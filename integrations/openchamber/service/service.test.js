import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWorkbenchService } from '../../../core/index.js';
import { createServiceServer } from './entry.js';

const ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const MAIN_PATH = path.join(ROOT, 'integrations', 'openchamber', 'service', 'entry.js');
const NOW = '2026-10-26T00:00:00.000Z';

async function createEnvironment(t) {
  const base = path.join(ROOT, 'private', `test-openchamber-service-${randomUUID()}`);
  const project = path.join(base, 'project');
  await fs.mkdir(project, { recursive: true });
  const env = {
    base,
    project,
    token: `test-token-${randomUUID()}`,
    apps: [],
  };
  t.after(async () => {
    for (const app of env.apps.splice(0).reverse()) {
      await app.stop().catch(() => {});
    }
    await fs.rm(env.base, { recursive: true, force: true });
  });
  return env;
}

async function startApp(env) {
  const app = createServiceServer({
    token: env.token,
    projectRoots: [env.base],
    now: () => NOW,
    newId: () => randomUUID(),
  });
  const info = await app.start();
  env.apps.push(app);
  return {
    ...env,
    app,
    baseUrl: `http://127.0.0.1:${info.port}`,
  };
}

async function request(client, pathname, { method = 'GET', token = client.token, body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (token !== null) requestHeaders.Authorization = `Bearer ${token}`;
  const init = { method, headers: requestHeaders };
  if (body !== undefined) {
    requestHeaders['Content-Type'] ??= 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return fetch(`${client.baseUrl}${pathname}`, init);
}

async function readResponse(response) {
  const text = await response.text();
  let body = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: response.status, headers: response.headers, text, body };
}

async function command(client, name, input = {}, expectedRevision) {
  const payload = {
    directory: client.project,
    command: name,
    input,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
  const response = await request(client, '/api/command', {
    method: 'POST',
    body: payload,
  });
  return readResponse(response);
}

async function state(client) {
  const response = await request(
    client,
    `/api/state?directory=${encodeURIComponent(client.project)}`,
  );
  return readResponse(response);
}

function assertNoCors(response) {
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
}

test('auth, protocol limits, unknown fields and GET state without writes', async (t) => {
  const env = await createEnvironment(t);
  const client = await startApp(env);

  const healthNoAuth = await readResponse(await request(client, '/health', { token: null }));
  assert.equal(healthNoAuth.status, 401);
  assert.equal(healthNoAuth.body.error.code, 'UNAUTHORIZED');
  assertNoCors(healthNoAuth);
  assert.doesNotMatch(healthNoAuth.text, new RegExp(env.token));

  const healthWrong = await readResponse(await request(client, '/health', { token: 'wrong-token' }));
  assert.equal(healthWrong.status, 401);
  assertNoCors(healthWrong);

  const health = await readResponse(await request(client, '/health'));
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true, status: 'ready' });
  assertNoCors(health);

  const stateNoAuth = await readResponse(await request(
    client,
    `/api/state?directory=${encodeURIComponent(client.project)}`,
    { token: null },
  ));
  assert.equal(stateNoAuth.status, 401);

  const wrongMethod = await readResponse(await request(client, '/health', { method: 'PUT' }));
  assert.equal(wrongMethod.status, 405);
  assertNoCors(wrongMethod);

  const unknownPath = await readResponse(await request(client, '/api/nope'));
  assert.equal(unknownPath.status, 404);
  assert.equal(unknownPath.body.error.code, 'NOT_FOUND');

  const relativeDirectory = await readResponse(await request(
    client,
    '/api/state?directory=relative-project',
  ));
  assert.equal(relativeDirectory.status, 400);
  assert.equal(relativeDirectory.body.error.code, 'INVALID_DIRECTORY');

  const missingDirectory = await readResponse(await request(
    client,
    `/api/state?directory=${encodeURIComponent(path.join(client.base, 'does-not-exist'))}`,
  ));
  assert.equal(missingDirectory.status, 400);
  assert.equal(missingDirectory.body.error.code, 'INVALID_DIRECTORY');

  const emptyState = await state(client);
  assert.equal(emptyState.status, 200);
  assert.equal(emptyState.body.revision, 0);
  assert.equal(emptyState.body.state.companies.length, 0);
  assert.equal(emptyState.body.state.queue.status, 'idle');
  assert.equal(emptyState.body.state.capabilities.autoResearch, true);
  assert.equal(emptyState.body.state.capabilities.autoFill, true);
  await assert.rejects(fs.stat(path.join(client.project, 'private')), { code: 'ENOENT' });

  const unknownTopLevel = await readResponse(await request(client, '/api/command', {
    method: 'POST',
    body: {
      directory: client.project,
      command: 'user.enqueue',
      input: { url: 'https://careers.example.invalid/jobs' },
      actor: 'operator',
    },
  }));
  assert.equal(unknownTopLevel.status, 400);
  assert.equal(unknownTopLevel.body.error.code, 'UNKNOWN_FIELD');
  assert.equal(unknownTopLevel.body.error.details.field, '请求体.actor');

  const unknownCommand = await command(client, 'user.deleteEverything');
  assert.equal(unknownCommand.status, 400);
  assert.equal(unknownCommand.body.error.code, 'UNKNOWN_COMMAND');

  const agentCommand = await command(client, 'agent.proposeJobCandidates', {});
  assert.equal(agentCommand.status, 403);
  assert.equal(agentCommand.body.error.code, 'UI_COMMAND_ONLY');

  const actorInput = await command(client, 'user.enqueue', {
    url: 'https://careers.example.invalid/jobs',
    actor: 'operator',
  });
  assert.equal(actorInput.status, 400);
  assert.equal(actorInput.body.error.code, 'UNKNOWN_FIELD');
  assert.equal(actorInput.body.error.details.field, 'input.actor');

  const noQuery = await readResponse(await request(client, '/api/state'));
  assert.equal(noQuery.status, 400);
  assert.equal(noQuery.body.error.code, 'UNKNOWN_QUERY');

  const capabilities = await readResponse(await request(client, '/api/capabilities'));
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.body.capabilities.apiVersion, 1);
  assert.equal(capabilities.body.capabilities.autoResearch, true);
  assert.equal(capabilities.body.capabilities.autoFill, true);
  assert.equal(capabilities.body.capabilities.secureModelCredentials, true);
  assert.equal(capabilities.body.capabilities.roleExecution, true);
  assert.equal(capabilities.body.capabilities.apiKeyStorage, false);
  assert.ok(capabilities.body.capabilities.commands.includes('user.enqueue'));
  assert.ok(capabilities.body.capabilities.commands.includes('user.mokaRunFill'));
  assert.ok(capabilities.body.capabilities.limitations.some((item) => item.includes('最终提交')));

  const tooLarge = await readResponse(await request(client, '/api/command', {
    method: 'POST',
    body: 'x'.repeat(600 * 1024),
  }));
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.error.code, 'BODY_TOO_LARGE');

  // None of the rejected requests may create the private data directory.
  await assert.rejects(fs.stat(path.join(client.project, 'private')), { code: 'ENOENT' });
});

