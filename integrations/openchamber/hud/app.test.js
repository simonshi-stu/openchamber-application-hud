import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const SDK_CHANNEL = 'openchamber.sdk';
const SDK_VERSION = 1;
const APP_URL = new URL('./app.js', import.meta.url);

class FakeMessageEvent {
  constructor(type, { data, source } = {}) {
    this.type = type;
    this.data = data;
    this.source = source;
  }
}

class FakeElement {
  constructor() {
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.value = '';
    this.title = '';
    this.dataset = {};
    this.style = { width: '', setProperty() {} };
    this.listeners = new Map();
    this.classList = { toggle() {} };
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ type, target: this, preventDefault() {}, ...event });
    }
  }

  click() {
    this.dispatch('click');
  }

  setAttribute(name, value) {
    this[name] = String(value);
  }
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement();
    this.elements = new Map();
  }

  querySelector(selector) {
    if (!this.elements.has(selector)) this.elements.set(selector, new FakeElement());
    return this.elements.get(selector);
  }
}

class FakeHostHarness {
  constructor({ message, session, autoSwitch = false } = {}) {
    this.message = message;
    this.session = session;
    this.autoSwitch = autoSwitch;
    this.window = null;
    this.parent = { postMessage: (wire) => this.handle(wire) };
    this.promptCount = 0;
    this.ackCount = 0;
    this.openSessionCalls = [];
    this.serviceRequests = [];
    this.deferNextAck = false;
    this.deferredAck = null;
  }

  install() {
    this.window = new FakeWindow(this.parent);
    this.document = new FakeDocument();
    this.previous = {
      window: globalThis.window,
      document: globalThis.document,
      MessageEvent: globalThis.MessageEvent,
    };
    globalThis.window = this.window;
    globalThis.document = this.document;
    globalThis.MessageEvent = FakeMessageEvent;
  }

  async load() {
    await import(`${APP_URL.href}?hud-test=${randomUUID()}`);
    await waitFor(() => this.document.querySelector('#app').hidden === false);
  }

  cleanup() {
    this.window?.dispatchEvent({ type: 'pagehide' });
    globalThis.window = this.previous.window;
    globalThis.document = this.previous.document;
    globalThis.MessageEvent = this.previous.MessageEvent;
  }

  handle(wire) {
    if (wire.type === 'hello') {
      this.respondPush('ready', {
        theme: {
          mode: 'light',
          tokens: {
            background: '#fff',
            elevated: '#fff',
            foreground: '#111',
            muted: '#666',
            subtle: '#eee',
            border: '#ddd',
            hover: '#eee',
            selection: '#def',
            focus: '#39f',
            primary: '#36c',
            mutedSurface: '#eee',
            elevatedForeground: '#111',
            active: '#def',
            selectionForeground: '#111',
            primaryForeground: '#fff',
            primaryText: '#246',
            successText: '#284',
            warningText: '#864',
            errorText: '#844',
            infoText: '#246',
            success: '#2a4',
            warning: '#a70',
            error: '#a33',
            info: '#268',
            font: 'system-ui',
            mono: 'monospace',
            radius: '8px',
          },
        },
        locale: 'zh-CN',
        directory: 'C:/virtual/hud-r1',
        session: this.session,
        surface: 'dialog',
        connection: { connected: true, account: null },
        settings: {},
        item: null,
      });
      return;
    }
    if (wire.type === 'prompt') {
      this.promptCount += 1;
      this.respondResult(wire.id, { sent: 'sent' });
      return;
    }
    if (wire.type === 'open-session') {
      const target = wire.payload?.sessionId;
      this.openSessionCalls.push(target);
      if (this.autoSwitch) this.emitSession({ id: target, title: `虚构会话 ${target}`, busy: false });
      this.respondResult(wire.id, {});
      return;
    }
    if (wire.type === 'close') {
      this.respondResult(wire.id, {});
      return;
    }
    if (wire.type !== 'service-request') return;

    this.serviceRequests.push(wire.payload);
    const path = wire.payload?.path;
    if (path === '/api/state') {
      this.respondResult(wire.id, {
        status: 200,
        body: JSON.stringify({
          ok: true,
          revision: 0,
          state: { queue: { state: 'idle' }, companies: [], issues: [] },
        }),
      });
      return;
    }
    if (path === '/api/session-inbox') {
      this.respondResult(wire.id, {
        status: 200,
        body: JSON.stringify({ ok: true, messages: this.message ? [this.message] : [] }),
      });
      return;
    }
    if (path === '/api/session-inbox/ack') {
      this.ackCount += 1;
      if (this.deferNextAck) {
        this.deferNextAck = false;
        this.deferredAck = () => this.respondResult(wire.id, {
          status: 200,
          body: JSON.stringify({ ok: true, acknowledged: 1 }),
        });
      } else {
        this.respondResult(wire.id, {
          status: 200,
          body: JSON.stringify({ ok: true, acknowledged: 1 }),
        });
      }
      return;
    }
    if (path === '/api/session-inbox/state') {
      this.respondResult(wire.id, {
        status: 200,
        body: JSON.stringify({ ok: true, updated: 1 }),
      });
    }
  }

