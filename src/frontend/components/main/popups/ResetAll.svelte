<script lang="ts">
    import { Main } from "../../../../types/IPC/Main"
    import type { SaveData } from "../../../../types/Save"
    import { sendMain } from "../../../IPC/main"
    import {
        activeEdit,
        activePage,
        activePopup,
        activeShow,
        dataPath,
        deletedShows,
        drawSettings,
        renamedShows,
        scriptureAutoHistory,
        scriptureAutoQueue,
        scriptureAutoSettings,
        scriptureAutoState,
        scriptureAutoStats,
        scriptureAutoTranscript,
        scripturesCache,
        showsPath
    } from "../../../stores"
    import { save } from "../../../utils/save"
    import T from "../../helpers/T.svelte"
    import MaterialButton from "../../inputs/MaterialButton.svelte"
    import { clearAll } from "../../output/clear"

    function reset() {
        // backup
        save(false, { backup: true, isAutoBackup: true })
        setTimeout(resetSettings, 500)
    }

    function resetSettings() {
        sendMain(Main.SAVE, {
            path: $showsPath || "",
            dataPath: $dataPath,
            // SETTINGS
            SETTINGS: {},
            SYNCED_SETTINGS: {},
            // SHOWS
            SHOWS: {},
            STAGE_SHOWS: {},
            // STORES
            PROJECTS: { projects: {}, folders: {}, projectTemplates: {} },
            OVERLAYS: {},
            TEMPLATES: {},
            EVENTS: {},
            MEDIA: {},
            THEMES: {},
            DRIVE_API_KEY: {},
            CACHE: { media: {}, text: {} },
            HISTORY: { undo: [], redo: [] },
            USAGE: { all: [] },
            // SAVE DATA
            closeWhenFinished: false,
            customTriggers: { changeUserData: { reset: true } }
        } as SaveData)

        // WIP reset error log / other config files
        // all content in FreeShow/ folder, including Shows/Scripture files are not deleted
        // media cache is not deleted

        clearAll()
        drawSettings.set({})

        showsPath.set(null)
        // dataPath.set("")
        // showsCache.set({})
        scripturesCache.set({})
        scriptureAutoHistory.set([])
        scriptureAutoTranscript.set([])
        scriptureAutoQueue.set([])
        scriptureAutoSettings.set({
            language: "en-US",
            autoDisplay: false,
            dedupeWindowMs: 15000,
            autoStartListening: false,
            themeId: "classic",
            minimumConfidence: 0.55,
            autoDisplayDelayMs: 0,
            autoClearDelayMs: 0,
            languageOverrides: {},
            recognizerMode: "browser",
            remoteServiceUrl: "",
        })
        scriptureAutoState.set({
            supported: true,
            listening: false,
            status: "",
            partialTranscript: "",
            lastHeardAt: null,
            lastReference: null,
            lastSource: null,
            lastText: null,
            lastConfidence: null,
            activeBibleId: null,
            activeBibleName: null,
            activeScriptureId: null,
            currentReference: null,
            currentText: null,
            currentTranslation: null,
            currentAppliedAt: null,
            currentSource: null,
            currentAuto: false,
            currentConfidence: null,
            currentDisplayed: false,
            pinned: false,
            recognizerMode: "browser",
            remoteConnected: false,
            remoteStatus: null,
            remoteLatencyMs: null,
            remoteLastPingAt: null,
            nextAutoApplyId: null,
            nextAutoApplyAt: null,
            nextAutoApplyDelayMs: null,
            nextAutoClearAt: null,
            nextAutoClearDelayMs: null
        })
        scriptureAutoStats.set({
            startedAt: Date.now(),
            lastUpdated: null,
            detected: 0,
            speechDetections: 0,
            manualDetections: 0,
            displayed: 0,
            autoDisplayed: 0,
            manualSubmissions: 0,
            dismissed: 0,
            confidenceSamples: 0,
            averageConfidence: 0,
            suppressedDuplicates: 0,
            suppressedLowConfidence: 0
        })
        deletedShows.set([])
        renamedShows.set([])

        activeShow.set(null)
        activeEdit.set({ items: [] })

        activePage.set("show")
        activePopup.set("initialize")
    }
</script>

<p><T id="popup.reset_all_confirm" /></p>
<p style="font-size: 0.9em;opacity: 0.7;"><T id="popup.reset_all_action" /></p>

<MaterialButton variant="outlined" class="red" style="margin-top: 20px;" icon="close" on:click={reset} white>
    <T id="popup.continue" />
</MaterialButton>

<style>
    /* red */
    :global(button.red) {
        background-color: rgb(255 0 0 / 0.25) !important;
    }
    :global(button.red):hover:not(.contained):not(.active) {
        background-color: rgb(255 0 0 / 0.35) !important;
    }
    :global(button.red):active:not(.contained):not(.active),
    :global(button.red):focus:not(.contained):not(.active) {
        background-color: rgb(255 0 0 / 0.3) !important;
    }
</style>
