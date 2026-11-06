// HUD-05 interactive offline trial. The server and page are a deliberately
// isolated synthetic harness around the real core/Moka workflow. It has no
// production-driver path, no model/network path, and no submission endpoint.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from '../../../core/store.js';
import {
  createHud04VirtualEnvironment,
  waitForMokaOperation,
} from './hud-04-virtual.js';
import {
  HUD_04_VIRTUAL_COMPANY_URL,
  HUD_04_VIRTUAL_JOB_URL,
  HUD_04_VIRTUAL_NOW,
  HUD_04_VIRTUAL_SCHEMA_VERSION,
  HUD_04_VIRTUAL_SCENARIOS,
} from './fixtures/hud-04-virtual-moka.js';

export const HUD_05_INTERACTIVE_SCHEMA_VERSION = 'application-copilot.hud-05.interactive.v1';
export const HUD_05_INTERACTIVE_MARKER = 'HUD-05-INTERACTIVE-TRIAL';
export const HUD_05_MATERIAL_BINDING_SCHEMA = 'application-copilot.hud-05.material-binding.v1';
export const HUD_05_POSITION_BINDING_SCHEMA = 'application-copilot.hud-05.position-binding.v1';
export const HUD_05_PLAN_BINDING_SCHEMA = 'application-copilot.hud-05.plan-binding.v1';
export const HUD_05_DEFAULT_REPORT_PATH = path.join(
  PROJECT_ROOT,
  'private',
  'application-copilot',
  'hud-05-interactive-trial-report.md',
);

const OPERATOR = Object.freeze({ actor: 'operator' });
const TRIAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'trial', 'hud-05');
const STATIC_FILES = Object.freeze({
  '/': 'index.html',
  '/index.html': 'index.html',
  '/styles.css': 'styles.css',
  '/app.js': 'app.js',
});
const ALLOWED_SCENARIOS = new Set(HUD_04_VIRTUAL_SCENARIOS);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ACTION_TEXT = 20_000;

class Hud05Error extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'Hud05Error';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 409) {
  throw new Hud05Error(code, message, status);
}

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function normalizeText(value, field = '文本') {
  if (typeof value !== 'string') fail('INVALID_TEXT', `${field} 必须是字符串。`, 400);
  if (value.length === 0 || value.length > MAX_ACTION_TEXT) {
    fail('INVALID_TEXT', `${field} 不能为空且不能超过 ${MAX_ACTION_TEXT} 个字符。`, 400);
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

function assertPlainObject(value, label = '请求') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_INPUT', `${label} 必须是对象。`, 400);
  }
  return value;
}

function assertOnlyKeys(value, allowed, label = '请求') {
  assertPlainObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('UNKNOWN_FIELD', `${label} 包含未支持字段：${key}。`, 400);
  }
}

function safeScenario(value) {
  const scenario = typeof value === 'string' && value ? value : 'happy';
  if (!ALLOWED_SCENARIOS.has(scenario)) fail('INVALID_SCENARIO', `不支持的 HUD-05 合成场景：${scenario}。`, 400);
  return scenario;
}

function confirmedFact(fact) {
  return Boolean(
    fact
    && fact.confirmed === true
    && Number.isInteger(fact.confirmedVersion)
    && fact.confirmedVersion === fact.version,
  );
}

function normalizeForDisplay(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function openBlockingIssues(issues) {
  return (Array.isArray(issues) ? issues : []).filter((issue) => issue?.blocking === true && issue.status !== 'resolved');
}

function stageFor({ summary, detail, materialConfirmed, moka, issues = [] }) {
  if (summary.recoveryPending) return 'recovery_required';
  if (moka.operation?.status === 'running') return 'running';
  if (openBlockingIssues(issues).length > 0) return 'blocked';
  if (moka.review && moka.review.passed !== true) return 'blocked';
  if (moka.review?.passed === true) return 'prepared';
  if (!materialConfirmed) return 'confirm_material';
  const position = detail.positions.find((item) => item.id === detail.company.activePositionId)
    || detail.positions.find((item) => item.id === detail.company.selectedPositionIds?.[0]);
  if (!position || position.status === 'candidate') return 'select_position';
  if (!moka.plan) return 'prepare_plan';
  if (moka.plan.confirmed !== true) return 'confirm_plan';
  return 'run_fill';
}

function getCandidate(input) {
  const candidate = input.resume?.candidateDrafts?.[0];
  if (!candidate) fail('FIXTURE_INVALID', 'HUD-04 fixture 缺少合成材料候选。', 500);
  return candidate;
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
        reject(new Hud05Error('BODY_TOO_LARGE', 'HUD-05 请求体超出本地限制。', 413));
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        reject(new Hud05Error('BODY_REQUIRED', 'HUD-05 POST 请求需要 JSON 对象。', 400));
        return;
      }
      try {
        resolve(assertPlainObject(JSON.parse(raw), '请求体'));
      } catch (error) {
        reject(error instanceof Hud05Error ? error : new Hud05Error('INVALID_JSON', '请求体不是有效 JSON。', 400));
      }
    });
    req.on('error', () => reject(new Hud05Error('REQUEST_READ_ERROR', '本地请求读取失败。', 400)));
  });
}

