import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import worker from '../src/index.js';
import {runtime} from '../scripts/local-runtime.mjs';
import {fixture,PASSWORD} from './helpers.mjs';
import {hashPassword,verifyPassword,decrypt} from '../src/util.js';
import {one,load} from '../src/store.js';
import {ensureInitialAdmin} from '../src/auth.js';
import {resolveAiEnv} from '../src/system-config.js';
import {publicEngine} from '../src/ai-policy.js';
import {buildSnapshot} from '../src/ai-snapshot.js';
import {requestAnalysis,runAiJob} from '../src/ai.js';
import {deliverOne} from '../src/notifications.js';

function client(rt){return {cookie:'',csrf:'',async request(path,{method='GET',data,headers={},key=crypto.randomUUID()}={}){
 const req=new Request('http://localhost:8787'+path,{method,headers:{origin:'http://localhost:8787',cookie:this.cookie,'x-csrf-token':this.csrf,'x-idempotency-key':key,...(data?{'Content-Type':'application/json'}:{}),...headers},body:data?JSON.stringify(data):undefined});
 const r=await worker.fetch(req,rt.env,rt.ctx),body=await r.json();if(r.headers.get('set-cookie'))this.cookie=r.headers.get('set-cookie').split(';')[0];if(body.csrf)this.csrf=body.csrf;return {status:r.status,body};
 },async ok(path,data,method='POST'){const r=await this.request(path,{data,method});assert.ok(r.status<300,JSON.stringify(r));return r.body;}};}
const aiConfig=(more={})=>({expectedRevision:0,enabled:true,provider:'openai_compatible',baseUrl:'https://api.openai.com/v1',model:'test-model',key:'mock-admin-key-not-real',inputCentsPerMillion:500,outputCentsPerMillion:1000,outputTokens:2048,structured:true,reason:'Test-only AI configuration',...more});
const accountPatch=(u,more={})=>({username:u.username||u.email.split('@')[0],name:u.name,systemRole:u.systemRole,canCreateProjects:u.canCreateProjects,disabled:u.disabled,expectedVersion:u.authVersion,reason:'Test permissions change',confirmImpact:true,...more});
const getUser=async(f,id)=> (await f.owner.ok('/api/admin/users/'+id,undefined,'GET')).user;
const getProject=async f=> f.owner.ok('/api/admin/projects/'+f.pid,undefined,'GET');
const life=async(f,action,more={})=>{const p=await getProject(f);return f.owner.request(`/api/admin/projects/${f.pid}/lifecycle`,{method:'POST',data:{action,expectedRevision:p.revision,confirmName:p.name,confirmImpact:true,reason:'Test lifecycle change',...more}});};

