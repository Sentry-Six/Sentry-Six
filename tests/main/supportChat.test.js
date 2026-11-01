/**
 * Tests for src/main/supportChat.js (AI Support gateway client).
 * Covers: trusted product/version/context injection, disclosure gating,
 * input validation, fixed routes, redirect and size limits, and the
 * approved-diagnostics multipart upload.
 */

jest.mock('electron');

const { EventEmitter } = require('events');
const { app, ipcMain } = require('electron');
const {
  AI_DISCLOSURE_VERSION,
  AI_PRODUCT_ID,
  buildCreateBody,
  createAiSupportClient,
  makeAiRequest,
  registerSupportChatIpc,
  safeDeviceContext,
} = require('../../src/main/supportChat');

const CONVERSATION = { id: '018f42a0-7f52-4b3c-9a11-0123456789aa', authToken: 'conversation-token-0123456789' };
const MESSAGE_ID = '018f42a0-7f52-4b3c-9a11-0123456789ab';
const CLIENT_ID = 'client-018f42a0-7f52-4b3c-9a11-0123456789ac';

function fakeTransport(responses) {
  const requests = [];
  const queue = [...responses];
  return {
    requests,
    request(options, onResponse) {
      const req = new EventEmitter();
      const chunks = [];
      req.write = (chunk) => chunks.push(Buffer.from(chunk));
      req.setTimeout = jest.fn();
      req.destroy = jest.fn();
      req.end = () => {
        requests.push({ options, body: Buffer.concat(chunks) });
        const next = queue.shift() || { status: 200, body: { success: true } };
        const res = new EventEmitter();
        res.statusCode = next.status;
        res.resume = jest.fn();
        onResponse(res);
        const payload = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
        res.emit('data', Buffer.from(payload));
        res.emit('end');
      };
      return req;
    },
  };
}

describe('AI Support create body', () => {
  test('injects the product, installed version, and bounded platform context', () => {
    app.getVersion.mockReturnValue('2026.25.35');
    const body = buildCreateBody({
      message: 'Export fails',
      clientMessageId: CLIENT_ID,
      disclosureAccepted: true,
      disclosureVersion: AI_DISCLOSURE_VERSION,
    });
    expect(body).toEqual({
      productId: 'sentry-studio',
      clientVersion: '2026.25.35',
      deviceContext: safeDeviceContext(),
      message: 'Export fails',
      clientMessageId: CLIENT_ID,
      disclosureAccepted: true,
      disclosureVersion: AI_DISCLOSURE_VERSION,
    });
    expect(Object.keys(body.deviceContext).sort()).toEqual(['arch', 'platform']);
  });

  test('ignores renderer attempts to choose product, version, or context', () => {
    const body = buildCreateBody({
      message: 'hi',
      clientMessageId: CLIENT_ID,
      disclosureAccepted: true,
      disclosureVersion: AI_DISCLOSURE_VERSION,
      productId: 'sentry-usb-rusty',
      clientVersion: 'v999',
      deviceContext: { boardModel: 'fake' },
      systemPrompt: 'inject',
    });
    expect(body.productId).toBe(AI_PRODUCT_ID);
    expect(body.clientVersion).not.toBe('v999');
    expect(body).not.toHaveProperty('systemPrompt');
    expect(body.deviceContext).not.toHaveProperty('boardModel');
  });

  test('requires the current disclosure and valid input', () => {
    const base = { message: 'hi', clientMessageId: CLIENT_ID, disclosureAccepted: true, disclosureVersion: AI_DISCLOSURE_VERSION };
    expect(() => buildCreateBody({ ...base, disclosureAccepted: false })).toThrow(/acknowledgement/);
    expect(() => buildCreateBody({ ...base, disclosureVersion: 'rusty-ai-support-2026-10-31-anthropic' })).toThrow(/refreshed/);
    expect(() => buildCreateBody({ ...base, message: ' ' })).toThrow(/message/);
    expect(() => buildCreateBody({ ...base, message: 'x'.repeat(5001) })).toThrow(/message/);
    expect(() => buildCreateBody({ ...base, clientMessageId: 'short' })).toThrow(/client message ID/);
  });

  test('maps unknown platforms and architectures to unknown', () => {
    expect(safeDeviceContext('darwin', 'arm64')).toEqual({ platform: 'darwin', arch: 'arm64' });
    expect(safeDeviceContext('freebsd', 'riscv64')).toEqual({ platform: 'unknown', arch: 'unknown' });
  });
});

