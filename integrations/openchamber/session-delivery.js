// Keep a successfully sent message marked until its inbox acknowledgement
// succeeds. This prevents a lost acknowledgement response from sending the
// same host message again during the lifetime of the HUD.

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

  async function sendAndAcknowledge({ message, prompt, acknowledge, isCurrent = () => true } = {}) {
    if (!message || typeof message.id !== 'string' || !message.id) {
      throw new Error('会话桥接消息缺少有效 ID。');
    }
    if (typeof prompt !== 'function' || typeof acknowledge !== 'function') {
      throw new Error('会话桥接发送器缺少 prompt 或 acknowledge 回调。');
    }

    const alreadySent = sentMessageIds.has(message.id);
    if (!alreadySent) {
      const result = await prompt(message.text);
      if (!isCurrent()) return { status: 'stale', messageId: message.id };
      if (result?.sent !== 'sent') {
        return { status: 'not-sent', messageId: message.id, sent: result?.sent || null };
      }
      sentMessageIds.add(message.id);
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
