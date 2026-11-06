// Fully synthetic Moka page/router fixtures for HUD-04. They never create a
// browser, call fetch, read a file, or contact a recruitment site.

import { createMokaDriverCore } from '../../browser/driver.js';

export const HUD_04_VIRTUAL_SCHEMA_VERSION = 'application-copilot.hud-04.virtual.v1';
export const HUD_04_VIRTUAL_NOW = '2026-11-02T00:00:00.000Z';
export const HUD_04_VIRTUAL_COMPANY_URL = 'https://app.mokahr.com/campus/hud04-virtual';
export const HUD_04_VIRTUAL_JOB_URL = 'https://app.mokahr.com/jobs/HUD04-J1';
export const HUD_04_VIRTUAL_JOB_ID = 'HUD04-J1';
export const HUD_04_VIRTUAL_POSITION_TITLE = '虚构数据治理实习生';

export const HUD_04_VIRTUAL_SCENARIOS = Object.freeze([
  'happy',
  'blocked-controls',
  'truncation',
  'readback-mismatch',
  'missing-readback',
  'rerender',
  'unknown-write-recovery',
]);

const CONTENT_TEXT = '虚构项目内容第一行\r\n虚构项目内容第二行';
const RESPONSIBILITIES_TEXT = '虚构本人职责第一行\r\n虚构本人职责第二行';

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

export function createHud04VirtualInput({ scenario = 'happy' } = {}) {
  if (!HUD_04_VIRTUAL_SCENARIOS.includes(scenario)) {
    throw new Error(`未知 HUD-04 虚构场景：${scenario}`);
  }
  return {
    schemaVersion: HUD_04_VIRTUAL_SCHEMA_VERSION,
    resume: {
      sourceName: 'fixture-resume-hud04.txt',
      sourceText: [
        '姓名：虚构候选人',
        '教育：虚构大学',
        '项目内容：虚构项目内容第一行',
        '虚构项目内容第二行',
        '本人职责：虚构本人职责第一行',
        '虚构本人职责第二行',
        '候选草稿：岗位专属材料候选，尚未确认。',
      ].join('\r\n'),
      paragraphs: [
        { id: 'para-name', text: '虚构候选人', kind: 'basic' },
        { id: 'para-school', text: '虚构大学', kind: 'education' },
        { id: 'para-project-content', text: CONTENT_TEXT, kind: 'project_content' },
        { id: 'para-project-responsibilities', text: RESPONSIBILITIES_TEXT, kind: 'project_responsibilities' },
      ],
      candidateDrafts: [{
        id: 'draft-hud04-project-material',
        content: CONTENT_TEXT,
        responsibilities: RESPONSIBILITIES_TEXT,
        sourceParagraphIds: ['para-project-content', 'para-project-responsibilities'],
        confirmed: false,
        status: 'unconfirmed',
      }],
    },
    profile: {
      profileVersion: 0,
      facts: [
        {
          id: 'fixture-name',
          section: 'basic',
          label: '姓名',
          value: '虚构候选人',
          source: { type: 'resume', ref: 'fixture-resume-hud04.txt#para-name' },
          confirmed: false,
          version: 1,
          confirmedVersion: null,
          sensitivity: 'normal',
          scope: { type: 'global', companyId: null, positionId: null },
        },
        {
          id: 'fixture-school',
          section: 'education',
          entityId: 'education-1',
          label: '学校',
          value: '虚构大学',
          source: { type: 'resume', ref: 'fixture-resume-hud04.txt#para-school' },
          confirmed: false,
          version: 1,
          confirmedVersion: null,
          sensitivity: 'normal',
          scope: { type: 'global', companyId: null, positionId: null },
        },
        {
          id: 'fixture-family',
          section: 'family',
          label: '父亲姓名',
          value: '虚构家长',
          source: { type: 'resume', ref: 'fixture-resume-hud04.txt#synthetic-family' },
          confirmed: false,
          version: 1,
          confirmedVersion: null,
          sensitivity: 'family',
          scope: { type: 'global', companyId: null, positionId: null },
        },
      ],
    },
    company: {
      id: 'hud04-company',
      name: '虚构星桥科技',
      batch: 'HUD-04-虚构批次',
      sourceUrl: HUD_04_VIRTUAL_COMPANY_URL,
      referralCandidates: [],
    },
    officialSnapshot: {
      sourceUrl: HUD_04_VIRTUAL_JOB_URL,
      capturedAt: HUD_04_VIRTUAL_NOW,
      complete: true,
      jobs: [{
        officialId: HUD_04_VIRTUAL_JOB_ID,
        title: HUD_04_VIRTUAL_POSITION_TITLE,
        city: '虚构城',
        jd: '虚构岗位描述：仅用于离线测试。',
        url: HUD_04_VIRTUAL_JOB_URL,
      }],
    },
    page: {
      targetId: 'hud04-target-1',
      snapshotId: 'synthetic-generated-at-runtime',
      pageUrl: HUD_04_VIRTUAL_JOB_URL,
      controls: [],
    },
    fakeRouter: {
      rankResult: {
        suggestions: [{
          officialId: HUD_04_VIRTUAL_JOB_ID,
          reason: '虚构岗位与已确认资料存在测试匹配。',
          gaps: [],
        }],
      },
      mapResult: { mappings: [] },
      reviewResult: { findings: [] },
    },
    scenario,
  };
}

