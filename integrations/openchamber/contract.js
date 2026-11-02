/**
 * Application Copilot OpenChamber panel <-> local host service contract.
 *
 * This module is intentionally dependency-free and browser-safe. It is not an
 * OpenChamber host SDK protocol and never talks to postMessage directly; the
 * panel calls the declared local service through host.serviceRequest().
 *
 * Transport
 * ---------
 * The host spawns `service/main.js`, passes OPENCHAMBER_SERVICE_PORT and
 * OPENCHAMBER_SERVICE_TOKEN, and proxies `host.serviceRequest()` only to that
 * loopback listener. Every service request, including GET /health, must check
 * `Authorization: Bearer <OPENCHAMBER_SERVICE_TOKEN>`. The panel never sees the
 * token and never dials the port.
 *
 * Endpoints
 * ---------
 * POST /api/command
 *   { directory, command, input, expectedRevision? }
 *   success: { ok: true, revision: <int>, state?: WorkbenchState, result?: object }
 *   failure: { ok: false, error: { code, message, details? } } with a non-2xx status
 *
 * GET /api/state?directory=<project directory>
 *   success: { ok: true, revision: <int>, state: WorkbenchState }
 *
 * GET /api/capabilities
 *   success: { ok: true, capabilities: {
 *     apiVersion: 1, backend, version?, commands: string[],
 *     features?: string[], limitations?: string[],
 *     secureModelCredentials?: boolean, roleExecution?: boolean,
 *     apiKeyStorage?: boolean, modelExecution?: boolean
 *   } }
 *
 * GET /health  (host readiness probe only; the panel must not call it)
 *   200 once the service is ready to accept authenticated requests.
 *
 * Session bridge
 * --------------
 * GET /api/session-inbox?directory=<project directory>
 *   Returns messages queued by the standalone HUD. The OpenChamber guest may
 * send them to the current session and acknowledge them one at a time.
 * POST /api/session-inbox/ack
 *   { directory, messageIds }
 * POST /api/session-inbox/state
 *   { directory, messageIds, state: 'needs_review' | 'sent' | 'pending' }
 *
 * A queued message may carry `targetSessionId`; the HUD opens that exact
 * host session before calling `host.prompt`, then acknowledges only after send.
 * `deliveryState: 'needs_review'` blocks automatic sending after an unknown
 * host result; `deliveryState: 'sent'` permits only a local acknowledgement.
 *
 * WorkbenchState (only the fields the panel needs; unknown fields are ignored)
 * -------------------------------------------------------------------------
 * {
 *   generatedAt?: ISO string, recoveryPending?: boolean, currentCompanyId?: string,
 *   queue: { state|panelState: 'idle'|'running'|'paused'|'completed',
 *            coreState|status?: string, activeCompanyId|currentCompanyId?: string,
 *            message?: string, updatedAt?: ISO },
 *   companies: [{
 *     id, name, queuePosition, status|panelStatus, coreStatus?,
 *     activePositionId?, selectedPositionIds?, holdReason?, skipReason?,
 *     links: [{ url, label?, source? }],
 *     referralCodes: [{ value, source?, selected?: boolean }],
 *     search: { state, message?, evidenceUrl?, checkedAt?, checkedBy?, resultText? },
 *     jobs: [{ id, title, jobId?, city?, officialUrl?, status, coreStatus?,
 *              selected?: boolean, priority?: 1..3, evidence?, skipReason?,
 *              submission?: { reportedAt?, reference? },
 *              verification?: { verifiedAt?, sourceUrl?, evidenceText? } }],
 *     application: { kind, jobIds?: string[], note?, reportedAt?, verifiedAt? },
 *     note?, updatedAt?
 *   }],
 *   issues: [{ id, companyId?, companyName?, jobId?, field?,
 *              severity: 'required'|'confirm'|'suggestion',
 *              status: 'open'|'answered'|'deferred'|'resolved',
 *              blocking?: boolean, title, detail?, evidence?, answer?,
 *              version?, createdAt?, updatedAt? }],
 *   issueDigest?: { id, ready: true, issueIds?: string[], createdAt? } | null,
 *   models: { [role in search|execution|review]: {
 *     provider, model, endpoint?, apiKeySet: boolean
 *   } },
 *   facts: [{ id, section, coreSection?, entityId?, label, rawText,
 *             confirmedText?, confirmed: boolean, source?, sensitive?,
 *             version?, updatedAt? }]
 * }
 *
 * `section` values include `project_content` and
 * `project_responsibilities`; `entityId` is the stable experience/project id
 * that keeps same-named fields separate. `skills` maps to core `skill`/`language`
 * in the backend.
 *
 * State is read-only for the panel. There is deliberately no HTTP command that
 * replaces the whole state file or forwards arbitrary objects. `expectedRevision`
 * is optimistic concurrency: a stale command must get 409 with
 * error.code = 'REVISION_CONFLICT'; the panel then asks the user to review,
 * never to retry a submission report automatically.
 *
 * Commands
 * --------
 * The panel sends only user.* commands listed in UI_COMMANDS. In addition to
 * enqueue/start/pause/resume/prioritizeCompany/selectJobs/reportSubmitted, the panel records
 * human receipts with confirmLogin and markReady, holds with deferCompany /
 * resumeCompany / skipCompany / skipJob, manual evidence with recordCandidates
 * / recordNoPositions, issue answers with resolveIssue (answer/defer/resolve),
 * and profile changes with importFacts / confirmFact / reviseFact. agent.*
 * names are reserved for the local orchestrator and must be narrow events,
 * never a "write whole state" escape hatch. There is no submit, verify,
 * writeState or replaceState command in either namespace.
 */

export const CONTRACT_VERSION = 1;

export const API_PATHS = Object.freeze({
  command: '/api/command',
  state: '/api/state',
  capabilities: '/api/capabilities',
  health: '/health',
  sessionInbox: '/api/session-inbox',
  sessionInboxAck: '/api/session-inbox/ack',
  sessionInboxState: '/api/session-inbox/state',
});

export const SESSION_DELIVERY_STATE = Object.freeze({
  pending: 'pending',
  sent: 'sent',
  needsReview: 'needs_review',
});

export const SESSION_DELIVERY_STATES = Object.freeze(Object.values(SESSION_DELIVERY_STATE));

export const COMMAND_PREFIX = Object.freeze({
  user: 'user.',
  agent: 'agent.',
});

/** Commands the panel may send. */
export const COMMAND = Object.freeze({
  enqueue: 'user.enqueue',
  start: 'user.start',
  pause: 'user.pause',
  resume: 'user.resume',
  prioritizeCompany: 'user.prioritizeCompany',
  confirmLogin: 'user.confirmLogin',
  selectJobs: 'user.selectJobs',
  reportSubmitted: 'user.reportSubmitted',
  reportHistoricalSubmission: 'user.reportHistoricalSubmission',
  markReady: 'user.markReady',
  deferCompany: 'user.deferCompany',
  resumeCompany: 'user.resumeCompany',
  skipCompany: 'user.skipCompany',
  skipJob: 'user.skipJob',
  resolveIssue: 'user.resolveIssue',
  saveModels: 'user.saveModels',
  importFacts: 'user.importFacts',
  confirmFact: 'user.confirmFact',
  reviseFact: 'user.reviseFact',
  recordCandidates: 'user.recordCandidates',
  recordNoPositions: 'user.recordNoPositions',
  acknowledgeRecovery: 'user.acknowledgeRecovery',
  mokaOpen: 'user.mokaOpen',
  mokaResearch: 'user.mokaResearch',
  mokaPrepareFill: 'user.mokaPrepareFill',
  mokaRunFill: 'user.mokaRunFill',
  mokaCancel: 'user.mokaCancel',
});

export const UI_COMMANDS = Object.freeze(Object.values(COMMAND));

/**
 * Reserved for the local orchestrator. The panel never sends one of these.
 * Every event is intentionally narrow: there is no agent.replaceState,
 * agent.writeState or agent.submit command in this contract.
 */
export const AGENT_COMMANDS = Object.freeze([
  'agent.reportSearchProgress',
  'agent.proposeJobCandidates',
  'agent.reportFillProgress',
  'agent.raiseIssue',
  'agent.reportReviewResult',
  'agent.reportPageReadback',
]);

