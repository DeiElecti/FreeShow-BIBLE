import { randomUUID } from "crypto"
import express, { type Request, type Response } from "express"
import http from "http"
import os from "os"
import {
    DEFAULT_SERMON_LISTENER_SETTINGS,
    DEFAULT_SERMON_TRANSCRIBER_SETTINGS,
    type AutoScriptureCommand,
    type AutoScriptureExternalReference,
    type AutoScriptureReference,
    type AutoScriptureStatus,
    type AutoScriptureSuggestion,
    type AutoScriptureEndpoint,
    type AutoScriptureTranscriptEvent,
    type AutoScriptureStatusReport,
    type SermonTranscriberSettings,
    type SermonListenerSettings,
    formatScriptureReference,
    getBookMeta
} from "../../shared/autoScripture"
import { SCRIPTURE_AUTO } from "../../types/Channels"
import { stores } from "../data/store"
import { toApp } from "../index"
import { extractReferences, hasReferenceParser } from "./scriptureReference"
import {
    SermonTranscriber,
    type TranscriberStatusUpdate,
    type TranscriberTranscriptEvent
} from "./transcriber"

interface TranscriptPayload {
    text: string
    confidence?: number
    speaker?: string
    timestamp?: number
    source?: string
}

let settings: SermonListenerSettings = { ...DEFAULT_SERMON_LISTENER_SETTINGS }
let status: AutoScriptureStatus = {
    enabled: DEFAULT_SERMON_LISTENER_SETTINGS.enabled,
    listening: false,
    port: DEFAULT_SERMON_LISTENER_SETTINGS.port,
    autoDisplay: DEFAULT_SERMON_LISTENER_SETTINGS.autoDisplay,
    minConfidence: DEFAULT_SERMON_LISTENER_SETTINGS.minConfidence,
    duplicateInterval: DEFAULT_SERMON_LISTENER_SETTINGS.duplicateInterval,
    maxVerses: DEFAULT_SERMON_LISTENER_SETTINGS.maxVerses,
    scriptureId: DEFAULT_SERMON_LISTENER_SETTINGS.scriptureId,
    recognizedReferences: 0,
    httpEndpoint: undefined,
    httpEndpoints: [],
    customEndpoints: [...DEFAULT_SERMON_LISTENER_SETTINGS.customEndpoints],
    contextWindow: DEFAULT_SERMON_LISTENER_SETTINGS.contextWindow,
    transcriberEngine: DEFAULT_SERMON_TRANSCRIBER_SETTINGS.engine,
    transcriberReady: false,
    transcriberMessage: undefined,
    transcriberSampleRate: DEFAULT_SERMON_TRANSCRIBER_SETTINGS.sampleRate,
    transcriberPartial: DEFAULT_SERMON_TRANSCRIBER_SETTINGS.enablePartial
}

let httpServer: http.Server | null = null
let expressApp: express.Express | null = null
const seenReferences: Map<string, number> = new Map()
const parserAvailable = hasReferenceParser()
let transcriber: SermonTranscriber | null = null
const transcriptHistory: AutoScriptureTranscriptEvent[] = []
const suggestionHistory: AutoScriptureSuggestion[] = []
const transcriptContext: { text: string; timestamp: number }[] = []
interface SseClient {
    id: string
    res: Response
    heartbeat: NodeJS.Timeout | null
}
const sseClients: Map<string, SseClient> = new Map()
const SSE_HEARTBEAT_INTERVAL = 30000
const TRANSCRIPT_HISTORY_LIMIT = 25
const SUGGESTION_HISTORY_LIMIT = 25
const TRANSCRIPT_CONTEXT_LIMIT = 12

export function initializeSermonListener() {
    applySettings(readSettings())

    const store: any = stores.SETTINGS
    if (store?.onDidChange) {
        store.onDidChange("special", () => {
            applySettings(readSettings())
        })
    }

    if (!parserAvailable) {
        sendError(
            "Automatic scripture detection requires the bible-passage-reference-parser dependency, but pre-parsed references can still be ingested via /reference."
        )
    }

    emitStatus()
}

export function handleAutoScriptureCommand(command: AutoScriptureCommand): AutoScriptureStatus | void {
    switch (command.action) {
        case "REQUEST_STATUS":
            return emitStatus()
        case "INGEST_TRANSCRIPT":
            processTranscript({
                text: command.text,
                confidence: command.confidence,
                speaker: command.speaker,
                timestamp: command.timestamp,
                source: command.source ?? "manual"
            })
            return emitStatus()
        case "INGEST_REFERENCE":
            ingestExternalReferences({
                reference: command.reference,
                references: command.references,
                confidence: command.confidence,
                source: command.source ?? "manual",
                timestamp: command.timestamp,
                transcript: command.transcript
            })
            return emitStatus()
        case "RESET_HISTORY":
            seenReferences.clear()
            status.recognizedReferences = 0
            status.lastSuggestionAt = undefined
            clearHistories()
            sendReset()
            return emitStatus()
        default:
            return emitStatus()
    }
}

