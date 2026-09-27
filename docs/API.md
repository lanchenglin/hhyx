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
| POST /ai/preview | `{kind:"project"或"purchase"或"stage", targetId}`；返回真实脱敏body、hash、本地规则和预占费用，不发送模型 |
| POST /ai/policy | `{engineFingerprint, confirmScope:true, monthlyCallLimit, monthlyBudgetCents, autoPurchase, autoStage}`；建立全员提案 |
| POST /ai/runs | `{kind,targetId,previewHash,confirmSend:true}`；返回202排队或200复用及id；失败同输入重试须额外 `retry:true,acceptPossibleCharge:true` |
| GET /ai/runs/:id | 冻结快照、报告、来源、模型配置、费用、处置记录与关联任务 |
| GET /ai/runs/:id/export | 同上JSON附件，不含服务端密钥 |
| POST /ai/runs/:id/reviews | `{findingId,disposition:"supplement"或"mitigate"或"accept_risk",note}`；追加记录，不改报告或采购批准 |
| POST /ai/runs/:id/tasks | `{index,confirm:true,title,description,deliverable,stageId,assigneeId,reviewerId,dueDate}`；人工确认后使用原task.add规则，旧报告还须confirmStale:true |

统一actions新增 `ai.materials`（六个业务说明字段和最多三行scenarios）、`ai.suspend`（停止新发送）。`ai.run.request`、`ai.run.finish`、`ai.review` 为内部验证动作，不能直接调用。`task.add` 的aiSource不可由普通actions伪造。

AI任务状态：queued → running → completed/failed/uncertain；发送前授权或资料变化可cancelled。租约中断只标不确定，不自动重发。业务层/AI供应商没有删除历史报告的接口。

403为项目/角色不符；409为预览/授权过期、幂等冲突或重试缺确认；429为费用/调用数/并发/速率限制；503为服务端模型未配置。错误不是风险分析结论。

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
| POST /api/admin/ai-settings | enabled/provider/baseUrl/model/key或clearKey/inputCentsPerMillion/outputCentsPerMillion/outputTokens/structured/expectedRevision/reason；第三方需要confirmExternalHost |
| POST /api/admin/ai-settings/test | expectedRevision、confirmCost=true；可能计费、限流、无项目数据 |
| GET /api/admin/audit?before=&action= | 管理日志分页、按动作筛选 |

普通登录支持原email字段中填写邮箱或用户名，也支持login字段。`/api/auth/me`增加username/systemRole/disabled/canCreateProjects/mustChangePassword。密码接口保留，修改后撤销其他会话并轮换权限版本。归档写请求409、回收站普通项目访问410、普通账号后台访问403。
