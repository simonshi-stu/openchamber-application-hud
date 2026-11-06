// Local application-result ledger. It records preparation, user reports, and
// trusted receipt observations without performing or claiming a submission.

import { createHash } from 'node:crypto';
import {
  JsonFileStore,
  PRIVATE_ROOT,
  createStoreValidator,
} from './store.js';
import {
  companyIdentityKey,
  normalizeOfficialId,
} from './records.js';
import { validateSchema } from './validation.js';

export const APPLICATION_LEDGER_SCHEMA_VERSION = 'application-copilot.application-ledger.v1';
export const APPLICATION_BINDING_SCHEMA_VERSION = 'application-copilot.application-binding.v1';

export const APPLICATION_LEDGER_STATUS = Object.freeze({
  PREPARED_WAITING_HUMAN_SUBMIT: 'prepared_waiting_human_submit',
  SUBMITTED_REPORTED: 'submitted_reported',
  UNKNOWN: 'unknown',
  OFFICIAL_VERIFIED: 'official_verified',
});

export const APPLICATION_LEDGER_EVIDENCE_KIND = Object.freeze({
  PREPARATION: 'preparation',
  USER_REPORT: 'user_report',
  UNKNOWN: 'unknown',
  OFFICIAL_RECEIPT: 'official_receipt',
});

const nullableString = { type: ['string', 'null'] };
const iso = { type: 'string', minLength: 1, format: 'date-time' };

const materialFactSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['id', 'section', 'version', 'confirmedVersion'],
  properties: {
    id: { type: 'string', minLength: 1 },
    section: { type: 'string', minLength: 1, maxLength: 100 },
    version: { type: 'integer', minimum: 1 },
    confirmedVersion: { type: ['integer', 'null'], minimum: 1 },
  },
});

const materialSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['candidateId', 'sourceName', 'sourceParagraphIds', 'profileRevision', 'coreRevision', 'facts', 'digest'],
  properties: {
    candidateId: { type: 'string', minLength: 1, maxLength: 300 },
    sourceName: { type: 'string', minLength: 1, maxLength: 300 },
    sourceParagraphIds: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 300 }, maxItems: 50 },
    profileRevision: { type: 'integer', minimum: 0 },
    coreRevision: { type: 'integer', minimum: 0 },
    facts: { type: 'array', items: materialFactSchema, minItems: 1, maxItems: 50 },
    digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  },
});

const planItemSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['controlRef', 'factId', 'fieldKey', 'factVersion', 'confirmedVersion'],
  properties: {
    controlRef: { type: 'string', minLength: 1, maxLength: 300 },
    factId: { type: 'string', minLength: 1, maxLength: 300 },
    fieldKey: { type: 'string', minLength: 1, maxLength: 300 },
    factVersion: { type: ['integer', 'null'], minimum: 1 },
    confirmedVersion: { type: ['integer', 'null'], minimum: 1 },
  },
});

const planSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['planId', 'snapshotId', 'targetId', 'profileVersion', 'coreRevision', 'items', 'digest'],
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 300 },
    snapshotId: { type: 'string', minLength: 1, maxLength: 300 },
    targetId: { type: 'string', minLength: 1, maxLength: 300 },
    profileVersion: { type: 'integer', minimum: 0 },
    coreRevision: { type: 'integer', minimum: 0 },
    items: { type: 'array', items: planItemSchema, minItems: 1, maxItems: 100 },
    digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  },
});

const preparationSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['preparedAt', 'material', 'plan', 'sourceVersion', 'bindingDigest', 'reviewPassed', 'readbackFields', 'writeCount', 'diffCount'],
  properties: {
    preparedAt: iso,
    material: materialSchema,
    plan: planSchema,
    sourceVersion: { type: 'string', minLength: 1, maxLength: 500 },
    bindingDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    reviewPassed: { const: true },
    readbackFields: { type: 'integer', minimum: 0 },
    writeCount: { type: 'integer', minimum: 0 },
    diffCount: { type: 'integer', minimum: 0 },
  },
});

const currentBindingSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'applicationId', 'applicationKey', 'companyId', 'positionId', 'officialId',
    'materialDigest', 'planDigest', 'sourceVersion', 'profileRevision', 'coreRevision',
  ],
  properties: {
    schemaVersion: { const: APPLICATION_BINDING_SCHEMA_VERSION },
    applicationId: { type: 'string', minLength: 1 },
    applicationKey: { type: 'string', minLength: 1, maxLength: 1000 },
    companyId: { type: 'string', minLength: 1 },
    positionId: { type: 'string', minLength: 1 },
    officialId: { type: 'string', minLength: 1, maxLength: 300 },
    materialDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    planDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    sourceVersion: { type: 'string', minLength: 1, maxLength: 500 },
    profileRevision: { type: 'integer', minimum: 0 },
    coreRevision: { type: 'integer', minimum: 0 },
  },
});

const lastEvidenceSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'source', 'observedAt', 'sourceVersion', 'acknowledged', 'trustedOfficialObservation', 'blockReason', 'evidenceDigest', 'eventId'],
  properties: {
    kind: { enum: Object.values(APPLICATION_LEDGER_EVIDENCE_KIND) },
    source: { enum: ['hud05_readback', 'user_report', 'unknown_report', 'official_site_observation'] },
    observedAt: iso,
    sourceVersion: { type: 'string', minLength: 1, maxLength: 500 },
    acknowledged: { type: 'boolean' },
    trustedOfficialObservation: { type: 'boolean' },
    blockReason: { type: 'string', maxLength: 500 },
    evidenceDigest: nullableString,
    eventId: { type: 'string', minLength: 1, maxLength: 300 },
  },
});

const submissionReportSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['reportedAt', 'reference', 'recordedBy', 'eventId', 'evidenceKind', 'acknowledged', 'sourceVersion', 'blockReason'],
  properties: {
    reportedAt: iso,
    reference: { type: 'string', maxLength: 500 },
    recordedBy: { const: 'user' },
    eventId: { type: 'string', minLength: 1, maxLength: 300 },
    evidenceKind: { const: APPLICATION_LEDGER_EVIDENCE_KIND.USER_REPORT },
    acknowledged: { const: false },
    sourceVersion: { type: 'string', minLength: 1, maxLength: 500 },
    blockReason: { type: 'string', minLength: 1, maxLength: 500 },
  },
});

const verificationSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['verifiedAt', 'sourceUrl', 'ackId', 'evidenceDigest', 'recordedBy', 'eventId', 'evidenceKind', 'sourceVersion', 'trustedOfficialObservation', 'synthetic'],
  properties: {
    verifiedAt: iso,
    sourceUrl: { type: 'string', minLength: 1, format: 'uri' },
    ackId: { type: 'string', minLength: 1, maxLength: 300 },
    evidenceDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    recordedBy: { const: 'user' },
    eventId: { type: 'string', minLength: 1, maxLength: 300 },
    evidenceKind: { const: APPLICATION_LEDGER_EVIDENCE_KIND.OFFICIAL_RECEIPT },
    sourceVersion: { type: 'string', minLength: 1, maxLength: 500 },
    trustedOfficialObservation: { const: true },
    synthetic: { type: 'boolean' },
  },
});

const historySchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['at', 'from', 'to', 'eventId', 'type', 'evidenceKind', 'sourceVersion', 'blockReason'],
  properties: {
    at: iso,
    from: { enum: [...Object.values(APPLICATION_LEDGER_STATUS), 'none'] },
    to: { enum: Object.values(APPLICATION_LEDGER_STATUS) },
    eventId: { type: 'string', minLength: 1, maxLength: 300 },
    type: { type: 'string', minLength: 1, maxLength: 100 },
    evidenceKind: { enum: Object.values(APPLICATION_LEDGER_EVIDENCE_KIND) },
    sourceVersion: { type: 'string', minLength: 1, maxLength: 500 },
    blockReason: { type: 'string', maxLength: 500 },
  },
});

const applicationSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'applicationId', 'applicationKey', 'companyIdentityKey', 'companyId', 'companyBatch',
    'positionId', 'officialId', 'status', 'preparedAt', 'preparation', 'currentBinding',
    'submissionReport', 'verification', 'lastEvidence', 'history', 'createdAt', 'updatedAt',
  ],
  properties: {
    applicationId: { type: 'string', minLength: 1, maxLength: 300 },
    applicationKey: { type: 'string', minLength: 1, maxLength: 1000 },
    companyIdentityKey: { type: 'string', minLength: 1, maxLength: 500 },
    companyId: { type: 'string', minLength: 1, maxLength: 300 },
    companyBatch: { type: 'string', maxLength: 200 },
    positionId: { type: 'string', minLength: 1, maxLength: 300 },
    officialId: { type: 'string', minLength: 1, maxLength: 300 },
    status: { enum: Object.values(APPLICATION_LEDGER_STATUS) },
    preparedAt: iso,
    preparation: { anyOf: [preparationSchema, { type: 'null' }] },
    currentBinding: currentBindingSchema,
    submissionReport: { anyOf: [submissionReportSchema, { type: 'null' }] },
    verification: { anyOf: [verificationSchema, { type: 'null' }] },
    lastEvidence: lastEvidenceSchema,
    history: { type: 'array', items: historySchema, maxItems: 200 },
    createdAt: iso,
    updatedAt: iso,
  },
});

const ledgerEventSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['eventId', 'applicationId', 'type', 'at', 'digest'],
  properties: {
    eventId: { type: 'string', minLength: 1, maxLength: 300 },
    applicationId: { type: 'string', minLength: 1, maxLength: 300 },
    type: { type: 'string', minLength: 1, maxLength: 100 },
    at: iso,
    digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  },
});

export const applicationLedgerDocumentSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'applications', 'events'],
  properties: {
    schemaVersion: { const: APPLICATION_LEDGER_SCHEMA_VERSION },
    applications: { type: 'array', items: applicationSchema, maxItems: 20000 },
    events: { type: 'array', items: ledgerEventSchema, maxItems: 50000 },
  },
});

