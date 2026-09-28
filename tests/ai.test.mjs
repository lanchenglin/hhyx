import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { publicEngine, aiUsage } from '../src/ai-policy.js';
import { buildSnapshot, scenarioMath, redact } from '../src/ai-snapshot.js';
import { validateReport, requestSpec } from '../src/ai-provider.js';
import { runAiJob, processAiJobs, requestAnalysis } from '../src/ai.js';
import { load } from '../src/store.js';
const validReport=()=>({verdict:'needs_information',summary:'根据系统资料，建议先补充试销依据，不代表已批准项目。',summaryRefs:['brief'],findings:[{id:'demand',severity:'high',basis:'missing',title:'缺少需求验证',detail:'输入没有充分的实际需求验证资料。',refs:['brief'],evidence:[],suggestion:'先补充试销记录。'}],missingInformation:[{topic:'试销结果',why:'用于检验销量假设'}],recommendations:[{title:'补充试销依据',description:'整理真实订单、退货和回款记录',deliverable:'提交有来源的试销记录',refs:['brief']}],decisions:['是否先进行小规模验证'],limitations:['未联网调查，未核验附件真实性。'],externalVerified:false});
const envConfig={AI_PROVIDER:'openai_compatible',AI_MODEL:'test-model',AI_API_KEY:'test-key-do-not-use-in-production',AI_INPUT_CENTS_PER_MILLION:'100',AI_OUTPUT_CENTS_PER_MILLION:'500'};
async function setup(options={}) {
 const f=await fixture(options);Object.assign(f.rt.env,envConfig);let calls=0,request=null;
 f.rt.env.AI_FETCH=async(url,init)=>{calls++;request={url,init};return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(validReport())}}],usage:{prompt_tokens:1000,completion_tokens:500}});};
 const approvePolicy=async(overrides={})=>{const engine=publicEngine(f.rt.env);let p=await f.owner.ok(f.base+'/ai/policy',{engineFingerprint:engine.fingerprint,confirmScope:true,monthlyCallLimit:30,monthlyBudgetCents:2000,autoPurchase:false,autoStage:false,...overrides});const id=p.proposals.at(-1).id;for(const c of f.all)p=await f.action(c,'proposal.vote',{id,decision:'approve',note:'确认模型、发送范围与费用限制'});return p;};
 const preview=async(kind='project',targetId='')=>f.owner.ok(f.base+'/ai/preview',{kind,targetId});
 const run=async(kind='project',targetId='',extra={},key)=>{const v=await preview(kind,targetId);return f.owner.ok(f.base+'/ai/runs',{kind,targetId,previewHash:v.hash,confirmSend:true,...extra},'POST',key);};
 const read=async id=>{await f.rt.settle();return f.owner.ok(`${f.base}/ai/runs/${id}`,undefined,'GET');};
 return {...f,approvePolicy,preview,run,read,get calls(){return calls;},get providerRequest(){return request;}};
}
async function use(fn,options){const f=await setup(options);try{await fn(f);}finally{await f.close();}}

