# OpenChamber Application HUD

Windows 独立 HUD 与 OpenChamber 扩展桥接器，用于控制 Application Copilot 的本地申请队列。**独立 Windows HUD 是主界面；OpenChamber 负责会话交互和消息转发。**

[中文](README.md) · [English](README.en.md)

## 项目定位

- **Windows HUD**：使用 `mshta.exe` 和仅监听 `127.0.0.1` 的本地服务，显示队列进度、当前公司，并支持开始、暂停、恢复和优先级调整。OpenChamber 可以保持最小化。
- **OpenChamber 扩展**：提供任务池面板和可关闭的 HUD 对话窗口。独立 HUD 的消息进入项目私有队列后，由扩展 HUD 转发到明确指定的既有会话。
- **会话交互**：扩展使用 OpenChamber SDK 的 `host.openSession()` 和 `host.prompt({ send: true })`，只打开和发送到已有会话，不创建新会话。
- **底层工作流**：本地状态机、公司顺序队列、岗位记录、问题队列和已确认原文复用由 Application Copilot 提供。

本项目的原生宿主是 **OpenChamber**，不是原生 OpenCode 插件，也不是通用 Harness 插件。OpenCode 等客户端只能通过明确配置的本地 MCP 或适配器复用有限的资料整理工具。

## 不做什么

- 不代登录、不代填验证码、不代点击最终提交。
- 不承诺任意招聘网站的完整自动投递；真实网站和真实模型供应商仍需单独验证。
- 独立 HUD 不能直接访问 OpenChamber 的 `host` 桥接。要把消息送入会话，必须保持 OpenChamber 的插件 HUD 打开；HUD 关闭时消息只会排队，不会丢失。

## 入口

| 入口 | 用途 |
|---|---|
| Windows 独立 HUD | 主界面：独立查看和控制本地队列 |
| OpenChamber 扩展 | 任务池、会话 HUD、目标会话切换和消息桥接 |
| 原有网页工作台 | 简历资料整理、段落确认和手动复制；不是完整 HUD |
| 本地 MCP | 向 OpenCode 或其他 MCP 客户端提供无状态资料整理函数 |

## 快速开始

### 1. Windows 独立 HUD

要求 Node.js 22+。在仓库根目录运行：

```powershell
npm ci
npm run standalone:hud
```

也可以双击 `start-standalone-hud.cmd`。指定项目和目标 OpenChamber 会话：

```powershell
npm run standalone:hud -- --project E:\path\to\project --session ses_...
```

`--session` 只绑定消息目标，不创建会话。窗口关闭后本地辅助服务停止。

### 2. 安装 OpenChamber 扩展

插件面向 OpenChamber **2.3.2 或更新版本**：

