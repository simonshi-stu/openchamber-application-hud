// 可供后续 OpenChamber 服务复用的公开入口。无网络、无框架、无数据库依赖。

export {
  WORKFLOW_VERSION,
  COMPANY_STATUS,
  POSITION_STATUS,
  QUEUE_STATUS,
  WorkflowError,
  canTransitionCompany,
  canTransitionPosition,
  isCompanyTerminal,
  isPositionTerminal,
  blocksResubmission,
} from './workflow.js';
export {
  RUNTIME_SCHEMA_VERSION,
  runtimeDocumentSchema,
  validateRuntimeDocument,
  createWorkbenchService,
} from './service.js';
export {
  PROJECT_ROOT,
  PRIVATE_ROOT,
  JsonFileStore,
  VersionConflictError,
  StoreError,
  assertPrivateDirectory,
  assertSafePrivatePaths,
} from './store.js';
export {
  PROFILE_SCHEMA_VERSION,
  FACT_SECTIONS,
  SENSITIVITY_LEVELS,
  createProfileStore,
  profileDocumentSchema,
  validateProfileDocument,
} from './profile-store.js';
export {
  canonicalLinkHint,
  companyIdentityKey,
  companyResultText,
  companyIsComplete,
  findApplicationDuplicate,
  normalizeBatch,
  normalizeCompanyName,
  normalizeOfficialId,
  selectedPositions,
} from './records.js';
export { ISSUE_TYPES, ISSUE_STATUSES, groupIssues, openBlockingIssues } from './issues.js';
export { TOOL_DEFINITIONS, ToolError, createToolRegistry, toolByName } from './tools.js';
export { ValidationError, validateSchema } from './validation.js';
export {
  APPLICATION_LEDGER_SCHEMA_VERSION,
  APPLICATION_BINDING_SCHEMA_VERSION,
  APPLICATION_LEDGER_STATUS,
  APPLICATION_LEDGER_EVIDENCE_KIND,
  applicationLedgerDocumentSchema,
  ApplicationLedgerError,
  applicationIdentity,
  createApplicationLedger,
  digestValue,
  validateApplicationLedgerDocument,
} from './application-ledger.js';
