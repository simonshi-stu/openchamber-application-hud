import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_COMMANDS,
  APPLICATION_META,
  COMMAND,
  CONTRACT_VERSION,
  ContractError,
  PROFILE_SECTIONS,
  SEARCH_META,
  STATUS_META,
  UI_COMMANDS,
  buildCapabilitiesRequest,
  buildCommandPayload,
  buildCommandRequest,
  buildSessionInboxAckRequest,
  buildSessionInboxRequest,
  buildSessionInboxStateRequest,
  buildStateRequest,
  countUnresolvedIssues,
  describeCompanyApplication,
  isAgentCommand,
  isSafeHttpUrl,
  isUiCommand,
  normalizeState,
  parseCapabilitiesResponse,
  parseCommandResponse,
  parseSessionInboxAckResponse,
  parseSessionInboxResponse,
  parseSessionInboxStateResponse,
  parseStateResponse,
  statusMeta,
} from './contract.js';

test('commands are separated and the panel may only send user.*', () => {
  assert.equal(CONTRACT_VERSION, 1);
  assert.ok(UI_COMMANDS.length >= 10);
  assert.ok(UI_COMMANDS.every((command) => command.startsWith('user.')));
  assert.ok(AGENT_COMMANDS.length >= 1);
  assert.ok(AGENT_COMMANDS.every((command) => command.startsWith('agent.')));
  assert.ok(!UI_COMMANDS.some((command) => AGENT_COMMANDS.includes(command)));
  assert.equal(isUiCommand(COMMAND.enqueue), true);
  assert.equal(isUiCommand('agent.reportFillProgress'), false);
  assert.equal(isAgentCommand('agent.reportFillProgress'), true);
  assert.equal(isAgentCommand('user.enqueue'), false);
  for (const forbidden of [
    'user.submit',
    'user.verify',
    'user.writeState',
    'user.replaceState',
    'agent.submit',
    'agent.writeState',
    'agent.replaceState',
    'agent.saveAll',
  ]) {
    assert.ok(!isUiCommand(forbidden), forbidden);
    assert.ok(!isAgentCommand(forbidden), forbidden);
    assert.throws(
      () => buildCommandPayload({ directory: 'C:/demo', command: forbidden, input: {} }),
      /未知的面板命令|未知命令/,
    );
  }
});

test('command envelope has only the contracted fields', () => {
  const payload = buildCommandPayload({
    directory: 'E:/demo/project',
    command: COMMAND.pause,
    input: { reason: '本人稍后处理', state: { evil: true } },
    expectedRevision: 7,
  });
  assert.deepEqual(payload, {
    directory: 'E:/demo/project',
    command: 'user.pause',
    input: { reason: '本人稍后处理' },
    expectedRevision: 7,
  });
  assert.deepEqual(buildStateRequest('E:/demo/project'), {
    method: 'GET',
    path: '/api/state',
    query: { directory: 'E:/demo/project' },
  });
  assert.deepEqual(buildCapabilitiesRequest(), {
    method: 'GET',
    path: '/api/capabilities',
  });
  const request = buildCommandRequest({
    directory: 'E:/demo/project',
    command: COMMAND.resume,
    input: {},
    expectedRevision: 3,
  });
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/api/command');
  assert.equal(JSON.parse(request.body).expectedRevision, 3);
});

