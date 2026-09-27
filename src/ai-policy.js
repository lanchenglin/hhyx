import { assert, text, sha } from './util.js';
import { AI_PROMPT_VERSION, REPORT_STYLES } from './ai-prompts.js';
export { AI_PROMPT_VERSION };
export const AI_SCOPE = 'project-minimal-v2';
export const AI_POLICY_VERSION = 2;
export const DEFAULT_AI_THRESHOLD_CENTS = 50000;
export const AI_KINDS = ['project', 'purchase', 'stage'];
export const AI_BRIEF_FIELDS = {
 context:'项目具体情况', focus:'本次希望重点分析什么',
 // Historical optional fields stay readable; they are never mandatory for a new project.
 business:'原补充说明', customers:'原受众/客户资料（如适用）', channels:'原发布/销售渠道（如适用）',
 economics:'原成本/收入假设（如适用）', validation:'已做的尝试与结果', risks:'风险及暂停安排'
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
export function validateBrief(a,previous={}) {
 const result = {};
 for (const [key, label] of Object.entries(AI_BRIEF_FIELDS)) result[key] = text(Object.hasOwn(a,key)?a[key]:previous[key], label, key==='context'?6000:2000, false);
 // Partial updates must not erase historical optional materials/scenarios.
 a={...a,scenarios:Object.hasOwn(a,'scenarios')?a.scenarios:previous.scenarios};
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
  const config = {provider, baseUrl:u.href.replace(/\/$/, ''), model, scope:AI_SCOPE, engineVersion:2,
   promptVersion:AI_PROMPT_VERSION, outputTokens:Number(env.AI_OUTPUT_TOKENS || 8192),
   structured:env.AI_STRUCTURED_OUTPUT !== 'false',
   analysisGuidance:text(env.AI_ANALYSIS_GUIDANCE,'管理员补充偏好',2000,false),
   ...(env.AI_CONFIGURATION_REVISION?{configurationRevision:env.AI_CONFIGURATION_REVISION}:{})};
  // Technical safety guard, not a visible character quota or a price requirement.
  assert(Number.isInteger(config.outputTokens) && config.outputTokens>=1024 && config.outputTokens<=32768,'服务端输出保护参数无效');
  return {...config, fingerprint:sha(config), configured:!!env.AI_API_KEY, error:env.AI_API_KEY ? '' : '尚未配置服务端 AI_API_KEY'};
 } catch (error) { return {configured:false, error:error.message, scope:AI_SCOPE}; }
}
export function validatePolicy(a) {
 assert(a.provider && /^[a-f0-9]{64}$/.test(a.provider.fingerprint || ''), '缺少服务端模型配置快照');
 assert(a.scope === AI_SCOPE, '请确认当前最小数据发送范围');
 assert(Number.isInteger(a.monthlyCallLimit) && a.monthlyCallLimit>=1 && a.monthlyCallLimit<=300, '月调用上限须为1–300次');
 const threshold=a.purchaseThresholdCents??DEFAULT_AI_THRESHOLD_CENTS;
 assert(Number.isSafeInteger(threshold)&&threshold>=0&&threshold<=100000000,'自动分析阈值须为0–100万元（人民币分）');
 const reportStyle=a.reportStyle||'concise';assert(Object.hasOwn(REPORT_STYLES,reportStyle),'报告详细程度无效');
 assert(typeof a.autoPurchase==='boolean'&&typeof a.autoStage==='boolean','自动触发设置不正确');
 return {version:AI_POLICY_VERSION,provider:a.provider,scope:AI_SCOPE,monthlyCallLimit:a.monthlyCallLimit,
  purchaseThresholdCents:threshold,reportStyle,autoPurchase:a.autoPurchase,autoStage:a.autoStage};
}
export const aiConsentValid = (p, engine) => {
 const policy=p.ai?.policy;
 const ids=p.members.filter(m=>m.active&&m.role==='partner').map(m=>m.id).sort();
 return !!((p.lifecycle||'active')==='active' && policy?.version===AI_POLICY_VERSION && !p.ai.suspended && engine.configured && policy.provider.fingerprint===engine.fingerprint &&
  ids.length>=2 && JSON.stringify(ids)===JSON.stringify([...policy.signerIds].sort()) && p.members.filter(m=>m.active&&m.role==='partner').every(m=>m.userId));
};
export function aiUsage(p, month=new Date().toISOString().slice(0,7)) {
 const jobs=(p.ai?.runs||[]).filter(j=>j.month===month);
 const active=j=>['queued','running'].includes(j.status);
 const used=j=>j.sentCalls??(j.status==='cancelled'?0:active(j)?0:1);
 // Quota counts HTTP attempts, including uncertain ones, not simply number of reports.
 const calls=jobs.reduce((n,j)=>n+(active(j)?(j.callSlots||1):used(j)),0);
 return {month,calls,actualCalls:jobs.reduce((n,j)=>n+used(j),0),reservedCalls:jobs.reduce((n,j)=>n+(active(j)?Math.max(0,(j.callSlots||1)-used(j)):0),0),
  reports:jobs.length,completed:jobs.filter(j=>j.status==='completed').length,failed:jobs.filter(j=>j.status==='failed').length,
  uncertain:jobs.filter(j=>j.status==='uncertain').length,
  inputTokens:jobs.reduce((n,j)=>n+(j.usage?.inputTokens||0),0),outputTokens:jobs.reduce((n,j)=>n+(j.usage?.outputTokens||0),0),
  unknownUsageCount:jobs.reduce((n,j)=>n+(j.unknownUsageCalls??(used(j)&&!j.usage?1:0)),0)};
}
