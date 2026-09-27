import {resolveAiEnv} from './system-config.js';
import { assert, AppError, body, json, now, sha } from './util.js';
import { load, one, rows, mutate } from './store.js';
import { partner, getMember } from './domain.js';
import { publicEngine, aiConsentValid, aiUsage, AI_SCOPE } from './ai-policy.js';
import { buildSnapshot } from './ai-snapshot.js';
import { reserveEstimate, invokeProvider } from './ai-provider.js';
import { requireReauth, rateLimit } from './auth.js';
const pending=['queued','running'];
const keyOf=req=>req.headers.get('x-idempotency-key');
const conditional=(env,sql,args,pid,op)=>env.DB.prepare(sql+' WHERE EXISTS(SELECT 1 FROM projects WHERE id=? AND last_operation=?)').bind(...args,pid,op);
const system={id:'system:ai',name:'AI任务服务'};
function currentHash(state,job){try{return buildSnapshot(state,job.kind,job.target_id||job.targetId).hash;}catch{return null;}}
function publicJob(j,state){return {id:j.id,kind:j.kind,targetId:j.target_id,status:j.status,createdAt:j.created_at,finishedAt:j.finished_at,error:j.error,errorCode:j.error_code,snapshotHash:j.snapshot_hash,stale:currentHash(state,j)!==j.snapshot_hash};}
export async function aiOverview(env,pid,state,offset=0) {
 env=await resolveAiEnv(env);
 const engine=publicEngine(env);const items=await rows(env,'SELECT * FROM ai_jobs WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?',pid,offset);
 const count=await one(env,'SELECT COUNT(*) AS n FROM ai_jobs WHERE project_id=?',pid);
 return {engine,consented:aiConsentValid(state,engine),policy:state.ai?.policy||null,suspended:!!state.ai?.suspended,
  usage:aiUsage(state),runs:items.map(j=>({...publicJob(j,state),accounting:(state.ai?.runs||[]).find(x=>x.id===j.id)})),total:count.n,nextOffset:offset+items.length<count.n?offset+items.length:null,
  scope:AI_SCOPE,scopeNotice:'仅发送预览中的匿名分工、计划、金额摘要、采购理由和补充资料；不发送账号、联系方式、付款凭证、原附件、API密钥、完整审计或聊天。自由文本仍可能含隐私，请先检查预览。未联网核查市场。',
  budgetNotice:'UTC自然月；费用依据服务端人工配置的人民币费率估算，不是服务商账单。未知计费保留预占，应用额度不能代替服务商预算限制。'};
}
export async function requestAnalysis(env,pid,actor,a,key,{automatic=false}={}) {
 env=await resolveAiEnv(env);
 assert(typeof key==='string'&&/^[a-zA-Z0-9_-]{12,100}$/.test(key),'缺少有效幂等键');
 const id=sha(`${pid}:${actor.id}:${key}`).slice(0,32),requestHash=sha(a);
 const {row,state}=await load(env,pid);const member=getMember(state,actor);
 assert(member.role==='partner'||(automatic&&member.role==='operator'),'只有合伙人可手动请求分析',403);
 const existing=(state.ai?.runs||[]).find(j=>j.id===id);
 if(existing){assert(existing.requestHash===requestHash,'同一请求标识不能用于不同分析',409);return {id,cached:true,status:existing.status};}
 const engine=publicEngine(env);assert(engine.configured,engine.error||'模型未配置',503);
 assert(aiConsentValid(state,engine),'外部AI尚未全员确认当前配置，或已暂停；未发送数据',409);
 const kind=a.kind,targetId=a.targetId||'',snapshot=buildSnapshot(state,kind,targetId);
 if(!automatic)assert(a.previewHash===snapshot.hash&&a.confirmSend===true,'请先查看当前数据预览并明确确认发送；资料变化后需重新预览',409);
 const same=(state.ai?.runs||[]).filter(j=>j.snapshotHash===snapshot.hash&&j.engineFingerprint===engine.fingerprint);
 const good=same.findLast(j=>['completed','queued','running'].includes(j.status));
 if(good)return {id:good.id,cached:true,status:good.status};
 const prior=same.findLast(j=>['failed','uncertain'].includes(j.status));
 assert(!prior||(!automatic&&a.retry===true&&a.acceptPossibleCharge===true),'相同输入已有失败/不确定调用；请核对记录并确认再次调用可能计费，系统不会自动重试',409);
 const record={id,kind,targetId,inputRevision:row.revision,targetVersion:snapshot.targetVersion,snapshotHash:snapshot.hash,engineFingerprint:engine.fingerprint,requestHash,reserveCents:reserveEstimate(engine,snapshot.body),automatic};
 await mutate(env,pid,actor,{type:'ai.run.request',data:record},key,{aiVerified:true,aiEngine:engine,requiredRevision:row.revision,extraStatements:(e,pid,op)=>[
  conditional(e,"INSERT INTO ai_jobs(id,project_id,actor_id,kind,target_id,snapshot_hash,snapshot,engine,status,created_at) SELECT ?,?,?,?,?,?,?,?,'queued',?",[id,pid,actor.id,kind,targetId,snapshot.hash,JSON.stringify(snapshot.body),JSON.stringify(engine),now()],pid,op)
 ]});
 return {id,cached:false,status:'queued'};
}
async function finishRun(env,j,result) {
 const {state}=await load(env,j.project_id),record=(state.ai?.runs||[]).find(x=>x.id===j.id);
 if(!record||!pending.includes(record.status))return;
 const reportHash=result.report?sha(result.report):null;
 // Unknown usage conservatively keeps the whole estimate; known usage never silently erases uncertainty.
 const chargeCents=result.status==='cancelled'?0:result.usage?.estimateCents??record.reserveCents;
 const data={id:j.id,status:result.status,errorCode:result.errorCode||null,error:result.error||null,usage:result.usage||null,chargeCents,reportHash};
 await mutate(env,j.project_id,system,{type:'ai.run.finish',data},'ai_finish_'+j.id,{aiSystemVerified:true,extraStatements:(e,pid,op)=>[
  e.DB.prepare('UPDATE ai_jobs SET status=?,finished_at=?,error_code=?,error=?,lease_until=0 WHERE id=? AND project_id=? AND EXISTS(SELECT 1 FROM projects WHERE id=? AND last_operation=?)').bind(data.status,now(),data.errorCode,data.error,j.id,pid,pid,op),
  ...(result.report?[conditional(e,'INSERT INTO ai_reports(job_id,project_id,report,report_hash,created_at) SELECT ?,?,?,?,?',[j.id,pid,JSON.stringify(result.report),reportHash,now()],pid,op)]:[])
 ]});
}
export async function runAiJob(env,id) {
 const claim=await env.DB.prepare("UPDATE ai_jobs SET status='running',lease_until=? WHERE id=? AND status='queued'").bind(Date.now()+60000,id).run();
 if(!claim.meta.changes)return;
 const j=await one(env,'SELECT * FROM ai_jobs WHERE id=?',id);
 const {state}=await load(env,j.project_id);
 try{env=await resolveAiEnv(env);}catch{await finishRun(env,j,{status:'cancelled',errorCode:'AI_CONFIG_ERROR',error:'发送前配置不可用，未调用模型。'});return;}
 const engine=publicEngine(env);const account=await one(env,'SELECT disabled,must_change_password FROM users WHERE id=?',j.actor_id);
 const allowed=account&&!account.disabled&&!account.must_change_password&&aiConsentValid(state,engine)&&state.members.some(m=>m.active&&m.userId===j.actor_id);
 if(!allowed||currentHash(state,j)!==j.snapshot_hash||engine.fingerprint!==JSON.parse(j.engine).fingerprint) {
  await finishRun(env,j,{status:'cancelled',errorCode:'INPUT_OR_CONSENT_CHANGED',error:'发送前资料、成员或授权发生变化，已取消，未调用模型。'});return;
 }
 const result=await invokeProvider(env,engine,JSON.parse(j.snapshot));
 await finishRun(env,j,result);
}
export async function processAiJobs(env) {
 const expired=await rows(env,"SELECT * FROM ai_jobs WHERE status='running' AND lease_until<? LIMIT 5",Date.now());
 for(const j of expired)await finishRun(env,j,{status:'uncertain',errorCode:'INTERRUPTED',error:'运行中断，服务商是否计费不确定；没有有效分析，不自动重试。'});
 // One bounded provider call per cron invocation. Multiple cron/HTTP invocations use a DB claim.
 const queued=await one(env,"SELECT id FROM ai_jobs WHERE status='queued' ORDER BY created_at LIMIT 1");
 if(queued)await runAiJob(env,queued.id);
}
export async function autoAnalysis(env,pid,actor,action) {
 env=await resolveAiEnv(env);
 const {state}=await load(env,pid),policy=state.ai?.policy;
 if(!policy||!aiConsentValid(state,publicEngine(env)))return;
 let kind,targetId;
 if(action.type==='purchase.submit'&&policy.autoPurchase){kind='purchase';targetId=action.data.id;}
 if(action.type==='proposal.vote'&&policy.autoStage){const g=state.proposals.find(x=>x.id===action.data.id);if(g?.status==='approved'&&['stage_open','stage_close'].includes(g.kind)){kind='stage';targetId=g.payload.stageId;}}
 if(!kind)return;
 try{
  const h=buildSnapshot(state,kind,targetId).hash;
  const v=await requestAnalysis(env,pid,actor,{kind,targetId},'ai_auto_'+sha(kind+targetId+h).slice(0,48),{automatic:true});
  if(v.status==='queued')await runAiJob(env,v.id);
 }catch(error){if(!(error instanceof AppError))throw error;
  // Visible explanation, deduped per triggering event. A blocked AI trigger never changes a business approval.
  const token=sha(`${pid}:ai-auto:${action.type}:${action.data.id}:${state.purchases.find(q=>q.id===targetId)?.version||''}:${error.message}`);
  await env.DB.prepare("INSERT OR IGNORE INTO notifications(id,project_id,user_id,title,body,target,severity,created_at) VALUES(?,?,?,'自动AI分析未启动',?,'ai','warning',?)").bind(token,pid,actor.id,error.message,now()).run();
 }
}
export async function getReport(env,pid,id,state) {
 const job=await one(env,'SELECT * FROM ai_jobs WHERE id=? AND project_id=?',id,pid);assert(job,'分析不存在或不属于本项目',404);
 const report=await one(env,'SELECT * FROM ai_reports WHERE job_id=? AND project_id=?',id,pid);
 const data=report?JSON.parse(report.report):null;
 const record=(state.ai?.runs||[]).find(x=>x.id===id);
 assert(record&&sha(JSON.parse(job.snapshot))===job.snapshot_hash&&record.snapshotHash===job.snapshot_hash,'分析输入一致性校验失败',409);
 assert(!report||(sha(data)===report.report_hash&&record.reportHash===report.report_hash),'报告一致性校验失败',409);
 return {...publicJob(job,state),snapshot:JSON.parse(job.snapshot),engine:JSON.parse(job.engine),report:data,reportHash:report?.report_hash||null,
  accounting:(state.ai?.runs||[]).find(x=>x.id===id),reviews:(state.ai?.reviews||[]).filter(x=>x.runId===id),linkedTasks:state.tasks.filter(t=>t.aiSource?.runId===id)};
}
export async function aiRoute(req,env,ctx,{pid,state,user,session,sub,url}) {
 env=await resolveAiEnv(env);
 const method=req.method;
 if(sub==='ai'&&method==='GET')return json(await aiOverview(env,pid,state,Math.max(0,Math.min(10000,Number.parseInt(url.searchParams.get('offset')||'0',10)||0))));
 if(sub==='ai/preview'&&method==='POST') {
  partner(state,user);const a=await body(req),snapshot=buildSnapshot(state,a.kind,a.targetId||'');
  const engine=publicEngine(env);return json({...snapshot,reserveCents:engine.configured?reserveEstimate(engine,snapshot.body):null,engine,consented:aiConsentValid(state,engine)});
 }
 if(sub==='ai/policy'&&method==='POST') {
  requireReauth(session);partner(state,user);const a=await body(req),engine=publicEngine(env);
  assert(engine.configured,engine.error||'请先配置服务端模型',503);
  assert(a.confirmScope===true&&a.engineFingerprint===engine.fingerprint,'请阅读发送范围并确认当前模型配置',409);
  const payload={provider:engine,scope:AI_SCOPE,monthlyCallLimit:a.monthlyCallLimit,monthlyBudgetCents:a.monthlyBudgetCents,autoPurchase:a.autoPurchase,autoStage:a.autoStage};
  return json(await mutate(env,pid,user,{type:'proposal.submit',data:{kind:'ai_policy',payload,reason:'确认外部AI发送范围、模型、费用额度及触发规则（不授予审批权）'}},keyOf(req),{aiPolicyVerified:true}));
 }
 if(sub==='ai/runs'&&method==='POST') {
  requireReauth(session);partner(state,user);await rateLimit(env,`ai:${pid}:${user.id}`,20,3600);
  const a=await body(req),result=await requestAnalysis(env,pid,user,a,keyOf(req));
  if(result.status==='queued')ctx.waitUntil(runAiJob(env,result.id).catch(()=>{}));
  return json(result,result.cached?200:202);
 }
 const m=sub.match(/^ai\/runs\/([a-f0-9]{32})(?:\/(tasks|reviews|export))?$/);
 if(m) {
  const report=await getReport(env,pid,m[1],state);
  if(method==='GET'&&(!m[2]||m[2]==='export'))return json(report,200,m[2]?{'Content-Disposition':`attachment; filename="ai-${m[1]}.json"`}:{});
  if(method==='POST'&&m[2]==='reviews') {
   partner(state,user);requireReauth(session);const a=await body(req);
   assert(report.report?.findings.some(f=>f.id===a.findingId),'风险条目不存在');
   assert(['supplement','mitigate','accept_risk'].includes(a.disposition),'请选择补充依据、采取措施或知情接受风险');
   return json(await mutate(env,pid,user,{type:'ai.review',data:{runId:m[1],findingId:a.findingId,disposition:a.disposition,note:a.note}},keyOf(req),{aiReviewVerified:true}));
  }
  if(method==='POST'&&m[2]==='tasks') {
   partner(state,user);requireReauth(session);const a=await body(req);
   assert(a.confirm===true,'必须人工确认任务');assert(!report.stale||a.confirmStale===true,'原报告已过期，请核对当前情况后再确认任务',409);
   assert(Number.isInteger(a.index)&&a.index>=0,'任务建议编号无效');const r=report.report?.recommendations[a.index];assert(r,'任务建议不存在');
   const data={title:a.title||r.title,description:a.description??r.description,deliverable:a.deliverable||r.deliverable,stageId:a.stageId,assigneeId:a.assigneeId,reviewerId:a.reviewerId,dueDate:a.dueDate,aiSource:{runId:m[1],index:a.index,reportHash:report.reportHash}};
   return json(await mutate(env,pid,user,{type:'task.add',data},keyOf(req),{aiTaskVerified:true}));
  }
 }
 throw new AppError('AI接口不存在或方法不支持',404);
}
