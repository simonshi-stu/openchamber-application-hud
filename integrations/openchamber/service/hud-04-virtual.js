// HUD-04 synthetic application closure. This module is deliberately a local
// harness: it uses the real core/Moka workflow with injected page and router
// fixtures, but never performs network I/O or a real application submission.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createWorkbenchService } from '../../../core/service.js';
import { PRIVATE_ROOT, PROJECT_ROOT } from '../../../core/store.js';
import { createToolRegistry } from '../../../core/tools.js';
import { createMemoryCredentialStore, createMokaWorkflow } from './moka-workflow.js';
import {
  createHud04VirtualDriver,
  createHud04VirtualInput,
  createHud04VirtualRouter,
  HUD_04_VIRTUAL_COMPANY_URL,
  HUD_04_VIRTUAL_JOB_URL,
  HUD_04_VIRTUAL_NOW,
  HUD_04_VIRTUAL_POSITION_TITLE,
  HUD_04_VIRTUAL_SCHEMA_VERSION,
} from './fixtures/hud-04-virtual-moka.js';

const OPERATOR = Object.freeze({ actor: 'operator' });
const SYNTHETIC_REPORT_MARKER = 'HUD-04-VIRTUAL-APPLICATION-CLOSURE';

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

export async function waitForMokaOperation(workflow, expectedStatus = 'completed', { timeoutMs = 5000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await workflow.getState();
    if (state.operation && state.operation.status !== 'running') {
      if (state.operation.status !== expectedStatus) {
        throw new Error(state.operation.message || `Moka operation ended as ${state.operation.status}`);
      }
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Moka synthetic operation did not finish within the test timeout.');
}

function syntheticRoles() {
  return {
    search: { provider: 'synthetic', model: 'hud04-search-fixture', endpoint: 'https://models.example.invalid/v1' },
    execution: { provider: 'synthetic', model: 'hud04-execution-fixture', endpoint: 'https://models.example.invalid/v1' },
    review: { provider: 'synthetic', model: 'hud04-review-fixture', endpoint: 'https://models.example.invalid/v1' },
  };
}

function nextIdFactory(prefix) {
  let count = 0;
  return () => `${prefix}-${++count}`;
}

async function seedFact(core, input, { confirm = true } = {}) {
  const created = await core.createProfileFact(input, OPERATOR);
  if (!confirm) return created;
  return core.confirmProfileFact({
    factId: created.id,
    expectedVersion: created.version,
    confirmedBy: 'user',
  }, OPERATOR);
}

async function seedInitialProfile(core, input) {
  const facts = input.profile.facts;
  const name = facts.find((fact) => fact.id === 'fixture-name');
  const school = facts.find((fact) => fact.id === 'fixture-school');
  const family = facts.find((fact) => fact.id === 'fixture-family');
  const common = [
    seedFact(core, {
      section: name.section,
      label: name.label,
      value: name.value,
      entityId: null,
      source: name.source,
      scope: name.scope,
      sensitivity: name.sensitivity,
    }),
    seedFact(core, {
      section: school.section,
      label: school.label,
      value: school.value,
      entityId: school.entityId,
      source: school.source,
      scope: school.scope,
      sensitivity: school.sensitivity,
    }),
    seedFact(core, {
      section: family.section,
      label: family.label,
      value: family.value,
      entityId: null,
      source: family.source,
      scope: family.scope,
      sensitivity: family.sensitivity,
      allowedPurposes: ['family_form'],
    }),
  ];
  return Promise.all(common);
}

export async function createHud04VirtualEnvironment({
  scenario = 'happy',
  sandboxPath = null,
  input = createHud04VirtualInput({ scenario }),
} = {}) {
  const sandbox = sandboxPath || await fs.mkdtemp(path.join(PRIVATE_ROOT, 'hud-04-virtual-'));
  const runtimeDirectory = path.join(sandbox, 'runtime');
  const coreIds = nextIdFactory('hud04-core');
  const mokaIds = nextIdFactory('hud04-moka');
  const calls = {
    network: 0,
    rank: 0,
    mapFields: 0,
    review: 0,
    open: 0,
    prepare: 0,
    run: 0,
    fill: 0,
    readback: 0,
  };
  let driver = null;
  const core = createWorkbenchService({
    directory: runtimeDirectory,
    privateRoot: PRIVATE_ROOT,
    now: () => HUD_04_VIRTUAL_NOW,
    newId: coreIds,
  });
  const registry = createToolRegistry(core, { access: 'operator' });
  const credentialStore = createMemoryCredentialStore();
  const routerCalls = { rank: 0, mapFields: 0, review: 0 };
  const workflow = createMokaWorkflow({
    projectPath: sandbox,
    core,
    registry,
    credentialStore,
    getRoles: async () => syntheticRoles(),
    now: () => HUD_04_VIRTUAL_NOW,
    newId: mokaIds,
    fetchImpl: async () => {
      calls.network += 1;
      throw new Error('HUD-04 synthetic trial must not call fetch.');
    },
    driverFactory: () => {
      calls.open += 1;
      driver = createHud04VirtualDriver({ input, scenario, now: () => new Date(HUD_04_VIRTUAL_NOW) });
      return driver;
    },
    routerFactory: () => createHud04VirtualRouter({ input, calls: routerCalls }),
  });

  calls.router = routerCalls;
  return {
    sandbox,
    runtimeDirectory,
    input,
    core,
    registry,
    workflow,
    driver: () => driver,
    calls,
    async seedInitialProfile() {
      return seedInitialProfile(core, input);
    },
    async cleanup() {
      await workflow.stop().catch(() => {});
      if (!sandboxPath) await fs.rm(sandbox, { recursive: true, force: true });
    },
  };
}

export async function confirmHud04MaterialCandidates(env, positionId, companyId) {
  const candidate = env.input.resume.candidateDrafts[0];
  if (!candidate || candidate.confirmed !== false) throw new Error('HUD-04 material fixture must start unconfirmed.');
  const events = [];
  const content = await seedFact(env.core, {
    section: 'project_content',
    entityId: 'project-hud04',
    label: '项目内容',
    value: candidate.content,
    source: { type: 'resume', ref: `${env.input.resume.sourceName}#para-project-content` },
    scope: { type: 'position', companyId, positionId },
    sensitivity: 'normal',
  });
  events.push({
    eventId: 'hud04-material-confirmation-content',
    candidateId: candidate.id,
    field: 'content',
    confirmedBy: 'user',
    factId: content.id,
    factVersion: content.version,
  });
  const responsibilities = await seedFact(env.core, {
    section: 'project_responsibilities',
    entityId: 'project-hud04',
    label: '本人职责',
    value: candidate.responsibilities,
    source: { type: 'resume', ref: `${env.input.resume.sourceName}#para-project-responsibilities` },
    scope: { type: 'position', companyId, positionId },
    sensitivity: 'normal',
  });
  events.push({
    eventId: 'hud04-material-confirmation-responsibilities',
    candidateId: candidate.id,
    field: 'responsibilities',
    confirmedBy: 'user',
    factId: responsibilities.id,
    factVersion: responsibilities.version,
  });
  return { candidate: { ...candidate, confirmed: true, status: 'confirmed' }, events, facts: [content, responsibilities] };
}

export async function prepareHud04Application(env, {
  attachSyntheticReceipts = true,
  confirmPlan = true,
  runFill = true,
} = {}) {
  const { core, input, registry, workflow } = env;
  await env.seedInitialProfile();
  const added = await core.addCompany({
    name: input.company.name,
    batch: input.company.batch,
    links: [{ url: input.company.sourceUrl, kind: 'apply', source: 'HUD-04 synthetic fixture' }],
    referralCandidates: input.company.referralCandidates,
  }, OPERATOR);
  const companyId = added.company.id;
  await core.startQueue({ eventId: 'hud04-queue-start', confirmedBy: 'user' }, OPERATOR);
  await core.recordHumanLogin({ companyId, eventId: 'hud04-synthetic-login', confirmedBy: 'user' }, OPERATOR);

  await workflow.startOpen({ companyId });
  const openState = await waitForMokaOperation(workflow);
  callsFor(env, 'open', openState);
  await workflow.startResearch({ companyId, sendAuthorized: true });
  const researchState = await waitForMokaOperation(workflow);
  const candidateResult = await core.getCompany({ companyId }, OPERATOR);
  const position = candidateResult.positions[0];
  if (!position) throw new Error('HUD-04 synthetic research produced no position.');
  await core.selectPositions({ companyId, positionIds: [position.id] }, OPERATOR);
  const material = await confirmHud04MaterialCandidates(env, position.id, companyId);

  await workflow.startPrepare({ companyId, jobId: position.id, sendAuthorized: true });
  const prepareState = await waitForMokaOperation(workflow);
  if (!prepareState.plan) {
    return {
      status: 'blocked',
      companyId,
      positionId: position.id,
      openState,
      researchState,
      prepareState,
      material,
      final: await core.getCompany({ companyId }, OPERATOR),
    };
  }

  if (!runFill) {
    return {
      status: 'prepared',
      companyId,
      positionId: position.id,
      openState,
      researchState,
      prepareState,
      material,
      final: await core.getCompany({ companyId }, OPERATOR),
    };
  }

  const planConfirmation = {
    eventId: 'hud04-plan-confirmation',
    planId: prepareState.plan.planId,
    confirmedBy: 'user',
  };
  if (confirmPlan) env.workflow.confirmPlan(planConfirmation.planId, true);
  await workflow.startRun({
    companyId,
    jobId: position.id,
    positionId: position.id,
    planId: prepareState.plan.planId,
    sendAuthorized: true,
  });
  const runState = await waitForMokaOperation(workflow);
  const preparationSummary = await workflow.getState();
  if (!preparationSummary.review?.passed || runState.operation.status !== 'completed') {
    return {
      status: 'blocked',
      companyId,
      positionId: position.id,
      openState,
      researchState,
      prepareState,
      runState,
      preparationSummary,
      material,
      planConfirmation,
      final: await core.getCompany({ companyId }, OPERATOR),
    };
  }

  const ready = await core.markPositionReadyForSubmit({ companyId, positionId: position.id, confirmedBy: 'user' }, OPERATOR);
  const recoveryService = createWorkbenchService({
    directory: env.runtimeDirectory,
    privateRoot: PRIVATE_ROOT,
    now: () => HUD_04_VIRTUAL_NOW,
    newId: nextIdFactory('hud04-recovery'),
  });
  const recovery = await recoveryService.recover();
  const syntheticReceipt = {
    submissionEventId: 'hud04-synthetic-submission-receipt',
    verificationEventId: 'hud04-synthetic-verification-receipt',
    confirmedBy: 'user',
    isSynthetic: true,
    realSubmissionPerformed: false,
    note: '仅写入虚构的本人报告/官网核验台账；没有登录、上传、点击提交或访问官网。',
  };
  let submission = null;
  let verification = null;
  if (attachSyntheticReceipts) {
    submission = await core.recordHumanSubmission({
      companyId,
      positionId: position.id,
      eventId: syntheticReceipt.submissionEventId,
      reportedAt: HUD_04_VIRTUAL_NOW,
      reference: 'SYNTHETIC-NOT-ACTUAL-HUD04',
      confirmedBy: 'user',
    }, OPERATOR);
    verification = await core.recordOfficialVerification({
      companyId,
      positionId: position.id,
      eventId: syntheticReceipt.verificationEventId,
      verifiedAt: HUD_04_VIRTUAL_NOW,
      sourceUrl: HUD_04_VIRTUAL_JOB_URL,
      evidenceText: 'SYNTHETIC-ONLY：虚构官网核验文本，不代表真实网站回执。',
      confirmedBy: 'user',
    }, OPERATOR);
  }
  return {
    status: 'completed',
    companyId,
    positionId: position.id,
    companyName: input.company.name,
    positionTitle: HUD_04_VIRTUAL_POSITION_TITLE,
    openState,
    researchState,
    prepareState,
    runState,
    preparationSummary,
    material,
    planConfirmation,
    ready,
    recovery,
    syntheticReceipt,
    submission,
    verification,
    writeLog: env.driver()?.page.writeLog || [],
    final: await core.getCompany({ companyId }, OPERATOR),
  };
}

function callsFor(env, kind, state) {
  env.calls[`${kind}State`] = {
    operation: state.operation,
    plan: state.plan,
    review: state.review,
  };
}

function reportMarkdown({ trial, env, generatedAt = HUD_04_VIRTUAL_NOW }) {
  const finalPosition = trial.final?.positions?.find((item) => item.id === trial.positionId) || null;
  const review = trial.preparationSummary?.review || trial.runState?.review || null;
  const issues = trial.final?.issues || [];
  return [
    `# ${SYNTHETIC_REPORT_MARKER}`,
    '',
    `- schema: \`${HUD_04_VIRTUAL_SCHEMA_VERSION}\``,
    `- generatedAt: ${generatedAt}`,
    `- trialStatus: ${trial.status}`,
    `- company: ${trial.companyName || env.input.company.name}（synthetic）`,
    `- position: ${trial.positionTitle || HUD_04_VIRTUAL_POSITION_TITLE}（synthetic）`,
    `- networkCalls: ${env.calls.network}`,
    '- realSiteAccess: false',
    '- realModelAccess: false',
    '- realSubmission: false',
    '',
    '## Synthetic lifecycle',
    '',
    '1. Synthetic resume paragraphs and source references were loaded locally.',
    `2. Material candidate started unconfirmed and was confirmed by explicit synthetic user events: ${trial.material?.events?.length || 0}.`,
    '3. One synthetic company and one synthetic official position were selected by the user-gated core workflow.',
    `4. Fake Moka page wrote ${review?.readbackFields || 0} field(s) and read back actual page state; expected values were not used as readback.`,
    `5. Program diff count: ${review?.programDiffCount ?? review?.programDiffs?.length ?? 'not available'}; review passed: ${review?.passed === true}.`,
    `6. Synthetic manual receipt records attached: ${trial.submission ? 'yes' : 'no'}; these are ledger entries only, not submission actions.`,
    '',
    '## Recovery and issues',
    '',
    `- Restart recovery pending: ${trial.recovery?.recoveryPending === true}.`,
    `- Recovery safe actions: ${(trial.recovery?.safeActions || []).join(', ') || 'none'}.`,
    `- Persisted issue count at final read: ${issues.length}.`,
    `- Final synthetic position status: ${finalPosition?.status || 'not available'}.`,
    '',
    '## Safety boundary',
    '',
    '- Login, CAPTCHA, attachment upload, save/next/submit clicks, and final submission were not executed or mocked as real completion.',
    '- The page, router, receipts, company, position, resume, and all text in this report are synthetic fixtures.',
    '- A verified-looking final state is synthetic ledger state only and must not be reported as a real application.',
    '',
  ].join('\n');
}

async function writeSyntheticReport(outputPath, content) {
  const parent = path.dirname(outputPath);
  await fs.mkdir(parent, { recursive: true });
  try {
    const previous = await fs.readFile(outputPath, 'utf8');
    if (!previous.includes(`# ${SYNTHETIC_REPORT_MARKER}`)) {
      throw new Error(`拒绝覆盖非 HUD-04 虚构报告：${outputPath}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.writeFile(outputPath, content, 'utf8');
  return outputPath;
}

export async function runHud04VirtualTrial({
  scenario = 'happy',
  outputPath = path.join(PROJECT_ROOT, 'private', 'application-copilot', 'hud-04-virtual-preparation-report.md'),
  attachSyntheticReceipts = true,
} = {}) {
  const env = await createHud04VirtualEnvironment({ scenario });
  let trial;
  try {
    trial = await prepareHud04Application(env, { attachSyntheticReceipts });
    const content = reportMarkdown({ trial, env });
    const reportPath = outputPath ? await writeSyntheticReport(outputPath, content) : null;
    return {
      schemaVersion: HUD_04_VIRTUAL_SCHEMA_VERSION,
      status: trial.status,
      reportPath,
      report: content,
      trial,
      calls: clone(env.calls),
      synthetic: true,
    };
  } finally {
    await env.cleanup();
  }
}

export { OPERATOR, SYNTHETIC_REPORT_MARKER };