test('AI项目分析、权限、预算、留痕和故障防护', async t=>{
 await t.test('默认不调用模型；必须全员确认且筹备期也可授权',()=>use(async f=>{
  const pre=await f.preview();assert.ok(pre.body.checks.length);assert.equal(pre.consented,false);
  const failed=await f.owner.request(f.base+'/ai/runs',{method:'POST',data:{kind:'project',previewHash:pre.hash,confirmSend:true}});assert.equal(failed.status,409);assert.equal(f.calls,0);
  const e=publicEngine(f.rt.env);let p=await f.owner.ok(f.base+'/ai/policy',{engineFingerprint:e.fingerprint,confirmScope:true,monthlyCallLimit:10,monthlyBudgetCents:2000,autoPurchase:false,autoStage:false});
  const id=p.proposals.at(-1).id;for(const c of f.all.slice(0,2))p=await f.action(c,'proposal.vote',{id,decision:'approve'});
  assert.equal((await f.owner.ok(f.base+'/ai',undefined,'GET')).consented,false);
  await f.action(f.all[2],'proposal.vote',{id,decision:'approve'});assert.equal((await f.owner.ok(f.base+'/ai',undefined,'GET')).consented,true);
 },{activate:false,fund:false}));
 await t.test('成功报告有冻结依据/版本/费用；不改采购或计划，审计链可校验',()=>use(async f=>{
  await f.approvePolicy();const before=(await load(f.rt.env,f.pid)).state;const r=await f.run(),report=await f.read(r.id);
  assert.equal(report.status,'completed');assert.equal(report.report.externalVerified,false);assert.equal(f.calls,1);assert.equal(report.accounting.usage.inputTokens,1000);assert.ok(report.accounting.inputRevision>0);
  const after=(await load(f.rt.env,f.pid)).state;assert.deepEqual(after.settings,before.settings);assert.deepEqual(after.purchases,before.purchases);assert.deepEqual(after.tasks,before.tasks);
  assert.equal((await f.owner.ok(f.base+'/audit/verify',undefined,'GET')).valid,true);
 }));
 await t.test('相同输入复用报告；重复幂等请求不重复付费',()=>use(async f=>{
  await f.approvePolicy();const key=crypto.randomUUID(),r=await f.run('project','',{},key);await f.read(r.id);
  const again=await f.run('project','',{},key),cached=await f.run();assert.equal(again.id,r.id);assert.equal(cached.id,r.id);assert.equal(cached.cached,true);assert.equal(f.calls,1);
 }));
 await t.test('过期预览不能发送；资料修订使旧报告过期且保留版本',()=>use(async f=>{
  await f.approvePolicy();const pre=await f.preview(),r=await f.run();await f.read(r.id);
  await f.action(f.owner,'ai.materials',{business:'新业务说明'});
  const blocked=await f.owner.request(f.base+'/ai/runs',{method:'POST',data:{kind:'project',confirmSend:true,previewHash:pre.hash}});assert.equal(blocked.status,409);
  assert.equal((await f.read(r.id)).stale,true);assert.equal(f.calls,1);
  await f.action(f.owner,'ai.materials',{business:'修订后的说明'});const p=(await load(f.rt.env,f.pid)).state;assert.equal(p.ai.briefHistory.length,1);assert.equal(p.ai.brief.version,2);
 }));
 await t.test('采购超过阶段预算由程序指出；AI不能放行，改版本后旧报告过期',()=>use(async f=>{
  await f.approvePolicy();const q=await f.createPurchase({items:[{name:'批量商品',quantity:100,unitCents:10000}]});
  const pre=await f.preview('purchase',q.id);assert.ok(pre.body.checks.some(c=>c.id==='budget-block'&&c.severity==='high'));
  const r=await f.run('purchase',q.id);await f.read(r.id);const rejected=await f.owner.request(f.base+'/actions',{method:'POST',data:{type:'purchase.submit',data:{id:q.id}}});assert.equal(rejected.status,409);
  await f.action(f.owner,'purchase.save',{...f.purchaseData(),id:q.id});assert.equal((await f.read(r.id)).stale,true);
 }));
 await t.test('跨项目报告、预览、导出和建议转任务均不可访问',()=>use(async f=>{
  await f.approvePolicy();const r=await f.run();await f.read(r.id);const other=await f.owner.ok('/api/projects',{name:'另一项目',totalBudgetCents:10000,minReserveCents:0});
  const b=`/api/projects/${other.id}`;
  assert.equal((await f.owner.request(`${b}/ai/runs/${r.id}`)).status,404);
  assert.equal((await f.all[1].request(`${b}/ai`)).status,403);
  assert.equal((await f.owner.request(`${b}/ai/runs/${r.id}/tasks`,{method:'POST',data:{confirm:true,index:0}})).status,404);
  assert.equal((await f.owner.request(`${b}/ai/preview`,{method:'POST',data:{kind:'stage',targetId:'stage-pilot'}})).status,404);
 }));
 await t.test('数据白名单与脱敏不泄露结构化账号、凭证、Webhook或密钥',()=>use(async f=>{
  await f.approvePolicy();await f.createPurchase({payee:'PRIVATE_BANK_ACCOUNT_123456789012345678',quote:'API_KEY=sk-THISISASECRET123456 https://private.test/token?a=b 联系 abc@example.com 电话 13812345678'});
  const pre=await f.preview();const text=JSON.stringify(pre.body);assert.ok(!text.includes('PRIVATE_BANK'));assert.ok(!text.includes('sk-THIS'));assert.ok(!text.includes('abc@example.com'));assert.ok(!text.includes('private.test'));assert.ok(!text.includes('13812345678'));assert.ok(!text.includes('owner@example'));
  const overview=await f.owner.ok(f.base+'/ai',undefined,'GET');assert.ok(!JSON.stringify(overview).includes(envConfig.AI_API_KEY));
 }));
 await t.test('模型配置或成员变化使原授权失效；暂停不影响原业务',()=>use(async f=>{
  await f.approvePolicy();f.rt.env.AI_MODEL='another-model';assert.equal((await f.owner.ok(f.base+'/ai',undefined,'GET')).consented,false);assert.equal((await f.owner.request(f.base+'/ai/runs',{method:'POST',data:{kind:'project'}})).status,409);f.rt.env.AI_MODEL='test-model';
  await f.action(f.all[1],'ai.suspend',{});assert.equal((await f.owner.ok(f.base+'/ai',undefined,'GET')).consented,false);assert.equal((await load(f.rt.env,f.pid)).state.status,'active');
  assert.equal(f.calls,0);
 }));
 await t.test('月调用限额拒绝新增发送，多个请求不超额预占',()=>use(async f=>{
  await f.approvePolicy({monthlyCallLimit:1});const pre=await f.preview();const payload={kind:'project',previewHash:pre.hash,confirmSend:true};
  const results=await Promise.all([1,2,3].map(()=>f.owner.request(f.base+'/ai/runs',{method:'POST',data:payload})));assert.ok(results.some(x=>x.status<300));await f.rt.settle();assert.equal(f.calls,1);
  await f.action(f.owner,'ai.materials',{business:'产生新快照'});const pr=await f.preview();const r=await f.owner.request(f.base+'/ai/runs',{method:'POST',data:{...payload,previewHash:pr.hash}});assert.equal(r.status,429);assert.equal(f.calls,1);
 }));
 await t.test('旧金额配置不再阻止调用；不捏造费用估算',()=>use(async f=>{
  await f.approvePolicy({monthlyBudgetCents:1});const pr=await f.preview();assert.equal(pr.reserveCents,undefined);
  const r=await f.owner.request(f.base+'/ai/runs',{method:'POST',data:{kind:'project',previewHash:pr.hash,confirmSend:true}});assert.ok(r.status<300);await f.rt.settle();assert.equal(f.calls,1);
 }));
 await t.test('超时状态不伪装为成功、不自动重试，已发生尝试仍计数；人工重试须确认',()=>use(async f=>{
  await f.approvePolicy();f.rt.env.AI_FETCH=async()=>{throw new DOMException('timeout','AbortError');};
  const r=await f.run(),report=await f.read(r.id);assert.equal(report.status,'uncertain');assert.equal(report.report,null);assert.equal(report.accounting.sentCalls,1);
  const pre=await f.preview();const denied=await f.owner.request(f.base+'/ai/runs',{method:'POST',data:{kind:'project',previewHash:pre.hash,confirmSend:true}});assert.equal(denied.status,409);
  const r2=await f.run('project','',{retry:true,acceptPossibleCharge:true});await f.read(r2.id);assert.notEqual(r.id,r2.id);
  assert.equal(aiUsage((await load(f.rt.env,f.pid)).state).calls,2);
 }));
 await t.test('伪造来源、截断或非法字段的模型输出不作为有效报告',()=>use(async f=>{
  await f.approvePolicy();const bad=validReport();bad.summaryRefs=['other-project-secret'];
  f.rt.env.AI_FETCH=async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(bad)}}],usage:{prompt_tokens:100,completion_tokens:100}});
  const r=await f.run(),v=await f.read(r.id);assert.equal(v.status,'failed');assert.equal(v.report,null);assert.equal(v.errorCode,'INVALID_REPORT');assert.ok(v.accounting.usage);
 }));
 await t.test('没有usage的成功报告标明用量未知，不假装免费',()=>use(async f=>{
  await f.approvePolicy();f.rt.env.AI_FETCH=async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(validReport())}}]});
  const r=await f.run(),v=await f.read(r.id);assert.equal(v.status,'completed');assert.equal(v.accounting.usage,null);assert.equal(v.accounting.chargeCents,v.accounting.reserveCents);
  assert.equal((await f.owner.ok(f.base+'/ai',undefined,'GET')).usage.unknownUsageCount,1);
 }));
 await t.test('任务建议必须人工确认、指定不同验收人；风险处置留痕且不能重复建任务',()=>use(async f=>{
  await f.approvePolicy();const r=await f.run();await f.read(r.id);const p=(await load(f.rt.env,f.pid)).state;
  assert.equal(p.tasks.length,0);const data={index:0,confirm:true,stageId:'stage-pilot',assigneeId:p.members[0].id,reviewerId:p.members[1].id,dueDate:'2026-12-01'};
  assert.equal((await f.owner.request(`${f.base}/ai/runs/${r.id}/tasks`,{method:'POST',data:{...data,confirm:false}})).status,400);
  assert.equal((await f.owner.request(`${f.base}/ai/runs/${r.id}/tasks`,{method:'POST',data:{...data,reviewerId:data.assigneeId}})).status,400);
  const created=await f.owner.ok(`${f.base}/ai/runs/${r.id}/tasks`,data);assert.equal(created.tasks.length,1);assert.equal(created.tasks[0].aiSource.runId,r.id);
  assert.equal((await f.owner.request(`${f.base}/ai/runs/${r.id}/tasks`,{method:'POST',data:{...data,confirmStale:true}})).status,409);
  await f.owner.ok(`${f.base}/ai/runs/${r.id}/reviews`,{findingId:'demand',disposition:'mitigate',note:'先做有限试销再决定扩大投入'});assert.equal((await f.read(r.id)).reviews.length,1);
  assert.equal((await f.owner.ok(f.base+'/audit/verify',undefined,'GET')).valid,true);
 }));
 await t.test('普通API不能伪造报告或代写系统审核、AI来源和授权',()=>use(async f=>{
  for(const type of ['ai.run.request','ai.run.finish','ai.review'])assert.equal((await f.owner.request(f.base+'/actions',{method:'POST',data:{type,data:{}}})).status,403);
  assert.equal((await f.owner.request(f.base+'/actions',{method:'POST',data:{type:'proposal.submit',data:{kind:'ai_policy',reason:'伪造授权',payload:{}}}})).status,403);
 }));
 await t.test('自动采购分析受已批准规则控制；报告不改变三人会签结果',()=>use(async f=>{
  await f.approvePolicy({autoPurchase:true});const q=await f.submitPurchase();await f.rt.settle();assert.equal(f.calls,1);
  const p=(await load(f.rt.env,f.pid)).state;assert.equal(p.purchases.find(x=>x.id===q.id).status,'pending');assert.deepEqual(p.purchases.find(x=>x.id===q.id).decisions,{});
  assert.equal(p.ai.runs[0].kind,'purchase');assert.equal(p.ai.runs[0].status,'completed');
 }));
 await t.test('阶段复盘有原计划和当前阶段，支持独立生成',()=>use(async f=>{
  await f.approvePolicy();const r=await f.run('stage','stage-pilot');const v=await f.read(r.id);assert.equal(v.kind,'stage');assert.ok(v.snapshot.sources.some(s=>s.id==='baseline'));assert.ok(v.snapshot.sources.some(s=>s.id==='stage:stage-pilot'));
 }));
 await t.test('报告正文及分析输入在数据库中不可直接更新或删除',()=>use(async f=>{
  await f.approvePolicy();const r=await f.run();await f.read(r.id);
  assert.throws(()=>f.rt.db.prepare('UPDATE ai_reports SET report=? WHERE job_id=?').run('{}',r.id),/ai_report_append_only/);
  assert.throws(()=>f.rt.db.prepare('DELETE FROM ai_reports WHERE job_id=?').run(r.id),/ai_report_append_only/);
  assert.throws(()=>f.rt.db.prepare('UPDATE ai_jobs SET snapshot=? WHERE id=?').run('{}',r.id),/ai_input_immutable/);
  const exp=await f.owner.ok(f.base+'/export',undefined,'GET');assert.equal(exp.schemaVersion,2);assert.equal(exp.aiManifest.length,1);
 }));
});

