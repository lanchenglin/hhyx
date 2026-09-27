// Synthetic local fixture. Calls real Worker handlers, mocks the AI provider, sends nothing externally.
import {mkdir, writeFile} from 'node:fs/promises';
import {fixture} from './helpers.mjs';
import {publicEngine} from '../src/ai-policy.js';
const f=await fixture();
try {
  Object.assign(f.rt.env, {AI_MODEL:'mobile-test-model', AI_API_KEY:'mobile-test-key-not-real', AI_INPUT_CENTS_PER_MILLION:'100', AI_OUTPUT_CENTS_PER_MILLION:'500'});
  f.rt.env.AI_FETCH=async()=>Response.json({choices:[{finish_reason:'stop', message:{content:JSON.stringify({
    verdict:'needs_information',summary:'手机布局演示：先补齐需求验证资料；这是测试响应，不是真实经营建议。',summaryRefs:['brief'],
    findings:[{id:'f1',severity:'high',basis:'missing',title:'缺少可核对的试销资料',detail:'尚未提供客户需求和试销记录。<img src=x onerror=window.mobileXss=1>',refs:['brief'],evidence:[],suggestion:'按原计划补充试销证据，再讨论是否扩大采购。'}],
    missingInformation:[{topic:'试销与回款记录',why:'不能仅凭销量假设增加投入'}],
    recommendations:[{title:'整理试销验证资料',description:'整理可核对的成交及回款数据',deliverable:'提交试销记录和下一阶段建议',refs:['brief']}],
    decisions:['全体合伙人确认是否进入下一阶段'],limitations:['本报告由测试替身生成，不是外部市场调研。'],externalVerified:false
  })}}],usage:{prompt_tokens:1234,completion_tokens:567}});
  let p=await f.owner.ok(f.base+'/ai/policy',{engineFingerprint:publicEngine(f.rt.env).fingerprint,confirmScope:true,monthlyCallLimit:30,monthlyBudgetCents:2000,autoPurchase:false,autoStage:false});
  for(const c of f.all)await f.action(c,'proposal.vote',{id:p.proposals.at(-1).id,decision:'approve'});
  const pending=await f.submitPurchase({title:'第二批试销商品采购 · 等待最后一位合伙人确认'});
  for(const c of f.all.slice(1))await f.action(c,'purchase.vote',{id:pending.id,version:pending.version,decision:'approve',note:'测试本人意见，仍需最后一位合伙人独立决定'});
  p=await f.owner.ok(f.base,undefined,'GET');
  await f.action(f.owner,'task.add',{title:'核对供应商报价与退货条件',stageId:p.stages[0].id,assigneeId:p.members[0].id,reviewerId:p.members[1].id,dueDate:'2026-12-31',deliverable:'可核查报价及退货条款',description:'手机测试任务，不涉及真实采购'});
  const preview=await f.owner.ok(f.base+'/ai/preview',{kind:'project'});
  await f.owner.ok(f.base+'/ai/runs',{kind:'project',previewHash:preview.hash,confirmSend:true});await f.rt.settle();
  const project=await f.owner.ok(f.base,undefined,'GET');
  const secondProject=await f.owner.ok('/api/projects',{name:'另一个独立合作项目（测试）',description:'验证同一手机在多个项目间切换',totalBudgetCents:500000,minReserveCents:10000});
  const ai=await f.owner.ok(f.base+'/ai',undefined,'GET');
  const report=await f.owner.ok(f.base+'/ai/runs/'+ai.runs[0].id,undefined,'GET');
  const previews={project:await f.owner.ok(f.base+'/ai/preview',{kind:'project'}),purchase:await f.owner.ok(f.base+'/ai/preview',{kind:'purchase',targetId:pending.id}),stage:await f.owner.ok(f.base+'/ai/preview',{kind:'stage',targetId:project.stages[0].id})};
  const data={user:{id:f.owner.user.id,name:f.owner.user.name,email:f.owner.user.email},csrf:'offline-fixture-only',project,secondProject,projects:(await f.owner.ok('/api/projects',undefined,'GET')).projects,ai,report,previews,notifications:(await f.owner.ok('/api/notifications?limit=200',undefined,'GET')).items,audit:(await f.owner.ok(f.base+'/audit?limit=200',undefined,'GET')).records,channels:await f.owner.ok(f.base+'/channels',undefined,'GET')};
  await mkdir('artifacts',{recursive:true});
  await writeFile('artifacts/mobile-fixture.json',JSON.stringify(data));
  console.log('Mobile fixture ready: two synthetic projects, three signers, real local handlers + mocked provider.');
} finally {await f.close();}
