import { get } from "svelte/store"
import type { AutoDetectedScripture, ScriptureAutoState, ScriptureAutoSettings } from "../../../types/Scripture"
import {
    openScripture,
    playScripture,
    scriptureAutoQueue,
    scriptureAutoSettings,
    scriptureAutoState,
    scriptureAutoStats,
    scriptureAutoTranscript,
    scriptures,
    scripturesCache
} from "../../stores"
import {
    clearProcessedReferences,
    dismissSuggestion,
    getParserLanguageBookNames,
    ingestExternalSuggestions,
    ingestTranscript
} from "./autoDetector"
import { getScriptureAutoLanguageLabel } from "./languageOptions"

let recognition: any = null
let initializationAttempted = false
let shouldResume = false
let userPaused = false
let isListening = false
let supported = false
let statusMessage = ""
let previousAutoStart = false
let activeBibleId: string | null = null
let previousBibleId: string | null = null
let lastAutoAppliedId: string | null = null
let activeScriptureId: string | null = null
let autoApplyTimer: ReturnType<typeof setTimeout> | null = null
let pendingAutoApplyId: string | null = null
let pendingAutoApplyDelay = 0
let remoteSocket: WebSocket | null = null
let remoteReconnectTimer: ReturnType<typeof setTimeout> | null = null
let remoteManualDisconnect = false
let remoteReconnectAttempts = 0
let lastRemoteConfig: { language: string | null; bibleId: string | null; vocabularyKey: string | null } = {
    language: null,
    bibleId: null,
    vocabularyKey: null
}
type RecognizerMode = "browser" | "remote"
let currentRecognizerMode: RecognizerMode = "browser"
let lastLanguage: string | null = null
let remoteConnected = false
let remoteStatusText: string | null = null
let currentGrammarSignature: string | null = null

const MAX_TRANSCRIPT_ITEMS = 200
const MAX_VOCABULARY_ITEMS = 256

const ORDINAL_WORDS: Record<string, string> = { 1: "First", 2: "Second", 3: "Third" }
const ROMAN_NUMERALS: Record<string, string> = { 1: "I", 2: "II", 3: "III" }

const FALLBACK_BOOK_NAMES = [
    "Genesis",
    "Exodus",
    "Leviticus",
    "Numbers",
    "Deuteronomy",
    "Joshua",
    "Judges",
    "Ruth",
    "1 Samuel",
    "2 Samuel",
    "1 Kings",
    "2 Kings",
    "1 Chronicles",
    "2 Chronicles",
    "Ezra",
    "Nehemiah",
    "Esther",
    "Job",
    "Psalms",
    "Psalm",
    "Proverbs",
    "Ecclesiastes",
    "Song of Songs",
    "Song of Solomon",
    "Canticles",
    "Isaiah",
    "Jeremiah",
    "Lamentations",
    "Ezekiel",
    "Daniel",
    "Hosea",
    "Joel",
    "Amos",
    "Obadiah",
    "Jonah",
    "Micah",
    "Nahum",
    "Habakkuk",
    "Zephaniah",
    "Haggai",
    "Zechariah",
    "Malachi",
    "Matthew",
    "Mark",
    "Luke",
    "John",
    "Acts",
    "Romans",
    "1 Corinthians",
    "2 Corinthians",
    "Galatians",
    "Ephesians",
    "Philippians",
    "Colossians",
    "1 Thessalonians",
    "2 Thessalonians",
    "1 Timothy",
    "2 Timothy",
    "Titus",
    "Philemon",
    "Hebrews",
    "James",
    "1 Peter",
    "2 Peter",
    "1 John",
    "2 John",
    "3 John",
    "Jude",
    "Revelation",
    "Revelations"
]

function sanitizeGrammarSource(value: unknown): string | null {
    if (value == null) return null

    const raw = typeof value === "string" ? value : String(value)
    const normalized = raw
        .replace(/[\u00A0\u2007\u202F]/g, " ")
        .replace(/[\u2013\u2014]/g, "-")
        .replace(/\s+/g, " ")
        .trim()

    if (!normalized) return null
    return normalized
}

