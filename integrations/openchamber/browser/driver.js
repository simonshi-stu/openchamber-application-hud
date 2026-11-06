// Moka 受控浏览器驱动。生产入口只在调用 openCompany 时启动浏览器；
// 不提供任意 selector、脚本、点击、提交或 shell 接口。

import { randomUUID } from 'node:crypto';
import { launchBrowser } from './launch.js';
import { attachPage, MokaPageError } from './cdp-page.js';
import { sanitizeObservation, publicControl, OBSERVATION_SCHEMA_VERSION } from './observation.js';
import { validateMokaFillPlan, MOKA_FILL_PLAN_SCHEMA_VERSION } from './fill-plan.js';
import { limitationsForFill, limitationsForResearch, MOKA_DRIVER_LIMITATIONS, MOKA_FILL_RESULT_NOTE } from './limitations.js';
import {
  MokaUrlError,
  parseApprovedMokaUrl,
  samePageUrl,
} from './url-policy.js';

const MAX_FILL_RESULTS = 50;
const MAX_FILL_ISSUES = 100;

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function nowIso(now) {
  try {
    const value = typeof now === 'function' ? now() : new Date();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function pageFailure(error, fallbackCode = 'PAGE_CALL_FAILED') {
  if (error instanceof MokaPageError) {
    return {
      code: error.code || fallbackCode,
      message: error.message || '浏览器页面操作失败。',
      details: error.details || null,
    };
  }
  return {
    code: fallbackCode,
    message: '浏览器页面操作失败。',
    details: { reason: error?.message || null },
  };
}

function bindingFailure(code, message) {
  return {
    ok: false,
    results: [],
    issues: [{ code, message, severity: 'blocked' }],
    limitations: limitationsForFill(),
    note: MOKA_FILL_RESULT_NOTE,
  };
}

function safeUrlLabel(raw) {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 300);
  } catch {
    return '[invalid-url]';
  }
}

function openNote(headless) {
  return headless
    ? '官网页面在受控无头浏览器中，未内嵌到 OpenChamber；登录与验证码由本人完成，本模式仅用于测试/受监督自动化。'
    : '官网在独立浏览器窗口，未内嵌到 OpenChamber；登录与验证码由本人完成。';
}

async function readInfoWithRetry(page, { attempts = 12, delayMs = 150 } = {}) {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      const info = await page.info();
      if (info && info.ok === true && typeof info.url === 'string' && info.url) {
        return info;
      }
      lastError = new MokaPageError('PAGE_INFO_UNAVAILABLE', '页面没有返回有效网址。');
    } catch (error) {
      lastError = error;
      if (error instanceof MokaPageError && error.code === 'TARGET_UNAVAILABLE') break;
    }
    if (index < attempts - 1) await sleep(delayMs);
  }
  throw lastError || new MokaPageError('PAGE_INFO_UNAVAILABLE', '页面没有返回有效网址。');
}

/**
 * 页面已 attach 之后的驱动核心。测试可用 fake page 直接验证这里的安全边界。
 */
