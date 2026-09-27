import {purchaseAnalysisDecision} from './purchase-analysis.js';
import { assert, sha } from './util.js';
import { finance, purchaseTotal, paid, budgetCheck } from './domain.js';
import { AI_PROMPT_VERSION, scenarioMath } from './ai-policy.js';
// This is a whitelist, not a project export. Structured identity/account/secret fields
// and raw attachments/chat/audit are excluded. Free text still requires user review.
export function redact(value) {
 return String(value ?? '').replace(/https?:\/\/[^\s<>"']+/gi,'[链接未外传]')
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[邮箱已隐去]')
  .replace(/(?:\+?\d[\d ()-]{8,}\d)/g,'[号码已隐去]')
  .replace(/\b(?:sk-|sk_|AKIA|ghp_|github_pat_)[A-Za-z0-9_-]{8,}\b/g,'[密钥已隐去]')
  .replace(/((?:api[_ -]?key|token|secret|password|密码|口令|密钥|账户|账号)\s*[:：=]\s*)[^\s,，;；]+/gi,'$1[已隐去]');
}
export { scenarioMath };
export function buildSnapshot(p,kind,targetId='',at=new Date().toISOString()) {
 assert(['project','purchase','stage'].includes(kind),'分析类型不正确');
 const target=kind==='purchase'?p.purchases.find(q=>q.id===targetId):kind==='stage'?p.stages.find(s=>s.id===targetId):null;
 assert(kind==='project'||target,'分析对象不属于当前项目',404);
 assert(kind!=='project'||!targetId,'项目分析不应带其他对象编号');
 const sources=[]; const add=(id,label,data)=>sources.push({id,label,data});
 const mapping=new Map(p.members.map((m,i)=>[m.id,`成员${i+1}`]));
 const clean=v=>JSON.parse(JSON.stringify(v,(_k,x)=>typeof x==='string'?redact(x):x));
 add('project','当前项目计划',{description:redact(p.description),status:p.status,totalBudgetCents:p.settings.totalBudgetCents,minReserveCents:p.settings.minReserveCents,terms:redact(p.settings.terms),approvalRule:p.settings.approvalRule});
 add('baseline','原批准基准（没有则为空）',p.baseline?clean({description:p.baseline.description,settings:p.baseline.settings,stages:p.baseline.stages.map(s=>({id:s.id,name:s.name,goal:s.goal,acceptance:s.acceptance,budgetCents:s.budgetCents,endDate:s.endDate}))}):null);
 add('members','当前分工角色（匿名）',p.members.filter(m=>m.active).map(m=>({ref:mapping.get(m.id),role:m.role,joined:!!m.userId,shareBps:m.shareBps})));
 add('brief','成员提交的分析补充资料，未经外部核实',clean(p.ai?.brief?.data||{}));
 const f=finance(p);add('finance','程序计算的内部管理账摘要（不是银行实时余额）',f);
 assert(p.stages.length<=100&&p.tasks.length<=200&&p.purchases.length<=150&&p.ledger.length<=500,'项目记录超过本版分析范围；不会静默截断，请分期归档或升级分段分析',413);
 for(const s of p.stages) add(`stage:${s.id}`,'阶段：'+redact(s.name),clean({id:s.id,name:s.name,status:s.status,goal:s.goal,acceptance:s.acceptance,budgetCents:s.budgetCents,startDate:s.startDate,endDate:s.endDate,evidence:s.evidence||''}));
 for(const t of p.tasks) add(`task:${t.id}`,'任务：'+redact(t.title),clean({title:t.title,stageId:t.stageId,status:t.status,description:t.description,deliverable:t.deliverable,dueDate:t.dueDate,assignee:mapping.get(t.assigneeId),reviewer:mapping.get(t.reviewerId),updates:t.updates.slice(-3).map(u=>({at:u.at,status:u.status,note:u.note}))}));
 for(const q of p.purchases) add(`purchase:${q.id}`,'采购：'+redact(q.title),clean({id:q.id,title:q.title,version:q.version,status:q.status,stageId:q.stageId,category:q.category,purpose:q.purpose||'other',commitmentGroup:q.commitmentGroup||'',items:q.items,totalCents:purchaseTotal(q),paidCents:paid(p,q),supplierGroup:sha(q.supplier).slice(0,12),reason:q.reason,risk:q.risk,exitPlan:q.exitPlan,quote:q.quote,paymentTerms:q.paymentTerms,expiresAt:q.expiresAt,ordered:!!q.order,receipts:q.receipts.map(r=>({at:r.at,quantities:r.quantities||[],exception:r.exception||''}))}));
 add('ledger','账目金额与复核状态（不发送凭证或个人账户）',p.ledger.map(x=>({id:x.id,kind:x.kind,amountCents:x.amountCents,verified:!!x.verifiedBy,unauthorized:!!x.unauthorized,stageId:x.stageId||null,purchaseId:x.purchaseId||null,at:x.at})));
 const asOfDay=at.slice(0,10);
 const checks=[]; const check=(id,severity,title,detail,refs)=>checks.push({id,severity,title,detail,refs,origin:'rule'});
 if(!p.baseline)check('no-baseline','warning','尚未共同批准基准计划','分析不是项目批准；正式执行仍需全体合伙人确认。',['baseline']);
 if(f.availableCents<0)check('cash-gap','high','内部可安排资金为负','按已登记现金、采购承诺和最低保留资金计算；先核对未入账业务。',['finance']);
 if(f.unverifiedCount)check('unverified','warning','存在未复核账目',`有${f.unverifiedCount}笔账目未独立复核，流入不能直接视为可用资金。`,['finance']);
 if(f.unauthorized)check('unauthorized','high','存在未经事前批准的真实支出','应如实对账并共同处理，不得删除记录掩盖支出。',['finance']);
 if(!f.lastReconciledAt)check('no-reconcile','warning','尚无共同对账记录','当前账目不是实时银行余额。',['finance']);
 if(!p.description&&!p.ai?.brief?.data?.context&&!p.ai?.brief?.data?.business)check('missing-context','warning','项目情况尚未说明','用一段话说明准备做什么即可，未知和不适用内容可以不填。',['project','brief']);
 for(const t of p.tasks.filter(t=>t.status!=='done'&&t.dueDate&&t.dueDate<asOfDay))check('overdue-'+t.id,'warning','任务已逾期',redact(t.title),[`task:${t.id}`]);
 let purchaseAssessment=null;
 if(kind==='purchase') {
  purchaseAssessment=purchaseAnalysisDecision(p,target,at);add('purchase-assessment','本地金额分级（不是批准）',purchaseAssessment);
  check('analysis-triage',purchaseAssessment.anomaly?'warning':'info',purchaseAssessment.reason,`本次总额 ${purchaseAssessment.amountCents} 分；阈值 ${purchaseAssessment.thresholdCents} 分；相关累计 ${purchaseAssessment.cumulativeCents} 分。手动分析不限金额。`,['purchase-assessment']);
  try{budgetCheck(p,target);check('budget-pass','info','当前程序预算检查通过','仅说明金额和阶段条件满足，不表示采购必要性合理或已获批准。',['finance',`purchase:${target.id}`,`stage:${target.stageId}`]);}
  catch(error){check('budget-block','high','当前预算/阶段规则不满足',error.message,['finance',`purchase:${target.id}`,`stage:${target.stageId}`]);}
  if(target.expiresAt<asOfDay)check('purchase-expired','high','采购申请已过期','需要修订并重新会签。',[`purchase:${target.id}`]);
  if(p.purchases.some(q=>q.id!==target.id&&q.supplier===target.supplier&&q.stageId===target.stageId&&['pending','approved','ordered'].includes(q.status)))check('split','warning','同阶段同供应商存在其他采购','共同复核累计规模，不能通过拆单绕过预算。',[`purchase:${target.id}`]);
 }
 const scenarios=(p.ai?.brief?.data?.scenarios||[]).map(scenarioMath);
 add('scenarios','程序场景测算：仅为成员填写的假设',scenarios);
 const body={schemaVersion:1,promptVersion:AI_PROMPT_VERSION,reportStyle:p.ai?.policy?.reportStyle||'concise',kind,targetId,asOfDay,sources,checks,
  limits:['仅分析已登记资料；未录入不等于未发生。','未联网调查市场、价格或政策；未识别附件内容。','资料可能含错误；来源引用不等于原始事实已核实。','不预测成功概率，不评价合伙人人格，不代替会签或实际付款复核。','任务仅含最近三次进度摘要；金额由程序计算。']};
 const encoded=JSON.stringify(body);assert(new TextEncoder().encode(encoded).length<=80000,'待发送数据超过80KB，未调用模型；不会静默截断',413);
 return {body,hash:sha(body),targetVersion:kind==='purchase'?target.version:null};
}
