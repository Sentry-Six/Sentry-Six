const { app, ipcMain } = require('electron');
const crypto = require('crypto');
const https = require('https');

// AI Support client for the Sentry Six gateway.
//
// The main process owns everything the gateway treats as trusted client
// metadata: the product ID, installed version, platform/architecture context,
// and the disclosure version. The renderer supplies only the user's text, the
// conversation it already holds, and its explicit decisions. Only fixed routes
// under /ai-support are reachable, and redirects are never followed.

const SUPPORT_SERVER_URL = 'https://api.sentry-six.com';
const AI_PRODUCT_ID = 'sentry-studio';
const AI_DISCLOSURE_VERSION = 'studio-ai-support-2026-10-31';
const AI_FILE_CONSENT_VERSION = 'diagnostic-upload-v1';
const AI_DIAGNOSTIC_FILE_NAME = 'sentry-studio-diagnostics.txt';
const AI_MAX_MESSAGE_CHARS = 5000;
const AI_MAX_RESPONSE_BYTES = 1024 * 1024;
const AI_MAX_DIAGNOSTIC_BYTES = 2 * 1024 * 1024;
const AI_GENERATION_TIMEOUT_MS = 120000;
const AI_READ_TIMEOUT_MS = 15000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_.~-]{16,256}$/;
// Also used as the Idempotency-Key, which the gateway requires to be random
// and at least 22 base64url characters; retries reuse the same ID.
const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{22,80}$/;
const KNOWN_PLATFORMS = ['darwin', 'win32', 'linux'];
const KNOWN_ARCHITECTURES = ['x64', 'arm64', 'ia32', 'arm'];

class SupportRequestError extends Error {
  constructor(message, status = 0, code = undefined) {
    super(message);
    this.name = 'SupportRequestError';
    this.status = status;
    this.code = code;
  }
}

function invalid(message) {
  return new SupportRequestError(message, 400);
}

function installedClientVersion() {
  const version = String(app.getVersion() || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version) ? version : 'unknown';
}

/** Only the fields the gateway's `sentry-studio` context schema accepts. */
function safeDeviceContext(platform = process.platform, arch = process.arch) {
  return {
    platform: KNOWN_PLATFORMS.includes(platform) ? platform : 'unknown',
    arch: KNOWN_ARCHITECTURES.includes(arch) ? arch : 'unknown',
  };
}

function requireConversation(conversation) {
  if (!conversation || typeof conversation !== 'object' ||
      !UUID_PATTERN.test(String(conversation.id || '')) ||
      !TOKEN_PATTERN.test(String(conversation.authToken || ''))) {
    throw invalid('A valid support conversation is required');
  }
  return { id: conversation.id, authToken: conversation.authToken };
}

function requireMessage(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > AI_MAX_MESSAGE_CHARS) {
    throw invalid(`${field} must contain 1 to ${AI_MAX_MESSAGE_CHARS} characters`);
  }
  return value;
}

function requireClientMessageId(value) {
  if (typeof value !== 'string' || !CLIENT_MESSAGE_ID_PATTERN.test(value)) {
    throw invalid('Invalid client message ID');
  }
  return value;
}

function requireRequestIndex(value) {
  if (!Number.isInteger(value) || value < 0 || value > 9) throw invalid('Invalid file request index');
  return value;
}

/** Builds the exact create body: product metadata never comes from the renderer. */
function buildCreateBody(input) {
  const value = input && typeof input === 'object' ? input : {};
  if (value.disclosureAccepted !== true) throw invalid('Online AI disclosure acknowledgement is required');
  if (value.disclosureVersion !== AI_DISCLOSURE_VERSION) {
    throw new SupportRequestError('The AI Support disclosure must be refreshed', 409, 'disclosure_required');
  }
  return {
    productId: AI_PRODUCT_ID,
    clientVersion: installedClientVersion(),
    deviceContext: safeDeviceContext(),
    message: requireMessage(value.message, 'message'),
    clientMessageId: requireClientMessageId(value.clientMessageId),
    disclosureAccepted: true,
    disclosureVersion: AI_DISCLOSURE_VERSION,
  };
}

