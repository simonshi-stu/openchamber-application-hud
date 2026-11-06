import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PRIVATE_ROOT } from '../../../core/store.js';
import {
  APPLICATION_LEDGER_STATUS,
  createApplicationLedger,
} from '../../../core/application-ledger.js';
import { createHud06LocalLedgerServer } from './hud-06-local-ledger.js';

const NOW = '2026-11-03T00:00:00.000Z';

function materialBinding(suffix = 'A') {
  return {
    schemaVersion: 'application-copilot.hud-05.material-binding.v1',
    candidateId: `fixture-candidate-${suffix}`,
    companyId: `company-${suffix}`,
    positionId: `position-${suffix}`,
    profileRevision: 3,
    coreRevision: 8,
    sourceName: 'fixture-resume-hud06.txt',
    sourceParagraphIds: [`fixture-paragraph-${suffix}`],
    facts: [{
      id: `fact-${suffix}`,
      section: 'project_content',
      value: `虚构材料 ${suffix} 不写入台账正文`,
      version: 2,
      confirmed: true,
      confirmedVersion: 2,
    }],
  };
}

function planBinding(suffix = 'A') {
  return {
    schemaVersion: 'application-copilot.hud-05.plan-binding.v1',
    planId: `plan-${suffix}`,
    companyId: `company-${suffix}`,
    positionId: `position-${suffix}`,
    pageUrl: 'https://example.invalid/jobs/fixture',
    snapshotId: `snapshot-${suffix}`,
    targetId: `target-${suffix}`,
    profileVersion: 3,
    coreRevision: 8,
    companyPositionRevision: NOW,
    items: [{
      controlRef: `control-${suffix}`,
      factId: `fact-${suffix}`,
      fieldKey: 'project.content',
      label: '项目内容',
      regionType: 'project',
      regionEntityId: `project-${suffix}`,
      factVersion: 2,
      confirmedVersion: 2,
      originalText: `虚构正文 ${suffix} 不写入台账正文`,
    }],
  };
}

function preparedInput({ suffix = 'A', companyName = '虚构公司A', batch = '批次A', officialId = 'JOB-A' } = {}) {
  return {
    companyName,
    batch,
    companyId: `company-${suffix}`,
    positionId: `position-${suffix}`,
    officialId,
    materialBinding: materialBinding(suffix),
    planBinding: planBinding(suffix),
    preparedAt: NOW,
    reviewPassed: true,
    readbackFields: 1,
    writeCount: 1,
    diffCount: 0,
  };
}

async function makeLedger(t, name = 'ledger') {
  const directory = await fs.mkdtemp(path.join(PRIVATE_ROOT, `hud06-${name}-${randomUUID()}-`));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return createApplicationLedger({ directory, privateRoot: PRIVATE_ROOT, now: () => NOW });
}

async function responseJson(response) {
  return { status: response.status, body: await response.json() };
}

function cookiesOf(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  return values.map((value) => value.split(';', 1)[0]).filter(Boolean).join('; ');
}

async function startHttp(t) {
  const app = await createHud06LocalLedgerServer({ reportPath: null, now: () => NOW });
  t.after(() => app.stop());
  const page = await fetch(app.url);
  const html = await page.text();
  const csrf = /<meta name="hud06-csrf" content="([^"]+)"/.exec(html)?.[1];
  assert.ok(csrf);
  return { app, cookies: cookiesOf(page), csrf, html };
}

async function getState(client) {
  return responseJson(await fetch(`${client.app.origin}/api/state`, {
    headers: { Cookie: client.cookies },
  }));
}

async function action(client, name, payload = {}) {
  return responseJson(await fetch(`${client.app.origin}/api/action`, {
    method: 'POST',
    headers: {
      Cookie: client.cookies,
      Origin: client.app.origin,
      'X-HUD06-CSRF': client.csrf,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: name, payload }),
  }));
}