test('管理员初始化、旧库升级和本地重启',async t=>{
 await t.test('迁移只提升原始初始化账号，保留密码与普通账号',async()=>{
  const db=new DatabaseSync(':memory:');try{
   db.exec(await readFile(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
   const hash=hashPassword(PASSWORD);for(const id of ['first','partner'])db.prepare('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)').run(id,id+'@example.test',id,hash,new Date().toISOString());
   db.prepare("INSERT INTO settings VALUES('bootstrapped','first')").run();db.exec(await readFile(new URL('../migrations/0003_administration.sql',import.meta.url),'utf8'));
   const admin=db.prepare("SELECT * FROM users WHERE id='first'").get(),other=db.prepare("SELECT * FROM users WHERE id='partner'").get();
   assert.equal(admin.username,'admin');assert.equal(admin.system_role,'admin');assert.equal(admin.password_hash,hash);assert.equal(admin.must_change_password,0);assert.equal(other.system_role,'member');assert.equal(other.username,null);
  }finally{db.close();}
 });
 await t.test('显式启用初始admin，首登强制改密且不覆写已设置密码',async()=>{
  const tmp='TempOnly10'; // Synthetic ten-character bootstrap password, not a user secret.
  const rt=await runtime({memory:true,vars:{INITIAL_ADMIN_ENABLED:'true',INITIAL_ADMIN_PASSWORD:tmp}});try{
   const c=client(rt);const stat=await c.ok('/api/auth/status',undefined,'GET');assert.equal(stat.initialized,true);
   const login=await c.ok('/api/auth/login',{email:'admin',password:tmp});assert.equal(login.user.mustChangePassword,true);
   for(const path of ['/api/projects','/api/admin/users'])assert.equal((await c.request(path)).body.code,'PASSWORD_CHANGE_REQUIRED');
   await c.ok('/api/auth/reauth',{password:tmp});await c.ok('/api/auth/password',{password:PASSWORD});
   assert.equal((await c.ok('/api/auth/me',undefined,'GET')).user.mustChangePassword,false);
   assert.equal(await ensureInitialAdmin(rt.env),false);assert.equal((await c.request('/api/auth/login',{method:'POST',data:{email:'admin',password:tmp}})).status,401);
   await c.ok('/api/auth/login',{email:'admin',password:PASSWORD});assert.equal((await c.request('/api/admin/users')).status,200);
  }finally{await rt.settle();rt.close();}
 });
 await t.test('没有Secret和明确启用时不生成公开默认管理员',async()=>{
  const rt=await runtime({memory:true});try{assert.equal(await ensureInitialAdmin(rt.env),false);assert.equal(await one(rt.env,'SELECT COUNT(*) AS n FROM users').then(x=>x.n),0);}finally{rt.close();}
 });
 await t.test('本地迁移只执行一次，重启不重置数据',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hhyx-admin-test-'));try{
   let rt=await runtime({dir});await rt.env.DB.prepare("INSERT INTO settings(key,value) VALUES('test-persist','kept')").run();rt.close();
   rt=await runtime({dir});assert.equal((await one(rt.env,"SELECT value FROM settings WHERE key='test-persist'")).value,'kept');assert.equal((await one(rt.env,'SELECT COUNT(*) AS n FROM local_migrations')).n,5);rt.close();
  }finally{await rm(dir,{recursive:true,force:true});}
 });
});

