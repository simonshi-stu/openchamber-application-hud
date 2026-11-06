import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { PRIVATE_ROOT } from '../../../core/store.js';
import {
  createHud05InteractiveServer,
  createHud05InteractiveSession,
} from './hud-05-interactive.js';

function parseCookies(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  return values.map((value) => value.split(';', 1)[0]).filter(Boolean).join('; ');
}

function csrfFromHtml(html) {
  const match = /<meta name="hud05-csrf" content="([^"]+)"/.exec(html);
  assert.ok(match, 'HTML must expose only the non-secret CSRF token to its same-origin page');
  return match[1];
}

async function jsonResponse(response) {
  return { status: response.status, body: await response.json() };
}

async function startHttp(t, options = {}) {
  const app = await createHud05InteractiveServer({ reportPath: null, ...options });
  t.after(() => app.stop());
  const page = await fetch(app.url);
  const html = await page.text();
  return {
    app,
    cookies: parseCookies(page),
    csrf: csrfFromHtml(html),
  };
}

async function getState(client) {
  const response = await fetch(`${client.app.origin}/api/state`, {
    headers: { Cookie: client.cookies },
  });
  return jsonResponse(response);
}

async function action(client, name, payload = {}) {
  const response = await fetch(`${client.app.origin}/api/action`, {
    method: 'POST',
    headers: {
      Cookie: client.cookies,
      Origin: client.app.origin,
      'X-HUD05-CSRF': client.csrf,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: name, payload }),
  });
  return jsonResponse(response);
}

