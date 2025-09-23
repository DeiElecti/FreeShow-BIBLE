export type SermonTranscriberEngine = "disabled" | "vosk"

export interface SermonTranscriberSettings {
    /** Speech-recognition engine that should process decoded sermon audio. */
    engine: SermonTranscriberEngine
    /** Filesystem path that contains the offline model required by the recognizer. */
    modelPath: string
    /** Target sample rate fed into the recognizer after down-mixing. */
    sampleRate: number
    /** Whether partial transcripts should be emitted while audio is still buffered. */
    enablePartial: boolean
    /** Maximum alternative hypotheses returned by the engine (0 disables alternatives). */
    maxAlternatives: number
}

export interface SermonListenerSettings {
    /** Whether the transcription listener is active. */
    enabled: boolean
    /** Automatically push detected scriptures to the output without manual confirmation. */
    autoDisplay: boolean
    /** Port used by the local HTTP listener that accepts transcript payloads. */
    port: number
    /** Minimum accepted confidence score (0-1). */
    minConfidence: number
    /** Time in seconds before the same reference can be triggered again. */
    duplicateInterval: number
    /** Maximum amount of verses allowed in a single automatic trigger. */
    maxVerses: number
    /** Optional scripture/collection identifier to use when showing references. */
    scriptureId: string
    /** Additional hostnames or proxy URLs that should be surfaced in the UI. */
    customEndpoints: string[]
    /** Configuration for the built-in speech-recognition engine. */
    transcriber: SermonTranscriberSettings
}

export const DEFAULT_SERMON_TRANSCRIBER_SETTINGS: SermonTranscriberSettings = {
    engine: "disabled",
    modelPath: "",
    sampleRate: 16000,
    enablePartial: true,
    maxAlternatives: 0
}

export const DEFAULT_SERMON_LISTENER_SETTINGS: SermonListenerSettings = {
    enabled: false,
    autoDisplay: false,
    port: 5750,
    minConfidence: 0.55,
    duplicateInterval: 45,
    maxVerses: 8,
    scriptureId: "",
    customEndpoints: [],
    transcriber: { ...DEFAULT_SERMON_TRANSCRIBER_SETTINGS }
}

export interface AutoScriptureReference {
    bookIndex: number
    bookId: string
    bookOsis: string
    bookName: string
    chapter: number
    endChapter?: number
    verses: number[]
    endVerse?: number
    formatted?: string
}

export interface AutoScriptureSuggestion {
    id: string
    reference: AutoScriptureReference
    transcript?: string
    timestamp: number
    confidence?: number
    source?: string
    formatted?: string
}

export interface AutoScriptureTranscriptEvent {
    text: string
    timestamp: number
    confidence?: number
    speaker?: string
    source?: string
}

export interface AutoScriptureStatus {
    enabled: boolean
    listening: boolean
    port: number
    autoDisplay: boolean
    minConfidence: number
    duplicateInterval: number
    maxVerses: number
    scriptureId: string
    recognizedReferences: number
    lastTranscriptAt?: number
    lastSuggestionAt?: number
    httpEndpoint?: string
    httpEndpoints?: AutoScriptureEndpoint[]
    customEndpoints: string[]
    transcriberEngine: SermonTranscriberEngine
    transcriberReady: boolean
    transcriberMessage?: string
    transcriberSampleRate: number
    transcriberPartial: boolean
}

export interface AutoScriptureError {
    message: string
    fatal?: boolean
}

export interface AutoScriptureStatusReport {
    status: AutoScriptureStatus
    suggestions: AutoScriptureSuggestion[]
    transcripts: AutoScriptureTranscriptEvent[]
}

export type AutoScriptureEndpointType = "loopback" | "lan" | "custom"

export interface AutoScriptureEndpoint {
    url: string
    type: AutoScriptureEndpointType
}

export type AutoScriptureCommand =
    | { action: "REQUEST_STATUS" }
    | {
          action: "INGEST_TRANSCRIPT"
          text: string
          confidence?: number
          speaker?: string
          timestamp?: number
          source?: string
      }
    | { action: "RESET_HISTORY" }
    | {
          action: "INGEST_REFERENCE"
          reference?: AutoScriptureExternalReference
          references?: AutoScriptureExternalReference[]
          confidence?: number
          source?: string
          timestamp?: number
          transcript?: string
      }

