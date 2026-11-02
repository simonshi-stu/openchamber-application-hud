// Keep a successfully sent message marked until its inbox acknowledgement
// succeeds. A durable state callback is used by the HUD before and after the
// host call, so a crash leaves the message waiting for review rather than
// silently sending it again. This is a local guard, not cross-system exactly-once.

const KNOWN_NOT_SENT = new Set(['no-model', 'skipped']);
const NEEDS_REVIEW = 'needs_review';
const SENT = 'sent';

export function createSessionDeliveryTracker() {
  const sentMessageIds = new Set();

  function reconcile(messages) {
    const pendingIds = new Set(
      Array.isArray(messages)
        ? messages.map((message) => message?.id).filter((id) => typeof id === 'string' && id)
        : [],
    );
    for (const id of sentMessageIds) {
      if (!pendingIds.has(id)) sentMessageIds.delete(id);
    }
  }

  async function sendAndAcknowledge({
    message,
    prompt,
    acknowledge,
    prepare,
    markSent,
    release,
    manualRetry = false,
    isCurrent = () => true,
  } = {}) {
    if (!message || typeof message.id !== 'string' || !message.id) {
      throw new Error('会话桥接消息缺少有效 ID。');
    }
    if (typeof prompt !== 'function' || typeof acknowledge !== 'function') {
      throw new Error('会话桥接发送器缺少 prompt 或 acknowledge 回调。');
    }
    for (const [name, callback] of [['prepare', prepare], ['markSent', markSent], ['release', release]]) {
      if (callback !== undefined && typeof callback !== 'function') {
        throw new Error(`会话桥接发送器缺少有效 ${name} 回调。`);
      }
    }

    if (manualRetry && message.deliveryState !== NEEDS_REVIEW) {
      return { status: 'conflict', messageId: message.id };
    }
    if (manualRetry && typeof release !== 'function') {
      throw new Error('人工重试发送器缺少 release 回调。');
    }
    if (manualRetry && typeof prepare !== 'function') {
      throw new Error('人工重试发送器缺少 prepare 回调。');
    }
    if (message.deliveryState === NEEDS_REVIEW && !manualRetry) {
      return { status: 'needs-review', messageId: message.id };
    }

    // A manual retry is a two-step durable transition: first release this
    // exact message from review, then claim it again before calling the host.
    // Only a successful release permits clearing this message's local marker;
    // another message's marker is never reset as a side effect.
    if (manualRetry) {
      const released = await release(message.id);
      if (!released || released.updated !== 1) {
        return { status: 'conflict', messageId: message.id };
      }
      sentMessageIds.delete(message.id);
      if (!isCurrent()) return { status: 'stale', messageId: message.id };
    }

    const alreadySent = !manualRetry && (sentMessageIds.has(message.id) || message.deliveryState === SENT);
    if (!alreadySent) {
      const prepared = prepare ? await prepare(message.id) : null;
      if (prepared && prepared.updated === 0) {
        return {
          status: manualRetry ? 'conflict' : 'needs-review',
          messageId: message.id,
        };
      }
      if (!isCurrent()) return { status: 'stale', messageId: message.id };

      let result;
      try {
        result = await prompt(message.text);
      } catch (error) {
        return { status: 'uncertain', messageId: message.id, error };
      }
      if (!isCurrent()) return { status: 'stale', messageId: message.id };
      if (result?.sent !== 'sent') {
        const sent = result?.sent || null;
        if (!KNOWN_NOT_SENT.has(sent)) {
          return { status: 'uncertain', messageId: message.id, sent };
        }
        const released = release ? await release(message.id) : null;
        if (released && released.updated === 0) {
          return { status: 'uncertain', messageId: message.id, sent };
        }
        return { status: 'not-sent', messageId: message.id, sent };
      }
      sentMessageIds.add(message.id);
      try {
        const marked = markSent ? await markSent(message.id) : null;
        if (marked && marked.updated === 0) {
          return { status: 'uncertain', messageId: message.id, sent: 'sent' };
        }
      } catch (error) {
        return { status: 'uncertain', messageId: message.id, sent: 'sent', error };
      }
    }

    // Keep the marker on acknowledgement failure. The next poll retries only
    // the local acknowledgement instead of sending the host message again.
    await acknowledge(message.id);
    if (!isCurrent()) return { status: 'stale', messageId: message.id, alreadySent };
    sentMessageIds.delete(message.id);
    return { status: 'acknowledged', messageId: message.id, alreadySent };
  }

  return {
    has: (messageId) => sentMessageIds.has(messageId),
    reconcile,
    reset: () => sentMessageIds.clear(),
    sendAndAcknowledge,
  };
}
