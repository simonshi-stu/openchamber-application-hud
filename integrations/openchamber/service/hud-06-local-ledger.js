// HUD-06 local application ledger. This is a synthetic loopback harness over
// the existing HUD-05 visible preparation flow. It records local result
// reports only; it has no real-site, upload, or submission path.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, PRIVATE_ROOT } from '../../../core/store.js';
import {
  APPLICATION_LEDGER_STATUS,
  createApplicationLedger,
  ApplicationLedgerError,
} from '../../../core/application-ledger.js';
import {
  createHud05InteractiveSession,
} from './hud-05-interactive.js';

export const HUD_06_LOCAL_LEDGER_SCHEMA_VERSION = 'application-copilot.hud-06.local-ledger.v1';
export const HUD_06_LOCAL_LEDGER_MARKER = 'HUD-06-LOCAL-APPLICATION-LEDGER';
export const HUD_06_DEFAULT_REPORT_PATH = path.join(
  PROJECT_ROOT,
  'private',
  'application-copilot',
  'hud-06-local-ledger-report.md',
);

const OPERATOR = Object.freeze({ actor: 'operator' });
const HUD05_TRIAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'trial', 'hud-05');
const HUD06_TRIAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'trial', 'hud-06');
const STATIC_FILES = Object.freeze({
  '/': 'index.html',
  '/index.html': 'index.html',
  '/styles.css': 'styles.css',
  '/base.js': 'base.js',
  '/ledger.js': 'ledger.js',
});
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ACTION_TEXT = 20_000;

class Hud06Error extends Error {
  constructor(code, message, status = 409, details = null) {
    super(message);
    this.name = 'Hud06Error';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fail(code, message, status = 409, details = null) {
  throw new Hud06Error(code, message, status, details);
}

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function assertPlainObject(value, label = '请求') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', `${label} 必须是对象。`, 400);
  return value;
}

function assertOnlyKeys(value, allowed, label = '请求') {
  assertPlainObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('UNKNOWN_FIELD', `${label} 包含未支持字段：${key}。`, 400);
  }
}

function normalizeText(value, field, { max = MAX_ACTION_TEXT, allowEmpty = false } = {}) {
  if (typeof value !== 'string') fail('INVALID_TEXT', `${field} 必须是字符串。`, 400);
  if ((!allowEmpty && !value.trim()) || value.length > max) {
    fail('INVALID_TEXT', `${field} 不能为空且不能超过 ${max} 个字符。`, 400);
  }
  return value;
}

function parseCookies(header) {
  const result = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let oversized = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        oversized = true;
        chunks.length = 0;
      } else if (!oversized) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (oversized) {
        reject(new Hud06Error('BODY_TOO_LARGE', 'HUD-06 请求体超出本地限制。', 413));
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        reject(new Hud06Error('BODY_REQUIRED', 'HUD-06 POST 请求需要 JSON 对象。', 400));
        return;
      }
      try {
        resolve(assertPlainObject(JSON.parse(raw), '请求体'));
      } catch (error) {
        reject(error instanceof Hud06Error ? error : new Hud06Error('INVALID_JSON', '请求体不是有效 JSON。', 400));
      }
    });
    req.on('error', () => reject(new Hud06Error('REQUEST_READ_ERROR', '本地请求读取失败。', 400)));
  });
}

function commonHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  };
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { ...commonHeaders('application/json; charset=utf-8'), ...extraHeaders });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text, contentType, extraHeaders = {}) {
  res.writeHead(status, { ...commonHeaders(contentType), ...extraHeaders });
  res.end(text);
}

function nowIso() {
  return new Date().toISOString();
}

function currentApplication(ledgerState, baseState) {
  return ledgerState.applications.find((item) => (
    item.companyId === baseState.company?.id && item.positionId === baseState.position?.id
  )) || null;
}

function ledgerActions(application, baseActions, storage) {
  const writable = storage !== 'corrupt';
  const status = application?.status || null;
  return {
    recordSubmissionReport: writable && status === APPLICATION_LEDGER_STATUS.PREPARED_WAITING_HUMAN_SUBMIT,
    recordUnknownResult: writable && [
      APPLICATION_LEDGER_STATUS.PREPARED_WAITING_HUMAN_SUBMIT,
      APPLICATION_LEDGER_STATUS.SUBMITTED_REPORTED,
    ].includes(status),
    recordOfficialVerification: false,
    preparationLocked: [
      APPLICATION_LEDGER_STATUS.SUBMITTED_REPORTED,
      APPLICATION_LEDGER_STATUS.UNKNOWN,
      APPLICATION_LEDGER_STATUS.OFFICIAL_VERIFIED,
    ].includes(status),
    ...baseActions,
  };
}

