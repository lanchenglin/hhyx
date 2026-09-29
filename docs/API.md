# API与实现导航

> **v1.2.0更新：** 已加入系统管理员后台、归档/回收站、用户权限与网页AI配置。以下早期版本内容需结合 `ADMINISTRATION.md` 阅读；升级必须应用0003，不能只替换前端。旧密码保留，管理员不能代签，已发生业务不物理删除。

所有业务API在 `/api/`。同源cookie认证，写请求必须有正确 `Origin`；登录后写请求还要 `X-CSRF-Token`。项目变更提交 `X-Idempotency-Key`（12–100位英文数字、下划线或连字符），推荐UUID。前端已处理这些字段，不需要用户手工发送。

## 身份与项目

| 方法/路径 | 用途 |
|---|---|
| GET /api/health | 版本与路由存活检查，不证明所有绑定健康 |
| GET /api/auth/status | 检查初始化标记，验证D1可查询 |
| POST /api/auth/bootstrap | 首次初始化，token/email/name/password |
| POST /api/auth/login | email/password |
| GET /api/invite?token=… | 有效邀请的项目/邮箱/到期信息 |
| POST /api/auth/accept | 邀请token、name、password；已有账号使用其原密码 |
| GET /api/auth/me | 当前用户与CSRF |
| POST /api/auth/reauth | 重要操作短时重验密码 |
| POST /api/auth/password | 重验后更新密码，并撤销其他会话 |
| POST /api/auth/logout | 撤销当前会话 |
| POST /api/profile | 本人phone、smsOptIn |
| GET /api/projects | 本人有效项目摘要 |
| POST /api/projects | 创建新合作项目 |
| GET /api/projects/:pid | 项目可见状态与revision |

## 统一业务操作

```http
POST /api/projects/:pid/actions
Content-Type: application/json
X-CSRF-Token: 当前会话值
X-Idempotency-Key: 本次操作唯一UUID
Origin: 当前站点来源
```

```json
{
  "type": "purchase.vote",
  "data": {
    "id": "真实采购ID",
    "version": 1,
    "decision": "approve",
    "note": "已核对报价、用途和资金影响，同意当前版本"
  }
}
```

金额字段 `amountCents`、`unitCents`、`budgetCents` 等均为整数分；比例 `shareBps` 为万分比。不得把元的小数直接传给这些字段。

可用业务type：

```text
plan.update
member.add / member.remove
proposal.submit / proposal.vote / proposal.cancel
project.pause
task.add / task.progress / task.accept
purchase.save / purchase.submit / purchase.read / purchase.vote
purchase.comment / purchase.cancel / purchase.order / purchase.pay / purchase.receive
ledger.add / ledger.verify / ledger.reverse
settlement.pay
```

proposal支持：ai_policy（仅专用AI接口建立）、baseline、budget、stage_open、stage_close、member_add、member_remove、profit_rule、terms、resume、task_change、settlement、reconcile。字段和限制以 `src/domain.js` 的相应case为准；前端 `public/app.js` 提供完整调用实现，`tests/helpers.mjs` 提供三用户示例。

`member.join`、`attachment.add`、`channel.update`、`invite.create` 是经过专用接口验证后调用的内部type，普通actions接口明确拒绝，不能自行伪造。

重要操作返回 `REAUTH_REQUIRED` 时，先完成 `/auth/reauth`，再以**原来那一个幂等键和原内容**重试。409发生版本/预算冲突后应刷新，让用户重新决定，不自动替用户改采购内容。

响应为最新项目可见状态和revision。参与最后一票完成自己退出的成员返回 `removedFromProject:true`，前端退出该项目视图。HTTP成功只是系统记录/批准成功，不是实际资金转移成功。

## 附件、记录和通知

| 方法/路径 | 用途 |
|---|---|
| POST /api/projects/:pid/invites | memberId，生成7天邀请链接 |
| POST /api/projects/:pid/files | multipart字段file，私有上传 |
| GET /api/projects/:pid/files/:id | 当前成员鉴权下载 |
| GET /api/projects/:pid/audit?after=0&limit=100 | 审计分页，使用nextAfter继续 |
| GET /api/projects/:pid/audit/verify | 检查当前审计链 |
| GET /api/projects/:pid/export | 项目与审计JSON，附件仅目录 |
| GET /api/projects/:pid/ledger.csv | 内部账目CSV |
| GET /api/notifications | 本人有效项目通知 |
| POST /api/notifications/:id/read | 通知已阅，不产生采购批准 |
| GET /api/projects/:pid/channels | 配置状态、最近100条投递状态及服务商回执号 |
| POST /api/projects/:pid/channels | 创建人重验后设置enabled/webhook |
| POST /api/projects/:pid/channels/test | 显式发送一次真实企业微信测试消息 |
| POST /api/projects/:pid/channels/retry | 重验后按id重试；uncertain需确认可能重复 |

