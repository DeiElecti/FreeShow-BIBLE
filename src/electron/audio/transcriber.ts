import fs from "fs"
import path from "path"
import {
    DEFAULT_SERMON_TRANSCRIBER_SETTINGS,
    type SermonTranscriberEngine,
    type SermonTranscriberSettings
} from "../../shared/autoScripture"

export interface TranscriberTranscriptEvent {
    text: string
    confidence?: number
    timestamp: number
    source: SermonTranscriberEngine
}

export interface TranscriberStatusUpdate {
    engine: SermonTranscriberEngine
    ready: boolean
    message?: string
    sampleRate: number
    partial: boolean
}

interface SermonTranscriberCallbacks {
    onResult: (event: TranscriberTranscriptEvent) => void
    onPartial: (event: TranscriberTranscriptEvent) => void
    onStatus: (status: TranscriberStatusUpdate) => void
    onError: (message: string) => void
}

interface AudioInfo {
    sampleRate: number
    channelCount: number
}

export class SermonTranscriber {
    private settings: SermonTranscriberSettings = { ...DEFAULT_SERMON_TRANSCRIBER_SETTINGS }
    private callbacks: SermonTranscriberCallbacks
    private vosk: any = null
    private model: any = null
    private recognizer: any = null
    private ready = false
    private active = false
    private queue: Buffer[] = []
    private processing = false
    private lastPartial = ""

    constructor(callbacks: SermonTranscriberCallbacks) {
        this.callbacks = callbacks
    }

    async configure(next: SermonTranscriberSettings) {
        const merged: SermonTranscriberSettings = {
            ...DEFAULT_SERMON_TRANSCRIBER_SETTINGS,
            ...next
        }
        this.settings = merged
        this.queue = []
        this.lastPartial = ""

        if (merged.engine !== "vosk") {
            this.disposeRecognizer()
            this.ready = false
            this.callbacks.onStatus({
                engine: merged.engine,
                ready: false,
                message: merged.engine === "disabled" ? "Speech recognizer disabled" : undefined,
                sampleRate: merged.sampleRate,
                partial: merged.enablePartial
            })
            return
        }

        this.initializeVosk(merged)
    }

    setActive(active: boolean) {
        this.active = active && this.ready
        if (!this.active) {
            this.queue = []
            this.lastPartial = ""
        }
    }

    pushAudio(buffer: Buffer, info: AudioInfo) {
        if (!this.active || !this.ready || !this.recognizer) return
        if (!buffer?.length || !info?.sampleRate) return

        const converted = convertBuffer(buffer, info.channelCount, info.sampleRate, this.settings.sampleRate)
        if (!converted) return

        this.queue.push(converted)
        this.scheduleProcessing()
    }

    private initializeVosk(settings: SermonTranscriberSettings) {
        try {
            if (!this.vosk) {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                this.vosk = require("vosk")
                if (typeof this.vosk.setLogLevel === "function") this.vosk.setLogLevel(0)
            }
        } catch (err) {
            const message =
                "Offline transcription requires the optional 'vosk' dependency. Install it and restart FreeShow to enable built-in speech recognition."
            this.callbacks.onStatus({
                engine: "vosk",
                ready: false,
                message,
                sampleRate: settings.sampleRate,
                partial: settings.enablePartial
            })
            this.callbacks.onError(message)
            this.disposeRecognizer()
            return
        }

        const modelPath = (settings.modelPath || "").trim()
        if (!modelPath) {
            const message = "Set a Vosk model path to enable offline transcription."
            this.callbacks.onStatus({
                engine: "vosk",
                ready: false,
                message,
                sampleRate: settings.sampleRate,
                partial: settings.enablePartial
            })
            this.disposeRecognizer()
            return
        }

        const resolved = path.resolve(modelPath)
        if (!fs.existsSync(resolved)) {
            const message = `Vosk model folder not found at ${resolved}`
            this.callbacks.onStatus({
                engine: "vosk",
                ready: false,
                message,
                sampleRate: settings.sampleRate,
                partial: settings.enablePartial
            })
            this.callbacks.onError(message)
            this.disposeRecognizer()
            return
        }

        try {
            this.disposeRecognizer()
            this.model = new this.vosk.Model(resolved)
            this.recognizer = new this.vosk.Recognizer({
                model: this.model,
                sampleRate: settings.sampleRate,
                maxAlternatives: settings.maxAlternatives
            })
            if (typeof this.recognizer.setWords === "function") this.recognizer.setWords(true)
            this.ready = true
            this.callbacks.onStatus({
                engine: "vosk",
                ready: true,
                message: `Model loaded: ${resolved}`,
                sampleRate: settings.sampleRate,
                partial: settings.enablePartial
            })
        } catch (err) {
            const message = `Failed to load Vosk model: ${(err as Error)?.message ?? err}`
            this.callbacks.onStatus({
                engine: "vosk",
                ready: false,
                message,
                sampleRate: settings.sampleRate,
                partial: settings.enablePartial
            })
            this.callbacks.onError(message)
            this.disposeRecognizer()
        }

        this.setActive(this.active)
    }