export function submitAudioBuffer(buffer: Buffer, info: { sampleRate: number; channelCount: number }) {
    if (!settings.enabled) return
    ensureTranscriber()?.pushAudio(buffer, info)
}

function readSettings(): SermonListenerSettings {
    const special = stores.SETTINGS.get("special") || {}
    const stored: Partial<SermonListenerSettings> = special?.sermonListener || {}

    const customEndpoints = Array.isArray(stored.customEndpoints)
        ? Array.from(
              new Set(
                  stored.customEndpoints
                      .map((entry) => normalizeCustomEndpoint(entry))
                      .filter((entry): entry is string => typeof entry === "string" && !!entry)
              )
          )
        : []

    const transcriber = sanitizeTranscriberSettings((stored as any)?.transcriber)

    const contextWindow =
        typeof stored.contextWindow === "number" && stored.contextWindow >= 0
            ? Math.min(120, Math.floor(stored.contextWindow))
            : DEFAULT_SERMON_LISTENER_SETTINGS.contextWindow

    const sanitized: SermonListenerSettings = {
        enabled: stored.enabled ?? DEFAULT_SERMON_LISTENER_SETTINGS.enabled,
        autoDisplay: stored.autoDisplay ?? DEFAULT_SERMON_LISTENER_SETTINGS.autoDisplay,
        port: Number.isFinite(stored.port) ? Number(stored.port) : DEFAULT_SERMON_LISTENER_SETTINGS.port,
        minConfidence: typeof stored.minConfidence === "number" ? Math.min(Math.max(stored.minConfidence, 0), 1) : DEFAULT_SERMON_LISTENER_SETTINGS.minConfidence,
        duplicateInterval: typeof stored.duplicateInterval === "number" && stored.duplicateInterval > 0 ? stored.duplicateInterval : DEFAULT_SERMON_LISTENER_SETTINGS.duplicateInterval,
        maxVerses: typeof stored.maxVerses === "number" && stored.maxVerses > 0 ? Math.max(1, Math.floor(stored.maxVerses)) : DEFAULT_SERMON_LISTENER_SETTINGS.maxVerses,
        scriptureId: stored.scriptureId ?? DEFAULT_SERMON_LISTENER_SETTINGS.scriptureId,
        contextWindow,
        customEndpoints,
        transcriber
    }

    return sanitized
}

function applySettings(newSettings: SermonListenerSettings) {
    const mustRestart = settings.enabled !== newSettings.enabled || settings.port !== newSettings.port
    settings = newSettings

    status.enabled = settings.enabled
    status.port = settings.port
    status.autoDisplay = settings.autoDisplay
    status.minConfidence = settings.minConfidence
    status.duplicateInterval = settings.duplicateInterval
    status.maxVerses = settings.maxVerses
    status.scriptureId = settings.scriptureId
    status.customEndpoints = [...settings.customEndpoints]
    status.contextWindow = settings.contextWindow
    status.transcriberEngine = settings.transcriber?.engine ?? DEFAULT_SERMON_TRANSCRIBER_SETTINGS.engine
    status.transcriberSampleRate = settings.transcriber?.sampleRate ?? DEFAULT_SERMON_TRANSCRIBER_SETTINGS.sampleRate
    status.transcriberPartial = settings.transcriber?.enablePartial ?? DEFAULT_SERMON_TRANSCRIBER_SETTINGS.enablePartial

    if (settings.contextWindow <= 0) {
        clearTranscriptContext()
    } else {
        pruneTranscriptContext(Date.now(), settings.contextWindow * 1000)
    }
    if (!settings.enabled) {
        status.httpEndpoint = undefined
        status.httpEndpoints = []
        status.transcriberReady = false
        ensureTranscriber()?.setActive(false)
        scheduleTranscriberUpdate()
        stopServer()
        emitStatus()
        return
    }

    if (mustRestart || !status.listening) {
        status.httpEndpoint = undefined
        status.httpEndpoints = []
        startServer()
        return
    }

    status.httpEndpoints = buildHttpEndpoints(settings.port, settings.customEndpoints)
    status.httpEndpoint = status.httpEndpoints[0]?.url
    scheduleTranscriberUpdate()
    emitStatus()
}