export const ALL_COMMANDS = Object.freeze([...UI_COMMANDS, ...AGENT_COMMANDS]);

const UI_COMMAND_SET = new Set(UI_COMMANDS);
const AGENT_COMMAND_SET = new Set(AGENT_COMMANDS);

export const QUEUE_STATES = Object.freeze([
  'idle',
  'running',
  'paused',
  'blocked',
  'completed',
  'unknown',
]);

export const COMPANY_STATUSES = Object.freeze([
  'queued',
  'awaiting_login',
  'searching',
  'awaiting_job_selection',
  'filling',
  'reviewing',
  'awaiting_user',
  'awaiting_submit',
  'awaiting_verification',
  'deferred',
  'paused',
  'failed',
  'completed',
  'no_suitable_jobs',
  'search_blocked',
  'submitted_self_reported',
  'submitted_verified',
  'skipped',
  'unknown',
]);

/** Core workflow statuses are translated to the panel's stable vocabulary. */
export const CORE_COMPANY_STATUS = Object.freeze({
  queued: 'queued',
  awaiting_login: 'awaiting_login',
  researching: 'searching',
  awaiting_selection: 'awaiting_job_selection',
  preparing: 'filling',
  awaiting_issue_answers: 'awaiting_user',
  awaiting_human_submit: 'awaiting_submit',
  held: 'deferred',
  blocked: 'search_blocked',
  submitted_reported: 'submitted_self_reported',
  completed: 'completed',
  no_positions: 'no_suitable_jobs',
  skipped: 'skipped',
});

export const CORE_JOB_STATUS = Object.freeze({
  candidate: 'available',
  selected: 'selected',
  preparing: 'filling',
  awaiting_issue_answers: 'filling',
  awaiting_human_submit: 'awaiting_submit',
  submitted_reported: 'self_reported',
  verified: 'verified',
  skipped: 'skipped',
});

export const APPLICATION_KINDS = Object.freeze([
  'none',
  'pending_submit',
  'self_reported',
  'verified',
  'no_suitable_jobs',
  'blocked',
  'partial',
  'skipped',
]);

export const SEARCH_STATES = Object.freeze([
  'not_started',
  'running',
  'complete',
  'blocked',
  'no_suitable_jobs',
  'unknown',
]);

export const ISSUE_SEVERITIES = Object.freeze(['required', 'confirm', 'suggestion']);
export const ISSUE_STATUSES = Object.freeze(['open', 'answered', 'deferred', 'resolved']);

export const JOB_STATUSES = Object.freeze([
  'available',
  'selected',
  'filling',
  'reviewing',
  'awaiting_submit',
  'self_reported',
  'verified',
  'skipped',
  'failed',
  'expired',
  'unknown',
]);

export const PROFILE_SECTIONS = Object.freeze([
  { id: 'basic', label: '基本信息', sensitive: false },
  { id: 'education', label: '教育经历', sensitive: false },
  { id: 'internship', label: '实习经历', sensitive: false },
  { id: 'project', label: '项目其他信息', sensitive: false },
  // These IDs intentionally match core.profile-store FACT_SECTIONS.
  { id: 'project_content', label: '项目内容', sensitive: false },
  { id: 'project_responsibilities', label: '项目职责', sensitive: false },
  { id: 'skills', label: '技能与语言', sensitive: false },
  {
    id: 'family',
    label: '家庭资料（敏感）',
    sensitive: true,
    warning: '仅在具体表单明确需要且你授权时使用，不用于岗位检索。',
  },
]);

const CORE_SECTION_TO_UI = Object.freeze({
  basic: 'basic',
  education: 'education',
  internship: 'internship',
  internship_content: 'internship',
  project: 'project',
  project_original: 'project',
  project_content: 'project_content',
  project_responsibilities: 'project_responsibilities',
  skill: 'skills',
  language: 'skills',
  family: 'family',
});

export const MODEL_ROLES = Object.freeze([
  {
    id: 'search',
    label: '检索与匹配',
    description: '读取官方招聘信息并给出 1～3 个岗位候选与证据。',
  },
  {
    id: 'execution',
    label: '填写执行',
    description: '只处理当前批准字段计划，不代登录、不代最终提交。',
  },
  {
    id: 'review',
    label: '独立复核',
    description: '独立只读核对页面读回、已确认资料与当前 JD。',
  },
]);

const MODEL_ROLE_IDS = new Set(MODEL_ROLES.map((role) => role.id));

export const STATUS_META = Object.freeze({
  queued: { label: '待开始', tone: 'neutral' },
  awaiting_login: { label: '待登录', tone: 'info' },
  searching: { label: '检索中', tone: 'info' },
  awaiting_job_selection: { label: '待选岗位', tone: 'warning' },
  filling: { label: '填写中', tone: 'info' },
  reviewing: { label: '复核中', tone: 'info' },
  awaiting_user: { label: '待你处理', tone: 'warning' },
  awaiting_submit: { label: '待你提交', tone: 'warning' },
  awaiting_verification: { label: '待核验', tone: 'info' },
  deferred: { label: '已暂挂', tone: 'neutral' },
  paused: { label: '已暂停', tone: 'neutral' },
  failed: { label: '失败', tone: 'error' },
  completed: { label: '已完成', tone: 'success' },
  no_suitable_jobs: { label: '未投递：没有符合职位', tone: 'neutral' },
  search_blocked: { label: '检索受阻：待处理', tone: 'warning' },
  submitted_self_reported: { label: '已投递（本人记录）', tone: 'info' },
  submitted_verified: { label: '已投递（官网已核验）', tone: 'success' },
  skipped: { label: '未投递：本人跳过', tone: 'neutral' },
  unknown: { label: '状态未知', tone: 'neutral' },
});

export const QUEUE_STATE_META = Object.freeze({
  idle: { label: '未开始', tone: 'neutral' },
  running: { label: '运行中', tone: 'success' },
  paused: { label: '已暂停', tone: 'warning' },
  blocked: { label: '待处理', tone: 'warning' },
  completed: { label: '本轮已完成', tone: 'neutral' },
  unknown: { label: '状态未知', tone: 'neutral' },
});

export const APPLICATION_META = Object.freeze({
  none: { label: '尚无投递记录', tone: 'neutral' },
  pending_submit: { label: '待本人提交', tone: 'warning' },
  self_reported: { label: '已投递（本人记录，待官网核验）', tone: 'info' },
  verified: { label: '已投递（官网已核验）', tone: 'success' },
  no_suitable_jobs: { label: '未投递：没有符合职位', tone: 'neutral' },
  blocked: { label: '待处理：检索受阻', tone: 'warning' },
  partial: { label: '部分投递：请逐岗位核对', tone: 'warning' },
  skipped: { label: '未投递：本人跳过', tone: 'neutral' },
});

export const COMPANY_FILTER_META = Object.freeze({
  all: { label: '全部', tone: 'neutral' },
  pending: { label: '待投递', tone: 'warning' },
  submitted: { label: '已投递', tone: 'success' },
  no_suitable_jobs: { label: '看过，无合适岗位', tone: 'neutral' },
  skipped: { label: '已跳过', tone: 'neutral' },
});

export const COMPANY_FILTERS = Object.freeze(Object.keys(COMPANY_FILTER_META));

export const SEARCH_META = Object.freeze({
  not_started: { label: '尚未检索', tone: 'neutral' },
  running: { label: '检索中', tone: 'info' },
  complete: { label: '检索完成', tone: 'info' },
  blocked: { label: '检索受阻：待处理', tone: 'warning' },
  no_suitable_jobs: { label: '未投递：没有符合职位', tone: 'neutral' },
  unknown: { label: '检索状态未知', tone: 'neutral' },
});

export const ISSUE_SEVERITY_META = Object.freeze({
  required: { label: '必须补充', tone: 'error' },
  confirm: { label: '待确认', tone: 'warning' },
  suggestion: { label: '建议', tone: 'info' },
});

export const ISSUE_STATUS_META = Object.freeze({
  open: { label: '待处理', tone: 'warning' },
  answered: { label: '已补充，待复核', tone: 'info' },
  deferred: { label: '稍后处理', tone: 'neutral' },
  resolved: { label: '已解决', tone: 'success' },
});

