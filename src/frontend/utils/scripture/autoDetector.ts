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

interface ExternalScriptureSuggestion {
    bibleId?: string
    osis?: string | string[]
    reference?: string
    book?: string | number
    bookNumber?: string | number
    chapter?: string | number
    verseStart?: string | number
    verseEnd?: string | number
    verses?: Array<string | number>
    text?: string
    translation?: string
    raw?: string
    confidence?: number
    source?: string
}

interface ExternalSuggestionOptions extends DetectionOptions {
    bibleId?: string
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

const OSIS_BOOK_NUMBERS: Record<string, number> = {
    GEN: 1,
    EXOD: 2,
    LEV: 3,
    NUM: 4,
    DEUT: 5,
    JOSH: 6,
    JUDG: 7,
    RUTH: 8,
    "1SAM": 9,
    "2SAM": 10,
    "1KGS": 11,
    "2KGS": 12,
    "1CHR": 13,
    "2CHR": 14,
    EZRA: 15,
    NEH: 16,
    ESTH: 17,
    JOB: 18,
    PS: 19,
    PROV: 20,
    ECCL: 21,
    SONG: 22,
    ISA: 23,
    JER: 24,
    LAM: 25,
    EZEK: 26,
    DAN: 27,
    HOS: 28,
    JOEL: 29,
    AMOS: 30,
    OBAD: 31,
    JONAH: 32,
    MIC: 33,
    NAH: 34,
    HAB: 35,
    ZEPH: 36,
    HAG: 37,
    ZECH: 38,
    MAL: 39,
    MATT: 40,
    MARK: 41,
    LUKE: 42,
    JOHN: 43,
    ACTS: 44,
    ROM: 45,
    "1COR": 46,
    "2COR": 47,
    GAL: 48,
    EPH: 49,
    PHIL: 50,
    COL: 51,
    "1THESS": 52,
    "2THESS": 53,
    "1TIM": 54,
    "2TIM": 55,
    TITUS: 56,
    PHLM: 57,
    HEB: 58,
    JAS: 59,
    "1PET": 60,
    "2PET": 61,
    "1JOHN": 62,
    "2JOHN": 63,
    "3JOHN": 64,
    JUDE: 65,
    REV: 66
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

function normalizeBookKey(value: string): string {
    let base = value.trim()
    try {
        base = base.normalize("NFD")
    } catch (error) {
        // Ignore normalization errors in environments that do not support it
    }

    return base
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^0-9A-Za-z]/g, "")
        .toLowerCase()
}

function buildBookLookupMap(bible: Bible): Map<string, number> {
    const map = new Map<string, number>()

    const books = bible.books || []
    books.forEach((book) => {
        const bookNumber = Math.floor(book.number)
        if (!bookNumber) return

        const candidates = [book.customName, book.name, book.abbreviation]
        candidates.forEach((candidate) => {
            if (!candidate) return
            const key = normalizeBookKey(candidate)
            if (key) map.set(key, bookNumber)
        })
    })

    return map
}

function toNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value)
    if (typeof value === "string") {
        const trimmed = value.trim()
        if (!trimmed) return null
        const parsed = Number.parseInt(trimmed, 10)
        if (Number.isFinite(parsed)) return Math.floor(parsed)
    }
    return null
}

function resolveBookNumber(
    value: unknown,
    bible: Bible,
    lookup: Map<string, number>
): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value)
    if (typeof value === "string") {
        const numeric = toNumber(value)
        if (numeric) return numeric

        const key = normalizeBookKey(value)
        if (key && lookup.has(key)) return lookup.get(key) ?? null

        const osisKey = value.replace(/[^0-9A-Za-z]/g, "").toUpperCase()
        if (osisKey && OSIS_BOOK_NUMBERS[osisKey]) return OSIS_BOOK_NUMBERS[osisKey]
    }

    return null
}