async function writeReportFile(outputPath, content) {
  if (!outputPath) return null;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    const previous = await fs.readFile(outputPath, 'utf8');
    if (!previous.includes(`# ${HUD_06_LOCAL_LEDGER_MARKER}`)) {
      throw new Error(`拒绝覆盖非 HUD-06 私有报告：${outputPath}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.writeFile(outputPath, content, 'utf8');
  return outputPath;
}

function reportMarkdown({ base, ledger, sandboxPath }) {
  const application = ledger.application;
  const history = application?.history || [];
  const display = (value) => String(value ?? '').replaceAll('\u0000', '\\u0000');
  return [
    `# ${HUD_06_LOCAL_LEDGER_MARKER}`,
    '',
    `- schema: \`${HUD_06_LOCAL_LEDGER_SCHEMA_VERSION}\``,
    '- synthetic: true',
    '- bindAddress: 127.0.0.1 only',
    '- externalNetworkCalls: 0',
    '- realSubmission: false',
    '- realSiteAccess: false',
    '- modelAccess: false',
    `- sandbox: ${sandboxPath}`,
    `- baseStage: ${base.stage}`,
    `- ledgerStorage: ${ledger.storage}`,
    `- ledgerRevision: ${ledger.revision ?? 'unknown'}`,
    `- applicationId: ${application?.applicationId || 'not prepared'}`,
    `- status: ${application?.statusLabel || '尚未产生准备结果'}`,
    '',
    '## 状态语义',
    '',
    '- `prepared_waiting_human_submit`：合成页面真实写入/读回复核通过，仍待本人登录、审核和提交。',
    '- `submitted_reported`：本人手工报告的本地记录，不代表网站动作或官网回执。',
    '- `official_verified`：只有带可信官方 ack、来源版本和结构化官网观测时才允许；合成证据仍标记 synthetic。',
    '- `unknown`：证据缺失、无 ack 或损坏时保留未知，禁止自动升级。',
    '',
    '## 当前台账',
    '',
    application ? [
      `- companyIdentityKey: ${display(application.companyIdentityKey)}`,
      `- companyId: ${display(application.companyId)}`,
      `- batch: ${display(application.companyBatch)}`,
      `- positionId: ${display(application.positionId)}`,
      `- officialId: ${display(application.officialId)}`,
      `- preparedAt: ${display(application.preparedAt)}`,
      `- lastEvidence: ${display(application.lastEvidence.kind)}/${display(application.lastEvidence.source)}`,
      `- acknowledged: ${application.lastEvidence.acknowledged}`,
      `- trustedOfficialObservation: ${application.lastEvidence.trustedOfficialObservation}`,
      `- blockReason: ${display(application.lastEvidence.blockReason || 'none')}`,
      `- materialDigest: ${display(application.currentBinding.materialDigest)}`,
      `- planDigest: ${display(application.currentBinding.planDigest)}`,
      `- sourceVersion: ${display(application.currentBinding.sourceVersion)}`,
      `- historyCount: ${history.length}`,
    ].join('\n') : '- 当前还没有达到准备完成的申请。',
    '',
    '## 安全边界',
    '',
    '- 本地台账不保存完整官网页面、完整真实简历或附件；材料/计划只保存版本标识与摘要。',
    '- 本页面没有登录、验证码、附件上传、最终提交或自动重投入口。',
    '- 任何本人报告、unknown 或无 ack 记录都不会自动变成官网已核验。',
    '- 服务重启只恢复本地台账和核心检查点；不会重放填写或提交。',
    '',
  ].join('\n');
}

export async function createHud06LocalLedgerSession({
  scenario = 'happy',
  sandboxPath = null,
  reportPath = HUD_06_DEFAULT_REPORT_PATH,
  now = nowIso,
} = {}) {
  const base = await createHud05InteractiveSession({ scenario, sandboxPath, reportPath: null });
  const ledger = createApplicationLedger({
    directory: path.join(base.env.sandbox, 'ledger'),
    privateRoot: PRIVATE_ROOT,
    now,
  });
  let closed = false;
  let actionTail = Promise.resolve();
  let lastError = null;

  async function syncPrepared(baseState) {
    const ledgerState = await ledger.snapshot();
    if (ledgerState.storage === 'corrupt') throw new Hud06Error('LEDGER_CORRUPT', ledgerState.error?.message || '申请台账损坏，拒绝继续写入。');
    if (baseState.stage !== 'prepared' || baseState.review?.passed !== true || !baseState.position?.selected || !baseState.plan?.confirmed) {
      return baseState;
    }
    let current = baseState;
    if (current.position.status === 'preparing') {
      await base.env.core.markPositionReadyForSubmit({
        companyId: current.company.id,
        positionId: current.position.id,
        confirmedBy: 'user',
      }, OPERATOR);
      current = await base.getState();
    }
    await ledger.ensurePrepared({
      companyName: current.company.name,
      batch: current.company.batch,
      companyId: current.company.id,
      positionId: current.position.id,
      officialId: current.position.officialId,
      materialBinding: current.material.binding,
      planBinding: current.plan.binding,
      preparedAt: now(),
      reviewPassed: current.review?.passed === true,
      readbackFields: current.review?.readbackFields || 0,
      writeCount: current.actualPage?.writes?.length || 0,
      diffCount: current.review?.programDiffs?.length || 0,
    });
    return current;
  }

  async function snapshot() {
    let baseState = await base.getState();
    try {
      baseState = await syncPrepared(baseState);
      lastError = null;
    } catch (error) {
      lastError = { code: error?.code || 'LEDGER_SYNC_FAILED', message: String(error?.message || '申请台账同步失败。').slice(0, 500) };
    }
    const ledgerState = await ledger.snapshot();
    const application = currentApplication(ledgerState, baseState);
    const state = {
      schemaVersion: HUD_06_LOCAL_LEDGER_SCHEMA_VERSION,
      hud05: baseState,
      ...baseState,
      capabilities: {
        ...baseState.capabilities,
        localApplicationLedger: true,
        automaticResubmission: false,
        trustedOfficialVerificationOnly: true,
      },
      ledger: {
        ...ledgerState,
        application,
        actions: ledgerActions(application, baseState.actions, ledgerState.storage),
      },
      application,
      lastError: lastError || baseState.lastError,
      report: {
        path: reportPath,
        content: reportMarkdown({ base: baseState, ledger: { ...ledgerState, application }, sandboxPath: base.env.sandbox }),
      },
    };
    return state;
  }

  async function requireLedgerWritable() {
    const state = await snapshot();
    if (state.ledger.storage === 'corrupt') fail('LEDGER_CORRUPT', state.ledger.error?.message || '申请台账损坏；拒绝继续动作。');
    return state;
  }

  async function requirePreparationUnlocked() {
    const state = await requireLedgerWritable();
    if (state.application && [
      APPLICATION_LEDGER_STATUS.SUBMITTED_REPORTED,
      APPLICATION_LEDGER_STATUS.UNKNOWN,
      APPLICATION_LEDGER_STATUS.OFFICIAL_VERIFIED,
    ].includes(state.application.status)) {
      fail('APPLICATION_RESULT_LOCKED', '该申请已有本人报告、未知结果或官网核验记录；禁止自动重新填写或提交路径。');
    }
    return state;
  }

  async function recordSubmissionReport(payload) {
    assertOnlyKeys(payload, ['binding', 'expectedLedgerRevision', 'eventId', 'reportedAt', 'reference', 'blockReason', 'confirmedByUser'], 'record_submission_report');
    if (payload.confirmedByUser !== true) fail('CONFIRMATION_REQUIRED', '本人报告必须由本人明确确认。', 400);
    const state = await requireLedgerWritable();
    const application = state.application;
    if (!application) fail('APPLICATION_NOT_PREPARED', '还没有准备完成的申请台账。');
    try {
      return await ledger.recordUserSubmission({
        applicationId: application.applicationId,
        binding: payload.binding,
        expectedRevision: payload.expectedLedgerRevision,
        eventId: payload.eventId || `hud06-user-report-${randomUUID()}`,
        reportedAt: payload.reportedAt || now(),
        reference: typeof payload.reference === 'string' ? payload.reference.slice(0, 500) : '',
        blockReason: payload.blockReason,
        sourceVersion: application.currentBinding.sourceVersion,
        now: now(),
      });
    } catch (error) {
      throw error instanceof ApplicationLedgerError ? error : new Hud06Error(error?.code || 'LEDGER_WRITE_FAILED', error?.message || '申请报告写入失败。');
    }
  }

  async function recordUnknownResult(payload) {
    assertOnlyKeys(payload, ['binding', 'expectedLedgerRevision', 'eventId', 'observedAt', 'blockReason', 'confirmedByUser'], 'record_unknown_result');
    if (payload.confirmedByUser !== true) fail('CONFIRMATION_REQUIRED', '记录未知结果必须由本人明确确认。', 400);
    const state = await requireLedgerWritable();
    const application = state.application;
    if (!application) fail('APPLICATION_NOT_PREPARED', '还没有准备完成的申请台账。');
    try {
      return await ledger.recordUnknown({
        applicationId: application.applicationId,
        binding: payload.binding,
        expectedRevision: payload.expectedLedgerRevision,
        eventId: payload.eventId || `hud06-unknown-${randomUUID()}`,
        observedAt: payload.observedAt || now(),
        blockReason: payload.blockReason,
        sourceVersion: application.currentBinding.sourceVersion,
        now: now(),
      });
    } catch (error) {
      throw error instanceof ApplicationLedgerError ? error : new Hud06Error(error?.code || 'LEDGER_WRITE_FAILED', error?.message || '未知结果写入失败。');
    }
  }

  async function recordOfficialVerification(payload) {
    assertOnlyKeys(payload, ['binding', 'expectedLedgerRevision', 'eventId', 'evidence', 'confirmedByUser'], 'record_official_verification');
    if (payload.confirmedByUser !== true) fail('CONFIRMATION_REQUIRED', '官网核验记录必须由本人明确确认。', 400);
    const state = await requireLedgerWritable();
    const application = state.application;
    if (!application) fail('APPLICATION_NOT_PREPARED', '还没有准备完成的申请台账。');
    try {
      return await ledger.recordOfficialVerification({
        applicationId: application.applicationId,
        binding: payload.binding,
        expectedRevision: payload.expectedLedgerRevision,
        eventId: payload.eventId || `hud06-official-verify-${randomUUID()}`,
        evidence: payload.evidence,
        now: now(),
      });
    } catch (error) {
      throw error instanceof ApplicationLedgerError ? error : new Hud06Error(error?.code || 'LEDGER_WRITE_FAILED', error?.message || '官网核验写入失败。');
    }
  }

  async function dispatch(action, payload) {
    if (typeof action !== 'string' || !action) fail('INVALID_ACTION', '缺少 HUD-06 动作。', 400);
    const body = payload === undefined ? {} : assertPlainObject(payload, `${action}.payload`);
    if (action === 'record_submission_report') return recordSubmissionReport(body);
    if (action === 'record_unknown_result') return recordUnknownResult(body);
    if (action === 'record_official_verification') return recordOfficialVerification(body);
    if (['prepare_plan', 'confirm_plan', 'run_fill'].includes(action)) await requirePreparationUnlocked();
    return base.action(action, body);
  }

  async function action(action, payload = {}) {
    const next = actionTail.catch(() => {}).then(async () => {
      if (closed) fail('TRIAL_CLOSED', 'HUD-06 合成试用已关闭。');
      try {
        const result = await dispatch(action, payload);
        const state = await snapshot();
        await writeReportFile(reportPath, state.report.content);
        if (result && typeof result === 'object' && Object.hasOwn(result, 'ok')) {
          return { ...result, state };
        }
        return { ok: true, result, state };
      } catch (error) {
        const errorBody = {
          code: error?.code || 'HUD06_ACTION_FAILED',
          message: String(error?.message || 'HUD-06 动作失败。').slice(0, 500),
          ...(error?.details ? { details: error.details } : {}),
        };
        const state = await snapshot().catch(() => null);
        if (state) {
          state.lastError = errorBody;
          await writeReportFile(reportPath, state.report.content).catch(() => {});
        }
        return { ok: false, error: errorBody, state };
      }
    });
    actionTail = next.catch(() => {});
    return next;
  }

  async function getState() {
    if (closed) fail('TRIAL_CLOSED', 'HUD-06 合成试用已关闭。');
    return snapshot();
  }

  async function close() {
    if (closed) return;
    closed = true;
    await writeReportFile(reportPath, await snapshot().then((state) => state.report.content)).catch(() => {});
    await base.close();
  }

  try {
    await base.getState();
    const initial = await snapshot();
    await writeReportFile(reportPath, initial.report.content);
  } catch (error) {
    await base.close().catch(() => {});
    throw error;
  }

  return {
    schemaVersion: HUD_06_LOCAL_LEDGER_SCHEMA_VERSION,
    scenario,
    sandboxPath: base.env.sandbox,
    reportPath,
    ledger,
    base,
    getState,
    action,
    close,
  };
}

function requestHost(req) {
  return typeof req.headers.host === 'string' ? req.headers.host : '';
}

function checkHost(req, origin) {
  if (requestHost(req) !== new URL(origin).host) fail('HOST_NOT_ALLOWED', 'HUD-06 只接受绑定的 loopback host。', 403);
}

function requireSession(req, token) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.hud06_sid !== token) fail('UNAUTHORIZED', 'HUD-06 会话未授权。', 401);
  return cookies;
}