test('session inbox bridges standalone messages and acknowledges only after delivery', async (t) => {
  const env = await createEnvironment(t);
  const client = await startApp(env);

  const empty = await readResponse(await request(
    client,
    `/api/session-inbox?directory=${encodeURIComponent(client.project)}`,
  ));
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.messages, []);
  await assert.rejects(fs.stat(path.join(client.project, 'private')), { code: 'ENOENT' });

  const appended = await readResponse(await request(client, '/api/session-inbox', {
    method: 'POST',
    body: {
      directory: client.project,
      text: '  独立 HUD 的虚构消息  ',
      targetSessionId: 'ses_virtual_service',
    },
  }));
  assert.equal(appended.status, 200, appended.text);
  assert.equal(appended.body.message.text, '  独立 HUD 的虚构消息  ');
  assert.equal(appended.body.message.targetSessionId, 'ses_virtual_service');

  const pending = await readResponse(await request(
    client,
    `/api/session-inbox?directory=${encodeURIComponent(client.project)}`,
  ));
  assert.deepEqual(pending.body.messages.map(message => message.id), [appended.body.message.id]);
  assert.equal(pending.body.messages[0].text, '  独立 HUD 的虚构消息  ');
  assert.equal(pending.body.messages[0].targetSessionId, 'ses_virtual_service');
  assert.equal(pending.body.messages[0].deliveryState, 'pending');

  const claimed = await readResponse(await request(client, '/api/session-inbox/state', {
    method: 'POST',
    body: {
      directory: client.project,
      messageIds: [appended.body.message.id],
      state: 'needs_review',
    },
  }));
  assert.equal(claimed.status, 200, claimed.text);
  assert.equal(claimed.body.updated, 1);

  const review = await readResponse(await request(
    client,
    `/api/session-inbox?directory=${encodeURIComponent(client.project)}`,
  ));
  assert.equal(review.body.messages[0].deliveryState, 'needs_review');

  const markedSent = await readResponse(await request(client, '/api/session-inbox/state', {
    method: 'POST',
    body: {
      directory: client.project,
      messageIds: [appended.body.message.id],
      state: 'sent',
    },
  }));
  assert.equal(markedSent.status, 200, markedSent.text);
  assert.equal(markedSent.body.updated, 1);

  const acknowledged = await readResponse(await request(client, '/api/session-inbox/ack', {
    method: 'POST',
    body: { directory: client.project, messageIds: [appended.body.message.id] },
  }));
  assert.equal(acknowledged.status, 200, acknowledged.text);
  assert.equal(acknowledged.body.acknowledged, 1);

  const afterAck = await readResponse(await request(
    client,
    `/api/session-inbox?directory=${encodeURIComponent(client.project)}`,
  ));
  assert.deepEqual(afterAck.body.messages, []);
});

test('prioritize command moves a queued company before starting the queue', async (t) => {
  const env = await createEnvironment(t);
  const client = await startApp(env);
  const first = await command(client, 'user.enqueue', {
    url: 'https://first.example.invalid/jobs',
    companyName: '虚构首家公司',
  }, 0);
  const second = await command(client, 'user.enqueue', {
    url: 'https://second.example.invalid/jobs',
    companyName: '虚构第二家公司',
  }, first.body.revision);
  const secondId = second.body.state.companies.find(company => company.name === '虚构第二家公司').id;

  const prioritized = await command(client, 'user.prioritizeCompany', { companyId: secondId }, second.body.revision);
  assert.equal(prioritized.status, 200, prioritized.text);
  assert.equal(prioritized.body.result.idempotent, false);
  const started = await command(client, 'user.start', {}, prioritized.body.revision);
  assert.equal(started.status, 200, started.text);
  assert.equal(started.body.state.currentCompanyId, secondId);
  assert.equal(started.body.state.companies.find(company => company.id === secondId).status, 'awaiting_login');
});

