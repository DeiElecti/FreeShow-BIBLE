import { bcv_parser } from "bible-passage-reference-parser/js/en_bcv_parser"
import { get } from "svelte/store"
import type { AutoDetectedScripture } from "../../../types/Scripture"
import type { Bible } from "../../../types/Bible"
import {
    scriptureAutoHistory,
    scriptureAutoQueue,
    scriptureAutoSettings,
    scriptureAutoStats,
    scriptures,
    scripturesCache
} from "../../stores"

interface DetectionOptions {
    source?: string
}

const parser = new bcv_parser()
const translationInfo = parser.translation_info()
const BOOK_ORDER_MAP: Record<string, number> = {}
Object.entries(translationInfo.order).forEach(([key, value]) => {
    if (value >= 1 && value <= 66) BOOK_ORDER_MAP[key.toLowerCase()] = value
})

const processedReferences = new Map<string, number>()
const lastContext = new Map<string, { bookNumber: number; chapter: number }>()
const MAX_QUEUE_ITEMS = 12
const MAX_HISTORY_ITEMS = 40

function sanitizeText(text: string): string {
    if (!text) return ""
    return text
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .replace(/\s([,.;:!?])/g, "$1")
        .trim()
}

function buildQueueKey(bibleId: string, bookNumber: number, chapter: number, startVerse: number, endVerse: number): string {
    return `${bibleId}:${bookNumber}:${chapter}:${startVerse}-${endVerse}`
}

function collectVerses(
    bible: Bible,
    bookNumber: number,
    chapterNumber: number,
    startVerse: number,
    endVerse: number
): { verses: string[]; preview: string } | null {
    const book = bible.books?.find((b) => b.number === bookNumber)
    if (!book) return null

    const chapter = book.chapters?.find((c) => c.number === chapterNumber)
    if (!chapter) return null

    const verses = chapter.verses || []
    if (!verses.length) return null

    const highestVerse = verses[verses.length - 1]?.number || 0
    if (!highestVerse) return null

    const from = Math.max(1, startVerse)
    const to = Math.min(endVerse, highestVerse)
    if (from > highestVerse || from > to) return null

    const verseIds: string[] = []
    const previewSegments: string[] = []

    verses.forEach((verse) => {
        if (verse.number >= from && verse.number <= to) {
            verseIds.push(String(verse.number))
            previewSegments.push(sanitizeText(verse.text || verse.value || ""))
        }
    })

    if (!verseIds.length) return null

    return {
        verses: verseIds,
        preview: previewSegments.join(" ").replace(/\s+/g, " ").trim()
    }
}

function hasChapter(bible: Bible, bookNumber: number, chapterNumber: number): boolean {
    const book = bible.books?.find((b) => b.number === bookNumber)
    if (!book) return false

    const chapter = book.chapters?.find((c: any) => Number(c.number) === chapterNumber)
    if (!chapter) return false

    const verses = chapter.verses || []
    return verses.length > 0
}

function getReferenceName(bible: Bible, bookNumber: number): string {
    const referenceBook = bible.books?.find((b) => b.number === bookNumber)
    return referenceBook?.customName || referenceBook?.name || translationInfo.books[bookNumber - 1] || ""
}

function pruneProcessedReferences(now: number, dedupeWindow: number) {
    const expireAfter = Math.max(dedupeWindow * 4, 60000)
    processedReferences.forEach((timestamp, key) => {
        if (now - timestamp > expireAfter) processedReferences.delete(key)
    })
}

interface RegisterRuntime {
    dedupeWindow: number
    existingKeys: Set<string>
    minConfidence: number
}

interface RegisterInfo {
    bible: Bible
    translationName: string
    bibleId: string
    bookNumber: number
    chapterNumber: number
    startVerse: number
    endVerse: number
    raw: string
    source: string
    osis?: string | string[]
    confidence?: number
}

