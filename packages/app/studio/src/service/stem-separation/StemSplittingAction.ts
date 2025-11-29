import {FloatArray, Progress, UUID} from "@opendaw/lib-std"
import {SamplePeaks} from "@opendaw/lib-fusion"
import {AudioData, AudioRegionBoxAdapter} from "@opendaw/studio-adapters"
import {
    StemSeparationService,
    SeparatedStem,
    SampleStorage,
    Workers,
    Project
} from "@opendaw/studio-core"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {
    showStemSplittingDialog,
    showStemSplittingProgress,
    StemSplittingConfig
} from "./StemSplittingDialog"

export interface StemSplittingActionContext {
    project: Project
    region: AudioRegionBoxAdapter
}

/**
 * Execute the stem splitting action for an audio region.
 */
export async function executeStemSplitting(context: StemSplittingActionContext): Promise<void> {
    const {project, region} = context

    // Get the audio data
    const audioData = region.file.data
    if (audioData.isEmpty()) {
        throw new Error("Audio data not loaded")
    }

    const audio = audioData.unwrap()
    const fileName = region.label || "Audio"

    // Show configuration dialog
    let dialogResult
    try {
        dialogResult = await showStemSplittingDialog(fileName)
    } catch {
        // User cancelled
        return
    }

    const {config} = dialogResult

    // Show progress dialog
    const progressDialog = await showStemSplittingProgress()

    try {
        // Prepare input for the service - convert frames to mutable array
        const frames: FloatArray[] = []
        for (let i = 0; i < audio.numberOfChannels; i++) {
            const channelData = audio.frames[i]
            if (channelData instanceof Float32Array) {
                frames.push(new Float32Array(channelData))
            } else {
                frames.push([...channelData])
            }
        }

        // Create and execute the separation job
        const service = StemSeparationService.get()
        const job = service.createJob({
            sampleRate: audio.sampleRate,
            numberOfChannels: audio.numberOfChannels,
            numberOfFrames: audio.numberOfFrames,
            frames
        }, {
            model: config.model,
            stems: Array.from(config.selectedStems)
        })

        // Subscribe to progress updates
        const progressSub = service.onProgress(({jobId, progress, message}) => {
            if (jobId === job.id) {
                progressDialog.update(progress, message)
            }
        })

        try {
            const result = await job.execute()

            progressDialog.update(0.95, "Creating stems...")

            // Import separated stems as audio files
            await importSeparatedStems(project, result.stems, fileName, config)

            progressDialog.complete()
        } finally {
            progressSub.terminate()
            service.removeJob(job.id)
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        progressDialog.fail(message)
        throw error
    }
}

/**
 * Import separated stems as audio files.
 */
async function importSeparatedStems(
    project: Project,
    stems: SeparatedStem[],
    originalName: string,
    config: StemSplittingConfig
): Promise<void> {
    const {editing} = project
    const graph = project.rootBoxAdapter.box.graph

    // First, store all stem audio data
    const stemData: Array<{
        stem: SeparatedStem
        audioFileUuid: UUID.Bytes
        stemLabel: string
    }> = []

    for (const stem of stems) {
        // Skip stems that weren't selected
        if (!config.selectedStems.has(stem.type)) {
            continue
        }

        const stemLabel = `${originalName} - ${stem.label}`
        const audioFileUuid = UUID.generate()

        // Convert FloatArray[] to Float32Array[] for storage
        const float32Frames: Float32Array[] = stem.audio.frames.map(frame => {
            if (frame instanceof Float32Array) {
                return new Float32Array(frame)
            }
            return new Float32Array(frame)
        })

        const audioDataForStorage: AudioData = {
            sampleRate: stem.audio.sampleRate,
            numberOfChannels: stem.audio.numberOfChannels,
            numberOfFrames: stem.audio.numberOfFrames,
            frames: float32Frames
        }

        await storeStemAudio(project, audioFileUuid, audioDataForStorage, stemLabel)
        stemData.push({stem, audioFileUuid, stemLabel})
    }

    // Then create the audio file boxes in a single edit transaction
    editing.modify(() => {
        for (const {stem, audioFileUuid, stemLabel} of stemData) {
            AudioFileBox.create(graph, audioFileUuid, box => {
                box.fileName.setValue(stemLabel)
                box.startInSeconds.setValue(0)
                box.endInSeconds.setValue(stem.audio.numberOfFrames / stem.audio.sampleRate)
            })
        }
    })
}

/**
 * Store audio data for a stem in the project's sample storage.
 */
async function storeStemAudio(
    project: Project,
    uuid: UUID.Bytes,
    audio: AudioData,
    label: string
): Promise<void> {
    // Generate peaks for waveform visualization
    const shifts = SamplePeaks.findBestFit(audio.numberOfFrames)
    const peaks = await Workers.Peak.generateAsync(
        Progress.Empty,
        shifts,
        audio.frames,
        audio.numberOfFrames,
        audio.numberOfChannels
    ) as ArrayBuffer

    // Save to sample storage
    await SampleStorage.get().save({
        uuid,
        audio,
        peaks,
        meta: {
            name: label,
            bpm: 0, // BPM not detected for stems
            duration: audio.numberOfFrames / audio.sampleRate,
            sample_rate: audio.sampleRate,
            origin: "import"
        }
    })

    // Invalidate the sample loader to reload from storage
    project.sampleManager.invalidate(uuid)
}