## 状态机

采购：draft → pending → approved → ordered → received。pending可rejected或要求补充；未执行可cancelled；关键内容改变归档旧版本并回到draft。收到货不自动表明已经全部付款。

任务：todo → doing/blocked → review → done；不同验收人可以退回doing。

共同决策：pending → approved/rejected/cancelled；只有最后一个有效必签人的同意才能使决策生效。

## 开发文件

`src/domain.js`业务约束；`store.js`事务/CAS/审计；`auth.js`会话；`notifications.js`投递；`index.js`路由/私有附件/安全头。`scripts/local-runtime.mjs`只是本地适配，不引入Worker生产入口。`migrations/0001_initial.sql`是首版数据库迁移。

## AI分析接口（v1.1）

所有路径前缀均为 `/api/projects/:pid`，沿用项目鉴权、同源/CSRF和幂等键规则。读取报告允许本项目全部有效成员；手动分析、授权提案、风险处置和建任务仅允许合伙人。重要写入需短时重新验证密码。

| 方法/路径 | 输入与输出 |
|---|---|
| GET /ai?offset=0 | 模型公开配置（无Key）、项目授权、UTC月额度、50条分页历史/过期状态 |
| POST /ai/preview | `{kind:"project"或"purchase"或"stage", targetId}`；返回真实脱敏body、hash、本地规则和预占调用次数，不发送模型 |
| POST /ai/policy | `{engineFingerprint, confirmScope:true, monthlyCallLimit, purchaseThresholdCents, reportStyle, autoPurchase, autoStage}`；建立全员提案 |
| POST /ai/runs | `{kind,targetId,previewHash,confirmSend:true}`；返回202排队或200复用及id；失败同输入重试须额外 `retry:true,acceptPossibleCharge:true` |
| GET /ai/runs/:id | 冻结快照、报告、来源、模型配置、尝试用量、处置记录与关联任务 |
| GET /ai/runs/:id/export | 同上JSON附件，不含服务端密钥 |
| POST /ai/runs/:id/reviews | `{findingId,disposition:"supplement"或"mitigate"或"accept_risk",note}`；追加记录，不改报告或采购批准 |
| POST /ai/runs/:id/tasks | `{index,confirm:true,title,description,deliverable,stageId,assigneeId,reviewerId,dueDate}`；人工确认后使用原task.add规则，旧报告还须confirmStale:true |

统一actions新增 `ai.materials`（六个业务说明字段和最多三行scenarios）、`ai.suspend`（停止新发送）。`ai.run.request`、`ai.run.finish`、`ai.review` 为内部验证动作，不能直接调用。`task.add` 的aiSource不可由普通actions伪造。

AI任务状态：queued → running → completed/failed/uncertain；发送前授权或资料变化可cancelled。租约中断只标不确定，不自动重发。业务层/AI供应商没有删除历史报告的接口。

403为项目/角色不符；409为预览/授权过期、幂等冲突或重试缺确认；429为调用数/并发/速率限制；503为服务端模型未配置。错误不是风险分析结论。

项目 `/export` 更新为schemaVersion 2，附 `aiManifest`（id/hash/详情链接）而不是内嵌所有AI输入。批量完整备份仍需D1导出，并另存R2。`src/ai-policy.js`授权配置，`ai-snapshot.js`脱敏和本地计算，`ai-provider.js`协议/报告校验，`ai.js`队列/API，`public/ai-ui.js`界面。初次和升级均须应用 `0002_ai_analysis.sql`。

## 系统管理（v1.2.0）

所有 `/api/admin/*` 要求当前账号有效且 `system_role=admin`，临时密码必须先修改。POST还要求Origin、CSRF、本人近期验证及幂等键。

