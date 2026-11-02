import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const SESSION_INBOX_SCHEMA = 1;
export const SESSION_INBOX_FILE = 'session-inbox.json';
export const SESSION_MESSAGE_MAX = 16000;
export const SESSION_ID_MAX = 128;
export const SESSION_INBOX_MAX = 100;
export const SESSION_DELIVERY_STATE = Object.freeze({
  pending: 'pending',
  sent: 'sent',
  needsReview: 'needs_review',
});
export const SESSION_DELIVERY_STATES = Object.freeze(Object.values(SESSION_DELIVERY_STATE));
const SESSION_INBOX_LOCK = `${SESSION_INBOX_FILE}.lock`;
const LOCK_WAIT_MS = 5000;
const STALE_LOCK_MS = 30_000;

export class SessionInboxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SessionInboxError';
    this.code = code;
  }
}

export function sessionInboxPath(appRoot) {
  return path.join(appRoot, SESSION_INBOX_FILE);
}

export async function readSessionInbox(appRoot) {
  const filePath = sessionInboxPath(appRoot);
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SessionInboxError('SESSION_INBOX_UNSAFE', '会话桥接文件必须是普通文件。');
  }
  let document;
  try {
    document = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    throw new SessionInboxError('SESSION_INBOX_CORRUPT', '会话桥接文件不是有效 JSON；未覆盖原文件。');
  }
  if (!document || document.schemaVersion !== SESSION_INBOX_SCHEMA || !Array.isArray(document.messages)) {
    throw new SessionInboxError('SESSION_INBOX_CORRUPT', '会话桥接文件版本或结构无效；未覆盖原文件。');
  }
  if (document.messages.length > SESSION_INBOX_MAX) {
    throw new SessionInboxError('SESSION_INBOX_CORRUPT', '会话桥接队列超过安全上限；未覆盖原文件。');
  }
  const messages = document.messages.map((message, index) => {
    const deliveryState = message && typeof message === 'object'
      ? Object.hasOwn(message, 'deliveryState')
        ? message.deliveryState
        : SESSION_DELIVERY_STATE.pending
      : null;
    if (!message || typeof message !== 'object'
      || typeof message.id !== 'string' || !message.id
      || typeof message.text !== 'string' || !message.text.trim()
      || message.text.length > SESSION_MESSAGE_MAX
      || typeof message.createdAt !== 'string' || !message.createdAt
      || !SESSION_DELIVERY_STATES.includes(deliveryState)
      || (message.targetSessionId !== undefined
        && message.targetSessionId !== null
        && !isSessionId(message.targetSessionId))) {
      throw new SessionInboxError('SESSION_INBOX_CORRUPT', `会话桥接消息 ${index + 1} 无效；未覆盖原文件。`);
    }
    return {
      id: message.id,
      text: message.text,
      createdAt: message.createdAt,
      targetSessionId: message.targetSessionId || null,
      deliveryState,
    };
  });
  if (new Set(messages.map((message) => message.id)).size !== messages.length) {
    throw new SessionInboxError('SESSION_INBOX_CORRUPT', '会话桥接消息 ID 重复；未覆盖原文件。');
  }
  return messages;
}

export async function appendSessionMessage(appRoot, text, {
  now = () => new Date().toISOString(),
  newId = () => randomUUID(),
  targetSessionId = null,
} = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new SessionInboxError('INVALID_SESSION_MESSAGE', '会话消息不能为空。');
  }
  if (text.length > SESSION_MESSAGE_MAX) {
    throw new SessionInboxError('INVALID_SESSION_MESSAGE', `会话消息不能超过 ${SESSION_MESSAGE_MAX} 个字符。`);
  }
  const target = normalizeSessionId(targetSessionId);
  return withInboxLock(appRoot, async () => {
    const messages = await readSessionInbox(appRoot);
    if (messages.length >= SESSION_INBOX_MAX) {
      throw new SessionInboxError('SESSION_INBOX_FULL', '会话桥接队列已满；请先打开 OpenChamber HUD 消费待发送消息。');
    }
    const id = newId();
    if (typeof id !== 'string' || !id || messages.some((message) => message.id === id)) {
      throw new SessionInboxError('SESSION_INBOX_CORRUPT', '无法生成唯一的会话桥接消息 ID；未覆盖原文件。');
    }
    const message = {
      id,
      text,
      createdAt: now(),
      targetSessionId: target,
      deliveryState: SESSION_DELIVERY_STATE.pending,
    };
    await writeSessionInbox(appRoot, [...messages, message]);
    return message;
  });
}

