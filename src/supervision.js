// Cooperation supervision. Pure domain functions: no model calls, payments or authentication changes.
import {assert, text, cents, date, sha} from './util.js';

export const SUPERVISION_ACTIONS = {
  'report.submit':'提交简短汇报与成果快照', 'report.read':'确认汇报已阅（非批准）',
  'report.review':'独立验收阶段成果', 'funding.receipt':'登记追加投入实际到账',
  'funding.link':'关联已有到账记录', 'issue.create':'建立异常处理事项',
  'issue.respond':'提交异常原因与处理安排', 'issue.resolve':'提交异常处理结果',
  'issue.review':'复核异常处理结果', 'supervision.sync':'生成监督异常与升级提醒'
};
export const SUPERVISION_PROPOSALS = ['supervision_policy','plan_change','funding_request','funding_cancel'];
const allowedStatuses = new Set(['pending','approved','ordered','received']);
const cashSigns = {contribution:1,revenue:1,loan_in:1,receivable_collection:1,refund_in:1,exit_receipt:1,operating_expense:-1,loan_repayment:-1,payable_payment:-1,purchase_payment:-1,distribution:-1,exit_payment:-1};
const members = p => p.members.filter(m => m.active && m.userId);
const partners = p => members(p).filter(m => m.role === 'partner');
const total = q => q.items.reduce((n,x) => n + x.quantity*x.unitCents,0);
const records = p => p.supervision || {reports:[],issues:[],fundings:[],changes:[]};
const init = p => p.supervision ||= {reports:[],issues:[],fundings:[],changes:[]};
const find = (list,id,name) => {const v=list.find(x=>x.id===id);assert(v,`${name}不存在`,404);return v;};
const clone = v => structuredClone(v);
export const supervisionDay = (at=new Date().toISOString(),tz='Asia/Shanghai') => new Intl.DateTimeFormat('sv-SE',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
export const plusDate = (day,n) => new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const ageDays = (day,today) => Math.max(0,Math.floor((Date.parse(today)-Date.parse(day))/86400000));
const atDay = at => supervisionDay(at);
function eligible(p,id,role='worker') {
  const m=members(p).find(x=>x.id===id && (role==='partner'?x.role==='partner':x.role!=='viewer'));
  assert(m,role==='partner'?'请选择已加入的合伙人':'请选择已加入的可执行成员');return m;
}
function evidenceIds(p,list) {
  assert(list==null || Array.isArray(list)&&list.length<=20,'附件列表无效');
  const ids=[...new Set(list||[])];assert(ids.every(id=>typeof id==='string'&&p.attachments.some(f=>f.id===id)),'附件不属于本项目或尚未上传');return ids;
}
function countGuard(list,max,name) {assert(list.length<max,`${name}达到当前项目容量上限，请导出后安排下一期项目，不会删除历史`,409);}
export function planState(p) {
  return {description:p.description,settings:p.settings,
    members:p.members.map(m=>({id:m.id,userId:m.userId,role:m.role,active:m.active,shareBps:m.shareBps})),
    stages:p.stages.map(s=>({id:s.id,name:s.name,goal:s.goal,acceptance:s.acceptance,startDate:s.startDate,endDate:s.endDate,budgetCents:s.budgetCents,status:s.status})),
    tasks:p.tasks.map(t=>({id:t.id,title:t.title,description:t.description,deliverable:t.deliverable,stageId:t.stageId,assigneeId:t.assigneeId,reviewerId:t.reviewerId,dueDate:t.dueDate}))};
}
export function stageBasis(p,stageId) {
  return sha({stage:p.stages.find(s=>s.id===stageId),tasks:p.tasks.filter(t=>t.stageId===stageId),
    purchases:p.purchases.filter(q=>q.stageId===stageId).map(q=>({id:q.id,version:q.version,status:q.status,items:q.items,order:q.order,receipts:q.receipts})),
    ledger:p.ledger,members:planState(p).members});
}
function fundingBasis(p) {
  return sha({plan:planState(p),ledger:p.ledger,tasks:p.tasks,reports:records(p).reports.map(r=>({id:r.id,review:r.review||null})),
    purchases:p.purchases.map(q=>({id:q.id,version:q.version,status:q.status,order:q.order})),fundings:records(p).fundings});
}
export function fundingProgress(p,f) {
  const allocations=f.allocations.map(a=>{
    const entries=p.ledger.filter(e=>e.fundingId===f.id&&e.fundingMemberId===a.memberId);
    const reportedCents=entries.reduce((n,e)=>n+e.amountCents,0);
    const verifiedCents=entries.reduce((n,e)=>n+(e.verifiedBy?e.amountCents:Math.min(0,e.amountCents)),0);
    return {...a,reportedCents,verifiedCents,remainingCents:Math.max(0,a.amountCents-reportedCents),entryIds:entries.map(e=>e.id)};
  });
  const receivedCents=allocations.reduce((n,a)=>n+a.verifiedCents,0);
  return {...f,allocations,receivedCents,reportedCents:allocations.reduce((n,a)=>n+a.reportedCents,0),
    progress:f.status==='cancelled'?'cancelled':receivedCents>=f.additionalCents?'funded':receivedCents>0?'partial':'waiting'};
}
export function reportDeadline(p) {
  const s=records(p),policy=s.policy;if(!policy?.enabled)return null;
  const latest=s.reports.filter(r=>r.authorId===policy.reporterId&&r.at>=policy.effectiveAt).slice().sort((a,b)=>a.toDate.localeCompare(b.toDate)||a.at.localeCompare(b.at)).at(-1);
  return latest?plusDate(latest.toDate,policy.intervalDays):policy.firstDueDate;
}
export function supervisionAlerts(p,today=supervisionDay()) {
  if((p.lifecycle||'active')!=='active'||!['active','paused'].includes(p.status))return [];
  const s=records(p),policy=s.policy,out=[];
  const add=(key,title,detail,severity,sourceType,sourceId,version='')=>out.push({key,title,detail,severity,sourceType,sourceId,fingerprint:sha({key,version})});
  const due=reportDeadline(p);
  if(due&&due<today)add('report:'+due,'简短汇报已逾期',`应于${due}提交。没有更新不代表没有问题。`,'warning','reports','',due);
  for(const t of p.tasks.filter(t=>t.status!=='done'&&t.dueDate&&t.dueDate<today))add('task:'+t.id,'任务延期：'+t.title,`原定${t.dueDate}完成，当前${t.status}。`,'warning','task',t.id,t.dueDate);
  for(const st of p.stages.filter(st=>st.status==='open'&&st.endDate&&st.endDate<today))add('stage:'+st.id,'阶段尚未验收：'+st.name,`原定${st.endDate}，请说明进度或提出变更。`,'warning','stage',st.id,st.endDate);
  for(const e of p.ledger.filter(e=>e.unauthorized&&e.amountCents>0))add('ledger:'+e.id,'未经批准的支出待处理',e.description,'critical','ledger',e.id,e.id);
  if(policy?.enabled) {
    const last=p.reconciliations.at(-1)?.at;
    const base=last?atDay(last):atDay(policy.effectiveAt),limit=plusDate(base,policy.reconcileDays);
    if(limit<today)add('reconcile:'+base,last?'真实资金对账已过期':'尚未完成首次真实资金对账',`最近对账：${last||'无'}；账目登记不代表已与真实账户核对。`,'warning','finance','',base);
    for(const r of s.reports.filter(r=>r.kind==='stage'&&!r.review&&stageReport(p,r.stageId)?.id===r.id&&plusDate(atDay(r.at),policy.escalateDays)<today))add('review:'+r.id,'阶段成果等待独立验收',`汇报提交于${atDay(r.at)}，阅读不等于验收。`,'warning','report',r.id,r.id);
  }
  for(const f of s.fundings.filter(f=>f.status!=='cancelled'&&f.reviewDate<today)) {
    if(fundingProgress(p,f).receivedCents<f.additionalCents)add('funding:'+f.id,'追加投入未足额核实到账',`复盘日期${f.reviewDate}已到，批准预算不等于资金已经到账。`,'warning','funding',f.id,f.id);
    if(!s.reports.some(r=>(r.fundingIds||[]).includes(f.id)&&r.toDate>=f.reviewDate))add('funding-review:'+f.id,'追加投入到期，验证结果尚未汇报',`应于${f.reviewDate}复盘：${f.validation}。到账不等于验证成功。`,'warning','funding',f.id,f.id);
  }
  return out;
}
export function supervisionHolds(p,today=supervisionDay()) {
  const s=records(p),policy=s.policy;if(!policy?.enabled)return [];
  const alerts=supervisionAlerts(p,today),holds=[];
  if(policy.blockCritical) {
    for(const i of s.issues.filter(i=>i.severity==='critical'&&i.status!=='closed'))holds.push({key:'issue:'+i.id,message:'重要异常未复核关闭：'+i.title});
    for(const a of alerts.filter(a=>a.severity==='critical'))if(!s.issues.some(i=>i.sourceKey===a.key&&i.sourceFingerprint===a.fingerprint))holds.push({key:a.key,message:a.title+'（尚未建立处理单）'});
  }
  const due=reportDeadline(p);if(policy.blockStaleReport&&due&&plusDate(due,policy.escalateDays)<today)holds.push({key:'stale-report',message:'汇报超过约定宽限期，请提交真实进展；不会阻止记录已有账目'});
  return holds;
}
export function assertNewCommitment(p,today=supervisionDay()) {
  const holds=supervisionHolds(p,today);assert(!holds.length,holds.map(x=>x.message).join('；'),409,'SUPERVISION_HOLD');
}
function workSnapshot(p,financial,stageId,from,to) {
  const inPeriod=e=>{const d=atDay(e.at);return d>=from&&d<=to;};
  const entries=p.ledger.filter(inPeriod),stage=p.stages.find(s=>s.id===stageId);
  return {capturedAt:new Date().toISOString(),stage:clone(stage),finance:clone(financial),
    period:{from,to,reportedOutCents:entries.reduce((n,e)=>n+((cashSigns[e.kind]||0)<0?e.amountCents:0),0),
      reportedInCents:entries.reduce((n,e)=>n+((cashSigns[e.kind]||0)>0?e.amountCents:0),0),entryIds:entries.map(e=>e.id)},
    tasks:p.tasks.filter(t=>t.stageId===stageId).map(t=>({id:t.id,title:t.title,status:t.status,dueDate:t.dueDate,assigneeId:t.assigneeId,reviewerId:t.reviewerId,deliverable:t.deliverable})),
    purchases:p.purchases.filter(q=>q.stageId===stageId&&allowedStatuses.has(q.status)).map(q=>({id:q.id,title:q.title,version:q.version,status:q.status,totalCents:total(q)}))};
}
export function stageReport(p,stageId) {return records(p).reports.filter(r=>r.kind==='stage'&&r.stageId===stageId).at(-1)||null;}
export function validateStageGate(p,stageId) {
  if(!records(p).policy?.enabled||!records(p).policy?.requireStageReport)return null;
  const r=stageReport(p,stageId);assert(r&&r.review?.accept,'请先提交阶段成果，并由指定的另一位合伙人验收通过；已阅不算验收',409,'STAGE_REPORT_REQUIRED');
  assert(r.basisHash===stageBasis(p,stageId),'验收后阶段、任务或账目已变化，请重新提交并核对阶段成果',409,'STAGE_REPORT_STALE');
  return {reportId:r.id,basisHash:r.basisHash,reviewerId:r.reviewerId};
}
export function earlyOpenAllowed(p,stageId) {
  const c=records(p).changes.filter(c=>c.earlyStageId===stageId&&!c.consumedAt).at(-1);
  return c&&c.planHashAfter===sha(planState(p))?c:null;
}
export function validateSupervisionProposal(p,kind,input,ctx,financial) {
  const a=input||{},s=records(p),today=ctx.today;
  if(kind==='supervision_policy') {
    const reporter=eligible(p,a.reporterId),reviewer=eligible(p,a.reviewerId,'partner');assert(reporter.id!==reviewer.id,'汇报负责人与独立验收人不能相同');
    const intervalDays=Number(a.intervalDays),reconcileDays=Number(a.reconcileDays),escalateDays=Number(a.escalateDays);
    assert(Number.isInteger(intervalDays)&&intervalDays>=1&&intervalDays<=30,'汇报周期须为1–30天');
    assert(Number.isInteger(reconcileDays)&&reconcileDays>=1&&reconcileDays<=90,'对账周期须为1–90天');
    assert(Number.isInteger(escalateDays)&&escalateDays>=1&&escalateDays<=30,'升级提醒宽限期须为1–30天');
    for(const k of ['enabled','requireStageReport','blockCritical','blockStaleReport'])assert(typeof a[k]==='boolean','请明确监督规则开关');
    const firstDueDate=date(a.firstDueDate,true);assert(firstDueDate>=today,'首次汇报日期不能早于今天');
    return {enabled:a.enabled,reporterId:reporter.id,reviewerId:reviewer.id,intervalDays,reconcileDays,escalateDays,firstDueDate,
      requireStageReport:a.requireStageReport,blockCritical:a.blockCritical,blockStaleReport:a.blockStaleReport,
      previous:clone(s.policy||null),basisHash:sha(planState(p))};
  }
  if(kind==='plan_change') {
    assert(['project','stage','task'].includes(a.targetType),'请选择项目方向、阶段标准或任务成果');
    const fields={project:['description'],stage:['name','goal','acceptance','startDate','endDate'],task:['title','description','deliverable','dueDate']}[a.targetType];
    const target=a.targetType==='project'?p:find(a.targetType==='stage'?p.stages:p.tasks,a.targetId,'变更对象');
    assert(a.targetType==='project'||!['completed','done'].includes(target.status),'不能改写已验收成果；请另建后续任务或阶段',409);
    assert(a.after&&typeof a.after==='object'&&!Array.isArray(a.after),'缺少调整后的内容');
    assert(Object.keys(a.after).every(k=>fields.includes(k)),'不允许通过计划变更修改金额、权限或执行状态');
    const before={},after={};
    for(const k of fields)if(Object.hasOwn(a.after,k)) {
      before[k]=target[k]||'';after[k]=k.endsWith('Date')?date(a.after[k],k==='dueDate'):text(a.after[k],k,3000,k!=='description');
    }
    if(a.targetType==='stage'){const merged={...target,...after};assert(!merged.startDate||!merged.endDate||merged.startDate<=merged.endDate,'阶段开始日期不能晚于结束日期');}
    const earlyStageId=a.openEarly===true&&a.targetType==='stage'?target.id:null;
    assert(!a.openEarly||earlyStageId&&target.status==='locked','提前开放例外仅适用于尚未开放的阶段');
    assert(earlyStageId||sha(before)!==sha(after),'没有实际变更');
    return {targetType:a.targetType,targetId:target.id,before,after,earlyStageId,
      impact:text(a.impact,'资金、时间、范围影响与依据',3000),exceptionReason:earlyStageId?text(a.exceptionReason,'提前开放原因及未完成验证的风险',3000):'',basisHash:sha(planState(p))};
  }
  if(kind==='funding_request') {
    assert(['complete_original','new_experiment','scale_up','new_direction'].includes(a.purposeType),'请选择追加用途');
    const stage=find(p.stages,a.stageId,'阶段');assert(stage.status!=='completed','不能给已关闭阶段直接追加，请共同调整后续阶段');
    const amount=cents(a.additionalCents,'新增投入'),allocations=a.allocations;
    assert(Array.isArray(allocations)&&allocations.length>0&&allocations.length<=30,'请填写出资分担');
    assert(new Set(allocations.map(x=>x.memberId)).size===allocations.length,'出资成员重复');
    const lines=allocations.map(x=>{const m=eligible(p,x.memberId,'partner');assert(['contribution','loan_in'].includes(x.kind),'请选择新增出资或借款');return {memberId:m.id,name:m.name,amountCents:cents(x.amountCents,'分担金额'),kind:x.kind};});
    assert(lines.reduce((n,x)=>n+x.amountCents,0)===amount,'个人分担之和必须等于本次新增投入');
    const reviewDate=date(a.reviewDate,true);assert(reviewDate>=today,'复盘日期不能早于今天');
    const reportIds=[...new Set(a.reportIds||[])];assert(reportIds.length<=10&&reportIds.every(id=>s.reports.some(r=>r.id===id)),'关联汇报不属于该项目');
    return {stageId:stage.id,purposeType:a.purposeType,additionalCents:amount,allocations:lines,reviewDate,reportIds,
      previousResults:text(a.previousResults,'前轮结果与未完成事项',3000),validation:text(a.validation,'本次要验证什么',2000),
      stopConditions:text(a.stopConditions,'停止投入的条件',2000),terms:text(a.terms,'分担或借款补充约定',3000,false),attachments:evidenceIds(p,a.attachments),
      before:{totalBudgetCents:p.settings.totalBudgetCents,stageBudgetCents:stage.budgetCents,finance:clone(financial),reportIds:s.reports.slice(-3).map(r=>r.id)},
      basisHash:fundingBasis(p)};
  }
  if(kind==='funding_cancel') {
    const f=find(s.fundings,a.fundingId,'追加投入单');assert(f.status!=='cancelled','已经撤销');
    assert(!p.ledger.some(e=>e.fundingId===f.id),'已经关联真实到账，不能简单撤销；请保留事实并共同处理',409);
    return {fundingId:f.id,basisHash:fundingBasis(p)};
  }
  return null;
}
export function validateFundingVote(p,g,mid,a) {
  if(g.kind==='funding_request'&&a.decision==='approve'&&g.payload.allocations.some(x=>x.memberId===mid.id))assert(a.acceptFunding===true,'请本人明确确认分担金额；同意项目预算不自动代表承诺个人出资');
}
export function applySupervisionProposal(p,g,ctx,financial) {
  const d=g.payload,s=init(p),at=ctx.at;
  if(g.kind==='supervision_policy') {
    assert(d.basisHash===sha(planState(p)),'会签期间成员或计划已变化，请重新确认监督规则',409);
    s.policyHistory ||= [];if(s.policy)s.policyHistory.push(s.policy);
    s.policy={...clone(d),effectiveAt:at,proposalId:g.id};delete s.policy.previous;delete s.policy.basisHash;return;
  }
  if(g.kind==='plan_change') {
    assert(d.basisHash===sha(planState(p)),'会签期间计划已变化，请查看新旧对比并重新提交',409);
    const target=d.targetType==='project'?p:find(d.targetType==='stage'?p.stages:p.tasks,d.targetId,'变更对象');
    assert(d.targetType==='project'||!['completed','done'].includes(target.status),'对象已经验收，不能改写历史',409);
    Object.assign(target,clone(d.after));countGuard(s.changes,200,'计划变更');
    s.changes.push({...clone(d),id:g.id,at,reason:g.reason,planHashAfter:sha(planState(p)),consumedAt:null});return;
  }
  if(g.kind==='funding_request') {
    assert(d.basisHash===fundingBasis(p),'会签期间账目、成果或计划已变化，请基于最新资料重新申请追加',409);
    for(const x of d.allocations)assert(g.decisions[x.memberId]?.acceptFunding===true,'仍缺少出资人的明确分担确认',409);
    const stage=find(p.stages,d.stageId,'阶段');
    cents(p.settings.totalBudgetCents+d.additionalCents,'追加后总预算');cents(stage.budgetCents+d.additionalCents,'追加后阶段预算');
    p.settings.totalBudgetCents+=d.additionalCents;stage.budgetCents+=d.additionalCents;
    countGuard(s.fundings,100,'追加投入单');s.fundings.push({...clone(d),id:g.id,at,status:'approved',reason:g.reason,signers:clone(g.signers)});return;
  }
  if(g.kind==='funding_cancel') {
    assert(d.basisHash===fundingBasis(p),'会签期间资料已变化，请重新核对',409);
    const f=find(s.fundings,d.fundingId,'追加投入单'),stage=find(p.stages,f.stageId,'阶段');
    assert(!p.ledger.some(e=>e.fundingId===f.id),'已关联真实到账，不允许简单撤销',409);
    const used=p.purchases.filter(q=>q.stageId===stage.id&&allowedStatuses.has(q.status)).reduce((n,q)=>n+total(q),0)+p.ledger.filter(e=>e.unauthorized&&e.stageId===stage.id&&e.amountCents>0).reduce((n,e)=>n+e.amountCents,0);
    assert(stage.budgetCents-f.additionalCents>=used&&p.settings.totalBudgetCents-f.additionalCents>=Math.max(financial.budgetUsed,p.settings.minReserveCents),'追加预算已被承诺或占用，请先处理相关事项',409);
    stage.budgetCents-=f.additionalCents;p.settings.totalBudgetCents-=f.additionalCents;f.status='cancelled';f.cancelledAt=at;f.cancelProposalId=g.id;
  }
}
export function supervisionMemberGuard(p,memberId) {
  const s=records(p),policy=s.policy;
  assert(!policy?.enabled||![policy.reporterId,policy.reviewerId].includes(memberId),'请先共同变更该成员负责的汇报与监督职责',409);
  assert(!s.reports.some(r=>r.kind==='stage'&&!r.review&&r.reviewerId===memberId),'该成员还有待验收阶段汇报',409);
  assert(!s.issues.some(i=>i.status!=='closed'&&[i.assigneeId,i.reviewerId].includes(memberId)),'该成员还有未关闭异常，请先处理和复核',409);
  assert(!s.fundings.some(f=>f.status!=='cancelled'&&fundingProgress(p,f).allocations.some(a=>a.memberId===memberId&&a.verifiedCents<a.amountCents)),'该成员还有未完成的追加出资承诺，请先共同处理',409);
}
export function supervisionAction(p,type,a,ctx,{mid,actor,financial,notify,addEntry}) {
  const s=init(p),today=ctx.today,at=ctx.at;
  const isPartner=()=>assert(mid.role==='partner','仅合伙人可操作',403);
  const canWork=()=>assert(mid.role!=='viewer','只读成员不能提交业务',403);
  if(type==='report.submit') {
    canWork();assert(['weekly','stage'].includes(a.kind),'汇报类型无效');
    const stage=find(p.stages,a.stageId,'阶段');assert(stage.status==='open','请为当前开放阶段提交汇报');
    assert(!s.policy?.enabled||s.policy.reporterId===mid.id,'请由约定的汇报负责人提交，交接需共同调整规则',403);
    const from=date(a.fromDate,true),to=date(a.toDate,true);assert(from<=to&&to<=today,'汇报日期不能倒置或填未来');
    const reviewer=eligible(p,a.reviewerId||s.policy?.reviewerId,'partner');assert(reviewer.id!==mid.id,'提交人与阶段验收人不能是同一人');
    if(s.policy?.enabled)assert(reviewer.id===s.policy.reviewerId,'请使用共同约定的独立验收人');
    let previous=null;if(a.supersedesId){previous=find(s.reports,a.supersedesId,'旧汇报');assert(previous.authorId===mid.id&&previous.stageId===stage.id&&previous.kind===a.kind,'只能更正本人同阶段同类型汇报');assert(!s.reports.some(r=>r.supersedesId===previous.id),'该版本已有后续更正，请刷新');}
    const fundingIds=[...new Set(a.fundingIds||[])];assert(Array.isArray(a.fundingIds||[])&&fundingIds.length<=10,'关联追加投入列表无效');
    for(const id of fundingIds){const f=find(s.fundings,id,'关联追加单');assert(f.status!=='cancelled'&&atDay(f.at)<=to,'请关联本项目已批准且在汇报期间已经生效的追加单');}
    countGuard(s.reports,240,'汇报');
    const r={id:ctx.id,kind:a.kind,stageId:stage.id,fromDate:from,toDate:to,authorId:mid.id,reviewerId:reviewer.id,at,
      completed:text(a.completed,'实际完成的内容（没有进展请如实说明）',3000),evidence:text(a.evidence,'成果位置或暂无成果的原因',3000),
      problems:text(a.problems,'问题与偏差',2000,false),nextSteps:text(a.nextSteps,'下一步与需共同决定事项',2000,false),
      attachments:evidenceIds(p,a.attachments),fundingIds,supersedesId:previous?.id||null,version:(previous?.version||0)+1,
      snapshot:workSnapshot(p,financial,stage.id,from,to),basisHash:stageBasis(p,stage.id),readBy:{},review:null};
    r.contentHash=sha({...r,readBy:undefined,review:undefined});s.reports.push(r);
    notify('执行汇报已提交，请查看成果',r.completed.slice(0,150),'info','reports');return;
  }
  if(type==='report.read') {const r=find(s.reports,a.id,'汇报');assert(a.contentHash===r.contentHash,'汇报版本不一致，请重新阅读',409);r.readBy[mid.id] ||= at;return;}
  if(type==='report.review') {
    isPartner();const r=find(s.reports,a.id,'汇报');assert(r.kind==='stage'&&r.reviewerId===mid.id&&r.authorId!==mid.id,'仅指定的独立验收人可验收阶段成果',403);
    assert(!r.review&&stageReport(p,r.stageId)?.id===r.id&&!s.reports.some(x=>x.supersedesId===r.id),'该版本已处理或已有更新的阶段成果',409);assert(typeof a.accept==='boolean','请明确验收结果');
    if(a.accept)assert(r.basisHash===stageBasis(p,r.stageId),'提交后任务、账目或阶段条件已变化，请先更新汇报',409,'STAGE_REPORT_STALE');
    r.review={accept:a.accept,note:text(a.note,'验收依据或退回原因',2000),at,by:mid.id};
    notify(a.accept?'阶段成果已独立验收，仍需阶段会签':'阶段成果已退回',a.note,'info','reports');return;
  }
  if(type==='funding.receipt'||type==='funding.link') {
    isPartner();const f=find(s.fundings,a.id,'追加投入单');assert(f.status==='approved','该追加单已撤销');
    const line=fundingProgress(p,f).allocations.find(x=>x.memberId===a.memberId);assert(line,'成员不在本单出资名单中');
    if(type==='funding.receipt') {
      const amount=cents(a.amountCents);assert(amount<=line.remainingCents,'超过尚未登记的分担金额；多余真实来款请单独记账后共同处理');
      addEntry({kind:line.kind,amountCents:amount,stageId:f.stageId,fundingId:f.id,fundingMemberId:line.memberId,
        description:'追加投入到账：'+line.name,evidence:text(a.evidence,'真实到账依据',3000),attachments:evidenceIds(p,a.attachments),unauthorized:false});
    } else {
      const entry=find(p.ledger,a.entryId,'已有账目');assert(entry.kind===line.kind&&entry.amountCents>0&&!entry.fundingId&&!entry.reversesId&&!p.ledger.some(e=>e.reversesId===entry.id),'只能关联未冲销、未被使用的同类型真实到账');
      assert(entry.amountCents<=line.remainingCents,'已有到账金额超过剩余分担；不拆改原账目');
      entry.fundingId=f.id;entry.fundingMemberId=line.memberId;entry.fundingLink={at,by:mid.id,note:text(a.evidence,'关联核对依据',2000)};
    }
    notify('追加投入到账记录已更新','仅已独立复核的实际来款计入已完成出资，承诺不计现金。','info','funding');return;
  }
  if(type==='issue.create') {
    isPartner();countGuard(s.issues,400,'异常');const candidate=a.sourceKey?supervisionAlerts(p,today).find(x=>x.key===a.sourceKey):null;
    assert(!a.sourceKey||candidate,'异常来源已变化，请刷新核对');
    assert(!candidate||!s.issues.some(i=>i.sourceKey===candidate.key&&i.sourceFingerprint===candidate.fingerprint),'同一异常已建立处理单，请查看原记录',409);
    const assignee=eligible(p,a.assigneeId),reviewer=eligible(p,a.reviewerId,'partner');assert(assignee.id!==reviewer.id,'异常处理人与复核人不能相同');
    const dueDate=date(a.dueDate,true);assert(dueDate>=today,'处理截止不能早于今天');
    const severity=candidate?.severity||(a.severity==='critical'?'critical':'warning');
    const issue={id:ctx.id,title:candidate?.title||text(a.title,'异常标题',150),detail:candidate?.detail||text(a.detail,'异常说明',3000),
      sourceKey:candidate?.key||null,sourceFingerprint:candidate?.fingerprint||null,severity,assigneeId:assignee.id,reviewerId:reviewer.id,
      dueDate,createdAt:at,status:'open',updates:[]};s.issues.push(issue);notify('异常需要处理',issue.title,severity,'issues');return;
  }
  if(['issue.respond','issue.resolve','issue.review'].includes(type)) {
    const i=find(s.issues,a.id,'异常');assert(i.status!=='closed','异常已经关闭，历史不能覆盖',409);
    if(type==='issue.respond'||type==='issue.resolve') {
      canWork();assert(i.assigneeId===mid.id,'只有指定负责人可提交异常处理',403);assert(i.status!=='review','请等待复核，不能覆盖已提交结果',409);
      if(type==='issue.respond'){i.status='doing';i.updates.push({at,by:mid.id,type:'response',cause:text(a.cause,'原因',2000),plan:text(a.plan,'处理办法与预计完成时间',2000)});}
      else{assert(i.updates.some(u=>u.type==='response'),'请先说明原因和处理办法');i.status='review';i.updates.push({at,by:mid.id,type:'resolution',result:text(a.result,'处理结果与依据',3000),attachments:evidenceIds(p,a.attachments)});}
    } else {
      isPartner();assert(i.reviewerId===mid.id&&i.assigneeId!==mid.id,'只有指定的另一位合伙人可复核',403);assert(i.status==='review','尚未提交处理结果');assert(typeof a.accept==='boolean','请明确复核结果');
      const disposition=a.disposition||'resolved';assert(['resolved','accepted','false_positive'].includes(disposition),'处理结论无效');
      const stillPresent=supervisionAlerts(p,today).some(x=>x.key===i.sourceKey&&x.fingerprint===i.sourceFingerprint);
      assert(!a.accept||!stillPresent||disposition!=='resolved','来源仍存在，不能写成已消除；请退回或明确记录知情处理/误报依据');
      i.status=a.accept?'closed':'doing';i.updates.push({at,by:mid.id,type:'review',accept:a.accept,disposition,note:text(a.note,'复核依据',3000)});if(a.accept)i.closedAt=at;
    }
    notify(i.status==='closed'?'异常已独立复核关闭':i.status==='review'?'异常处理结果待复核':'异常处理安排已更新',i.title,'info','issues');return;
  }
  if(type==='supervision.sync') {
    assert(ctx.supervisionSystemVerified,'缺少监督调度授权',403);if(!s.policy?.enabled)return;
    const policy=s.policy,alerts=supervisionAlerts(p,today);
    const fresh=alerts.filter(a=>!s.issues.some(i=>i.sourceKey===a.key&&i.sourceFingerprint===a.fingerprint)).slice(0,8);
    for(const a of fresh) {
      countGuard(s.issues,400,'异常');s.issues.push({id:sha(p.id+':'+a.key+':'+a.fingerprint).slice(0,32),title:a.title,detail:a.detail,sourceKey:a.key,sourceFingerprint:a.fingerprint,
        severity:a.severity,assigneeId:policy.reporterId,reviewerId:policy.reviewerId,dueDate:plusDate(today,policy.escalateDays),createdAt:at,status:'open',updates:[],automatic:true});
    }
    if(fresh.length)notify('新增监督异常，请明确处理',fresh.map(a=>a.title).join('；'),fresh.some(a=>a.severity==='critical')?'critical':'warning','issues');
    const overdue=s.issues.filter(i=>i.status!=='closed'&&i.dueDate<today);
    const unread=s.reports.filter(r=>plusDate(atDay(r.at),policy.escalateDays)<today&&partners(p).some(m=>!r.readBy[m.id]));
    if(s.lastDigestDay!==today&&(overdue.length||unread.length)) {
      s.lastDigestDay=today;notify('监督待办升级提醒',`${overdue.length}项异常逾期未关闭，${unread.length}份汇报尚未全员确认已阅。请处理，不以已读代替完成。`,'warning','supervision');
    }
    s.lastCheckedAt=at;return;
  }
  assert(false,'不支持的监督操作');
}
export function supervisionNeedsSync(p,today=supervisionDay()) {
  const s=records(p);if(!s.policy?.enabled||(p.lifecycle||'active')!=='active'||!['active','paused'].includes(p.status))return false;
  return supervisionAlerts(p,today).some(a=>!s.issues.some(i=>i.sourceKey===a.key&&i.sourceFingerprint===a.fingerprint))||s.lastDigestDay!==today&&(
    s.issues.some(i=>i.status!=='closed'&&i.dueDate<today)||s.reports.some(r=>plusDate(atDay(r.at),s.policy.escalateDays)<today&&partners(p).some(m=>!r.readBy[m.id])));
}
export function supervisionView(p,actor,financial,today=supervisionDay()) {
  const s=records(p),mid=p.members.find(m=>m.active&&m.userId===actor.id)?.id,latest=s.reports.at(-1),fundings=s.fundings.map(f=>fundingProgress(p,f));
  const pending=p.proposals.filter(g=>g.status==='pending'&&g.signers.some(m=>m.id===mid)&&!g.decisions[mid]);
  const reportedThrough=s.reports.map(r=>r.toDate).sort().at(-1)||null;
  const lastReconciledAt=p.reconciliations.at(-1)?.at||null,stale=!reportedThrough||ageDays(reportedThrough,today)>(s.policy?.intervalDays||7);
  return {today,reportedThrough,policy:s.policy||null,lastReportAt:latest?.at||null,lastReconciledAt,reportDueDate:reportDeadline(p),informationStatus:stale?'needs_verification':'reported_not_independently_verified',
    holds:supervisionHolds(p,today),alerts:supervisionAlerts(p,today),fundings,
    currentStages:p.stages.filter(st=>st.status==='open').map(st=>({id:st.id,name:st.name,goal:st.goal,acceptance:st.acceptance,endDate:st.endDate,budgetCents:st.budgetCents,
      reportId:stageReport(p,st.id)?.id||null,reportAccepted:stageReport(p,st.id)?.review?.accept===true,reportCurrent:stageReport(p,st.id)?.basisHash===stageBasis(p,st.id)})),
    reportedOutCents:p.ledger.reduce((n,e)=>n+((cashSigns[e.kind]||0)<0?e.amountCents:0),0),committedUnpaidCents:financial.holds+financial.settlementHolds+financial.exitHoldCents+Math.max(0,financial.payableCents-p.purchases.filter(q=>q.order).reduce((n,q)=>n+Math.max(0,total(q)-p.ledger.filter(e=>e.purchaseId===q.id&&e.kind==='purchase_payment').reduce((n,e)=>n+e.amountCents,0)),0)),
    fundingPledgedCents:fundings.filter(f=>f.status!=='cancelled').reduce((n,f)=>n+f.additionalCents,0),fundingVerifiedCents:fundings.filter(f=>f.status!=='cancelled').reduce((n,f)=>n+f.receivedCents,0),
    myPending:{decisions:pending.map(g=>g.id),purchases:p.purchases.filter(q=>q.status==='pending'&&q.signers.some(m=>m.id===mid)&&q.decisions[mid]?.decision!=='approve').map(q=>q.id),
      unreadReports:s.reports.filter(r=>!r.readBy[mid]).map(r=>r.id),stageReviews:s.reports.filter(r=>r.kind==='stage'&&!r.review&&stageReport(p,r.stageId)?.id===r.id&&r.reviewerId===mid&&!s.reports.some(x=>x.supersedesId===r.id)).map(r=>r.id),
      issues:s.issues.filter(i=>i.status!=='closed'&&(i.status==='review'?i.reviewerId===mid:i.assigneeId===mid)).map(i=>i.id)}};
}