export class ApplicationLedgerError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ApplicationLedgerError';
    this.code = code;
    this.details = details;
  }
}

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function digestValue(value) {
  return createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
}

export function applicationIdentity({ companyName, batch = '', officialId }) {
  const identity = companyIdentityKey(companyName, batch);
  const official = normalizeOfficialId(officialId);
  if (!identity || !official) {
    throw new ApplicationLedgerError('INVALID_APPLICATION_IDENTITY', '申请身份必须包含公司、批次和官方岗位 ID。');
  }
  const applicationKey = `${identity}\u0000${official}`;
  return {
    companyIdentityKey: identity,
    officialId: official,
    applicationKey,
    applicationId: `application_${digestValue(applicationKey).slice(0, 32)}`,
  };
}

function safeSourceName(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : 'unknown-source';
}

function safeStringArray(value, fallback = []) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.slice(0, 300)).slice(0, 50)
    : fallback;
}

function sanitizeMaterialBinding(binding) {
  if (!binding || typeof binding !== 'object') {
    throw new ApplicationLedgerError('MATERIAL_BINDING_REQUIRED', '准备台账必须携带材料版本绑定。');
  }
  const facts = Array.isArray(binding.facts) ? binding.facts.map((fact) => ({
    id: String(fact?.id || ''),
    section: String(fact?.section || ''),
    version: fact?.version,
    confirmedVersion: fact?.confirmedVersion ?? null,
  })) : [];
  if (!binding.candidateId || !facts.length) {
    throw new ApplicationLedgerError('MATERIAL_BINDING_INVALID', '材料版本绑定缺少候选或事实版本。');
  }
  const sanitized = {
    candidateId: String(binding.candidateId),
    sourceName: safeSourceName(binding.sourceName),
    sourceParagraphIds: safeStringArray(binding.sourceParagraphIds),
    profileRevision: Number.isInteger(binding.profileRevision) ? binding.profileRevision : 0,
    coreRevision: Number.isInteger(binding.coreRevision) ? binding.coreRevision : 0,
    facts,
    digest: digestValue(binding),
  };
  validateSchema(sanitized, materialSchema);
  return sanitized;
}

function sanitizePlanBinding(binding) {
  if (!binding || typeof binding !== 'object') {
    throw new ApplicationLedgerError('PLAN_BINDING_REQUIRED', '准备台账必须携带字段计划绑定。');
  }
  const items = Array.isArray(binding.items) ? binding.items.map((item) => ({
    controlRef: String(item?.controlRef || ''),
    factId: String(item?.factId || ''),
    fieldKey: String(item?.fieldKey || ''),
    factVersion: item?.factVersion ?? null,
    confirmedVersion: item?.confirmedVersion ?? null,
  })) : [];
  if (!binding.planId || !items.length) {
    throw new ApplicationLedgerError('PLAN_BINDING_INVALID', '字段计划绑定缺少 planId 或字段项。');
  }
  const sanitized = {
    planId: String(binding.planId),
    snapshotId: String(binding.snapshotId || 'unknown-snapshot'),
    targetId: String(binding.targetId || 'unknown-target'),
    profileVersion: Number.isInteger(binding.profileVersion) ? binding.profileVersion : 0,
    coreRevision: Number.isInteger(binding.coreRevision) ? binding.coreRevision : 0,
    items,
    digest: digestValue(binding),
  };
  validateSchema(sanitized, planSchema);
  return sanitized;
}

function sourceVersionFor(material, plan) {
  return `material:${material.profileRevision}:${material.facts.map((fact) => `${fact.id}@${fact.version}/${fact.confirmedVersion ?? 'unconfirmed'}`).join(',')}|plan:${plan.planId}@${plan.coreRevision}`.slice(0, 500);
}

function currentBindingFor(identity, input, material, plan, sourceVersion) {
  const binding = {
    schemaVersion: APPLICATION_BINDING_SCHEMA_VERSION,
    applicationId: identity.applicationId,
    applicationKey: identity.applicationKey,
    companyId: String(input.companyId),
    positionId: String(input.positionId),
    officialId: identity.officialId,
    materialDigest: material.digest,
    planDigest: plan.digest,
    sourceVersion,
    profileRevision: material.profileRevision,
    coreRevision: Math.max(material.coreRevision, plan.coreRevision),
  };
  validateSchema(binding, currentBindingSchema);
  return binding;
}

