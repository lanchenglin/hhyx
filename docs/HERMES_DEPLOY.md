# 给 Hermes：将合伙有序部署到 Cloudflare

版本：1.2.0。首次部署目标是**新建一个独立应用**，只用 Workers + D1 + 私有 R2。不要修改 `sx_web`、`memos-cloudflare` 或其他现有项目。用户指定的源码仓库是 `https://github.com/lanchenglin/hhyx`，默认分支为 `main`。不要新建其他仓库，也不要上传真实业务数据或密钥。

## 0. 执行权限与停止条件

先确认当前终端确实位于本源码目录，检查 `package.json` 的 name 是 `coop-plan`。确认已授权使用的 Cloudflare 账户、环境、域名及允许的费用范围。发现同名资源已存在时，先核实归属，不能删除、覆盖或复用不相关数据。

本系统并非为最低免费配额优化。密码 scrypt、多人审计事务和定时提醒都有计算/查询开销，正式使用优先在 **Workers 付费计划及足够 D1/R2 配额**下验证。不得擅自替用户开通付费计划。未取得相关授权就停在构建检查和所缺资料清单，不要降低密码安全参数或减少必签人数来适配配额。

必须停止并报告的情形：账号归属不明；真实域名/预算范围未确认；需要覆盖现有库；测试不通过；生产密钥缺失；来源校验/私有附件隔离失效。不要宣称“已部署”来代替这些步骤。

## 现有站点升级到 v1.2.0：保留账号与数据

仅更新已核实属于本仓库的站点。先记录部署版本、检查 `git status`，保留域名、D1/R2绑定、路由和未提交改动，不强制重置。

1. 在源码目录之外加密备份D1、私有R2以及配置根密钥，核实恢复方案。**保留原CONFIG_ENCRYPTION_KEY**，不可重新生成覆盖旧密钥。
2. 获取main的v1.2.0源码，执行 `npm run check` 和 `npm test`，保留实际部署配置。
3. 对确认的专属数据库执行 `npm run db:remote`。Wrangler只应用未执行的迁移：本次新增 **0003_administration.sql**；从1.0升级还需0002。不要清库或手工重复运行ALTER脚本。
4. 0003只把 `settings.bootstrapped` 记录的原初始化账号提升为系统管理员并增加admin用户名，**原密码不变**。不新建默认账号、不覆盖既有用户。有账号但缺少可信初始化记录时停止并核实，不能猜“第一个用户”。
5. 先迁移再执行 `npm run deploy:check` 和 `npm run deploy`。包含全部静态资源：`admin-ui.js`、`admin.css`、`mobile.css`等。不重建项目、Worker、数据库或对象桶。
6. 原初始化用户用原邮箱或admin用户名和原密码登录，打开 **系统管理**。按 `ACCEPTANCE_ADMIN.md` 检查普通用户后台拒绝、项目生命周期、用户停用、旧采购与财务及附件完整性。
7. AI原环境变量可继续兼容，管理员可以在网页接管Key/Model/URL设置。数据库加密配置保存后优先；修改配置需要项目重新全员确认。保存本身不调用模型，单独测试连接需明确同意可能费用。

**不要回滚为不识别归档、停用或强制改密字段的旧代码**，否则旧版可能忽略新安全限制。出现问题应停止入口/进入维护、保留数据并前向修复；恢复备份前核对后续真实业务，不静默丢弃记录。

## 新空站点：可选 admin 临时密码初始化

只用于用户明确授权的新站点，不能用于覆盖已有账号。公开源码没有共享固定密码。

先完成0001–0003迁移，按下文生成专属CONFIG_ENCRYPTION_KEY（旧站点不得重生成）。使用交互式Secret设置用户私下指定的临时密码：

```bash
npx wrangler secret put INITIAL_ADMIN_PASSWORD
```

不要把密码作为命令参数或写进Git、SQL、普通vars、本文、截图或日志。普通vars中可设置 `INITIAL_ADMIN_ENABLED="true"`，可选 `INITIAL_ADMIN_EMAIL` 指定真实管理员邮箱；未指定时为admin@local.invalid，仅作账号标识。

部署后第一次读取登录状态/登录时，仅在空库建立admin。此临时密码允许10–128字符，**首次登录必须改为12–128字符的新密码**，改密前业务和管理API均拒绝访问。初始化完成并确认用户可正常登录后，删除INITIAL_ADMIN_PASSWORD及不再使用的BOOTSTRAP_TOKEN Secret。重启不会重设已存在密码。

没有上述显式配置时，仍使用BOOTSTRAP_TOKEN初始化页面。已有站点只走前面的升级流程，原密码不变。

本地新实例可把同名变量写进被Git忽略的 `.dev.vars`，同时保留/生成专属配置加密密钥后运行 `npm run dev`。生产不用明文env文件。详细权限说明见 `ADMINISTRATION.md`。

