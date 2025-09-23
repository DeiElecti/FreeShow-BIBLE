<script lang="ts">
    import { get } from "svelte/store"
    import {
        BIBLE_BOOK_META,
        DEFAULT_SERMON_LISTENER_SETTINGS,
        DEFAULT_SERMON_TRANSCRIBER_SETTINGS,
        getBookMeta,
        type AutoScriptureEndpoint,
        type AutoScriptureEndpointType,
        type AutoScriptureStatus,
        type SermonListenerSettings,
        type SermonTranscriberSettings
    } from "../../../../shared/autoScripture"
    import { Main } from "../../../../types/IPC/Main"
    import Icon from "../../helpers/Icon.svelte"
    import T from "../../helpers/T.svelte"
    import MaterialButton from "../../inputs/MaterialButton.svelte"
    import MaterialDropdown from "../../inputs/MaterialDropdown.svelte"
    import MaterialNumberInput from "../../inputs/MaterialNumberInput.svelte"
    import MaterialToggleSwitch from "../../inputs/MaterialToggleSwitch.svelte"
    import MaterialTextarea from "../../inputs/MaterialTextarea.svelte"
    import MaterialTextInput from "../../inputs/MaterialTextInput.svelte"
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
    let customEndpointValue = ""

    interface DisplayEndpoint {
        transcript: string
        reference: string
        status: string
        events: string
        type: AutoScriptureEndpointType
    }

    let status: AutoScriptureStatus
    let endpointList: DisplayEndpoint[] = []
    let primaryReferenceEndpoint = ""
    let primaryStatusEndpoint = ""
    let primaryEventsEndpoint = ""
    let listenerSettings: SermonListenerSettings = { ...DEFAULT_SERMON_LISTENER_SETTINGS }
    let transcriberSettings: SermonTranscriberSettings = { ...DEFAULT_SERMON_TRANSCRIBER_SETTINGS }
    let transcriberEngineOptions: { value: string; label: string }[] = []
    const transcriberEngineChoices = [
        { value: "disabled", label: "scripture.auto_listener_transcriber_engine_disabled" },
        { value: "vosk", label: "scripture.auto_listener_transcriber_engine_vosk" }
    ]

    $: status = $autoScriptureStatus
    $: suggestions = $autoScriptureSuggestions
    $: transcripts = $autoScriptureTranscripts
    $: {
        const storedSettings = ($special?.sermonListener || {}) as Partial<SermonListenerSettings>
        const customList = Array.isArray(storedSettings.customEndpoints)
            ? [...storedSettings.customEndpoints]
            : [...DEFAULT_SERMON_LISTENER_SETTINGS.customEndpoints]
        listenerSettings = {
            ...DEFAULT_SERMON_LISTENER_SETTINGS,
            ...storedSettings,
            customEndpoints: customList,
            transcriber: {
                ...DEFAULT_SERMON_TRANSCRIBER_SETTINGS,
                ...(storedSettings.transcriber || {})
            }
        }
    }
    $: endpointList = buildEndpointList(status, listenerSettings)
    $: primaryReferenceEndpoint = endpointList[0]?.reference || ""
    $: primaryStatusEndpoint = endpointList[0]?.status || ""
    $: primaryEventsEndpoint = endpointList[0]?.events || ""
    $: scriptureOptions = buildScriptureOptions($scriptures, $dictionary)
    $: scriptureTargetLabel = listenerSettings.scriptureId
        ? getScriptureName(listenerSettings.scriptureId)
        : ""
    $: transcriberSettings = {
        ...DEFAULT_SERMON_TRANSCRIBER_SETTINGS,
        ...(listenerSettings.transcriber || {})
    }
    $: transcriberEngineOptions = transcriberEngineChoices.map((option) => ({
        value: option.value,
        label: translateText(option.label, $dictionary) || option.label
    }))

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

    function updateTranscriberSetting<K extends keyof SermonTranscriberSettings>(
        key: K,
        value: SermonTranscriberSettings[K]
    ) {
        const current = listenerSettings.transcriber || DEFAULT_SERMON_TRANSCRIBER_SETTINGS
        const updated: SermonTranscriberSettings = {
            ...DEFAULT_SERMON_TRANSCRIBER_SETTINGS,
            ...current,
            [key]: value
        }

        updateSetting("transcriber", updated)

        autoScriptureStatus.update((state) => {
            const next = { ...state }
            if (key === "engine") {
                next.transcriberEngine = updated.engine
                next.transcriberReady = false
                next.transcriberMessage = undefined
            }
            if (key === "sampleRate") next.transcriberSampleRate = updated.sampleRate
            if (key === "enablePartial") next.transcriberPartial = updated.enablePartial
            if (key === "modelPath") next.transcriberMessage = undefined
            if (key === "maxAlternatives") next.transcriberMessage = state.transcriberMessage
            return next
        })
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

    function buildEndpointList(
        currentStatus: AutoScriptureStatus | undefined,
        settings: SermonListenerSettings
    ): DisplayEndpoint[] {
        const collected: DisplayEndpoint[] = []
        const seen = new Set<string>()
        const endpoints = collectEndpoints(currentStatus, settings)

        endpoints.forEach((endpoint) => {
            const transcript = normalizeTranscriptUrl(endpoint.url)
            if (!transcript || seen.has(transcript)) return
            seen.add(transcript)

            const reference = normalizeEndpointVariant(endpoint.reference, transcript, "/reference")
            const statusUrl = normalizeEndpointVariant(endpoint.status, transcript, "/status")
            const eventsUrl = normalizeEndpointVariant(endpoint.events, transcript, "/events")
            collected.push({
                transcript,
                reference,
                status: statusUrl,
                events: eventsUrl,
                type: endpoint.type ?? "loopback"
            })
        })

        return collected
    }

    function collectEndpoints(
        currentStatus: AutoScriptureStatus | undefined,
        settings: SermonListenerSettings
    ): AutoScriptureEndpoint[] {
        const endpoints: AutoScriptureEndpoint[] = []
        if (currentStatus?.httpEndpoints?.length) {
            currentStatus.httpEndpoints.forEach((entry) => {
                if (!entry?.url) return
                endpoints.push(entry)
            })
        } else if (currentStatus?.httpEndpoint) {
            endpoints.push({ url: currentStatus.httpEndpoint, type: "loopback" })
        } else if (settings.enabled) {
            endpoints.push({ url: `http://127.0.0.1:${settings.port}/transcript`, type: "loopback" })
        }

        const appendCustom = (values: string[] | undefined) => {
            values?.forEach((entry) => {
                const normalized = normalizeTranscriptUrl(entry)
                if (!normalized) return
                endpoints.push({ url: normalized, type: "custom" })
            })
        }

        appendCustom(currentStatus?.customEndpoints)
        appendCustom(settings.customEndpoints)

        return endpoints
    }

    function normalizeTranscriptUrl(url: string): string {
        if (!url) return ""
        let normalized = url.trim()
        if (!normalized) return ""
        if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
            normalized = `http://${normalized}`
        }
        normalized = normalized.replace(/\s/g, "")
        normalized = normalized.replace(/\/+$/, "")
        if (!/\/transcript$/i.test(normalized)) normalized = `${normalized}/transcript`
        return normalized
    }

    function normalizeEndpointVariant(value: string | undefined, base: string, suffix: string) {
        const candidate = normalizeGenericUrl(value)
        if (candidate) return candidate
        return normalizeGenericUrl(base.replace(/\/transcript$/i, suffix))
    }

    function normalizeGenericUrl(url: string | undefined): string {
        if (!url) return ""
        let normalized = url.trim()
        if (!normalized) return ""
        if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
            normalized = `http://${normalized}`
        }
        normalized = normalized.replace(/\s/g, "")
        return normalized.replace(/\/+$/, "")
    }

    function getEndpointTypeLabel(type?: AutoScriptureEndpointType) {
        switch (type) {
            case "lan":
                return "scripture.auto_listener_endpoint_type_lan"
            case "custom":
                return "scripture.auto_listener_endpoint_type_custom"
            default:
                return "scripture.auto_listener_endpoint_type_loopback"
        }
    }

    function addCustomEndpoint() {
        const normalized = normalizeTranscriptUrl(customEndpointValue)
        if (!normalized) {
            newToast("scripture.auto_listener_custom_endpoint_invalid")
            return
        }

        const existing = listenerSettings.customEndpoints || []
        const duplicate = existing.some((entry) => entry.toLowerCase() === normalized.toLowerCase())
        const alreadyListed = endpointList.some(
            (endpoint) => endpoint.transcript.toLowerCase() === normalized.toLowerCase()
        )
        if (duplicate || alreadyListed) {
            newToast("scripture.auto_listener_custom_endpoint_duplicate")
            return
        }

        updateSetting("customEndpoints", [...existing, normalized])
        customEndpointValue = ""
    }

    function removeCustomEndpoint(index: number) {
        const existing = listenerSettings.customEndpoints || []
        if (index < 0 || index >= existing.length) return
        const updated = existing.filter((_, i) => i !== index)
        updateSetting("customEndpoints", updated)
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
    {#if endpointList.length}
        <div class="endpoints">
            {#each endpointList as endpoint (endpoint.transcript)}
                <div class="endpoint" class:inactive={!status.listening}>
                    <div class="endpoint-info">
                        <span class="endpoint-label">
                            <T id="scripture.auto_listener_endpoint_transcript" />
                            <span class="endpoint-type">
                                <T id={getEndpointTypeLabel(endpoint.type)} />
                            </span>
                        </span>
                        <code>{endpoint.transcript}</code>
                    </div>
                    <MaterialButton
                        icon="content_copy"
                        variant="text"
                        title="scripture.auto_listener_copy"
                        on:click={() => copyValue(endpoint.transcript)}
                        small
                    />
                </div>
                <div class="endpoint" class:inactive={!status.listening}>
                    <div class="endpoint-info">
                        <span class="endpoint-label">
                            <T id="scripture.auto_listener_endpoint_reference" />
                            <span class="endpoint-type">
                                <T id={getEndpointTypeLabel(endpoint.type)} />
                            </span>
                        </span>
                        <code>{endpoint.reference}</code>
                    </div>
                    <MaterialButton
                        icon="content_copy"
                        variant="text"
                        title="scripture.auto_listener_copy"
                        on:click={() => copyValue(endpoint.reference)}
                        small
                    />
                </div>
                <div class="endpoint" class:inactive={!status.listening}>
                    <div class="endpoint-info">
                        <span class="endpoint-label">
                            <T id="scripture.auto_listener_endpoint_status" />
                            <span class="endpoint-type">
                                <T id={getEndpointTypeLabel(endpoint.type)} />
                            </span>
                        </span>
                        <code>{endpoint.status}</code>
                    </div>
                    <MaterialButton
                        icon="content_copy"
                        variant="text"
                        title="scripture.auto_listener_copy"
                        on:click={() => copyValue(endpoint.status)}
                        small
                    />
                </div>
                <div class="endpoint" class:inactive={!status.listening}>
                    <div class="endpoint-info">
                        <span class="endpoint-label">
                            <T id="scripture.auto_listener_endpoint_events" />
                            <span class="endpoint-type">
                                <T id={getEndpointTypeLabel(endpoint.type)} />
                            </span>
                        </span>
                        <code>{endpoint.events}</code>
                    </div>
                    <MaterialButton
                        icon="content_copy"
                        variant="text"
                        title="scripture.auto_listener_copy"
                        on:click={() => copyValue(endpoint.events)}
                        small
                    />
                </div>
            {/each}
        </div>
        <p class="endpoint-help">
            <T id="scripture.auto_listener_endpoint_help" />
        </p>
        {#if primaryReferenceEndpoint}
            <p class="endpoint-help">
                <T id="scripture.auto_listener_reference_help" replace={[primaryReferenceEndpoint]} />
            </p>
        {/if}
        {#if primaryStatusEndpoint}
            <p class="endpoint-help">
                <T id="scripture.auto_listener_status_help" replace={[primaryStatusEndpoint]} />
            </p>
        {/if}
        {#if primaryEventsEndpoint}
            <p class="endpoint-help">
                <T id="scripture.auto_listener_events_help" replace={[primaryEventsEndpoint]} />
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

    <div class="transcriber">
        <div class="transcriber-header">
            <h4><T id="scripture.auto_listener_transcriber" /></h4>
        </div>
        <p
            class="transcriber-status"
            class:ready={status.transcriberReady}
            class:warning={!status.transcriberReady && status.transcriberEngine === "vosk"}
        >
            {#if status.transcriberEngine === "vosk"}
                {#if status.transcriberReady}
                    <T id="scripture.auto_listener_transcriber_status_ready" />
                {:else if status.transcriberMessage}
                    <T
                        id="scripture.auto_listener_transcriber_status_error"
                        replace={[status.transcriberMessage]}
                    />
                {:else}
                    <T id="scripture.auto_listener_transcriber_status_loading" />
                {/if}
            {:else}
                <T id="scripture.auto_listener_transcriber_status_disabled" />
            {/if}
        </p>
        {#if status.transcriberEngine === "vosk" && status.transcriberMessage && status.transcriberReady}
            <p class="transcriber-detail">{status.transcriberMessage}</p>
        {:else if status.transcriberEngine === "vosk" && status.transcriberMessage}
            <p class="transcriber-detail warning">{status.transcriberMessage}</p>
        {/if}
        <div class="transcriber-controls">
            <MaterialDropdown
                label="scripture.auto_listener_transcriber_engine"
                options={transcriberEngineOptions}
                value={transcriberSettings.engine}
                on:change={(e) => updateTranscriberSetting("engine", e.detail)}
            />
            {#if transcriberSettings.engine === "vosk"}
                <MaterialTextInput
                    label="scripture.auto_listener_transcriber_model_path"
                    value={transcriberSettings.modelPath}
                    on:input={(e) => updateTranscriberSetting("modelPath", e.detail || "")}
                    on:change={(e) => updateTranscriberSetting("modelPath", e.detail || "")}
                />
                <MaterialNumberInput
                    label="scripture.auto_listener_transcriber_sample_rate"
                    value={transcriberSettings.sampleRate}
                    min={8000}
                    max={96000}
                    step={1000}
                    on:change={(e) => updateTranscriberSetting("sampleRate", Number(e.detail))}
                />
                <MaterialNumberInput
                    label="scripture.auto_listener_transcriber_max_alternatives"
                    value={transcriberSettings.maxAlternatives}
                    min={0}
                    max={10}
                    on:change={(e) => updateTranscriberSetting("maxAlternatives", Number(e.detail))}
                />
                <MaterialToggleSwitch
                    label="scripture.auto_listener_transcriber_partial"
                    checked={transcriberSettings.enablePartial}
                    on:change={(e) => updateTranscriberSetting("enablePartial", e.detail)}
                />
            {/if}
        </div>
        <p class="transcriber-hint"><T id="scripture.auto_listener_transcriber_hint" /></p>
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
            label="scripture.auto_listener_context_window"
            value={listenerSettings.contextWindow}
            min={0}
            max={120}
            on:change={(e) =>
                updateSetting(
                    "contextWindow",
                    Math.max(0, Math.min(120, Math.floor(Number(e.detail) || 0)))
                )}
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
    <p class="context-hint"><T id="scripture.auto_listener_context_hint" /></p>

    <div class="custom-endpoints">
        <div class="custom-header">
            <h4><T id="scripture.auto_listener_custom_endpoints" /></h4>
        </div>
        <p class="custom-hint"><T id="scripture.auto_listener_custom_endpoints_hint" /></p>
        {#if listenerSettings.customEndpoints.length}
            <ul>
                {#each listenerSettings.customEndpoints as endpoint, index (endpoint)}
                    <li>
                        <code>{endpoint}</code>
                        <MaterialButton
                            icon="delete"
                            variant="text"
                            title="scripture.auto_listener_custom_endpoint_remove"
                            on:click={() => removeCustomEndpoint(index)}
                            small
                        />
                    </li>
                {/each}
            </ul>
        {:else}
            <p class="empty"><T id="scripture.auto_listener_custom_endpoints_empty" /></p>
        {/if}
        <div class="custom-endpoint-form">
            <MaterialTextInput
                label="scripture.auto_listener_custom_endpoint_label"
                placeholder={translateText("scripture.auto_listener_custom_endpoint_placeholder")}
                value={customEndpointValue}
                on:input={(e) => (customEndpointValue = e.detail || "")}
                on:change={(e) => (customEndpointValue = e.detail || "")}
            />
            <MaterialButton icon="add" on:click={addCustomEndpoint} small>
                <T id="scripture.auto_listener_custom_endpoint_add" />
            </MaterialButton>
        </div>
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

    .endpoint-type {
        margin-left: 6px;
        font-weight: 400;
        opacity: 0.65;
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

    .transcriber {
        border-top: 1px solid rgba(255, 255, 255, 0.05);
        padding-top: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .transcriber-header h4 {
        margin: 0;
    }

    .transcriber-status {
        margin: 0;
        font-size: 0.8em;
        opacity: 0.75;
    }

    .transcriber-status.ready {
        color: #9ed69e;
        opacity: 1;
    }

    .transcriber-status.warning {
        color: #ffcf82;
        opacity: 1;
    }

    .transcriber-detail {
        margin: 0;
        font-size: 0.75em;
        opacity: 0.75;
        word-break: break-word;
    }

    .transcriber-detail.warning {
        color: #ffb8b8;
        opacity: 1;
    }

    .transcriber-controls {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 10px;
        align-items: end;
    }

    .transcriber-hint {
        margin: 0;
        font-size: 0.75em;
        opacity: 0.7;
    }

    .settings {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 10px;
    }

    .context-hint {
        margin: 0;
        font-size: 0.75em;
        opacity: 0.7;
    }

    .custom-endpoints {
        border-top: 1px solid rgba(255, 255, 255, 0.05);
        padding-top: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .custom-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }

    .custom-hint {
        margin: 0;
        font-size: 0.8em;
        opacity: 0.75;
    }

    .custom-endpoints ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .custom-endpoints li {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        background: rgba(0, 0, 0, 0.2);
        border-radius: 6px;
        padding: 8px 10px;
    }

    .custom-endpoints code {
        word-break: break-all;
        font-size: 0.85em;
        flex: 1;
    }

    .custom-endpoint-form {
        display: flex;
        gap: 8px;
        align-items: flex-end;
    }

    .custom-endpoint-form :global(.textfield) {
        flex: 1;
    }

    .custom-endpoint-form :global(.material-button) {
        align-self: stretch;
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