test('queue flow: manual candidates, selection, preparation gate, submission receipt', async (t) => {
  const env = await createEnvironment(t);
  const client = await startApp(env);

  const enqueued = await command(client, 'user.enqueue', {
    url: 'https://careers.example.invalid/jobs?recommendCode=ABC123',
    companyName: '示例甲公司',
    batch: '2027届',
    referralCode: 'CODE-A',
    source: '虚构粘贴',
  }, 0);
  assert.equal(enqueued.status, 200, enqueued.text);
  assert.equal(enqueued.body.result.companyName, '示例甲公司');
  assert.deepEqual(enqueued.body.result.referralCodes, ['CODE-A', 'ABC123']);
  assert.equal(enqueued.body.state.companies.length, 1);
  const company = enqueued.body.state.companies[0];
  assert.equal(company.status, 'queued');
  assert.equal(company.coreStatus, 'queued');
  assert.equal(company.name, '示例甲公司');
  assert.equal(company.batch, '2027届');
  assert.equal(company.links[0].url, 'https://careers.example.invalid/jobs?recommendCode=ABC123');
  assert.deepEqual(company.referralCodes.map((code) => code.value), ['CODE-A', 'ABC123']);
  assert.ok(company.referralCodes.every((code) => code.selected === false));

  const started = await command(client, 'user.start', {}, enqueued.body.revision);
  assert.equal(started.status, 200, started.text);
  assert.equal(started.body.state.queue.status, 'running');
  assert.equal(started.body.state.queue.state, 'running');
  assert.equal(started.body.state.queue.coreState, 'running');
  assert.equal(started.body.state.currentCompanyId, company.id);
  assert.equal(started.body.state.companies[0].status, 'awaiting_login');
  assert.equal(started.body.state.companies[0].coreStatus, 'awaiting_login');

  const loggedIn = await command(client, 'user.confirmLogin', {
    companyId: company.id,
    confirmedByUser: true,
  }, started.body.revision);
  assert.equal(loggedIn.status, 200, loggedIn.text);
  assert.equal(loggedIn.body.state.companies[0].status, 'searching');
  assert.equal(loggedIn.body.state.companies[0].coreStatus, 'researching');

  const candidates = await command(client, 'user.recordCandidates', {
    companyId: company.id,
    confirmedByUser: true,
    positions: [
      {
        officialId: 'JOB-1',
        title: '示例岗位一',
        city: '示例城市',
        checkedAt: NOW,
        officialUrl: 'https://careers.example.invalid/jobs/1',
        matchEvidence: '虚构官方 JD 与示例条件匹配。',
      },
      {
        officialId: 'JOB-2',
        title: '示例岗位二',
        checkedAt: NOW,
        officialUrl: 'https://careers.example.invalid/jobs/2',
        matchEvidence: '虚构官方 JD 与示例条件匹配。',
      },
    ],
  }, loggedIn.body.revision);
  assert.equal(candidates.status, 200, candidates.text);
  assert.equal(candidates.body.result.evidenceSource, 'user_manual_entry');
  assert.equal(candidates.body.state.companies[0].status, 'awaiting_job_selection');
  assert.equal(candidates.body.state.companies[0].coreStatus, 'awaiting_selection');
  assert.equal(candidates.body.state.companies[0].jobs.length, 2);
  assert.equal(candidates.body.state.companies[0].jobs[0].status, 'available');
  assert.equal(candidates.body.state.companies[0].jobs[0].coreStatus, 'candidate');
  const jobs = candidates.body.state.companies[0].jobs;

  const selected = await command(client, 'user.selectJobs', {
    companyId: company.id,
    jobIds: jobs.map((job) => job.id),
  }, candidates.body.revision);
  assert.equal(selected.status, 200, selected.text);
  assert.equal(selected.body.state.companies[0].status, 'filling');
  assert.equal(selected.body.state.companies[0].coreStatus, 'preparing');
  assert.equal(selected.body.state.companies[0].jobs[0].priority, 1);
  assert.equal(selected.body.state.companies[0].jobs[1].priority, 2);

  const earlySubmission = await command(client, 'user.reportSubmitted', {
    companyId: company.id,
    jobId: jobs[0].id,
    confirmedByUser: true,
  }, selected.body.revision);
  assert.equal(earlySubmission.status, 409);
  assert.equal(earlySubmission.body.error.code, 'NOT_READY_FOR_SUBMIT');
  assert.equal(earlySubmission.body.state ?? null, null);

  const noConfirmation = await command(client, 'user.reportSubmitted', {
    companyId: company.id,
    jobId: jobs[0].id,
    confirmedByUser: false,
  }, selected.body.revision);
  assert.equal(noConfirmation.status, 400);
  assert.equal(noConfirmation.body.error.code, 'CONFIRMATION_REQUIRED');

  const readyFirst = await command(client, 'user.markReady', {
    companyId: company.id,
    jobId: jobs[0].id,
    confirmedByUser: true,
  }, selected.body.revision);
  assert.equal(readyFirst.status, 200, readyFirst.text);
  assert.equal(readyFirst.body.state.companies[0].status, 'awaiting_submit');
  assert.equal(readyFirst.body.state.companies[0].coreStatus, 'awaiting_human_submit');
  assert.equal(readyFirst.body.state.companies[0].jobs[0].status, 'awaiting_submit');
  assert.equal(readyFirst.body.state.companies[0].jobs[0].coreStatus, 'awaiting_human_submit');

  const firstReceipt = await command(client, 'user.reportSubmitted', {
    companyId: company.id,
    jobId: jobs[0].id,
    confirmedByUser: true,
    note: '虚构申请号-1',
  }, readyFirst.body.revision);
  assert.equal(firstReceipt.status, 200, firstReceipt.text);
  const afterFirst = firstReceipt.body.state.companies[0];
  assert.equal(afterFirst.jobs[0].status, 'self_reported');
  assert.equal(afterFirst.jobs[0].verification, null);
  assert.equal(afterFirst.application.kind, 'partial');
  assert.match(afterFirst.result, /本人记录，待官网核验/);
  assert.doesNotMatch(afterFirst.result, /官网已核验/);
  assert.equal(firstReceipt.body.state.queue.status, 'running');

  const duplicate = await command(client, 'user.reportSubmitted', {
    companyId: company.id,
    jobId: jobs[0].id,
    confirmedByUser: true,
  }, firstReceipt.body.revision);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'ALREADY_SUBMITTED');

  const readySecond = await command(client, 'user.markReady', {
    companyId: company.id,
    jobId: jobs[1].id,
    confirmedByUser: true,
  }, firstReceipt.body.revision);
  assert.equal(readySecond.status, 200, readySecond.text);
  const secondReceipt = await command(client, 'user.reportSubmitted', {
    companyId: company.id,
    jobId: jobs[1].id,
    confirmedByUser: true,
  }, readySecond.body.revision);
  assert.equal(secondReceipt.status, 200, secondReceipt.text);
  assert.equal(secondReceipt.body.state.companies[0].status, 'completed');
  assert.equal(secondReceipt.body.state.companies[0].coreStatus, 'completed');
  assert.equal(secondReceipt.body.state.queue.status, 'drained');
  assert.equal(secondReceipt.body.state.queue.state, 'completed');
  assert.equal(secondReceipt.body.state.queue.coreState, 'drained');
  assert.equal(secondReceipt.body.state.queue.panelState, 'completed');
  assert.equal(secondReceipt.body.state.currentCompanyId, null);
  assert.equal(secondReceipt.body.state.companies[0].application.kind, 'self_reported');
  assert.doesNotMatch(secondReceipt.body.state.companies[0].result, /官网已核验/);
});