function control({
  ref,
  tag = 'input',
  type = 'text',
  label,
  region,
  value = '',
  maxLength = 200,
  options = null,
}) {
  return {
    ref,
    tag,
    type,
    name: ref,
    id: ref,
    autocomplete: '',
    placeholder: '',
    label,
    labelSource: 'label',
    region,
    maxLength,
    minLength: 0,
    pattern: '',
    required: false,
    disabled: false,
    readOnly: false,
    value,
    writable: true,
    ...(tag === 'select' ? { options, optionCount: options.length } : {}),
  };
}

function pageControls(scenario) {
  const contentMaxLength = scenario === 'truncation' ? 8 : 200;
  const controls = [
    control({
      ref: 'hud04_name',
      label: '姓名',
      region: { type: 'basic', label: '基本信息', entityId: null, ambiguous: false },
      maxLength: 40,
    }),
    control({
      ref: 'hud04_school',
      tag: 'select',
      type: 'select',
      label: '学校',
      region: { type: 'education', label: '教育经历', entityId: 'education-1', ambiguous: false },
      options: [
        { value: 'school-placeholder', label: '请选择', disabled: false, selected: true },
        { value: 'virtual-school', label: '虚构大学', disabled: false, selected: false },
      ],
    }),
    control({
      ref: 'hud04_content',
      tag: 'textarea',
      type: 'textarea',
      label: '项目内容',
      region: { type: 'project', label: '虚构项目', entityId: 'project-hud04', ambiguous: false },
      maxLength: contentMaxLength,
    }),
    control({
      ref: 'hud04_responsibility',
      tag: 'textarea',
      type: 'textarea',
      label: '本人职责',
      region: { type: 'project', label: '虚构项目', entityId: 'project-hud04', ambiguous: false },
      maxLength: 200,
    }),
  ];

  if (scenario === 'blocked-controls') {
    controls.push(
      control({ ref: 'hud04_password', label: '密码', type: 'password', region: { type: 'basic', entityId: null } }),
      control({ ref: 'hud04_upload', label: '简历附件', type: 'file', region: { type: 'basic', entityId: null } }),
      control({ ref: 'hud04_choice', label: '同意协议', type: 'checkbox', region: { type: 'basic', entityId: null } }),
      control({ ref: 'hud04_submit', label: '提交申请', type: 'submit', region: { type: 'basic', entityId: null } }),
    );
  }
  return controls;
}