test('session inbox requests preserve message text and validate acknowledgements', () => {
  assert.deepEqual(buildSessionInboxRequest('E:/demo/project'), {
    method: 'GET',
    path: '/api/session-inbox',
    query: { directory: 'E:/demo/project' },
  });
  const ack = buildSessionInboxAckRequest('E:/demo/project', ['message-1']);
  assert.equal(ack.method, 'POST');
  assert.equal(ack.path, '/api/session-inbox/ack');
  assert.deepEqual(JSON.parse(ack.body), {
    directory: 'E:/demo/project',
    messageIds: ['message-1'],
  });
  const state = buildSessionInboxStateRequest('E:/demo/project', ['message-1'], 'needs_review');
  assert.equal(state.method, 'POST');
  assert.equal(state.path, '/api/session-inbox/state');
  assert.deepEqual(JSON.parse(state.body), {
    directory: 'E:/demo/project',
    messageIds: ['message-1'],
    state: 'needs_review',
  });
  assert.throws(
    () => buildSessionInboxAckRequest('E:/demo/project', ['message-1', 'message-1']),
    error => error.code === 'INVALID_SESSION_MESSAGE_IDS',
  );
  const response = parseSessionInboxResponse({
    status: 200,
    body: JSON.stringify({
      ok: true,
      messages: [{
        id: 'message-1',
        text: '  保留原文  ',
        createdAt: '2026-10-28T00:00:00.000Z',
        targetSessionId: 'ses_virtual_test',
      }],
    }),
  });
  assert.deepEqual(response.messages[0].text, '  保留原文  ');
  assert.equal(response.messages[0].targetSessionId, 'ses_virtual_test');
  assert.equal(response.messages[0].deliveryState, 'pending');
  assert.equal(
    parseSessionInboxResponse({
      status: 200,
      body: JSON.stringify({
        ok: true,
        messages: [{
          id: 'message-2',
          text: '虚构消息',
          createdAt: '2026-10-28T00:00:00.000Z',
          deliveryState: 'needs_review',
        }],
      }),
    }).messages[0].deliveryState,
    'needs_review',
  );
  assert.deepEqual(
    parseSessionInboxAckResponse({ status: 200, body: JSON.stringify({ ok: true, acknowledged: 1 }) }),
    { acknowledged: 1 },
  );
  assert.deepEqual(
    parseSessionInboxStateResponse({ status: 200, body: JSON.stringify({ ok: true, updated: 1 }) }),
    { updated: 1 },
  );
  assert.throws(
    () => buildSessionInboxStateRequest('E:/demo/project', ['message-1'], 'unknown'),
    error => error.code === 'INVALID_SESSION_DELIVERY_STATE',
  );
});

test('enqueue accepts http(s) only and does not select a referral code', () => {
  assert.throws(
    () => buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.enqueue,
      input: { url: 'javascript:alert(1)' },
    }),
    (error) => error instanceof ContractError && error.code === 'INVALID_URL',
  );
  assert.throws(
    () => buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.enqueue,
      input: { url: 'https://user:pass@example.invalid/job' },
    }),
    (error) => error.code === 'INVALID_URL',
  );
  const payload = buildCommandPayload({
    directory: 'E:/demo',
    command: COMMAND.enqueue,
    input: {
      url: 'https://example.invalid/jobs/1',
      referralCode: 'CODE-1',
      companyName: '示例公司',
      source: '本人粘贴',
    },
  });
  assert.deepEqual(payload.input, {
    url: 'https://example.invalid/jobs/1',
    referralCode: 'CODE-1',
    companyName: '示例公司',
    source: '本人粘贴',
  });
  assert.ok(isSafeHttpUrl('http://127.0.0.1:4173/private'));
  assert.equal(isSafeHttpUrl('https://'), false);
  assert.equal(isSafeHttpUrl('ftp://example.invalid/x'), false);
});

test('job selection is exactly one to three unique official candidates', () => {
  for (const jobIds of [[], ['a', 'b', 'c', 'd'], ['a', 'a']]) {
    assert.throws(
      () => buildCommandPayload({
        directory: 'E:/demo',
        command: COMMAND.selectJobs,
        input: { companyId: 'company-1', jobIds },
      }),
      (error) => error.code === 'INVALID_JOB_SELECTION',
    );
  }
  const payload = buildCommandPayload({
    directory: 'E:/demo',
    command: COMMAND.selectJobs,
    input: { companyId: 'company-1', jobIds: ['job-2', 'job-1'] },
  });
  assert.deepEqual(payload.input, { companyId: 'company-1', jobIds: ['job-2', 'job-1'] });
});