| 接口 | 用途 |
|---|---|
| GET /api/admin/overview | 计数和绑定诊断 |
| GET /api/admin/users?q=&offset= | 搜索/分页用户 |
| POST /api/admin/users | 新建：name/username/email/systemRole/canCreateProjects/temporaryPassword/reason |
| GET /api/admin/users/:id | 用户资料、所属项目、authVersion（无密码） |
| POST /api/admin/users/:id | 修改资料/系统角色/disabled/canCreateProjects；expectedVersion、reason及必要影响确认 |
| POST /api/admin/users/:id/reset-password | 其他用户临时密码重置；expectedVersion、temporaryPassword、reason |
| POST /api/admin/users/:id/revoke-sessions | 撤销登录；expectedVersion、reason |
| GET /api/admin/projects?lifecycle=active\|archived\|trashed\|all&q=&offset= | 全站项目分页 |
| GET /api/admin/projects/:id | 只读审阅（记录访问日志） |
| GET /api/admin/projects/:id/export | 业务JSON/审计/AI索引（不等于完整备份） |
| GET /api/admin/projects/:id/files/:fileId | 项目附件只读下载；校验文件属于该项目 |
| GET /api/admin/projects/:id/ai/:runId | 只读AI报告及该次快照 |
| POST /api/admin/projects/:id/lifecycle | action=archive/unarchive/trash/restore，expectedRevision、confirmName、confirmImpact、reason |
| POST /api/admin/projects/:id/members | memberId/role/expectedRevision/reason；正式项目生成全员提议 |
| GET /api/admin/ai-settings | 无Key明文的配置视图和revision |
| POST /api/admin/ai-settings | enabled/provider/baseUrl/model/key或clearKey/expectedRevision/reason，可选analysisGuidance；第三方需要confirmExternalHost |
| POST /api/admin/ai-settings/test | expectedRevision、confirmCost=true；可能计费、限流、无项目数据 |
| GET /api/admin/audit?before=&action= | 管理日志分页、按动作筛选 |

普通登录支持原email字段中填写邮箱或用户名，也支持login字段。`/api/auth/me`增加username/systemRole/disabled/canCreateProjects/mustChangePassword。密码接口保留，修改后撤销其他会话并轮换权限版本。归档写请求409、回收站普通项目访问410、普通账号后台访问403。

## v1.3 第二因素、运维与交接

所有写操作继续要求当前有效会话、Origin/CSRF、幂等键和相应权限。第二因素待验证会话不能调用业务接口。管理员写操作仍验证密码，已绑定MFA的高风险操作还须近期第二因素。新增数据库迁移0004。

| 路径 | 方法 | 作用 |
|---|---|---|
| `/api/auth/mfa/status` | GET | 本人绑定、验证、近期验证、恢复码剩余状态 |
| `/api/auth/mfa/enroll` | POST | 当前会话创建10分钟待绑定密钥，需验证密码 |
| `/api/auth/mfa/confirm` | POST | `{code}`；验证绑定，返回一次性恢复码 |
| `/api/auth/mfa/verify` | POST | `{code}`；TOTP或恢复码，轮换会话与CSRF |
| `/api/auth/mfa/recovery-codes` | POST | 验证后重新生成，旧码作废 |
| `/api/auth/mfa/disable` | POST | 本人关闭，受管理员强制策略限制 |
| `/api/admin/security` | GET | 管理员策略与绑定列表 |
| `/api/admin/security/policy` | POST | `{requireAdmins,reason}`，本人先绑定 |
| `/api/admin/notification-settings` | GET / POST | 脱敏读取/版本校验更新加密配置；不发送 |
| `/api/admin/notification-settings/test` | POST | `{channel,expectedRevision,confirmSend,confirmAudience?}`，单独授权测试 |
| `/api/admin/delivery` | GET | 最近100投递及告警 |
| `/api/admin/delivery/retry` | POST | `{id,reason,confirmDuplicate:true}`，保留原记录、新建重发 |
| `/api/admin/alerts/acknowledge` | POST | `{id,reason}`，确认处理告警 |
| `/api/admin/backups` | GET | 设置、实际绑定状态、最近成功、过期提示、任务报告 |
| `/api/admin/backups/settings` | POST | `{enabled,utcHour,autoDrill,expectedRevision,reason}` |
| `/api/admin/backups/run` | POST | `{kind:'backup'|'drill',sourceId?,confirmStorage:true,confirmIsolation?,reason}`，返回202仅表示排队 |
| `/api/admin/backups/:id/download` | GET | 已完成的密文TAR，需近期密码/MFA验证 |

项目渠道POST增加 `mode: 'off'|'own'|'global'`。global必须有 `confirmAudience:true` 和当前 `expectedGlobalRevision`。普通成员只能看到是否配置与公开的接收范围，不能读密钥。

项目 `/actions` 的 `proposal.submit` 新增：

- `ownership_transfer`：payload `{newOwnerMemberId,handover}`。接收者 `proposal.vote` 同意还需 `acceptOwnership:true`。
- `exit_plan`：payload `{memberId,capitalCents,profitCents,reimburseCents,owedCents,shares:{memberId:basisPoints},handover:{tasks:[{id,assigneeId,reviewerId}],purchases:[{id,executorId,receiverId}]},basis,responsibilities,dueDate}`。金额均整数分，剩余比例合计10000；退出者同意还需 `acceptExit:true`。
- `exit_finalize`：payload `{exitId,confirmation}`，实际净额足额独立复核后再次原全员确认。
- `exit_cancel`：payload `{exitId}`，无已发生退出收付时才可共同取消。
- `exit.payment` 是动作type而不是proposal：data `{id:exitPlanId,amountCents,evidence,attachments?}`，按批准净额方向登记，不转账，仍走 `ledger.verify` 不同成员复核。