1. 运行 `npm run package:openchamber`，或下载 [Latest Release](https://github.com/simonshi-stu/openchamber-application-hud/releases/latest) 中的 ZIP。
2. 在 OpenChamber 的“设置 → Extensions”添加 ZIP 或仓库根目录。
3. 审核并批准 `prompt`、`sessions` 和本地服务权限。
4. 打开“投递任务池”。需要会话 HUD 时，在当前会话的“会话操作”菜单中选择“投递 HUD”。

`sessions` 权限只用于独立 HUD 指定目标会话时打开该既有会话；不会创建新会话。关闭 HUD 不会关闭会话。

### 3. 从源码构建

```powershell
npm ci
npm test
npm run package:openchamber
npm run check:publication
```

ZIP 只作为 GitHub Release 附件发布，不把 `private/`、`artifacts/` 或运行数据提交到仓库。

## 当前状态

| 能力 | 状态 |
|---|---|
| 独立 Windows HUD | 已实现：队列进度、当前公司、开始／暂停／恢复、优先级和消息队列 |
| OpenChamber 交互 | 已实现：SDK 2.3.2 面板、服务、会话 HUD、目标会话切换和消息转发 |
| 本地状态与队列 | 已实现：固定状态机、暂停恢复、顺序推进和持久化记录 |
| 真实招聘网站 | 未完成完整闭环；登录、验证码和最终提交始终由本人操作 |

最近的虚构联调已验证：独立 HUD 消息可投递到指定 OpenChamber 会话、目标会话收到回复、桥接 inbox 在成功发送后确认消费。虚构测试不代表真实求职网站流程通过。

## 数据与隐私边界

- 会话 ID、API Key、姓名、简历、家庭信息、项目正文、附件、投递记录、截图、日志和浏览器缓存不上传 GitHub。
- 正式资料和运行记录放在当前项目的 `private/` 明确子目录；这些内容被 Git 忽略并不等于可以发布。
- 测试只使用虚构资料和 `example.invalid` 地址；发布前还会检查暂存文件名、暂存内容、包白名单和敏感模式。
- 云模型外发与 GitHub 发布是两项独立授权；不上传 GitHub 不等于不会向已授权的模型提供商发送必要资料。

## 其他文档

- [OpenChamber 使用方式](docs/OPENCHAMBER.md)
- [架构与集成边界](docs/ARCHITECTURE.md)
- [部署与在线演示](docs/DEPLOY.md)
- [使用声明](docs/USAGE.md)
- [可选 MCP](docs/MCP.md)

原有静态网页工作台：[在线预览](https://simonshi-stu.github.io/openchamber-application-hud/)。它不包含 OpenChamber 面板、本地服务或招聘网站自动化能力。

## HUD06：本地申请结果台账（U36）

HUD06 是接在 HUD05 可见准备流程之后的本地、合成、loopback 台账层。它记录“准备是否完成”和“本人报告了什么”，不把本地记录扩写成真实网投成功。当前阶段只使用虚构材料、虚构岗位和 `127.0.0.1`；不读取真实简历，不登录招聘网站，不上传附件，不调用模型，不点击最终提交。

### 能力与边界

- **真实个人准备问题**：产品可以引用本人已经确认的材料段落、字段版本、适用岗位和字段计划；HUD06 只把这些绑定保存为版本、ID 和 digest，不把未确认草稿当成可复用事实。真实个人资料仍应由本人在本地确认，不能用本地准备状态替代本人审核。
- **申请级防重**：申请身份由规范化公司身份（公司名＋批次）和官方岗位 ID 生成稳定 ID；不同公司、不同批次或不同岗位不会被静默合并。材料或计划变更保留历史并要求重新确认。
- **最终人工边界**：登录、验证码、附件上传和最终提交始终由本人执行。HUD06 页面没有这些入口，也不撤回、删除或重复申请。
- **结果证据边界**：页面和台账不会把“模型无报错”“本地写入完成”或“本人说已投”写成官网成功。

状态语义如下：

| 状态 | 含义 | 允许的结论 |
|---|---|---|
| `prepared_waiting_human_submit` | 合成页面实际写入、实际读回和 review 通过，等待本人登录、审核和提交 | 只能说“准备完成／待本人提交”，没有官网回执 |
| `submitted_reported` | 本人明确报告后的本地记录 | 只能说“本人报告已提交（本地记录）”，不代表网站动作或官方回执 |
| `official_verified` | 本人确认的结构化证据记录，带可信观测、ack、来源和当前版本字段 | 记录为本地核验状态；当前不是独立连接器自动认证第三方官网 |
| `unknown` | 证据缺失、ack 缺失或结果不确定 | 保留未知并阻断自动升级、重新准备和重投路径；台账损坏另以 `storage: corrupt`／错误暴露，不伪造状态 |

`official_verified` 的当前实现要求本人提交结构化的 `sourceUrl`、`ackId`、`evidenceText`、`sourceVersion`、`acknowledged: true` 和 `trustedOfficialObservation: true`，并通过动作层的 `confirmedByUser: true`；写入台账后保存证据 digest。`synthetic: true` 的合成证据只能用于测试，不能写成真实官网 ack。本人报告、无 ack 或 unknown 均不能自动升级为 `official_verified`。

### 架构与业务流程

```text
OpenChamber HUD / HUD06 loopback page
        │ 只通过本地受控 HTTP 会话读取状态、提交本人确认动作
        ▼
HUD05 可见准备流程
  材料确认 → 岗位选择 → 字段计划 → 本人确认 → synthetic page 写入/读回/review
        │ reviewPassed=true；保存材料/计划版本、ID、digest
        ▼
本地 JSON 申请台账（JsonFileStore 原子写入 + revision 冲突保护）
        ├─ prepared_waiting_human_submit
        ├─ 本人报告 → submitted_reported（仍无官方回执）
        ├─ 不确定/无 ack → unknown（保留阻断）
        └─ 本人提供结构化可信证据 → official_verified（不是自动官网连接器）

本人登录／验证码／附件上传／最终提交
        └─ 永远在本地试用范围之外，由本人自行完成
```

台账与业务对象的关系是：

```text
company identity (name + batch)
        + official position id
        └─ applicationId / applicationKey
             ├─ material binding: fact ids + versions + digest
             ├─ plan binding: plan/snapshot/target + field ids + digest
             ├─ preparation evidence: write/readback/review summary
             ├─ submissionReport: local human report, optional
             ├─ verification: structured evidence, optional
             └─ history/events: append-only transitions and idempotency keys
```

### JSON 原子文件数据模型

运行数据是 `private/` 明确子目录中的 JSON 文件，由 `JsonFileStore` 做目录安全检查、schema 校验、revision 版本控制和临时文件替换；不是 SQL 数据库，也不应按 SQL 表来理解。HUD06 的逻辑文档形状如下，内容为脱敏示例：

```json
{
  "schemaVersion": "application-copilot.application-ledger.v1",
  "applications": [
    {
      "applicationId": "application_fixture-digest",
      "applicationKey": "fixture-company\u0000fixture-batch\u0000fixture-job-1",
      "companyIdentityKey": "fixture-company\u0000fixture-batch",
      "companyId": "fixture-company-id",
      "companyBatch": "fixture-batch",
      "positionId": "fixture-position-id",
      "officialId": "FIXTURE-JOB-1",
      "status": "prepared_waiting_human_submit",
      "preparedAt": "2026-11-03T00:00:00.000Z",
      "preparation": {
        "preparedAt": "2026-11-03T00:00:00.000Z",
        "material": {
          "candidateId": "fixture-candidate",
          "sourceName": "fixture-resume.txt",
          "sourceParagraphIds": ["fixture-paragraph-1"],
          "profileRevision": 3,
          "coreRevision": 8,
          "facts": [{ "id": "fixture-fact-1", "section": "project_content", "version": 2, "confirmedVersion": 2 }],
          "digest": "0000000000000000000000000000000000000000000000000000000000000000"
        },
        "plan": {
          "planId": "fixture-plan-1",
          "snapshotId": "fixture-snapshot-1",
          "targetId": "fixture-position-id",
          "profileVersion": 3,
          "coreRevision": 8,
          "items": [{ "controlRef": "fixture-control-1", "factId": "fixture-fact-1", "fieldKey": "project_content", "factVersion": 2, "confirmedVersion": 2 }],
          "digest": "0000000000000000000000000000000000000000000000000000000000000000"
        },
        "sourceVersion": "material:3|plan:fixture-plan-1",
        "bindingDigest": "0000000000000000000000000000000000000000000000000000000000000000",
        "reviewPassed": true,
        "readbackFields": 1,
        "writeCount": 1,
        "diffCount": 0
      },
      "currentBinding": {
        "schemaVersion": "application-copilot.application-binding.v1",
        "applicationId": "application_fixture-digest",
        "applicationKey": "fixture-company\u0000fixture-batch\u0000fixture-job-1",
        "companyId": "fixture-company-id",
        "positionId": "fixture-position-id",
        "officialId": "FIXTURE-JOB-1",
        "materialDigest": "0000000000000000000000000000000000000000000000000000000000000000",
        "planDigest": "0000000000000000000000000000000000000000000000000000000000000000",
        "sourceVersion": "material:3|plan:fixture-plan-1",
        "profileRevision": 3,
        "coreRevision": 8
      },
      "submissionReport": null,
      "verification": null,
      "lastEvidence": {
        "kind": "preparation",
        "source": "hud05_readback",
        "observedAt": "2026-11-03T00:00:00.000Z",
        "sourceVersion": "material:3|plan:fixture-plan-1",
        "acknowledged": false,
        "trustedOfficialObservation": false,
        "blockReason": "等待本人登录、审核并提交。",
        "evidenceDigest": "0000000000000000000000000000000000000000000000000000000000000000",
        "eventId": "prepared:fixture"
      },
      "history": [],
      "createdAt": "2026-11-03T00:00:00.000Z",
      "updatedAt": "2026-11-03T00:00:00.000Z"
    }
  ],
  "events": []
}
```

完整 schema 以代码为准；台账不保存完整材料正文或完整官网页面。`events` 保存事件 ID 和 digest，用于幂等及防止同一事件 ID 携带不同关键参数。

### 代码导航与关键入口

- [`core/application-ledger.js`](core/application-ledger.js)：状态常量、稳定申请身份、schema、材料／计划 binding、本人报告、unknown、结构化官方证据、幂等和台账快照。
- [`core/store.js`](core/store.js)：`private/` 范围检查、JSON schema、revision 冲突和原子文件写入。
- [`integrations/openchamber/service/hud-06-local-ledger.js`](integrations/openchamber/service/hud-06-local-ledger.js)：HUD05 session 复用、HUD06 loopback HTTP 服务、CSRF／Origin／host 边界和台账动作。
- [`integrations/openchamber/trial/hud-06/index.html`](integrations/openchamber/trial/hud-06/index.html)、[`ledger.js`](integrations/openchamber/trial/hud-06/ledger.js)：只展示合成准备证据、台账状态、历史和本人报告控件。
- [`scripts/hud-06-local-ledger.mjs`](scripts/hud-06-local-ledger.mjs)：交互服务与真实新进程重启检查；不会访问真实招聘站。
- [`integrations/openchamber/service/hud-06-local-ledger.test.js`](integrations/openchamber/service/hud-06-local-ledger.test.js)：稳定 ID、批次隔离、幂等、版本冲突、损坏保护、证据门控和 HTTP 页面回归。

关键动作示例：

```js
await ledger.ensurePrepared({
  companyName: '虚构公司', batch: '虚构批次', officialId: 'FIXTURE-JOB-1',
  materialBinding, planBinding, reviewPassed: true
});

await ledger.recordUserSubmission({
  applicationId, binding, expectedRevision, eventId: 'fixture-report-1',
  sourceVersion: binding.sourceVersion
});
```

以上示例只说明本地结构化接口；它不会替本人登录或提交，也不会产生真实官网回执。

### 合成 CLI 与测试

要求 Node.js 22+，在仓库根目录运行：

```powershell
# 启动仅监听 127.0.0.1 的 HUD06 合成页面；终端会打印一次性 URL
npm run trial:hud-06

# 自动完成虚构准备，启动两个真实 Node 子进程，验证重启、防重和重放阻断
npm run trial:hud-06 -- --check

# HUD05/HUD06 定向回归
node --test integrations/openchamber/service/hud-05-interactive.test.js integrations/openchamber/service/hud-06-local-ledger.test.js

# 全部回归与公开内容检查
npm test
npm run check:publication
```

预期的 `--check` 关键结果是：

```text
statusBeforeReport=prepared_waiting_human_submit
statusAfterReport=submitted_reported
statusAfterRestart=submitted_reported
duplicateReport=true
replayBlockedBeforeRestart=true
replayBlockedAfterRestart=true
externalNetworkCalls=0
```

这些是虚构 loopback 检查结果，不是实际网投结果。`npm test` 中需要真实 Chrome 的测试和当前 Windows 无法创建符号链接的测试可能按环境跳过；跳过不应被改写成通过。

### 来源、许可与未实现

- 本项目代码和通用文档按 [`LICENSE`](LICENSE) 的 MIT 许可发布；第三方声明见 [`THIRD_PARTY_NOTICES`](THIRD_PARTY_NOTICES)。
- Tabler 仅作为界面布局参考，HUD06 未引入远程 CSS、远程字体或运行时 CDN；OpenChamber SDK 版本由 `package.json` 固定。
- 未实现或未在本阶段承诺：任意招聘网站兼容、真实网站自动投递、登录／验证码代理、附件上传、最终提交、官网独立认证连接器、后台无人值守重投、云端资料库、真实模型调用和真实个人资料外发。
- 本节只链接公开代码、架构和许可文件；不链接 `private/`、`artifacts/`、协调日志、浏览器截图、个人资料或本地绝对路径。演示内容均为虚构且链接使用相对仓库路径或 `example.invalid`。

## License

MIT