function startServer() {
    stopServer()

    expressApp = express()
    expressApp.disable("x-powered-by")
    expressApp.use(express.json({ limit: "1mb" }))

    expressApp.post("/transcript", (req: Request, res: Response) => {
        const { text, confidence, speaker, timestamp, source, reference, references, transcript } = req.body || {}

        if (typeof text !== "string" || !text.trim()) {
            res.status(400).json({ error: "Missing transcript text" })
            return
        }

        processTranscript({
            text: text.toString(),
            confidence: typeof confidence === "number" ? confidence : undefined,
            speaker: typeof speaker === "string" ? speaker : undefined,
            timestamp: typeof timestamp === "number" ? timestamp : Date.now(),
            source: typeof source === "string" ? source : "http"
        })

        const result = ingestExternalReferences({
            reference: reference && typeof reference === "object" ? (reference as AutoScriptureExternalReference) : undefined,
            references: Array.isArray(references)
                ? (references as AutoScriptureExternalReference[]).filter((entry) => entry && typeof entry === "object")
                : undefined,
            confidence: typeof confidence === "number" ? confidence : undefined,
            source: typeof source === "string" ? source : "http",
            timestamp: typeof timestamp === "number" ? timestamp : undefined,
            transcript: typeof transcript === "string" ? transcript : undefined
        })

        if (result.accepted || result.transcriptLogged) emitStatus()

        res.status(202).json({ status: "accepted", accepted: result.accepted })
    })

    expressApp.post("/reference", (req: Request, res: Response) => {
        const { reference, references, confidence, source, timestamp, transcript } = req.body || {}

        const result = ingestExternalReferences({
            reference: reference && typeof reference === "object" ? (reference as AutoScriptureExternalReference) : undefined,
            references: Array.isArray(references)
                ? (references as AutoScriptureExternalReference[]).filter((entry) => entry && typeof entry === "object")
                : undefined,
            confidence: typeof confidence === "number" ? confidence : undefined,
            source: typeof source === "string" ? source : "http",
            timestamp: typeof timestamp === "number" ? timestamp : undefined,
            transcript: typeof transcript === "string" ? transcript : undefined
        })

        if (!result.accepted && !result.transcriptLogged) {
            res.status(400).json({ error: "No valid scripture references supplied" })
            return
        }

        emitStatus()
        res.status(202).json({ status: "accepted", accepted: result.accepted })
    })

    expressApp.get("/health", (_req: Request, res: Response) => {
        res.json({
            enabled: settings.enabled,
            listening: status.listening,
            parser: parserAvailable,
            recognized: status.recognizedReferences
        })
    })

    expressApp.get("/status", (_req: Request, res: Response) => {
        res.json(buildStatusReport())
    })

    expressApp.get("/events", (req: Request, res: Response) => {
        res.setHeader("Content-Type", "text/event-stream")
        res.setHeader("Cache-Control", "no-cache")
        res.setHeader("Connection", "keep-alive")
        res.setHeader("X-Accel-Buffering", "no")
        ;(res as any).flushHeaders?.()

        const client = registerSseClient(res)
        const cleanup = () => removeSseClient(client.id)

        req.on("close", cleanup)
        req.on("end", cleanup)
        req.on("error", cleanup)
        res.on("close", cleanup)
        res.on("finish", cleanup)
        res.on("error", cleanup)

        try {
            res.write(`: connected\n\n`)
        } catch (err) {
            removeSseClient(client.id)
            return
        }

        sendSseSnapshot(client)
    })

    httpServer = expressApp.listen(settings.port, "0.0.0.0", () => {
        status.listening = true
        status.httpEndpoints = buildHttpEndpoints(settings.port, settings.customEndpoints)
        status.httpEndpoint = status.httpEndpoints[0]?.url
        scheduleTranscriberUpdate()
        emitStatus()
    })

    httpServer.on("error", (err: NodeJS.ErrnoException) => {
        status.listening = false
        status.httpEndpoint = undefined
        status.httpEndpoints = []
        sendError(`Failed to start sermon listener on port ${settings.port}: ${err.message}`, true)
        emitStatus()
    })
}

function stopServer() {
    if (httpServer) {
        try {
            httpServer.close()
        } catch (err) {
            console.warn("Failed to close sermon listener server:", err)
        }
    }
    httpServer = null
    expressApp = null
    clearSseClients()
    status.listening = false
    status.httpEndpoint = undefined
    status.httpEndpoints = []
    status.customEndpoints = [...settings.customEndpoints]
    ensureTranscriber()?.setActive(false)
    clearTranscriptContext()
}