function addVocabularyVariant(target: Map<string, string>, value: unknown) {
    const normalized = sanitizeGrammarSource(value)
    if (!normalized) return

    const base = normalized.replace(/\s+/g, " ")
    const key = base.toLowerCase()
    if (!target.has(key)) target.set(key, base)

    let ascii = base.normalize("NFD")
    try {
        ascii = ascii.replace(/\p{Diacritic}/gu, "")
    } catch (error) {
        ascii = ascii.replace(/[\u0300-\u036f]/g, "")
    }
    ascii = ascii.replace(/\s+/g, " ").trim()
    if (ascii && ascii !== base) {
        const asciiKey = ascii.toLowerCase()
        if (!target.has(asciiKey)) target.set(asciiKey, ascii)
    }

    const ordinalMatch = base.match(/^([123])\s+(.+)$/)
    if (ordinalMatch) {
        const digit = ordinalMatch[1]
        const rest = ordinalMatch[2]
        const ordinalWord = ORDINAL_WORDS[digit]
        const romanNumeral = ROMAN_NUMERALS[digit]
        if (ordinalWord) addVocabularyVariant(target, `${ordinalWord} ${rest}`)
        if (romanNumeral) addVocabularyVariant(target, `${romanNumeral} ${rest}`)
    }

    const romanMatch = base.match(/^(I{1,3})\s+(.+)$/i)
    if (romanMatch) {
        const romanValue = romanMatch[1].toUpperCase()
        const rest = romanMatch[2]
        const romanToDigit: Record<string, string> = { I: "1", II: "2", III: "3" }
        const digit = romanToDigit[romanValue]
        if (digit) addVocabularyVariant(target, `${digit} ${rest}`)
    }
}

function buildVocabularyForBible(
    bibleId: string | null,
    language: string
): { values: string[]; signature: string } {
    const cache = get(scripturesCache)
    const bible = bibleId ? cache[bibleId] : null
    const collected = new Map<string, string>()

    if (bible?.books?.length) {
        bible.books.forEach((book: any) => {
            const candidates = [
                book?.customName,
                book?.name,
                book?.nameLong,
                book?.abbreviation,
                book?.shortName,
                book?.title
            ]

            candidates.forEach((entry) => addVocabularyVariant(collected, entry))
        })
    }

    const parserNames = getParserLanguageBookNames(language)
    parserNames.forEach((name) => addVocabularyVariant(collected, name))

    FALLBACK_BOOK_NAMES.forEach((name) => addVocabularyVariant(collected, name))

    const values = Array.from(collected.values()).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "accent" })
    )
    const limited = values.slice(0, MAX_VOCABULARY_ITEMS)

    const signature = JSON.stringify({
        id: bibleId || "default",
        lang: (language || "en-US").toLowerCase(),
        total: values.length,
        sample: limited.slice(0, 32)
    })

    return { values: limited, signature }
}

function encodeGrammarTerm(value: string): string | null {
    if (!value) return null
    const sanitized = value.replace(/[=;|]/g, " ").replace(/\s+/g, " ").trim()
    if (!sanitized) return null
    const escaped = sanitized.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    return `"${escaped}"`
}

function updateRecognitionGrammar(force = false) {
    if (typeof window === "undefined" || currentRecognizerMode !== "browser" || !recognition) return

    const GrammarCtor = (window as any).SpeechGrammarList || (window as any).webkitSpeechGrammarList
    if (!GrammarCtor) return

    const settings = get(scriptureAutoSettings)
    const language = settings.language || "en-US"
    const vocabulary = buildVocabularyForBible(activeBibleId, language)
    const signature = `${language.toLowerCase()}:${vocabulary.signature}`

    if (!force && currentGrammarSignature === signature) return
    currentGrammarSignature = signature

    try {
        const grammarList = new GrammarCtor()
        const encoded = vocabulary.values
            .map((value) => encodeGrammarTerm(value))
            .filter((value): value is string => Boolean(value))

        if (encoded.length) {
            const grammar = `#JSGF V1.0; grammar scriptureBooks; public <book> = ${encoded.join(" | ")} ;`
            grammarList.addFromString(grammar, 1)
        }

        recognition.grammars = grammarList
    } catch (error) {
        console.error("Failed to update speech recognition grammar", error)
        currentGrammarSignature = null
    }
}

