// 本地编排服务：固定状态机、公司顺序队列、岗位台账、问题队列与私有资料。
// 模型通过 tools.js 的严格白名单调用；提交、登录和终审由本人操作入口执行。

import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { JsonFileStore, createStoreValidator } from './store.js';
import { validateSchema } from './validation.js';
import {
  WORKFLOW_VERSION,
  COMPANY_STATUS,
  POSITION_STATUS,
  QUEUE_STATUS,
  WorkflowError,
  assertAgentOrOperator,
  assertCompanyTransition,
  assertHumanConfirmation,
  assertOperator,
  assertPositionTransition,
  assertQueueTransition,
  blocksResubmission,
  isCompanyTerminal,
  isPositionTerminal,
} from './workflow.js';
import {
  canonicalLinkHint,
  companyIdentityKey,
  companyResultText,
  companySchema,
  createCompany,
  createPosition,
  findApplicationDuplicate,
  historicalSubmissionSchema,
  noPositionsEvidenceSchema,
  normalizeOfficialId,
  positionSchema,
  positionPreventsResubmission,
  selectedPositions,
  submissionSchema,
  verificationSchema,
} from './records.js';
import { createQueue, nextQueuedCompany, prioritizeQueuedCompany, queueSchema } from './queue.js';
import {
  ISSUE_STATUSES,
  ISSUE_TYPES,
  createIssue,
  groupIssues,
  issueSchema,
  issueKey,
  openBlockingIssues,
} from './issues.js';
import { createProfileStore, profileDocumentSchema } from './profile-store.js';

export const RUNTIME_SCHEMA_VERSION = 'application-copilot.runtime.v1';

const eventSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'at', 'companyId', 'digest'],
  properties: {
    id: { type: 'string', minLength: 1 },
    type: { type: 'string', minLength: 1, maxLength: 100 },
    at: { type: 'string', minLength: 1 },
    companyId: { type: ['string', 'null'] },
    // 只保存规范化请求指纹，不保存岗位名、回答、链接等完整载荷。
    digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  },
});

const checkpointSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['at', 'currentCompanyId', 'activePositionId', 'requiresObservation', 'note'],
  properties: {
    at: { type: ['string', 'null'] },
    currentCompanyId: { type: ['string', 'null'] },
    activePositionId: { type: ['string', 'null'] },
    requiresObservation: { type: 'boolean' },
    note: { type: 'string', maxLength: 500 },
  },
});

export const runtimeDocumentSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'workflowVersion', 'queue', 'companies', 'positions', 'issues', 'events', 'checkpoint'],
  properties: {
    schemaVersion: { const: RUNTIME_SCHEMA_VERSION },
    workflowVersion: { const: WORKFLOW_VERSION },
    queue: queueSchema,
    companies: { type: 'array', items: companySchema, maxItems: 5000 },
    positions: { type: 'array', items: positionSchema, maxItems: 20000 },
    issues: { type: 'array', items: issueSchema, maxItems: 50000 },
    events: { type: 'array', items: eventSchema, maxItems: 5000 },
    checkpoint: checkpointSchema,
  },
});

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
  }
  return value;
}

function requestDigest(payload) {
  return createHash('sha256').update(JSON.stringify(canonicalValue(payload ?? {}))).digest('hex');
}

function emptyRuntime(now) {
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    workflowVersion: WORKFLOW_VERSION,
    queue: createQueue(now),
    companies: [],
    positions: [],
    issues: [],
    events: [],
    checkpoint: {
      at: null,
      currentCompanyId: null,
      activePositionId: null,
      requiresObservation: false,
      note: '尚未开始。',
    },
  };
}

function uniqueIds(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw new WorkflowError('DUPLICATE_ID', `${label} ID 重复：${item.id}`);
    seen.add(item.id);
  }
}

export function validateRuntimeDocument(data) {
  validateSchema(data, runtimeDocumentSchema);
  uniqueIds(data.companies, '公司');
  uniqueIds(data.positions, '岗位');
  uniqueIds(data.issues, '问题');
  uniqueIds(data.events, '事件');
  const companyIds = new Set(data.companies.map(company => company.id));
  const positionById = new Map(data.positions.map(position => [position.id, position]));
  if (data.queue.currentCompanyId && !companyIds.has(data.queue.currentCompanyId)) {
    throw new WorkflowError('INVALID_STATE', '队列当前公司不存在。');
  }
  for (const company of data.companies) {
    if (company.status === COMPANY_STATUS.NO_POSITIONS && !company.noPositionsEvidence) {
      throw new WorkflowError('INVALID_STATE', `公司「${company.name}」标记无岗位但缺少证据。`);
    }
    if (new Set(company.selectedPositionIds).size !== company.selectedPositionIds.length) {
      throw new WorkflowError('INVALID_STATE', `公司「${company.name}」有重复的已选岗位。`);
    }
    for (const positionId of company.selectedPositionIds) {
      const position = positionById.get(positionId);
      if (!position || position.companyId !== company.id) {
        throw new WorkflowError('INVALID_STATE', `公司「${company.name}」引用了不存在或他人的岗位。`);
      }
    }
    if (company.activePositionId) {
      const position = positionById.get(company.activePositionId);
      if (!position || position.companyId !== company.id || !company.selectedPositionIds.includes(position.id)) {
        throw new WorkflowError('INVALID_STATE', `公司「${company.name}」的活动岗位无效。`);
      }
    }
  }
  for (const position of data.positions) {
    if (!companyIds.has(position.companyId)) {
      throw new WorkflowError('INVALID_STATE', `岗位「${position.title}」属于不存在的公司。`);
    }
  }
  for (const issue of data.issues) {
    if (!companyIds.has(issue.companyId)) throw new WorkflowError('INVALID_STATE', '问题引用了不存在的公司。');
    if (issue.positionId) {
      const position = positionById.get(issue.positionId);
      if (!position || position.companyId !== issue.companyId) {
        throw new WorkflowError('INVALID_STATE', '问题引用了不存在或他人的岗位。');
      }
    }
  }
  return data;
}

function transitionCompany(company, to, event, now) {
  if (company.status === to) return;
  assertCompanyTransition(company.status, to);
  const from = company.status;
  company.history = [...company.history, { at: now, from, to, event }].slice(-80);
  company.status = to;
  company.updatedAt = now;
  company.checkpoint = {
    ...company.checkpoint,
    phase: to,
    activePositionId: company.activePositionId,
    requiresObservation: [
      COMPANY_STATUS.PREPARING,
      COMPANY_STATUS.AWAITING_ISSUE_ANSWERS,
      COMPANY_STATUS.AWAITING_HUMAN_SUBMIT,
    ].includes(to),
    updatedAt: now,
  };
}

function transitionPosition(position, to, event, now) {
  if (position.status === to) return;
  assertPositionTransition(position.status, to);
  const from = position.status;
  position.history = [...position.history, { at: now, from, to, event }].slice(-80);
  position.status = to;
  position.updatedAt = now;
}

function requireCurrentCompany(state, companyId) {
  if (state.queue.currentCompanyId !== companyId) {
    throw new WorkflowError('NOT_ACTIVE_COMPANY', '该操作只能针对队列当前活动公司。');
  }
}

function requireQueueRunning(state, operation = '该业务操作') {
  if (state.queue.status !== QUEUE_STATUS.RUNNING) {
    throw new WorkflowError('QUEUE_NOT_RUNNING', `队列未运行（当前 ${state.queue.status}），${operation}已暂停；真实提交回执和只读官网核验除外。`);
  }
}