async function complete(client) {
  const initial = await getState(client);
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.equal(initial.body.state.stage, 'confirm_material');
  const initialState = initial.body.state;
  const confirmed = await action(client, 'confirm_material', {
    binding: initialState.material.binding,
    values: {
      content: initialState.material.candidate.content,
      responsibilities: initialState.material.candidate.responsibilities,
    },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const selected = await action(client, 'select_position', { binding: confirmed.body.state.position.binding });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  const prepared = await action(client, 'prepare_plan', {
    positionBinding: selected.body.state.position.binding,
    materialBinding: selected.body.state.material.binding,
  });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const planned = await action(client, 'confirm_plan', { binding: prepared.body.state.plan.binding });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  const filled = await action(client, 'run_fill', { binding: planned.body.state.plan.binding });
  assert.equal(filled.status, 200, JSON.stringify(filled.body));
  return filled.body.state;
}

function decodeHtml(value) {
  return String(value)
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

class Hud05DomElement {
  constructor(id) {
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.readOnly = false;
    this.value = '';
    this.textContent = '';
    this.className = '';
    this.onclick = null;
    this.listeners = new Map();
    this._innerHTML = '';
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    const textareaPattern = /<textarea id="([^"]+)">([\s\S]*?)<\/textarea>/g;
    let match;
    while ((match = textareaPattern.exec(this._innerHTML))) {
      const child = this.ownerDocument.replace(match[1]);
      child.value = decodeHtml(match[2]);
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener(event);
  }

  click() {
    if (this.disabled) return undefined;
    if (typeof this.onclick === 'function') this.onclick({ target: this });
    for (const listener of this.listeners.get('click') || []) listener({ target: this, type: 'click' });
    return undefined;
  }
}

class Hud05DomDocument {
  constructor() {
    this.elements = new Map();
    this.meta = { content: 'dom-test-csrf' };
  }

  ensure(id) {
    if (!this.elements.has(id)) {
      const element = new Hud05DomElement(id);
      element.ownerDocument = this;
      this.elements.set(id, element);
    }
    return this.elements.get(id);
  }

  replace(id) {
    const element = new Hud05DomElement(id);
    element.ownerDocument = this;
    this.elements.set(id, element);
    return element;
  }

  querySelector(selector) {
    if (selector === 'meta[name="hud05-csrf"]') return this.meta;
    if (selector.startsWith('#')) return this.ensure(selector.slice(1));
    throw new Error(`DOM test selector not implemented: ${selector}`);
  }
}

function fakeResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

async function runHud05DomApp({ initialState, postResponses = [], getResponses = [] }) {
  const document = new Hud05DomDocument();
  const posted = [];
  const fetchCalls = [];
  let getIndex = 0;
  const fetch = async (url, options = {}) => {
    fetchCalls.push({ url, options });
    if (options.method === 'POST') {
      posted.push(JSON.parse(options.body));
      const response = postResponses.shift() || { body: { ok: true, state: initialState }, status: 200 };
      return fakeResponse(response.body, response.status);
    }
    const response = getResponses[getIndex++] || { body: { ok: true, state: initialState }, status: 200 };
    return fakeResponse(response.body, response.status);
  };
  const timers = new Set();
  const window = {
    clearTimeout(timer) { timers.delete(timer); },
    setTimeout(callback) {
      const timer = setImmediate(callback);
      timers.add(timer);
      return timer;
    },
    addEventListener() {},
  };
  const source = await fs.readFile(path.join('integrations', 'openchamber', 'trial', 'hud-05', 'app.js'), 'utf8');
  vm.runInNewContext(source, {
    document,
    window,
    fetch,
    console,
    setImmediate,
    Promise,
  }, { filename: 'hud-05/app.js' });
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { document, posted, fetchCalls, flush: () => new Promise((resolve) => setImmediate(resolve)) };
}

async function runDeferredHud05DomApp(initialState) {
  const document = new Hud05DomDocument();
  const pending = [];
  const fetchCalls = [];
  let initialRequest = true;
  const fetch = (url, options = {}) => {
    fetchCalls.push({ url, options });
    if (initialRequest && !options.method) {
      initialRequest = false;
      return Promise.resolve(fakeResponse({ ok: true, state: initialState }));
    }
    return new Promise((resolve) => pending.push({ url, options, resolve }));
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const window = {
    clearTimeout() {},
    setTimeout() { throw new Error('Unexpected polling in deferred draft test'); },
    addEventListener() {},
  };
  const source = await fs.readFile(path.join('integrations', 'openchamber', 'trial', 'hud-05', 'app.js'), 'utf8');
  vm.runInNewContext(source, {
    document,
    window,
    fetch,
    console,
    setImmediate,
    Promise,
  }, { filename: 'hud-05/app.js' });
  for (let index = 0; index < 4; index += 1) await tick();

  async function resolveNext(body, status = 200) {
    const request = pending.shift();
    assert.ok(request, 'a deferred request must be pending');
    let resolveJson;
    request.resolve({
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return new Promise((resolve) => { resolveJson = resolve; });
      },
    });
    while (!resolveJson) await tick();
    resolveJson(body);
    for (let index = 0; index < 3; index += 1) await tick();
  }

  return {
    document,
    pending,
    fetchCalls,
    resolveNext,
    values() {
      return [
        document.querySelector('#candidate-content').value,
        document.querySelector('#candidate-responsibilities').value,
      ];
    },
  };
}

function setDomDraft(document, content, responsibilities) {
  const contentInput = document.querySelector('#candidate-content');
  const responsibilitiesInput = document.querySelector('#candidate-responsibilities');
  contentInput.value = content;
  responsibilitiesInput.value = responsibilities;
  contentInput.dispatchEvent({ type: 'input' });
  responsibilitiesInput.dispatchEvent({ type: 'input' });
}

function materialResponseState(base, {
  revision,
  content,
  responsibilities,
  confirmed = false,
  bindingKind = 'same',
}) {
  const next = structuredClone(base);
  next.interactionRevision = revision;
  next.stage = confirmed ? 'select_position' : 'confirm_material';
  next.material.candidate.content = content;
  next.material.candidate.responsibilities = responsibilities;
  next.material.candidate.confirmed = confirmed;
  next.actions = {
    ...next.actions,
    editMaterial: true,
    confirmMaterial: !confirmed,
  };
  if (bindingKind === 'same') {
    next.material.binding = structuredClone(base.material.binding);
    if (typeof next.material.binding.profileRevision === 'number') next.material.binding.profileRevision += 1;
    if (typeof next.material.binding.coreRevision === 'number') next.material.binding.coreRevision += 1;
    next.material.binding.facts = next.material.binding.facts.map((fact) => ({
      ...fact,
      version: (fact.version || 0) + 1,
      value: fact.section === 'project_content' ? content : responsibilities,
    }));
  } else {
    next.material.binding = {
      ...structuredClone(base.material.binding),
      candidateId: 'different-synthetic-candidate',
      companyId: 'different-synthetic-company',
      positionId: 'different-synthetic-position',
      sourceName: 'different-synthetic-source.txt',
      sourceParagraphIds: ['different-paragraph'],
      facts: base.material.binding.facts.map((fact, index) => ({
        ...structuredClone(fact),
        id: `different-fact-${index}`,
        source: { type: 'resume', ref: 'different-synthetic-source.txt#different-paragraph' },
        scope: { type: 'position', companyId: 'different-synthetic-company', positionId: 'different-synthetic-position' },
      })),
    };
  }
  return next;
}

function parseTemplateTree(html) {
  const nodes = new Map();
  const root = { id: null, hidden: false, parent: null };
  const stack = [root];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const tokenPattern = /<!--[\s\S]*?-->|<\/?([A-Za-z][\w:-]*)([^>]*)>/g;
  let match;
  while ((match = tokenPattern.exec(html))) {
    const token = match[0];
    if (token.startsWith('<!--')) continue;
    const tag = match[1].toLowerCase();
    if (token.startsWith('</')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attributes = match[2] || '';
    const id = /\bid\s*=\s*["']([^"']+)["']/.exec(attributes)?.[1] || null;
    const node = {
      id,
      hidden: /(?:^|\s)hidden(?:\s|=|$)/.test(attributes),
      parent: stack.at(-1),
    };
    if (id) nodes.set(id, node);
    if (!voidTags.has(tag) && !token.endsWith('/>')) stack.push(node);
  }
  return nodes;
}

function templateVisible(nodes, id, hiddenOverrides = {}) {
  let node = nodes.get(id);
  assert.ok(node, `template must contain #${id}`);
  while (node) {
    const hidden = node.id && Object.hasOwn(hiddenOverrides, node.id)
      ? hiddenOverrides[node.id]
      : node.hidden;
    if (hidden) return false;
    node = node.parent;
  }
  return true;
}

function legacyPlanTemplate(indexHtml) {
  const planSectionStart = indexHtml.indexOf('<section id="plan-section"');
  assert.ok(planSectionStart >= 0, 'real template must contain the plan section');
  const planFragment = indexHtml.slice(planSectionStart);
  const match = /(<div id="plan-content" hidden>[\s\S]*?<\/div>)\s*(<div class="action-row">[\s\S]*?<\/div>)/.exec(planFragment);
  assert.ok(match, 'real template must expose the fixed plan-content/action-row split');
  const planOpenAndTable = match[1].slice(0, match[1].lastIndexOf('</div>'));
  const legacyBlock = `${planOpenAndTable}\n${match[2]}\n          </div>`;
  return `${indexHtml.slice(0, planSectionStart)}${planFragment.replace(match[0], legacyBlock)}`;
}

test('real index template keeps prepare plan visible only after material and position gates', async (t) => {
  const indexPath = path.join('integrations', 'openchamber', 'trial', 'hud-05', 'index.html');
  const appPath = path.join('integrations', 'openchamber', 'trial', 'hud-05', 'app.js');
  const [indexHtml, appSource] = await Promise.all([
    fs.readFile(indexPath, 'utf8'),
    fs.readFile(appPath, 'utf8'),
  ]);
  assert.match(appSource, /el\.planContent\.hidden = !plan/);

  const fixedTree = parseTemplateTree(indexHtml);
  const legacyTree = parseTemplateTree(legacyPlanTemplate(indexHtml));
  const visibleRuntime = { 'plan-section': false, 'plan-content': true, 'prepare-plan-button': false };
  assert.equal(
    templateVisible(legacyTree, 'prepare-plan-button', visibleRuntime),
    false,
    '旧模板中 plan-content 的祖先 hidden 必须复现原始阻断',
  );
  assert.equal(
    templateVisible(fixedTree, 'prepare-plan-button', visibleRuntime),
    true,
    '修复模板中 prepare button 不得位于 hidden plan-content 内',
  );

  const client = await startHttp(t);
  const initial = await getState(client);
  const initialDom = await runHud05DomApp({ initialState: initial.body.state });
  assert.equal(initialDom.document.querySelector('#plan-section').hidden, true);
  assert.equal(
    templateVisible(fixedTree, 'prepare-plan-button', {
      'plan-section': initialDom.document.querySelector('#plan-section').hidden,
      'plan-content': initialDom.document.querySelector('#plan-content').hidden,
      'prepare-plan-button': initialDom.document.querySelector('#prepare-plan-button').hidden,
    }),
    false,
    '未确认材料时生成计划仍不可见',
  );

  const confirmed = await action(client, 'confirm_material', {
    binding: initial.body.state.material.binding,
    values: {
      content: initial.body.state.material.candidate.content,
      responsibilities: initial.body.state.material.candidate.responsibilities,
    },
  });
  const beforePositionDom = await runHud05DomApp({ initialState: confirmed.body.state });
  assert.equal(beforePositionDom.document.querySelector('#plan-section').hidden, true);
  assert.equal(
    templateVisible(fixedTree, 'prepare-plan-button', {
      'plan-section': beforePositionDom.document.querySelector('#plan-section').hidden,
      'plan-content': beforePositionDom.document.querySelector('#plan-content').hidden,
      'prepare-plan-button': beforePositionDom.document.querySelector('#prepare-plan-button').hidden,
    }),
    false,
    '未选择岗位时生成计划仍不可见',
  );

  const selected = await action(client, 'select_position', { binding: confirmed.body.state.position.binding });
  assert.equal(selected.body.state.stage, 'prepare_plan');
  const selectedDom = await runHud05DomApp({ initialState: selected.body.state });
  const prepareButton = selectedDom.document.querySelector('#prepare-plan-button');
  const planContent = selectedDom.document.querySelector('#plan-content');
  const planSection = selectedDom.document.querySelector('#plan-section');
  assert.equal(prepareButton.hidden, false, '实际 app.js 必须显示 prepare button 自身');
  assert.equal(planContent.hidden, true, '无 plan 时 plan-content 仍可隐藏计划表内容');
  assert.equal(planSection.hidden, false, '材料确认且岗位选择后 plan section 必须显示');
  assert.equal(
    templateVisible(fixedTree, 'prepare-plan-button', {
      'plan-section': planSection.hidden,
      'plan-content': planContent.hidden,
      'prepare-plan-button': prepareButton.hidden,
    }),
    true,
    '实际 app.js 状态叠加真实 index.html 祖先层级后按钮必须可见',
  );
});

test('HUD-05 local page enforces auth/Origin/CSRF and exposes a stepwise happy path', async (t) => {
  const client = await startHttp(t);
  const noSession = await fetch(`${client.app.origin}/api/state`);
  assert.equal(noSession.status, 401);
  const wrongOrigin = await fetch(`${client.app.origin}/api/action`, {
    method: 'POST',
    headers: {
      Cookie: client.cookies,
      Origin: 'http://127.0.0.1:9',
      'X-HUD05-CSRF': client.csrf,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'confirm_material', payload: {} }),
  });
  assert.equal(wrongOrigin.status, 403);

  const initial = await getState(client);
  const initialState = initial.body.state;
  assert.equal(initialState.synthetic, true);
  assert.equal(initialState.offline, true);
  assert.equal(initialState.material.candidate.confirmed, false);
  assert.equal(initialState.material.source.name, 'fixture-resume-hud04.txt');
  assert.equal(initialState.material.facts.some((fact) => fact.section === 'family'), false);
  assert.equal(initialState.actions.confirmMaterial, true);

  const final = await complete(client);
  assert.equal(final.stage, 'prepared');
  assert.equal(final.capabilities.networkCalls, 0);
  assert.equal(final.capabilities.realSubmission, false);
  assert.equal(final.capabilities.submitAction, false);
  assert.equal(final.review.passed, true);
  assert.equal(final.actualPage.writes.length, 2);
  assert.equal(final.actualPage.fields.find((field) => field.ref === 'hud04_content').value, '虚构项目内容第一行\n虚构项目内容第二行');
  assert.equal(final.actualPage.fields.find((field) => field.ref === 'hud04_responsibility').value, '虚构本人职责第一行\n虚构本人职责第二行');
  assert.equal(final.interactiveEvents.map((event) => event.type).join(','), 'confirm_material_candidate,select_synthetic_position,prepare_field_plan,confirm_field_plan,run_fake_page_fill_and_readback');
  assert.match(final.report.content, /realSubmission: false/);
  assert.match(final.report.content, /trial_setup/);

  const refreshed = await getState(client);
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.state.stage, 'prepared');
  assert.equal(refreshed.body.state.actualPage.writes.length, 2);
});

test('editing confirmed material revokes confirmation and invalidates the old plan', async (t) => {
  const client = await startHttp(t);
  const initial = await getState(client);
  const confirmed = await action(client, 'confirm_material', {
    binding: initial.body.state.material.binding,
    values: {
      content: initial.body.state.material.candidate.content,
      responsibilities: initial.body.state.material.candidate.responsibilities,
    },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const selected = await action(client, 'select_position', { binding: confirmed.body.state.position.binding });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  const prepared = await action(client, 'prepare_plan', {
    positionBinding: selected.body.state.position.binding,
    materialBinding: selected.body.state.material.binding,
  });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const oldPlanId = prepared.body.state.plan.planId;
  const oldText = prepared.body.state.plan.items.find((item) => item.fieldKey === 'project.content').text;
  const edited = await action(client, 'edit_material', {
    binding: prepared.body.state.material.binding,
    values: {
      content: `${oldText}\n修改后但仍为虚构原文`,
      responsibilities: prepared.body.state.material.candidate.responsibilities,
    },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.state.material.candidate.confirmed, false);
  assert.equal(edited.body.state.plan, null);
  assert.equal(edited.body.state.stage, 'confirm_material');
  assert.equal(client.app.session.env.driver().page.stats.writes, 0);
  assert.equal(client.app.session.env.workflow.getPlan(oldPlanId), null);

  const staleConfirm = await action(client, 'confirm_plan', { binding: prepared.body.state.plan?.binding || { planId: oldPlanId } });
  assert.equal(staleConfirm.status, 409);
  assert.equal(staleConfirm.body.ok, false);
  assert.equal(staleConfirm.body.error.code, 'PLAN_REQUIRED');
});

test('confirmation and execution require exact observed bindings, including stale two-tab plan rejection', async (t) => {
  const client = await startHttp(t);
  const initial = await getState(client);
  const missingMaterialBinding = await action(client, 'confirm_material', {});
  assert.equal(missingMaterialBinding.status, 409);
  assert.equal(missingMaterialBinding.body.error.code, 'CONFIRMATION_BINDING_REQUIRED');
  assert.equal(initial.body.state.material.facts.every((fact) => fact.confirmed === false), true);

  const staleMaterialBinding = structuredClone(initial.body.state.material.binding);
  staleMaterialBinding.facts[0].version += 1;
  const staleMaterial = await action(client, 'confirm_material', {
    binding: staleMaterialBinding,
    values: {
      content: initial.body.state.material.candidate.content,
      responsibilities: initial.body.state.material.candidate.responsibilities,
    },
  });
  assert.equal(staleMaterial.status, 409);
  assert.equal(staleMaterial.body.error.code, 'STALE_MATERIAL_CONFIRMATION');
  assert.equal(staleMaterial.body.state.material.facts.every((fact) => fact.confirmed === false), true);

  const confirmed = await action(client, 'confirm_material', {
    binding: initial.body.state.material.binding,
    values: {
      content: initial.body.state.material.candidate.content,
      responsibilities: initial.body.state.material.candidate.responsibilities,
    },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const selected = await action(client, 'select_position', { binding: confirmed.body.state.position.binding });
  const preparedA = await action(client, 'prepare_plan', {
    positionBinding: selected.body.state.position.binding,
    materialBinding: selected.body.state.material.binding,
  });
  assert.equal(preparedA.status, 200, JSON.stringify(preparedA.body));
  const oldPlanBinding = structuredClone(preparedA.body.state.plan.binding);

  const edited = await action(client, 'edit_material', {
    binding: preparedA.body.state.material.binding,
    values: {
      content: `${preparedA.body.state.material.candidate.content}\n标签页 B 的修改`,
      responsibilities: preparedA.body.state.material.candidate.responsibilities,
    },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const reconfirmed = await action(client, 'confirm_material', {
    binding: edited.body.state.material.binding,
    values: {
      content: edited.body.state.material.candidate.content,
      responsibilities: edited.body.state.material.candidate.responsibilities,
    },
  });
  assert.equal(reconfirmed.status, 200, JSON.stringify(reconfirmed.body));
  const preparedB = await action(client, 'prepare_plan', {
    positionBinding: reconfirmed.body.state.position.binding,
    materialBinding: reconfirmed.body.state.material.binding,
  });
  assert.equal(preparedB.status, 200, JSON.stringify(preparedB.body));
  assert.notEqual(preparedB.body.state.plan.planId, oldPlanBinding.planId);

  const oldPlanConfirm = await action(client, 'confirm_plan', { binding: oldPlanBinding });
  assert.equal(oldPlanConfirm.status, 409);
  assert.equal(oldPlanConfirm.body.error.code, 'STALE_PLAN_CONFIRMATION');
  assert.equal(oldPlanConfirm.body.state.plan.confirmed, false);

  const confirmedB = await action(client, 'confirm_plan', { binding: preparedB.body.state.plan.binding });
  assert.equal(confirmedB.status, 200, JSON.stringify(confirmedB.body));
  const missingRunBinding = await action(client, 'run_fill', {});
  assert.equal(missingRunBinding.status, 409);
  assert.equal(missingRunBinding.body.error.code, 'PLAN_BINDING_REQUIRED');
  const oldRun = await action(client, 'run_fill', { binding: oldPlanBinding });
  assert.equal(oldRun.status, 409);
  assert.equal(oldRun.body.error.code, 'STALE_PLAN_CONFIRMATION');
  assert.equal(client.app.session.env.driver().page.stats.writes, 0);
});

test('unconfirmed candidates can atomically save both fields and stale atomic edits leave both unchanged', async (t) => {
  const client = await startHttp(t);
  const initial = await getState(client);
  assert.equal(initial.body.state.actions.editMaterial, true);
  const staleBinding = structuredClone(initial.body.state.material.binding);
  staleBinding.facts[1].version += 1;
  const failed = await action(client, 'edit_material', {
    binding: staleBinding,
    values: {
      content: '虚构新项目内容 A',
      responsibilities: '虚构新本人职责 A',
    },
  });
  assert.equal(failed.status, 409);
  assert.equal(failed.body.error.code, 'STALE_MATERIAL_CONFIRMATION');
  assert.equal(failed.body.state.material.facts.find((fact) => fact.section === 'project_content').version, 1);
  assert.equal(failed.body.state.material.facts.find((fact) => fact.section === 'project_responsibilities').version, 1);

  const edited = await action(client, 'edit_material', {
    binding: initial.body.state.material.binding,
    values: {
      content: '虚构新项目内容 A',
      responsibilities: '虚构新本人职责 A',
    },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.state.material.candidate.confirmed, false);
  assert.equal(edited.body.state.material.candidate.content, '虚构新项目内容 A');
  assert.equal(edited.body.state.material.candidate.responsibilities, '虚构新本人职责 A');
  assert.deepEqual(edited.body.state.material.facts.map((fact) => fact.version), [2, 2]);
  assert.equal(edited.body.state.material.binding.facts[0].value, '虚构新项目内容 A');
  assert.equal(edited.body.state.material.binding.facts[1].value, '虚构新本人职责 A');

  const confirmed = await action(client, 'confirm_material', {
    binding: edited.body.state.material.binding,
    values: {
      content: edited.body.state.material.candidate.content,
      responsibilities: edited.body.state.material.candidate.responsibilities,
    },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.state.material.facts.every((fact) => fact.confirmed === true), true);
});

test('actual HUD-05 page script keeps unconfirmed edits, both fields, and newer state over stale responses', async (t) => {
  const client = await startHttp(t);
  const initialResponse = await getState(client);
  const initialState = initialResponse.body.state;
  const changedContent = 'DOM 测试项目内容草稿';
  const changedResponsibilities = 'DOM 测试本人职责草稿';
  const editedResponse = await action(client, 'edit_material', {
    binding: initialState.material.binding,
    values: { content: changedContent, responsibilities: changedResponsibilities },
  });
  assert.equal(editedResponse.status, 200, JSON.stringify(editedResponse.body));
  const newerState = editedResponse.body.state;
  assert.ok(newerState.interactionRevision > initialState.interactionRevision);
  const staleResponseState = structuredClone(newerState);
  staleResponseState.interactionRevision += 1;
  staleResponseState.material.candidate.content = '服务端较新的项目值';
  staleResponseState.material.candidate.responsibilities = '服务端较新的职责值';
  for (const fact of staleResponseState.material.facts) {
    fact.version += 1;
    fact.confirmedVersion = null;
    fact.confirmed = false;
    fact.value = fact.section === 'project_content' ? '服务端较新的项目值' : '服务端较新的职责值';
  }
  for (const fact of staleResponseState.material.binding.facts) {
    fact.version += 1;
    fact.confirmedVersion = null;
    fact.confirmed = false;
    fact.value = fact.section === 'project_content' ? '服务端较新的项目值' : '服务端较新的职责值';
  }

  const dom = await runHud05DomApp({
    initialState,
    postResponses: [
      {
        status: 409,
        body: {
          ok: false,
          error: { code: 'STALE_MATERIAL_CONFIRMATION', message: 'synthetic save failure' },
          state: initialState,
        },
      },
      { status: 200, body: { ok: true, state: newerState } },
      {
        status: 409,
        body: {
          ok: false,
          error: { code: 'STALE_MATERIAL_CONFIRMATION', message: 'synthetic stale response' },
          state: staleResponseState,
        },
      },
    ],
    getResponses: [{ status: 200, body: { ok: true, state: initialState } }],
  });
  const contentInput = () => dom.document.querySelector('#candidate-content');
  const responsibilityInput = () => dom.document.querySelector('#candidate-responsibilities');
  const saveButton = dom.document.querySelector('#save-edit-button');
  const confirmButton = dom.document.querySelector('#confirm-material-button');

  assert.equal(contentInput().readOnly, false, 'unconfirmed content must be editable before approval');
  assert.equal(responsibilityInput().readOnly, false, 'unconfirmed responsibilities must be editable before approval');
  assert.equal(confirmButton.disabled, false);
  assert.equal(typeof saveButton.onclick, 'function');

  contentInput().value = 'DOM 失败保留的项目草稿';
  responsibilityInput().value = 'DOM 失败保留的职责草稿';
  contentInput().dispatchEvent({ type: 'input' });
  responsibilityInput().dispatchEvent({ type: 'input' });
  assert.equal(saveButton.disabled, false);
  await saveButton.click();
  await dom.flush();
  assert.ok(dom.posted[0], `fetch calls: ${dom.fetchCalls.length}`);
  assert.deepEqual(dom.posted[0].payload.values, {
    content: 'DOM 失败保留的项目草稿',
    responsibilities: 'DOM 失败保留的职责草稿',
  });
  assert.equal(contentInput().value, 'DOM 失败保留的项目草稿');
  assert.equal(responsibilityInput().value, 'DOM 失败保留的职责草稿');

  await saveButton.click();
  await dom.flush();
  assert.deepEqual(dom.posted[1].payload.values, {
    content: 'DOM 失败保留的项目草稿',
    responsibilities: 'DOM 失败保留的职责草稿',
  });
  assert.equal(contentInput().value, changedContent);
  assert.equal(responsibilityInput().value, changedResponsibilities);

  contentInput().value = 'DOM 旧响应期间的项目草稿';
  responsibilityInput().value = 'DOM 旧响应期间的职责草稿';
  contentInput().dispatchEvent({ type: 'input' });
  responsibilityInput().dispatchEvent({ type: 'input' });
  await saveButton.click();
  await dom.flush();
  assert.equal(dom.posted[2].payload.binding.facts[0].version, newerState.material.binding.facts[0].version);
  assert.equal(contentInput().value, 'DOM 旧响应期间的项目草稿');
  assert.equal(responsibilityInput().value, 'DOM 旧响应期间的职责草稿');

  const refresh = dom.document.querySelector('#refresh-button');
  await refresh.click();
  await dom.flush();
  assert.equal(contentInput().value, 'DOM 旧响应期间的项目草稿');
  assert.equal(responsibilityInput().value, 'DOM 旧响应期间的职责草稿');
});

test('deferred response and JSON handling preserves newer drafts and flags changed bindings', async (t) => {
  const client = await startHttp(t);
  const initial = (await getState(client)).body.state;

  const success = await runDeferredHud05DomApp(initial);
  setDomDraft(success.document, 'draft A content', 'draft A responsibilities');
  const oldContentInput = success.document.querySelector('#candidate-content');
  success.document.querySelector('#save-edit-button').click();
  assert.equal(success.pending.length, 1);
  setDomDraft(success.document, 'draft B content', 'draft B responsibilities');
  const savedA = materialResponseState(initial, {
    revision: initial.interactionRevision + 1,
    content: 'draft A content',
    responsibilities: 'draft A responsibilities',
  });
  await success.resolveNext({ ok: true, state: savedA });
  assert.deepEqual(success.values(), ['draft B content', 'draft B responsibilities']);
  assert.notEqual(success.document.querySelector('#candidate-content'), oldContentInput, 'rerender must replace the textarea node');
  assert.equal(success.document.querySelector('#candidate-content').listeners.get('input').length, 1);
  assert.equal(success.document.querySelector('#material-badge').textContent, '未确认 · 不可复用');
  assert.equal(success.document.querySelector('#save-edit-button').disabled, false);

  const failure = await runDeferredHud05DomApp(initial);
  setDomDraft(failure.document, 'draft A content', 'draft A responsibilities');
  failure.document.querySelector('#save-edit-button').click();
  assert.equal(failure.pending.length, 1);
  setDomDraft(failure.document, 'draft B content', 'draft B responsibilities');
  await failure.resolveNext({
    ok: false,
    error: { code: 'STALE_MATERIAL_CONFIRMATION', message: 'synthetic rejected save' },
    state: initial,
  }, 409);
  assert.deepEqual(failure.values(), ['draft B content', 'draft B responsibilities']);
  assert.equal(failure.document.querySelector('#save-edit-button').disabled, false);
  failure.document.querySelector('#save-edit-button').click();
  assert.equal(failure.pending.length, 1, 'a preserved draft remains explicitly saveable');
  const retryPayload = JSON.parse(failure.fetchCalls.at(-1).options.body);
  assert.deepEqual(retryPayload.payload.values, {
    content: 'draft B content',
    responsibilities: 'draft B responsibilities',
  });
  await failure.resolveNext({ ok: true, state: materialResponseState(initial, {
    revision: initial.interactionRevision + 1,
    content: 'draft B content',
    responsibilities: 'draft B responsibilities',
  }) });

  const refresh = await runDeferredHud05DomApp(initial);
  setDomDraft(refresh.document, 'draft A content', 'draft A responsibilities');
  refresh.document.querySelector('#refresh-button').click();
  assert.equal(refresh.pending.length, 1, 'refresh must use the real click listener and remain deferred');
  setDomDraft(refresh.document, 'draft B content', 'draft B responsibilities');
  const serverChanged = materialResponseState(initial, {
    revision: initial.interactionRevision + 2,
    content: 'server replacement content',
    responsibilities: 'server replacement responsibilities',
  });
  await refresh.resolveNext({ ok: true, state: serverChanged });
  assert.deepEqual(refresh.values(), ['draft B content', 'draft B responsibilities']);
  refresh.document.querySelector('#refresh-button').click();
  assert.equal(refresh.pending.length, 1);
  await refresh.resolveNext({ ok: true, state: initial });
  assert.deepEqual(refresh.values(), ['draft B content', 'draft B responsibilities'], 'older refresh response must not roll back the draft');

  const conflict = await runDeferredHud05DomApp(initial);
  setDomDraft(conflict.document, 'draft A content', 'draft A responsibilities');
  conflict.document.querySelector('#refresh-button').click();
  assert.equal(conflict.pending.length, 1);
  setDomDraft(conflict.document, 'draft B content', 'draft B responsibilities');
  const differentBinding = materialResponseState(initial, {
    revision: initial.interactionRevision + 1,
    content: 'different candidate content',
    responsibilities: 'different candidate responsibilities',
    bindingKind: 'different',
  });
  await conflict.resolveNext({ ok: true, state: differentBinding });
  assert.deepEqual(conflict.values(), ['draft B content', 'draft B responsibilities']);
  assert.equal(conflict.document.querySelector('#material-badge').textContent, '未确认 · 不可复用');
  assert.equal(conflict.document.querySelector('#save-edit-button').disabled, true);
  assert.match(conflict.document.querySelector('#material-action-note').textContent, /未自动重绑或确认/);
  conflict.document.querySelector('#refresh-button').click();
  assert.equal(conflict.pending.length, 1);
  await conflict.resolveNext({ ok: true, state: differentBinding });
  assert.deepEqual(conflict.values(), ['draft B content', 'draft B responsibilities']);
  assert.equal(conflict.document.querySelector('#save-edit-button').disabled, true, 'conflict must not silently rebind on refresh');
});

test('readback mismatch and unknown write remain visible and blocked', async (t) => {
  const mismatch = await startHttp(t, { scenario: 'readback-mismatch' });
  const mismatchState = await complete(mismatch);
  assert.equal(mismatchState.stage, 'blocked');
  assert.equal(mismatchState.review.passed, false);
  assert.ok(mismatchState.review.programDiffs.length > 0);
  assert.ok(mismatchState.issues.some((issue) => issue.blocking === true));
  assert.equal(mismatchState.capabilities.networkCalls, 0);

  const unknown = await startHttp(t, { scenario: 'unknown-write-recovery' });
  const initial = await getState(unknown);
  const confirmed = await action(unknown, 'confirm_material', {
    binding: initial.body.state.material.binding,
    values: {
      content: initial.body.state.material.candidate.content,
      responsibilities: initial.body.state.material.candidate.responsibilities,
    },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const selected = await action(unknown, 'select_position', { binding: confirmed.body.state.position.binding });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  const prepared = await action(unknown, 'prepare_plan', {
    positionBinding: selected.body.state.position.binding,
    materialBinding: selected.body.state.material.binding,
  });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const planned = await action(unknown, 'confirm_plan', { binding: prepared.body.state.plan.binding });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  const failed = await action(unknown, 'run_fill', { binding: planned.body.state.plan.binding });
  assert.equal(failed.status, 200, JSON.stringify(failed.body));
  assert.equal(failed.body.state.stage, 'blocked');
  assert.equal(failed.body.state.capabilities.networkCalls, 0);
  assert.ok(failed.body.state.issues.some((issue) => issue.blocking === true));
  assert.equal(unknown.app.session.env.driver().page.stats.writes, 1);

  const edited = await action(unknown, 'edit_material', {
    binding: failed.body.state.material.binding,
    values: {
      content: `${failed.body.state.material.candidate.content}\n未知写入后编辑草稿`,
      responsibilities: failed.body.state.material.candidate.responsibilities,
    },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.state.stage, 'blocked');
  assert.equal(edited.body.state.material.candidate.confirmed, false);
  assert.ok(edited.body.state.issues.some((issue) => issue.blocking === true));
  const reconfirmed = await action(unknown, 'confirm_material', {
    binding: edited.body.state.material.binding,
    values: {
      content: edited.body.state.material.candidate.content,
      responsibilities: edited.body.state.material.candidate.responsibilities,
    },
  });
  assert.equal(reconfirmed.status, 200, JSON.stringify(reconfirmed.body));
  assert.equal(reconfirmed.body.state.stage, 'blocked');
  assert.ok(reconfirmed.body.state.issues.some((issue) => issue.blocking === true));
  const blockedPrepare = await action(unknown, 'prepare_plan', {
    positionBinding: reconfirmed.body.state.position.binding,
    materialBinding: reconfirmed.body.state.material.binding,
  });
  assert.equal(blockedPrepare.status, 409);
  assert.equal(blockedPrepare.body.error.code, 'BLOCKING_ISSUES_PRESENT');
  const blockedConfirm = await action(unknown, 'confirm_plan', { binding: planned.body.state.plan.binding });
  assert.equal(blockedConfirm.status, 409);
  assert.equal(blockedConfirm.body.error.code, 'PLAN_REQUIRED');
  const retry = await action(unknown, 'run_fill', { binding: planned.body.state.plan.binding });
  assert.equal(retry.status, 409);
  assert.equal(retry.body.error.code, 'BLOCKING_ISSUES_PRESENT');
  assert.equal(unknown.app.session.env.driver().page.stats.writes, 1);
});

test('restart reuses only the synthetic core checkpoint and requires fresh observation', async (t) => {
  const sandbox = await fs.mkdtemp(path.join(PRIVATE_ROOT, `hud05-restart-${randomUUID()}-`));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const first = await createHud05InteractiveSession({ sandboxPath: sandbox, reportPath: null });
  const initial = await first.getState();
  const confirmed = await first.action('confirm_material', {
    binding: initial.material.binding,
    values: {
      content: initial.material.candidate.content,
      responsibilities: initial.material.candidate.responsibilities,
    },
  });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  const selected = await first.action('select_position', { binding: confirmed.state.position.binding });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  const prepared = await first.action('prepare_plan', {
    positionBinding: selected.state.position.binding,
    materialBinding: selected.state.material.binding,
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const planned = await first.action('confirm_plan', { binding: prepared.state.plan.binding });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const oldPlanId = (await first.getState()).plan.planId;
  await first.close();

  const restarted = await createHud05InteractiveSession({ sandboxPath: sandbox, reportPath: null });
  t.after(() => restarted.close());
  const recoveredInitial = await restarted.getState();
  assert.equal(recoveredInitial.core.recoveryPending, true);
  assert.equal(recoveredInitial.stage, 'recovery_required');
  assert.equal(recoveredInitial.plan, null);
  assert.equal(restarted.env.workflow.getPlan(oldPlanId), null);
  const blockedRun = await restarted.action('run_fill');
  assert.equal(blockedRun.ok, false);
  assert.equal(blockedRun.error.code, 'RECOVERY_OBSERVATION_REQUIRED');
  const recovery = await restarted.action('recover');
  assert.equal(recovery.ok, true, JSON.stringify(recovery));
  assert.equal(recovery.state.core.recoveryPending, false);
  assert.equal(recovery.state.plan, null);
  assert.equal(restarted.env.driver().page.stats.writes, 0);
});