function registerSuggestion(info: RegisterInfo, runtime: RegisterRuntime): AutoDetectedScripture | null {
    let { startVerse, endVerse } = info
    const { bibleId, bookNumber, chapterNumber } = info

    startVerse = Math.max(1, Math.floor(startVerse))
    endVerse = Math.max(startVerse, Math.floor(endVerse))

    if (chapterNumber <= 0) return null

    const queueKey = buildQueueKey(bibleId, bookNumber, chapterNumber, startVerse, endVerse)
    const timestamp = Date.now()

    if (runtime.existingKeys.has(queueKey)) return null

    const lastProcessed = processedReferences.get(queueKey)
    if (lastProcessed && timestamp - lastProcessed < runtime.dedupeWindow) return null

    const verseData = collectVerses(info.bible, bookNumber, chapterNumber, startVerse, endVerse)
    if (!verseData) return null

    const referenceName = getReferenceName(info.bible, bookNumber)
    if (!referenceName) return null

    const verseStartNumber = parseInt(verseData.verses[0], 10)
    const verseEndNumber = parseInt(verseData.verses[verseData.verses.length - 1], 10)

    let confidence =
        typeof info.confidence === "number" && Number.isFinite(info.confidence)
            ? info.confidence
            : 0.75

    const span = Math.max(0, endVerse - startVerse)
    if (span >= 4) confidence -= 0.05
    if (span >= 8) confidence -= 0.05
    confidence = Math.max(0.35, Math.min(0.99, confidence))

    if (confidence < runtime.minConfidence) return null

    const suggestion: AutoDetectedScripture = {
        id: `${queueKey}:${timestamp}`,
        osis: Array.isArray(info.osis) ? info.osis[0] || "" : info.osis || "",
        bibleId,
        bookNumber,
        chapter: chapterNumber,
        verseStart: Number.isNaN(verseStartNumber) ? startVerse : verseStartNumber,
        verseEnd: Number.isNaN(verseEndNumber) ? endVerse : verseEndNumber,
        verses: verseData.verses,
        reference: `${referenceName} ${chapterNumber}:${verseData.verses[0]}${
            verseData.verses.length > 1 ? `-${verseData.verses[verseData.verses.length - 1]}` : ""
        }`,
        text: verseData.preview,
        translation: info.translationName,
        source: info.source,
        createdAt: timestamp,
        raw: info.raw,
        confidence
    }

    processedReferences.set(queueKey, timestamp)
    runtime.existingKeys.add(queueKey)
    lastContext.set(bibleId, { bookNumber, chapter: chapterNumber })

    return suggestion
}

function recordHistoryEntries(entries: AutoDetectedScripture[]) {
    if (!entries.length) return

    const clones = entries.map((item) => ({ ...item }))

    scriptureAutoHistory.update((history) => {
        const combined = [...clones, ...history]
        const seen = new Set<string>()
        const unique: AutoDetectedScripture[] = []

        combined.forEach((item) => {
            if (seen.has(item.id)) return
            seen.add(item.id)
            unique.push(item)
        })

        return unique.slice(0, MAX_HISTORY_ITEMS)
    })
}

function updateDetectionStats(entries: AutoDetectedScripture[], source: string) {
    if (!entries.length) return

    scriptureAutoStats.update((stats) => {
        let average = stats.averageConfidence
        let samples = stats.confidenceSamples

        entries.forEach((item) => {
            if (typeof item.confidence === "number" && Number.isFinite(item.confidence)) {
                samples += 1
                average += (item.confidence - average) / samples
            }
        })

        return {
            ...stats,
            detected: stats.detected + entries.length,
            speechDetections: stats.speechDetections + (source === "speech" ? entries.length : 0),
            manualDetections: stats.manualDetections + (source === "manual" ? entries.length : 0),
            confidenceSamples: samples,
            averageConfidence: samples ? average : 0,
            lastUpdated: Date.now()
        }
    })
}

interface ContextRuntime {
    bible: Bible
    bibleId: string
    bookNumber: number
    chapter: number
    translationName: string
    source: string
    raw: string
    runtime: RegisterRuntime
}

function detectContextualReferences(text: string, context: ContextRuntime): AutoDetectedScripture[] {
    const results: AutoDetectedScripture[] = []
    let currentChapter = context.chapter
    const consumedRanges: Array<{ start: number; end: number }> = []

    const chapterRegex = /\bchapter\s+(\d+)(?:\s+(?:verse|verses)\s+(\d+)(?:\s*(?:-|to|through|and)\s*(\d+))?)?/gi
    let match: RegExpExecArray | null

    while ((match = chapterRegex.exec(text))) {
        const chapterNumber = parseInt(match[1], 10)
        if (Number.isNaN(chapterNumber) || chapterNumber <= 0) {
            consumedRanges.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length })
            continue
        }

        if (!match[2]) {
            if (hasChapter(context.bible, context.bookNumber, chapterNumber)) {
                lastContext.set(context.bibleId, { bookNumber: context.bookNumber, chapter: chapterNumber })
                currentChapter = chapterNumber
            }
            consumedRanges.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length })
            continue
        }

        let startVerse = parseInt(match[2], 10)
        let endVerse = match[3] ? parseInt(match[3], 10) : startVerse

        if (Number.isNaN(startVerse)) startVerse = 1
        if (Number.isNaN(endVerse)) endVerse = startVerse
        if (endVerse < startVerse) endVerse = startVerse

        const suggestion = registerSuggestion(
            {
                bible: context.bible,
                translationName: context.translationName,
                bibleId: context.bibleId,
                bookNumber: context.bookNumber,
                chapterNumber,
                startVerse,
                endVerse,
                raw: context.raw,
                source: context.source,
                confidence: 0.78
            },
            context.runtime
        )

        if (suggestion) {
            results.push(suggestion)
            currentChapter = chapterNumber
        }

        consumedRanges.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length })
    }

    const verseRegex = /\bverses?\s+(\d+)(?:\s*(?:-|to|through|and)\s*(\d+))?/gi
    while ((match = verseRegex.exec(text))) {
        const startIndex = match.index ?? 0
        const endIndex = startIndex + match[0].length
        if (consumedRanges.some((range) => startIndex < range.end && endIndex > range.start)) continue

        let startVerse = parseInt(match[1], 10)
        let endVerse = match[2] ? parseInt(match[2], 10) : startVerse
        if (Number.isNaN(startVerse) || startVerse <= 0) continue
        if (Number.isNaN(endVerse) || endVerse < startVerse) endVerse = startVerse

        const suggestion = registerSuggestion(
            {
                bible: context.bible,
                translationName: context.translationName,
                bibleId: context.bibleId,
                bookNumber: context.bookNumber,
                chapterNumber: currentChapter,
                startVerse,
                endVerse,
                raw: context.raw,
                source: context.source,
                confidence: 0.7
            },
            context.runtime
        )

        if (suggestion) results.push(suggestion)
    }

    return results
}

