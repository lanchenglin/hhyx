import worker from '../src/index.js';
import { runtime } from '../scripts/local-runtime.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
export const PASSWORD='Local-Test-Password-2026!';
export async function fixture({partners=3,activate=true,fund=true}={}) {
 const rt=await runtime({memory:true,vars:{BOOTSTRAP_TOKEN:'test-bootstrap-token-only',CONFIG_ENCRYPTION_KEY:randomBytes(32).toString('base64')}});
 const client=()=>({cookie:'',csrf:'',user:null,async request(path,{method='GET',data,form,key=crypto.randomUUID(),headers={}}={}){
  const req=new Request('http://localhost:8787'+path,{method,headers:{origin:'http://localhost:8787',cookie:this.cookie,'x-csrf-token':this.csrf,'x-idempotency-key':key,...(form?{}:data?{'Content-Type':'application/json'}:{}),...headers},body:form|| (data?JSON.stringify(data):undefined)});
  const res=await worker.fetch(req,rt.env,rt.ctx);let body;const content=res.headers.get('content-type')||'';if(content.includes('json'))body=await res.json();else body=await res.text();
  const cookie=res.headers.get('set-cookie');if(cookie)this.cookie=cookie.split(';')[0];if(body?.csrf)this.csrf=body.csrf;if(body?.user&&path.startsWith('/api/auth/'))this.user=body.user;
  return {status:res.status,body,headers:res.headers};
 },async ok(path,data,method='POST',key){const r=await this.request(path,{data,method,key});assert.ok(r.status>=200&&r.status<300,`${path} ${r.status} ${JSON.stringify(r.body)}`);return r.body;},async reauth(){return this.ok('/api/auth/reauth',{password:PASSWORD});}});
 const owner=client();await owner.ok('/api/auth/bootstrap',{token:'test-bootstrap-token-only',email:'owner@example.test',name:'项目负责人',password:PASSWORD});
 const p=await owner.ok('/api/projects',{name:'三人合作采购验证',description:'端到端测试项目，不包含真实资金',totalBudgetCents:1000000,minReserveCents:100000});
 const pid=p.id,base=`/api/projects/${pid}`,all=[owner];
 const action=async(c,type,data={},key)=>c.ok(base+'/actions',{type,data},'POST',key);
 for(let n=1;n<partners;n++){
  const p2=await action(owner,'member.add',{name:`合伙人${n}`,email:`partner${n}@example.test`,role:'partner'}),m=p2.members.at(-1);
  const invite=await owner.ok(base+'/invites',{memberId:m.id}),c=client();await c.ok('/api/auth/accept',{token:invite.url.split('=')[1],name:m.name,password:PASSWORD});all.push(c);
 }
 let project=await owner.ok(base,undefined,'GET');
 const share=Math.floor(10000/partners),shares=Object.fromEntries(project.members.map((m,i)=>[m.id,share+(i===0?10000-share*partners:0)]));
 project=await action(owner,'plan.update',{terms:'合伙人各自独立会签，采购前先确认风险；分阶段投入，账目如实登记，退出与分配需共同确认。',shares,stages:[{id:'stage-pilot',name:'小批量验证',budgetCents:500000,goal:'先验证',acceptance:'提交真实需求和测试数据',startDate:'2026-09-01',endDate:'2026-12-31'},{id:'stage-scale',name:'扩大执行',budgetCents:500000,goal:'验证成功后扩大',acceptance:'经营结果达成并共同确认',endDate:'2027-03-01'}]});
 for(const c of all)await c.reauth();
 if(activate){project=await action(owner,'proposal.submit',{kind:'baseline',payload:{},reason:'确认初始合作计划'});const g=project.proposals.at(-1);for(const c of all)project=await action(c,'proposal.vote',{id:g.id,decision:'approve',note:'本人已阅读并同意'});}
 if(fund&&activate){project=await action(owner,'ledger.add',{kind:'contribution',amountCents:1000000,description:'实际投入',evidence:'测试流水（无真实转账）'});project=await action(all[1],'ledger.verify',{id:project.ledger.at(-1).id,note:'核对出资记录'});}
 const purchaseData=(overrides={})=>({title:'试销商品采购',stageId:'stage-pilot',category:'inventory',items:[{name:'样品',spec:'A规格',quantity:10,unitCents:10000}],supplier:'测试供应商',payee:'测试公司 / 尾号0001',paymentTerms:'先确认后付款',reason:'验证小批量需求',risk:'滞销风险',exitPlan:'约定可退货，限制试销规模',quote:'已对照两家报价',dueDate:'2027-01-01',expiresAt:'2026-12-31',executorId:project.members[0].id,receiverId:project.members[1].id,...overrides});
 const createPurchase=async(overrides={})=>{let v=await action(owner,'purchase.save',purchaseData(overrides));return v.purchases.at(-1);};
 const submitPurchase=async(overrides={})=>{const q=await createPurchase(overrides);const v=await action(owner,'purchase.submit',{id:q.id});return v.purchases.find(x=>x.id===q.id);};
 const approvePurchase=async(overrides={})=>{const q=await submitPurchase(overrides);let v;for(const c of all)v=await action(c,'purchase.vote',{id:q.id,version:q.version,decision:'approve',note:''});return v.purchases.find(x=>x.id===q.id);};
 const orderPurchase=async(overrides={})=>{const q=await approvePurchase(overrides);const v=await action(owner,'purchase.order',{id:q.id,version:q.version,payee:q.payee,reference:'ORDER-TEST-001'});return v.purchases.find(x=>x.id===q.id);};
 return {rt,client,all,owner,pid,base,action,purchaseData,createPurchase,submitPurchase,approvePurchase,orderPurchase,async close(){await rt.settle();rt.close();}};
}