export const JOB_STATUS_META = Object.freeze({
  available: { label: '可选', tone: 'neutral' },
  selected: { label: '已选择', tone: 'info' },
  filling: { label: '填写中', tone: 'info' },
  reviewing: { label: '复核中', tone: 'info' },
  awaiting_submit: { label: '待本人提交', tone: 'warning' },
  self_reported: { label: '已投递（本人记录）', tone: 'info' },
  verified: { label: '已投递（官网已核验）', tone: 'success' },
  skipped: { label: '已跳过', tone: 'neutral' },
  failed: { label: '失败', tone: 'error' },
  expired: { label: '已失效', tone: 'neutral' },
  unknown: { label: '状态未知', tone: 'neutral' },
});

export class ContractError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
    this.details = details;
  }
}

export function isUiCommand(command) {
  return typeof command === 'string' && UI_COMMAND_SET.has(command);
}

export function isAgentCommand(command) {
  return typeof command === 'string' && AGENT_COMMAND_SET.has(command);
}

export function statusMeta(status) {
  return STATUS_META[status] ?? STATUS_META.unknown;
}

export function queueStateMeta(state) {
  return QUEUE_STATE_META[state] ?? QUEUE_STATE_META.unknown;
}

export function applicationMeta(kind) {
  return APPLICATION_META[kind] ?? APPLICATION_META.none;
}

export function searchMeta(state) {
  return SEARCH_META[state] ?? SEARCH_META.unknown;
}

export function issueSeverityMeta(severity) {
  return ISSUE_SEVERITY_META[severity] ?? ISSUE_SEVERITY_META.confirm;
}

export function issueStatusMeta(status) {
  return ISSUE_STATUS_META[status] ?? ISSUE_STATUS_META.open;
}

export function jobStatusMeta(status) {
  return JOB_STATUS_META[status] ?? JOB_STATUS_META.unknown;
}

export function profileSectionMeta(section) {
  return PROFILE_SECTIONS.find((item) => item.id === section) ?? {
    id: section || 'unknown',
    label: '未知分区',
    sensitive: true,
  };
}

export function modelRoleMeta(role) {
  return MODEL_ROLES.find((item) => item.id === role) ?? {
    id: role || 'unknown',
    label: '未知角色',
    description: '',
  };
}

export function isSafeHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the POST /api/command payload. Validates and copies only known fields;
 * it never forwards an arbitrary state object.
 */
export function buildCommandPayload({ directory, command, input, expectedRevision } = {}) {
  const dir = requireString(directory, 'directory', { max: 1024 });
  if (!isUiCommand(command)) {
    if (isAgentCommand(command)) {
      throw new ContractError('UI_COMMAND_ONLY', '面板只能发送 user.* 命令，不能发送 agent.* 命令。');
    }
    throw new ContractError('UNKNOWN_COMMAND', `未知的面板命令：${String(command ?? '')}`);
  }
  const normalizedInput = validateCommandInput(command, input ?? {});
  const payload = { directory: dir, command, input: normalizedInput };
  if (expectedRevision !== undefined && expectedRevision !== null) {
    payload.expectedRevision = requireRevision(expectedRevision);
  }
  return payload;
}

/** Host serviceRequest() argument for POST /api/command. */
export function buildCommandRequest(options) {
  const payload = buildCommandPayload(options);
  return {
    method: 'POST',
    path: API_PATHS.command,
    body: JSON.stringify(payload),
  };
}

export function buildStateRequest(directory) {
  return {
    method: 'GET',
    path: API_PATHS.state,
    query: { directory: requireString(directory, 'directory', { max: 1024 }) },
  };
}

export function buildCapabilitiesRequest() {
  return { method: 'GET', path: API_PATHS.capabilities };
}

export function buildSessionInboxRequest(directory) {
  return {
    method: 'GET',
    path: API_PATHS.sessionInbox,
    query: { directory: requireString(directory, 'directory', { max: 1024 }) },
  };
}

export function buildSessionInboxAckRequest(directory, messageIds) {
  const dir = requireString(directory, 'directory', { max: 1024 });
  if (!Array.isArray(messageIds) || messageIds.length < 1 || messageIds.length > 100) {
    throw new ContractError('INVALID_SESSION_MESSAGE_IDS', '会话桥接确认 ID 列表必须包含 1～100 项。');
  }
  const ids = messageIds.map((id) => requireString(id, 'messageId', { max: 128 }));
  if (new Set(ids).size !== ids.length) {
    throw new ContractError('INVALID_SESSION_MESSAGE_IDS', '会话桥接确认 ID 不能重复。');
  }
  return {
    method: 'POST',
    path: API_PATHS.sessionInboxAck,
    body: JSON.stringify({ directory: dir, messageIds: ids }),
  };
}

export function buildSessionInboxStateRequest(directory, messageIds, state) {
  const dir = requireString(directory, 'directory', { max: 1024 });
  if (!Array.isArray(messageIds) || messageIds.length < 1 || messageIds.length > 100) {
    throw new ContractError('INVALID_SESSION_MESSAGE_IDS', '会话桥接状态 ID 列表必须包含 1～100 项。');
  }
  const ids = messageIds.map((id) => requireString(id, 'messageId', { max: 128 }));
  if (new Set(ids).size !== ids.length) {
    throw new ContractError('INVALID_SESSION_MESSAGE_IDS', '会话桥接状态 ID 不能重复。');
  }
  if (!SESSION_DELIVERY_STATES.includes(state)) {
    throw new ContractError('INVALID_SESSION_DELIVERY_STATE', '会话桥接送达状态无效。');
  }
  return {
    method: 'POST',
    path: API_PATHS.sessionInboxState,
    body: JSON.stringify({ directory: dir, messageIds: ids, state }),
  };
}