function appendTranscriptEntry(text: string, source: string) {
    const trimmed = (text || "").replace(/\s+/g, " ").trim()
    if (!trimmed) return

    const entry = {
        id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
        text: trimmed,
        timestamp: Date.now(),
        source
    }

    scriptureAutoTranscript.update((entries) => {
        const next = [...entries, entry]
        if (next.length > MAX_TRANSCRIPT_ITEMS) next.splice(0, next.length - MAX_TRANSCRIPT_ITEMS)
        return next
    })
}

scriptureAutoState.subscribe((state) => {
    const nextId = state.activeBibleId || null
    activeBibleId = nextId
    activeScriptureId = state.activeScriptureId || null

    if (!nextId) {
        previousBibleId = null
        return
    }

    if (previousBibleId !== nextId) {
        scriptureAutoQueue.update((items) => items.filter((item) => item.bibleId === nextId))
        clearProcessedReferences()
        previousBibleId = nextId
        lastAutoAppliedId = null

        const settings = get(scriptureAutoSettings)
        const overrides = settings.languageOverrides || {}
        const overrideLanguage = overrides[nextId] || null

        if (overrideLanguage && settings.language !== overrideLanguage) {
            scriptureAutoSettings.update((current) => {
                if (current.language === overrideLanguage) return current
                return { ...current, language: overrideLanguage }
            })

            const languageLabel = getScriptureAutoLanguageLabel(overrideLanguage)
            setStatus(
                languageLabel
                    ? `Recognition language set to ${languageLabel} for this translation.`
                    : "Recognition language updated for this translation."
            )
        }
    }

    sendRemoteConfiguration()
    if (currentRecognizerMode === "browser") updateRecognitionGrammar()
})

scriptureAutoSettings.subscribe((settings) => {
    const minConfidence = Math.min(Math.max(settings.minimumConfidence ?? 0.55, 0), 0.99)
    applyConfidenceThreshold(minConfidence)

    const queue = get(scriptureAutoQueue)

    if (!settings.autoDisplay) {
        clearAutoApplyTimer()
        return
    }

    if (queue.length) scheduleAutoApply(queue[0])
})

scriptureAutoQueue.subscribe((queue) => {
    const settings = get(scriptureAutoSettings)
    if (!queue.length) {
        lastAutoAppliedId = null
        clearAutoApplyTimer()
        return
    }

    if (!settings.autoDisplay) {
        clearAutoApplyTimer()
        return
    }

    scheduleAutoApply(queue[0])
})

function clearAutoApplyTimer() {
    if (autoApplyTimer) {
        clearTimeout(autoApplyTimer)
        autoApplyTimer = null
    }
    pendingAutoApplyId = null
    pendingAutoApplyDelay = 0
}

function applyConfidenceThreshold(minConfidence: number) {
    scriptureAutoQueue.update((queue) => {
        if (!queue.length) return queue

        const filtered = queue.filter((item) => {
            if (typeof item.confidence !== "number") return true
            return item.confidence >= minConfidence - 0.0001
        })

        if (filtered.length === queue.length) return queue

        if (pendingAutoApplyId && !filtered.some((item) => item.id === pendingAutoApplyId)) {
            clearAutoApplyTimer()
        }

        return filtered
    })
}

function updateState(partial: Partial<ScriptureAutoState>) {
    scriptureAutoState.update((state) => ({ ...state, ...partial }))
}

function setRecognizerMode(mode: RecognizerMode) {
    if (currentRecognizerMode === mode) return
    currentRecognizerMode = mode
    updateState({ recognizerMode: mode })
    if (mode !== "browser") currentGrammarSignature = null
}

function setRemoteConnectedState(value: boolean) {
    if (remoteConnected === value) return
    remoteConnected = value
    updateState({ remoteConnected: value })
}

function setRemoteStatus(value: string | null) {
    if (remoteStatusText === value) return
    remoteStatusText = value
    updateState({ remoteStatus: value })
}

function setStatus(message: string) {
    if (statusMessage === message) return
    statusMessage = message
    updateState({ status: message })
}

function setListeningState(listening: boolean) {
    if (isListening === listening) return
    isListening = listening
    updateState({ listening })
}

function setSupportedState(value: boolean) {
    if (supported === value) return
    supported = value
    updateState({ supported: value })
}

function setPartialTranscript(value: string) {
    updateState({ partialTranscript: value })
}

function clearRemoteReconnectTimer() {
    if (remoteReconnectTimer) {
        clearTimeout(remoteReconnectTimer)
        remoteReconnectTimer = null
    }
}

