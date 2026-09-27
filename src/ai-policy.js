import { assert, text, sha } from './util.js';
export const AI_SCOPE = 'project-minimal-v1';
export const AI_PROMPT_VERSION = 'cooperation-review-1.1.0';
export const AI_KINDS = ['project', 'purchase', 'stage'];
export const AI_BRIEF_FIELDS = {
 business: '业务与产品', customers: '目标客户与需求证据', channels: '成交渠道',
 economics: '售价与成本依据', validation: '试销/验证结果', risks: '风险及退出安排'
};
// Integer intermediates avoid a one-cent floating-point error when multiplying
// large scenario revenue by a basis-point collection rate.
export function scenarioMath(s) {
 const fields=['units','priceCents','unitCostCents','fixedCostCents','openingCashCents','upfrontCents','otherCashOutCents','collectionBps'];
 for(const k of fields)assert(Number.isSafeInteger(s[k])&&s[k]>=0,'场景输入必须为非负安全整数');
 assert(s.collectionBps<=10000,'场景回款比例不得超过100%');
 const b=k=>BigInt(s[k]), number=v=>{assert(v>=-BigInt(Number.MAX_SAFE_INTEGER)&&v<=BigInt(Number.MAX_SAFE_INTEGER),'场景结果超出整数精度范围');return Number(v);};
 const revenue=b('units')*b('priceCents'),cost=b('units')*b('unitCostCents')+b('fixedCostCents'),collected=revenue*b('collectionBps')/10000n;
 const margin=b('priceCents')-b('unitCostCents');
 return {...s,revenueCents:number(revenue),costCents:number(cost),profitCents:number(revenue-cost),collectedCents:number(collected),
  endingCashCents:number(b('openingCashCents')-b('upfrontCents')-b('otherCashOutCents')+collected),
  breakEvenUnits:margin>0n?number((b('fixedCostCents')+margin-1n)/margin):null};
}
export function validateBrief(a) {
 const result = {};
 for (const [key, label] of Object.entries(AI_BRIEF_FIELDS)) result[key] = text(a[key], label, 2000, false);
 // Scenarios are assumptions, not forecasts. All money is integer CNY cents.
 result.scenarios = [];
 assert(a.scenarios == null || (Array.isArray(a.scenarios) && a.scenarios.length <= 3), '最多填写三个测算场景');
 for (const s of a.scenarios || []) {
  const row = { label: text(s.label, '场景名称', 30) };
  for (const key of ['units','priceCents','unitCostCents','fixedCostCents','openingCashCents','upfrontCents','otherCashOutCents','collectionBps']) {
   assert(Number.isSafeInteger(s[key]) && s[key] >= 0 && s[key] <= (key === 'collectionBps' ? 10000 : 100000000), '场景数据须为有效非负整数，回款比例不得超过100%'); row[key] = s[key];
  }
  scenarioMath(row); // Reject overflow before saving unanalysable assumptions.
  result.scenarios.push(row);
 }
 return result;
}
export function publicEngine(env) {
 try {
  const provider = env.AI_PROVIDER || 'openai_compatible';
  assert(['openai_compatible','anthropic'].includes(provider), 'AI_PROVIDER 仅支持 openai_compatible 或 anthropic');
  const u = new URL(env.AI_BASE_URL || (provider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'));
  const allowed = new Set(['api.openai.com', 'api.anthropic.com', ...String(env.AI_ALLOWED_HOSTS || '').split(',').map(x=>x.trim()).filter(Boolean)]);
  assert(u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && (!u.port || u.port === '443'), '模型地址必须为无鉴权参数的 HTTPS API 基址');
  assert(allowed.has(u.hostname) && /^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(u.hostname) && !/(^|\.)(localhost|local|internal|test|invalid)$/.test(u.hostname), '模型域名未获服务端允许；第三方端点需配置 AI_ALLOWED_HOSTS');
  assert(!u.pathname.includes('//') && !/%/.test(u.pathname), 'API 基址路径不正确');
  const model = text(env.AI_MODEL, 'AI_MODEL', 120);
  assert(/^[a-zA-Z0-9._:/-]+$/.test(model), '模型标识格式不正确');
  const config = {provider, baseUrl:u.href.replace(/\/$/, ''), model, scope:AI_SCOPE,
   outputTokens:Number(env.AI_OUTPUT_TOKENS || 4096),
   inputCentsPerMillion:Number(env.AI_INPUT_CENTS_PER_MILLION), outputCentsPerMillion:Number(env.AI_OUTPUT_CENTS_PER_MILLION),
   structured:env.AI_STRUCTURED_OUTPUT !== 'false'};
  assert(Number.isInteger(config.outputTokens) && config.outputTokens >= 1024 && config.outputTokens <= 8192, '输出上限须为1024–8192 token');
  for (const k of ['inputCentsPerMillion','outputCentsPerMillion']) assert(Number.isSafeInteger(config[k]) && config[k] > 0 && config[k] <= 100000000, '须配置真实费率（每百万 token 的人民币分），不可使用未知或零费率启用费用控制');
  return {...config, fingerprint:sha(config), configured:!!env.AI_API_KEY, error:env.AI_API_KEY ? '' : '尚未配置服务端 AI_API_KEY'};
 } catch (error) { return {configured:false, error:error.message, scope:AI_SCOPE}; }
}
export function validatePolicy(a) {
 assert(a.provider && /^[a-f0-9]{64}$/.test(a.provider.fingerprint || ''), '缺少服务端模型配置快照');
 assert(a.scope === AI_SCOPE, '请确认当前最小数据发送范围');
 assert(Number.isInteger(a.monthlyCallLimit) && a.monthlyCallLimit >= 1 && a.monthlyCallLimit <= 300, '月调用上限须为1–300次');
 assert(Number.isInteger(a.monthlyBudgetCents) && a.monthlyBudgetCents >= 1 && a.monthlyBudgetCents <= 1000000, '月预算须为有效人民币分（最多10000元）');
 assert(typeof a.autoPurchase === 'boolean' && typeof a.autoStage === 'boolean', '自动触发设置不正确');
 return {provider:a.provider, scope:AI_SCOPE, monthlyCallLimit:a.monthlyCallLimit, monthlyBudgetCents:a.monthlyBudgetCents, autoPurchase:a.autoPurchase, autoStage:a.autoStage};
}
export const aiConsentValid = (p, engine) => {
 const policy=p.ai?.policy;
 const ids=p.members.filter(m=>m.active&&m.role==='partner').map(m=>m.id).sort();
 return !!(policy && !p.ai.suspended && engine.configured && policy.provider.fingerprint===engine.fingerprint &&
  ids.length>=2 && JSON.stringify(ids)===JSON.stringify([...policy.signerIds].sort()) && p.members.filter(m=>m.active&&m.role==='partner').every(m=>m.userId));
};
export function aiUsage(p, month=new Date().toISOString().slice(0,7)) {
 const jobs=(p.ai?.runs || []).filter(j=>j.month===month && j.status!=='cancelled');
 return {month, calls:jobs.length, budgetUsedCents:jobs.reduce((s,j)=>s+(j.chargeCents ?? j.reserveCents),0),
  inputTokens:jobs.reduce((s,j)=>s+(j.usage?.inputTokens||0),0), outputTokens:jobs.reduce((s,j)=>s+(j.usage?.outputTokens||0),0),
  unknownUsageCount:jobs.filter(j=>['completed','failed','uncertain'].includes(j.status)&&!j.usage).length};
}