export function validateCommandInput(command, input) {
  if (!isRecord(input)) {
    throw new ContractError('INVALID_INPUT', '命令参数必须是对象。');
  }
  switch (command) {
    case COMMAND.enqueue:
      return {
        url: requireHttpUrl(input.url, '公司链接'),
        referralCode: optionalString(input.referralCode, '内推码', 200),
        companyName: optionalString(input.companyName, '公司名称', 200),
        source: optionalString(input.source, '来源说明', 500),
      };
    case COMMAND.start: {
      const companyId = optionalString(input.companyId, '公司 ID', 128);
      return companyId ? { companyId } : {};
    }
    case COMMAND.pause:
      return { reason: optionalString(input.reason, '暂停原因', 500) };
    case COMMAND.resume:
      return {};
    case COMMAND.prioritizeCompany:
      return { companyId: requireString(input.companyId, 'companyId', { max: 128 }) };
    case COMMAND.confirmLogin:
      return {
        companyId: requireString(input.companyId, 'companyId', { max: 128 }),
        confirmedByUser: requireUserConfirmation(input, '记录本人登录'),
        note: optionalString(input.note, '登录备注', 500),
      };
    case COMMAND.markReady:
      return {
        companyId: requireString(input.companyId, 'companyId', { max: 128 }),
        jobId: requireString(input.jobId ?? input.positionId, 'jobId', { max: 128 }),
        confirmedByUser: requireUserConfirmation(input, '确认岗位可送交本人提交'),
      };
    case COMMAND.selectJobs: {
      const companyId = requireString(input.companyId, 'companyId', { max: 128 });
      if (!Array.isArray(input.jobIds)) {
        throw new ContractError('INVALID_JOB_SELECTION', '岗位选择必须是数组。');
      }
      const jobIds = input.jobIds.map((id) => requireString(id, 'jobId', { max: 128 }));
      if (jobIds.length < 1 || jobIds.length > 3) {
        throw new ContractError('INVALID_JOB_SELECTION', '请选择 1～3 个岗位。');
      }
      if (new Set(jobIds).size !== jobIds.length) {
        throw new ContractError('INVALID_JOB_SELECTION', '岗位选择不能重复。');
      }
      return { companyId, jobIds };
    }
    case COMMAND.reportSubmitted: {
      const companyId = requireString(input.companyId, 'companyId', { max: 128 });
      const jobId = requireString(input.jobId, 'jobId', { max: 128 });
      if (input.confirmedByUser !== true) {
        throw new ContractError(
          'CONFIRMATION_REQUIRED',
          '记录本人已提交前，必须由本人明确确认；系统不会代提交或代核验。',
        );
      }
      return {
        companyId,
        jobId,
        confirmedByUser: true,
        note: optionalString(input.note, '提交备注', 1000),
      };
    }
    case COMMAND.reportHistoricalSubmission:
      return {
        companyId: requireString(input.companyId, 'companyId', { max: 128 }),
        note: requireString(input.note, '历史投递说明', { max: 1000, preserve: true }),
        confirmedByUser: requireUserConfirmation(input, '记录历史本人已投递'),
      };
    case COMMAND.deferCompany:
      return {
        companyId: requireString(input.companyId, 'companyId', { max: 128 }),
        reason: optionalString(input.reason, '暂挂原因', 500, true),
      };
    case COMMAND.resumeCompany:
      return {
        companyId: requireString(input.companyId, 'companyId', { max: 128 }),
      };
    case COMMAND.skipCompany: {
      const reason = requireString(input.reason, '跳过公司原因', { max: 500, preserve: true });
      if (!reason.trim()) throw new ContractError('REASON_REQUIRED', '跳过公司必须说明真实原因。');
      return {
        companyId: requireString(input.companyId, 'companyId', { max: 128 }),
        reason,
        confirmedByUser: requireUserConfirmation(input, '跳过整家公司'),
      };
    }
    case COMMAND.skipJob: {
      const reason = requireString(input.reason, '跳过岗位原因', { max: 500, preserve: true });
      if (!reason.trim()) throw new ContractError('REASON_REQUIRED', '跳过岗位必须说明真实原因。');
      return {
        companyId: requireString(input.companyId, 'companyId', { max: 128 }),
        jobId: requireString(input.jobId ?? input.positionId, 'jobId', { max: 128 }),
        reason,
        confirmedByUser: requireUserConfirmation(input, '跳过岗位'),
      };
    }
    case COMMAND.resolveIssue: {
      const issueId = requireString(input.issueId, 'issueId', { max: 128 });
      if (!['answer', 'defer', 'resolve'].includes(input.action)) {
        throw new ContractError('INVALID_ISSUE_ACTION', '问题只能选择补充、稍后处理或本人核对解决。');
      }
      if (input.action === 'defer') {
        return { issueId, action: 'defer' };
      }
      if (input.action === 'resolve') {
        return {
          issueId,
          action: 'resolve',
          confirmedByUser: requireUserConfirmation(input, '本人核对解决'),
        };
      }
      return {
        issueId,
        action: 'answer',
        answer: requireString(input.answer, '问题补充', { max: 4000, preserve: true }),
      };
    }
    case COMMAND.recordCandidates:
      return {
        companyId: requireString(input.companyId, 'companyId', { max: 128 }),
        positions: validateCandidatePositions(input.positions),
        confirmedByUser: requireUserConfirmation(input, '录入本人核查的岗位证据'),
      };
    case COMMAND.recordNoPositions:
      return {
        companyId: requireString(input.companyId, 'companyId', { max: 128 }),
        evidence: validateNoPositionsEvidence(input.evidence),
        confirmedByUser: requireUserConfirmation(input, '录入本人核查的无合适岗位证据'),
      };
    case COMMAND.reviseFact:
      return {
        factId: requireString(input.factId, 'factId', { max: 128 }),
        expectedVersion: requireVersion(input.expectedVersion, 'expectedVersion'),
        patch: validateFactPatch(input.patch),
      };
    case COMMAND.acknowledgeRecovery: {
      const result = { confirmedByUser: requireUserConfirmation(input, '确认恢复后已观察现场') };
      if (input.observedAt !== undefined && input.observedAt !== null && input.observedAt !== '') {
        result.observedAt = requireCheckedAt(input.observedAt, 'observedAt');
      }
      return result;
    }
    case COMMAND.saveModels:
      return { roles: validateModelRoles(input.roles) };
    case COMMAND.mokaOpen:
      return { companyId: requireString(input.companyId, 'companyId', { max: 128 }) };
    case COMMAND.mokaResearch:
      return requireMokaAuthorization(input, {
        companyId: requireString(input.companyId, 'companyId', { max: 128 }),
      });
    case COMMAND.mokaPrepareFill:
      return requireMokaAuthorization(input, {
        companyId: requireString(input.companyId, 'companyId', { max: 128 }),
        jobId: requireString(input.jobId, 'jobId', { max: 128 }),
      });
    case COMMAND.mokaRunFill:
      return requireMokaAuthorization(input, {
        companyId: requireString(input.companyId, 'companyId', { max: 128 }),
        jobId: requireString(input.jobId, 'jobId', { max: 128 }),
        planId: requireString(input.planId, 'planId', { max: 128 }),
        confirmedByUser: requireUserConfirmation(input, '确认并执行当前填写计划'),
      });
    case COMMAND.mokaCancel:
      return {
        ...(input.companyId ? { companyId: requireString(input.companyId, 'companyId', { max: 128 }) } : {}),
        reason: optionalString(input.reason, '停止原因', 500, true),
      };
    case COMMAND.importFacts: {
      const section = requireString(input.section, '资料分区', { max: 40 });
      if (!PROFILE_SECTIONS.some((item) => item.id === section)) {
        throw new ContractError('INVALID_PROFILE_SECTION', `未知资料分区：${section}`);
      }
      const rawText = requireString(input.rawText, '字段原文', { max: 20000, preserve: true });
      if (rawText.trim().length === 0) {
        throw new ContractError('INVALID_RAW_TEXT', '字段原文不能只有空白。');
      }
      return {
        section,
        label: requireString(input.label, '字段名称', { max: 120, preserve: true }),
        rawText,
        source: optionalString(input.source, '原文来源', 500, true),
        entityId: optionalString(input.entityId, '经历编号', 200),
        sensitive: section === 'family' || input.sensitive === true,
      };
    }
    case COMMAND.confirmFact:
      {
        const factId = requireString(input.factId, 'factId', { max: 128 });
        if (input.confirmedByUser !== true) {
          throw new ContractError('CONFIRMATION_REQUIRED', '确认资料必须由本人明确操作。');
        }
        const result = { factId, confirmedByUser: true };
        if (input.expectedVersion !== undefined && input.expectedVersion !== null) {
          const version = input.expectedVersion;
          if (typeof version !== 'string' && typeof version !== 'number') {
            throw new ContractError('INVALID_VERSION', 'expectedVersion 必须是字符串或数字。');
          }
          result.expectedVersion = version;
        }
        return result;
      }
    default:
      throw new ContractError('UNKNOWN_COMMAND', `未知命令：${command}`);
  }
}

function requireMokaAuthorization(input, fields) {
  if (input.sendAuthorized !== true) {
    throw new ContractError('MODEL_SEND_NOT_AUTHORIZED', '请先勾选本次模型发送授权；未授权不会发起任何模型请求。');
  }
  return { ...fields, sendAuthorized: true };
}

function requireUserConfirmation(input, operation) {
  if (input.confirmedByUser !== true) {
    throw new ContractError(
      'CONFIRMATION_REQUIRED',
      `${operation}必须由本人明确确认，面板不会代替本人操作。`,
    );
  }
  return true;
}

function requireCheckedAt(value, field = 'checkedAt') {
  const text = requireString(value, field, { max: 80 });
  if (Number.isNaN(Date.parse(text))) {
    throw new ContractError('INVALID_FIELD', `${field} 必须是可解析的日期时间。`);
  }
  return text;
}

function requireVersion(value, field = 'expectedVersion') {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ContractError('INVALID_VERSION', `${field} 必须是字符串或数字。`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new ContractError('INVALID_VERSION', `${field} 必须是有限数字。`);
  }
  return value;
}

