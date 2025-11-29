import {Option, panic, Procedure} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {StorageBackend} from "./StorageBackend"
import {OpfsStorageBackend} from "./OpfsStorageBackend"

/**
 * Storage scope determines which backend to use for different content types.
 */
export type StorageScope = "projects" | "samples" | "soundfonts" | "all"

/**
 * Configuration for a storage backend within the provider.
 */
export interface BackendConfig {
    readonly backend: StorageBackend
    readonly scopes: ReadonlyArray<StorageScope>
    readonly priority: number
}

/**
 * Configuration for the StorageProvider.
 */
export interface StorageProviderConfig {
    /**
     * The primary storage backend (usually OPFS for local-first).
     */
    readonly primary: StorageBackend

    /**
     * Optional cloud backends for sync/backup.
     */
    readonly cloud?: ReadonlyArray<BackendConfig>

    /**
     * Whether to automatically sync changes to cloud backends.
     */
    readonly autoSync?: boolean

    /**
     * Delay in milliseconds before syncing after a write.
     */
    readonly syncDebounceMs?: number
}

/**
 * Progress information for sync operations.
 */
export interface SyncProgress {
    readonly total: number
    readonly completed: number
    readonly currentFile?: string
    readonly bytesTransferred: number
    readonly bytesTotal: number
}

/**
 * Result of a sync operation.
 */
export interface SyncResult {
    readonly success: boolean
    readonly filesUploaded: number
    readonly filesDownloaded: number
    readonly filesDeleted: number
    readonly errors: ReadonlyArray<{ path: string; error: string }>
}

/**
 * Storage change event for reactive updates.
 */
export interface StorageChangeEvent {
    readonly type: "write" | "delete" | "sync"
    readonly path: string
    readonly backend: StorageBackend.BackendType
    readonly timestamp: Date
}

/**
 * StorageProvider is the main facade for cloud-agnostic storage operations.
 *
 * It provides a unified interface for managing multiple storage backends,
 * supporting local-first workflows with optional cloud sync.
 *
 * @example
 * ```typescript
 * // Create provider with local storage only
 * const provider = StorageProvider.create()
 *
 * // Add cloud backend later
 * await provider.addCloudBackend(new DropboxStorageBackend(token), ["projects"])
 *
 * // Use unified API
 * await provider.write("projects/my-project/data.json", data)
 *
 * // Sync to cloud
 * await provider.sync("projects")
 * ```
 */
export class StorageProvider {
    readonly #primary: StorageBackend
    readonly #cloudBackends: Map<StorageBackend.BackendType, BackendConfig> = new Map()
    readonly #changeListeners: Set<Procedure<StorageChangeEvent>> = new Set()
    readonly #syncDebounceMs: number
    readonly #autoSync: boolean

    #syncTimer: number | undefined
    #syncInProgress = false

    private constructor(config: StorageProviderConfig) {
        this.#primary = config.primary
        this.#syncDebounceMs = config.syncDebounceMs ?? 5000
        this.#autoSync = config.autoSync ?? false

        if (config.cloud) {
            for (const cloudConfig of config.cloud) {
                this.#cloudBackends.set(cloudConfig.backend.type, cloudConfig)
            }
        }
    }

    /**
     * Create a new StorageProvider with default OPFS primary storage.
     */
    static create(config?: Partial<StorageProviderConfig>): StorageProvider {
        return new StorageProvider({
            primary: config?.primary ?? new OpfsStorageBackend(),
            cloud: config?.cloud,
            autoSync: config?.autoSync,
            syncDebounceMs: config?.syncDebounceMs
        })
    }

    /**
     * Get the primary storage backend.
     */
    get primary(): StorageBackend {
        return this.#primary
    }

