export function formatAutoDisplayCountdown(
    scheduledAt: number | null | undefined,
    autoEnabled: boolean
): string {
    if (!autoEnabled || !scheduledAt) return ""

    const remaining = scheduledAt - Date.now()

    if (remaining <= 0) return "Now"
    if (remaining < 1000) return "<1s"

    const seconds = remaining / 1000
    if (seconds < 10) return `${seconds.toFixed(1)}s`

    return `${Math.ceil(seconds)}s`
}

export function hasActiveAutoDisplayCountdown(
    scheduledAt: number | null | undefined,
    autoEnabled: boolean
): boolean {
    if (!autoEnabled || !scheduledAt) return false
    return scheduledAt - Date.now() > 0
}