function validateCandidatePositions(positions) {
  if (!Array.isArray(positions) || positions.length < 1 || positions.length > 3) {
    throw new ContractError('INVALID_POSITION', '人工核查候选必须是 1～3 个岗位。');
  }
  const seen = new Set();
  return positions.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new ContractError('INVALID_POSITION', `positions[${index}] 必须是对象。`);
    }
    const officialId = requireString(raw.officialId ?? raw.jobId, `positions[${index}].officialId`, {
      max: 200,
    });
    if (seen.has(officialId)) {
      throw new ContractError('INVALID_POSITION', '同一批岗位候选的官方岗位 ID 不能重复。');
    }
    seen.add(officialId);
    const matchEvidence = requireString(
      raw.matchEvidence,
      `positions[${index}].matchEvidence`,
      { max: 2000, preserve: true },
    );
    if (!matchEvidence.trim()) {
      throw new ContractError('INVALID_POSITION', '岗位候选必须附本人核查的匹配证据。');
    }
    return {
      officialId,
      title: requireString(raw.title, `positions[${index}].title`, { max: 300 }),
      city: optionalString(raw.city, `positions[${index}].city`, 100),
      sourceUrl: requireHttpUrl(
        raw.sourceUrl ?? raw.officialUrl,
        `positions[${index}].sourceUrl`,
      ),
      checkedAt: requireCheckedAt(raw.checkedAt, `positions[${index}].checkedAt`),
      matchEvidence,
    };
  });
}

function validateNoPositionsEvidence(raw) {
  if (!isRecord(raw)) {
    throw new ContractError('INVALID_EVIDENCE', '无合适岗位证据必须是对象。');
  }
  const reason = requireString(raw.reason, '无合适岗位原因', { max: 500, preserve: true });
  const resultText = requireString(raw.resultText, '核查结果原文', {
    max: 2000,
    preserve: true,
  });
  if (!reason.trim() || !resultText.trim()) {
    throw new ContractError('INVALID_EVIDENCE', '无合适岗位原因和核查结果都不能只有空白。');
  }
  return {
    reason,
    sourceUrl: requireHttpUrl(raw.sourceUrl, '无合适岗位来源'),
    checkedAt: requireCheckedAt(raw.checkedAt, '无合适岗位核查时间'),
    resultText,
  };
}

function validateFactPatch(raw) {
  if (!isRecord(raw)) {
    throw new ContractError('INVALID_PATCH', '资料修订 patch 必须是对象。');
  }
  const allowed = new Set(['rawText', 'label', 'entityId']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ContractError('FIELD_PROTECTED', `资料字段 ${key} 不能通过面板修订。`);
    }
  }
  const patch = {};
  if (Object.hasOwn(raw, 'rawText')) {
    patch.rawText = requireString(raw.rawText, '修订后原文', { max: 20000, preserve: true });
    if (!patch.rawText.trim()) {
      throw new ContractError('INVALID_RAW_TEXT', '修订后原文不能只有空白。');
    }
  }
  if (Object.hasOwn(raw, 'label')) {
    patch.label = requireString(raw.label, '修订后字段名称', { max: 120, preserve: true });
  }
  if (Object.hasOwn(raw, 'entityId')) {
    if (raw.entityId === null || raw.entityId === '') {
      patch.entityId = null;
    } else {
      patch.entityId = requireString(raw.entityId, '经历编号', { max: 200, preserve: true });
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new ContractError('INVALID_PATCH', '资料修订至少需要修改一个字段。');
  }
  return patch;
}

function validateModelRoles(roles) {
  if (!isRecord(roles)) {
    throw new ContractError('INVALID_MODELS', '模型配置必须是对象。');
  }
  const result = {};
  let count = 0;
  for (const [role, value] of Object.entries(roles)) {
    if (!MODEL_ROLE_IDS.has(role)) {
      throw new ContractError('INVALID_MODEL_ROLE', `未知角色：${role}`);
    }
    if (!isRecord(value)) {
      throw new ContractError('INVALID_MODELS', `角色 ${role} 的配置必须是对象。`);
    }
    const provider = requireString(value.provider, `${role}.provider`, { max: 120 });
    const model = requireString(value.model, `${role}.model`, { max: 200 });
    const config = { provider, model };
    if (value.endpoint !== undefined && value.endpoint !== null && value.endpoint !== '') {
      config.endpoint = requireHttpUrl(value.endpoint, `${role}.endpoint`);
    }
    if (value.apiKey !== undefined && value.apiKey !== null && value.apiKey !== '') {
      config.apiKey = requireString(value.apiKey, `${role}.apiKey`, {
        max: 8192,
        preserve: true,
      });
    }
    if (value.clearApiKey === true) {
      config.clearApiKey = true;
    }
    result[role] = config;
    count += 1;
  }
  if (count === 0) {
    throw new ContractError('INVALID_MODELS', '至少需要保存一个角色配置。');
  }
  return result;
}

/** Decode {status, body} returned by host.serviceRequest(). */
export function decodeServiceResponse(result) {
  if (!isRecord(result) || typeof result.status !== 'number' || typeof result.body !== 'string') {
    throw new ContractError('INVALID_SERVICE_RESPONSE', '本地服务返回了无法识别的响应。');
  }
  let body;
  try {
    body = result.body.trim() === '' ? null : JSON.parse(result.body);
  } catch {
    throw new ContractError('INVALID_SERVICE_JSON', '本地服务响应不是有效 JSON。', {
      status: result.status,
    });
  }
  const serviceError = body && isRecord(body) && isRecord(body.error) ? body.error : null;
  const errorCode = serviceError?.code ?? `HTTP_${result.status}`;
  const errorMessage = serviceError?.message ?? `本地服务返回 HTTP ${result.status}。`;
  if (result.status < 200 || result.status >= 300) {
    throw new ContractError(
      typeof errorCode === 'string' ? errorCode : `HTTP_${result.status}`,
      typeof errorMessage === 'string' ? errorMessage : `本地服务返回 HTTP ${result.status}。`,
      serviceError?.details,
    );
  }
  if (!isRecord(body)) {
    throw new ContractError('INVALID_SERVICE_RESPONSE', '本地服务响应缺少 JSON 对象。');
  }
  if (body.ok === false) {
    throw new ContractError(
      typeof serviceError?.code === 'string' ? serviceError.code : 'SERVICE_REJECTED',
      typeof serviceError?.message === 'string' ? serviceError.message : '本地服务拒绝了操作。',
      serviceError?.details,
    );
  }
  if (body.ok !== true) {
    throw new ContractError(
      'INVALID_SERVICE_RESPONSE',
      '本地服务响应缺少明确的 ok: true 成功标记。',
    );
  }
  return body;
}

export function parseStateResponse(result) {
  const body = decodeServiceResponse(result);
  const revision = requireRevision(body.revision);
  if (!isRecord(body.state)) {
    throw new ContractError('INVALID_STATE_RESPONSE', '状态响应缺少 state 对象。');
  }
  return { revision, state: normalizeState(body.state) };
}

export function parseCommandResponse(result) {
  const body = decodeServiceResponse(result);
  const revision = requireRevision(body.revision);
  return {
    revision,
    state: isRecord(body.state) ? normalizeState(body.state) : null,
    result: isRecord(body.result) ? body.result : null,
  };
}

export function parseCapabilitiesResponse(result) {
  const body = decodeServiceResponse(result);
  if (!isRecord(body.capabilities)) {
    throw new ContractError('INVALID_CAPABILITIES_RESPONSE', '能力响应缺少 capabilities 对象。');
  }
  const capabilities = body.capabilities;
  if (capabilities.apiVersion !== CONTRACT_VERSION) {
    throw new ContractError(
      'UNSUPPORTED_CONTRACT_VERSION',
      `本地服务契约版本不兼容：${String(capabilities.apiVersion)}。面板需要版本 ${CONTRACT_VERSION}。`,
    );
  }
  const commands = Array.isArray(capabilities.commands)
    ? capabilities.commands.filter((item) => typeof item === 'string')
    : [];
  return {
    apiVersion: CONTRACT_VERSION,
    backend: optionalString(capabilities.backend, 'backend', 120) || 'application-copilot',
    version: optionalString(capabilities.version, 'version', 120),
    commands,
    features: Array.isArray(capabilities.features)
      ? capabilities.features.filter((item) => typeof item === 'string').slice(0, 50)
      : [],
    limitations: Array.isArray(capabilities.limitations)
      ? capabilities.limitations.filter((item) => typeof item === 'string').slice(0, 50)
      : [],
    // `apiKeyStorage` / `modelExecution` are accepted as service aliases, but
    // the UI only enables credential fields when both explicit guarantees are
    // present. Saving provider/model metadata never implies execution.
    flags: {
      secureModelCredentials:
        capabilities.secureModelCredentials === true || capabilities.apiKeyStorage === true,
      roleExecution:
        capabilities.roleExecution === true || capabilities.modelExecution === true,
      autoResearch: capabilities.autoResearch === true,
      autoFill: capabilities.autoFill === true,
      autoSubmit: capabilities.autoSubmit === true,
      manualSubmit: capabilities.manualSubmit === true,
      browserAutomation: capabilities.browserAutomation === true,
      reviewTransport: capabilities.reviewTransport === true,
      stage4: capabilities.stage4 === true,
    },
  };
}

