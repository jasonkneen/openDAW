/**
 * Cloud-agnostic storage facade for openDAW.
 *
 * This module provides a unified interface for storing projects and sample libraries
 * across different cloud services (OPFS, Dropbox, Google Drive, S3).
 *
 * @example
 * ```typescript
 * import {
 *   StorageProvider,
 *   getStorageProvider,
 *   DropboxStorageBackend,
 *   StorageConfigManager
 * } from "@opendaw/studio-core/cloud/storage"
 *
 * // Get the default provider (uses OPFS)
 * const provider = getStorageProvider()
 *
 * // Add Dropbox for cloud sync
 * const dropbox = new DropboxStorageBackend(accessToken)
 * provider.addCloudBackend(dropbox, ["projects", "samples"])
 *
 * // Write to storage (local + cloud sync)
 * await provider.write("projects/my-project/data.json", data)
 *
 * // Manually sync to cloud
 * await provider.sync("projects")
 * ```
 *
 * @module
 */

// Core types and interface
export type {StorageBackend} from "./StorageBackend"
export {AbstractStorageBackend} from "./StorageBackend"

// Backend implementations
export {OpfsStorageBackend} from "./OpfsStorageBackend"
export {DropboxStorageBackend} from "./DropboxStorageBackend"
export {GoogleDriveStorageBackend} from "./GoogleDriveStorageBackend"
export {S3StorageBackend, type S3Config} from "./S3StorageBackend"

// Main facade
export {
    StorageProvider,
    getStorageProvider,
    initStorageProvider,
    type StorageScope,
    type BackendConfig,
    type StorageProviderConfig,
    type SyncProgress,
    type SyncResult,
    type StorageChangeEvent
} from "./StorageProvider"

// Configuration
export {
    StorageBackendFactory,
    StorageConfigManager,
    StorageConfigSignal,
    DEFAULT_STORAGE_CONFIG,
    type StorageConfiguration,
    type CloudBackendConfig,
    type DropboxBackendConfig,
    type GoogleDriveBackendConfig,
    type S3BackendConfig,
    type OpfsBackendConfig
} from "./StorageConfig"