function normalizeVerseRangeFromList(values: Array<string | number> | undefined): { start: number; end: number } | null {
    if (!Array.isArray(values) || !values.length) return null
    const normalized = values
        .map((value) => toNumber(value))
        .filter((value): value is number => typeof value === "number" && value > 0)

    if (!normalized.length) return null

    normalized.sort((a, b) => a - b)
    return { start: normalized[0], end: normalized[normalized.length - 1] }
}

function normalizeVerseList(values: Array<string | number> | undefined): string[] {
    if (!Array.isArray(values)) return []
    const normalized = values
        .map((value) => toNumber(value))
        .filter((value): value is number => typeof value === "number" && value > 0)

    const unique = Array.from(new Set(normalized))
    unique.sort((a, b) => a - b)
    return unique.map((value) => value.toString())
}

function parseOsisRange(
    value: string | string[] | undefined,
    bible: Bible,
    lookup: Map<string, number>
): { bookNumber: number; chapter: number; startVerse: number; endVerse: number } | null {
    const osisValue = Array.isArray(value) ? value[0] : value
    if (typeof osisValue !== "string" || !osisValue.trim()) return null

    const trimmed = osisValue.trim()
    const [startRaw, endRaw] = trimmed.split("-", 2)
    const startParts = startRaw.split(".")
    if (startParts.length < 2) return null

    const bookNumber = resolveBookNumber(startParts[0], bible, lookup)
    if (!bookNumber) return null

    const chapter = toNumber(startParts[1])
    if (!chapter || chapter <= 0) return null

    let startVerse = startParts.length > 2 ? toNumber(startParts[2]) ?? 1 : 1
    if (!startVerse || startVerse <= 0) startVerse = 1

    let endVerse = startVerse
    let endChapter = chapter

    if (endRaw) {
        const endParts = endRaw.split(".")
        if (endParts.length === 1) {
            const candidate = toNumber(endParts[0])
            if (candidate) {
                if (startParts.length > 2) {
                    endVerse = candidate
                } else {
                    endChapter = candidate
                }
            }
        } else if (endParts.length === 2) {
            const chapterCandidate = toNumber(endParts[0])
            const verseCandidate = toNumber(endParts[1])
            if (chapterCandidate) endChapter = chapterCandidate
            if (verseCandidate) endVerse = verseCandidate
        } else if (endParts.length >= 3) {
            const bookCandidate = resolveBookNumber(endParts[0], bible, lookup)
            if (bookCandidate && bookCandidate !== bookNumber) {
                return null
            }
            const chapterCandidate = toNumber(endParts[endParts.length - 2])
            const verseCandidate = toNumber(endParts[endParts.length - 1])
            if (chapterCandidate) endChapter = chapterCandidate
            if (verseCandidate) endVerse = verseCandidate
        }
    }

    if (endChapter !== chapter) return null
    if (!endVerse || endVerse < startVerse) endVerse = startVerse

    return { bookNumber, chapter, startVerse, endVerse }
}