export function parseSessionInboxResponse(result) {
  const body = decodeServiceResponse(result);
  if (!Array.isArray(body.messages)) {
    throw new ContractError('INVALID_SESSION_INBOX_RESPONSE', '会话桥接响应缺少 messages 数组。');
  }
  const messages = body.messages.map((message, index) => {
    if (!isRecord(message)) {
      throw new ContractError('INVALID_SESSION_INBOX_RESPONSE', `会话桥接消息 ${index + 1} 不是对象。`);
    }
    const id = requireString(message.id, `session.messages[${index}].id`, { max: 128 });
    const text = requireString(message.text, `session.messages[${index}].text`, {
      max: 16000,
      preserve: true,
    });
    if (!text.trim()) {
      throw new ContractError('INVALID_SESSION_INBOX_RESPONSE', `会话桥接消息 ${index + 1} 不能为空。`);
    }
    const createdAt = requireString(message.createdAt, `session.messages[${index}].createdAt`, { max: 80 });
    const targetSessionId = optionalString(message.targetSessionId, `session.messages[${index}].targetSessionId`, 128);
    const deliveryState = Object.hasOwn(message, 'deliveryState')
      ? message.deliveryState
      : SESSION_DELIVERY_STATE.pending;
    if (!SESSION_DELIVERY_STATES.includes(deliveryState)) {
      throw new ContractError('INVALID_SESSION_INBOX_RESPONSE', `会话桥接消息 ${index + 1} 的送达状态无效。`);
    }
    return {
      id,
      text,
      createdAt,
      targetSessionId: targetSessionId || null,
      deliveryState,
    };
  });
  if (new Set(messages.map((message) => message.id)).size !== messages.length) {
    throw new ContractError('INVALID_SESSION_INBOX_RESPONSE', '会话桥接消息 ID 不能重复。');
  }
  return { messages };
}

export function parseSessionInboxAckResponse(result) {
  const body = decodeServiceResponse(result);
  if (!Number.isInteger(body.acknowledged) || body.acknowledged < 0 || body.acknowledged > 100) {
    throw new ContractError('INVALID_SESSION_INBOX_RESPONSE', '会话桥接确认响应无效。');
  }
  return { acknowledged: body.acknowledged };
}

export function parseSessionInboxStateResponse(result) {
  const body = decodeServiceResponse(result);
  if (!Number.isInteger(body.updated) || body.updated < 0 || body.updated > 100) {
    throw new ContractError('INVALID_SESSION_INBOX_RESPONSE', '会话桥接状态响应无效。');
  }
  return { updated: body.updated };
}

function requireRevision(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ContractError('INVALID_REVISION', 'revision 必须是非负整数。');
  }
  return value;
}

export function normalizeState(raw) {
  if (!isRecord(raw)) {
    throw new ContractError('INVALID_STATE', 'state 必须是对象。');
  }
  const companies = Array.isArray(raw.companies)
    ? raw.companies.filter(isRecord).map(normalizeCompany)
    : [];
  const issues = Array.isArray(raw.issues) ? raw.issues.filter(isRecord).map(normalizeIssue) : [];
  return {
    generatedAt: optionalString(raw.generatedAt, 'generatedAt', 80),
    profileRevision: Number.isInteger(raw.profileRevision) ? raw.profileRevision : 0,
    currentCompanyId: optionalString(raw.currentCompanyId, 'currentCompanyId', 128),
    recoveryPending: raw.recoveryPending === true,
    checkpoint: normalizeCheckpoint(raw.checkpoint),
    queue: normalizeQueue(raw.queue),
    companies,
    issues,
    issueDigest: normalizeDigest(raw.issueDigest),
    models: normalizeModels(raw.models),
    facts: Array.isArray(raw.facts) ? raw.facts.filter(isRecord).map(normalizeFact) : [],
    moka: normalizeMokaState(raw.moka),
  };
}

function normalizeMokaState(raw) {
  if (!isRecord(raw)) return null;
  const op = isRecord(raw.operation) ? raw.operation : null;
  const plan = isRecord(raw.plan) ? raw.plan : null;
  const review = isRecord(raw.review) ? raw.review : null;
  const research = isRecord(raw.research) ? raw.research : null;
  return {
    operation: op ? {
      id: optionalString(op.id, 'moka.operation.id', 128),
      kind: optionalString(op.kind, 'moka.operation.kind', 60),
      status: optionalString(op.status, 'moka.operation.status', 40) || 'idle',
      companyId: optionalString(op.companyId, 'moka.operation.companyId', 128),
      positionId: optionalString(op.positionId, 'moka.operation.positionId', 128),
      message: optionalString(op.message, 'moka.operation.message', 1000, true),
      startedAt: optionalString(op.startedAt, 'moka.operation.startedAt', 80),
      finishedAt: optionalString(op.finishedAt, 'moka.operation.finishedAt', 80),
    } : null,
    driver: isRecord(raw.driver) ? {
      status: optionalString(raw.driver.status, 'moka.driver.status', 40) || 'idle',
      lastPageUrl: isSafeHttpUrl(raw.driver.lastPageUrl) ? raw.driver.lastPageUrl : '',
    } : null,
    plan: plan ? {
      planId: optionalString(plan.planId, 'moka.plan.planId', 128),
      companyId: optionalString(plan.companyId, 'moka.plan.companyId', 128),
      positionId: optionalString(plan.positionId, 'moka.plan.positionId', 128),
      itemCount: Number.isInteger(plan.itemCount) ? plan.itemCount : 0,
      confirmed: plan.confirmed === true,
      used: plan.used === true,
      createdAt: optionalString(plan.createdAt, 'moka.plan.createdAt', 80),
      items: Array.isArray(plan.items)
        ? plan.items.filter(isRecord).slice(0, 50).map((item) => ({
          controlRef: optionalString(item.controlRef, 'moka.plan.item.controlRef', 120),
          label: optionalString(item.label, 'moka.plan.item.label', 300, true),
          fieldKey: optionalString(item.fieldKey, 'moka.plan.item.fieldKey', 120),
          regionType: optionalString(item.regionType, 'moka.plan.item.regionType', 40),
        }))
        : [],
    } : null,
    research: research ? {
      status: optionalString(research.status, 'moka.research.status', 40),
      jobCount: Number.isInteger(research.jobCount) ? research.jobCount : 0,
      sourceUrl: isSafeHttpUrl(research.sourceUrl) ? research.sourceUrl : '',
      capturedAt: optionalString(research.capturedAt, 'moka.research.capturedAt', 80),
      message: optionalString(research.message, 'moka.research.message', 1000, true),
    } : null,
    review: review ? {
      passed: review.passed === true,
      programDiffCount: Array.isArray(review.programDiffs) ? review.programDiffs.length : 0,
      findingCount: Array.isArray(review.modelFindings) ? review.modelFindings.length : 0,
      readbackFields: Number.isInteger(review.readbackFields) ? review.readbackFields : 0,
      readbackCapturedAt: optionalString(review.readbackCapturedAt, 'moka.review.capturedAt', 80),
      reviewError: optionalString(review.reviewError, 'moka.review.error', 1000, true),
      note: optionalString(review.note, 'moka.review.note', 1000, true),
    } : null,
    issueDigest: normalizeDigest(raw.issueDigest),
    limits: Array.isArray(raw.limits) ? raw.limits.filter((item) => typeof item === 'string').slice(0, 20) : [],
  };
}

function normalizeCheckpoint(raw) {
  if (!isRecord(raw)) return null;
  return {
    currentCompanyId: optionalString(raw.currentCompanyId, 'checkpoint.currentCompanyId', 128),
    activePositionId: optionalString(raw.activePositionId, 'checkpoint.activePositionId', 128),
    requiresObservation: raw.requiresObservation === true,
    note: optionalString(raw.note, 'checkpoint.note', 500, true),
  };
}