test('管理员用户管理：独立系统权限，不代替项目签名',async t=>{
 const f=await fixture({partners:3});try{
 await t.test('普通用户不能访问后台接口，用户名admin可登录',async()=>{
  for(const path of ['/api/admin/overview','/api/admin/users','/api/admin/projects','/api/admin/ai-settings','/api/admin/audit'])assert.equal((await f.all[1].request(path)).status,403);
  const c=f.client();await c.ok('/api/auth/login',{email:'admin',password:PASSWORD});assert.equal(c.user.systemRole,'admin');
  const r=await c.request('/api/admin/users',{method:'POST',data:{}});assert.equal(r.body.code,'REAUTH_REQUIRED');
 });
 await t.test('管理员也不能绕过来源、CSRF或允许列表',async()=>{
  const r=await f.owner.request('/api/admin/users',{method:'POST',data:{},headers:{'x-csrf-token':'wrong'}});assert.equal(r.status,403);
  const cross=await f.owner.request('/api/admin/users',{method:'POST',data:{},headers:{origin:'https://evil.invalid'}});assert.equal(cross.status,403);
  const bypass=await f.owner.request(f.base+'/actions',{method:'POST',data:{type:'admin.lifecycle',data:{action:'trash'}}});assert.equal(bypass.status,403);
 });
 await t.test('创建用户幂等、强制改密，不存临时密码明文',async()=>{
  const key=crypto.randomUUID(),data={username:'new-user',name:'New user',email:'new-user@example.test',systemRole:'member',canCreateProjects:false,temporaryPassword:'Synthetic-Temporary-Password!',reason:'Create test account'};
  const first=await f.owner.request('/api/admin/users',{method:'POST',data,key});assert.equal(first.status,201);
  const second=await f.owner.request('/api/admin/users',{method:'POST',data,key});assert.equal(second.body.id,first.body.id);
  const u=await getUser(f,first.body.id);assert.equal(u.mustChangePassword,true);assert.equal(u.canCreateProjects,false);
  const audit=await f.owner.ok('/api/admin/audit',undefined,'GET');assert.ok(!JSON.stringify(audit).includes(data.temporaryPassword));
  const c=f.client();await c.ok('/api/auth/login',{email:'new-user',password:data.temporaryPassword});assert.equal((await c.request('/api/projects')).body.code,'PASSWORD_CHANGE_REQUIRED');
 });
 await t.test('不能停用自己或移除最后管理员，数据库亦有保护',async()=>{
  const u=await getUser(f,f.owner.user.id);const r=await f.owner.request('/api/admin/users/'+u.id,{method:'POST',data:accountPatch(u,{systemRole:'member'})});assert.equal(r.status,409);
  assert.throws(()=>f.rt.db.prepare("UPDATE users SET disabled=1 WHERE id=?").run(u.id),/last_active_admin/);
  assert.throws(()=>f.rt.db.prepare('DELETE FROM users WHERE id=?').run(u.id),/disable_accounts/);
 });
 await t.test('停用用户立即撤销会话，不移除采购签名和项目成员',async()=>{
  const q=await f.submitPurchase(),target=f.all[2].user.id,u=await getUser(f,target);
  const r=await f.owner.ok('/api/admin/users/'+target,accountPatch(u,{disabled:true}));assert.equal(r.ok,true);
  assert.equal((await f.all[2].request('/api/auth/me')).status,401);
  const fresh=f.client();assert.equal((await fresh.request('/api/auth/login',{method:'POST',data:{email:u.email,password:PASSWORD}})).status,401);
  const p=await f.owner.ok(f.base,undefined,'GET');assert.equal(p.purchases.find(x=>x.id===q.id).signers.length,3);assert.equal(p.members.find(m=>m.userId===target).active,true);
  const changed=await getUser(f,target);await f.owner.ok('/api/admin/users/'+target,accountPatch(changed,{disabled:false}));await f.all[2].ok('/api/auth/login',{email:u.email,password:PASSWORD});await f.all[2].reauth();
 });
 await t.test('可限制新建项目，仍保留原项目访问；旧版本更新被拒',async()=>{
  const target=f.all[1].user.id,u=await getUser(f,target);await f.owner.ok('/api/admin/users/'+target,accountPatch(u,{canCreateProjects:false}));
  const stale=await f.owner.request('/api/admin/users/'+target,{method:'POST',data:accountPatch(u)});assert.equal(stale.status,409);
  await f.all[1].ok('/api/auth/login',{email:u.email,password:PASSWORD});assert.equal((await f.all[1].request('/api/projects',{method:'POST',data:{}})).status,403);assert.equal((await f.all[1].request(f.base)).status,200);await f.all[1].reauth();
 });
 await t.test('重置密码使旧密码失效，新密码强制本人更改，其他成员不受影响',async()=>{
  const target=f.all[2].user.id,u=await getUser(f,target),tmp='Temporary-Reset-Only!';
  await f.owner.ok('/api/admin/users/'+target+'/reset-password',{expectedVersion:u.authVersion,temporaryPassword:tmp,reason:'Reset test account'});
  assert.equal((await f.all[2].request('/api/auth/me')).status,401);const c=f.client();assert.equal((await c.request('/api/auth/login',{method:'POST',data:{email:u.email,password:PASSWORD}})).status,401);
  await c.ok('/api/auth/login',{email:u.email,password:tmp});assert.equal(c.user.mustChangePassword,true);assert.equal((await c.request('/api/projects')).status,403);assert.equal((await f.all[1].request(f.base)).status,200);
 });
 await t.test('审计行不允许更新或删除，没有明文密码返回',async()=>{
  const users=await f.owner.ok('/api/admin/users',undefined,'GET');assert.ok(!JSON.stringify(users).includes('password_hash'));assert.ok(!JSON.stringify(users).includes(PASSWORD));
  assert.throws(()=>f.rt.db.exec('DELETE FROM admin_audit'),/append_only/);assert.throws(()=>f.rt.db.exec("UPDATE admin_audit SET details='{}'"),/append_only/);
 });
 }finally{await f.close();}
});

