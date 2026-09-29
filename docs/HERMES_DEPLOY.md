# v1.5.0 出资人监督升级补充（本节优先）

仓库：`https://github.com/lanchenglin/hhyx`。本次基线为 `0b2f54d18280d4e2ab153bc63c6a953d3a57a5e1`，保留后续已有用户改动，不能强制重置。以下旧章节涉及v1.2/v1.3/v1.4时，应按实际已执行迁移逐项判断，不能照搬新建站点命令覆盖现有资源。

1. 确认此项目工作目录、线上Worker/D1/R2归属及获授权范围；备份现有D1、私有附件和必要部署配置，核实恢复方式。不要打印Secrets或真实账目。
2. 检查 `git status` 并保留未提交改动，正常拉取新代码；保留真实 `wrangler.jsonc`、域名、资源ID、Secrets和现有账号。此次不改密码/MFA/AI Key存储，不创建默认管理员。
3. v1.5新增内容存于已有项目JSON，**本版无新增SQL表/列/迁移文件**。已执行0001–0005的站点不必额外迁移；更早版本仅通过Wrangler迁移跟踪应用尚未执行的既有迁移，禁止清库或重复手动ALTER。
4. 执行 `npm run check` 和 `npm test`。部署工具安装后执行 `npm run deploy:check`；核对不会覆盖其他应用，再按原脚本部署。构建通过不代表真实D1/R2/定时任务已验证。
5. 登录测试站或独立测试项目，确认新首页和五个导航入口。由实际执行者/测试账号共同选择汇报负责人、不同验收人、首次截止和周期，逐人批准监督规则。不要替真实合伙人同意真实事项。
6. 使用三个独立测试账号跑通：提交汇报→他人已阅→追加投入→承担人明确勾选金额→全体通过（现金不变）→真实测试来款登记/不同人员复核→提交阶段成果→独立验收→全员阶段关闭→另行开放下一阶段。只有测试数据可用虚构数值。
7. 验证异常原因、计划、实际结果和独立关闭；验证严重规则仅限制新增承诺而不阻止已有账目。保持现有Cron，确认监督游标、站内提醒、出站记录以及失败状态；未配置渠道不应声称送达。
8. 手机真机验证新导航、日期/金额输入、表单底部按钮、附件下载、最新数据刷新。明确记录哪些已验证，不能把构建或本地截图当成生产验收。

已有SQL迁移和备份格式仍为schemaVersion5；新监督资料随项目JSON进入导出/备份，不需要独立搬运。不要回滚到不认识已生效监督规则的旧代码来绕过限制。出现问题优先保留数据并前向修复；确需恢复必须核对后续真实业务及原批准义务。

**本轮实测：** 独立Node/SQLite上的业务回归、真实Chromium经回环HTTP调用Worker处理器，以及Wrangler dry-run；均不是生产Cloudflare部署或真实短信/模型验收。完整记录见 `ACCEPTANCE_V1_5.md`。

---

# 给 Hermes：将合伙有序部署到 Cloudflare

版本：1.4.0。首次部署目标是**新建一个独立应用**，只用 Workers + D1 + 私有 R2。不要修改 `sx_web`、`memos-cloudflare` 或其他现有项目。用户指定的源码仓库是 `https://github.com/lanchenglin/hhyx`，默认分支为 `main`。不要新建其他仓库，也不要上传真实业务数据或密钥。

## 0. 执行权限与停止条件

先确认当前终端确实位于本源码目录，检查 `package.json` 的 name 是 `coop-plan`。确认已授权使用的 Cloudflare 账户、环境、域名及允许的费用范围。发现同名资源已存在时，先核实归属，不能删除、覆盖或复用不相关数据。

本系统并非为最低免费配额优化。密码 scrypt、多人审计事务和定时提醒都有计算/查询开销，正式使用优先在 **Workers 付费计划及足够 D1/R2 配额**下验证。不得擅自替用户开通付费计划。未取得相关授权就停在构建检查和所缺资料清单，不要降低密码安全参数或减少必签人数来适配配额。

