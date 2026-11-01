/**
 * AI Support chat (Sentry Assistant).
 *
 * The panel talks to the Sentry Six AI Support gateway through the main
 * process, which adds the product, version, and platform context. Message and
 * assistant text is only ever inserted with textContent; no server text is
 * parsed as HTML. Diagnostics are collected only after the user approves a
 * specific request in the chat.
 */

import { collectDiagnostics } from './diagnostics.js';
import { t } from '../lib/i18n.js';
import { escapeHtml } from '../lib/utils.js';

const $ = id => document.getElementById(id);

export const SUPPORT_DISCLOSURE_VERSION = 'studio-ai-support-2026-10-31';
const STORAGE_KEY = 'aiSupportConversation';
const LEGACY_TICKET_KEY = 'supportTicket';
const DISCORD_URL = 'https://discord.gg/9QZEzVwdnt';
const PRIVACY_URL = 'https://sentry-six.com/privacy';
const MESSAGE_LIMIT = 5000;
const DIAGNOSTIC_HARD_LIMIT = 2 * 1024 * 1024;
const STORED_CONVERSATION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

const state = {
    conversation: null,          // { id, authToken }
    disclosureAccepted: false,
    requiresDisclosureReset: false,
    messages: [],
    status: 'idle',              // idle | generating | closed
    sending: false,
    error: null,
    fileStates: {},              // `${messageId}:${index}` -> { phase, detail, retryDecision }
    pending: null,               // { content, clientMessageId } for a retried send
};
let chatInitialized = false;
let storageLoaded = null;
let pollTimer = null;