async function writeReportFile(outputPath, content) {
  if (!outputPath) return null;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    const existing = await fs.readFile(outputPath, 'utf8');
    if (!existing.includes(`# ${HUD_05_INTERACTIVE_MARKER}`)) {
      throw new Error(`拒绝覆盖非 HUD-05 私有报告：${outputPath}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.writeFile(outputPath, content, 'utf8');
  return outputPath;
}

export async function createHud05InteractiveSession({
  scenario = 'happy',
  sandboxPath = null,
  reportPath = HUD_05_DEFAULT_REPORT_PATH,
} = {}) {
  const selectedScenario = safeScenario(scenario);
  const env = await createHud04VirtualEnvironment({ scenario: selectedScenario, sandboxPath });
  const state = {
    companyId: null,
    positionId: null,
    materialFactIds: { content: null, responsibilities: null },
    materialConfirmed: false,
    materialEditCount: 0,
    userEvents: [],
    setupEvents: [],
    lastError: null,
    interactionRevision: 0,
    confirmedPlanBinding: null,
    reportPath,
    closed: false,
  };
  let actionTail = Promise.resolve();
  let closePromise = null;

  function addSetupEvent(type, detail = {}) {
    state.setupEvents.push({
      eventId: `hud05-setup-${state.setupEvents.length + 1}`,
      type,
      actor: 'trial_setup',
      isUserApproval: false,
      synthetic: true,
      at: HUD_04_VIRTUAL_NOW,
      ...detail,
    });
  }

  function addUserEvent(type, detail = {}) {
    state.userEvents.push({
      eventId: `hud05-user-${state.userEvents.length + 1}`,
      type,
      actor: 'interactive_user_action',
      synthetic: true,
      at: HUD_04_VIRTUAL_NOW,
      ...detail,
    });
  }

  async function facts() {
    const list = await env.core.listProfileFactsForLocalEdit(OPERATOR);
    return (Array.isArray(list) ? list : []).filter((fact) => (
      fact.scope?.companyId === state.companyId
      && fact.scope?.positionId === state.positionId
      && ['project_content', 'project_responsibilities'].includes(fact.section)
    ));
  }

  async function syncMaterial() {
    const list = await facts();
    const content = list.find((fact) => fact.section === 'project_content');
    const responsibilities = list.find((fact) => fact.section === 'project_responsibilities');
    state.materialFactIds = {
      content: content?.id || null,
      responsibilities: responsibilities?.id || null,
    };
    state.materialConfirmed = confirmedFact(content) && confirmedFact(responsibilities);
    return { content, responsibilities };
  }

  function materialBinding(summary, currentFacts, candidate) {
    const factsBySection = new Map(currentFacts.map((fact) => [fact.section, fact]));
    return {
      schemaVersion: HUD_05_MATERIAL_BINDING_SCHEMA,
      candidateId: candidate.id,
      companyId: state.companyId,
      positionId: state.positionId,
      profileRevision: summary.profileRevision,
      coreRevision: summary.revision,
      sourceName: env.input.resume.sourceName,
      sourceParagraphIds: [...candidate.sourceParagraphIds],
      facts: ['project_content', 'project_responsibilities'].map((section) => {
        const fact = factsBySection.get(section);
        return fact ? {
          id: fact.id,
          section: fact.section,
          label: fact.label,
          value: fact.value,
          version: fact.version,
          confirmed: fact.confirmed,
          confirmedVersion: fact.confirmedVersion,
          source: clone(fact.source),
          scope: clone(fact.scope),
        } : null;
      }),
    };
  }

  function assertMaterialBinding(binding, summary, currentFacts, candidate) {
    if (!binding) fail('CONFIRMATION_BINDING_REQUIRED', '确认材料必须携带本人所见的候选、事实版本和岗位作用域。');
    assertOnlyKeys(binding, [
      'schemaVersion',
      'candidateId',
      'companyId',
      'positionId',
      'profileRevision',
      'coreRevision',
      'sourceName',
      'sourceParagraphIds',
      'facts',
    ], '材料所见绑定');
    const expected = materialBinding(summary, currentFacts, candidate);
    if (!sameValue(binding, expected)) {
      fail('STALE_MATERIAL_CONFIRMATION', '材料所见版本、事实内容或岗位作用域已变化；拒绝确认旧标签内容。');
    }
    return expected;
  }

  function positionBinding(summary, detailRecord, position) {
    return {
      schemaVersion: HUD_05_POSITION_BINDING_SCHEMA,
      companyId: detailRecord.company.id,
      companyStatus: detailRecord.company.status,
      positionId: position.id,
      officialId: position.officialId,
      title: position.title,
      city: position.city,
      sourceUrl: position.source?.url || HUD_04_VIRTUAL_JOB_URL,
      coreRevision: summary.revision,
      companyPositionRevision: detailRecord.company.updatedAt || null,
    };
  }

  function assertPositionBinding(binding, summary, detailRecord, position) {
    if (!binding) fail('POSITION_BINDING_REQUIRED', '岗位动作必须携带本人所见的岗位、公司和修订绑定。');
    assertOnlyKeys(binding, [
      'schemaVersion',
      'companyId',
      'companyStatus',
      'positionId',
      'officialId',
      'title',
      'city',
      'sourceUrl',
      'coreRevision',
      'companyPositionRevision',
    ], '岗位所见绑定');
    const expected = positionBinding(summary, detailRecord, position);
    if (!sameValue(binding, expected)) {
      fail('STALE_POSITION_BINDING', '岗位或公司作用域已变化；拒绝使用旧标签选择。');
    }
    return expected;
  }

  function planBinding(summary, detailRecord, moka, currentFacts) {
    const plan = moka.plan;
    if (!plan) return null;
    const factsById = new Map(currentFacts.map((fact) => [fact.id, fact]));
    return {
      schemaVersion: HUD_05_PLAN_BINDING_SCHEMA,
      planId: plan.planId,
      companyId: plan.companyId,
      positionId: plan.positionId,
      pageUrl: plan.pageUrl,
      snapshotId: plan.snapshotId,
      targetId: plan.targetId,
      profileVersion: plan.profileVersion,
      coreRevision: summary.revision,
      companyPositionRevision: detailRecord.company.updatedAt || null,
      items: plan.items.map((item) => {
        const fact = factsById.get(item.factId);
        return {
          controlRef: item.controlRef,
          factId: item.factId,
          fieldKey: item.fieldKey,
          label: item.label,
          regionType: item.regionType,
          regionEntityId: item.regionEntityId,
          factVersion: fact?.version ?? null,
          confirmedVersion: fact?.confirmedVersion ?? null,
          originalText: fact?.value ?? null,
        };
      }),
    };
  }

  function assertPlanBinding(binding, expected) {
    if (!binding) fail('PLAN_BINDING_REQUIRED', '计划确认或执行必须携带本人所见的 planId、事实版本和页面作用域。');
    assertOnlyKeys(binding, [
      'schemaVersion',
      'planId',
      'companyId',
      'positionId',
      'pageUrl',
      'snapshotId',
      'targetId',
      'profileVersion',
      'coreRevision',
      'companyPositionRevision',
      'items',
    ], '计划所见绑定');
    if (!expected || !sameValue(binding, expected)) {
      fail('STALE_PLAN_CONFIRMATION', '字段计划、事实版本或页面作用域已变化；拒绝确认或执行旧标签计划。');
    }
    return expected;
  }

  async function currentMaterialContext() {
    const [summary, currentFacts] = await Promise.all([env.core.summary(), facts()]);
    const candidate = getCandidate(env.input);
    return {
      summary,
      currentFacts,
      candidate,
      binding: materialBinding(summary, currentFacts, candidate),
    };
  }

  async function currentPositionContext() {
    const [summary, companyDetail] = await Promise.all([env.core.summary(), detail()]);
    const position = companyDetail.positions.find((item) => item.id === state.positionId);
    if (!position) fail('POSITION_NOT_FOUND', '当前合成岗位不存在。');
    return {
      summary,
      companyDetail,
      position,
      binding: positionBinding(summary, companyDetail, position),
    };
  }

  async function assertNoBlockingIssues() {
    const issues = await env.core.listIssues({ status: 'all', companyId: state.companyId }, OPERATOR);
    const blocking = openBlockingIssues(issues);
    if (blocking.length) {
      fail('BLOCKING_ISSUES_PRESENT', '当前仍有未解决的阻断问题；编辑不会清除该门禁，不能继续准备、确认或执行。');
    }
    return issues;
  }

  async function detail() {
    return env.core.getCompany({ companyId: state.companyId }, OPERATOR);
  }

  async function bootstrap() {
    const summary = await env.core.summary();
    if (summary.companies.length === 0) {
      const added = await env.core.addCompany({
        name: env.input.company.name,
        batch: env.input.company.batch,
        links: [{ url: env.input.company.sourceUrl, kind: 'apply', source: 'HUD-05 synthetic fixture' }],
      }, OPERATOR);
      state.companyId = added.company.id;
      await env.core.startQueue({ eventId: 'hud05-setup-start-queue', confirmedBy: 'user' }, OPERATOR);
      await env.core.recordHumanLogin({
        companyId: state.companyId,
        eventId: 'hud05-setup-login',
        confirmedBy: 'user',
      }, OPERATOR);
      addSetupEvent('queue_started');
      addSetupEvent('synthetic_login_recorded');

      await env.workflow.startOpen({ companyId: state.companyId });
      await waitForMokaOperation(env.workflow);
      addSetupEvent('fake_page_opened', { url: HUD_04_VIRTUAL_JOB_URL });
      await env.workflow.startResearch({ companyId: state.companyId, sendAuthorized: true });
      await waitForMokaOperation(env.workflow);
      addSetupEvent('fake_router_research_completed', { externalNetworkCalls: env.calls.network });
    } else {
      state.companyId = summary.queue.currentCompanyId || summary.companies[0]?.id || null;
      if (!state.companyId) fail('TRIAL_STATE_INVALID', '合成试用缺少当前公司。', 500);
      addSetupEvent('sandbox_state_reused_after_restart');
    }

    const companyDetail = await detail();
    const position = companyDetail.positions.find((item) => item.id === companyDetail.company.activePositionId)
      || companyDetail.positions.find((item) => companyDetail.company.selectedPositionIds?.includes(item.id))
      || companyDetail.positions[0];
    if (!position) fail('TRIAL_STATE_INVALID', '合成检索没有岗位候选。', 500);
    state.positionId = position.id;
    const candidate = getCandidate(env.input);
    const currentFacts = await facts();
    const specs = [
      {
        section: 'project_content',
        label: '项目内容',
        value: candidate.content,
        sourceRef: `${env.input.resume.sourceName}#para-project-content`,
      },
      {
        section: 'project_responsibilities',
        label: '本人职责',
        value: candidate.responsibilities,
        sourceRef: `${env.input.resume.sourceName}#para-project-responsibilities`,
      },
    ];
    for (const spec of specs) {
      if (!currentFacts.some((fact) => fact.section === spec.section)) {
        await env.core.createProfileFact({
          section: spec.section,
          entityId: 'project-hud04',
          label: spec.label,
          value: spec.value,
          source: { type: 'resume', ref: spec.sourceRef },
          scope: { type: 'position', companyId: state.companyId, positionId: state.positionId },
          sensitivity: 'normal',
        }, OPERATOR);
      }
    }
    await syncMaterial();
  }

  function materialFromFacts(candidate, currentFacts, binding = null) {
    const content = currentFacts.content;
    const responsibilities = currentFacts.responsibilities;
    return {
      candidate: {
        id: candidate.id,
        status: state.materialConfirmed ? 'confirmed' : (state.materialEditCount ? 'edited_unconfirmed' : 'unconfirmed'),
        confirmed: state.materialConfirmed,
        sourceName: env.input.resume.sourceName,
        sourceParagraphIds: [...candidate.sourceParagraphIds],
        content: content?.value ?? candidate.content,
        responsibilities: responsibilities?.value ?? candidate.responsibilities,
        originalContent: candidate.content,
        originalResponsibilities: candidate.responsibilities,
      },
      source: {
        name: env.input.resume.sourceName,
        text: env.input.resume.sourceText,
        paragraphs: env.input.resume.paragraphs.filter((paragraph) => (
          candidate.sourceParagraphIds.includes(paragraph.id)
        )),
      },
      facts: [content, responsibilities].filter(Boolean).map((fact) => ({
        id: fact.id,
        section: fact.section,
        label: fact.label,
        version: fact.version,
        confirmed: fact.confirmed,
        confirmedVersion: fact.confirmedVersion,
        scope: clone(fact.scope),
        source: clone(fact.source),
        value: fact.value,
      })),
      binding: clone(binding),
    };
  }

  function actualPageView() {
    const driver = env.driver();
    const page = driver?.page;
    if (!page) return null;
    const values = page.values;
    const controls = Array.isArray(page.controls) ? page.controls : [];
    return {
      url: HUD_04_VIRTUAL_JOB_URL,
      targetId: page.targetId,
      fields: controls.map((control) => {
        const value = values.get(control.ref) || {};
        return {
          ref: control.ref,
          label: control.label,
          type: control.type,
          value: control.type === 'select' ? (value.selectedLabel || '') : (value.value || ''),
          valueLength: control.type === 'select' ? (value.selectedLabel || '').length : (value.value || '').length,
        };
      }),
      writes: page.writeLog || [],
      stats: page.stats,
    };
  }

  function planView(moka, currentFacts, { summary, companyDetail } = {}) {
    if (!moka.plan) return null;
    const byId = new Map(currentFacts.filter(Boolean).map((fact) => [fact.id, fact]));
    return {
      ...moka.plan,
      items: moka.plan.items.map((item) => {
        const fact = byId.get(item.factId);
        return {
          ...item,
          originalText: fact?.value || '',
          text: normalizeForDisplay(fact?.value || ''),
          factVersion: fact?.version ?? null,
          confirmedVersion: fact?.confirmedVersion ?? null,
        };
      }),
      binding: summary && companyDetail
        ? planBinding(summary, companyDetail, moka, currentFacts)
        : null,
    };
  }

  async function collectSnapshot() {
    const [summary, companyDetail, issueList, currentFacts, moka] = await Promise.all([
      env.core.summary(),
      detail(),
      env.core.listIssues({ status: 'all', companyId: state.companyId }, OPERATOR),
      facts(),
      env.workflow.getState(),
    ]);
    const candidate = getCandidate(env.input);
    const currentFactMap = {
      content: currentFacts.find((fact) => fact.section === 'project_content') || null,
      responsibilities: currentFacts.find((fact) => fact.section === 'project_responsibilities') || null,
    };
    state.materialFactIds = {
      content: currentFactMap.content?.id || null,
      responsibilities: currentFactMap.responsibilities?.id || null,
    };
    state.materialConfirmed = confirmedFact(currentFactMap.content) && confirmedFact(currentFactMap.responsibilities);
    const materialBindingValue = materialBinding(summary, currentFacts, candidate);
    const stage = stageFor({
      summary,
      detail: companyDetail,
      materialConfirmed: state.materialConfirmed,
      moka,
      issues: issueList,
    });
    const position = companyDetail.positions.find((item) => item.id === state.positionId) || null;
    const page = actualPageView();
    const reportContent = reportMarkdown({
      scenario: selectedScenario,
      state,
      summary,
      companyDetail,
      issueList,
      moka,
      page,
      material: materialFromFacts(candidate, currentFactMap),
      plan: planView(moka, [currentFactMap.content, currentFactMap.responsibilities]),
    });
    return {
      schemaVersion: HUD_05_INTERACTIVE_SCHEMA_VERSION,
      fixtureSchemaVersion: HUD_04_VIRTUAL_SCHEMA_VERSION,
      synthetic: true,
      offline: true,
      scenario: selectedScenario,
      stage,
      capabilities: {
        productionDriver: false,
        fakeRouter: true,
        externalNetwork: false,
        networkCalls: env.calls.network,
        realSubmission: false,
        submitAction: false,
        officialVerification: false,
      },
      preflight: {
        syntheticOnly: true,
        note: '队列、合成登录、fake page 与 fake router 是试用前置，不是本人真实审核或真实登录。',
        events: clone(state.setupEvents),
      },
      company: {
        id: companyDetail.company.id,
        name: companyDetail.company.name,
        batch: companyDetail.company.batch,
        sourceUrl: HUD_04_VIRTUAL_COMPANY_URL,
        status: companyDetail.company.status,
      },
      position: position ? {
        id: position.id,
        officialId: position.officialId,
        title: position.title,
        city: position.city,
        status: position.status,
        selected: companyDetail.company.selectedPositionIds.includes(position.id),
        source: clone(position.source),
        binding: positionBinding(summary, companyDetail, position),
      } : null,
      material: materialFromFacts(candidate, currentFactMap, materialBindingValue),
      plan: planView(moka, [currentFactMap.content, currentFactMap.responsibilities], { summary, companyDetail }),
      actualPage: page,
      interactionRevision: state.interactionRevision,
      core: {
        queue: clone(summary.queue),
        checkpoint: clone(summary.checkpoint),
        recoveryPending: summary.recoveryPending === true,
        revision: summary.revision,
        profileRevision: summary.profileRevision,
        positionStatus: position?.status || null,
      },
      operation: clone(moka.operation),
      research: clone(moka.research),
      review: clone(moka.review),
      issues: clone(issueList),
      interactiveEvents: clone(state.userEvents),
      lastError: clone(state.lastError),
      report: {
        path: reportPath,
        content: reportContent,
      },
      actions: {
        confirmMaterial: !state.materialConfirmed && stage !== 'running' && stage !== 'recovery_required',
        editMaterial: Boolean(currentFactMap.content || currentFactMap.responsibilities)
          && stage !== 'running'
          && stage !== 'recovery_required',
        selectPosition: stage === 'select_position',
        preparePlan: stage === 'prepare_plan',
        confirmPlan: stage === 'confirm_plan',
        runFill: stage === 'run_fill',
        recover: stage === 'recovery_required',
      },
    };
  }

  function reportMarkdown({ scenario, state: sessionState, summary, companyDetail, issueList, moka, page, material, plan }) {
    const review = moka.review;
    const position = companyDetail.positions.find((item) => item.id === sessionState.positionId) || null;
    const lines = [
      `# ${HUD_05_INTERACTIVE_MARKER}`,
      '',
      `- schema: \`${HUD_05_INTERACTIVE_SCHEMA_VERSION}\``,
      `- fixtureSchema: \`${HUD_04_VIRTUAL_SCHEMA_VERSION}\``,
      `- generatedAt: ${HUD_04_VIRTUAL_NOW}`,
      `- scenario: ${scenario}`,
      `- stage: ${stageFor({ summary, detail: companyDetail, materialConfirmed: sessionState.materialConfirmed, moka, issues: issueList })}`,
      `- company: ${companyDetail.company.name}（synthetic）`,
      `- position: ${position?.title || 'not selected'}（synthetic）`,
      `- networkCalls: ${env.calls.network}`,
      '- bindAddress: 127.0.0.1 only',
      '- realSiteAccess: false',
      '- realModelAccess: false',
      '- realSubmission: false',
      '- submitAction: absent',
      '',
      '## Interaction boundary',
      '',
      '- `trial_setup` events only create the synthetic precondition; they are not real user review, login, or submission.',
      `- interactive user actions: ${sessionState.userEvents.length}`,
      ...sessionState.userEvents.map((event) => `  - ${event.type}: ${event.eventId}`),
      '',
      '## Material provenance',
      '',
      `- source: ${material.source.name}`,
      `- candidate: ${material.candidate.id}`,
      `- confirmed: ${material.candidate.confirmed}`,
      `- editCount: ${sessionState.materialEditCount}`,
      `- sourceParagraphs: ${material.candidate.sourceParagraphIds.join(', ')}`,
      '- position scope: current synthetic company and position only',
      '- family/sensitive fixture facts were not exposed to the trial plan.',
      '',
      '## Plan and page result',
      '',
      `- planId: ${plan?.planId || 'none'}`,
      `- planConfirmedByInteractiveUser: ${plan?.confirmed === true}`,
      `- fields: ${plan?.items?.length || 0}`,
      `- operation: ${moka.operation?.status || 'none'}`,
      `- reviewPassed: ${review?.passed === true}`,
      `- programDiffs: ${review?.programDiffs?.length || 0}`,
      `- actualPageWrites: ${page?.writes?.length || 0}`,
      `- actualPageReadbackFields: ${review?.readbackFields || 0}`,
      ...((review?.programDiffs || []).map((diff) => `  - diff ${diff.fieldId}: ${diff.reason}`)),
      '',
      '## Issues and recovery',
      '',
      `- openIssueCount: ${issueList.filter((issue) => issue.status !== 'resolved').length}`,
      ...issueList.map((issue) => `  - ${issue.type}/${issue.fieldKey}: ${issue.message}`),
      `- recoveryPending: ${summary.recoveryPending === true}`,
      '- restart behavior: old in-memory plan is not restored or replayed; recovery requires a fresh observation and interactive confirmation.',
      '',
      '## Final boundary',
      '',
      '- The trial stops at synthetic preparation/review. It does not expose buttons or routes for login, upload, save/next, submit, or official verification.',
      '- The report is local private synthetic evidence and must not be read as a real application receipt.',
      '',
    ];
    return lines.join('\n');
  }

  async function persistReport() {
    const snapshot = await collectSnapshot();
    await writeReportFile(reportPath, snapshot.report.content);
    return snapshot.report;
  }

  async function confirmMaterial(payload) {
    assertOnlyKeys(payload, ['binding', 'values'], 'confirm_material');
    const context = await currentMaterialContext();
    const expectedBinding = assertMaterialBinding(payload.binding, context.summary, context.currentFacts, context.candidate);
    assertPlainObject(payload.values, 'confirm_material.values');
    assertOnlyKeys(payload.values, ['content', 'responsibilities'], 'confirm_material.values');
    const content = normalizeText(payload.values.content, '项目内容');
    const responsibilities = normalizeText(payload.values.responsibilities, '本人职责');
    const factsBySection = new Map(context.currentFacts.map((fact) => [fact.section, fact]));
    const contentFact = factsBySection.get('project_content');
    const responsibilitiesFact = factsBySection.get('project_responsibilities');
    if (!contentFact || !responsibilitiesFact) {
      fail('MATERIAL_FACTS_REQUIRED', '两个岗位专属材料事实必须同时存在，确认不会半成功。');
    }
    if (content !== contentFact.value || responsibilities !== responsibilitiesFact.value) {
      fail('UNSAVED_MATERIAL_DRAFT', '页面草稿与当前事实版本不同；请先原子保存全部修改，再确认。');
    }
    const confirmed = await env.core.confirmProfileFacts({
      confirmations: [contentFact, responsibilitiesFact].map((fact) => ({
        factId: fact.id,
        expectedVersion: fact.version,
      })),
      confirmedBy: 'user',
    }, OPERATOR);
    state.lastError = null;
    state.confirmedPlanBinding = null;
    addUserEvent('confirm_material_candidate', {
      candidateId: expectedBinding.candidateId,
      factIds: confirmed.map((fact) => fact.id),
      factVersions: confirmed.map((fact) => fact.version),
      companyId: expectedBinding.companyId,
      positionId: expectedBinding.positionId,
      profileRevision: expectedBinding.profileRevision,
    });
    await syncMaterial();
  }

  async function editMaterial(payload) {
    assertOnlyKeys(payload, ['binding', 'values'], 'edit_material');
    assertPlainObject(payload.values, 'edit_material.values');
    assertOnlyKeys(payload.values, ['content', 'responsibilities'], 'edit_material.values');
    const content = normalizeText(payload.values.content, '项目内容');
    const responsibilities = normalizeText(payload.values.responsibilities, '本人职责');
    const context = await currentMaterialContext();
    assertMaterialBinding(payload.binding, context.summary, context.currentFacts, context.candidate);
    const factsBySection = new Map(context.currentFacts.map((fact) => [fact.section, fact]));
    const contentFact = factsBySection.get('project_content');
    const responsibilitiesFact = factsBySection.get('project_responsibilities');
    if (!contentFact || !responsibilitiesFact) fail('MATERIAL_FACTS_REQUIRED', '两个岗位专属材料事实必须同时存在。');
    const changes = [
      [contentFact, content],
      [responsibilitiesFact, responsibilities],
    ].filter(([fact, value]) => value !== fact.value).map(([fact, value]) => ({
      factId: fact.id,
      expectedVersion: fact.version,
      patch: { value },
    }));
    if (!changes.length) fail('NO_MATERIAL_CHANGES', '没有检测到可保存的材料修改。', 400);
    // Invalidate only after the full binding and both-field payload have been
    // checked. The profile store applies all changes atomically.
    env.workflow.invalidatePlan('材料编辑，旧计划失效');
    state.confirmedPlanBinding = null;
    const revised = await env.core.reviseProfileFacts({ changes }, OPERATOR);
    state.materialEditCount += 1;
    state.lastError = null;
    addUserEvent('edit_material_revoke_confirmation', {
      fields: changes.map((change) => change.factId),
      factIds: revised.map((fact) => fact.id),
      newVersions: revised.map((fact) => fact.version),
      atomic: true,
    });
    await syncMaterial();
  }

  async function selectPosition(payload) {
    assertOnlyKeys(payload, ['binding'], 'select_position');
    const context = await currentPositionContext();
    assertPositionBinding(payload.binding, context.summary, context.companyDetail, context.position);
    if (context.position.status !== 'candidate') fail('POSITION_NOT_SELECTABLE', '该虚构岗位当前不能再次选择。');
    await env.core.selectPositions({ companyId: state.companyId, positionIds: [state.positionId] }, OPERATOR);
    state.lastError = null;
    addUserEvent('select_synthetic_position', { binding: clone(payload.binding) });
  }

  async function preparePlan(payload) {
    assertOnlyKeys(payload, ['positionBinding', 'materialBinding'], 'prepare_plan');
    const materialContext = await currentMaterialContext();
    const positionContext = await currentPositionContext();
    assertMaterialBinding(payload.materialBinding, materialContext.summary, materialContext.currentFacts, materialContext.candidate);
    assertPositionBinding(payload.positionBinding, positionContext.summary, positionContext.companyDetail, positionContext.position);
    if (!state.materialConfirmed) fail('MATERIAL_CONFIRMATION_REQUIRED', '请先确认当前材料候选。');
    if (!positionContext.companyDetail.company.selectedPositionIds.includes(state.positionId)) {
      fail('POSITION_SELECTION_REQUIRED', '请先选择虚构岗位。');
    }
    if (materialContext.summary.recoveryPending) fail('RECOVERY_OBSERVATION_REQUIRED', '恢复后必须先重新观察合成页面。');
    await assertNoBlockingIssues();
    state.confirmedPlanBinding = null;
    await env.workflow.startPrepare({
      companyId: state.companyId,
      jobId: state.positionId,
      sendAuthorized: true,
    });
    await waitForMokaOperation(env.workflow);
    state.lastError = null;
    addUserEvent('prepare_field_plan', {
      fakeRouter: true,
      externalNetworkCalls: env.calls.network,
      materialBinding: clone(payload.materialBinding),
      positionBinding: clone(payload.positionBinding),
    });
  }

  async function confirmPlan(payload) {
    assertOnlyKeys(payload, ['binding'], 'confirm_plan');
    const [summary, companyDetail, currentFacts, moka] = await Promise.all([
      env.core.summary(),
      detail(),
      facts(),
      env.workflow.getState(),
    ]);
    if (!moka.plan?.planId) fail('PLAN_REQUIRED', '当前没有可确认的字段计划。');
    const expectedBinding = planBinding(summary, companyDetail, moka, currentFacts);
    assertPlanBinding(payload.binding, expectedBinding);
    await assertNoBlockingIssues();
    env.workflow.confirmPlan(moka.plan.planId, true);
    state.confirmedPlanBinding = clone(expectedBinding);
    state.lastError = null;
    addUserEvent('confirm_field_plan', { binding: clone(expectedBinding) });
  }

  async function runFill(payload) {
    assertOnlyKeys(payload, ['binding'], 'run_fill');
    const summary = await env.core.summary();
    if (summary.recoveryPending) fail('RECOVERY_OBSERVATION_REQUIRED', '恢复后必须先重新观察合成页面。');
    await assertNoBlockingIssues();
    const [companyDetail, currentFacts, moka] = await Promise.all([
      detail(),
      facts(),
      env.workflow.getState(),
    ]);
    if (!moka.plan?.planId || moka.plan.confirmed !== true) fail('PLAN_CONFIRMATION_REQUIRED', '执行前必须确认当前字段计划。');
    const expectedBinding = planBinding(summary, companyDetail, moka, currentFacts);
    assertPlanBinding(payload.binding, expectedBinding);
    if (!state.confirmedPlanBinding || !sameValue(state.confirmedPlanBinding, expectedBinding)) {
      fail('PLAN_CONFIRMATION_REQUIRED', '当前计划没有由本次会话按相同所见版本确认。');
    }
    await env.workflow.startRun({
      companyId: state.companyId,
      jobId: state.positionId,
      positionId: state.positionId,
      planId: expectedBinding.planId,
      sendAuthorized: true,
    });
    await waitForMokaOperation(env.workflow);
    state.lastError = null;
    addUserEvent('run_fake_page_fill_and_readback', { binding: clone(expectedBinding) });
  }

  async function recover() {
    const summary = await env.core.summary();
    if (!summary.recoveryPending) return;
    await env.workflow.startOpen({ companyId: state.companyId });
    await waitForMokaOperation(env.workflow);
    const driver = env.driver();
    const observation = driver ? await driver.observe() : null;
    if (!observation?.ok || !observation.snapshot) fail('OBSERVATION_REQUIRED', '合成页面重新观察失败；未解除恢复阻断。');
    await env.core.acknowledgeRecovery({
      observedAt: HUD_04_VIRTUAL_NOW,
      confirmedBy: 'user',
    }, OPERATOR);
    state.lastError = null;
    addUserEvent('reobserve_after_restart', { snapshotId: observation.snapshot.id });
  }

  async function dispatch(action, payload) {
    assertOnlyKeys({ action, payload }, ['action', 'payload'], '动作');
    if (typeof action !== 'string' || !action) fail('INVALID_ACTION', '缺少 HUD-05 动作。', 400);
    const body = payload === undefined ? {} : assertPlainObject(payload, `${action}.payload`);
    switch (action) {
      case 'confirm_material':
        await confirmMaterial(body);
        break;
      case 'edit_material':
        await editMaterial(body);
        break;
      case 'select_position':
        await selectPosition(body);
        break;
      case 'prepare_plan':
        await preparePlan(body);
        break;
      case 'confirm_plan':
        await confirmPlan(body);
        break;
      case 'run_fill':
        await runFill(body);
        break;
      case 'recover':
        assertOnlyKeys(body, [], action);
        await recover();
        break;
      default:
        fail('UNKNOWN_ACTION', `未知 HUD-05 动作：${action}。`, 400);
    }
    return { action };
  }

  async function action(action, payload = {}) {
    const next = actionTail.catch(() => {}).then(async () => {
      if (state.closed) fail('TRIAL_CLOSED', 'HUD-05 合成试用已关闭。', 409);
      try {
        const result = await dispatch(action, payload);
        state.interactionRevision += 1;
        state.lastError = null;
        const snapshot = await collectSnapshot();
        await writeReportFile(reportPath, snapshot.report.content);
        return { ok: true, ...result, state: snapshot };
      } catch (error) {
        state.interactionRevision += 1;
        state.lastError = {
          code: error?.code || 'TRIAL_ACTION_FAILED',
          message: String(error?.message || 'HUD-05 动作失败。').slice(0, 500),
        };
        const snapshot = await collectSnapshot().catch(() => null);
        if (snapshot) await writeReportFile(reportPath, snapshot.report.content).catch(() => {});
        return {
          ok: false,
          error: state.lastError,
          state: snapshot,
        };
      }
    });
    actionTail = next.catch(() => {});
    return next;
  }

  async function getState() {
    if (state.closed) fail('TRIAL_CLOSED', 'HUD-05 合成试用已关闭。', 409);
    return collectSnapshot();
  }

  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (state.closed) return;
      state.closed = true;
      await writeReportFile(reportPath, await collectSnapshot().then((snapshot) => snapshot.report.content)).catch(() => {});
      await env.cleanup();
    })();
    return closePromise;
  }

  try {
    await bootstrap();
    await persistReport();
  } catch (error) {
    await env.cleanup().catch(() => {});
    throw error;
  }

  return {
    schemaVersion: HUD_05_INTERACTIVE_SCHEMA_VERSION,
    scenario: selectedScenario,
    sandboxPath: env.sandbox,
    reportPath,
    env,
    getState,
    action,
    close,
  };
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
  const text = JSON.stringify(body);
  res.writeHead(status, { ...commonHeaders('application/json; charset=utf-8'), ...extraHeaders });
  res.end(text);
}