function requireEventId(input, operation) {
  if (typeof input?.eventId !== 'string' || !input.eventId.trim()) {
    throw new WorkflowError('EVENT_ID_REQUIRED', `${operation} 必须携带幂等事件 ID。`);
  }
}

function normalizeLinks(links = []) {
  return links.map(link => {
    if (!link || typeof link.url !== 'string' || !/^https?:\/\//i.test(link.url)) {
      throw new WorkflowError('INVALID_LINK', '公司链接必须是 http(s) 地址。');
    }
    return {
      url: link.url,
      kind: ['apply', 'job', 'referral', 'other'].includes(link.kind) ? link.kind : 'apply',
      source: typeof link.source === 'string' ? link.source : '',
    };
  });
}

function normalizeReferralCandidates(candidates = []) {
  return candidates.map(candidate => {
    if (!candidate || typeof candidate.value !== 'string' || !candidate.value.trim()) {
      throw new WorkflowError('INVALID_REFERRAL', '内推候选必须有值。');
    }
    return { value: candidate.value, source: typeof candidate.source === 'string' ? candidate.source : '' };
  });
}

function normalizePositionCandidate(input) {
  if (!input || typeof input !== 'object') throw new WorkflowError('INVALID_POSITION', '岗位候选必须是对象。');
  if (typeof input.officialId !== 'string' || !input.officialId.trim()) {
    throw new WorkflowError('INVALID_POSITION', '岗位必须有官方岗位 ID。');
  }
  if (typeof input.title !== 'string' || !input.title.trim()) {
    throw new WorkflowError('INVALID_POSITION', '岗位必须有名称。');
  }
  if (typeof input.sourceUrl !== 'string' || !/^https?:\/\//i.test(input.sourceUrl)) {
    throw new WorkflowError('INVALID_POSITION', '岗位必须保留官方来源链接。');
  }
  if (typeof input.checkedAt !== 'string' || Number.isNaN(Date.parse(input.checkedAt))) {
    throw new WorkflowError('INVALID_POSITION', '岗位必须有有效的查询时间。');
  }
  if (typeof input.matchEvidence !== 'string' || !input.matchEvidence.trim()) {
    throw new WorkflowError('INVALID_POSITION', '岗位候选必须提供匹配依据。');
  }
  return {
    officialId: input.officialId,
    title: input.title,
    city: typeof input.city === 'string' ? input.city : '',
    source: { url: input.sourceUrl, checkedAt: input.checkedAt, evidence: input.matchEvidence },
  };
}

