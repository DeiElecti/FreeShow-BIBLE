import { formatScriptureReference, getBookMeta, type AutoScriptureReference } from "../../shared/autoScripture"

let parser: any = null
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { bcv_parser } = require("bible-passage-reference-parser/js/en_bcv_parser")
    parser = new bcv_parser()
    parser.set_options({
        book_alone_strategy: "full",
        book_sequence_strategy: "separate",
        osis_compaction_strategy: "b",
        consecutive_combination_strategy: "combine",
        single_chapter_1_strategy: "include",
        single_chapter_1: "include",
        single_chapter_2_strategy: "include",
        single_chapter_2: "include",
        ps151_strategy: "b"
    })
} catch (err) {
    console.warn("Bible reference parser not available:", err)
}

export function hasReferenceParser() {
    return !!parser
}

export function extractReferences(text: string, maxVerses: number): AutoScriptureReference[] {
    if (!parser || !text) return []
    try {
        const results: any[] = parser.parse(text).osis_and_indices()
        const references: AutoScriptureReference[] = []
        results.forEach((result) => {
            const osis: string = result.osis || ""
            if (!osis) return

            osis.split(",").forEach((osisRef) => {
                const normalized = normalizeOsis(osisRef.trim(), maxVerses)
                if (normalized) {
                    if (normalized.verses.length) {
                        normalized.endVerse = normalized.verses[normalized.verses.length - 1]
                    }
                    normalized.verses = normalized.verses.filter((v) => Number.isFinite(v))
                    if (!normalized.verses.length) return
                    normalized.bookName = normalized.bookName || getBookMeta(normalized.bookOsis)?.name || normalized.bookOsis
                    normalized.formatted = formatScriptureReference(normalized)
                    references.push(normalized)
                }
            })
        })
        return references
    } catch (err) {
        console.warn("Failed to parse scripture references:", err)
        return []
    }
}

interface OsisParts {
    book?: string
    chapter?: number
    verse?: number
}

function normalizeOsis(osis: string, maxVerses: number): AutoScriptureReference | null {
    if (!osis) return null
    const [rawStart, rawEnd] = osis.split("-")
    const start = parseOsisPart(rawStart)
    if (!start.book || !start.chapter || !start.verse) return null

    const end = parseOsisPart(rawEnd, start.book, start.chapter, start.verse)
    const bookMeta = getBookMeta(start.book)
    if (!bookMeta) return null

    if (end.book && end.book !== start.book) return null // cross-book references not supported automatically

    const startVerse = start.verse
    const endVerse = end.verse ?? start.verse
    const endChapter = end.chapter ?? start.chapter

    if (endChapter !== start.chapter) {
        // avoid spanning multiple chapters automatically to keep slides readable
        return {
            bookId: bookMeta.id,
            bookIndex: bookMeta.index,
            bookOsis: bookMeta.osis,
            bookName: bookMeta.name,
            chapter: start.chapter,
            endChapter,
            verses: [startVerse],
            endVerse
        }
    }

    const verses: number[] = []
    const highestVerse = Math.max(startVerse, endVerse)
    const lowestVerse = Math.min(startVerse, endVerse)
    for (let verse = lowestVerse; verse <= highestVerse; verse++) {
        verses.push(verse)
        if (verses.length >= maxVerses) break
    }

    return {
        bookId: bookMeta.id,
        bookIndex: bookMeta.index,
        bookOsis: bookMeta.osis,
        bookName: bookMeta.name,
        chapter: start.chapter,
        verses,
        endVerse: highestVerse
    }
}

function parseOsisPart(part: string, defaultBook?: string, defaultChapter?: number, defaultVerse?: number): OsisParts {
    if (!part) {
        return { book: defaultBook, chapter: defaultChapter, verse: defaultVerse }
    }

    const split = part.split(".")
    const clean = (value: string | undefined) => (value ? Number.parseInt(value.replace(/[^0-9]/g, ""), 10) || undefined : undefined)

    if (split.length === 3) {
        return {
            book: split[0],
            chapter: clean(split[1]) ?? defaultChapter,
            verse: clean(split[2]) ?? defaultVerse
        }
    }

    if (split.length === 2) {
        const possibleChapter = clean(split[0])
        if (possibleChapter !== undefined) {
            return {
                book: defaultBook,
                chapter: possibleChapter,
                verse: clean(split[1]) ?? defaultVerse
            }
        }

        return {
            book: split[0],
            chapter: clean(split[1]) ?? defaultChapter,
            verse: defaultVerse
        }
    }

    if (split.length === 1) {
        const possibleVerse = clean(split[0])
        if (possibleVerse !== undefined) {
            return { book: defaultBook, chapter: defaultChapter, verse: possibleVerse }
        }
        return { book: split[0], chapter: defaultChapter, verse: defaultVerse }
    }

    return { book: defaultBook, chapter: defaultChapter, verse: defaultVerse }
}
