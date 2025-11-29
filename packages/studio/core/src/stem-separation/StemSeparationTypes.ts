import {float, FloatArray} from "@opendaw/lib-std"

/**
 * Supported stem separation models.
 * Each model separates audio into different numbers and types of stems.
 */
export enum StemModel {
    /** 2 stems: vocals, accompaniment */
    TwoStem = 0,
    /** 4 stems: vocals, drums, bass, other */
    FourStem = 1,
    /** 5 stems: vocals, drums, bass, piano, other */
    FiveStem = 2
}

/**
 * Types of stems that can be extracted from audio.
 */
export type StemType =
    | "vocals"
    | "drums"
    | "bass"
    | "other"
    | "piano"
    | "accompaniment"

/**
 * Status of a stem separation job.
 */
export enum StemJobStatus {
    Pending = 0,
    Processing = 1,
    Completed = 2,
    Failed = 3
}

/**
 * Configuration for stem separation.
 */
export interface StemSeparationConfig {
    /** The model to use for separation */
    model: StemModel
    /** Which stems to extract (if not specified, all available stems are extracted) */
    stems?: StemType[]
}

/**
 * Result of stem separation for a single stem.
 */
export interface SeparatedStem {
    /** The type of stem */
    type: StemType
    /** Suggested label for this stem */
    label: string
    /** Audio data for the separated stem */
    audio: {
        sampleRate: number
        numberOfChannels: number
        numberOfFrames: number
        frames: FloatArray[]
    }
}

/**
 * Result of stem separation.
 */
export interface StemSeparationResult {
    /** The separated stems */
    stems: SeparatedStem[]
    /** Original audio duration in seconds */
    duration: float
    /** Sample rate of the output */
    sampleRate: number
}

/**
 * Progress callback for stem separation.
 */
export type StemSeparationProgress = (progress: float, message: string) => void

/**
 * Input for stem separation - raw audio data.
 */
export interface StemSeparationInput {
    /** Sample rate of the audio */
    sampleRate: number
    /** Number of audio channels (1 = mono, 2 = stereo) */
    numberOfChannels: number
    /** Number of audio frames (samples per channel) */
    numberOfFrames: number
    /** Audio data per channel */
    frames: FloatArray[]
}

/**
 * Returns the stem types available for a given model.
 */
export function getStemTypesForModel(model: StemModel): StemType[] {
    switch (model) {
        case StemModel.TwoStem:
            return ["vocals", "accompaniment"]
        case StemModel.FourStem:
            return ["vocals", "drums", "bass", "other"]
        case StemModel.FiveStem:
            return ["vocals", "drums", "bass", "piano", "other"]
    }
}

/**
 * Returns a human-readable label for a stem type.
 */
export function getStemLabel(type: StemType): string {
    switch (type) {
        case "vocals": return "Vocals"
        case "drums": return "Drums"
        case "bass": return "Bass"
        case "other": return "Other"
        case "piano": return "Piano"
        case "accompaniment": return "Accompaniment"
    }
}
