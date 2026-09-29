import {fixture,PASSWORD} from './helpers.mjs';
import {supervisionDay,plusDate} from '../src/supervision.js';

// All accounts and business data below are synthetic and exist only in this fixture.
export async function supervisionFixture() {
  const f=await fixture(),today=supervisionDay();
  let p=await f.owner.ok(f.base,undefined,'GET');
  const vote=async g=>{for(const c of f.all)p=await f.action(c,'proposal.vote',{id:g.id,decision:'approve',acceptFunding:true,note:'明确的合成测试同意'});};
  p=await f.action(f.owner,'proposal.submit',{kind:'supervision_policy',reason:'每周提交成果，重要变化共同决定',payload:{enabled:true,reporterId:p.members[0].id,reviewerId:p.members[1].id,intervalDays:7,reconcileDays:14,escalateDays:3,firstDueDate:plusDate(today,7),requireStageReport:true,blockCritical:false,blockStaleReport:false}});await vote(p.proposals.at(-1));
  p=await f.action(f.owner,'proposal.submit',{kind:'plan_change',reason:'从空泛验证改为先交付样片',payload:{targetType:'stage',targetId:'stage-pilot',after:{name:'第一条 AI 漫剧样片',goal:'先交付一条样片并记录实际耗时，再共同决定是否批量制作',acceptance:'两分钟可播放样片、工程位置、API花费和返工原因'},impact:'本次不增加预算，先明确成果与验收口径'}});await vote(p.proposals.at(-1));
  for(const kind of ['weekly','stage'])p=await f.action(f.owner,'report.submit',{kind,stageId:'stage-pilot',fromDate:plusDate(today,-6),toDate:today,completed:'已完成样片初版；画面和旁白正在复核。<img src=x onerror="window.badReport=true">',evidence:'合成资料：样片、工程及本轮耗时记录，不包含真实项目',problems:'两次画面返工，先不批量购买更多服务额度。',nextSteps:'复核样片后，再决定是否试做第二条。',reviewerId:p.members[1].id});
  p=await f.action(f.owner,'proposal.submit',{kind:'funding_request',reason:'只做一次新渠道小规模验证',payload:{stageId:'stage-pilot',purposeType:'new_experiment',additionalCents:100000,allocations:[{memberId:p.members[0].id,amountCents:60000,kind:'contribution'},{memberId:p.members[1].id,amountCents:40000,kind:'loan_in'}],reviewDate:plusDate(today,7),previousResults:'首条样片已经完成初版，仍需复核真实制作成本。',validation:'测试另一种发布方式，不直接扩大制作规模。',stopConditions:'本轮预算花完仍未形成验证结果则暂停。'}});await vote(p.proposals.at(-1));const funding=p.supervision.fundings.at(-1);
  p=await f.action(f.owner,'funding.receipt',{id:funding.id,memberId:p.members[0].id,amountCents:30000,evidence:'合成测试到账，非真实付款'});p=await f.action(f.all[1],'ledger.verify',{id:p.ledger.at(-1).id,note:'核对合成来款'});
  p=await f.action(f.owner,'issue.create',{title:'阶段耗时与原估计不一致',detail:'本轮记录有两次返工，需先解释原因。',severity:'warning',assigneeId:p.members[0].id,reviewerId:p.members[1].id,dueDate:plusDate(today,3)});
  // Refresh a stage report after the changed finance snapshot, preserving prior versions.
  const prior=p.supervision.reports.filter(r=>r.kind==='stage').at(-1);
  p=await f.action(f.owner,'report.submit',{kind:'stage',stageId:'stage-pilot',fromDate:plusDate(today,-6),toDate:today,completed:'样片与本轮投入已汇总，等待独立验收。',evidence:'合成测试成果记录',problems:'暂不扩大制作',nextSteps:'验收后再共同决定',reviewerId:p.members[1].id,supersedesId:prior.id});
  return {f,project:p,accounts:[{email:'owner@example.test',password:PASSWORD},{email:'partner1@example.test',password:PASSWORD},{email:'partner2@example.test',password:PASSWORD}],async close(){await f.close();}};
}
