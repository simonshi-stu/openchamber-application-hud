import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { createSessionDeliveryTracker } from '../session-delivery.js';
import {
  COMMAND,
  buildCommandRequest,
  buildStateRequest,
  buildSessionInboxAckRequest,
  buildSessionInboxRequest,
  buildSessionInboxStateRequest,
  countUnresolvedIssues,
  parseCommandResponse,
  parseSessionInboxAckResponse,
  parseSessionInboxResponse,
  parseSessionInboxStateResponse,
  parseStateResponse,
  queueStateMeta,
  statusMeta,
} from '../contract.js';

const boot = document.querySelector('#boot');
const app = document.querySelector('#app');
const bootMessage = document.querySelector('#boot-message');

if (window.parent === window) {
  bootMessage.textContent = '请在 OpenChamber 扩展的 HUD 对话窗口中打开。';
} else {
  start();
}

function start() {
  let host;
  try {
    host = connectHost();
  } catch {
    bootMessage.textContent = '无法连接 OpenChamber 宿主；不会启动本地模拟数据。';
    return;
  }

  const state = {
    host,
    hostReady: false,
    initialized: false,
    directory: null,
    bridgeDirectory: null,
    contextDirectory: null,
    directoryInitialized: false,
    generation: 0,
    sessionEpoch: 0,
    requestSeq: 0,
    loadStatus: 'idle',
    loadError: null,
    revision: null,
    workbench: null,
    session: null,
    sessionPhase: null,
    commandBusy: false,
    messageBusy: false,
    inboxBusy: false,
    deliveryTracker: createSessionDeliveryTracker(),
    sessionSwitchBusy: false,
    sessionSwitchRequestPending: false,
    sessionSwitchTarget: null,
    pollTimer: null,
    inboxPollTimer: null,
    messageNote: '发送到当前会话，不创建新对话。',
    deliveryReview: null,
    deliveryTarget: null,
    manualRetryMessageId: null,
    manualRetryContext: null,
    preserveDirectoryDuringSessionSwitch: false,
  };

  const el = {
    app,
    boot,
    bootMessage,
    projectLabel: document.querySelector('#project-label'),
    queuePill: document.querySelector('#queue-pill'),
    refreshButton: document.querySelector('#refresh-button'),
    closeButton: document.querySelector('#close-button'),
    globalBanner: document.querySelector('#global-banner'),
    progressSummary: document.querySelector('#progress-summary'),
    progressPercent: document.querySelector('#progress-percent'),
    progressTrack: document.querySelector('.progress-track'),
    progressFill: document.querySelector('#progress-fill'),
    progressCount: document.querySelector('#progress-count'),
    issueCount: document.querySelector('#issue-count'),
    totalCount: document.querySelector('#total-count'),
    doneCount: document.querySelector('#done-count'),
    attentionCount: document.querySelector('#attention-count'),
    currentStatus: document.querySelector('#current-status'),
    currentCompany: document.querySelector('#current-company'),
    currentDetail: document.querySelector('#current-detail'),
    startButton: document.querySelector('#start-button'),
    pauseButton: document.querySelector('#pause-button'),
    resumeButton: document.querySelector('#resume-button'),
    sessionStatus: document.querySelector('#session-status'),
    sessionTitle: document.querySelector('#session-title'),
    sessionMessageForm: document.querySelector('#session-message-form'),
    sessionMessage: document.querySelector('#session-message'),
    sendMessageButton: document.querySelector('#send-message-button'),
    messageNote: document.querySelector('#message-note'),
    deliveryReview: document.querySelector('#delivery-review'),
    deliveryReviewTitle: document.querySelector('#delivery-review-title'),
    deliveryReviewMessage: document.querySelector('#delivery-review-message'),
    deliveryConfirmButton: document.querySelector('#delivery-confirm-button'),
    deliveryRetryButton: document.querySelector('#delivery-retry-button'),
    deliveryOpenTargetButton: document.querySelector('#delivery-open-target-button'),
  };

  const hostTimer = window.setTimeout(() => {
    if (state.hostReady) return;
    el.bootMessage.textContent = '未收到 OpenChamber 宿主响应，请从扩展菜单重新打开 HUD。';
  }, 12000);

  el.refreshButton.addEventListener('click', () => {
    void loadState();
  });
  el.closeButton.addEventListener('click', () => {
    void host.close().catch(() => {});
  });
  el.startButton.addEventListener('click', () => {
    void runCommand(COMMAND.start, {}, '队列已开始。');
  });
  el.pauseButton.addEventListener('click', () => {
    void runCommand(COMMAND.pause, {}, '队列已请求暂停。');
  });
  el.resumeButton.addEventListener('click', () => {
    void runCommand(COMMAND.resume, {}, '队列已恢复；请按当前公司阶段继续。');
  });
  el.sessionMessageForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendMessage();
  });
  el.deliveryConfirmButton.addEventListener('click', () => {
    void confirmDeliveryReview();
  });
  el.deliveryRetryButton.addEventListener('click', () => {
    void retryDeliveryReview();
  });
  el.deliveryOpenTargetButton.addEventListener('click', () => {
    void openDeliveryTarget();
  });

  host.onReady((ctx) => {
    applyHostReady(ctx, document.documentElement);
    state.hostReady = true;
    state.sessionEpoch += 1;
    state.session = ctx.session ?? null;
    refreshDeliverySessionContext();
    clearTimeout(hostTimer);
    if (!state.initialized) {
      state.initialized = true;
      el.boot.hidden = true;
      el.app.hidden = false;
    }
    updateProjectLabel();
    const itemDirectory = normalizeDirectory(ctx.item?.directory);
    const nextDirectory = itemDirectory || normalizeDirectory(ctx.directory);
    if (!state.directoryInitialized) {
      state.directoryInitialized = true;
      state.contextDirectory = itemDirectory;
      state.bridgeDirectory = nextDirectory;
      changeDirectory(nextDirectory);
      return;
    }
    if (state.preserveDirectoryDuringSessionSwitch && ctx.session?.id === state.sessionSwitchTarget) {
      state.sessionSwitchRequestPending = false;
      state.sessionSwitchBusy = false;
      state.preserveDirectoryDuringSessionSwitch = false;
      state.sessionSwitchTarget = null;
      render();
      scheduleInboxPoll(0);
      return;
    }
    if (nextDirectory !== state.directory) changeDirectory(nextDirectory);
    render();
  });

  host.onDirectory((directory) => {
    if (!state.hostReady || !state.directoryInitialized) return;
    if (state.contextDirectory || state.preserveDirectoryDuringSessionSwitch) return;
    const nextDirectory = normalizeDirectory(directory);
    if (nextDirectory !== state.directory) changeDirectory(nextDirectory);
  });

  host.onSession((session) => {
    state.sessionEpoch += 1;
    state.session = session ?? null;
    state.sessionPhase = null;
    if (state.sessionSwitchTarget && state.session?.id === state.sessionSwitchTarget) {
      if (!state.sessionSwitchRequestPending) state.sessionSwitchBusy = false;
      if (!state.preserveDirectoryDuringSessionSwitch) state.sessionSwitchTarget = null;
      state.messageNote = '已切换到指定会话，等待桥接消息发送。';
    }
    refreshDeliverySessionContext();
    renderSession();
    scheduleInboxPoll(0);
  });

  host.onSessionLifecycle((event) => {
    if (!state.session || event.sessionId !== state.session.id) return;
    state.sessionPhase = event.phase;
    renderSession();
    if (event.phase !== 'started') scheduleInboxPoll(0);
  });

  window.addEventListener('pagehide', () => {
    clearTimeout(hostTimer);
    clearPollTimer();
    clearInboxPollTimer();
    host.dispose();
  });

  function changeDirectory(nextDirectory) {
    state.generation += 1;
    state.requestSeq += 1;
    state.directory = nextDirectory;
    state.bridgeDirectory = nextDirectory;
    state.revision = null;
    state.workbench = null;
    state.loadError = null;
    state.loadStatus = nextDirectory ? 'loading' : 'no-directory';
    state.inboxBusy = false;
    state.sessionSwitchBusy = false;
    state.sessionSwitchRequestPending = false;
    state.sessionSwitchTarget = null;
    state.messageNote = '发送到当前会话，不创建新对话。';
    state.deliveryReview = null;
    state.deliveryTarget = null;
    state.manualRetryMessageId = null;
    state.manualRetryContext = null;
    state.deliveryTracker.reset();
    clearPollTimer();
    clearInboxPollTimer();
    updateProjectLabel();
    render();
    if (nextDirectory) void loadState();
  }

  async function loadState() {
    if (!state.hostReady || !state.directory) {
      state.loadStatus = state.directory ? 'idle' : 'no-directory';
      render();
      return;
    }
    clearPollTimer();
    const generation = state.generation;
    const directory = state.bridgeDirectory || state.directory;
    const requestSeq = ++state.requestSeq;
    state.loadStatus = 'loading';
    state.loadError = null;
    render();
    try {
      const result = await host.serviceRequest(buildStateRequest(directory));
      if (isStale(generation, requestSeq, directory)) return;
      const parsed = parseStateResponse(result);
      state.revision = parsed.revision;
      state.workbench = parsed.state;
      state.loadStatus = 'ready';
      render();
      schedulePoll();
      scheduleInboxPoll(0);
    } catch (error) {
      if (isStale(generation, requestSeq, directory)) return;
      state.loadStatus = 'error';
      state.loadError = error;
      render();
      schedulePoll(5000);
      scheduleInboxPoll(5000);
    }
  }

  async function runCommand(command, input, successMessage) {
    if (!state.directory || !state.workbench || state.loadStatus !== 'ready' || state.loadError) {
      showBanner('warning', '任务状态尚未就绪，请先刷新。');
      return;
    }
    if (state.commandBusy) {
      showBanner('info', '上一个队列操作仍在处理，请稍候。');
      return;
    }
    const generation = state.generation;
    const directory = state.directory;
    state.commandBusy = true;
    clearPollTimer();
    renderControls();
    try {
      const result = await host.serviceRequest(buildCommandRequest({
        directory,
        command,
        input,
        expectedRevision: state.revision ?? undefined,
      }));
      if (generation !== state.generation || directory !== state.directory) return;
      const parsed = parseCommandResponse(result);
      state.revision = parsed.revision;
      if (parsed.state) {
        state.workbench = parsed.state;
        state.loadStatus = 'ready';
        state.loadError = null;
        render();
        showBanner('success', successMessage);
        schedulePoll();
      } else {
        await loadState();
        if (generation === state.generation && directory === state.directory) {
          showBanner('success', successMessage);
        }
      }
    } catch (error) {
      if (generation !== state.generation || directory !== state.directory) return;
      state.loadError = error;
      showError(error);
      render();
      schedulePoll(5000);
    } finally {
      if (generation === state.generation) {
        state.commandBusy = false;
        renderControls();
      }
    }
  }

  async function sendMessage() {
    const text = el.sessionMessage.value;
    if (!text.trim() || !state.session || state.messageBusy || state.inboxBusy) return;
    state.messageBusy = true;
    state.messageNote = '正在发送到当前会话…';
    renderSession();
    try {
      const result = await host.prompt({ text, send: true });
      if (result.sent !== 'sent') {
        state.messageNote = promptResultMessage(result.sent);
        return;
      }
      el.sessionMessage.value = '';
      state.messageNote = '已发送到当前会话，不会创建新对话。';
    } catch (error) {
      state.messageNote = `发送失败：${friendlyError(error)}`;
    } finally {
      state.messageBusy = false;
      renderSession();
      scheduleInboxPoll(0);
    }
  }

  async function pollSessionInbox({ manualRetryMessageId = null, manualRetryContext = null } = {}) {
    if (!state.hostReady || !state.directory) {
      scheduleInboxPoll();
      return;
    }
    const requestedRetryId = manualRetryMessageId ?? state.manualRetryMessageId;
    const isManualRetry = typeof requestedRetryId === 'string' && requestedRetryId.length > 0;
    const retryContext = manualRetryContext ?? state.manualRetryContext;
    const generation = state.generation;
    const directory = state.directory;
    const sessionEpoch = state.sessionEpoch;
    const sessionId = currentSessionId();
    let message = null;
    state.inboxBusy = true;
    renderSession();
    try {
      const response = await host.serviceRequest(buildSessionInboxRequest(directory));
      if (isInboxStale(generation, directory, sessionEpoch, sessionId)) return;
      const { messages } = parseSessionInboxResponse(response);
      state.deliveryTracker.reconcile(messages);
      message = isManualRetry
        ? messages.find((item) => item.id === requestedRetryId) ?? null
        : messages[0] ?? null;
      if (!message) {
        if (isManualRetry) {
          state.messageNote = `指定消息 ${requestedRetryId} 已不在本地队列，未操作其他消息。`;
        } else {
          state.deliveryReview = null;
          state.deliveryTarget = null;
        }
        return;
      }
      if (message.targetSessionId && currentSessionId() !== message.targetSessionId) {
        state.deliveryTarget = createDeliveryContext(message, generation);
        state.deliveryReview = message.deliveryState === 'needs_review'
          ? state.deliveryTarget
          : null;
        state.messageNote = message.deliveryState === 'needs_review'
          ? `送达结果未知；请先打开目标会话 ${message.targetSessionId}，不会在当前会话确认或重试。`
          : `消息目标为会话 ${message.targetSessionId}；请先明确打开该已有会话，不会创建会话或发送。`;
        return;
      }
      state.deliveryTarget = null;
      if (isManualRetry && message.deliveryState !== 'needs_review') {
        state.deliveryReview = createDeliveryContext(
          { ...message, deliveryState: 'conflict' },
          generation,
        );
        state.messageNote = '消息状态已变化，未执行指定 ID 的人工重试；仍需重新核对。';
        return;
      }
      if (message.deliveryState === 'needs_review' && !isManualRetry) {
        state.deliveryReview = createDeliveryContext(message, generation);
        state.messageNote = message.targetSessionId
          ? '消息送达结果未知，已暂停；请核对指定目标会话，不会自动重发或丢弃。'
          : '消息送达结果未知，已暂停；原消息没有可证明的目标会话，不会猜测当前会话。';
        return;
      }
      if (isManualRetry && !isDeliveryActionCurrent(retryContext)) return;
      if (!canReceiveSessionMessage()) return;

      const alreadySent = state.deliveryTracker.has(message.id) || message.deliveryState === 'sent';
      state.messageNote = isManualRetry
        ? '正在按本人授权对指定消息执行一次人工重试…'
        : alreadySent
          ? '正在确认已发送的独立 HUD 消息…'
          : '正在把独立 HUD 消息发送到当前会话…';
      renderSession();
      const isCurrent = () => (
        !isInboxStale(generation, directory, sessionEpoch, sessionId)
        && (!isManualRetry || isDeliveryActionCurrent(retryContext))
      );
      const result = await state.deliveryTracker.sendAndAcknowledge({
        message,
        manualRetry: isManualRetry,
        prepare: async (messageId) => {
          const prepared = await host.serviceRequest(
            buildSessionInboxStateRequest(directory, [messageId], 'needs_review'),
          );
          if (!isCurrent()) return { updated: 0 };
          return parseSessionInboxStateResponse(prepared);
        },
        prompt: (text) => host.prompt({ text, send: true }),
        markSent: async (messageId) => {
          const marked = await host.serviceRequest(
            buildSessionInboxStateRequest(directory, [messageId], 'sent'),
          );
          if (!isCurrent()) return { updated: 0 };
          return parseSessionInboxStateResponse(marked);
        },
        release: async (messageId) => {
          const released = await host.serviceRequest(
            buildSessionInboxStateRequest(directory, [messageId], 'pending'),
          );
          if (!isCurrent()) return { updated: 0 };
          return parseSessionInboxStateResponse(released);
        },
        acknowledge: async (messageId) => {
          const acknowledged = await host.serviceRequest(buildSessionInboxAckRequest(directory, [messageId]));
          if (!isCurrent()) return;
          parseSessionInboxAckResponse(acknowledged);
        },
        isCurrent,
      });
      if (result.status === 'stale') return;
      if (result.status === 'conflict') {
        state.deliveryReview = createDeliveryContext(
          { ...message, deliveryState: 'needs_review' },
          generation,
        );
        state.messageNote = '消息状态已变化，未执行指定 ID 的人工重试；仍待本人核对。';
        return;
      }
      if (result.status === 'needs-review' || result.status === 'uncertain') {
        state.deliveryReview = createDeliveryContext(
          { ...message, deliveryState: 'needs_review' },
          generation,
        );
        state.messageNote = '宿主没有可靠的送达结论，消息已停在待人工核对；不会自动重发或丢弃。';
        return;
      }
      if (result.status === 'not-sent') {
        state.deliveryReview = null;
        state.messageNote = promptResultMessage(result.sent);
        return;
      }
      state.deliveryReview = null;
      state.messageNote = isManualRetry
        ? '指定消息已完成一次人工重试并确认消费，不会创建新对话。'
        : '已从独立 HUD 转发到当前会话，不会创建新对话。';
    } catch (error) {
      if (isInboxScopeCurrent(generation, directory)) {
        state.messageNote = message?.deliveryState === 'sent' || state.deliveryTracker.has(message?.id)
          ? `已送达消息的本地确认失败：${friendlyError(error)}；不会重发。`
          : isManualRetry
            ? `人工重试未执行：${friendlyError(error)}`
            : `会话桥接失败：${friendlyError(error)}`;
      }
    } finally {
      if (isInboxScopeCurrent(generation, directory)) {
        state.inboxBusy = false;
        if (isManualRetry && state.manualRetryMessageId === requestedRetryId) {
          state.manualRetryMessageId = null;
          state.manualRetryContext = null;
        }
        renderSession();
        scheduleInboxPoll();
      }
    }
  }

  async function confirmDeliveryReview() {
    const review = state.deliveryReview;
    if (!canActOnDeliveryReview(review)) return;
    const action = captureDeliveryActionContext(review);
    const generation = state.generation;
    const directory = state.directory;
    state.inboxBusy = true;
    state.messageNote = '正在按本人核对结果移除指定消息…';
    renderSession();
    try {
      if (!isDeliveryActionCurrent(action)) return;
      const response = await host.serviceRequest(buildSessionInboxAckRequest(directory, [action.messageId]));
      if (!isDeliveryActionCurrent(action)) return;
      const result = parseSessionInboxAckResponse(response);
      state.deliveryReview = null;
      state.deliveryTarget = null;
      state.messageNote = result.acknowledged > 0
        ? '已按本人确认移除指定消息；不会再次发送。'
        : '指定消息已不在本地队列；不会再次发送。';
    } catch (error) {
      if (isInboxScopeCurrent(generation, directory) && isDeliveryActionCurrent(action)) {
        state.messageNote = `人工核对处理失败：${friendlyError(error)}`;
      }
    } finally {
      if (isInboxScopeCurrent(generation, directory)) {
        state.inboxBusy = false;
        renderSession();
        scheduleInboxPoll(0);
      }
    }
  }

  async function retryDeliveryReview() {
    const review = state.deliveryReview;
    if (!canActOnDeliveryReview(review)) return;
    const action = captureDeliveryActionContext(review);
    state.manualRetryMessageId = action.messageId;
    state.manualRetryContext = action;
    clearInboxPollTimer();
    state.messageNote = '正在记录本人确认，准备一次人工重试…';
    renderSession();
    await pollSessionInbox({
      manualRetryMessageId: action.messageId,
      manualRetryContext: action,
    });
  }

  async function openDeliveryTarget() {
    const target = state.deliveryTarget || state.deliveryReview;
    if (!target?.targetSessionId || !state.directory || state.sessionSwitchBusy) return;
    if (target.reviewGeneration !== state.generation) return;
    if (currentSessionId() === target.targetSessionId) return;
    const generation = state.generation;
    const directory = state.directory;
    state.sessionSwitchBusy = true;
    state.sessionSwitchRequestPending = true;
    state.sessionSwitchTarget = target.targetSessionId;
    state.preserveDirectoryDuringSessionSwitch = true;
    state.messageNote = `正在打开指定会话 ${target.targetSessionId}；不会创建会话或发送消息…`;
    renderSession();
    try {
      await host.openSession(target.targetSessionId);
      if (!isInboxScopeCurrent(generation, directory)) return;
      if (currentSessionId() === target.targetSessionId) {
        state.sessionSwitchRequestPending = false;
        state.sessionSwitchBusy = false;
        state.sessionSwitchTarget = null;
        state.preserveDirectoryDuringSessionSwitch = false;
        state.messageNote = '已打开指定会话，等待重新核对桥接消息。';
        scheduleInboxPoll(0);
      } else {
        state.messageNote = `已请求打开指定会话 ${target.targetSessionId}，等待宿主切换完成…`;
      }
    } catch (error) {
      if (isInboxScopeCurrent(generation, directory)) {
        state.sessionSwitchRequestPending = false;
        state.sessionSwitchBusy = false;
        state.sessionSwitchTarget = null;
        state.preserveDirectoryDuringSessionSwitch = false;
        state.messageNote = `无法打开指定会话：${friendlyError(error)}`;
      }
    } finally {
      if (isInboxScopeCurrent(generation, directory)) renderSession();
    }
  }

  function createDeliveryContext(message, generation) {
    return {
      ...message,
      reviewGeneration: generation,
      reviewSessionEpoch: state.sessionEpoch,
      reviewSessionId: currentSessionId(),
    };
  }

  function refreshDeliverySessionContext() {
    if (state.deliveryReview) {
      state.deliveryReview = {
        ...state.deliveryReview,
        reviewSessionEpoch: state.sessionEpoch,
        reviewSessionId: currentSessionId(),
      };
    }
    if (state.deliveryTarget) {
      state.deliveryTarget = {
        ...state.deliveryTarget,
        reviewSessionEpoch: state.sessionEpoch,
        reviewSessionId: currentSessionId(),
      };
    }
  }

  function captureDeliveryActionContext(review) {
    return {
      messageId: review.id,
      targetSessionId: review.targetSessionId,
      reviewGeneration: review.reviewGeneration,
      reviewSessionEpoch: state.sessionEpoch,
      reviewSessionId: currentSessionId(),
    };
  }

  function isDeliveryActionCurrent(action) {
    const review = state.deliveryReview;
    return Boolean(
      action
      && review
      && review.id === action.messageId
      && review.deliveryState === 'needs_review'
      && review.reviewGeneration === state.generation
      && action.reviewGeneration === state.generation
      && review.targetSessionId === action.targetSessionId
      && action.reviewSessionEpoch === state.sessionEpoch
      && action.reviewSessionId === currentSessionId()
      && action.targetSessionId
      && currentSessionId() === action.targetSessionId
      && !state.sessionSwitchBusy
      && canReceiveSessionMessage(),
    );
  }

  function canActOnDeliveryReview(review) {
    return Boolean(review && !state.inboxBusy && isDeliveryActionCurrent({
      messageId: review.id,
      targetSessionId: review.targetSessionId,
      reviewGeneration: review.reviewGeneration,
      reviewSessionEpoch: state.sessionEpoch,
      reviewSessionId: currentSessionId(),
    }));
  }

  function isStale(generation, requestSeq, directory) {
    return generation !== state.generation || requestSeq !== state.requestSeq || directory !== state.directory;
  }

  function schedulePoll(delay = 3000) {
    clearPollTimer();
    if (!state.hostReady || !state.directory) return;
    state.pollTimer = window.setTimeout(() => {
      state.pollTimer = null;
      if (state.commandBusy) {
        schedulePoll(1000);
        return;
      }
      void loadState();
    }, delay);
  }

  function scheduleInboxPoll(delay = 3000) {
    clearInboxPollTimer();
    if (!state.hostReady || !state.directory) return;
    state.inboxPollTimer = window.setTimeout(() => {
      state.inboxPollTimer = null;
      if (state.inboxBusy || state.messageBusy) {
        scheduleInboxPoll(1000);
        return;
      }
      void pollSessionInbox();
    }, delay);
  }

  function clearPollTimer() {
    if (state.pollTimer) window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  function clearInboxPollTimer() {
    if (state.inboxPollTimer) window.clearTimeout(state.inboxPollTimer);
    state.inboxPollTimer = null;
  }

  function canReceiveSessionMessage() {
    return Boolean(
      state.session
      && state.session.id
      && state.session.busy !== true
      && state.sessionPhase !== 'started',
    );
  }

  function currentSessionId() {
    return typeof state.session?.id === 'string' && state.session.id ? state.session.id : null;
  }

  function isInboxScopeCurrent(generation, directory) {
    return generation === state.generation && directory === state.directory;
  }

  function isInboxStale(generation, directory, sessionEpoch = null, sessionId = null) {
    return !isInboxScopeCurrent(generation, directory)
      || (sessionEpoch !== null
        && (sessionEpoch !== state.sessionEpoch || sessionId !== currentSessionId()));
  }

  function render() {
    updateProjectLabel();
    renderQueue();
    renderProgress();
    renderCurrentCompany();
    renderControls();
    renderSession();
    renderBanner();
  }

  function renderQueue() {
    const queue = state.workbench?.queue;
    const meta = queueStateMeta(queue?.state ?? 'unknown');
    setPill(el.queuePill, meta.label, meta.tone);
  }

  function renderProgress() {
    const companies = state.workbench?.companies ?? [];
    const done = companies.filter(isCompletedCompany).length;
    const attention = companies.filter((company) => [
      'awaiting_user',
      'awaiting_submit',
      'search_blocked',
      'deferred',
      'failed',
    ].includes(company.status)).length;
    const percent = companies.length > 0 ? Math.round((done / companies.length) * 100) : 0;
    const queue = state.workbench?.queue;
    const summary = queue?.message || (
      state.loadStatus === 'loading'
        ? '正在读取本地服务…'
        : state.loadStatus === 'error'
          ? '任务状态不可用'
          : state.directory
            ? `${companies.length} 家公司`
            : '未打开项目'
    );
    el.progressSummary.textContent = summary;
    el.progressPercent.textContent = `${percent}%`;
    el.progressTrack.setAttribute('aria-valuenow', String(percent));
    el.progressFill.style.width = `${percent}%`;
    el.progressCount.textContent = `${done} / ${companies.length} 家公司`;
    el.issueCount.textContent = `待处理问题 ${state.workbench ? countUnresolvedIssues(state.workbench.issues) : 0}`;
    el.totalCount.textContent = String(companies.length);
    el.doneCount.textContent = String(done);
    el.attentionCount.textContent = String(attention);
  }

  function renderCurrentCompany() {
    const workbench = state.workbench;
    const queue = workbench?.queue;
    const activeId = queue?.activeCompanyId || workbench?.currentCompanyId;
    const company = workbench?.companies?.find((item) => item.id === activeId) ?? null;
    if (!company) {
      setPill(el.currentStatus, '暂无', 'neutral');
      el.currentCompany.textContent = '暂无活动公司';
      el.currentDetail.textContent = queue?.message || (state.directory ? '队列尚未开始。' : '请先在 OpenChamber 中打开项目。');
      return;
    }
    const meta = statusMeta(company.status);
    setPill(el.currentStatus, meta.label, meta.tone);
    el.currentCompany.textContent = company.name;
    const activeJob = company.jobs?.find((job) => job.id === company.activePositionId);
    const parts = [meta.label];
    if (activeJob) parts.push(activeJob.title);
    if (queue?.state === 'paused') {
      parts.push('队列已暂停，请点击“恢复队列”继续。');
    } else if (queue?.state === 'running' && company.status === 'awaiting_login') {
      parts.push('队列已运行，请本人登录后在任务池中记录“我已登录”。');
    } else if (queue?.message) {
      parts.push(queue.message);
    }
    el.currentDetail.textContent = parts.join(' · ');
  }

  function renderControls() {
    const queueState = state.workbench?.queue?.state;
    const ready = Boolean(state.workbench && state.loadStatus === 'ready' && !state.loadError);
    const hasCompanies = (state.workbench?.companies ?? []).length > 0;
    const busy = state.commandBusy;
    const paused = queueState === 'paused';
    const activeId = state.workbench?.queue?.activeCompanyId || state.workbench?.currentCompanyId;
    const activeCompany = (state.workbench?.companies ?? []).find((company) => company.id === activeId);
    const awaitingLogin = queueState === 'running' && activeCompany?.status === 'awaiting_login';
    el.refreshButton.disabled = state.loadStatus === 'loading';
    el.startButton.disabled = !ready || busy || !hasCompanies || !['idle', 'completed'].includes(queueState);
    el.pauseButton.disabled = !ready || busy || !['running', 'blocked'].includes(queueState);
    el.resumeButton.disabled = !ready || busy || queueState !== 'paused';
    el.startButton.textContent = paused ? '已暂停' : awaitingLogin ? '队列已运行' : '开始队列';
    el.startButton.title = paused
      ? '队列已暂停，请点击“恢复队列”继续。'
      : awaitingLogin
        ? '队列已经运行，请本人登录后在任务池中记录“我已登录”。'
        : '';
    el.resumeButton.textContent = paused ? '恢复队列' : '恢复';
    el.resumeButton.classList.toggle('primary', paused);
    el.resumeButton.classList.toggle('outline', !paused);
  }

  function renderSession() {
    const session = state.session;
    const status = session
      ? session.busy || state.sessionPhase === 'started'
        ? { label: '处理中', tone: 'info' }
        : state.sessionPhase === 'failure'
          ? { label: '失败', tone: 'error' }
          : { label: '空闲', tone: 'success' }
      : { label: '未连接', tone: 'neutral' };
    setPill(el.sessionStatus, status.label, status.tone);
    el.sessionTitle.textContent = session ? session.title : '没有当前会话';
    el.messageNote.textContent = state.messageNote;
    // Background inbox polling must not disable the textarea: changing the
    // disabled state steals focus and interrupts typing every poll cycle.
    el.sessionMessage.disabled = !session || state.messageBusy;
    el.sendMessageButton.disabled = !session || state.messageBusy || state.inboxBusy;
    el.sendMessageButton.textContent = state.messageBusy || state.inboxBusy ? '发送中…' : '发送';
    const review = state.deliveryReview;
    const target = state.deliveryTarget;
    const delivery = review || target;
    const targetSessionId = delivery?.targetSessionId || null;
    const currentSession = currentSessionId();
    const targetMatches = Boolean(targetSessionId && targetSessionId === currentSession);
    const reviewActionsEnabled = Boolean(review && canActOnDeliveryReview(review));
    el.deliveryReview.hidden = !delivery;
    el.deliveryReviewTitle.textContent = review ? '桥接消息待人工核对' : '桥接消息等待目标会话';
    el.deliveryReviewMessage.textContent = delivery
      ? [
        `消息 ID：${delivery.id}`,
        `目标会话：${targetSessionId || '无法证明（旧消息未绑定目标会话）'}`,
        `当前会话：${currentSession || '无'}`,
        `内容摘要：${messageSummary(delivery.text)}`,
        review
          ? targetMatches
            ? '送达结果未知；请本人确认已送达或允许一次人工重试。'
            : '送达结果未知；目标不匹配时禁止确认或重试。'
          : '请先明确打开该已有目标会话；不会创建会话或发送消息。',
      ].join(' · ')
      : '';
    el.deliveryConfirmButton.disabled = !reviewActionsEnabled;
    el.deliveryRetryButton.disabled = !reviewActionsEnabled;
    el.deliveryOpenTargetButton.hidden = !targetSessionId || targetMatches;
    el.deliveryOpenTargetButton.disabled = !targetSessionId
      || targetMatches
      || state.inboxBusy
      || state.sessionSwitchBusy;
  }

  function renderBanner() {
    if (!state.directory) {
      showBanner('warning', '未打开项目：任务池状态不可用。');
      return;
    }
    if (state.loadStatus === 'error' && state.loadError) {
      showBanner('error', friendlyError(state.loadError));
      return;
    }
    if (state.deliveryReview || state.deliveryTarget) {
      showBanner(
        'warning',
        state.deliveryReview
          ? '会话桥接消息送达结果未知，已暂停等待本人核对。'
          : '会话桥接消息绑定了其他会话；不会在当前会话发送。',
      );
      return;
    }
    if (state.workbench?.recoveryPending) {
      showBanner('warning', '检测到中断恢复现场；请在任务池面板中先完成本人观察确认。');
      return;
    }
    if (!state.workbench && state.loadStatus === 'loading') {
      showBanner('info', '正在读取当前项目的任务状态…');
      return;
    }
    el.globalBanner.hidden = true;
    el.globalBanner.textContent = '';
  }

  function showBanner(tone, message) {
    el.globalBanner.hidden = false;
    el.globalBanner.dataset.tone = tone;
    el.globalBanner.textContent = message;
  }

  function showError(error) {
    showBanner('error', friendlyError(error));
  }

  function updateProjectLabel() {
    const name = basename(state.directory);
    el.projectLabel.textContent = name ? `项目：${name}` : '项目未加载';
    el.projectLabel.title = state.directory || '';
  }
}

