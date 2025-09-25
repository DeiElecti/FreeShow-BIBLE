<script lang="ts">
    import { createEventDispatcher } from "svelte"
    import type { AutoDetectedScripture } from "../../../../types/Scripture"
    import {
        scriptureAutoHistory,
        scriptureAutoQueue,
        scriptureAutoSettings,
        scriptureAutoState,
        scriptureAutoStats,
        scriptureAutoTranscript
    } from "../../../stores"
    import {
        clearProcessedReferences,
        clearSuggestionQueue,
        dismissSuggestion,
        moveSuggestion,
        moveSuggestionToTop
    } from "../../../utils/scripture/autoDetector"
    import {
        processAutoScriptureManualInput,
        toggleAutoScriptureListening,
        exportAutoScriptureSession,
        resetAutoScriptureSession
    } from "../../../utils/scripture/autoService"
    import {
        SCRIPTURE_AUTO_LANGUAGE_OPTIONS,
        getScriptureAutoLanguageLabel
    } from "../../../utils/scripture/languageOptions"

    export let bibleId: string
    export let bibleName: string = ""
    export let open: boolean = true

    const dispatch = createEventDispatcher<{
        apply: { suggestion: AutoDetectedScripture; auto: boolean }
        close: void
    }>()

    const navItems = [
        { id: "dashboard", label: "Dashboard" },
        { id: "queue", label: "Queue" },
        { id: "history", label: "Recently detected" },
        { id: "transcript", label: "Transcript" },
        { id: "settings", label: "Settings" }
    ]

    const previewThemes = [
        {
            id: "classic",
            label: "Classic warm",
            background: "linear-gradient(135deg, #1c2133 0%, #34395a 100%)",
            textColor: "#f7f8ff",
            accent: "#ffd866"
        },
        {
            id: "dusk",
            label: "Evening dusk",
            background: "linear-gradient(135deg, #121c2b 0%, #3e3a66 100%)",
            textColor: "#f4f5fb",
            accent: "#7bdcff"
        },
        {
            id: "daybreak",
            label: "Daybreak",
            background: "linear-gradient(135deg, #fefefe 0%, #e7eaee 100%)",
            textColor: "#232b3d",
            accent: "#f97362"
        }
    ]

    const recognizerModes = [
        { value: "browser", label: "Browser microphone" },
        { value: "remote", label: "Remote recognizer" }
    ] as const

    let activeNav = navItems[0].id
    let manualInput = ""
    let language = "en-US"
    let languageOverrides: Record<string, string> = {}
    let activeLanguageOverride: string | undefined
    let hasLanguageOverride = false
    let overrideLabel = ""
    let overrideMatchesCurrent = false
    let currentLanguageLabel = ""
    let autoDisplay = false
    let queue: AutoDetectedScripture[] = []
    let history: AutoDetectedScripture[] = []
    let transcript: { id: string; text: string; timestamp: number; source: string }[] = []
    let stats = $scriptureAutoStats
    let dedupeControl = 15
    let confidenceThreshold = 55
    let autoDelay = 0
    let autoDelayLabel = "Instant"
    let statusMessage = ""
    let partialTranscript = ""
    let listening = false
    let supported = true
    let previewThemeId = previewThemes[0].id
    let previewTheme = previewThemes[0]
    let recognizerMode: "browser" | "remote" = "browser"
    let remoteUrlInput = ""
    let remoteStatusMessage = ""
    let remoteConnected = false
    let startButtonLabel = "Start listening"
    let isRemoteMode = false
    let dashboardSection: HTMLElement
    let queueSection: HTMLElement
    let historySection: HTMLElement
    let transcriptSection: HTMLElement
    let settingsSection: HTMLElement

    $: language = $scriptureAutoSettings.language
    $: languageOverrides = ($scriptureAutoSettings.languageOverrides || {}) as Record<string, string>
    $: activeLanguageOverride = bibleId ? languageOverrides[bibleId] : undefined
    $: hasLanguageOverride = Boolean(activeLanguageOverride)
    $: overrideMatchesCurrent = Boolean(activeLanguageOverride && activeLanguageOverride === language)
    $: overrideLabel = getScriptureAutoLanguageLabel(activeLanguageOverride)
    $: currentLanguageLabel = getScriptureAutoLanguageLabel(language)
    $: autoDisplay = $scriptureAutoSettings.autoDisplay
    $: previewThemeId = $scriptureAutoSettings.themeId || previewThemes[0].id
    $: previewTheme = previewThemes.find((theme) => theme.id === previewThemeId) || previewThemes[0]
    $: queue = $scriptureAutoQueue as AutoDetectedScripture[]
    $: history = $scriptureAutoHistory as AutoDetectedScripture[]
    $: stats = $scriptureAutoStats
    $: transcript = $scriptureAutoTranscript
    $: statusMessage = ($scriptureAutoState.status || "").trim()
    $: partialTranscript = $scriptureAutoState.partialTranscript || ""
    $: listening = $scriptureAutoState.listening
    $: supported = $scriptureAutoState.supported
    $: recognizerMode = ($scriptureAutoSettings.recognizerMode as "browser" | "remote") || "browser"
    $: remoteUrlInput = $scriptureAutoSettings.remoteServiceUrl || ""
    $: remoteConnected = Boolean($scriptureAutoState.remoteConnected)
    $: remoteStatusMessage = $scriptureAutoState.remoteStatus || ""
    $: isRemoteMode = recognizerMode === "remote"
    $: {
        const statusLower = remoteStatusMessage.toLowerCase()
        const remoteBusy = statusLower.startsWith("connecting") || statusLower.startsWith("reconnecting")
        const remoteErrored = statusLower.startsWith("error")
        startButtonLabel = isRemoteMode
            ? remoteConnected
                ? "Disconnect"
                : remoteBusy
                    ? "Cancel"
                    : remoteErrored
                        ? "Retry"
                        : "Connect"
            : listening
                ? "Stop listening"
                : "Start listening"
    }

    $: {
        const storeSeconds = Math.round(($scriptureAutoSettings.dedupeWindowMs ?? 15000) / 1000)
        if (storeSeconds !== dedupeControl) dedupeControl = storeSeconds
    }
    $: confidenceThreshold = Math.round(($scriptureAutoSettings.minimumConfidence ?? 0.55) * 100)
    $: autoDelay = $scriptureAutoSettings.autoDisplayDelayMs ?? 0
    $: autoDelayLabel = formatDelay(autoDelay)

    $: currentReference =
        $scriptureAutoState.currentReference || $scriptureAutoState.lastReference || "Waiting for a reference…"
    $: currentText =
        $scriptureAutoState.currentText ||
        $scriptureAutoState.lastText ||
        "When a scripture is detected it will appear here."
    $: currentTranslation =
        $scriptureAutoState.currentTranslation || bibleName || $scriptureAutoState.activeBibleName || ""
    $: previewConfidence =
        $scriptureAutoState.currentConfidence ?? $scriptureAutoState.lastConfidence ?? null
    $: previewConfidenceLabel = formatConfidence(previewConfidence)
    $: recentHistory = history.slice(0, 5)
    $: transcriptView = [...transcript].slice(-40).reverse()

    $: detectionAverage = stats.confidenceSamples ? Math.round(stats.averageConfidence * 100) : null
    $: sessionDurationLabel = formatDuration(stats.startedAt, stats.lastUpdated || Date.now())
    $: totalDetections = stats.detected
    $: manualDetections = stats.manualDetections
    $: speechDetections = stats.speechDetections
    $: autoDisplayed = stats.autoDisplayed
    $: manualSubmissions = stats.manualSubmissions
    $: dismissedCount = stats.dismissed
    $: displayedCount = stats.displayed

    function handleToggleClick() {
        toggleAutoScriptureListening()
    }

    function handleExportSession() {
        exportAutoScriptureSession()
    }

    function handleResetSession() {
        if (typeof window !== "undefined") {
            const confirmed = window.confirm(
                "Reset the detection session? This clears the queue, history, transcript, and stats."
            )
            if (!confirmed) return
        }

        resetAutoScriptureSession()
    }

    function submitManual() {
        if (!manualInput.trim()) return
        processAutoScriptureManualInput(manualInput, bibleId)
        manualInput = ""
    }

    function applySuggestion(suggestion: AutoDetectedScripture, auto = false) {
        dispatch("apply", { suggestion, auto })
    }

    function removeSuggestion(id: string) {
        dismissSuggestion(id)
    }

    function moveSuggestionUp(id: string) {
        moveSuggestion(id, "up")
    }

    function moveSuggestionDown(id: string) {
        moveSuggestion(id, "down")
    }

    function setSuggestionAsNext(id: string) {
        moveSuggestionToTop(id)
    }

    function requeueHistory(item: AutoDetectedScripture) {
        processAutoScriptureManualInput(item.raw, item.bibleId)
    }

    function changeLanguage(event: Event) {
        const value = (event.target as HTMLSelectElement).value
        scriptureAutoSettings.update((settings) => ({ ...settings, language: value }))
        clearProcessedReferences()
    }

    function rememberLanguageForBible() {
        if (!bibleId || !language) return

        const label = getScriptureAutoLanguageLabel(language)
        scriptureAutoSettings.update((settings) => {
            const overrides = { ...(settings.languageOverrides || {}) }
            if (overrides[bibleId] === language) return settings
            overrides[bibleId] = language
            return { ...settings, languageOverrides: overrides }
        })

        scriptureAutoState.update((state) => ({
            ...state,
            status: label
                ? `Saved ${label} for ${bibleName || "this translation"}.`
                : `Saved recognition language for ${bibleName || "this translation"}.`
        }))
    }

    function clearLanguageOverride() {
        if (!bibleId) return

        let removed = false
        scriptureAutoSettings.update((settings) => {
            const overrides = { ...(settings.languageOverrides || {}) }
            if (!overrides[bibleId]) return settings
            delete overrides[bibleId]
            removed = true
            return { ...settings, languageOverrides: overrides }
        })

        if (!removed) return

        scriptureAutoState.update((state) => ({
            ...state,
            status: `Cleared saved language for ${bibleName || "this translation"}.`
        }))
    }

    function changeTheme(event: Event) {
        const value = (event.target as HTMLSelectElement).value
        scriptureAutoSettings.update((settings) => ({ ...settings, themeId: value }))
    }

    function toggleAutoDisplay() {
        scriptureAutoSettings.update((settings) => ({ ...settings, autoDisplay: !settings.autoDisplay }))
    }

    function toggleAutoStartListening() {
        scriptureAutoSettings.update((settings) => ({
            ...settings,
            autoStartListening: !settings.autoStartListening
        }))
    }

    function handleDedupeChange(event: Event) {
        const value = Number((event.target as HTMLInputElement).value)
        if (!Number.isFinite(value)) return
        dedupeControl = value
        scriptureAutoSettings.update((settings) => ({ ...settings, dedupeWindowMs: Math.max(3, value) * 1000 }))
    }

    function handleConfidenceChange(event: Event) {
        const value = Number((event.target as HTMLInputElement).value)
        if (!Number.isFinite(value)) return
        confidenceThreshold = value
        scriptureAutoSettings.update((settings) => ({
            ...settings,
            minimumConfidence: Math.min(Math.max(value / 100, 0), 0.99)
        }))
    }

    function handleAutoDelayChange(event: Event) {
        const value = Number((event.target as HTMLInputElement).value)
        if (!Number.isFinite(value)) return
        autoDelay = value
        scriptureAutoSettings.update((settings) => ({
            ...settings,
            autoDisplayDelayMs: Math.min(Math.max(value, 0), 15000)
        }))
    }

    function handleClearQueue() {
        if (!queue.length) return
        clearSuggestionQueue()
        scriptureAutoState.update((state) => ({ ...state, status: "Suggestion queue cleared." }))
    }

    function formatSourceLabel(source: string) {
        if (!source) return ""
        if (source === "speech") return "Speech"
        if (source === "manual") return "Manual"
        if (source === "remote") return "Remote"
        return source.charAt(0).toUpperCase() + source.slice(1)
    }

    function handleRecognizerModeChange(event: Event) {
        const value = (event.target as HTMLSelectElement).value as "browser" | "remote"
        scriptureAutoSettings.update((settings) => ({ ...settings, recognizerMode: value }))
    }

    function handleRemoteUrlInput(event: Event) {
        remoteUrlInput = (event.target as HTMLInputElement).value
        scriptureAutoSettings.update((settings) => ({ ...settings, remoteServiceUrl: remoteUrlInput }))
    }

    function scrollToSection(id: string) {
        activeNav = id
        const targets: Record<string, HTMLElement | undefined> = {
            dashboard: dashboardSection,
            queue: queueSection,
            history: historySection,
            transcript: transcriptSection,
            settings: settingsSection
        }
        const element = targets[id]
        if (element) element.scrollIntoView({ behavior: "smooth", block: "start" })
    }

    function formatConfidence(value: number | null | undefined) {
        if (typeof value !== "number" || Number.isNaN(value)) return "—"
        return `${Math.round(value * 100)}%`
    }

    function formatTimestamp(value: number | null | undefined) {
        if (!value) return ""
        return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    }

    function formatRelative(value: number | null | undefined) {
        if (!value) return ""
        const diff = Date.now() - value
        if (diff < 60_000) return "moments ago"
        if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
        if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
        return new Date(value).toLocaleDateString()
    }

    function formatDuration(start: number | null | undefined, end: number | null | undefined) {
        if (!start || !end || end < start) return "—"
        const totalSeconds = Math.max(0, Math.floor((end - start) / 1000))
        const hours = Math.floor(totalSeconds / 3600)
        const minutes = Math.floor((totalSeconds % 3600) / 60)
        const seconds = totalSeconds % 60
        if (hours) return `${hours}h ${minutes}m`
        if (minutes) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`
        return `${seconds}s`
    }

    function formatDelay(value: number) {
        if (!value) return "Instant"
        const seconds = value / 1000
        const precision = seconds % 1 === 0 ? 0 : 2
        return `${seconds.toFixed(precision)} s`
    }

    function closePanel() {
        dispatch("close")
    }
</script>

<div class="auto-panel" class:hidden={!open}>
    <header class="auto-header">
        <div>
            <h3>Live Scripture Detection</h3>
            {#if bibleName}
                <p class="subtitle">Active translation: {bibleName}</p>
            {/if}
        </div>
        <button class="icon" on:click={closePanel} aria-label="Close scripture detection panel">×</button>
    </header>

    <div class="layout">
        <nav class="side-nav">
            {#each navItems as item}
                <button class:active={activeNav === item.id} on:click={() => scrollToSection(item.id)}>
                    {item.label}
                </button>
            {/each}
        </nav>

        <div class="content">
            <section class="section dashboard" bind:this={dashboardSection} id="dashboard">
                <div class="card preview-card">
                    <div class="card-header">
                        <h4>Live preview</h4>
                        <label class="preview-select">
                            <span>Theme</span>
                            <select value={previewThemeId} on:change={changeTheme}>
                                {#each previewThemes as theme}
                                    <option value={theme.id}>{theme.label}</option>
                                {/each}
                            </select>
                        </label>
                    </div>
                    <div
                        class="preview-surface"
                        style={`--preview-bg: ${previewTheme.background}; --preview-text: ${previewTheme.textColor}; --preview-accent: ${previewTheme.accent};`}
                    >
                        <div class="preview-inner">
                            <span class="preview-reference">{currentReference}</span>
                            <p>{currentText}</p>
                        </div>
                    </div>
                    <footer class="preview-footer">
                        <span>{currentTranslation || "No translation selected"}</span>
                        <span>Confidence: {previewConfidenceLabel}</span>
                        {#if $scriptureAutoState.currentAppliedAt}
                            <span>{formatRelative($scriptureAutoState.currentAppliedAt)}</span>
                        {:else if $scriptureAutoState.lastHeardAt}
                            <span>{formatRelative($scriptureAutoState.lastHeardAt)}</span>
                        {/if}
                    </footer>
                </div>

                <div class="card control-card" bind:this={settingsSection}>
                    <div class="controls-grid">
                        {#if supported || isRemoteMode}
                            <label class="select">
                                <span>Recognizer</span>
                                <select value={recognizerMode} on:change={handleRecognizerModeChange} aria-label="Recognizer mode">
                                    {#each recognizerModes as option}
                                        <option value={option.value}>{option.label}</option>
                                    {/each}
                                </select>
                            </label>
                            <button
                                class:listening={listening || (isRemoteMode && remoteConnected)}
                                on:click={handleToggleClick}
                            >
                                {startButtonLabel}
                            </button>
                            <label class="select">
                                <span>Language</span>
                                <select value={language} on:change={changeLanguage} aria-label="Recognition language">
                                    {#each SCRIPTURE_AUTO_LANGUAGE_OPTIONS as option}
                                        <option value={option.value}>{option.label}</option>
                                    {/each}
                                </select>
                            </label>
                            {#if bibleId}
                                <div class="language-override">
                                    {#if hasLanguageOverride}
                                        <span class="hint">
                                            Saved: {overrideLabel || activeLanguageOverride}
                                            {#if !overrideMatchesCurrent}
                                                · applies when this translation is active
                                            {/if}
                                        </span>
                                        <button class="text" on:click={clearLanguageOverride}>
                                            Clear saved language
                                        </button>
                                    {:else}
                                        <button class="text" on:click={rememberLanguageForBible}>
                                            Remember {currentLanguageLabel || language} for this translation
                                        </button>
                                    {/if}
                                </div>
                            {/if}

                            {#if isRemoteMode}
                                <div class="remote-config">
                                    <label>
                                        <span>Remote service URL</span>
                                        <input
                                            type="text"
                                            value={remoteUrlInput}
                                            on:input={handleRemoteUrlInput}
                                            placeholder="ws://localhost:8765"
                                        />
                                    </label>
                                    {#if remoteStatusMessage}
                                        <p class="status remote-status">{remoteStatusMessage}</p>
                                    {/if}
                                </div>
                            {/if}
                        {:else}
                            <p class="status error">{statusMessage}</p>
                        {/if}

                        <label class="auto-toggle">
                            <input type="checkbox" checked={autoDisplay} on:change={toggleAutoDisplay} />
                            <span>Auto display on detection</span>
                        </label>

                        <label class="auto-toggle">
                            <input
                                type="checkbox"
                                checked={$scriptureAutoSettings.autoStartListening}
                                on:change={toggleAutoStartListening}
                            />
                            <span>Resume listening automatically</span>
                        </label>

                        <div class="slider">
                            <label for="dedupe-window">Duplicate suppression</label>
                            <div class="range">
                                <input
                                    id="dedupe-window"
                                    type="range"
                                    min="3"
                                    max="60"
                                    step="1"
                                    bind:value={dedupeControl}
                                    on:input={handleDedupeChange}
                                />
                                <span>{dedupeControl} second{dedupeControl === 1 ? "" : "s"}</span>
                            </div>
                        </div>

                        <div class="slider">
                            <label for="confidence-threshold">Minimum confidence</label>
                            <div class="range">
                                <input
                                    id="confidence-threshold"
                                    type="range"
                                    min="35"
                                    max="95"
                                    step="1"
                                    bind:value={confidenceThreshold}
                                    on:input={handleConfidenceChange}
                                />
                                <span>{confidenceThreshold}%</span>
                            </div>
                        </div>

                        <div class="slider">
                            <label for="auto-delay">Auto display delay</label>
                            <div class="range">
                                <input
                                    id="auto-delay"
                                    type="range"
                                    min="0"
                                    max="5000"
                                    step="250"
                                    bind:value={autoDelay}
                                    on:input={handleAutoDelayChange}
                                />
                                <span>{autoDelayLabel}</span>
                            </div>
                        </div>
                    </div>

                    <p class="hint subtle">Shift+click the microphone button to toggle listening without reopening this panel.</p>
                    {#if partialTranscript}
                        <p class="partial">…{partialTranscript}</p>
                    {/if}
                    {#if statusMessage && (supported || isRemoteMode)}
                        <p class="status">{statusMessage}</p>
                    {/if}
                    {#if $scriptureAutoState.lastReference}
                        <p class="status highlight">
                            Last detected: {$scriptureAutoState.lastReference}
                            {#if $scriptureAutoState.lastSource}
                                · {formatSourceLabel($scriptureAutoState.lastSource)}
                            {/if}
                            {#if $scriptureAutoState.lastHeardAt}
                                · {formatTimestamp($scriptureAutoState.lastHeardAt)}
                            {/if}
                        </p>
                    {/if}
                </div>

                <div class="card stats-card">
                    <div class="card-header">
                        <h4>Session stats</h4>
                        <span class="hint">Running for {sessionDurationLabel}</span>
                    </div>
                    <div class="stats-grid">
                        <div class="stat">
                            <strong>{totalDetections}</strong>
                            <span>Detections</span>
                        </div>
                        <div class="stat">
                            <strong>{speechDetections}</strong>
                            <span>From speech</span>
                        </div>
                        <div class="stat">
                            <strong>{manualDetections}</strong>
                            <span>Manual matches</span>
                        </div>
                        <div class="stat">
                            <strong>{displayedCount}</strong>
                            <span>Displayed</span>
                        </div>
                        <div class="stat">
                            <strong>{autoDisplayed}</strong>
                            <span>Auto display</span>
                        </div>
                        <div class="stat">
                            <strong>{manualSubmissions}</strong>
                            <span>Manual submissions</span>
                        </div>
                        <div class="stat">
                            <strong>{dismissedCount}</strong>
                            <span>Dismissed</span>
                        </div>
                        <div class="stat">
                            <strong>{detectionAverage !== null ? `${detectionAverage}%` : "—"}</strong>
                            <span>Avg confidence</span>
                        </div>
                    </div>
                </div>

                <div class="card session-card">
                    <div class="card-header">
                        <h4>Session controls</h4>
                        <span class="hint">Archive or reset this detection run.</span>
                    </div>
                    <div class="session-actions">
                        <button class="primary" on:click={handleExportSession}>Export session log</button>
                        <button class="danger" on:click={handleResetSession}>Reset session</button>
                    </div>
                    <p class="hint subtle">
                        Resetting clears the queue, transcript, history, and statistics so you can start fresh.
                    </p>
                </div>

                {#if recentHistory.length}
                    <div class="card recent-card">
                        <div class="card-header">
                            <h4>Recent suggestions</h4>
                            <span class="hint">Tap to requeue if you missed one.</span>
                        </div>
                        <ul>
                            {#each recentHistory as item (item.id)}
                                <li>
                                    <div>
                                        <strong>{item.reference}</strong>
                                        <span class="meta">· {formatConfidence(item.confidence)}</span>
                                    </div>
                                    <div class="meta">
                                        <span>{formatSourceLabel(item.source)}</span>
                                        <span>{formatRelative(item.createdAt)}</span>
                                    </div>
                                    <button class="text" on:click={() => requeueHistory(item)}>Queue again</button>
                                </li>
                            {/each}
                        </ul>
                    </div>
                {/if}
            </section>

            <section class="section queue-section" bind:this={queueSection} id="queue">
                <div class="card manual-card">
                    <h4>Manual reference</h4>
                    <div class="manual">
                        <input
                            type="text"
                            placeholder="Type or paste a verse (e.g. John 3:16)"
                            bind:value={manualInput}
                            on:keydown={(event) => event.key === "Enter" && submitManual()}
                        />
                        <button on:click={submitManual}>Process</button>
                    </div>
                </div>

                <div class="card queue-card">
                    <div class="queue-header">
                        <h4>Detected suggestions</h4>
                        <div class="queue-actions">
                            <span>{queue.length} {queue.length === 1 ? "item" : "items"}</span>
                            <button class="text" on:click={handleClearQueue} disabled={!queue.length}>Clear queue</button>
                        </div>
                    </div>

                    {#if queue.length}
                        {#each queue as item, index (item.id)}
                            <article class="suggestion" class:next={index === 0}>
                                <header>
                                    <div class="reference-row">
                                        <strong>{item.reference}</strong>
                                        {#if index === 0}
                                            <span class="badge next-badge">Next</span>
                                        {/if}
                                    </div>
                                    <span class="meta">{item.translation}</span>
                                    {#if item.source}
                                        <span class="meta">{formatSourceLabel(item.source)}</span>
                                    {/if}
                                    {#if typeof item.confidence === "number"}
                                        <span class="meta confidence">{formatConfidence(item.confidence)}</span>
                                    {/if}
                                    <span class="meta">{formatTimestamp(item.createdAt)}</span>
                                </header>
                                <p class="preview">{item.text}</p>
                                <footer>
                                    <div class="queue-order">
                                        {#if index > 0}
                                            <button class="text" on:click={() => setSuggestionAsNext(item.id)}>
                                                Set as next
                                            </button>
                                            <button
                                                class="text icon-button"
                                                on:click={() => moveSuggestionUp(item.id)}
                                                aria-label="Move up in queue"
                                            >
                                                ↑
                                            </button>
                                        {/if}
                                        {#if index < queue.length - 1}
                                            <button
                                                class="text icon-button"
                                                on:click={() => moveSuggestionDown(item.id)}
                                                aria-label="Move down in queue"
                                            >
                                                ↓
                                            </button>
                                        {/if}
                                    </div>
                                    <div class="suggestion-actions">
                                        <button class="primary" on:click={() => applySuggestion(item, false)}>Display</button>
                                        <button on:click={() => removeSuggestion(item.id)}>Dismiss</button>
                                    </div>
                                </footer>
                            </article>
                        {/each}
                    {:else}
                        <p class="empty">No detected references yet. Speak into the microphone or paste a verse above.</p>
                    {/if}
                </div>
            </section>

            <section class="section history-section" bind:this={historySection} id="history">
                <div class="card history-card">
                    <div class="card-header">
                        <h4>Recently detected</h4>
                        <span class="hint">Full log of suggestions this session.</span>
                    </div>
                    {#if history.length}
                        <ul>
                            {#each history as item (item.id)}
                                <li>
                                    <div class="history-header">
                                        <strong>{item.reference}</strong>
                                        <span class="meta">{item.translation}</span>
                                        <span class="meta">{formatConfidence(item.confidence)}</span>
                                    </div>
                                    <p class="preview">{item.text}</p>
                                    <div class="history-meta">
                                        <span>{formatSourceLabel(item.source)}</span>
                                        <span>{formatTimestamp(item.createdAt)}</span>
                                        <span>{formatRelative(item.createdAt)}</span>
                                    </div>
                                    <div class="history-actions">
                                        <button class="text" on:click={() => applySuggestion(item, false)}>Display</button>
                                        <button class="text" on:click={() => requeueHistory(item)}>Queue again</button>
                                    </div>
                                </li>
                            {/each}
                        </ul>
                    {:else}
                        <p class="empty">No detections recorded yet this session.</p>
                    {/if}
                </div>
            </section>

            <section class="section transcript-section" bind:this={transcriptSection} id="transcript">
                <div class="card transcript-card">
                    <div class="card-header">
                        <h4>Transcript history</h4>
                        <span class="hint">Latest phrases captured from speech and manual input.</span>
                    </div>
                    {#if transcriptView.length}
                        <ul>
                            {#each transcriptView as item (item.id)}
                                <li>
                                    <div class="transcript-meta">
                                        <span class="tag">{formatSourceLabel(item.source)}</span>
                                        <span>{formatTimestamp(item.timestamp)}</span>
                                    </div>
                                    <p>{item.text}</p>
                                </li>
                            {/each}
                        </ul>
                    {:else}
                        <p class="empty">No transcript available yet.</p>
                    {/if}
                </div>
            </section>
        </div>
    </div>
</div>

<style>
    .auto-panel {
        width: min(960px, 100%);
        max-height: min(85vh, 100%);
        padding: 20px;
        background: rgba(12, 16, 28, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 20px;
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
        display: flex;
        flex-direction: column;
        gap: 18px;
        color: #fff;
        backdrop-filter: blur(6px);
    }

    .auto-panel.hidden {
        display: none;
    }

    .auto-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
    }

    .auto-header h3 {
        margin: 0;
        font-size: 1.1rem;
    }

    .subtitle {
        margin: 4px 0 0;
        opacity: 0.6;
        font-size: 0.85rem;
    }

    .icon {
        background: transparent;
        border: none;
        color: inherit;
        font-size: 1.5rem;
        cursor: pointer;
        line-height: 1;
    }

    .layout {
        display: flex;
        gap: 18px;
        min-height: 0;
    }

    .side-nav {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 160px;
        padding-right: 4px;
    }

    .side-nav button {
        border: none;
        background: rgba(255, 255, 255, 0.08);
        color: inherit;
        padding: 10px 14px;
        border-radius: 10px;
        text-align: left;
        cursor: pointer;
        transition: background 0.2s ease, transform 0.2s ease;
        font-size: 0.92rem;
    }

    .side-nav button:hover {
        background: rgba(255, 255, 255, 0.15);
    }

    .side-nav button.active {
        background: var(--secondary, rgba(255, 216, 102, 0.9));
        color: #121212;
        transform: translateX(4px);
    }

    .content {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 24px;
        overflow-y: auto;
        padding-right: 4px;
    }

    .section {
        display: grid;
        gap: 16px;
    }

    .dashboard {
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    }

    .preview-card {
        grid-column: span 2;
    }

    @media (max-width: 980px) {
        .preview-card {
            grid-column: span 1;
        }
    }

    .card {
        background: rgba(18, 22, 38, 0.88);
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.05);
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    .card-header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: baseline;
    }

    .card-header h4 {
        margin: 0;
        font-size: 1rem;
    }

    .preview-select,
    .select {
        display: flex;
        flex-direction: column;
        font-size: 0.8rem;
        gap: 4px;
        align-items: flex-start;
    }

    .preview-select select,
    .select select {
        border: none;
        border-radius: 10px;
        padding: 8px 12px;
        background: rgba(255, 255, 255, 0.1);
        color: inherit;
        cursor: pointer;
    }

    .remote-config {
        grid-column: 1 / -1;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .remote-config label {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 0.8rem;
    }

    .remote-config input {
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 10px;
        padding: 8px 12px;
        background: rgba(255, 255, 255, 0.08);
        color: inherit;
    }

    .remote-config input:focus {
        outline: none;
        border-color: rgba(255, 255, 255, 0.4);
    }

    .remote-status {
        font-size: 0.8rem;
        opacity: 0.75;
    }

    .preview-surface {
        border-radius: 14px;
        padding: 24px;
        min-height: 200px;
        background: var(--preview-bg);
        color: var(--preview-text);
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
    }

    .preview-inner {
        display: flex;
        flex-direction: column;
        gap: 12px;
        max-width: 100%;
    }

    .preview-inner p {
        margin: 0;
        font-size: 1.1rem;
        line-height: 1.4;
        word-break: break-word;
    }

    .preview-reference {
        font-size: 0.9rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--preview-accent);
    }

    .preview-footer {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        font-size: 0.8rem;
        opacity: 0.8;
    }

    .controls-grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        align-items: start;
    }

    button {
        border: none;
        background: rgba(255, 255, 255, 0.12);
        color: inherit;
        padding: 9px 16px;
        border-radius: 999px;
        cursor: pointer;
        transition: background 0.2s ease;
    }

    button:hover {
        background: rgba(255, 255, 255, 0.2);
    }

    button.primary {
        background: var(--secondary, #ffd866);
        color: #0f111a;
    }

    button.primary:hover {
        background: #ffe386;
    }

    button.listening {
        background: rgba(16, 200, 140, 0.85);
        color: #041b12;
    }

    .auto-toggle {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 0.85rem;
    }

    .auto-toggle input {
        accent-color: var(--secondary, #ffd866);
    }

    .slider {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .range {
        display: flex;
        align-items: center;
        gap: 12px;
    }

    .range input {
        flex: 1;
        accent-color: var(--secondary, #ffd866);
    }

    .range span {
        font-size: 0.85rem;
        opacity: 0.75;
        min-width: 64px;
        text-align: right;
    }

    .hint {
        margin: 0;
        font-size: 0.75rem;
        opacity: 0.6;
    }

    .hint.subtle {
        margin-top: -4px;
    }

    .partial {
        margin: 0;
        opacity: 0.7;
        font-style: italic;
    }

    .status {
        margin: 0;
        opacity: 0.7;
        font-size: 0.85rem;
    }

    .status.highlight {
        opacity: 0.85;
        font-weight: 500;
    }

    .status.error {
        color: #ff8a7a;
    }

    .stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 12px;
    }

    .stat {
        background: rgba(255, 255, 255, 0.06);
        border-radius: 12px;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .stat strong {
        font-size: 1.2rem;
        line-height: 1.2;
    }

    .stat span {
        font-size: 0.75rem;
        opacity: 0.7;
    }

    .session-card .session-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
    }

    .session-card .session-actions button {
        flex: 0 0 auto;
    }

    button.danger {
        background: rgba(239, 83, 80, 0.15);
        color: #ffb4ad;
        border: 1px solid rgba(239, 83, 80, 0.35);
    }

    button.danger:hover {
        background: rgba(239, 83, 80, 0.25);
    }

    .recent-card ul,
    .history-card ul,
    .transcript-card ul {
        margin: 0;
        padding: 0;
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    .recent-card li,
    .history-card li,
    .transcript-card li {
        background: rgba(255, 255, 255, 0.05);
        border-radius: 12px;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .recent-card li button {
        align-self: flex-start;
    }

    .manual {
        display: flex;
        gap: 10px;
    }

    .manual input {
        flex: 1;
        padding: 9px 14px;
        border-radius: 999px;
        border: none;
        background: rgba(255, 255, 255, 0.08);
        color: inherit;
    }

    .queue-card {
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    .language-override {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }

    .language-override .hint {
        font-size: 0.8rem;
        opacity: 0.75;
    }

    .queue-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
    }

    .queue-actions {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 0.85rem;
        opacity: 0.75;
    }

    .suggestion {
        padding: 12px;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.05);
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .suggestion.next {
        border: 1px solid rgba(255, 255, 255, 0.18);
        box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.06);
    }

    .suggestion header {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: baseline;
    }

    .reference-row {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .suggestion header strong {
        font-size: 1rem;
    }

    .meta {
        opacity: 0.6;
        font-size: 0.8rem;
    }

    .meta.confidence {
        color: var(--secondary, #ffd866);
    }

    .preview {
        margin: 0;
        font-size: 0.95rem;
        line-height: 1.35;
    }

    .suggestion footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
    }

    .queue-order {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }

    .suggestion-actions {
        display: flex;
        gap: 10px;
        align-items: center;
    }

    .badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 0.7rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        background: rgba(255, 255, 255, 0.12);
    }

    .next-badge {
        background: var(--secondary, #ffd866);
        color: #151515;
    }

    .icon-button {
        padding: 2px 6px;
        border-radius: 6px;
        font-size: 0.85rem;
    }

    .icon-button:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.1);
    }

    button.text {
        background: transparent;
        color: var(--secondary, #ffd866);
        padding: 0;
    }

    button.text:hover:not(:disabled) {
        background: transparent;
        text-decoration: underline;
    }

    button.text:disabled {
        opacity: 0.4;
        cursor: default;
    }

    .history-header {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        align-items: baseline;
    }

    .history-meta {
        display: flex;
        gap: 12px;
        font-size: 0.8rem;
        opacity: 0.6;
        flex-wrap: wrap;
    }

    .history-actions {
        display: flex;
        gap: 16px;
    }

    .transcript-meta {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        font-size: 0.8rem;
        opacity: 0.7;
    }

    .tag {
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.12);
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .empty {
        margin: 0;
        opacity: 0.6;
        font-size: 0.9rem;
    }

    @media (max-width: 860px) {
        .layout {
            flex-direction: column;
        }

        .side-nav {
            flex-direction: row;
            flex-wrap: wrap;
            min-width: unset;
        }

        .side-nav button {
            flex: 1 1 calc(50% - 8px);
            text-align: center;
        }

        .content {
            max-height: 60vh;
        }

        .manual {
            flex-direction: column;
        }

        .manual button {
            width: 100%;
        }
    }
</style>