test('项目生命周期与项目角色会签',async t=>{
 const f=await fixture({partners:3});try{
 await t.test('归档要求明确名称、影响确认和当前版本',async()=>{
  assert.equal((await life(f,'archive',{confirmName:'wrong'})).status,400);assert.equal((await life(f,'archive',{confirmImpact:false})).status,400);assert.equal((await life(f,'archive',{expectedRevision:0})).status,409);
 });
 const q=await f.submitPurchase();
 await t.test('归档只读、能导出且没有删除采购账目，后台也不能代签',async()=>{
  assert.equal((await life(f,'archive')).status,200);assert.equal((await f.all[1].request(f.base)).status,200);
  for(const [sub,data] of [['actions',{type:'purchase.vote',data:{id:q.id,version:q.version,decision:'approve'}}],['invites',{memberId:'x'}],['ai/preview',{kind:'project'}]])assert.equal((await f.owner.request(f.base+'/'+sub,{method:'POST',data})).status,409);
  const p=await getProject(f);assert.equal(p.lifecycle,'archived');assert.equal(p.project.purchases.length,1);assert.ok(p.project.ledger.length>0);
  assert.equal((await f.owner.request(f.base+'/export')).status,200);
  assert.equal((await f.owner.request('/api/admin/projects/'+f.pid+'/approve',{method:'POST',data:{}})).status,404);
 });
 await t.test('归档停止外发通知，即使旧任务已排队也不再发送',async()=>{
  const env=f.rt.env;await env.DB.prepare("INSERT INTO outbox(id,project_id,channel,title,body,target,severity,created_at) VALUES('archive-notice',?,'wecom','test','','','info',?)").bind(f.pid,new Date().toISOString()).run();let calls=0;
  await deliverOne(env,'archive-notice',async()=>{calls++;throw Error('must not send');});assert.equal(calls,0);assert.equal((await one(env,"SELECT status FROM outbox WHERE id='archive-notice'")).status,'disabled');
 });
 await t.test('回收站不向成员列出，恢复先到归档，历史审计链完整',async()=>{
  assert.equal((await life(f,'trash')).status,200);assert.equal((await f.all[1].request(f.base)).status,410);
  const list=await f.all[1].ok('/api/projects',undefined,'GET');assert.ok(!list.projects.some(p=>p.id===f.pid));
  const trash=await f.owner.ok('/api/admin/projects?lifecycle=trashed',undefined,'GET');assert.ok(trash.projects.some(p=>p.id===f.pid));
  assert.equal((await life(f,'restore')).status,200);assert.equal((await getProject(f)).lifecycle,'archived');
  assert.equal((await life(f,'unarchive')).status,200);const audit=await f.owner.ok(f.base+'/audit/verify',undefined,'GET');assert.equal(audit.valid,true);
 });
 await t.test('只读审阅跨项目由管理员专用接口授权，普通业务接口不越权',async()=>{
  const other=await f.all[1].ok('/api/projects',{name:'Different project',description:'test',totalBudgetCents:10000,minReserveCents:0});
  assert.equal((await f.owner.request('/api/projects/'+other.id)).status,403);
  const view=await f.owner.ok('/api/admin/projects/'+other.id,undefined,'GET');assert.equal(view.readOnly,true);
  assert.equal((await f.all[2].request('/api/admin/projects/'+other.id)).status,403);
 });
 await t.test('活跃项目角色修改必须原合伙人全员确认，反对不被移除',async()=>{
  // First release the target's share by the existing unanimous profit-rule process.
  let p=await f.owner.ok(f.base,undefined,'GET');const target=p.members[2],shares=Object.fromEntries(p.members.map((m,i)=>[m.id,i===0?5000:i===1?5000:0]));
  p=await f.action(f.owner,'proposal.submit',{kind:'profit_rule',payload:{shares},reason:'Test role transfer shares'});let g=p.proposals.at(-1);for(const c of f.all)p=await f.action(c,'proposal.vote',{id:g.id,decision:'approve',note:''});
  let v=await getProject(f);await f.owner.ok('/api/admin/projects/'+f.pid+'/members',{memberId:target.id,role:'viewer',expectedRevision:v.revision,reason:'Test partner role review'});
  p=await f.owner.ok(f.base,undefined,'GET');g=p.proposals.at(-1);assert.equal(p.members[2].role,'partner');assert.equal(g.signers.length,3);
  p=await f.action(f.all[2],'proposal.vote',{id:g.id,decision:'reject',note:'I do not agree'});assert.equal(p.members[2].role,'partner');
  v=await getProject(f);await f.owner.ok('/api/admin/projects/'+f.pid+'/members',{memberId:target.id,role:'viewer',expectedRevision:v.revision,reason:'Second test proposal'});
  p=await f.owner.ok(f.base,undefined,'GET');g=p.proposals.at(-1);for(const c of f.all)p=await f.action(c,'proposal.vote',{id:g.id,decision:'approve',note:''});assert.equal(p.members[2].role,'viewer');
  assert.equal(p.purchases.find(x=>x.id===q.id).status,'draft');assert.equal((await f.owner.ok(f.base+'/audit/verify',undefined,'GET')).valid,true);
 });
 await t.test('不能直接降权项目创建人或通过DELETE物理清库',async()=>{
  const v=await getProject(f);const r=await f.owner.request('/api/admin/projects/'+f.pid+'/members',{method:'POST',data:{memberId:v.project.members[0].id,role:'viewer',expectedRevision:v.revision,reason:'Not allowed'}});assert.equal(r.status,400);
  assert.equal((await f.owner.request('/api/admin/projects/'+f.pid,{method:'DELETE'})).status,404);assert.equal((await getProject(f)).id,f.pid);
 });
 }finally{await f.close();}
});

