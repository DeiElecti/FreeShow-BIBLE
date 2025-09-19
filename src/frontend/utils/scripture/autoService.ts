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
    scriptures
} from "../../stores"
import { clearProcessedReferences, dismissSuggestion, ingestTranscript } from "./autoDetector"

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

const MAX_TRANSCRIPT_ITEMS = 200

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
    }
})

scriptureAutoSettings.subscribe((settings) => {
    const autoDisplay = settings.autoDisplay
    const queue = get(scriptureAutoQueue)

    if (autoDisplay && queue.length) {
        scheduleAutoApply(queue[0])
    }
})

scriptureAutoQueue.subscribe((queue) => {
    const settings = get(scriptureAutoSettings)
    if (!settings.autoDisplay) return
    if (!queue.length) {
        lastAutoAppliedId = null
        return
    }

    scheduleAutoApply(queue[0])
})

function updateState(partial: Partial<ScriptureAutoState>) {
    scriptureAutoState.update((state) => ({ ...state, ...partial }))
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

function processSpeechTranscript(text: string) {
    const bibleId = activeBibleId
    if (!bibleId) {
        if (!statusMessage) setStatus("Select a Bible translation to enable detection.")
        return
    }

    const suggestions = ingestTranscript(text, bibleId, { source: "speech" })
    if (suggestions.length) recordDetections(suggestions, "speech")
}

function scheduleAutoApply(suggestion: AutoDetectedScripture) {
    if (!suggestion || suggestion.id === lastAutoAppliedId) return
    if (!get(scriptureAutoSettings).autoDisplay) return

    applySuggestion(suggestion, true)
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
    return true
}

function handleResult(event: any) {
    let finalTranscript = ""
    for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const transcript = result[0]?.transcript || ""
        if (result.isFinal) {
            finalTranscript += transcript + " "
        } else {
            setPartialTranscript(transcript)
        }
    }

    if (finalTranscript.trim()) {
        processSpeechTranscript(finalTranscript.trim())
        setPartialTranscript("")
        appendTranscriptEntry(finalTranscript.trim(), "speech")
    }
}

export function initializeAutoScriptureService() {
    if (initializationAttempted) return
    initializationAttempted = true

    if (!ensureRecognition()) return

    const settings = get(scriptureAutoSettings)
    previousAutoStart = settings.autoStartListening ?? false

    handleSettingsChange(settings)

    scriptureAutoSettings.subscribe(handleSettingsChange)
}

function handleSettingsChange(settings: ScriptureAutoSettings) {
    if (recognition) recognition.lang = settings.language || "en-US"

    const autoStart = settings.autoStartListening ?? false
    if (autoStart !== previousAutoStart) {
        if (autoStart) userPaused = false
        previousAutoStart = autoStart
    }

    if (recognition && supported && autoStart && !isListening && !userPaused) {
        startAutoScriptureListening()
    }
}

export function startAutoScriptureListening(): boolean {
    initializeAutoScriptureService()
    if (!ensureRecognition()) return false

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

    if (isListening) stopAutoScriptureListening()
    else startAutoScriptureListening()
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
