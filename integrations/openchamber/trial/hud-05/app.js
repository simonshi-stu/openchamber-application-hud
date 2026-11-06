const csrf = document.querySelector('meta[name="hud05-csrf"]')?.content || '';
const state = {
  current: null,
  loading: false,
  timer: null,
  appliedRevision: -1,
  materialDraft: null,
};

const el = {
  banner: document.querySelector('#banner'),
  stageBadge: document.querySelector('#stage-badge'),
  steps: document.querySelector('#steps'),
  setupNote: document.querySelector('#setup-note'),
  refresh: document.querySelector('#refresh-button'),
  recover: document.querySelector('#recover-button'),
  materialBadge: document.querySelector('#material-badge'),
  materialSource: document.querySelector('#material-source'),
  candidateCard: document.querySelector('#candidate-card'),
  confirmMaterial: document.querySelector('#confirm-material-button'),
  saveEdit: document.querySelector('#save-edit-button'),
  materialActionNote: document.querySelector('#material-action-note'),
  positionSection: document.querySelector('#position-section'),
  positionBadge: document.querySelector('#position-badge'),
  positionCard: document.querySelector('#position-card'),
  selectPosition: document.querySelector('#select-position-button'),
  planSection: document.querySelector('#plan-section'),
  planBadge: document.querySelector('#plan-badge'),
  planEmpty: document.querySelector('#plan-empty'),
  planContent: document.querySelector('#plan-content'),
  planTable: document.querySelector('#plan-table'),
  preparePlan: document.querySelector('#prepare-plan-button'),
  confirmPlan: document.querySelector('#confirm-plan-button'),
  runFill: document.querySelector('#run-fill-button'),
  planActionNote: document.querySelector('#plan-action-note'),
  resultSection: document.querySelector('#result-section'),
  resultBadge: document.querySelector('#result-badge'),
  pageFields: document.querySelector('#page-fields'),
  pageWrites: document.querySelector('#page-writes'),
  diffs: document.querySelector('#diff-list'),
  issues: document.querySelector('#issue-list'),
  reportPath: document.querySelector('#report-path'),
  report: document.querySelector('#report-content'),
  events: document.querySelector('#event-list'),
};

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const badge = (text, tone = 'neutral') => `<span class="badge badge-${tone}">${escapeHtml(text)}</span>`;

function stageLabel(stage) {
  return {
    confirm_material: '待确认材料',
    select_position: '待选岗位',
    prepare_plan: '待生成计划',
    confirm_plan: '待确认计划',
    run_fill: '待执行填写',
    running: '执行中',
    prepared: '准备完成',
    blocked: '已阻断',
    recovery_required: '待恢复观察',
  }[stage] || '读取中';
}

function stageTone(stage) {
  if (stage === 'prepared') return 'success';
  if (stage === 'blocked' || stage === 'recovery_required') return 'danger';
  if (stage === 'running') return 'info';
  return 'warning';
}

function setBanner(text, tone = 'warning') {
  el.banner.textContent = text;
  el.banner.className = `banner banner-${tone}`;
}

function actionButton(button, enabled) {
  button.disabled = !enabled || state.loading;
}

function bindingKey(binding) {
  return JSON.stringify(binding || null);
}

function materialBindingIdentity(binding) {
  if (!binding || typeof binding !== 'object') return null;
  return {
    candidateId: binding.candidateId ?? null,
    companyId: binding.companyId ?? null,
    positionId: binding.positionId ?? null,
    sourceName: binding.sourceName ?? null,
    sourceParagraphIds: Array.isArray(binding.sourceParagraphIds) ? [...binding.sourceParagraphIds] : [],
    facts: Array.isArray(binding.facts)
      ? binding.facts.map((fact) => ({
        id: fact?.id ?? null,
        section: fact?.section ?? null,
        source: fact?.source ?? null,
        scope: fact?.scope ?? null,
      }))
      : [],
  };
}