test('manual confirmation commands reject a missing confirmedByUser', async (t) => {
  const env = await createEnvironment(t);
  const client = await startApp(env);
  const enqueued = await command(client, 'user.enqueue', {
    url: 'https://confirm.example.invalid/jobs',
    companyName: '示例确认公司',
  }, 0);
  assert.equal(enqueued.status, 200, enqueued.text);
  const companyId = enqueued.body.state.companies[0].id;
  const started = await command(client, 'user.start', {}, enqueued.body.revision);
  assert.equal(started.status, 200, started.text);

  const missingLogin = await command(client, 'user.confirmLogin', { companyId }, started.body.revision);
  assert.equal(missingLogin.status, 400);
  assert.equal(missingLogin.body.error.code, 'CONFIRMATION_REQUIRED');

  const loggedIn = await command(client, 'user.confirmLogin', {
    companyId,
    confirmedByUser: true,
  }, started.body.revision);
  assert.equal(loggedIn.status, 200, loggedIn.text);

  const evidence = {
    reason: '虚构：本人核查后没有合适岗位。',
    sourceUrl: 'https://confirm.example.invalid/jobs',
    checkedAt: NOW,
    resultText: '虚构页面：0 个岗位。',
  };
  const missingNoPositions = await command(client, 'user.recordNoPositions', {
    companyId,
    evidence,
  }, loggedIn.body.revision);
  assert.equal(missingNoPositions.status, 400);
  assert.equal(missingNoPositions.body.error.code, 'CONFIRMATION_REQUIRED');

  const position = {
    officialId: 'CONFIRM-J1',
    title: '示例岗位',
    checkedAt: NOW,
    sourceUrl: 'https://confirm.example.invalid/jobs/1',
    matchEvidence: '虚构本人核查证据。',
  };
  const missingCandidates = await command(client, 'user.recordCandidates', {
    companyId,
    positions: [position],
  }, loggedIn.body.revision);
  assert.equal(missingCandidates.status, 400);
  assert.equal(missingCandidates.body.error.code, 'CONFIRMATION_REQUIRED');

  const candidates = await command(client, 'user.recordCandidates', {
    companyId,
    confirmedByUser: true,
    positions: [position],
  }, loggedIn.body.revision);
  assert.equal(candidates.status, 200, candidates.text);
  const jobId = candidates.body.state.companies[0].jobs[0].id;
  const selected = await command(client, 'user.selectJobs', {
    companyId,
    jobIds: [jobId],
  }, candidates.body.revision);
  assert.equal(selected.status, 200, selected.text);

  const missingReady = await command(client, 'user.markReady', {
    companyId,
    jobId,
  }, selected.body.revision);
  assert.equal(missingReady.status, 400);
  assert.equal(missingReady.body.error.code, 'CONFIRMATION_REQUIRED');

  const ready = await command(client, 'user.markReady', {
    companyId,
    jobId,
    confirmedByUser: true,
  }, selected.body.revision);
  assert.equal(ready.status, 200, ready.text);

  const missingRecovery = await command(client, 'user.acknowledgeRecovery', {}, ready.body.revision);
  assert.equal(missingRecovery.status, 400);
  assert.equal(missingRecovery.body.error.code, 'CONFIRMATION_REQUIRED');

  const recovered = await command(client, 'user.acknowledgeRecovery', {
    confirmedByUser: true,
  }, ready.body.revision);
  assert.equal(recovered.status, 200, recovered.text);
  assert.equal(recovered.body.result.recoveryPending, false);
});

test('manual no-positions evidence is recorded as a user source, not auto-research', async (t) => {
  const env = await createEnvironment(t);
  const client = await startApp(env);
  const enqueued = await command(client, 'user.enqueue', {
    url: 'https://none.example.invalid/jobs',
    companyName: '示例无岗位公司',
  }, 0);
  assert.equal(enqueued.status, 200, enqueued.text);
  const companyId = enqueued.body.state.companies[0].id;
  const started = await command(client, 'user.start', {}, enqueued.body.revision);
  assert.equal(started.status, 200, started.text);
  const loggedIn = await command(client, 'user.confirmLogin', {
    companyId,
    confirmedByUser: true,
  }, started.body.revision);
  assert.equal(loggedIn.status, 200, loggedIn.text);

  const noPositions = await command(client, 'user.recordNoPositions', {
    companyId,
    confirmedByUser: true,
    evidence: {
      reason: '虚构检索：当前批次没有符合本人条件的岗位。',
      sourceUrl: 'https://none.example.invalid/jobs',
      checkedAt: NOW,
      resultText: '虚构页面：0 个符合条件岗位。',
    },
  }, loggedIn.body.revision);
  assert.equal(noPositions.status, 200, noPositions.text);
  const company = noPositions.body.state.companies[0];
  assert.equal(company.status, 'no_suitable_jobs');
  assert.equal(company.coreStatus, 'no_positions');
  assert.equal(company.search.state, 'no_suitable_jobs');
  assert.equal(company.search.checkedBy, 'user');
  assert.equal(company.search.source, 'user_manual_entry');
  assert.equal(company.application.kind, 'no_suitable_jobs');
  assert.match(company.result, /没有符合职位/);
  assert.equal(noPositions.body.state.queue.status, 'drained');
  assert.equal(noPositions.body.state.queue.state, 'completed');
  assert.equal(noPositions.body.state.currentCompanyId, null);
});

