import type {Option} from "@opendaw/lib-std"

/**
 * Represents an entry in a storage directory listing.
 */
export namespace StorageBackend {
    export type EntryKind = "file" | "directory"

    export interface Entry {
        readonly name: string
        readonly kind: EntryKind
        readonly size?: number
        readonly modified?: Date
    }

    export interface Metadata {
        readonly size: number
        readonly modified?: Date
        readonly created?: Date
        readonly contentType?: string
    }

    /**
     * Supported storage backend types.
     */
    export type BackendType = "opfs" | "dropbox" | "google-drive" | "s3" | "custom"

    /**
     * Progress callback for long-running operations.
     */
    export type ProgressCallback = (loaded: number, total: number) => void

    /**
     * Options for read operations.
     */
    export interface ReadOptions {
        readonly onProgress?: ProgressCallback
    }

    /**
     * Options for write operations.
     */
    export interface WriteOptions {
        readonly onProgress?: ProgressCallback
        readonly contentType?: string
    }

    /**
     * Options for list operations.
     */
    export interface ListOptions {
        readonly recursive?: boolean
        readonly maxResults?: number
    }

    /**
     * Result of a health check operation.
     */
    export interface HealthStatus {
        readonly healthy: boolean
        readonly latencyMs?: number
        readonly message?: string
    }
}

/**
 * A cloud-agnostic storage backend interface.
 *
 * This interface provides a unified API for interacting with different
 * storage services (OPFS, Dropbox, Google Drive, S3, etc.) allowing
 * users to plug in their preferred cloud storage for projects and sample libraries.
 *
 * @example
 * ```typescript
 * // Using with OPFS (local)
 * const opfs = new OpfsStorageBackend()
 * await opfs.write("projects/my-project/project.od", data)
 *
 * // Using with Dropbox
 * const dropbox = new DropboxStorageBackend(accessToken)
 * await dropbox.write("projects/my-project/project.od", data)
 *
 * // Both use the same interface!
 * ```
 */
export interface StorageBackend {
    /**
     * The type identifier for this backend.
     */
    readonly type: StorageBackend.BackendType

    /**
     * Human-readable display name for this backend.
     */
    readonly displayName: string

    /**
     * Whether this backend requires authentication.
     */
    readonly requiresAuth: boolean

    /**
     * Write data to the specified path.
     * Creates parent directories if they don't exist.
     *
     * @param path - The path to write to (e.g., "projects/uuid/project.od")
     * @param data - The data to write
     * @param options - Optional write options including progress callback
     */
    write(path: string, data: Uint8Array, options?: StorageBackend.WriteOptions): Promise<void>

    /**
     * Read data from the specified path.
     *
     * @param path - The path to read from
     * @param options - Optional read options including progress callback
     * @returns The data at the specified path
     * @throws {Errors.FileNotFound} if the file doesn't exist
     */
    read(path: string, options?: StorageBackend.ReadOptions): Promise<Uint8Array>

    /**
     * Delete a file or directory at the specified path.
     *
     * @param path - The path to delete
     * @param recursive - If true, delete directory contents recursively
     */
    delete(path: string, recursive?: boolean): Promise<void>

    /**
     * List entries at the specified path.
     *
     * @param path - The directory path to list
     * @param options - Optional list options
     * @returns Array of entries in the directory
     */
    list(path: string, options?: StorageBackend.ListOptions): Promise<ReadonlyArray<StorageBackend.Entry>>

    /**
     * Check if a file or directory exists at the specified path.
     *
     * @param path - The path to check
     * @returns true if the path exists, false otherwise
     */
    exists(path: string): Promise<boolean>

    /**
     * Get metadata for a file at the specified path.
     *
     * @param path - The path to get metadata for
     * @returns Metadata if the file exists, None otherwise
     */
    getMetadata(path: string): Promise<Option<StorageBackend.Metadata>>

    /**
     * Copy a file from one path to another.
     * Default implementation reads and writes; backends may optimize.
     *
     * @param sourcePath - The source path
     * @param destPath - The destination path
     */
    copy(sourcePath: string, destPath: string): Promise<void>

    /**
     * Move a file from one path to another.
     * Default implementation copies and deletes; backends may optimize.
     *
     * @param sourcePath - The source path
     * @param destPath - The destination path
     */
    move(sourcePath: string, destPath: string): Promise<void>

    /**
     * Create a directory at the specified path.
     *
     * @param path - The directory path to create
     * @param recursive - If true, create parent directories as needed
     */
    mkdir(path: string, recursive?: boolean): Promise<void>

    /**
     * Check if the storage backend is accessible and healthy.
     *
     * @returns Health status including latency information
     */
    healthCheck(): Promise<StorageBackend.HealthStatus>

    /**
     * Get the total and available storage space.
     * Not all backends support this; returns undefined if unsupported.
     *
     * @returns Object with total and available bytes, or undefined
     */
    getStorageQuota(): Promise<{ total: number; available: number } | undefined>
}

/**
 * Base class providing default implementations for some StorageBackend methods.
 */
export abstract class AbstractStorageBackend implements StorageBackend {
    abstract readonly type: StorageBackend.BackendType
    abstract readonly displayName: string
    abstract readonly requiresAuth: boolean

    abstract write(path: string, data: Uint8Array, options?: StorageBackend.WriteOptions): Promise<void>
    abstract read(path: string, options?: StorageBackend.ReadOptions): Promise<Uint8Array>
    abstract delete(path: string, recursive?: boolean): Promise<void>
    abstract list(path: string, options?: StorageBackend.ListOptions): Promise<ReadonlyArray<StorageBackend.Entry>>
    abstract exists(path: string): Promise<boolean>
    abstract getMetadata(path: string): Promise<Option<StorageBackend.Metadata>>
    abstract healthCheck(): Promise<StorageBackend.HealthStatus>

    async copy(sourcePath: string, destPath: string): Promise<void> {
        const data = await this.read(sourcePath)
        await this.write(destPath, data)
    }

    async move(sourcePath: string, destPath: string): Promise<void> {
        await this.copy(sourcePath, destPath)
        await this.delete(sourcePath)
    }

    async mkdir(path: string, _recursive?: boolean): Promise<void> {
        // Most cloud backends create directories implicitly
        // OPFS needs explicit directory creation
        void path
    }

    async getStorageQuota(): Promise<{ total: number; available: number } | undefined> {
        return undefined
    }
}