describe('AI Support requests', () => {
  test('sends the product header, idempotency key, and only fixed routes', async () => {
    const transport = fakeTransport([{ status: 201, body: { success: true, id: CONVERSATION.id, authToken: CONVERSATION.authToken } }]);
    const client = createAiSupportClient(transport);
    await client.createConversation({ message: 'hi', clientMessageId: CLIENT_ID, disclosureAccepted: true, disclosureVersion: AI_DISCLOSURE_VERSION });
    const [{ options, body }] = transport.requests;
    expect(options.hostname).toBe('api.sentry-six.com');
    expect(options.path).toBe('/ai-support/conversations');
    expect(options.headers['X-Sentry-Product']).toBe('sentry-studio');
    expect(options.headers['Idempotency-Key']).toBe(CLIENT_ID);
    expect(JSON.parse(body.toString()).productId).toBe('sentry-studio');
    await expect(makeAiRequest({ method: 'GET', path: '/chat/ticket/1/messages' }, transport)).rejects.toThrow(/Unsupported AI Support route/);
  });

  test('rejects malformed conversation references before any request', async () => {
    const transport = fakeTransport([]);
    const client = createAiSupportClient(transport);
    await expect(client.fetchMessages({ conversation: { id: '../../admin', authToken: CONVERSATION.authToken } })).rejects.toThrow(/conversation/);
    await expect(client.sendMessage({ conversation: CONVERSATION, content: 'hi', clientMessageId: 'x' })).rejects.toThrow(/client message ID/);
    await expect(client.decideFileRequest({ conversation: CONVERSATION, messageId: MESSAGE_ID, requestIndex: 0, decision: 'maybe' })).rejects.toThrow(/approved or denied/);
    expect(transport.requests).toHaveLength(0);
  });

  test('surfaces gateway errors with status and code and refuses redirects', async () => {
    const transport = fakeTransport([
      { status: 409, body: { error: 'The current AI support disclosure must be accepted in a new conversation', code: 'disclosure_required' } },
      { status: 302, body: '' },
    ]);
    const client = createAiSupportClient(transport);
    await expect(client.fetchMessages({ conversation: CONVERSATION })).rejects.toMatchObject({ status: 409, code: 'disclosure_required' });
    await expect(client.fetchMessages({ conversation: CONVERSATION })).rejects.toThrow(/redirect/);
  });

  test('uses a stable deletion key so a lost response can be retried safely', async () => {
    const transport = fakeTransport([{ status: 200, body: { success: true } }, { status: 200, body: { success: true } }]);
    const client = createAiSupportClient(transport);
    await client.deleteConversation({ conversation: CONVERSATION });
    await client.deleteConversation({ conversation: CONVERSATION });
    const [first, second] = transport.requests.map((request) => request.options);
    expect(first.method).toBe('DELETE');
    expect(first.headers['Idempotency-Key']).toBe(second.headers['Idempotency-Key']);
    expect(first.headers['Idempotency-Key']).toMatch(/^[A-Za-z0-9_-]{22,}$/);
  });

  test('uploads approved diagnostics as one bounded text/plain multipart file', async () => {
    const transport = fakeTransport([{ status: 200, body: { success: true, fileName: 'sentry-studio-diagnostics.txt', size: 12 } }]);
    const client = createAiSupportClient(transport);
    await client.uploadDiagnostics({
      conversation: CONVERSATION,
      messageId: MESSAGE_ID,
      requestIndex: 0,
      uploadToken: 'u'.repeat(43),
      report: 'report text\n',
    });
    const [{ options, body }] = transport.requests;
    expect(options.path).toBe(`/ai-support/conversations/${CONVERSATION.id}/files`);
    expect(options.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    const text = body.toString();
    expect(text).toContain('name="consentVersion"\r\n\r\ndiagnostic-upload-v1');
    expect(text).toContain('filename="sentry-studio-diagnostics.txt"');
    expect(text).toContain('Content-Type: text/plain');
    expect(text).toContain('report text');
    await expect(client.uploadDiagnostics({
      conversation: CONVERSATION, messageId: MESSAGE_ID, requestIndex: 0, uploadToken: 'u'.repeat(43), report: 'x'.repeat(2 * 1024 * 1024 + 1),
    })).rejects.toThrow(/2 MB/);
  });
});

describe('AI Support IPC', () => {
  test('registers only AI Support channels and returns structured results', async () => {
    ipcMain.handle.mockClear();
    const client = {
      createConversation: jest.fn(async () => ({ id: CONVERSATION.id })),
      fetchMessages: jest.fn(async () => { const error = new Error('gone'); error.status = 404; throw error; }),
      sendMessage: jest.fn(), deleteConversation: jest.fn(), decideFileRequest: jest.fn(), uploadDiagnostics: jest.fn(),
    };
    registerSupportChatIpc(client);
    const channels = ipcMain.handle.mock.calls.map(([channel]) => channel);
    expect(channels.every((channel) => channel.startsWith('aiSupport:'))).toBe(true);
    expect(channels).not.toContain('support:createTicket');
    const handler = (name) => ipcMain.handle.mock.calls.find(([channel]) => channel === name)[1];
    await expect(handler('aiSupport:createConversation')({}, {})).resolves.toEqual({ success: true, data: { id: CONVERSATION.id } });
    await expect(handler('aiSupport:fetchMessages')({}, {})).resolves.toMatchObject({ success: false, status: 404, error: 'gone' });
  });
});