test('defer and resume company keep the real held state', async (t) => {
  const env = await createEnvironment(t);
  const client = await startApp(env);
  const enqueued = await command(client, 'user.enqueue', {
    url: 'https://defer.example.invalid/jobs',
    companyName: '示例暂挂公司',
  }, 0);
  assert.equal(enqueued.status, 200, enqueued.text);
  const companyId = enqueued.body.state.companies[0].id;
  const started = await command(client, 'user.start', {}, enqueued.body.revision);
  const loggedIn = await command(client, 'user.confirmLogin', {
    companyId,
    confirmedByUser: true,
  }, started.body.revision);
  assert.equal(loggedIn.status, 200, loggedIn.text);

  const deferred = await command(client, 'user.deferCompany', { companyId }, loggedIn.body.revision);
  assert.equal(deferred.status, 200, deferred.text);
  assert.equal(deferred.body.state.companies[0].status, 'deferred');
  assert.equal(deferred.body.state.companies[0].coreStatus, 'held');
  assert.match(deferred.body.state.companies[0].holdReason, /稍后处理/);
  assert.equal(deferred.body.state.queue.status, 'drained');
  assert.equal(deferred.body.state.queue.state, 'completed');
  assert.equal(deferred.body.state.currentCompanyId, null);

  const resumed = await command(client, 'user.resumeCompany', { companyId }, deferred.body.revision);
  assert.equal(resumed.status, 200, resumed.text);
  assert.equal(resumed.body.state.companies[0].status, 'searching');
  assert.equal(resumed.body.state.companies[0].coreStatus, 'researching');
  assert.equal(resumed.body.state.queue.status, 'running');
  assert.equal(resumed.body.state.currentCompanyId, companyId);
});

test('concurrent commands serialize and stale revisions are rejected with 409', async (t) => {
  const env = await createEnvironment(t);
  const client = await startApp(env);

  const first = await command(client, 'user.enqueue', {
    url: 'https://a.example.invalid/jobs',
    companyName: '示例甲公司',
  }, 0);
  assert.equal(first.status, 200, first.text);
  const revision = first.body.revision;

  const [one, two] = await Promise.all([
    command(client, 'user.enqueue', {
      url: 'https://b.example.invalid/jobs',
      companyName: '示例乙公司',
    }, revision),
    command(client, 'user.enqueue', {
      url: 'https://c.example.invalid/jobs',
      companyName: '示例丙公司',
    }, revision),
  ]);
  const statuses = [one.status, two.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);
  const conflict = one.status === 409 ? one : two;
  assert.equal(conflict.body.error.code, 'REVISION_CONFLICT');
  assert.ok(Number.isInteger(conflict.body.error.details.currentRevision));

  const afterConflict = await state(client);
  assert.equal(afterConflict.status, 200);
  assert.equal(afterConflict.body.state.companies.length, 2);
  assert.equal(afterConflict.body.revision, conflict.body.error.details.currentRevision);

  const [three, four] = await Promise.all([
    command(client, 'user.enqueue', {
      url: 'https://d.example.invalid/jobs',
      companyName: '示例丁公司',
    }),
    command(client, 'user.enqueue', {
      url: 'https://e.example.invalid/jobs',
      companyName: '示例戊公司',
    }),
  ]);
  assert.equal(three.status, 200, three.text);
  assert.equal(four.status, 200, four.text);
  const finalState = await state(client);
  assert.equal(finalState.body.state.companies.length, 4);
  assert.equal(
    new Set(finalState.body.state.companies.map((company) => company.queueOrder)).size,
    4,
  );
});

test('profile sections, entityId, and label-inferred sensitivity stay conservative', async (t) => {
  const env = await createEnvironment(t);
  const client = await startApp(env);

  const content = await command(client, 'user.importFacts', {
    section: 'project_content',
    label: '项目内容',
    rawText: '虚构项目内容原文。',
    source: '虚构粘贴',
    entityId: 'project-example-1',
  }, 0);
  assert.equal(content.status, 200, content.text);
  const contentFact = content.body.state.facts.find((fact) => fact.label === '项目内容');
  assert.ok(contentFact);
  assert.equal(contentFact.section, 'project_content');
  assert.equal(contentFact.coreSection, 'project_content');
  assert.equal(contentFact.entityId, 'project-example-1');
  assert.equal(contentFact.confirmed, false);

  const responsibilities = await command(client, 'user.importFacts', {
    section: 'project_responsibilities',
    label: '项目职责',
    rawText: '虚构项目职责原文。',
    source: '虚构粘贴',
    entityId: 'project-example-1',
  }, content.body.revision);
  assert.equal(responsibilities.status, 200, responsibilities.text);
  const responsibilityFact = responsibilities.body.state.facts.find((fact) => fact.label === '项目职责');
  assert.ok(responsibilityFact);
  assert.equal(responsibilityFact.section, 'project_responsibilities');
  assert.equal(responsibilityFact.coreSection, 'project_responsibilities');
  assert.equal(responsibilityFact.entityId, 'project-example-1');

  const parent = await command(client, 'user.importFacts', {
    section: 'basic',
    label: '父亲姓名',
    rawText: '虚构父亲姓名',
    source: '虚构粘贴',
    sensitive: false,
  }, responsibilities.body.revision);
  assert.equal(parent.status, 200, parent.text);
  assert.equal(parent.body.result.sensitivity, 'family');
  assert.equal(parent.body.result.sensitivityInferredFromLabel, true);
  const parentFact = parent.body.state.facts.find((fact) => fact.label === '父亲姓名');
  assert.ok(parentFact);
  assert.equal(parentFact.section, 'basic');
  assert.equal(parentFact.sensitive, true);
  assert.equal(parentFact.sensitivity, 'family');
  assert.ok(parentFact.allowedPurposes.includes('local_profile_management'));

  const idCard = await command(client, 'user.importFacts', {
    section: 'basic',
    label: '身份证号',
    rawText: '虚构身份证号',
    source: '虚构粘贴',
    sensitive: false,
  }, parent.body.revision);
  assert.equal(idCard.status, 200, idCard.text);
  const idFact = idCard.body.state.facts.find((fact) => fact.label === '身份证号');
  assert.ok(idFact);
  assert.equal(idFact.sensitive, true);
  assert.equal(idFact.sensitivity, 'sensitive');

  const revised = await command(client, 'user.reviseFact', {
    factId: contentFact.id,
    expectedVersion: contentFact.version,
    patch: {
      entityId: 'project-example-2',
      rawText: '虚构项目内容修订版。',
    },
  }, idCard.body.revision);
  assert.equal(revised.status, 200, revised.text);
  const revisedFact = revised.body.state.facts.find((fact) => fact.id === contentFact.id);
  assert.ok(revisedFact);
  assert.equal(revisedFact.section, 'project_content');
  assert.equal(revisedFact.coreSection, 'project_content');
  assert.equal(revisedFact.entityId, 'project-example-2');
  assert.equal(revisedFact.rawText, '虚构项目内容修订版。');
  assert.equal(revisedFact.confirmed, false);
  assert.equal(revisedFact.version, contentFact.version + 1);
});

