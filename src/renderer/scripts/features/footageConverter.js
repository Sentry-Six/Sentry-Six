const ACTIVE_STATES = new Set([
    'discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry',
    'verifying', 'copying', 'replacing', 'paused', 'paused_network'
]);

const PIPELINE_ORDER = ['discover', 'encode', 'verify', 'save'];
const GROUPS = ['RecentClips', 'SavedClips', 'SentryClips'];
const DEFAULT_GROUP_ORDER = ['SavedClips', 'SentryClips', 'RecentClips'];

const STATUS_LABELS = Object.freeze({
    discovering: ['statusDiscovering', 'Discovering footage'],
    waiting: ['statusWaiting', 'Preparing next file'],
    staging: ['statusStaging', 'Staging locally'],
    encoding: ['statusEncoding', 'Encoding video'],
    'writing-telemetry': ['statusWritingTelemetry', 'Writing telemetry'],
    verifying: ['statusVerifying', 'Verifying telemetry'],
    copying: ['statusCopying', 'Saving verified file'],
    replacing: ['statusReplacing', 'Replacing verified original'],
    paused: ['statusPaused', 'Paused at a safe boundary'],
    paused_network: ['statusWaitingForConnection', 'Waiting for connection'],
    completed: ['statusCompleted', 'Conversion complete'],
    cancelled: ['statusCancelled', 'Conversion cancelled'],
    failed: ['statusFailed', 'Conversion stopped']
});

function formatBytes(bytes, locale) {
    const safe = Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0;
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = safe;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const rendered = new Intl.NumberFormat(locale, {
        minimumFractionDigits: 0,
        maximumFractionDigits: unit === 0 ? 0 : 2
    }).format(unit === 0 ? safe : value);
    return `${rendered} ${units[unit]}`;
}