function resolveRecognizerMode(settings?: ScriptureAutoSettings): RecognizerMode {
    const mode = settings?.recognizerMode
    return mode === "remote" ? "remote" : "browser"
}

function getRemoteServiceUrl(settings?: ScriptureAutoSettings): string {
    const value = settings?.remoteServiceUrl
    if (typeof value === "string") return value.trim()
    return ""
}

function sendRemoteConfiguration(force = false) {
    if (!remoteSocket || remoteSocket.readyState !== WebSocket.OPEN) return

    const settings = get(scriptureAutoSettings)
    const language = (settings.language || "en-US").trim()
    const bibleId = activeBibleId || null
    const vocabulary = buildVocabularyForBible(bibleId, language)

    if (
        !force &&
        language === lastRemoteConfig.language &&
        bibleId === lastRemoteConfig.bibleId &&
        vocabulary.signature === lastRemoteConfig.vocabularyKey
    ) {
        return
    }

    const translationMeta = bibleId ? get(scriptures)[bibleId] : null
    const translationName =
        translationMeta?.customName || translationMeta?.name || translationMeta?.metadata?.name || null

    const payload: Record<string, unknown> = {
        type: "configure",
        language,
        bibleId,
        translation: translationName
    }

    if (vocabulary.values.length) payload.vocabulary = vocabulary.values

    try {
        remoteSocket.send(JSON.stringify(payload))
        lastRemoteConfig = { language, bibleId, vocabularyKey: vocabulary.signature }
    } catch (error) {
        console.error("Failed to send remote configuration", error)
    }
}

function processRemotePayload(raw: unknown) {
    let payload: any = raw
    if (typeof raw === "string") {
        try {
            payload = JSON.parse(raw)
        } catch (error) {
            console.error("Invalid remote payload", error)
            return
        }
    }

    if (!payload || typeof payload !== "object") return

    const type = typeof payload.type === "string" ? payload.type.toLowerCase() : "transcript"
    const sourceRaw = typeof payload.source === "string" ? payload.source.trim() : ""
    const source = sourceRaw ? sourceRaw.toLowerCase() : "remote"

    if (type === "ping") {
        try {
            remoteSocket?.send(
                JSON.stringify({ type: "pong", timestamp: Date.now(), received: payload.timestamp || Date.now() })
            )
        } catch (error) {
            console.error("Failed to send remote pong", error)
        }
        return
    }

    if (type === "ready") {
        sendRemoteConfiguration(true)
        return
    }

    if (type === "transcript" || type === "partial" || type === "final") {
        const text = String(payload.text ?? payload.transcript ?? "").trim()
        if (!text) return

        const confidence =
            typeof payload.confidence === "number" && Number.isFinite(payload.confidence)
                ? Math.max(0, Math.min(payload.confidence, 1))
                : undefined
        const bibleId = typeof payload.bibleId === "string" ? payload.bibleId : undefined
        const isFinal = payload.isFinal ?? payload.final ?? type === "final"

        if (isFinal) {
            processSpeechTranscript(text, source, confidence, bibleId)
            appendTranscriptEntry(text, source)
            setPartialTranscript("")
        } else {
            setPartialTranscript(text)
        }

        return
    }

    if (type === "reference") {
        const text = String(payload.reference ?? payload.text ?? "").trim()
        if (!text) return

        const bibleId = typeof payload.bibleId === "string" ? payload.bibleId : activeBibleId
        if (!bibleId) return

        appendTranscriptEntry(text, source)
        const suggestions = ingestTranscript(text, bibleId, { source })
        if (suggestions.length) {
            recordDetections(suggestions, source)
        }
        return
    }

    if (type === "suggestion" || type === "suggestions") {
        const items: any[] = []

        if (Array.isArray(payload.suggestions)) items.push(...payload.suggestions)
        if (Array.isArray(payload.items)) items.push(...payload.items)
        if (Array.isArray(payload.data)) items.push(...payload.data)
        if (payload.suggestion && typeof payload.suggestion === "object") items.push(payload.suggestion)
        if (payload.item && typeof payload.item === "object") items.push(payload.item)

        if (!items.length && type === "suggestion") {
            items.push(payload)
        }

        const fallbackBibleId =
            typeof payload.bibleId === "string" && payload.bibleId.trim() ? payload.bibleId.trim() : activeBibleId || undefined

        const suggestions = ingestExternalSuggestions(items, {
            bibleId: fallbackBibleId || undefined,
            source
        })

        if (suggestions.length) {
            recordDetections(suggestions, source)
        }

        return
    }

    if (type === "status") {
        if (typeof payload.remoteStatus === "string") setRemoteStatus(payload.remoteStatus)
        if (typeof payload.message === "string") setStatus(payload.message)
        return
    }

    if (type === "error") {
        if (typeof payload.remoteStatus === "string") setRemoteStatus(payload.remoteStatus)
        const message = typeof payload.message === "string" ? payload.message : "Remote recognizer error."
        setStatus(message)
    }
}

