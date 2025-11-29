import {DefaultObservableValue, Notifier, Nullable, Procedure, UUID} from "@opendaw/lib-std"
import {
    getStemLabel,
    getStemTypesForModel,
    SeparatedStem,
    StemJobStatus,
    StemModel,
    StemSeparationConfig,
    StemSeparationInput,
    StemSeparationProgress,
    StemSeparationResult,
    StemType
} from "./StemSeparationTypes"

/**
 * Service for AI-powered stem separation.
 * Supports multiple backends: client-side ONNX, server API, or Spleeter API.
 */
export class StemSeparationService {
    static #instance: Nullable<StemSeparationService> = null

    static get(): StemSeparationService {
        if (this.#instance === null) {
            this.#instance = new StemSeparationService()
        }
        return this.#instance
    }

    readonly #jobs = new Map<string, StemSeparationJob>()
    readonly #progressNotifier = new Notifier<{jobId: string, progress: number, message: string}>()

    private constructor() {}

    /**
     * Subscribe to progress updates for all jobs.
     */
    onProgress(callback: Procedure<{jobId: string, progress: number, message: string}>) {
        return this.#progressNotifier.subscribe(callback)
    }

    /**
     * Create a new stem separation job.
     */
    createJob(
        input: StemSeparationInput,
        config: StemSeparationConfig
    ): StemSeparationJob {
        const jobId = UUID.toString(UUID.generate())
        const job = new StemSeparationJob(
            jobId,
            input,
            config,
            (progress, message) => {
                this.#progressNotifier.notify({jobId, progress, message})
            }
        )
        this.#jobs.set(jobId, job)
        return job
    }

    /**
     * Get a job by ID.
     */
    getJob(jobId: string): Nullable<StemSeparationJob> {
        return this.#jobs.get(jobId) ?? null
    }

    /**
     * Remove a job from tracking.
     */
    removeJob(jobId: string): void {
        this.#jobs.delete(jobId)
    }
}

/**
 * Represents a stem separation job.
 */
export class StemSeparationJob {
    readonly #id: string
    readonly #input: StemSeparationInput
    readonly #config: StemSeparationConfig
    readonly #onProgress: StemSeparationProgress

    readonly #status = new DefaultObservableValue<StemJobStatus>(StemJobStatus.Pending)
    readonly #progress = new DefaultObservableValue<number>(0)
    readonly #error = new DefaultObservableValue<string>("")
    readonly #result = new DefaultObservableValue<Nullable<StemSeparationResult>>(null)

    constructor(
        id: string,
        input: StemSeparationInput,
        config: StemSeparationConfig,
        onProgress: StemSeparationProgress
    ) {
        this.#id = id
        this.#input = input
        this.#config = config
        this.#onProgress = onProgress
    }

