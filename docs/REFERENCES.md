# 技术参考与验证依据

下列为实现时核查的官方技术文档。部署人员应在目标账号再次核实当前支持范围与配额，网页文档支持某项API不等于本包已在真实云端跑通。

Cloudflare Workers静态资源与Worker优先路由：

```text
https://developers.cloudflare.com/workers/static-assets/
https://developers.cloudflare.com/workers/static-assets/routing/worker-script/
https://developers.cloudflare.com/workers/static-assets/binding/
```

D1批量事务与限制：

```text
https://developers.cloudflare.com/d1/worker-api/d1-database/
https://developers.cloudflare.com/d1/platform/limits/
```

Node兼容加密API、Cron、R2和队列：

```text
https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/
https://developers.cloudflare.com/workers/configuration/cron-triggers/
https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
https://developers.cloudflare.com/queues/configuration/javascript-apis/
```

阿里云短信SendSms与RPC签名：

```text
https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms
https://help.aliyun.com/en/cmn/developer-reference/signature-mechanism
```

企业微信接口接入采用官方主机的内部群机器人Webhook。本版会验证域名、路径并只在收到errcode=0时标记服务商接受。是否允许添加机器人、频率和成员限制，应在用户的企业微信环境中核实；未做真实群推送测试。

## v1.1 AI实现参考（核对日期：2026-09-27）

- OpenAI Structured Outputs（Chat Completions response_format）：https://developers.openai.com/api/docs/guides/structured-outputs
- Anthropic Structured Outputs（output_config.format、支持的schema子集及截断/拒绝）：https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Anthropic Messages API：https://platform.claude.com/docs/en/api/messages/create
- Cloudflare Workers context / waitUntil：https://developers.cloudflare.com/workers/runtime-apis/context/

接口文档参考不代表已用真实账号测试；本版报告schema刻意仅采用基础类型/required/enum/对象禁止额外字段等共同子集，本地另做长度、引用和业务校验。报价与模型ID不写死，部署者应核对其账户当时可用模型与费率。


## v1.3 实现参考

- IETF RFC 6238（TOTP）：https://www.rfc-editor.org/rfc/rfc6238
- OWASP MFA Cheat Sheet：https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html
- Cloudflare D1 批次与事务：https://developers.cloudflare.com/d1/worker-api/d1-database/
- Cloudflare D1 导入导出：https://developers.cloudflare.com/d1/best-practices/import-export-data/
- R2 Workers API：https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- 阿里云 SendSms：https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms

这些文档是实现依据，不是对本项目真实云端、服务商账户或生产恢复验收的证明。
