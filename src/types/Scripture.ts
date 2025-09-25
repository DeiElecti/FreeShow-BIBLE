export interface Bible {
    api?: boolean
    version: null | string
    metadata?: { [key: string]: string }
    copyright?: string // displayed in the drawer
    id?: string
    book: null | string
    bookId?: string
    chapter: null | string
    verses: any
    activeVerses: string[]
    attributionRequired?: boolean // API needs attribution
    attributionString?: string // API needs custom attribution
}

export interface Version {
    id: string
    dblId: string
    relatedDbl: null
    name: string
    nameLocal: string
    abbreviation: string
    abbreviationLocal: string
    description: null | string
    descriptionLocal: null | string
    language: {
        id: string
        name: string
        nameLocal: string
        script: string
        scriptDirection: string
    }
    countries: {
        id: string
        name: string
        nameLocal: string
    }[]
    type: "text"
    updatedAt: string // date
    audioBibles: {
        id: string
        name: string
        nameLocal: string
        dblId: string
    }[]
}

export interface Book {
    abbreviation: string // "Gen"
    bibleId: string // "de4e12af7f28f599-01"
    id?: string // "GEN"
    keyName: string // "GEN"
    customName?: string // many XML book names are not correct
    name: string // "Genesis"
    nameLong: string // "The First Book of Moses, called Genesis"
}

export interface Chapter {
    bibleId: string // "de4e12af7f28f599-01"
    bookId: string // "GEN"
    keyName: string // "GEN.intro"
    number: string // "intro"
    reference: string // "Genesis"
}

export interface Verse {
    bibleId: string //"de4e12af7f28f599-01"
    bookId: string // "GEN"
    chapterId: string // "GEN.1"
    keyName: string // "GEN.1.1"
    orgId: string // "GEN.1.1"
    reference: string // "Genesis 1:1"
}

export interface VerseText {
    bibleId: string // "de4e12af7f28f599-01"
    bookId: string // "GEN"
    chapterId: string // "GEN.1"
    content: string | string[][] // "<p class=\"p\"><span data-number=\"1\" data-sid=\"GEN 1:1\" class=\"v\">1</span>In the beginning God created the heaven and the earth. </p>"
    metadata?: { [key: string]: string } // {}
    copyright?: string // "\n          \n            PUBLIC DOMAIN except in the United Kingdom, where a Crown Copyright applies to printing the KJV. See http://www.cambridge.org/about-us/who-we-are/queens-printers-patent\n        "
    id: string // "GEN.1.1"
    next: {
        id: string
        number: string
    } // {id: "GEN.1.2", number: "2"}
    orgId: string // "GEN.1.1"
    previous: {
        id: string
        number: string
    } // {id: "GEN.intro.0", number: "0"}
    reference: string // "Genesis 1:1"
    verseCount: number // 1
}

export interface AutoDetectedScripture {
    id: string
    osis: string
    bibleId: string
    bookNumber: number
    chapter: number
    verseStart: number
    verseEnd: number
    verses: string[]
    reference: string
    text: string
    translation: string
    source: string
    createdAt: number
    raw: string
    confidence?: number
}

export interface ScriptureAutoSettings {
    language: string
    autoDisplay: boolean
    dedupeWindowMs: number
    autoStartListening: boolean
    themeId: string
    minimumConfidence: number
    autoDisplayDelayMs: number
    languageOverrides?: Record<string, string>
    recognizerMode?: "browser" | "remote"
    remoteServiceUrl?: string
}

export interface ScriptureAutoState {
    supported: boolean
    listening: boolean
    status: string
    partialTranscript: string
    lastHeardAt: number | null
    lastReference: string | null
    lastSource: string | null
    lastText: string | null
    lastConfidence: number | null
    activeBibleId: string | null
    activeBibleName: string | null
    activeScriptureId: string | null
    currentReference: string | null
    currentText: string | null
    currentTranslation: string | null
    currentAppliedAt: number | null
    currentSource: string | null
    currentAuto: boolean
    currentConfidence: number | null
    currentDisplayed: boolean
    pinned: boolean
    recognizerMode: "browser" | "remote"
    remoteConnected: boolean
    remoteStatus: string | null
    nextAutoApplyId: string | null
    nextAutoApplyAt: number | null
    nextAutoApplyDelayMs: number | null
}

export interface AutoTranscriptEntry {
    id: string
    timestamp: number
    text: string
    source: string
}

export interface ScriptureAutoStats {
    startedAt: number
    lastUpdated: number | null
    detected: number
    speechDetections: number
    manualDetections: number
    displayed: number
    autoDisplayed: number
    manualSubmissions: number
    dismissed: number
    confidenceSamples: number
    averageConfidence: number
    suppressedDuplicates: number
    suppressedLowConfidence: number
}