MFA常见错误码：`MFA_REQUIRED`、`MFA_STEPUP_REQUIRED`、`MFA_SETUP_REQUIRED`、`MFA_INVALID`。接口被拒绝不代表验证码通过；报告过期或资料冲突为409，不得自动重试投票忽略新内容。


## v1.4 轻量AI和支出（0005迁移）

- 管理员 `/api/admin/ai-settings` 主字段：enabled/provider/baseUrl/model/key/expectedRevision/reason，可选clearKey/confirmExternalHost/analysisGuidance。价格/输出限制不再必填；仍要求管理员、本人验证、版本和加密。GET包含只读prompts目录，绝不回显已保存Key。
- `/ai/policy` 字段：engineFingerprint、confirmScope=true、monthlyCallLimit、purchaseThresholdCents（整数分，缺省50000）、reportStyle（concise/standard/detailed）、autoPurchase、autoStage。创建全员提议，不直接生效；scope升级project-minimal-v2，policy.version=2。
- `ai.materials` 接受context/focus，按字段合并，保留未提交的旧business/customers/channels/economics/validation/risks/scenarios。不是PATCH批准计划。
- `/ai/preview` 新增callSlots、purchaseAssessment；不调用AI。`/ai` 返回usage的actualCalls/reservedCalls/inputTokens/outputTokens/unknownUsageCount，以及purchaseAssessments。次数按UTC月，未知usage不是免费。
- 新job保存attempts、call_limit、usage_log、continuation、lease_token。accounting包含sentCalls/unknownUsageCalls，截断待补齐时continuationPending=true。旧reserveCents/chargeCents字段仅历史兼容，新记录的0不能解释为真实零成本。
- `ai.run.progress` 与request/finish一样只允许内部验证服务使用，普通actions端点拒绝伪造。补齐仍检查身份、授权、输入和配置。
- `purchase.save` 可选purpose（daily/content/software/promotion/outsourcing/equipment/goods/other）、commitmentGroup（同事项标签，最多100字符）、simpleForm。simpleForm=true必须单条数量1；必填原阶段、收款对象、付款安排及不同执行/验收人不取消。quote/risk/exitPlan可空，空值不是无风险。金额来自items，不信任客户端另外传的amount或分析判断。
- GET项目的每张采购单包含后端派生analysisAssessment，列出阈值、自身/累计金额、相关ID及原因；派生判断不写回业务签名快照。自动调用只在有效授权范围内发生。


## v1.5 监督与追加投入（原项目接口扩展，无新权限入口）

`GET /api/projects/:id` 返回 `supervision`（保留资料）与 `supervisionView`（本次计算的总览、资金、期限、待办与异常）。普通成员仍仅能读自己的有效项目。

`POST /api/projects/:id/actions` 新增：

| type | 主要字段 | 权限／语义 |
|---|---|---|
| report.submit | kind=weekly/stage, stageId, fromDate, toDate, completed, evidence, problems?, nextSteps?, reviewerId, attachments?, fundingIds?, supersedesId? | 已加入可执行成员，启用规则后仅指定汇报人；不自动批准 |
| report.read | id, contentHash | 本人对具体版本确认已阅，归档不写入 |
| report.review | id, accept, note | 指定不同合伙人；只处理最新阶段成果，接受时核对依据哈希 |
| funding.receipt | id, memberId, amountCents, evidence, attachments? | 合伙人登记真实来款，等待原ledger.verify独立复核 |
| funding.link | id, memberId, entryId, evidence | 关联未重复使用的原来款，不增加现金 |
| issue.create | sourceKey? 或 title/detail/severity, assigneeId, reviewerId, dueDate | 合伙人建单，处理人与复核人不同 |
| issue.respond | id, cause, plan | 指定处理人说明原因与安排 |
| issue.resolve | id, result, attachments? | 指定处理人提交结果，不自行关闭 |
| issue.review | id, accept, disposition=resolved/accepted/false_positive, note | 指定不同合伙人复核，来源仍在不能标记已消除 |

`proposal.submit` 新增 kind：`supervision_policy`、`plan_change`、`funding_request`、`funding_cancel`，具体字段见 `src/supervision.js` 的验证函数。全部沿用原冻结成员与全员会签。追加承担人在 `proposal.vote` 同意时必须另送 `acceptFunding:true`；服务端存入该人的决定。前端不能通过隐藏字段修改预算或冒充系统。

`supervision.sync` 为内部定时服务专用操作，浏览器接口直接拒绝。幂等键、项目权限、原审批验证与审计仍生效。新视图中的 `informationStatus` 不应解读为AI结论或经营保证。