必须停止并报告的情形：账号归属不明；真实域名/预算范围未确认；需要覆盖现有库；测试不通过；生产密钥缺失；来源校验/私有附件隔离失效。不要宣称“已部署”来代替这些步骤。

## 现有站点升级到 v1.4.0（优先执行本节）

只更新此仓库对应的Workers应用。保留原D1/R2、域名、所有Secrets、备份资源、MFA、管理员密码和本地实际配置；不用重新创建资源或配置Key。下方v1.3内容用于尚未设置运维功能的旧站点。

1. 核实工作目录和未提交改动；在源码目录之外备份生产D1、私有附件、部署配置及加密密钥。不要因新版本有备份功能就跳过本次备份。
2. 获取main新版，保留本地修改，运行 `npm run check` 和 `npm test`。生产已有lockfile则用 `npm ci`，不要强制重置。
3. 对真实DB运行 `npm run db:remote`，由Wrangler应用尚未执行的迁移。本版新增 **0005_lightweight_ai.sql**（续写状态、实际尝试数、用量日志、租约标记）；早期站点同时需要0001–0004。禁止清库、手动重复ALTER或给RESTORE_DB套生产迁移。
4. 在维护安排下先迁移再部署 `npm run deploy:check`、`npm run deploy`。新前端与后端必须一起更新，不要仅替换网页文件。
5. 检查管理员模型页无需填写价格和输出长度，旧Key仍仅显示已配置；不换配置根密钥。旧费率环境变量不用再填。原AI配置可继续读取，但新提示词/授权语义使旧项目授权不再有效。
6. 各项目由真实合伙人重新确认「AI授权与金额分级」：建议500元阈值、每月调用上限、报告模式及是否自动分析。管理员不能代签。未确认只暂停AI新发送，不影响原项目流程。旧排队任务在下次调度核对到旧配置/资料会取消发送，已发生调用不能抹去。
7. 先用虚构测试项目验证500元以下不自动调用、超过阈值才触发、关联累计提示、任何金额手动分析、全员会签没有降低、历史报告和材料保留，再在授权范围内做真实模型/手机/云端验收。不得替真实业务试投票。

不新增Queue或Cloudflare绑定；继续原10分钟Cron。明确长度停止才最多补齐一次，第二次由后续调度领取，刷新不重发；未知超时不自动重试。真实API费用和兼容性需用户授权验证，不能以mock通过代替。更换模型仍由管理员配置并重新确认授权。特殊网关的结构化参数可通过部署层 `AI_STRUCTURED_OUTPUT=false` 调整，不关闭最终校验；不是保证任意兼容网关都能调用。

0005不改用户密码、成员比例、审批结果、财务或历史签名；备份新数据格式版本5且仍支持版本4校验。不要直接回退到不认识新权限/运维/续写状态的旧代码；保留数据后修复并前向发布。

当前说明：[AI使用说明](AI_ANALYSIS.md)；实测与未测：[v1.4验收](ACCEPTANCE_V1_4.md)。

## 历史v1.3升级及可选资源：先迁移，再验证四项功能

本节优先于下方保留的v1.2升级说明。只修改已核实属于本仓库的应用；保留真实APP_URL、路由、绑定、Secrets、原配置根密钥和未提交修改。不得重建/清空原库、重置原admin密码，也不替真实合伙人批准任何业务。

### A. 代码与数据库

1. 在源码目录之外备份现有D1、私有R2、部署配置及原CONFIG_ENCRYPTION_KEY，确认可恢复。新备份功能还没部署，不能拿“准备启用新备份”代替升级前备份。
2. 获取本仓库main的v1.3.0，先检查工作目录未提交改动，普通合并更新，不强制重置。运行 `npm run check`、`npm test`。已经存在lockfile则用 `npm ci`，本仓库没有编造无法联网生成的lockfile。
3. 对正确的生产DB执行 `npm run db:remote`：Wrangler只应用尚未执行的迁移，本版新增 `0004_operations_security.sql`。更早版本还需未执行的0002/0003。不要手工重跑ALTER，也不要在演练库上应用生产迁移。
4. 先迁移后部署。0004不改原密码/用户名，MFA全站强制与自动备份默认关闭。上线期间按环境安排维护，不能回退到忽略MFA/退出清算的旧代码继续处理业务。