## 1. 检查源码与安装构建工具

首次获取源码：

```bash
git clone https://github.com/lanchenglin/hhyx.git
cd hhyx
```

已有工作目录时先检查 `git status`，保留本地配置和未提交修改；不要强制重置或覆盖已有部署。

```bash
node --version
npm --version
npm run check
npm test
npm install
npx wrangler --version
npx wrangler whoami
```

Node 至少22.16.0。`npm test` 使用本地 SQLite，不需要账号或短信。首次 npm 安装生成的 lockfile 应在用户确认的此项目仓库中保存，后续改用 `npm ci`。

未登录时使用交互式 `npx wrangler login`，或使用用户明确提供的、最小必要权限 API Token 与账户 ID。禁止把 Token 写入 Git、文档、截图、聊天正文或构建日志。不要搜集或挪用其他项目的服务商凭据。

## 2. 创建独立资源

以下为建议名；若已占用，选新的明确归属此项目的名字，并统一更新配置。不要删掉旧资源。

```bash
npx wrangler d1 create coop-plan-db
npx wrangler r2 bucket create coop-plan-private
```

保存 D1 命令返回的真实 `database_id`。R2 桶保持**私有**，不开放 `r2.dev` 或公共自定义域名；文件只通过登录后的 Worker 下载。

决定正式入口：可以先使用用户账号下的 Workers 子域名，也可以是已授权的自定义域名。APP_URL 必须准确匹配最终浏览器地址；本应用拒绝其他 Origin 的写请求。

```bash
node scripts/configure-cloudflare.mjs \
  --database-id '这里替换为真实UUID' \
  --app-url 'https://这里替换为实际站点域名' \
  --worker-name 'coop-plan' \
  --database-name 'coop-plan-db' \
  --bucket 'coop-plan-private'
```

这个脚本只改当前目录的 `wrangler.jsonc`，不创建资源。占位文字不能照抄执行。若有同名应用，先换新名，不覆盖。

使用自定义域名时，在配置中增加已获授权的 Worker 自定义域路由，例如：

```json
"routes": [{"pattern": "cooperate.example.com", "custom_domain": true}]
```

示例域名必须换成实际域名。其 DNS 区域需在目标账户中。也可先仅部署 Workers 子域名；不要猜测用户的子域名。

## 3. 配置正式密钥

正式密钥必须重新生成，不复用本地 `.dev.vars`，更不能用 `.dev.vars.example` 中的示例值。

必需的两个 Secret：

| 名称 | 用途与格式 |
|---|---|
| BOOTSTRAP_TOKEN | 至少32字节随机值；仅创建第一个账号使用 |
| CONFIG_ENCRYPTION_KEY | 恰好32字节随机值的 base64 编码；加密企业微信 Webhook |

用可信密码管理器/随机生成器生成，安全保存，再交互式设置，避免命令历史泄露：

```bash
npx wrangler secret put BOOTSTRAP_TOKEN
npx wrangler secret put CONFIG_ENCRYPTION_KEY
```

先设置真实配置再调用 Wrangler Secret。若 Wrangler 提示需要建立尚不存在的 Worker，确认名称属于此新项目后再继续。密钥本身不要出现在交付报告里。

不要将任何 Secret 放进 `wrangler.jsonc` 的 `vars`。APP_URL 和 TZ 才是普通变量。配置加密密钥遗失将无法解密原 Webhook；更换时须重新设置每个项目的渠道。

短信不是基础站点启动的必需项。只有用户提供已开通的合法服务商配置且允许发送费用时，才设置通知文档中的四个短信 Secret。

## 4. 本地官方运行时验证和数据库迁移

```bash
npm run db:local
npm run dev:workers
```

另一个终端可检查：

```bash
curl --fail http://localhost:8787/api/health
curl --fail http://localhost:8787/api/auth/status
```

在支持浏览器访问的环境中完成三账号全流程。`.dev.vars` 仅本地使用，APP_URL 应为实际访问的 localhost 地址；不要混用 localhost 与127.0.0.1。

正式新库迁移：

```bash
npm run db:remote
```

看到现有表或业务数据时，不得执行清库、重置或删除；先核实是否是专属新库。当前包含0001初始、0002新增AI和0003管理员迁移，后续仍须使用新的增量迁移，不能改写历史迁移模拟升级。

## 5. 构建与部署

```bash
npm run deploy:check
npm run deploy
```

`npm run deploy` 会检查占位配置并先执行 dry-run，失败时不会继续。记录真实部署 URL、Worker 名称、D1 名称及 ID、R2 名称、部署版本和时间，**不记录 Secret**。

发布后确认：

```bash
curl --fail 'https://实际域名/api/health'
curl --fail 'https://实际域名/api/auth/status'
```

health 只证明路由能响应；auth/status 能检查库是否可查询。二者都不能代替完整的业务和 R2 验收。

## 6. 账号初始化和三人业务验收

