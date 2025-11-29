import type {Dropbox, DropboxResponse, files} from "dropbox"
import {Errors, isDefined, Option, panic} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {AbstractStorageBackend, StorageBackend} from "./StorageBackend"

/**
 * Storage backend implementation using Dropbox.
 *
 * Provides cloud storage using Dropbox's API. Requires OAuth authentication.
 * Files are stored in the app's folder within the user's Dropbox.
 *
 * @example
 * ```typescript
 * const dropbox = new DropboxStorageBackend(accessToken)
 *
 * // Check connection
 * const health = await dropbox.healthCheck()
 * if (health.healthy) {
 *   await dropbox.write("projects/my-project/data.json", data)
 * }
 * ```
 */
export class DropboxStorageBackend extends AbstractStorageBackend {
    readonly type: StorageBackend.BackendType = "dropbox"
    readonly displayName = "Dropbox"
    readonly requiresAuth = true

    readonly #accessToken: string
    #dropboxClient: Option<Dropbox> = Option.None

    constructor(accessToken: string) {
        super()
        this.#accessToken = accessToken
    }

    async write(path: string, data: Uint8Array, _options?: StorageBackend.WriteOptions): Promise<void> {
        const client = await this.#ensureClient()
        const fullPath = this.#getFullPath(path)

        console.debug("[DropboxStorage] Uploading to:", fullPath)
        const {status, error, value: result} = await Promises.tryCatch(
            client.filesUpload({
                path: fullPath,
                contents: data.buffer,
                mode: {".tag": "overwrite"}
            })
        )

        if (status === "rejected") {
            return panic(error)
        }

        console.debug("[DropboxStorage] Upload successful:", result.result.path_display)
    }

    async read(path: string, _options?: StorageBackend.ReadOptions): Promise<Uint8Array> {
        const client = await this.#ensureClient()
        const fullPath = this.#getFullPath(path)

        try {
            const response = await client.filesDownload({path: fullPath})
            const {result: {fileBlob}} = response as DropboxResponse<files.FileMetadata & { fileBlob: Blob }>
            const buffer = await fileBlob.arrayBuffer()
            return new Uint8Array(buffer)
        } catch (error) {
            if (this.#isNotFoundError(error)) {
                throw new Errors.FileNotFound(path)
            }
            throw error
        }
    }

    async delete(path: string, _recursive?: boolean): Promise<void> {
        const client = await this.#ensureClient()
        const fullPath = this.#getFullPath(path)

        try {
            await client.filesDeleteV2({path: fullPath})
        } catch (error) {
            // Silently ignore if file doesn't exist
            if (!this.#isNotFoundError(error)) {
                throw error
            }
        }
    }

    async list(path: string, options?: StorageBackend.ListOptions): Promise<ReadonlyArray<StorageBackend.Entry>> {
        const client = await this.#ensureClient()
        const fullPath = path ? this.#getFullPath(path) : ""

        const entries: StorageBackend.Entry[] = []
        let cursor: string | undefined

        do {
            const response = cursor
                ? await client.filesListFolderContinue({cursor})
                : await client.filesListFolder({
                    path: fullPath,
                    recursive: options?.recursive ?? false,
                    limit: options?.maxResults
                })

            for (const entry of response.result.entries) {
                if (!entry.name) continue

                const kind: StorageBackend.EntryKind = entry[".tag"] === "folder" ? "directory" : "file"
                const metadata = entry as files.FileMetadataReference

                entries.push({
                    name: entry.name,
                    kind,
                    size: metadata.size,
                    modified: metadata.client_modified ? new Date(metadata.client_modified) : undefined
                })
            }

            cursor = response.result.has_more ? response.result.cursor : undefined
        } while (cursor && (!options?.maxResults || entries.length < options.maxResults))

        return entries
    }

