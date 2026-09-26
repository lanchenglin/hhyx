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