test('facts, model metadata, and error responses never leak secrets', async (t) => {
  const env = await createEnvironment(t);
  const client = await startApp(env);

  const imported = await command(client, 'user.importFacts', {
    section: 'basic',
    label: '示例字段',
    rawText: '  虚构原文\n第二行  ',
    source: '虚构粘贴',
    sensitive: false,
    confirmed: true,
    confirmedText: '伪造确认文本',
    verified: true,
  }, 0);
  assert.equal(imported.status, 200, imported.text);
  assert.equal(imported.body.result.confirmed, false);
  assert.deepEqual(imported.body.result.ignoredExternalFlags, ['confirmed', 'confirmedText', 'verified']);
  let fact = imported.body.state.facts[0];
  assert.equal(fact.section, 'basic');
  assert.equal(fact.rawText, '  虚构原文\n第二行  ');
  assert.equal(fact.confirmed, false);
  assert.equal(fact.confirmedText, '');
  assert.match(fact.source, /import/);
  assert.equal(fact.version, 1);

  const noConfirmation = await command(client, 'user.confirmFact', {
    factId: fact.id,
    expectedVersion: 1,
  }, imported.body.revision);
  assert.equal(noConfirmation.status, 400);
  assert.equal(noConfirmation.body.error.code, 'CONFIRMATION_REQUIRED');

  const confirmed = await command(client, 'user.confirmFact', {
    factId: fact.id,
    expectedVersion: 1,
    confirmedByUser: true,
  }, imported.body.revision);
  assert.equal(confirmed.status, 200, confirmed.text);
  fact = confirmed.body.state.facts[0];
  assert.equal(fact.confirmed, true);
  assert.equal(fact.confirmedText, '  虚构原文\n第二行  ');

  const revised = await command(client, 'user.reviseFact', {
    factId: fact.id,
    expectedVersion: 1,
    patch: { rawText: ' 修改后的原文 ' },
  }, confirmed.body.revision);
  assert.equal(revised.status, 200, revised.text);
  fact = revised.body.state.facts[0];
  assert.equal(fact.version, 2);
  assert.equal(fact.confirmed, false);
  assert.equal(fact.rawText, ' 修改后的原文 ');

  const staleConfirm = await command(client, 'user.confirmFact', {
    factId: fact.id,
    expectedVersion: 1,
    confirmedByUser: true,
  }, revised.body.revision);
  assert.equal(staleConfirm.status, 409);
  assert.equal(staleConfirm.body.error.code, 'PROFILE_VERSION_CONFLICT');
  assert.doesNotMatch(staleConfirm.text, /修改后的原文/);

  const missingVersion = await command(client, 'user.confirmFact', {
    factId: fact.id,
    confirmedByUser: true,
  }, revised.body.revision);
  assert.equal(missingVersion.status, 400);
  assert.equal(missingVersion.body.error.code, 'EXPECTED_VERSION_REQUIRED');

  const currentConfirm = await command(client, 'user.confirmFact', {
    factId: fact.id,
    expectedVersion: 2,
    confirmedByUser: true,
  }, revised.body.revision);
  assert.equal(currentConfirm.status, 200, currentConfirm.text);
  assert.equal(currentConfirm.body.result.version, 2);
  assert.equal(currentConfirm.body.result.confirmed, true);

  const family = await command(client, 'user.importFacts', {
    section: 'family',
    label: '示例家庭字段',
    rawText: '虚构敏感原文-不要回显',
    source: '虚构来源',
    sensitive: true,
  }, currentConfirm.body.revision);
  assert.equal(family.status, 200, family.text);
  const familyFact = family.body.state.facts.find((item) => item.section === 'family');
  assert.ok(familyFact);
  assert.equal(familyFact.confirmed, false);
  assert.equal(familyFact.sensitive, true);

  const badPatch = await command(client, 'user.reviseFact', {
    factId: familyFact.id,
    expectedVersion: familyFact.version,
    patch: { source: '不允许修改来源' },
  }, family.body.revision);
  assert.equal(badPatch.status, 400);
  assert.equal(badPatch.body.error.code, 'FIELD_PROTECTED');
  assert.doesNotMatch(badPatch.text, /虚构敏感原文-不要回显/);

  const secret = 'sk-fake-secret-value-do-not-return';
  const keyRejected = await command(client, 'user.saveModels', {
    roles: {
      search: {
        provider: 'example-provider',
        model: 'example-model-v1',
        endpoint: 'https://models.example.invalid/v1',
        apiKey: secret,
      },
    },
  }, family.body.revision);
  assert.equal(keyRejected.status, 200, keyRejected.text);
  assert.doesNotMatch(keyRejected.text, new RegExp(secret));
  assert.equal(keyRejected.body.state.models.search.apiKeySet, true);
  assert.equal(keyRejected.body.state.modelRoles.search.apiKeySet, true);
  const keyModelsFile = await fs.readFile(
    path.join(client.project, 'private', 'application-copilot', 'models.json'),
    'utf8',
  );
  assert.doesNotMatch(keyModelsFile, /apiKey|sk-fake-secret-value/);

  const saved = await command(client, 'user.saveModels', {
    roles: {
      research: {
        provider: 'example-provider',
        model: 'example-research-v1',
        baseUrl: 'https://models.example.invalid/v1',
      },
    },
  }, keyRejected.body.revision);
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.state.models.search.provider, 'example-provider');
  assert.equal(saved.body.state.models.search.model, 'example-research-v1');
  assert.equal(saved.body.state.models.search.endpoint, 'https://models.example.invalid/v1');
  assert.equal(saved.body.state.models.search.apiKeySet, true);
  assert.equal(saved.body.state.modelRoles.research.apiKeySet, true);
  assert.doesNotMatch(saved.text, /apiKey"/);
  assert.doesNotMatch(saved.text, new RegExp(secret));

  const modelsFile = await fs.readFile(
    path.join(client.project, 'private', 'application-copilot', 'models.json'),
    'utf8',
  );
  assert.doesNotMatch(modelsFile, /apiKey|sk-fake-secret-value/);
  assert.equal(JSON.parse(modelsFile).roles.search.provider, 'example-provider');
});