export interface AutoScriptureExternalReference {
    bookOsis?: string
    bookId?: string
    bookName?: string
    chapter: number | string
    verseStart: number | string
    verseEnd?: number | string
}

interface BookMeta {
    index: number
    osis: string
    id: string
    name: string
    aliases?: string[]
}

export const BIBLE_BOOK_META: BookMeta[] = [
    { index: 1, osis: "Gen", id: "GEN", name: "Genesis", aliases: ["Gen"] },
    { index: 2, osis: "Exod", id: "EXO", name: "Exodus", aliases: ["Ex"] },
    { index: 3, osis: "Lev", id: "LEV", name: "Leviticus" },
    { index: 4, osis: "Num", id: "NUM", name: "Numbers" },
    { index: 5, osis: "Deut", id: "DEU", name: "Deuteronomy", aliases: ["Deu"] },
    { index: 6, osis: "Josh", id: "JOS", name: "Joshua" },
    { index: 7, osis: "Judg", id: "JDG", name: "Judges" },
    { index: 8, osis: "Ruth", id: "RUT", name: "Ruth" },
    { index: 9, osis: "1Sam", id: "1SA", name: "1 Samuel", aliases: ["1Sa", "1Samuel"] },
    { index: 10, osis: "2Sam", id: "2SA", name: "2 Samuel", aliases: ["2Sa", "2Samuel"] },
    { index: 11, osis: "1Kgs", id: "1KI", name: "1 Kings", aliases: ["1Kgs", "1Kin"] },
    { index: 12, osis: "2Kgs", id: "2KI", name: "2 Kings", aliases: ["2Kgs", "2Kin"] },
    { index: 13, osis: "1Chr", id: "1CH", name: "1 Chronicles", aliases: ["1Ch", "1Chron"] },
    { index: 14, osis: "2Chr", id: "2CH", name: "2 Chronicles", aliases: ["2Ch", "2Chron"] },
    { index: 15, osis: "Ezra", id: "EZR", name: "Ezra" },
    { index: 16, osis: "Neh", id: "NEH", name: "Nehemiah" },
    { index: 17, osis: "Esth", id: "EST", name: "Esther", aliases: ["Est"] },
    { index: 18, osis: "Job", id: "JOB", name: "Job" },
    { index: 19, osis: "Ps", id: "PSA", name: "Psalms", aliases: ["Psa", "Psalm"] },
    { index: 20, osis: "Prov", id: "PRO", name: "Proverbs", aliases: ["Pr", "Pro"] },
    { index: 21, osis: "Eccl", id: "ECC", name: "Ecclesiastes", aliases: ["Ecc"] },
    { index: 22, osis: "Song", id: "SNG", name: "Song of Solomon", aliases: ["Song", "SongOfSol", "Cant"] },
    { index: 23, osis: "Isa", id: "ISA", name: "Isaiah" },
    { index: 24, osis: "Jer", id: "JER", name: "Jeremiah" },
    { index: 25, osis: "Lam", id: "LAM", name: "Lamentations", aliases: ["La"] },
    { index: 26, osis: "Ezek", id: "EZK", name: "Ezekiel", aliases: ["Eze"] },
    { index: 27, osis: "Dan", id: "DAN", name: "Daniel" },
    { index: 28, osis: "Hos", id: "HOS", name: "Hosea" },
    { index: 29, osis: "Joel", id: "JOL", name: "Joel" },
    { index: 30, osis: "Amos", id: "AMO", name: "Amos" },
    { index: 31, osis: "Obad", id: "OBA", name: "Obadiah" },
    { index: 32, osis: "Jonah", id: "JON", name: "Jonah" },
    { index: 33, osis: "Mic", id: "MIC", name: "Micah" },
    { index: 34, osis: "Nah", id: "NAM", name: "Nahum" },
    { index: 35, osis: "Hab", id: "HAB", name: "Habakkuk" },
    { index: 36, osis: "Zeph", id: "ZEP", name: "Zephaniah", aliases: ["Zep"] },
    { index: 37, osis: "Hag", id: "HAG", name: "Haggai" },
    { index: 38, osis: "Zech", id: "ZEC", name: "Zechariah" },
    { index: 39, osis: "Mal", id: "MAL", name: "Malachi" },
    { index: 40, osis: "Matt", id: "MAT", name: "Matthew", aliases: ["Mt"] },
    { index: 41, osis: "Mark", id: "MRK", name: "Mark", aliases: ["Mk"] },
    { index: 42, osis: "Luke", id: "LUK", name: "Luke", aliases: ["Lu", "Lk"] },
    { index: 43, osis: "John", id: "JHN", name: "John", aliases: ["Jn"] },
    { index: 44, osis: "Acts", id: "ACT", name: "Acts" },
    { index: 45, osis: "Rom", id: "ROM", name: "Romans" },
    { index: 46, osis: "1Cor", id: "1CO", name: "1 Corinthians", aliases: ["1Co"] },
    { index: 47, osis: "2Cor", id: "2CO", name: "2 Corinthians", aliases: ["2Co"] },
    { index: 48, osis: "Gal", id: "GAL", name: "Galatians" },
    { index: 49, osis: "Eph", id: "EPH", name: "Ephesians" },
    { index: 50, osis: "Phil", id: "PHP", name: "Philippians", aliases: ["Php", "Phil"] },
    { index: 51, osis: "Col", id: "COL", name: "Colossians" },
    { index: 52, osis: "1Thess", id: "1TH", name: "1 Thessalonians", aliases: ["1Th"] },
    { index: 53, osis: "2Thess", id: "2TH", name: "2 Thessalonians", aliases: ["2Th"] },
    { index: 54, osis: "1Tim", id: "1TI", name: "1 Timothy", aliases: ["1Ti"] },
    { index: 55, osis: "2Tim", id: "2TI", name: "2 Timothy", aliases: ["2Ti"] },
    { index: 56, osis: "Titus", id: "TIT", name: "Titus" },
    { index: 57, osis: "Phlm", id: "PHM", name: "Philemon", aliases: ["Phlm", "Phm"] },
    { index: 58, osis: "Heb", id: "HEB", name: "Hebrews" },
    { index: 59, osis: "Jas", id: "JAS", name: "James" },
    { index: 60, osis: "1Pet", id: "1PE", name: "1 Peter", aliases: ["1Pe"] },
    { index: 61, osis: "2Pet", id: "2PE", name: "2 Peter", aliases: ["2Pe"] },
    { index: 62, osis: "1John", id: "1JN", name: "1 John", aliases: ["1Jn", "1Jhn"] },
    { index: 63, osis: "2John", id: "2JN", name: "2 John", aliases: ["2Jn", "2Jhn"] },
    { index: 64, osis: "3John", id: "3JN", name: "3 John", aliases: ["3Jn", "3Jhn"] },
    { index: 65, osis: "Jude", id: "JUD", name: "Jude" },
    { index: 66, osis: "Rev", id: "REV", name: "Revelation", aliases: ["Re", "Revel"] }
]

const bookMap: Record<string, BookMeta> = {}
BIBLE_BOOK_META.forEach((book) => {
    bookMap[book.osis.toLowerCase()] = book
    bookMap[book.id.toLowerCase()] = book
    if (book.aliases) {
        book.aliases.forEach((alias) => {
            bookMap[alias.toLowerCase()] = book
        })
    }
    bookMap[book.name.toLowerCase()] = book
})

export function getBookMeta(book: string): BookMeta | undefined {
    if (!book) return undefined
    return bookMap[book.toLowerCase()]
}

export function formatScriptureReference(reference: AutoScriptureReference): string {
    const base = `${reference.bookName} ${reference.chapter}`
    const verses = reference.verses
    if (!verses.length) return base

    const first = verses[0]
    const last = reference.endVerse || verses[verses.length - 1]
    if (verses.length === 1 && (!reference.endVerse || first === reference.endVerse)) {
        return `${base}:${first}`
    }
    return `${base}:${first}-${last}`
}