function requireMutationBoundary(req, origin, token, csrfToken) {
  checkHost(req, origin);
  const cookies = requireSession(req, token);
  if (req.headers.origin !== origin) fail('ORIGIN_NOT_ALLOWED', 'HUD-06 动作必须来自本地试用页面。', 403);
  const headerToken = req.headers['x-hud06-csrf'] || req.headers['x-hud05-csrf'];
  if (headerToken !== csrfToken || cookies.hud06_csrf !== csrfToken) {
    fail('CSRF_REQUIRED', 'HUD-06 动作缺少本地 CSRF 校验。', 403);
  }
}

async function staticText(fileName) {
  if (fileName === 'styles.css') {
    const [base, extra] = await Promise.all([
      fs.readFile(path.join(HUD05_TRIAL_ROOT, 'styles.css'), 'utf8'),
      fs.readFile(path.join(HUD06_TRIAL_ROOT, 'styles.css'), 'utf8'),
    ]);
    return `${base}\n${extra}`;
  }
  const root = fileName === 'base.js' ? HUD05_TRIAL_ROOT : HUD06_TRIAL_ROOT;
  const actualFileName = fileName === 'base.js' ? 'app.js' : fileName;
  const candidate = path.join(root, actualFileName);
  if (path.dirname(candidate) !== root) throw new Error('HUD-06 static path escaped.');
  return fs.readFile(candidate, 'utf8');
}

