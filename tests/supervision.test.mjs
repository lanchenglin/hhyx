import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,PASSWORD} from './helpers.mjs';
import {reduceProject,finance,projectView} from '../src/domain.js';
import {load,mutate,verifyAudit,auditRows} from '../src/store.js';
import {supervisionDay,plusDate,supervisionAlerts,supervisionHolds,supervisionNeedsSync,stageBasis} from '../src/supervision.js';
import {scheduledSupervision} from '../src/supervision-scheduler.js';

const current=async f=>f.owner.ok(f.base,undefined,'GET');
const action=(f,c,type,data={},key)=>f.action(c,type,data,key);
const request=(f,c,type,data={})=>c.request(f.base+'/actions',{method:'POST',data:{type,data}});
async function voteAll(f,id,extra={}) {let p;for(const c of f.all)p=await action(f,c,'proposal.vote',{id,decision:'approve',note:'已核对本轮内容',...extra});return p;}
async function propose(f,kind,payload,reason='合成测试：共同确认新安排') {const p=await action(f,f.owner,'proposal.submit',{kind,payload,reason});return p.proposals.at(-1);}
async function policy(f,extra={}) {
  const p=await current(f),d={enabled:true,reporterId:p.members[0].id,reviewerId:p.members[1].id,intervalDays:7,reconcileDays:14,escalateDays:3,firstDueDate:plusDate(supervisionDay(),7),requireStageReport:true,blockCritical:false,blockStaleReport:false,...extra};
  const g=await propose(f,'supervision_policy',d);await voteAll(f,g.id);return d;
}
async function report(f,kind='weekly',extra={}) {
  const p=await current(f),today=supervisionDay();
  const result=await action(f,f.owner,'report.submit',{kind,stageId:'stage-pilot',fromDate:plusDate(today,-6),toDate:today,completed:'完成了一条样片，不含真实资金',evidence:'合成样片位置及耗时记录',problems:'渲染返工两次',nextSteps:'下一阶段是否扩展需另行决定',reviewerId:p.members[1].id,...extra});return result.supervision.reports.at(-1);
}
async function fundingData(f,extra={}) {
  const p=await current(f);return {stageId:'stage-pilot',purposeType:'new_experiment',additionalCents:100000,allocations:[{memberId:p.members[0].id,amountCents:60000,kind:'contribution'},{memberId:p.members[1].id,amountCents:40000,kind:'loan_in'}],reviewDate:plusDate(supervisionDay(),7),previousResults:'第一轮做出样片，渠道尚未验证',validation:'小规模验证新的发布流程',stopConditions:'达到本轮额度仍无验证结果则停止',terms:'借款条款仅为合成测试',...extra};
}

test('旧项目不因升级被自动启用监督或冻结；总览区分未汇报、未对账和实际现金',async()=>{
 const f=await fixture();try{
  const p=await current(f),v=p.supervisionView;assert.equal(p.supervision,undefined);assert.equal(v.policy,null);assert.equal(v.informationStatus,'needs_verification');assert.equal(v.lastReconciledAt,null);assert.equal(v.fundingVerifiedCents,0);assert.deepEqual(v.holds,[]);
  const q=await f.submitPurchase();assert.equal(q.status,'pending');assert.equal((await current(f)).finance.availableCents,800000);
  assert.equal((await f.owner.request(f.base.replace(f.pid,'not-this-project'))).status,404);
 }finally{await f.close();}
});

test('监督规则需完整三人确认，读取与未处理不计同意，停用也需共同确认',async()=>{
 const f=await fixture();try{
  const p=await current(f),d={enabled:true,reporterId:p.members[0].id,reviewerId:p.members[1].id,intervalDays:7,reconcileDays:14,escalateDays:3,firstDueDate:plusDate(supervisionDay(),7),requireStageReport:true,blockCritical:false,blockStaleReport:false};
  const g=await propose(f,'supervision_policy',d);
  for(const c of f.all.slice(0,2))await action(f,c,'proposal.vote',{id:g.id,decision:'approve'});
  assert.equal((await current(f)).supervision?.policy,undefined);
  await action(f,f.all[2],'proposal.vote',{id:g.id,decision:'approve'});assert.equal((await current(f)).supervision.policy.enabled,true);
  const off=await propose(f,'supervision_policy',{...d,enabled:false});assert.equal((await current(f)).supervision.policy.enabled,true);await voteAll(f,off.id);assert.equal((await current(f)).supervision.policy.enabled,false);
  assert.equal((await request(f,f.owner,'supervision.sync',{})).status,403);
 }finally{await f.close();}
});

