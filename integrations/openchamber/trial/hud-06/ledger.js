(() => {
const csrf = document.querySelector('meta[name="hud06-csrf"]')?.content || '';
const ledgerState = { current: null, timer: null, loading: false };

const el = {
  storage: document.querySelector('#ledger-storage'),
  status: document.querySelector('#ledger-status'),
  identity: document.querySelector('#ledger-identity'),
  evidence: document.querySelector('#ledger-evidence'),
  history: document.querySelector('#ledger-history'),
  reference: document.querySelector('#submission-reference'),
  unknownReason: document.querySelector('#unknown-reason'),
  recordSubmission: document.querySelector('#record-submission-button'),
  recordUnknown: document.querySelector('#record-unknown-button'),
  reportPath: document.querySelector('#report-path'),
  report: document.querySelector('#report-content'),
};

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const badge = (text, tone = 'neutral') => `<span class="badge badge-${tone}">${escapeHtml(text)}</span>`;

function statusTone(status) {
  if (status === 'official_verified') return 'success';
  if (status === 'submitted_reported') return 'info';
  if (status === 'unknown') return 'danger';
  if (status === 'prepared_waiting_human_submit') return 'warning';
  return 'neutral';
}

function storageLabel(storage) {
  return {
    ready: '可读写（本地原子文件）',
    missing: '尚未写入（准备完成后创建）',
    corrupt: '损坏/未知（拒绝覆盖与升级）',
  }[storage] || '读取中';
}

function setButton(button, enabled) {
  if (button) button.disabled = ledgerState.loading || !enabled;
}

function renderIdentity(application) {
  if (!application) {
    el.identity.innerHTML = '<div class="empty-state">完成实际写入、读回和复核后，申请级台账将在这里创建。</div>';
    return;
  }
  const binding = application.currentBinding || {};
  el.identity.innerHTML = [
    ['申请 ID', application.applicationId],
    ['公司/批次', `${application.companyIdentityKey} / ${application.companyBatch || '未提供批次'}`],
    ['岗位 ID', `${application.positionId} / ${application.officialId}`],
    ['材料版本', `${binding.profileRevision} · ${binding.materialDigest.slice(0, 16)}`],
    ['字段计划', `${binding.planDigest.slice(0, 16)} · ${application.preparation?.plan?.planId || 'unknown'}`],
    ['台账版本', binding.ledgerRevision],
  ].map(([label, value]) => `<div class="ledger-chip"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div>`).join('');
}

function renderEvidence(application) {
  if (!application) {
    el.evidence.innerHTML = '<div class="empty-state">尚无结果证据。</div>';
    return;
  }
  const evidence = application.lastEvidence || {};
  const report = application.submissionReport;
  const verification = application.verification;
  el.evidence.innerHTML = `
    <div class="ledger-chip"><strong>最后证据</strong><span>${escapeHtml(evidence.kind)} · ${escapeHtml(evidence.source)} · ${escapeHtml(evidence.observedAt)}</span></div>
    <div class="ledger-chip"><strong>来源版本</strong><span>${escapeHtml(evidence.sourceVersion)}</span></div>
    <div class="ledger-chip"><strong>ack/可信官网观测</strong><span>${evidence.acknowledged ? '有' : '无'} / ${evidence.trustedOfficialObservation ? '有' : '无'}</span></div>
    <div class="ledger-chip"><strong>阻塞原因</strong><span>${escapeHtml(evidence.blockReason || '无')}</span></div>
    ${report ? `<div class="ledger-chip"><strong>本人报告</strong><span>${escapeHtml(report.reportedAt)} · ${escapeHtml(report.reference || '无备注')} · 不代表网站动作</span></div>` : ''}
    ${verification ? `<div class="ledger-chip"><strong>官网回执</strong><span>${escapeHtml(verification.verifiedAt)} · ack ${escapeHtml(verification.ackId)}${verification.synthetic ? ' · synthetic' : ''}</span></div>` : ''}`;
}

function renderHistory(application) {
  const history = application?.history || [];
  el.history.innerHTML = history.length ? history.map((item) => `
    <div class="event-row">
      <span class="event-type">${escapeHtml(item.type)}</span>
      <span class="event-actor">${escapeHtml(item.at)} · ${escapeHtml(item.eventId)}</span>
      <span>${badge(`${item.from} → ${item.to}`, item.to === 'unknown' ? 'danger' : item.to === 'official_verified' ? 'success' : 'info')}</span>
    </div>`).join('') : '<div class="empty-state">尚无台账状态历史。</div>';
}

function render(state) {
  ledgerState.current = state;
  const ledger = state?.ledger || { storage: 'corrupt', applications: [], application: null, actions: {} };
  const application = ledger.application;
  el.storage.textContent = `台账状态：${storageLabel(ledger.storage)} · revision=${ledger.revision ?? 'unknown'}${ledger.error ? ` · ${ledger.error.message}` : ''}`;
  el.status.textContent = application?.statusLabel || '尚未产生准备结果';
  el.status.className = `badge badge-${statusTone(application?.status)}`;
  renderIdentity(application);
  renderEvidence(application);
  renderHistory(application);
  if (state?.report) {
    el.reportPath.textContent = state.report.path ? `报告产物：${state.report.path}` : '本次 API 回归不写报告文件。';
    el.report.textContent = state.report.content || '';
  }
  setButton(el.recordSubmission, Boolean(ledger.actions?.recordSubmissionReport));
  setButton(el.recordUnknown, Boolean(ledger.actions?.recordUnknownResult));
}

async function loadState() {
  const response = await fetch('/api/state', { credentials: 'same-origin' });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error?.message || '读取 HUD-06 台账失败。');
  render(body.state);
  if (body.state.stage === 'running' || (!body.state.ledger?.application && body.state.stage !== 'prepared')) {
    window.clearTimeout(ledgerState.timer);
    ledgerState.timer = window.setTimeout(() => void loadState().catch(() => {}), 700);
  }
}

async function runLedgerAction(action, payload) {
  if (ledgerState.loading || !ledgerState.current?.application) return;
  ledgerState.loading = true;
  render(ledgerState.current);
  try {
    const response = await fetch('/api/action', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-HUD06-CSRF': csrf },
      body: JSON.stringify({ action, payload }),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error?.message || '台账动作被阻断。');
    render(body.state);
  } catch (error) {
    el.storage.textContent = `台账动作失败：${error?.message || '未知错误'}`;
  } finally {
    ledgerState.loading = false;
    if (ledgerState.current) render(ledgerState.current);
  }
}

el.recordSubmission.addEventListener('click', () => {
  const current = ledgerState.current;
  const application = current?.ledger?.application;
  if (!application) return;
  void runLedgerAction('record_submission_report', {
    binding: application.currentBinding,
    expectedLedgerRevision: current.ledger.revision,
    eventId: `hud06-ui-report-${Date.now()}`,
    reportedAt: new Date().toISOString(),
    reference: el.reference.value,
    confirmedByUser: true,
  });
});

el.recordUnknown.addEventListener('click', () => {
  const current = ledgerState.current;
  const application = current?.ledger?.application;
  if (!application) return;
  void runLedgerAction('record_unknown_result', {
    binding: application.currentBinding,
    expectedLedgerRevision: current.ledger.revision,
    eventId: `hud06-ui-unknown-${Date.now()}`,
    observedAt: new Date().toISOString(),
    blockReason: el.unknownReason.value,
    confirmedByUser: true,
  });
});

void loadState().catch((error) => {
  el.storage.textContent = `台账读取失败：${error?.message || '未知错误'}`;
});
})();