export function ingestTranscript(rawText: string, bibleId: string, options: DetectionOptions = {}): AutoDetectedScripture[] {
    const trimmed = (rawText || "").replace(/\s+/g, " ").trim()
    if (!trimmed) return []

    const bible = get(scripturesCache)[bibleId]
    if (!bible?.books?.length) return []

    const translationMeta = get(scriptures)
    const translationName =
        translationMeta[bibleId]?.customName || translationMeta[bibleId]?.name || bible.name || bible.metadata?.name || ""

    const settings = get(scriptureAutoSettings)
    const dedupeWindow = settings?.dedupeWindowMs ?? 15000

    const now = Date.now()
    pruneProcessedReferences(now, dedupeWindow)

    const existingQueue = get(scriptureAutoQueue)
    const existingKeys = new Set(
        existingQueue.map((item) => buildQueueKey(item.bibleId, item.bookNumber, item.chapter, item.verseStart, item.verseEnd))
    )

    const minimumConfidence = Math.min(
        Math.max(settings?.minimumConfidence ?? 0.55, 0),
        0.99
    )

    const runtime: RegisterRuntime = { dedupeWindow, existingKeys, minConfidence: minimumConfidence }
    const suggestions: AutoDetectedScripture[] = []

    const parsed = parser.parse(trimmed).parsed_entities()
    parsed.forEach((match) => {
        const entity = match.entities?.[0]
        if (!entity?.start?.b || !entity.start.c) return

        if (entity.end?.c && entity.start.c !== entity.end.c) return

        const bookCode = entity.start.b.toLowerCase()
        const bookNumber = BOOK_ORDER_MAP[bookCode]
        if (!bookNumber) return

        const chapterNumber = entity.start.c
        const startVerse = entity.start.v || 1
        const endVerse = entity.end?.v || entity.start.v || 1

        const suggestion = registerSuggestion(
            {
                bible,
                translationName,
                bibleId,
                bookNumber,
                chapterNumber,
                startVerse,
                endVerse,
                raw: trimmed,
                source: options.source || "speech",
                osis: match.osis,
                confidence: 0.95
            },
            runtime
        )

        if (suggestion) suggestions.push(suggestion)
    })

    const contextDetails = lastContext.get(bibleId)
    if (contextDetails) {
        const contextSuggestions = detectContextualReferences(trimmed, {
            bible,
            bibleId,
            bookNumber: contextDetails.bookNumber,
            chapter: contextDetails.chapter,
            translationName,
            source: options.source || "speech",
            raw: trimmed,
            runtime
        })

        if (contextSuggestions.length) suggestions.push(...contextSuggestions)
    }

    if (!suggestions.length) return []

    recordHistoryEntries(suggestions)
    updateDetectionStats(suggestions, options.source || "speech")

    scriptureAutoQueue.update((queue) => {
        const combined = [...suggestions, ...queue]
        const seen = new Set<string>()
        const unique: AutoDetectedScripture[] = []

        combined.forEach((item) => {
            const key = buildQueueKey(item.bibleId, item.bookNumber, item.chapter, item.verseStart, item.verseEnd)
            if (seen.has(key)) return
            seen.add(key)
            unique.push(item)
        })

        return unique.slice(0, MAX_QUEUE_ITEMS)
    })

    return suggestions
}

export function dismissSuggestion(id: string, skipStats = false) {
    let removed: AutoDetectedScripture | null = null
    scriptureAutoQueue.update((queue) =>
        queue.filter((item) => {
            if (item.id === id) removed = item
            return item.id !== id
        })
    )

    if (!skipStats && removed) {
        scriptureAutoStats.update((stats) => ({
            ...stats,
            dismissed: stats.dismissed + 1,
            lastUpdated: Date.now()
        }))
    }
}

export function clearProcessedReferences() {
    processedReferences.clear()
    lastContext.clear()
}

export function clearSuggestionQueue() {
    const current = get(scriptureAutoQueue)
    if (current.length) {
        scriptureAutoStats.update((stats) => ({
            ...stats,
            dismissed: stats.dismissed + current.length,
            lastUpdated: Date.now()
        }))
    }

    scriptureAutoQueue.set([])
    clearProcessedReferences()
}