function handleRemoteMessage(event: MessageEvent) {
    const { data } = event

    if (typeof data === "string") {
        processRemotePayload(data)
        return
    }

    if (data instanceof ArrayBuffer) {
        processRemotePayload(new TextDecoder().decode(data))
        return
    }

    if (typeof Blob !== "undefined" && data instanceof Blob) {
        data.text().then(processRemotePayload).catch(() => {})
    }
}

function connectRemoteRecognizer(): boolean {
    const settings = get(scriptureAutoSettings)
    const url = getRemoteServiceUrl(settings)

    if (!url) {
        setRemoteStatus("Configure remote recognizer URL")
        setStatus("Configure a remote recognizer URL before connecting.")
        setListeningState(false)
        setRemoteConnectedState(false)
        return false
    }

    if (remoteSocket && (remoteSocket.readyState === WebSocket.OPEN || remoteSocket.readyState === WebSocket.CONNECTING)) {
        return true
    }

    clearRemoteReconnectTimer()
    remoteManualDisconnect = false

    try {
        remoteSocket = new WebSocket(url)
    } catch (error) {
        console.error("Failed to open remote recognizer", error)
        setRemoteStatus("Connection failed")
        setStatus("Unable to connect to remote recognizer.")
        setListeningState(false)
        setRemoteConnectedState(false)
        return false
    }

    setRemoteStatus("Connecting…")
    setStatus("Connecting to remote recognizer…")

    remoteSocket.onopen = () => {
        remoteReconnectAttempts = 0
        setRemoteConnectedState(true)
        setRemoteStatus("Connected")
        setListeningState(true)
        setStatus("Connected to remote recognizer.")
        lastRemoteConfig = { language: null, bibleId: null, vocabularyKey: null }
        sendRemoteConfiguration(true)
    }

    remoteSocket.onerror = () => {
        setRemoteStatus("Error")
        setStatus("Remote recognizer reported an error.")
    }

    remoteSocket.onmessage = handleRemoteMessage

    remoteSocket.onclose = () => {
        setRemoteConnectedState(false)
        setListeningState(false)
        setPartialTranscript("")

        if (remoteManualDisconnect) {
            setRemoteStatus("Disconnected")
            remoteManualDisconnect = false
            return
        }

        if (shouldResume && !userPaused) {
            remoteReconnectAttempts += 1
            const delay = Math.min(10000, 1000 * Math.pow(2, remoteReconnectAttempts))
            setRemoteStatus(`Reconnecting in ${Math.max(1, Math.round(delay / 1000))}s…`)
            setStatus("Remote recognizer disconnected. Attempting to reconnect…")
            clearRemoteReconnectTimer()
            remoteReconnectTimer = setTimeout(() => {
                remoteReconnectTimer = null
                connectRemoteRecognizer()
            }, delay)
        } else {
            setRemoteStatus("Disconnected")
            setStatus("Remote recognizer disconnected.")
        }
    }

    return true
}

function disconnectRemoteRecognizer(message?: string, manual = false) {
    clearRemoteReconnectTimer()
    remoteManualDisconnect = manual

    if (remoteSocket) {
        try {
            remoteSocket.close()
        } catch (error) {
            console.error("Failed to close remote recognizer", error)
        }
    }

    remoteSocket = null
    setRemoteConnectedState(false)
    setListeningState(false)
    setRemoteStatus("Disconnected")
    if (message) setStatus(message)
}