async function complete(client) {
  let state = (await getState(client)).body.state;
  const confirmed = await action(client, 'confirm_material', {
    binding: state.material.binding,
    values: {
      content: state.material.candidate.content,
      responsibilities: state.material.candidate.responsibilities,
    },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  state = confirmed.body.state;
  const selected = await action(client, 'select_position', { binding: state.position.binding });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  state = selected.body.state;
  const prepared = await action(client, 'prepare_plan', {
    positionBinding: state.position.binding,
    materialBinding: state.material.binding,
  });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  state = prepared.body.state;
  const planned = await action(client, 'confirm_plan', { binding: state.plan.binding });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  state = planned.body.state;
  const filled = await action(client, 'run_fill', { binding: state.plan.binding });
  assert.equal(filled.status, 200, JSON.stringify(filled.body));
  assert.equal(filled.body.state.stage, 'prepared');
  return filled.body.state;
}

test('application ledger is stable, atomic, idempotent, scoped, and evidence-gated', async (t) => {
  const ledger = await makeLedger(t, 'core');
  const first = await ledger.ensurePrepared(preparedInput());
  assert.equal(first.application.status, APPLICATION_LEDGER_STATUS.PREPARED_WAITING_HUMAN_SUBMIT);
  const before = await ledger.snapshot();
  const binding = before.application.currentBinding;
  const report = await ledger.recordUserSubmission({
    applicationId: before.application.applicationId,
    binding,
    expectedRevision: before.revision,
    eventId: 'report-1',
    reportedAt: NOW,
    reference: 'SYNTHETIC-REPORT',
    sourceVersion: binding.sourceVersion,
    now: NOW,
  });
  assert.equal(report.application.status, APPLICATION_LEDGER_STATUS.SUBMITTED_REPORTED);
  const afterReport = await ledger.snapshot();
  const duplicate = await ledger.recordUserSubmission({
    applicationId: afterReport.application.applicationId,
    binding: afterReport.application.currentBinding,
    expectedRevision: before.revision,
    eventId: 'report-1',
    reportedAt: NOW,
    reference: 'SYNTHETIC-REPORT',
    sourceVersion: binding.sourceVersion,
    now: NOW,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.revision, afterReport.revision, 'duplicate report must not create a new ledger revision');

  const rejectedUntrusted = await assert.rejects(
    ledger.recordOfficialVerification({
      applicationId: afterReport.application.applicationId,
      binding: afterReport.application.currentBinding,
      expectedRevision: afterReport.revision,
      eventId: 'verify-untrusted',
      evidence: {
        kind: 'official_receipt',
        trustedOfficialObservation: false,
        acknowledged: false,
        sourceUrl: 'https://example.invalid/receipt',
        ackId: '',
        evidenceText: '无 ack 的虚构文本',
        sourceVersion: binding.sourceVersion,
      },
      now: NOW,
    }),
    (error) => error.code === 'UNTRUSTED_OFFICIAL_EVIDENCE',
  );
  assert.equal(rejectedUntrusted, undefined);

  const verified = await ledger.recordOfficialVerification({
    applicationId: afterReport.application.applicationId,
    binding: afterReport.application.currentBinding,
    expectedRevision: afterReport.revision,
    eventId: 'verify-1',
    evidence: {
      kind: 'official_receipt',
      trustedOfficialObservation: true,
      acknowledged: true,
      sourceUrl: 'https://example.invalid/receipt/fixture-1',
      ackId: 'SYNTHETIC-ACK-1',
      evidenceText: 'SYNTHETIC-ONLY official acknowledgement',
      sourceVersion: binding.sourceVersion,
      verifiedAt: NOW,
      synthetic: true,
    },
    now: NOW,
  });
  assert.equal(verified.application.status, APPLICATION_LEDGER_STATUS.OFFICIAL_VERIFIED);
  assert.equal(verified.application.verification.synthetic, true);
  assert.equal(verified.application.lastEvidence.acknowledged, true);

  const second = await ledger.ensurePrepared(preparedInput({
    suffix: 'B',
    companyName: '虚构公司B',
    batch: '批次B',
    officialId: 'JOB-B',
  }));
  assert.notEqual(second.application.applicationId, verified.application.applicationId);
  const scoped = await ledger.snapshot();
  assert.equal(scoped.applications.length, 2);
  assert.notEqual(scoped.applications[0].applicationKey, scoped.applications[1].applicationKey);
  const unknown = await ledger.recordUnknown({
    applicationId: second.application.applicationId,
    binding: second.application.currentBinding,
    expectedRevision: scoped.revision,
    eventId: 'unknown-1',
    observedAt: NOW,
    blockReason: '无 ack；结果未知。',
    sourceVersion: second.application.currentBinding.sourceVersion,
    now: NOW,
  });
  assert.equal(unknown.application.status, APPLICATION_LEDGER_STATUS.UNKNOWN);
  await assert.rejects(
    ledger.recordOfficialVerification({
      applicationId: second.application.applicationId,
      binding: unknown.application.currentBinding,
      expectedRevision: unknown.revision,
      eventId: 'verify-unknown',
      evidence: {
        kind: 'official_receipt',
        trustedOfficialObservation: true,
        acknowledged: true,
        sourceUrl: 'https://example.invalid/receipt/fixture-unknown',
        ackId: 'SYNTHETIC-ACK-UNKNOWN',
        evidenceText: 'synthetic',
        sourceVersion: second.application.currentBinding.sourceVersion,
        verifiedAt: NOW,
        synthetic: true,
      },
      now: NOW,
    }),
    (error) => error.code === 'NOT_SUBMITTED',
  );
});

test('ledger rejects stale writers and corrupt files without overwriting them', async (t) => {
  const directory = await fs.mkdtemp(path.join(PRIVATE_ROOT, `hud06-conflict-${randomUUID()}-`));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = createApplicationLedger({ directory, privateRoot: PRIVATE_ROOT, now: () => NOW });
  const second = createApplicationLedger({ directory, privateRoot: PRIVATE_ROOT, now: () => NOW });
  await first.ensurePrepared(preparedInput());
  const secondBefore = await second.snapshot();
  const firstBefore = await first.snapshot();
  await first.recordUserSubmission({
    applicationId: firstBefore.application.applicationId,
    binding: firstBefore.application.currentBinding,
    expectedRevision: firstBefore.revision,
    eventId: 'conflict-report',
    reportedAt: NOW,
    reference: 'synthetic',
    sourceVersion: firstBefore.application.currentBinding.sourceVersion,
    now: NOW,
  });
  await assert.rejects(
    second.recordUnknown({
      applicationId: secondBefore.application.applicationId,
      binding: secondBefore.application.currentBinding,
      expectedRevision: secondBefore.revision,
      eventId: 'stale-unknown',
      observedAt: NOW,
      blockReason: 'stale writer',
      sourceVersion: secondBefore.application.currentBinding.sourceVersion,
      now: NOW,
    }),
    (error) => error.code === 'VERSION_CONFLICT',
  );

  const corruptDir = await fs.mkdtemp(path.join(PRIVATE_ROOT, `hud06-corrupt-${randomUUID()}-`));
  t.after(() => fs.rm(corruptDir, { recursive: true, force: true }));
  const corruptPath = path.join(corruptDir, 'application-ledger.json');
  const corruptText = '{not-json';
  await fs.writeFile(corruptPath, corruptText, 'utf8');
  const corrupt = createApplicationLedger({ directory: corruptDir, privateRoot: PRIVATE_ROOT, now: () => NOW });
  const corruptState = await corrupt.snapshot();
  assert.equal(corruptState.storage, 'corrupt');
  await assert.rejects(corrupt.ensurePrepared(preparedInput()), (error) => error.code === 'LEDGER_CORRUPT');
  assert.equal(await fs.readFile(corruptPath, 'utf8'), corruptText);
});

test('HUD-06 HTTP/page integration exposes the ledger and separates local report from verification', async (t) => {
  const client = await startHttp(t);
  assert.match(client.html, /id="ledger-section"/);
  assert.match(client.html, /src="\.\/ledger\.js"/);
  const staticBase = await fetch(`${client.app.origin}/base.js`);
  assert.equal(staticBase.status, 200);
  const initial = await getState(client);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.state.ledger.storage, 'missing');

  const prepared = await complete(client);
  assert.equal(prepared.ledger.application.status, APPLICATION_LEDGER_STATUS.PREPARED_WAITING_HUMAN_SUBMIT);
  assert.equal(prepared.ledger.application.preparation.writeCount, 2);
  assert.equal(prepared.ledger.application.preparation.diffCount, 0);
  assert.equal(prepared.ledger.application.lastEvidence.acknowledged, false);

  const reportPayload = {
    binding: prepared.application.currentBinding,
    expectedLedgerRevision: prepared.ledger.revision,
    eventId: 'http-report-1',
    reportedAt: NOW,
    reference: 'HTTP-SYNTHETIC-LOCAL-REPORT',
    blockReason: '只有本人本地报告；没有官网 ack。',
    confirmedByUser: true,
  };
  const reported = await action(client, 'record_submission_report', reportPayload);
  assert.equal(reported.status, 200, JSON.stringify(reported.body));
  assert.equal(reported.body.state.application.status, APPLICATION_LEDGER_STATUS.SUBMITTED_REPORTED);
  assert.equal(reported.body.state.application.verification, null);
  assert.match(reported.body.state.report.content, /- ledgerRevision: 2/);
  assert.match(reported.body.state.report.content, /- status: 本人报告已提交（本地记录）/);
  assert.doesNotMatch(reported.body.state.report.content, /\u0000/);
  const repeated = await action(client, 'record_submission_report', reportPayload);
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.equal(repeated.body.result.duplicate, true);

  const stale = await action(client, 'record_submission_report', {
    ...reportPayload,
    eventId: 'http-report-different',
    expectedLedgerRevision: reported.body.state.ledger.revision,
    reference: 'different',
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'ALREADY_REPORTED');
  const replay = await action(client, 'run_fill', {});
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error.code, 'APPLICATION_RESULT_LOCKED');

  const unknownClient = await startHttp(t);
  const unknownPrepared = await complete(unknownClient);
  const unknown = await action(unknownClient, 'record_unknown_result', {
    binding: unknownPrepared.application.currentBinding,
    expectedLedgerRevision: unknownPrepared.ledger.revision,
    eventId: 'http-unknown-1',
    observedAt: NOW,
    blockReason: '无 ack；结果未知，不能标为官网核验。',
    confirmedByUser: true,
  });
  assert.equal(unknown.status, 200, JSON.stringify(unknown.body));
  assert.equal(unknown.body.state.application.status, APPLICATION_LEDGER_STATUS.UNKNOWN);
  const unknownReplay = await action(unknownClient, 'run_fill', {});
  assert.equal(unknownReplay.status, 409);
  assert.equal(unknownReplay.body.error.code, 'APPLICATION_RESULT_LOCKED');
});