test('简短汇报自动冻结资金和任务来源；已阅不是审批，更正保留旧版',async()=>{
 const f=await fixture();try{
  await policy(f);let p=await current(f);await action(f,f.owner,'task.add',{title:'交付样片',stageId:'stage-pilot',deliverable:'两分钟视频及耗时',assigneeId:p.members[0].id,reviewerId:p.members[1].id,dueDate:plusDate(supervisionDay(),2)});
  const r=await report(f);assert.equal(r.snapshot.tasks.length,1);assert.equal(r.snapshot.finance.verifiedCash,1000000);assert.equal(r.snapshot.period.reportedInCents,1000000);
  p=await action(f,f.all[1],'report.read',{id:r.id,contentHash:r.contentHash});assert.equal(p.supervision.reports[0].review,null);assert.equal(p.stages[0].status,'open');assert.equal(p.proposals.filter(g=>g.status==='pending').length,0);
  const r2=await report(f,'weekly',{supersedesId:r.id,completed:'更正：实际只完成一分钟'});assert.equal(r2.version,2);p=await current(f);assert.equal(p.supervision.reports[0].completed,r.completed);assert.equal(p.supervision.reports[0].contentHash,r.contentHash);assert.equal(p.supervisionView.lastReportAt,r2.at);
  assert.equal((await request(f,f.owner,'report.read',{id:r2.id,contentHash:r.contentHash})).status,409);
  const {row,state}=await load(f.rt.env,f.pid);assert.equal(verifyAudit(await auditRows(f.rt.env,f.pid,0,1000),state,row.audit_head).valid,true);
 }finally{await f.close();}
});

test('汇报不接受代报、自己验收、未来日期或其他项目附件；普通会话不新增密码门槛',async()=>{
 const f=await fixture();try{
  await policy(f);const p=await current(f),base={kind:'weekly',stageId:'stage-pilot',fromDate:supervisionDay(),toDate:supervisionDay(),completed:'测试',evidence:'暂无成果，说明原因',reviewerId:p.members[1].id};
  assert.equal((await request(f,f.all[1],'report.submit',base)).status,403);
  assert.equal((await request(f,f.owner,'report.submit',{...base,reviewerId:p.members[0].id})).status,400);
  assert.equal((await request(f,f.owner,'report.submit',{...base,toDate:plusDate(supervisionDay(),1)})).status,400);
  assert.equal((await request(f,f.owner,'report.submit',{...base,attachments:['foreign-file']})).status,400);
  const fresh=f.client();await fresh.ok('/api/auth/login',{email:'owner@example.test',password:PASSWORD});assert.equal((await request(f,fresh,'report.submit',base)).status,200);
 }finally{await f.close();}
});

test('阶段关闭必须先独立验收；资料变化拒绝旧验收与旧最后一票',async()=>{
 const f=await fixture();try{
  await policy(f);assert.equal((await request(f,f.owner,'proposal.submit',{kind:'stage_close',payload:{stageId:'stage-pilot',evidence:'只说做完了'},reason:'测试'})).body.code,'STAGE_REPORT_REQUIRED');
  const r=await report(f,'stage');assert.equal((await request(f,f.owner,'report.review',{id:r.id,accept:true,note:'自评'})).status,403);
  await action(f,f.all[1],'report.review',{id:r.id,accept:true,note:'核对合成样片与时间记录'});
  const g=await propose(f,'stage_close',{stageId:'stage-pilot',evidence:'成果经独立验收'});await action(f,f.owner,'proposal.vote',{id:g.id,decision:'approve'});
  await action(f,f.owner,'ledger.add',{kind:'revenue',amountCents:100,description:'新增合成记录',evidence:'测试'});
  await action(f,f.all[1],'proposal.vote',{id:g.id,decision:'approve'});
  assert.equal((await request(f,f.all[2],'proposal.vote',{id:g.id,decision:'approve'})).body.code,'STAGE_REPORT_STALE');assert.equal((await current(f)).stages[0].status,'open');
  await action(f,f.owner,'proposal.cancel',{id:g.id,reason:'资料变化重新核对'});
  const rr=await report(f,'stage',{supersedesId:r.id});await action(f,f.all[1],'report.review',{id:rr.id,accept:true,note:'核对更新后的成果与账目'});
  const close=await propose(f,'stage_close',{stageId:'stage-pilot',evidence:'重新核对'});let p=await voteAll(f,close.id);assert.equal(p.stages[0].acceptedReportId,rr.id);assert.equal(p.stages[0].status,'completed');
  const open=await propose(f,'stage_open',{stageId:'stage-scale',evidence:'前阶段已验收'});p=await voteAll(f,open.id);assert.equal(p.stages[1].status,'open');
 }finally{await f.close();}
});