    async exists(path: string): Promise<boolean> {
        const client = await this.#ensureClient()
        const fullPath = this.#getFullPath(path)

        const {status, error} = await Promises.tryCatch(
            client.filesGetMetadata({path: fullPath})
        )

        if (status === "resolved") return true
        return this.#isNotFoundError(error) ? false : panic(error)
    }

    async getMetadata(path: string): Promise<Option<StorageBackend.Metadata>> {
        const client = await this.#ensureClient()
        const fullPath = this.#getFullPath(path)

        const {status, value} = await Promises.tryCatch(
            client.filesGetMetadata({path: fullPath})
        )

        if (status === "rejected") {
            return Option.None
        }

        const metadata = value.result as files.FileMetadataReference
        return Option.wrap({
            size: metadata.size ?? 0,
            modified: metadata.client_modified ? new Date(metadata.client_modified) : undefined,
            created: undefined
        })
    }

    async copy(sourcePath: string, destPath: string): Promise<void> {
        const client = await this.#ensureClient()
        const from = this.#getFullPath(sourcePath)
        const to = this.#getFullPath(destPath)

        await client.filesCopyV2({from_path: from, to_path: to})
    }

    async move(sourcePath: string, destPath: string): Promise<void> {
        const client = await this.#ensureClient()
        const from = this.#getFullPath(sourcePath)
        const to = this.#getFullPath(destPath)

        await client.filesMoveV2({from_path: from, to_path: to})
    }

    async mkdir(path: string, _recursive?: boolean): Promise<void> {
        const client = await this.#ensureClient()
        const fullPath = this.#getFullPath(path)

        try {
            await client.filesCreateFolderV2({path: fullPath})
        } catch (error) {
            // Ignore if folder already exists
            if (!this.#isFolderConflictError(error)) {
                throw error
            }
        }
    }

    async healthCheck(): Promise<StorageBackend.HealthStatus> {
        const start = performance.now()
        try {
            const client = await this.#ensureClient()
            await client.usersGetCurrentAccount()
            return {
                healthy: true,
                latencyMs: Math.round(performance.now() - start),
                message: "Dropbox connected"
            }
        } catch (error) {
            return {
                healthy: false,
                latencyMs: Math.round(performance.now() - start),
                message: `Dropbox error: ${error instanceof Error ? error.message : String(error)}`
            }
        }
    }

    async getStorageQuota(): Promise<{ total: number; available: number } | undefined> {
        try {
            const client = await this.#ensureClient()
            const response = await client.usersGetSpaceUsage()
            const allocation = response.result.allocation

            if (allocation[".tag"] === "individual") {
                return {
                    total: allocation.allocated,
                    available: allocation.allocated - response.result.used
                }
            }
        } catch {
            // Quota info not available
        }
        return undefined
    }

    async #ensureClient(): Promise<Dropbox> {
        if (this.#dropboxClient.isEmpty()) {
            const DropboxModule = await import("dropbox")
            this.#dropboxClient = Option.wrap(
                new DropboxModule.Dropbox({accessToken: this.#accessToken})
            )
        }
        return this.#dropboxClient.unwrap()
    }

    #getFullPath(path: string): string {
        // Handle special characters in path (colons from timestamps)
        if (path.includes(":") || path.includes("T")) {
            const filename = path.replace(/:/g, "-")
            return filename.startsWith("/") ? filename : `/${filename}`
        }
        return path.startsWith("/") ? path : `/${path}`
    }

    #isNotFoundError(error: unknown): boolean {
        return (
            typeof error === "object" &&
            error !== null &&
            "status" in error &&
            (error as { status: number }).status === 409 &&
            (error as any).error?.error?.[".tag"] === "path" &&
            (error as any).error?.error?.path?.[".tag"] === "not_found"
        )
    }

    #isFolderConflictError(error: unknown): boolean {
        return (
            typeof error === "object" &&
            error !== null &&
            "status" in error &&
            (error as { status: number }).status === 409 &&
            (error as any).error?.error?.[".tag"] === "path" &&
            (error as any).error?.error?.path?.[".tag"] === "conflict"
        )
    }
}
