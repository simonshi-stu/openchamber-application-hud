import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  acknowledgeSessionMessages,
  appendSessionMessage,
  readSessionInbox,
  SessionInboxError,
  updateSessionMessageStates,
} from './session-bridge.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('session bridge preserves message text and serializes concurrent writers', async (t) => {
  const directory = path.join(ROOT, 'private', `test-session-bridge-${randomUUID()}`);
  await fs.mkdir(directory, { recursive: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const messages = await Promise.all([
    appendSessionMessage(directory, '  虚构消息  ', { newId: () => 'message-1', now: () => '2026-10-28T00:00:00.000Z' }),
    appendSessionMessage(directory, '虚构消息 2', { newId: () => 'message-2', now: () => '2026-10-28T00:00:01.000Z' }),
    appendSessionMessage(directory, '虚构消息 3', { newId: () => 'message-3', now: () => '2026-10-28T00:00:02.000Z' }),
  ]);
  assert.equal(messages.length, 3);
  assert.equal((await readSessionInbox(directory)).find((message) => message.id === 'message-1').text, '  虚构消息  ');

  const acknowledged = await acknowledgeSessionMessages(directory, ['message-2']);
  assert.equal(acknowledged.acknowledged, 1);
  assert.deepEqual(
    (await readSessionInbox(directory)).map((message) => message.id).sort(),
    ['message-1', 'message-3'],
  );
});

test('session delivery state claims are durable and only an explicit retry releases review', async (t) => {
  const directory = path.join(ROOT, 'private', `test-session-delivery-state-${randomUUID()}`);
  await fs.mkdir(directory, { recursive: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  await appendSessionMessage(directory, '虚构待发送消息', {
    newId: () => 'message-delivery-1',
    now: () => '2026-10-28T00:00:03.000Z',
  });
  const firstClaim = await updateSessionMessageStates(directory, ['message-delivery-1'], 'needs_review');
  assert.equal(firstClaim.updated, 1);
  const secondClaim = await updateSessionMessageStates(directory, ['message-delivery-1'], 'needs_review');
  assert.equal(secondClaim.updated, 0);
  assert.equal((await readSessionInbox(directory))[0].deliveryState, 'needs_review');

  const releasedForExplicitRetry = await updateSessionMessageStates(directory, ['message-delivery-1'], 'pending');
  assert.equal(releasedForExplicitRetry.updated, 1);
  assert.equal((await readSessionInbox(directory))[0].deliveryState, 'pending');
  assert.equal((await updateSessionMessageStates(directory, ['message-delivery-1'], 'needs_review')).updated, 1);

  const markedSent = await updateSessionMessageStates(directory, ['message-delivery-1'], 'sent');
  assert.equal(markedSent.updated, 1);
  assert.equal((await readSessionInbox(directory))[0].deliveryState, 'sent');
  assert.equal((await updateSessionMessageStates(directory, ['message-delivery-1'], 'pending')).updated, 0);

  await assert.rejects(
    updateSessionMessageStates(directory, ['message-delivery-1'], 'not-a-state'),
    (error) => error instanceof SessionInboxError && error.code === 'INVALID_SESSION_DELIVERY_STATE',
  );
  assert.equal((await readSessionInbox(directory))[0].deliveryState, 'sent');
  assert.equal((await updateSessionMessageStates(directory, ['message-delivery-1'], 'pending')).updated, 0);
});

test('session bridge rejects corrupt files without replacing them', async (t) => {
  const directory = path.join(ROOT, 'private', `test-session-bridge-corrupt-${randomUUID()}`);
  await fs.mkdir(directory, { recursive: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'session-inbox.json');
  await fs.writeFile(file, '{not-json', 'utf8');

  await assert.rejects(
    readSessionInbox(directory),
    (error) => error instanceof SessionInboxError && error.code === 'SESSION_INBOX_CORRUPT',
  );
  assert.equal(await fs.readFile(file, 'utf8'), '{not-json');
});
