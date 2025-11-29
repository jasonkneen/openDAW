import {Errors, isDefined, Option, panic} from "@opendaw/lib-std"
import {AbstractStorageBackend, StorageBackend} from "./StorageBackend"

type DriveFile = {
    id: string
    name: string
    mimeType?: string
    size?: string
    modifiedTime?: string
    createdTime?: string
}

type DriveListResponse = {
    files: Array<DriveFile>
    nextPageToken?: string
}

const DRIVE_FILES_API = "https://www.googleapis.com/drive/v3/files"
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files"
const FOLDER_MIME = "application/vnd.google-apps.folder"
const ROOT_ID = "appDataFolder"

/**
 * Storage backend implementation using Google Drive.
 *
 * Provides cloud storage using Google Drive's API. Requires OAuth authentication.
 * Files are stored in the app's hidden appDataFolder.
 *
 * @example
 * ```typescript
 * const drive = new GoogleDriveStorageBackend(accessToken)
 *
 * // Check connection
 * const health = await drive.healthCheck()
 * if (health.healthy) {
 *   await drive.write("projects/my-project/data.json", data)
 * }
 * ```
 */
export class GoogleDriveStorageBackend extends AbstractStorageBackend {
    readonly type: StorageBackend.BackendType = "google-drive"
    readonly displayName = "Google Drive"
    readonly requiresAuth = true

    readonly #accessToken: string
    #ensureFolderInProgress = false

    constructor(accessToken: string) {
        super()
        this.#accessToken = accessToken
    }

