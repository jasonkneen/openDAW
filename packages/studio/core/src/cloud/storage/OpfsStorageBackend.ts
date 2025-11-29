import {Option} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {AbstractStorageBackend, StorageBackend} from "./StorageBackend"
import {Workers} from "../../Workers"

/**
 * Storage backend implementation using the Origin Private File System (OPFS).
 *
 * OPFS provides fast, local storage that persists across browser sessions.
 * This is the default storage backend and works entirely offline.
 *
 * @example
 * ```typescript
 * const opfs = new OpfsStorageBackend()
 *
 * // Write a file
 * await opfs.write("projects/my-project/data.json", new TextEncoder().encode('{}'))
 *
 * // Read it back
 * const data = await opfs.read("projects/my-project/data.json")
 * ```
 */
export class OpfsStorageBackend extends AbstractStorageBackend {
    readonly type: StorageBackend.BackendType = "opfs"
    readonly displayName = "Local Storage (OPFS)"
    readonly requiresAuth = false

    async write(path: string, data: Uint8Array, _options?: StorageBackend.WriteOptions): Promise<void> {
        await Workers.Opfs.write(path, data)
    }

    async read(path: string, _options?: StorageBackend.ReadOptions): Promise<Uint8Array> {
        return Workers.Opfs.read(path)
    }

    async delete(path: string, _recursive?: boolean): Promise<void> {
        await Workers.Opfs.delete(path)
    }

    async list(path: string, _options?: StorageBackend.ListOptions): Promise<ReadonlyArray<StorageBackend.Entry>> {
        const entries = await Workers.Opfs.list(path)
        return entries.map(entry => ({
            name: entry.name,
            kind: entry.kind
        }))
    }

    async exists(path: string): Promise<boolean> {
        const {status} = await Promises.tryCatch(Workers.Opfs.read(path))
        return status === "resolved"
    }

    async getMetadata(path: string): Promise<Option<StorageBackend.Metadata>> {
        const {status, value} = await Promises.tryCatch(Workers.Opfs.read(path))
        if (status === "rejected") {
            return Option.None
        }
        return Option.wrap({
            size: value.byteLength,
            modified: undefined,
            created: undefined
        })
    }

    async mkdir(path: string, _recursive?: boolean): Promise<void> {
        // OPFS creates directories implicitly when writing files
        // But we can ensure the directory exists by listing it
        const {status} = await Promises.tryCatch(Workers.Opfs.list(path))
        if (status === "rejected") {
            // Create directory by writing and immediately deleting a temp file
            const tempPath = `${path}/.opfs-mkdir-temp`
            await Workers.Opfs.write(tempPath, new Uint8Array(0))
            await Workers.Opfs.delete(tempPath)
        }
    }

    async healthCheck(): Promise<StorageBackend.HealthStatus> {
        const start = performance.now()
        try {
            // Try to list the root directory
            await Workers.Opfs.list("")
            return {
                healthy: true,
                latencyMs: Math.round(performance.now() - start),
                message: "OPFS is accessible"
            }
        } catch (error) {
            return {
                healthy: false,
                latencyMs: Math.round(performance.now() - start),
                message: `OPFS error: ${error instanceof Error ? error.message : String(error)}`
            }
        }
    }

    async getStorageQuota(): Promise<{ total: number; available: number } | undefined> {
        try {
            if (navigator.storage && navigator.storage.estimate) {
                const estimate = await navigator.storage.estimate()
                return {
                    total: estimate.quota ?? 0,
                    available: (estimate.quota ?? 0) - (estimate.usage ?? 0)
                }
            }
        } catch {
            // Storage estimation not supported
        }
        return undefined
    }
}
