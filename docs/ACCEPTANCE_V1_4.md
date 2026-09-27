# v1.4.0 轻量AI更新：实测与上线验收

基线：GitHub main `4d26ea9838459844517d98b4b1213b450de97d1b`（v1.3.0）。本次使用隔离工作容器中的 Node.js 22.16.0、真实Worker源代码、本地SQLite事务适配器和离线Chromium。模型和浏览器HTTP使用明确测试替身，没有真实API Key、项目业务、付款或线上部署。

## 实际结果

| 检查 | 结果 | 记录 |
|---|---|---|
| 全部Node测试 | 160通过，0失败、0跳过；包括父分组 | test-results/node-test-results-v1.4.0.txt |
| JavaScript语法/声明绑定检查 | 50个文件通过 | test-results/check-v1.4.0.txt |
| 新轻量界面 | 20项通过，无pageErrors | test-results/lightweight-ui-v1.4.0.json |
| 管理员页面回归 | 24项通过 | test-results/admin-render-results-v1.4.0.json |
| 手机/平板/桌面回归 | 57项通过 | test-results/mobile-render-results-v1.4.0.json |
| 密码显示与关闭清理 | 21项通过 | test-results/password-visibility-results-v1.4.0.json |
| 原AI报告界面 | 11项通过 | test-results/ai-browser-render-results-v1.4.0.json |
| MFA/备份/通知/交接界面 | 26项通过 | test-results/operations-render-results-v1.4.0.json |

新增16个顶层Node测试覆盖：无价格配置、密钥与管理员隔离、不同类型自然语言项目、无客户不强制补客户、历史资料部分更新、499.99/500/500.01元边界、生活用途大额不豁免、小额手动分析、全员会签未减、关联累计但不跨项目、撤销和时间窗口、订阅完整承诺、全员阈值变更、旧授权失效、提示词/偏好版本、OpenAI及Anthropic两种明确长度停止的受控补齐、实际用量与未知用量、重复点击/并发领取不重复调用、暂停后不补齐、两次截断仍失败、最后1次调用额度、不能通过普通API伪造进度/完成、网关部署兼容参数和引用校验。

既有144项覆盖原治理、审批、预算、账目、鉴权、归档、MFA、恢复演练和通知；保持安全断言。旧费率必填测试因本次明确取消费率需求，改为验证无价格也可配置、真实调用仍计数，未删除身份/隔离/来源检查。

新增UI检查覆盖320/390/430/1440宽度。运行实际前端，测试一段说明自动带入与保存payload、阈值元转分及共同提议、快速支出4项可见必填与不同验收人、保存草稿不自动投票/付款/调用AI、多项明细保留、Key不回显、提示词只读及可选偏好分离。配合原手机回归包含360、667横屏、768及短视口。截图均为合成测试数据，不是实机或真实AI建议。

## 复现

```bash
npm run check
npm test
npm run test:lightweight-ui
npm run test:admin-ui
node tests/mobile-fixture.mjs
npm run test:mobile
npm run test:password-ui
npm run test:operations-ui
npm run fixture:ai
python3 tests/ai_browser_render.py
```

UI需要Python Playwright及Chromium；默认/usr/bin/chromium，可用CHROMIUM_PATH指定。测试不安装或绕过网络限制。临时数据和截图在被Git忽略的artifacts，不上传真实数据。测试代码保留历史报告文件名时，本次结果另存v1.4文件，历史报告不覆盖。

## 本次没有完成，部署后必须验收

1. 生产升级前独立备份、D1迁移0005及旧数据前后核对；原账号密码、MFA、Key、原签名和历史报告保留。
2. 官方Wrangler构建及真实Workers CPU/时限、D1新增列与事务、R2私有访问、Cron调度；本地适配器不模拟云配额。
3. 所选真实API的鉴权、参数兼容、结构化输出、延迟、usage与实际账单。不同模型不一定遵循补齐指令；不符合时应失败而非假成功。测试替身通过不证明真实分析质量。
4. 由本人及独立测试账号确认新的AI规则；验证小额免自动分析、超额/累计触发、有限补齐、暂停、过期预览、不绕过会签。不代表真实合伙人投业务票。
5. iPhone/安卓/微信浏览器在线登录、折叠表单、软键盘、上传下载、来源查看；离线宽度检查不等于真机验收。
6. 按既有运维说明验证schemaVersion5新备份和版本4旧备份兼容，使用独立D1/R2；不以本地恢复当作生产灾备切换完成。

本次未部署、未发送真实短信/微信、未调用收费模型。移除软件中的估算价格并不免除真实服务商费用，应用次数上限不是服务商金额硬限额。小额免AI不等于免记账、通知或审批。