test('计划变更展示冻结的新旧版本；不覆盖基准，不接受偷偷改变预算或角色',async()=>{
 const f=await fixture();try{
  const old=await current(f),g=await propose(f,'plan_change',{targetType:'stage',targetId:'stage-pilot',after:{goal:'先做一条样片，不扩大数量',acceptance:'交付样片及耗时记录'},impact:'范围缩小，不增加预算'});
  assert.equal(g.payload.before.goal,'先验证');assert.equal((await current(f)).stages[0].goal,'先验证');
  await action(f,f.owner,'proposal.vote',{id:g.id,decision:'approve'});assert.equal((await current(f)).stages[0].goal,'先验证');const p=await voteRemaining(f,g.id,[1,2]);
  assert.equal(p.stages[0].goal,'先做一条样片，不扩大数量');assert.deepEqual(p.baseline,old.baseline);assert.equal(p.supervision.changes.length,1);
  assert.equal((await request(f,f.owner,'proposal.submit',{kind:'plan_change',payload:{targetType:'project',after:{totalBudgetCents:9999999},impact:'测试'},reason:'测试'})).status,400);
 }finally{await f.close();}
});
async function voteRemaining(f,id,indexes) {let p;for(const n of indexes)p=await action(f,f.all[n],'proposal.vote',{id,decision:'approve'});return p;}

test('提前开放只能在全员批准明确例外后执行，不把前阶段伪装为已验收',async()=>{
 const f=await fixture();try{
  const g=await propose(f,'stage_open',{stageId:'stage-scale',evidence:'直接扩大'});await voteRemaining(f,g.id,[0,1]);assert.equal((await request(f,f.all[2],'proposal.vote',{id:g.id,decision:'approve'})).status,400);await action(f,f.owner,'proposal.cancel',{id:g.id,reason:'先明确风险'});
  const change=await propose(f,'plan_change',{targetType:'stage',targetId:'stage-scale',after:{},openEarly:true,exceptionReason:'仅并行准备素材，接受前阶段尚未验证的风险',impact:'不增加额度，阶段开放仍单独会签'});await voteAll(f,change.id);
  const open=await propose(f,'stage_open',{stageId:'stage-scale',evidence:'引用已批准并行安排'}),p=await voteAll(f,open.id);assert.equal(p.stages[0].status,'open');assert.equal(p.stages[1].status,'open');assert.ok(p.supervision.changes[0].consumedAt);
 }finally{await f.close();}
});

test('追加投入单区分项目预算、个人承诺和到账；个人承担必须额外明确确认',async()=>{
 const f=await fixture();try{
  await policy(f);const before=await current(f),d=await fundingData(f),g=await propose(f,'funding_request',d);
  assert.equal((await request(f,f.owner,'proposal.vote',{id:g.id,decision:'approve'})).status,400);
  let p=await voteAll(f,g.id,{acceptFunding:true});assert.equal(p.settings.totalBudgetCents,before.settings.totalBudgetCents+100000);assert.equal(p.finance.verifiedCash,before.finance.verifiedCash);assert.equal(p.ledger.length,before.ledger.length);assert.deepEqual(p.members.map(m=>m.shareBps),before.members.map(m=>m.shareBps));assert.equal(p.supervisionView.fundings[0].progress,'waiting');
  assert.equal((await request(f,f.owner,'proposal.submit',{kind:'budget',payload:{totalBudgetCents:p.settings.totalBudgetCents+1},reason:'绕过追加单'})).status,409);
  const key='same-funding-receipt-test-001',payload={id:g.id,memberId:p.members[0].id,amountCents:40000,evidence:'合成实际到账'};
  p=await action(f,f.owner,'funding.receipt',payload,key);const entry=p.ledger.at(-1);assert.equal(p.supervisionView.fundings[0].receivedCents,0);
  await action(f,f.owner,'funding.receipt',payload,key);p=await current(f);assert.equal(p.ledger.filter(e=>e.fundingId===g.id).length,1);
  p=await action(f,f.all[1],'ledger.verify',{id:entry.id,note:'独立核对测试来款'});assert.equal(p.supervisionView.fundings[0].receivedCents,40000);assert.equal(p.supervisionView.fundings[0].progress,'partial');
  assert.equal((await request(f,f.owner,'funding.receipt',{...payload,amountCents:30000})).status,400);
 }finally{await f.close();}
});

