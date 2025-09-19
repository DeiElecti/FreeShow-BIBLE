<script lang="ts">
    import { get } from "svelte/store"
    import {
        BIBLE_BOOK_META,
        DEFAULT_SERMON_LISTENER_SETTINGS,
        getBookMeta,
        type SermonListenerSettings
    } from "../../../../shared/autoScripture"
    import { Main } from "../../../../types/IPC/Main"
    import Icon from "../../helpers/Icon.svelte"
    import T from "../../helpers/T.svelte"
    import MaterialButton from "../../inputs/MaterialButton.svelte"
    import MaterialDropdown from "../../inputs/MaterialDropdown.svelte"
    import MaterialNumberInput from "../../inputs/MaterialNumberInput.svelte"
    import MaterialToggleSwitch from "../../inputs/MaterialToggleSwitch.svelte"
    import MaterialTextarea from "../../inputs/MaterialTextarea.svelte"
    import {
        autoScriptureStatus,
        autoScriptureSuggestions,
        autoScriptureTranscripts,
        dictionary,
        scriptures,
        special,
    } from "../../../stores"
    import {
        acceptAutoScripture,
        dismissAutoScripture,
        ingestManualReference,
        ingestManualTranscript,
        resetAutoScriptureHistory,
    } from "../../../utils/autoScripture"
    import { newToast } from "../../../utils/common"
    import { translateText } from "../../../utils/language"
    import { sendMain } from "../../../IPC/main"

    let manualTranscript = ""
    let manualMode: "transcript" | "reference" = "transcript"
    const manualBookOptions = BIBLE_BOOK_META.map((book) => ({ value: book.osis, label: book.name }))
    let manualBook = manualBookOptions[0]?.value || ""
    let manualChapter = 1
    let manualVerseStart = 1
    let manualVerseEnd = 1

    $: status = $autoScriptureStatus
    $: suggestions = $autoScriptureSuggestions
    $: transcripts = $autoScriptureTranscripts
    $: listenerSettings = {
        ...DEFAULT_SERMON_LISTENER_SETTINGS,
        ...($special?.sermonListener || {}),
    }
    $: endpoint =
        status?.httpEndpoint ||
        (listenerSettings.enabled ? `http://127.0.0.1:${listenerSettings.port}/transcript` : "")
    $: referenceEndpoint = endpoint
        ? endpoint.replace(/\/?transcript$/, "/reference")
        : listenerSettings.enabled
        ? `http://127.0.0.1:${listenerSettings.port}/reference`
        : ""
    $: scriptureOptions = buildScriptureOptions($scriptures, $dictionary)
    $: scriptureTargetLabel = listenerSettings.scriptureId
        ? getScriptureName(listenerSettings.scriptureId)
        : ""

    function updateSetting<K extends keyof SermonListenerSettings>(key: K, value: SermonListenerSettings[K]) {
        special.update((data) => {
            const current = { ...DEFAULT_SERMON_LISTENER_SETTINGS, ...(data.sermonListener || {}) }
            current[key] = value
            return { ...data, sermonListener: current }
        })

        autoScriptureStatus.update((current) => {
            if (key in current) {
                return { ...current, [key]: value }
            }
            return current
        })

        const updatedSpecial = get(special)
        sendMain(Main.SET_STORE_VALUE, { file: "SETTINGS", key: "special", value: updatedSpecial })
        sendMain(Main.AUTO_SCRIPTURE, { action: "REQUEST_STATUS" })
    }

    $: if (manualVerseEnd < manualVerseStart) manualVerseEnd = manualVerseStart

    function sendManualTranscript() {
        if (!manualTranscript.trim()) return
        ingestManualTranscript(manualTranscript)
        manualTranscript = ""
    }

    function sendManualReference() {
        const bookMeta = getBookMeta(manualBook)
        if (!bookMeta) {
            newToast("scripture.auto_listener_manual_reference_invalid")
            return
        }

        if (!manualChapter || !manualVerseStart) {
            newToast("scripture.auto_listener_manual_reference_invalid")
            return
        }

        ingestManualReference({
            bookOsis: bookMeta.osis,
            chapter: manualChapter,
            verseStart: manualVerseStart,
            verseEnd: manualVerseEnd,
        })
    }

    async function copyValue(value: string) {
        if (!value) return
        try {
            await navigator.clipboard.writeText(value)
            newToast("scripture.auto_listener_copied")
        } catch (err) {
            console.warn("Failed to copy auto scripture endpoint", err)
            newToast("scripture.auto_listener_copy_failed")
        }
    }

    function handleManualKeydown(event: KeyboardEvent) {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault()
            sendManualTranscript()
        }
    }

    function getStatusLabel() {
        if (!status.enabled) return "scripture.auto_listener_disabled"
        if (status.listening) return "scripture.auto_listener_listening"
        return "scripture.auto_listener_starting"
    }

    function formatTimestamp(timestamp?: number) {
        if (!timestamp) return "—"
        try {
            return new Date(timestamp).toLocaleTimeString()
        } catch (err) {
            return "—"
        }
    }

    function formatConfidence(confidence?: number) {
        if (confidence === undefined || Number.isNaN(confidence)) return "—"
        const value = Math.round(confidence * 100)
        return `${Math.max(0, Math.min(100, value))}%`
    }

    function formatSource(source?: string) {
        if (!source) return ""
        const normalized = source.toLowerCase()
        if (normalized === "http") return "HTTP"
        return source
            .replace(/[_-]+/g, " ")
            .split(" ")
            .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ""))
            .join(" ")
    }

    function buildScriptureOptions(scripturesMap: Record<string, any>, dict: any) {
        const seen = new Set<string>()
        const options: { label: string; value: string; favorite?: boolean }[] = []

        Object.entries(scripturesMap || {}).forEach(([key, entry]) => {
            if (!entry) return
            const value = entry.id || key
            if (!value || seen.has(value)) return
            const label = entry.customName || entry.name || value
            seen.add(value)
            options.push({ value, label, favorite: entry.favorite })
        })

        options.sort((a, b) => {
            if (!!a.favorite === !!b.favorite) return a.label.localeCompare(b.label)
            return a.favorite ? -1 : 1
        })

        const defaultLabel = translateText("scripture.auto_listener_follow_active", dict)
        return [
            { value: "", label: defaultLabel || "" },
            ...options.map(({ value, label }) => ({ value, label })),
        ]
    }

    function getScriptureName(id: string) {
        if (!id) return ""
        const scripturesMap = $scriptures || {}
        const direct = scripturesMap[id]
        if (direct) return direct.customName || direct.name || direct.id || id
        const fallback = Object.values(scripturesMap).find((entry: any) => entry?.id === id) as any
        if (fallback) return fallback.customName || fallback.name || fallback.id || id
        const option = scriptureOptions.find((item) => item.value === id)
        return option?.label || id
    }

