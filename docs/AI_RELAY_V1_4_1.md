# v1.4.1：中转站 API 与 AI 配置保存修复

## 使用变化

系统管理员在已完成登录的会话内，修改 AI 的 URL、Model、Key、启停和补充偏好，以及明确确认后测试连接，不再重复输入密码或动态验证码。未登录、普通用户、停用账号、未完成登录第二因素、强制改密状态、CSRF/来源校验仍会被阻止。删除/归档项目、用户权限、密码重置、备份和其他敏感操作仍保留原来的再验证。

选择“OpenAI兼容／中转站 Chat Completions”。可填写中转站域名、含 `/v1` 的 API 基址或完整 `/chat/completions` 地址。根路径自动补 `/v1`，完整接口会规范为基址，避免重复拼接；自定义路径保留。Anthropic Messages 协议同样支持完整 `/messages` 地址。与协议不匹配的路径会提示纠正。

示例（仅说明格式，不访问任何服务商）：

```text
https://relay.example.com
https://relay.example.com/v1
https://relay.example.com/v1/chat/completions
```

上述三种写法在 OpenAI 兼容模式下均规范为 `https://relay.example.com/v1`。Model 填服务商账号可用的模型ID，不能只凭别处的模型名称推断该中转站支持。

第三方域名仍需管理员明确确认。只接受 HTTPS，拒绝本地/IP地址、URL中的密钥或密码、查询参数、编码/异常路径、非443端口和重定向。允许名单不是对服务商资质、隐私或DNS行为的保证。

## 请求兼容性

官方 OpenAI 地址默认继续使用 `max_completion_tokens` 和严格结构化请求；第三方 OpenAI 兼容地址默认使用更精简的 `max_tokens` 请求，不强制发送 `json_schema`。报告 JSON 规则和三类提示词依然内置，响应仍须经过字段、来源和完整性校验，不能将不合格文本当成成功报告。基础连接测试和正式分析使用同一套 token 字段选择。

不恢复 token 单价、价格或输出字数输入。少数特殊网关需要部署者设置以下可选参数，不需要普通用户填写：

- `AI_REQUEST_MODE=auto|modern|relay`：默认auto，modern选新参数，relay选精简参数。
- `AI_TOKEN_PARAMETER=max_tokens|max_completion_tokens`：覆盖OpenAI兼容请求的字段名，不改变数值上限。
- `AI_JSON_MODE=prompt|json_object|json_schema`：选择提示词约束、JSON模式或严格结构。Anthropic不接受json_object。

已有 `AI_STRUCTURED_OUTPUT=false` 仍可关闭服务商结构化参数，但不会关闭本地报告校验。没有自动试多个接口、偷偷更换模型或失败后重复收费重试；不是承诺所有中转站都兼容。真实鉴权、响应耗时、模型质量和账单仍须用实际服务验收。

## 保存失败与测试失败分别处理

**保存配置不调用中转站。** 旧版截图中的通用“操作未完成”不足以定位原因，不能断言由中转站或Key错误导致。

现在会区分服务端 `CONFIG_ENCRYPTION_KEY` 缺失/格式错误、可识别的D1迁移问题，以及配置读写/加密异常；异常提供诊断编号。原始密钥、上游HTML和原始服务商错误不会直接回显或写入本次新增诊断日志。不要将模型API Key填成配置根密钥，也不要为了消除错误重新生成并覆盖已经使用的根密钥。

测试连接会区分 HTTP 400/401/403/404/422/429/5xx、网页响应、空正文、长度中断和网络异常。测试失败留在错误提示中，不再被通用“已保存”成功提示覆盖；成功展示独立测试结果，不把连接测试当成完成项目分析。

“全站启用外部AI”未勾选时，只保存配置，AI继续关闭；不会替管理员自动勾选。保存不会自动做连接测试。测试仍需明确确认可能费用，不发送项目数据。

## 升级与部署

正式环境仍是 Cloudflare Workers + D1 + R2。v1.4.0 → v1.4.1 **没有新增数据库迁移**。保留已有真实域名、Wrangler绑定、Secrets、管理员密码、MFA和业务数据，按 `HERMES_DEPLOY.md` 的备份/检查/部署流程升级。不要用仓库占位配置覆盖生产配置；从旧版本升级仍须应用其尚未执行的0001–0005迁移。

本次请求兼容策略进入模型配置指纹，原项目AI授权会显示需重新共同确认；这是防止静默改变外部请求方式。原采购会签及其他业务无需重建。没有改动线上服务或任何用户真实密码，没有真实API Key，也没有请求截图中的中转站。

Hermes上线核对：管理员保存与测试不再弹密码；普通用户不能访问配置接口；其他敏感操作仍验证；未启用状态不发分析；先用通用句确认真实中转接口，再由独立测试项目共同授权分析。遇到错误保存诊断编号并核对Worker日志，不复制密钥进公开问题、截图或Git。

## 本次实际验收

隔离环境：Node.js 22.16.0、本地SQLite D1适配器、离线Chromium，未使用真实账号或服务商密钥。

- 完整 `npm test`：167项通过，0失败、0跳过、0取消；包含测试分组，耗时199464.443886ms。
- `npm run check`：52个JavaScript文件语法及绑定声明检查通过。
- 管理员界面回归：24项通过，无pageErrors。
- 新中转配置界面：15项通过，无pageErrors；覆盖320、390、1440宽度。

后端新增7项顶层测试覆盖URL规范化、精简/严格协议、来源校验、错误不泄露、单次请求、管理员无近期再验证保存、CSRF/普通用户拒绝、项目归档继续再验证、登录MFA仍有效、其他管理操作仍要求近期第二因素、缺失根密钥和安全诊断。原有业务、AI、备份、MFA和退出清算回归全部保留。

前端实测真实页面代码，HTTP是明确测试替身；覆盖Key不回显、保存错误可读、不重复密码/MFA、保存不自动启用/测试、明确确认后只测试一次、测试401不显示成功、关闭清理及补充偏好。汇总证据见 `test-results/ai-relay-v1.4.1.json`。

尚未验证：Cloudflare官方运行时及线上D1、截图中中转站的真实Key/模型/网络、iPhone/安卓真机。保存报错的线上根因仍需实际部署日志，不能把本次本地测试当成线上故障已经证实修复。

## 实现参考

- DeepSeek Chat Completions（max_tokens及JSON参数）：https://api-docs.deepseek.com/api/create-chat-completion/
- DeepSeek JSON输出说明：https://api-docs.deepseek.com/guides/json_mode/
- OpenAI结构化输出与JSON模式：https://developers.openai.com/api/docs/guides/structured-outputs
- Workers node:crypto兼容：https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/

接口支持情况随服务商变化，本版按配置显式选择，不在线读取或猜测第三方模型能力。