  respondResult(id, payload) {
    queueMicrotask(() => this.window.dispatchEvent(new FakeMessageEvent('message', {
      source: this.parent,
      data: { channel: SDK_CHANNEL, v: SDK_VERSION, type: 'result', id, ok: true, payload },
    })));
  }

  respondPush(type, payload) {
    queueMicrotask(() => this.window.dispatchEvent(new FakeMessageEvent('message', {
      source: this.parent,
      data: { channel: SDK_CHANNEL, v: SDK_VERSION, type, payload },
    })));
  }

  emitSession(session) {
    this.session = session;
    this.respondPush('session', { session });
  }
}

class FakeWindow {
  constructor(parent) {
    this.parent = parent;
    this.listeners = new Map();
    this.setTimeout = setTimeout;
    this.clearTimeout = clearTimeout;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener));
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
}

async function waitFor(predicate, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('虚构 HUD DOM 状态未在预期时间内出现。');
}

async function withHarness(options, callback) {
  const harness = new FakeHostHarness(options);
  harness.install();
  try {
    await harness.load();
    await callback(harness);
  } finally {
    harness.cleanup();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('HUD binds review actions to the exact target session and guards stale actions', async () => {
  await withHarness({
    message: {
      id: 'virtual-review-1',
      text: '虚构待核对内容，不展示完整正文',
      createdAt: '2026-11-02T00:00:00.000Z',
      targetSessionId: 'ses-target',
      deliveryState: 'needs_review',
    },
    session: { id: 'ses-other', title: '虚构当前会话', busy: false },
  }, async (harness) => {
    const review = harness.document.querySelector('#delivery-review');
    const reviewMessage = harness.document.querySelector('#delivery-review-message');
    const confirm = harness.document.querySelector('#delivery-confirm-button');
    const retry = harness.document.querySelector('#delivery-retry-button');
    const openTarget = harness.document.querySelector('#delivery-open-target-button');
    await waitFor(() => review.hidden === false);
    assert.match(reviewMessage.textContent, /目标会话：ses-target/);
    assert.match(reviewMessage.textContent, /内容摘要：虚构待核对内容/);
    assert.equal(confirm.disabled, true);
    assert.equal(retry.disabled, true);
    assert.equal(openTarget.hidden, false);

    openTarget.click();
    await waitFor(() => harness.openSessionCalls.length === 1);
    assert.deepEqual(harness.openSessionCalls, ['ses-target']);
    assert.equal(harness.promptCount, 0);
    assert.equal(harness.ackCount, 0);
    assert.equal(openTarget.disabled, true);

    // The first call deliberately did not create or send anything. The host
    // now reports the existing target session as the active session.
    harness.emitSession({ id: 'ses-target', title: '虚构目标会话', busy: false });
    await waitFor(() => harness.document.querySelector('#delivery-confirm-button').disabled === false);
    assert.equal(harness.promptCount, 0);
    assert.equal(harness.ackCount, 0);

    harness.deferNextAck = true;
    confirm.click();
    await waitFor(() => harness.ackCount === 1);
    harness.emitSession({ id: 'ses-other', title: '虚构切换中的其他会话', busy: false });
    harness.deferredAck();
    await waitFor(() => harness.document.querySelector('#delivery-review').hidden === false);
    await waitFor(() => harness.document.querySelector('#send-message-button').disabled === false);
    assert.equal(harness.promptCount, 0);
    assert.equal(harness.document.querySelector('#delivery-confirm-button').disabled, true);
  });
});

test('an old unbound review remains unknown and cannot be confirmed or retried', async () => {
  await withHarness({
    message: {
      id: 'virtual-unbound-review',
      text: '虚构未绑定目标消息',
      createdAt: '2026-11-02T00:00:01.000Z',
      targetSessionId: null,
      deliveryState: 'needs_review',
    },
    session: { id: 'ses-current', title: '虚构当前会话', busy: false },
  }, async (harness) => {
    await waitFor(() => harness.document.querySelector('#delivery-review').hidden === false);
    const message = harness.document.querySelector('#delivery-review-message').textContent;
    assert.match(message, /无法证明（旧消息未绑定目标会话）/);
    assert.equal(harness.document.querySelector('#delivery-confirm-button').disabled, true);
    assert.equal(harness.document.querySelector('#delivery-retry-button').disabled, true);
    assert.equal(harness.document.querySelector('#delivery-open-target-button').hidden, true);
    assert.equal(harness.promptCount, 0);
    assert.equal(harness.ackCount, 0);
  });
});

test('HUD retry is one exact-ID send and sent state only acknowledges locally', async () => {
  await withHarness({
    message: {
      id: 'virtual-retry-ui',
      text: '虚构人工重试正文',
      createdAt: '2026-11-02T00:00:02.000Z',
      targetSessionId: 'ses-current',
      deliveryState: 'needs_review',
    },
    session: { id: 'ses-current', title: '虚构当前会话', busy: false },
  }, async (harness) => {
    const review = harness.document.querySelector('#delivery-review');
    const retry = harness.document.querySelector('#delivery-retry-button');
    await waitFor(() => review.hidden === false && retry.disabled === false);
    retry.click();
    await waitFor(() => review.hidden === true);
    assert.equal(harness.promptCount, 1);
    assert.equal(harness.ackCount, 1);
    const stateBodies = harness.serviceRequests
      .filter((request) => request.path === '/api/session-inbox/state')
      .map((request) => JSON.parse(request.body));
    assert.deepEqual(stateBodies.map((body) => [body.messageIds, body.state]), [
      [['virtual-retry-ui'], 'pending'],
      [['virtual-retry-ui'], 'needs_review'],
      [['virtual-retry-ui'], 'sent'],
    ]);
    const ackBody = JSON.parse(
      harness.serviceRequests.find((request) => request.path === '/api/session-inbox/ack').body,
    );
    assert.deepEqual(ackBody.messageIds, ['virtual-retry-ui']);
  });

  await withHarness({
    message: {
      id: 'virtual-sent-only',
      text: '虚构已送达消息',
      createdAt: '2026-11-02T00:00:03.000Z',
      targetSessionId: 'ses-current',
      deliveryState: 'sent',
    },
    session: { id: 'ses-current', title: '虚构当前会话', busy: false },
  }, async (harness) => {
    await waitFor(() => harness.ackCount === 1);
    assert.equal(harness.promptCount, 0);
    assert.equal(
      harness.serviceRequests.some((request) => request.path === '/api/session-inbox/state'),
      false,
    );
  });
});