test('已有流水可关联追加单而不重复入账；冲销会减少已核实分担，不能虚报完成',async()=>{
 const f=await fixture();try{
  const d=await fundingData(f),g=await propose(f,'funding_request',d);await voteAll(f,g.id,{acceptFunding:true});let p=await current(f);
  p=await action(f,f.owner,'ledger.add',{kind:'loan_in',amountCents:40000,description:'实际借入测试款',evidence:'合成流水'});const entry=p.ledger.at(-1);
  p=await action(f,f.all[1],'ledger.verify',{id:entry.id,note:'核对'});const cash=p.finance.verifiedCash;
  p=await action(f,f.owner,'funding.link',{id:g.id,memberId:p.members[1].id,entryId:entry.id,evidence:'该笔正是本次借款'});assert.equal(p.finance.verifiedCash,cash);assert.equal(p.supervisionView.fundings[0].receivedCents,40000);
  assert.equal((await request(f,f.owner,'funding.link',{id:g.id,memberId:p.members[1].id,entryId:entry.id,evidence:'重复'})).status,400);
  p=await action(f,f.owner,'ledger.reverse',{id:entry.id,evidence:'原登记有误，追加反向记录'});assert.equal(p.ledger.at(-1).fundingId,g.id);assert.equal(p.supervisionView.fundings[0].receivedCents,0);
  assert.equal((await request(f,f.owner,'proposal.submit',{kind:'funding_cancel',payload:{fundingId:g.id},reason:'不能删除真实来款'})).status,409);
 }finally{await f.close();}
});

test('追加会签期间前轮事实改变，不允许最后一票悄悄接受新事实；未到账取消扣回预算',async()=>{
 const f=await fixture();try{
  let g=await propose(f,'funding_request',await fundingData(f));await voteRemaining(f,g.id,[2]);
  await action(f,f.owner,'ledger.add',{kind:'revenue',amountCents:100,description:'发生新变化',evidence:'测试'});
  await action(f,f.owner,'proposal.vote',{id:g.id,decision:'approve',acceptFunding:true});assert.equal((await request(f,f.all[1],'proposal.vote',{id:g.id,decision:'approve',acceptFunding:true})).status,409);
  await action(f,f.owner,'proposal.cancel',{id:g.id,reason:'更新资料后重提'});const before=await current(f);g=await propose(f,'funding_request',await fundingData(f));await voteAll(f,g.id,{acceptFunding:true});
  const cancel=await propose(f,'funding_cancel',{fundingId:g.id});const p=await voteAll(f,cancel.id);assert.equal(p.settings.totalBudgetCents,before.settings.totalBudgetCents);assert.equal(p.supervision.fundings[0].status,'cancelled');
 }finally{await f.close();}
});