export async function createHud06LocalLedgerServer({
  scenario = 'happy',
  sandboxPath = null,
  port = 0,
  reportPath = HUD_06_DEFAULT_REPORT_PATH,
  now = nowIso,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Hud06Error('INVALID_PORT', 'HUD-06 端口无效。', 400);
  const session = await createHud06LocalLedgerSession({ scenario, sandboxPath, reportPath, now });
  const sessionToken = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(24).toString('hex');
  let server = null;
  let origin = null;
  let stopPromise = null;

  async function handle(req, res) {
    try {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      checkHost(req, origin);
      const fileName = STATIC_FILES[parsed.pathname];
      if (req.method === 'GET' && fileName && !parsed.search) {
        if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
          const html = (await staticText(fileName)).replaceAll('__HUD06_CSRF__', csrfToken);
          sendText(res, 200, html, 'text/html; charset=utf-8', {
            'Set-Cookie': [
              `hud06_sid=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/`,
              `hud06_csrf=${encodeURIComponent(csrfToken)}; SameSite=Strict; Path=/`,
            ],
          });
          return;
        }
        const content = await staticText(fileName);
        sendText(res, 200, content, fileName.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
        return;
      }
      if (req.method === 'GET' && parsed.pathname === '/api/state' && !parsed.search) {
        requireSession(req, sessionToken);
        sendJson(res, 200, { ok: true, state: await session.getState() });
        return;
      }
      if (req.method === 'POST' && parsed.pathname === '/api/action' && !parsed.search) {
        requireMutationBoundary(req, origin, sessionToken, csrfToken);
        const body = await readBody(req);
        assertOnlyKeys(body, ['action', 'payload'], '请求体');
        const result = await session.action(body.action, body.payload || {});
        sendJson(res, result.ok ? 200 : 409, result);
        return;
      }
      fail('NOT_FOUND', 'HUD-06 本地路由不存在。', 404);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      sendJson(res, status, {
        ok: false,
        error: {
          code: error?.code || 'INTERNAL_ERROR',
          message: status >= 500 ? 'HUD-06 本地服务处理失败。' : String(error?.message || 'HUD-06 请求失败。').slice(0, 500),
        },
      });
    }
  }

  server = http.createServer((req, res) => { void handle(req, res); });
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
    server.listen(port, '127.0.0.1');
  });
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;

  async function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      await session.close();
      await new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
    })();
    return stopPromise;
  }

  return {
    schemaVersion: HUD_06_LOCAL_LEDGER_SCHEMA_VERSION,
    synthetic: true,
    origin,
    url: `${origin}/`,
    port: address.port,
    scenario,
    sandboxPath: session.sandboxPath,
    reportPath,
    session,
    stop,
  };
}

export { Hud06Error, APPLICATION_LEDGER_STATUS };
