// 私有结构化资料：精确字段查询、确认版本、来源、作用域和敏感用途授权。
// 默认不发送、不返回未确认字段；家庭/敏感字段必须由本人授权具体用途。

import { JsonFileStore } from './store.js';
import { validateSchema } from './validation.js';
import { WorkflowError, assertHumanConfirmation, assertOperator } from './workflow.js';

export const PROFILE_SCHEMA_VERSION = 'application-copilot.profile.v1';
export const FACT_SECTIONS = Object.freeze([
  'basic', 'education', 'internship', 'internship_content', 'project', 'project_original',
  'project_content', 'project_responsibilities', 'skill', 'language', 'family', 'attachment',
  'company_answer', 'other',
]);
export const SENSITIVITY_LEVELS = Object.freeze(['normal', 'sensitive', 'family']);
export const SOURCE_TYPES = Object.freeze(['user', 'resume', 'attachment', 'company_answer', 'import']);

const nullableString = { type: ['string', 'null'] };
const iso = { type: 'string', minLength: 1 };

export const factScopeSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['type', 'companyId', 'positionId'],
  properties: {
    type: { enum: ['global', 'company', 'position'] },
    companyId: nullableString,
    positionId: nullableString,
  },
});

const factHistorySchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['version', 'label', 'value', 'confirmed', 'confirmedAt', 'scope', 'sensitivity', 'allowedPurposes', 'at'],
  properties: {
    version: { type: 'integer', minimum: 1 },
    entityId: { type: ['string', 'null'], maxLength: 200 },
    label: { type: 'string' },
    value: { type: 'string' },
    confirmed: { type: 'boolean' },
    confirmedAt: nullableString,
    scope: factScopeSchema,
    sensitivity: { enum: SENSITIVITY_LEVELS },
    allowedPurposes: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 30 },
    at: iso,
  },
});

export const factSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'id', 'section', 'label', 'value', 'source', 'version', 'confirmed', 'confirmedAt',
    'confirmedVersion', 'scope', 'sensitivity', 'allowedPurposes', 'history', 'createdAt', 'updatedAt',
  ],
  properties: {
    id: { type: 'string', minLength: 1 },
    section: { enum: FACT_SECTIONS },
    // 可选稳定实体 ID（项目、经历、家庭成员等）；旧数据可缺省。
    entityId: { type: ['string', 'null'], maxLength: 200 },
    label: { type: 'string', minLength: 1, maxLength: 200 },
    value: { type: 'string', minLength: 1, maxLength: 20000 },
    source: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'ref'],
      properties: {
        type: { enum: SOURCE_TYPES },
        ref: { type: 'string', maxLength: 1000 },
      },
    },
    version: { type: 'integer', minimum: 1 },
    confirmed: { type: 'boolean' },
    confirmedAt: nullableString,
    confirmedVersion: { type: ['integer', 'null'], minimum: 1 },
    scope: factScopeSchema,
    sensitivity: { enum: SENSITIVITY_LEVELS },
    allowedPurposes: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 100 }, maxItems: 30 },
    history: { type: 'array', items: factHistorySchema, maxItems: 50 },
    createdAt: iso,
    updatedAt: iso,
  },
});

export const grantSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['id', 'factIds', 'purpose', 'scope', 'grantedAt', 'grantedBy'],
  properties: {
    id: { type: 'string', minLength: 1 },
    factIds: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 30 },
    purpose: { type: 'string', minLength: 1, maxLength: 100 },
    scope: factScopeSchema,
    grantedAt: iso,
    grantedBy: { const: 'user' },
  },
});

export const profileDocumentSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'facts', 'grants'],
  properties: {
    schemaVersion: { const: PROFILE_SCHEMA_VERSION },
    facts: { type: 'array', items: factSchema, maxItems: 5000 },
    grants: { type: 'array', items: grantSchema, maxItems: 1000 },
  },
});