function sendText(res, status, text, contentType, extraHeaders = {}) {
  res.writeHead(status, { ...commonHeaders(contentType), ...extraHeaders });
  res.end(text);
}

function requestHost(req) {
  return typeof req.headers.host === 'string' ? req.headers.host : '';
}

function checkHost(req, origin) {
  const expected = new URL(origin).host;
  if (requestHost(req) !== expected) throw new Hud05Error('HOST_NOT_ALLOWED', 'HUD-05 只接受绑定的 loopback host。', 403);
}

function requireSession(req, sessionToken) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.hud05_sid !== sessionToken) throw new Hud05Error('UNAUTHORIZED', 'HUD-05 会话未授权。', 401);
  return cookies;
}

function requireMutationBoundary(req, origin, sessionToken, csrfToken) {
  checkHost(req, origin);
  const cookies = requireSession(req, sessionToken);
  if (req.headers.origin !== origin) throw new Hud05Error('ORIGIN_NOT_ALLOWED', 'HUD-05 动作必须来自本地试用页面。', 403);
  if (req.headers['x-hud05-csrf'] !== csrfToken || cookies.hud05_csrf !== csrfToken) {
    throw new Hud05Error('CSRF_REQUIRED', 'HUD-05 动作缺少本地 CSRF 校验。', 403);
  }
  return cookies;
}

