// 受控 Moka 连接层：只衔接已有 driver、字段语义、模型路由与 core 台账。
// 不实现登录、提交或任意 URL/selector；所有模型调用须本次用户授权且密钥只在进程内存。

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createMokaBrowserDriver,
  suggestMokaFieldMappings,
  validateMokaFillPlan,
  MOKA_FILL_PLAN_SCHEMA_VERSION,
  normalizePlanText,
} from '../browser/index.js';
import {
  createModelRouter,
  createCallBudget,
  buildReviewDiff,
} from '../../../core/model-router.js';

const OPERATION_SCHEMA = 'application-copilot.moka-operation.v1';
const FAMILY_LABEL = /(父亲|母亲|父母|家庭|家人|亲属|配偶|子女|紧急联系人|身份证|证件|护照|户口|户籍|婚姻|健康|病史|疾病|残疾|征信|银行卡|政治面貌|宗教|住址)/i;
const SAFE_SECTIONS = new Set(['basic', 'education', 'internship', 'internship_content', 'project', 'project_original', 'project_content', 'project_responsibilities', 'skill', 'language']);
// 面板内存槽用 search/execution/review；真实路由角色是 research/execute/review。固定成对，禁止跨角色复用密钥。
const ROUTER_CREDENTIAL_REFS = Object.freeze({ research: 'search', execute: 'execution', review: 'review' });
const PROJECT_NAME_LABEL = /项目|project/i;
const PROJECT_CONTENT_LABEL = /内容|正文|描述|content|description/i;
const PROJECT_RESPONSIBILITIES_LABEL = /职责|responsibilit|duty|duties/i;

export const MOKA_WORKFLOW_COMMANDS = Object.freeze({
  open: 'user.mokaOpen',
  research: 'user.mokaResearch',
  prepareFill: 'user.mokaPrepareFill',
  runFill: 'user.mokaRunFill',
  cancel: 'user.mokaCancel',
});

export function createMemoryCredentialStore() {
  const keys = new Map();
  return {
    set(role, apiKey) {
      if (typeof apiKey === 'string' && apiKey.trim()) keys.set(role, apiKey.trim());
    },
    clear(role) {
      keys.delete(role);
    },
    get(role) {
      return keys.get(role) || null;
    },
    apiKeySet(role) {
      return keys.has(role);
    },
  };
}

function isConfirmedCurrent(fact) {
  return Boolean(fact && fact.confirmed === true && fact.confirmedVersion === fact.version);
}

function scopeAllows(fact, { companyId, positionId = null }) {
  const scope = fact?.scope || {};
  if (scope.type === 'global') return true;
  if (scope.type === 'company') return scope.companyId === companyId;
  if (scope.type === 'position') return scope.companyId === companyId && scope.positionId === positionId;
  return false;
}

function safeFact(fact, use) {
  return isConfirmedCurrent(fact)
    && fact.sensitivity === 'normal'
    && SAFE_SECTIONS.has(fact.section)
    && !FAMILY_LABEL.test(fact.label || '')
    && scopeAllows(fact, use);
}