function isCompletedCompany(company) {
  const terminalStatuses = new Set([
    'completed',
    'submitted_self_reported',
    'submitted_verified',
    'no_suitable_jobs',
    'skipped',
  ]);
  const terminalApplications = new Set(['self_reported', 'verified', 'no_suitable_jobs', 'skipped']);
  return terminalStatuses.has(company.status) || terminalApplications.has(company.application?.kind);
}

function setPill(element, label, tone) {
  element.textContent = label;
  element.dataset.tone = tone;
}

function normalizeDirectory(directory) {
  return typeof directory === 'string' && directory ? directory : null;
}

function basename(value) {
  if (!value) return '';
  const parts = String(value).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || value;
}

function messageSummary(value, maxLength = 180) {
  const normalized = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function promptResultMessage(sent) {
  if (sent === 'no-model') return '当前会话没有可用模型，消息未发送。';
  if (sent === 'skipped') return '宿主跳过了本次发送，消息未发送。';
  return '当前会话未接受消息，消息未发送。';
}

function friendlyError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const messages = {
    HOST_TIMEOUT: 'OpenChamber 响应超时。',
    NO_SERVICE: '本地任务服务未启动。',
    SERVICE_FAILED: '本地任务服务启动失败。',
    REVISION_CONFLICT: '任务状态已在别处更新，请刷新后再操作。',
    QUEUE_BUSY: '另一家公司仍在处理中。',
    QUEUE_NOT_RUNNING: '队列当前未运行。',
    QUEUE_PAUSED: '队列已暂停，请点击“恢复队列”。',
    QUEUE_NOT_PAUSED: '队列当前不是暂停状态。',
    SESSION_BUSY: '当前会话正在处理，请稍后再发送。',
    NO_SESSION: '当前没有可用会话。',
    SESSION_INBOX_BUSY: '会话桥接队列正由另一个窗口更新，请稍后重试。',
    INVALID_SESSION_INBOX_RESPONSE: '会话桥接响应无效，消息仍保留在队列中。',
    INVALID_SESSION_ID: '目标会话 ID 无效，消息仍保留在队列中。',
    INVALID_SESSION_DELIVERY_STATE: '会话桥接送达状态无效，消息仍保留在队列中。',
    SESSION_DELIVERY_CONFLICT: '消息状态已变化，未执行重试。',
  };
  return messages[code] || (typeof error?.message === 'string' && error.message ? error.message : '操作失败，请刷新后重试。');
}