export function createWorkbenchService({
  directory,
  privateRoot,
  profileDirectory = null,
  runtimeFileName = 'runtime.json',
  profileFileName = 'profile.json',
  now = () => new Date().toISOString(),
  newId = () => randomUUID(),
} = {}) {
  if (!directory) {
    throw new WorkflowError('PRIVATE_DIR_REQUIRED', '必须显式传入本项目 private/ 下的运行目录。');
  }
  const runtimeFile = new JsonFileStore({
    directory,
    fileName: runtimeFileName,
    privateRoot,
    validate: createStoreValidator(runtimeDocumentSchema),
  });
  const resolvedProfileDirectory = profileDirectory || path.join(runtimeFile.directory, 'profile');
  const profile = createProfileStore({
    directory: resolvedProfileDirectory,
    privateRoot,
    fileName: profileFileName,
    now,
    newId,
  });

  let state = null;
  let revision = 0;
  let ready = null;
  let tail = Promise.resolve();
  let recoveryPending = false;

  async function ensure() {
    if (state) return;
    if (!ready) {
      ready = (async () => {
        const loaded = await runtimeFile.load();
        state = loaded.data || emptyRuntime(now());
        revision = loaded.revision;
        validateRuntimeDocument(state);
        // 重启后现场可能已变化。字段写入尚未实现；浏览器写入接入前，
        // 准备/复核阶段的 agent 写操作必须等本人确认已重新观察页面。
        recoveryPending = Boolean(loaded.exists && state.checkpoint.requiresObservation);
      })();
    }
    await ready;
  }

  function serial(task) {
    const next = tail.catch(() => {}).then(task);
    tail = next.catch(() => {});
    return next;
  }

  function currentCompanyRecord() {
    return state.companies.find(company => company.id === state.queue.currentCompanyId) || null;
  }

  function requireAgentWritableActive(context, {
    companyId,
    statuses,
    positionId = null,
    requireActivePosition = false,
    operation,
  }) {
    assertAgentOrOperator(context, operation);
    if (recoveryPending) {
      throw new WorkflowError('RECOVERY_OBSERVATION_REQUIRED', '服务重启后需要本人确认已重新观察页面，模型不能直接继续写入。');
    }
    requireQueueRunning(state, operation);
    requireCurrentCompany(state, companyId);
    const company = findCompany(companyId);
    if (!statuses.includes(company.status)) {
      throw new WorkflowError('WRONG_COMPANY_STAGE', `公司当前阶段为 ${company.status}，不允许${operation}。`);
    }
    if (requireActivePosition) {
      if (!positionId || company.activePositionId !== positionId) {
        throw new WorkflowError('NOT_ACTIVE_POSITION', '该操作只能针对当前活动岗位。');
      }
    } else if (positionId && company.activePositionId !== positionId) {
      throw new WorkflowError('NOT_ACTIVE_POSITION', '问题只能挂到当前活动岗位；历史岗位不能由模型改写。');
    }
    return company;
  }

  function updateCheckpoint() {
    const company = currentCompanyRecord();
    state.checkpoint = {
      at: now(),
      currentCompanyId: state.queue.currentCompanyId,
      activePositionId: company?.activePositionId || null,
      requiresObservation: Boolean(company && [
        COMPANY_STATUS.PREPARING,
        COMPANY_STATUS.AWAITING_ISSUE_ANSWERS,
        COMPANY_STATUS.AWAITING_HUMAN_SUBMIT,
      ].includes(company.status)),
      note: company ? `当前公司：${company.name}（${company.status}）` : '队列没有活动公司。',
    };
  }

  function advanceQueue() {
    if (state.queue.status !== QUEUE_STATUS.RUNNING) return false;
    const current = currentCompanyRecord();
    if (current && !isCompanyTerminal(current.status) && current.status !== COMPANY_STATUS.HELD) {
      return false;
    }
    if (current && current.status === COMPANY_STATUS.HELD) {
      // 明确暂挂后允许先处理下一家；当前公司状态保留 held，不标完成。
    }
    const next = nextQueuedCompany(state.companies);
    if (!next) {
      if (state.queue.status === QUEUE_STATUS.RUNNING) {
        assertQueueTransition(state.queue.status, QUEUE_STATUS.DRAINED);
        state.queue.status = QUEUE_STATUS.DRAINED;
        state.queue.currentCompanyId = null;
        state.queue.updatedAt = now();
      }
      return false;
    }
    transitionCompany(next, COMPANY_STATUS.AWAITING_LOGIN, 'queue_start_company', now());
    state.queue.currentCompanyId = next.id;
    state.queue.updatedAt = now();
    return true;
  }

  function recordEvent(eventId, type, companyId, digest) {
    if (!eventId) return;
    state.events = [...state.events, { id: eventId, type, at: now(), companyId, digest }].slice(-5000);
  }

  function findEvent(eventId) {
    return eventId ? state.events.find(event => event.id === eventId) || null : null;
  }

  function duplicateResponse(eventId) {
    return {
      duplicate: true,
      eventId,
      queue: clone(state.queue),
      checkpoint: clone(state.checkpoint),
    };
  }

  async function mutate({ eventId = null, type = 'mutation', companyId = null, fingerprint = null } = {}, fn) {
    await ensure();
    const digest = eventId ? requestDigest(fingerprint) : null;
    const previousEvent = findEvent(eventId);
    if (previousEvent) {
      if (previousEvent.type !== type || previousEvent.companyId !== companyId) {
        throw new WorkflowError('EVENT_ID_REUSED', '同一幂等事件 ID 被用于不同操作；拒绝执行。');
      }
      if (previousEvent.digest !== digest) {
        throw new WorkflowError('EVENT_ID_PAYLOAD_MISMATCH', '同一幂等事件 ID 的岗位或关键参数不一致；拒绝把不同请求当作重复成功。');
      }
      return duplicateResponse(eventId);
    }
    const before = clone(state);
    const beforeRevision = revision;
    try {
      const result = fn(state);
      recordEvent(eventId, type, companyId, digest);
      updateCheckpoint();
      validateRuntimeDocument(state);
      const saved = await runtimeFile.save(state, revision);
      revision = saved.revision;
      return { duplicate: false, ...result };
    } catch (error) {
      state = before;
      revision = beforeRevision;
      throw error;
    }
  }

  function findCompany(companyId) {
    const company = state.companies.find(item => item.id === companyId);
    if (!company) throw new WorkflowError('COMPANY_NOT_FOUND', '公司任务不存在。');
    return company;
  }

  function findPosition(positionId) {
    const position = state.positions.find(item => item.id === positionId);
    if (!position) throw new WorkflowError('POSITION_NOT_FOUND', '岗位不存在。');
    return position;
  }

  function selectedFor(company) {
    return selectedPositions(company, state.positions);
  }

  function syncCompanyAfterPosition(company) {
    const blocking = openBlockingIssues(state.issues, company.id).length;
    const selected = selectedFor(company);
    const allTerminal = selected.length > 0 && selected.every(position => isPositionTerminal(position.status));
    if (allTerminal && blocking === 0) {
      company.activePositionId = null;
      if (!isCompanyTerminal(company.status)) {
        transitionCompany(company, COMPANY_STATUS.COMPLETED, 'all_selected_positions_terminal', now());
      }
      company.checkpoint = {
        ...company.checkpoint,
        activePositionId: null,
        requiresObservation: false,
        updatedAt: now(),
      };
      // 只有当前公司结束才推进队列；历史范围修正不得带动另一家活动公司。
      if (state.queue.currentCompanyId === company.id) advanceQueue();
      return;
    }
    if (allTerminal && blocking > 0) {
      if (company.status !== COMPANY_STATUS.AWAITING_ISSUE_ANSWERS
        && (company.status === COMPANY_STATUS.PREPARING || company.status === COMPANY_STATUS.AWAITING_HUMAN_SUBMIT)) {
        transitionCompany(company, COMPANY_STATUS.AWAITING_ISSUE_ANSWERS, 'blocking_issue_remains', now());
      }
      return;
    }
    const next = selected.find(position => !isPositionTerminal(position.status));
    if (!next) return;
    company.activePositionId = next.id;
    if (next.status === POSITION_STATUS.SELECTED) {
      transitionPosition(next, POSITION_STATUS.PREPARING, 'next_selected_position', now());
    }
    if (next.status === POSITION_STATUS.AWAITING_ISSUE_ANSWERS) {
      if ([COMPANY_STATUS.PREPARING, COMPANY_STATUS.AWAITING_HUMAN_SUBMIT].includes(company.status)) {
        transitionCompany(company, COMPANY_STATUS.AWAITING_ISSUE_ANSWERS, 'position_issue_waiting', now());
      }
      return;
    }
    if (company.status === COMPANY_STATUS.AWAITING_HUMAN_SUBMIT
      || company.status === COMPANY_STATUS.AWAITING_ISSUE_ANSWERS) {
      transitionCompany(company, COMPANY_STATUS.PREPARING, 'next_position_continues', now());
    }
    company.checkpoint = {
      ...company.checkpoint,
      activePositionId: company.activePositionId,
      requiresObservation: true,
      updatedAt: now(),
    };
  }

  function maybeResolveIssues(company) {
    if (company.status !== COMPANY_STATUS.AWAITING_ISSUE_ANSWERS) return;
    if (openBlockingIssues(state.issues, company.id).length) return;
    const active = company.activePositionId ? state.positions.find(item => item.id === company.activePositionId) : null;
    if (active?.status === POSITION_STATUS.AWAITING_ISSUE_ANSWERS) {
      transitionPosition(active, POSITION_STATUS.PREPARING, 'issues_resolved', now());
    }
    const blockedPosition = selectedFor(company).find(position => position.status === POSITION_STATUS.AWAITING_ISSUE_ANSWERS);
    if (blockedPosition) return;
    transitionCompany(company, COMPANY_STATUS.PREPARING, 'issues_resolved', now());
  }

  async function addCompany(input, context) {
    assertOperator(context, 'addCompany');
    const name = typeof input?.name === 'string' ? input.name : '';
    const batch = typeof input?.batch === 'string' ? input.batch : '';
    if (!name.trim()) throw new WorkflowError('INVALID_COMPANY', '公司名不能为空。');
    const identityKey = companyIdentityKey(name, batch);
    return serial(() => mutate({ type: 'add_company' }, local => {
      const links = normalizeLinks(Array.isArray(input.links) ? input.links : []);
      const referralCandidates = normalizeReferralCandidates(Array.isArray(input.referralCandidates) ? input.referralCandidates : []);
      const existing = local.companies.find(company => (company.identityKey || companyIdentityKey(company.name, company.batch)) === identityKey);
      if (existing) {
        const linksAdded = [];
        for (const link of links) {
          if (existing.links.some(item => item.url === link.url && item.source === link.source && item.kind === link.kind)) continue;
          existing.links.push(link);
          linksAdded.push(link);
        }
        const referralsAdded = [];
        for (const candidate of referralCandidates) {
          if (existing.referralCandidates.some(item => item.value === candidate.value && item.source === candidate.source)) continue;
          existing.referralCandidates.push(candidate);
          referralsAdded.push(candidate);
        }
        existing.updatedAt = now();
        return {
          company: clone(existing),
          duplicate: true,
          identityKey,
          canonicalLinks: existing.links.map(link => canonicalLinkHint(link.url)),
          merged: {
            linksAdded: linksAdded.map(clone),
            referralCandidatesAdded: referralsAdded.map(clone),
          },
          queue: clone(local.queue),
        };
      }
      const queueOrder = local.companies.reduce((max, company) => Math.max(max, company.queueOrder), 0) + 1;
      const company = createCompany({
        id: newId(),
        name,
        batch,
        links,
        referralCandidates,
        queueOrder,
        now: now(),
      });
      local.companies.push(company);
      return {
        company: clone(company),
        duplicate: false,
        identityKey,
        canonicalLinks: company.links.map(link => canonicalLinkHint(link.url)),
        merged: { linksAdded: [], referralCandidatesAdded: [] },
        queue: clone(local.queue),
      };
    }));
  }

  async function startQueue(input, context) {
    assertOperator(context, 'startQueue');
    assertHumanConfirmation(input, '启动队列');
    requireEventId(input, '启动队列');
    return serial(() => mutate({
      eventId: input.eventId,
      type: 'start_queue',
      fingerprint: { confirmedBy: input.confirmedBy },
    }, local => {
      if (local.queue.status === QUEUE_STATUS.RUNNING) throw new WorkflowError('QUEUE_ALREADY_RUNNING', '队列已经在运行。');
      if (local.queue.status === QUEUE_STATUS.PAUSED) throw new WorkflowError('QUEUE_PAUSED', '队列已暂停，请使用恢复。');
      assertQueueTransition(local.queue.status, QUEUE_STATUS.RUNNING);
      local.queue.status = QUEUE_STATUS.RUNNING;
      local.queue.startedAt = local.queue.startedAt || now();
      local.queue.pausedAt = null;
      local.queue.updatedAt = now();
      advanceQueue();
      return { queue: clone(local.queue), currentCompanyId: local.queue.currentCompanyId };
    }));
  }

  async function pauseQueue(context) {
    assertOperator(context, 'pauseQueue');
    return serial(async () => {
      await ensure();
      if (state.queue.status === QUEUE_STATUS.PAUSED) {
        return { duplicate: false, idempotent: true, queue: clone(state.queue) };
      }
      return mutate({ type: 'pause_queue' }, local => {
        if (local.queue.status !== QUEUE_STATUS.RUNNING) throw new WorkflowError('QUEUE_NOT_RUNNING', '只有运行中的队列可以暂停。');
        assertQueueTransition(local.queue.status, QUEUE_STATUS.PAUSED);
        local.queue.status = QUEUE_STATUS.PAUSED;
        local.queue.pausedAt = now();
        local.queue.updatedAt = now();
        return { queue: clone(local.queue) };
      });
    });
  }

  async function resumeQueue(context) {
    assertOperator(context, 'resumeQueue');
    return serial(async () => {
      await ensure();
      if (state.queue.status === QUEUE_STATUS.RUNNING) {
        return { duplicate: false, idempotent: true, queue: clone(state.queue) };
      }
      return mutate({ type: 'resume_queue' }, local => {
        if (local.queue.status !== QUEUE_STATUS.PAUSED) throw new WorkflowError('QUEUE_NOT_PAUSED', '队列当前不处于暂停状态。');
        assertQueueTransition(local.queue.status, QUEUE_STATUS.RUNNING);
        local.queue.status = QUEUE_STATUS.RUNNING;
        local.queue.pausedAt = null;
        local.queue.updatedAt = now();
        advanceQueue();
        return { queue: clone(local.queue), currentCompanyId: local.queue.currentCompanyId };
      });
    });
  }

  async function prioritizeCompany(input, context) {
    assertOperator(context, 'prioritizeCompany');
    const companyId = input?.companyId;
    return serial(() => mutate({ type: 'prioritize_company', companyId }, local => {
      if (![QUEUE_STATUS.IDLE, QUEUE_STATUS.PAUSED].includes(local.queue.status)) {
        throw new WorkflowError('QUEUE_NOT_REORDERABLE', '只有未开始或已暂停的队列可以调整公司优先级。');
      }
      const company = findCompany(companyId);
      if (company.status !== COMPANY_STATUS.QUEUED) {
        throw new WorkflowError('COMPANY_NOT_QUEUED', '只有尚未开始的公司可以调整优先级。');
      }
      const changed = prioritizeQueuedCompany(local.companies, company.id);
      return {
        company: clone(company),
        queue: clone(local.queue),
        idempotent: !changed,
      };
    }));
  }

  async function holdCompany(input, context) {
    assertOperator(context, 'holdCompany');
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
    if (!reason) throw new WorkflowError('REASON_REQUIRED', '暂挂必须说明原因。');
    return serial(() => mutate({ type: 'hold_company', companyId: input.companyId }, local => {
      requireQueueRunning(local, '暂挂公司');
      const company = findCompany(input.companyId);
      requireCurrentCompany(local, company.id);
      if (isCompanyTerminal(company.status)) throw new WorkflowError('COMPANY_TERMINAL', '已结束的公司不能暂挂。');
      const resumeStatus = company.status === COMPANY_STATUS.HELD ? company.resumeStatus : company.status;
      transitionCompany(company, COMPANY_STATUS.HELD, 'user_hold', now());
      company.resumeStatus = resumeStatus;
      company.holdReason = reason;
      company.checkpoint.requiresObservation = true;
      advanceQueue();
      return { company: clone(company), queue: clone(local.queue) };
    }));
  }

  async function resumeHeldCompany(input, context) {
    assertOperator(context, 'resumeHeldCompany');
    return serial(() => mutate({ type: 'resume_held_company', companyId: input.companyId }, local => {
      const company = findCompany(input.companyId);
      if (company.status !== COMPANY_STATUS.HELD) throw new WorkflowError('NOT_HELD', '该公司当前不在暂挂状态。');
      if (local.queue.status === QUEUE_STATUS.PAUSED) throw new WorkflowError('QUEUE_PAUSED', '请先恢复队列。');
      const current = currentCompanyRecord();
      if (current && current.id !== company.id && !isCompanyTerminal(current.status)) {
        throw new WorkflowError('QUEUE_BUSY', '已有另一家公司在处理，不能同时恢复暂挂公司。');
      }
      if (local.queue.status === QUEUE_STATUS.DRAINED) {
        assertQueueTransition(local.queue.status, QUEUE_STATUS.RUNNING);
        local.queue.status = QUEUE_STATUS.RUNNING;
      }
      const resumeStatus = company.resumeStatus;
      if (!resumeStatus) throw new WorkflowError('NO_RESUME_POINT', '缺少暂挂前的状态，不能自动恢复。');
      local.queue.currentCompanyId = company.id;
      transitionCompany(company, resumeStatus, 'user_resume_hold', now());
      company.resumeStatus = null;
      company.holdReason = null;
      local.queue.updatedAt = now();
      return { company: clone(company), queue: clone(local.queue) };
    }));
  }

  async function selectPositions(input, context) {
    assertOperator(context, 'selectPositions');
    const positionIds = Array.isArray(input?.positionIds) ? [...new Set(input.positionIds)] : [];
    if (!positionIds.length) throw new WorkflowError('NO_POSITION_SELECTED', '本人至少选择一个岗位。');
    return serial(() => mutate({ type: 'select_positions', companyId: input.companyId }, local => {
      requireQueueRunning(local, '选择岗位');
      const company = findCompany(input.companyId);
      requireCurrentCompany(local, company.id);
      if (company.status !== COMPANY_STATUS.AWAITING_SELECTION) {
        throw new WorkflowError('NOT_AWAITING_SELECTION', '该公司当前不在待选岗位阶段。');
      }
      const candidates = positionIds.map(positionId => {
        const position = findPosition(positionId);
        if (position.companyId !== company.id) throw new WorkflowError('POSITION_COMPANY_MISMATCH', '岗位不属于该公司。');
        if (position.status !== POSITION_STATUS.CANDIDATE) throw new WorkflowError('POSITION_NOT_SELECTABLE', '岗位不是待选候选。');
        const duplicate = findDuplicateOfficialRecord(local, company, position);
        if (duplicate) {
          throw new WorkflowError('DUPLICATE_APPLICATION', `同一公司批次已有官方岗位 ${position.officialId}，禁止重复选择或申请。`);
        }
        return position;
      });
      company.selectedPositionIds = positionIds;
      candidates.forEach((position, index) => {
        position.priority = index + 1;
        transitionPosition(position, POSITION_STATUS.SELECTED, 'user_select', now());
      });
      const first = candidates[0];
      company.activePositionId = first.id;
      transitionPosition(first, POSITION_STATUS.PREPARING, 'position_start', now());
      transitionCompany(company, COMPANY_STATUS.PREPARING, 'positions_selected', now());
      return { company: clone(company), positions: candidates.map(clone), queue: clone(local.queue) };
    }));
  }

  async function recordHumanLogin(input, context) {
    assertOperator(context, 'recordHumanLogin');
    assertHumanConfirmation(input, '记录本人登录');
    requireEventId(input, '记录本人登录');
    return serial(() => mutate({
      eventId: input.eventId,
      type: 'human_login',
      companyId: input.companyId,
      fingerprint: { companyId: input.companyId },
    }, local => {
      requireQueueRunning(local, '记录本人登录');
      const company = findCompany(input.companyId);
      requireCurrentCompany(local, company.id);
      if (company.status !== COMPANY_STATUS.AWAITING_LOGIN) {
        throw new WorkflowError('NOT_AWAITING_LOGIN', '公司当前不在待登录阶段。');
      }
      transitionCompany(company, COMPANY_STATUS.RESEARCHING, 'human_login', now());
      return { company: clone(company), queue: clone(local.queue) };
    }));
  }

  async function recordPositionCandidates(input, context) {
    assertAgentOrOperator(context, 'recordPositionCandidates');
    requireEventId(input, '记录岗位候选');
    const positions = Array.isArray(input?.positions) ? input.positions.map(normalizePositionCandidate) : [];
    if (!positions.length) throw new WorkflowError('NO_CANDIDATES', '至少记录一个官方岗位候选。');
    return serial(() => mutate({
      eventId: input.eventId,
      type: 'record_candidates',
      companyId: input.companyId,
      fingerprint: {
        companyId: input.companyId,
        positions: positions
          .map(position => ({
            officialId: normalizeOfficialId(position.officialId),
            title: position.title,
            sourceUrl: position.source.url,
            checkedAt: position.source.checkedAt,
          }))
          .sort((a, b) => (a.officialId < b.officialId ? -1 : a.officialId > b.officialId ? 1 : 0)),
      },
    }, local => {
      const company = requireAgentWritableActive(context, {
        companyId: input.companyId,
        statuses: [COMPANY_STATUS.RESEARCHING, COMPANY_STATUS.AWAITING_SELECTION],
        operation: '记录岗位候选',
      });
      const existing = new Set(local.positions.filter(position => position.companyId === company.id).map(position => normalizeOfficialId(position.officialId)));
      const created = positions.map(item => {
        const official = normalizeOfficialId(item.officialId);
        if (existing.has(official)) throw new WorkflowError('DUPLICATE_POSITION', `岗位 ${item.officialId} 已存在。`);
        const historicalDuplicate = findApplicationDuplicate(company, item.officialId, local.companies, local.positions);
        if (historicalDuplicate) {
          throw new WorkflowError('DUPLICATE_APPLICATION', `同一公司批次已有官方岗位 ${item.officialId}（${historicalDuplicate.title}），禁止用重复公司条目再次申请。`);
        }
        existing.add(official);
        const position = createPosition({ id: newId(), companyId: company.id, ...item, now: now() });
        local.positions.push(position);
        return position;
      });
      if (company.status === COMPANY_STATUS.RESEARCHING) {
        transitionCompany(company, COMPANY_STATUS.AWAITING_SELECTION, 'candidates_found', now());
      }
      return { company: clone(company), positions: created.map(clone), queue: clone(local.queue) };
    }));
  }

  async function recordNoPositions(input, context) {
    assertAgentOrOperator(context, 'recordNoPositions');
    requireEventId(input, '记录无合适岗位');
    const evidence = input?.evidence;
    validateSchema(evidence, noPositionsEvidenceSchema);
    return serial(() => mutate({
      eventId: input.eventId,
      type: 'no_positions',
      companyId: input.companyId,
      fingerprint: {
        companyId: input.companyId,
        sourceUrl: evidence.sourceUrl,
        checkedAt: evidence.checkedAt,
        checkedBy: evidence.checkedBy,
        reason: evidence.reason,
        resultText: evidence.resultText,
      },
    }, local => {
      const company = requireAgentWritableActive(context, {
        companyId: input.companyId,
        statuses: [COMPANY_STATUS.RESEARCHING],
        operation: '记录无合适岗位',
      });
      company.noPositionsEvidence = clone(evidence);
      transitionCompany(company, COMPANY_STATUS.NO_POSITIONS, 'no_positions_with_evidence', now());
      company.activePositionId = null;
      advanceQueue();
      return { company: clone(company), queue: clone(local.queue) };
    }));
  }

  async function markPositionReadyForSubmit(input, context) {
    assertOperator(context, 'markPositionReadyForSubmit');
    assertHumanConfirmation(input, '确认岗位可送交本人提交');
    return serial(() => mutate({ type: 'position_ready', companyId: input.companyId }, local => {
      requireQueueRunning(local, '确认岗位可送交本人提交');
      const company = findCompany(input.companyId);
      const position = findPosition(input.positionId);
      requireCurrentCompany(local, company.id);
      if (position.companyId !== company.id) throw new WorkflowError('POSITION_COMPANY_MISMATCH', '岗位不属于该公司。');
      if (company.activePositionId !== position.id) throw new WorkflowError('NOT_ACTIVE_POSITION', '该岗位不是当前活动岗位。');
      if (![POSITION_STATUS.PREPARING, POSITION_STATUS.AWAITING_ISSUE_ANSWERS].includes(position.status)) {
        throw new WorkflowError('POSITION_NOT_PREPARING', '岗位当前不能进入待提交。');
      }
      if (openBlockingIssues(local.issues, company.id).length) {
        throw new WorkflowError('BLOCKING_ISSUES', '仍有阻断问题未解决，不能进入待提交。');
      }
      transitionPosition(position, POSITION_STATUS.AWAITING_HUMAN_SUBMIT, 'ready_for_human_submit', now());
      if (company.status === COMPANY_STATUS.AWAITING_ISSUE_ANSWERS) {
        transitionCompany(company, COMPANY_STATUS.PREPARING, 'issues_cleared_before_ready', now());
      }
      transitionCompany(company, COMPANY_STATUS.AWAITING_HUMAN_SUBMIT, 'position_ready', now());
      company.checkpoint.requiresObservation = true;
      return { company: clone(company), position: clone(position), queue: clone(local.queue) };
    }));
  }

  async function addIssue(input, context) {
    assertAgentOrOperator(context, 'addIssue');
    const type = ISSUE_TYPES.includes(input?.type) ? input.type : null;
    if (!type) throw new WorkflowError('INVALID_ISSUE', '问题类型无效。');
    return serial(() => mutate({ type: 'add_issue', companyId: input.companyId }, local => {
      const company = requireAgentWritableActive(context, {
        companyId: input.companyId,
        statuses: [
          COMPANY_STATUS.RESEARCHING,
          COMPANY_STATUS.AWAITING_SELECTION,
          COMPANY_STATUS.PREPARING,
          COMPANY_STATUS.AWAITING_ISSUE_ANSWERS,
          COMPANY_STATUS.AWAITING_HUMAN_SUBMIT,
        ],
        positionId: input.positionId || null,
        operation: '记录问题',
      });
      let position = null;
      if (input.positionId) {
        position = findPosition(input.positionId);
        if (position.companyId !== company.id) throw new WorkflowError('POSITION_COMPANY_MISMATCH', '岗位不属于该公司。');
      }
      const incoming = {
        companyId: company.id,
        positionId: position?.id || null,
        fieldKey: input.fieldKey,
        type,
        severity: ['error', 'warn', 'info'].includes(input.severity) ? input.severity : 'warn',
        blocking: Boolean(input.blocking),
        message: input.message,
        evidence: typeof input.evidence === 'string' ? input.evidence : '',
        dependencies: Array.isArray(input.dependencies) ? input.dependencies : [],
      };
      if (typeof incoming.fieldKey !== 'string' || !incoming.fieldKey.trim()
        || typeof incoming.message !== 'string' || !incoming.message.trim()) {
        throw new WorkflowError('INVALID_ISSUE', '问题必须有字段键和说明。');
      }
      const key = issueKey(incoming);
      const existing = local.issues.find(issue => issueKey(issue) === key);
      if (existing) {
        existing.occurrences += 1;
        existing.message = incoming.message;
        existing.severity = incoming.severity;
        existing.blocking = incoming.blocking || existing.blocking;
        existing.evidence = incoming.evidence || existing.evidence;
        existing.dependencies = [...new Set([...existing.dependencies, ...incoming.dependencies])].slice(0, 20);
        existing.updatedAt = now();
        if (existing.status === 'resolved') existing.status = 'open';
      } else {
        const issue = createIssue({ id: newId(), ...incoming, now: now() });
        local.issues.push(issue);
      }
      const issue = existing || local.issues[local.issues.length - 1];
      if (issue.blocking) {
        const active = company.activePositionId
          ? local.positions.find(item => item.id === company.activePositionId)
          : null;
        const affected = position
          ? (company.activePositionId === position.id ? position : null)
          : active;
        if (affected && [POSITION_STATUS.PREPARING, POSITION_STATUS.AWAITING_HUMAN_SUBMIT].includes(affected.status)) {
          transitionPosition(affected, POSITION_STATUS.AWAITING_ISSUE_ANSWERS, 'blocking_issue', now());
        }
        if ([COMPANY_STATUS.PREPARING, COMPANY_STATUS.AWAITING_HUMAN_SUBMIT].includes(company.status)) {
          transitionCompany(company, COMPANY_STATUS.AWAITING_ISSUE_ANSWERS, 'blocking_issue', now());
        }
      }
      return { issue: clone(issue), merged: Boolean(existing), company: clone(company) };
    }));
  }

  async function answerIssue(input, context) {
    assertOperator(context, 'answerIssue');
    return serial(() => mutate({ type: 'answer_issue' }, local => {
      requireQueueRunning(local, '回答问题');
      const issue = local.issues.find(item => item.id === input.issueId);
      if (!issue) throw new WorkflowError('ISSUE_NOT_FOUND', '问题不存在。');
      if (issue.status === 'resolved') throw new WorkflowError('ISSUE_RESOLVED', '问题已解决，不能直接改写历史回答。');
      if (typeof input.answer !== 'string' || !input.answer.trim()) throw new WorkflowError('ANSWER_REQUIRED', '回答不能为空。');
      issue.answer = input.answer;
      issue.status = 'answered';
      issue.updatedAt = now();
      return { issue: clone(issue) };
    }));
  }

  async function resolveIssue(input, context) {
    assertOperator(context, 'resolveIssue');
    return serial(() => mutate({ type: 'resolve_issue' }, local => {
      requireQueueRunning(local, '解决问题');
      const issue = local.issues.find(item => item.id === input.issueId);
      if (!issue) throw new WorkflowError('ISSUE_NOT_FOUND', '问题不存在。');
      if (issue.status !== 'resolved') {
        issue.status = 'resolved';
        issue.updatedAt = now();
      }
      const company = findCompany(issue.companyId);
      maybeResolveIssues(company);
      return { issue: clone(issue), company: clone(company) };
    }));
  }

  async function recordHumanSubmission(input, context) {
    assertOperator(context, 'recordHumanSubmission');
    assertHumanConfirmation(input, '记录本人提交');
    // 真实提交可能发生在队列暂停期间；允许记录回执，但 advanceQueue 在暂停时不会启动下一家。
    requireEventId(input, '记录本人提交');
    const submission = {
      reportedAt: input.reportedAt,
      reference: typeof input.reference === 'string' ? input.reference : '',
      recordedBy: 'user',
      eventId: input.eventId,
    };
    validateSchema(submission, submissionSchema);
    return serial(() => mutate({
      eventId: input.eventId,
      type: 'human_submission',
      companyId: input.companyId,
      fingerprint: {
        companyId: input.companyId,
        positionId: input.positionId,
        reportedAt: input.reportedAt,
        reference: submission.reference,
      },
    }, local => {
      const company = findCompany(input.companyId);
      const position = findPosition(input.positionId);
      if (position.companyId !== company.id) throw new WorkflowError('POSITION_COMPANY_MISMATCH', '岗位不属于该公司。');
      if (blocksResubmission(position.status) || position.submission || position.verification) {
        throw new WorkflowError('ALREADY_SUBMITTED', '该岗位已有提交或核验记录，禁止重复申请。');
      }
      const duplicate = findDuplicateOfficialRecord(local, company, position);
      if (duplicate) {
        throw new WorkflowError('DUPLICATE_APPLICATION', `同一公司批次已有官方岗位 ${position.officialId} 的申请记录，禁止重复申请。`);
      }
      requireCurrentCompany(local, company.id);
      if (company.activePositionId !== position.id) {
        throw new WorkflowError('NOT_ACTIVE_POSITION', '只能记录当前活动岗位的本人提交回执。');
      }
      if (position.status !== POSITION_STATUS.AWAITING_HUMAN_SUBMIT
        || company.status !== COMPANY_STATUS.AWAITING_HUMAN_SUBMIT) {
        throw new WorkflowError('NOT_READY_FOR_SUBMIT', '岗位尚未达到本人提交阶段，不能记录提交。');
      }
      if (openBlockingIssues(local.issues, company.id).length) {
        throw new WorkflowError('BLOCKING_ISSUES', '仍有阻断问题未解决，不能记录本人提交。');
      }
      position.submission = submission;
      transitionPosition(position, POSITION_STATUS.SUBMITTED_REPORTED, 'human_submission_receipt', now());
      syncCompanyAfterPosition(company);
      return {
        company: clone(company),
        position: clone(position),
        queue: clone(local.queue),
      };
    }));
  }

  async function recordHistoricalSubmission(input, context) {
    assertOperator(context, 'recordHistoricalSubmission');
    assertHumanConfirmation(input, '记录历史本人提交');
    requireEventId(input, '记录历史本人提交');
    const submission = {
      reportedAt: input.reportedAt,
      reference: typeof input.reference === 'string' ? input.reference : '',
      recordedBy: 'user',
      eventId: input.eventId,
      source: 'user_history',
    };
    validateSchema(submission, historicalSubmissionSchema);
    return serial(() => mutate({
      eventId: input.eventId,
      type: 'historical_submission',
      companyId: input.companyId,
      fingerprint: {
        companyId: input.companyId,
        reportedAt: input.reportedAt,
        reference: submission.reference,
      },
    }, local => {
      const company = findCompany(input.companyId);
      if (company.historicalSubmission) {
        throw new WorkflowError('ALREADY_SUBMITTED', '该公司已有历史本人提交记录，禁止重复记录。');
      }
      if (selectedFor(company).some(position => position.submission || position.verification || blocksResubmission(position.status))) {
        throw new WorkflowError('ALREADY_SUBMITTED', '该公司已有岗位提交或核验记录，不能再写入历史公司级报告。');
      }
      if (company.status !== COMPANY_STATUS.QUEUED) {
        throw new WorkflowError('HISTORICAL_SUBMISSION_NOT_ALLOWED', '历史本人报告只允许用于尚未启动的队列项；运行中的任务请按岗位流程记录。');
      }
      company.historicalSubmission = submission;
      company.activePositionId = null;
      transitionCompany(company, COMPANY_STATUS.SUBMITTED_REPORTED, 'historical_submission_receipt', now());
      return { company: clone(company), queue: clone(local.queue) };
    }));
  }

  async function recordOfficialVerification(input, context) {
    assertOperator(context, 'recordOfficialVerification');
    assertHumanConfirmation(input, '记录官网核验');
    // 只读核验可以在暂停或历史公司上记录；暂停时不会因此推进队列。
    requireEventId(input, '记录官网核验');
    const verification = {
      verifiedAt: input.verifiedAt,
      sourceUrl: input.sourceUrl,
      evidenceText: input.evidenceText,
      recordedBy: 'user',
      eventId: input.eventId,
    };
    validateSchema(verification, verificationSchema);
    return serial(() => mutate({
      eventId: input.eventId,
      type: 'official_verification',
      companyId: input.companyId,
      fingerprint: {
        companyId: input.companyId,
        positionId: input.positionId,
        verifiedAt: input.verifiedAt,
        sourceUrl: input.sourceUrl,
        evidenceText: input.evidenceText,
      },
    }, local => {
      const company = findCompany(input.companyId);
      const position = findPosition(input.positionId);
      if (position.companyId !== company.id) throw new WorkflowError('POSITION_COMPANY_MISMATCH', '岗位不属于该公司。');
      if (position.verification) throw new WorkflowError('ALREADY_VERIFIED', '该岗位已有官网核验记录。');
      if (position.status !== POSITION_STATUS.SUBMITTED_REPORTED) {
        throw new WorkflowError('NOT_SUBMITTED', '只有本人已提交且待核验的岗位可以记录官网核验。');
      }
      position.verification = verification;
      transitionPosition(position, POSITION_STATUS.VERIFIED, 'official_verification', now());
      if (company.status !== COMPANY_STATUS.COMPLETED) syncCompanyAfterPosition(company);
      return {
        company: clone(company),
        position: clone(position),
        queue: clone(local.queue),
      };
    }));
  }

  async function skipPosition(input, context) {
    assertOperator(context, 'skipPosition');
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
    if (!reason) throw new WorkflowError('REASON_REQUIRED', '跳过岗位必须说明原因。');
    const scope = input.scope === 'history' ? 'history' : 'current';
    if (scope === 'history') assertHumanConfirmation(input, '历史范围跳过岗位');
    return serial(() => mutate({ type: 'skip_position', companyId: input.companyId }, local => {
      const company = findCompany(input.companyId);
      if (scope === 'current') {
        requireQueueRunning(local, '跳过岗位');
        requireCurrentCompany(local, company.id);
      } else {
        if (local.queue.currentCompanyId === company.id) {
          throw new WorkflowError('USE_CURRENT_SCOPE', '当前公司请使用普通跳过范围；历史范围只用于明确修正旧记录。');
        }
      }
      const position = findPosition(input.positionId);
      if (position.companyId !== company.id) throw new WorkflowError('POSITION_COMPANY_MISMATCH', '岗位不属于该公司。');
      if (positionPreventsResubmissionOrVerified(position)) {
        throw new WorkflowError('ALREADY_SUBMITTED', '已提交或核验的岗位不能再标记跳过。');
      }
      if (position.status !== POSITION_STATUS.SELECTED
        && position.status !== POSITION_STATUS.PREPARING
        && position.status !== POSITION_STATUS.AWAITING_ISSUE_ANSWERS
        && position.status !== POSITION_STATUS.AWAITING_HUMAN_SUBMIT) {
        throw new WorkflowError('POSITION_NOT_SKIPPABLE', '岗位当前状态不能跳过。');
      }
      position.skipReason = reason;
      transitionPosition(position, POSITION_STATUS.SKIPPED, 'user_skip_position', now());
      syncCompanyAfterPosition(company);
      return { company: clone(company), position: clone(position), queue: clone(local.queue) };
    }));
  }

  function positionPreventsResubmissionOrVerified(position) {
    return positionPreventsResubmission(position);
  }

  function findDuplicateOfficialRecord(local, company, position) {
    const official = normalizeOfficialId(position.officialId);
    const identity = company.identityKey || companyIdentityKey(company.name, company.batch);
    return local.positions.find(other => {
      if (other.id === position.id || normalizeOfficialId(other.officialId) !== official) return false;
      if (other.companyId === company.id) return true;
      const otherCompany = local.companies.find(item => item.id === other.companyId);
      return (otherCompany?.identityKey || companyIdentityKey(otherCompany?.name, otherCompany?.batch)) === identity;
    }) || null;
  }

  async function skipCompany(input, context) {
    assertOperator(context, 'skipCompany');
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
    if (!reason) throw new WorkflowError('REASON_REQUIRED', '跳过公司必须说明原因。');
    const scope = input.scope === 'history' ? 'history' : 'current';
    if (scope === 'history') assertHumanConfirmation(input, '历史范围跳过公司');
    return serial(() => mutate({ type: 'skip_company', companyId: input.companyId }, local => {
      const company = findCompany(input.companyId);
      if (scope === 'current') {
        requireQueueRunning(local, '跳过公司');
        requireCurrentCompany(local, company.id);
      } else if (local.queue.currentCompanyId === company.id) {
        throw new WorkflowError('USE_CURRENT_SCOPE', '当前公司请使用普通跳过范围；历史范围只用于明确修正旧记录。');
      }
      if (isCompanyTerminal(company.status)) throw new WorkflowError('COMPANY_TERMINAL', '公司已经结束。');
      const submitted = selectedFor(company).some(position => blocksResubmission(position.status) || position.submission || position.verification);
      if (submitted) throw new WorkflowError('COMPANY_HAS_SUBMISSIONS', '公司已有本人提交记录，不能整家标为跳过。');
      company.skipReason = reason;
      transitionCompany(company, COMPANY_STATUS.SKIPPED, 'user_skip_company', now());
      company.activePositionId = null;
      if (local.queue.currentCompanyId === company.id) advanceQueue();
      return { company: clone(company), queue: clone(local.queue) };
    }));
  }

  async function queryProfileFacts(filter, context) {
    const facts = await profile.queryFacts(filter, context);
    return facts.map(fact => ({
      id: fact.id,
      section: fact.section,
      entityId: fact.entityId ?? null,
      label: fact.label,
      value: fact.value,
      version: fact.version,
      confirmed: fact.confirmed,
      confirmedVersion: fact.confirmedVersion,
      source: fact.source,
      scope: fact.scope,
      sensitivity: fact.sensitivity,
    }));
  }

  async function getProfileFactForFill(input, context) {
    const fact = await profile.getFactForFill(input.factId, {
      companyId: input.companyId || null,
      positionId: input.positionId || null,
      purpose: input.purpose || null,
    }, context);
    return {
      id: fact.id,
      entityId: fact.entityId ?? null,
      label: fact.label,
      value: fact.value,
      version: fact.version,
      confirmedVersion: fact.confirmedVersion,
      source: fact.source,
      scope: fact.scope,
      sensitivity: fact.sensitivity,
    };
  }

  async function summary() {
    await ensure();
    const current = currentCompanyRecord();
    return {
      workflowVersion: WORKFLOW_VERSION,
      queue: clone(state.queue),
      checkpoint: clone(state.checkpoint),
      currentCompany: current ? clone(current) : null,
      currentCompanyResult: current ? companyResultText(current, state.positions) : null,
      activePosition: current?.activePositionId
        ? clone(state.positions.find(position => position.id === current.activePositionId) || null)
        : null,
      issueGroups: groupIssues(state.issues),
      recoveryPending,
      companies: state.companies.map(company => ({
        id: company.id,
        name: company.name,
        status: company.status,
        queueOrder: company.queueOrder,
        selectedCount: company.selectedPositionIds.length,
        result: companyResultText(company, state.positions),
      })),
      revision,
      profileRevision: await profile.revision(),
    };
  }

  async function getCompany(input, context) {
    assertAgentOrOperator(context, 'getCompany');
    await ensure();
    const company = findCompany(input.companyId);
    return {
      company: clone(company),
      positions: state.positions.filter(position => position.companyId === company.id).map(clone),
      issues: state.issues.filter(issue => issue.companyId === company.id).map(clone),
      result: companyResultText(company, state.positions),
    };
  }

  async function listCompanies(context) {
    assertAgentOrOperator(context, 'listCompanies');
    await ensure();
    return state.companies.map(company => ({
      id: company.id,
      name: company.name,
      status: company.status,
      queueOrder: company.queueOrder,
      selectedPositionIds: [...company.selectedPositionIds],
      result: companyResultText(company, state.positions),
    }));
  }

  async function listIssues(input, context) {
    assertAgentOrOperator(context, 'listIssues');
    await ensure();
    const status = input?.status || 'open';
    if (!['all', ...ISSUE_STATUSES].includes(status)) throw new WorkflowError('INVALID_STATUS', '问题状态筛选无效。');
    return state.issues
      .filter(issue => (!input?.companyId || issue.companyId === input.companyId))
      .filter(issue => status === 'all' || issue.status === status)
      .map(clone);
  }

  async function acknowledgeRecovery(input, context) {
    assertOperator(context, 'acknowledgeRecovery');
    assertHumanConfirmation(input, '确认已重新观察页面');
    await ensure();
    if (!recoveryPending) {
      return { recoveryPending: false, idempotent: true, acknowledgedAt: now() };
    }
    recoveryPending = false;
    return {
      recoveryPending: false,
      idempotent: false,
      acknowledgedAt: now(),
      observedAt: typeof input.observedAt === 'string' ? input.observedAt : now(),
      note: '仅确认本次进程已重新观察现场；不会重放填写、上传或提交。',
    };
  }

  async function recover() {
    await ensure();
    const current = currentCompanyRecord();
    const active = current?.activePositionId
      ? state.positions.find(position => position.id === current.activePositionId) || null
      : null;
    const safeActions = [];
    if (recoveryPending) safeActions.push('acknowledge_recovery_by_user');
    if (state.queue.status === QUEUE_STATUS.PAUSED) safeActions.push('resume_queue_by_user');
    if (current) {
      if (current.status === COMPANY_STATUS.AWAITING_LOGIN) safeActions.push('human_login');
      else if (current.status === COMPANY_STATUS.RESEARCHING) safeActions.push('observe_official_site', 'record_candidates_or_no_positions');
      else if (current.status === COMPANY_STATUS.AWAITING_SELECTION) safeActions.push('user_select_positions');
      else if (current.status === COMPANY_STATUS.PREPARING) safeActions.push('observe_page', 'continue_preparation');
      else if (current.status === COMPANY_STATUS.AWAITING_ISSUE_ANSWERS) safeActions.push('answer_issues_by_user', 'observe_page');
      else if (current.status === COMPANY_STATUS.AWAITING_HUMAN_SUBMIT) safeActions.push('user_review_and_submit');
      else if (current.status === COMPANY_STATUS.HELD) safeActions.push('resume_held_by_user', 'skip_company_by_user');
      else if (current.status === COMPANY_STATUS.BLOCKED) safeActions.push('fix_blocker_by_user');
    }
    return {
      workflowVersion: WORKFLOW_VERSION,
      queue: clone(state.queue),
      checkpoint: clone(state.checkpoint),
      currentCompany: current ? clone(current) : null,
      activePosition: active ? clone(active) : null,
      openBlockingIssues: current ? openBlockingIssues(state.issues, current.id).map(clone) : [],
      safeActions,
      recoveryPending,
      note: '恢复只读取已持久化状态和现场；不会重放上传、填写或提交，也不会把未确认操作当作完成。字段页面写入尚未实现，接入后必须先观察再继续。',
      revision,
    };
  }

  return {
    addCompany,
    startQueue,
    pauseQueue,
    resumeQueue,
    prioritizeCompany,
    holdCompany,
    resumeHeldCompany,
    selectPositions,
    recordHumanLogin,
    recordPositionCandidates,
    recordNoPositions,
    markPositionReadyForSubmit,
    addIssue,
    answerIssue,
    resolveIssue,
    recordHumanSubmission,
    recordHistoricalSubmission,
    recordOfficialVerification,
    skipPosition,
    skipCompany,
    createProfileFact: (input, context) => profile.createFact(input, context),
    reviseProfileFact: (input, context) => profile.reviseFact(input.factId, input.patch, { expectedVersion: input.expectedVersion }, context),
    reviseProfileFacts: (input, context) => profile.reviseFacts(input.changes, context),
    confirmProfileFact: (input, context) => {
      assertOperator(context, 'confirmProfileFact');
      assertHumanConfirmation(input, '确认资料字段');
      return profile.confirmFact(input.factId, { expectedVersion: input.expectedVersion }, context);
    },
    confirmProfileFacts: (input, context) => {
      assertOperator(context, 'confirmProfileFacts');
      assertHumanConfirmation(input, '确认资料字段');
      return profile.confirmFacts(input.confirmations, context);
    },
    grantSensitiveFactUse: (input, context) => profile.grantSensitiveUse(input, context),
    queryProfileFacts,
    getProfileFactForFill,
    getProfileFactForLocalEdit: (input, context) => profile.getFactForLocalEdit(input.factId, context),
    listProfileFactsForLocalEdit: (context) => profile.listFactsForLocalEdit(context),
    summary,
    getCompany,
    listCompanies,
    listIssues,
    recover,
    acknowledgeRecovery,
    runtimeRevision: async () => { await ensure(); return revision; },
  };
}

export { profileDocumentSchema };