function formatDuration(milliseconds) {
    const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remaining = seconds % 60;
    return hours > 0
        ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
        : `${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
}

function apiError(code) {
    return Object.assign(new Error(code || 'OPERATION_FAILED'), { code: code || 'OPERATION_FAILED' });
}

function unwrap(result) {
    if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'ok')) {
        if (result.ok === true) return result.value;
        throw apiError(result.error?.code);
    }
    return result;
}

function selected(options, dataKey, fallback) {
    return options.find((entry) => entry.checked)?.dataset?.[dataKey] || fallback;
}

function setText(element, value) {
    if (element) element.textContent = value == null ? '' : String(value);
}

function setHidden(element, hidden) {
    if (element) element.hidden = Boolean(hidden);
}

function setDisabled(element, disabled) {
    if (element) element.disabled = Boolean(disabled);
}

function createRow(container, primary, secondary = '') {
    const documentApi = container?.ownerDocument;
    if (!container || !documentApi?.createElement) return null;
    const row = documentApi.createElement('div');
    row.classList.add('converter-row');
    const label = documentApi.createElement('span');
    label.classList.add('converter-row-primary');
    label.textContent = primary;
    row.append(label);
    if (secondary) {
        const detail = documentApi.createElement('span');
        detail.classList.add('converter-row-secondary');
        detail.textContent = secondary;
        row.append(detail);
    }
    return row;
}

function renderRows(container, rows) {
    if (!container) return;
    container.textContent = rows.map(([primary, secondary]) => `${primary}${secondary ? ` — ${secondary}` : ''}`).join('\n');
    const rendered = rows.map(([primary, secondary]) => createRow(container, primary, secondary)).filter(Boolean);
    if (typeof container.replaceChildren === 'function' && rendered.length) container.replaceChildren(...rendered);
}

function collectElements(root) {
    const byId = (id) => root?.querySelector?.(`#${id}`) || null;
    const all = (selector) => [...(root?.querySelectorAll?.(selector) || [])];
    const orderRows = all('[data-converter-order-group]').map((row) => ({
        group: row.dataset?.converterOrderGroup,
        row,
        rank: row.querySelector?.('[data-converter-order-rank]') || null,
        up: row.querySelector?.('[data-converter-order-move="up"]') || null,
        down: row.querySelector?.('[data-converter-order-move="down"]') || null
    }));
    return {
        sourcePath: byId('converterSourcePath'),
        destinationPath: byId('converterDestinationPath'),
        sourceButton: byId('converterChooseSource'),
        destinationButton: byId('converterChooseDestination'),
        groupOptions: all('[data-converter-group]'),
        orderRows,
        codecOptions: all('[data-converter-codec]'),
        profileOptions: all('[data-converter-profile]'),
        outputOptions: all('[data-converter-output]'),
        replaceOption: byId('converterReplaceOption'),
        replaceInput: byId('converterOutputReplace'),
        replaceCapability: byId('converterReplaceCapability'),
        replacementConfirmation: byId('converterReplacementConfirmation'),
        replacementWarning: byId('converterReplacementWarning'),
        replacementConfirmationRow: byId('converterReplacementConfirmationRow'),
        estimate: byId('converterEstimate'),
        startButton: byId('converterStart'),
        pauseButton: byId('converterPause'),
        resumeButton: byId('converterResume'),
        cancelButton: byId('converterCancel'),
        retryButton: byId('converterRetry'),
        dismissButton: byId('converterDismissSummary'),
        status: byId('converterStatus'),
        currentFile: byId('converterCurrentFile'),
        currentProgress: byId('converterCurrentProgress'),
        currentProgressFill: byId('converterCurrentProgressFill'),
        elapsed: byId('converterElapsed'),
        countDiscovered: byId('converterCountDiscovered'),
        countCompleted: byId('converterCountCompleted'),
        countSkipped: byId('converterCountSkipped'),
        countFailed: byId('converterCountFailed'),
        countWaiting: byId('converterCountWaiting'),
        processedBytes: byId('converterProcessedBytes'),
        reconnectBanner: byId('converterReconnectBanner'),
        cleanupBanner: byId('converterCleanupBanner'),
        errorRows: byId('converterErrorRows'),
        pipeline: byId('converterPipeline'),
        pipelineStages: all('[data-converter-phase]'),
        summary: byId('converterSummary'),
        summaryRetention: byId('converterSummaryRetention'),
        summaryFiles: byId('converterSummaryFiles'),
        summarySkipped: byId('converterSummarySkipped'),
        summaryFailed: byId('converterSummaryFailed'),
        summarySource: byId('converterSummarySource'),
        summaryOutput: byId('converterSummaryOutput'),
        summarySaved: byId('converterSummarySaved'),
        summaryPercent: byId('converterSummaryPercent'),
        summaryAssets: byId('converterSummaryAssets'),
        summaryElapsed: byId('converterSummaryElapsed'),
        summaryGroups: byId('converterSummaryGroups')
    };
}

function phaseFor(snapshot) {
    let state = snapshot?.state;
    if (state === 'paused') state = snapshot?.recovery?.fromState || 'waiting';
    if (state === 'paused_network') state = snapshot?.recovery?.resumeState || 'waiting';
    if (state === 'discovering') return 'discover';
    if (['waiting', 'staging', 'encoding', 'writing-telemetry'].includes(state)) return 'encode';
    if (state === 'verifying') return 'verify';
    if (['copying', 'replacing'].includes(state)) return 'save';
    if (state === 'completed') return 'complete';
    return null;
}