function recordDetections(suggestions: AutoDetectedScripture[], source: string) {
    if (!suggestions.length) return false

    const latest = suggestions[0]
    updateState({
        lastHeardAt: Date.now(),
        lastReference: latest.reference,
        lastSource: latest.source || source,
        lastText: latest.text,
        lastConfidence:
            typeof latest.confidence === "number" && Number.isFinite(latest.confidence)
                ? latest.confidence
                : null
    })

    setStatus(
        suggestions.length === 1
            ? `Detected ${latest.reference}`
            : `Detected ${suggestions.length} references`
    )

    return true
}

function processSpeechTranscript(
    text: string,
    source: string = "speech",
    transcriptConfidence?: number,
    bibleOverride?: string
) {
    const targetBibleId = bibleOverride || activeBibleId
    if (!targetBibleId) {
        if (!statusMessage) setStatus("Select a Bible translation to enable detection.")
        return
    }

    const suggestions = ingestTranscript(text, targetBibleId, { source })

    if (
        suggestions.length &&
        typeof transcriptConfidence === "number" &&
        Number.isFinite(transcriptConfidence)
    ) {
        const normalized = Math.max(0.35, Math.min(transcriptConfidence, 0.99))
        suggestions.forEach((item) => {
            if (typeof item.confidence === "number" && Number.isFinite(item.confidence)) {
                item.confidence = Math.max(0.35, Math.min(0.99, (item.confidence + normalized) / 2))
            } else {
                item.confidence = normalized
            }
        })
    }

    if (suggestions.length) recordDetections(suggestions, source)
}

function scheduleAutoApply(suggestion: AutoDetectedScripture | undefined) {
    if (!suggestion) {
        clearAutoApplyTimer()
        return
    }

    if (suggestion.id === lastAutoAppliedId) return

    const settings = get(scriptureAutoSettings)
    if (!settings.autoDisplay) {
        clearAutoApplyTimer()
        return
    }

    const minConfidence = settings.minimumConfidence ?? 0
    if (typeof suggestion.confidence === "number" && suggestion.confidence < minConfidence) return

    const delay = Math.max(0, settings.autoDisplayDelayMs ?? 0)

    if (!delay) {
        clearAutoApplyTimer()
        applySuggestion(suggestion, true)
        return
    }

    if (pendingAutoApplyId === suggestion.id && pendingAutoApplyDelay === delay && autoApplyTimer) return

    clearAutoApplyTimer()
    const suggestionId = suggestion.id

    pendingAutoApplyId = suggestionId
    pendingAutoApplyDelay = delay
    autoApplyTimer = setTimeout(() => {
        pendingAutoApplyId = null
        pendingAutoApplyDelay = 0

        const latestSettings = get(scriptureAutoSettings)
        if (!latestSettings.autoDisplay) {
            clearAutoApplyTimer()
            return
        }

        const queue = get(scriptureAutoQueue)
        if (!queue.length) {
            clearAutoApplyTimer()
            return
        }

        const next = queue[0]
        if (next.id !== suggestionId) {
            clearAutoApplyTimer()
            scheduleAutoApply(next)
            return
        }

        if (
            typeof next.confidence === "number" &&
            next.confidence < (latestSettings.minimumConfidence ?? 0)
        ) {
            clearAutoApplyTimer()
            return
        }

        clearAutoApplyTimer()
        applySuggestion(next, true)
    }, delay)
}