function normalizeQueue(raw) {
  const value = isRecord(raw) ? raw : {};
  const coreState =
    optionalString(value.status, 'queue.status', 40) ||
    optionalString(value.coreState, 'queue.coreState', 40);
  const panelState = QUEUE_STATES.includes(value.panelState)
    ? value.panelState
    : QUEUE_STATES.includes(value.state)
      ? value.state
      : coreState === 'drained'
        ? 'completed'
        : 'unknown';
  return {
    state: panelState,
    coreState,
    activeCompanyId:
      optionalString(value.activeCompanyId, 'queue.activeCompanyId', 128) ||
      optionalString(value.currentCompanyId, 'queue.currentCompanyId', 128),
    message: optionalString(value.message, 'queue.message', 2000, true),
    updatedAt: optionalString(value.updatedAt, 'queue.updatedAt', 80),
  };
}

function normalizeCompany(raw) {
  const id = optionalString(raw.id, 'company.id', 128);
  const jobs = Array.isArray(raw.jobs) ? raw.jobs.filter(isRecord).map(normalizeJob) : [];
  const links = Array.isArray(raw.links)
    ? raw.links
        .map((link) => {
          if (typeof link === 'string') {
            return isSafeHttpUrl(link) ? { url: link, label: '' } : null;
          }
          if (!isRecord(link) || !isSafeHttpUrl(link.url)) return null;
          return {
            url: link.url,
            label: optionalString(link.label, 'link.label', 200, true),
            source: optionalString(link.source, 'link.source', 200, true),
          };
        })
        .filter(Boolean)
    : [];
  const referralCodes = Array.isArray(raw.referralCodes)
    ? raw.referralCodes
        .map((code) => {
          if (typeof code === 'string') {
            return { value: code, source: '', selected: false };
          }
          if (!isRecord(code)) return null;
          const value = optionalString(code.value, 'referral.value', 200, true);
          if (!value) return null;
          return {
            value,
            source: optionalString(code.source, 'referral.source', 200, true),
            selected: code.selected === true,
          };
        })
        .filter(Boolean)
    : [];
  const coreStatus =
    optionalString(raw.coreStatus, 'company.coreStatus', 40) ||
    (typeof raw.status === 'string' && CORE_COMPANY_STATUS[raw.status] ? raw.status : '');
  const coreMapped = CORE_COMPANY_STATUS[coreStatus] || CORE_COMPANY_STATUS[raw.status];
  let panelStatus = COMPANY_STATUSES.includes(raw.panelStatus)
    ? raw.panelStatus
    : COMPANY_STATUSES.includes(raw.status)
      ? raw.status
      : coreMapped || 'unknown';
  if (panelStatus === 'unknown' && coreMapped) panelStatus = coreMapped;
  return {
    id: id || '',
    name: optionalString(raw.name, 'company.name', 200, true) || '未命名任务',
    queuePosition: Number.isInteger(raw.queuePosition) ? raw.queuePosition : null,
    status: panelStatus,
    coreStatus,
    links,
    referralCodes,
    search: normalizeSearch(raw.search),
    jobs,
    application: normalizeApplication(raw.application, panelStatus),
    historicalSubmission: normalizeHistoricalSubmission(raw.historicalSubmission),
    result: optionalString(raw.result, 'company.result', 4000, true),
    note: optionalString(raw.note, 'company.note', 2000, true),
    holdReason: optionalString(raw.holdReason, 'company.holdReason', 500, true),
    skipReason: optionalString(raw.skipReason, 'company.skipReason', 500, true),
    activePositionId: optionalString(raw.activePositionId, 'company.activePositionId', 128),
    selectedPositionIds: Array.isArray(raw.selectedPositionIds)
      ? raw.selectedPositionIds.filter((item) => typeof item === 'string').slice(0, 10)
      : [],
    checkpoint: normalizeCheckpoint(raw.checkpoint),
    updatedAt: optionalString(raw.updatedAt, 'company.updatedAt', 80),
  };
}

function normalizeSearch(raw) {
  const value = isRecord(raw) ? raw : {};
  return {
    state: SEARCH_STATES.includes(value.state) ? value.state : 'unknown',
    message: optionalString(value.message, 'search.message', 2000, true),
    evidenceUrl: isSafeHttpUrl(value.evidenceUrl) ? value.evidenceUrl : '',
    checkedAt: optionalString(value.checkedAt, 'search.checkedAt', 80),
    checkedBy: optionalString(value.checkedBy, 'search.checkedBy', 40),
    resultText: optionalString(value.resultText, 'search.resultText', 2000, true),
    source: optionalString(value.source, 'search.source', 80),
  };
}

function normalizeJob(raw) {
  const id = optionalString(raw.id, 'job.id', 128);
  const coreStatus =
    optionalString(raw.coreStatus, 'job.coreStatus', 40) ||
    (typeof raw.status === 'string' && CORE_JOB_STATUS[raw.status] ? raw.status : '');
  const status = JOB_STATUSES.includes(raw.status)
    ? raw.status
    : CORE_JOB_STATUS[raw.status] || 'unknown';
  return {
    id: id || '',
    title: optionalString(raw.title, 'job.title', 200, true) || '未命名岗位',
    jobId: optionalString(raw.jobId, 'job.jobId', 120, true),
    city: optionalString(raw.city, 'job.city', 120, true),
    officialUrl: isSafeHttpUrl(raw.officialUrl) ? raw.officialUrl : '',
    status,
    coreStatus,
    selected: raw.selected === true,
    priority: Number.isInteger(raw.priority) && raw.priority > 0 ? raw.priority : null,
    evidence: optionalString(raw.evidence, 'job.evidence', 2000, true),
    skipReason: optionalString(raw.skipReason, 'job.skipReason', 500, true),
    submission: normalizeSubmission(raw.submission),
    verification: normalizeVerification(raw.verification),
    updatedAt: optionalString(raw.updatedAt, 'job.updatedAt', 80),
  };
}

function normalizeSubmission(raw) {
  if (!isRecord(raw)) return null;
  return {
    reportedAt: optionalString(raw.reportedAt, 'submission.reportedAt', 80),
    reference: optionalString(raw.reference, 'submission.reference', 500, true),
  };
}

function normalizeHistoricalSubmission(raw) {
  if (!isRecord(raw)) return null;
  return {
    reportedAt: optionalString(raw.reportedAt, 'historicalSubmission.reportedAt', 80),
    reference: optionalString(raw.reference, 'historicalSubmission.reference', 1000, true),
  };
}

function normalizeVerification(raw) {
  if (!isRecord(raw)) return null;
  return {
    verifiedAt: optionalString(raw.verifiedAt, 'verification.verifiedAt', 80),
    sourceUrl: isSafeHttpUrl(raw.sourceUrl) ? raw.sourceUrl : '',
    evidenceText: optionalString(raw.evidenceText, 'verification.evidenceText', 2000, true),
  };
}

function normalizeApplication(raw, companyStatus = 'unknown') {
  const value = isRecord(raw) ? raw : {};
  const kind = APPLICATION_KINDS.includes(value.kind)
    ? value.kind
    : companyStatus === 'skipped'
      ? 'skipped'
      : 'none';
  return {
    kind,
    jobIds: Array.isArray(value.jobIds)
      ? value.jobIds.filter((id) => typeof id === 'string').slice(0, 10)
      : [],
    note: optionalString(value.note, 'application.note', 2000, true),
    reportedAt: optionalString(value.reportedAt, 'application.reportedAt', 80),
    verifiedAt: optionalString(value.verifiedAt, 'application.verifiedAt', 80),
  };
}

export function companyApplicationCategory(company) {
  const kind = company?.application?.kind;
  if (kind === 'verified' || kind === 'self_reported' || kind === 'partial') return 'submitted';
  if (kind === 'no_suitable_jobs' || company?.status === 'no_suitable_jobs') return 'no_suitable_jobs';
  if (kind === 'skipped' || company?.status === 'skipped') return 'skipped';
  return 'pending';
}

