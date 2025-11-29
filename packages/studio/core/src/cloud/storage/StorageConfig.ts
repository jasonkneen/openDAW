import {Option} from "@opendaw/lib-std"
import {StorageBackend} from "./StorageBackend"
import {StorageScope} from "./StorageProvider"
import {OpfsStorageBackend} from "./OpfsStorageBackend"
import {DropboxStorageBackend} from "./DropboxStorageBackend"
import {GoogleDriveStorageBackend} from "./GoogleDriveStorageBackend"
import {S3StorageBackend, S3Config} from "./S3StorageBackend"

/**
 * Serializable configuration for a Dropbox backend.
 */
export interface DropboxBackendConfig {
    readonly type: "dropbox"
    readonly accessToken: string
    readonly scopes: ReadonlyArray<StorageScope>
    readonly priority?: number
}

/**
 * Serializable configuration for a Google Drive backend.
 */
export interface GoogleDriveBackendConfig {
    readonly type: "google-drive"
    readonly accessToken: string
    readonly scopes: ReadonlyArray<StorageScope>
    readonly priority?: number
}

/**
 * Serializable configuration for an S3 backend.
 */
export interface S3BackendConfig {
    readonly type: "s3"
    readonly config: S3Config
    readonly scopes: ReadonlyArray<StorageScope>
    readonly priority?: number
}

/**
 * Serializable configuration for an OPFS backend.
 */
export interface OpfsBackendConfig {
    readonly type: "opfs"
}

/**
 * Union type of all backend configurations.
 */
export type CloudBackendConfig = DropboxBackendConfig | GoogleDriveBackendConfig | S3BackendConfig

/**
 * Complete storage configuration that can be serialized and persisted.
 */
export interface StorageConfiguration {
    /**
     * Version number for configuration migration.
     */
    readonly version: 1

    /**
     * Primary storage backend type (usually "opfs").
     */
    readonly primary: "opfs"

    /**
     * Cloud backend configurations.
     */
    readonly cloudBackends: ReadonlyArray<CloudBackendConfig>

    /**
     * Whether to automatically sync changes.
     */
    readonly autoSync: boolean

    /**
     * Sync debounce delay in milliseconds.
     */
    readonly syncDebounceMs: number

    /**
     * Last sync timestamps per scope.
     */
    readonly lastSyncTimestamps?: Partial<Record<StorageScope, string>>
}

/**
 * Default storage configuration.
 */
export const DEFAULT_STORAGE_CONFIG: StorageConfiguration = {
    version: 1,
    primary: "opfs",
    cloudBackends: [],
    autoSync: false,
    syncDebounceMs: 5000
}

const STORAGE_CONFIG_KEY = "opendaw:storage-config"

/**
 * Factory for creating storage backends from configuration.
 */
export class StorageBackendFactory {
    /**
     * Create a storage backend from configuration.
     */
    static createBackend(config: CloudBackendConfig | OpfsBackendConfig): StorageBackend {
        switch (config.type) {
            case "opfs":
                return new OpfsStorageBackend()
            case "dropbox":
                return new DropboxStorageBackend(config.accessToken)
            case "google-drive":
                return new GoogleDriveStorageBackend(config.accessToken)
            case "s3":
                return new S3StorageBackend(config.config)
        }
    }

    /**
     * Create all backends from a storage configuration.
     */
    static createFromConfig(config: StorageConfiguration): {
        primary: StorageBackend
        cloud: Array<{ backend: StorageBackend; scopes: ReadonlyArray<StorageScope>; priority: number }>
    } {
        const primary = new OpfsStorageBackend()
        const cloud: Array<{ backend: StorageBackend; scopes: ReadonlyArray<StorageScope>; priority: number }> = []

        for (const backendConfig of config.cloudBackends) {
            cloud.push({
                backend: this.createBackend(backendConfig),
                scopes: backendConfig.scopes,
                priority: backendConfig.priority ?? 1
            })
        }

        return {primary, cloud}
    }
}

/**
 * Storage configuration manager for persisting and loading configurations.
 */
export class StorageConfigManager {
    /**
     * Load storage configuration from localStorage.
     */
    static load(): StorageConfiguration {
        try {
            const stored = localStorage.getItem(STORAGE_CONFIG_KEY)
            if (stored) {
                const parsed = JSON.parse(stored) as StorageConfiguration
                // Validate version and migrate if needed
                if (parsed.version === 1) {
                    return parsed
                }
            }
        } catch (error) {
            console.warn("Failed to load storage configuration:", error)
        }
        return DEFAULT_STORAGE_CONFIG
    }

    /**
     * Save storage configuration to localStorage.
     * Note: Access tokens are stored - consider encryption for production.
     */
    static save(config: StorageConfiguration): void {
        try {
            localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify(config))
        } catch (error) {
            console.error("Failed to save storage configuration:", error)
        }
    }

    /**
     * Clear stored configuration.
     */
    static clear(): void {
        localStorage.removeItem(STORAGE_CONFIG_KEY)
    }

    /**
     * Add a cloud backend to the configuration.
     */
    static addCloudBackend(
        current: StorageConfiguration,
        backend: CloudBackendConfig
    ): StorageConfiguration {
        // Remove existing backend of same type
        const filtered = current.cloudBackends.filter(b => b.type !== backend.type)
        return {
            ...current,
            cloudBackends: [...filtered, backend]
        }
    }

    /**
     * Remove a cloud backend from the configuration.
     */
    static removeCloudBackend(
        current: StorageConfiguration,
        type: StorageBackend.BackendType
    ): StorageConfiguration {
        return {
            ...current,
            cloudBackends: current.cloudBackends.filter(b => b.type !== type)
        }
    }

    /**
     * Update auto-sync setting.
     */
    static setAutoSync(current: StorageConfiguration, enabled: boolean): StorageConfiguration {
        return {...current, autoSync: enabled}
    }

    /**
     * Update sync debounce setting.
     */
    static setSyncDebounce(current: StorageConfiguration, ms: number): StorageConfiguration {
        return {...current, syncDebounceMs: ms}
    }

    /**
     * Update last sync timestamp for a scope.
     */
    static updateSyncTimestamp(
        current: StorageConfiguration,
        scope: StorageScope
    ): StorageConfiguration {
        return {
            ...current,
            lastSyncTimestamps: {
                ...current.lastSyncTimestamps,
                [scope]: new Date().toISOString()
            }
        }
    }
}

/**
 * Reactive storage configuration hook for UI integration.
 */
export class StorageConfigSignal {
    static #listeners: Set<(config: StorageConfiguration) => void> = new Set()
    static #current: Option<StorageConfiguration> = Option.None

    /**
     * Get the current configuration.
     */
    static get(): StorageConfiguration {
        if (this.#current.isEmpty()) {
            this.#current = Option.wrap(StorageConfigManager.load())
        }
        return this.#current.unwrap()
    }

    /**
     * Update and persist configuration.
     */
    static set(config: StorageConfiguration): void {
        this.#current = Option.wrap(config)
        StorageConfigManager.save(config)
        this.#notify(config)
    }

    /**
     * Subscribe to configuration changes.
     */
    static subscribe(listener: (config: StorageConfiguration) => void): () => void {
        this.#listeners.add(listener)
        // Immediately call with current value
        listener(this.get())
        return () => this.#listeners.delete(listener)
    }

    static #notify(config: StorageConfiguration): void {
        for (const listener of this.#listeners) {
            try {
                listener(config)
            } catch (error) {
                console.error("Storage config listener error:", error)
            }
        }
    }
}