### B. 可选备份资源必须真实隔离

未授权新资源/费用时，保留备份未配置状态，仍可更新原业务、MFA、通知配置与合作交接；不要擅自开通付费服务。获得授权并核对归属后，以下仅为专属新资源示例，遇到同名先核实，不能删除旧资源：

```bash
npx wrangler r2 bucket create coop-plan-backups-private
npx wrangler d1 create coop-plan-restore-drill
npx wrangler r2 bucket create coop-plan-drill-private
```

三个R2桶必须私有，不开启r2.dev或公开域名。记录真实D1 UUID。向**现有配置**合并以下新绑定，保留原DB、FILES和其余绑定；下面片段不是完整可替换配置：

```json
{
  "d1_databases": [
    {"binding":"DB","database_name":"保留原库名","database_id":"保留原真实UUID","migrations_dir":"migrations"},
    {"binding":"RESTORE_DB","database_name":"coop-plan-restore-drill","database_id":"填写新演练库真实UUID"}
  ],
  "r2_buckets": [
    {"binding":"FILES","bucket_name":"保留原业务私有桶"},
    {"binding":"BACKUPS","bucket_name":"coop-plan-backups-private"},
    {"binding":"RESTORE_FILES","bucket_name":"coop-plan-drill-private"}
  ],
  "vars": {
    "FILES_BUCKET_NAME":"保留原业务私有桶",
    "BACKUP_BUCKET_NAME":"coop-plan-backups-private",
    "RESTORE_BUCKET_NAME":"coop-plan-drill-private"
  }
}
```

占位内容必须换成真实值；vars要合并而非覆盖APP_URL等。三个bucket_name不同、两个database_id不同，不能只换binding名称而复用资源。RESTORE_DB无需运行应用迁移，由演练器建立有命名空间的表；目标已有其他业务表时立即停止，不清库。

用可信随机生成器或密码管理器生成**独立于CONFIG_ENCRYPTION_KEY**的32字节随机值base64，以交互方式保存：

```bash
npx wrangler secret put BACKUP_ENCRYPTION_KEY
# 已有旧备份且确需轮换时，另外安全保存旧指纹到旧密钥的JSON映射：
# npx wrangler secret put BACKUP_OLD_KEYS_JSON
```

不要输出、截图或提交密钥；原CONFIG_ENCRYPTION_KEY必须保留，不能重生成。密钥不放普通vars。将密钥与密文异地/离线分开保管，具体验证与费用由用户授权。没有备份Secret或独立绑定，系统会显示未配置，不自动复用业务桶。

保留已有每10分钟Cron。自动备份UTC时刻是“该小时之后调度”，不保证整点完成；多附件恢复可能要多个Cron周期。历史备份和演练文件不自动删除，须明确留存和存储费用。单次数据库16MiB、每表10000行、1000附件/每份10MiB上限不代表目标Workers计划已满足CPU/内存/查询配额。

### C. 构建与首次功能验收

```bash
npm run check
npm run check:bindings
npm run deploy:check
npm run deploy
```

这些命令需要已经安装Wrangler并获得对应账号权限。本次交付环境未运行真实Wrangler/Cloudflare验收，必须在部署环境执行并记录真实结果。使用自定义 `--env` 时，另外核对该环境实际生效的DB/R2和vars；默认文件校验不能代替云端资源核对。

先通过真实URL检查health/auth/status及旧项目完整性，再用明确标注的隔离测试项目：

