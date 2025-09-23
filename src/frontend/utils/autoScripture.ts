import { get } from "svelte/store"
import { SCRIPTURE_AUTO } from "../../types/Channels"
import { Main } from "../../types/IPC/Main"
import {
    formatScriptureReference,
    type AutoScriptureExternalReference,
    type AutoScriptureStatus,
    type AutoScriptureSuggestion,
    type AutoScriptureTranscriptEvent
} from "../shared/autoScripture"
import { bookIds } from "../components/drawer/bible/scripture"
import { setDrawerTabData } from "../components/helpers/historyHelpers"
import { newToast } from "./common"
import { sendMain } from "../IPC/main"
import { activeDrawerTab, autoScriptureStatus, autoScriptureSuggestions, autoScriptureTranscripts, drawerTabsData, openScripture, scriptures, special } from "../stores"

let initialized = false

function resetQueues() {
    autoScriptureSuggestions.set([])
    autoScriptureTranscripts.set([])
}

export function initAutoScripture() {
    if (initialized) return
    initialized = true

    window.api.receive(
        SCRIPTURE_AUTO,
        (msg: { channel: string; data: any }) => {
            switch (msg.channel) {
                case "STATUS":
                    updateStatus(msg.data as AutoScriptureStatus)
                    break
                case "SUGGESTION":
                    queueSuggestion(msg.data as AutoScriptureSuggestion)
                    break
                case "TRANSCRIPT":
                    appendTranscript(msg.data as AutoScriptureTranscriptEvent)
                    break
                case "RESET":
                    resetQueues()
                    break
                case "ERROR":
                    if (msg.data?.message) newToast(msg.data.message)
                    break
                default:
                    break
            }
        },
        "auto-scripture"
    )

    sendMain(Main.AUTO_SCRIPTURE, { action: "REQUEST_STATUS" })
}

export function ingestManualTranscript(text: string) {
    if (!text.trim()) return
    sendMain(Main.AUTO_SCRIPTURE, { action: "INGEST_TRANSCRIPT", text: text.trim(), source: "manual" })
}

export function ingestManualReference(reference: AutoScriptureExternalReference) {
    if (!reference) return

    const hasBook = typeof (reference as any)?.bookOsis === "string" || typeof (reference as any)?.bookId === "string" || typeof (reference as any)?.bookName === "string"
    if (!hasBook) return

    const chapter = sanitizeReferenceNumber(reference.chapter)
    const verseStart = sanitizeReferenceNumber(reference.verseStart)
    const verseEnd = sanitizeReferenceNumber(reference.verseEnd ?? reference.verseStart)

    if (!chapter || !verseStart) return

    const payload: AutoScriptureExternalReference = {
        ...reference,
        chapter,
        verseStart
    }

    if (verseEnd >= verseStart) payload.verseEnd = verseEnd

    sendMain(Main.AUTO_SCRIPTURE, {
        action: "INGEST_REFERENCE",
        reference: payload,
        source: "manual",
        timestamp: Date.now()
    })
}

function sanitizeReferenceNumber(value: AutoScriptureExternalReference["chapter"]) {
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, Math.floor(value))
    if (typeof value === "string" && value.trim()) {
        const parsed = Number.parseInt(value, 10)
        if (Number.isFinite(parsed)) return Math.max(1, parsed)
    }
    return 0
}

export function resetAutoScriptureHistory() {
    resetQueues()
    sendMain(Main.AUTO_SCRIPTURE, { action: "RESET_HISTORY" })
}

export function dismissAutoScripture(id: string) {
    autoScriptureSuggestions.update((items) => items.filter((item) => item.id !== id))
}

export function acceptAutoScripture(id: string) {
    const suggestion = get(autoScriptureSuggestions).find((item) => item.id === id)
    if (!suggestion) return

    if (!triggerScripture(suggestion.reference)) {
        newToast("Unable to display scripture – no Bible version configured.")
    }

    dismissAutoScripture(id)
}

function updateStatus(status: AutoScriptureStatus) {
    autoScriptureStatus.set(status)
}

function queueSuggestion(suggestion: AutoScriptureSuggestion) {
    suggestion.formatted = suggestion.formatted || formatScriptureReference(suggestion.reference)

    autoScriptureSuggestions.update((items) => {
        const existingIndex = items.findIndex((item) => item.id === suggestion.id)
        if (existingIndex > -1) {
            const updated = [...items]
            updated[existingIndex] = suggestion
            return updated
        }

        const key = createReferenceKey(suggestion.reference)
        const duplicateIndex = items.findIndex((item) => createReferenceKey(item.reference) === key)
        if (duplicateIndex > -1) {
            const updated = [...items]
            updated[duplicateIndex] = suggestion
            return updated
        }

        return [suggestion, ...items].slice(0, 10)
    })

    if (get(autoScriptureStatus).autoDisplay) {
        setTimeout(() => acceptAutoScripture(suggestion.id), 100)
    }
}

function appendTranscript(event: AutoScriptureTranscriptEvent) {
    if (!event?.text) return
    autoScriptureTranscripts.update((entries) => [event, ...entries].slice(0, 20))
}

function triggerScripture(reference: AutoScriptureSuggestion["reference"]): boolean {
    const target = resolveScriptureTarget()
    if (!target) return false

    const verses = reference.verses.map((v) => v.toString())
    const bookIndex = reference.bookIndex - 1
    const bookValue = target.isApi ? bookIds[bookIndex] : bookIndex

    activeDrawerTab.set("scripture")
    setDrawerTabData("scripture", target.id)

    openScripture.set({
        book: bookValue,
        chapter: reference.chapter,
        verses,
        play: true,
        api: target.isApi
    })

    return true
}

function resolveScriptureTarget(): { id: string; isApi: boolean } | null {
    const scripturesMap = get(scriptures) || {}
    const configuredId: string | undefined = get(special)?.sermonListener?.scriptureId
    const activeId: string | undefined = get(drawerTabsData).scripture?.activeSubTab || undefined

    const candidates = [configuredId, activeId]

    for (const candidate of candidates) {
        const resolved = resolveCandidate(candidate, scripturesMap)
        if (resolved) return resolved
    }

    const fallback = Object.keys(scripturesMap)[0]
    return resolveCandidate(fallback, scripturesMap)
}

function resolveCandidate(candidate: string | undefined, scripturesMap: any) {
    if (!candidate) return null

    let entry = scripturesMap[candidate]
    if (!entry) {
        const matched = Object.entries(scripturesMap).find(([, value]: any) => value?.id === candidate)
        if (matched) {
            entry = matched[1]
            candidate = matched[0]
        }
    }

    if (!entry) return null

    if (entry.collection?.versions?.length) {
        const versionId = entry.collection.versions[0]
        const versionEntry = scripturesMap[versionId]
        if (versionEntry) {
            return { id: versionId, isApi: !!versionEntry.api }
        }
    }

    return { id: candidate, isApi: !!entry.api }
}

function createReferenceKey(reference: AutoScriptureSuggestion["reference"]) {
    const start = reference.verses[0] ?? 0
    const end = reference.endVerse ?? reference.verses[reference.verses.length - 1] ?? start
    return `${reference.bookOsis}.${reference.chapter}.${start}-${end}`
}