function applySuggestion(suggestion: AutoDetectedScripture, auto = false) {
    if (!suggestion) return

    const scripturesStore = get(scriptures)
    let targetId = activeScriptureId
    let targetEntry = targetId ? scripturesStore[targetId] : undefined

    if (!targetEntry) {
        const fallback = Object.entries(scripturesStore).find(([, value]) => {
            if (!value) return false
            const versions: string[] = value.collection?.versions || [value.id]
            return versions?.includes(suggestion.bibleId)
        })

        if (fallback) {
            targetId = fallback[0]
            targetEntry = fallback[1]
        }
    }

    if (targetId && targetEntry) {
        const versions: string[] = targetEntry.collection?.versions || [targetEntry.id]
        const targetIndex = versions.indexOf(suggestion.bibleId)
        if (targetIndex > -1) {
            scriptures.update((data) => {
                const entry = data[targetId!]
                if (!entry) return data
                const updated = { ...entry, biblePreviewIndex: targetIndex }
                return { ...data, [targetId!]: updated }
            })
        }
    }

    openScripture.set({
        book: Math.max(0, suggestion.bookNumber - 1),
        chapter: suggestion.chapter,
        verses: suggestion.verses,
        play: true
    })

    playScripture.set(true)
    dismissSuggestion(suggestion.id, true)
    lastAutoAppliedId = suggestion.id

    scriptureAutoStats.update((stats) => ({
        ...stats,
        displayed: stats.displayed + 1,
        autoDisplayed: auto ? stats.autoDisplayed + 1 : stats.autoDisplayed,
        lastUpdated: Date.now()
    }))

    updateState({
        currentReference: suggestion.reference,
        currentText: suggestion.text,
        currentTranslation: suggestion.translation,
        currentAppliedAt: Date.now(),
        currentSource: suggestion.source || (auto ? "speech" : "manual"),
        currentAuto: auto,
        currentConfidence:
            typeof suggestion.confidence === "number" && Number.isFinite(suggestion.confidence)
                ? suggestion.confidence
                : null
    })

    if (!auto) setStatus(`Displaying ${suggestion.reference}`)
}

function ensureRecognition(): boolean {
    if (recognition || typeof window === "undefined") return recognition !== null

    const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null

    if (!SpeechRecognition) {
        setSupportedState(false)
        setStatus("Speech recognition is not available in this browser.")
        return false
    }

    recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = get(scriptureAutoSettings).language || "en-US"

    recognition.onstart = () => {
        setListeningState(true)
        setStatus("Listening for scripture references…")
    }

    recognition.onresult = handleResult

    recognition.onerror = (event: any) => {
        setStatus(`Microphone error: ${event.error}`)
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
            shouldResume = false
            userPaused = true
        }
    }

    recognition.onend = () => {
        setListeningState(false)
        if (shouldResume && !userPaused) {
            setStatus("Reconnecting to microphone…")
            try {
                recognition?.start()
            } catch (err) {
                setStatus("Unable to resume microphone access.")
                shouldResume = false
                userPaused = true
            }
        } else if (!statusMessage) {
            setStatus("Microphone stopped.")
        }
    }

    setSupportedState(true)
    updateRecognitionGrammar(true)
    return true
}

function handleResult(event: any) {
    let finalTranscript = ""
    let finalConfidence: number | undefined
    for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const transcript = result[0]?.transcript || ""
        if (result.isFinal) {
            finalTranscript += transcript + " "
            const candidateConfidence = result[0]?.confidence
            if (typeof candidateConfidence === "number" && Number.isFinite(candidateConfidence)) {
                finalConfidence = candidateConfidence
            }
        } else {
            setPartialTranscript(transcript)
        }
    }

    if (finalTranscript.trim()) {
        const normalizedConfidence =
            typeof finalConfidence === "number" && Number.isFinite(finalConfidence)
                ? Math.max(0, Math.min(finalConfidence, 1))
                : undefined
        processSpeechTranscript(finalTranscript.trim(), "speech", normalizedConfidence)
        setPartialTranscript("")
        appendTranscriptEntry(finalTranscript.trim(), "speech")
    }
}

export function initializeAutoScriptureService() {
    if (initializationAttempted) return
    initializationAttempted = true

    const settings = get(scriptureAutoSettings)
    previousAutoStart = settings.autoStartListening ?? false
    lastLanguage = settings.language || "en-US"

    const mode = resolveRecognizerMode(settings)
    const previousMode = currentRecognizerMode
    setRecognizerMode(mode)

    if (mode === "browser") {
        ensureRecognition()
    } else {
        if (previousMode !== mode) {
            setSupportedState(true)
        }
    }

    handleSettingsChange(settings)

    scriptureAutoSettings.subscribe(handleSettingsChange)
}