test('AI纯函数防护及确定性测算',async t=>{
 await t.test('场景测算使用整数分，不等同真实利润或回款',()=>{
  const r=scenarioMath({units:10,priceCents:10000,unitCostCents:6000,fixedCostCents:10000,openingCashCents:80000,upfrontCents:40000,otherCashOutCents:5000,collectionBps:5000});
  assert.equal(r.profitCents,30000);assert.equal(r.collectedCents,50000);assert.equal(r.endingCashCents,85000);assert.equal(r.breakEvenUnits,3);
  const large={units:99999999,priceCents:90000001,unitCostCents:1,fixedCostCents:3,openingCashCents:0,upfrontCents:0,otherCashOutCents:0,collectionBps:7777};
  assert.equal(scenarioMath(large).collectedCents,Number(BigInt(large.units)*BigInt(large.priceCents)*7777n/10000n));
  assert.throws(()=>scenarioMath({...large,units:100000000,unitCostCents:90071992,fixedCostCents:100000000}),/精度/);
 });
 await t.test('拒绝不安全端点但不要求域名白名单；缺失价格不影响配置',()=>{
  for(const baseUrl of ['http://localhost:123','https://127.0.0.1','https://user:pass@api.openai.com/v1','https://api.openai.com/v1?token=secret'])assert.equal(publicEngine({...envConfig,AI_BASE_URL:baseUrl}).configured,false);
  assert.equal(publicEngine({...envConfig,AI_BASE_URL:'https://gateway.example.com/v1'}).configured,true);
  assert.equal(publicEngine({...envConfig,AI_INPUT_CENTS_PER_MILLION:''}).configured,true);
 });
 await t.test('OpenAI兼容与Anthropic请求协议各自正确，且没有工具权限',()=>{
  const open=publicEngine(envConfig),a=requestSpec(open,{sources:[]},'demo');assert.ok(a.url.endsWith('/chat/completions'));assert.equal(a.body.response_format.type,'json_schema');assert.equal(a.body.tools,undefined);
  const anth=publicEngine({...envConfig,AI_PROVIDER:'anthropic'}),b=requestSpec(anth,{sources:[]},'demo');assert.ok(b.url.endsWith('/messages'));assert.equal(b.headers['anthropic-version'],'2023-06-01');assert.equal(b.body.output_config.format.type,'json_schema');assert.equal(b.body.tools,undefined);
 });
 await t.test('报告字段、来源原文与成功率不允许伪造',()=>{
  const snap={sources:[{id:'brief',data:{validation:'实际试销记录'}}]};let r=validReport();assert.equal(validateReport(r,snap),r);
  assert.throws(()=>validateReport({...r,approval:true},snap));r=validReport();r.findings[0].basis='input';r.findings[0].evidence=[{sourceId:'brief',quote:'虚构的quote'}];assert.throws(()=>validateReport(r,snap));
  r=validReport();r.summary='成功率87%';assert.throws(()=>validateReport(r,snap));
 });
});