    /**
     * Get all configured cloud backends.
     */
    get cloudBackends(): ReadonlyArray<BackendConfig> {
        return Array.from(this.#cloudBackends.values())
    }

    /**
     * Add a cloud backend for specific scopes.
     */
    addCloudBackend(backend: StorageBackend, scopes: StorageScope[], priority = 1): void {
        this.#cloudBackends.set(backend.type, {backend, scopes, priority})
    }

    /**
     * Remove a cloud backend.
     */
    removeCloudBackend(type: StorageBackend.BackendType): boolean {
        return this.#cloudBackends.delete(type)
    }

    /**
     * Get the appropriate backend for a given path and scope.
     */
    getBackendForPath(path: string, preferCloud = false): StorageBackend {
        if (!preferCloud) {
            return this.#primary
        }

        const scope = this.#getScopeFromPath(path)
        const cloudBackend = this.#getCloudBackendForScope(scope)

        return cloudBackend?.backend ?? this.#primary
    }

    /**
     * Write data to storage.
     * Writes to primary storage and optionally schedules cloud sync.
     */
    async write(
        path: string,
        data: Uint8Array,
        options?: StorageBackend.WriteOptions & { skipCloud?: boolean }
    ): Promise<void> {
        await this.#primary.write(path, data, options)

        this.#notifyChange({
            type: "write",
            path,
            backend: this.#primary.type,
            timestamp: new Date()
        })

