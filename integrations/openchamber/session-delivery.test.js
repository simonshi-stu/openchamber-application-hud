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

test('an explicitly authorized retry clears only that message marker before reclaiming it', async () => {
  const tracker = createSessionDeliveryTracker();
  const message = { id: 'virtual-retry-message', text: '虚构人工重试消息' };
  const other = { id: 'virtual-other-message', text: '虚构其他消息' };
  let promptCount = 0;
  let acknowledgeCount = 0;
  const initial = await tracker.sendAndAcknowledge({
    message,
    prompt: async () => {
      promptCount += 1;
      return { sent: 'sent' };
    },
    markSent: async () => ({ updated: 0 }),
    acknowledge: async () => { throw new Error('虚构首次确认异常'); },
  });
  assert.equal(initial.status, 'uncertain');
  assert.equal(tracker.has(message.id), true);

  await tracker.sendAndAcknowledge({
    message: other,
    prompt: async () => ({ sent: 'sent' }),
    acknowledge: async () => { throw new Error('虚构其他消息确认异常'); },
  }).catch(() => {});
  assert.equal(tracker.has(other.id), true);

  const calls = [];
  const retried = await tracker.sendAndAcknowledge({
    message: { ...message, deliveryState: 'needs_review' },
    manualRetry: true,
    release: async (messageId) => {
      calls.push(`release:${messageId}`);
      return { updated: 1 };
    },
    prepare: async (messageId) => {
      calls.push(`prepare:${messageId}`);
      return { updated: 1 };
    },
    prompt: async (text) => {
      promptCount += 1;
      assert.equal(text, message.text);
      return { sent: 'sent' };
    },
    markSent: async (messageId) => {
      calls.push(`mark:${messageId}`);
      return { updated: 1 };
    },
    acknowledge: async (messageId) => {
      calls.push(`ack:${messageId}`);
      acknowledgeCount += 1;
    },
  });
  assert.equal(retried.status, 'acknowledged');
  assert.deepEqual(calls, [
    'release:virtual-retry-message',
    'prepare:virtual-retry-message',
    'mark:virtual-retry-message',
    'ack:virtual-retry-message',
  ]);
  assert.equal(promptCount, 2);
  assert.equal(acknowledgeCount, 1);
  assert.equal(tracker.has(message.id), false);
  assert.equal(tracker.has(other.id), true);
});

test('a retry conflict refuses the prompt and preserves the exact marker', async () => {
  const tracker = createSessionDeliveryTracker();
  const message = { id: 'virtual-conflict-message', text: '虚构冲突消息' };
  await tracker.sendAndAcknowledge({
    message,
    prompt: async () => ({ sent: 'sent' }),
    markSent: async () => ({ updated: 0 }),
    acknowledge: async () => {},
  });
  assert.equal(tracker.has(message.id), true);
  let promptCount = 0;
  const result = await tracker.sendAndAcknowledge({
    message: { ...message, deliveryState: 'needs_review' },
    manualRetry: true,
    release: async () => ({ updated: 0 }),
    prepare: async () => ({ updated: 1 }),
    prompt: async () => {
      promptCount += 1;
      return { sent: 'sent' };
    },
    acknowledge: async () => {},
  });
  assert.equal(result.status, 'conflict');
  assert.equal(promptCount, 0);
  assert.equal(tracker.has(message.id), true);
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

test('an unknown host result stops delivery and requires an explicit review', async () => {
  const tracker = createSessionDeliveryTracker();
  const message = { id: 'virtual-message-4', text: '虚构未知结果消息', deliveryState: 'pending' };
  let promptCount = 0;
  let prepareCount = 0;
  let markSentCount = 0;
  let releaseCount = 0;
  const prepare = async () => {
    prepareCount += 1;
    return { updated: 1 };
  };
  const markSent = async () => {
    markSentCount += 1;
    return { updated: 1 };
  };
  const release = async () => {
    releaseCount += 1;
    return { updated: 1 };
  };

  const first = await tracker.sendAndAcknowledge({
    message,
    prompt: async () => {
      promptCount += 1;
      throw Object.assign(new Error('虚构宿主响应未知'), { code: 'HOST_TIMEOUT' });
    },
    acknowledge: async () => { throw new Error('不应确认未知结果'); },
    prepare,
    markSent,
    release,
  });
  assert.equal(first.status, 'uncertain');
  assert.equal(promptCount, 1);
  assert.equal(prepareCount, 1);
  assert.equal(markSentCount, 0);
  assert.equal(releaseCount, 0);

  const afterCrash = await tracker.sendAndAcknowledge({
    message: { ...message, deliveryState: 'needs_review' },
    prompt: async () => { throw new Error('不应自动重发'); },
    acknowledge: async () => { throw new Error('未知结果不能自动确认'); },
    prepare,
    markSent,
    release,
  });
  assert.equal(afterCrash.status, 'needs-review');
  assert.equal(promptCount, 1);

  const failed = await tracker.sendAndAcknowledge({
    message: { id: 'virtual-message-7', text: '虚构失败结果消息', deliveryState: 'pending' },
    prompt: async () => ({ sent: 'failed' }),
    acknowledge: async () => { throw new Error('失败结果不能自动确认'); },
    prepare,
    release,
  });
  assert.equal(failed.status, 'uncertain');
  assert.equal(releaseCount, 0);
});

test('a durable sent state retries only local acknowledgement after a HUD restart', async () => {
  const tracker = createSessionDeliveryTracker();
  const message = { id: 'virtual-message-5', text: '虚构已送达消息', deliveryState: 'sent' };
  let promptCount = 0;
  let acknowledgeCount = 0;
  const result = await tracker.sendAndAcknowledge({
    message,
    prompt: async () => {
      promptCount += 1;
      return { sent: 'sent' };
    },
    acknowledge: async () => { acknowledgeCount += 1; },
  });
  assert.equal(result.status, 'acknowledged');
  assert.equal(promptCount, 0);
  assert.equal(acknowledgeCount, 1);
});

test('an explicit known-not-sent result may release the durable attempt guard', async () => {
  const tracker = createSessionDeliveryTracker();
  const message = { id: 'virtual-message-6', text: '虚构无模型消息', deliveryState: 'pending' };
  let released = 0;
  const result = await tracker.sendAndAcknowledge({
    message,
    prompt: async () => ({ sent: 'no-model' }),
    acknowledge: async () => { throw new Error('不应确认未发送消息'); },
    prepare: async () => ({ updated: 1 }),
    release: async () => {
      released += 1;
      return { updated: 1 };
    },
  });
  assert.equal(result.status, 'not-sent');
  assert.equal(released, 1);
});