test('AI调度恢复与授权变动回归',async t=>{
 await t.test('移除合伙人后原外发授权失效，不沿用减少人数的旧许可',()=>use(async f=>{
  await f.approvePolicy();let p=(await load(f.rt.env,f.pid)).state;
  p=await f.action(f.owner,'proposal.submit',{kind:'exit_plan',payload:{memberId:p.members[2].id,capitalCents:0,profitCents:0,reimburseCents:0,owedCents:0,shares:{[p.members[0].id]:5000,[p.members[1].id]:5000},handover:{tasks:[],purchases:[]},basis:'测试零净额退出，相关责任另列',responsibilities:'测试成员共同核对已有责任',dueDate:'2027-01-01'},reason:'全员确认成员退出清算'});
  const planId=p.proposals.at(-1).id;for(const c of f.all)await f.action(c,'proposal.vote',{id:planId,decision:'approve',acceptExit:true});
  p=await f.action(f.owner,'proposal.submit',{kind:'exit_finalize',payload:{exitId:planId,confirmation:'零净额与交接共同确认'},reason:'全体最后确认退出'});
  const id=p.proposals.at(-1).id;for(const c of f.all)await f.action(c,'proposal.vote',{id,decision:'approve'});
  assert.equal((await f.owner.ok(f.base+'/ai',undefined,'GET')).consented,false);assert.equal(f.calls,0);
 }));
 await t.test('HTTP错误不泄漏服务商原始报错或密钥，且不自动重试',()=>use(async f=>{
  await f.approvePolicy();f.rt.env.AI_FETCH=async()=>Response.json({error:'secret upstream body'}, {status:401});
  const r=await f.run(),v=await f.read(r.id);assert.equal(v.status,'failed');assert.equal(v.errorCode,'PROVIDER_HTTP_401');assert.ok(!JSON.stringify(v).includes('secret upstream body'));
 }));
 await t.test('阶段验收自动分析仅在全员通过后触发一次',()=>use(async f=>{
  await f.approvePolicy({autoStage:true});let p=await f.action(f.owner,'proposal.submit',{kind:'stage_close',payload:{stageId:'stage-pilot',evidence:'本阶段验收资料已提交'},reason:'完成阶段验收'});
  const id=p.proposals.at(-1).id;for(const c of f.all.slice(0,2))await f.action(c,'proposal.vote',{id,decision:'approve'});await f.rt.settle();assert.equal(f.calls,0);
  await f.action(f.all[2],'proposal.vote',{id,decision:'approve'});await f.rt.settle();assert.equal(f.calls,1);assert.equal((await load(f.rt.env,f.pid)).state.ai.runs[0].kind,'stage');
 }));
 await t.test('已排队请求在发送前重新检查撤销授权，不调用模型并释放预占',()=>use(async f=>{
  await f.approvePolicy();const pre=await f.preview();const job=await requestAnalysis(f.rt.env,f.pid,f.owner.user,{kind:'project',previewHash:pre.hash,confirmSend:true},crypto.randomUUID());
  await f.action(f.all[1],'ai.suspend',{});await runAiJob(f.rt.env,job.id);const r=await f.read(job.id);assert.equal(r.status,'cancelled');assert.equal(f.calls,0);assert.equal(r.accounting.chargeCents,0);
 }));
 await t.test('两个执行器并发处理同一任务，只能领取并发送一次',()=>use(async f=>{
  await f.approvePolicy();const pre=await f.preview();const job=await requestAnalysis(f.rt.env,f.pid,f.owner.user,{kind:'project',previewHash:pre.hash,confirmSend:true},crypto.randomUUID());
  await Promise.all([runAiJob(f.rt.env,job.id),runAiJob(f.rt.env,job.id)]);assert.equal(f.calls,1);assert.equal((await f.read(job.id)).status,'completed');
 }));
 await t.test('进程中断的租约由调度器收敛为不确定，不重复发送或清零已发生尝试',()=>use(async f=>{
  await f.approvePolicy();const pre=await f.preview();const job=await requestAnalysis(f.rt.env,f.pid,f.owner.user,{kind:'project',previewHash:pre.hash,confirmSend:true},crypto.randomUUID());
  f.rt.db.prepare("UPDATE ai_jobs SET status='running',lease_until=0 WHERE id=?").run(job.id);
  await processAiJobs(f.rt.env);await processAiJobs(f.rt.env);const r=await f.read(job.id);assert.equal(r.status,'uncertain');assert.equal(r.errorCode,'INTERRUPTED');assert.equal(r.accounting.sentCalls,1);assert.equal(f.calls,0);
 }));
});