test('管理员AI配置：加密、透明授权、费用确认及过期任务',async t=>{
 const f=await fixture({partners:2});try{
 let current;
 await t.test('URL和Key输入校验，不能使用本地IP或带密钥参数的地址',async()=>{
  for(const baseUrl of ['http://localhost:8080','https://127.0.0.1/v1','https://169.254.169.254/v1','https://api.openai.com/v1?key=secret']){
   const r=await f.owner.request('/api/admin/ai-settings',{method:'POST',data:aiConfig({baseUrl,confirmExternalHost:true})});assert.equal(r.status,400,baseUrl);
  }
 });
 await t.test('保存Key加密，不向任何读接口和日志回显；保存不调用模型',async()=>{
  let calls=0;f.rt.env.AI_FETCH=async()=>{calls++;throw Error('unexpected');};
  current=await f.owner.ok('/api/admin/ai-settings',aiConfig());assert.equal(calls,0);assert.equal(current.keyConfigured,true);assert.ok(!JSON.stringify(current).includes('mock-admin-key-not-real'));
  const record=JSON.parse((await one(f.rt.env,"SELECT value FROM settings WHERE key='admin_ai_config'")).value);assert.ok(!JSON.stringify(record).includes('mock-admin-key-not-real'));assert.equal(decrypt(record.keyEncrypted,f.rt.env.CONFIG_ENCRYPTION_KEY),'mock-admin-key-not-real');
  const resolved=await resolveAiEnv(f.rt.env);assert.equal(resolved.AI_API_KEY,'mock-admin-key-not-real');assert.equal(publicEngine(resolved).model,'test-model');
  const audit=await f.owner.ok('/api/admin/audit',undefined,'GET');assert.ok(!JSON.stringify(audit).includes('mock-admin-key-not-real'));
 });
 await t.test('留空保留Key；并发旧配置拒绝；清除Key须先关闭',async()=>{
  const wrong=await f.owner.request('/api/admin/ai-settings',{method:'POST',data:aiConfig()});assert.equal(wrong.status,409);
  current=await f.owner.ok('/api/admin/ai-settings',aiConfig({expectedRevision:current.revision,key:'',model:'test-model-v2'}));assert.equal((await resolveAiEnv(f.rt.env)).AI_API_KEY,'mock-admin-key-not-real');
  const invalid=await f.owner.request('/api/admin/ai-settings',{method:'POST',data:aiConfig({expectedRevision:current.revision,key:'',clearKey:true})});assert.equal(invalid.status,400);
 });
 await t.test('测试连接须确认费用，只发送通用文字且不自动重试',async()=>{
  let calls=0,request;f.rt.env.AI_TEST_FETCH=async(url,options)=>{calls++;request={url,body:JSON.parse(options.body)};return new Response(JSON.stringify({choices:[{message:{content:'OK'}}],usage:{prompt_tokens:20,completion_tokens:2}}),{headers:{'Content-Type':'application/json'}});};
  const denied=await f.owner.request('/api/admin/ai-settings/test',{method:'POST',data:{expectedRevision:current.revision}});assert.equal(denied.status,400);assert.equal(calls,0);
  const result=await f.owner.ok('/api/admin/ai-settings/test',{expectedRevision:current.revision,confirmCost:true});assert.equal(result.ok,true);assert.equal(calls,1);assert.ok(!JSON.stringify(request.body).includes(f.pid));assert.ok(!JSON.stringify(request.body).includes('三人合作'));
  f.rt.env.AI_TEST_FETCH=async()=>{calls++;throw Error('timeout with secret');};const failed=await f.owner.ok('/api/admin/ai-settings/test',{expectedRevision:current.revision,confirmCost:true});assert.equal(failed.ok,false);assert.equal(calls,2);assert.ok(!JSON.stringify(failed).includes('secret'));
 });
 async function consent(){const overview=await f.owner.ok(f.base+'/ai',undefined,'GET');let p=await f.owner.ok(f.base+'/ai/policy',{confirmScope:true,engineFingerprint:overview.engine.fingerprint,monthlyCallLimit:20,monthlyBudgetCents:10000,autoPurchase:false,autoStage:false});const g=p.proposals.at(-1);for(const c of f.all)p=await f.action(c,'proposal.vote',{id:g.id,decision:'approve',note:''});return p;}
 await t.test('改Model/Key后原项目授权失效，不会管理员配置即代签',async()=>{
  await consent();assert.equal((await f.owner.ok(f.base+'/ai',undefined,'GET')).consented,true);
  current=await f.owner.ok('/api/admin/ai-settings',aiConfig({expectedRevision:current.revision,key:'new-mock-secret-key'}));assert.equal((await f.owner.ok(f.base+'/ai',undefined,'GET')).consented,false);
  const view=await f.all[1].ok(f.base+'/ai',undefined,'GET');assert.ok(!JSON.stringify(view).includes('new-mock-secret-key'));assert.ok(view.engine.baseUrl);
 });
 await t.test('项目归档后排队AI请求被取消，实际调用为零',async()=>{
  const p=await consent(),snap=buildSnapshot(p,'project','');const run=await requestAnalysis(f.rt.env,f.pid,f.owner.user,{kind:'project',previewHash:snap.hash,confirmSend:true},crypto.randomUUID());
  assert.equal(run.status,'queued');assert.equal((await life(f,'archive')).status,200);let calls=0;f.rt.env.AI_FETCH=async()=>{calls++;throw Error('must not send');};
  await runAiJob(f.rt.env,run.id);assert.equal(calls,0);assert.equal((await one(f.rt.env,'SELECT status FROM ai_jobs WHERE id=?',run.id)).status,'cancelled');
  const {state}=await load(f.rt.env,f.pid);assert.equal(state.ai.runs.find(x=>x.id===run.id).chargeCents,0);
 });
 await t.test('关闭且清除Key后不回退到环境变量旧Key',async()=>{
  f.rt.env.AI_API_KEY='old-environment-key';current=await f.owner.ok('/api/admin/ai-settings',aiConfig({expectedRevision:current.revision,enabled:false,key:'',clearKey:true}));assert.equal(current.keyConfigured,false);assert.equal((await resolveAiEnv(f.rt.env)).AI_API_KEY,'');
 });
 }finally{await f.close();}
});