async function staticText(fileName) {
  const candidate = path.join(TRIAL_ROOT, fileName);
  if (path.dirname(candidate) !== TRIAL_ROOT) throw new Error('HUD-05 static path escaped.');
  return fs.readFile(candidate, 'utf8');
}

export async function createHud05InteractiveServer({
  scenario = 'happy',
  port = 0,
  reportPath = HUD_05_DEFAULT_REPORT_PATH,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Hud05Error('INVALID_PORT', 'HUD-05 端口无效。', 400);
  const session = await createHud05InteractiveSession({ scenario, reportPath });
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
      if (req.method === 'GET' && fileName) {
        if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
          const html = (await staticText(fileName)).replaceAll('__HUD05_CSRF__', csrfToken);
          sendText(res, 200, html, 'text/html; charset=utf-8', {
            'Set-Cookie': [
              `hud05_sid=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Strict; Path=/`,
              `hud05_csrf=${encodeURIComponent(csrfToken)}; SameSite=Strict; Path=/`,
            ],
          });
          return;
        }
        sendText(res, 200, await staticText(fileName), fileName.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
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
        if (typeof body.action !== 'string') fail('INVALID_ACTION', 'action 必须是字符串。', 400);
        const result = await session.action(body.action, body.payload || {});
        if (result.ok) {
          sendJson(res, 200, result);
        } else {
          sendJson(res, 409, result);
        }
        return;
      }
      throw new Hud05Error('NOT_FOUND', 'HUD-05 本地路由不存在。', 404);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      sendJson(res, status, {
        ok: false,
        error: {
          code: error?.code || 'INTERNAL_ERROR',
          message: status >= 500 ? 'HUD-05 本地服务处理失败。' : String(error?.message || 'HUD-05 请求失败。').slice(0, 500),
        },
      });
    }
  }

  server = http.createServer((req, res) => {
    void handle(req, res);
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
    schemaVersion: HUD_05_INTERACTIVE_SCHEMA_VERSION,
    synthetic: true,
    origin,
    url: `${origin}/`,
    port: address.port,
    scenario: session.scenario,
    reportPath,
    session,
    stop,
  };
}