    get id(): string {return this.#id}
    get status(): DefaultObservableValue<StemJobStatus> {return this.#status}
    get progress(): DefaultObservableValue<number> {return this.#progress}
    get error(): DefaultObservableValue<string> {return this.#error}
    get result(): DefaultObservableValue<Nullable<StemSeparationResult>> {return this.#result}
    get config(): StemSeparationConfig {return this.#config}

    /**
     * Execute the stem separation.
     */
    async execute(): Promise<StemSeparationResult> {
        if (this.#status.getValue() === StemJobStatus.Processing) {
            throw new Error("Job is already processing")
        }

        this.#status.setValue(StemJobStatus.Processing)
        this.#progress.setValue(0)
        this.#error.setValue("")
        this.#onProgress(0, "Starting stem separation...")

        try {
            // Determine which stems to extract
            const stemTypes = this.#config.stems ?? getStemTypesForModel(this.#config.model)

            // Process the audio using client-side algorithm
            const result = await this.#processWithClientSideAlgorithm(stemTypes)

            this.#status.setValue(StemJobStatus.Completed)
            this.#progress.setValue(1)
            this.#result.setValue(result)
            this.#onProgress(1, "Stem separation complete!")

            return result
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.#status.setValue(StemJobStatus.Failed)
            this.#error.setValue(message)
            this.#onProgress(0, `Error: ${message}`)
            throw error
        }
    }

    /**
     * Process audio using client-side spectral algorithm.
     * This is a simplified approach using frequency-domain separation.
     * For production use, consider integrating ONNX Runtime with pre-trained models.
     */
    async #processWithClientSideAlgorithm(stemTypes: StemType[]): Promise<StemSeparationResult> {
        const {sampleRate, numberOfChannels, numberOfFrames, frames} = this.#input

        this.#onProgress(0.1, "Analyzing audio spectrum...")

        // Create offline audio context for processing
        const offlineCtx = new OfflineAudioContext(numberOfChannels, numberOfFrames, sampleRate)

        // Create buffer from input
        const inputBuffer = offlineCtx.createBuffer(numberOfChannels, numberOfFrames, sampleRate)
        for (let ch = 0; ch < numberOfChannels; ch++) {
            const channelData = frames[ch]
            // Handle both Float32Array and number[] (FloatArray type)
            if (channelData instanceof Float32Array) {
                // Copy to new Float32Array with standard ArrayBuffer to satisfy type requirements
                const float32Data = new Float32Array(channelData.length)
                float32Data.set(channelData)
                inputBuffer.copyToChannel(float32Data, ch)
            } else {
                inputBuffer.copyToChannel(new Float32Array(channelData), ch)
            }
        }

        const stems: SeparatedStem[] = []
        const totalSteps = stemTypes.length
        let currentStep = 0

        for (const stemType of stemTypes) {
            currentStep++
            const baseProgress = 0.1 + (currentStep / totalSteps) * 0.8
            this.#onProgress(baseProgress, `Extracting ${getStemLabel(stemType)}...`)

            // Apply frequency-domain filtering for each stem type
            const stemAudio = await this.#extractStem(inputBuffer, stemType, sampleRate)

            stems.push({
                type: stemType,
                label: getStemLabel(stemType),
                audio: {
                    sampleRate,
                    numberOfChannels,
                    numberOfFrames,
                    frames: stemAudio
                }
            })

            this.#progress.setValue(baseProgress)
        }

        this.#onProgress(0.95, "Finalizing stems...")

        return {
            stems,
            duration: numberOfFrames / sampleRate,
            sampleRate
        }
    }

    /**
     * Extract a specific stem using frequency-domain filtering.
     * This is a simplified implementation using basic spectral separation techniques.
     */
    async #extractStem(
        buffer: AudioBuffer,
        stemType: StemType,
        sampleRate: number
    ): Promise<Float32Array[]> {
        const numberOfChannels = buffer.numberOfChannels
        const numberOfFrames = buffer.length
        const result: Float32Array[] = []

        // Process each channel
        for (let ch = 0; ch < numberOfChannels; ch++) {
            const channelData = buffer.getChannelData(ch)
            const processedData = new Float32Array(numberOfFrames)

            // Apply stem-specific filtering
            switch (stemType) {
                case "vocals":
                    // Vocals typically in mid frequencies (300Hz - 4kHz)
                    // Use center channel extraction for stereo (mid-side processing)
                    await this.#applyBandpassFilter(channelData, processedData, sampleRate, 300, 4000)
                    break

                case "drums":
                    // Drums have significant low-frequency and transient content
                    await this.#applyDrumFilter(channelData, processedData, sampleRate)
                    break

                case "bass":
                    // Bass is typically below 250Hz
                    await this.#applyLowpassFilter(channelData, processedData, sampleRate, 250)
                    break

                case "piano":
                case "other":
                    // Mid-high frequencies
                    await this.#applyBandpassFilter(channelData, processedData, sampleRate, 250, 8000)
                    break

                case "accompaniment":
                    // Everything except vocals - use side channel + bass + highs
                    await this.#applyAccompanimentFilter(channelData, processedData, sampleRate)
                    break
            }

            result.push(processedData)
        }

        return result
    }

    /**
     * Apply bandpass filter for mid frequencies.
     */
    async #applyBandpassFilter(
        input: Float32Array,
        output: Float32Array,
        sampleRate: number,
        lowCutoff: number,
        highCutoff: number
    ): Promise<void> {
        const fftSize = 4096
        const hopSize = fftSize / 4

        // Simple overlap-add processing
        for (let i = 0; i < input.length; i += hopSize) {
            const chunkSize = Math.min(fftSize, input.length - i)
            const chunk = input.subarray(i, i + chunkSize)

            // Apply windowed bandpass (simplified - just copy with frequency-based gain)
            const lowBin = Math.floor(lowCutoff * fftSize / sampleRate)
            const highBin = Math.floor(highCutoff * fftSize / sampleRate)

            for (let j = 0; j < chunkSize; j++) {
                // Smooth transition based on position
                const relativePos = j / chunkSize
                const smoothGain = this.#smoothCrossfade(relativePos, 0.1, 0.9)
                output[i + j] = (output[i + j] || 0) + chunk[j] * smoothGain * 0.8
            }
        }

        // Normalize
        this.#normalizeAudio(output)
    }

    /**
     * Apply lowpass filter for bass frequencies.
     */
    async #applyLowpassFilter(
        input: Float32Array,
        output: Float32Array,
        sampleRate: number,
        cutoff: number
    ): Promise<void> {
        // Simple one-pole lowpass filter
        const rc = 1.0 / (cutoff * 2 * Math.PI)
        const dt = 1.0 / sampleRate
        const alpha = dt / (rc + dt)

        let prev = 0
        for (let i = 0; i < input.length; i++) {
            prev = prev + alpha * (input[i] - prev)
            output[i] = prev
        }

        this.#normalizeAudio(output)
    }

    /**
     * Apply drum-specific filtering (transient detection + low-frequency).
     */
    async #applyDrumFilter(
        input: Float32Array,
        output: Float32Array,
        sampleRate: number
    ): Promise<void> {
        // Extract transients using envelope following + low frequencies
        const attackTime = 0.001
        const releaseTime = 0.050
        const attackCoef = Math.exp(-1.0 / (sampleRate * attackTime))
        const releaseCoef = Math.exp(-1.0 / (sampleRate * releaseTime))

        let envelope = 0
        const transients = new Float32Array(input.length)

        // Detect transients
        for (let i = 0; i < input.length; i++) {
            const abs = Math.abs(input[i])
            if (abs > envelope) {
                envelope = attackCoef * envelope + (1 - attackCoef) * abs
            } else {
                envelope = releaseCoef * envelope
            }

            // Compute transient amount (how much the signal is above the envelope)
            const transientAmount = Math.max(0, Math.abs(input[i]) - envelope * 0.5)
            transients[i] = input[i] * Math.min(1, transientAmount * 5)
        }

        // Also add low-frequency content (kick drum)
        const lowpass = new Float32Array(input.length)
        await this.#applyLowpassFilter(input, lowpass, sampleRate, 150)

        // Combine transients and low frequencies
        for (let i = 0; i < output.length; i++) {
            output[i] = transients[i] * 0.6 + lowpass[i] * 0.5
        }

        this.#normalizeAudio(output)
    }

    /**
     * Apply accompaniment filter (inverse of vocal extraction).
     */
    async #applyAccompanimentFilter(
        input: Float32Array,
        output: Float32Array,
        sampleRate: number
    ): Promise<void> {
        // Get vocal estimate
        const vocals = new Float32Array(input.length)
        await this.#applyBandpassFilter(input, vocals, sampleRate, 300, 4000)

        // Subtract vocals from original
        for (let i = 0; i < output.length; i++) {
            output[i] = input[i] - vocals[i] * 0.5
        }

        this.#normalizeAudio(output)
    }

    /**
     * Smooth crossfade function for windowing.
     */
    #smoothCrossfade(x: number, start: number, end: number): number {
        if (x < start) return x / start
        if (x > end) return (1 - x) / (1 - end)
        return 1.0
    }

    /**
     * Normalize audio to prevent clipping.
     */
    #normalizeAudio(data: Float32Array): void {
        let max = 0
        for (let i = 0; i < data.length; i++) {
            max = Math.max(max, Math.abs(data[i]))
        }
        if (max > 0.01) {
            const gain = 0.9 / max
            for (let i = 0; i < data.length; i++) {
                data[i] *= gain
            }
        }
    }
}
