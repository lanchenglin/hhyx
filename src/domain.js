// 所有业务状态通过同一 reducer 修改；数据库以项目 revision 做 CAS，保证多名审批人并发时的预算与会签一致。
import { assert, text, cents, email, date, sha } from './util.js';
import { validateBrief, validatePolicy, aiConsentValid, aiUsage } from './ai-policy.js';

export const ACTIONS = {
 'ai.materials':'更新分析补充资料','ai.suspend':'暂停外部AI发送','ai.run.request':'请求AI分析','ai.run.finish':'记录AI分析结果','ai.review':'记录AI风险处置',
 'plan.update':'修改筹备计划','member.remove':'移除筹备成员','member.add':'添加筹备成员','member.join':'成员接受邀请',
 'task.add':'创建任务','task.progress':'提交任务进度','task.accept':'验收任务',
 'proposal.submit':'提交共同决策','proposal.vote':'共同决策表态','proposal.cancel':'撤回共同决策',
 'purchase.save':'保存采购版本','purchase.submit':'提交采购会签','purchase.read':'确认已阅',
 'purchase.vote':'采购会签表态','purchase.comment':'补充采购说明','purchase.cancel':'撤销未执行采购',
 'purchase.order':'登记已下单','purchase.pay':'登记采购付款','purchase.receive':'登记收货验收',
 'ledger.add':'登记实际账目','ledger.verify':'复核账目','ledger.reverse':'提交账目更正',
 'project.pause':'紧急暂停新增采购','settlement.pay':'登记分红付款',
 'attachment.add':'归档附件','channel.update':'更改通知渠道','invite.create':'生成成员邀请'
};
const RESERVED = new Set(['pending','approved','ordered','received']);
const CASH_SIGNS = { contribution:1, revenue:1, loan_in:1, receivable_collection:1, refund_in:1, operating_expense:-1, loan_repayment:-1, payable_payment:-1, purchase_payment:-1, distribution:-1 };
const MANUAL_LEDGER = new Set(['contribution','revenue','loan_in','receivable_collection','refund_in','operating_expense','loan_repayment','payable_payment','cost_of_goods_sold','inventory_writeoff','receivable_revenue','payable_expense']);
const SIGNIFICANT = new Set(['budget','member_add','member_remove','profit_rule','terms']);
const clone = x => structuredClone(x);
const activeMembers = p => p.members.filter(m=>m.active);
export const partners = p => activeMembers(p).filter(m=>m.role==='partner');
export function getMember(p, actor) { const m = p.members.find(m=>m.active && m.userId===actor.id); assert(m,'你不是该项目的有效成员',403); return m; }
export const partner = (p, actor) => { const m=getMember(p,actor); assert(m.role==='partner','仅合伙人可以执行此操作',403); return m; };
const canWork = (p, actor) => { const m=getMember(p,actor); assert(m.role!=='viewer','只读成员不能执行此操作',403); return m; };
const getById = (arr,id,what) => {const x=arr.find(x=>x.id===id); assert(x,`${what}不存在`,404); return x;};
const sum = arr => arr.reduce((s,x)=>s+x,0);
export const paid = (p,q) => sum(p.ledger.filter(e=>e.kind==='purchase_payment'&&e.purchaseId===q.id).map(e=>e.amountCents));
export const purchaseTotal = q => sum(q.items.map(i=>i.quantity*i.unitCents));
const live = p => assert(['active','paused'].includes(p.status),'请先让全体合伙人确认合作基准计划');
const purchasing = p => { live(p); assert(p.status==='active','项目已暂停，不能新增采购或形成新支出承诺',409); };
const proof = v => text(v,'依据/凭证说明',3000);
const attachmentIds = v => { assert(v==null || (Array.isArray(v)&&v.length<=20&&v.every(x=>typeof x==='string'&&x.length<=100)), '附件列表格式不正确'); return v||[]; };
function snapshots(p) { const ms=partners(p); assert(ms.length>=2,'合作项目至少需要两名合伙人'); assert(ms.length<=30,'第一版每个项目最多支持30名合伙人'); assert(ms.every(m=>m.userId),'还有合伙人未接受邀请，不能开始会签'); return ms.map(m=>({id:m.id,userId:m.userId,name:m.name,email:m.email})); }
function stageFrom(p,id) {return getById(p.stages,id,'阶段');}
const notBaselinePending = p => assert(!p.proposals.some(g=>g.kind==='baseline'&&g.status==='pending'),'基准计划正在会签，请先撤回后再修改',409);
function validShares(p) { assert(sum(partners(p).map(m=>m.shareBps))===10000,'合伙人分配比例总和必须为100%'); }
function verifyStages(stages, total) {
 assert(Array.isArray(stages)&&stages.length>0&&stages.length<=30,'请配置1–30个阶段');
 assert(new Set(stages.map(s=>s.id)).size===stages.length,'阶段编号重复');
 assert(sum(stages.map(s=>s.budgetCents))<=total,'阶段预算之和不能超过项目总预算');
 for(const s of stages) { cents(s.budgetCents,'阶段预算',true); if(s.startDate&&s.endDate)assert(s.startDate<=s.endDate,'阶段开始日期不能晚于截止日期'); }
}
function newMember(a,id) { const role=a.role||'partner'; assert(['partner','operator','viewer'].includes(role),'成员角色不正确'); return {id,userId:null,email:email(a.email),name:text(a.name,'成员姓名',60),role,active:true,shareBps:0}; }
function newStage(s,id) { assert(typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id),'阶段编号格式不正确'); return {id,name:text(s.name,'阶段名称',100),budgetCents:cents(s.budgetCents,'阶段预算',true),goal:text(s.goal,'阶段目标',2000),acceptance:text(s.acceptance,'验收标准',2000),startDate:date(s.startDate),endDate:date(s.endDate),status:'locked',evidence:''}; }
export function createProject(a,actor,ctx) {
 const budget=cents(a.totalBudgetCents,'项目总预算'), reserve=cents(a.minReserveCents??0,'最低保留资金',true); assert(reserve<=budget,'最低保留资金不能超过总预算');
 return {id:ctx.id,name:text(a.name,'项目名称',100),description:text(a.description,'项目说明',3000,false),ownerId:actor.id,createdAt:ctx.at,status:'draft',pauseReason:'',
  settings:{totalBudgetCents:budget,minReserveCents:reserve,terms:text(a.terms,'合作约定',12000,false),approvalRule:'all_partners',currency:'CNY'},
  members:[{id:ctx.id+'-owner',userId:actor.id,name:actor.name,email:actor.email,role:'partner',active:true,shareBps:10000}],
  stages:[],tasks:[],purchases:[],proposals:[],ledger:[],settlements:[],attachments:[],baseline:null,reconciliations:[]};
}
function ledgerEffect(e) {return (CASH_SIGNS[e.kind]||0)*e.amountCents;}
export function finance(p) {
 // 已上报的现金流出立即计入保守余额；尚未复核的流入不能用于新采购。
 const verified=p.ledger.filter(e=>e.verifiedBy), verifiedCash=sum(verified.map(ledgerEffect));
 const conservativeCash=sum(p.ledger.map(e=> e.verifiedBy?ledgerEffect(e):Math.min(0,ledgerEffect(e))));
 const reportedCash=sum(p.ledger.map(ledgerEffect));
 const holds=sum(p.purchases.filter(q=>RESERVED.has(q.status)).map(q=>Math.max(0,purchaseTotal(q)-paid(p,q))));
 const settlementHolds=sum(p.settlements.filter(s=>s.status==='approved').map(s=>sum(s.allocations.map(a=>a.amountCents-(a.paidCents||0)))));
 const unauthorized=sum(p.ledger.filter(e=>e.unauthorized&&e.amountCents>0).map(e=>Math.max(0,-ledgerEffect(e))));
 const budgetUsed=sum(p.purchases.filter(q=>RESERVED.has(q.status)).map(purchaseTotal))+unauthorized;
 const revenue=sum(verified.filter(e=>['revenue','receivable_revenue'].includes(e.kind)).map(e=>e.amountCents));
 const costs=sum(verified.filter(e=>['operating_expense','cost_of_goods_sold','inventory_writeoff','payable_expense'].includes(e.kind)|| (e.kind==='purchase_payment'&&p.purchases.find(q=>q.id===e.purchaseId)?.category==='expense')).map(e=>e.amountCents));
 const distributed=sum(p.ledger.filter(e=>e.kind==='distribution').map(e=>e.amountCents));
 const receivable=sum(verified.filter(e=>e.kind==='receivable_revenue').map(e=>e.amountCents))-sum(verified.filter(e=>e.kind==='receivable_collection').map(e=>e.amountCents));
 const manualPayable=sum(p.ledger.filter(e=>e.kind==='payable_expense').map(e=>e.amountCents))-sum(p.ledger.filter(e=>e.kind==='payable_payment').map(e=>e.amountCents));
 const purchasePayable=sum(p.purchases.filter(q=>q.order).map(q=>Math.max(0,purchaseTotal(q)-paid(p,q))));
 return {verifiedCash,reportedCash,conservativeCash,holds,settlementHolds,unauthorized,budgetUsed,
 availableCents:conservativeCash-holds-settlementHolds-p.settings.minReserveCents-Math.max(0,manualPayable),
 revenueCents:revenue,costCents:costs,estimatedProfitCents:revenue-costs,distributedCents:distributed,
 receivableCents:receivable,payableCents:manualPayable+purchasePayable,
 unverifiedCount:p.ledger.filter(e=>!e.verifiedBy).length,lastReconciledAt:p.reconciliations.at(-1)?.at||null};
}
export function budgetCheck(p,q) {
 const stage=stageFrom(p,q.stageId); assert(stage.status==='open','只能采购已开放阶段的商品',409);
 const others=p.purchases.filter(x=>x.id!==q.id&&RESERVED.has(x.status));
 const unauthorized=sum(p.ledger.filter(e=>e.unauthorized).map(e=>Math.max(0,-ledgerEffect(e))));
 assert(sum(others.filter(x=>x.stageId===q.stageId).map(purchaseTotal))+purchaseTotal(q)+sum(p.ledger.filter(e=>e.unauthorized&&e.stageId===q.stageId).map(e=>Math.max(0,-ledgerEffect(e))))<=stage.budgetCents,'超过当前阶段预算：请先全员批准预算变更',409);
 assert(sum(others.map(purchaseTotal))+purchaseTotal(q)+unauthorized<=p.settings.totalBudgetCents,'超过项目总预算',409);
 const f=finance(p), existing=RESERVED.has(q.status)?Math.max(0,purchaseTotal(q)-paid(p,q)):0;
 assert(f.availableCents+existing>=purchaseTotal(q)-paid(p,q),'核实资金扣除已有承诺及保留资金后不足，不能放行本次采购',409);
}
function purchaseInput(p,a,id) {
 assert(Array.isArray(a.items)&&a.items.length>0&&a.items.length<=50,'每张采购单需包含1–50项商品');
 const items=a.items.map(i=>({name:text(i.name,'商品名称',120),spec:text(i.spec,'规格',300,false),quantity:cents(i.quantity,'数量'),unitCents:cents(i.unitCents,'单价',true)}));
 assert(items.every(i=>i.quantity<=1000000&&Number.isSafeInteger(i.quantity*i.unitCents)), '数量或金额超出范围');
 const q={id,title:text(a.title,'采购标题',150),category:a.category||'inventory',stageId:text(a.stageId,'阶段',100),items,
 supplier:text(a.supplier,'供应商',200),payee:text(a.payee,'收款对象/账号',250),paymentTerms:text(a.paymentTerms,'付款条件',1000),
 reason:text(a.reason,'采购原因',3000),risk:text(a.risk,'风险说明',2000),exitPlan:text(a.exitPlan,'退出/退货方案',2000),quote:proof(a.quote),
 attachments:attachmentIds(a.attachments),dueDate:date(a.dueDate,true),expiresAt:date(a.expiresAt,true),executorId:a.executorId,receiverId:a.receiverId};
 assert(['inventory','expense'].includes(q.category),'采购类别不正确'); stageFrom(p,q.stageId); cents(purchaseTotal(q),'采购总额');
 for(const k of ['executorId','receiverId'])assert(activeMembers(p).some(m=>m.id===q[k]&&m.role!=='viewer'&&m.userId),'执行人/验收人必须为已加入的可执行成员');
 assert(q.executorId!==q.receiverId,'采购执行人与验收人应分开'); return q;
}
function resetUncommitted(p,at,why) {
 for(const q of p.purchases.filter(q=>['pending','approved'].includes(q.status)&&!q.order)) {
  q.history.push(purchaseArchive(q,at,why)); q.version++; q.status='draft'; q.signers=[]; q.decisions={}; q.readBy={}; q.invalidatedReason=why;
 }
}
function purchaseArchive(q,at,reason) {const v=clone(q); delete v.history; return {...v,archivedAt:at,archiveReason:reason};}
function allocate(total,ms) {
 const result=ms.map(m=>({memberId:m.id,name:m.name,shareBps:m.shareBps,amountCents:Math.floor(total*m.shareBps/10000),remainder:(total*m.shareBps)%10000,paidCents:0}));
 let left=total-sum(result.map(a=>a.amountCents));
 for(const a of [...result].sort((a,b)=>b.remainder-a.remainder||a.memberId.localeCompare(b.memberId))) {if(left-->0)a.amountCents++; delete a.remainder;}
 return result;
}
export function reduceProject(original, action, actor, ctx) {
 const p=clone(original), a=action.data||{}, at=ctx.at, today=ctx.today||ctx.at.slice(0,10), mid=action.type==='ai.run.finish'&&ctx.aiSystemVerified ? {id:'system:ai',name:'AI任务服务'} : action.type==='member.join'&&ctx.inviteVerified ? p.members.find(m=>m.id===a.memberId&&m.email===actor.email) : getMember(p,actor), events=[];
 assert(ACTIONS[action.type],'不支持的操作',400);
 const notify=(title,body='',severity='info',target='',recipients=null)=>events.push({title,body,severity,target,recipients});
 const requirePartner=()=>partner(p,actor);
 const requireDraft=()=>{ requirePartner(); assert(p.ownerId===actor.id,'筹备期由创建人编辑，生效须全体确认',403); assert(p.status==='draft','正式生效后必须提交共同决策变更'); notBaselinePending(p); };
 const addEntry=(e)=>{ const v={id:ctx.id,at,actorId:mid.id,verifiedBy:null,verifiedAt:null,...e}; p.ledger.push(v); return v; };
 switch(action.type) {
 case 'ai.materials': {
  requirePartner(); p.ai ||= {runs:[],reviews:[],briefHistory:[]};
  if(p.ai.brief)p.ai.briefHistory.push(p.ai.brief);
  p.ai.brief={version:(p.ai.brief?.version||0)+1,data:validateBrief(a),at,authorId:mid.id};
  notify('项目分析补充资料已更新','补充资料不修改原批准计划，旧分析将按输入变化标记过期。','info','ai');break;
 }
 case 'ai.suspend': {
  requirePartner();p.ai ||= {runs:[],reviews:[],briefHistory:[]};p.ai.suspended=true;
  notify('已暂停后续外部AI发送','已发出的请求无法撤回；恢复须重新全员确认。','warning','ai');break;
 }
 case 'ai.run.request': {
  assert(ctx.aiVerified,'分析请求未经服务端校验',403);canWork(p,actor);
  assert(aiConsentValid(p,ctx.aiEngine),'尚未全员确认当前模型/发送范围，或已暂停；未发送数据',409);
  const u=aiUsage(p,at.slice(0,7)), policy=p.ai.policy;
  assert(!p.ai.runs.some(j=>['queued','running'].includes(j.status)),'本项目已有分析排队/运行中，请先查看其结果',409);
  assert(p.ai.runs.length<1000,'分析记录达到本版上限，请导出归档',409);
  assert(u.calls+1<=policy.monthlyCallLimit,'已达到项目月调用上限',429);
  assert(u.budgetUsedCents+a.reserveCents<=policy.monthlyBudgetCents,'本次保守费用预占将超过月预算，未调用模型',429);
  p.ai.runs.push({...a,status:'queued',month:at.slice(0,7),createdAt:at,actorId:mid.id,chargeCents:null,usage:null});
  notify('已请求项目AI分析','报告只辅助判断，不代表批准；同一输入将复用已有有效报告。','info','ai');break;
 }
 case 'ai.run.finish': {
  assert(ctx.aiSystemVerified,'仅任务服务可写入分析结果',403);const run=getById(p.ai?.runs||[],a.id,'分析');
  assert(['queued','running'].includes(run.status),'该分析已结束',409);
  assert(['completed','failed','uncertain','cancelled'].includes(a.status),'分析结果状态不正确');
  Object.assign(run,{status:a.status,finishedAt:at,error:a.error||null,errorCode:a.errorCode||null,usage:a.usage||null,chargeCents:a.chargeCents,reportHash:a.reportHash||null});
  notify(a.status==='completed'?'AI分析报告已生成':'AI分析未完成',a.status==='completed'?'请查看来源、风险和待共同决定事项；AI没有投票权。':a.error||'未形成有效结论','info','ai');break;
 }
 case 'ai.review': {
  requirePartner();assert(ctx.aiReviewVerified,'风险处置对象未核验',403);p.ai.reviews.push({id:ctx.id,at,memberId:mid.id,runId:a.runId,findingId:a.findingId,disposition:a.disposition,note:proof(a.note)});
  notify('新增AI风险处置说明','该说明不代替采购会签或预算变更。','info','ai');break;
 }
 case 'plan.update': {
  requireDraft(); p.name=text(a.name??p.name,'项目名称',100); p.description=text(a.description??p.description,'项目说明',3000,false);
  p.settings.totalBudgetCents=cents(a.totalBudgetCents??p.settings.totalBudgetCents,'总预算'); p.settings.minReserveCents=cents(a.minReserveCents??p.settings.minReserveCents,'保留资金',true);
  assert(p.settings.minReserveCents<=p.settings.totalBudgetCents,'保留资金不能超过总预算'); p.settings.terms=text(a.terms??p.settings.terms,'合作约定',12000,false);
  if(a.stages){assert(Array.isArray(a.stages),'阶段列表格式不正确');assert(!p.tasks.some(t=>!a.stages.some(s=>s.id===t.stageId)),'不能删除仍有关联任务的阶段');p.stages=a.stages.map((s,i)=>newStage(s,s.id||`${ctx.id}-stage-${i}`));verifyStages(p.stages,p.settings.totalBudgetCents);}
  if(a.shares){for(const m of partners(p)){const value=a.shares[m.id];assert(Number.isInteger(value)&&value>=0&&value<=10000,'分配比例不正确');m.shareBps=value;}validShares(p);}
  notify('筹备计划已更新','生效前仍需所有合伙人确认'); break;
 }
 case 'member.add': {
  requireDraft(); const m=newMember(a,ctx.id); assert(m.role!=='partner'||partners(p).length<30,'第一版每个项目最多支持30名合伙人'); assert(!activeMembers(p).some(x=>x.email===m.email),'该邮箱已在项目中'); assert(activeMembers(p).length<40,'第一版单项目最多40名成员'); p.members.push(m); notify('项目新增待邀请成员',m.name); break;
 }
 case 'member.remove': {requireDraft();const m=getById(p.members,a.memberId,'成员');assert(m.userId!==p.ownerId,'不能移除创建人');m.active=false;m.removedAt=at;notify('筹备成员已移除',m.name);break;}
 case 'member.join': {
  // API 层核验邀请 token，其他调用不得进入此分支。
  assert(ctx.inviteVerified,'邀请未验证',403); const m=getById(p.members,a.memberId,'成员'); assert(m.active&&m.email===actor.email,'邀请与登录账号不匹配',403); assert(!m.userId||m.userId===actor.id,'该邀请已绑定其他账号',409); m.userId=actor.id; m.name=actor.name; notify('成员已接受邀请',m.name); break;
 }
 case 'task.add': {
  requirePartner(); assert(p.status!=='completed','项目已结束'); stageFrom(p,a.stageId);
  assert(activeMembers(p).some(m=>m.id===a.assigneeId&&m.role!=='viewer'),'负责人无效'); assert(activeMembers(p).some(m=>m.id===a.reviewerId&&m.role!=='viewer'),'验收人无效'); assert(a.assigneeId!==a.reviewerId,'任务负责人和验收人不能相同');
  if(a.aiSource){assert(ctx.aiTaskVerified,'AI任务来源未经校验',403);assert(!p.tasks.some(t=>t.aiSource?.runId===a.aiSource.runId&&t.aiSource?.index===a.aiSource.index),'此建议已建立任务，不能重复创建',409);}
  p.tasks.push({id:ctx.id,...(a.aiSource?{aiSource:a.aiSource}:{}),title:text(a.title,'任务名称',150),description:text(a.description,'任务说明',3000,false),deliverable:text(a.deliverable,'交付成果/标准',2000),stageId:a.stageId,assigneeId:a.assigneeId,reviewerId:a.reviewerId,dueDate:date(a.dueDate,true),status:'todo',updates:[],createdAt:at});
  notify('新增执行任务',a.title,'info','tasks'); break;
 }
 case 'task.progress': {
  canWork(p,actor); const t=getById(p.tasks,a.id,'任务'); assert(t.assigneeId===mid.id,'只有任务负责人可提交进度',403); assert(t.status!=='done','已验收任务不能直接修改'); assert(['doing','review','blocked'].includes(a.status),'任务状态不正确');
  t.status=a.status;t.updates.push({at,memberId:mid.id,status:a.status,note:proof(a.note),attachments:attachmentIds(a.attachments)}); notify(a.status==='review'?'任务待验收':'任务进度更新',t.title,a.status==='blocked'?'warning':'info','tasks');break;
 }
 case 'task.accept': {
  canWork(p,actor); const t=getById(p.tasks,a.id,'任务');assert(t.reviewerId===mid.id,'只有指定验收人可验收',403);assert(t.status==='review','任务尚未提交验收');assert(typeof a.accept==='boolean','请明确验收结果');t.status=a.accept?'done':'doing';t.updates.push({at,memberId:mid.id,status:t.status,note:proof(a.note)});notify('任务验收结果',`${t.title}：${a.accept?'通过':'退回'}`,'info','tasks');break;
 }
 case 'project.pause': {requirePartner();live(p);p.status='paused';p.pauseReason=proof(a.reason);notify('项目紧急暂停',p.pauseReason,'critical');break;}
 case 'proposal.submit': {
  requirePartner(); assert(!p.proposals.some(g=>g.status==='pending'),'请先完成或撤回现有共同决策，避免相互冲突',409);
  const kind=a.kind; assert(['baseline','budget','stage_open','stage_close','member_add','member_remove','profit_rule','terms','resume','task_change','settlement','reconcile','ai_policy'].includes(kind),'决策类型不支持');
  if(kind==='baseline'){assert(p.status==='draft','基准计划已生效');verifyStages(p.stages,p.settings.totalBudgetCents);validShares(p);assert(p.settings.terms.length>=10,'请填写合作约定（职责、决策权、退出和分配规则）');}
  else if(kind!=='ai_policy')live(p);
  const data=clone(a.payload||{}); const signers=snapshots(p);
  if(kind==='ai_policy'){assert(ctx.aiPolicyVerified,'AI启用范围必须经专用接口校验',403);Object.assign(data,validatePolicy(data));}
  if(kind==='baseline'){data.plan={settings:clone(p.settings),stages:clone(p.stages),members:clone(p.members),name:p.name,description:p.description};}
  if(kind==='budget') {data.totalBudgetCents=cents(data.totalBudgetCents,'新总预算');data.minReserveCents=cents(data.minReserveCents,'新保留资金',true);assert(data.minReserveCents<=data.totalBudgetCents,'保留资金过大');assert(data.stageBudgets&&typeof data.stageBudgets==='object','需提供各阶段预算');const ss=p.stages.map(s=>({...s,budgetCents:cents(data.stageBudgets[s.id],'新阶段预算',true)}));verifyStages(ss,data.totalBudgetCents);}
  if(['stage_open','stage_close'].includes(kind)){stageFrom(p,data.stageId);data.evidence=proof(data.evidence);}
  if(kind==='member_add'){data.member=newMember(data,ctx.id+'-member');assert(data.member.role!=='partner'||partners(p).length<30,'第一版每个项目最多支持30名合伙人');assert(!activeMembers(p).some(m=>m.email===data.member.email),'该成员已存在');assert(activeMembers(p).length<40,'成员达到上限');}
  if(kind==='member_remove'){const m=getById(p.members,data.memberId,'成员');assert(m.active,'成员已退出');assert(m.userId!==p.ownerId,'第一版不支持移除项目创建人；不能绕过其审批权');assert(m.role!=='partner'||partners(p).length>2,'至少保留两名合伙人');assert(!p.tasks.some(t=>t.status!=='done'&&(t.assigneeId===m.id||t.reviewerId===m.id)),'该成员还有未完成任务，请先变更分工');assert(!p.purchases.some(q=>q.order&&q.status!=='received'&&(q.executorId===m.id||q.receiverId===m.id)),'该成员还有执行中的采购');assert(!p.settlements.some(s=>s.status==='approved'&&s.allocations.some(x=>x.memberId===m.id&&x.paidCents<x.amountCents)),'该成员还有未付结算');}
  if(kind==='profit_rule'){const ms=partners(p);assert(data.shares&&ms.every(m=>Number.isInteger(data.shares[m.id])&&data.shares[m.id]>=0&&data.shares[m.id]<=10000)&&sum(ms.map(m=>data.shares[m.id]))===10000,'比例须覆盖全体合伙人且合计100%');}
  if(kind==='terms')data.terms=text(data.terms,'新合作约定',12000);
  if(kind==='task_change'){const t=getById(p.tasks,data.taskId,'任务');assert(t.status!=='done','不能改写已验收任务');data.dueDate=date(data.dueDate,true);assert(activeMembers(p).some(m=>m.id===data.assigneeId&&m.role!=='viewer'),'新负责人无效');assert(activeMembers(p).some(m=>m.id===data.reviewerId&&m.role!=='viewer')&&data.assigneeId!==data.reviewerId,'新验收人无效');}
  if(kind==='settlement'){const f=finance(p);assert(f.unverifiedCount===0,'结算前请先完成账目复核');validShares(p);data.amountCents=cents(data.amountCents,'拟分配金额');assert(data.amountCents<=f.estimatedProfitCents-f.distributedCents-f.settlementHolds,'拟分配金额超过当前内部估算的未分配利润');assert(data.amountCents<=f.availableCents,'扣除承诺、应付及保留资金后的现金不足');data.basis=proof(data.basis);data.allocations=allocate(data.amountCents,partners(p));data.ledgerHash=sha(p.ledger);data.financeSnapshot=f;}
  if(kind==='reconcile'){assert(finance(p).unverifiedCount===0,'请先复核所有账目');data.balanceCents=cents(data.balanceCents,'对账余额',true);assert(data.balanceCents===finance(p).verifiedCash,'外部余额与系统核实余额不一致，请先补记或更正差异');data.evidence=proof(data.evidence);data.ledgerHash=sha(p.ledger);}
  p.proposals.push({id:ctx.id,kind,payload:data,reason:proof(a.reason),status:'pending',signers,decisions:{},createdAt:at,creatorId:mid.id});notify('新的共同决策等待全员会签',a.reason,'warning','decisions');break;
 }
 case 'proposal.cancel': {requirePartner();const g=getById(p.proposals,a.id,'决策');assert(g.creatorId===mid.id,'仅发起人可撤回');assert(g.status==='pending','只能撤回待决策事项');g.status='cancelled';g.cancelReason=proof(a.reason);notify('共同决策已撤回',g.reason,'info','decisions');break;}
 case 'proposal.vote': {
  requirePartner();const g=getById(p.proposals,a.id,'决策');assert(g.status==='pending','本轮决策已结束',409);assert(g.signers.some(s=>s.id===mid.id),'你不在本轮必签名单中',403);assert(['approve','reject'].includes(a.decision),'请同意或反对');assert(!g.decisions[mid.id],'你已提交本轮意见，不能覆盖历史决定',409);
  g.decisions[mid.id]={decision:a.decision,at,note:text(a.note,'决定说明',2000,a.decision==='reject')};
  if(a.decision==='reject'){g.status='rejected';notify('共同决策未通过',g.reason,'warning','decisions');break;}
  if(g.signers.every(s=>g.decisions[s.id]?.decision==='approve')){
   const d=g.payload;
   if(g.kind==='ai_policy'){p.ai ||= {runs:[],reviews:[],briefHistory:[]};p.ai.policy={...clone(d),signerIds:g.signers.map(s=>s.id),approvedAt:at,proposalId:g.id};p.ai.suspended=false;}
   if(g.kind==='baseline'){p.status='active';p.baseline={...clone(d.plan),approvedAt:at,proposalId:g.id};p.stages[0].status='open';}
   if(g.kind==='budget'){
    assert(d.totalBudgetCents>=finance(p).budgetUsed,'新总预算低于当前采购承诺与已发生支出');
    for(const s of p.stages){const used=sum(p.purchases.filter(q=>q.stageId===s.id&&RESERVED.has(q.status)).map(purchaseTotal));assert(d.stageBudgets[s.id]>=used,'新阶段预算低于已有采购承诺');s.budgetCents=d.stageBudgets[s.id];}p.settings.totalBudgetCents=d.totalBudgetCents;p.settings.minReserveCents=d.minReserveCents;
   }
   if(g.kind==='stage_open'){const s=stageFrom(p,d.stageId),i=p.stages.indexOf(s);assert(s.status==='locked','阶段已开放');assert(i===0||p.stages[i-1].status==='completed','必须先验收前一阶段，不能跳过验证直接扩大投入');s.status='open';}
   if(g.kind==='stage_close'){const s=stageFrom(p,d.stageId);assert(s.status==='open','仅可验收开放阶段');assert(p.tasks.filter(t=>t.stageId===s.id).every(t=>t.status==='done'),'本阶段还有未验收任务');assert(!p.purchases.some(q=>q.stageId===s.id&&['pending','approved','ordered'].includes(q.status)),'本阶段还有未完成采购');s.status='completed';s.evidence=d.evidence;}
   if(g.kind==='member_add')p.members.push(d.member);
   if(g.kind==='member_remove'){const m=getById(p.members,d.memberId,'成员');m.active=false;m.removedAt=at;}
   if(g.kind==='profit_rule')for(const m of partners(p))m.shareBps=d.shares[m.id];
   if(g.kind==='terms')p.settings.terms=d.terms;
   if(g.kind==='resume'){assert(p.status==='paused','项目并未暂停');p.status='active';p.pauseReason='';}
   if(g.kind==='task_change'){const t=getById(p.tasks,d.taskId,'任务');t.updates.push({at,memberId:mid.id,status:t.status,note:`共同决策变更：${g.reason}`,before:{dueDate:t.dueDate,assigneeId:t.assigneeId,reviewerId:t.reviewerId}});Object.assign(t,{dueDate:d.dueDate,assigneeId:d.assigneeId,reviewerId:d.reviewerId});}
   if(g.kind==='settlement'){assert(sha(p.ledger)===d.ledgerHash,'会签期间账目已变化，请撤回并基于新账目重新发起结算',409);const f=finance(p);assert(d.amountCents<=f.availableCents&&d.amountCents<=f.estimatedProfitCents-f.distributedCents-f.settlementHolds,'当前资金/利润不足，不能批准结算');p.settlements.push({id:g.id,at,amountCents:d.amountCents,allocations:clone(d.allocations),status:'approved',basis:d.basis});}
   if(g.kind==='reconcile'){assert(sha(p.ledger)===d.ledgerHash,'会签期间账目已变化，请重新对账',409);p.reconciliations.push({id:g.id,at,balanceCents:d.balanceCents,evidence:d.evidence,ledgerHash:d.ledgerHash});}
   if(SIGNIFICANT.has(g.kind))resetUncommitted(p,at,`共同规则变更：${g.kind}，重新确认采购`);
   g.status='approved';g.approvedAt=at;notify('共同决策已全员通过',g.reason,'info','decisions');
  }else notify('共同决策新增会签意见',`${mid.name}已确认`,'info','decisions');break;
 }
 case 'purchase.save': {
  canWork(p,actor);purchasing(p);const q=purchaseInput(p,a,a.id||ctx.id);assert(q.expiresAt>=today,'审批有效期不能早于今天');
  const old=a.id?getById(p.purchases,a.id,'采购单'):null;
  if(old){assert(!old.order,'已形成采购承诺后不能改写原单；实际差异另行记录并决策',409);assert(old.creatorId===mid.id,'只有发起人可修订采购单',403);assert(old.status!=='cancelled','已撤销采购不能直接修改');
   const history=[...old.history,purchaseArchive(old,at,'关键内容修订，旧会签失效')];Object.assign(old,q,{version:old.version+1,status:'draft',signers:[],decisions:{},readBy:{},history,updatedAt:at});notify('采购内容已修改，旧会签失效',q.title,'warning',`purchase:${q.id}`);
  }else p.purchases.push({...q,version:1,status:'draft',creatorId:mid.id,createdAt:at,updatedAt:at,signers:[],decisions:{},readBy:{},history:[],comments:[],order:null,receipts:[]});break;
 }
 case 'purchase.submit': {
  canWork(p,actor);purchasing(p);const q=getById(p.purchases,a.id,'采购单');assert(q.creatorId===mid.id,'只有发起人可提交',403);assert(['draft','rejected'].includes(q.status),'当前状态不可提交');assert(q.expiresAt>=today,'采购申请已过有效期，请修改');budgetCheck(p,q);
  if(q.status==='rejected'){q.history.push(purchaseArchive(q,at,'反对后重新提交'));q.version++;}
  q.status='pending';q.signers=snapshots(p);q.decisions={};q.readBy={};q.submittedAt=at;q.ruleSnapshot={approvalRule:'all_partners',memberIds:q.signers.map(s=>s.id)};
  const similar=p.purchases.filter(x=>x.id!==q.id&&RESERVED.has(x.status)&&x.supplier===q.supplier&&x.stageId===q.stageId);q.splitWarning=similar.length?`同阶段同供应商已有${similar.length}笔申请/采购，请复核是否拆单。`:'';
  notify('采购待全员会签',`${q.title}，¥${(purchaseTotal(q)/100).toFixed(2)}。${q.splitWarning}`,'warning',`purchase:${q.id}`);break;
 }
 case 'purchase.read': {
  const q=getById(p.purchases,a.id,'采购单');assert(a.version===q.version,'版本已变化，请刷新后确认',409);q.readBy[mid.id]=at;break;
 }
 case 'purchase.vote': {
  requirePartner();const q=getById(p.purchases,a.id,'采购单');assert(q.status==='pending','该采购不在待会签状态',409);assert(q.version===a.version,'内容版本已变化，请重新阅读',409);assert(q.expiresAt>=today,'采购申请已过有效期，请修订重审',409);assert(q.signers.some(s=>s.id===mid.id),'你不在冻结的必签名单中',403);assert(['approve','reject','needs_info'].includes(a.decision),'决定不正确');
  assert(!q.decisions[mid.id]||q.decisions[mid.id].decision==='needs_info','已经表态不能覆盖，请通过修订新版本重审',409);const note=text(a.note,'表态说明',2000,a.decision!=='approve');
  if(q.decisions[mid.id])q.comments.push({at,memberId:mid.id,text:`原补充要求：${q.decisions[mid.id].note}`});q.decisions[mid.id]={decision:a.decision,note,at};q.readBy[mid.id]=at;
  if(a.decision==='reject'){q.status='rejected';notify('采购会签未通过',`${q.title}：${note}`,'warning',`purchase:${q.id}`);}
  else if(q.signers.every(s=>q.decisions[s.id]?.decision==='approve')){purchasing(p);budgetCheck(p,q);q.status='approved';q.approvedAt=at;notify('采购已全员批准',`${q.title}，仅可按当前版本执行`,'info',`purchase:${q.id}`);}
  else notify(a.decision==='needs_info'?'采购需要补充说明':'采购新增会签意见',`${q.title}：${mid.name}${a.decision==='approve'?'已同意':'要求补充'}`,'info',`purchase:${q.id}`);break;
 }
 case 'purchase.comment': {canWork(p,actor);const q=getById(p.purchases,a.id,'采购单');q.comments.push({at,memberId:mid.id,text:proof(a.text),attachments:attachmentIds(a.attachments)});notify('采购讨论有新补充',q.title,'info',`purchase:${q.id}`);break;}
 case 'purchase.cancel': {requirePartner();const q=getById(p.purchases,a.id,'采购单');assert(!q.order&&!['received','cancelled'].includes(q.status),'已执行采购不能通过撤销掩盖事实');q.status='cancelled';q.cancelReason=proof(a.reason);notify('未执行采购已撤销',`${q.title}：${q.cancelReason}`,'warning',`purchase:${q.id}`);break;}
 case 'purchase.order': {
  canWork(p,actor);purchasing(p);const q=getById(p.purchases,a.id,'采购单');assert(q.executorId===mid.id,'仅指定执行人可登记下单',403);assert(q.status==='approved','全员批准前不允许下单',409);assert(q.version===a.version,'版本不一致',409);assert(q.expiresAt>=today,'批准已过有效期，请重新审批',409);budgetCheck(p,q);
  assert(a.payee===q.payee,'实际收款对象与批准内容不符，请重审',409);q.order={at,by:mid.id,reference:proof(a.reference),attachments:attachmentIds(a.attachments)};q.status='ordered';notify('已按批准内容登记下单',q.title,'info',`purchase:${q.id}`);break;
 }
 case 'purchase.pay': {
  requirePartner();const q=getById(p.purchases,a.id,'采购单');assert(q.order&&['ordered','received'].includes(q.status),'需要先登记已批准订单',409);assert(q.version===a.version,'采购版本不一致',409);assert(a.payee===q.payee,'收款对象与已批准内容不符',409);const amount=cents(a.amountCents);
  assert(amount<=purchaseTotal(q)-paid(p,q),'付款超过该批准单尚未支付金额',409);assert(finance(p).conservativeCash>=amount,'核实现金不足；已实际发生的超额支出请走异常支出登记',409);
  addEntry({kind:'purchase_payment',amountCents:amount,purchaseId:q.id,stageId:q.stageId,description:`采购付款：${q.title}`,evidence:proof(a.evidence),attachments:attachmentIds(a.attachments),payee:a.payee,unauthorized:false});notify('采购付款已登记，待独立复核',q.title,'info',`purchase:${q.id}`);break;
 }
 case 'purchase.receive': {
  canWork(p,actor);const q=getById(p.purchases,a.id,'采购单');assert(q.receiverId===mid.id,'仅指定验收人可登记验收',403);assert(q.order&&q.status==='ordered','仅可验收已下单采购');
  assert(Array.isArray(a.quantities)&&a.quantities.length===q.items.length,'请逐项填写本次合格到货数量');a.quantities.forEach((n,i)=>{assert(Number.isInteger(n)&&n>=0,'到货数量须为非负整数');const before=sum(q.receipts.map(r=>r.quantities[i]));assert(before+n<=q.items[i].quantity,'累计验收数量超过批准采购数量');});assert(a.quantities.some(n=>n>0)||a.exception,'请填到货数量或异常');
  q.receipts.push({id:ctx.id,at,by:mid.id,quantities:a.quantities,evidence:proof(a.evidence),exception:text(a.exception,'验收异常',2000,false),attachments:attachmentIds(a.attachments)});
  if(q.items.every((i,k)=>sum(q.receipts.map(r=>r.quantities[k]))===i.quantity))q.status='received';notify(a.exception?'采购验收发现异常':'采购验收已登记',`${q.title} ${a.exception||''}`,a.exception?'critical':'info',`purchase:${q.id}`);break;
 }
 case 'ledger.add': {
  requirePartner();live(p);assert(MANUAL_LEDGER.has(a.kind),'该账目类型须从采购/结算专用流程登记');const amount=cents(a.amountCents);if(a.stageId)stageFrom(p,a.stageId);
  const unauthorized=['operating_expense','loan_repayment','payable_payment','payable_expense'].includes(a.kind);
  const e=addEntry({kind:a.kind,amountCents:amount,stageId:a.stageId||null,description:text(a.description,'账目说明',500),evidence:proof(a.evidence),attachments:attachmentIds(a.attachments),unauthorized,purchaseId:a.purchaseId||null});
  if(e.purchaseId)getById(p.purchases,e.purchaseId,'关联采购');notify(unauthorized?'已发生的未经事前批准支出':'新增账目待独立复核',`${e.description}，¥${(amount/100).toFixed(2)}`,unauthorized?'critical':'info','finance');break;
 }
 case 'ledger.verify': {
  requirePartner();const e=getById(p.ledger,a.id,'账目');assert(!e.verifiedBy,'该账目已复核',409);assert(e.actorId!==mid.id,'不能复核自己登记的账目',403);e.verifiedBy=mid.id;e.verifiedAt=at;e.verifyNote=proof(a.note);notify('账目已独立复核',e.description,'info','finance');break;
 }
 case 'ledger.reverse': {
  requirePartner();const e=getById(p.ledger,a.id,'原账目');assert(e.verifiedBy,'请先确认原账目再提交冲销');assert(!['purchase_payment','distribution'].includes(e.kind),'采购/分红实付不支持直接冲销；真实退款请另行登记并对账');assert(!e.reversesId&&!p.ledger.some(x=>x.reversesId===e.id),'不能重复冲销');addEntry({kind:e.kind,amountCents:-e.amountCents,description:`冲销：${e.description}`,evidence:proof(a.evidence),attachments:attachmentIds(a.attachments),reversesId:e.id,unauthorized:false,stageId:e.stageId||null});notify('账目更正待独立复核',e.description,'warning','finance');break;
 }
 case 'settlement.pay': {
  requirePartner();const s=getById(p.settlements,a.id,'结算');assert(s.status==='approved','结算已完成或未批准');const allocation=getById(s.allocations.map(x=>({...x,id:x.memberId})),a.memberId,'分配对象'), real=s.allocations.find(x=>x.memberId===allocation.memberId);const amount=cents(a.amountCents);assert(amount<=real.amountCents-real.paidCents,'超过该成员尚未支付分红');assert(finance(p).conservativeCash>=amount,'实际现金不足');
  addEntry({kind:'distribution',amountCents:amount,description:`分红支付：${real.name}`,evidence:proof(a.evidence),attachments:attachmentIds(a.attachments),settlementId:s.id,recipientId:real.memberId,unauthorized:false});real.paidCents+=amount;if(s.allocations.every(x=>x.paidCents===x.amountCents))s.status='paid';notify('分红支付已登记',real.name,'info','finance');break;
 }
 case 'invite.create': {requirePartner();assert(ctx.inviteCreateVerified,'邀请未校验',403);const m=getById(p.members,a.memberId,'成员');assert(m.active&&!m.userId,'该成员已加入或已退出');break;}
 case 'attachment.add': {canWork(p,actor);assert(ctx.attachmentVerified,'文件未核验',403);assert(!p.attachments.some(x=>x.id===a.file.id),'附件已归档');p.attachments.push(a.file);break;}
 case 'channel.update': {requirePartner();assert(ctx.channelVerified,'通知配置未经服务端验证',403);notify('项目通知渠道已调整','通知只用于提醒，不替代正式会签','warning','notifications');break;}
 default: assert(false,'未实现的操作');
 }
 // 附件引用必须来自该项目；不得靠猜测对象 ID 读取他人凭证。
 function inspectAttachments(v){if(!v||typeof v!=='object')return;for(const [k,x] of Object.entries(v)){if(k==='attachments'&&Array.isArray(x)&&x.every(y=>typeof y==='string'))for(const id of x)assert(p.attachments.some(f=>f.id===id),'附件不属于该项目或尚未上传');else if(k!=='history'&&k!=='file')inspectAttachments(x);}}
 inspectAttachments(a);
 assert(new TextEncoder().encode(JSON.stringify(p)).length<=1400000,'该项目记录接近第一版容量上限，请导出归档并新建下一期项目',409);
 return {state:p,events,summary:ACTIONS[action.type]};
}
export function projectView(p,actor) {const member=getMember(p,actor);return {...p,currentMemberId:member.id,finance:finance(p)};}