export async function runHud05InteractiveCheck({ scenario = 'happy', reportPath = null } = {}) {
  const app = await createHud05InteractiveServer({ scenario, reportPath });
  try {
    const action = async (name, payload = {}) => app.session.action(name, payload);
    const initial = await app.session.getState();
    const confirmed = await action('confirm_material', {
      binding: initial.material.binding,
      values: {
        content: initial.material.candidate.content,
        responsibilities: initial.material.candidate.responsibilities,
      },
    });
    const selected = await action('select_position', { binding: initial.position.binding });
    const selectedState = selected.state || await app.session.getState();
    const prepared = await action('prepare_plan', {
      positionBinding: selectedState.position.binding,
      materialBinding: selectedState.material.binding,
    });
    const preparedState = prepared.state || await app.session.getState();
    const planned = await action('confirm_plan', { binding: preparedState.plan.binding });
    const plannedState = planned.state || await app.session.getState();
    const filled = await action('run_fill', { binding: plannedState.plan.binding });
    const finalState = filled.state || await app.session.getState();
    return {
      schemaVersion: HUD_05_INTERACTIVE_SCHEMA_VERSION,
      scenario,
      synthetic: true,
      nonInteractiveCheck: true,
      interactiveActionsSimulated: [
        'confirm_material',
        'select_position',
        'prepare_plan',
        'confirm_plan',
        'run_fill',
      ],
      status: finalState.stage,
      networkCalls: finalState.capabilities.networkCalls,
      actionResults: [confirmed.ok, selected.ok, prepared.ok, planned.ok, filled.ok],
      final: finalState,
    };
  } finally {
    await app.stop();
  }
}

export { Hud05Error, OPERATOR };