test('reportSubmitted requires an explicit human confirmation and is not a submit command', () => {
  assert.throws(
    () => buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.reportSubmitted,
      input: { companyId: 'c1', jobId: 'j1', confirmedByUser: false },
    }),
    (error) => error.code === 'CONFIRMATION_REQUIRED',
  );
  const payload = buildCommandPayload({
    directory: 'E:/demo',
    command: COMMAND.reportSubmitted,
    input: { companyId: 'c1', jobId: 'j1', confirmedByUser: true, note: '本人官网记录' },
  });
  assert.equal(payload.command, 'user.reportSubmitted');
  assert.equal(payload.input.confirmedByUser, true);
  assert.ok(!payload.command.includes('submit'));
});

test('issue resolution is per item: answer, defer or explicit resolve', () => {
  assert.throws(
    () => buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.resolveIssue,
      input: { issueId: 'i1', action: 'dismiss' },
    }),
    (error) => error.code === 'INVALID_ISSUE_ACTION',
  );
  const answer = buildCommandPayload({
    directory: 'E:/demo',
    command: COMMAND.resolveIssue,
    input: { issueId: 'i1', action: 'answer', answer: '  原文空格保留  ' },
  });
  assert.equal(answer.input.answer, '  原文空格保留  ');
  const defer = buildCommandPayload({
    directory: 'E:/demo',
    command: COMMAND.resolveIssue,
    input: { issueId: 'i1', action: 'defer' },
  });
  assert.deepEqual(defer.input, { issueId: 'i1', action: 'defer' });
  const resolve = buildCommandPayload({
    directory: 'E:/demo',
    command: COMMAND.resolveIssue,
    input: { issueId: 'i1', action: 'resolve', confirmedByUser: true },
  });
  assert.deepEqual(resolve.input, {
    issueId: 'i1',
    action: 'resolve',
    confirmedByUser: true,
  });
  assert.throws(
    () => buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.resolveIssue,
      input: { issueId: 'i1', action: 'resolve', confirmedByUser: false },
    }),
    (error) => error.code === 'CONFIRMATION_REQUIRED',
  );
});

test('fact import preserves raw text and family facts are marked sensitive', () => {
  const raw = '\n  示例大学\n  GPA：3.8\n';
  const payload = buildCommandPayload({
    directory: 'E:/demo',
    command: COMMAND.importFacts,
    input: {
      section: 'family',
      label: '家庭成员',
      rawText: raw,
      source: '本人提供',
      sensitive: false,
      confirmed: true,
    },
  });
  assert.equal(payload.input.rawText, raw);
  assert.equal(payload.input.sensitive, true);
  assert.equal(Object.hasOwn(payload.input, 'confirmed'), false);
  assert.equal(
    PROFILE_SECTIONS.find((section) => section.id === 'family').sensitive,
    true,
  );
  assert.throws(
    () => buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.confirmFact,
      input: { factId: 'f1', confirmedByUser: false },
    }),
    (error) => error.code === 'CONFIRMATION_REQUIRED',
  );
});

test('model settings validate roles and strip key-status fields', () => {
  const payload = buildCommandPayload({
    directory: 'E:/demo',
    command: COMMAND.saveModels,
    input: {
      roles: {
        search: {
          provider: 'provider-a',
          model: 'model-a',
          endpoint: 'https://api.example.invalid/v1',
          apiKey: ' test-key ',
          apiKeySet: true,
          token: 'must-not-forward',
        },
        review: { provider: 'provider-b', model: 'model-b', clearApiKey: true },
      },
    },
  });
  assert.deepEqual(payload.input, {
    roles: {
      search: {
        provider: 'provider-a',
        model: 'model-a',
        endpoint: 'https://api.example.invalid/v1',
        apiKey: ' test-key ',
      },
      review: { provider: 'provider-b', model: 'model-b', clearApiKey: true },
    },
  });
  assert.throws(
    () => buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.saveModels,
      input: { roles: { review: { provider: 'x' } } },
    }),
    /model/,
  );
  assert.throws(
    () => buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.saveModels,
      input: { roles: { unknown: { provider: 'x', model: 'y' } } },
    }),
    (error) => error.code === 'INVALID_MODEL_ROLE',
  );
});

