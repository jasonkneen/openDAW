import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {IndexConstraints, UnipolarConstraints} from "./Defaults"

/**
 * Represents a stem separation job configuration and state.
 * This box stores the configuration for AI-powered stem splitting.
 */
export const StemSeparationJobBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "StemSeparationJobBox",
        fields: {
            1: {type: "int32", name: "model", value: 0, ...IndexConstraints}, // 0=4-stem, 1=2-stem, 2=5-stem
            2: {type: "int32", name: "status", value: 0, ...IndexConstraints}, // 0=pending, 1=processing, 2=completed, 3=failed
            3: {type: "float32", name: "progress", value: 0, ...UnipolarConstraints},
            4: {type: "string", name: "error-message", value: ""}
        }
    },
    pointerRules: {accepts: [Pointers.StemSeparationJob], mandatory: false}
}

/**
 * Represents a single stem output from the separation process.
 * Links to the generated AudioFileBox for the separated stem.
 */
export const StemSeparationOutputBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "StemSeparationOutputBox",
        fields: {
            1: {type: "string", name: "stem-type"}, // "vocals", "drums", "bass", "other", "piano", "guitar"
            2: {type: "string", name: "label"},
            3: {type: "float32", name: "gain", value: 1.0, constraints: "non-negative", unit: ""}
        }
    },
    pointerRules: {accepts: [Pointers.StemSeparationOutput, Pointers.AudioFile], mandatory: false}
}