test('issue defer is a no-op while resolve requires confirmation and an answer', async (t) => {
  const env = await createEnvironment(t);
  const privateRoot = path.join(env.project, 'private');
  await fs.mkdir(privateRoot, { recursive: true });
  const seed = createWorkbenchService({
    directory: path.join(privateRoot, 'application-copilot', 'runtime'),
    privateRoot,
    now: () => NOW,
    newId: () => randomUUID(),
  });
  const operator = { actor: 'operator' };
  const company = await seed.addCompany({
    name: '示例问题公司',
    links: [{ url: 'https://issue.example.invalid/jobs', kind: 'apply', source: '虚构' }],
  }, operator);
  await seed.startQueue({ eventId: 'seed-start', confirmedBy: 'user' }, operator);
  await seed.recordHumanLogin({
    companyId: company.company.id,
    eventId: 'seed-login',
    confirmedBy: 'user',
  }, operator);
  const candidates = await seed.recordPositionCandidates({
    companyId: company.company.id,
    eventId: 'seed-candidates',
    positions: [{
      officialId: 'ISSUE-J1',
      title: '示例问题岗位',
      city: '示例城市',
      sourceUrl: 'https://issue.example.invalid/jobs/1',
      checkedAt: NOW,
      matchEvidence: '虚构本人核查证据。',
    }],
  }, operator);
  await seed.selectPositions({
    companyId: company.company.id,
    positionIds: [candidates.positions[0].id],
  }, operator);
  const seededIssue = await seed.addIssue({
    companyId: company.company.id,
    positionId: candidates.positions[0].id,
    fieldKey: 'gpa',
    type: 'unknown',
    severity: 'warn',
    blocking: false,
    message: '虚构问题：GPA 字段待本人确认。',
  }, operator);
  const secondIssue = await seed.addIssue({
    companyId: company.company.id,
    positionId: candidates.positions[0].id,
    fieldKey: 'major',
    type: 'unknown',
    severity: 'info',
    blocking: false,
    message: '虚构问题：专业名称待本人确认。',
  }, operator);

  const client = await startApp(env);
  const initial = await state(client);
  assert.equal(initial.status, 200, initial.text);
  const issueView = initial.body.state.issues.find((issue) => issue.id === seededIssue.issue.id);
  assert.ok(issueView);
  assert.equal(issueView.status, 'open');
  assert.equal(issueView.severity, 'confirm');
  assert.equal(issueView.coreSeverity, 'warn');
  assert.equal(initial.body.state.companies[0].status, 'filling');
  assert.equal(initial.body.state.companies[0].coreStatus, 'preparing');
  assert.equal(initial.body.state.queue.state, 'running');
  assert.equal(initial.body.state.queue.status, 'running');

  const deferred = await command(client, 'user.resolveIssue', {
    issueId: seededIssue.issue.id,
    action: 'defer',
  }, initial.body.revision);
  assert.equal(deferred.status, 200, deferred.text);
  assert.equal(deferred.body.result.deferred, true);
  assert.equal(deferred.body.revision, initial.body.revision);
  assert.equal(
    deferred.body.state.issues.find((issue) => issue.id === seededIssue.issue.id).status,
    'open',
  );

  const missingIssueDefer = await command(client, 'user.resolveIssue', {
    issueId: 'missing-issue',
    action: 'defer',
  }, deferred.body.revision);
  assert.equal(missingIssueDefer.status, 404);
  assert.equal(missingIssueDefer.body.error.code, 'ISSUE_NOT_FOUND');

  const missingConfirmation = await command(client, 'user.resolveIssue', {
    issueId: seededIssue.issue.id,
    action: 'resolve',
  }, deferred.body.revision);
  assert.equal(missingConfirmation.status, 400);
  assert.equal(missingConfirmation.body.error.code, 'CONFIRMATION_REQUIRED');

  const unresolvedOpen = await command(client, 'user.resolveIssue', {
    issueId: seededIssue.issue.id,
    action: 'resolve',
    confirmedByUser: true,
  }, deferred.body.revision);
  assert.equal(unresolvedOpen.status, 409);
  assert.equal(unresolvedOpen.body.error.code, 'ISSUE_ANSWER_REQUIRED');

  const explicitNoAnswer = await command(client, 'user.resolveIssue', {
    issueId: seededIssue.issue.id,
    action: 'resolve',
    confirmedByUser: true,
    confirmedNoAnswer: true,
  }, deferred.body.revision);
  assert.equal(explicitNoAnswer.status, 200, explicitNoAnswer.text);
  assert.equal(
    explicitNoAnswer.body.state.issues.find((issue) => issue.id === seededIssue.issue.id).status,
    'resolved',
  );

  const answered = await command(client, 'user.resolveIssue', {
    issueId: secondIssue.issue.id,
    action: 'answer',
    answer: '虚构本人回答。',
  }, explicitNoAnswer.body.revision);
  assert.equal(answered.status, 200, answered.text);
  assert.equal(
    answered.body.state.issues.find((issue) => issue.id === secondIssue.issue.id).status,
    'answered',
  );

  const resolved = await command(client, 'user.resolveIssue', {
    issueId: secondIssue.issue.id,
    action: 'resolve',
    confirmedByUser: true,
  }, answered.body.revision);
  assert.equal(resolved.status, 200, resolved.text);
  assert.equal(
    resolved.body.state.issues.find((issue) => issue.id === secondIssue.issue.id).status,
    'resolved',
  );
  assert.equal(resolved.body.result.resolved, true);
  assert.equal(resolved.body.result.deferred, false);
});

