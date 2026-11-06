// 受控填写计划的严格 schema。计划只能引用观察快照中的控件，不能携带
// selector、脚本、点击、提交或任意 URL；只允许绑定已确认事实的原文。

import {
  MokaUrlError,
  approvedMokaHref,
  normalizeNewlines,
} from './url-policy.js';

export const MOKA_FILL_PLAN_SCHEMA_VERSION = 'application-copilot.moka-fill-plan.v1';
export const MOKA_REGION_TYPES = Object.freeze(['basic', 'education', 'internship', 'work', 'project', 'unknown']);
export const MOKA_PLAN_TOP_KEYS = Object.freeze(['schemaVersion', 'snapshotId', 'pageUrl', 'targetId', 'items']);
export const MOKA_PLAN_ITEM_KEYS = Object.freeze([
  'controlRef', 'factId', 'factVersion', 'confirmed', 'confirmedVersion',
  'originalText', 'text', 'regionType', 'regionEntityId', 'expectedLabel',
  'fieldKey', 'optionValue', 'optionLabel',
]);
export const MOKA_FORBIDDEN_PLAN_KEYS = Object.freeze([
  'selector', 'xpath', 'script', 'javascript', 'js', 'eval', 'click', 'submit',
  'formSubmit', 'action', 'html', 'url', 'targetUrl', 'expression',
]);

const TOP_KEYS = new Set(MOKA_PLAN_TOP_KEYS);
const ITEM_KEYS = new Set(MOKA_PLAN_ITEM_KEYS);
const CONTROL_REF_RE = /^[A-Za-z0-9_-]{4,120}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const FIELD_KEY_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const MAX_TEXT_LENGTH = 20000;
const MAX_ITEMS = 50;

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function issue(code, message, path) {
  return { code, message, path, severity: 'blocked' };
}

function validString(value, { min = 1, max = 1000, pattern = null, allowNewlines = false } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) return false;
  if (!allowNewlines && /[\r\n]/.test(value)) return false;
  if (CONTROL_CHAR_RE.test(value)) return false;
  if (pattern && !pattern.test(value)) return false;
  return true;
}

function validText(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= MAX_TEXT_LENGTH
    && /\S/.test(value)
    && !CONTROL_CHAR_RE.test(value);
}

/**
 * 校验并规范化计划。绝不抛异常，返回 issues 供上层集中展示。
 * @returns {{ok: boolean, plan: object|null, issues: Array}}
 */