interface ExternalIngestOptions {
    reference?: AutoScriptureExternalReference
    references?: AutoScriptureExternalReference[]
    confidence?: number
    source?: string
    timestamp?: number
    transcript?: string
}

function ingestExternalReferences({ reference, references, confidence, source, timestamp, transcript }: ExternalIngestOptions) {
    const items: AutoScriptureExternalReference[] = []
    if (reference) items.push(reference)
    if (Array.isArray(references)) {
        references.forEach((entry) => {
            if (entry) items.push(entry)
        })
    }

    if (!items.length && !transcript) return { accepted: 0, transcriptLogged: false }

    const baseTimestamp = typeof timestamp === "number" ? timestamp : Date.now()
    let accepted = 0
    let transcriptLogged = false

    const cleanSource = typeof source === "string" ? source : undefined
    const cleanConfidence = typeof confidence === "number" ? confidence : undefined
    const cleanTranscript = typeof transcript === "string" ? transcript.trim() : ""

    if (cleanTranscript) {
        const eventTimestamp = sanitizeTimestamp(baseTimestamp)
        const payload = {
            text: cleanTranscript,
            timestamp: eventTimestamp,
            confidence: cleanConfidence,
            source: cleanSource,
        }
        status.lastTranscriptAt = eventTimestamp
        sendTranscriptEvent(payload)
        updateTranscriptContextBuffer(cleanTranscript, eventTimestamp)
        transcriptLogged = true
    }

    cleanupSeen(baseTimestamp)

    items.forEach((rawReference, index) => {
        const normalized = normalizeExternalReference(rawReference, settings.maxVerses)
        if (!normalized) return

        const refConfidence = resolveConfidence(rawReference, cleanConfidence)
        if (typeof refConfidence === "number" && refConfidence < settings.minConfidence) return

        const refSource = resolveSource(rawReference, cleanSource)
        const refTranscript = resolveTranscript(rawReference, cleanTranscript)
        const refTimestamp = resolveTimestamp(rawReference, baseTimestamp, index)

        const key = createReferenceKey(normalized)
        if (shouldSkipReference(key, refTimestamp)) return

        seenReferences.set(key, refTimestamp)
        status.recognizedReferences += 1
        status.lastSuggestionAt = refTimestamp

        const suggestion: AutoScriptureSuggestion = {
            id: typeof randomUUID === "function" ? randomUUID() : `${refTimestamp}-${Math.random().toString(16).slice(2)}`,
            reference: normalized,
            transcript: refTranscript || undefined,
            timestamp: refTimestamp,
            confidence: refConfidence,
            source: refSource,
            formatted: normalized.formatted
        }

        sendSuggestion(suggestion)
        accepted += 1
    })

    return { accepted, transcriptLogged }
}

function resolveConfidence(reference: AutoScriptureExternalReference, fallback?: number) {
    const candidate = (reference as any)?.confidence
    return typeof candidate === "number" ? candidate : fallback
}

function resolveSource(reference: AutoScriptureExternalReference, fallback?: string) {
    const candidate = (reference as any)?.source
    return typeof candidate === "string" && candidate ? candidate : fallback
}

function resolveTranscript(reference: AutoScriptureExternalReference, fallback: string) {
    const candidate = (reference as any)?.transcript
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim()
    return fallback
}

function resolveTimestamp(reference: AutoScriptureExternalReference, baseTimestamp: number, offset = 0) {
    const candidate = (reference as any)?.timestamp
    const sanitized = sanitizeNumber(candidate)
    if (typeof sanitized === "number" && Number.isFinite(sanitized)) return Math.floor(sanitized)
    return Math.floor(baseTimestamp + offset)
}

function normalizeExternalReference(reference: AutoScriptureExternalReference, maxVerses: number): AutoScriptureReference | null {
    if (!reference) return null
    const bookMeta = resolveBook(reference)
    if (!bookMeta) return null

    const chapter = sanitizePositiveInteger((reference as any)?.chapter)
    const verseStart = sanitizePositiveInteger((reference as any)?.verseStart ?? (reference as any)?.verse ?? (reference as any)?.startVerse)
    if (!chapter || !verseStart) return null

    const endRaw = (reference as any)?.verseEnd ?? (reference as any)?.endVerse ?? verseStart
    let verseEnd = sanitizePositiveInteger(endRaw) || verseStart
    if (verseEnd < verseStart) verseEnd = verseStart

    const verses: number[] = []
    for (let verse = verseStart; verse <= verseEnd; verse++) {
        verses.push(verse)
        if (verses.length >= maxVerses) break
    }

    const normalized: AutoScriptureReference = {
        bookId: bookMeta.id,
        bookIndex: bookMeta.index,
        bookOsis: bookMeta.osis,
        bookName: bookMeta.name,
        chapter,
        verses,
        endVerse: verseEnd,
        formatted: ""
    }

    normalized.formatted = formatScriptureReference(normalized)
    return normalized
}

