// All transitions are committed by the project reducer/CAS, never by an admin shortcut.
import {assert,text,cents,sha,date} from './util.js';
const members=p=>p.members.filter(m=>m.active);
const partners=p=>members(p).filter(m=>m.role==='partner');
const sum=xs=>xs.reduce((a,b)=>a+b,0);
export const openExit=p=>(p.exits||[]).find(x=>x.status==='settling');
export const governanceHash=p=>sha({owner:p.ownerId,members:p.members});
export const exitBasis=p=>sha({owner:p.ownerId,members:p.members,settings:p.settings,tasks:p.tasks,purchases:p.purchases,ledger:p.ledger,settlements:p.settlements});
export const exitPaid=(p,id,verified=false)=>sum(p.ledger.filter(e=>e.exitId===id&&['exit_payment','exit_receipt'].includes(e.kind)&&(!verified||e.verifiedBy)).map(e=>e.amountCents));
export const exitHold=p=>sum((p.exits||[]).filter(x=>x.status==='settling'&&x.netCents>0).map(x=>Math.max(0,x.netCents-exitPaid(p,x.id))));
export const exitProfitHold=p=>sum((p.exits||[]).filter(x=>x.status==='settling').map(x=>x.profitCents));
export const exitProfitDistributed=p=>sum((p.exits||[]).filter(x=>x.status==='completed').map(x=>x.profitCents));
function workMember(p,id,leaving){return members(p).find(m=>m.id===id&&m.id!==leaving&&m.userId&&m.role!=='viewer');}
function validateHandover(p,leaving,a){
 const tasks=p.tasks.filter(t=>t.status!=='done'&&(t.assigneeId===leaving||t.reviewerId===leaving));
 const purchases=p.purchases.filter(q=>!['received','cancelled'].includes(q.status)&&(q.executorId===leaving||q.receiverId===leaving));
 assert(Array.isArray(a.tasks)&&Array.isArray(a.purchases),'请填写所有未完成分工的交接安排');
 assert(a.tasks.length===tasks.length&&new Set(a.tasks.map(t=>t.id)).size===tasks.length,'任务交接清单不完整或重复');
 assert(a.purchases.length===purchases.length&&new Set(a.purchases.map(q=>q.id)).size===purchases.length,'采购交接清单不完整或重复');
 return {tasks:tasks.map(t=>{const x=a.tasks.find(x=>x.id===t.id);assert(x&&workMember(p,x.assigneeId,leaving)&&workMember(p,x.reviewerId,leaving)&&x.assigneeId!==x.reviewerId,'任务交接须由不同的有效执行人/验收人负责');return {id:t.id,assigneeId:x.assigneeId,reviewerId:x.reviewerId};}),purchases:purchases.map(q=>{const x=a.purchases.find(x=>x.id===q.id);assert(x&&workMember(p,x.executorId,leaving)&&workMember(p,x.receiverId,leaving)&&x.executorId!==x.receiverId,'采购交接须保留不同执行人与验收人');return {id:q.id,executorId:x.executorId,receiverId:x.receiverId};})};
}
export function validateExit(p,input,f){
 const m=members(p).find(m=>m.id===input.memberId);assert(m&&m.role==='partner'&&m.userId,'退出者必须是已加入的合伙人');
 assert(m.userId!==p.ownerId,'项目负责人请先完成所有权移交，再申请退出',409);assert(partners(p).length>=3,'退出后须至少保留两位合伙人；两人项目应先结束业务并归档',409);
 assert(!openExit(p),'请先完成现有退出清算',409);assert(f.unverifiedCount===0,'退出清算前请先复核全部账目',409);
 assert(!p.settlements.some(s=>s.status==='approved'&&s.allocations.some(a=>a.memberId===m.id&&a.paidCents<a.amountCents)),'请先结清该成员既有分红，不把旧欠款重复计入退出金额',409);
 const rest=partners(p).filter(x=>x.id!==m.id),shares=input.shares;
 assert(shares&&Object.keys(shares).length===rest.length&&rest.every(x=>Number.isInteger(shares[x.id])&&shares[x.id]>=0&&shares[x.id]<=10000)&&sum(rest.map(x=>shares[x.id]))===10000,'退出后的比例须覆盖剩余合伙人并合计100%');
 const data={memberId:m.id,memberName:m.name,capitalCents:cents(input.capitalCents,'约定返还出资',true),profitCents:cents(input.profitCents,'本次约定利润分配',true),reimburseCents:cents(input.reimburseCents,'约定偿还垫款',true),owedCents:cents(input.owedCents,'成员应向项目补缴/抵扣',true),shares:structuredClone(shares),handover:validateHandover(p,m.id,input.handover||{}),basis:text(input.basis,'金额依据、存货和未结责任处理',5000),responsibilities:text(input.responsibilities,'退出后的合同、债务和争议安排',5000),dueDate:date(input.dueDate,true),basisHash:exitBasis(p),financeSnapshot:f};
 data.netCents=data.capitalCents+data.profitCents+data.reimburseCents-data.owedCents;assert(Number.isSafeInteger(data.netCents)&&Math.abs(data.netCents)<=100000000000,'净清算金额超出范围');
 assert(data.profitCents<=Math.max(0,f.estimatedProfitCents-f.distributedCents-f.settlementHolds-f.exitProfitHeldCents),'约定利润部分超过可分配内部估算利润');
 assert(data.netCents<=0||data.netCents<=f.availableCents,'扣除采购、应付及保留资金后，不足以预占本次退出净支出',409);return data;
}
export function applyHandover(p,plan,at,actorId){
 for(const h of plan.handover.tasks){const t=p.tasks.find(t=>t.id===h.id);t.updates.push({at,memberId:actorId,status:t.status,note:'全员批准退出交接',before:{assigneeId:t.assigneeId,reviewerId:t.reviewerId},exitId:plan.id});t.assigneeId=h.assigneeId;t.reviewerId=h.reviewerId;}
 for(const h of plan.handover.purchases){const q=p.purchases.find(q=>q.id===h.id);q.assignmentHistory||=[];q.assignmentHistory.push({at,exitId:plan.id,executorId:q.executorId,receiverId:q.receiverId});q.executorId=h.executorId;q.receiverId=h.receiverId;}
}
export function verifyExitReady(p,plan,f){
 assert(plan&&plan.status==='settling','没有可结清的退出计划',409);assert(f.unverifiedCount===0,'请先独立复核全部账目',409);
 assert(exitPaid(p,plan.id,true)===Math.abs(plan.netCents),'实际收付尚未足额登记并独立复核，不能退出',409);
 assert(!p.tasks.some(t=>t.status!=='done'&&(t.assigneeId===plan.memberId||t.reviewerId===plan.memberId)),'还有未交接任务',409);
 assert(!p.purchases.some(q=>!['received','cancelled'].includes(q.status)&&(q.executorId===plan.memberId||q.receiverId===plan.memberId)),'还有未交接采购',409);
 assert(partners(p).length>=3&&partners(p).filter(m=>m.id!==plan.memberId).every(m=>Object.hasOwn(plan.shares,m.id)),'成员已变化，请重新处理清算方案',409);
}
