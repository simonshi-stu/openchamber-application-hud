import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionDeliveryTracker } from './session-delivery.js';

test('acknowledgement timeout retries the ack without duplicating the host message', async () => {
  const tracker = createSessionDeliveryTracker();
  const message = { id: 'virtual-message-1', text: '虚构会话消息' };
  let promptCount = 0;
  let acknowledgeCount = 0;
  let failAcknowledgement = true;

  const send = () => tracker.sendAndAcknowledge({
    message,
    prompt: async (text) => {
      promptCount += 1;
      assert.equal(text, message.text);
      return { sent: 'sent' };
    },
    acknowledge: async () => {
      acknowledgeCount += 1;
      if (failAcknowledgement) {
        failAcknowledgement = false;
        const error = new Error('虚构宿主确认超时');
        error.code = 'HOST_TIMEOUT';
        throw error;
      }
    },
  });

  await assert.rejects(send(), (error) => error.code === 'HOST_TIMEOUT');
  assert.equal(promptCount, 1);
  assert.equal(acknowledgeCount, 1);
  assert.equal(tracker.has(message.id), true);

  const retried = await send();
  assert.equal(retried.status, 'acknowledged');
  assert.equal(retried.alreadySent, true);
  assert.equal(promptCount, 1);
  assert.equal(acknowledgeCount, 2);
  assert.equal(tracker.has(message.id), false);
});

test('delivery markers are cleared when the message is gone or the directory changes', async () => {
  const tracker = createSessionDeliveryTracker();
  const message = { id: 'virtual-message-2', text: '虚构目录消息' };
  await tracker.sendAndAcknowledge({
    message,
    prompt: async () => ({ sent: 'sent' }),
    acknowledge: async () => { throw new Error('虚构确认超时'); },
  }).catch(() => {});
  assert.equal(tracker.has(message.id), true);
  tracker.reconcile([]);
  assert.equal(tracker.has(message.id), false);
  tracker.reconcile([{ id: message.id }]);
  await tracker.sendAndAcknowledge({
    message,
    prompt: async () => ({ sent: 'sent' }),
    acknowledge: async () => {},
  });
  assert.equal(tracker.has(message.id), false);
  tracker.reconcile([{ id: 'virtual-message-3' }]);
  tracker.reset();
  assert.equal(tracker.has('virtual-message-3'), false);
});