test('first write creates an application-private .gitignore before runtime data', async (t) => {
  const env = await createEnvironment(t);
  const client = await startApp(env);
  const enqueued = await command(client, 'user.enqueue', {
    url: 'https://ignore.example.invalid/jobs',
    companyName: '示例忽略公司',
  }, 0);
  assert.equal(enqueued.status, 200, enqueued.text);
  const appRoot = path.join(client.project, 'private', 'application-copilot');
  const ignorePath = path.join(appRoot, '.gitignore');
  const runtimePath = path.join(appRoot, 'runtime', 'runtime.json');
  const ignoreContent = await fs.readFile(ignorePath, 'utf8');
  assert.equal(ignoreContent, '*\n');
  const ignoreStat = await fs.stat(ignorePath);
  const runtimeStat = await fs.stat(runtimePath);
  assert.ok(ignoreStat.birthtimeMs <= runtimeStat.birthtimeMs);
});

test('existing private ignore must cover everything and is never overwritten', async (t) => {
  const unsafeEnv = await createEnvironment(t);
  const unsafeAppRoot = path.join(unsafeEnv.project, 'private', 'application-copilot');
  await fs.mkdir(unsafeAppRoot, { recursive: true });
  await fs.writeFile(path.join(unsafeAppRoot, '.gitignore'), '# user rule without wildcard\n', 'utf8');
  const unsafeClient = await startApp(unsafeEnv);
  const blocked = await command(unsafeClient, 'user.enqueue', {
    url: 'https://unsafe-ignore.example.invalid/jobs',
    companyName: '不应写入的公司',
  }, 0);
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'PRIVATE_IGNORE_UNSAFE');
  await assert.rejects(fs.stat(path.join(unsafeAppRoot, 'runtime', 'runtime.json')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(unsafeAppRoot, 'service-meta.json')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(unsafeAppRoot, 'models.json')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(unsafeAppRoot, '.service.lock')), { code: 'ENOENT' });

  const validEnv = await createEnvironment(t);
  const validAppRoot = path.join(validEnv.project, 'private', 'application-copilot');
  await fs.mkdir(validAppRoot, { recursive: true });
  const userIgnore = '# user rule\n*\n';
  await fs.writeFile(path.join(validAppRoot, '.gitignore'), userIgnore, 'utf8');
  const validClient = await startApp(validEnv);
  const allowed = await command(validClient, 'user.enqueue', {
    url: 'https://valid-ignore.example.invalid/jobs',
    companyName: '示例有效忽略公司',
  }, 0);
  assert.equal(allowed.status, 200, allowed.text);
  assert.equal(await fs.readFile(path.join(validAppRoot, '.gitignore'), 'utf8'), userIgnore);
  await fs.stat(path.join(validAppRoot, 'runtime', 'runtime.json'));
});

test('project lock blocks a second instance, releases on stop, and state recovers', async (t) => {
  const env = await createEnvironment(t);
  const first = await startApp(env);
  const firstEnqueue = await command(first, 'user.enqueue', {
    url: 'https://lock.example.invalid/jobs',
    companyName: '示例锁公司',
  }, 0);
  assert.equal(firstEnqueue.status, 200, firstEnqueue.text);
  const revision = firstEnqueue.body.revision;
  const lockPath = path.join(first.project, 'private', 'application-copilot', '.service.lock');
  await fs.stat(lockPath);

  const second = await startApp(env);
  const locked = await command(second, 'user.enqueue', {
    url: 'https://blocked.example.invalid/jobs',
    companyName: '不应写入的公司',
  }, revision);
  assert.equal(locked.status, 409);
  assert.equal(locked.body.error.code, 'PROJECT_LOCKED');
  assert.match(locked.body.error.message, /未删除存活锁/);

  await first.app.stop();
  await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });

  const retry = await command(second, 'user.enqueue', {
    url: 'https://second.example.invalid/jobs',
    companyName: '示例乙公司',
  });
  assert.equal(retry.status, 200, retry.text);
  assert.equal(retry.body.state.companies.length, 2);
  assert.equal(new Set(retry.body.state.companies.map((company) => company.id)).size, 2);

  const recovered = await startApp(env);
  const recoveredState = await state(recovered);
  assert.equal(recoveredState.status, 200);
  assert.equal(recoveredState.body.state.companies.length, 2);
  assert.equal(
    recoveredState.body.revision,
    retry.body.revision,
  );
  assert.equal(recoveredState.body.state.companies.find((company) => company.name === '示例锁公司').status, 'queued');

  await second.app.stop();
  await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
  await recovered.app.stop();
  await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
});

test('service entry refuses to start without a host token', async () => {
  const env = {
    ...process.env,
    OPENCHAMBER_SERVICE_PORT: '54321',
  };
  delete env.OPENCHAMBER_SERVICE_TOKEN;
  const child = spawn(process.execPath, [MAIN_PATH], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 1);
  assert.match(stderr, /OPENCHAMBER_SERVICE_TOKEN is required/);
  assert.doesNotMatch(stderr, /test-token/);
});
