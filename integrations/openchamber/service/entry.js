// Application Copilot local host service source entry.
//
// OpenChamber spawns the built `service/main.js`, which the parent/build step
// produces by bundling this `entry.js` (ESM) with core/index.js. The manifest
// entry remains `integrations/openchamber/service/main.js`.
//
// The service binds only 127.0.0.1, authenticates every request (including
// /health), and never exposes the token, request bodies, file contents, or
// model credentials in logs.
//
// This is intentionally a small adapter over core/index.js. It does not fetch
// websites, call model APIs, submit applications, or manage API keys. The panel
// reaches it only through host.serviceRequest(); it never sees the token.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  createWorkbenchService,
  createToolRegistry,
  companyResultText,
  isPositionTerminal,
  WorkflowError,
  ValidationError,
  ToolError,
} from '../../../core/index.js';
import {
  createMokaWorkflow,
  createMemoryCredentialStore,
} from './moka-workflow.js';
import {
  acknowledgeSessionMessages,
  appendSessionMessage,
  readSessionInbox,
  SessionInboxError,
  updateSessionMessageStates,
} from '../session-bridge.js';

const API_VERSION = 1;
const SERVICE_BACKEND = 'application-copilot-local-service';
const SERVICE_VERSION = '0.4.0';
const MAX_BODY_BYTES = 512 * 1024;
const MAX_DIRECTORY_LENGTH = 1024;
const STREAM_LIMIT_MESSAGE = '请求体超出本地服务限制。';
const AUTH_SCHEME = 'Bearer';
const MODELS_SCHEMA = 'application-copilot.models.v1';
const META_SCHEMA = 'application-copilot.service-meta.v1';
const LOCK_SCHEMA = 'application-copilot.service-lock.v1';

const UI_SECTIONS = Object.freeze(['basic', 'education', 'internship', 'project', 'project_content', 'project_responsibilities', 'skills', 'family']);
const FAMILY_LABEL_PATTERN = /(父亲|母亲|父母|家庭|亲属|家属|监护人|配偶|子女|兄弟|姐妹|家庭成员)/u;
const SENSITIVE_LABEL_PATTERN = /(身份证|证件号|护照|签证|健康|病史|疾病|残疾|婚育|婚姻|生育|政治面貌|户籍|住址|银行|社保|公积金|征信)/u;

const PANEL_COMPANY_STATUS = Object.freeze({
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

const PANEL_JOB_STATUS = Object.freeze({
  candidate: 'available',
  selected: 'selected',
  preparing: 'filling',
  awaiting_issue_answers: 'filling',
  awaiting_human_submit: 'awaiting_submit',
  submitted_reported: 'self_reported',
  verified: 'verified',
  skipped: 'skipped',
});

const PANEL_ISSUE_SEVERITY = Object.freeze({
  error: 'required',
  warn: 'confirm',
  info: 'suggestion',
});

const LIVE_LOCKS = new Map();

class ServiceError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function serviceError(status, code, message, details) {
  return new ServiceError(status, code, message, details);
}

function sessionInboxServiceError(error, fallbackStatus) {
  const status = error.code === 'SESSION_INBOX_BUSY' ? 409 : fallbackStatus;
  return serviceError(status, error.code, error.message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isInsideOrEqual(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function projectKey(projectPath) {
  return process.platform === 'win32' ? projectPath.toLowerCase() : projectPath;
}

function limitText(value, max) {
  if (typeof value !== 'string') return '';
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function safeHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (!url.hostname || url.username || url.password) return false;
    return true;
  } catch {
    return false;
  }
}

function requireString(value, field, { max = 1000, preserve = false, allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    throw serviceError(400, 'INVALID_FIELD', `${field} 必须是字符串。`, { field });
  }
  const text = preserve ? value : value.trim();
  if (!allowEmpty && text.length === 0) {
    throw serviceError(400, 'INVALID_FIELD', `${field} 不能为空。`, { field });
  }
  if (text.length > max) {
    throw serviceError(400, 'INVALID_FIELD', `${field} 超出长度限制（最多 ${max} 个字符）。`, { field });
  }
  return text;
}

function optionalString(value, field, { max = 1000, preserve = false } = {}) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw serviceError(400, 'INVALID_FIELD', `${field} 必须是字符串。`, { field });
  }
  const text = preserve ? value : value.trim();
  if (text.length > max) {
    throw serviceError(400, 'INVALID_FIELD', `${field} 超出长度限制（最多 ${max} 个字符）。`, { field });
  }
  return text;
}

function assertOnlyKeys(value, allowed, field = 'input') {
  if (!isPlainObject(value)) {
    throw serviceError(400, 'INVALID_INPUT', `${field} 必须是对象。`, { field });
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw serviceError(400, 'UNKNOWN_FIELD', `${field} 包含未支持字段：${key}。`, {
        field: `${field}.${key}`,
      });
    }
  }
  return value;
}

function normalizeExpectedRevision(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw serviceError(400, 'INVALID_REVISION', 'expectedRevision 必须是非负整数。');
  }
  return value;
}

function normalizeIntegerVersion(value) {
  if (Number.isInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 1) return parsed;
  }
  throw serviceError(400, 'INVALID_VERSION', 'expectedVersion 必须是正整数。');
}

function requireUserConfirmation(input, operation) {
  if (input?.confirmedByUser !== true) {
    throw serviceError(
      400,
      'CONFIRMATION_REQUIRED',
      `${operation}必须由本人明确确认（confirmedByUser:true），面板不能代替本人操作。`,
    );
  }
}

function mapUiSectionToCore(section) {
  const map = {
    basic: 'basic',
    education: 'education',
    internship: 'internship',
    project: 'project',
    project_content: 'project_content',
    project_responsibilities: 'project_responsibilities',
    skills: 'skill',
    family: 'family',
  };
  return map[section] || null;
}

function mapCoreSectionToUi(section) {
  const map = {
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
  };
  return map[section] || 'other';
}

function normalizeStatusForPanel(status) {
  return PANEL_COMPANY_STATUS[status] || 'unknown';
}

function normalizeJobStatusForPanel(status) {
  return PANEL_JOB_STATUS[status] || 'unknown';
}

function normalizeQueueStateForPanel(state) {
  if (state === 'drained') return 'completed';
  return state;
}

function summarizeQueue(summary) {
  if (!summary) {
    return {
      status: 'idle',
      state: 'idle',
      coreState: 'idle',
      panelState: 'idle',
      currentCompanyId: null,
      activeCompanyId: null,
      startedAt: null,
      pausedAt: null,
      updatedAt: null,
      message: '尚未开始。',
    };
  }
  const queue = summary.queue;
  const current = summary.currentCompany;
  let message = '尚未开始。';
  if (queue.status === 'paused') message = '队列已暂停；不会自动推进。';
  else if (queue.status === 'drained') message = '本轮队列已结束。';
  else if (queue.status === 'running' && current) {
    message = `当前公司：${current.name}（${current.status}）`;
  } else if (queue.status === 'running') message = '队列运行中，等待程序推进。';
  const panelState = normalizeQueueStateForPanel(queue.status);
  return {
    ...queue,
    status: queue.status,
    state: panelState,
    coreState: queue.status,
    panelState,
    currentCompanyId: queue.currentCompanyId,
    activeCompanyId: queue.currentCompanyId,
    message: limitText(message, 2000),
  };
}

function buildCapabilities() {
  return {
    apiVersion: API_VERSION,
    backend: SERVICE_BACKEND,
    version: SERVICE_VERSION,
    commands: [...SUPPORTED_COMMANDS],
    features: [
      'local_authenticated_service',
      'per_project_private_storage',
      'sequential_queue',
      'manual_login_receipt',
      'manual_job_evidence_entry',
      'job_selection',
      'manual_submission_receipt',
      'historical_submission_receipt',
      'persistent_issue_queue',
      'local_profile_facts_management',
      'model_role_metadata_only',
      'memory_only_model_credentials',
      'controlled_moka_research',
      'controlled_moka_fill_readback',
      'background_browser_operations',
    ],
    limitations: [
      'autoResearch=true：仅在本人点击后读取已保存的 Moka 官方页面并调用已授权检索模型；不是无人值守巡检。',
      'autoFill=true：仅在本人确认计划后填写已批准字段；不代登录、不提交、不上传附件。',
      'autoSubmit=false：最终提交始终由本人完成；本服务没有提交接口。',
      '受控窗口是独立 Chrome 窗口，不是嵌入 OpenChamber 的官网页面；只接受已保存的官方 https 来源。',
      '模型密钥只保存在当前宿主进程内存，不落盘、不回显、不导出；服务重启需重新输入。secureModelCredentials 表示内存隔离，不表示磁盘加密。',
      '未勾选发送授权时不会发起模型请求；未配置对应角色模型或缺少本次密钥时失败关闭。',
      '页面读回以实际页面值优先；读回缺失或程序差异不会被模型空输出覆盖。',
      '仅验证 Moka 受控路径；不对其他招聘网站或全部 Moka 自定义控件作通用兼容承诺。',
      'stage4 为受控填写与读回连接层，不包含自动提交、自动撤回或真实账号操作。',
    ],
    autoResearch: true,
    autoFill: true,
    autoSubmit: false,
    manualSubmit: true,
    browserAutomation: true,
    reviewTransport: true,
    stage4: true,
    modelExecution: true,
    roleExecution: true,
    secureModelCredentials: true,
    apiKeyStorage: false,
  };
}

async function lstatIfExists(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function resolveProjectDirectory(directory, allowedRoots) {
  if (typeof directory !== 'string') {
    throw serviceError(400, 'INVALID_DIRECTORY', 'directory 必须是绝对路径字符串。');
  }
  const raw = directory.trim();
  if (!raw || raw.length > MAX_DIRECTORY_LENGTH) {
    throw serviceError(400, 'INVALID_DIRECTORY', 'directory 不能为空且不能过长。');
  }
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw serviceError(400, 'INVALID_DIRECTORY', 'directory 包含非法控制字符。');
  }
  if (!path.isAbsolute(raw)) {
    throw serviceError(400, 'INVALID_DIRECTORY', 'directory 必须是绝对路径。');
  }
  if (process.platform === 'win32' && /^[/\\]{2}/.test(raw)) {
    throw serviceError(400, 'INVALID_DIRECTORY', 'directory 必须是本机项目目录，不接受 UNC 路径。');
  }
  const parsedRoot = path.parse(path.resolve(raw)).root;
  if (samePath(path.resolve(raw), parsedRoot)) {
    throw serviceError(400, 'INVALID_DIRECTORY', 'directory 不能是文件系统根目录。');
  }
  let stat;
  try {
    stat = await fs.stat(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw serviceError(400, 'INVALID_DIRECTORY', 'directory 不存在或不是可访问的项目目录。');
    }
    throw serviceError(400, 'INVALID_DIRECTORY', 'directory 无法读取。');
  }
  if (!stat.isDirectory()) {
    throw serviceError(400, 'INVALID_DIRECTORY', 'directory 必须是目录。');
  }
  const real = await fs.realpath(raw);
  if (samePath(real, path.parse(real).root)) {
    throw serviceError(400, 'INVALID_DIRECTORY', 'directory 不能是文件系统根目录。');
  }
  if (allowedRoots && allowedRoots.length > 0) {
    const allowed = allowedRoots.some((root) => isInsideOrEqual(root, real));
    if (!allowed) {
      throw serviceError(403, 'PROJECT_NOT_ALLOWED', '该项目目录不在本服务实例允许的测试范围内。');
    }
  }
  return real;
}