function normalizeSessionId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !isSessionId(value)) {
    throw new SessionInboxError('INVALID_SESSION_ID', '目标会话 ID 必须是非空且不超过 128 个字符的单行标识。');
  }
  return value.trim();
}

export function isSessionId(value) {
  return typeof value === 'string'
    && value.length <= SESSION_ID_MAX
    && value.trim() === value
    && value.length > 0
    && !/[\u0000-\u001f\u007f\s]/.test(value);
}

export async function acknowledgeSessionMessages(appRoot, ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > SESSION_INBOX_MAX) {
    throw new SessionInboxError('INVALID_SESSION_MESSAGE_IDS', '会话桥接确认 ID 列表无效。');
  }
  const idSet = new Set(ids.filter((id) => typeof id === 'string' && id));
  if (idSet.size !== ids.length) {
    throw new SessionInboxError('INVALID_SESSION_MESSAGE_IDS', '会话桥接确认 ID 列表包含无效值。');
  }
  return withInboxLock(appRoot, async () => {
    const messages = await readSessionInbox(appRoot);
    const remaining = messages.filter((message) => !idSet.has(message.id));
    if (remaining.length !== messages.length) await writeSessionInbox(appRoot, remaining);
    return { acknowledged: messages.length - remaining.length, remaining };
  });
}

/**
 * Atomically move delivery state forward or explicitly release a message for
 * a user-authorized retry. The pending -> needs_review transition is the
 * durable send-attempt guard: a HUD crash after this write must not cause a
 * new HUD process to send the same host message automatically.
 */
export async function updateSessionMessageStates(appRoot, ids, nextState) {
  validateMessageIds(ids);
  if (!SESSION_DELIVERY_STATES.includes(nextState)) {
    throw new SessionInboxError('INVALID_SESSION_DELIVERY_STATE', '会话桥接送达状态无效。');
  }
  const idSet = new Set(ids);
  return withInboxLock(appRoot, async () => {
    const messages = await readSessionInbox(appRoot);
    let updated = 0;
    const nextMessages = messages.map((message) => {
      if (!idSet.has(message.id) || !canTransitionDeliveryState(message.deliveryState, nextState)) {
        return message;
      }
      updated += 1;
      return { ...message, deliveryState: nextState };
    });
    if (updated > 0) await writeSessionInbox(appRoot, nextMessages);
    return { updated, remaining: nextMessages };
  });
}

async function withInboxLock(appRoot, task) {
  const lockPath = path.join(appRoot, SESSION_INBOX_LOCK);
  const startedAt = Date.now();
  let acquired = false;
  while (!acquired) {
    let handle = null;
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
      await handle.close();
      handle = null;
      acquired = true;
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error.code !== 'EEXIST') throw error;
      const lockStat = await fs.lstat(lockPath).catch(() => null);
      if (lockStat?.isSymbolicLink() || (lockStat && !lockStat.isFile())) {
        throw new SessionInboxError('SESSION_INBOX_UNSAFE', '会话桥接锁必须是普通文件。');
      }
      if (lockStat && Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
        await fs.rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - startedAt >= LOCK_WAIT_MS) {
        throw new SessionInboxError('SESSION_INBOX_BUSY', '会话桥接队列正由另一个窗口更新，请稍后重试。');
      }
      await delay(20);
    }
  }
  try {
    return await task();
  } finally {
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateMessageIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > SESSION_INBOX_MAX) {
    throw new SessionInboxError('INVALID_SESSION_MESSAGE_IDS', '会话桥接确认 ID 列表无效。');
  }
  const idSet = new Set(ids.filter((id) => typeof id === 'string' && id));
  if (idSet.size !== ids.length) {
    throw new SessionInboxError('INVALID_SESSION_MESSAGE_IDS', '会话桥接确认 ID 列表包含无效值。');
  }
}

function canTransitionDeliveryState(currentState, nextState) {
  if (currentState === nextState) return false;
  if (currentState === SESSION_DELIVERY_STATE.pending) {
    return nextState === SESSION_DELIVERY_STATE.needsReview;
  }
  if (currentState === SESSION_DELIVERY_STATE.needsReview) {
    return nextState === SESSION_DELIVERY_STATE.pending
      || nextState === SESSION_DELIVERY_STATE.sent;
  }
  return false;
}

async function writeSessionInbox(appRoot, messages) {
  const filePath = sessionInboxPath(appRoot);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const document = JSON.stringify({ schemaVersion: SESSION_INBOX_SCHEMA, messages }, null, 2);
  let handle = null;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(document, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