function buildMultipart(fields, file) {
  const boundary = `----SentryStudio${crypto.randomBytes(12).toString('hex')}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      'utf8'
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
    'Content-Type: text/plain\r\n\r\n',
    'utf8'
  ));
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function makeAiRequest({ method, path, body = null, contentType = null, authToken = null, idempotency = null, timeoutMs = AI_READ_TIMEOUT_MS }, transport = https) {
  if (!/^\/ai-support\/conversations(?:\/[0-9a-f-]{36}(?:\/(?:messages|file-decisions|files))?)?(?:\?since=[0-9a-f-]{36})?$/i.test(path)) {
    return Promise.reject(invalid('Unsupported AI Support route'));
  }
  return new Promise((resolve, reject) => {
    const url = new URL(path, SUPPORT_SERVER_URL);
    const headers = { 'X-Sentry-Product': AI_PRODUCT_ID, Accept: 'application/json' };
    if (authToken) headers['X-Auth-Token'] = authToken;
    if (idempotency) headers['Idempotency-Key'] = idempotency;
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
    if (payload) {
      headers['Content-Type'] = contentType || 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      family: 0,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400) {
        res.resume();
        reject(new SupportRequestError('AI Support server returned an unexpected redirect', 502));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > AI_MAX_RESPONSE_BYTES) {
          req.destroy();
          reject(new SupportRequestError('AI Support response exceeded the safety limit', 502));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { data = null; }
        if (status >= 200 && status < 300 && data && typeof data === 'object') {
          resolve(data);
          return;
        }
        const message = data && typeof data.error === 'string'
          ? data.error.slice(0, 300)
          : `AI Support server error (${status})`;
        const code = data && typeof data.code === 'string' ? data.code.slice(0, 64) : undefined;
        reject(new SupportRequestError(message, status, code));
      });
    });
    req.on('error', () => reject(new SupportRequestError('AI Support server is unavailable', 0)));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new SupportRequestError('AI Support request timed out', 0));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function createAiSupportClient(transport = https) {
  const request = (options) => makeAiRequest(options, transport);
  return {
    async createConversation(input) {
      const body = buildCreateBody(input);
      return request({
        method: 'POST',
        path: '/ai-support/conversations',
        body,
        idempotency: body.clientMessageId,
        timeoutMs: AI_GENERATION_TIMEOUT_MS,
      });
    },
    async fetchMessages({ conversation }) {
      const active = requireConversation(conversation);
      return request({
        method: 'GET',
        path: `/ai-support/conversations/${active.id}/messages`,
        authToken: active.authToken,
      });
    },
    async sendMessage({ conversation, content, clientMessageId }) {
      const active = requireConversation(conversation);
      return request({
        method: 'POST',
        path: `/ai-support/conversations/${active.id}/messages`,
        authToken: active.authToken,
        body: { content: requireMessage(content, 'content'), clientMessageId: requireClientMessageId(clientMessageId) },
        idempotency: clientMessageId,
        timeoutMs: AI_GENERATION_TIMEOUT_MS,
      });
    },
    async deleteConversation({ conversation }) {
      const active = requireConversation(conversation);
      return request({
        method: 'DELETE',
        path: `/ai-support/conversations/${active.id}`,
        authToken: active.authToken,
        // A stable key lets a lost deletion response be retried safely.
        idempotency: crypto.createHash('sha256').update(`delete\0${active.id}`).digest('base64url'),
      });
    },
    async decideFileRequest({ conversation, messageId, requestIndex, decision }) {
      const active = requireConversation(conversation);
      if (!UUID_PATTERN.test(String(messageId || ''))) throw invalid('Invalid message ID');
      if (!['approved', 'denied'].includes(decision)) throw invalid('File decision must be approved or denied');
      return request({
        method: 'POST',
        path: `/ai-support/conversations/${active.id}/file-decisions`,
        authToken: active.authToken,
        body: { messageId, requestIndex: requireRequestIndex(requestIndex), decision, consentVersion: AI_FILE_CONSENT_VERSION },
        idempotency: `decision-${messageId}-${requestIndex}-${decision}`,
      });
    },
    async uploadDiagnostics({ conversation, messageId, requestIndex, uploadToken, report }) {
      const active = requireConversation(conversation);
      if (!UUID_PATTERN.test(String(messageId || ''))) throw invalid('Invalid message ID');
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(String(uploadToken || ''))) throw invalid('Invalid upload token');
      if (typeof report !== 'string' || !report.trim()) throw invalid('The diagnostics report is empty');
      const data = Buffer.from(report, 'utf8');
      if (data.length > AI_MAX_DIAGNOSTIC_BYTES) throw invalid('Diagnostics exceed the approved 2 MB limit');
      const multipart = buildMultipart({
        uploadToken,
        messageId,
        requestIndex: String(requireRequestIndex(requestIndex)),
        kind: 'diagnostics',
        consentVersion: AI_FILE_CONSENT_VERSION,
      }, { name: AI_DIAGNOSTIC_FILE_NAME, data });
      return request({
        method: 'POST',
        path: `/ai-support/conversations/${active.id}/files`,
        authToken: active.authToken,
        body: multipart.body,
        contentType: multipart.contentType,
        idempotency: `upload-${messageId}-${requestIndex}`,
        timeoutMs: AI_GENERATION_TIMEOUT_MS,
      });
    },
  };
}

function toIpcResult(promise) {
  return promise.then(
    (data) => ({ success: true, data }),
    (error) => ({
      success: false,
      error: error && error.message ? error.message : 'AI Support request failed',
      status: error && Number.isInteger(error.status) ? error.status : 0,
      code: error && error.code ? error.code : undefined,
    })
  );
}

function registerSupportChatIpc(client = createAiSupportClient()) {
  ipcMain.handle('aiSupport:createConversation', (_event, input) => toIpcResult(client.createConversation(input)));
  ipcMain.handle('aiSupport:fetchMessages', (_event, input) => toIpcResult(client.fetchMessages(input || {})));
  ipcMain.handle('aiSupport:sendMessage', (_event, input) => toIpcResult(client.sendMessage(input || {})));
  ipcMain.handle('aiSupport:deleteConversation', (_event, input) => toIpcResult(client.deleteConversation(input || {})));
  ipcMain.handle('aiSupport:decideFileRequest', (_event, input) => toIpcResult(client.decideFileRequest(input || {})));
  ipcMain.handle('aiSupport:uploadDiagnostics', (_event, input) => toIpcResult(client.uploadDiagnostics(input || {})));
}

module.exports = {
  AI_DISCLOSURE_VERSION,
  AI_PRODUCT_ID,
  SUPPORT_SERVER_URL,
  buildCreateBody,
  buildMultipart,
  createAiSupportClient,
  makeAiRequest,
  registerSupportChatIpc,
  safeDeviceContext,
};
