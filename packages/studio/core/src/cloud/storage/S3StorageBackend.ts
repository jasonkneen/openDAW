import {Errors, Option, panic} from "@opendaw/lib-std"
import {AbstractStorageBackend, StorageBackend} from "./StorageBackend"

/**
 * S3 configuration for the storage backend.
 */
export interface S3Config {
    /**
     * The S3 bucket name.
     */
    readonly bucket: string

    /**
     * The AWS region (e.g., "us-east-1").
     */
    readonly region: string

    /**
     * AWS access key ID.
     */
    readonly accessKeyId: string

    /**
     * AWS secret access key.
     */
    readonly secretAccessKey: string

    /**
     * Optional session token for temporary credentials.
     */
    readonly sessionToken?: string

    /**
     * Optional custom endpoint URL for S3-compatible services (MinIO, DigitalOcean Spaces, etc.)
     */
    readonly endpoint?: string

    /**
     * Optional path prefix for all operations.
     */
    readonly pathPrefix?: string

    /**
     * Whether to use path-style URLs instead of virtual hosted-style.
     * Required for some S3-compatible services.
     * @default false
     */
    readonly forcePathStyle?: boolean
}

/**
 * Storage backend implementation using Amazon S3 or S3-compatible services.
 *
 * Supports AWS S3, MinIO, DigitalOcean Spaces, Backblaze B2, and other
 * S3-compatible object storage services.
 *
 * Uses AWS Signature Version 4 for authentication.
 *
 * @example
 * ```typescript
 * // AWS S3
 * const s3 = new S3StorageBackend({
 *   bucket: "my-opendaw-bucket",
 *   region: "us-east-1",
 *   accessKeyId: "AKIA...",
 *   secretAccessKey: "secret..."
 * })
 *
 * // MinIO (S3-compatible)
 * const minio = new S3StorageBackend({
 *   bucket: "opendaw",
 *   region: "us-east-1",
 *   accessKeyId: "minioadmin",
 *   secretAccessKey: "minioadmin",
 *   endpoint: "http://localhost:9000",
 *   forcePathStyle: true
 * })
 * ```
 */
export class S3StorageBackend extends AbstractStorageBackend {
    readonly type: StorageBackend.BackendType = "s3"
    readonly displayName: string
    readonly requiresAuth = true

    readonly #config: S3Config

    constructor(config: S3Config) {
        super()
        this.#config = config
        this.displayName = config.endpoint
            ? `S3-Compatible (${new URL(config.endpoint).hostname})`
            : "Amazon S3"
    }

    async write(path: string, data: Uint8Array, options?: StorageBackend.WriteOptions): Promise<void> {
        const fullPath = this.#getFullPath(path)
        const url = this.#buildUrl(fullPath)

        const headers: Record<string, string> = {
            "Content-Type": options?.contentType ?? "application/octet-stream",
            "Content-Length": String(data.byteLength)
        }

        const signedHeaders = await this.#signRequest("PUT", fullPath, headers, data)

        const res = await fetch(url, {
            method: "PUT",
            headers: signedHeaders,
            body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
        })

        if (!res.ok) {
            const text = await res.text()
            return panic(`S3 upload failed: ${res.status} ${text}`)
        }
    }

    async read(path: string, _options?: StorageBackend.ReadOptions): Promise<Uint8Array> {
        const fullPath = this.#getFullPath(path)
        const url = this.#buildUrl(fullPath)

        const signedHeaders = await this.#signRequest("GET", fullPath, {})

        const res = await fetch(url, {
            method: "GET",
            headers: signedHeaders
        })

        if (!res.ok) {
            if (res.status === 404) {
                throw new Errors.FileNotFound(path)
            }
            const text = await res.text()
            return panic(`S3 download failed: ${res.status} ${text}`)
        }

        const buffer = await res.arrayBuffer()
        return new Uint8Array(buffer)
    }

    async delete(path: string, recursive?: boolean): Promise<void> {
        if (recursive) {
            // Delete all objects with the given prefix
            const entries = await this.list(path, {recursive: true})
            for (const entry of entries) {
                const entryPath = `${path}/${entry.name}`
                await this.#deleteObject(entryPath)
            }
        }
        await this.#deleteObject(path)
    }

    async #deleteObject(path: string): Promise<void> {
        const fullPath = this.#getFullPath(path)
        const url = this.#buildUrl(fullPath)

        const signedHeaders = await this.#signRequest("DELETE", fullPath, {})

        const res = await fetch(url, {
            method: "DELETE",
            headers: signedHeaders
        })