test('state normalization strips secrets and never invents confirmed or selected facts', () => {
  const state = normalizeState({
    queue: { state: 'running', activeCompanyId: 'c1' },
    companies: [
      {
        id: 'c1',
        name: '示例公司',
        status: 'search_blocked',
        referralCodes: ['CODE-A', 'CODE-B'],
        jobs: [
          {
            id: 'j1',
            title: '示例岗位',
            status: 'available',
            selected: false,
            apiKey: 'must-be-stripped',
          },
        ],
        application: { kind: 'blocked' },
      },
    ],
    issues: [
      { id: 'i1', title: '需要补充', severity: 'required', status: 'open' },
      { id: 'i2', title: '已解决', severity: 'confirm', status: 'resolved' },
    ],
    models: {
      search: {
        provider: 'p',
        model: 'm',
        apiKeySet: true,
        apiKey: 'secret',
        token: 'secret',
      },
    },
    facts: [
      {
        id: 'f1',
        section: 'project',
        label: '项目职责',
        rawText: '  保留原文  ',
        confirmed: 'yes',
        confirmedText: '不应自动确认',
      },
    ],
  });
  assert.equal(state.queue.state, 'running');
  assert.deepEqual(state.companies[0].referralCodes, [
    { value: 'CODE-A', source: '', selected: false },
    { value: 'CODE-B', source: '', selected: false },
  ]);
  assert.equal(state.companies[0].jobs[0].selected, false);
  assert.equal(state.companies[0].application.kind, 'blocked');
  assert.equal(state.models.search.apiKeySet, true);
  assert.equal(Object.hasOwn(state.models.search, 'apiKey'), false);
  assert.equal(Object.hasOwn(state.models.search, 'token'), false);
  assert.equal(state.facts[0].confirmed, false);
  assert.equal(state.facts[0].confirmedText, '不应自动确认');
  assert.equal(state.facts[0].rawText, '  保留原文  ');
  assert.equal(countUnresolvedIssues(state.issues), 1);
});

test('application, search and status labels keep the required distinctions', () => {
  const jobs = [
    { id: 'j1', title: '岗位甲', status: 'verified', selected: true, priority: 1 },
    { id: 'j2', title: '岗位乙', status: 'self_reported', selected: true, priority: 2 },
  ];
  assert.equal(
    describeCompanyApplication({
      jobs,
      application: { kind: 'verified', jobIds: ['j1'] },
    }),
    '已投递：岗位甲（官网已核验）',
  );
  assert.equal(
    describeCompanyApplication({
      jobs,
      application: { kind: 'self_reported', jobIds: ['j2'] },
    }),
    '已投递：岗位乙（本人记录，待官网核验）',
  );
  assert.equal(
    describeCompanyApplication({ jobs, application: { kind: 'no_suitable_jobs' } }),
    '未投递：没有符合职位',
  );
  assert.equal(
    describeCompanyApplication({ jobs, application: { kind: 'blocked' } }),
    '待处理：检索受阻',
  );
  assert.equal(
    describeCompanyApplication({ jobs, application: { kind: 'pending_submit', jobIds: ['j1'] } }),
    '待本人提交：岗位甲',
  );
  assert.notEqual(STATUS_META.no_suitable_jobs.label, STATUS_META.search_blocked.label);
  assert.notEqual(STATUS_META.submitted_self_reported.label, STATUS_META.submitted_verified.label);
  assert.notEqual(SEARCH_META.no_suitable_jobs.label, SEARCH_META.blocked.label);
  assert.equal(APPLICATION_META.self_reported.label, '已投递（本人记录，待官网核验）');
  assert.equal(APPLICATION_META.verified.label, '已投递（官网已核验）');
  assert.equal(statusMeta('made-up').label, '状态未知');
  assert.equal(
    describeCompanyApplication({
      status: 'skipped',
      skipReason: '本人决定不申请',
      application: { kind: 'none' },
    }),
    '未投递：本人跳过：本人决定不申请',
  );
});