function emptyProfile() {
  return { schemaVersion: PROFILE_SCHEMA_VERSION, facts: [], grants: [] };
}

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function normalizedScope(scope = {}) {
  const type = scope.type || 'global';
  const companyId = typeof scope.companyId === 'string' && scope.companyId ? scope.companyId : null;
  const positionId = typeof scope.positionId === 'string' && scope.positionId ? scope.positionId : null;
  if (type === 'global' && (companyId || positionId)) {
    throw new WorkflowError('INVALID_SCOPE', '全局字段不能携带公司或岗位作用域。');
  }
  if (type === 'company' && !companyId) throw new WorkflowError('INVALID_SCOPE', '公司作用域字段必须指定公司。');
  if (type === 'position' && (!companyId || !positionId)) {
    throw new WorkflowError('INVALID_SCOPE', '岗位作用域字段必须指定公司和岗位。');
  }
  if (!['global', 'company', 'position'].includes(type)) throw new WorkflowError('INVALID_SCOPE', '未知作用域类型。');
  return { type, companyId, positionId };
}

function normalizedSensitivity(section, sensitivity) {
  if (section === 'family') return 'family';
  return SENSITIVITY_LEVELS.includes(sensitivity) ? sensitivity : 'normal';
}

function normalizeFactInput(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new WorkflowError('INVALID_FACT', '字段资料必须是对象。');
  }
  const section = input.section || 'basic';
  if (!FACT_SECTIONS.includes(section)) throw new WorkflowError('INVALID_FACT', '未知资料分区。');
  const source = input.source;
  if (!source || typeof source !== 'object' || !SOURCE_TYPES.includes(source.type)) {
    throw new WorkflowError('SOURCE_REQUIRED', '字段资料必须保留来源类型，不能无来源确认。');
  }
  const label = typeof input.label === 'string' ? input.label : '';
  const value = typeof input.value === 'string' ? input.value : '';
  if (!label.trim() || !value.trim()) throw new WorkflowError('INVALID_FACT', '字段名和内容都不能为空。');
  const scope = normalizedScope(input.scope);
  const sensitivity = normalizedSensitivity(section, input.sensitivity);
  if (section === 'company_answer' && scope.type === 'global') {
    throw new WorkflowError('INVALID_SCOPE', '公司专属回答必须限定到公司或岗位。');
  }
  if (source.type === 'company_answer' && scope.type === 'global') {
    throw new WorkflowError('INVALID_SCOPE', '公司回答来源必须带公司作用域。');
  }
  const allowedPurposes = Array.isArray(input.allowedPurposes)
    ? [...new Set(input.allowedPurposes.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()))]
    : [];
  if (sensitivity !== 'normal' && !allowedPurposes.length) {
    throw new WorkflowError('PURPOSE_REQUIRED', '家庭/敏感字段必须声明允许的使用用途，默认不得读取。');
  }
  return {
    section,
    entityId: typeof input.entityId === 'string' && input.entityId.trim() ? input.entityId : null,
    label,
    value,
    source: { type: source.type, ref: typeof source.ref === 'string' ? source.ref : '' },
    scope,
    sensitivity,
    allowedPurposes,
  };
}

function scopeMatches(factScope, { companyId = null, positionId = null } = {}) {
  if (factScope.type === 'global') return true;
  if (factScope.type === 'company') return companyId === factScope.companyId;
  return companyId === factScope.companyId && positionId === factScope.positionId;
}

function isConfirmedCurrent(fact) {
  return Boolean(fact.confirmed && fact.confirmedVersion === fact.version);
}

function grantMatches(grant, fact, use) {
  if (!grant.factIds.includes(fact.id) || grant.purpose !== use.purpose) return false;
  if (grant.scope.type === 'company') return use.companyId === grant.scope.companyId;
  if (grant.scope.type === 'position') {
    return use.companyId === grant.scope.companyId && use.positionId === grant.scope.positionId;
  }
  return false;
}

export function validateProfileDocument(data) {
  validateSchema(data, profileDocumentSchema);
  const ids = new Set();
  for (const fact of data.facts) {
    if (ids.has(fact.id)) throw new WorkflowError('DUPLICATE_ID', `资料字段 ID 重复：${fact.id}`);
    ids.add(fact.id);
  }
  const grantIds = new Set();
  for (const grant of data.grants) {
    if (grantIds.has(grant.id)) throw new WorkflowError('DUPLICATE_ID', `敏感授权 ID 重复：${grant.id}`);
    grantIds.add(grant.id);
    for (const factId of grant.factIds) {
      if (!ids.has(factId)) throw new WorkflowError('INVALID_GRANT', `敏感授权引用了不存在的字段：${factId}`);
    }
  }
  return data;
}