function ignoreCoversAll(content) {
  const lines = String(content || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (lines.some((line) => line.startsWith('!'))) return false;
  return lines.some((line) => line === '*' || line === '/*' || line === '**');
}

async function ensurePrivateIgnore(appRoot, { create }) {
  const ignorePath = path.join(appRoot, '.gitignore');
  const readAndValidate = async () => {
    const stat = await fs.lstat(ignorePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw serviceError(
        400,
        'PRIVATE_IGNORE_UNSAFE',
        '应用私有目录的 .gitignore 必须是普通文件；未跟随或覆盖该路径。',
      );
    }
    const content = await fs.readFile(ignorePath, 'utf8');
    if (!ignoreCoversAll(content)) {
      throw serviceError(
        400,
        'PRIVATE_IGNORE_UNSAFE',
        '应用私有目录的 .gitignore 未覆盖全部运行数据；请先由本人修正，未写入任何运行数据。',
      );
    }
    return content;
  };

  const stat = await lstatIfExists(ignorePath);
  if (stat) {
    await readAndValidate();
    return;
  }
  if (!create) return;

  // The application-owned ignore file must exist before runtime/profile/model
  // data. It lives inside application-copilot and ignores only this directory.
  // This is not a substitute for the publication allowlist or for reviewing
  // `git add -f`; it is a local fail-closed guard.
  let handle = null;
  try {
    handle = await fs.open(ignorePath, 'wx', 0o600);
    await handle.writeFile('*\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error.code !== 'EEXIST') throw error;
    await readAndValidate();
  }
}

async function validateProjectLayout(projectPath, { create }) {
  const privatePath = path.join(projectPath, 'private');
  const appRoot = path.join(privatePath, 'application-copilot');
  const privateStat = await lstatIfExists(privatePath);
  if (privateStat) {
    if (privateStat.isSymbolicLink() || !privateStat.isDirectory()) {
      throw serviceError(400, 'UNSAFE_PROJECT_LAYOUT', 'private/ 必须是普通目录，不能是符号链接或文件。');
    }
  } else if (!create) {
    return { privateExists: false, appExists: false, privatePath, appRoot };
  } else {
    await fs.mkdir(privatePath, { recursive: true, mode: 0o700 });
  }

  const privateReal = await fs.realpath(privatePath);
  if (!isInsideOrEqual(projectPath, privateReal)) {
    throw serviceError(400, 'UNSAFE_PROJECT_LAYOUT', 'private/ 的真实路径越出项目目录。');
  }

  let appStat = await lstatIfExists(appRoot);
  if (appStat) {
    if (appStat.isSymbolicLink() || !appStat.isDirectory()) {
      throw serviceError(400, 'UNSAFE_PROJECT_LAYOUT', 'application-copilot/ 必须是普通目录。');
    }
  } else if (create) {
    await fs.mkdir(appRoot, { recursive: true, mode: 0o700 });
    appStat = await lstatIfExists(appRoot);
  } else {
    return { privateExists: true, appExists: false, privatePath, appRoot };
  }

  if (!appStat || appStat.isSymbolicLink() || !appStat.isDirectory()) {
    throw serviceError(400, 'UNSAFE_PROJECT_LAYOUT', 'application-copilot/ 无法安全创建或读取。');
  }
  const appReal = await fs.realpath(appRoot);
  if (!isInsideOrEqual(privateReal, appReal)) {
    throw serviceError(400, 'UNSAFE_PROJECT_LAYOUT', 'application-copilot/ 的真实路径越出 private/。');
  }
  await ensurePrivateIgnore(appRoot, { create });
  return { privateExists: true, appExists: true, privatePath, appRoot };
}

async function assertServiceFileTarget(ctx, filePath) {
  const stat = await lstatIfExists(filePath);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw serviceError(500, 'UNSAFE_DATA_FILE', '本地服务数据文件必须是普通文件，未读取链接。');
  }
  const appReal = await fs.realpath(ctx.appRoot);
  const real = await fs.realpath(filePath);
  if (!isInsideOrEqual(appReal, real) || !samePath(real, filePath)) {
    throw serviceError(500, 'UNSAFE_DATA_FILE', '本地服务数据文件真实路径异常。');
  }
}

async function readServiceJson(ctx, filePath, fallback) {
  const stat = await lstatIfExists(filePath);
  if (!stat) return fallback;
  await assertServiceFileTarget(ctx, filePath);
  const text = await fs.readFile(filePath, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw serviceError(500, 'CORRUPT_SERVICE_FILE', '本地服务元数据不是有效 JSON；未覆盖原文件。');
  }
}

async function writeServiceJson(ctx, filePath, value) {
  await validateProjectLayout(ctx.projectPath, { create: true });
  await assertServiceFileTarget(ctx, filePath);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8');
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

function sanitizeModelConfig(value) {
  if (!isPlainObject(value)) return null;
  const provider = typeof value.provider === 'string' ? value.provider : '';
  const model = typeof value.model === 'string' ? value.model : '';
  if (!provider || !model) return null;
  if (provider.length > 120 || model.length > 200) return null;
  const endpoint = typeof value.endpoint === 'string' ? value.endpoint : '';
  if (endpoint && !safeHttpUrl(endpoint)) return null;
  return { provider, model, endpoint };
}

async function readModelsDocument(ctx) {
  const doc = await readServiceJson(ctx, ctx.modelsFile, null);
  if (!doc) return { roles: {} };
  if (!isPlainObject(doc) || !isPlainObject(doc.roles)) {
    throw serviceError(500, 'CORRUPT_SERVICE_FILE', '模型角色元数据格式异常；未覆盖原文件。');
  }
  const roles = {};
  for (const role of ['search', 'execution', 'review']) {
    const config = sanitizeModelConfig(doc.roles[role]);
    if (config) roles[role] = config;
  }
  return { roles };
}

function modelsSnapshot(roleMap, credentialStore = null) {
  const pick = (role) => {
    const config = sanitizeModelConfig(roleMap[role]) || { provider: '', model: '', endpoint: '' };
    return {
      provider: config.provider,
      model: config.model,
      endpoint: config.endpoint,
      apiKeySet: credentialStore ? credentialStore.apiKeySet(role) : false,
    };
  };
  const search = pick('search');
  const execution = pick('execution');
  const review = pick('review');
  return {
    models: {
      search,
      research: { ...search },
      execution,
      review,
    },
    modelRoles: {
      research: { ...search },
      search: { ...search },
      execution: { ...execution },
      review: { ...review },
    },
  };
}

function buildFactUi(fact, companyNameById) {
  const confirmed = Boolean(fact.confirmed && fact.confirmedVersion === fact.version);
  const sourceRef = fact.source && typeof fact.source.ref === 'string' ? fact.source.ref : '';
  const sourceType = fact.source && typeof fact.source.type === 'string' ? fact.source.type : '';
  const sourceText = sourceType && sourceRef ? `${sourceType} · ${sourceRef}` : (sourceType || sourceRef);
  return {
    id: fact.id,
    section: mapCoreSectionToUi(fact.section),
    coreSection: fact.section,
    label: limitText(fact.label, 120),
    fullLabel: fact.label,
    rawText: fact.value,
    confirmedText: confirmed ? fact.value : '',
    confirmed,
    source: limitText(sourceText, 500),
    sourceType,
    sourceRef,
    sensitive: fact.sensitivity !== 'normal',
    sensitivity: fact.sensitivity,
    scope: fact.scope,
    allowedPurposes: Array.isArray(fact.allowedPurposes) ? [...fact.allowedPurposes] : [],
    entityId: fact.entityId ?? null,
    version: fact.version,
    confirmedAt: fact.confirmedAt || '',
    updatedAt: fact.updatedAt,
    companyName: companyNameById.get(fact.scope?.companyId) || '',
  };
}

function buildJob(position, company) {
  const selected = Array.isArray(company.selectedPositionIds)
    && company.selectedPositionIds.includes(position.id);
  const title = limitText(position.title, 200);
  const officialId = limitText(position.officialId, 120);
  return {
    id: position.id,
    title,
    fullTitle: position.title,
    jobId: officialId,
    fullJobId: position.officialId,
    city: limitText(position.city || '', 120),
    officialUrl: position.source?.url || '',
    status: normalizeJobStatusForPanel(position.status),
    coreStatus: position.status,
    selected,
    priority: Number.isInteger(position.priority) && position.priority > 0 ? position.priority : null,
    evidence: position.source?.evidence || '',
    source: position.source ? { ...position.source } : null,
    evidenceSource: 'user_manual_entry',
    submission: position.submission ? { ...position.submission } : null,
    verification: position.verification ? { ...position.verification } : null,
    skipReason: position.skipReason || '',
    history: Array.isArray(position.history) ? position.history.map((item) => ({ ...item })) : [],
    createdAt: position.createdAt,
    updatedAt: position.updatedAt,
  };
}

function buildApplication(company, positions, result, panelPositions) {
  const selected = positions.filter((position) => company.selectedPositionIds.includes(position.id));
  const verified = selected.filter((position) => position.status === 'verified');
  const reported = selected.filter((position) => position.status === 'submitted_reported');
  const pending = selected.filter((position) => !isPositionTerminal(position.status));
  let kind = 'none';
  let jobIds = [];
  if (company.historicalSubmission && selected.length === 0) {
    kind = 'self_reported';
  } else if (company.status === 'no_positions') {
    kind = 'no_suitable_jobs';
  } else if (company.status === 'blocked') {
    kind = 'blocked';
  } else if (company.status === 'skipped') {
    kind = 'skipped';
  } else if (selected.length > 0 && verified.length === selected.length) {
    kind = 'verified';
    jobIds = verified.map((position) => position.id);
  } else if (selected.length > 0 && reported.length === selected.length) {
    kind = 'self_reported';
    jobIds = reported.map((position) => position.id);
  } else if (verified.length > 0 || reported.length > 0) {
    kind = 'partial';
    jobIds = [...verified, ...reported].map((position) => position.id);
  } else if (pending.some((position) => position.status === 'awaiting_human_submit')) {
    kind = 'pending_submit';
    jobIds = pending.filter((position) => position.status === 'awaiting_human_submit').map((position) => position.id);
  }
  const reportedAt = company.historicalSubmission?.reportedAt || reported
    .map((position) => position.submission?.reportedAt)
    .filter(Boolean)
    .sort()
    .pop() || '';
  const verifiedAt = verified
    .map((position) => position.verification?.verifiedAt)
    .filter(Boolean)
    .sort()
    .pop() || '';
  return {
    kind,
    jobIds,
    note: limitText(company.historicalSubmission?.reference || result || '', 2000),
    reportedAt,
    verifiedAt,
    panelPositions: panelPositions.map((position) => position.id),
  };
}

function buildSearch(company, positions) {
  const evidence = company.noPositionsEvidence;
  let state = 'not_started';
  if (company.status === 'no_positions') state = 'no_suitable_jobs';
  else if (company.status === 'blocked') state = 'blocked';
  else if (company.status === 'researching') state = 'running';
  else if (['awaiting_selection', 'preparing', 'awaiting_issue_answers', 'awaiting_human_submit', 'completed', 'held'].includes(company.status)) {
    state = positions.length > 0 ? 'complete' : 'unknown';
  }
  const latestPosition = positions
    .map((position) => position.source?.checkedAt)
    .filter(Boolean)
    .sort()
    .pop() || '';
  return {
    state,
    panelState: state,
    message: limitText(evidence?.reason || '', 2000),
    evidenceUrl: evidence?.sourceUrl || positions.find((position) => position.source?.url)?.source?.url || '',
    checkedAt: evidence?.checkedAt || latestPosition,
    resultText: limitText(evidence?.resultText || '', 2000),
    checkedBy: evidence?.checkedBy || (positions.length ? 'user' : ''),
    source: evidence?.checkedBy === 'user' || positions.length ? 'user_manual_entry' : 'local_record',
  };
}

function buildIssue(issue, companyNameById) {
  return {
    id: issue.id,
    companyId: issue.companyId,
    companyName: companyNameById.get(issue.companyId) || '',
    jobId: issue.positionId || '',
    field: issue.fieldKey,
    severity: PANEL_ISSUE_SEVERITY[issue.severity] || 'confirm',
    coreSeverity: issue.severity,
    status: issue.status,
    title: limitText(issue.message, 300),
    message: issue.message,
    detail: limitText(issue.message, 4000),
    evidence: limitText(issue.evidence || '', 4000),
    answer: issue.answer || '',
    blocking: issue.blocking === true,
    type: issue.type,
    occurrences: issue.occurrences,
    dependencies: Array.isArray(issue.dependencies) ? [...issue.dependencies] : [],
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    version: issue.updatedAt,
  };
}

async function buildCompanySnapshot(ctx, companyId, companyNameById, issues) {
  const detail = await ctx.registry.invoke('get_company', { companyId });
  const company = detail.company;
  const positions = Array.isArray(detail.positions) ? detail.positions : [];
  const result = detail.result || companyResultText(company, positions);
  const jobs = positions.map((position) => buildJob(position, company));
  return {
    id: company.id,
    name: company.name,
    batch: company.batch || '',
    identityKey: company.identityKey || '',
    queuePosition: company.queueOrder,
    queueOrder: company.queueOrder,
    status: normalizeStatusForPanel(company.status),
    coreStatus: company.status,
    panelStatus: normalizeStatusForPanel(company.status),
    links: (company.links || [])
      .filter((link) => safeHttpUrl(link.url))
      .slice(0, 30)
      .map((link) => ({
        url: link.url,
        label: link.kind || '',
        source: limitText(link.source || '', 200),
      })),
    coreLinks: (company.links || []).map((link) => ({ ...link })),
    referralCodes: (company.referralCandidates || []).map((candidate) => ({
      value: candidate.value,
      source: limitText(candidate.source || '', 200),
      selected: company.referralSelected === candidate.value,
    })),
    referralCandidates: (company.referralCandidates || []).map((candidate) => ({ ...candidate })),
    referralSelected: company.referralSelected || null,
    search: buildSearch(company, positions),
    jobs,
    positions: positions.map((position) => ({ ...position })),
    application: buildApplication(company, positions, result, jobs),
    historicalSubmission: company.historicalSubmission ? { ...company.historicalSubmission } : null,
    result: limitText(result, 4000),
    note: limitText(company.holdReason || company.skipReason || '', 2000),
    holdReason: company.holdReason || '',
    skipReason: company.skipReason || '',
    activePositionId: company.activePositionId,
    selectedPositionIds: [...(company.selectedPositionIds || [])],
    noPositionsEvidence: company.noPositionsEvidence ? { ...company.noPositionsEvidence } : null,
    checkpoint: company.checkpoint ? { ...company.checkpoint } : null,
    history: Array.isArray(company.history) ? company.history.map((item) => ({ ...item })) : [],
    issues: issues.filter((issue) => issue.companyId === company.id).map((issue) => buildIssue(issue, companyNameById)),
    createdAt: company.createdAt,
    updatedAt: company.updatedAt,
  };
}

async function buildState(ctx, { revision, summary = null, layout = null } = {}) {
  const effectiveLayout = layout || await validateProjectLayout(ctx.projectPath, { create: false });
  if (summary === null) {
    summary = effectiveLayout.privateExists ? await ctx.core.summary() : null;
  }
  const modelDoc = await readModelsDocument(ctx);
  const modelSnapshot = modelsSnapshot(modelDoc.roles, ctx.mokaCredentials);
  const mokaState = ctx.moka ? await ctx.moka.getState() : null;
  const metaRevision = await readMetaRevision(ctx);
  const effectiveRevision = revision ?? Math.max(metaRevision, summary?.revision || 0, summary?.profileRevision || 0);
  const queue = summarizeQueue(summary);
  const capabilities = buildCapabilities();

  if (!summary) {
    return {
      generatedAt: new Date().toISOString(),
      revision: effectiveRevision,
      profileRevision: 0,
      workflowVersion: null,
      queue,
      currentCompanyId: null,
      currentCompany: null,
      recoveryPending: false,
      checkpoint: null,
      companies: [],
      positions: [],
      issues: [],
      issueDigest: null,
      facts: [],
      profileFacts: [],
      ...modelSnapshot,
      capabilities,
      moka: mokaState,
    };
  }

  const issueList = await ctx.registry.invoke('list_issues', { status: 'all' });
  const issues = Array.isArray(issueList) ? issueList : [];
  const companyNameById = new Map((summary.companies || []).map((company) => [company.id, company.name]));
  const companies = [];
  for (const company of summary.companies || []) {
    companies.push(await buildCompanySnapshot(ctx, company.id, companyNameById, issues));
  }
  const positions = companies.flatMap((company) => company.positions || []);
  const factList = await ctx.registry.invoke('list_profile_facts_for_local_edit', {});
  const facts = Array.isArray(factList)
    ? factList.map((fact) => buildFactUi(fact, companyNameById))
    : [];
  const currentCompanyId = summary.queue?.currentCompanyId || null;
  return {
    generatedAt: new Date().toISOString(),
    revision: effectiveRevision,
    profileRevision: summary.profileRevision || 0,
    workflowVersion: summary.workflowVersion || null,
    queue,
    currentCompanyId,
    currentCompany: companies.find((company) => company.id === currentCompanyId) || null,
    recoveryPending: summary.recoveryPending === true,
    checkpoint: summary.checkpoint ? { ...summary.checkpoint } : null,
    companies,
    positions,
    issues: issues.map((issue) => buildIssue(issue, companyNameById)),
    issueDigest: mokaState?.issueDigest || null,
    facts,
    profileFacts: facts,
    ...modelSnapshot,
    capabilities,
    moka: mokaState,
  };
}

async function readMetaRevision(ctx) {
  const doc = await readServiceJson(ctx, ctx.metaFile, null);
  if (!doc) return 0;
  if (!isPlainObject(doc) || !Number.isInteger(doc.revision) || doc.revision < 0) {
    throw serviceError(500, 'CORRUPT_SERVICE_FILE', '本地服务修订记录格式异常；未覆盖原文件。');
  }
  return doc.revision;
}

async function currentRevision(ctx) {
  const summary = await ctx.core.summary();
  const metaRevision = await readMetaRevision(ctx);
  return {
    revision: Math.max(metaRevision, summary.revision || 0, summary.profileRevision || 0),
    summary,
  };
}

async function bumpRevision(ctx, baseRevision) {
  const metaRevision = await readMetaRevision(ctx);
  let runtimeRevision = 0;
  let profileRevision = 0;
  try {
    runtimeRevision = await ctx.core.runtimeRevision();
    profileRevision = (await ctx.core.summary()).profileRevision || 0;
  } catch {
    // The command already used the core; a revision read failure must not
    // rewrite or invent state. Keep the highest known revision and bump once.
  }
  const next = Math.max(metaRevision, baseRevision, runtimeRevision, profileRevision) + 1;
  await writeServiceJson(ctx, ctx.metaFile, {
    schemaVersion: META_SCHEMA,
    revision: next,
    updatedAt: new Date().toISOString(),
  });
  return next;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function acquireProjectLock(ctx) {
  if (ctx.lockHeld) return;
  const lockPath = ctx.lockFile;
  const key = projectKey(lockPath);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const stat = await lstatIfExists(lockPath);
    if (stat && stat.isSymbolicLink()) {
      throw serviceError(409, 'PROJECT_LOCKED', '项目锁路径异常，未删除或跟随该锁文件。');
    }
    if (!stat) {
      let handle = null;
      try {
        handle = await fs.open(lockPath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({
          schemaVersion: LOCK_SCHEMA,
          id: ctx.lockId,
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }), 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        ctx.lockHeld = true;
        LIVE_LOCKS.set(key, ctx.lockId);
        return;
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        if (error.code !== 'EEXIST') throw error;
      }
    }

    let content = null;
    let parsed = null;
    let lockStat = null;
    try {
      lockStat = await fs.lstat(lockPath);
      if (lockStat.isSymbolicLink()) {
        throw serviceError(409, 'PROJECT_LOCKED', '项目锁路径异常，未删除或跟随该锁文件。');
      }
      content = await fs.readFile(lockPath, 'utf8');
      parsed = JSON.parse(content);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      if (error.code === 'ENOENT') continue;
      parsed = null;
    }

    const heldHere = LIVE_LOCKS.has(key);
    const otherProcessAlive = parsed && Number.isInteger(parsed.pid)
      && parsed.pid !== process.pid
      && isProcessAlive(parsed.pid);
    if (heldHere || otherProcessAlive) {
      throw serviceError(
        409,
        'PROJECT_LOCKED',
        '该项目已有另一个服务实例在管理；未删除存活锁，请先关闭另一个实例。',
      );
    }

    if (!parsed) {
      const age = lockStat ? Date.now() - lockStat.mtimeMs : 0;
      if (age < 30_000) {
        throw serviceError(409, 'PROJECT_LOCKED', '项目锁内容无法识别且仍较新；未删除该锁文件。');
      }
    }

    // Only remove a lock that is not held by a live process in this process or
    // another process. Re-read so a newly written lock is never deleted.
    const beforeDelete = await fs.readFile(lockPath, 'utf8').catch(() => null);
    if (beforeDelete === null) continue;
    if (content !== null && beforeDelete !== content) continue;
    await fs.unlink(lockPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  throw serviceError(409, 'PROJECT_LOCKED', '无法安全取得项目锁；未覆盖现有锁文件。');
}

async function releaseProjectLock(ctx) {
  if (!ctx.lockHeld) return;
  const key = projectKey(ctx.lockFile);
  try {
    const raw = await fs.readFile(ctx.lockFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.id === ctx.lockId) {
      await fs.unlink(ctx.lockFile);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // Never delete an unreadable or replaced lock. A dead PID is recovered on
      // the next start; a live lock remains respected.
    }
  } finally {
    LIVE_LOCKS.delete(key);
    ctx.lockHeld = false;
  }
}

function enqueueProjectTask(ctx, task) {
  const run = ctx.tail.catch(() => {}).then(task);
  ctx.tail = run.catch(() => {});
  return run;
}

function assertModelRoles(value) {
  if (!isPlainObject(value)) {
    throw serviceError(400, 'INVALID_MODELS', '模型角色配置必须是对象。');
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw serviceError(400, 'INVALID_MODELS', '至少需要保存一个角色配置。');
  }
  const result = {};
  const seen = new Set();
  for (const [rawRole, rawConfig] of entries) {
    const role = rawRole === 'research' ? 'search' : rawRole;
    if (!['search', 'execution', 'review'].includes(role)) {
      throw serviceError(400, 'INVALID_MODEL_ROLE', `未知模型角色：${rawRole}。`);
    }
    if (seen.has(role)) {
      throw serviceError(400, 'INVALID_MODEL_ROLE', `模型角色别名重复：${rawRole}。`);
    }
    seen.add(role);
    if (!isPlainObject(rawConfig)) {
      throw serviceError(400, 'INVALID_MODELS', `角色 ${rawRole} 的配置必须是对象。`);
    }
    for (const key of Object.keys(rawConfig)) {
      if (!['provider', 'model', 'endpoint', 'baseUrl', 'apiKey', 'clearApiKey'].includes(key)) {
        throw serviceError(400, 'UNKNOWN_FIELD', `角色 ${rawRole} 包含未支持字段：${key}。`, {
          field: `roles.${rawRole}.${key}`,
        });
      }
    }
    if (rawConfig.clearApiKey === true && rawConfig.apiKey !== undefined && rawConfig.apiKey !== null && rawConfig.apiKey !== '') {
      throw serviceError(400, 'INVALID_MODELS', '不能同时输入新密钥和清除密钥。');
    }
    if (rawConfig.apiKey !== undefined && rawConfig.apiKey !== null && rawConfig.apiKey !== '') {
      if (typeof rawConfig.apiKey !== 'string' || !rawConfig.apiKey.trim() || rawConfig.apiKey.length > 4000) {
        throw serviceError(400, 'INVALID_API_KEY', 'API Key 必须是非空字符串且不超过 4000 字符；未保存。');
      }
    }
    const provider = requireString(rawConfig.provider, `${rawRole}.provider`, { max: 120 });
    const model = requireString(rawConfig.model, `${rawRole}.model`, { max: 200 });
    const endpointValue = rawConfig.endpoint !== undefined ? rawConfig.endpoint : rawConfig.baseUrl;
    const endpoint = endpointValue === undefined || endpointValue === null || endpointValue === ''
      ? ''
      : requireString(endpointValue, `${rawRole}.endpoint`, { max: 2000 });
    if (endpoint && !safeHttpUrl(endpoint)) {
      throw serviceError(400, 'INVALID_ENDPOINT', `${rawRole}.endpoint 必须是 http(s) 地址且不能包含账号密码。`);
    }
    result[role] = {
      provider,
      model,
      endpoint,
      ...(rawConfig.clearApiKey === true ? { clearApiKey: true } : {}),
      ...(typeof rawConfig.apiKey === 'string' && rawConfig.apiKey.trim() ? { apiKey: rawConfig.apiKey.trim() } : {}),
    };
  }
  return result;
}

function normalizeEnqueue(input) {
  assertOnlyKeys(input, ['url', 'link', 'companyName', 'batch', 'referralCode', 'referralCodes', 'source']);
  const rawUrl = input.url ?? input.link;
  const url = requireString(rawUrl, '公司链接', { max: 2000 });
  if (!safeHttpUrl(url)) {
    throw serviceError(400, 'INVALID_URL', '公司链接必须是可公开打开的 http(s) 地址，且不能包含账号密码。');
  }
  let name = optionalString(input.companyName, '公司名称', { max: 200 });
  if (!name) {
    try {
      name = new URL(url).hostname.replace(/^www\./i, '') || '未命名公司';
    } catch {
      name = '未命名公司';
    }
  }
  const batch = optionalString(input.batch, '批次', { max: 100 });
  const source = optionalString(input.source, '来源说明', { max: 1000 });
  const codes = [];
  const pushCode = (value) => {
    if (typeof value !== 'string') {
      throw serviceError(400, 'INVALID_REFERRAL', '内推码必须是字符串。');
    }
    const code = value.trim();
    if (!code) return;
    if (code.length > 200) {
      throw serviceError(400, 'INVALID_REFERRAL', '内推码超出长度限制。');
    }
    if (!codes.includes(code)) codes.push(code);
  };
  if (input.referralCode !== undefined && input.referralCode !== null) pushCode(input.referralCode);
  if (input.referralCodes !== undefined && input.referralCodes !== null) {
    if (!Array.isArray(input.referralCodes)) {
      throw serviceError(400, 'INVALID_REFERRAL', 'referralCodes 必须是数组。');
    }
    for (const code of input.referralCodes) pushCode(code);
  }
  // Keep referral codes embedded in the official link as candidates instead of
  // silently discarding them. This mirrors extension/company-parser.js's local
  // link-parameter rules and never expands short links or makes a request.
  try {
    const parsed = new URL(url);
    for (const [key, value] of parsed.searchParams.entries()) {
      if (!['recommendcode', 'acotycode'].includes(key.toLowerCase())) continue;
      if (/^[A-Za-z0-9_-]{3,40}$/.test(value)) pushCode(value);
    }
  } catch {
    // URL validity was checked above.
  }
  return { name, batch, url, source, codes };
}

async function runEnqueue(ctx, input, deps) {
  const result = await deps.invoke(ctx, 'add_company', {
    name: input.name,
    batch: input.batch,
    links: [{
      url: input.url,
      kind: 'apply',
      source: input.source || '本人手动加入任务池',
    }],
    referralCandidates: input.codes.map((value) => ({
      value,
      source: input.source || '本人手动录入',
    })),
  });
  return {
    result: {
      companyId: result.company?.id || '',
      companyName: result.company?.name || input.name,
      queueOrder: result.company?.queueOrder ?? null,
      duplicate: result.duplicate === true,
      merged: result.merged || null,
      referralCodes: input.codes,
      note: '已加入任务池；不会自动登录、检索或提交。',
    },
    changed: true,
  };
}

function normalizeStart(input) {
  assertOnlyKeys(input, ['companyId', 'confirmedByUser']);
  if (input.companyId !== undefined && input.companyId !== null && input.companyId !== '') {
    requireString(input.companyId, 'companyId', { max: 128 });
  }
  return {};
}

async function runStart(ctx, input, deps) {
  const result = await deps.invoke(ctx, 'start_queue', {
    eventId: deps.newId(),
    confirmedBy: 'user',
  });
  return {
    result: {
      queue: result.queue,
      currentCompanyId: result.currentCompanyId || null,
      note: '队列已启动；只把首家置为待登录，登录和最终提交仍由本人完成。',
    },
    changed: true,
  };
}

function normalizePause(input) {
  assertOnlyKeys(input, ['reason']);
  return { reason: optionalString(input.reason, '暂停原因', { max: 500 }) };
}

async function runPause(ctx, input, deps) {
  const result = await deps.invoke(ctx, 'pause_queue', {});
  await ctx.moka.cancel('队列已暂停').catch(() => {});
  return {
    result: {
      queue: result.queue,
      idempotent: result.idempotent === true,
      note: input.reason ? `暂停原因：${input.reason}` : '已暂停；不会自动推进。',
    },
    changed: result.idempotent !== true,
  };
}

function normalizeResume(input) {
  assertOnlyKeys(input, []);
  return {};
}

function normalizePrioritizeCompany(input) {
  assertOnlyKeys(input, ['companyId']);
  return { companyId: requireString(input.companyId, '公司 ID', { max: 128 }) };
}

async function runResume(ctx, input, deps) {
  const result = await deps.invoke(ctx, 'resume_queue', {});
  return {
    result: {
      queue: result.queue,
      currentCompanyId: result.currentCompanyId || null,
      idempotent: result.idempotent === true,
      note: '恢复只依据持久化状态；不重放页面填写、上传或提交。',
    },
    changed: result.idempotent !== true,
  };
}

async function runPrioritizeCompany(ctx, input, deps) {
  const result = await deps.invoke(ctx, 'prioritize_company', {
    companyId: input.companyId,
  });
  return {
    result: {
      company: result.company,
      queue: result.queue,
      idempotent: result.idempotent === true,
      note: '已把该公司调整为下一家待处理任务；不会自动登录、填写或提交。',
    },
    changed: result.idempotent !== true,
  };
}

function normalizeConfirmLogin(input) {
  assertOnlyKeys(input, ['companyId', 'confirmedByUser', 'note']);
  requireUserConfirmation(input, '记录本人登录');
  return {
    companyId: requireString(input.companyId, 'companyId', { max: 128 }),
    note: optionalString(input.note, '登录备注', { max: 500 }),
  };
}

async function runConfirmLogin(ctx, input, deps) {
  const result = await deps.invoke(ctx, 'record_human_login', {
    companyId: input.companyId,
    eventId: deps.newId(),
    confirmedBy: 'user',
  });
  return {
    result: {
      company: result.company,
      queue: result.queue,
      note: '已记录本人完成登录；服务未读取账号、密码或验证码。',
    },
    changed: true,
  };
}

function normalizeSelectJobs(input) {
  assertOnlyKeys(input, ['companyId', 'jobIds', 'positionIds']);
  const companyId = requireString(input.companyId, 'companyId', { max: 128 });
  const rawIds = input.jobIds ?? input.positionIds;
  if (!Array.isArray(rawIds)) {
    throw serviceError(400, 'INVALID_JOB_SELECTION', '岗位选择必须是数组。');
  }
  const jobIds = rawIds.map((id) => requireString(id, 'jobId', { max: 128 }));
  if (jobIds.length < 1 || jobIds.length > 3) {
    throw serviceError(400, 'INVALID_JOB_SELECTION', '请选择 1～3 个岗位。');
  }
  if (new Set(jobIds).size !== jobIds.length) {
    throw serviceError(400, 'INVALID_JOB_SELECTION', '岗位选择不能重复。');
  }
  return { companyId, jobIds };
}

async function runSelectJobs(ctx, input, deps) {
  const result = await deps.invoke(ctx, 'select_positions', {
    companyId: input.companyId,
    positionIds: input.jobIds,
  });
  return {
    result: {
      company: result.company,
      positions: result.positions,
      queue: result.queue,
      note: '已保存本人选择与优先级；不会代提交。',
    },
    changed: true,
  };
}

function normalizeReportSubmitted(input) {
  assertOnlyKeys(input, ['companyId', 'jobId', 'positionId', 'confirmedByUser', 'note']);
  const companyId = requireString(input.companyId, 'companyId', { max: 128 });
  const jobId = requireString(input.jobId ?? input.positionId, 'jobId', { max: 128 });
  requireUserConfirmation(input, '记录本人已提交');
  const note = optionalString(input.note, '提交备注', { max: 500, preserve: true });
  return { companyId, jobId, note };
}

async function runReportSubmitted(ctx, input, deps) {
  const result = await deps.invoke(ctx, 'record_human_submission', {
    companyId: input.companyId,
    positionId: input.jobId,
    eventId: deps.newId(),
    reportedAt: deps.now(),
    reference: input.note,
    confirmedBy: 'user',
  });
  return {
    result: {
      company: result.company,
      position: result.position,
      queue: result.queue,
      note: '已记录本人提交回执；这不是官网核验，也不会自动重投。',
    },
    changed: true,
  };
}

function normalizeHistoricalSubmission(input) {
  assertOnlyKeys(input, ['companyId', 'confirmedByUser', 'note']);
  requireUserConfirmation(input, '记录历史本人已投递');
  return {
    companyId: requireString(input.companyId, 'companyId', { max: 128 }),
    reference: requireString(input.note, '历史投递说明', { max: 1000, preserve: true }),
  };
}

async function runHistoricalSubmission(ctx, input, deps) {
  const result = await deps.invoke(ctx, 'record_historical_submission', {
    companyId: input.companyId,
    eventId: deps.newId(),
    reportedAt: deps.now(),
    reference: input.reference,
    confirmedBy: 'user',
  });
  return {
    result: {
      company: result.company,
      queue: result.queue,
      note: '已记录历史本人投递；没有岗位 ID 时保留公司级来源，不等同官网核验，也不会自动重投。',
    },
    changed: true,
  };
}

function normalizeMarkReady(input) {
  assertOnlyKeys(input, ['companyId', 'jobId', 'positionId', 'confirmedByUser']);
  requireUserConfirmation(input, '确认岗位可送交本人提交');
  return {
    companyId: requireString(input.companyId, 'companyId', { max: 128 }),
    jobId: requireString(input.jobId ?? input.positionId, 'jobId', { max: 128 }),
  };
}

async function runMarkReady(ctx, input, deps) {
  const result = await deps.invoke(ctx, 'mark_position_ready', {
    companyId: input.companyId,
    positionId: input.jobId,
    confirmedBy: 'user',
  });
  return {
    result: {
      company: result.company,
      position: result.position,
      queue: result.queue,
      note: '岗位已进入待本人提交；仍不会自动提交。',
    },
    changed: true,
  };
}

function normalizeDeferCompany(input) {
  assertOnlyKeys(input, ['companyId', 'reason']);
  return {
    companyId: requireString(input.companyId, 'companyId', { max: 128 }),
    reason: optionalString(input.reason, '暂挂原因', { max: 500 }) || '本人选择稍后处理（未完成）',
  };
}

async function runDeferCompany(ctx, input, deps) {
  const result = await deps.invoke(ctx, 'hold_company', {
    companyId: input.companyId,
    reason: input.reason,
  });
  return {
    result: {
      company: result.company,
      queue: result.queue,
      note: '已暂挂；不会标记完成，也不会丢失现场。',
    },
    changed: true,
  };
}

function normalizeResumeCompany(input) {
  assertOnlyKeys(input, ['companyId']);
  return { companyId: requireString(input.companyId, 'companyId', { max: 128 }) };
}

async function runResumeCompany(ctx, input, deps) {
  const result = await deps.invoke(ctx, 'resume_held_company', { companyId: input.companyId });
  return {
    result: {
      company: result.company,
      queue: result.queue,
      note: '已恢复暂挂公司；不会同时处理另一家活动公司。',
    },
    changed: true,
  };
}

function normalizeSkipCompany(input) {
  assertOnlyKeys(input, ['companyId', 'reason', 'confirmedByUser']);
  requireUserConfirmation(input, '跳过整家公司');
  return {
    companyId: requireString(input.companyId, 'companyId', { max: 128 }),
    reason: optionalString(input.reason, '跳过原因', { max: 500 }) || '本人明确跳过该公司',
  };
}

async function runSkipCompany(ctx, input, deps) {
  const result = await deps.invoke(ctx, 'skip_company', {
    companyId: input.companyId,
    reason: input.reason,
  });
  return {
    result: {
      company: result.company,
      queue: result.queue,
      note: '已记录本人跳过该公司；不写成“没有符合职位”。',
    },
    changed: true,
  };
}

function normalizeSkipJob(input) {
  assertOnlyKeys(input, ['companyId', 'jobId', 'positionId', 'reason', 'confirmedByUser']);
  requireUserConfirmation(input, '跳过岗位');
  return {
    companyId: requireString(input.companyId, 'companyId', { max: 128 }),
    jobId: requireString(input.jobId ?? input.positionId, 'jobId', { max: 128 }),
    reason: optionalString(input.reason, '跳过原因', { max: 500 }) || '本人明确跳过该岗位',
  };
}

async function runSkipJob(ctx, input, deps) {
  const result = await deps.invoke(ctx, 'skip_position', {
    companyId: input.companyId,
    positionId: input.jobId,
    reason: input.reason,
  });
  return {
    result: {
      company: result.company,
      position: result.position,
      queue: result.queue,
      note: '已记录本人跳过该岗位；不会自动重投或标记公司完成。',
    },
    changed: true,
  };
}

function normalizeResolveIssue(input) {
  assertOnlyKeys(input, [
    'issueId',
    'action',
    'answer',
    'confirmedByUser',
    'confirmedNoAnswer',
    'noAnswerNeeded',
  ]);
  const issueId = requireString(input.issueId, 'issueId', { max: 128 });
  const action = input.action;
  if (action === 'defer') {
    return { issueId, action: 'defer' };
  }
  if (action === 'answer') {
    const answer = requireString(input.answer, '问题补充', { max: 4000, preserve: true });
    if (!answer.trim()) {
      throw serviceError(400, 'ANSWER_REQUIRED', '问题补充不能只有空白。');
    }
    return { issueId, action, answer };
  }
  if (action === 'resolve') {
    requireUserConfirmation(input, '本人核对解决');
    return {
      issueId,
      action,
      confirmedNoAnswer: input.confirmedNoAnswer === true || input.noAnswerNeeded === true,
    };
  }
  throw serviceError(400, 'INVALID_ISSUE_ACTION', '问题操作只能是 answer、defer 或 resolve。');
}

async function findIssueForUserAction(ctx, issueId, deps) {
  const issues = await deps.invoke(ctx, 'list_issues', { status: 'all' });
  const issue = Array.isArray(issues) ? issues.find((item) => item.id === issueId) : null;
  if (!issue) throw serviceError(404, 'ISSUE_NOT_FOUND', '问题不存在。');
  return issue;
}

async function runResolveIssue(ctx, input, deps) {
  if (input.action === 'answer') {
    const result = await deps.invoke(ctx, 'answer_issue', {
      issueId: input.issueId,
      answer: input.answer,
    });
    return {
      result: {
        issue: result.issue,
        note: '已保存本人回答；问题变为已回答，不等同于已解决。',
      },
      changed: true,
    };
  }

  const issue = await findIssueForUserAction(ctx, input.issueId, deps);
  if (input.action === 'defer') {
    // Explicit, persistable no-op. The core issue remains open/answered and
    // the revision does not move; closing the dialog still does not resolve it.
    return {
      result: {
        issue,
        deferred: true,
        issueStatus: issue.status,
        note: '已记录本人稍后处理；问题仍保持未决，不会增加修订或标记解决。',
      },
      changed: false,
    };
  }

  if (issue.status === 'resolved') {
    return {
      result: {
        issue,
        resolved: true,
        alreadyResolved: true,
        note: '该问题此前已由本人解决；未重复写入。',
      },
      changed: false,
    };
  }
  if (issue.status !== 'answered' && input.confirmedNoAnswer !== true) {
    throw serviceError(
      409,
      'ISSUE_ANSWER_REQUIRED',
      '问题尚未回答；请先补充，或在界面中由本人明确表示无需回答后再解决。',
      { issueStatus: issue.status },
    );
  }

  const result = await deps.invoke(ctx, 'resolve_issue', { issueId: input.issueId });
  return {
    result: {
      issue: result.issue,
      company: result.company,
      resolved: true,
      deferred: false,
      note: '已由本人明确标记问题解决；关闭弹窗不会触发此操作。',
    },
    changed: true,
  };
}

function normalizeImportFacts(input) {
  const ignored = ['confirmed', 'confirmedText', 'verified'];
  assertOnlyKeys(input, [
    'section',
    'label',
    'rawText',
    'source',
    'sensitive',
    'allowedPurposes',
    'entityId',
    ...ignored,
  ]);
  const section = requireString(input.section, '资料分区', { max: 40 });
  const coreSection = mapUiSectionToCore(section);
  if (!coreSection) {
    throw serviceError(400, 'INVALID_PROFILE_SECTION', `未知资料分区：${section}。`);
  }
  const label = requireString(input.label, '字段名称', { max: 120, preserve: true });
  if (!label.trim()) {
    throw serviceError(400, 'INVALID_FIELD', '字段名称不能只有空白。', { field: 'label' });
  }
  const rawText = requireString(input.rawText, '字段原文', { max: 20000, preserve: true });
  if (!rawText.trim()) {
    throw serviceError(400, 'INVALID_RAW_TEXT', '字段原文不能只有空白。');
  }
  const source = optionalString(input.source, '原文来源', { max: 1000, preserve: true });
  const entityId = optionalString(input.entityId, '经历编号', { max: 200, preserve: true });
  const labelForSensitivity = label.replace(/\s+/g, '');
  const familyByLabel = FAMILY_LABEL_PATTERN.test(labelForSensitivity);
  const sensitiveByLabel = SENSITIVE_LABEL_PATTERN.test(labelForSensitivity);
  let sensitivity = 'normal';
  if (section === 'family' || familyByLabel) sensitivity = 'family';
  else if (input.sensitive === true || sensitiveByLabel) sensitivity = 'sensitive';
  let allowedPurposes = [];
  if (input.allowedPurposes !== undefined) {
    if (!Array.isArray(input.allowedPurposes)) {
      throw serviceError(400, 'INVALID_FIELD', 'allowedPurposes 必须是数组。', { field: 'allowedPurposes' });
    }
    allowedPurposes = [...new Set(input.allowedPurposes.map((purpose) => requireString(purpose, 'allowedPurposes', { max: 100 })))];
  }
  if (sensitivity !== 'normal' && allowedPurposes.length === 0) {
    allowedPurposes = ['local_profile_management'];
  }
  return {
    section: coreSection,
    label,
    value: rawText,
    source,
    entityId,
    sensitivity,
    allowedPurposes,
    sensitivityInferredFromLabel: (familyByLabel || sensitiveByLabel) && input.sensitive !== true,
    ignoredExternalFlags: ignored.filter((key) => Object.hasOwn(input, key)),
  };
}

async function runImportFacts(ctx, input, deps) {
  const result = await deps.invoke(ctx, 'create_profile_fact', {
    section: input.section,
    label: input.label,
    value: input.value,
    source: { type: 'import', ref: input.source },
    scope: { type: 'global', companyId: null, positionId: null },
    sensitivity: input.sensitivity,
    allowedPurposes: input.allowedPurposes,
    ...(input.entityId ? { entityId: input.entityId } : {}),
  });
  return {
    result: {
      fact: result,
      factId: result.id,
      confirmed: false,
      source: 'import',
      sensitivity: result.sensitivity,
      entityId: result.entityId ?? null,
      sensitivityInferredFromLabel: input.sensitivityInferredFromLabel,
      ignoredExternalFlags: input.ignoredExternalFlags,
      note: '已导入为未确认条目；原文保留，不能直接用于填写。',
    },
    changed: true,
  };
}

function normalizeConfirmFact(input) {
  assertOnlyKeys(input, ['factId', 'expectedVersion', 'confirmedByUser']);
  requireUserConfirmation(input, '确认资料');
  if (input.expectedVersion === undefined || input.expectedVersion === null) {
    throw serviceError(
      400,
      'EXPECTED_VERSION_REQUIRED',
      '确认资料必须携带本人实际看到的 expectedVersion，不能自动读取最新版本。',
    );
  }
  return {
    factId: requireString(input.factId, 'factId', { max: 128 }),
    expectedVersion: normalizeIntegerVersion(input.expectedVersion),
  };
}

async function runConfirmFact(ctx, input, deps) {
  const result = await deps.invoke(ctx, 'confirm_profile_fact', {
    factId: input.factId,
    expectedVersion: input.expectedVersion,
    confirmedBy: 'user',
  });
  return {
    result: {
      fact: result,
      factId: result.id,
      confirmed: result.confirmed === true,
      version: result.version,
      note: '已确认当前版本；修改该字段后确认会自动失效。',
    },
    changed: true,
  };
}

function normalizeReviseFact(input) {
  assertOnlyKeys(input, ['factId', 'expectedVersion', 'patch', 'confirmedByUser']);
  const factId = requireString(input.factId, 'factId', { max: 128 });
  const expectedVersion = normalizeIntegerVersion(input.expectedVersion);
  if (!isPlainObject(input.patch)) {
    throw serviceError(400, 'INVALID_PATCH', 'patch 必须是对象。');
  }
  const patch = { ...input.patch };
  for (const key of Object.keys(patch)) {
    if (!['label', 'value', 'rawText', 'entityId'].includes(key)) {
      throw serviceError(400, 'FIELD_PROTECTED', `资料字段属性 ${key} 不允许通过此接口修改。`);
    }
  }
  if (Object.hasOwn(patch, 'rawText')) {
    if (Object.hasOwn(patch, 'value')) {
      throw serviceError(400, 'INVALID_PATCH', 'patch 不能同时包含 value 和 rawText。');
    }
    patch.value = patch.rawText;
    delete patch.rawText;
  }
  if (Object.hasOwn(patch, 'entityId')) {
    if (patch.entityId === null || patch.entityId === '') {
      patch.entityId = null;
    } else {
      patch.entityId = requireString(patch.entityId, '经历编号', { max: 200, preserve: true });
    }
  }
  if (Object.keys(patch).length === 0) {
    throw serviceError(400, 'INVALID_PATCH', 'patch 至少要包含一个可修改字段。');
  }
  return { factId, expectedVersion, patch };
}

async function runReviseFact(ctx, input, deps) {
  const result = await deps.invoke(ctx, 'revise_profile_fact', {
    factId: input.factId,
    expectedVersion: input.expectedVersion,
    patch: input.patch,
  });
  return {
    result: {
      fact: result,
      factId: result.id,
      confirmed: false,
      version: result.version,
      entityId: result.entityId ?? null,
      note: '已按旧版本保存修改；原确认已失效，请重新本人确认。',
    },
    changed: true,
  };
}

function normalizeSaveModels(input) {
  assertOnlyKeys(input, ['roles']);
  return { roles: assertModelRoles(input.roles) };
}

async function runSaveModels(ctx, input, deps) {
  await validateProjectLayout(ctx.projectPath, { create: true });
  const existing = await readModelsDocument(ctx);
  const roles = { ...existing.roles };
  for (const [role, config] of Object.entries(input.roles)) {
    if (config.clearApiKey === true) ctx.mokaCredentials.clear(role);
    if (config.apiKey) ctx.mokaCredentials.set(role, config.apiKey);
    roles[role] = {
      provider: config.provider,
      model: config.model,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    };
  }
  await writeServiceJson(ctx, ctx.modelsFile, {
    schemaVersion: MODELS_SCHEMA,
    roles,
  });
  return {
    result: {
      roles: modelsSnapshot(roles, ctx.mokaCredentials).models,
      note: '已保存角色 provider/model 元数据；本进程内存已更新密钥（不回显、不落盘）。服务重启需重新输入。',
    },
    changed: true,
  };
}

function normalizeMokaOpen(input) {
  assertOnlyKeys(input, ['companyId']);
  return { companyId: requireString(input.companyId, 'companyId', { max: 128 }) };
}

function normalizeMokaResearch(input) {
  assertOnlyKeys(input, ['companyId', 'sendAuthorized']);
  if (input.sendAuthorized !== true) {
    throw serviceError(400, 'MODEL_SEND_NOT_AUTHORIZED', '未勾选本次模型发送授权；不会发起任何模型请求。');
  }
  return {
    companyId: requireString(input.companyId, 'companyId', { max: 128 }),
    sendAuthorized: true,
  };
}

function normalizeMokaPrepareFill(input) {
  assertOnlyKeys(input, ['companyId', 'jobId', 'sendAuthorized']);
  if (input.sendAuthorized !== true) {
    throw serviceError(400, 'MODEL_SEND_NOT_AUTHORIZED', '未勾选本次模型发送授权；不会发起任何模型请求。');
  }
  return {
    companyId: requireString(input.companyId, 'companyId', { max: 128 }),
    jobId: requireString(input.jobId, 'jobId', { max: 128 }),
    sendAuthorized: true,
  };
}

function normalizeMokaRunFill(input) {
  assertOnlyKeys(input, ['companyId', 'jobId', 'planId', 'sendAuthorized', 'confirmedByUser']);
  if (input.sendAuthorized !== true) {
    throw serviceError(400, 'MODEL_SEND_NOT_AUTHORIZED', '未勾选发送授权；不会执行填写或复核。');
  }
  if (input.confirmedByUser !== true) {
    throw serviceError(400, 'CONFIRMATION_REQUIRED', '执行前必须由本人确认当前填写计划。');
  }
  return {
    companyId: requireString(input.companyId, 'companyId', { max: 128 }),
    jobId: requireString(input.jobId, 'jobId', { max: 128 }),
    planId: requireString(input.planId, 'planId', { max: 128 }),
    sendAuthorized: true,
    confirmedByUser: true,
  };
}

function normalizeMokaCancel(input) {
  assertOnlyKeys(input, ['companyId', 'reason']);
  return {
    companyId: requiredOptionalId(input.companyId),
    reason: optionalString(input.reason, '停止原因', { max: 500, preserve: true }),
  };
}

function requiredOptionalId(value) {
  if (value === undefined || value === null || value === '') return null;
  return requireString(value, 'companyId', { max: 128 });
}

async function runMokaOpen(ctx, input) {
  const started = await ctx.moka.startOpen(input);
  return { result: { ...started, note: '后台启动独立受控 Chrome 窗口；面板可低频轮询状态。' }, changed: false };
}

async function runMokaResearch(ctx, input) {
  const started = await ctx.moka.startResearch(input);
  return { result: { ...started, note: '后台检索已启动；未授权时不会调用模型。' }, changed: false };
}

async function runMokaPrepareFill(ctx, input) {
  const started = await ctx.moka.startPrepare(input);
  return { result: { ...started, note: '后台准备计划已启动；计划仅缓存于本服务内存。' }, changed: false };
}

async function runMokaRunFill(ctx, input) {
  const plan = ctx.moka.confirmPlan(input.planId, input.confirmedByUser);
  if (!plan || plan.used) throw serviceError(409, 'PLAN_STALE', '计划不存在、已过期或已执行；请重新准备。');
  const started = await ctx.moka.startRun({ ...input, positionId: input.jobId });
  return { result: { ...started, planId: input.planId, note: '已按本人确认的计划启动填写、实际读回与独立复核；不会提交。' }, changed: false };
}

async function runMokaCancel(ctx, input) {
  const result = await ctx.moka.cancel(input.reason);
  return {
    result: { ...result, note: '已停止后台操作或关闭受控窗口；不会重放未知动作。' },
    changed: false,
  };
}

function normalizeAcknowledgeRecovery(input) {
  assertOnlyKeys(input, ['confirmedByUser', 'observedAt']);
  requireUserConfirmation(input, '确认恢复后已观察现场');
  const observedAt = input.observedAt === undefined
    ? ''
    : requireString(input.observedAt, 'observedAt', { max: 80 });
  if (observedAt && Number.isNaN(Date.parse(observedAt))) {
    throw serviceError(400, 'INVALID_FIELD', 'observedAt 必须是有效日期时间。', { field: 'observedAt' });
  }
  return { observedAt };
}

async function runAcknowledgeRecovery(ctx, input, deps) {
  const result = await deps.invoke(ctx, 'acknowledge_recovery', {
    ...(input.observedAt ? { observedAt: input.observedAt } : {}),
    confirmedBy: 'user',
  });
  return {
    result: {
      recoveryPending: false,
      idempotent: result.idempotent === true,
      note: '仅确认本次进程已重新观察现场；不重放页面填写、上传或提交。',
    },
    changed: result.idempotent !== true,
  };
}

function normalizeManualCandidates(input) {
  assertOnlyKeys(input, ['companyId', 'positions', 'jobs', 'source', 'confirmedByUser']);
  requireUserConfirmation(input, '录入本人核查的岗位证据');
  const companyId = requireString(input.companyId, 'companyId', { max: 128 });
  const rawPositions = input.positions ?? input.jobs;
  if (!Array.isArray(rawPositions) || rawPositions.length < 1 || rawPositions.length > 3) {
    throw serviceError(400, 'INVALID_POSITION', '本人手动录入的岗位候选必须是 1～3 项数组。');
  }
  const seen = new Set();
  const positions = rawPositions.map((raw, index) => {
    assertOnlyKeys(raw, ['officialId', 'jobId', 'title', 'name', 'city', 'officialUrl', 'sourceUrl', 'url', 'checkedAt', 'matchEvidence', 'evidence'], `positions[${index}]`);
    const officialId = requireString(raw.officialId ?? raw.jobId, `positions[${index}].officialId`, { max: 200 });
    if (seen.has(officialId)) {
      throw serviceError(400, 'INVALID_POSITION', '同一批岗位候选的官方岗位 ID 不能重复。');
    }
    seen.add(officialId);
    const title = requireString(raw.title ?? raw.name, `positions[${index}].title`, { max: 300 });
    const sourceUrl = requireString(raw.officialUrl ?? raw.sourceUrl ?? raw.url, `positions[${index}].sourceUrl`, { max: 2000 });
    if (!safeHttpUrl(sourceUrl)) {
      throw serviceError(400, 'INVALID_URL', `positions[${index}].sourceUrl 必须是 http(s) 地址。`);
    }
    const matchEvidence = requireString(raw.matchEvidence ?? raw.evidence, `positions[${index}].matchEvidence`, { max: 2000, preserve: true });
    if (!matchEvidence.trim()) {
      throw serviceError(400, 'INVALID_POSITION', '岗位候选必须附本人核查的匹配证据。');
    }
    const checkedAt = raw.checkedAt === undefined
      ? ''
      : requireString(raw.checkedAt, `positions[${index}].checkedAt`, { max: 80 });
    if (checkedAt && Number.isNaN(Date.parse(checkedAt))) {
      throw serviceError(400, 'INVALID_FIELD', `positions[${index}].checkedAt 必须是有效日期时间。`);
    }
    return {
      officialId,
      title,
      city: optionalString(raw.city, `positions[${index}].city`, { max: 100 }),
      sourceUrl,
      checkedAt,
      matchEvidence,
    };
  });
  return { companyId, positions };
}

async function runRecordCandidates(ctx, input, deps) {
  const positions = input.positions.map((position) => ({
    officialId: position.officialId,
    title: position.title,
    city: position.city,
    sourceUrl: position.sourceUrl,
    checkedAt: position.checkedAt || deps.now(),
    matchEvidence: position.matchEvidence,
  }));
  const result = await deps.invoke(ctx, 'record_position_candidates', {
    companyId: input.companyId,
    eventId: deps.newId(),
    positions,
  });
  return {
    result: {
      company: result.company,
      positions: result.positions,
      queue: result.queue,
      evidenceSource: 'user_manual_entry',
      note: '本人手动录入的岗位证据；不是自动检索，也不代表官网已核验。',
    },
    changed: true,
  };
}

function normalizeNoPositions(input) {
  assertOnlyKeys(input, [
    'companyId',
    'evidence',
    'confirmedByUser',
    'reason',
    'sourceUrl',
    'evidenceUrl',
    'checkedAt',
    'resultText',
  ]);
  requireUserConfirmation(input, '录入本人核查的无合适岗位证据');
  const companyId = requireString(input.companyId, 'companyId', { max: 128 });
  let rawEvidence = null;
  if (isPlainObject(input.evidence)) {
    assertOnlyKeys(input.evidence, ['reason', 'sourceUrl', 'checkedAt', 'resultText'], 'evidence');
    rawEvidence = input.evidence;
  } else if (input.evidence !== undefined && input.evidence !== null && typeof input.evidence !== 'string') {
    throw serviceError(400, 'INVALID_EVIDENCE', 'evidence 必须是对象。');
  }
  if (rawEvidence && (input.reason !== undefined || input.sourceUrl !== undefined
    || input.evidenceUrl !== undefined || input.checkedAt !== undefined || input.resultText !== undefined)) {
    throw serviceError(400, 'INVALID_EVIDENCE', 'evidence 对象和扁平证据字段不能同时提供。');
  }
  const reason = requireString(rawEvidence?.reason ?? input.reason, '无合适岗位原因', { max: 500, preserve: true });
  if (!reason.trim()) {
    throw serviceError(400, 'INVALID_EVIDENCE', '无合适岗位原因不能只有空白。');
  }
  const sourceUrl = requireString(rawEvidence?.sourceUrl ?? input.sourceUrl ?? input.evidenceUrl, '来源链接', { max: 2000 });
  if (!safeHttpUrl(sourceUrl)) {
    throw serviceError(400, 'INVALID_URL', '来源链接必须是 http(s) 地址。');
  }
  const resultText = requireString(
    rawEvidence?.resultText ?? input.resultText ?? (typeof input.evidence === 'string' ? input.evidence : undefined),
    '检索结果证据',
    { max: 2000, preserve: true },
  );
  if (!resultText.trim()) {
    throw serviceError(400, 'INVALID_EVIDENCE', '检索结果证据不能只有空白。');
  }
  const checkedAt = rawEvidence?.checkedAt ?? input.checkedAt;
  const normalizedCheckedAt = checkedAt === undefined || checkedAt === null || checkedAt === ''
    ? ''
    : requireString(checkedAt, 'checkedAt', { max: 80 });
  if (normalizedCheckedAt && Number.isNaN(Date.parse(normalizedCheckedAt))) {
    throw serviceError(400, 'INVALID_FIELD', 'checkedAt 必须是有效日期时间。');
  }
  return { companyId, reason, sourceUrl, resultText, checkedAt: normalizedCheckedAt };
}

async function runRecordNoPositions(ctx, input, deps) {
  const result = await deps.invoke(ctx, 'record_no_positions', {
    companyId: input.companyId,
    eventId: deps.newId(),
    evidence: {
      reason: input.reason,
      sourceUrl: input.sourceUrl,
      checkedAt: input.checkedAt || deps.now(),
      checkedBy: 'user',
      resultText: input.resultText,
    },
  });
  return {
    result: {
      company: result.company,
      queue: result.queue,
      evidenceSource: 'user_manual_entry',
      note: '本人手动记录无合适岗位证据；不是自动检索结论。',
    },
    changed: true,
  };
}

const COMMAND_ENTRIES = [];
function defineCommand(name, canonical, normalize, run, options = {}) {
  COMMAND_ENTRIES.push([name, Object.freeze({
    name,
    canonical,
    normalize,
    run,
    background: options.background === true,
  })]);
}

defineCommand('user.enqueue', 'enqueue', normalizeEnqueue, runEnqueue);
defineCommand('user.start', 'start', normalizeStart, runStart);
defineCommand('user.pause', 'pause', normalizePause, runPause);
defineCommand('user.resume', 'resume', normalizeResume, runResume);
defineCommand('user.prioritizeCompany', 'prioritizeCompany', normalizePrioritizeCompany, runPrioritizeCompany);
defineCommand('user.confirmLogin', 'confirmLogin', normalizeConfirmLogin, runConfirmLogin);
defineCommand('user.selectJobs', 'selectJobs', normalizeSelectJobs, runSelectJobs);
defineCommand('user.reportSubmitted', 'reportSubmitted', normalizeReportSubmitted, runReportSubmitted);
defineCommand('user.reportHistoricalSubmission', 'reportHistoricalSubmission', normalizeHistoricalSubmission, runHistoricalSubmission);
defineCommand('user.markReady', 'markReady', normalizeMarkReady, runMarkReady);
defineCommand('user.deferCompany', 'deferCompany', normalizeDeferCompany, runDeferCompany);
defineCommand('user.resumeCompany', 'resumeCompany', normalizeResumeCompany, runResumeCompany);
defineCommand('user.skipCompany', 'skipCompany', normalizeSkipCompany, runSkipCompany);
defineCommand('user.skipJob', 'skipJob', normalizeSkipJob, runSkipJob);
defineCommand('user.resolveIssue', 'resolveIssue', normalizeResolveIssue, runResolveIssue);
defineCommand('user.importFacts', 'importFacts', normalizeImportFacts, runImportFacts);
defineCommand('user.confirmFact', 'confirmFact', normalizeConfirmFact, runConfirmFact);
defineCommand('user.reviseFact', 'reviseFact', normalizeReviseFact, runReviseFact);
defineCommand('user.saveModels', 'saveModels', normalizeSaveModels, runSaveModels);
defineCommand('user.recordCandidates', 'recordCandidates', normalizeManualCandidates, runRecordCandidates);
defineCommand('user.recordNoPositions', 'recordNoPositions', normalizeNoPositions, runRecordNoPositions);
defineCommand('user.acknowledgeRecovery', 'acknowledgeRecovery', normalizeAcknowledgeRecovery, runAcknowledgeRecovery);
defineCommand('user.mokaOpen', 'mokaOpen', normalizeMokaOpen, runMokaOpen, { background: true });
defineCommand('user.mokaResearch', 'mokaResearch', normalizeMokaResearch, runMokaResearch, { background: true });
defineCommand('user.mokaPrepareFill', 'mokaPrepareFill', normalizeMokaPrepareFill, runMokaPrepareFill, { background: true });
defineCommand('user.mokaRunFill', 'mokaRunFill', normalizeMokaRunFill, runMokaRunFill, { background: true });
defineCommand('user.mokaCancel', 'mokaCancel', normalizeMokaCancel, runMokaCancel, { background: false });

// Compatibility aliases for panel/contract work in progress. They are still
// user.* commands, never agent.* and never accept an actor field.
defineCommand('user.addJobCandidates', 'recordCandidates', normalizeManualCandidates, runRecordCandidates);
defineCommand('user.addJobs', 'recordCandidates', normalizeManualCandidates, runRecordCandidates);
defineCommand('user.reportNoPositions', 'recordNoPositions', normalizeNoPositions, runRecordNoPositions);
defineCommand('user.noSuitableJobs', 'recordNoPositions', normalizeNoPositions, runRecordNoPositions);
defineCommand('user.confirmObservation', 'acknowledgeRecovery', normalizeAcknowledgeRecovery, runAcknowledgeRecovery);

export const COMMAND_MAP = Object.freeze(Object.fromEntries(COMMAND_ENTRIES));
export const SUPPORTED_COMMANDS = Object.freeze(Object.keys(COMMAND_MAP));

/** Extensible command mapping. Unknown/agent commands return null. */
export function mapCommand(command) {
  if (typeof command !== 'string') return null;
  return COMMAND_MAP[command] || null;
}

function statusForErrorCode(code) {
  if (code === 'FORBIDDEN' || code === 'TOOL_FORBIDDEN' || code === 'UI_COMMAND_ONLY'
    || code === 'PROJECT_NOT_ALLOWED') return 403;
  if (code === 'METHOD_NOT_ALLOWED') return 405;
  if (code === 'BODY_TOO_LARGE') return 413;
  if (code === 'UNAUTHORIZED') return 401;
  if (typeof code === 'string' && code.includes('NOT_FOUND')) return 404;
  if ([
    'REVISION_CONFLICT',
    'VERSION_CONFLICT',
    'PROFILE_VERSION_CONFLICT',
    'PROJECT_LOCKED',
    'EVENT_ID_REUSED',
    'EVENT_ID_PAYLOAD_MISMATCH',
    'DUPLICATE_FACT',
    'DUPLICATE_POSITION',
    'DUPLICATE_APPLICATION',
    'QUEUE_ALREADY_RUNNING',
    'QUEUE_PAUSED',
    'QUEUE_NOT_RUNNING',
    'QUEUE_NOT_PAUSED',
    'QUEUE_BUSY',
    'NOT_ACTIVE_COMPANY',
    'NOT_ACTIVE_POSITION',
    'NOT_AWAITING_LOGIN',
    'NOT_AWAITING_SELECTION',
    'NOT_RESEARCHING',
    'NOT_READY_FOR_SUBMIT',
    'NOT_SUBMITTED',
    'NOT_HELD',
    'POSITION_NOT_SELECTABLE',
    'POSITION_NOT_SKIPPABLE',
    'POSITION_NOT_PREPARING',
    'BLOCKING_ISSUES',
    'ALREADY_SUBMITTED',
    'HISTORICAL_SUBMISSION_NOT_ALLOWED',
    'ALREADY_VERIFIED',
    'COMPANY_TERMINAL',
    'COMPANY_HAS_SUBMISSIONS',
    'ISSUE_RESOLVED',
    'RECOVERY_OBSERVATION_REQUIRED',
    'WRONG_COMPANY_STAGE',
  ].includes(code)) return 409;
  if (typeof code === 'string' && (code.startsWith('ILLEGAL_') || code.startsWith('USE_CURRENT_SCOPE'))) return 409;
  if (code === 'CORRUPT_FILE' || code === 'CORRUPT_SERVICE_FILE' || code === 'UNSAFE_DATA_FILE') return 500;
  if (code === 'PRIVATE_ROOT_MISSING' || code === 'PRIVATE_DIR_REQUIRED'
    || code === 'PRIVATE_DIR_TOO_BROAD' || code === 'PATH_TRAVERSAL'
    || code === 'PATH_SYMLINK' || code === 'PATH_NOT_DIRECTORY' || code === 'PATH_NOT_FILE'
    || code === 'UNSAFE_PROJECT_LAYOUT') return 400;
  return 400;
}

function toHttpError(error) {
  if (error instanceof ServiceError) return error;
  if (error instanceof ValidationError || error instanceof WorkflowError || error instanceof ToolError) {
    const code = typeof error.code === 'string' ? error.code : 'INVALID_INPUT';
    return new ServiceError(statusForErrorCode(code), code, error.message || '请求未通过校验。');
  }
  if (error && typeof error.code === 'string') {
    const status = statusForErrorCode(error.code);
    if (status !== 400 || ['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes(error.code)) {
      return new ServiceError(status, error.code === 'ENOENT' ? 'INTERNAL_ERROR' : error.code,
        status >= 500 ? '本地服务处理失败；可能未写入完成状态。' : '本地文件或目录无法安全访问。');
    }
  }
  return new ServiceError(500, 'INTERNAL_ERROR', '本地服务处理失败；未返回请求内容。');
}

function parseBearerToken(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  return match[1];
}

function tokenHash(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function isAuthorized(req, expectedHash) {
  const supplied = parseBearerToken(req.headers.authorization);
  const suppliedHash = tokenHash(supplied === null ? '' : supplied);
  return supplied !== null && timingSafeEqual(expectedHash, suppliedHash);
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, error) {
  const normalized = toHttpError(error);
  const payload = {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
    },
  };
  if (normalized.details && isPlainObject(normalized.details)) payload.error.details = normalized.details;
  const headers = {};
  if (normalized.status === 401) {
    headers['WWW-Authenticate'] = 'Bearer realm="application-copilot"';
  }
  sendJson(res, normalized.status, payload, headers);
}

function drainRequest(req) {
  try {
    req.resume();
  } catch {
    // Ignore; the socket is closed by the runtime.
  }
}

function assertNoBody(req) {
  if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) > 0) {
    throw serviceError(400, 'BODY_NOT_ALLOWED', '该接口不接受请求体。');
  }
}

function assertNoQuery(url) {
  if ([...url.searchParams.keys()].length > 0) {
    throw serviceError(400, 'UNKNOWN_QUERY', '该接口不接受查询参数。');
  }
}

function assertMethod(req, method) {
  if (req.method !== method) {
    throw serviceError(405, 'METHOD_NOT_ALLOWED', `该接口只接受 ${method}。`);
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const contentLength = req.headers['content-length'];
    if (contentLength !== undefined) {
      const parsed = Number(contentLength);
      if (!Number.isFinite(parsed) || parsed < 0) {
        reject(serviceError(400, 'INVALID_CONTENT_LENGTH', '请求体长度无效。'));
        return;
      }
      if (parsed > MAX_BODY_BYTES) {
        drainRequest(req);
        reject(serviceError(413, 'BODY_TOO_LARGE', STREAM_LIMIT_MESSAGE));
        return;
      }
    }
    let total = 0;
    let oversized = false;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      if (!oversized) chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversized) {
        reject(serviceError(413, 'BODY_TOO_LARGE', STREAM_LIMIT_MESSAGE));
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        reject(serviceError(400, 'BODY_REQUIRED', 'POST 请求需要 JSON 对象。'));
        return;
      }
      try {
        const value = JSON.parse(text);
        if (!isPlainObject(value)) {
          reject(serviceError(400, 'INVALID_JSON', '请求体必须是 JSON 对象。'));
          return;
        }
        resolve(value);
      } catch {
        reject(serviceError(400, 'INVALID_JSON', '请求体不是有效 JSON。'));
      }
    });
    req.on('error', () => {
      reject(serviceError(400, 'REQUEST_READ_ERROR', '请求体读取失败。'));
    });
  });
}