function sameMaterialBindingIdentity(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function materialValues(material) {
  return {
    content: material?.candidate?.content ?? '',
    responsibilities: material?.candidate?.responsibilities ?? '',
  };
}

function sameMaterialValues(left, right) {
  return left?.content === right?.content && left?.responsibilities === right?.responsibilities;
}

function materialConfirmationState(current) {
  const material = current?.material;
  const draft = state.materialDraft;
  const dirty = Boolean(draft && !sameMaterialValues(draft.values, materialValues(material)));
  const conflict = draft?.conflict || null;
  return {
    dirty,
    conflict,
    confirmed: Boolean(material?.candidate?.confirmed && !dirty && !conflict),
  };
}

function captureMaterialGuard(action = null) {
  const material = state.current?.material;
  const draft = state.materialDraft;
  const serverValues = materialValues(material);
  return {
    action,
    binding: material?.binding || null,
    revision: draft?.revision ?? 0,
    values: draft ? { ...draft.values } : { ...serverValues },
    dirty: Boolean(draft && !sameMaterialValues(draft.values, serverValues)),
  };
}

function preserveMaterialDraft(current, guard, { force = false } = {}) {
  if (!guard || !state.materialDraft || !current?.material) return;
  const draft = state.materialDraft;
  const editedAfterRequest = draft.revision > guard.revision;
  const preserveExistingDraft = (force || guard.action === 'refresh') && guard.dirty;
  if (!editedAfterRequest && !preserveExistingDraft) return;

  const nextBinding = current.material.binding || null;
  const nextIdentity = materialBindingIdentity(nextBinding);
  const draftIdentity = draft.bindingScope || materialBindingIdentity(guard.binding);
  if (sameMaterialBindingIdentity(draftIdentity, nextIdentity)) {
    // A response from the same candidate/scope may advance the fact version,
    // but it must not turn newer local text into an acknowledged value.
    state.materialDraft = {
      ...draft,
      bindingKey: bindingKey(nextBinding),
      bindingScope: nextIdentity,
      conflict: null,
    };
    return;
  }

  // Candidate, position, source, or fact identity changed while local text
  // was in flight. Keep the text anchored to its original binding and make
  // the conflict visible instead of silently rebinding or confirming it.
  state.materialDraft = {
    ...draft,
    conflict: {
      serverBindingKey: bindingKey(nextBinding),
      message: '材料候选、岗位或事实来源已变化；草稿未自动重绑或确认。',
    },
  };
}

function applyState(current, { materialGuard = null, forceMaterialDraft = false } = {}) {
  if (!current) return false;
  const revision = Number.isInteger(current.interactionRevision)
    ? current.interactionRevision
    : Number.isInteger(current.core?.interactionRevision) ? current.core.interactionRevision : 0;
  if (revision < state.appliedRevision) return false;
  preserveMaterialDraft(current, materialGuard, { force: forceMaterialDraft });
  state.appliedRevision = revision;
  render(current);
  return true;
}

function renderSteps(current) {
  const stages = [
    ['confirm_material', '确认材料'],
    ['select_position', '选择岗位'],
    ['prepare_plan', '生成计划'],
    ['confirm_plan', '确认计划'],
    ['run_fill', '写入读回'],
  ];
  const order = stages.map(([id]) => id);
  const currentIndex = order.indexOf(current.stage);
  const doneUntil = current.stage === 'prepared' || current.stage === 'blocked'
    ? 5
    : Math.max(0, currentIndex);
  el.steps.innerHTML = stages.map(([id, label], index) => {
    const done = current.stage === 'prepared' ? true : index < doneUntil;
    const active = id === current.stage || (current.stage === 'running' && id === 'run_fill');
    const blocked = current.stage === 'blocked' && index === 4;
    return `<li class="step${done ? ' done' : ''}${active ? ' active' : ''}${blocked ? ' blocked' : ''}">${escapeHtml(label)}</li>`;
  }).join('');
  el.stageBadge.textContent = stageLabel(current.stage);
  el.stageBadge.className = `badge badge-${stageTone(current.stage)}`;
  el.setupNote.textContent = `${current.preflight.note} 外部网络调用：${current.capabilities.networkCalls}。`;
  el.recover.hidden = !current.actions.recover;
  actionButton(el.recover, current.actions.recover);
  el.recover.onclick = () => void runAction('recover');
}

function renderMaterial(current) {
  const material = current.material;
  const currentBindingKey = bindingKey(material.binding);
  if (!state.materialDraft || (!state.materialDraft.conflict && state.materialDraft.bindingKey !== currentBindingKey)) {
    state.materialDraft = {
      bindingKey: currentBindingKey,
      bindingScope: materialBindingIdentity(material.binding),
      revision: 0,
      values: {
        content: material.candidate.content,
        responsibilities: material.candidate.responsibilities,
      },
    };
  }
  const draft = state.materialDraft.values;
  const { dirty, conflict, confirmed } = materialConfirmationState(current);
  el.materialBadge.textContent = confirmed ? '已确认 · 当前版本' : '未确认 · 不可复用';
  el.materialBadge.className = `badge badge-${confirmed ? 'success' : 'warning'}`;
  el.materialSource.innerHTML = `
    <div class="source-block"><strong>来源文件</strong><span class="muted">${escapeHtml(material.source.name)}</span></div>
    <div class="source-block"><strong>来源段落</strong><div class="source-paragraphs">${material.source.paragraphs.map((item) => `<div class="source-paragraph"><b>${escapeHtml(item.id)}</b> · ${escapeHtml(item.text)}</div>`).join('')}</div></div>`;
  const content = material.candidate.content;
  const responsibilities = material.candidate.responsibilities;
  el.candidateCard.innerHTML = `
    <div class="field-block"><label for="candidate-content">项目内容 · 来源原文/当前草稿</label><textarea id="candidate-content">${escapeHtml(draft.content)}</textarea></div>
    <div class="field-block"><label for="candidate-responsibilities">本人职责 · 来源原文/当前草稿</label><textarea id="candidate-responsibilities">${escapeHtml(draft.responsibilities)}</textarea></div>`;
  el.confirmMaterial.hidden = confirmed;
  el.saveEdit.hidden = !current.actions.editMaterial;
  el.saveEdit.textContent = confirmed ? '保存全部修改并撤销确认' : '保存全部草稿（仍未确认）';
  const contentInput = document.querySelector('#candidate-content');
  const responsibilityInput = document.querySelector('#candidate-responsibilities');
  contentInput.readOnly = false;
  responsibilityInput.readOnly = false;
  const draftIsDirty = () => state.materialDraft.values.content !== content
    || state.materialDraft.values.responsibilities !== responsibilities;
  const rememberDraft = () => {
    state.materialDraft.values = {
      content: contentInput.value,
      responsibilities: responsibilityInput.value,
    };
    state.materialDraft.revision += 1;
    const draftDirty = draftIsDirty();
    actionButton(el.saveEdit, current.actions.editMaterial && draftDirty && !state.materialDraft.conflict);
    el.confirmMaterial.disabled = draftDirty || Boolean(state.materialDraft.conflict)
      || !current.actions.confirmMaterial || state.loading;
  };
  contentInput.addEventListener('input', rememberDraft);
  responsibilityInput.addEventListener('input', rememberDraft);
  el.confirmMaterial.disabled = dirty || Boolean(conflict) || !current.actions.confirmMaterial || state.loading;
  el.confirmMaterial.onclick = () => void runAction('confirm_material', {
    binding: material.binding,
    values: { ...state.materialDraft.values },
  });
  actionButton(el.saveEdit, current.actions.editMaterial && dirty && !conflict);
  el.saveEdit.onclick = () => {
    if (!state.materialDraft || state.materialDraft.conflict || !draftIsDirty()) {
      setBanner('没有检测到可保存的修改。', 'warning');
      return;
    }
    void runAction('edit_material', {
      binding: material.binding,
      values: { ...state.materialDraft.values },
    });
  };
  el.materialActionNote.textContent = conflict
    ? `${conflict.message} 请重新加载页面后由本人重新处理。`
    : dirty
      ? '存在未保存草稿；请一次保存全部修改，保存失败不会清除草稿。'
      : confirmed
        ? '可编辑候选；保存任一字段会撤销确认并使旧计划失效。'
        : '未确认候选也可以先编辑；保存后仍需单独确认。';
}

function renderPosition(current) {
  const position = current.position;
  const visible = materialConfirmationState(current).confirmed && position;
  el.positionSection.hidden = !visible;
  if (!visible) return;
  const selected = position.selected;
  el.positionBadge.textContent = selected ? '已选择 · 当前岗位' : '候选岗位';
  el.positionBadge.className = `badge badge-${selected ? 'success' : 'info'}`;
  el.positionCard.innerHTML = `
    <div class="position-title"><strong>${escapeHtml(position.title)}</strong>${badge(position.status, selected ? 'success' : 'info')}</div>
    <div class="meta-list"><span class="meta-chip">officialId: ${escapeHtml(position.officialId)}</span><span class="meta-chip">城市：${escapeHtml(position.city || '未提供')}</span><span class="meta-chip">来源：${escapeHtml(position.source?.url)}</span></div>
    <p class="muted small">匹配证据：${escapeHtml(position.source?.evidence)}</p>`;
  actionButton(el.selectPosition, current.actions.selectPosition);
  el.selectPosition.textContent = selected ? '已选择此岗位' : '选择此岗位';
  el.selectPosition.onclick = () => void runAction('select_position', { binding: position.binding });
}

function renderPlan(current) {
  const visible = materialConfirmationState(current).confirmed
    && Boolean(current.position?.selected || current.plan || current.review);
  el.planSection.hidden = !visible;
  if (!visible) return;
  const plan = current.plan;
  el.planEmpty.hidden = Boolean(plan);
  el.planContent.hidden = !plan;
  el.planBadge.textContent = plan ? (plan.confirmed ? '已确认' : '待本人确认') : '尚未生成';
  el.planBadge.className = `badge badge-${plan?.confirmed ? 'success' : plan ? 'warning' : 'neutral'}`;
  if (!plan) {
    el.preparePlan.hidden = false;
    el.confirmPlan.hidden = true;
    el.runFill.hidden = true;
    el.preparePlan.onclick = () => void runAction('prepare_plan', {
      positionBinding: current.position?.binding,
      materialBinding: current.material.binding,
    });
    actionButton(el.preparePlan, current.actions.preparePlan);
    return;
  }
  el.planTable.innerHTML = `<table><thead><tr><th>控件</th><th>字段</th><th>确认原文</th><th>版本/作用域</th></tr></thead><tbody>${plan.items.map((item) => `
    <tr><td><code>${escapeHtml(item.controlRef)}</code><br>${escapeHtml(item.label)}</td><td>${escapeHtml(item.fieldKey)}</td><td class="cell-text">${escapeHtml(item.text)}</td><td>${escapeHtml(String(item.factVersion))} / ${escapeHtml(item.regionEntityId || '无')}</td></tr>`).join('')}</tbody></table>`;
  el.preparePlan.hidden = true;
  el.confirmPlan.hidden = plan.confirmed;
  el.runFill.hidden = !plan.confirmed;
  el.confirmPlan.onclick = () => void runAction('confirm_plan', { binding: plan.binding });
  el.runFill.onclick = () => void runAction('run_fill', { binding: plan.binding });
  actionButton(el.confirmPlan, current.actions.confirmPlan);
  actionButton(el.runFill, current.actions.runFill);
  el.planActionNote.textContent = plan.confirmed
    ? '下一步仍需单独点击；fake page 会实际写入后读回。'
    : '计划只展示当前确认版本；确认前不会写入 fake page。';
}

function renderResult(current) {
  const visible = Boolean(current.actualPage || current.review || current.issues.length || current.stage === 'prepared' || current.stage === 'blocked');
  el.resultSection.hidden = !visible;
  if (!visible) return;
  const review = current.review;
  el.resultBadge.textContent = review?.passed === true ? '复核通过 · 准备完成' : review ? '有差异/问题 · 已阻断' : '等待执行';
  el.resultBadge.className = `badge badge-${review?.passed === true ? 'success' : review ? 'danger' : 'neutral'}`;
  const fields = current.actualPage?.fields || [];
  el.pageFields.innerHTML = fields.length ? fields.map((field) => `<div class="field-row ${field.value ? 'row-success' : ''}"><div class="row-head"><span class="row-title">${escapeHtml(field.label)}</span><span class="row-code">${escapeHtml(field.ref)}</span></div><div class="row-detail">${escapeHtml(field.value || '（空）')}</div></div>`).join('') : '<div class="empty-state">尚无 fake page 实际读回。</div>';
  const writes = current.actualPage?.writes || [];
  el.pageWrites.innerHTML = writes.length ? writes.map((write) => `<div class="write-row"><div class="row-head"><span class="row-title">${escapeHtml(write.ref)}</span><span class="row-code">实际 page.write</span></div><div class="row-detail">${escapeHtml(write.text || write.option?.label || '')}</div></div>`).join('') : '<div class="empty-state">尚无写入记录。</div>';
  const diffs = review?.programDiffs || [];
  el.diffs.innerHTML = diffs.length ? diffs.map((diff) => `<div class="diff-row row-danger"><div class="row-head"><span class="row-title">${escapeHtml(diff.fieldId)}</span>${badge('阻断', 'danger')}</div><div class="row-detail">expected: ${escapeHtml(diff.expected)}\nactual: ${escapeHtml(diff.actual ?? '（缺失）')}\nreason: ${escapeHtml(diff.reason)}</div></div>`).join('') : '<div class="empty-state">程序 diff：0</div>';
  el.issues.innerHTML = current.issues.length ? current.issues.map((issue) => `<div class="issue-row ${issue.blocking ? 'row-danger' : ''}"><div class="row-head"><span class="row-title">${escapeHtml(issue.fieldKey)}</span>${badge(issue.blocking ? 'blocking' : issue.status, issue.blocking ? 'danger' : 'warning')}</div><div class="row-detail">${escapeHtml(issue.message)}</div></div>`).join('') : '<div class="empty-state">当前没有持久化问题。</div>';
}

function renderReport(current) {
  el.reportPath.textContent = current.report.path ? `报告产物：${current.report.path}` : '本次 API 回归不写报告文件。';
  el.report.textContent = current.report.content;
}

function renderEvents(current) {
  const setup = current.preflight.events.map((event) => ({ ...event, kind: 'setup' }));
  const user = current.interactiveEvents.map((event) => ({ ...event, kind: 'interactive user' }));
  const all = [...setup, ...user];
  el.events.innerHTML = all.length ? all.map((event) => `<div class="event-row"><span class="event-type">${escapeHtml(event.type)}</span><span class="event-actor">${escapeHtml(event.actor)} · ${escapeHtml(event.eventId)}</span><span>${badge(event.kind, event.kind === 'setup' ? 'neutral' : 'info')}</span></div>`).join('') : '<div class="empty-state">尚无事件。</div>';
}

function render(current) {
  state.current = current;
  renderSteps(current);
  renderMaterial(current);
  renderPosition(current);
  renderPlan(current);
  renderResult(current);
  renderReport(current);
  renderEvents(current);
  if (current.lastError) {
    setBanner(`${current.lastError.code}：${current.lastError.message}`, 'danger');
  } else if (current.stage === 'prepared') {
    setBanner('合成填写、实际读回与复核已完成；页面停在准备状态，没有提交入口。', 'success');
  } else if (current.stage === 'blocked') {
    setBanner('本次合成操作被阻断；实际读回和问题已保留，未用预期值掩盖失败。', 'danger');
  } else if (current.stage === 'recovery_required') {
    setBanner('检测到恢复阻断。当前页面没有自动重放旧计划；请重新观察后再继续。', 'danger');
  } else {
    setBanner('本页只运行虚构 fixture。不会打开招聘站、读取真实简历、调用模型、发送 OpenChamber 消息或提供提交按钮。', 'warning');
  }
  actionButton(el.refresh, true);
}

async function loadState() {
  const materialGuard = captureMaterialGuard('refresh');
  const response = await fetch('/api/state', { credentials: 'same-origin' });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error?.message || '读取 HUD-05 状态失败。');
  if (applyState(body.state, { materialGuard }) && body.state.stage === 'running') schedulePoll();
}

function schedulePoll() {
  window.clearTimeout(state.timer);
  state.timer = window.setTimeout(() => void loadState().catch(showError), 500);
}

async function runAction(action, payload = {}) {
  if (state.loading) return;
  const materialGuard = captureMaterialGuard(action);
  state.loading = true;
  render(state.current);
  try {
    const response = await fetch('/api/action', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-HUD05-CSRF': csrf },
      body: JSON.stringify({ action, payload }),
    });
    const body = await response.json();
    if (body.state) {
      applyState(body.state, { materialGuard, forceMaterialDraft: !body.ok });
    }
    if (!response.ok || !body.ok) {
      throw new Error(body.error?.message || 'HUD-05 动作被阻断。');
    }
    if (body.state?.stage === 'running') schedulePoll();
  } catch (error) {
    showError(error);
  } finally {
    state.loading = false;
    if (state.current) render(state.current);
  }
}

function showError(error) {
  setBanner(error?.message || 'HUD-05 本地请求失败。', 'danger');
}

el.refresh.addEventListener('click', () => void loadState().catch(showError));
window.addEventListener('beforeunload', () => window.clearTimeout(state.timer));
void loadState().catch(showError);