    private disposeRecognizer() {
        if (this.recognizer) {
            try {
                if (typeof this.recognizer.free === "function") this.recognizer.free()
            } catch (err) {
                console.warn("Failed to free Vosk recognizer", err)
            }
        }
        if (this.model) {
            try {
                if (typeof this.model.free === "function") this.model.free()
            } catch (err) {
                console.warn("Failed to free Vosk model", err)
            }
        }
        this.recognizer = null
        this.model = null
        this.ready = false
    }

    private scheduleProcessing() {
        if (this.processing) return
        this.processing = true

        const process = () => {
            if (!this.ready || !this.recognizer || !this.queue.length) {
                this.processing = false
                return
            }

            const chunk = this.queue.shift()
            if (!chunk) {
                this.processing = false
                return
            }

            try {
                const accepted = this.recognizer.acceptWaveform(chunk)
                if (accepted) {
                    const result = this.recognizer.result()
                    this.emitResult(result)
                } else {
                    const partial = this.recognizer.partialResult()
                    this.emitPartial(partial)
                }
            } catch (err) {
                const message = `Speech recognizer error: ${(err as Error)?.message ?? err}`
                this.callbacks.onError(message)
                this.callbacks.onStatus({
                    engine: this.settings.engine,
                    ready: false,
                    message,
                    sampleRate: this.settings.sampleRate,
                    partial: this.settings.enablePartial
                })
                this.disposeRecognizer()
                this.processing = false
                return
            }

            setImmediate(process)
        }

        setImmediate(process)
    }

    private emitResult(result: any) {
        if (!result) return
        const text = typeof result.text === "string" ? result.text.trim() : ""
        if (!text) return
        this.lastPartial = ""

        const confidence = computeConfidence(result?.result)
        this.callbacks.onResult({
            text,
            confidence,
            timestamp: Date.now(),
            source: this.settings.engine
        })
    }

    private emitPartial(result: any) {
        const text = typeof result?.partial === "string" ? result.partial.trim() : ""
        if (!text || text === this.lastPartial) return
        this.lastPartial = text

        const confidence = computeConfidence(result?.result)
        this.callbacks.onPartial({
            text,
            confidence,
            timestamp: Date.now(),
            source: this.settings.engine
        })
    }
}

function convertBuffer(
    buffer: Buffer,
    channelCount: number,
    inputRate: number,
    targetRate: number
): Buffer | null {
    if (!buffer.length || !inputRate || !targetRate) return null
    const mono = downmixToMono(buffer, channelCount)
    if (!mono.length) return null
    const resampled = resampleFloat32(mono, inputRate, targetRate)
    return float32ToInt16(resampled)
}

function downmixToMono(buffer: Buffer, channelCount: number): Float32Array {
    const samples = buffer.length / 2
    const source = new Int16Array(buffer.buffer, buffer.byteOffset, samples)
    const channels = Math.max(1, channelCount || 1)
    const frames = Math.floor(source.length / channels)
    const mono = new Float32Array(frames)

    if (channels === 1) {
        for (let i = 0; i < frames; i++) {
            mono[i] = source[i] / 32768
        }
        return mono
    }

    for (let i = 0; i < frames; i++) {
        let sum = 0
        for (let ch = 0; ch < channels; ch++) {
            sum += source[i * channels + ch]
        }
        mono[i] = sum / channels / 32768
    }

    return mono
}

function resampleFloat32(data: Float32Array, inputRate: number, targetRate: number): Float32Array {
    if (!data.length || inputRate === targetRate) return data
    const ratio = inputRate / targetRate
    const newLength = Math.max(1, Math.round(data.length / ratio))
    const result = new Float32Array(newLength)

    for (let i = 0; i < newLength; i++) {
        const position = i * ratio
        const index = Math.floor(position)
        const frac = position - index
        const current = data[index] ?? 0
        const next = data[index + 1] ?? current
        result[i] = current + (next - current) * frac
    }

    return result
}

function float32ToInt16(data: Float32Array): Buffer {
    const buffer = Buffer.alloc(data.length * 2)
    for (let i = 0; i < data.length; i++) {
        let sample = data[i]
        if (!Number.isFinite(sample)) sample = 0
        sample = Math.max(-1, Math.min(1, sample))
        buffer.writeInt16LE(Math.round(sample * 32767), i * 2)
    }
    return buffer
}

function computeConfidence(result: any): number | undefined {
    if (!Array.isArray(result) || !result.length) return undefined
    let total = 0
    let count = 0
    for (const entry of result) {
        const value = typeof entry?.conf === "number" ? entry.conf : undefined
        if (value === undefined || Number.isNaN(value)) continue
        total += value
        count += 1
    }
    if (!count) return undefined
    const average = total / count
    return Math.max(0, Math.min(1, average))
}