</script>

<div class="auto-scripture">
    <div class="header">
        <div class="title">
            <Icon id="scripture" size={1} />
            <h3><T id="scripture.auto_listener" /></h3>
        </div>
        <MaterialToggleSwitch
            label=""
            checked={status.enabled}
            on:change={(e) => updateSetting("enabled", e.detail)}
        />
    </div>
    <p class="status">
        <T id={getStatusLabel()} replace={[listenerSettings.port.toString()]} />
    </p>
    {#if endpoint}
        <div class="endpoints">
            <div class="endpoint" class:inactive={!status.listening}>
                <div class="endpoint-info">
                    <span class="endpoint-label"><T id="scripture.auto_listener_endpoint_transcript" /></span>
                    <code>{endpoint}</code>
                </div>
                <MaterialButton
                    icon="content_copy"
                    variant="text"
                    title="scripture.auto_listener_copy"
                    on:click={() => copyValue(endpoint)}
                    small
                />
            </div>
            {#if referenceEndpoint}
                <div class="endpoint" class:inactive={!status.listening}>
                    <div class="endpoint-info">
                        <span class="endpoint-label"><T id="scripture.auto_listener_endpoint_reference" /></span>
                        <code>{referenceEndpoint}</code>
                    </div>
                    <MaterialButton
                        icon="content_copy"
                        variant="text"
                        title="scripture.auto_listener_copy"
                        on:click={() => copyValue(referenceEndpoint)}
                        small
                    />
                </div>
            {/if}
        </div>
        <p class="endpoint-help">
            <T id="scripture.auto_listener_endpoint_help" />
        </p>
        {#if referenceEndpoint}
            <p class="endpoint-help">
                <T id="scripture.auto_listener_reference_help" replace={[referenceEndpoint]} />
            </p>
        {/if}
    {/if}
    <div class="metrics">
        <p>
            <strong><T id="scripture.auto_listener_recognized" /></strong>
            <span>{status.recognizedReferences}</span>
        </p>
        <p>
            <strong><T id="scripture.auto_listener_target" /></strong>
            {#if listenerSettings.scriptureId}
                <span>{scriptureTargetLabel || listenerSettings.scriptureId}</span>
            {:else}
                <span><T id="scripture.auto_listener_follow_active" /></span>
            {/if}
        </p>
        <p>
            <strong><T id="scripture.auto_listener_last_transcript" /></strong>
            <span>{formatTimestamp(status.lastTranscriptAt)}</span>
        </p>
        <p>
            <strong><T id="scripture.auto_listener_last_reference" /></strong>
            <span>{formatTimestamp(status.lastSuggestionAt)}</span>
        </p>
    </div>

    <div class="settings">
        <MaterialNumberInput
            label="scripture.auto_listener_port"
            value={listenerSettings.port}
            min={1000}
            max={65535}
            on:change={(e) => updateSetting("port", Number(e.detail))}
        />
        <MaterialNumberInput
            label="scripture.auto_listener_confidence"
            value={listenerSettings.minConfidence}
            step={0.05}
            min={0}
            max={1}
            on:change={(e) => updateSetting("minConfidence", Number(e.detail))}
        />
        <MaterialNumberInput
            label="scripture.auto_listener_cooldown"
            value={listenerSettings.duplicateInterval}
            min={5}
            max={600}
            on:change={(e) => updateSetting("duplicateInterval", Number(e.detail))}
        />
        <MaterialNumberInput
            label="scripture.auto_listener_max_verses"
            value={listenerSettings.maxVerses}
            min={1}
            max={25}
            on:change={(e) => updateSetting("maxVerses", Number(e.detail))}
        />
        <MaterialDropdown
            label="scripture.auto_listener_scripture"
            options={scriptureOptions}
            value={listenerSettings.scriptureId}
            on:change={(e) => updateSetting("scriptureId", e.detail)}
        />
        <MaterialToggleSwitch
            label="scripture.auto_listener_auto_display"
            checked={listenerSettings.autoDisplay}
            on:change={(e) => updateSetting("autoDisplay", e.detail)}
        />
    </div>

    <div class="suggestions">
        <div class="suggestions-header">
            <h4><T id="scripture.auto_listener_queue" /></h4>
            <MaterialButton icon="refresh" variant="text" on:click={resetAutoScriptureHistory} small>
                <T id="scripture.auto_listener_reset" />
            </MaterialButton>
        </div>
        {#if suggestions.length}
            <ul>
                {#each suggestions as suggestion (suggestion.id)}
                    <li>
                        <div class="suggestion-text">
                            <strong>{suggestion.formatted}</strong>
                            {#if suggestion.transcript}
                                <p>{suggestion.transcript}</p>
                            {:else}
                                <p class="placeholder"><T id="scripture.auto_listener_no_transcript" /></p>
                            {/if}
                            <div class="metadata">
                                <span>
                                    <T id="scripture.auto_listener_time" />: {formatTimestamp(suggestion.timestamp)}
                                </span>
                                {#if suggestion.source}
                                    <span>
                                        <T id="scripture.auto_listener_source" />: {formatSource(suggestion.source)}
                                    </span>
                                {/if}
                                {#if suggestion.confidence !== undefined}
                                    <span>
                                        <T id="scripture.auto_listener_detected_confidence" />:
                                        {formatConfidence(suggestion.confidence)}
                                    </span>
                                {/if}
                            </div>
                        </div>
                        <div class="actions">
                            <MaterialButton icon="check" on:click={() => acceptAutoScripture(suggestion.id)} />
                            <MaterialButton
                                icon="close"
                                variant="text"
                                on:click={() => dismissAutoScripture(suggestion.id)}
                            />
                        </div>
                    </li>
                {/each}
            </ul>
        {:else}
            <p class="empty"><T id="scripture.auto_listener_empty" /></p>
        {/if}
    </div>

    <div class="manual">
        <h4><T id="scripture.auto_listener_manual" /></h4>
        <div class="manual-mode">
            <MaterialButton
                variant="text"
                class:active={manualMode === "transcript"}
                on:click={() => (manualMode = "transcript")}
                small
            >
                <T id="scripture.auto_listener_manual_transcript" />
            </MaterialButton>
            <MaterialButton
                variant="text"
                class:active={manualMode === "reference"}
                on:click={() => (manualMode = "reference")}
                small
            >
                <T id="scripture.auto_listener_manual_reference" />
            </MaterialButton>
        </div>

        {#if manualMode === "transcript"}
            <MaterialTextarea
                value={manualTranscript}
                rows={3}
                placeholder={"John 3:16"}
                on:change={(e) => (manualTranscript = e.detail)}
                on:keydown={handleManualKeydown}
            />
            <div class="manual-actions">
                <MaterialButton icon="send" on:click={sendManualTranscript}>
                    <T id="scripture.auto_listener_submit" />
                </MaterialButton>
            </div>
            <p class="manual-hint"><T id="scripture.auto_listener_manual_hint" /></p>
        {:else}
            <div class="manual-reference-fields">
                <MaterialDropdown
                    label="scripture.auto_listener_manual_reference_book"
                    options={manualBookOptions}
                    value={manualBook}
                    on:change={(e) => (manualBook = e.detail)}
                />
                <div class="reference-row">
                    <MaterialNumberInput
                        label="scripture.auto_listener_manual_reference_chapter"
                        value={manualChapter}
                        min={1}
                        on:change={(e) => (manualChapter = Math.max(1, Number(e.detail) || 1))}
                    />
                    <MaterialNumberInput
                        label="scripture.auto_listener_manual_reference_start"
                        value={manualVerseStart}
                        min={1}
                        on:change={(e) => (manualVerseStart = Math.max(1, Number(e.detail) || 1))}
                    />
                    <MaterialNumberInput
                        label="scripture.auto_listener_manual_reference_end"
                        value={manualVerseEnd}
                        min={1}
                        on:change={(e) => (manualVerseEnd = Math.max(manualVerseStart, Number(e.detail) || manualVerseStart))}
                    />
                </div>
            </div>
            <div class="manual-actions">
                <MaterialButton icon="send" on:click={sendManualReference}>
                    <T id="scripture.auto_listener_submit_reference" />
                </MaterialButton>
            </div>
            <p class="manual-hint"><T id="scripture.auto_listener_manual_reference_hint" /></p>
        {/if}
    </div>

    {#if transcripts.length}
        <div class="transcripts">
            <h4><T id="scripture.auto_listener_recent" /></h4>
            <ul>
                {#each transcripts.slice(0, 5) as transcript, index (index)}
                    <li>
                        <div class="meta">
                            <span class="time">{formatTimestamp(transcript.timestamp)}</span>
                            {#if transcript.source}
                                <span class="source">{formatSource(transcript.source)}</span>
                            {/if}
                            {#if transcript.confidence !== undefined}
                                <span class="confidence">{formatConfidence(transcript.confidence)}</span>
                            {/if}
                        </div>
                        <span class="text">{transcript.text}</span>
                    </li>
                {/each}
            </ul>
        </div>
    {/if}
</div>

<style>
    .auto-scripture {
        background: rgba(0, 0, 0, 0.15);
        border-radius: 8px;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-bottom: 12px;
    }

    .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }

    .title {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    h3 {
        margin: 0;
        font-size: 1em;
    }

    .status {
        margin: 0;
        font-size: 0.9em;
        opacity: 0.9;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .endpoints {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .endpoint {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 0.85em;
    }

    .endpoint-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .endpoint-label {
        font-size: 0.75em;
        opacity: 0.7;
    }

    .endpoint code {
        background: rgba(0, 0, 0, 0.25);
        padding: 4px 6px;
        border-radius: 4px;
        font-family: monospace;
    }

    .endpoint.inactive code {
        opacity: 0.6;
    }

    .endpoint-help {
        margin: 0;
        font-size: 0.75em;
        opacity: 0.7;
    }

    .metrics {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 10px;
    }

    .metrics p {
        margin: 0;
        background: rgba(0, 0, 0, 0.2);
        padding: 8px;
        border-radius: 6px;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .settings {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 10px;
    }

    .suggestions {
        border-top: 1px solid rgba(255, 255, 255, 0.05);
        padding-top: 10px;
    }

    .suggestions-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
    }

    .suggestions ul {
        list-style: none;
        margin: 8px 0 0 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .suggestions li {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        background: rgba(0, 0, 0, 0.25);
        border-radius: 6px;
        padding: 10px;
    }

    .suggestion-text {
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-width: 75%;
    }

    .suggestion-text p {
        margin: 0;
        opacity: 0.8;
        font-size: 0.85em;
    }

    .suggestion-text .placeholder {
        opacity: 0.6;
        font-style: italic;
    }

    .metadata {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        font-size: 0.75em;
        opacity: 0.75;
    }

    .metadata span {
        display: inline-flex;
        align-items: center;
        gap: 4px;
    }

    .actions {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .empty {
        opacity: 0.7;
        margin: 6px 0 0 0;
    }

    .manual {
        border-top: 1px solid rgba(255, 255, 255, 0.05);
        padding-top: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .manual-mode {
        display: flex;
        gap: 6px;
    }

    .manual-mode :global(button.active) {
        background: rgba(255, 255, 255, 0.18);
    }

    .manual-mode :global(.material-button.active) {
        background: rgba(255, 255, 255, 0.18);
    }

    .manual-reference-fields {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .reference-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
        gap: 8px;
    }

    .manual-actions {
        display: flex;
        justify-content: flex-end;
    }

    .manual-hint {
        margin: 0;
        font-size: 0.75em;
        opacity: 0.7;
        text-align: right;
    }

    .transcripts {
        border-top: 1px solid rgba(255, 255, 255, 0.05);
        padding-top: 10px;
    }

    .transcripts ul {
        list-style: none;
        margin: 6px 0 0 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .transcripts li {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 0.85em;
        opacity: 0.85;
    }

    .transcripts .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        font-size: 0.75em;
        opacity: 0.7;
    }

    .transcripts .meta .time {
        font-family: monospace;
    }

    .transcripts .text {
        flex: 1;
    }
</style>