function resolveBook(reference: AutoScriptureExternalReference) {
    const candidates = [
        (reference as any)?.bookOsis,
        (reference as any)?.bookId,
        (reference as any)?.book,
        (reference as any)?.bookName,
        (reference as any)?.osis,
        (reference as any)?.id
    ]

    for (const value of candidates) {
        if (typeof value !== "string" || !value.trim()) continue
        const meta = getBookMeta(value)
        if (meta) return meta
    }

    return undefined
}

function sanitizePositiveInteger(value: unknown): number | null {
    const numeric = sanitizeNumber(value)
    if (typeof numeric !== "number" || !Number.isFinite(numeric)) return null
    const integer = Math.floor(numeric)
    if (!Number.isFinite(integer) || integer <= 0) return null
    return integer
}

function sanitizeTimestamp(value: unknown): number {
    const numeric = sanitizeNumber(value)
    if (typeof numeric === "number" && Number.isFinite(numeric)) return Math.floor(numeric)
    return Date.now()
}

function sanitizeNumber(value: unknown): number | null {
    if (typeof value === "number" && !Number.isNaN(value)) return value
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value)
        if (!Number.isNaN(parsed)) return parsed
    }
    return null
}

function processTranscript({ text, confidence, speaker, timestamp, source }: TranscriptPayload) {
    const now = sanitizeTimestamp(timestamp)
    const trimmedText = typeof text === "string" ? text.trim() : ""

    const payload = {
        text,
        timestamp: now,
        confidence,
        speaker,
        source
    }
    status.lastTranscriptAt = now
    sendTranscriptEvent(payload)

    const aggregatedContext = updateTranscriptContextBuffer(trimmedText, now)

    if (!parserAvailable || !trimmedText) {
        emitStatus()
        return
    }

    if (typeof confidence === "number" && confidence < settings.minConfidence) {
        emitStatus()
        return
    }

    const parseTargets: string[] = []
    if (trimmedText) parseTargets.push(trimmedText)
    if (aggregatedContext && aggregatedContext !== trimmedText) parseTargets.push(aggregatedContext)

    if (!parseTargets.length) {
        emitStatus()
        return
    }

    const uniqueReferences = new Map<string, AutoScriptureReference>()
    parseTargets.forEach((target) => {
        extractReferences(target, settings.maxVerses).forEach((reference) => {
            const key = createReferenceKey(reference)
            if (!key || uniqueReferences.has(key)) return
            uniqueReferences.set(key, reference)
        })
    })

    if (!uniqueReferences.size) {
        emitStatus()
        return
    }

    cleanupSeen(now)

    const transcriptForSuggestion = aggregatedContext || trimmedText

    uniqueReferences.forEach((reference) => {
        const key = createReferenceKey(reference)
        if (shouldSkipReference(key, now)) return

        seenReferences.set(key, now)
        status.recognizedReferences += 1
        status.lastSuggestionAt = now

        const suggestion: AutoScriptureSuggestion = {
            id: typeof randomUUID === "function" ? randomUUID() : `${now}-${Math.random().toString(16).slice(2)}`,
            reference,
            transcript: transcriptForSuggestion || undefined,
            timestamp: now,
            confidence,
            source
        }

        sendSuggestion(suggestion)
    })

    emitStatus()
}

function shouldSkipReference(key: string, now: number) {
    if (!key) return true
    const previous = seenReferences.get(key)
    if (!previous) return false
    const diff = (now - previous) / 1000
    return diff < settings.duplicateInterval
}

function cleanupSeen(now: number) {
    const ttl = settings.duplicateInterval * 2000
    seenReferences.forEach((value, key) => {
        if (now - value > ttl) seenReferences.delete(key)
    })
}

function createReferenceKey(reference: AutoScriptureSuggestion["reference"]) {
    const chapter = reference.chapter
    const endChapter = reference.endChapter ?? reference.chapter
    const startVerse = reference.verses[0] ?? 0
    const endVerse = reference.endVerse ?? reference.verses[reference.verses.length - 1] ?? startVerse
    return `${reference.bookOsis}.${chapter}-${endChapter}.${startVerse}-${endVerse}`
}