function validateCommandEnvelope(body) {
  assertOnlyKeys(body, ['directory', 'command', 'input', 'expectedRevision'], '请求体');
  const directory = requireString(body.directory, 'directory', { max: MAX_DIRECTORY_LENGTH });
  const command = requireString(body.command, 'command', { max: 120 });
  if (body.input !== undefined && !isPlainObject(body.input)) {
    throw serviceError(400, 'INVALID_INPUT', 'input 必须是对象。');
  }
  return {
    directory,
    command,
    input: body.input === undefined ? {} : body.input,
    expectedRevision: normalizeExpectedRevision(body.expectedRevision),
  };
}

export function createServiceServer(options = {}) {
  if (typeof options.token !== 'string' || options.token.trim().length === 0) {
    throw serviceError(400, 'TOKEN_REQUIRED', '缺少 OPENCHAMBER_SERVICE_TOKEN，拒绝启动。');
  }
  const token = options.token;
  const expectedHash = tokenHash(token);
  const requestedPort = options.port === undefined ? 0 : options.port;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw serviceError(400, 'INVALID_PORT', 'OPENCHAMBER_SERVICE_PORT 必须是 1～65535 的整数。');
  }
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const newId = typeof options.newId === 'function' ? options.newId : () => randomUUID();
  const rawRoots = options.projectRoots ?? (options.projectRoot ? [options.projectRoot] : null);
  if (rawRoots !== null && !Array.isArray(rawRoots)) {
    throw serviceError(400, 'INVALID_PROJECT_ROOTS', 'projectRoots 必须是数组。');
  }
  const projectRootInputs = rawRoots ? rawRoots.map((root) => {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      throw serviceError(400, 'INVALID_PROJECT_ROOTS', '测试项目根目录必须是绝对路径。');
    }
    return root;
  }) : null;

  const contexts = new Map();
  let allowedRoots = null;
  let server = null;
  let started = false;
  let stopping = null;
  const signalHandlers = [];

  async function getContext(directory) {
    const projectPath = await resolveProjectDirectory(directory, allowedRoots);
    const key = projectKey(projectPath);
    let ctx = contexts.get(key);
    if (!ctx) {
      const privateRoot = path.join(projectPath, 'private');
      const appRoot = path.join(privateRoot, 'application-copilot');
      const core = createWorkbenchService({
        directory: path.join(appRoot, 'runtime'),
        privateRoot,
        now,
        newId,
      });
      const registry = createToolRegistry(core, { access: 'operator' });
      ctx = {
        projectPath,
        privateRoot,
        appRoot,
        runtimeDirectory: path.join(appRoot, 'runtime'),
        modelsFile: path.join(appRoot, 'models.json'),
        metaFile: path.join(appRoot, 'service-meta.json'),
        lockFile: path.join(appRoot, '.service.lock'),
        lockId: newId(),
        lockHeld: false,
        core,
        registry,
        tail: Promise.resolve(),
        mokaCredentials: createMemoryCredentialStore(),
        moka: null,
      };
      ctx.moka = createMokaWorkflow({
        projectPath,
        core,
        registry,
        credentialStore: ctx.mokaCredentials,
        getRoles: async () => (await readModelsDocument(ctx)).roles,
        now,
        newId,
        fetchImpl: options.fetchImpl,
        driverFactory: options.mokaDriverFactory || null,
        routerFactory: options.mokaRouterFactory,
        onChanged: async () => {
          await enqueueProjectTask(ctx, async () => {
            const current = await currentRevision(ctx);
            await bumpRevision(ctx, current.revision);
          });
        },
      });
      contexts.set(key, ctx);
    }
    return ctx;
  }

  async function getState(directory) {
    const ctx = await getContext(directory);
    return enqueueProjectTask(ctx, async () => {
      const layout = await validateProjectLayout(ctx.projectPath, { create: false });
      let summary = null;
      let revision = 0;
      if (layout.privateExists) {
        const current = await currentRevision(ctx);
        summary = current.summary;
        revision = current.revision;
      }
      return buildState(ctx, { revision, summary, layout });
    });
  }

  async function getSessionInbox(directory) {
    const ctx = await getContext(directory);
    return enqueueProjectTask(ctx, async () => {
      try {
        await validateProjectLayout(ctx.projectPath, { create: false });
        return await readSessionInbox(ctx.appRoot);
      } catch (error) {
        if (error instanceof SessionInboxError) {
          throw sessionInboxServiceError(error, 500);
        }
        throw error;
      }
    });
  }

  async function appendSessionInbox(directory, text, targetSessionId = null) {
    const ctx = await getContext(directory);
    return enqueueProjectTask(ctx, async () => {
      try {
        await validateProjectLayout(ctx.projectPath, { create: true });
        const message = await appendSessionMessage(ctx.appRoot, text, { now, newId, targetSessionId });
        return { message };
      } catch (error) {
        if (error instanceof SessionInboxError) {
          throw sessionInboxServiceError(error, 400);
        }
        throw error;
      }
    });
  }

  async function acknowledgeSessionInbox(directory, messageIds) {
    const ctx = await getContext(directory);
    return enqueueProjectTask(ctx, async () => {
      try {
        await validateProjectLayout(ctx.projectPath, { create: true });
        return await acknowledgeSessionMessages(ctx.appRoot, messageIds);
      } catch (error) {
        if (error instanceof SessionInboxError) {
          throw sessionInboxServiceError(error, 400);
        }
        throw error;
      }
    });
  }

  async function updateSessionInboxState(directory, messageIds, state) {
    const ctx = await getContext(directory);
    return enqueueProjectTask(ctx, async () => {
      try {
        await validateProjectLayout(ctx.projectPath, { create: true });
        return await updateSessionMessageStates(ctx.appRoot, messageIds, state);
      } catch (error) {
        if (error instanceof SessionInboxError) {
          throw sessionInboxServiceError(error, 400);
        }
        throw error;
      }
    });
  }

  async function runCommand(envelope) {
    const info = mapCommand(envelope.command);
    if (!info) {
      if (envelope.command.startsWith('agent.')) {
        throw serviceError(403, 'UI_COMMAND_ONLY', '面板只能发送 user.* 命令；agent.* 不能通过此入口升级。');
      }
      throw serviceError(400, 'UNKNOWN_COMMAND', `未知命令：${envelope.command}。`);
    }
    // Validate input before creating directories or taking the project lock.
    const normalizedInput = info.normalize(envelope.input);
    const ctx = await getContext(envelope.directory);
    return enqueueProjectTask(ctx, async () => {
      await validateProjectLayout(ctx.projectPath, { create: true });
      await acquireProjectLock(ctx);
      const current = await currentRevision(ctx);
      if (envelope.expectedRevision !== undefined && envelope.expectedRevision !== current.revision) {
        throw serviceError(
          409,
          'REVISION_CONFLICT',
          '状态已被更新；请刷新后由本人重新核对，未覆盖新数据。',
          { currentRevision: current.revision },
        );
      }
      const outcome = await info.run(ctx, normalizedInput, {
        now,
        newId,
        invoke: (target, name, input) => target.registry.invoke(name, input),
      });
      if (info.background === true) {
        // 长任务已转后台；状态读取不等待模型/浏览器调用，返回持久摘要的入口。
        const state = await buildState(ctx, { revision: current.revision });
        return { revision: current.revision, state, result: outcome.result || {} };
      }
      const changed = outcome.changed !== false && outcome.result?.idempotent !== true;
      const revision = changed ? await bumpRevision(ctx, current.revision) : current.revision;
      const state = await buildState(ctx, { revision });
      return { revision, state, result: outcome.result || {} };
    });
  }

  async function handleRequest(req, res) {
    try {
      if (!isAuthorized(req, expectedHash)) {
        drainRequest(req);
        throw serviceError(401, 'UNAUTHORIZED', '缺少或无效的本地服务凭据。');
      }
      let url;
      try {
        url = new URL(req.url || '/', 'http://127.0.0.1');
      } catch {
        throw serviceError(400, 'INVALID_PATH', '请求路径无效。');
      }
      const pathname = url.pathname;

      if (pathname === '/health') {
        assertMethod(req, 'GET');
        assertNoQuery(url);
        assertNoBody(req);
        sendJson(res, 200, { ok: true, status: 'ready' });
        return;
      }

      if (pathname === '/api/capabilities') {
        assertMethod(req, 'GET');
        assertNoQuery(url);
        assertNoBody(req);
        sendJson(res, 200, { ok: true, capabilities: buildCapabilities() });
        return;
      }

      if (pathname === '/api/session-inbox') {
        if (req.method === 'GET') {
          assertNoBody(req);
          const keys = [...url.searchParams.keys()];
          if (keys.length !== 1 || keys[0] !== 'directory') {
            throw serviceError(400, 'UNKNOWN_QUERY', 'session-inbox 接口只接受一个 directory 查询参数。');
          }
          const directory = url.searchParams.get('directory');
          if (!directory) throw serviceError(400, 'INVALID_DIRECTORY', '缺少 directory 查询参数。');
          const messages = await getSessionInbox(directory);
          sendJson(res, 200, { ok: true, messages });
          return;
        }
        if (req.method === 'POST') {
          assertNoQuery(url);
          const body = await readJsonBody(req);
        assertOnlyKeys(body, ['directory', 'text', 'targetSessionId'], '请求体');
        const directory = requireString(body.directory, 'directory', { max: MAX_DIRECTORY_LENGTH });
        const text = requireString(body.text, 'text', { max: 16000, preserve: true });
        const targetSessionId = optionalString(body.targetSessionId, 'targetSessionId', { max: 128 });
        const result = await appendSessionInbox(directory, text, targetSessionId || null);
          sendJson(res, 200, { ok: true, ...result });
          return;
        }
        throw serviceError(405, 'METHOD_NOT_ALLOWED', 'session-inbox 接口只接受 GET 或 POST。');
      }

      if (pathname === '/api/session-inbox/ack') {
        assertMethod(req, 'POST');
        assertNoQuery(url);
        const body = await readJsonBody(req);
        assertOnlyKeys(body, ['directory', 'messageIds'], '请求体');
        const directory = requireString(body.directory, 'directory', { max: MAX_DIRECTORY_LENGTH });
        if (!Array.isArray(body.messageIds)) {
          throw serviceError(400, 'INVALID_SESSION_MESSAGE_IDS', 'messageIds 必须是数组。');
        }
        const result = await acknowledgeSessionInbox(directory, body.messageIds);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (pathname === '/api/session-inbox/state') {
        assertMethod(req, 'POST');
        assertNoQuery(url);
        const body = await readJsonBody(req);
        assertOnlyKeys(body, ['directory', 'messageIds', 'state'], '请求体');
        const directory = requireString(body.directory, 'directory', { max: MAX_DIRECTORY_LENGTH });
        if (!Array.isArray(body.messageIds)) {
          throw serviceError(400, 'INVALID_SESSION_MESSAGE_IDS', 'messageIds 必须是数组。');
        }
        const state = requireString(body.state, 'state', { max: 40 });
        const result = await updateSessionInboxState(directory, body.messageIds, state);
        sendJson(res, 200, { ok: true, updated: result.updated });
        return;
      }

      if (pathname === '/api/state') {
        assertMethod(req, 'GET');
        assertNoBody(req);
        const keys = [...url.searchParams.keys()];
        if (keys.length !== 1 || keys[0] !== 'directory') {
          throw serviceError(400, 'UNKNOWN_QUERY', 'state 接口只接受一个 directory 查询参数。');
        }
        const directory = url.searchParams.get('directory');
        if (!directory) {
          throw serviceError(400, 'INVALID_DIRECTORY', '缺少 directory 查询参数。');
        }
        const state = await getState(directory);
        sendJson(res, 200, { ok: true, revision: state.revision, state });
        return;
      }

      if (pathname === '/api/command') {
        assertMethod(req, 'POST');
        assertNoQuery(url);
        const body = await readJsonBody(req);
        const envelope = validateCommandEnvelope(body);
        const result = await runCommand(envelope);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      throw serviceError(404, 'NOT_FOUND', '未知的本地服务路径。');
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(res, error);
    }
  }

  function installSignals() {
    if (signalHandlers.length > 0) return;
    const shutdown = () => {
      void stop().finally(() => {
        process.exit(0);
      });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    signalHandlers.push(['SIGTERM', shutdown], ['SIGINT', shutdown]);
  }

  function removeSignals() {
    for (const [signal, handler] of signalHandlers.splice(0)) {
      process.removeListener(signal, handler);
    }
  }

  async function start() {
    if (started) {
      return { host: '127.0.0.1', port: server.address().port };
    }
    if (stopping) throw serviceError(409, 'SERVICE_STOPPING', '服务正在关闭。');
    if (projectRootInputs) {
      allowedRoots = [];
      for (const root of projectRootInputs) {
        const stat = await fs.stat(root).catch(() => null);
        if (!stat || !stat.isDirectory()) {
          throw serviceError(400, 'INVALID_PROJECT_ROOTS', '测试项目根目录不存在或不是目录。');
        }
        allowedRoots.push(await fs.realpath(root));
      }
    }
    server = http.createServer((req, res) => {
      void handleRequest(req, res);
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.on('clientError', (error, socket) => {
      if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      }
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(requestedPort, '127.0.0.1');
    });
    started = true;
    if (options.handleSignals === true) installSignals();
    return { host: '127.0.0.1', port: server.address().port };
  }

  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      removeSignals();
      const activeContexts = [...contexts.values()];
      await Promise.allSettled(activeContexts.map((ctx) => ctx.moka?.stop()));
      let closePromise = Promise.resolve();
      if (server) {
        closePromise = new Promise((resolve) => {
          server.close(() => resolve());
        });
      }
      await Promise.allSettled(activeContexts.map((ctx) => ctx.tail));
      if (server) {
        try {
          server.closeAllConnections?.();
        } catch {
          // Node versions without closeAllConnections still resolve close() for
          // idle keep-alive sockets on supported runtimes.
        }
        await Promise.race([
          closePromise,
          new Promise((resolve) => {
            const timer = setTimeout(resolve, 2_000);
            timer.unref?.();
          }),
        ]);
      }
      for (const ctx of activeContexts) {
        await releaseProjectLock(ctx).catch(() => {});
      }
      contexts.clear();
      started = false;
      server = null;
    })();
    return stopping;
  }

  return {
    start,
    stop,
    get port() {
      return server && server.address() ? server.address().port : null;
    },
    get host() {
      return '127.0.0.1';
    },
  };
}

async function startFromEnvironment() {
  const portText = process.env.OPENCHAMBER_SERVICE_PORT;
  const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
  if (typeof token !== 'string' || token.trim().length === 0) {
    console.error('Application Copilot service refused to start: OPENCHAMBER_SERVICE_TOKEN is required.');
    process.exitCode = 1;
    return;
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('Application Copilot service refused to start: OPENCHAMBER_SERVICE_PORT is invalid.');
    process.exitCode = 1;
    return;
  }
  const app = createServiceServer({ token, port, handleSignals: true });
  await app.start();
}

const isDirectRun = Boolean(process.argv[1])
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  startFromEnvironment().catch((error) => {
    const code = error && typeof error.code === 'string' ? error.code : 'START_FAILED';
    console.error(`Application Copilot service failed to start (${code}).`);
    process.exitCode = 1;
  });
}