function preparationFor(input, material, plan) {
  const preparedAt = typeof input.preparedAt === 'string' ? input.preparedAt : input.now;
  if (typeof preparedAt !== 'string' || Number.isNaN(Date.parse(preparedAt))) {
    throw new ApplicationLedgerError('INVALID_PREPARED_AT', '准备时间必须是有效日期时间。');
  }
  if (input.reviewPassed !== true) {
    throw new ApplicationLedgerError('PREPARATION_NOT_PASSED', '没有通过实际读回复核，不能进入准备完成台账。');
  }
  const result = {
    preparedAt,
    material,
    plan,
    sourceVersion: sourceVersionFor(material, plan),
    bindingDigest: digestValue({ materialBinding: input.materialBinding, planBinding: input.planBinding }),
    reviewPassed: true,
    readbackFields: Number.isInteger(input.readbackFields) && input.readbackFields >= 0 ? input.readbackFields : 0,
    writeCount: Number.isInteger(input.writeCount) && input.writeCount >= 0 ? input.writeCount : 0,
    diffCount: Number.isInteger(input.diffCount) && input.diffCount >= 0 ? input.diffCount : 0,
  };
  validateSchema(result, preparationSchema);
  return result;
}

function emptyDocument() {
  return {
    schemaVersion: APPLICATION_LEDGER_SCHEMA_VERSION,
    applications: [],
    events: [],
  };
}

function applicationStatusLabel(status) {
  return {
    [APPLICATION_LEDGER_STATUS.PREPARED_WAITING_HUMAN_SUBMIT]: '准备完成／待本人提交',
    [APPLICATION_LEDGER_STATUS.SUBMITTED_REPORTED]: '本人报告已提交（本地记录）',
    [APPLICATION_LEDGER_STATUS.UNKNOWN]: '结果未知／需本人核查',
    [APPLICATION_LEDGER_STATUS.OFFICIAL_VERIFIED]: '官网回执已核验',
  }[status] || '未知状态';
}

function publicApplication(application, revision) {
  if (!application) return null;
  return {
    applicationId: application.applicationId,
    applicationKey: application.applicationKey,
    companyIdentityKey: application.companyIdentityKey,
    companyId: application.companyId,
    companyBatch: application.companyBatch,
    positionId: application.positionId,
    officialId: application.officialId,
    status: application.status,
    statusLabel: applicationStatusLabel(application.status),
    preparedAt: application.preparedAt,
    preparation: clone(application.preparation),
    currentBinding: {
      ...clone(application.currentBinding),
      ledgerRevision: revision,
    },
    submissionReport: clone(application.submissionReport),
    verification: clone(application.verification),
    lastEvidence: clone(application.lastEvidence),
    history: clone(application.history),
    createdAt: application.createdAt,
    updatedAt: application.updatedAt,
  };
}

function cloneError(error) {
  return {
    code: error?.code || 'LEDGER_CORRUPT',
    message: String(error?.message || '本地申请台账不可读取。').slice(0, 500),
  };
}

function assertRevision(expectedRevision, actualRevision) {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new ApplicationLedgerError('REVISION_REQUIRED', '申请台账写入必须携带当前台账版本。');
  }
  if (expectedRevision !== actualRevision) {
    throw new ApplicationLedgerError(
      'VERSION_CONFLICT',
      `申请台账版本已变化（期望 ${expectedRevision}，实际 ${actualRevision}）；未覆盖新记录。`,
      { expected: expectedRevision, actual: actualRevision },
    );
  }
}

function assertBinding(application, binding) {
  if (!binding || typeof binding !== 'object') {
    throw new ApplicationLedgerError('APPLICATION_BINDING_REQUIRED', '结果台账动作必须携带本人所见的申请绑定。');
  }
  const expected = application.currentBinding;
  const actual = { ...binding };
  delete actual.ledgerRevision;
  validateSchema(actual, currentBindingSchema);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ApplicationLedgerError('STALE_APPLICATION_BINDING', '岗位、材料版本或字段计划已变化；拒绝写入旧申请结果。');
  }
}

function bindingFingerprint(binding) {
  const result = clone(binding);
  if (result && typeof result === 'object') delete result.ledgerRevision;
  return result;
}

function findApplication(document, applicationId) {
  return document.applications.find((application) => application.applicationId === applicationId) || null;
}

function appendHistory(application, { at, from, to, eventId, type, evidenceKind, sourceVersion, blockReason = '' }) {
  const item = { at, from, to, eventId, type, evidenceKind, sourceVersion, blockReason };
  validateSchema(item, historySchema);
  application.history = [...application.history, item].slice(-200);
}

function appendEvent(document, { eventId, applicationId, type, at, fingerprint }) {
  if (!eventId) return null;
  const digest = digestValue(fingerprint);
  const previous = document.events.find((event) => event.eventId === eventId);
  if (previous) {
    if (previous.applicationId !== applicationId || previous.type !== type) {
      throw new ApplicationLedgerError('EVENT_ID_REUSED', '同一台账事件 ID 被用于不同申请或不同动作。');
    }
    if (previous.digest !== digest) {
      throw new ApplicationLedgerError('EVENT_ID_PAYLOAD_MISMATCH', '同一台账事件 ID 的关键参数不一致。');
    }
    return { duplicate: true, event: previous };
  }
  const event = { eventId, applicationId, type, at, digest };
  validateSchema(event, ledgerEventSchema);
  document.events = [...document.events, event].slice(-50000);
  return { duplicate: false, event };
}

function requireApplicationInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApplicationLedgerError('INVALID_INPUT', '申请台账输入必须是对象。');
  }
  if (!input.applicationId) throw new ApplicationLedgerError('APPLICATION_ID_REQUIRED', '缺少申请 ID。');
  if (typeof input.now !== 'string' || Number.isNaN(Date.parse(input.now))) {
    throw new ApplicationLedgerError('INVALID_TIME', '台账动作必须携带有效时间。');
  }
}

export function createApplicationLedger({
  directory,
  privateRoot = PRIVATE_ROOT,
  fileName = 'application-ledger.json',
  now = () => new Date().toISOString(),
} = {}) {
  const store = new JsonFileStore({
    directory,
    privateRoot,
    fileName,
    validate: createStoreValidator(applicationLedgerDocumentSchema),
  });
  let document = null;
  let revision = 0;
  let storage = 'missing';
  let loadError = null;
  let tail = Promise.resolve();

  async function loadCurrent() {
    try {
      const loaded = await store.load({ force: true });
      document = loaded.data || emptyDocument();
      revision = loaded.revision;
      storage = loaded.exists ? 'ready' : 'missing';
      loadError = null;
      return { document, revision };
    } catch (error) {
      document = null;
      revision = 0;
      storage = 'corrupt';
      loadError = cloneError(error);
      throw new ApplicationLedgerError('LEDGER_CORRUPT', loadError.message, loadError);
    }
  }

  async function snapshot() {
    try {
      await loadCurrent();
      const applications = document.applications.map((application) => publicApplication(application, revision));
      return {
        schemaVersion: APPLICATION_LEDGER_SCHEMA_VERSION,
        storage,
        revision,
        applications,
        application: applications[0] || null,
        error: null,
      };
    } catch {
      return {
        schemaVersion: APPLICATION_LEDGER_SCHEMA_VERSION,
        storage: 'corrupt',
        revision: null,
        applications: [],
        application: null,
        error: clone(loadError),
      };
    }
  }

  async function mutate(task) {
    const next = tail.catch(() => {}).then(async () => {
      await loadCurrent();
      const before = clone(document);
      const beforeRevision = revision;
      try {
        const result = await task(document, revision);
        if (result?.duplicate === true) {
          return { ...result, revision, document: clone(document) };
        }
        validateSchema(document, applicationLedgerDocumentSchema);
        const saved = await store.save(document, revision);
        document = saved.data;
        revision = saved.revision;
        storage = 'ready';
        return { ...result, revision, document: clone(document) };
      } catch (error) {
        document = before;
        revision = beforeRevision;
        throw error;
      }
    });
    tail = next.catch(() => {});
    return next;
  }

  async function ensurePrepared(input) {
    const identity = applicationIdentity(input);
    const material = sanitizeMaterialBinding(input.materialBinding);
    const plan = sanitizePlanBinding(input.planBinding);
    const preparation = preparationFor({ ...input, now: now() }, material, plan);
    const binding = currentBindingFor(identity, input, material, plan, preparation.sourceVersion);
    return mutate((local, currentRevision) => {
      let application = findApplication(local, identity.applicationId);
      if (application && application.applicationKey !== identity.applicationKey) {
        throw new ApplicationLedgerError('APPLICATION_IDENTITY_CONFLICT', '稳定申请 ID 对应了不同公司批次或岗位。');
      }
      if (application && [APPLICATION_LEDGER_STATUS.SUBMITTED_REPORTED, APPLICATION_LEDGER_STATUS.UNKNOWN, APPLICATION_LEDGER_STATUS.OFFICIAL_VERIFIED].includes(application.status)) {
        if (application.currentBinding.materialDigest !== binding.materialDigest || application.currentBinding.planDigest !== binding.planDigest) {
          throw new ApplicationLedgerError('APPLICATION_RESULT_LOCKED', '已有本人报告、未知结果或官网核验记录；材料变化不得新建或覆盖原申请结果。');
        }
        return { duplicate: true, application: clone(application), reason: 'result_locked' };
      }
      if (application && application.preparation?.bindingDigest === preparation.bindingDigest) {
        return { duplicate: true, application: clone(application), reason: 'same_preparation' };
      }
      const at = preparation.preparedAt;
      if (!application) {
        application = {
          applicationId: identity.applicationId,
          applicationKey: identity.applicationKey,
          companyIdentityKey: identity.companyIdentityKey,
          companyId: String(input.companyId),
          companyBatch: typeof input.batch === 'string' ? input.batch : '',
          positionId: String(input.positionId),
          officialId: identity.officialId,
          status: APPLICATION_LEDGER_STATUS.PREPARED_WAITING_HUMAN_SUBMIT,
          preparedAt: at,
          preparation,
          currentBinding: binding,
          submissionReport: null,
          verification: null,
          lastEvidence: {
            kind: APPLICATION_LEDGER_EVIDENCE_KIND.PREPARATION,
            source: 'hud05_readback',
            observedAt: at,
            sourceVersion: preparation.sourceVersion,
            acknowledged: false,
            trustedOfficialObservation: false,
            blockReason: '准备完成；等待本人登录、审核并提交。没有官网回执。',
            evidenceDigest: preparation.bindingDigest,
            eventId: `prepared:${identity.applicationId}:${preparation.bindingDigest.slice(0, 16)}`,
          },
          history: [],
          createdAt: at,
          updatedAt: at,
        };
        const eventId = `prepared:${identity.applicationId}:${preparation.bindingDigest.slice(0, 16)}`;
        appendEvent(local, {
          eventId,
          applicationId: identity.applicationId,
          type: 'prepared',
          at,
          fingerprint: { applicationId: identity.applicationId, bindingDigest: preparation.bindingDigest },
        });
        appendHistory(application, {
          at,
          from: 'none',
          to: application.status,
          eventId,
          type: 'prepared',
          evidenceKind: APPLICATION_LEDGER_EVIDENCE_KIND.PREPARATION,
          sourceVersion: preparation.sourceVersion,
          blockReason: application.lastEvidence.blockReason,
        });
        local.applications.push(application);
        return { duplicate: false, application: clone(application), reason: 'created' };
      }
      const from = application.status;
      const eventId = `prepared-refresh:${identity.applicationId}:${preparation.bindingDigest.slice(0, 16)}`;
      const event = appendEvent(local, {
        eventId,
        applicationId: identity.applicationId,
        type: 'prepared_refresh',
        at,
        fingerprint: { applicationId: identity.applicationId, bindingDigest: preparation.bindingDigest },
      });
      if (event.duplicate) return { duplicate: true, application: clone(application), reason: 'same_preparation' };
      application.status = APPLICATION_LEDGER_STATUS.PREPARED_WAITING_HUMAN_SUBMIT;
      application.preparedAt = at;
      application.preparation = preparation;
      application.currentBinding = binding;
      application.updatedAt = at;
      application.lastEvidence = {
        kind: APPLICATION_LEDGER_EVIDENCE_KIND.PREPARATION,
        source: 'hud05_readback',
        observedAt: at,
        sourceVersion: preparation.sourceVersion,
        acknowledged: false,
        trustedOfficialObservation: false,
        blockReason: '准备完成；等待本人登录、审核并提交。没有官网回执。',
        evidenceDigest: preparation.bindingDigest,
        eventId,
      };
      appendHistory(application, {
        at,
        from,
        to: application.status,
        eventId,
        type: 'prepared_refresh',
        evidenceKind: APPLICATION_LEDGER_EVIDENCE_KIND.PREPARATION,
        sourceVersion: preparation.sourceVersion,
        blockReason: application.lastEvidence.blockReason,
      });
      return { duplicate: false, application: clone(application), reason: 'refreshed', currentRevision };
    });
  }

  async function recordUserSubmission(input) {
    requireApplicationInput(input);
    const reference = typeof input.reference === 'string' ? input.reference : '';
    const blockReason = typeof input.blockReason === 'string' && input.blockReason.trim()
      ? input.blockReason.trim().slice(0, 500)
      : '本人报告是本地记录；没有可信官网回执，不能标记官网已核验。';
    const sourceVersion = String(input.sourceVersion || '').slice(0, 500);
    if (!sourceVersion) throw new ApplicationLedgerError('SOURCE_VERSION_REQUIRED', '本人报告必须绑定材料/计划来源版本。');
    return mutate((local, currentRevision) => {
      const application = findApplication(local, input.applicationId);
      if (!application) throw new ApplicationLedgerError('APPLICATION_NOT_FOUND', '申请台账记录不存在。');
      assertBinding(application, input.binding);
      const eventId = String(input.eventId || '');
      if (!eventId) throw new ApplicationLedgerError('EVENT_ID_REQUIRED', '本人报告必须携带幂等事件 ID。');
      const reportedAt = String(input.reportedAt || input.now);
      if (Number.isNaN(Date.parse(reportedAt))) throw new ApplicationLedgerError('INVALID_TIME', '本人报告时间无效。');
      const event = appendEvent(local, {
        eventId,
        applicationId: application.applicationId,
        type: 'user_report',
        at: reportedAt,
        fingerprint: {
          applicationId: application.applicationId,
          binding: bindingFingerprint(input.binding),
          reportedAt,
          reference,
          sourceVersion,
          blockReason,
        },
      });
      if (event.duplicate) return { duplicate: true, application: clone(application), reason: 'same_report' };
      assertRevision(input.expectedRevision, currentRevision);
      if (application.status === APPLICATION_LEDGER_STATUS.OFFICIAL_VERIFIED) {
        throw new ApplicationLedgerError('ALREADY_VERIFIED', '官网核验记录已存在，不能重复写入本人报告。');
      }
      if (application.status === APPLICATION_LEDGER_STATUS.SUBMITTED_REPORTED) {
        throw new ApplicationLedgerError('ALREADY_REPORTED', '本人提交报告已存在，禁止重复记录或重走申请路径。');
      }
      if (application.status === APPLICATION_LEDGER_STATUS.UNKNOWN) {
        throw new ApplicationLedgerError('UNKNOWN_RESULT_LOCKED', '结果仍为未知；不能用新的手工报告覆盖未知证据。');
      }
      if (application.status !== APPLICATION_LEDGER_STATUS.PREPARED_WAITING_HUMAN_SUBMIT) {
        throw new ApplicationLedgerError('NOT_READY_FOR_REPORT', '申请尚未达到准备完成／待本人提交阶段。');
      }
      const from = application.status;
      application.status = APPLICATION_LEDGER_STATUS.SUBMITTED_REPORTED;
      application.submissionReport = {
        reportedAt,
        reference: reference.slice(0, 500),
        recordedBy: 'user',
        eventId,
        evidenceKind: APPLICATION_LEDGER_EVIDENCE_KIND.USER_REPORT,
        acknowledged: false,
        sourceVersion,
        blockReason,
      };
      application.updatedAt = input.now;
      application.lastEvidence = {
        kind: APPLICATION_LEDGER_EVIDENCE_KIND.USER_REPORT,
        source: 'user_report',
        observedAt: reportedAt,
        sourceVersion,
        acknowledged: false,
        trustedOfficialObservation: false,
        blockReason,
        evidenceDigest: digestValue({ reference, sourceVersion }),
        eventId,
      };
      appendHistory(application, {
        at: reportedAt,
        from,
        to: application.status,
        eventId,
        type: 'user_report',
        evidenceKind: APPLICATION_LEDGER_EVIDENCE_KIND.USER_REPORT,
        sourceVersion,
        blockReason,
      });
      return { duplicate: false, application: clone(application), reason: 'reported' };
    });
  }

  async function recordUnknown(input) {
    requireApplicationInput(input);
    const reason = typeof input.blockReason === 'string' ? input.blockReason.trim().slice(0, 500) : '';
    if (!reason) throw new ApplicationLedgerError('BLOCK_REASON_REQUIRED', '未知结果必须说明阻塞原因。');
    const sourceVersion = String(input.sourceVersion || '').slice(0, 500);
    if (!sourceVersion) throw new ApplicationLedgerError('SOURCE_VERSION_REQUIRED', '未知结果必须绑定材料/计划来源版本。');
    return mutate((local, currentRevision) => {
      const application = findApplication(local, input.applicationId);
      if (!application) throw new ApplicationLedgerError('APPLICATION_NOT_FOUND', '申请台账记录不存在。');
      assertBinding(application, input.binding);
      const eventId = String(input.eventId || '');
      if (!eventId) throw new ApplicationLedgerError('EVENT_ID_REQUIRED', '未知结果必须携带幂等事件 ID。');
      const observedAt = String(input.observedAt || input.now);
      if (Number.isNaN(Date.parse(observedAt))) throw new ApplicationLedgerError('INVALID_TIME', '未知结果时间无效。');
      const event = appendEvent(local, {
        eventId,
        applicationId: application.applicationId,
        type: 'unknown_result',
        at: observedAt,
        fingerprint: { applicationId: application.applicationId, binding: bindingFingerprint(input.binding), observedAt, sourceVersion, reason },
      });
      if (event.duplicate) return { duplicate: true, application: clone(application), reason: 'same_unknown' };
      assertRevision(input.expectedRevision, currentRevision);
      if (application.status === APPLICATION_LEDGER_STATUS.OFFICIAL_VERIFIED) {
        throw new ApplicationLedgerError('ALREADY_VERIFIED', '已有官网核验记录，不能改写为未知。');
      }
      const from = application.status;
      application.status = APPLICATION_LEDGER_STATUS.UNKNOWN;
      application.updatedAt = input.now;
      application.lastEvidence = {
        kind: APPLICATION_LEDGER_EVIDENCE_KIND.UNKNOWN,
        source: 'unknown_report',
        observedAt,
        sourceVersion,
        acknowledged: false,
        trustedOfficialObservation: false,
        blockReason: reason,
        evidenceDigest: digestValue({ reason, sourceVersion }),
        eventId,
      };
      appendHistory(application, {
        at: observedAt,
        from,
        to: application.status,
        eventId,
        type: 'unknown_result',
        evidenceKind: APPLICATION_LEDGER_EVIDENCE_KIND.UNKNOWN,
        sourceVersion,
        blockReason: reason,
      });
      return { duplicate: false, application: clone(application), reason: 'unknown' };
    });
  }

  async function recordOfficialVerification(input) {
    requireApplicationInput(input);
    const evidence = input.evidence;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      throw new ApplicationLedgerError('OFFICIAL_EVIDENCE_REQUIRED', '官网核验必须提供结构化回执证据。');
    }
    if (evidence.kind !== APPLICATION_LEDGER_EVIDENCE_KIND.OFFICIAL_RECEIPT
      || evidence.trustedOfficialObservation !== true
      || evidence.acknowledged !== true) {
      throw new ApplicationLedgerError('UNTRUSTED_OFFICIAL_EVIDENCE', '没有可信官网观测和 ack，不能标记官网回执已核验。');
    }
    const sourceUrl = String(evidence.sourceUrl || '');
    let parsed;
    try { parsed = new URL(sourceUrl); } catch { parsed = null; }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new ApplicationLedgerError('INVALID_OFFICIAL_SOURCE', '官网核验来源必须是无凭据的 http(s) 地址。');
    }
    const evidenceText = typeof evidence.evidenceText === 'string' ? evidence.evidenceText : '';
    if (!evidenceText.trim()) throw new ApplicationLedgerError('OFFICIAL_EVIDENCE_REQUIRED', '官网回执证据文本不能为空。');
    const ackId = String(evidence.ackId || '').trim();
    if (!ackId) throw new ApplicationLedgerError('OFFICIAL_ACK_REQUIRED', '没有 ackId，不能标记官网回执已核验。');
    const sourceVersion = String(evidence.sourceVersion || '').slice(0, 500);
    return mutate((local, currentRevision) => {
      const application = findApplication(local, input.applicationId);
      if (!application) throw new ApplicationLedgerError('APPLICATION_NOT_FOUND', '申请台账记录不存在。');
      assertBinding(application, input.binding);
      const eventId = String(input.eventId || '');
      if (!eventId) throw new ApplicationLedgerError('EVENT_ID_REQUIRED', '官网核验必须携带幂等事件 ID。');
      const verifiedAt = String(evidence.verifiedAt || input.now);
      if (Number.isNaN(Date.parse(verifiedAt))) throw new ApplicationLedgerError('INVALID_TIME', '官网核验时间无效。');
      const event = appendEvent(local, {
        eventId,
        applicationId: application.applicationId,
        type: 'official_verification',
        at: verifiedAt,
        fingerprint: {
          applicationId: application.applicationId,
          binding: bindingFingerprint(input.binding),
          sourceUrl,
          ackId,
          evidenceText,
          sourceVersion,
          synthetic: evidence.synthetic === true,
        },
      });
      if (event.duplicate) return { duplicate: true, application: clone(application), reason: 'same_verification' };
      assertRevision(input.expectedRevision, currentRevision);
      if (application.status === APPLICATION_LEDGER_STATUS.OFFICIAL_VERIFIED) {
        throw new ApplicationLedgerError('ALREADY_VERIFIED', '该申请已有官网核验记录。');
      }
      if (application.status !== APPLICATION_LEDGER_STATUS.SUBMITTED_REPORTED) {
        throw new ApplicationLedgerError('NOT_SUBMITTED', '只有本人报告已提交且未核验的申请可以记录官网回执。');
      }
      if (sourceVersion !== application.currentBinding.sourceVersion) {
        throw new ApplicationLedgerError('STALE_APPLICATION_BINDING', '官网回执没有绑定当前材料/计划来源版本。');
      }
      const from = application.status;
      application.status = APPLICATION_LEDGER_STATUS.OFFICIAL_VERIFIED;
      application.verification = {
        verifiedAt,
        sourceUrl,
        ackId: ackId.slice(0, 300),
        evidenceDigest: digestValue(evidenceText),
        recordedBy: 'user',
        eventId,
        evidenceKind: APPLICATION_LEDGER_EVIDENCE_KIND.OFFICIAL_RECEIPT,
        sourceVersion,
        trustedOfficialObservation: true,
        synthetic: evidence.synthetic === true,
      };
      application.updatedAt = input.now;
      application.lastEvidence = {
        kind: APPLICATION_LEDGER_EVIDENCE_KIND.OFFICIAL_RECEIPT,
        source: 'official_site_observation',
        observedAt: verifiedAt,
        sourceVersion,
        acknowledged: true,
        trustedOfficialObservation: true,
        blockReason: '',
        evidenceDigest: application.verification.evidenceDigest,
        eventId,
      };
      appendHistory(application, {
        at: verifiedAt,
        from,
        to: application.status,
        eventId,
        type: 'official_verification',
        evidenceKind: APPLICATION_LEDGER_EVIDENCE_KIND.OFFICIAL_RECEIPT,
        sourceVersion,
        blockReason: '',
      });
      return { duplicate: false, application: clone(application), reason: 'verified' };
    });
  }

  async function canContinuePreparation(applicationId) {
    const state = await snapshot();
    const application = state.applications.find((item) => item.applicationId === applicationId);
    if (!application) return { allowed: true, reason: null };
    if ([APPLICATION_LEDGER_STATUS.SUBMITTED_REPORTED, APPLICATION_LEDGER_STATUS.UNKNOWN, APPLICATION_LEDGER_STATUS.OFFICIAL_VERIFIED].includes(application.status)) {
      return { allowed: false, reason: application.status };
    }
    return { allowed: true, reason: null };
  }

  return {
    snapshot,
    ensurePrepared,
    recordUserSubmission,
    recordUnknown,
    recordOfficialVerification,
    canContinuePreparation,
    applicationStatusLabel,
    get filePath() { return store.filePath; },
  };
}

export function validateApplicationLedgerDocument(document) {
  validateSchema(document, applicationLedgerDocumentSchema);
  return document;
}

export { applicationStatusLabel };