function parseReferenceString(
    reference: string | undefined,
    bible: Bible,
    lookup: Map<string, number>
): { bookNumber: number; chapter: number; startVerse: number; endVerse: number } | null {
    if (!reference) return null
    const trimmed = reference.trim()
    if (!trimmed) return null

    const match = trimmed.match(/^([\dI]{0,3}\s*[A-Za-z\u00C0-\u024F'`.\- ]+)\s+(\d+)(?::(\d+)(?:\s*[-–—]\s*(\d+))?)?/i)
    if (!match) return null

    const bookKey = normalizeBookKey(match[1])
    let bookNumber = lookup.get(bookKey) ?? null

    if (!bookNumber) {
        const romanNormalized = match[1]
            .replace(/\bIII\b/gi, "3")
            .replace(/\bII\b/gi, "2")
            .replace(/\bI\b/gi, "1")
        const romanKey = normalizeBookKey(romanNormalized)
        bookNumber = lookup.get(romanKey) ?? null
    }

    if (!bookNumber) return null

    const chapter = Number.parseInt(match[2], 10)
    if (!Number.isFinite(chapter) || chapter <= 0) return null

    let startVerse = match[3] ? Number.parseInt(match[3], 10) : 1
    if (!Number.isFinite(startVerse) || startVerse <= 0) startVerse = 1

    let endVerse = match[4] ? Number.parseInt(match[4], 10) : startVerse
    if (!Number.isFinite(endVerse) || endVerse < startVerse) endVerse = startVerse

    return { bookNumber, chapter, startVerse, endVerse }
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

        const isSpeechSource = source === "speech" || source === "remote"

        return {
            ...stats,
            detected: stats.detected + entries.length,
            speechDetections: stats.speechDetections + (isSpeechSource ? entries.length : 0),
            manualDetections: stats.manualDetections + (source === "manual" ? entries.length : 0),
            confidenceSamples: samples,
            averageConfidence: samples ? average : 0,
            lastUpdated: Date.now()
        }
    })
}

function commitSuggestions(suggestions: AutoDetectedScripture[], fallbackSource: string) {
    if (!suggestions.length) return

    recordHistoryEntries(suggestions)

    const grouped = new Map<string, AutoDetectedScripture[]>()
    suggestions.forEach((item) => {
        const source = item.source || fallbackSource
        const existing = grouped.get(source)
        if (existing) {
            existing.push(item)
        } else {
            grouped.set(source, [item])
        }
    })

    grouped.forEach((entries, source) => updateDetectionStats(entries, source))

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

    commitSuggestions(suggestions, source)

    return suggestions
}

export function ingestExternalSuggestions(
    input: ExternalScriptureSuggestion | ExternalScriptureSuggestion[],
    options: ExternalSuggestionOptions = {}
): AutoDetectedScripture[] {
    const entries = Array.isArray(input) ? input : input ? [input] : []
    if (!entries.length) return []

    const fallbackBibleId = typeof options.bibleId === "string" && options.bibleId.trim() ? options.bibleId.trim() : undefined
    const fallbackSource = options.source || "remote"

    const cache = get(scripturesCache)
    const translationMeta = get(scriptures)
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

    const runtime: RegisterRuntime = {
        dedupeWindow,
        existingKeys,
        minConfidence: minimumConfidence,
        translationInfo: parserBundle.translationInfo
    }

    const suggestions: AutoDetectedScripture[] = []

    entries.forEach((entry) => {
        if (!entry || typeof entry !== "object") return

        const explicitBibleId = typeof entry.bibleId === "string" && entry.bibleId.trim() ? entry.bibleId.trim() : undefined
        const bibleId = explicitBibleId || fallbackBibleId
        if (!bibleId) return

        const bible = cache[bibleId]
        if (!bible?.books?.length) return

        const bookLookup = buildBookLookupMap(bible)

        let bookNumber = resolveBookNumber(entry.bookNumber ?? entry.book, bible, bookLookup)
        let chapterNumber = toNumber(entry.chapter)

        const verseRange = normalizeVerseRangeFromList(entry.verses)
        let startVerse = verseRange?.start ?? toNumber(entry.verseStart)
        let endVerse = verseRange?.end ?? toNumber(entry.verseEnd)

        const osisRange = parseOsisRange(entry.osis, bible, bookLookup)
        if (osisRange) {
            if (!bookNumber) bookNumber = osisRange.bookNumber
            if (!chapterNumber) chapterNumber = osisRange.chapter
            if (startVerse == null) startVerse = osisRange.startVerse
            if (endVerse == null) endVerse = osisRange.endVerse
        }

        if ((!bookNumber || !chapterNumber) && entry.reference) {
            const referenceRange = parseReferenceString(entry.reference, bible, bookLookup)
            if (referenceRange) {
                if (!bookNumber) bookNumber = referenceRange.bookNumber
                if (!chapterNumber) chapterNumber = referenceRange.chapter
                if (startVerse == null) startVerse = referenceRange.startVerse
                if (endVerse == null) endVerse = referenceRange.endVerse
            }
        }

        if (!bookNumber || !chapterNumber) return

        const normalizedStart = startVerse && startVerse > 0 ? startVerse : 1
        const normalizedEnd = endVerse && endVerse >= normalizedStart ? endVerse : normalizedStart

        const osisValues = Array.isArray(entry.osis)
            ? entry.osis.filter((value): value is string => typeof value === "string" && value.trim())
            : typeof entry.osis === "string" && entry.osis.trim()
              ? [entry.osis.trim()]
              : []

        const osisPayload = osisValues.length > 1 ? osisValues : osisValues.length === 1 ? osisValues[0] : undefined

        const rawCandidate = entry.raw ?? entry.reference ?? (osisValues.length ? osisValues.join(", ") : "")
        const rawValue = rawCandidate ? String(rawCandidate) : ""

        const detectionSource =
            typeof entry.source === "string" && entry.source.trim() ? entry.source.trim() : fallbackSource

        const suggestion = registerSuggestion(
            {
                bible,
                translationName:
                    entry.translation ||
                    translationMeta[bibleId]?.customName ||
                    translationMeta[bibleId]?.name ||
                    bible.name ||
                    bible.metadata?.name ||
                    "",
                bibleId,
                bookNumber,
                chapterNumber,
                startVerse: normalizedStart,
                endVerse: normalizedEnd,
                raw: rawValue,
                source: detectionSource,
                osis: osisPayload,
                confidence:
                    typeof entry.confidence === "number" && Number.isFinite(entry.confidence)
                        ? Math.max(0.35, Math.min(entry.confidence, 0.99))
                        : undefined
            },
            runtime
        )

        if (!suggestion) return

        if (entry.text) suggestion.text = sanitizeText(String(entry.text))
        if (entry.reference) suggestion.reference = String(entry.reference)
        if (entry.translation) suggestion.translation = String(entry.translation)

        if (Array.isArray(entry.verses)) {
            const normalizedVerses = normalizeVerseList(entry.verses)
            if (normalizedVerses.length) suggestion.verses = normalizedVerses
        }

        if (typeof entry.source === "string" && entry.source.trim()) suggestion.source = entry.source.trim()

        suggestions.push(suggestion)
    })

    if (!suggestions.length) return []

    commitSuggestions(suggestions, fallbackSource)

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

function repositionQueue(
    queue: AutoDetectedScripture[],
    fromIndex: number,
    toIndex: number
): AutoDetectedScripture[] {
    if (fromIndex === toIndex) return queue

    const boundedFrom = Math.min(Math.max(fromIndex, 0), queue.length - 1)
    const boundedTo = Math.min(Math.max(toIndex, 0), queue.length - 1)
    if (boundedFrom === boundedTo) return queue

    const next = [...queue]
    const [item] = next.splice(boundedFrom, 1)
    if (!item) return queue
    next.splice(boundedTo, 0, item)
    return next
}

export function moveSuggestion(id: string, direction: "up" | "down") {
    scriptureAutoQueue.update((queue) => {
        const index = queue.findIndex((item) => item.id === id)
        if (index === -1) return queue

        const targetIndex = direction === "up" ? index - 1 : index + 1
        if (targetIndex < 0 || targetIndex >= queue.length) return queue

        return repositionQueue(queue, index, targetIndex)
    })
}

export function moveSuggestionToTop(id: string) {
    scriptureAutoQueue.update((queue) => {
        const index = queue.findIndex((item) => item.id === id)
        if (index <= 0) return queue
        return repositionQueue(queue, index, 0)
    })
}

export function moveSuggestionToBottom(id: string) {
    scriptureAutoQueue.update((queue) => {
        const index = queue.findIndex((item) => item.id === id)
        if (index === -1 || index === queue.length - 1) return queue
        return repositionQueue(queue, index, queue.length - 1)
    })
}