class SupportApiError extends Error {
    constructor(message, status = 0, code = undefined) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

async function call(method, payload) {
    const api = window.electronAPI;
    if (!api || typeof api[method] !== 'function') throw new SupportApiError('AI Support is unavailable in this build');
    const result = await api[method](payload);
    if (!result || result.success !== true) {
        throw new SupportApiError(result?.error || 'AI Support request failed', result?.status || 0, result?.code);
    }
    return result.data || {};
}

/** Mirrors the reset rules of the other Sentry Six AI Support clients. */
export function resetReason(error) {
    if (!(error instanceof SupportApiError)) return null;
    if ([401, 404, 410].includes(error.status)) return 'unavailable';
    if (error.status === 409 && (error.code === 'disclosure_required' || /disclosure/i.test(error.message))) return 'disclosure';
    return null;
}

function clientMessageId() {
    return `client-${crypto.randomUUID()}`;
}

function normalizedStatus(value) {
    return value === 'generating' || value === 'closed' ? value : 'idle';
}

export function mergeMessages(current, incoming) {
    if (!Array.isArray(incoming) || incoming.length === 0) return current;
    const next = [...current];
    for (const message of incoming) {
        if (!message || typeof message.id !== 'string') continue;
        const exact = next.findIndex(item => item.id === message.id);
        if (exact >= 0) { next[exact] = message; continue; }
        if (message.role === 'user') {
            const optimistic = next.findIndex(item => item.id.startsWith('client-') && item.role === 'user' && item.content === message.content);
            if (optimistic >= 0) { next[optimistic] = message; continue; }
        }
        next.push(message);
    }
    return next.sort((a, b) => {
        const aTime = Date.parse(a.createdAt);
        const bTime = Date.parse(b.createdAt);
        return Number.isFinite(aTime) && Number.isFinite(bTime) ? aTime - bTime : 0;
    });
}

/**
 * Serializes the existing (already redacted) diagnostics bundle and trims the
 * oldest log entries until it fits the approved size.
 */
export function diagnosticsReport(diagnostics, maxBytes) {
    const limit = Math.min(Number(maxBytes) || DIAGNOSTIC_HARD_LIMIT, DIAGNOSTIC_HARD_LIMIT);
    const copy = JSON.parse(JSON.stringify(diagnostics || {}));
    const encoder = new TextEncoder();
    const header = 'Sentry Studio diagnostics (user names in paths and logged locations redacted)\n';
    const render = () => `${header}${JSON.stringify(copy, null, 1)}\n`;
    const lists = [
        () => copy.logs?.console,
        () => copy.terminalLogs,
        () => copy.logs?.errors,
    ];
    let report = render();
    for (const list of lists) {
        while (encoder.encode(report).length > limit) {
            const entries = list();
            if (!Array.isArray(entries) || entries.length === 0) break;
            entries.splice(0, Math.max(1, Math.ceil(entries.length / 10)));
            report = render();
        }
    }
    if (encoder.encode(report).length > limit) throw new Error('Diagnostics exceed the approved 2 MB limit');
    return report;
}

function filePolicyIssue(request) {
    if (!request || request.kind !== 'diagnostics') return 'This file type is not available to AI Support.';
    if (request.retentionDays !== 7) return 'This request does not match the required 7-day retention policy.';
    if (!Number.isFinite(request.maxBytes) || request.maxBytes <= 0) return 'This request has an invalid size limit.';
    return null;
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return 'Unknown size';
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.ceil(bytes / 1024)} KB`;
}

// ---- Persistence --------------------------------------------------------

async function loadStoredConversation() {
    const api = window.electronAPI;
    if (!api?.getSetting) return;
    try {
        // Older releases stored a human-support ticket; that chat is retired.
        if (await api.getSetting(LEGACY_TICKET_KEY)) await api.setSetting(LEGACY_TICKET_KEY, null);
        const stored = await api.getSetting(STORAGE_KEY);
        const age = Date.now() - Number(stored?.storedAt);
        if (!stored || typeof stored.id !== 'string' || typeof stored.authToken !== 'string' ||
            !Number.isFinite(age) || age < 0 || age > STORED_CONVERSATION_MAX_AGE_MS) {
            if (stored) await api.setSetting(STORAGE_KEY, null);
            return;
        }
        state.conversation = { id: stored.id, authToken: stored.authToken };
        state.disclosureAccepted = stored.disclosureVersion === SUPPORT_DISCLOSURE_VERSION;
        state.requiresDisclosureReset = !state.disclosureAccepted;
    } catch (error) {
        console.error('[AISupport] Could not load the saved conversation:', error?.message);
    }
}

function persistConversation(conversation) {
    const api = window.electronAPI;
    if (!api?.setSetting) return;
    const value = conversation
        ? { ...conversation, storedAt: Date.now(), disclosureVersion: SUPPORT_DISCLOSURE_VERSION }
        : null;
    Promise.resolve(api.setSetting(STORAGE_KEY, value)).catch(() => {});
}

function resetConversation({ error = null, keepDisclosure = false } = {}) {
    stopPolling();
    persistConversation(null);
    state.conversation = null;
    state.messages = [];
    state.status = 'idle';
    state.fileStates = {};
    state.pending = null;
    state.requiresDisclosureReset = false;
    state.disclosureAccepted = keepDisclosure && state.disclosureAccepted;
    state.error = error;
}

function handleResetError(error, unavailableMessage) {
    const reason = resetReason(error);
    if (reason === 'disclosure' && state.conversation) {
        stopPolling();
        state.requiresDisclosureReset = true;
        state.disclosureAccepted = false;
        state.status = 'idle';
        state.error = null;
        return true;
    }
    if (reason === 'unavailable') {
        resetConversation({ error: unavailableMessage });
        return true;
    }
    return false;
}

// ---- Server interaction -------------------------------------------------

function applyResult(data) {
    state.messages = mergeMessages(state.messages, data.messages);
    state.status = normalizedStatus(data.status);
    if (state.status === 'generating') startPolling(); else stopPolling();
}

async function refreshConversation() {
    if (!state.conversation || state.requiresDisclosureReset) return;
    try {
        applyResult(await call('aiSupportFetchMessages', { conversation: state.conversation }));
        state.error = null;
    } catch (error) {
        if (!handleResetError(error, 'This saved support conversation is no longer available. Start a new chat to continue.')) {
            state.error = error.message || 'Could not refresh this conversation.';
        }
    }
    render();
}

function startPolling() {
    if (pollTimer) return;
    pollTimer = setTimeout(async function tick() {
        pollTimer = null;
        if (!state.conversation || state.status !== 'generating') return;
        try {
            applyResult(await call('aiSupportFetchMessages', { conversation: state.conversation }));
        } catch (error) {
            handleResetError(error, 'This support conversation is no longer available. Start a new chat to continue.');
            // Other transient failures retry on the next tick.
            if (state.status === 'generating' && !pollTimer) pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
        }
        render();
    }, POLL_INTERVAL_MS);
}

function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
}

export async function sendMessage(rawContent) {
    const content = String(rawContent || '').trim();
    if (!content || state.sending || state.requiresDisclosureReset || state.status !== 'idle') return false;
    if (!state.conversation && !state.disclosureAccepted) {
        state.error = 'Please confirm the AI Support notice before sending.';
        render();
        return false;
    }
    const input = $('supportMessageInput');
    if (input) { input.value = ''; $('supportCharCount').textContent = '0'; }
    const pending = state.pending?.content === content ? state.pending : { content, clientMessageId: clientMessageId() };
    state.pending = pending;
    state.messages = [...state.messages, { id: pending.clientMessageId, role: 'user', content, createdAt: new Date().toISOString() }];
    state.sending = true;
    state.status = 'generating';
    state.error = null;
    render();
    try {
        if (!state.conversation) {
            const data = await call('aiSupportCreateConversation', {
                message: content,
                clientMessageId: pending.clientMessageId,
                disclosureAccepted: true,
                disclosureVersion: SUPPORT_DISCLOSURE_VERSION,
            });
            if (!data.id || !data.authToken) throw new SupportApiError('The support server returned an incomplete conversation');
            state.conversation = { id: data.id, authToken: data.authToken };
            persistConversation(state.conversation);
            applyResult(data);
        } else {
            const data = await call('aiSupportSendMessage', {
                conversation: state.conversation,
                content,
                clientMessageId: pending.clientMessageId,
            });
            persistConversation(state.conversation);
            applyResult(data);
        }
        state.pending = null;
        return true;
    } catch (error) {
        state.messages = state.messages.filter(message => message.id !== pending.clientMessageId);
        state.status = 'idle';
        if (!handleResetError(error, 'This support conversation is no longer available. Confirm the notice to start a new chat.')) {
            state.error = error.message || 'The message could not be sent.';
        }
        if (input) { input.value = content; $('supportCharCount').textContent = String(content.length); }
        return false;
    } finally {
        state.sending = false;
        render();
    }
}

export async function startNewConversation({ confirmFirst = true } = {}) {
    if (!state.conversation) return false;
    if (confirmFirst && !window.confirm('Delete this conversation from Sentry Six servers and start a new one? Any diagnostics approved for it are deleted too. This cannot be undone.')) {
        return false;
    }
    try {
        await call('aiSupportDeleteConversation', { conversation: state.conversation });
        resetConversation();
    } catch (error) {
        if ([404, 410].includes(error.status)) {
            resetConversation();
        } else {
            state.error = `${error.message || 'The delete request failed.'} Deletion was not verified. Retry, or contact privacy@sentry-six.com; any server copy otherwise expires under the retention policy.`;
        }
    }
    render();
    return true;
}

function forgetConversation() {
    resetConversation();
    render();
}

export async function decideFileRequest(messageId, requestIndex, request, decision) {
    if (!state.conversation) return;
    const key = `${messageId}:${requestIndex}`;
    const issue = filePolicyIssue(request);
    if (decision === 'approved' && issue) {
        state.fileStates[key] = { phase: 'error', detail: issue };
        render();
        return;
    }
    state.fileStates[key] = { phase: decision === 'approved' ? 'approving' : 'denying' };
    render();
    try {
        const decided = await call('aiSupportDecideFileRequest', {
            conversation: state.conversation, messageId, requestIndex, decision,
        });
        persistConversation(state.conversation);
        if (decision === 'denied') {
            state.fileStates[key] = { phase: 'denied' };
            return;
        }
        if (!decided.uploadToken) throw new Error('No one-time upload token was returned');
        const limit = Math.min(request.maxBytes, decided.maxBytes || request.maxBytes, DIAGNOSTIC_HARD_LIMIT);
        // Consent is recorded first; only this explicit approval collects diagnostics.
        const report = diagnosticsReport(await collectDiagnostics(), limit);
        const uploaded = await call('aiSupportUploadDiagnostics', {
            conversation: state.conversation, messageId, requestIndex, uploadToken: decided.uploadToken, report,
        });
        state.fileStates[key] = {
            phase: 'approved',
            detail: `${uploaded.fileName || request.fileName} (${formatBytes(uploaded.size)}) was shared once.`,
        };
        state.status = 'generating';
        startPolling();
    } catch (error) {
        if (!handleResetError(error, 'This support conversation is no longer available. Confirm the notice to start a new chat.')) {
            state.fileStates[key] = {
                phase: 'error',
                detail: `${error.message || 'The file was not shared.'} Nothing will retry automatically.`,
                retryDecision: decision,
            };
        }
    } finally {
        render();
    }
}

// ---- Rendering ----------------------------------------------------------

function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content != null) node.textContent = content;
    return node;
}

function icon(name, extra = '') {
    return el('span', `material-symbols-outlined ${extra}`.trim(), name);
}

function openExternal(url) {
    window.electronAPI?.openExternal?.(url);
}

function linkButton(label, url, className = 'ai-support-link') {
    const button = el('button', className);
    button.type = 'button';
    button.append(label, ' ', icon('open_in_new', 'mi-xs'));
    button.onclick = () => openExternal(url);
    return button;
}

function renderInline(parent, line) {
    for (const piece of line.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)) {
        if (!piece) continue;
        if (piece.startsWith('**') && piece.endsWith('**') && piece.length > 4) parent.append(el('strong', null, piece.slice(2, -2)));
        else if (piece.startsWith('`') && piece.endsWith('`') && piece.length > 2) parent.append(el('code', null, piece.slice(1, -1)));
        else parent.append(document.createTextNode(piece));
    }
}

/** A small Markdown subset (paragraphs, lists, bold, code) built as DOM nodes. */
export function renderAssistantContent(content) {
    const root = el('div', 'ai-support-markdown');
    let list = null;
    let paragraph = null;
    for (const raw of String(content || '').replace(/\r\n?/g, '\n').split('\n')) {
        const line = raw.trimEnd();
        const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
        if (ordered || bullet) {
            paragraph = null;
            const tag = ordered ? 'OL' : 'UL';
            if (!list || list.tagName !== tag) { list = el(tag.toLowerCase()); root.append(list); }
            const item = el('li');
            renderInline(item, (ordered ? ordered[1] : bullet[1]).trim());
            list.append(item);
            continue;
        }
        if (!line.trim()) { list = null; paragraph = null; continue; }
        list = null;
        if (!paragraph) { paragraph = el('p'); root.append(paragraph); } else paragraph.append(el('br'));
        renderInline(paragraph, line.trim());
    }
    return root;
}

function renderDisclosure(container) {
    const gate = el('div', 'ai-support-gate');
    gate.append(icon('shield', 'mi-xl'), el('h3', null, 'Before you chat'));
    gate.append(el('p', null, 'Sentry Assistant is an online AI assistant. Your messages, the Sentry Studio version, operating system and CPU type go to Sentry Six, and Anthropic processes them to write each answer. Your public IP is used for abuse prevention.'));
    gate.append(el('p', 'muted', 'Chats are redacted and stored on Sentry Six servers in Canada for up to 90 days after your last message, and authorized maintainers may review them to improve support. New chat deletes the current chat.'));
    gate.append(el('p', 'muted', 'Diagnostics are shared only when you approve a request, and are deleted within 7 days. AI can be wrong and cannot approve refunds or warranty claims; Discord is always available for help from a person.'));
    gate.append(el('p', 'muted', 'Keep passwords and other secrets out of the chat.'));
    const accept = el('button', 'ai-support-primary', 'Acknowledge & continue');
    accept.type = 'button';
    accept.id = 'aiSupportAcknowledge';
    accept.onclick = () => { state.disclosureAccepted = true; state.error = null; render(); };
    gate.append(accept, linkButton('Privacy policy', PRIVACY_URL));
    container.append(gate);
}

function renderDisclosureRefresh(container) {
    const gate = el('div', 'ai-support-gate');
    gate.append(icon('shield', 'mi-xl'), el('h3', null, 'AI Support privacy update'));
    gate.append(el('p', null, 'Your saved chat used an earlier notice, so it cannot continue. Delete it to see the current notice and start a new chat.'));
    if (state.error) gate.append(el('p', 'ai-support-error-text', state.error));
    const remove = el('button', 'ai-support-danger', 'Delete old chat & continue');
    remove.type = 'button';
    remove.onclick = () => { void startNewConversation({ confirmFirst: false }); };
    gate.append(remove);
    if (state.error) {
        const forget = el('button', 'ai-support-secondary', 'Forget local access without verified deletion');
        forget.type = 'button';
        forget.onclick = forgetConversation;
        gate.append(forget);
    }
    gate.append(linkButton('Privacy policy', PRIVACY_URL));
    container.append(gate);
}

function renderFileRequest(message, request, index) {
    const key = `${message.id}:${index}`;
    const fileState = state.fileStates[key] || { phase: 'idle' };
    const card = el('section', 'ai-support-file-card');
    card.append(el('p', 'title', 'AI requests one-time access'));
    card.append(el('p', null, request.label || 'Sentry Studio diagnostics'));
    const facts = el('dl');
    for (const [label, value] of [
        ['File', `${request.fileName} · max ${formatBytes(Math.min(request.maxBytes, DIAGNOSTIC_HARD_LIMIT))}`],
        ['Destination', 'api.sentry-six.com · Sentry Six support servers'],
        ['AI processing', 'Processed by Anthropic for this answer'],
        ['Retention', 'Deleted within 7 days'],
    ]) facts.append(el('dt', null, label), el('dd', null, value));
    card.append(facts);
    card.append(el('p', 'muted', 'Includes the app version, operating system, CPU, memory and GPU details, FFmpeg detection, update status, a few app settings, and recent app logs. User names in file paths and logged locations are redacted on this computer first. Collected and uploaded only after you approve.'));
    const issue = filePolicyIssue(request);
    if (fileState.phase === 'idle') {
        if (issue) card.append(el('p', 'ai-support-error-text', issue));
        const row = el('div', 'ai-support-actions');
        const approve = el('button', 'ai-support-approve', 'Collect & upload diagnostics once');
        approve.type = 'button';
        approve.disabled = Boolean(issue);
        approve.onclick = () => { void decideFileRequest(message.id, index, request, 'approved'); };
        const deny = el('button', 'ai-support-secondary', 'Deny');
        deny.type = 'button';
        deny.onclick = () => { void decideFileRequest(message.id, index, request, 'denied'); };
        row.append(approve, deny);
        card.append(row);
    } else if (fileState.phase === 'approving' || fileState.phase === 'denying') {
        card.append(el('p', 'status', fileState.phase === 'approving' ? 'Preparing and sharing approved diagnostics…' : 'Saving your decision…'));
    } else if (fileState.phase === 'approved') {
        card.append(el('p', 'success', fileState.detail || 'Diagnostics shared once.'));
    } else if (fileState.phase === 'denied') {
        card.append(el('p', 'muted', 'Denied. Nothing was collected or uploaded.'));
    } else {
        card.append(el('p', 'ai-support-error-text', fileState.detail || 'The file was not shared.'));
        if (fileState.retryDecision) {
            const retry = el('button', 'ai-support-secondary', fileState.retryDecision === 'approved' ? 'Try upload again' : 'Try deny again');
            retry.type = 'button';
            retry.onclick = () => { void decideFileRequest(message.id, index, request, fileState.retryDecision); };
            card.append(retry);
        }
    }
    return card;
}

function renderMessage(message) {
    const isUser = message.role === 'user';
    const row = el('div', `chat-message-row ${isUser ? 'user-row' : 'support-row'}`);
    row.dataset.msgId = message.id;
    const bubble = el('div', `chat-message ${isUser ? 'user-message' : 'support-message'}`);
    if (!isUser) bubble.append(el('div', 'message-sender-name', 'Sentry Assistant'));
    const body = el('div', 'message-content');
    if (isUser) body.append(el('p', null, message.content));
    else body.append(renderAssistantContent(message.content));
    bubble.append(body);
    const time = new Date(message.createdAt);
    const meta = el('div', 'message-meta');
    meta.append(el('span', 'message-time', Number.isNaN(time.getTime()) ? '' : time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    bubble.append(meta);
    if (!isUser) {
        (message.actions?.fileRequests || []).forEach((request, index) => bubble.append(renderFileRequest(message, request, index)));
        if (message.actions?.suggestDiscord) {
            const help = el('div', 'ai-support-discord');
            help.append(el('p', 'title', 'Want help from a person?'));
            help.append(el('p', 'muted', 'Join the Sentry Six Discord community. This AI conversation is not transferred; share only what you choose.'));
            help.append(linkButton('Join Discord', DISCORD_URL));
            bubble.append(help);
        }
    }
    const avatar = el('div', `message-avatar ${isUser ? 'avatar-user' : 'avatar-support'}`, isUser ? 'You' : 'AI');
    if (isUser) row.append(bubble, avatar); else row.append(avatar, bubble);
    return row;
}

function renderWelcome(container) {
    const welcome = el('div', 'support-chat-welcome');
    const iconWrap = el('div', 'welcome-icon');
    iconWrap.append(icon('smart_toy', 'mi-xxl'));
    welcome.append(iconWrap, el('h3', null, 'What can I help with?'));
    welcome.append(el('p', null, 'Sentry Assistant answers Sentry Studio questions from Sentry Six\'s public documentation, and can read a diagnostics report when you approve one.'));
    container.append(welcome);
}

function render() {
    const panel = $('supportChatPanel');
    if (!panel) return;
    const messagesEl = $('supportChatMessages');
    const composer = $('supportChatComposer');
    const newChat = $('aiSupportNewChat');
    messagesEl.replaceChildren();

    const gated = (state.conversation && state.requiresDisclosureReset) || (!state.conversation && !state.disclosureAccepted);
    if (state.conversation && state.requiresDisclosureReset) renderDisclosureRefresh(messagesEl);
    else if (!state.conversation && !state.disclosureAccepted) renderDisclosure(messagesEl);
    else if (state.messages.length === 0) renderWelcome(messagesEl);
    else state.messages.forEach(message => messagesEl.append(renderMessage(message)));

    if (!gated && state.status === 'generating') {
        const typing = el('div', 'chat-message-row support-row ai-support-typing');
        typing.setAttribute('role', 'status');
        typing.append(el('div', 'message-avatar avatar-support', 'AI'), el('div', 'chat-message support-message', 'Sentry Assistant is preparing a response…'));
        messagesEl.append(typing);
    }

    composer.classList.toggle('hidden', Boolean(gated));
    newChat.classList.toggle('hidden', !state.conversation || state.requiresDisclosureReset);
    const fileBusy = Object.values(state.fileStates).some(item => item.phase === 'approving' || item.phase === 'denying');
    const locked = state.sending || fileBusy || state.status !== 'idle' || state.requiresDisclosureReset;
    const input = $('supportMessageInput');
    input.disabled = locked;
    input.placeholder = state.status === 'generating' ? 'Waiting for Sentry Assistant…' : 'Ask about Sentry Studio…';
    $('supportSendBtn').disabled = locked;
    const status = $('supportChatStatus');
    if (state.error && !gated) {
        status.textContent = state.error;
        status.className = 'support-chat-status error';
    } else {
        status.className = 'support-chat-status hidden';
    }
    if (state.status === 'closed') {
        status.textContent = 'This conversation is closed. Use New chat to delete it and start again.';
        status.className = 'support-chat-status';
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function createSupportChatPanel() {
    const panel = document.createElement('div');
    panel.id = 'supportChatPanel';
    panel.className = 'support-chat-panel hidden';
    panel.innerHTML = `
        <div class="support-chat-header">
            <div class="support-chat-title">
                <span class="material-symbols-outlined mi-md">support_agent</span>
                <span>${escapeHtml('AI Support')}</span>
            </div>
            <div class="support-chat-actions">
                <button id="aiSupportDiscord" class="support-chat-btn" title="${escapeHtml('Join Discord')}">
                    <span class="material-symbols-outlined mi-sm">groups</span>
                </button>
                <button id="aiSupportNewChat" class="support-chat-btn hidden" title="${escapeHtml('New chat')}">
                    <span class="material-symbols-outlined mi-sm">restart_alt</span>
                </button>
                <button id="supportChatMinimize" class="support-chat-btn" title="${escapeHtml(t('ui.supportChat.minimize'))}">
                    <span class="material-symbols-outlined mi-sm">remove</span>
                </button>
                <button id="supportChatClose" class="support-chat-btn" title="${escapeHtml(t('ui.supportChat.closePanel'))}">
                    <span class="material-symbols-outlined mi-sm">close</span>
                </button>
            </div>
        </div>
        <div id="supportChatMessages" class="support-chat-messages" aria-live="polite"></div>
        <div id="supportChatComposer" class="support-chat-composer">
            <div class="composer-input-row">
                <textarea id="supportMessageInput" class="composer-textarea" rows="3" maxlength="${MESSAGE_LIMIT}"></textarea>
                <button id="supportSendBtn" class="composer-send-btn" title="${escapeHtml(t('ui.supportChat.sendMessage'))}">
                    <span class="material-symbols-outlined mi-md">send</span>
                </button>
            </div>
            <div class="composer-footer">
                <span class="char-count"><span id="supportCharCount">0</span>/${MESSAGE_LIMIT}</span>
                <span class="privacy-note">
                    <span class="material-symbols-outlined">security</span>
                    <span>${escapeHtml('AI answers · redacted chats kept up to 90 days')}</span>
                </span>
            </div>
        </div>
        <div id="supportChatStatus" class="support-chat-status hidden"></div>
    `;
    document.body.appendChild(panel);
}

function initChatEventHandlers() {
    $('supportChatClose').onclick = hideSupportChat;
    $('supportChatMinimize').onclick = hideSupportChat;
    $('aiSupportDiscord').onclick = () => openExternal(DISCORD_URL);
    $('aiSupportNewChat').onclick = () => { void startNewConversation(); };
    const input = $('supportMessageInput');
    const count = $('supportCharCount');
    const submit = () => sendMessage(input.value);
    input.addEventListener('input', () => { count.textContent = String(input.value.length); });
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void submit();
        }
    });
    $('supportSendBtn').onclick = () => { void submit(); };
    initDraggablePanel();
}

function initDraggablePanel() {
    const panel = $('supportChatPanel');
    const header = panel.querySelector('.support-chat-header');
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;
    header.addEventListener('mousedown', (event) => {
        if (event.target.closest('.support-chat-actions')) return;
        dragging = true;
        panel.classList.add('dragging');
        const rect = panel.getBoundingClientRect();
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;
        event.preventDefault();
    });
    document.addEventListener('mousemove', (event) => {
        if (!dragging) return;
        const x = Math.max(0, Math.min(event.clientX - offsetX, window.innerWidth - panel.offsetWidth));
        const y = Math.max(0, Math.min(event.clientY - offsetY, window.innerHeight - panel.offsetHeight));
        panel.style.left = `${x}px`;
        panel.style.top = `${y}px`;
        panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        panel.classList.remove('dragging');
    });
}

// ---- Public API ---------------------------------------------------------

export function initSupportChat() {
    if (chatInitialized) return storageLoaded;
    chatInitialized = true;
    storageLoaded = loadStoredConversation();
    return storageLoaded;
}

export async function showSupportChat() {
    let panel = $('supportChatPanel');
    if (!panel) {
        createSupportChatPanel();
        initChatEventHandlers();
        panel = $('supportChatPanel');
    }
    panel.classList.remove('hidden');
    panel.classList.add('visible');
    render();
    await initSupportChat();
    render();
    await refreshConversation();
}

export function hideSupportChat() {
    const panel = $('supportChatPanel');
    if (!panel) return;
    panel.classList.remove('visible');
    panel.classList.add('hidden');
}

export function toggleSupportChat() {
    const panel = $('supportChatPanel');
    if (panel && panel.classList.contains('visible')) hideSupportChat();
    else void showSupportChat();
}

/**
 * Startup hook kept for the settings module. AI Support answers inline, so
 * there is nothing to poll in the background; this only loads saved state and
 * clears any retired support-ticket record.
 */
export async function checkForActiveTicket() {
    await initSupportChat();
}