- 管理员“账号安全”手动绑定认证器，保存一次性恢复码；退出再登录应先验证第二因素，未验证不得读业务。确认恢复方式后再逐个让现有管理员绑定，最后可开启强制策略。不得替用户保存长期明文种子到公共文件。
- “备份与恢复”手动创建一次成功备份，执行隔离恢复演练，核对报告和生产数据没有变化；下载密文在源码目录外的新目录跑离线工具。真实D1、R2权限、Cron及错误告警均通过后，才由管理员开启每日计划/自动演练。
- “通知服务商”填写已授权密钥、审核通过的签名模板及全站接收范围。保存不发送；获得接收群/本人短信费用授权才测试。项目自有群继续可用，继承全站群需项目负责人另行确认。不得拿真实业务群当默认测试群。
- 三个由测试者控制的独立虚构账号完成负责人移交、退出方案、实际模拟收付登记、不同人员复核、最终全员确认；禁止冒充真实合伙人投票。核对旧采购与AI全员授权不被绕过。
- 手机Safari/Chrome/常用微信内置浏览器检查菜单、密码与验证码输入、恢复码显示/关闭清理、备份下载、清算长表单和全员确认；离线Chromium布局不等于这些真机流程已通过。

离线恢复命令与容量见 `OPERATIONS_V1_3.md`；实际本地测试证据与云端待验收见 `ACCEPTANCE_V1_3.md`。交付报告应逐项写成功/失败/未测，明确真实URL、版本、资源ID（不含密钥）、是否产生费用和谁保管恢复材料。缺授权或校验失败就停止对应外部操作，不降低验证和隔离要求。


## 历史补充：v1.2管理员升级行为（当前以v1.3步骤为准）

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

先完成0001–0005迁移，按下文生成专属CONFIG_ENCRYPTION_KEY（旧站点不得重生成）。使用交互式Secret设置用户私下指定的临时密码：

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

看到现有表或业务数据时，不得执行清库、重置或删除；先核实是否是专属新库。当前包含0001初始、0002新增AI、0003管理员、0004运维安全及0005轻量AI迁移，后续仍须使用新的增量迁移，不能改写历史迁移模拟升级。

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

简化配置、数据发送范围、金额分级、报告/任务操作见 `AI_ANALYSIS.md`。不要将文档中的示意模型ID或占位文字照抄为生产配置。AI_PROVIDER只有 `openai_compatible` 和 `anthropic` 两种协议；自建网关需服务端域名允许清单。

无需为AI新建Cloudflare Queue；当前实现用D1任务表和已有Cron，单次AI HTTP请求20秒。模型过慢会变成未完成/不确定，不会自动重试。实际计费以服务商账单为准，应用人民币预占不能代替服务商消费上限。

升级交付报告中分别记录：迁移是否完成、原业务是否回归、AI是否仅配置或已实际调用、选用模型/接收方、真实发送次数和测试费用、全员授权是否真实完成、Cron恢复是否实测。不得代替合伙人批准真实采购或共享个人密码。

## 10. 历史手机更新（仅1.1.0→1.1.1；本次升级应用所有未执行迁移直到0005）

从v1.1.0更新无需新增迁移；仅更新源码和静态资源，保留现有绑定/Secrets/域名/数据。不要清库或重建应用。新增`public/mobile.css`必须随静态目录部署，本地运行适配器也已包含此资源。先检查`git status`并保留用户修改，再按现有构建/部署步骤发布；从v1.0.0更新仍须执行0002迁移。

运行`npm run check`及`npm test`，有浏览器测试依赖时再运行`node tests/mobile-fixture.mjs`与`npm run test:mobile`。上线后检查`/mobile.css`返回CSS而不是HTML，并按`MOBILE_WEB.md`完成iPhone/安卓及常用微信浏览器的真机验收。不能把离线截图当成云端或软键盘测试通过。

## 原有业务交付仍须逐项说明

实际部署URL/版本、全部迁移直到0005是否完成、旧密码和项目是否保留、管理员入口与普通用户API隔离、归档恢复与私有附件、账号变更提醒和会话失效、AI配置及真实测试发送情况。未进行的真机、云端、模型、消息和恢复演练写明未验证，不能将绑定存在或离线截图写为线上成功。