function buildHttpEndpoints(port: number, custom: string[] = []): AutoScriptureEndpoint[] {
    const endpoints: AutoScriptureEndpoint[] = []
    const seen = new Set<string>()

    const pushEndpoint = (url: string, type: AutoScriptureEndpoint["type"]) => {
        if (!url) return
        const normalized = url.replace(/\/+$/, "")
        if (seen.has(normalized)) return
        seen.add(normalized)

        const reference = normalized.replace(/\/transcript$/i, "/reference")
        const statusUrl = normalized.replace(/\/transcript$/i, "/status")
        const events = normalized.replace(/\/transcript$/i, "/events")

        endpoints.push({ url: normalized, type, reference, status: statusUrl, events })
    }

    pushEndpoint(`http://127.0.0.1:${port}/transcript`, "loopback")
    pushEndpoint(`http://localhost:${port}/transcript`, "loopback")

    const interfaces = os.networkInterfaces()
    Object.values(interfaces).forEach((addresses) => {
        addresses?.forEach((address) => {
            if (!address) return
            const family = typeof address.family === "string" ? address.family : address.family === 4 ? "IPv4" : "IPv6"
            if (family !== "IPv4") return
            if (address.internal) return
            const ip = address.address
            if (!ip) return
            pushEndpoint(`http://${ip}:${port}/transcript`, "lan")
        })
    })

    custom.forEach((entry) => {
        const normalized = normalizeCustomEndpoint(entry)
        if (!normalized) return
        pushEndpoint(normalized, "custom")
    })

    return endpoints
}