function handleSettingsChange(settings: ScriptureAutoSettings) {
    const mode = resolveRecognizerMode(settings)
    const previousMode = currentRecognizerMode
    setRecognizerMode(mode)

    const language = settings.language || "en-US"
    if (mode === "browser") {
        if (!recognition) ensureRecognition()
        if (recognition) {
            recognition.lang = language
            updateRecognitionGrammar(true)
        }
    }

    if (language !== lastLanguage) {
        lastLanguage = language
        if (mode === "remote") sendRemoteConfiguration(true)
        else updateRecognitionGrammar(true)
    }

    const autoStart = settings.autoStartListening ?? false
    if (autoStart !== previousAutoStart) {
        if (autoStart) userPaused = false
        previousAutoStart = autoStart
    }

    if (!autoStart) {
        shouldResume = false
        userPaused = true
    }

    if (mode === "browser") {
        if (previousMode === "remote") {
            shouldResume = false
            disconnectRemoteRecognizer("Switched to browser microphone.")
        }

        if (recognition && supported && autoStart && !isListening && !userPaused) {
            startAutoScriptureListening()
        }
    } else {
        setSupportedState(true)
        if (previousMode === "browser" && recognition) {
            try {
                recognition.stop()
            } catch (error) {
                console.error("Failed to stop browser recognition", error)
            }
            setListeningState(false)
        }

        if (autoStart && !isListening && !userPaused) {
            startAutoScriptureListening()
        } else if (!autoStart) {
            disconnectRemoteRecognizer(undefined, false)
        }
    }
}

export function startAutoScriptureListening(): boolean {
    initializeAutoScriptureService()
    const settings = get(scriptureAutoSettings)
    const mode = resolveRecognizerMode(settings)

    if (mode === "remote") {
        shouldResume = true
        userPaused = false
        return connectRemoteRecognizer()
    }

    if (!ensureRecognition()) return false
    updateRecognitionGrammar(true)

    if (isListening) {
        shouldResume = true
        userPaused = false
        return true
    }

    shouldResume = true
    userPaused = false
    setStatus("Starting microphone…")
    try {
        recognition.start()
        return true
    } catch (err) {
        setStatus("Unable to access the microphone.")
        shouldResume = false
        userPaused = true
        setListeningState(false)
        return false
    }
}

export function stopAutoScriptureListening(message = "Microphone paused."): boolean {
    shouldResume = false
    userPaused = true
    setStatus(message)

    const settings = get(scriptureAutoSettings)
    const mode = resolveRecognizerMode(settings)

    if (mode === "remote") {
        disconnectRemoteRecognizer(message, true)
        return true
    }

    if (!recognition) return false

    try {
        recognition.stop()
        return true
    } catch (err) {
        setStatus("Unable to stop the microphone.")
        return false
    }
}

export function toggleAutoScriptureListening(force?: boolean) {
    if (force === true) {
        startAutoScriptureListening()
        return
    }

    if (force === false) {
        stopAutoScriptureListening()
        return
    }

    const settings = get(scriptureAutoSettings)
    const mode = resolveRecognizerMode(settings)
    if (mode === "remote") {
        const state = get(scriptureAutoState)
        const status = (state.remoteStatus || "").toLowerCase()
        const remoteBusy =
            Boolean(state.remoteConnected) || status.startsWith("connecting") || status.startsWith("reconnecting")

        if (remoteBusy || isListening) {
            stopAutoScriptureListening("Remote recognizer paused.")
        } else {
            startAutoScriptureListening()
        }
        return
    }

    if (isListening) {
        stopAutoScriptureListening()
    } else {
        startAutoScriptureListening()
    }
}

export function processAutoScriptureManualInput(input: string, bibleId?: string) {
    initializeAutoScriptureService()
    const trimmed = (input || "").replace(/\s+/g, " ").trim()
    if (!trimmed) return []

    const targetId = bibleId || activeBibleId
    if (!targetId) {
        setStatus("Select a Bible translation before processing references.")
        return []
    }

    appendTranscriptEntry(trimmed, "manual")
    scriptureAutoStats.update((stats) => ({
        ...stats,
        manualSubmissions: stats.manualSubmissions + 1,
        lastUpdated: Date.now()
    }))

    const suggestions = ingestTranscript(trimmed, targetId, { source: "manual" })
    if (recordDetections(suggestions, "manual")) return suggestions

    updateState({
        lastHeardAt: Date.now(),
        lastReference: null,
        lastSource: null,
        lastText: null,
        lastConfidence: null
    })
    setStatus("No scripture references found.")
    scriptureAutoStats.update((stats) => ({ ...stats, lastUpdated: Date.now() }))
    return suggestions
}

export function applyAutoScriptureSuggestion(suggestion: AutoDetectedScripture, auto = false) {
    applySuggestion(suggestion, auto)
}

export function isAutoScriptureSupported() {
    return supported
}
