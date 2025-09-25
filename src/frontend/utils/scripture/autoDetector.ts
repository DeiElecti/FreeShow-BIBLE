import { bcv_parser as en_bcv_parser } from "bible-passage-reference-parser/js/en_bcv_parser"
import { bcv_parser as es_bcv_parser } from "bible-passage-reference-parser/js/es_bcv_parser"
import { bcv_parser as fr_bcv_parser } from "bible-passage-reference-parser/js/fr_bcv_parser"
import { bcv_parser as pt_bcv_parser } from "bible-passage-reference-parser/js/pt_bcv_parser"
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

type ParserConstructor = new () => any

interface ParserTranslationInfo {
    books: string[]
    order: Record<string, number>
}

interface ParserBundle {
    key: string
    Parser: ParserConstructor
    translationInfo: ParserTranslationInfo
    bookOrderMap: Record<string, number>
}

const DEFAULT_PARSER_KEY = "en"

const LANGUAGE_TO_PARSER_KEY: Record<string, string> = {
    en: "en",
    "en-us": "en",
    "en-gb": "en",
    es: "es",
    "es-es": "es",
    "es-mx": "es",
    pt: "pt",
    "pt-br": "pt",
    fr: "fr",
    "fr-fr": "fr",
    "fr-ca": "fr"
}

function createParserBundle(key: string, Parser: ParserConstructor): ParserBundle {
    const parserInstance = new Parser()
    let info: ParserTranslationInfo = { books: [], order: {} }

    try {
        const translation = parserInstance.translation_info?.() || {}
        const books = Array.isArray(translation.books) ? [...translation.books] : []
        const order = typeof translation.order === "object" && translation.order ? translation.order : {}
        info = { books, order }
    } catch (error) {
        info = { books: [], order: {} }
    }

    const map: Record<string, number> = {}
    Object.entries(info.order).forEach(([bookCode, index]) => {
        if (typeof index === "number") map[bookCode.toLowerCase()] = index
    })

    return { key, Parser, translationInfo: info, bookOrderMap: map }
}

const PARSER_BUNDLES: Record<string, ParserBundle> = {
    en: createParserBundle("en", en_bcv_parser),
    es: createParserBundle("es", es_bcv_parser),
    fr: createParserBundle("fr", fr_bcv_parser),
    pt: createParserBundle("pt", pt_bcv_parser)
}

function resolveParserBundle(language?: string): ParserBundle {
    if (!language) return PARSER_BUNDLES[DEFAULT_PARSER_KEY]

    const normalized = language.toLowerCase()
    const direct = LANGUAGE_TO_PARSER_KEY[normalized]
    if (direct && PARSER_BUNDLES[direct]) return PARSER_BUNDLES[direct]

    const base = LANGUAGE_TO_PARSER_KEY[normalized.split("-")[0]]
    if (base && PARSER_BUNDLES[base]) return PARSER_BUNDLES[base]

    return PARSER_BUNDLES[DEFAULT_PARSER_KEY]
}

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

function formatBookFallback(code: string | undefined): string {
    if (!code) return ""
    return code
        .replace(/_/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/^(\d)([A-Za-z])/, "$1 $2")
}

function getReferenceName(
    bible: Bible,
    bookNumber: number,
    translationInfo: ParserTranslationInfo
): string {
    const referenceBook = bible.books?.find((b) => b.number === bookNumber)
    if (referenceBook?.customName) return referenceBook.customName
    if (referenceBook?.name) return referenceBook.name

    const fallback = translationInfo?.books?.[bookNumber - 1]
    return formatBookFallback(fallback)
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
    translationInfo: ParserTranslationInfo
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

    const referenceName = getReferenceName(info.bible, bookNumber, runtime.translationInfo)
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

interface DetectRequest {
    text: string
    raw: string
    bibleId: string
    bible: Bible
    translationName: string
    bundle: ParserBundle
    runtime: RegisterRuntime
    source: string
}

function detectWithBundle(request: DetectRequest): AutoDetectedScripture[] {
    const suggestions: AutoDetectedScripture[] = []
    const parserInstance = new request.bundle.Parser()

    let parsed: any[] = []
    try {
        parsed = parserInstance.parse(request.text).parsed_entities()
    } catch (error) {
        return suggestions
    }

    parsed.forEach((match) => {
        const entity = match.entities?.[0]
        if (!entity?.start?.b || !entity.start.c) return

        if (entity.end?.c && entity.start.c !== entity.end.c) return

        const bookCode = String(entity.start.b || "").toLowerCase()
        const bookNumber = request.bundle.bookOrderMap[bookCode]
        if (!bookNumber) return

        const chapterNumber = entity.start.c
        const startVerse = entity.start.v || 1
        const endVerse = entity.end?.v || entity.start.v || 1

        const suggestion = registerSuggestion(
            {
                bible: request.bible,
                translationName: request.translationName,
                bibleId: request.bibleId,
                bookNumber,
                chapterNumber,
                startVerse,
                endVerse,
                raw: request.raw,
                source: request.source,
                osis: match.osis,
                confidence: 0.95
            },
            request.runtime
        )

        if (suggestion) suggestions.push(suggestion)
    })

    const contextDetails = lastContext.get(request.bibleId)
    if (contextDetails) {
        const contextSuggestions = detectContextualReferences(request.text, {
            bible: request.bible,
            bibleId: request.bibleId,
            bookNumber: contextDetails.bookNumber,
            chapter: contextDetails.chapter,
            translationName: request.translationName,
            source: request.source,
            raw: request.raw,
            runtime: request.runtime
        })

        if (contextSuggestions.length) suggestions.push(...contextSuggestions)
    }

    return suggestions
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

    const minimumConfidence = Math.min(Math.max(settings?.minimumConfidence ?? 0.55, 0), 0.99)
    const parserBundle = resolveParserBundle(settings?.language)
    const source = options.source || "speech"

    const baseRuntime = { dedupeWindow, existingKeys, minConfidence: minimumConfidence }

    const suggestionsPrimary = detectWithBundle({
        text: trimmed,
        raw: trimmed,
        bibleId,
        bible,
        translationName,
        bundle: parserBundle,
        runtime: { ...baseRuntime, translationInfo: parserBundle.translationInfo },
        source
    })

    let suggestions = suggestionsPrimary

    if (!suggestions.length && source === "manual" && parserBundle.key !== DEFAULT_PARSER_KEY) {
        const fallbackBundle = PARSER_BUNDLES[DEFAULT_PARSER_KEY]
        suggestions = detectWithBundle({
            text: trimmed,
            raw: trimmed,
            bibleId,
            bible,
            translationName,
            bundle: fallbackBundle,
            runtime: { ...baseRuntime, translationInfo: fallbackBundle.translationInfo },
            source
        })
    }

    if (!suggestions.length) return []

    recordHistoryEntries(suggestions)
    updateDetectionStats(suggestions, source)

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
