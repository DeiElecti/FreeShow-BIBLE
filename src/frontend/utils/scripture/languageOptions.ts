export interface ScriptureAutoLanguageOption {
    value: string
    label: string
}

export const SCRIPTURE_AUTO_LANGUAGE_OPTIONS: ScriptureAutoLanguageOption[] = [
    { value: "en-US", label: "English (US)" },
    { value: "en-GB", label: "English (UK)" },
    { value: "es-ES", label: "Spanish (Spain)" },
    { value: "es-MX", label: "Spanish (Mexico)" },
    { value: "pt-BR", label: "Portuguese (Brazil)" },
    { value: "fr-FR", label: "French (France)" },
    { value: "fr-CA", label: "French (Canada)" },
    { value: "de-DE", label: "German (Germany)" },
    { value: "it-IT", label: "Italian" },
    { value: "nl-NL", label: "Dutch (Netherlands)" },
    { value: "sv-SE", label: "Swedish" },
    { value: "ru-RU", label: "Russian" },
    { value: "pl-PL", label: "Polish" }
]

const LANGUAGE_LABEL_MAP = new Map(
    SCRIPTURE_AUTO_LANGUAGE_OPTIONS.map((option) => [option.value.toLowerCase(), option.label])
)

export function getScriptureAutoLanguageLabel(value: string | null | undefined): string {
    if (!value) return ""
    const label = LANGUAGE_LABEL_MAP.get(value.toLowerCase())
    return label || value
}
