import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { createSessionDeliveryTracker } from '../session-delivery.js';
import {
  COMMAND,
  buildCommandRequest,
  buildStateRequest,
  buildSessionInboxAckRequest,
  buildSessionInboxRequest,
  countUnresolvedIssues,
  parseCommandResponse,
  parseSessionInboxAckResponse,
  parseSessionInboxResponse,
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
    sessionSwitchTarget: null,
    pollTimer: null,
    inboxPollTimer: null,
    messageNote: '发送到当前会话，不创建新对话。',
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

  host.onReady((ctx) => {
    applyHostReady(ctx, document.documentElement);
    state.hostReady = true;
    state.session = ctx.session ?? null;
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
    state.session = session ?? null;
    state.sessionPhase = null;
    if (state.sessionSwitchTarget && state.session?.id === state.sessionSwitchTarget) {
      state.sessionSwitchBusy = false;
      if (!state.preserveDirectoryDuringSessionSwitch) state.sessionSwitchTarget = null;
      state.messageNote = '已切换到指定会话，等待桥接消息发送。';
    }
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
    state.sessionSwitchTarget = null;
    state.messageNote = '发送到当前会话，不创建新对话。';
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

  async function pollSessionInbox() {
    if (!state.hostReady || !state.directory) {
      scheduleInboxPoll();
      return;
    }
    const generation = state.generation;
    const directory = state.directory;
    state.inboxBusy = true;
    renderSession();
    try {
      const response = await host.serviceRequest(buildSessionInboxRequest(directory));
      if (isInboxStale(generation, directory)) return;
      const { messages } = parseSessionInboxResponse(response);
      state.deliveryTracker.reconcile(messages);
      const message = messages[0];
      if (!message) return;

      if (message.targetSessionId && state.session?.id !== message.targetSessionId) {
        if (state.sessionSwitchBusy) return;
        state.sessionSwitchBusy = true;
        state.sessionSwitchTarget = message.targetSessionId;
        state.messageNote = `正在打开指定会话 ${message.targetSessionId}…`;
        renderSession();
        try {
          state.preserveDirectoryDuringSessionSwitch = true;
          await host.openSession(message.targetSessionId);
          if (!isInboxStale(generation, directory) && state.session?.id === message.targetSessionId) {
            state.sessionSwitchBusy = false;
            state.sessionSwitchTarget = null;
            state.preserveDirectoryDuringSessionSwitch = false;
          }
        } catch (error) {
          if (!isInboxStale(generation, directory)) {
            state.sessionSwitchBusy = false;
            state.sessionSwitchTarget = null;
            state.preserveDirectoryDuringSessionSwitch = false;
            state.messageNote = `无法打开指定会话：${friendlyError(error)}`;
          }
        }
        return;
      }
      if (!canReceiveSessionMessage()) return;

      const alreadySent = state.deliveryTracker.has(message.id);
      state.messageNote = alreadySent
        ? '正在确认已发送的独立 HUD 消息…'
        : '正在把独立 HUD 消息发送到当前会话…';
      renderSession();
      const result = await state.deliveryTracker.sendAndAcknowledge({
        message,
        prompt: (text) => host.prompt({ text, send: true }),
        acknowledge: async (messageId) => {
          const acknowledged = await host.serviceRequest(buildSessionInboxAckRequest(directory, [messageId]));
          if (isInboxStale(generation, directory)) return;
          parseSessionInboxAckResponse(acknowledged);
        },
        isCurrent: () => !isInboxStale(generation, directory),
      });
      if (result.status === 'stale') return;
      if (result.status === 'not-sent') {
        state.messageNote = promptResultMessage(result.sent);
        return;
      }
      state.messageNote = '已从独立 HUD 转发到当前会话，不会创建新对话。';
    } catch (error) {
      if (!isInboxStale(generation, directory)) {
        state.messageNote = `会话桥接失败：${friendlyError(error)}`;
      }
    } finally {
      if (!isInboxStale(generation, directory)) {
        state.inboxBusy = false;
        renderSession();
        scheduleInboxPoll();
      }
    }
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

  function isInboxStale(generation, directory) {
    return generation !== state.generation || directory !== state.directory;
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
  };
  return messages[code] || (typeof error?.message === 'string' && error.message ? error.message : '操作失败，请刷新后重试。');
}