function createFootageConverterController(options = {}) {
    const api = options.api;
    if (!api) throw new TypeError('converter api is required');
    const elements = options.elements || collectElements(options.root);
    const notify = typeof options.notify === 'function' ? options.notify : () => {};
    const confirmAction = typeof options.confirm === 'function'
        ? options.confirm
        : (message) => globalThis.confirm?.(message) === true;
    const getLocale = typeof options.getLocale === 'function'
        ? options.getLocale
        : () => options.locale || options.root?.documentElement?.lang || globalThis.document?.documentElement?.lang || 'en';
    const renderBytes = options.formatBytes || ((bytes) => formatBytes(bytes, getLocale()));
    const translate = typeof options.t === 'function' ? options.t : (key) => key;
    const subscribeLanguage = typeof options.onLanguageChange === 'function' ? options.onLanguageChange : null;
    let capabilities = { separatePublication: 'unavailable', ownershipCleanup: 'unavailable', replacement: 'unavailable' };
    let snapshot = null;
    let latestRevision = -1;
    let initialized = false;
    let initPromise = null;
    let unsubscribe = null;
    let unsubscribeLanguage = null;
    let visible = false;
    let pendingStartEvents = null;
    let groupOrder = [...DEFAULT_GROUP_ORDER];

    function message(key, fallback, params) {
        const fullKey = `ui.converter.${key}`;
        const value = params === undefined ? translate(fullKey) : translate(fullKey, params);
        if (value && value !== fullKey) return value;
        return String(fallback).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match);
    }

    function setChecked(optionsList, dataKey, value) {
        for (const entry of optionsList) entry.checked = entry.dataset?.[dataKey] === value;
    }

    function syncConfig(config) {
        if (!config) return;
        if (elements.sourcePath) elements.sourcePath.value = config.sourceRoot || '';
        if (elements.destinationPath) elements.destinationPath.value = config.destinationRoot || '';
        setChecked(elements.codecOptions, 'converterCodec', config.codec);
        setChecked(elements.profileOptions, 'converterProfile', config.profileId);
        setChecked(elements.outputOptions, 'converterOutput', config.outputMode);
        const included = new Set(config.includedGroups || []);
        for (const entry of elements.groupOptions) entry.checked = included.has(entry.dataset?.converterGroup);
        groupOrder = Array.isArray(config.groupOrder) && config.groupOrder.length === GROUPS.length
            ? [...config.groupOrder]
            : [...DEFAULT_GROUP_ORDER];
        if (elements.replacementConfirmation) elements.replacementConfirmation.checked = config.replacementConfirmed === true;
        updateOutputMode();
    }

    function renderGroupOrder(disabled = false) {
        for (const item of elements.orderRows || []) {
            const index = groupOrder.indexOf(item.group);
            if (item.row?.style) item.row.style.order = String(index);
            setText(item.rank, String(index + 1));
            setDisabled(item.up, disabled || index <= 0);
            setDisabled(item.down, disabled || index < 0 || index >= groupOrder.length - 1);
        }
    }

    function moveGroup(group, direction) {
        const index = groupOrder.indexOf(group);
        const nextIndex = direction === 'up' ? index - 1 : index + 1;
        if (index < 0 || nextIndex < 0 || nextIndex >= groupOrder.length) return;
        [groupOrder[index], groupOrder[nextIndex]] = [groupOrder[nextIndex], groupOrder[index]];
        renderGroupOrder(false);
    }

    function updateCapabilities(next) {
        capabilities = next || capabilities;
        const replacementAvailable = capabilities.replacement === 'available';
        setDisabled(elements.replaceInput, !replacementAvailable);
        if (elements.replaceOption) {
            elements.replaceOption.setAttribute?.('aria-disabled', replacementAvailable ? 'false' : 'true');
            elements.replaceOption.classList?.toggle('is-unavailable', !replacementAvailable);
        }
        setText(elements.replaceCapability, replacementAvailable
            ? message('capabilityReplaceAvailable', 'Available on this filesystem')
            : message('capabilityReplaceUnavailable', 'Replace originals is not available on this system. Originals remain protected.'));
        if (!replacementAvailable && selected(elements.outputOptions, 'converterOutput', 'separate') === 'replace') {
            setChecked(elements.outputOptions, 'converterOutput', 'separate');
        }
        updateOutputMode();
    }

    function updateOutputMode() {
        const mode = selected(elements.outputOptions, 'converterOutput', 'separate');
        const replacing = mode === 'replace' && capabilities.replacement === 'available';
        setHidden(elements.replacementConfirmationRow, !replacing);
        setDisabled(elements.destinationPath, replacing);
        setDisabled(elements.destinationButton, replacing);
        const sourceRoot = elements.sourcePath?.value?.trim() || message('sourcePlaceholder', 'the selected source folder');
        setText(elements.replacementWarning, message(
            'replacementWarning',
            'Source {sourceRoot}: each original is backed up before replacement. If replacement fails, the backup is restored so you can roll back safely.',
            { sourceRoot }
        ));
    }

    function renderPipeline() {
        const current = phaseFor(snapshot);
        const activeIndex = PIPELINE_ORDER.indexOf(current);
        if (elements.pipeline) elements.pipeline.dataset.currentPhase = current || 'idle';
        for (const stage of elements.pipelineStages) {
            const index = PIPELINE_ORDER.indexOf(stage.dataset?.phase);
            const complete = current === 'complete' || (activeIndex >= 0 && index < activeIndex);
            stage.classList?.toggle('is-active', index === activeIndex);
            stage.classList?.toggle('is-complete', complete);
            stage.setAttribute?.('aria-current', index === activeIndex ? 'step' : 'false');
        }
    }

    function renderSummary(items) {
        const summary = snapshot?.summary;
        setHidden(elements.summary, !summary);
        if (!summary) return;
        setText(elements.summaryRetention, snapshot?.config?.outputMode === 'separate'
            ? message('summarySeparateRetention', 'Video size reduction is not physical storage reclaimed. Originals are retained in separate mode.')
            : message('summaryRetention', 'Video size reduction is not physical storage reclaimed. Retained cleanup artifacts still consume space.'));
        const skipped = snapshot?.itemStateCounts?.skipped
            ?? items.filter((item) => item.state === 'skipped').length;
        const failed = snapshot?.itemStateCounts?.failed
            ?? items.filter((item) => item.state === 'failed').length;
        const percent = summary.sourceVideoBytes > 0 ? Math.round((summary.savedBytes / summary.sourceVideoBytes) * 100) : 0;
        setText(elements.summaryFiles, summary.files);
        setText(elements.summarySkipped, skipped);
        setText(elements.summaryFailed, failed);
        setText(elements.summarySource, renderBytes(summary.sourceVideoBytes));
        setText(elements.summaryOutput, renderBytes(summary.outputVideoBytes));
        setText(elements.summarySaved, renderBytes(summary.savedBytes));
        setText(elements.summaryPercent, `${percent}%`);
        setText(elements.summaryAssets, renderBytes(summary.copiedAssetBytes));
        setText(elements.summaryElapsed, formatDuration((snapshot.updatedAt || 0) - (snapshot.createdAt || 0)));
        renderRows(elements.summaryGroups, GROUPS.map((group) => {
            const counters = summary.groups?.[group] || { files: 0, savedBytes: 0 };
            return [group, message('summaryGroup', '{count} files · {bytes} video size reduction', {
                count: counters.files,
                bytes: renderBytes(counters.savedBytes)
            })];
        }));
    }

    function render() {
        const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
        const counters = snapshot?.counters || {};
        const activeItem = items.find((item) => item.id === snapshot?.activeItemId)
            || items.find((item) => item.state === 'processing');
        const failedItems = items.filter((item) => item.state === 'failed');
        const cleanupItems = items.filter((item) => String(item.resultCode || '').includes('cleanup-pending'));
        const stateCount = (state) => snapshot?.itemStateCounts?.[state]
            ?? items.filter((item) => item.state === state).length;
        const cleanupPendingCount = snapshot?.cleanupPendingCount ?? cleanupItems.length;
        const progress = snapshot?.progress;
        const active = ACTIVE_STATES.has(snapshot?.state);
        const paused = snapshot?.state === 'paused';

        const statusLabel = STATUS_LABELS[snapshot?.state];
        setText(elements.status, snapshot
            ? statusLabel ? message(...statusLabel) : message('statusReady', 'Converter ready')
            : message('ready', 'Ready to configure'));
        setText(elements.currentFile, activeItem?.relativePath || message('noFileActive', 'No file active'));
        setText(elements.currentProgress, progress?.outTimeUs !== undefined
            ? message('progressEncoded', '{duration} encoded', { duration: formatDuration(progress.outTimeUs / 1000) })
            : activeItem ? message('progressWorking', 'Working on current file') : '—');
        elements.currentProgressFill?.classList?.toggle('is-live', Boolean(activeItem && active));
        const elapsedEnd = active ? Date.now() : (snapshot?.updatedAt || snapshot?.createdAt || 0);
        setText(elements.elapsed, snapshot ? formatDuration(elapsedEnd - (snapshot.createdAt || 0)) : '00:00');
        setText(elements.countDiscovered, snapshot?.itemCount ?? items.length);
        setText(elements.countCompleted, stateCount('completed'));
        setText(elements.countSkipped, stateCount('skipped'));
        setText(elements.countFailed, stateCount('failed'));
        setText(elements.countWaiting, stateCount('queued'));
        setText(elements.processedBytes, renderBytes(counters.sourceVideoBytes || 0));
        setHidden(elements.reconnectBanner, snapshot?.state !== 'paused_network');
        setHidden(elements.cleanupBanner, cleanupPendingCount === 0);
        if (cleanupPendingCount) {
            setText(elements.cleanupBanner, message('cleanupPending', '{count} {file} with cleanup pending. Retained artifacts still consume space; hardlinks share disk allocation.', {
                count: cleanupPendingCount,
                file: message(cleanupPendingCount === 1 ? 'cleanupFileSingular' : 'cleanupFilePlural', cleanupPendingCount === 1 ? 'file' : 'files')
            }));
        }
        renderRows(elements.errorRows, failedItems.map((item) => [item.relativePath || item.id, item.failure?.code || 'operation-failed']));
        setHidden(elements.errorRows, failedItems.length === 0);
        setDisabled(elements.startButton, active);
        setDisabled(elements.pauseButton, !active || paused || snapshot?.state === 'paused_network');
        setDisabled(elements.resumeButton, !paused);
        setDisabled(elements.cancelButton, !active);
        setDisabled(elements.retryButton, failedItems.length === 0 || !['completed', 'failed'].includes(snapshot?.state));
        renderGroupOrder(active);
        renderPipeline();
        renderSummary(items);
    }

    function applySnapshot(next, revision = next?.revision) {
        if (!next || !Number.isSafeInteger(revision) || revision < latestRevision) return false;
        const progressOnly = Object.keys(next).every((key) => ['id', 'revision', 'progress'].includes(key));
        if (progressOnly && snapshot) snapshot = { ...snapshot, progress: next.progress };
        else {
            snapshot = { ...next };
            if (!Object.prototype.hasOwnProperty.call(next, 'progress')) delete snapshot.progress;
            syncConfig(snapshot.config);
        }
        latestRevision = revision;
        render();
        return true;
    }

    function handleProgress(payload) {
        if (!payload || typeof payload.jobId !== 'string' || !payload.snapshot) return;
        if (pendingStartEvents && (!snapshot?.id || payload.jobId !== snapshot.id)) {
            let buffered = pendingStartEvents.get(payload.jobId);
            if (!buffered) {
                if (pendingStartEvents.size >= 8) return;
                buffered = { full: null, progress: null };
                pendingStartEvents.set(payload.jobId, buffered);
            }
            const progressOnly = Object.keys(payload.snapshot)
                .every((key) => ['id', 'revision', 'progress'].includes(key));
            const slot = progressOnly ? 'progress' : 'full';
            if (!buffered[slot] || payload.revision >= buffered[slot].revision) buffered[slot] = payload;
            return;
        }
        if (snapshot?.id && payload.jobId !== snapshot.id) return;
        applySnapshot(payload.snapshot, payload.revision);
    }

    async function chooseFolder(purpose) {
        try {
            const field = purpose === 'source' ? elements.sourcePath : elements.destinationPath;
            const chosen = unwrap(await api.chooseConverterFolder(purpose, field?.value || undefined));
            if (chosen && field) {
                field.value = chosen;
                updateOutputMode();
            }
        } catch (error) {
            notify(message('folderSelectionFailed', 'Folder selection failed: {code}', { code: error.code || 'OPERATION_FAILED' }), { type: 'error' });
        }
    }

    function configFromControls() {
        const sourceRoot = elements.sourcePath?.value?.trim();
        const outputMode = selected(elements.outputOptions, 'converterOutput', 'separate');
        const destinationRoot = elements.destinationPath?.value?.trim();
        const includedGroups = elements.groupOptions
            .filter((entry) => entry.checked)
            .map((entry) => entry.dataset?.converterGroup)
            .filter((group) => GROUPS.includes(group));
        if (!sourceRoot) throw apiError('SOURCE_REQUIRED');
        if (includedGroups.length === 0) throw apiError('GROUP_REQUIRED');
        if (outputMode === 'separate' && !destinationRoot) throw apiError('DESTINATION_REQUIRED');
        if (outputMode === 'replace') {
            if (capabilities.replacement !== 'available') throw apiError('REPLACEMENT_UNAVAILABLE');
            if (elements.replacementConfirmation?.checked !== true) throw apiError('REPLACEMENT_CONFIRMATION_REQUIRED');
            if (!confirmAction(message(
                'replacementConfirm',
                'Replace originals in {sourceRoot}? Each original is backed up first, and a failed replacement restores that backup for rollback.',
                { sourceRoot }
            ))) throw apiError('REPLACEMENT_CONFIRMATION_REQUIRED');
        }
        return {
            sourceRoot,
            destinationRoot: outputMode === 'replace' ? null : destinationRoot,
            codec: selected(elements.codecOptions, 'converterCodec', 'h265'),
            profileId: selected(elements.profileOptions, 'converterProfile', 'balanced'),
            networkMode: 'auto',
            outputMode,
            includedGroups,
            groupOrder: [...groupOrder],
            replacementConfirmed: outputMode === 'replace'
        };
    }

    function describeError(error) {
        const labels = {
            SOURCE_REQUIRED: ['errorSourceRequired', 'Choose a source folder before starting.'],
            DESTINATION_REQUIRED: ['errorDestinationRequired', 'Choose a destination folder for separate output.'],
            GROUP_REQUIRED: ['errorGroupRequired', 'Select at least one Tesla clip group.'],
            REPLACEMENT_CONFIRMATION_REQUIRED: ['errorReplacementConfirmation', 'Acknowledge and confirm replacement before starting.'],
            REPLACEMENT_UNAVAILABLE: ['errorReplacementUnavailable', 'Replace originals is not available on this system.']
        };
        return labels[error?.code]
            ? message(...labels[error.code])
            : message('errorActionFailed', 'Converter action failed: {code}', { code: error?.code || 'OPERATION_FAILED' });
    }

    async function start() {
        pendingStartEvents = new Map();
        try {
            const config = configFromControls();
            const result = unwrap(await api.startConverter(config));
            const buffered = pendingStartEvents.get(result.jobId);
            pendingStartEvents = null;
            const createdAt = Date.now();
            snapshot = null;
            latestRevision = -1;
            applySnapshot({
                id: result.jobId,
                state: 'discovering',
                revision: 0,
                createdAt,
                updatedAt: createdAt,
                config,
                items: [],
                counters: { sourceVideoBytes: 0 },
                summary: null
            }, 0);
            if (buffered?.full) applySnapshot(buffered.full.snapshot, buffered.full.revision);
            if (buffered?.progress) applySnapshot(buffered.progress.snapshot, buffered.progress.revision);
        } catch (error) {
            pendingStartEvents = null;
            notify(describeError(error), { type: 'error' });
        }
    }

    async function command(method, { confirmMessage } = {}) {
        if (!snapshot?.id || typeof api[method] !== 'function') return;
        if (confirmMessage && !confirmAction(confirmMessage)) return;
        try {
            const next = unwrap(await api[method](snapshot.id));
            if (next) applySnapshot(next, next.revision);
        } catch (error) {
            notify(describeError(error), { type: 'error' });
        }
    }

    function bind() {
        elements.sourceButton?.addEventListener('click', () => chooseFolder('source'));
        elements.destinationButton?.addEventListener('click', () => chooseFolder('destination'));
        for (const option of elements.outputOptions) option.addEventListener?.('change', updateOutputMode);
        for (const item of elements.orderRows || []) {
            item.up?.addEventListener('click', () => moveGroup(item.group, 'up'));
            item.down?.addEventListener('click', () => moveGroup(item.group, 'down'));
        }
        elements.startButton?.addEventListener('click', start);
        elements.pauseButton?.addEventListener('click', () => command('pauseConverter'));
        elements.resumeButton?.addEventListener('click', () => command('resumeConverter'));
        elements.cancelButton?.addEventListener('click', () => command('cancelConverter', {
            confirmMessage: message('cancelConfirm', 'Cancel this conversion job after owned temporary files are reconciled?')
        }));
        elements.retryButton?.addEventListener('click', () => command('retryFailedConverter'));
        elements.dismissButton?.addEventListener('click', () => command('dismissConverterSummary'));
    }

    async function initialize() {
        if (initialized) return controller;
        initialized = true;
        bind();
        if (typeof api.onConverterProgress === 'function') unsubscribe = api.onConverterProgress(handleProgress);
        if (subscribeLanguage) {
            unsubscribeLanguage = subscribeLanguage(() => {
                updateOutputMode();
                render();
            });
        }
        try {
            updateCapabilities(unwrap(await api.getConverterCapabilities()));
            const current = unwrap(await api.getCurrentConverterJob());
            if (current) applySnapshot(current, current.revision);
            else render();
        } catch (error) {
            notify(describeError(error), { type: 'error' });
            render();
        }
        return controller;
    }

    const controller = Object.freeze({
        init() {
            if (!initPromise) initPromise = initialize();
            return initPromise;
        },
        setVisible(nextVisible) { visible = Boolean(nextVisible); },
        get visible() { return visible; },
        get snapshot() { return snapshot; },
        destroy() {
            unsubscribe?.();
            unsubscribe = null;
            unsubscribeLanguage?.();
            unsubscribeLanguage = null;
        }
    });
    return controller;
}