test('service-shaped state maps core statuses and preserves evidence/entity IDs', () => {
  const parsed = parseStateResponse({
    status: 200,
    body: JSON.stringify({
      ok: true,
      revision: 12,
      state: {
        recoveryPending: true,
        currentCompanyId: 'c1',
        queue: {
          status: 'running',
          panelState: 'running',
          currentCompanyId: 'c1',
          message: '当前公司',
        },
        companies: [
          {
            id: 'c1',
            name: '示例公司',
            status: 'researching',
            coreStatus: 'researching',
            panelStatus: 'searching',
            activePositionId: 'j1',
            selectedPositionIds: ['j1'],
            skipReason: '',
            holdReason: '',
            search: {
              state: 'running',
              checkedBy: 'user',
              resultText: '本人核查结果',
              source: 'user_manual_entry',
            },
            jobs: [
              {
                id: 'j1',
                title: '示例岗位',
                status: 'awaiting_human_submit',
                coreStatus: 'awaiting_human_submit',
                submission: { reportedAt: '2026-10-26T10:00:00.000Z', reference: 'REF-1' },
              },
            ],
            application: { kind: 'pending_submit', jobIds: ['j1'] },
          },
          {
            id: 'c2',
            name: '已跳过公司',
            status: 'skipped',
            panelStatus: 'unknown',
          },
        ],
        issues: [
          {
            id: 'i1',
            title: '问题',
            status: 'answered',
            blocking: true,
            version: '2026-10-26T10:00:00.000Z',
          },
        ],
        facts: [
          {
            id: 'f1',
            section: 'project',
            coreSection: 'project_responsibilities',
            entityId: 'project-a',
            label: '项目职责',
            rawText: '原文',
            confirmed: true,
            confirmedText: '原文',
            version: 2,
          },
        ],
      },
    }),
  });
  const [active, skipped] = parsed.state.companies;
  assert.equal(parsed.state.recoveryPending, true);
  assert.equal(parsed.state.queue.coreState, 'running');
  assert.equal(active.status, 'searching');
  assert.equal(active.coreStatus, 'researching');
  assert.equal(active.search.checkedBy, 'user');
  assert.equal(active.search.resultText, '本人核查结果');
  assert.equal(active.activePositionId, 'j1');
  assert.equal(active.jobs[0].status, 'awaiting_submit');
  assert.equal(active.jobs[0].submission.reference, 'REF-1');
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.application.kind, 'skipped');
  assert.equal(parsed.state.issues[0].blocking, true);
  assert.equal(parsed.state.facts[0].section, 'project_responsibilities');
  assert.equal(parsed.state.facts[0].entityId, 'project-a');
});