function normalizeCustomEndpoint(value: unknown): string | null {
    if (typeof value !== "string") return null

    let normalized = value.trim()
    if (!normalized) return null

    normalized = normalized.replace(/\s/g, "")
    if (!/^https?:\/\//i.test(normalized)) normalized = `http://${normalized}`

    try {
        const url = new URL(normalized)
        let pathname = url.pathname || "/"
        if (!pathname.toLowerCase().endsWith("/transcript")) {
            pathname = pathname.replace(/\/+$/, "")
            if (!pathname || pathname === "/") {
                pathname = "/transcript"
            } else {
                if (!pathname.startsWith("/")) pathname = `/${pathname}`
                pathname = `${pathname.replace(/\/+$/, "")}/transcript`
            }
        }
        url.pathname = pathname
        return url.toString().replace(/\/+$/, "")
    } catch (err) {
        let fallback = normalized.replace(/\/+$/, "")
        if (!/\/transcript$/i.test(fallback)) fallback = `${fallback}/transcript`
        return fallback
    }
}

function emitStatus(): AutoScriptureStatus {
    const payload = serializeStatus(status)
    toApp(SCRIPTURE_AUTO, { channel: "STATUS", data: payload })
    broadcastSse("status", payload)
    return payload
}

function sendTranscriptEvent(event: TranscriptPayload) {
    const payload = sanitizeTranscriptEvent(event)
    if (!payload) return
    recordTranscript(payload)
    toApp(SCRIPTURE_AUTO, { channel: "TRANSCRIPT", data: payload })
    broadcastSse("transcript", payload)
}

function sendSuggestion(suggestion: AutoScriptureSuggestion) {
    const payload = cloneSuggestion(suggestion)
    recordSuggestion(payload)
    toApp(SCRIPTURE_AUTO, { channel: "SUGGESTION", data: payload })
    broadcastSse("suggestion", payload)
}

function sendReset() {
    toApp(SCRIPTURE_AUTO, { channel: "RESET", data: null })
    broadcastSse("reset", null)
    broadcastSse("snapshot", buildStatusReport())
}

function sendError(message: string, fatal = false) {
    const payload = { message, fatal }
    toApp(SCRIPTURE_AUTO, { channel: "ERROR", data: payload })
    broadcastSse("error", payload)
}

function clearHistories() {
    transcriptHistory.length = 0
    suggestionHistory.length = 0
    clearTranscriptContext()
}

function clearTranscriptContext() {
    transcriptContext.length = 0
}

function pruneTranscriptContext(now: number, windowMs: number) {
    for (let i = transcriptContext.length - 1; i >= 0; i--) {
        if (now - transcriptContext[i].timestamp > windowMs) transcriptContext.splice(i, 1)
    }

    if (transcriptContext.length > TRANSCRIPT_CONTEXT_LIMIT) {
        transcriptContext.splice(0, transcriptContext.length - TRANSCRIPT_CONTEXT_LIMIT)
    }
}

function updateTranscriptContextBuffer(text: string, timestamp: number) {
    const windowSeconds = Math.max(0, settings.contextWindow || 0)
    const windowMs = windowSeconds * 1000

    if (!windowSeconds) {
        clearTranscriptContext()
        return ""
    }

    pruneTranscriptContext(timestamp, windowMs)

    if (text) {
        const last = transcriptContext[transcriptContext.length - 1]
        if (!last || last.text !== text) {
            transcriptContext.push({ text, timestamp })
            if (transcriptContext.length > TRANSCRIPT_CONTEXT_LIMIT) {
                transcriptContext.splice(0, transcriptContext.length - TRANSCRIPT_CONTEXT_LIMIT)
            }
        } else {
            transcriptContext[transcriptContext.length - 1].timestamp = timestamp
        }
    }

    const combined = transcriptContext
        .map((entry) => entry.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()

    if (combined.length > 500) {
        return combined.slice(combined.length - 500).trimStart()
    }

    return combined
}

function sanitizeTranscriptEvent(event: TranscriptPayload): AutoScriptureTranscriptEvent | null {
    if (!event?.text) return null
    const text = `${event.text}`.trim()
    if (!text) return null

    const sanitized: AutoScriptureTranscriptEvent = {
        text,
        timestamp: sanitizeTimestamp(event.timestamp)
    }

    if (typeof event.confidence === "number" && !Number.isNaN(event.confidence)) {
        sanitized.confidence = event.confidence
    }
    if (typeof event.speaker === "string" && event.speaker.trim()) sanitized.speaker = event.speaker.trim()
    if (typeof event.source === "string" && event.source.trim()) sanitized.source = event.source.trim()

    return sanitized
}

function recordTranscript(event: AutoScriptureTranscriptEvent) {
    const cloned = cloneTranscript(event)
    transcriptHistory.unshift(cloned)
    if (transcriptHistory.length > TRANSCRIPT_HISTORY_LIMIT) transcriptHistory.length = TRANSCRIPT_HISTORY_LIMIT
}

function recordSuggestion(suggestion: AutoScriptureSuggestion) {
    const cloned = cloneSuggestion(suggestion)
    const existingIndex = suggestionHistory.findIndex((item) => item.id === cloned.id)
    if (existingIndex > -1) suggestionHistory.splice(existingIndex, 1)
    suggestionHistory.unshift(cloned)
    if (suggestionHistory.length > SUGGESTION_HISTORY_LIMIT) suggestionHistory.length = SUGGESTION_HISTORY_LIMIT
}

function cloneTranscript(event: AutoScriptureTranscriptEvent): AutoScriptureTranscriptEvent {
    const cloned: AutoScriptureTranscriptEvent = {
        text: event.text,
        timestamp: event.timestamp
    }
    if (event.confidence !== undefined) cloned.confidence = event.confidence
    if (event.speaker) cloned.speaker = event.speaker
    if (event.source) cloned.source = event.source
    return cloned
}

function cloneSuggestion(suggestion: AutoScriptureSuggestion): AutoScriptureSuggestion {
    return {
        ...suggestion,
        reference: cloneReference(suggestion.reference),
        transcript: suggestion.transcript,
        formatted: suggestion.formatted
    }
}

function cloneReference(reference: AutoScriptureReference): AutoScriptureReference {
    return {
        ...reference,
        verses: [...reference.verses]
    }
}

function buildStatusReport(): AutoScriptureStatusReport {
    return {
        status: serializeStatus(status),
        transcripts: transcriptHistory.map((entry) => cloneTranscript(entry)),
        suggestions: suggestionHistory.map((entry) => cloneSuggestion(entry))
    }
}

function serializeStatus(current: AutoScriptureStatus): AutoScriptureStatus {
    const httpEndpoints = Array.isArray(current.httpEndpoints)
        ? current.httpEndpoints.map((endpoint) => ({ ...endpoint }))
        : undefined

    return {
        ...current,
        customEndpoints: [...current.customEndpoints],
        httpEndpoints
    }
}

function ensureTranscriber() {
    if (!transcriber) {
        transcriber = new SermonTranscriber({
            onResult: handleTranscriberResult,
            onPartial: handleTranscriberPartial,
            onStatus: handleTranscriberStatus,
            onError: handleTranscriberError
        })
    }
    return transcriber
}

function scheduleTranscriberUpdate() {
    const instance = ensureTranscriber()
    const config = settings.transcriber ?? { ...DEFAULT_SERMON_TRANSCRIBER_SETTINGS }
    const shouldBeActive = !!(settings.enabled && config.engine !== "disabled")

    instance
        .configure(config)
        .then(() => {
            instance.setActive(shouldBeActive)
        })
        .catch((err) => {
            handleTranscriberError(err instanceof Error ? err.message : String(err))
        })
}

function handleTranscriberStatus(update: TranscriberStatusUpdate) {
    status.transcriberEngine = update.engine
    status.transcriberReady = update.ready
    status.transcriberMessage = update.message
    status.transcriberSampleRate = update.sampleRate
    status.transcriberPartial = update.partial
    emitStatus()
}

function handleTranscriberResult(event: TranscriberTranscriptEvent) {
    if (!event?.text) return
    processTranscript({
        text: event.text,
        confidence: event.confidence,
        timestamp: sanitizeTimestamp(event.timestamp),
        source: event.source || status.transcriberEngine || "transcriber"
    })
}

function handleTranscriberPartial(event: TranscriberTranscriptEvent) {
    if (!event?.text) return
    const allowPartial = settings.transcriber?.enablePartial ?? DEFAULT_SERMON_TRANSCRIBER_SETTINGS.enablePartial
    if (!allowPartial) return

    const timestamp = sanitizeTimestamp(event.timestamp)
    status.lastTranscriptAt = timestamp
    sendTranscriptEvent({
        text: event.text,
        timestamp,
        confidence: event.confidence,
        source: `${event.source || status.transcriberEngine || "transcriber"}-partial`
    })
}

function handleTranscriberError(message: string) {
    status.transcriberReady = false
    status.transcriberMessage = message
    emitStatus()
    if (message) {
        sendError(message, false)
    }
}

function sanitizeTranscriberSettings(raw: unknown): SermonTranscriberSettings {
    const defaults = DEFAULT_SERMON_TRANSCRIBER_SETTINGS
    const candidate = (raw || {}) as Partial<SermonTranscriberSettings> & { [key: string]: any }

    const engineValue = (candidate.engine ?? candidate.type ?? candidate.provider) as string | undefined
    const normalizedEngine = typeof engineValue === "string" ? engineValue.toLowerCase().trim() : ""
    const engine: SermonTranscriberSettings["engine"] = normalizedEngine === "vosk" ? "vosk" : "disabled"

    const model = typeof candidate.modelPath === "string" ? candidate.modelPath : typeof (candidate as any).model === "string" ? (candidate as any).model : ""
    const sampleRate = Number.isFinite(candidate.sampleRate)
        ? Math.max(8000, Math.min(96000, Math.floor(Number(candidate.sampleRate))))
        : defaults.sampleRate
    const enablePartial = typeof candidate.enablePartial === "boolean" ? candidate.enablePartial : defaults.enablePartial
    const maxAlternatives = Number.isFinite(candidate.maxAlternatives)
        ? Math.max(0, Math.min(10, Math.floor(Number(candidate.maxAlternatives))))
        : defaults.maxAlternatives

    return {
        engine,
        modelPath: model,
        sampleRate,
        enablePartial,
        maxAlternatives
    }
}

function registerSseClient(res: Response): SseClient {
    const id = typeof randomUUID === "function" ? randomUUID() : `sse-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const client: SseClient = {
        id,
        res,
        heartbeat: null
    }

    client.heartbeat = setInterval(() => sendSseHeartbeat(client), SSE_HEARTBEAT_INTERVAL)
    sseClients.set(id, client)
    return client
}

function removeSseClient(id: string, end = false) {
    const client = sseClients.get(id)
    if (!client) return

    if (client.heartbeat) {
        clearInterval(client.heartbeat)
        client.heartbeat = null
    }

    if (end) {
        try {
            client.res.end()
        } catch (err) {
            // Ignore errors when closing the stream.
        }
    }

    sseClients.delete(id)
}

function clearSseClients() {
    Array.from(sseClients.keys()).forEach((id) => removeSseClient(id, true))
}

function sendSseHeartbeat(client: SseClient) {
    try {
        client.res.write(`: ping ${Date.now()}\n\n`)
    } catch (err) {
        removeSseClient(client.id)
    }
}

function sendSseSnapshot(client: SseClient) {
    const snapshot = formatSsePayload("snapshot", buildStatusReport())
    const statusPayload = formatSsePayload("status", serializeStatus(status))

    try {
        if (snapshot) client.res.write(snapshot)
        if (statusPayload) client.res.write(statusPayload)
    } catch (err) {
        removeSseClient(client.id)
    }
}

function broadcastSse(event: string, data: unknown) {
    if (!sseClients.size) return
    const payload = formatSsePayload(event, data)
    if (!payload) return

    sseClients.forEach((client) => {
        try {
            client.res.write(payload)
        } catch (err) {
            removeSseClient(client.id)
        }
    })
}

function formatSsePayload(event: string, data: unknown): string | null {
    let body = "null"
    try {
        body = JSON.stringify(data ?? null)
    } catch (err) {
        console.warn("Failed to serialize SSE payload:", err)
        return null
    }

    return `event: ${event}\ndata: ${body}\n\n`
}