        // S3 returns 204 on successful delete, and doesn't error on non-existent objects
        if (!res.ok && res.status !== 204 && res.status !== 404) {
            const text = await res.text()
            return panic(`S3 delete failed: ${res.status} ${text}`)
        }
    }

    async list(path: string, options?: StorageBackend.ListOptions): Promise<ReadonlyArray<StorageBackend.Entry>> {
        const prefix = this.#getFullPath(path)
        const entries: StorageBackend.Entry[] = []
        let continuationToken: string | undefined

        do {
            const params = new URLSearchParams({
                "list-type": "2",
                prefix: prefix.endsWith("/") ? prefix : `${prefix}/`
            })

            if (!options?.recursive) {
                params.set("delimiter", "/")
            }

            if (options?.maxResults) {
                params.set("max-keys", String(options.maxResults))
            }

            if (continuationToken) {
                params.set("continuation-token", continuationToken)
            }

            const url = this.#buildUrl("", params)
            const signedHeaders = await this.#signRequest("GET", "", {}, undefined, params)

            const res = await fetch(url, {
                method: "GET",
                headers: signedHeaders
            })

            if (!res.ok) {
                const text = await res.text()
                return panic(`S3 list failed: ${res.status} ${text}`)
            }

            const xml = await res.text()
            const parsed = this.#parseListResponse(xml, prefix)
            entries.push(...parsed.entries)
            continuationToken = parsed.continuationToken

        } while (continuationToken && (!options?.maxResults || entries.length < options.maxResults))

        return entries
    }

    async exists(path: string): Promise<boolean> {
        const fullPath = this.#getFullPath(path)
        const url = this.#buildUrl(fullPath)

        const signedHeaders = await this.#signRequest("HEAD", fullPath, {})

        const res = await fetch(url, {
            method: "HEAD",
            headers: signedHeaders
        })

        return res.ok
    }

    async getMetadata(path: string): Promise<Option<StorageBackend.Metadata>> {
        const fullPath = this.#getFullPath(path)
        const url = this.#buildUrl(fullPath)

        const signedHeaders = await this.#signRequest("HEAD", fullPath, {})

        const res = await fetch(url, {
            method: "HEAD",
            headers: signedHeaders
        })

        if (!res.ok) {
            return Option.None
        }

        const size = parseInt(res.headers.get("content-length") ?? "0", 10)
        const modified = res.headers.get("last-modified")
        const contentType = res.headers.get("content-type")

        return Option.wrap({
            size,
            modified: modified ? new Date(modified) : undefined,
            contentType: contentType ?? undefined
        })
    }

    async copy(sourcePath: string, destPath: string): Promise<void> {
        const sourceFullPath = this.#getFullPath(sourcePath)
        const destFullPath = this.#getFullPath(destPath)
        const url = this.#buildUrl(destFullPath)

        const copySource = `/${this.#config.bucket}/${sourceFullPath}`
        const headers: Record<string, string> = {
            "x-amz-copy-source": copySource
        }

        const signedHeaders = await this.#signRequest("PUT", destFullPath, headers)

        const res = await fetch(url, {
            method: "PUT",
            headers: signedHeaders
        })

        if (!res.ok) {
            const text = await res.text()
            return panic(`S3 copy failed: ${res.status} ${text}`)
        }
    }

    async healthCheck(): Promise<StorageBackend.HealthStatus> {
        const start = performance.now()

        try {
            // Try to list bucket (even with empty results)
            const params = new URLSearchParams({
                "list-type": "2",
                "max-keys": "1"
            })
            const url = this.#buildUrl("", params)
            const signedHeaders = await this.#signRequest("GET", "", {}, undefined, params)

            const res = await fetch(url, {
                method: "GET",
                headers: signedHeaders
            })

            if (!res.ok) {
                return {
                    healthy: false,
                    latencyMs: Math.round(performance.now() - start),
                    message: `S3 error: ${res.status}`
                }
            }

            return {
                healthy: true,
                latencyMs: Math.round(performance.now() - start),
                message: `S3 bucket ${this.#config.bucket} accessible`
            }
        } catch (error) {
            return {
                healthy: false,
                latencyMs: Math.round(performance.now() - start),
                message: `S3 error: ${error instanceof Error ? error.message : String(error)}`
            }
        }
    }

    // --- Private Helpers ---

    #getFullPath(path: string): string {
        const prefix = this.#config.pathPrefix?.replace(/^\/+|\/+$/g, "") ?? ""
        const cleanPath = path.replace(/^\/+/, "")
        return prefix ? `${prefix}/${cleanPath}` : cleanPath
    }

    #buildUrl(path: string, params?: URLSearchParams): string {
        const endpoint = this.#config.endpoint ?? `https://s3.${this.#config.region}.amazonaws.com`
        const bucket = this.#config.bucket

        let url: string
        if (this.#config.forcePathStyle) {
            url = `${endpoint}/${bucket}/${path}`.replace(/\/+$/, "")
        } else {
            // Virtual hosted-style
            const host = new URL(endpoint)
            url = `${host.protocol}//${bucket}.${host.host}/${path}`.replace(/\/+$/, "")
        }

        if (params && params.toString()) {
            url += `?${params.toString()}`
        }

        return url
    }

    async #signRequest(
        method: string,
        path: string,
        headers: Record<string, string>,
        body?: Uint8Array,
        queryParams?: URLSearchParams
    ): Promise<Record<string, string>> {
        // AWS Signature Version 4 implementation
        const datetime = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "")
        const date = datetime.slice(0, 8)

        const host = this.#getHost()
        const signedHeaders: Record<string, string> = {
            ...headers,
            host,
            "x-amz-date": datetime
        }

        if (this.#config.sessionToken) {
            signedHeaders["x-amz-security-token"] = this.#config.sessionToken
        }

        // Calculate payload hash
        const payloadHash = body
            ? await this.#sha256Hex(body)
            : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" // empty string hash

        signedHeaders["x-amz-content-sha256"] = payloadHash

        // Create canonical request
        const signedHeaderNames = Object.keys(signedHeaders).sort().join(";")
        const canonicalHeaders = Object.keys(signedHeaders)
            .sort()
            .map(k => `${k.toLowerCase()}:${signedHeaders[k].trim()}`)
            .join("\n")

        const canonicalQueryString = queryParams
            ? Array.from(queryParams.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
                .join("&")
            : ""

        const canonicalUri = this.#config.forcePathStyle
            ? `/${this.#config.bucket}/${path}`.replace(/\/+/g, "/")
            : `/${path}`.replace(/\/+/g, "/") || "/"

        const canonicalRequest = [
            method,
            canonicalUri,
            canonicalQueryString,
            canonicalHeaders + "\n",
            signedHeaderNames.toLowerCase(),
            payloadHash
        ].join("\n")

        // Create string to sign
        const scope = `${date}/${this.#config.region}/s3/aws4_request`
        const stringToSign = [
            "AWS4-HMAC-SHA256",
            datetime,
            scope,
            await this.#sha256Hex(new TextEncoder().encode(canonicalRequest))
        ].join("\n")

        // Calculate signature
        const signature = await this.#calculateSignature(date, stringToSign)

        // Add authorization header
        signedHeaders["Authorization"] = [
            `AWS4-HMAC-SHA256 Credential=${this.#config.accessKeyId}/${scope}`,
            `SignedHeaders=${signedHeaderNames.toLowerCase()}`,
            `Signature=${signature}`
        ].join(", ")

        return signedHeaders
    }

    #getHost(): string {
        if (this.#config.endpoint) {
            const url = new URL(this.#config.endpoint)
            return this.#config.forcePathStyle
                ? url.host
                : `${this.#config.bucket}.${url.host}`
        }
        return `${this.#config.bucket}.s3.${this.#config.region}.amazonaws.com`
    }

    async #calculateSignature(date: string, stringToSign: string): Promise<string> {
        const keyData = new TextEncoder().encode(`AWS4${this.#config.secretAccessKey}`)
        const kDate = await this.#hmacSha256(
            keyData.buffer.slice(keyData.byteOffset, keyData.byteOffset + keyData.byteLength) as ArrayBuffer,
            date
        )
        const kRegion = await this.#hmacSha256(kDate, this.#config.region)
        const kService = await this.#hmacSha256(kRegion, "s3")
        const kSigning = await this.#hmacSha256(kService, "aws4_request")
        const signature = await this.#hmacSha256(kSigning, stringToSign)

        return Array.from(new Uint8Array(signature))
            .map(b => b.toString(16).padStart(2, "0"))
            .join("")
    }

    async #hmacSha256(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
        const cryptoKey = await crypto.subtle.importKey(
            "raw",
            key,
            {name: "HMAC", hash: "SHA-256"},
            false,
            ["sign"]
        )
        return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data))
    }

    async #sha256Hex(data: Uint8Array): Promise<string> {
        const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
        const hash = await crypto.subtle.digest("SHA-256", buffer)
        return Array.from(new Uint8Array(hash))
            .map(b => b.toString(16).padStart(2, "0"))
            .join("")
    }

    #parseListResponse(xml: string, prefix: string): { entries: StorageBackend.Entry[]; continuationToken?: string } {
        const entries: StorageBackend.Entry[] = []

        // Parse Contents (files)
        const contentMatches = xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)
        for (const match of contentMatches) {
            const content = match[1]
            const key = content.match(/<Key>(.*?)<\/Key>/)?.[1] ?? ""
            const size = parseInt(content.match(/<Size>(.*?)<\/Size>/)?.[1] ?? "0", 10)
            const lastModified = content.match(/<LastModified>(.*?)<\/LastModified>/)?.[1]

            // Remove prefix to get relative name
            const name = key.replace(new RegExp(`^${prefix}/?`), "")
            if (name) {
                entries.push({
                    name,
                    kind: "file",
                    size,
                    modified: lastModified ? new Date(lastModified) : undefined
                })
            }
        }

        // Parse CommonPrefixes (directories)
        const prefixMatches = xml.matchAll(/<CommonPrefixes>[\s\S]*?<Prefix>(.*?)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g)
        for (const match of prefixMatches) {
            const key = match[1]
            const name = key.replace(new RegExp(`^${prefix}/?`), "").replace(/\/$/, "")
            if (name) {
                entries.push({
                    name,
                    kind: "directory"
                })
            }
        }

        // Parse continuation token
        const continuationToken = xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/)?.[1]

        return {entries, continuationToken}
    }
}