export function createProfileStore({
  directory,
  privateRoot,
  fileName = 'profile.json',
  now = () => new Date().toISOString(),
  newId = () => crypto.randomUUID(),
} = {}) {
  if (!directory) throw new WorkflowError('PRIVATE_DIR_REQUIRED', '资料存储必须显式传入 private/ 下目录。');
  const file = new JsonFileStore({ directory, fileName, privateRoot, validate: validateProfileDocument });
  let data = null;
  let revision = 0;
  let ready = null;
  let byId = new Map();
  let tail = Promise.resolve();

  function index() {
    byId = new Map(data.facts.map(fact => [fact.id, fact]));
  }

  // 所有写操作从 ensure、查找、版本检查到保存完整串行化，避免并发回滚覆盖别人。
  function serial(task) {
    const next = tail.catch(() => {}).then(task);
    tail = next.catch(() => {});
    return next;
  }

  async function waitPendingWrites() {
    await tail.catch(() => {});
  }

  async function ensure() {
    if (data) return;
    if (!ready) {
      ready = (async () => {
        const loaded = await file.load();
        data = loaded.data || emptyProfile();
        revision = loaded.revision;
        validateProfileDocument(data);
        index();
      })();
    }
    await ready;
  }

  async function mutate(fn) {
    await ensure();
    const before = clone(data);
    const beforeRevision = revision;
    try {
      const result = fn(data);
      validateProfileDocument(data);
      const saved = await file.save(data, revision);
      revision = saved.revision;
      index();
      return result;
    } catch (error) {
      data = before;
      revision = beforeRevision;
      index();
      throw error;
    }
  }

  function canReadSensitive(fact, use = {}) {
    if (fact.sensitivity === 'normal') return true;
    if (!use.purpose || !fact.allowedPurposes.includes(use.purpose)) return false;
    return data.grants.some(grant => grantMatches(grant, fact, use));
  }

  async function createFact(input, context) {
    assertOperator(context, 'createFact');
    return serial(async () => {
      await ensure();
      const normalized = normalizeFactInput(input, now());
      if ([...byId.values()].some(fact => fact.section === normalized.section
        && fact.entityId === normalized.entityId
        && fact.label === normalized.label
        && fact.value === normalized.value
        && fact.scope.type === normalized.scope.type
        && fact.scope.companyId === normalized.scope.companyId
        && fact.scope.positionId === normalized.scope.positionId)) {
        throw new WorkflowError('DUPLICATE_FACT', '相同来源作用域的字段已存在；请修改原字段或明确区分。');
      }
      const time = now();
      const fact = {
        id: newId(),
        ...normalized,
        version: 1,
        confirmed: false,
        confirmedAt: null,
        confirmedVersion: null,
        history: [],
        createdAt: time,
        updatedAt: time,
      };
      validateSchema(fact, factSchema);
      await mutate(state => { state.facts.push(fact); });
      return clone(fact);
    });
  }

  async function reviseFact(factId, patch = {}, { expectedVersion } = {}, context) {
    assertOperator(context, 'reviseFact');
    return serial(async () => {
      await ensure();
      const fact = byId.get(factId);
      if (!fact) throw new WorkflowError('FACT_NOT_FOUND', '资料字段不存在。');
      if (expectedVersion !== fact.version) {
        throw new WorkflowError('PROFILE_VERSION_CONFLICT', `字段版本已变化（期望 ${expectedVersion}，实际 ${fact.version}）；未覆盖。`);
      }
      const allowedKeys = ['entityId', 'label', 'value', 'section', 'scope', 'sensitivity', 'allowedPurposes'];
      for (const key of Object.keys(patch)) {
        if (!allowedKeys.includes(key)) throw new WorkflowError('FIELD_PROTECTED', `字段属性 ${key} 不允许修改。`);
      }
      const merged = normalizeFactInput({ ...fact, ...patch, source: fact.source }, now());
      const historyEntry = {
        version: fact.version,
        entityId: fact.entityId ?? null,
        label: fact.label,
        value: fact.value,
        confirmed: fact.confirmed,
        confirmedAt: fact.confirmedAt,
        scope: clone(fact.scope),
        sensitivity: fact.sensitivity,
        allowedPurposes: [...fact.allowedPurposes],
        at: now(),
      };
      const revised = {
        ...fact,
        ...merged,
        version: fact.version + 1,
        confirmed: false,
        confirmedAt: null,
        confirmedVersion: null,
        history: [...fact.history, historyEntry].slice(-50),
        updatedAt: now(),
      };
      validateSchema(revised, factSchema);
      await mutate(state => {
        const index = state.facts.findIndex(item => item.id === factId);
        state.facts[index] = revised;
        // 内容修订后旧用途授权不再覆盖新版本；空授权直接移除，必须本人重新批准。
        const grants = [];
        for (const grant of state.grants) {
          if (!grant.factIds.includes(factId)) {
            grants.push(grant);
            continue;
          }
          grant.factIds = grant.factIds.filter(id => id !== factId);
          if (grant.factIds.length) grants.push(grant);
        }
        state.grants = grants;
      });
      return clone(revised);
    });
  }

  async function reviseFacts(changes = [], context) {
    assertOperator(context, 'reviseFacts');
    return serial(async () => {
      await ensure();
      if (!Array.isArray(changes) || changes.length === 0) {
        throw new WorkflowError('INVALID_FACT', '至少需要一个资料字段修改。');
      }
      const seen = new Set();
      const revisedFacts = [];
      for (const change of changes) {
        if (!change || typeof change !== 'object' || Array.isArray(change)) {
          throw new WorkflowError('INVALID_FACT', '资料字段修改必须是对象。');
        }
        const factId = change.factId;
        if (typeof factId !== 'string' || !factId || seen.has(factId)) {
          throw new WorkflowError('INVALID_FACT', '资料字段修改必须使用不重复的 factId。');
        }
        seen.add(factId);
        const fact = byId.get(factId);
        if (!fact) throw new WorkflowError('FACT_NOT_FOUND', '资料字段不存在。');
        if (change.expectedVersion !== fact.version) {
          throw new WorkflowError('PROFILE_VERSION_CONFLICT', `字段版本已变化（期望 ${change.expectedVersion}，实际 ${fact.version}）；未覆盖。`);
        }
        const patch = change.patch && typeof change.patch === 'object' && !Array.isArray(change.patch)
          ? change.patch
          : {};
        const allowedKeys = ['entityId', 'label', 'value', 'section', 'scope', 'sensitivity', 'allowedPurposes'];
        for (const key of Object.keys(patch)) {
          if (!allowedKeys.includes(key)) throw new WorkflowError('FIELD_PROTECTED', `字段属性 ${key} 不允许修改。`);
        }
        const merged = normalizeFactInput({ ...fact, ...patch, source: fact.source }, now());
        const historyEntry = {
          version: fact.version,
          entityId: fact.entityId ?? null,
          label: fact.label,
          value: fact.value,
          confirmed: fact.confirmed,
          confirmedAt: fact.confirmedAt,
          scope: clone(fact.scope),
          sensitivity: fact.sensitivity,
          allowedPurposes: [...fact.allowedPurposes],
          at: now(),
        };
        const revised = {
          ...fact,
          ...merged,
          version: fact.version + 1,
          confirmed: false,
          confirmedAt: null,
          confirmedVersion: null,
          history: [...fact.history, historyEntry].slice(-50),
          updatedAt: now(),
        };
        validateSchema(revised, factSchema);
        revisedFacts.push(revised);
      }
      await mutate(state => {
        for (const revised of revisedFacts) {
          const index = state.facts.findIndex(item => item.id === revised.id);
          state.facts[index] = revised;
          // Content revisions revoke every grant that included the changed fact.
          const grants = [];
          for (const grant of state.grants) {
            if (!grant.factIds.includes(revised.id)) {
              grants.push(grant);
              continue;
            }
            grant.factIds = grant.factIds.filter(id => id !== revised.id);
            if (grant.factIds.length) grants.push(grant);
          }
          state.grants = grants;
        }
      });
      return clone(revisedFacts);
    });
  }

  async function confirmFact(factId, { expectedVersion } = {}, context) {
    assertOperator(context, 'confirmFact');
    return serial(async () => {
      await ensure();
      const fact = byId.get(factId);
      if (!fact) throw new WorkflowError('FACT_NOT_FOUND', '资料字段不存在。');
      if (expectedVersion !== fact.version) {
        throw new WorkflowError('PROFILE_VERSION_CONFLICT', `字段版本已变化（期望 ${expectedVersion}，实际 ${fact.version}）；未确认。`);
      }
      if (fact.confirmed && fact.confirmedVersion === fact.version) return clone(fact);
      const confirmed = {
        ...fact,
        confirmed: true,
        confirmedAt: now(),
        confirmedVersion: fact.version,
        updatedAt: now(),
      };
      validateSchema(confirmed, factSchema);
      await mutate(state => {
        const index = state.facts.findIndex(item => item.id === factId);
        state.facts[index] = confirmed;
      });
      return clone(confirmed);
    });
  }

  async function confirmFacts(confirmations = [], context) {
    assertOperator(context, 'confirmFacts');
    return serial(async () => {
      await ensure();
      if (!Array.isArray(confirmations) || confirmations.length === 0) {
        throw new WorkflowError('INVALID_FACT', '至少需要确认一个资料字段。');
      }
      const seen = new Set();
      const confirmedFacts = [];
      for (const confirmation of confirmations) {
        if (!confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation)) {
          throw new WorkflowError('INVALID_FACT', '资料确认必须是对象。');
        }
        const factId = confirmation.factId;
        if (typeof factId !== 'string' || !factId || seen.has(factId)) {
          throw new WorkflowError('INVALID_FACT', '资料确认必须使用不重复的 factId。');
        }
        seen.add(factId);
        const fact = byId.get(factId);
        if (!fact) throw new WorkflowError('FACT_NOT_FOUND', '资料字段不存在。');
        if (confirmation.expectedVersion !== fact.version) {
          throw new WorkflowError('PROFILE_VERSION_CONFLICT', `字段版本已变化（期望 ${confirmation.expectedVersion}，实际 ${fact.version}）；未确认。`);
        }
        const confirmed = {
          ...fact,
          confirmed: true,
          confirmedAt: now(),
          confirmedVersion: fact.version,
          updatedAt: now(),
        };
        validateSchema(confirmed, factSchema);
        confirmedFacts.push(confirmed);
      }
      await mutate(state => {
        for (const confirmed of confirmedFacts) {
          const index = state.facts.findIndex(item => item.id === confirmed.id);
          state.facts[index] = confirmed;
        }
      });
      return clone(confirmedFacts);
    });
  }

  async function grantSensitiveUse(input, context) {
    assertOperator(context, 'grantSensitiveUse');
    assertHumanConfirmation(input, '授权敏感资料用途');
    return serial(async () => {
      await ensure();
      const factIds = [...new Set(Array.isArray(input.factIds) ? input.factIds : [])];
      if (!factIds.length) throw new WorkflowError('INVALID_GRANT', '至少选择一个字段。');
      const purpose = typeof input.purpose === 'string' ? input.purpose.trim() : '';
      if (!purpose) throw new WorkflowError('INVALID_GRANT', '必须说明该敏感用途。');
      const scope = normalizedScope(input.scope);
      if (scope.type === 'global') throw new WorkflowError('INVALID_GRANT', '敏感用途授权必须限定公司与岗位，不能使用全局授权。');
      for (const factId of factIds) {
        const fact = byId.get(factId);
        if (!fact) throw new WorkflowError('FACT_NOT_FOUND', `资料字段不存在：${factId}`);
        if (fact.sensitivity === 'normal') throw new WorkflowError('INVALID_GRANT', `字段「${fact.label}」不是敏感字段，无需敏感授权。`);
        if (!fact.allowedPurposes.includes(purpose)) {
          throw new WorkflowError('INVALID_GRANT', `字段「${fact.label}」未声明用途 ${purpose}。`);
        }
        if (!scopeMatches(fact.scope, scope)) {
          throw new WorkflowError('INVALID_GRANT', `字段「${fact.label}」的作用域与授权范围不一致。`);
        }
      }
      const existing = data.grants.find(grant => grant.purpose === purpose
        && grant.scope.type === scope.type
        && grant.scope.companyId === scope.companyId
        && grant.scope.positionId === scope.positionId
        && factIds.every(id => grant.factIds.includes(id)));
      if (existing) return clone(existing);
      const grant = {
        id: newId(),
        factIds,
        purpose,
        scope,
        grantedAt: now(),
        grantedBy: 'user',
      };
      validateSchema(grant, grantSchema);
      await mutate(state => { state.grants.push(grant); });
      return clone(grant);
    });
  }

  async function queryFacts(filter = {}, context = { actor: 'agent' }) {
    if (context.actor !== 'agent' && context.actor !== 'operator') {
      throw new WorkflowError('FORBIDDEN', '查询资料需要明确操作者。');
    }
    await waitPendingWrites();
    await ensure();
    const ids = Array.isArray(filter.ids) ? new Set(filter.ids) : null;
    const includeUnconfirmed = context.actor === 'operator' && filter.includeUnconfirmed === true;
    const use = {
      companyId: filter.companyId || null,
      positionId: filter.positionId || null,
      purpose: filter.purpose || null,
    };
    return [...byId.values()]
      .filter(fact => !ids || ids.has(fact.id))
      .filter(fact => !filter.section || fact.section === filter.section)
      .filter(fact => !filter.entityId || fact.entityId === filter.entityId)
      .filter(fact => !filter.label || fact.label === filter.label)
      .filter(fact => includeUnconfirmed || isConfirmedCurrent(fact))
      .filter(fact => scopeMatches(fact.scope, use))
      .filter(fact => canReadSensitive(fact, use))
      .map(clone);
  }

  async function getFact(factId, use = {}, context = { actor: 'agent' }) {
    if (context.actor !== 'agent' && context.actor !== 'operator') {
      throw new WorkflowError('FORBIDDEN', '查询资料需要明确操作者。');
    }
    await waitPendingWrites();
    await ensure();
    const fact = byId.get(factId);
    if (!fact) return null;
    if (!isConfirmedCurrent(fact)) throw new WorkflowError('NOT_CONFIRMED', '该字段尚未确认当前版本。');
    if (!scopeMatches(fact.scope, use)) {
      throw new WorkflowError('SCOPE_MISMATCH', '该字段不属于当前公司或岗位作用域。');
    }
    if (fact.sensitivity !== 'normal') {
      if (!use.purpose || !fact.allowedPurposes.includes(use.purpose) || !data.grants.some(grant => grantMatches(grant, fact, use))) {
        throw new WorkflowError('SENSITIVE_AUTH_REQUIRED', `字段「${fact.label}」缺少本用途的敏感信息授权。`);
      }
    }
    return clone(fact);
  }

  async function getFactForLocalEdit(factId, context) {
    assertOperator(context, 'getFactForLocalEdit');
    await waitPendingWrites();
    await ensure();
    const fact = byId.get(factId);
    return fact ? clone(fact) : null;
  }

  async function listFactsForLocalEdit(context) {
    assertOperator(context, 'listFactsForLocalEdit');
    await waitPendingWrites();
    await ensure();
    return [...byId.values()].map(clone);
  }

  async function getFactForFill(factId, use = {}, context = { actor: 'agent' }) {
    if (context.actor !== 'agent' && context.actor !== 'operator') {
      throw new WorkflowError('FORBIDDEN', '查询资料需要明确操作者。');
    }
    await waitPendingWrites();
    await ensure();
    const fact = byId.get(factId);
    if (!fact) throw new WorkflowError('FACT_NOT_FOUND', '资料字段不存在。');
    if (!isConfirmedCurrent(fact)) throw new WorkflowError('NOT_CONFIRMED', `字段「${fact.label}」尚未人工确认，不能用于填写。`);
    if (!scopeMatches(fact.scope, use)) {
      throw new WorkflowError('SCOPE_MISMATCH', `字段「${fact.label}」不属于当前公司或岗位，禁止跨作用域复用。`);
    }
    if (fact.sensitivity !== 'normal') {
      if (!use.purpose) throw new WorkflowError('SENSITIVE_AUTH_REQUIRED', `字段「${fact.label}」属于家庭/敏感信息，必须说明当前用途。`);
      if (!fact.allowedPurposes.includes(use.purpose)) {
        throw new WorkflowError('SENSITIVE_AUTH_REQUIRED', `字段「${fact.label}」未授权用于 ${use.purpose}。`);
      }
      if (!data.grants.some(grant => grantMatches(grant, fact, use))) {
        throw new WorkflowError('SENSITIVE_AUTH_REQUIRED', `字段「${fact.label}」缺少本人针对该用途的授权。`);
      }
    }
    return clone(fact);
  }

  async function revisionInfo() {
    await waitPendingWrites();
    await ensure();
    return revision;
  }

  return {
    createFact,
    reviseFact,
    reviseFacts,
    confirmFact,
    confirmFacts,
    grantSensitiveUse,
    queryFacts,
    getFact,
    getFactForLocalEdit,
    listFactsForLocalEdit,
    getFactForFill,
    revision: revisionInfo,
  };
}