function safeHttp(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function sourceUrlForCompany(company) {
  for (const link of company?.links || []) {
    const href = safeHttp(link?.url);
    if (href) return href;
  }
  return null;
}

function sourceUrlForPosition(company, position) {
  return safeHttp(position?.source?.url) || sourceUrlForCompany(company) || null;
}

function modelSignature(roles) {
  return JSON.stringify(['research', 'execution', 'review'].map((role) => {
    const config = roles[role] || {};
    return [role, config.provider || '', config.model || '', config.endpoint || ''];
  }));
}

function profileVersionFor(summary) {
  if (Number.isInteger(summary?.profileVersion)) return summary.profileVersion;
  if (Number.isInteger(summary?.profileRevision)) return summary.profileRevision;
  return 0;
}

function factKeySections(key) {
  if (key === 'basic.name' || key === 'basic.phone' || key === 'basic.email') return { sections: ['basic'], label: key.split('.')[1], expectedSection: 'basic' };
  if (key === 'education.school') return { sections: ['education'], label: /学校|院校|school|university/i, expectedSection: 'education' };
  if (key === 'project.name') return { sections: ['project', 'project_original'], label: PROJECT_NAME_LABEL, exclude: /职责|内容|正文|描述|responsibilit|content|description|duty|duties/i, expectedSection: null };
  if (key === 'internship.content') return { sections: ['internship_content'], label: PROJECT_CONTENT_LABEL, expectedSection: 'internship_content' };
  if (key.startsWith('internship.')) return { sections: ['internship'], label: key.split('.')[1], expectedSection: 'internship' };
  if (key === 'project.content') return { sections: ['project_content'], label: PROJECT_CONTENT_LABEL, expectedSection: 'project_content' };
  if (key === 'project.responsibilities') return { sections: ['project_responsibilities'], label: PROJECT_RESPONSIBILITIES_LABEL, expectedSection: 'project_responsibilities' };
  return null;
}

function factMatchesKey(fact, key) {
  const rule = factKeySections(key);
  if (!rule) return false;
  if (!rule.sections.includes(fact.section)) return false;
  if (rule.exclude && rule.exclude.test(fact.label || '')) return false;
  if (rule.label instanceof RegExp) return rule.label.test(fact.label || '');
  const labels = {
    name: /姓名|名字|^name$/i,
    phone: /电话|手机|联系方式|phone|mobile|tel/i,
    email: /邮箱|邮件|e-?mail/i,
    school: /学校|院校|school|university/i,
    company: /公司|单位|企业|company|employer/i,
    location: /地点|城市|location|city/i,
    role: /岗位|职位|职务|role|position|title/i,
    content: PROJECT_CONTENT_LABEL,
    name_project: PROJECT_NAME_LABEL,
    responsibilities: PROJECT_RESPONSIBILITIES_LABEL,
  };
  return (labels[rule.label] || new RegExp(rule.label, 'i')).test(fact.label || '');
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('已取消；未继续后续填写或模型调用。');
  error.name = 'AbortError';
  throw error;
}

function selectOption(control, factValue) {
  const options = Array.isArray(control.options) ? control.options : [];
  const matches = options.filter((option) => option.value === factValue || option.label === factValue);
  return matches.length === 1 && matches[0].disabled !== true ? matches[0] : null;
}

export function createMokaWorkflow({
  projectPath,
  core,
  registry,
  credentialStore,
  getRoles,
  now = () => new Date().toISOString(),
  newId,
  fetchImpl = globalThis.fetch,
  driverFactory = null,
  routerFactory = createModelRouter,
  onChanged = async () => {},
} = {}) {
  if (!core || !registry || !credentialStore || typeof getRoles !== 'function' || typeof newId !== 'function') {
    throw new TypeError('createMokaWorkflow 缺少 core/registry/credentialStore/getRoles/newId');
  }
  const stateFile = path.join(projectPath, 'private', 'application-copilot', 'moka-operation.json');
  let driver = null;
  let opened = null;
  let operation = null;
  let activeController = null;
  let planCache = null;
  let researchCache = null;
  let reviewCache = null;
  let issueDigest = null;
  let persistedLoaded = false;

  async function persistSummary(summary) {
    try {
      await fs.mkdir(path.dirname(stateFile), { recursive: true });
      await fs.writeFile(stateFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    } catch {
      // 持久摘要失败不回滚已完成的业务动作，也不在日志输出内容。
    }
  }

  async function ensureLoaded() {
    if (persistedLoaded) return;
    persistedLoaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      if (raw && raw.schemaVersion === OPERATION_SCHEMA && raw.operation && typeof raw.operation === 'object') {
        operation = {
          id: String(raw.operation.id || ''),
          kind: String(raw.operation.kind || ''),
          status: raw.operation.status === 'running' ? 'interrupted' : String(raw.operation.status || 'idle'),
          companyId: raw.operation.companyId || null,
          positionId: raw.operation.positionId || null,
          message: raw.operation.status === 'running' ? '上次后台操作在服务停止时中断；未重放任何填写或提交。' : String(raw.operation.message || ''),
          startedAt: raw.operation.startedAt || null,
          finishedAt: raw.operation.finishedAt || null,
        };
      }
    } catch {
      // 没有摘要或摘要损坏时保持空状态，不覆盖原文件。
    }
  }

  function summaryFor(status, extra = {}) {
    const op = operation || {};
    return {
      schemaVersion: OPERATION_SCHEMA,
      operation: {
        id: op.id || null,
        kind: op.kind || null,
        status,
        companyId: op.companyId || null,
        positionId: op.positionId || null,
        message: extra.message || op.message || '',
        startedAt: op.startedAt || null,
        finishedAt: extra.finishedAt || (status === 'running' ? null : now()),
      },
    };
  }

  function publicPlan(plan, meta = {}) {
    if (!plan) return null;
    return {
      planId: meta.planId || null,
      companyId: meta.companyId || null,
      positionId: meta.positionId || null,
      pageUrl: plan.pageUrl,
      snapshotId: plan.snapshotId,
      targetId: plan.targetId,
      profileVersion: meta.profileVersion || 0,
      itemCount: plan.items.length,
      createdAt: meta.createdAt || null,
      confirmed: meta.confirmed === true,
      used: meta.used === true,
      items: plan.items.map((item) => ({
        controlRef: item.controlRef,
        factId: item.factId,
        fieldKey: item.fieldKey,
        label: item.expectedLabel,
        regionType: item.regionType,
        regionEntityId: item.regionEntityId,
        hasOption: Boolean(item.optionValue && item.optionLabel),
      })),
    };
  }

  async function getState() {
    await ensureLoaded();
    return {
      operation: operation ? { ...operation } : null,
      driver: driver ? { ...driver.getStatus() } : { status: 'idle', closed: true },
      plan: planCache ? publicPlan(planCache.plan, planCache) : null,
      research: researchCache,
      review: reviewCache ? {
        ...reviewCache,
        programDiffCount: Array.isArray(reviewCache.programDiffs) ? reviewCache.programDiffs.length : 0,
        findingCount: Array.isArray(reviewCache.modelFindings) ? reviewCache.modelFindings.length : 0,
      } : null,
      issueDigest: issueDigest ? { ...issueDigest } : null,
      limits: [
        '只操作本人已保存的 Moka 官方来源；不代登录、不提交、不上传附件。',
        '模型密钥只在本宿主进程内存中；服务重启需重新输入，不回显、不导出。',
        '页面读回以实际页面值为准；未读到或差异不会被模型空输出覆盖。',
      ],
    };
  }

  async function companyContext(companyId, { requireQueue = true } = {}) {
    const summary = await core.summary();
    if (requireQueue && summary?.queue?.status !== 'running') {
      throw new Error('队列未运行；不会启动受控窗口或模型调用。');
    }
    if (requireQueue && summary?.queue?.currentCompanyId !== companyId) {
      throw new Error('只能操作当前 RUNNING 公司；未切换或外发其他公司数据。');
    }
    const detail = await registry.invoke('get_company', { companyId });
    return { summary, company: detail.company, positions: detail.positions || [] };
  }

  function activePosition(company, positions) {
    return positions.find((item) => item.id === company.activePositionId && item.status === 'preparing') || null;
  }

  async function assertStillCurrent({ companyId, positionId = null, profileVersion }) {
    const latest = await core.summary();
    if (latest?.queue?.status !== 'running' || latest.queue.currentCompanyId !== companyId) {
      throw new Error('运行公司或队列状态已变化；未写入旧任务结果。');
    }
    if (Number.isInteger(profileVersion) && profileVersionFor(latest) !== profileVersion) {
      throw new Error('资料版本已变化；未写入旧任务结果。');
    }
    if (positionId) {
      const detail = await registry.invoke('get_company', { companyId });
      if (detail?.company?.activePositionId !== positionId) {
        throw new Error('活动岗位已变化；未写入旧任务结果。');
      }
    }
  }

  async function factsFor(companyId, positionId = null) {
    const list = await registry.invoke('list_profile_facts_for_local_edit', {});
    return (Array.isArray(list) ? list : []).filter((fact) => safeFact(fact, { companyId, positionId }));
  }

  async function raiseIssue(companyId, positionId, fieldKey, type, message, { blocking = false, evidence = '' } = {}) {
    try {
      await registry.invoke('add_issue', {
        companyId,
        ...(positionId ? { positionId } : {}),
        fieldKey: String(fieldKey || 'moka').slice(0, 160),
        type,
        severity: blocking ? 'error' : 'warn',
        blocking,
        message: String(message).slice(0, 1000),
        evidence: String(evidence || '').slice(0, 2000),
      });
    } catch {
      // 公司状态可能已不允许多写一条问题；原始失败结果仍返回给面板。
    }
  }

  async function refreshDigest(companyId) {
    try {
      const issues = await registry.invoke('list_issues', { status: 'all' });
      const open = (Array.isArray(issues) ? issues : []).filter((issue) => issue.companyId === companyId && issue.status !== 'resolved');
      issueDigest = open.length
        ? { id: `moka_${newId()}`, ready: true, issueIds: open.map((issue) => issue.id), createdAt: now() }
        : null;
    } catch {
      issueDigest = null;
    }
  }

  function rolesForRouter() {
    return getRoles().then((roles) => {
      const mapped = {};
      for (const [from, to] of [['search', 'research'], ['execution', 'execute'], ['review', 'review']]) {
        const config = roles?.[from];
        if (!config?.provider || !config?.model || !config?.endpoint) continue;
        mapped[to] = {
          provider: config.provider,
          model: config.model,
          endpoint: config.endpoint,
          endpointApproved: true,
          credentialRef: ROUTER_CREDENTIAL_REFS[to],
        };
      }
      return mapped;
    });
  }

  async function routerWithRoles() {
    const roles = await rolesForRouter();
    return {
      roles,
      router: routerFactory({
        roles,
        fetchImpl,
        allowInsecureLocalhost: false,
        resolveCredential: async (ref, context = {}) => {
          const storeRole = ROUTER_CREDENTIAL_REFS[context.role];
          if (!storeRole || ref !== storeRole) {
            throw new Error('credential 引用与模型角色不匹配；未发送请求。');
          }
          const key = credentialStore.get(storeRole);
          if (!key) throw new Error(`角色 ${storeRole} 没有本次进程内的密钥；未发送请求。`);
          return key;
        },
      }),
    };
  }

  function authorization({ grantId, role, companyId, profileVersion, budget, sendScope, planVersion }) {
    return {
      authorized: true,
      grantId,
      role,
      companyId,
      profileVersion,
      ...(planVersion ? { planVersion } : {}),
      budget,
      sendScope,
    };
  }

  function newOperation(kind, input) {
    if (operation?.status === 'running' || activeController) throw new Error('已有后台操作在运行或尚未安全停止；请等待其结束或先取消。');
    operation = {
      id: `moka_op_${newId()}`,
      kind,
      status: 'running',
      companyId: input.companyId || null,
      positionId: input.positionId || null,
      message: '后台操作已启动；状态由本地摘要低频轮询。',
      startedAt: now(),
      finishedAt: null,
    };
    planCache = kind === 'runFill' ? planCache : null;
    void persistSummary(summaryFor('running'));
    return operation;
  }

  async function runOperation(kind, input, task) {
    const op = newOperation(kind, input);
    const controller = new AbortController();
    activeController = controller;
    queueMicrotask(async () => {
      try {
        const result = await task({ signal: controller.signal, operationId: op.id });
        throwIfAborted(controller.signal);
        if (op.status !== 'running') throwIfAborted({ aborted: true });
        const message = result?.message || '后台操作完成；仍需本人核对页面与问题汇总。';
        await refreshDigest(input.companyId);
        throwIfAborted(controller.signal);
        if (op.status !== 'running') return;
        await persistSummary(summaryFor('completed', { message }));
        await onChanged();
        throwIfAborted(controller.signal);
        if (op.status !== 'running') return;
        op.message = message;
        op.status = 'completed';
        // 先释放控制器再公布完成，避免新任务与未 settle 的旧任务抢 activeController/缓存。
        if (activeController === controller) activeController = null;
      } catch (error) {
        const cancelled = controller.signal.aborted || error?.name === 'AbortError';
        op.status = cancelled ? 'cancelled' : 'failed';
        op.message = String(error?.code || '') === 'MODEL_CANCELLED' || cancelled
          ? '已取消；未继续后续填写或模型调用。'
          : String(error?.message || '受控操作失败，未获得可用结果。').slice(0, 500);
        await persistSummary(summaryFor(op.status, { message: op.message }));
        await onChanged().catch(() => {});
      } finally {
        if (activeController === controller) activeController = null;
      }
    });
    return { operationId: op.id, status: 'running' };
  }

  async function ensureDriver() {
    if (!driver) driver = driverFactory ? driverFactory({ projectDirectory: projectPath }) : createMokaBrowserDriver({ projectDirectory: projectPath });
    return driver;
  }

  async function open(input) {
    const { company } = await companyContext(input.companyId);
    const url = sourceUrlForCompany(company);
    if (!url) throw new Error('当前公司没有已保存的 https 官方来源，不能打开受控窗口。');
    const current = driver ? driver.getStatus() : null;
    if (current?.status === 'open' && opened?.url === url && opened?.companyId === input.companyId) {
      return { operationId: operation?.id || null, status: 'running', alreadyOpen: true };
    }
    const d = await ensureDriver();
    if (current?.status === 'open' && opened?.companyId !== input.companyId) await d.close();
    const result = await d.openCompany(url);
    if (!result?.ok) throw new Error(result?.message || '受控 Moka 窗口打开失败。');
    opened = { companyId: input.companyId, url: result.pageUrl || url, targetId: result.targetId || null };
    return { operationId: operation?.id || null, status: 'running', pageUrl: opened.url, note: '已打开独立 Chrome 窗口；不是嵌入本面板的网页。' };
  }

  async function research(input, { signal } = {}) {
    if (input.sendAuthorized !== true) throw new Error('未勾选本次模型发送授权；0 个模型请求。');
    const { summary, company, positions } = await companyContext(input.companyId);
    if (company.status !== 'researching') throw new Error('公司不在检索阶段；请先完成本人登录确认。');
    if (!driver || !opened || opened.companyId !== input.companyId) throw new Error('请先点击“打开受控 Moka 窗口”。');
    const snapshot = await driver.extractResearchSnapshot();
    researchCache = {
      status: snapshot.status,
      jobCount: Array.isArray(snapshot.jobs) ? snapshot.jobs.length : 0,
      sourceUrl: snapshot.sourceUrl || null,
      capturedAt: snapshot.capturedAt || null,
      code: snapshot.code || null,
      message: snapshot.message || '',
    };
    if (snapshot.status !== 'ok' || !snapshot.jobs?.length) {
      await raiseIssue(input.companyId, null, 'moka.research', snapshot.status === 'blocked' ? 'blocking' : 'unknown', snapshot.message || '岗位快照不完整；未记录“没有符合职位”。', { evidence: snapshot.code || '' });
      await refreshDigest(input.companyId);
      return { message: `${snapshot.message || '检索结果不完整'}；未记录无职位结论。` };
    }
    const jobs = snapshot.jobs.map((job) => ({
      officialId: job.jobId,
      title: job.title,
      location: job.city || '',
      requirements: job.jd || '',
      url: job.url,
    }));
    const { router } = await routerWithRoles();
    const facts = await factsFor(input.companyId);
    const profileVersion = profileVersionFor(summary);
    const officialSnapshot = {
      sourceUrl: snapshot.sourceUrl,
      capturedAt: snapshot.capturedAt,
      complete: snapshot.status === 'ok' && jobs.length > 0,
      jobs,
    };
    const result = await router.rankCandidates({
      authorization: authorization({
        grantId: operation.id,
        role: 'research',
        companyId: input.companyId,
        profileVersion,
        budget: createCallBudget({ maxCalls: 1, maxInputChars: 60000, maxOutputChars: 8000 }),
        sendScope: { factIds: facts.map((fact) => fact.id), controlIds: [], fieldKeys: [] },
      }),
      officialSnapshot,
      confirmedFacts: facts,
      companyId: input.companyId,
      profileVersion,
      signal,
    });
    throwIfAborted(signal);
    if (!result.suggestions.length) {
      await raiseIssue(input.companyId, null, 'moka.research', 'unknown', '模型没有给出岗位建议；保留待核，未记录“没有符合职位”。');
      await refreshDigest(input.companyId);
      return { message: '模型没有给出岗位建议；保留待核，未自动结束公司。' };
    }
    await assertStillCurrent({ companyId: input.companyId, profileVersion });
    const jobById = new Map(snapshot.jobs.map((job) => [job.jobId, job]));
    const positionsToRecord = result.suggestions.map((suggestion) => {
      const job = jobById.get(suggestion.officialId);
      return {
        officialId: suggestion.officialId,
        title: job.title,
        city: job.city || '',
        sourceUrl: job.url,
        checkedAt: snapshot.capturedAt,
        matchEvidence: [suggestion.reason, ...(suggestion.gaps || []).map((gap) => `缺口：${gap}`)].join('；').slice(0, 2000),
      };
    });
    await registry.invoke('record_position_candidates', {
      companyId: input.companyId,
      eventId: `moka_${newId()}`,
      positions: positionsToRecord,
    });
    researchCache.suggestions = result.suggestions.map((item) => ({ officialId: item.officialId, title: item.title }));
    return { message: `已记录 ${positionsToRecord.length} 个候选岗位；仍需本人选择与复核。` };
  }

  async function prepareFill(input, { signal } = {}) {
    if (input.sendAuthorized !== true) throw new Error('未勾选本次模型发送授权；0 个模型请求。');
    const { summary, company, positions } = await companyContext(input.companyId);
    if (company.status !== 'preparing') throw new Error('公司不在填写阶段；请先由本人选择岗位。');
    const position = activePosition(company, positions);
    if (!position || position.id !== input.jobId) throw new Error('指定岗位不是当前活动岗位；拒绝使用其他岗位或公司的计划。');
    if (!driver || !opened || opened.companyId !== input.companyId) throw new Error('请先打开当前公司的受控 Moka 窗口。');
    const expectedUrl = sourceUrlForPosition(company, position);
    const observed = await driver.observe();
    if (!observed?.ok || !observed.snapshot) throw new Error(observed?.message || '页面观察失败；未生成填写计划。');
    const snapshot = observed.snapshot;
    if (expectedUrl && observed.snapshot.pageUrl !== expectedUrl && !observed.snapshot.pageUrl.startsWith(expectedUrl.split('?')[0])) {
      throw new Error('当前页面与已保存岗位来源不一致；拒绝生成计划。');
    }
    for (const pageIssue of snapshot.issues || []) {
      const code = String(pageIssue?.code || 'PAGE_OBSERVATION');
      const safety = ['CREDENTIAL_FIELD_BLOCKED', 'UNSUPPORTED_UPLOAD'].includes(code);
      const blocking = code === 'NO_WRITABLE_CONTROLS';
      await raiseIssue(
        input.companyId,
        position.id,
        `moka.page.${code}`,
        safety ? 'safety' : (blocking ? 'blocking' : 'unknown'),
        pageIssue?.message || '页面观察发现未处理控件；相关控件未进入填写计划。',
        { blocking, evidence: code },
      );
    }
    const facts = await factsFor(input.companyId, position.id);
    const semantic = suggestMokaFieldMappings(snapshot.controls);
    const items = [];
    const unresolved = [];
    const notes = [];
    for (const candidate of semantic.candidates) {
      const matching = facts.filter((fact) => factMatchesKey(fact, candidate.factKey));
      if (matching.length !== 1) {
        if (matching.length === 0) {
          notes.push([candidate.controlRef, 'unknown', '没有与控件栏目精确匹配的已确认资料；未填写，也未让模型猜值。']);
        }
        unresolved.push(candidate);
        continue;
      }
      const fact = matching[0];
      const control = snapshot.controls.find((item) => item.ref === candidate.controlRef);
      if (!control) continue;
      if (control.region?.entityId && fact.entityId && control.region.entityId !== fact.entityId) {
        notes.push([candidate.controlRef, 'conflict', '控件经历 ID 与已确认资料的 entityId 不一致；未填写。']);
        continue;
      }
      if (control.region?.type && ['education', 'internship', 'project'].includes(control.region.type)
        && (!control.region.entityId || !fact.entityId)) {
        notes.push([candidate.controlRef, 'unknown', '重复经历缺少稳定 entityId；未自动绑定。']);
        continue;
      }
      let optionValue = null;
      let optionLabel = null;
      let text = normalizePlanText(fact.value);
      if (control.type === 'select') {
        const option = selectOption(control, fact.value);
        if (!option) {
          notes.push([candidate.controlRef, 'unknown', '下拉字段没有与确认值精确且唯一匹配的选项；未选择。']);
          continue;
        }
        optionValue = option.value;
        optionLabel = option.label;
        text = optionLabel;
      }
      if (control.maxLength !== null && control.maxLength !== undefined && text.length > control.maxLength) {
        notes.push([candidate.controlRef, 'overlong', `确认原文超过页面长度上限（${text.length}/${control.maxLength}）；未截断。`]);
        continue;
      }
      items.push({
        controlRef: candidate.controlRef,
        factId: fact.id,
        factVersion: fact.version,
        confirmed: true,
        confirmedVersion: fact.confirmedVersion,
        originalText: fact.value,
        text,
        regionType: control.region?.type || 'unknown',
        regionEntityId: control.region?.entityId || null,
        expectedLabel: control.label,
        fieldKey: candidate.factKey,
        ...(control.type === 'select' ? { optionValue, optionLabel } : {}),
      });
    }

    // 只有确定性语义无法覆盖、且模型可能安全处理的普通文本控件才发送 ID 映射。
    const unresolvedWithFacts = unresolved.filter((candidate) => facts.some((fact) => factMatchesKey(fact, candidate.factKey)));
    if (unresolvedWithFacts.length) {
      const { roles, router } = await routerWithRoles();
      if (roles.execute) {
        const controls = unresolvedWithFacts
          .filter((candidate) => candidate.controlType !== 'select')
          .slice(0, 50)
          .map((candidate) => {
            const matched = semantic.candidates.find((item) => item.controlRef === candidate.controlRef) || candidate;
            const rule = factKeySections(matched.factKey);
            return {
              controlId: candidate.controlRef,
              label: candidate.label,
              type: candidate.controlType || 'text',
              visible: true,
              approved: true,
              ambiguous: false,
              semanticsClear: true,
              expectedSection: rule?.expectedSection || null,
              maxLength: snapshot.controls.find((item) => item.ref === candidate.controlRef)?.maxLength ?? null,
              entityId: candidate.regionEntityId || null,
            };
          });
        if (controls.length) {
          const result = await router.mapFields({
            authorization: authorization({
              grantId: operation.id,
              role: 'execute',
              companyId: input.companyId,
              profileVersion: profileVersionFor(summary),
              budget: createCallBudget({ maxCalls: 1, maxInputChars: 60000, maxOutputChars: 8000 }),
              sendScope: { factIds: facts.map((fact) => fact.id), controlIds: controls.map((item) => item.controlId), fieldKeys: [] },
            }),
            controls,
            facts,
            companyId: input.companyId,
            positionId: position.id,
            profileVersion: profileVersionFor(summary),
            signal,
          });
          throwIfAborted(signal);
          await assertStillCurrent({ companyId: input.companyId, positionId: position.id, profileVersion: profileVersionFor(summary) });
          for (const mapping of result.mappings) {
            const control = snapshot.controls.find((item) => item.ref === mapping.controlId);
            const fact = facts.find((item) => item.id === mapping.factId);
            const semanticCandidate = semantic.candidates.find((item) => item.controlRef === mapping.controlId);
            if (!control || !fact || control.type === 'select') continue;
            if (!semanticCandidate || !factMatchesKey(fact, semanticCandidate.factKey)) {
              notes.push([control.ref, 'conflict', '模型选择的字段与该控件候选语义不兼容；未填写。']);
              continue;
            }
            if (items.some((item) => item.controlRef === control.ref)) continue;
            if (control.maxLength !== null && fact.value.length > control.maxLength) {
              notes.push([control.ref, 'overlong', '模型映射的确认原文超过控件长度；未截断。']);
              continue;
            }
            items.push({
              controlRef: control.ref,
              factId: fact.id,
              factVersion: fact.version,
              confirmed: true,
              confirmedVersion: fact.confirmedVersion,
              originalText: fact.value,
              text: normalizePlanText(fact.value),
              regionType: control.region?.type || 'unknown',
              regionEntityId: control.region?.entityId || null,
              expectedLabel: control.label,
              fieldKey: semanticCandidate.factKey,
            });
          }
        }
      }
    }
    for (const item of semantic.ambiguous) {
      notes.push([item.controlRef, 'unknown', item.reason || '字段语义不明确；未自动填写。']);
    }
    for (const item of semantic.unsupported) {
      notes.push([item.controlRef, 'unknown', item.reason || '控件类型暂不支持；未自动处理。']);
    }
    for (const [controlRef, type, message] of notes) {
      await raiseIssue(input.companyId, position.id, `moka.${controlRef}`, type, message);
    }
    await refreshDigest(input.companyId);
    throwIfAborted(signal);
    if (!items.length) throw new Error('没有可安全填写的已确认字段；未生成计划，也未写入页面。');
    await assertStillCurrent({ companyId: input.companyId, positionId: position.id, profileVersion: profileVersionFor(summary) });
    const planId = `moka_plan_${newId()}`;
    const plan = validateMokaFillPlan({
      schemaVersion: MOKA_FILL_PLAN_SCHEMA_VERSION,
      snapshotId: snapshot.id,
      pageUrl: snapshot.pageUrl,
      targetId: snapshot.targetId,
      items,
    });
    if (!plan.ok) throw new Error(`填写计划未通过严格 schema：${plan.issues[0]?.message || '结构无效'}`);
    planCache = {
      planId,
      plan: plan.plan,
      companyId: input.companyId,
      positionId: position.id,
      profileVersion: profileVersionFor(summary),
      jobsSignature: modelSignature(await getRoles()),
      createdAt: now(),
      confirmed: false,
      used: false,
    };
    return { message: `已准备 ${plan.plan.items.length} 个字段的填写计划；等待本人确认一次后执行。` };
  }

  async function runFill(input, { signal } = {}) {
    if (input.sendAuthorized !== true) throw new Error('未勾选本次模型发送授权；0 个模型请求。');
    if (!planCache || planCache.planId !== input.planId) throw new Error('计划不存在或已失效；只接受当前服务缓存的 planId。');
    if (planCache.used) throw new Error('该计划已经执行过；禁止重放。');
    if (planCache.confirmed !== true) throw new Error('计划尚未由本人确认。');
    const cache = planCache;
    const { summary, company } = await companyContext(input.companyId);
    if (cache.companyId !== input.companyId || cache.positionId !== input.jobId) {
      throw new Error('计划绑定的公司或岗位与当前任务不一致；拒绝执行。');
    }
    if (company.activePositionId !== cache.positionId) throw new Error('活动岗位已变化；拒绝旧计划。');
    if (profileVersionFor(summary) !== cache.profileVersion) throw new Error('资料版本已变化；请重新准备计划。');
    if (modelSignature(await getRoles()) !== cache.jobsSignature) throw new Error('模型配置已变化；请重新准备计划。');
    if (!driver) throw new Error('受控 Moka 窗口未打开。');
    throwIfAborted(signal);
    cache.used = true;
    const fillResult = await driver.fillConfirmedPlan(cache.plan, {
      signal,
      beforeWrite: async () => {
        if (signal?.aborted) return false;
        try {
          await assertStillCurrent({ companyId: input.companyId, positionId: cache.positionId, profileVersion: cache.profileVersion });
          return !signal?.aborted;
        } catch {
          return false;
        }
      },
    });
    // 取消后不得继续批量读回、复核或落地成功；已发出的一次 page.write 允许完成。
    throwIfAborted(signal);
    await assertStillCurrent({ companyId: input.companyId, positionId: cache.positionId, profileVersion: cache.profileVersion });
    const expectedFields = cache.plan.items.map((item) => ({
      fieldId: item.controlRef,
      controlId: item.controlRef,
      label: item.expectedLabel || '',
      expectedValue: item.optionLabel || item.text,
    }));
    let readback = { ok: false, fields: [], message: '未执行批量读回。' };
    try {
      readback = await driver.readbackApprovedPlan(cache.plan);
    } catch (error) {
      readback = { ok: false, fields: [], message: error?.message || '批量读回失败。' };
    }
    throwIfAborted(signal);
    const snapshotFields = readback.ok ? readback.fields : [];
    const programDiffs = buildReviewDiff(expectedFields, snapshotFields);
    if (!readback.ok) {
      await raiseIssue(input.companyId, cache.positionId, 'moka.readback', 'review', readback.message || '页面读回失败；未用预期值代替实际值。', { blocking: true });
    }
    for (const diff of programDiffs) {
      await raiseIssue(
        input.companyId,
        cache.positionId,
        `moka.${diff.fieldId}`,
        'review',
        diff.reason === 'missing_readback'
          ? '页面没有读回该字段的实际值；按失败处理，不以预期值代替。'
          : '页面实际读回与确认原文不一致；请本人核对，未自动修正。',
        { blocking: true, evidence: diff.reason },
      );
    }
    for (const issue of fillResult.issues || []) {
      await raiseIssue(input.companyId, cache.positionId, `moka.${issue.controlRef || 'fill'}`, issue.severity === 'blocked' ? 'blocking' : 'unknown', issue.message || issue.code || '页面填写失败。', { blocking: issue.severity === 'blocked' });
    }
    throwIfAborted(signal);
    await assertStillCurrent({ companyId: input.companyId, positionId: cache.positionId, profileVersion: cache.profileVersion });
    let review = null;
    let reviewError = null;
    const { roles, router } = await routerWithRoles();
    if (!roles.review) {
      reviewError = '未配置 review 角色；填写结果未经独立模型复核。';
    } else if (!readback.ok || snapshotFields.length === 0) {
      reviewError = '没有实际页面读回值；拒绝让模型仅凭预期值宣称复核通过。';
    } else {
      try {
        review = await router.reviewReadback({
          authorization: authorization({
            grantId: operation.id,
            role: 'review',
            companyId: input.companyId,
            profileVersion: cache.profileVersion,
            planVersion: cache.planId,
            budget: createCallBudget({ maxCalls: 1, maxInputChars: 60000, maxOutputChars: 8000 }),
            sendScope: { factIds: [], controlIds: [], fieldKeys: expectedFields.map((field) => field.fieldId) },
          }),
          snapshot: {
            source: 'page_readback',
            url: readback.url,
            capturedAt: readback.capturedAt,
            fields: snapshotFields.map((field) => ({
              fieldId: field.fieldId,
              controlId: field.controlId,
              label: field.label,
              readbackValue: field.readbackValue,
            })),
          },
          expected: {
            planVersion: cache.planId,
            profileVersion: cache.profileVersion,
            fields: expectedFields,
          },
          companyId: input.companyId,
          signal,
        });
        throwIfAborted(signal);
        await assertStillCurrent({ companyId: input.companyId, positionId: cache.positionId, profileVersion: cache.profileVersion });
        for (const finding of review.modelFindings || []) {
          await raiseIssue(input.companyId, cache.positionId, `moka.${finding.fieldId}`, 'review', finding.message || finding.reason || '独立复核提出问题。', { blocking: true, evidence: finding.severity || '' });
        }
      } catch (error) {
        throwIfAborted(signal);
        reviewError = String(error?.message || '独立复核失败。').slice(0, 500);
      }
    }
    throwIfAborted(signal);
    if (reviewError) {
      await raiseIssue(input.companyId, cache.positionId, 'moka.review', 'review', reviewError, { blocking: true });
    }
    await refreshDigest(input.companyId);
    throwIfAborted(signal);
    reviewCache = {
      passed: fillResult.ok === true && Boolean(review?.passed) && programDiffs.length === 0 && readback.ok,
      fillOk: fillResult.ok === true,
      programDiffs,
      modelFindings: review?.modelFindings || [],
      readbackCapturedAt: readback.capturedAt || null,
      readbackFields: snapshotFields.length,
      reviewError,
      note: '填写与复核结果不自动提交，也不自动标记可提交；请本人终审。',
    };
    const ok = fillResult.ok === true && readback.ok && programDiffs.length === 0 && review?.passed === true && !reviewError;
    return { message: ok ? '填写、实际读回与独立复核均通过；仍需本人终审，未提交。' : '填写或复核未全部通过；问题已集中记录，未提交。' };
  }

  async function cancel(reason = '') {
    if (!operation || operation.status !== 'running') {
      if (driver) void driver.close().catch(() => {});
      return { cancelled: false, message: '没有运行中的受控操作。' };
    }
    if (activeController) activeController.abort();
    operation.status = 'cancelled';
    operation.message = `已由本人停止${reason ? `：${reason}` : ''}；未继续后续填写或模型调用。`;
    operation.finishedAt = now();
    await persistSummary(summaryFor('cancelled', { message: operation.message }));
    // 暂停命令立即返回；关闭仍在串行队列后等待已发出的单次写入结束，不阻塞状态读取。
    if (driver) void driver.close().catch(() => {});
    return { cancelled: true, message: operation.message };
  }

  async function stop() {
    if (activeController) activeController.abort();
    if (operation?.status === 'running') {
      operation.status = 'cancelled';
      operation.message = '本地服务停止；后台操作已取消，未重放。';
      operation.finishedAt = now();
      await persistSummary(summaryFor('cancelled', { message: operation.message })).catch(() => {});
    }
    if (driver) await driver.close().catch(() => {});
    driver = null;
    opened = null;
  }

  function invalidatePlan(reason = '本地资料已修改') {
    if (operation?.status === 'running' || activeController) {
      throw new Error('后台操作仍在运行；不能在未知结果期间使计划失效。');
    }
    const invalidated = Boolean(planCache);
    planCache = null;
    reviewCache = null;
    return { invalidated, reason: String(reason || '本地资料已修改').slice(0, 200) };
  }

  return {
    MOKA_WORKFLOW_COMMANDS,
    startOpen: (input) => runOperation('openMoka', input, () => open(input)),
    startResearch: (input) => runOperation('researchMoka', input, ({ signal }) => research(input, { signal })),
    startPrepare: (input) => runOperation('prepareFill', input, ({ signal }) => prepareFill(input, { signal })),
    startRun: (input) => runOperation('runFill', input, ({ signal }) => runFill(input, { signal })),
    confirmPlan(planId, confirm) {
      if (!planCache || planCache.planId !== planId) throw new Error('计划不存在或已失效。');
      if (confirm !== true) throw new Error('确认参数无效。');
      planCache.confirmed = true;
      return publicPlan(planCache.plan, planCache);
    },
    cancel,
    stop,
    invalidatePlan,
    getState,
    getPlan(planId) {
      return planCache && planCache.planId === planId ? publicPlan(planCache.plan, planCache) : null;
    },
  };
}