test('异常必须原因、结果、另一人复核；已读或本人不能关闭，也不能把仍存在的问题标为消除',async()=>{
 const f=await fixture();try{
  await policy(f,{blockCritical:true});let p=await current(f);p=await action(f,f.owner,'ledger.add',{kind:'operating_expense',amountCents:500,description:'未经批准的测试支出',evidence:'真实场景的合成替身',stageId:'stage-pilot'});
  assert.ok(p.supervisionView.holds.length);assert.equal((await request(f,f.owner,'purchase.save',f.purchaseData())).body.code,'SUPERVISION_HOLD');
  const source=p.supervisionView.alerts.find(a=>a.sourceType==='ledger');p=await action(f,f.owner,'issue.create',{sourceKey:source.key,assigneeId:p.members[0].id,reviewerId:p.members[1].id,dueDate:plusDate(supervisionDay(),3)});const i=p.supervision.issues.at(-1);
  assert.equal((await request(f,f.owner,'issue.resolve',{id:i.id,result:'未先说明原因'})).status,400);
  await action(f,f.owner,'issue.respond',{id:i.id,cause:'未核对批准单',plan:'补齐事实，说明后续处理并复核'});await action(f,f.owner,'issue.resolve',{id:i.id,result:'已核对该记录，保留异常历史'});
  assert.equal((await request(f,f.owner,'issue.review',{id:i.id,accept:true,disposition:'accepted',note:'自己验收'})).status,403);
  assert.equal((await request(f,f.all[1],'issue.review',{id:i.id,accept:true,disposition:'resolved',note:'不允许假装消失'})).status,400);
  p=await action(f,f.all[1],'issue.review',{id:i.id,accept:true,disposition:'accepted',note:'已核实并共同知情，保留后续责任，不删除原支出'});assert.equal(p.supervision.issues[0].status,'closed');assert.equal(p.supervisionView.holds.length,0);assert.equal(p.ledger.at(-1).unauthorized,true);
  assert.equal((await f.submitPurchase()).status,'pending');
 }finally{await f.close();}
});

test('严重异常限制新增投入但不阻止已发生账目、已批准订单付款、汇报和独立复核',async()=>{
 const f=await fixture();try{
  const q=await f.orderPurchase();await policy(f,{blockCritical:true});let p=await current(f);
  p=await action(f,f.owner,'issue.create',{title:'重要异常测试',detail:'等待核实资金用途',severity:'critical',assigneeId:p.members[0].id,reviewerId:p.members[1].id,dueDate:plusDate(supervisionDay(),3)});
  p=await action(f,f.owner,'purchase.pay',{id:q.id,version:q.version,payee:q.payee,amountCents:1000,evidence:'已发生测试付款'});assert.equal(p.ledger.at(-1).amountCents,1000);
  await action(f,f.all[1],'ledger.verify',{id:p.ledger.at(-1).id,note:'核对实际付款'});await report(f);assert.equal((await current(f)).supervision.reports.length,1);
 }finally{await f.close();}
});

test('周期缺报、旧对账和延期会形成可追踪异常；不自动关闭，日提醒去重',async()=>{
 const f=await fixture();try{
  await policy(f,{blockStaleReport:true});const {state}=await load(f.rt.env,f.pid),future=plusDate(supervisionDay(),30),at=future+'T04:00:00.000Z';
  assert.ok(supervisionAlerts(state,future).some(a=>a.sourceType==='reports'));assert.ok(supervisionAlerts(state,future).some(a=>a.sourceType==='finance'));assert.ok(supervisionHolds(state,future).some(h=>h.key==='stale-report'));
  assert.equal(supervisionNeedsSync(state,future),true);
  const next=reduceProject(state,{type:'supervision.sync',data:{}},{id:'system:supervision',name:'测试监督服务'},{id:'test-sync',at,today:future,supervisionSystemVerified:true}).state;
  assert.equal(next.supervision.issues.length,2);assert.equal(supervisionNeedsSync(next,future),false);
  const later=plusDate(future,4),first=reduceProject(next,{type:'supervision.sync',data:{}},{id:'system:supervision',name:'测试'},{id:'test-sync-2',at:later+'T04:00:00.000Z',today:later,supervisionSystemVerified:true});
  assert.equal(first.events.filter(e=>e.title==='监督待办升级提醒').length,1);assert.equal(first.state.supervision.issues[0].status,'open');
  const twice=reduceProject(first.state,{type:'supervision.sync',data:{}},{id:'system:supervision',name:'测试'},{id:'test-sync-3',at:later+'T04:10:00.000Z',today:later,supervisionSystemVerified:true});assert.equal(twice.events.length,0);
  // The real scheduled entrypoint runs against actual fixture storage without model requests.
  let calls=0;f.rt.env.AI_FETCH=()=>{calls++;throw Error('不应调用模型');};await scheduledSupervision(f.rt.env);assert.equal(calls,0);
 }finally{await f.close();}
});