test('service response parsing is explicit and conflicts are not success', () => {
  const parsedState = parseStateResponse({
    status: 200,
    body: JSON.stringify({
      ok: true,
      revision: 4,
      state: { queue: { state: 'paused' }, companies: [], issues: [] },
    }),
  });
  assert.equal(parsedState.revision, 4);
  assert.equal(parsedState.state.queue.state, 'paused');

  assert.throws(
    () => parseStateResponse({
      status: 409,
      body: JSON.stringify({
        ok: false,
        error: { code: 'REVISION_CONFLICT', message: '状态已更新' },
      }),
    }),
    (error) => error instanceof ContractError && error.code === 'REVISION_CONFLICT',
  );
  assert.throws(
    () => parseStateResponse({ status: 200, body: '{"ok":true,"revision":"x"}' }),
    (error) => error.code === 'INVALID_REVISION',
  );
  assert.throws(
    () => parseCommandResponse({ status: 200, body: '{"ok":true}' }),
    (error) => error.code === 'INVALID_REVISION',
  );
  assert.throws(
    () => parseStateResponse({
      status: 200,
      body: JSON.stringify({ revision: 1, state: { companies: [], issues: [] } }),
    }),
    (error) => error.code === 'INVALID_SERVICE_RESPONSE',
  );
  const capabilities = parseCapabilitiesResponse({
    status: 200,
    body: JSON.stringify({
      ok: true,
      capabilities: {
        apiVersion: 1,
        backend: 'application-copilot-core',
        version: '0.1.0',
        commands: ['user.enqueue', 'user.resolveIssue'],
        limitations: ['真实招聘站填写待接入'],
      },
    }),
  });
  assert.equal(capabilities.apiVersion, 1);
  assert.equal(capabilities.commands.length, 2);
  assert.equal(capabilities.limitations[0], '真实招聘站填写待接入');
  assert.equal(capabilities.flags.secureModelCredentials, false);
  assert.equal(capabilities.flags.roleExecution, false);
  const modelCapabilities = parseCapabilitiesResponse({
    status: 200,
    body: JSON.stringify({
      ok: true,
      capabilities: {
        apiVersion: 1,
        backend: 'service',
        apiKeyStorage: true,
        modelExecution: true,
        reviewTransport: false,
      },
    }),
  });
  assert.equal(modelCapabilities.flags.secureModelCredentials, true);
  assert.equal(modelCapabilities.flags.roleExecution, true);
  assert.equal(modelCapabilities.flags.reviewTransport, false);
  assert.throws(
    () => parseCapabilitiesResponse({
      status: 200,
      body: JSON.stringify({ ok: true, capabilities: { apiVersion: 2 } }),
    }),
    (error) => error.code === 'UNSUPPORTED_CONTRACT_VERSION',
  );
});

test('login, ready, resume and skip commands require the correct human receipt', () => {
  assert.deepEqual(
    buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.confirmLogin,
      input: { companyId: 'c1', confirmedByUser: true },
    }).input,
    { companyId: 'c1', confirmedByUser: true, note: '' },
  );
  assert.throws(
    () => buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.confirmLogin,
      input: { companyId: 'c1' },
    }),
    (error) => error.code === 'CONFIRMATION_REQUIRED',
  );
  assert.deepEqual(
    buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.markReady,
      input: { companyId: 'c1', jobId: 'j1', confirmedByUser: true },
    }).input,
    { companyId: 'c1', jobId: 'j1', confirmedByUser: true },
  );
  assert.throws(
    () => buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.markReady,
      input: { companyId: 'c1', jobId: 'j1' },
    }),
    (error) => error.code === 'CONFIRMATION_REQUIRED',
  );
  assert.deepEqual(
    buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.resumeCompany,
      input: { companyId: 'c1' },
    }).input,
    { companyId: 'c1' },
  );
  assert.throws(
    () => buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.skipJob,
      input: { companyId: 'c1', jobId: 'j1', reason: ' ', confirmedByUser: true },
    }),
    (error) => error.code === 'REASON_REQUIRED',
  );
  assert.deepEqual(
    buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.skipCompany,
      input: { companyId: 'c1', reason: '本人决定不申请', confirmedByUser: true },
    }).input,
    { companyId: 'c1', reason: '本人决定不申请', confirmedByUser: true },
  );
  assert.deepEqual(
    buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.acknowledgeRecovery,
      input: { confirmedByUser: true, observedAt: '2026-10-26T10:00:00.000Z' },
    }).input,
    { confirmedByUser: true, observedAt: '2026-10-26T10:00:00.000Z' },
  );
});