export function validateMokaFillPlan(rawPlan) {
  const issues = [];
  if (!isPlainRecord(rawPlan)) {
    return {
      ok: false,
      plan: null,
      issues: [issue('INVALID_PLAN', '填写计划必须是普通对象。', '$')],
    };
  }

  for (const key of Object.keys(rawPlan)) {
    if (!TOP_KEYS.has(key)) {
      issues.push(issue('UNKNOWN_PLAN_KEY', `计划包含不允许的字段：${key}`, `$.${key}`));
    }
  }
  if (rawPlan.schemaVersion !== MOKA_FILL_PLAN_SCHEMA_VERSION) {
    issues.push(issue('INVALID_PLAN_SCHEMA', `schemaVersion 必须是 ${MOKA_FILL_PLAN_SCHEMA_VERSION}。`, '$.schemaVersion'));
  }
  if (!validString(rawPlan.snapshotId, { min: 4, max: 120, pattern: ID_RE })) {
    issues.push(issue('INVALID_SNAPSHOT_ID', 'snapshotId 无效。', '$.snapshotId'));
  }
  if (!validString(rawPlan.targetId, { min: 1, max: 200, pattern: ID_RE })) {
    issues.push(issue('INVALID_TARGET_ID', 'targetId 无效。', '$.targetId'));
  }

  let canonicalPageUrl = null;
  try {
    canonicalPageUrl = approvedMokaHref(rawPlan.pageUrl);
  } catch (error) {
    const code = error instanceof MokaUrlError ? error.code : 'INVALID_PAGE_URL';
    issues.push(issue('INVALID_PAGE_URL', `计划 pageUrl 不是批准的 Moka 官方页面（${code}）。`, '$.pageUrl'));
  }

  if (!Array.isArray(rawPlan.items) || rawPlan.items.length < 1 || rawPlan.items.length > MAX_ITEMS) {
    issues.push(issue('INVALID_PLAN_ITEMS', `计划必须包含 1 到 ${MAX_ITEMS} 个填写项。`, '$.items'));
    return { ok: false, plan: null, issues };
  }

  const seenRefs = new Set();
  const items = [];
  rawPlan.items.forEach((rawItem, index) => {
    const path = `$.items[${index}]`;
    if (!isPlainRecord(rawItem)) {
      issues.push(issue('INVALID_PLAN_ITEM', '填写项必须是普通对象。', path));
      return;
    }
    for (const key of Object.keys(rawItem)) {
      if (!ITEM_KEYS.has(key)) {
        issues.push(issue('UNKNOWN_ITEM_KEY', `填写项包含不允许的字段：${key}`, `${path}.${key}`));
      }
    }

    if (!validString(rawItem.controlRef, { min: 4, max: 120, pattern: CONTROL_REF_RE })) {
      issues.push(issue('INVALID_CONTROL_REF', 'controlRef 无效。', `${path}.controlRef`));
    } else if (seenRefs.has(rawItem.controlRef)) {
      issues.push(issue('DUPLICATE_CONTROL_REF', `controlRef 重复：${rawItem.controlRef}`, `${path}.controlRef`));
    } else {
      seenRefs.add(rawItem.controlRef);
    }

    if (!validString(rawItem.factId, { min: 1, max: 200 })) {
      issues.push(issue('INVALID_FACT_ID', 'factId 无效。', `${path}.factId`));
    }
    const factVersionOk = Number.isInteger(rawItem.factVersion) && rawItem.factVersion >= 1 && rawItem.factVersion <= 1000000000;
    if (!factVersionOk) {
      issues.push(issue('INVALID_FACT_VERSION', 'factVersion 必须是正整数。', `${path}.factVersion`));
    }
    if (rawItem.confirmed !== true) {
      issues.push(issue('NOT_CONFIRMED', '填写项必须由服务端确认（confirmed: true）。', `${path}.confirmed`));
    }
    const confirmedVersionOk = Number.isInteger(rawItem.confirmedVersion)
      && rawItem.confirmedVersion >= 1
      && rawItem.confirmedVersion <= 1000000000;
    if (!confirmedVersionOk) {
      issues.push(issue('INVALID_CONFIRMED_VERSION', 'confirmedVersion 必须是正整数。', `${path}.confirmedVersion`));
    } else if (factVersionOk && rawItem.confirmedVersion !== rawItem.factVersion) {
      issues.push(issue('STALE_CONFIRMATION', '确认版本与当前事实版本不一致，需要重新确认。', `${path}.confirmedVersion`));
    }

    if (!validText(rawItem.originalText)) {
      issues.push(issue('INVALID_ORIGINAL_TEXT', 'originalText 为空、过长或包含不允许的控制字符。', `${path}.originalText`));
    }
    if (!validText(rawItem.text)) {
      issues.push(issue('INVALID_TEXT', 'text 为空、过长或包含不允许的控制字符。', `${path}.text`));
    }
    if (validText(rawItem.originalText) && validText(rawItem.text)) {
      const normalized = normalizeNewlines(rawItem.originalText);
      if (normalized !== rawItem.text) {
        issues.push(issue(
          'TEXT_NOT_ORIGINAL',
          'text 必须等于原文仅做 CRLF/CR→LF 归一后的结果；不得润色、截断或重排。',
          `${path}.text`,
        ));
      }
    }

    if (!MOKA_REGION_TYPES.includes(rawItem.regionType)) {
      issues.push(issue('INVALID_REGION_TYPE', 'regionType 无效。', `${path}.regionType`));
    }
    const hasEntity = rawItem.regionEntityId !== null && rawItem.regionEntityId !== undefined;
    if (hasEntity && !validString(rawItem.regionEntityId, { min: 1, max: 200 })) {
      issues.push(issue('INVALID_REGION_ENTITY', 'regionEntityId 无效。', `${path}.regionEntityId`));
    }
    if ((rawItem.regionType === 'basic' || rawItem.regionType === 'unknown') && hasEntity) {
      issues.push(issue('REGION_ENTITY_NOT_ALLOWED', '基本信息/未知区域不能绑定经历 entityId。', `${path}.regionEntityId`));
    }
    if (rawItem.expectedLabel !== undefined && rawItem.expectedLabel !== null
      && !validString(rawItem.expectedLabel, { min: 0, max: 200 })) {
      issues.push(issue('INVALID_EXPECTED_LABEL', 'expectedLabel 无效。', `${path}.expectedLabel`));
    }
    if (rawItem.fieldKey !== undefined && !validString(rawItem.fieldKey, { min: 1, max: 120, pattern: FIELD_KEY_RE })) {
      issues.push(issue('INVALID_FIELD_KEY', 'fieldKey 无效。', `${path}.fieldKey`));
    }

    // The canonical form returned below uses null for non-select options. Treat
    // that form as absent when the plan is validated again by the driver.
    const hasOptionValue = rawItem.optionValue !== undefined && rawItem.optionValue !== null;
    const hasOptionLabel = rawItem.optionLabel !== undefined && rawItem.optionLabel !== null;
    if (hasOptionValue !== hasOptionLabel) {
      issues.push(issue('INCOMPLETE_OPTION', 'optionValue 与 optionLabel 必须同时提供。', `${path}.optionValue`));
    }
    if (hasOptionValue && !validString(rawItem.optionValue, { min: 0, max: 200 })) {
      issues.push(issue('INVALID_OPTION_VALUE', 'optionValue 无效。', `${path}.optionValue`));
    }
    if (hasOptionLabel && !validString(rawItem.optionLabel, { min: 1, max: 200 })) {
      issues.push(issue('INVALID_OPTION_LABEL', 'optionLabel 无效。', `${path}.optionLabel`));
    }

    items.push({
      controlRef: rawItem.controlRef,
      factId: rawItem.factId,
      factVersion: rawItem.factVersion,
      confirmed: rawItem.confirmed === true,
      confirmedVersion: rawItem.confirmedVersion,
      originalText: rawItem.originalText,
      text: rawItem.text,
      regionType: rawItem.regionType,
      regionEntityId: hasEntity ? rawItem.regionEntityId : null,
      expectedLabel: rawItem.expectedLabel === undefined ? null : rawItem.expectedLabel,
      fieldKey: rawItem.fieldKey === undefined ? null : rawItem.fieldKey,
      optionValue: hasOptionValue ? rawItem.optionValue : null,
      optionLabel: hasOptionLabel ? rawItem.optionLabel : null,
    });
  });

  if (issues.length) {
    return { ok: false, plan: null, issues };
  }

  return {
    ok: true,
    plan: {
      schemaVersion: MOKA_FILL_PLAN_SCHEMA_VERSION,
      snapshotId: rawPlan.snapshotId,
      pageUrl: canonicalPageUrl,
      targetId: rawPlan.targetId,
      items,
    },
    issues: [],
  };
}

export function normalizePlanText(text) {
  return normalizeNewlines(text);
}