        if (this.#autoSync && !options?.skipCloud) {
            this.#scheduleSyncDebounced(path)
        }
    }

    /**
     * Read data from storage.
     * Reads from primary storage first, falls back to cloud if not found.
     */
    async read(
        path: string,
        options?: StorageBackend.ReadOptions & { preferCloud?: boolean }
    ): Promise<Uint8Array> {
        if (options?.preferCloud) {
            const scope = this.#getScopeFromPath(path)
            const cloudBackend = this.#getCloudBackendForScope(scope)
            if (cloudBackend) {
                const {status, value} = await Promises.tryCatch(
                    cloudBackend.backend.read(path, options)
                )
                if (status === "resolved") {
                    return value
                }
            }
        }

        // Try primary first
        const {status, value, error} = await Promises.tryCatch(
            this.#primary.read(path, options)
        )

        if (status === "resolved") {
            return value
        }

        // Fallback to cloud backends
        const scope = this.#getScopeFromPath(path)
        const cloudBackend = this.#getCloudBackendForScope(scope)

        if (cloudBackend) {
            const cloudResult = await Promises.tryCatch(
                cloudBackend.backend.read(path, options)
            )
            if (cloudResult.status === "resolved") {
                // Cache in primary storage
                await this.#primary.write(path, cloudResult.value)
                return cloudResult.value
            }
        }

        // Re-throw original error
        throw error
    }

    /**
     * Delete data from storage.
     * Deletes from primary and optionally from cloud.
     */
    async delete(path: string, options?: { recursive?: boolean; skipCloud?: boolean }): Promise<void> {
        await this.#primary.delete(path, options?.recursive)

        this.#notifyChange({
            type: "delete",
            path,
            backend: this.#primary.type,
            timestamp: new Date()
        })

        if (!options?.skipCloud) {
            const scope = this.#getScopeFromPath(path)
            const cloudBackend = this.#getCloudBackendForScope(scope)
            if (cloudBackend) {
                await Promises.tryCatch(cloudBackend.backend.delete(path, options?.recursive))
            }
        }
    }

    /**
     * List entries at the specified path.
     */
    async list(
        path: string,
        options?: StorageBackend.ListOptions & { preferCloud?: boolean }
    ): Promise<ReadonlyArray<StorageBackend.Entry>> {
        const backend = options?.preferCloud
            ? (this.#getCloudBackendForScope(this.#getScopeFromPath(path))?.backend ?? this.#primary)
            : this.#primary

        return backend.list(path, options)
    }

    /**
     * Check if a path exists.
     */
    async exists(path: string, options?: { checkCloud?: boolean }): Promise<boolean> {
        const primaryExists = await this.#primary.exists(path)
        if (primaryExists || !options?.checkCloud) {
            return primaryExists
        }

        const scope = this.#getScopeFromPath(path)
        const cloudBackend = this.#getCloudBackendForScope(scope)

        if (cloudBackend) {
            return cloudBackend.backend.exists(path)
        }

        return false
    }

    /**
     * Sync a specific path or scope to/from cloud.
     */
    async sync(
        pathOrScope: string | StorageScope,
        options?: {
            direction?: "upload" | "download" | "both"
            onProgress?: Procedure<SyncProgress>
        }
    ): Promise<SyncResult> {
        if (this.#syncInProgress) {
            return {
                success: false,
                filesUploaded: 0,
                filesDownloaded: 0,
                filesDeleted: 0,
                errors: [{path: pathOrScope, error: "Sync already in progress"}]
            }
        }

        this.#syncInProgress = true

        try {
            const scope = this.#isScope(pathOrScope)
                ? pathOrScope
                : this.#getScopeFromPath(pathOrScope)

            const cloudBackend = this.#getCloudBackendForScope(scope)
            if (!cloudBackend) {
                return {
                    success: false,
                    filesUploaded: 0,
                    filesDownloaded: 0,
                    filesDeleted: 0,
                    errors: [{path: pathOrScope, error: "No cloud backend configured for this scope"}]
                }
            }

            const basePath = this.#isScope(pathOrScope)
                ? this.#getScopeBasePath(pathOrScope)
                : pathOrScope

            const direction = options?.direction ?? "both"
            const mutableResult = {
                success: true,
                filesUploaded: 0,
                filesDownloaded: 0,
                filesDeleted: 0,
                errors: [] as Array<{ path: string; error: string }>
            }

            if (direction === "upload" || direction === "both") {
                // Get local files
                const localEntries = await this.#getAllEntries(this.#primary, basePath)

                for (let i = 0; i < localEntries.length; i++) {
                    const entry = localEntries[i]
                    if (entry.kind === "directory") continue

                    const fullPath = `${basePath}/${entry.name}`

                    options?.onProgress?.({
                        total: localEntries.length,
                        completed: i,
                        currentFile: fullPath,
                        bytesTransferred: 0,
                        bytesTotal: 0
                    })

                    const {status, error} = await Promises.tryCatch((async () => {
                        const data = await this.#primary.read(fullPath)
                        await cloudBackend.backend.write(fullPath, data)
                    })())

                    if (status === "resolved") {
                        mutableResult.filesUploaded++
                    } else {
                        mutableResult.errors.push({
                            path: fullPath,
                            error: error instanceof Error ? error.message : String(error)
                        })
                    }
                }
            }

            if (direction === "download" || direction === "both") {
                // Get cloud files
                const cloudEntries = await this.#getAllEntries(cloudBackend.backend, basePath)

                for (let i = 0; i < cloudEntries.length; i++) {
                    const entry = cloudEntries[i]
                    if (entry.kind === "directory") continue

                    const fullPath = `${basePath}/${entry.name}`

                    // Skip if local file is newer (simple conflict resolution)
                    const localMeta = await this.#primary.getMetadata(fullPath)
                    if (localMeta.nonEmpty() && entry.modified) {
                        const localModified = localMeta.unwrap().modified
                        if (localModified && localModified > entry.modified) {
                            continue
                        }
                    }

                    options?.onProgress?.({
                        total: cloudEntries.length,
                        completed: i,
                        currentFile: fullPath,
                        bytesTransferred: 0,
                        bytesTotal: 0
                    })

                    const {status, error} = await Promises.tryCatch((async () => {
                        const data = await cloudBackend.backend.read(fullPath)
                        await this.#primary.write(fullPath, data)
                    })())

                    if (status === "resolved") {
                        mutableResult.filesDownloaded++
                    } else {
                        mutableResult.errors.push({
                            path: fullPath,
                            error: error instanceof Error ? error.message : String(error)
                        })
                    }
                }
            }

            this.#notifyChange({
                type: "sync",
                path: basePath,
                backend: cloudBackend.backend.type,
                timestamp: new Date()
            })

            return {
                ...mutableResult,
                success: mutableResult.errors.length === 0
            }
        } finally {
            this.#syncInProgress = false
        }
    }

    /**
     * Subscribe to storage change events.
     */
    onChange(listener: Procedure<StorageChangeEvent>): () => void {
        this.#changeListeners.add(listener)
        return () => this.#changeListeners.delete(listener)
    }

    /**
     * Check health of all configured backends.
     */
    async healthCheck(): Promise<Map<StorageBackend.BackendType, StorageBackend.HealthStatus>> {
        const results = new Map<StorageBackend.BackendType, StorageBackend.HealthStatus>()

        // Check primary
        results.set(this.#primary.type, await this.#primary.healthCheck())

        // Check cloud backends
        for (const [type, config] of this.#cloudBackends) {
            results.set(type, await config.backend.healthCheck())
        }

        return results
    }

    /**
     * Get storage quota for all backends.
     */
    async getStorageQuotas(): Promise<Map<StorageBackend.BackendType, { total: number; available: number } | undefined>> {
        const results = new Map<StorageBackend.BackendType, { total: number; available: number } | undefined>()

        results.set(this.#primary.type, await this.#primary.getStorageQuota())

        for (const [type, config] of this.#cloudBackends) {
            results.set(type, await config.backend.getStorageQuota())
        }

        return results
    }

    // --- Private Helpers ---

    #getScopeFromPath(path: string): StorageScope {
        const normalized = path.replace(/^\/+/, "")
        if (normalized.startsWith("projects")) return "projects"
        if (normalized.startsWith("samples")) return "samples"
        if (normalized.startsWith("soundfont")) return "soundfonts"
        return "all"
    }

    #getScopeBasePath(scope: StorageScope): string {
        switch (scope) {
            case "projects":
                return "projects/v1"
            case "samples":
                return "samples/v2"
            case "soundfonts":
                return "soundfont"
            case "all":
                return ""
        }
    }

    #isScope(value: string): value is StorageScope {
        return ["projects", "samples", "soundfonts", "all"].includes(value)
    }

    #getCloudBackendForScope(scope: StorageScope): BackendConfig | undefined {
        let bestMatch: BackendConfig | undefined
        let bestPriority = -1

        for (const config of this.#cloudBackends.values()) {
            if (config.scopes.includes(scope) || config.scopes.includes("all")) {
                if (config.priority > bestPriority) {
                    bestMatch = config
                    bestPriority = config.priority
                }
            }
        }

        return bestMatch
    }

    async #getAllEntries(backend: StorageBackend, basePath: string): Promise<StorageBackend.Entry[]> {
        const entries: StorageBackend.Entry[] = []

        const processDir = async (path: string, prefix: string) => {
            const dirEntries = await backend.list(path)
            for (const entry of dirEntries) {
                const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
                if (entry.kind === "directory") {
                    await processDir(`${path}/${entry.name}`, relativePath)
                } else {
                    entries.push({...entry, name: relativePath})
                }
            }
        }

        await processDir(basePath, "")
        return entries
    }

    #scheduleSyncDebounced(path: string): void {
        if (this.#syncTimer) {
            clearTimeout(this.#syncTimer)
        }

        this.#syncTimer = window.setTimeout(() => {
            const scope = this.#getScopeFromPath(path)
            this.sync(scope, {direction: "upload"}).catch(console.error)
        }, this.#syncDebounceMs)
    }

    #notifyChange(event: StorageChangeEvent): void {
        for (const listener of this.#changeListeners) {
            try {
                listener(event)
            } catch (error) {
                console.error("Storage change listener error:", error)
            }
        }
    }
}

// Singleton instance for global access
let defaultProvider: Option<StorageProvider> = Option.None

/**
 * Get the default storage provider instance.
 * Creates one with OPFS if not already initialized.
 */
export function getStorageProvider(): StorageProvider {
    if (defaultProvider.isEmpty()) {
        defaultProvider = Option.wrap(StorageProvider.create())
    }
    return defaultProvider.unwrap()
}

/**
 * Initialize the default storage provider with custom configuration.
 */
export function initStorageProvider(config: StorageProviderConfig): StorageProvider {
    if (defaultProvider.nonEmpty()) {
        console.warn("StorageProvider already initialized, replacing...")
    }
    const provider = StorageProvider.create(config)
    defaultProvider = Option.wrap(provider)
    return provider
}