function createSidebarPanelSwitcher(options = {}) {
    const validPanels = new Set(['clips', 'drives', 'converter']);
    const tabs = options.tabs || [];
    let converterOpened = false;
    let converterPromise = null;
    async function switchSidebarPanel(panel) {
        if (!validPanels.has(panel)) return false;
        const converterActive = panel === 'converter';
        if (options.clipList) options.clipList.style.display = panel === 'clips' ? '' : 'none';
        if (options.driveList) options.driveList.style.display = panel === 'drives' ? '' : 'none';
        if (options.workspace) options.workspace.hidden = !converterActive;
        options.body?.classList?.toggle('converter-mode', converterActive);
        if (options.clipFilter) options.clipFilter.style.display = panel === 'clips' ? '' : 'none';
        if (options.driveFilter) options.driveFilter.style.display = panel === 'drives' ? '' : 'none';
        if (options.chooseFolderButton) options.chooseFolderButton.hidden = converterActive;
        for (const tab of tabs) {
            const active = tab.dataset?.panel === panel;
            tab.classList?.toggle('active', active);
            tab.setAttribute?.('aria-selected', active ? 'true' : 'false');
            tab.setAttribute?.('tabindex', active ? '0' : '-1');
        }
        if (panel === 'drives') options.onDrivesOpen?.();
        if (converterActive && !converterOpened) {
            converterOpened = true;
            converterPromise = Promise.resolve(options.onConverterOpen?.());
        }
        if (converterActive && converterPromise) await converterPromise;
        options.onPanelChange?.(panel);
        return true;
    }
    tabs.forEach((tab, index) => tab.addEventListener?.('keydown', async (event) => {
        let nextIndex = null;
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = tabs.length - 1;
        if (nextIndex === null) return;
        event.preventDefault?.();
        const nextTab = tabs[nextIndex];
        await switchSidebarPanel(nextTab.dataset?.panel);
        nextTab.focus?.();
    }));
    return switchSidebarPanel;
}

function initFootageConverter(options = {}) {
    const controller = createFootageConverterController({
        api: options.api || globalThis.window?.electronAPI,
        root: options.root || globalThis.document,
        notify: options.notify,
        t: options.t,
        getLocale: options.getLocale,
        onLanguageChange: options.onLanguageChange,
        confirm: options.confirm
    });
    return controller.init().then(() => controller);
}

export {
    createFootageConverterController,
    createSidebarPanelSwitcher,
    formatBytes,
    initFootageConverter
};