由用户本人使用正式 BOOTSTRAP_TOKEN 初始化账号。不要把临时共享密码发给所有合伙人，也不要代替真实合伙人批准真实项目。初始化完成后可删除 BOOTSTRAP_TOKEN Secret；数据库中的初始化标记仍阻止再次初始化。先保证用户能正常登录。

在独立测试项目里使用三个由测试执行者控制并明确标注的账号；不得冒充真实合作方。执行 `ACCEPTANCE.md` 的云端清单，尤其是：

- 两人同意、第三人未表态，采购仍不可执行。
- 改金额后旧表态失效；超预算不能靠全员同意直接跳过预算变更。
- 同一付款请求重复提交不重复记账。
- 不属于项目的账号无法下载凭证；未登录也不行。
- 已批准采购能够登记订单、部分付款、另一人复核、独立收货。
- 创建人不能直接删掉反对者或把规则改成多数票。

真实云端性能、CPU、查询次数、Cron 与对象存储须在此时检查。本源码交付时未完成这些云端实测。

## 7. 通知和可选 Queues

基础模式已实现 **D1 outbox + Cron 每10分钟轮询**。业务提交会尝试即时处理少量待发通知，剩余和重试由 Cron 继续。没有 Queue 也能工作；不是界面里写了个占位。

企业微信由用户在项目“通知中心”录入该项目内部群机器人的 Webhook。发送测试消息前取得群内许可。不要用无关工作群测试。

需要队列时，先创建专用 Queue：

```bash
npx wrangler queues create coop-plan-notifications
```

再把以下结构合并到 `wrangler.jsonc`，不要覆盖原有绑定：

```json
"queues": {
  "producers": [{"binding": "NOTIFY_QUEUE", "queue": "coop-plan-notifications"}],
  "consumers": [{"queue": "coop-plan-notifications", "max_batch_size": 5, "max_retries": 3}]
}
```

Cron 保留，用于到期提醒、退避和租约恢复。Queue 为可选路径，交付测试未对真实队列进行云端验证。

## 8. 备份与交付

对已有生产库的任何后续升级先备份。示例导出命令需对准已确认的专属库：

```bash
npx wrangler d1 export coop-plan-db --remote --output ./backup-coop-plan.sql
```

数据库备份包含敏感资料，应加密、限制访问、存放在源码目录之外。R2 对象单独备份；网页 JSON 导出只有附件目录，不包含附件文件本身。恢复验证必须在新的隔离库/桶中，不得覆盖当前生产数据。

最终向用户提交：实际访问地址、部署状态、测试通过/失败清单、通知真实发送情况、账号初始化方式、备份位置和维护事项。**未验证的项目逐项标明**。如未部署，就交付源码及缺失条件，不将本地截图当成线上证明。

## 9. AI可选配置及交付核验（v1.2支持管理员网页配置）

详细变量、数据发送范围、报价单位、报告/任务操作见 `AI_ANALYSIS.md`。不要将文档中的示意模型ID或费率占位文字照抄为生产配置。AI_PROVIDER只有 `openai_compatible` 和 `anthropic` 两种协议；自建网关需服务端域名允许清单。

无需为AI新建Cloudflare Queue；当前实现用D1任务表和已有Cron，单次AI HTTP请求20秒。模型过慢会变成未完成/不确定，不会自动重试。实际计费以服务商账单为准，应用人民币预占不能代替服务商消费上限。

升级交付报告中分别记录：迁移是否完成、原业务是否回归、AI是否仅配置或已实际调用、选用模型/接收方、真实发送次数和测试费用、全员授权是否真实完成、Cron恢复是否实测。不得代替合伙人批准真实采购或共享个人密码。

## 10. 历史手机更新（仅1.1.0→1.1.1；本次升级仍须0003）

从v1.1.0更新无需新增迁移；仅更新源码和静态资源，保留现有绑定/Secrets/域名/数据。不要清库或重建应用。新增`public/mobile.css`必须随静态目录部署，本地运行适配器也已包含此资源。先检查`git status`并保留用户修改，再按现有构建/部署步骤发布；从v1.0.0更新仍须执行0002迁移。

运行`npm run check`及`npm test`，有浏览器测试依赖时再运行`node tests/mobile-fixture.mjs`与`npm run test:mobile`。上线后检查`/mobile.css`返回CSS而不是HTML，并按`MOBILE_WEB.md`完成iPhone/安卓及常用微信浏览器的真机验收。不能把离线截图当成云端或软键盘测试通过。

## v1.2交付必须逐项说明

实际部署URL/版本、0003迁移是否完成、旧密码和项目是否保留、管理员入口与普通用户API隔离、归档恢复与私有附件、账号变更提醒和会话失效、AI配置及真实测试发送情况。未进行的真机、云端、模型、消息和恢复演练写明未验证，不能将绑定存在或离线截图写为线上成功。