export function createHud04VirtualPage({ scenario = 'happy', input = createHud04VirtualInput({ scenario }) } = {}) {
  const stats = {
    info: 0,
    targetInfo: 0,
    observe: 0,
    research: 0,
    writes: 0,
    readback: 0,
    close: 0,
  };
  const writeLog = [];
  let targetId = input.page.targetId;
  let url = input.page.pageUrl;
  let closed = false;
  const controls = pageControls(scenario);
  const controlsByRef = new Map(controls.map((item) => [item.ref, item]));
  const values = new Map(controls.map((item) => [item.ref, {
    value: item.value || '',
    selectedValue: item.options?.find((option) => option.selected)?.value || '',
    selectedLabel: item.options?.find((option) => option.selected)?.label || '',
  }]));

  function assertOpen() {
    if (closed) throw new Error('synthetic page is closed');
  }

  function currentValue(ref) {
    return values.get(ref) || { value: '', selectedValue: '', selectedLabel: '' };
  }

  return {
    get targetId() {
      return targetId;
    },
    set targetId(value) {
      targetId = value;
    },
    get stats() {
      return { ...stats };
    },
    get values() {
      return new Map([...values.entries()].map(([key, value]) => [key, { ...value }]));
    },
    get controls() {
      return clone(controls);
    },
    get writeLog() {
      return writeLog.map((item) => ({ ...item }));
    },
    async targetInfo() {
      assertOpen();
      stats.targetInfo += 1;
      return { targetId, type: 'page' };
    },
    async info() {
      assertOpen();
      stats.info += 1;
      return {
        ok: true,
        url,
        title: 'HUD-04 synthetic Moka application',
        readyState: 'complete',
        hasPasswordField: false,
        loginHint: false,
      };
    },
    async observe() {
      assertOpen();
      stats.observe += 1;
      return {
        ok: true,
        url,
        title: 'HUD-04 synthetic Moka application',
        controls: clone(controls),
        issues: [],
      };
    },
    async research() {
      assertOpen();
      stats.research += 1;
      return {
        ok: true,
        url,
        jobs: input.officialSnapshot.jobs.map((job) => ({
          jobId: job.officialId,
          title: job.title,
          city: job.city,
          jd: job.jd,
          url: job.url,
        })),
        issues: [],
      };
    },
    async write({ ref, text, option, expected }) {
      assertOpen();
      stats.writes += 1;
      const observed = controlsByRef.get(ref);
      if (!observed) return { ok: false, code: 'UNKNOWN_CONTROL', message: 'synthetic control not found' };
      if (!expected) return { ok: false, code: 'SIGNATURE_REQUIRED', message: 'synthetic signature missing' };
      writeLog.push({ ref, text, option: option ? { ...option } : null });
      const current = currentValue(ref);
      if (observed.type === 'select') {
        const selected = observed.options.find((item) => item.value === option?.value && item.label === option?.label);
        if (!selected) return { ok: false, code: 'OPTION_NOT_FOUND', message: 'synthetic option not found' };
        current.selectedValue = selected.value;
        current.selectedLabel = selected.label;
      } else {
        current.value = text;
      }
      values.set(ref, current);

      if (scenario === 'unknown-write-recovery' && stats.writes === 1) {
        throw new Error('synthetic unknown result after page mutation');
      }

      if (scenario === 'readback-mismatch' && observed.type !== 'select') {
        current.value = text.slice(0, Math.max(0, text.length - 1));
        values.set(ref, current);
      }

      const actual = currentValue(ref);
      const isSelect = observed.type === 'select';
      const matched = isSelect
        ? actual.selectedValue === option?.value && actual.selectedLabel === option?.label
        : actual.value === text;
      return {
        ok: true,
        url,
        status: 'filled',
        readBackMatched: matched,
        ...(isSelect
          ? { readBackValue: actual.selectedValue, readBackLabel: actual.selectedLabel }
          : { readBackValue: actual.value, readBackLength: actual.value.length }),
      };
    },
    async readback({ refs }) {
      assertOpen();
      stats.readback += 1;
      const selectedRefs = scenario === 'missing-readback' ? refs.slice(1) : refs;
      return {
        ok: true,
        url,
        fields: selectedRefs.map((ref) => {
          const observed = controlsByRef.get(ref);
          const current = currentValue(ref);
          return observed?.type === 'select'
            ? { ref, value: current.selectedValue, length: current.selectedLabel.length, selectedLabel: current.selectedLabel }
            : { ref, value: current.value, length: current.value.length };
        }),
      };
    },
    async navigate(nextUrl) {
      assertOpen();
      url = nextUrl;
      return { ok: true, url };
    },
    rerender() {
      targetId = 'hud04-target-rerendered';
    },
    async close() {
      stats.close += 1;
      closed = true;
      return { ok: true };
    },
  };
}

export function createHud04VirtualDriver({ scenario = 'happy', input = createHud04VirtualInput({ scenario }), now = () => new Date(HUD_04_VIRTUAL_NOW) } = {}) {
  const page = createHud04VirtualPage({ scenario, input });
  const core = createMokaDriverCore({
    page,
    now,
    closeImpl: () => page.close(),
  });
  let opened = false;
  return {
    page,
    core,
    async openCompany(url) {
      if (url !== HUD_04_VIRTUAL_COMPANY_URL) {
        return { ok: false, code: 'SYNTHETIC_URL_MISMATCH', message: 'synthetic company URL mismatch' };
      }
      await page.navigate(HUD_04_VIRTUAL_JOB_URL);
      opened = true;
      return { ok: true, pageUrl: HUD_04_VIRTUAL_JOB_URL, targetId: page.targetId };
    },
    observe: (options) => core.observe(options),
    extractResearchSnapshot: () => core.extractResearchSnapshot(),
    fillConfirmedPlan: (plan, options) => core.fillConfirmedPlan(plan, options),
    readbackApprovedPlan: (plan) => core.readbackApprovedPlan(plan),
    close: () => core.close(),
    getStatus() {
      return {
        ...core.getStatus(),
        status: opened ? core.getStatus().status : 'idle',
        synthetic: true,
      };
    },
  };
}

export function createHud04VirtualRouter({ input = createHud04VirtualInput(), calls = null } = {}) {
  const counter = calls || { rank: 0, mapFields: 0, review: 0 };
  return {
    async rankCandidates({ officialSnapshot }) {
      counter.rank += 1;
      const allowed = new Set(officialSnapshot.jobs.map((job) => job.officialId));
      return {
        suggestions: input.fakeRouter.rankResult.suggestions
          .filter((suggestion) => allowed.has(suggestion.officialId))
          .map((suggestion) => ({ ...suggestion, title: officialSnapshot.jobs.find((job) => job.officialId === suggestion.officialId)?.title || '' })),
      };
    },
    async mapFields() {
      counter.mapFields += 1;
      return clone(input.fakeRouter.mapResult);
    },
    async reviewReadback() {
      counter.review += 1;
      const result = clone(input.fakeRouter.reviewResult);
      return {
        passed: result.findings.length === 0,
        programDiffs: [],
        modelFindings: result.findings,
        reviewKind: 'page_readback',
      };
    },
  };
}