export function createMokaDriverCore({ page, now = () => new Date(), closeImpl = null } = {}) {
  if (!page || typeof page.info !== 'function' || typeof page.write !== 'function' || typeof page.observe !== 'function') {
    throw new TypeError('createMokaDriverCore 需要 page adapter');
  }

  let snapshot = null;
  let internalControls = new Map();
  let closed = false;
  let closing = false;
  let lastPageUrl = null;

  function guard() {
    if (closed || closing) return { ok: false, code: 'DRIVER_CLOSED', message: '浏览器驱动已关闭。' };
    return null;
  }

  function invalidateSnapshot() {
    snapshot = null;
    internalControls = new Map();
  }

  async function readInfo() {
    let target;
    let info;
    try {
      target = await page.targetInfo();
      info = await page.info();
    } catch (error) {
      return { ok: false, ...pageFailure(error, 'TARGET_UNAVAILABLE') };
    }
    if (!target || target.targetId !== page.targetId || target.type !== 'page') {
      return { ok: false, code: 'TARGET_CHANGED', message: '当前页面 target 已变化，已停止操作。' };
    }
    if (!info || info.ok !== true || typeof info.url !== 'string' || !info.url) {
      return { ok: false, code: 'PAGE_INFO_UNAVAILABLE', message: '页面没有返回有效网址。' };
    }
    lastPageUrl = info.url;
    return {
      ok: true,
      targetId: target.targetId,
      url: info.url,
      title: typeof info.title === 'string' ? info.title : '',
      readyState: typeof info.readyState === 'string' ? info.readyState : '',
      hasPasswordField: info.hasPasswordField === true,
      loginHint: info.loginHint === true,
    };
  }

  async function approvedInfo() {
    const info = await readInfo();
    if (!info.ok) return info;
    try {
      const url = parseApprovedMokaUrl(info.url);
      return { ...info, url: url.href };
    } catch (error) {
      return {
        ok: false,
        code: 'PAGE_NOT_APPROVED',
        message: '当前页面已离开批准的 Moka 官方域名，已停止操作。',
        pageUrl: safeUrlLabel(info.url),
        urlCode: error instanceof MokaUrlError ? error.code : 'INVALID_URL',
      };
    }
  }

  async function observe({ maxControls = 200 } = {}) {
    const g = guard();
    if (g) return { ...g, issues: [{ code: g.code, message: g.message, severity: 'blocked' }] };
    invalidateSnapshot();

    const info = await approvedInfo();
    if (!info.ok) {
      return {
        ok: false,
        code: info.code,
        message: info.message,
        pageUrl: info.pageUrl || null,
        issues: [{ code: info.code, message: info.message, severity: 'blocked' }],
      };
    }

    const snapshotId = `snap_${randomUUID()}`;
    const refPrefix = `mc_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    let raw;
    try {
      raw = await page.observe({ refPrefix, maxControls });
    } catch (error) {
      const failure = pageFailure(error, 'OBSERVE_FAILED');
      return {
        ok: false,
        code: failure.code,
        message: failure.message,
        pageUrl: safeUrlLabel(info.url),
        issues: [{ code: failure.code, message: failure.message, severity: 'blocked' }],
      };
    }

    if (!raw || raw.ok !== true || typeof raw.url !== 'string') {
      return {
        ok: false,
        code: 'INVALID_OBSERVATION',
        message: '页面观察结果无效。',
        pageUrl: safeUrlLabel(info.url),
        issues: [{ code: 'INVALID_OBSERVATION', message: '页面观察结果无效。', severity: 'blocked' }],
      };
    }
    if (!samePageUrl(raw.url, info.url)) {
      return {
        ok: false,
        code: 'PAGE_CHANGED_DURING_OBSERVE',
        message: '观察过程中页面网址发生变化，请重新观察。',
        pageUrl: safeUrlLabel(raw.url),
        issues: [{ code: 'PAGE_CHANGED_DURING_OBSERVE', message: '观察过程中页面网址发生变化，请重新观察。', severity: 'blocked' }],
      };
    }
    let canonicalUrl;
    try {
      canonicalUrl = parseApprovedMokaUrl(raw.url).href;
    } catch {
      return {
        ok: false,
        code: 'PAGE_NOT_APPROVED',
        message: '观察到的页面不在批准的 Moka 官方域名内。',
        pageUrl: safeUrlLabel(raw.url),
        issues: [{ code: 'PAGE_NOT_APPROVED', message: '观察到的页面不在批准的 Moka 官方域名内。', severity: 'blocked' }],
      };
    }

    const sanitized = sanitizeObservation(raw, { maxControls });
    if (!sanitized.ok) {
      return {
        ok: false,
        code: 'INVALID_OBSERVATION',
        message: '页面观察结果结构无效。',
        pageUrl: safeUrlLabel(canonicalUrl),
        issues: sanitized.issues,
      };
    }

    const publicControls = sanitized.controls.map(publicControl);
    snapshot = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      id: snapshotId,
      targetId: page.targetId,
      pageUrl: canonicalUrl,
      pageTitle: typeof raw.title === 'string' ? raw.title.slice(0, 300) : info.title,
      capturedAt: nowIso(now),
      controls: publicControls,
      issues: sanitized.issues,
      counts: {
        controls: publicControls.length,
        blocked: sanitized.counts.blocked,
        writable: publicControls.filter((control) => control.writable).length,
        ambiguous: publicControls.filter((control) => control.region.ambiguous).length,
      },
    };
    internalControls = new Map(sanitized.controls.map((control) => [control.ref, {
      control,
      signature: control.signature,
    }]));

    return { ok: true, snapshot };
  }

  function addFillIssue(issues, issue) {
    if (issues.length >= MAX_FILL_ISSUES) return;
    const key = `${issue.code}|${issue.controlRef || ''}|${issue.factId || ''}`;
    if (issues.some((existing) => `${existing.code}|${existing.controlRef || ''}|${existing.factId || ''}` === key)) return;
    issues.push(issue);
  }

  function resultBase(item, control) {
    return {
      controlRef: item.controlRef,
      factId: item.factId,
      fieldKey: item.fieldKey || null,
      label: control?.label || '',
      regionType: control?.region?.type || item.regionType,
      regionEntityId: control?.region?.entityId || item.regionEntityId || null,
    };
  }

  async function fillConfirmedPlan(rawPlan, options = {}) {
    const signal = options.signal;
    const beforeWrite = options.beforeWrite;
    if (signal?.aborted) {
      return {
        ok: false,
        results: [],
        issues: [{ code: 'FILL_CANCELLED', message: '本人已取消；未写入任何字段。', severity: 'blocked' }],
        limitations: limitationsForFill(),
        note: MOKA_FILL_RESULT_NOTE,
      };
    }
    const g = guard();
    if (g) return bindingFailure(g.code, g.message);
    const validated = validateMokaFillPlan(rawPlan);
    if (!validated.ok) {
      return {
        ok: false,
        results: [],
        issues: validated.issues,
        limitations: limitationsForFill(),
        note: MOKA_FILL_RESULT_NOTE,
      };
    }
    const plan = validated.plan;
    if (!snapshot) {
      return {
        ...bindingFailure('NO_SNAPSHOT', '请先观察页面，再基于同一份观察生成填写计划。'),
        planSchemaVersion: MOKA_FILL_PLAN_SCHEMA_VERSION,
      };
    }
    if (plan.snapshotId !== snapshot.id) {
      return {
        ...bindingFailure('STALE_SNAPSHOT', '计划绑定的观察快照已过期，请重新观察并重新生成计划。'),
        snapshotId: snapshot.id,
        planSchemaVersion: MOKA_FILL_PLAN_SCHEMA_VERSION,
      };
    }
    if (!samePageUrl(plan.pageUrl, snapshot.pageUrl)) {
      return bindingFailure('SNAPSHOT_PAGE_MISMATCH', '计划页面网址与观察快照不一致，拒绝写入。');
    }
    if (plan.targetId !== snapshot.targetId) {
      return bindingFailure('SNAPSHOT_TARGET_MISMATCH', '计划 targetId 与当前页面不一致，拒绝写入。');
    }

    const info = await approvedInfo();
    if (!info.ok) {
      return {
        ...bindingFailure(info.code, info.message),
        pageUrl: info.pageUrl || null,
      };
    }
    if (info.targetId !== snapshot.targetId) {
      return bindingFailure('TARGET_CHANGED', '当前页面 target 已变化，拒绝写入。');
    }
    if (!samePageUrl(info.url, snapshot.pageUrl)) {
      return {
        ...bindingFailure('PAGE_URL_CHANGED', '页面网址在观察后已变化，拒绝写入。'),
        pageUrl: safeUrlLabel(info.url),
      };
    }

    // 同一个事实 ID 不能跨两个不同经历 entity 自动填写；避免把甲实习内容填到乙实习。
    const factEntities = new Map();
    for (const item of plan.items) {
      if (!item.regionEntityId) continue;
      const existing = factEntities.get(item.factId);
      if (existing && existing !== item.regionEntityId) {
        return bindingFailure('FACT_ENTITY_CONFLICT', '同一事实 ID 被绑定到多个经历 entity，拒绝混填。请为每段经历使用各自的事实。');
      }
      factEntities.set(item.factId, item.regionEntityId);
    }

    const results = [];
    const issues = [];
    let globalStop = null;

    for (const item of plan.items.slice(0, MAX_FILL_RESULTS)) {
      if (globalStop) {
        results.push({
          ...resultBase(item, null),
          status: 'skipped',
          code: globalStop.code,
          message: globalStop.message,
        });
        continue;
      }

      const internal = internalControls.get(item.controlRef);
      if (!internal) {
        const failed = { ...resultBase(item, null), status: 'failed', code: 'UNKNOWN_CONTROL', message: '快照中没有该控件引用。' };
        results.push(failed);
        addFillIssue(issues, { ...failed, severity: 'blocked' });
        continue;
      }
      const control = internal.control;
      const base = resultBase(item, control);

      if (signal?.aborted) {
        globalStop = { code: 'FILL_CANCELLED', message: '本人已取消；未继续写入后续字段。' };
        results.push({ ...base, status: 'skipped', code: globalStop.code, message: globalStop.message });
        addFillIssue(issues, { code: globalStop.code, message: globalStop.message, severity: 'blocked' });
        continue;
      }

      if (!control.writable) {
        const failed = {
          ...base,
          status: 'failed',
          code: 'CONTROL_NOT_WRITABLE',
          message: control.writableReason === 'AMBIGUOUS_REGION'
            ? '重复经历区域无法稳定分组，不能自动填写。'
            : '控件当前不可写。',
        };
        results.push(failed);
        addFillIssue(issues, { ...failed, severity: 'blocked' });
        continue;
      }
      if (control.region.type !== item.regionType
        || (control.region.entityId || null) !== (item.regionEntityId || null)) {
        const failed = {
          ...base,
          status: 'failed',
          code: 'REGION_MISMATCH',
          message: '计划绑定的经历区域与观察快照不一致，拒绝混填。',
        };
        results.push(failed);
        addFillIssue(issues, { ...failed, severity: 'blocked' });
        continue;
      }
      if (item.expectedLabel !== null && item.expectedLabel !== control.label) {
        const failed = {
          ...base,
          status: 'failed',
          code: 'LABEL_MISMATCH',
          message: '计划绑定的字段标签与观察快照不一致，拒绝写入。',
        };
        results.push(failed);
        addFillIssue(issues, { ...failed, severity: 'blocked' });
        continue;
      }
      if (control.disabled) {
        const failed = { ...base, status: 'failed', code: 'CONTROL_DISABLED', message: '控件已禁用。' };
        results.push(failed);
        addFillIssue(issues, { ...failed, severity: 'blocked' });
        continue;
      }
      if (control.readOnly) {
        const failed = { ...base, status: 'failed', code: 'CONTROL_READONLY', message: '控件只读。' };
        results.push(failed);
        addFillIssue(issues, { ...failed, severity: 'blocked' });
        continue;
      }
      if (control.type === 'select') {
        if (item.optionValue === null || item.optionLabel === null) {
          const failed = { ...base, status: 'failed', code: 'OPTION_REQUIRED', message: '下拉字段需要精确且唯一的 optionValue/optionLabel。' };
          results.push(failed);
          addFillIssue(issues, { ...failed, severity: 'blocked' });
          continue;
        }
        const optionMatches = (control.options || []).filter((option) => (
          option.value === item.optionValue && option.label === item.optionLabel
        ));
        if (optionMatches.length !== 1) {
          const failed = {
            ...base,
            status: 'failed',
            code: optionMatches.length ? 'OPTION_AMBIGUOUS' : 'OPTION_NOT_FOUND',
            message: optionMatches.length ? '观察快照中的下拉选项不唯一，拒绝选择。' : '观察快照中没有该精确选项，拒绝选择。',
          };
          results.push(failed);
          addFillIssue(issues, { ...failed, severity: 'blocked' });
          continue;
        }
        if (optionMatches[0].disabled) {
          const failed = { ...base, status: 'failed', code: 'OPTION_DISABLED', message: '观察快照中的下拉选项已禁用。' };
          results.push(failed);
          addFillIssue(issues, { ...failed, severity: 'blocked' });
          continue;
        }
        if (/^(请选择|请选择一项|请选择\.\.\.|--+|-|—+|select|choose|please\s*select)$/i.test(item.optionLabel)) {
          const failed = { ...base, status: 'failed', code: 'OPTION_PLACEHOLDER', message: '不能把下拉占位项当作已确认值。' };
          results.push(failed);
          addFillIssue(issues, { ...failed, severity: 'blocked' });
          continue;
        }
      } else if (item.optionValue !== null || item.optionLabel !== null) {
        const failed = { ...base, status: 'failed', code: 'OPTION_NOT_APPLICABLE', message: '非下拉字段不接受选项参数。' };
        results.push(failed);
        addFillIssue(issues, { ...failed, severity: 'blocked' });
        continue;
      }
      if (control.maxLength !== null && item.text.length > control.maxLength) {
        const failed = {
          ...base,
          status: 'failed',
          code: 'TOO_LONG',
          message: `确认文本超过控件长度限制（${item.text.length}/${control.maxLength}）。`,
          details: { actualLength: item.text.length, maxLength: control.maxLength },
        };
        results.push(failed);
        addFillIssue(issues, { ...failed, severity: 'blocked' });
        continue;
      }

      // 每次写前重新读取实时 URL 和 target；页面桥还会在真正赋值前再查一次 location.href。
      const before = await readInfo();      if (!before.ok) {
        globalStop = { code: before.code, message: before.message };
        const failed = { ...base, status: 'failed', code: before.code, message: before.message };
        results.push(failed);
        addFillIssue(issues, { ...failed, severity: 'blocked' });
        continue;
      }
      if (before.targetId !== snapshot.targetId) {
        globalStop = { code: 'TARGET_CHANGED', message: '当前页面 target 已变化，停止后续写入。' };
        const failed = { ...base, status: 'failed', code: globalStop.code, message: globalStop.message };
        results.push(failed);
        addFillIssue(issues, { ...failed, severity: 'blocked' });
        continue;
      }
      let liveUrl;
      try {
        liveUrl = parseApprovedMokaUrl(before.url).href;
      } catch {
        globalStop = { code: 'PAGE_NOT_APPROVED', message: '页面已离开批准的 Moka 官方域名，停止后续写入。' };
        const failed = { ...base, status: 'failed', code: globalStop.code, message: globalStop.message };
        results.push(failed);
        addFillIssue(issues, { ...failed, severity: 'blocked' });
        continue;
      }
      if (!samePageUrl(liveUrl, snapshot.pageUrl)) {
        globalStop = { code: 'PAGE_URL_CHANGED', message: '页面网址在观察后已变化，停止后续写入。' };
        const failed = { ...base, status: 'failed', code: globalStop.code, message: globalStop.message };
        results.push(failed);
        addFillIssue(issues, { ...failed, severity: 'blocked' });
        continue;
      }
      // 异步页面检查之后、真正写页面前再确认一次暂停信号；取消后只允许已发出的一次写入完成。
      if (signal?.aborted) {
        globalStop = { code: 'FILL_CANCELLED', message: '本人已取消；未继续写入后续字段。' };
        results.push({ ...base, status: 'skipped', code: globalStop.code, message: globalStop.message });
        addFillIssue(issues, { code: globalStop.code, message: globalStop.message, severity: 'blocked' });
        continue;
      }
      if (typeof beforeWrite === 'function') {
        let allowed = false;
        try {
          allowed = (await beforeWrite()) === true;
        } catch {
          allowed = false;
        }
        if (signal?.aborted) {
          globalStop = { code: 'FILL_CANCELLED', message: '本人已取消；未继续写入后续字段。' };
          results.push({ ...base, status: 'skipped', code: globalStop.code, message: globalStop.message });
          addFillIssue(issues, { code: globalStop.code, message: globalStop.message, severity: 'blocked' });
          continue;
        }
        if (!allowed) {
          globalStop = { code: 'WRITE_GUARD_BLOCKED', message: '公司、岗位或资料版本已变化；停止后续写入。' };
          results.push({ ...base, status: 'skipped', code: globalStop.code, message: globalStop.message });
          addFillIssue(issues, { code: globalStop.code, message: globalStop.message, severity: 'blocked' });
          continue;
        }
      }

      let response;
      try {
        response = await page.write({
          expectedUrl: snapshot.pageUrl,
          ref: item.controlRef,
          text: item.text,
          option: control.type === 'select'
            ? { value: item.optionValue, label: item.optionLabel }
            : null,
          expected: internal.signature,
        });
      } catch (error) {
        const failure = pageFailure(error, 'WRITE_FAILED');
        // A thrown write has an unknown outcome: the page may have changed
        // before the response was lost. Stop the batch rather than issuing
        // more writes or making a later retry look exactly-once.
        if (failure.code === 'WRITE_FAILED' || failure.code === 'TARGET_UNAVAILABLE' || failure.code === 'PAGE_TIMEOUT') {
          globalStop = { code: failure.code, message: failure.message };
        }
        const failed = { ...base, status: 'failed', code: failure.code, message: failure.message };
        results.push(failed);
        addFillIssue(issues, { ...failed, severity: 'blocked' });
        continue;
      }

      if (!response || response.ok !== true) {
        const code = typeof response?.code === 'string' ? response.code : 'WRITE_FAILED';
        const message = typeof response?.message === 'string' ? response.message : '页面拒绝写入。';
        if (code === 'WRITE_FAILED' || code === 'PAGE_URL_CHANGED') {
          globalStop = { code, message };
        }
        const failed = {
          ...base,
          status: 'failed',
          code,
          message,
          details: response?.changedFields ? { changedFields: response.changedFields } : undefined,
        };
        results.push(failed);
        addFillIssue(issues, { ...failed, severity: 'blocked' });
        continue;
      }
      if (typeof response.url !== 'string' || !samePageUrl(response.url, snapshot.pageUrl)) {
        globalStop = { code: 'PAGE_URL_CHANGED', message: '写入过程中页面网址缺失或发生变化，停止后续写入。' };
        const failed = { ...base, status: 'failed', code: globalStop.code, message: globalStop.message };
        results.push(failed);
        addFillIssue(issues, { ...failed, severity: 'blocked' });
        continue;
      }
      if (response.status !== 'filled' && response.status !== 'already_set') {
        const failed = {
          ...base,
          status: 'failed',
          code: 'WRITE_STATUS_INVALID',
          message: '页面写入结果状态不明确，未计为成功。',
        };
        results.push(failed);
        addFillIssue(issues, { ...failed, severity: 'blocked' });
        continue;
      }
      if (response.readBackMatched !== true) {
        const failed = {
          ...base,
          status: 'failed',
          code: 'READBACK_MISMATCH',
          message: '写入后读回与确认文本不一致，标记失败。',
        };
        results.push(failed);
        addFillIssue(issues, { ...failed, severity: 'blocked' });
        continue;
      }
      if (response.status !== 'already_set') {
        if (control.type === 'select') {
          if (response.readBackValue !== item.optionValue || response.readBackLabel !== item.optionLabel) {
            const failed = {
              ...base,
              status: 'failed',
              code: 'READBACK_MISMATCH',
              message: '下拉写入后读回的选项与计划不一致。',
            };
            results.push(failed);
            addFillIssue(issues, { ...failed, severity: 'blocked' });
            continue;
          }
        } else if (!Number.isInteger(response.readBackLength) || response.readBackLength !== item.text.length) {
          const failed = {
            ...base,
            status: 'failed',
            code: 'READBACK_MISMATCH',
            message: '写入后读回长度与确认文本不一致。',
          };
          results.push(failed);
          addFillIssue(issues, { ...failed, severity: 'blocked' });
          continue;
        }
      }

      const status = response.status === 'already_set' ? 'already_set' : 'filled';
      results.push({
        ...base,
        status,
        code: null,
        message: status === 'already_set' ? '页面值已与确认文本一致，未重复写入。' : '已写入并即时读回一致。',
        readBackMatched: true,
      });
    }

    if (globalStop && !issues.some((issue) => issue.code === globalStop.code)) {
      addFillIssue(issues, {
        code: globalStop.code,
        message: globalStop.message,
        severity: 'blocked',
      });
    }

    const successful = results.length === plan.items.length
      && results.every((result) => result.status === 'filled' || result.status === 'already_set');
    return {
      ok: !globalStop && successful && issues.length === 0,
      planSchemaVersion: MOKA_FILL_PLAN_SCHEMA_VERSION,
      snapshotId: snapshot.id,
      pageUrl: snapshot.pageUrl,
      targetId: snapshot.targetId,
      completedAt: nowIso(now),
      results,
      issues,
      limitations: limitationsForFill(),
      note: MOKA_FILL_RESULT_NOTE,
    };
  }

  const ALLOWED_RESEARCH_ISSUES = new Set(['LOGIN_REQUIRED', 'JD_NOT_BOUND', 'JD_WITHOUT_JOB', 'NO_RELIABLE_JOB_CARDS']);

  async function readbackApprovedPlan(rawPlan) {
    const g = guard();
    if (g) return { ok: false, code: g.code, message: g.message, fields: [] };
    const validated = validateMokaFillPlan(rawPlan);
    if (!validated.ok) return { ok: false, code: 'INVALID_PLAN', message: '读回计划未通过严格 schema。', fields: [] };
    const plan = validated.plan;
    if (!snapshot || plan.snapshotId !== snapshot.id || plan.targetId !== snapshot.targetId
      || !samePageUrl(plan.pageUrl, snapshot.pageUrl)) {
      return { ok: false, code: 'STALE_SNAPSHOT', message: '只允许读回上次批准计划绑定的同一页面与快照。', fields: [] };
    }
    const info = await approvedInfo();
    if (!info.ok) return { ok: false, code: info.code, message: info.message, fields: [] };
    if (info.targetId !== snapshot.targetId || !samePageUrl(info.url, snapshot.pageUrl)) {
      return { ok: false, code: 'PAGE_URL_CHANGED', message: '页面已变化；未读回，不能以预期值代替。', fields: [] };
    }
    const refs = [];
    for (const item of plan.items) {
      const internal = internalControls.get(item.controlRef);
      if (!internal) return { ok: false, code: 'UNKNOWN_CONTROL', message: '计划控件不在上次观察快照中。', fields: [] };
      if (internal.control.type === 'password' || internal.control.region?.type === 'credential') {
        return { ok: false, code: 'PASSWORD_READBACK_BLOCKED', message: '拒绝读回密码或登录区域控件。', fields: [] };
      }
      refs.push(item.controlRef);
    }
    let response;
    try {
      response = await page.readback({ refs, expectedUrl: snapshot.pageUrl });
    } catch (error) {
      const failure = pageFailure(error, 'READBACK_FAILED');
      return { ok: false, code: failure.code, message: failure.message, fields: [] };
    }
    if (!response || response.ok !== true || !samePageUrl(response.url, snapshot.pageUrl)) {
      return {
        ok: false,
        code: response?.code || 'READBACK_FAILED',
        message: response?.message || '页面读回失败或网址变化。',
        fields: [],
      };
    }
    const byRef = new Map((response.fields || []).map((field) => [field.ref, field]));
    const fields = plan.items.map((item) => {
      const actual = byRef.get(item.controlRef);
      const control = internalControls.get(item.controlRef).control;
      return {
        fieldId: item.controlRef,
        controlId: item.controlRef,
        label: control.label,
        readbackValue: actual
          ? (control.type === 'select' ? String(actual.selectedLabel || '') : String(actual.value ?? ''))
          : null,
        readbackLength: actual && Number.isInteger(actual.length) ? actual.length : null,
      };
    });
    if (fields.some((field) => field.readbackValue === null)) {
      return { ok: false, code: 'READBACK_MISSING', message: '部分已批准控件没有实际读回值；按失败处理。', fields: [] };
    }
    return {
      ok: true,
      source: 'page_readback',
      url: snapshot.pageUrl,
      targetId: snapshot.targetId,
      snapshotId: snapshot.id,
      capturedAt: nowIso(now),
      fields,
      note: '只读上次批准计划中已注册控件的实际页面值；未接受 selector、脚本或任意 ref。',
    };
  }

  async function extractResearchSnapshot() {
    const g = guard();
    if (g) {
      return {
        status: 'blocked',
        code: g.code,
        message: g.message,
        jobs: [],
        sourceUrl: null,
        capturedAt: nowIso(now),
        issues: [{ code: g.code, message: g.message, severity: 'blocked' }],
        limitations: limitationsForResearch(),
      };
    }
    const info = await approvedInfo();
    if (!info.ok) {
      return {
        status: 'blocked',
        code: info.code,
        message: info.message,
        jobs: [],
        sourceUrl: info.pageUrl || null,
        capturedAt: nowIso(now),
        issues: [{ code: info.code, message: info.message, severity: 'blocked' }],
        limitations: limitationsForResearch(),
      };
    }
    if (info.loginHint && info.hasPasswordField) {
      return {
        status: 'blocked',
        code: 'LOGIN_REQUIRED',
        message: '当前页面可能需要本人登录；本层不读取或代填登录凭据。',
        jobs: [],
        sourceUrl: info.url,
        pageTitle: info.title,
        capturedAt: nowIso(now),
        issues: [{ code: 'LOGIN_REQUIRED', message: '当前页面可能需要本人登录；本层不读取或代填登录凭据。', severity: 'blocked' }],
        limitations: limitationsForResearch(),
      };
    }

    let raw;
    try {
      raw = await page.research({ maxJobs: 30, maxText: 4000 });
    } catch (error) {
      const failure = pageFailure(error, 'RESEARCH_FAILED');
      return {
        status: 'blocked',
        code: failure.code,
        message: failure.message,
        jobs: [],
        sourceUrl: info.url,
        pageTitle: info.title,
        capturedAt: nowIso(now),
        issues: [{ code: failure.code, message: failure.message, severity: 'blocked' }],
        limitations: limitationsForResearch(),
      };
    }
    if (!raw || raw.ok !== true || typeof raw.url !== 'string') {
      return {
        status: 'blocked',
        code: 'INVALID_RESEARCH_RESULT',
        message: '岗位页面读取结果无效。',
        jobs: [],
        sourceUrl: info.url,
        pageTitle: info.title,
        capturedAt: nowIso(now),
        issues: [{ code: 'INVALID_RESEARCH_RESULT', message: '岗位页面读取结果无效。', severity: 'blocked' }],
        limitations: limitationsForResearch(),
      };
    }
    if (!samePageUrl(raw.url, info.url)) {
      return {
        status: 'blocked',
        code: 'PAGE_CHANGED_DURING_RESEARCH',
        message: '读取岗位时页面发生变化，结果不完整。',
        jobs: [],
        sourceUrl: safeUrlLabel(raw.url),
        pageTitle: info.title,
        capturedAt: nowIso(now),
        issues: [{ code: 'PAGE_CHANGED_DURING_RESEARCH', message: '读取岗位时页面发生变化，结果不完整。', severity: 'blocked' }],
        limitations: limitationsForResearch(),
      };
    }

    let sourceUrl;
    try {
      sourceUrl = parseApprovedMokaUrl(raw.url).href;
    } catch {
      return {
        status: 'blocked',
        code: 'PAGE_NOT_APPROVED',
        message: '岗位页面已离开批准的 Moka 官方域名。',
        jobs: [],
        sourceUrl: safeUrlLabel(raw.url),
        pageTitle: info.title,
        capturedAt: nowIso(now),
        issues: [{ code: 'PAGE_NOT_APPROVED', message: '岗位页面已离开批准的 Moka 官方域名。', severity: 'blocked' }],
        limitations: limitationsForResearch(),
      };
    }

    const issues = [];
    if (Array.isArray(raw.issues)) {
      for (const issue of raw.issues) {
        if (!issue || typeof issue.code !== 'string' || !ALLOWED_RESEARCH_ISSUES.has(issue.code)) continue;
        issues.push({
          code: issue.code,
          message: issue.code === 'LOGIN_REQUIRED'
            ? '当前页面可能需要本人登录；本层不读取或代填登录凭据。'
            : issue.code === 'NO_RELIABLE_JOB_CARDS'
              ? '未发现可确认的官方岗位卡；不能据此判断没有合适职位。'
              : issue.code === 'JD_NOT_BOUND'
                ? '页面有职位描述文本，但无法确定对应岗位卡。'
                : '页面有职位描述文本，但没有可靠岗位卡。',
          severity: issue.code === 'LOGIN_REQUIRED' ? 'blocked' : 'warning',
        });
      }
    }

    const jobs = [];
    const seen = new Set();
    if (Array.isArray(raw.jobs)) {
      for (const job of raw.jobs) {
        if (jobs.length >= 30) break;
        if (!job || typeof job !== 'object') continue;
        if (typeof job.title !== 'string' || !job.title.trim()) continue;
        if (typeof job.jobId !== 'string' || !job.jobId.trim()) continue;
        let jobUrl;
        try {
          jobUrl = parseApprovedMokaUrl(job.url).href;
        } catch {
          issues.push({
            code: 'EXTERNAL_JOB_LINK_DROPPED',
            message: '岗位链接不在批准的 Moka 官方域名内，已丢弃。',
            severity: 'warning',
          });
          continue;
        }
        const key = `${job.jobId}|${jobUrl}`;
        if (seen.has(key)) continue;
        seen.add(key);
        jobs.push({
          jobId: job.jobId.slice(0, 120),
          title: job.title.trim().slice(0, 200),
          url: jobUrl,
          sourceUrl: jobUrl,
          city: typeof job.city === 'string' && job.city.trim() ? job.city.trim().slice(0, 60) : null,
          jd: typeof job.jd === 'string' && job.jd.trim() ? job.jd.slice(0, 8000) : null,
          visibleText: typeof job.visibleText === 'string' ? job.visibleText.slice(0, 2000) : null,
          source: 'moka-official-visible-page',
        });
      }
    }

    let status;
    let code = null;
    let message;
    if (raw.status === 'blocked') {
      status = 'blocked';
      code = raw.code === 'LOGIN_REQUIRED' ? 'LOGIN_REQUIRED' : 'RESEARCH_BLOCKED';
      message = '岗位检索受阻；这不是“没有合适职位”的证据。';
    } else if (!jobs.length) {
      status = 'incomplete';
      code = 'NO_RELIABLE_JOB_CARDS';
      message = '没有可靠岗位卡；结果不完整，不能据此记录没有符合职位。';
    } else {
      status = 'ok';
      message = '只读当前官方页面可见文本；岗位匹配与选择由上层和本人完成。';
    }

    return {
      status,
      code,
      message,
      jobs,
      sourceUrl,
      pageTitle: typeof raw.title === 'string' ? raw.title.slice(0, 300) : info.title,
      capturedAt: nowIso(now),
      issues,
      limitations: limitationsForResearch(),
    };
  }

  async function close() {
    if (closed) return { ok: true, closed: true, alreadyClosed: true };
    if (closing) return { ok: false, code: 'CLOSE_IN_PROGRESS', message: '正在关闭浏览器。' };
    closing = true;
    invalidateSnapshot();
    try {
      if (typeof closeImpl === 'function') await closeImpl();
      closed = true;
      return { ok: true, closed: true };
    } catch (error) {
      return {
        ok: false,
        code: 'CLOSE_FAILED',
        message: '浏览器关闭失败。',
        details: { reason: error?.message || null },
      };
    } finally {
      closing = false;
    }
  }

  return {
    targetId: page.targetId,
    observe,
    fillConfirmedPlan,
    readbackApprovedPlan,
    extractResearchSnapshot,
    invalidateSnapshot,
    close,
    getStatus() {
      return {
        status: closed ? 'closed' : 'open',
        targetId: page.targetId,
        snapshotId: snapshot?.id || null,
        lastPageUrl: lastPageUrl ? safeUrlLabel(lastPageUrl) : null,
      };
    },
  };
}

async function defaultOpenPage({
  projectDirectory,
  browser = 'auto',
  instanceId,
  headless,
  startupTimeoutMs,
  timeoutMs,
  navigationTimeoutMs,
  approvedUrl,
}) {
  let launched = null;
  try {
    launched = await launchBrowser({
      projectDirectory,
      browserPreference: browser,
      instanceId,
      headless,
      startupTimeoutMs,
    });
    const attached = await attachPage(launched.cdp, { timeoutMs });
    const navigation = await attached.page.navigate(approvedUrl, { navigationTimeoutMs });
    const info = await readInfoWithRetry(attached.page);
    let finalUrl;
    try {
      finalUrl = parseApprovedMokaUrl(info.url).href;
    } catch {
      throw new MokaPageError('NAVIGATION_OUTSIDE_MOKA', '最终页面不在批准的 Moka 官方域名内。', {
        pageUrl: safeUrlLabel(info.url),
      });
    }
    if (info.url === 'about:blank' || !finalUrl) {
      throw new MokaPageError('NAVIGATION_FAILED', '浏览器没有打开招聘页面。');
    }
    return {
      page: attached.page,
      targetId: attached.targetId,
      browser: launched.browser,
      profileDir: launched.profileDir,
      headless: launched.headless,
      warning: navigation.warning || null,
      close: () => launched.close(),
    };
  } catch (error) {
    if (launched) {
      try {
        await launched.close();
      } catch {
        // 忽略清理错误。
      }
    }
    throw error;
  }
}

function launchFailureResult(error) {
  if (error instanceof MokaPageError) {
    return {
      ok: false,
      code: error.code || 'PAGE_FAILED',
      message: error.message || '浏览器页面操作失败。',
      details: error.details || null,
    };
  }
  if (error?.name === 'BrowserLaunchError') {
    return {
      ok: false,
      code: error.code || 'BROWSER_LAUNCH_FAILED',
      message: error.message || '浏览器启动失败。',
      details: error.details || null,
    };
  }
  if (error instanceof MokaUrlError) {
    return { ok: false, code: error.code, message: error.message };
  }
  return {
    ok: false,
    code: 'BROWSER_OPEN_FAILED',
    message: '浏览器打开失败。',
    details: { reason: error?.message || null },
  };
}

/**
 * 生产工厂。创建时不启动任何进程；第一次 openCompany 才 spawn。
 * 生产始终使用 headful 独立窗口，不提供无头成功模式。
 * @param {object} options
 * @param {string} options.projectDirectory 项目根目录；profile 会落在其 .cache 下
 * @param {'auto'|'chrome'|'edge'} [options.browser]
 * @param {string} [options.instanceId]
 */
export function createMokaBrowserDriver(options = {}) {
  return createMokaBrowserDriverWithDeps({ ...options, headless: false }, {});
}

/**
 * 测试用注入入口（不导出到 index.js）。生产不得传入伪造 openPage。
 */
export function createMokaBrowserDriverWithDeps(options = {}, deps = {}) {
  const {
    projectDirectory,
    browser = 'auto',
    instanceId = 'moka',
    headless = false,
    startupTimeoutMs = 20000,
    timeoutMs = 15000,
    navigationTimeoutMs = 30000,
    now = () => new Date(),
  } = options;
  const openPage = deps.openPage || defaultOpenPage;

  let core = null;
  let session = null;
  let opening = null;
  let lastError = null;
  let operationTail = Promise.resolve();

  // 同一驱动实例的公开操作串行执行，避免观察、写入、导航、关闭互相穿插。
  function serialized(task) {
    const run = operationTail.then(task, task);
    operationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  function notOpenResult() {
    return {
      ok: false,
      code: 'NOT_OPEN',
      message: '尚未打开受控 Moka 浏览器窗口。',
      issues: [{ code: 'NOT_OPEN', message: '尚未打开受控 Moka 浏览器窗口。', severity: 'blocked' }],
    };
  }

  async function openCompany(rawUrl) {
    let approvedUrl;
    try {
      approvedUrl = parseApprovedMokaUrl(rawUrl).href;
    } catch (error) {
      return {
        ok: false,
        code: error instanceof MokaUrlError ? error.code : 'INVALID_URL',
        message: error instanceof MokaUrlError ? error.message : '只有批准的 Moka 官方 https 页面可以打开。',
      };
    }
    if (opening) {
      return { ok: false, code: 'OPEN_IN_PROGRESS', message: '浏览器正在打开，请稍候。' };
    }
    if (!core && !session && (typeof projectDirectory !== 'string' || !projectDirectory.trim())) {
      return { ok: false, code: 'INVALID_PROJECT_DIRECTORY', message: '缺少项目目录，不能创建受约束的浏览器 profile。' };
    }
    opening = (async () => {
      try {
        if (core && session) {
          core.invalidateSnapshot();
          let navigation;
          try {
            navigation = await session.page.navigate(approvedUrl, { navigationTimeoutMs });
          } catch (error) {
            lastError = launchFailureResult(error);
            return lastError;
          }
          let info;
          try {
            info = await readInfoWithRetry(session.page);
          } catch (error) {
            lastError = launchFailureResult(error);
            return lastError;
          }
          try {
            const finalUrl = parseApprovedMokaUrl(info.url).href;
            lastError = null;
            return {
              ok: true,
              pageUrl: finalUrl,
              targetId: session.targetId,
              browser: session.browser,
              profileDir: session.profileDir,
              headless: session.headless,
              warning: navigation.warning || null,
              note: openNote(session.headless),
            };
          } catch {
            lastError = {
              ok: false,
              code: 'NAVIGATION_OUTSIDE_MOKA',
              message: '最终页面不在批准的 Moka 官方域名内。',
              pageUrl: safeUrlLabel(info.url),
            };
            return lastError;
          }
        }

        let opened;
        try {
          opened = await openPage({
            projectDirectory,
            browser,
            instanceId,
            headless,
            startupTimeoutMs,
            timeoutMs,
            navigationTimeoutMs,
            approvedUrl,
          });
        } catch (error) {
          lastError = launchFailureResult(error);
          return lastError;
        }
        session = {
          page: opened.page,
          targetId: opened.targetId,
          browser: opened.browser,
          profileDir: opened.profileDir,
          headless: opened.headless,
          close: opened.close,
        };
        core = createMokaDriverCore({
          page: opened.page,
          now,
          closeImpl: opened.close,
        });
        let info;
        try {
          info = await readInfoWithRetry(opened.page);
        } catch (error) {
          lastError = launchFailureResult(error);
          await opened.close().catch(() => {});
          core = null;
          session = null;
          return lastError;
        }
        let finalUrl;
        try {
          finalUrl = parseApprovedMokaUrl(info.url).href;
        } catch {
          lastError = {
            ok: false,
            code: 'NAVIGATION_OUTSIDE_MOKA',
            message: '最终页面不在批准的 Moka 官方域名内。',
            pageUrl: safeUrlLabel(info.url),
          };
          await opened.close().catch(() => {});
          core = null;
          session = null;
          return lastError;
        }
        lastError = null;
        return {
          ok: true,
          pageUrl: finalUrl,
          targetId: opened.targetId,
          browser: opened.browser,
          profileDir: opened.profileDir,
          headless: opened.headless,
          warning: opened.warning || null,
          note: openNote(opened.headless),
        };
      } catch (error) {
        lastError = launchFailureResult(error);
        if (session) {
          if (typeof session.close === 'function') {
            await session.close().catch(() => {});
          }
          core = null;
          session = null;
        }
        return lastError;
      }
    })();
    try {
      return await opening;
    } finally {
      opening = null;
    }
  }

  async function observe(options = {}) {
    if (!core) return notOpenResult();
    return core.observe(options);
  }

  async function fillConfirmedPlan(plan, options = {}) {
    if (!core) return bindingFailure('NOT_OPEN', '尚未打开受控 Moka 浏览器窗口。');
    return core.fillConfirmedPlan(plan, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(typeof options.beforeWrite === 'function' ? { beforeWrite: options.beforeWrite } : {}),
    });
  }

  async function readbackApprovedPlan(plan) {
    if (!core) return { ok: false, code: 'NOT_OPEN', message: '尚未打开受控 Moka 浏览器窗口。', fields: [] };
    return core.readbackApprovedPlan(plan);
  }

  async function extractResearchSnapshot() {
    if (!core) {
      return {
        status: 'blocked',
        code: 'NOT_OPEN',
        message: '尚未打开受控 Moka 浏览器窗口。',
        jobs: [],
        sourceUrl: null,
        capturedAt: nowIso(now),
        issues: [{ code: 'NOT_OPEN', message: '尚未打开受控 Moka 浏览器窗口。', severity: 'blocked' }],
        limitations: limitationsForResearch(),
      };
    }
    return core.extractResearchSnapshot();
  }

  async function close() {
    if (opening) {
      try {
        await opening;
      } catch {
        // 打开失败时没有需要关闭的会话。
      }
    }
    if (!core && !session) {
      return { ok: true, closed: true, alreadyClosed: true };
    }
    const result = core ? await core.close() : { ok: true, closed: true };
    if (result.ok) {
      core = null;
      session = null;
    }
    return result;
  }

  function getStatus() {
    return {
      status: core ? 'open' : (opening ? 'opening' : 'idle'),
      closed: !core && !opening,
      browser: session?.browser || null,
      profileDir: session?.profileDir || null,
      headless: session?.headless ?? headless,
      lastError: lastError ? { code: lastError.code, message: lastError.message } : null,
      ...(core ? core.getStatus() : { snapshotId: null, lastPageUrl: null }),
      note: '受控 Moka 驱动只支持已批准的官方 https 页面；不代登录、不提交。',
    };
  }

  return {
    openCompany: (url) => serialized(() => openCompany(url)),
    observe: (options) => serialized(() => observe(options)),
    fillConfirmedPlan: (plan, options) => serialized(() => fillConfirmedPlan(plan, options)),
    readbackApprovedPlan: (plan) => serialized(() => readbackApprovedPlan(plan)),
    extractResearchSnapshot: () => serialized(() => extractResearchSnapshot()),
    close: () => serialized(() => close()),
    getStatus,
  };
}

export { MOKA_DRIVER_LIMITATIONS };