test('归档保留监督资料与导出，但拒绝写入；任务与成员不得绕过未结监督职责',async()=>{
 const f=await fixture();try{
  await policy(f);const r=await report(f),p=await current(f);
  assert.equal((await request(f,f.owner,'proposal.submit',{kind:'member_remove',payload:{memberId:p.members[1].id},reason:'绕过验收职责'})).status,409);
  const a=await f.owner.ok('/api/admin/projects/'+f.pid+'/lifecycle',{expectedRevision:p.revision,action:'archive',confirmName:p.name,confirmImpact:true,reason:'合成归档测试'});
  assert.ok(a.ok);assert.equal((await request(f,f.owner,'report.read',{id:r.id,contentHash:r.contentHash})).status,409);assert.equal((await f.owner.ok(f.base+'/export',undefined,'GET')).project.supervision.reports.length,1);
 }finally{await f.close();}
});

test('补交旧周期汇报不能伪装成最近进展；追加投入到期还要汇报验证结果',async()=>{
 const f=await fixture();try{
  await policy(f,{blockStaleReport:true});const today=supervisionDay();
  await report(f,'weekly',{fromDate:plusDate(today,-35),toDate:plusDate(today,-28)});
  let p=await current(f);assert.equal(p.supervisionView.informationStatus,'needs_verification');assert.ok(p.supervisionView.holds.some(h=>h.key==='stale-report'));
  const g=await propose(f,'funding_request',await fundingData(f,{reviewDate:today}));await voteAll(f,g.id,{acceptFunding:true});
  p=await current(f);assert.ok(supervisionAlerts(p,plusDate(today,1)).some(a=>a.key==='funding-review:'+g.id));
  await report(f,'weekly',{fundingIds:[g.id],completed:'本次渠道尚未验证，停止新增投入，结果并非成功'});
  p=await current(f);assert.equal(p.supervisionView.informationStatus,'reported_not_independently_verified');assert.ok(!supervisionAlerts(p,plusDate(today,1)).some(a=>a.key==='funding-review:'+g.id));
  assert.ok(supervisionAlerts(p,plusDate(today,1)).some(a=>a.key==='funding:'+g.id));assert.equal(p.supervisionView.fundings[0].receivedCents,0);
 }finally{await f.close();}
});

test('真实监督调度写入异常、审计及通知；并发重复调度不会重复建单或减掉必签人',async()=>{
 const f=await fixture();try{
  await policy(f);let p=await current(f);const signers=p.members.map(m=>[m.id,m.role]);
  p=await action(f,f.owner,'task.add',{title:'逾期任务触发监督',stageId:'stage-pilot',deliverable:'测试成果',assigneeId:p.members[0].id,reviewerId:p.members[1].id,dueDate:plusDate(supervisionDay(),-1)});
  const original=await current(f);await Promise.all([scheduledSupervision(f.rt.env),scheduledSupervision(f.rt.env)]);
  p=await current(f);assert.equal(p.supervision.issues.length,1);assert.deepEqual(p.members.map(m=>[m.id,m.role]),signers);
  assert.equal(p.revision,original.revision+1);assert.equal(p.supervision.issues[0].automatic,true);
  const notices=f.rt.db.prepare("SELECT count(*) AS n FROM notifications WHERE title='新增监督异常，请明确处理'").get().n;
  assert.equal(notices,3);await scheduledSupervision(f.rt.env);assert.equal((await current(f)).revision,p.revision);
  const {row,state}=await load(f.rt.env,f.pid);assert.equal(verifyAudit(await auditRows(f.rt.env,f.pid,0,1000),state,row.audit_head).valid,true);
 }finally{await f.close();}
});

test('并发登记追加到账不能超分担金额；过旧阶段报告不能绕过更新版本验收',async()=>{
 const f=await fixture();try{
  const g=await propose(f,'funding_request',await fundingData(f));await voteAll(f,g.id,{acceptFunding:true});let p=await current(f);
  const a={id:g.id,memberId:p.members[0].id,amountCents:60000,evidence:'同一笔合成来款的并发核对'};
  const results=await Promise.all([request(f,f.owner,'funding.receipt',a),request(f,f.all[1],'funding.receipt',a)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);
  p=await current(f);assert.equal(p.ledger.filter(e=>e.fundingId===g.id).length,1);
  const old=await report(f,'stage'),fresh=await report(f,'stage');
  assert.equal((await request(f,f.all[1],'report.review',{id:old.id,accept:true,note:'旧报告'})).status,409);
  assert.equal((await request(f,f.all[1],'report.review',{id:fresh.id,accept:true,note:'核对最新报告'})).status,200);
 }finally{await f.close();}
});