    async write(path: string, data: Uint8Array, _options?: StorageBackend.WriteOptions): Promise<void> {
        const {dir, base} = this.#splitPath(path)
        const parentId = await this.#ensureFolderPath(dir)
        const existing = await this.#findFileInFolder(base, parentId)

        if (existing.nonEmpty()) {
            // Update existing file
            const fileId = existing.unwrap().id
            const res = await fetch(`${DRIVE_UPLOAD_API}/${fileId}?uploadType=media`, {
                method: "PATCH",
                headers: {
                    Authorization: `Bearer ${this.#accessToken}`,
                    "Content-Type": "application/octet-stream"
                },
                body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
            })
            if (!res.ok) {
                return panic(`Google Drive update failed: ${res.status} ${await res.text()}`)
            }
        } else {
            // Create new file
            const meta = {name: base, parents: [parentId]}
            const {boundary, body} = this.#buildMultipartBody(meta, data)
            const res = await fetch(`${DRIVE_UPLOAD_API}?uploadType=multipart`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this.#accessToken}`,
                    "Content-Type": `multipart/related; boundary=${boundary}`
                },
                body
            })
            if (!res.ok) {
                return panic(`Google Drive upload failed: ${res.status} ${await res.text()}`)
            }
        }
    }

    async read(path: string, _options?: StorageBackend.ReadOptions): Promise<Uint8Array> {
        const fileId = await this.#resolveFileIdByPath(path)
        if (fileId.isEmpty()) {
            throw new Errors.FileNotFound(path)
        }

        const res = await fetch(`${DRIVE_FILES_API}/${fileId.unwrap()}?alt=media`, {
            method: "GET",
            headers: {Authorization: `Bearer ${this.#accessToken}`}
        })

        if (!res.ok) {
            if (res.status === 404) {
                throw new Errors.FileNotFound(path)
            }
            const text = await res.text()
            return panic(`Google Drive download failed: ${res.status} ${text}`)
        }

        const buffer = await res.arrayBuffer()
        return new Uint8Array(buffer)
    }

    async delete(path: string, _recursive?: boolean): Promise<void> {
        const fileId = await this.#resolveFileIdByPath(path)
        if (fileId.isEmpty()) {
            // Deleting non-existent file is a no-op
            return
        }

        const res = await fetch(`${DRIVE_FILES_API}/${fileId.unwrap()}`, {
            method: "DELETE",
            headers: {Authorization: `Bearer ${this.#accessToken}`}
        })

        if (!res.ok && res.status !== 404) {
            const text = await res.text()
            return panic(`Google Drive delete failed: ${res.status} ${text}`)
        }
    }

    async list(path: string, options?: StorageBackend.ListOptions): Promise<ReadonlyArray<StorageBackend.Entry>> {
        const folderId = await this.#resolveFolderId(path ?? "/")
        if (folderId.isEmpty()) {
            return []
        }

        const entries: StorageBackend.Entry[] = []
        let pageToken: string | undefined

        do {
            const q = `'${folderId.unwrap()}' in parents and trashed = false`
            const params = new URLSearchParams({
                q,
                fields: "files(id,name,mimeType,size,modifiedTime,createdTime),nextPageToken",
                pageSize: String(Math.min(options?.maxResults ?? 1000, 1000)),
                spaces: "appDataFolder"
            })

            if (pageToken) {
                params.set("pageToken", pageToken)
            }

            const res = await fetch(`${DRIVE_FILES_API}?${params.toString()}`, {
                headers: {Authorization: `Bearer ${this.#accessToken}`}
            })

            if (!res.ok) {
                const text = await res.text()
                return panic(`Google Drive list failed: ${res.status} ${text}`)
            }

            const json: DriveListResponse = await res.json()
            for (const file of json.files) {
                entries.push({
                    name: file.name,
                    kind: file.mimeType === FOLDER_MIME ? "directory" : "file",
                    size: file.size ? parseInt(file.size, 10) : undefined,
                    modified: file.modifiedTime ? new Date(file.modifiedTime) : undefined
                })
            }

            pageToken = json.nextPageToken
        } while (isDefined(pageToken) && (!options?.maxResults || entries.length < options.maxResults))

        return entries
    }

    async exists(path: string): Promise<boolean> {
        const fileId = await this.#resolveFileIdByPath(path)
        return fileId.nonEmpty()
    }

    async getMetadata(path: string): Promise<Option<StorageBackend.Metadata>> {
        const fileId = await this.#resolveFileIdByPath(path)
        if (fileId.isEmpty()) {
            return Option.None
        }

        const params = new URLSearchParams({
            fields: "size,modifiedTime,createdTime,mimeType"
        })

        const res = await fetch(`${DRIVE_FILES_API}/${fileId.unwrap()}?${params.toString()}`, {
            headers: {Authorization: `Bearer ${this.#accessToken}`}
        })

        if (!res.ok) {
            return Option.None
        }

        const file: DriveFile = await res.json()
        return Option.wrap({
            size: file.size ? parseInt(file.size, 10) : 0,
            modified: file.modifiedTime ? new Date(file.modifiedTime) : undefined,
            created: file.createdTime ? new Date(file.createdTime) : undefined,
            contentType: file.mimeType
        })
    }

    async copy(sourcePath: string, destPath: string): Promise<void> {
        const sourceId = await this.#resolveFileIdByPath(sourcePath)
        if (sourceId.isEmpty()) {
            throw new Errors.FileNotFound(sourcePath)
        }

        const {dir, base} = this.#splitPath(destPath)
        const parentId = await this.#ensureFolderPath(dir)

        const res = await fetch(`${DRIVE_FILES_API}/${sourceId.unwrap()}/copy`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.#accessToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({name: base, parents: [parentId]})
        })

        if (!res.ok) {
            return panic(`Google Drive copy failed: ${res.status} ${await res.text()}`)
        }
    }

    async mkdir(path: string, _recursive?: boolean): Promise<void> {
        const parts = this.#splitPath(path)
        // Ensure the full path exists
        await this.#ensureFolderPath([...parts.dir, parts.base].filter(Boolean))
    }

    async healthCheck(): Promise<StorageBackend.HealthStatus> {
        const start = performance.now()
        const params = new URLSearchParams({
            q: `'${ROOT_ID}' in parents and trashed = false`,
            fields: "files(id)",
            pageSize: "1",
            spaces: "appDataFolder"
        })

        try {
            const res = await fetch(`${DRIVE_FILES_API}?${params.toString()}`, {
                headers: {Authorization: `Bearer ${this.#accessToken}`}
            })

            if (!res.ok) {
                const text = await res.text()
                return {
                    healthy: false,
                    latencyMs: Math.round(performance.now() - start),
                    message: `Google Drive error: ${res.status} ${text}`
                }
            }

            return {
                healthy: true,
                latencyMs: Math.round(performance.now() - start),
                message: "Google Drive connected"
            }
        } catch (error) {
            return {
                healthy: false,
                latencyMs: Math.round(performance.now() - start),
                message: `Google Drive error: ${error instanceof Error ? error.message : String(error)}`
            }
        }
    }

    async getStorageQuota(): Promise<{ total: number; available: number } | undefined> {
        try {
            const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=storageQuota", {
                headers: {Authorization: `Bearer ${this.#accessToken}`}
            })

            if (res.ok) {
                const data = await res.json()
                const quota = data.storageQuota
                if (quota) {
                    return {
                        total: parseInt(quota.limit ?? "0", 10),
                        available: parseInt(quota.limit ?? "0", 10) - parseInt(quota.usage ?? "0", 10)
                    }
                }
            }
        } catch {
            // Quota info not available
        }
        return undefined
    }

    // --- Private Helpers ---

    #splitPath(path: string): { dir: string[]; base: string } {
        const clean = path.replace(/^\/*/, "") // remove leading slashes
        const parts = clean.split("/").filter(p => p.length > 0)
        if (parts.length === 0) {
            return {dir: [], base: ""}
        }
        const base = parts.pop() as string
        return {dir: parts, base}
    }

    async #resolveFileIdByPath(path: string): Promise<Option<string>> {
        const {dir, base} = this.#splitPath(path)
        const parentId = await this.#resolveFolderPath(dir)
        if (parentId.isEmpty() || base.length === 0) {
            return Option.None
        }
        const existing = await this.#findFileInFolder(base, parentId.unwrap())
        return existing.map(f => f.id)
    }

    async #resolveFolderId(path: string): Promise<Option<string>> {
        if (path === "/" || path.trim() === "") {
            return Option.wrap(ROOT_ID)
        }
        const parts = path.replace(/^\/*/, "").split("/").filter(Boolean)
        return this.#resolveFolderPath(parts)
    }

    async #resolveFolderPath(parts: string[]): Promise<Option<string>> {
        let currentId: string = ROOT_ID
        for (const part of parts) {
            const next = await this.#findFolderInFolder(part, currentId)
            if (next.isEmpty()) {
                return Option.None
            }
            currentId = next.unwrap().id
        }
        return Option.wrap(currentId)
    }

    async #ensureFolderPath(parts: string[]): Promise<string> {
        // Prevent concurrent folder creation which can cause duplicates
        while (this.#ensureFolderInProgress) {
            await new Promise(resolve => setTimeout(resolve, 50))
        }

        this.#ensureFolderInProgress = true
        try {
            let currentId: string = ROOT_ID
            for (const part of parts) {
                const found = await this.#findFolderInFolder(part, currentId)
                if (found.nonEmpty()) {
                    currentId = found.unwrap().id
                    continue
                }
                const created = await this.#createFolder(part, currentId)
                currentId = created.id
            }
            return currentId
        } finally {
            this.#ensureFolderInProgress = false
        }
    }

    async #findFolderInFolder(name: string, parentId: string): Promise<Option<DriveFile>> {
        const q = [
            `name = '${name.replace(/'/g, "\\'")}'`,
            `'${parentId}' in parents`,
            `mimeType = '${FOLDER_MIME}'`,
            `trashed = false`
        ].join(" and ")

        const params = new URLSearchParams({
            q,
            fields: "files(id,name,mimeType)",
            pageSize: "1",
            spaces: "appDataFolder"
        })

        const res = await fetch(`${DRIVE_FILES_API}?${params.toString()}`, {
            headers: {Authorization: `Bearer ${this.#accessToken}`}
        })

        if (!res.ok) {
            const text = await res.text()
            return panic(`Google Drive query failed: ${res.status} ${text}`)
        }

        const json: DriveListResponse = await res.json()
        return Option.wrap(json.files[0])
    }

    async #findFileInFolder(name: string, parentId: string): Promise<Option<DriveFile>> {
        const q = [
            `name = '${name.replace(/'/g, "\\'")}'`,
            `'${parentId}' in parents`,
            `mimeType != '${FOLDER_MIME}'`,
            `trashed = false`
        ].join(" and ")

        const params = new URLSearchParams({
            q,
            fields: "files(id,name,mimeType,size,modifiedTime)",
            pageSize: "1",
            spaces: "appDataFolder"
        })

        const res = await fetch(`${DRIVE_FILES_API}?${params.toString()}`, {
            headers: {Authorization: `Bearer ${this.#accessToken}`}
        })

        if (!res.ok) {
            const text = await res.text()
            return panic(`Google Drive query failed: ${res.status} ${text}`)
        }

        const json: DriveListResponse = await res.json()
        return Option.wrap(json.files[0])
    }

    async #createFolder(name: string, parentId: string): Promise<DriveFile> {
        const metadata = {
            name,
            mimeType: FOLDER_MIME,
            parents: [parentId]
        }

        const res = await fetch(DRIVE_FILES_API, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.#accessToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(metadata)
        })

        if (!res.ok) {
            const text = await res.text()
            return panic(`Google Drive create folder failed: ${res.status} ${text}`)
        }

        return await res.json() as DriveFile
    }

    #buildMultipartBody(metadata: object, content: Uint8Array): { boundary: string; body: Blob } {
        const boundary = `======opendaw_${Math.random().toString(36).slice(2)}`
        const delimiter = `--${boundary}`
        const close = `--${boundary}--`

        const metaHeader =
            `${delimiter}\r\n` +
            "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
            `${JSON.stringify(metadata)}\r\n`

        const binHeader =
            `${delimiter}\r\n` +
            "Content-Type: application/octet-stream\r\n\r\n"

        const body = new Blob([
            metaHeader,
            binHeader,
            content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer,
            `\r\n${close}\r\n`
        ])

        return {boundary, body}
    }
}