export function companyApplicationCategoryMeta(company) {
  return COMPANY_FILTER_META[companyApplicationCategory(company)] || COMPANY_FILTER_META.pending;
}

function normalizeIssue(raw) {
  const id = optionalString(raw.id, 'issue.id', 128);
  return {
    id: id || '',
    companyId: optionalString(raw.companyId, 'issue.companyId', 128),
    companyName: optionalString(raw.companyName, 'issue.companyName', 200, true),
    jobId: optionalString(raw.jobId, 'issue.jobId', 128),
    field: optionalString(raw.field, 'issue.field', 200, true),
    severity: ISSUE_SEVERITIES.includes(raw.severity) ? raw.severity : 'confirm',
    status: ISSUE_STATUSES.includes(raw.status) ? raw.status : 'open',
    title: optionalString(raw.title, 'issue.title', 300, true) || '未命名问题',
    detail: optionalString(raw.detail, 'issue.detail', 4000, true),
    evidence: optionalString(raw.evidence, 'issue.evidence', 4000, true),
    answer: optionalString(raw.answer, 'issue.answer', 4000, true),
    blocking: raw.blocking === true,
    coreSeverity: optionalString(raw.coreSeverity, 'issue.coreSeverity', 40),
    type: optionalString(raw.type, 'issue.type', 80),
    occurrences: Number.isInteger(raw.occurrences) ? raw.occurrences : null,
    createdAt: optionalString(raw.createdAt, 'issue.createdAt', 80),
    updatedAt: optionalString(raw.updatedAt, 'issue.updatedAt', 80),
    version:
      typeof raw.version === 'string' || typeof raw.version === 'number'
        ? raw.version
        : undefined,
  };
}

function normalizeDigest(raw) {
  if (!isRecord(raw) || raw.ready !== true) return null;
  const id = optionalString(raw.id, 'digest.id', 128);
  if (!id) return null;
  return {
    id,
    ready: true,
    issueIds: Array.isArray(raw.issueIds)
      ? raw.issueIds.filter((item) => typeof item === 'string').slice(0, 200)
      : [],
    createdAt: optionalString(raw.createdAt, 'digest.createdAt', 80),
  };
}

function normalizeModels(raw) {
  const value = isRecord(raw) ? raw : {};
  const result = {};
  for (const role of MODEL_ROLES) {
    const config = isRecord(value[role.id]) ? value[role.id] : null;
    result[role.id] = {
      provider: optionalString(config?.provider, `${role.id}.provider`, 120, true),
      model: optionalString(config?.model, `${role.id}.model`, 200, true),
      endpoint: isSafeHttpUrl(config?.endpoint) ? config.endpoint : '',
      apiKeySet: config?.apiKeySet === true || config?.hasKey === true,
    };
  }
  return result;
}

function normalizeFact(raw) {
  const fromCore = CORE_SECTION_TO_UI[raw.coreSection] || CORE_SECTION_TO_UI[raw.section];
  const section = fromCore
    ? fromCore
    : PROFILE_SECTIONS.some((item) => item.id === raw.section)
      ? raw.section
      : 'unknown';
  const sensitivity = optionalString(raw.sensitivity, 'fact.sensitivity', 20);
  return {
    id: optionalString(raw.id, 'fact.id', 128),
    section,
    coreSection: optionalString(raw.coreSection, 'fact.coreSection', 40) || raw.section || '',
    entityId: optionalString(raw.entityId, 'fact.entityId', 200),
    label: optionalString(raw.label, 'fact.label', 120, true) || '未命名字段',
    rawText: typeof raw.rawText === 'string' ? raw.rawText : '',
    confirmedText: typeof raw.confirmedText === 'string' ? raw.confirmedText : '',
    confirmed: raw.confirmed === true,
    confirmedAt: optionalString(raw.confirmedAt, 'fact.confirmedAt', 80),
    source: optionalString(raw.source, 'fact.source', 500, true),
    sensitive: section === 'family' || raw.sensitive === true || (sensitivity && sensitivity !== 'normal'),
    sensitivity,
    companyName: optionalString(raw.companyName, 'fact.companyName', 200, true),
    version:
      typeof raw.version === 'string' || typeof raw.version === 'number'
        ? raw.version
        : undefined,
    updatedAt: optionalString(raw.updatedAt, 'fact.updatedAt', 80),
  };
}

/**
 * Return a stable, user-facing result summary. Submission state, self-report
 * and official verification are deliberately distinct.
 */
export function describeCompanyApplication(company) {
  const jobs = Array.isArray(company?.jobs) ? company.jobs : [];
  const application = company?.application ?? { kind: 'none', jobIds: [] };
  const namesFor = (ids) => {
    const wanted = new Set(Array.isArray(ids) ? ids : []);
    return jobs
      .filter((job) => wanted.has(job.id))
      .map((job) => job.title)
      .filter(Boolean);
  };
  const selectedNames = () =>
    jobs
      .filter((job) => job.selected)
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((job) => job.title)
      .filter(Boolean);
  const joined = (names) => names.join('、');

  if (company?.status === 'skipped' || application.kind === 'skipped') {
    const reason = company?.skipReason ? `：${company.skipReason}` : '';
    return `未投递：本人跳过${reason}`;
  }

  switch (application.kind) {
    case 'verified': {
      const names = namesFor(application.jobIds);
      return names.length > 0
        ? `已投递：${joined(names)}（官网已核验）`
        : '已投递（官网已核验）';
    }
    case 'self_reported': {
      const names = namesFor(application.jobIds);
      return names.length > 0
        ? `已投递：${joined(names)}（本人记录，待官网核验）`
        : '已投递（本人记录，待官网核验）';
    }
    case 'pending_submit': {
      const names = namesFor(application.jobIds);
      return names.length > 0 ? `待本人提交：${joined(names)}` : '待本人提交';
    }
    case 'no_suitable_jobs':
      return '未投递：没有符合职位';
    case 'blocked':
      return '待处理：检索受阻';
    case 'partial': {
      const verified = jobs.filter((job) => job.status === 'verified').map((job) => job.title);
      const reported = jobs.filter((job) => job.status === 'self_reported').map((job) => job.title);
      const pending = jobs
        .filter((job) => job.status === 'awaiting_submit')
        .map((job) => job.title);
      const skipped = jobs
        .filter((job) => job.status === 'skipped')
        .map((job) => job.title);
      const parts = [];
      if (verified.length) parts.push(`官网已核验：${joined(verified)}`);
      if (reported.length) parts.push(`本人记录待核验：${joined(reported)}`);
      if (pending.length) parts.push(`待本人提交：${joined(pending)}`);
      if (skipped.length) parts.push(`本人跳过：${joined(skipped)}`);
      return parts.length ? `部分投递：${parts.join('；')}` : '部分投递：请逐岗位核对';
    }
    case 'none':
    default: {
      const names = selectedNames();
      return names.length
        ? `尚无投递记录；已选岗位：${joined(names)}`
        : '尚无投递记录';
    }
  }
}

export function countUnresolvedIssues(issues) {
  return Array.isArray(issues)
    ? issues.filter((issue) => issue.status !== 'resolved').length
    : 0;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, field, { max = 1000, preserve = false } = {}) {
  if (typeof value !== 'string') {
    throw new ContractError('INVALID_FIELD', `${field} 必须是字符串。`);
  }
  const text = preserve ? value : value.trim();
  if (text.length === 0) {
    throw new ContractError('INVALID_FIELD', `${field} 不能为空。`);
  }
  if (text.length > max) {
    throw new ContractError('INVALID_FIELD', `${field} 超出长度限制（最多 ${max} 个字符）。`);
  }
  return text;
}

function optionalString(value, field, max = 1000, preserve = false) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw new ContractError('INVALID_FIELD', `${field} 必须是字符串。`);
  }
  const text = preserve ? value : value.trim();
  if (text.length > max) {
    throw new ContractError('INVALID_FIELD', `${field} 超出长度限制（最多 ${max} 个字符）。`);
  }
  return text;
}

function requireHttpUrl(value, field) {
  const url = requireString(value, field, { max: 2000 });
  if (!isSafeHttpUrl(url)) {
    throw new ContractError('INVALID_URL', `${field} 必须是可公开打开的 http(s) 链接，且不能包含账号密码。`);
  }
  return url;
}