test('manual candidate and no-position evidence are explicit and bounded', () => {
  const candidateInput = {
    companyId: 'c1',
    positions: [
      {
        officialId: 'OFF-1',
        title: '示例岗位',
        city: '上海',
        sourceUrl: 'https://official.example.invalid/job/1',
        checkedAt: '2026-10-26T10:00:00.000Z',
        matchEvidence: '本人核对：学历与地点符合。',
      },
    ],
    confirmedByUser: true,
  };
  assert.deepEqual(
    buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.recordCandidates,
      input: candidateInput,
    }).input,
    candidateInput,
  );
  assert.throws(
    () => buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.recordCandidates,
      input: { ...candidateInput, confirmedByUser: false },
    }),
    (error) => error.code === 'CONFIRMATION_REQUIRED',
  );
  assert.throws(
    () => buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.recordCandidates,
      input: {
        ...candidateInput,
        positions: [{ ...candidateInput.positions[0], checkedAt: 'not-a-date' }],
      },
    }),
    (error) => error.code === 'INVALID_FIELD',
  );
  assert.throws(
    () => buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.recordCandidates,
      input: {
        ...candidateInput,
        positions: [
          ...candidateInput.positions,
          { ...candidateInput.positions[0], officialId: 'OFF-2' },
          { ...candidateInput.positions[0], officialId: 'OFF-3' },
          { ...candidateInput.positions[0], officialId: 'OFF-4' },
        ],
      },
    }),
    (error) => error.code === 'INVALID_POSITION',
  );
  const noPositions = buildCommandPayload({
    directory: 'E:/demo',
    command: COMMAND.recordNoPositions,
    input: {
      companyId: 'c1',
      evidence: {
        reason: '本人核对后没有符合地点与资格的岗位。',
        sourceUrl: 'https://official.example.invalid/jobs',
        checkedAt: '2026-10-26T10:00:00.000Z',
        resultText: '官方页面搜索结果为空。',
      },
      confirmedByUser: true,
    },
  });
  assert.equal(noPositions.input.confirmedByUser, true);
  assert.equal(noPositions.input.evidence.resultText, '官方页面搜索结果为空。');
  assert.throws(
    () => buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.recordNoPositions,
      input: {
        companyId: 'c1',
        evidence: {
          reason: '原因',
          sourceUrl: 'ftp://example.invalid/jobs',
          checkedAt: '2026-10-26T10:00:00.000Z',
          resultText: '结果',
        },
        confirmedByUser: true,
      },
    }),
    (error) => error.code === 'INVALID_URL',
  );
});

test('fact revision patches only allowed fields with an expected version', () => {
  assert.deepEqual(
    buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.reviseFact,
      input: {
        factId: 'f1',
        expectedVersion: 3,
        patch: {
          label: '项目职责',
          rawText: '  保留原文  ',
          entityId: 'project-a',
        },
      },
    }).input,
    {
      factId: 'f1',
      expectedVersion: 3,
      patch: {
        label: '项目职责',
        rawText: '  保留原文  ',
        entityId: 'project-a',
      },
    },
  );
  assert.deepEqual(
    buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.reviseFact,
      input: { factId: 'f1', expectedVersion: 'v3', patch: { entityId: null } },
    }).input.patch,
    { entityId: null },
  );
  assert.throws(
    () => buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.reviseFact,
      input: { factId: 'f1', expectedVersion: 3, patch: { section: 'basic' } },
    }),
    (error) => error.code === 'FIELD_PROTECTED',
  );
  assert.throws(
    () => buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.reviseFact,
      input: { factId: 'f1', expectedVersion: 3, patch: {} },
    }),
    (error) => error.code === 'INVALID_PATCH',
  );
});

test('profile sections separate project content and responsibilities', () => {
  const ids = PROFILE_SECTIONS.map((section) => section.id);
  assert.ok(ids.includes('project_content'));
  assert.ok(ids.includes('project_responsibilities'));
  assert.ok(ids.includes('skills'));
  assert.equal(
    buildCommandPayload({
      directory: 'E:/demo',
      command: COMMAND.importFacts,
      input: {
        section: 'project_responsibilities',
        entityId: 'project-a',
        label: '项目职责',
        rawText: '本人负责示例工作。',
        source: '简历原文',
      },
    }).input.entityId,
    'project-a',
  );
});