test('后台只读附件路径隔离、账号安全提醒与静态资源',async()=>{
 const f=await fixture({partners:2});try{
  const other=await f.all[1].ok('/api/projects',{name:'Other member private project',description:'synthetic',totalBudgetCents:10000,minReserveCents:0});
  const form=new FormData();form.append('file',new Blob(['synthetic private evidence'],{type:'text/plain'}),'evidence.txt');
  const upload=await f.all[1].request('/api/projects/'+other.id+'/files',{method:'POST',form});assert.equal(upload.status,201);
  const url='/api/admin/projects/'+other.id+'/files/'+upload.body.id;
  const download=await f.owner.request(url);assert.equal(download.status,200);assert.equal(download.body,'synthetic private evidence');assert.match(download.headers.get('content-disposition'),/^attachment/);
  assert.equal((await f.all[1].request(url)).status,403);assert.equal((await f.owner.request('/api/admin/projects/'+f.pid+'/files/'+upload.body.id)).status,404);
  const u=await getUser(f,f.all[1].user.id);await f.owner.ok('/api/admin/users/'+u.id+'/revoke-sessions',{expectedVersion:u.authVersion,reason:'Synthetic session revoke'});
  const notice=await f.owner.ok('/api/notifications',undefined,'GET');assert.ok(notice.items.some(x=>x.title==='项目成员账号管理变更'));assert.ok(!JSON.stringify(notice).includes(PASSWORD));
  for(const [asset,contentType] of [['/admin-ui.js','text/javascript'],['/admin.css','text/css']]){
   const r=await worker.fetch(new Request('http://localhost:8787'+asset),f.rt.env,f.rt.ctx);assert.equal(r.status,200);assert.match(r.headers.get('Content-Type'),new RegExp(contentType));
  }
 }finally{await f.close();}
});
