import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,PASSWORD} from './helpers.mjs';
import {publicEngine} from '../src/ai-policy.js';
import {resolveAiEnv,aiSettingsError} from '../src/system-config.js';
import {normalizeAiUrl,providerHttpMessage} from '../src/ai-transport.js';
import {requestSpec,invokeProvider,probeProvider} from '../src/ai-provider.js';
import {one,rows} from '../src/store.js';
import {totp} from '../src/mfa.js';
const host='relay.example.com';
const env={AI_PROVIDER:'openai_compatible',AI_BASE_URL:`https://${host}/v1`,AI_MODEL:'deepseek-flash',AI_API_KEY:'synthetic-key-not-real'};
const config=(extra={})=>({provider:'openai_compatible',baseUrl:env.AI_BASE_URL,model:env.AI_MODEL,key:env.AI_API_KEY,enabled:true,expectedRevision:0,...extra});
const reply={verdict:'needs_information',summary:'合成测试报告',summaryRefs:['project'],findings:[],missingInformation:[],recommendations:[],decisions:[],limitations:['未联网核查'],externalVerified:false};
const snapshot={kind:'project',sources:[{id:'project',data:{name:'合成测试'}}]};
const response=()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(reply)}}],usage:{prompt_tokens:20,completion_tokens:80}});

test('relay URL normalizes host/base/endpoint without duplicate /v1; rejects protocol mismatch and unsafe paths',()=>{
 for(const url of [`https://${host}`,`https://${host}/`,`https://${host}/v1/`,`https://${host}/v1/chat/completions`])assert.equal(normalizeAiUrl(url),env.AI_BASE_URL);
 assert.equal(normalizeAiUrl(`https://${host}/api/proxy/v1/chat/completions`),`https://${host}/api/proxy/v1`);
 assert.equal(normalizeAiUrl(`https://${host}/v1/messages`,'anthropic'),env.AI_BASE_URL);
 for(const url of [`https://${host}/v1/messages`,`https://${host}/v1/responses`,`https://${host}/v1?key=secret`,`https://user:secret@${host}`,`http://${host}`,`https://${host}/v1//x`,`https://${host}/%2e/`])assert.throws(()=>normalizeAiUrl(url));
});
test('relay uses max_tokens and prompt JSON; official/explicit modern remains structured; overrides validated',()=>{
 const relay=publicEngine(env),spec=requestSpec(relay,snapshot,env.AI_API_KEY);
 assert.equal(spec.body.max_tokens,8192);assert.equal(spec.body.max_completion_tokens,undefined);assert.equal(spec.body.response_format,undefined);assert.ok(spec.body.messages[0].content.includes('JSON'));
 assert.equal(spec.url,env.AI_BASE_URL+'/chat/completions');
 const modern=publicEngine({...env,AI_REQUEST_MODE:'modern'}),m=requestSpec(modern,snapshot,'test');assert.equal(m.body.max_completion_tokens,8192);assert.equal(m.body.response_format.type,'json_schema');
 const official=publicEngine({...env,AI_BASE_URL:'https://api.openai.com/v1'});assert.equal(official.requestMode,'modern');
 const json=publicEngine({...env,AI_JSON_MODE:'json_object'});assert.equal(requestSpec(json,snapshot,'test').body.response_format.type,'json_object');
 assert.equal(publicEngine({...env,AI_REQUEST_MODE:'invalid'}).configured,false);
 assert.equal(publicEngine({...env,AI_BASE_URL:'https://127.0.0.1/v1',AI_ALLOWED_HOSTS:'127.0.0.1'}).configured,false);
 assert.equal(publicEngine({...env,AI_BASE_URL:'https://other.example.com/v1'}).configured,true);
});
test('relay successful output still validates report references; probe and report share transport fields',async()=>{
 let calls=0,probeBody;
 const e={...env,AI_FETCH:async(url,opts)=>{calls++;const data=JSON.parse(opts.body);assert.ok(data.max_tokens);assert.equal(data.response_format,undefined);return response();},AI_TEST_FETCH:async(url,opts)=>{calls++;probeBody=JSON.parse(opts.body);return response();}};
 const engine=publicEngine(e),r=await invokeProvider(e,engine,snapshot);assert.equal(r.status,'completed');assert.equal(r.usage.outputTokens,80);
 assert.equal((await probeProvider(e,engine)).ok,true);assert.equal(probeBody.max_tokens,128);assert.equal(probeBody.max_completion_tokens,undefined);assert.ok(!JSON.stringify(probeBody).includes('合成测试'));assert.equal(calls,2);
 e.AI_FETCH=async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({...reply,summaryRefs:['invented']})}}],usage:{prompt_tokens:1,completion_tokens:5}});
 assert.equal((await invokeProvider(e,engine,snapshot)).status,'failed');
});
test('HTTP diagnosis never returns upstream secrets/HTML and never retries',async()=>{
 let calls=0;for(const status of [400,401,403,404,422,429,500]){
  const fetcher=async()=>{calls++;return Response.json({error:{message:'sensitive upstream key '+env.AI_API_KEY}},{status});};
  const e={...env,AI_FETCH:fetcher,AI_TEST_FETCH:fetcher},engine=publicEngine(e);
  const a=await invokeProvider(e,engine,snapshot),b=await probeProvider(e,engine);assert.equal(a.status,'failed');assert.equal(b.ok,false);assert.ok(a.error.includes(String(status)));assert.ok(!JSON.stringify([a,b]).includes(env.AI_API_KEY));
 }
 assert.equal(calls,14);
 const html=async()=>new Response('<html>secret</html>',{headers:{'Content-Type':'text/html'}}),e={...env,AI_FETCH:html,AI_TEST_FETCH:html};
 assert.match((await probeProvider(e,publicEngine(e))).message,/网页/);assert.equal((await invokeProvider(e,publicEngine(e),snapshot)).errorCode,'PROVIDER_HTML');
 assert.match(providerHttpMessage(401),/Key/);
});
test('AI configuration uses current admin login; cannot bypass CSRF, other permissions, archive or audit',async()=>{
 const f=await fixture({partners:2,activate:false,fund:false});try{
  const fresh=f.client();await fresh.ok('/api/auth/login',{email:'owner@example.test',password:PASSWORD});let calls=0;
  f.rt.env.AI_TEST_FETCH=async()=>{calls++;return response();};f.rt.env.AI_FETCH=async()=>{calls++;throw Error('must not send');};
  const p=config({baseUrl:`https://${host}/v1/chat/completions`});
  assert.equal((await f.all[1].request('/api/admin/ai-settings',{method:'POST',data:p})).status,403);
  assert.equal((await fresh.request('/api/admin/ai-settings',{method:'POST',data:p,headers:{'x-csrf-token':'bad'}})).status,403);
  assert.equal((await fresh.request('/api/admin/ai-settings',{method:'POST',data:p,headers:{origin:'https://evil.example'}})).status,403);
  const key='relay-config-idempotent-123',saved=await fresh.ok('/api/admin/ai-settings',p,'POST',key);assert.equal(saved.baseUrl,env.AI_BASE_URL);assert.equal(calls,0);
  await fresh.ok('/api/admin/ai-settings',p,'POST',key);assert.equal((await fresh.ok('/api/admin/ai-settings',undefined,'GET')).revision,1);
  const project=await fresh.ok('/api/admin/projects/'+f.pid,undefined,'GET');
  const denied=await fresh.request('/api/admin/projects/'+f.pid+'/lifecycle',{method:'POST',data:{expectedRevision:project.revision,action:'archive',confirmName:project.project.name,confirmImpact:true,reason:'must reauth'}});assert.equal(denied.body.code,'REAUTH_REQUIRED');
  const noConfirm=await fresh.request('/api/admin/ai-settings/test',{method:'POST',data:{expectedRevision:1}});assert.equal(noConfirm.status,400);assert.equal(calls,0);
  assert.equal((await fresh.ok('/api/admin/ai-settings/test',{expectedRevision:1,confirmCost:true})).ok,true);assert.equal(calls,1);
  assert.ok((await rows(f.rt.env,'SELECT * FROM admin_audit')).some(a=>a.action==='ai.settings'));
  assert.ok(!JSON.stringify(await rows(f.rt.env,'SELECT * FROM admin_audit')).includes(env.AI_API_KEY));
  await fresh.ok('/api/admin/ai-settings',config({expectedRevision:1,key:'',enabled:false}));assert.equal((await resolveAiEnv(f.rt.env)).AI_API_KEY,'');
 }finally{await f.close();}
});
test('completed MFA login stays usable for AI settings after step-up expires; incomplete MFA still blocked',async()=>{
 const f=await fixture({partners:2,activate:false,fund:false});try{
  const start=await f.owner.ok('/api/auth/mfa/enroll',{}),enabled=await f.owner.ok('/api/auth/mfa/confirm',{code:totp(start.secret)});
  await f.rt.env.DB.prepare('UPDATE sessions SET reauth_at=0,mfa_at=1 WHERE user_id=?').bind(f.owner.user.id).run();
  const c=await f.owner.ok('/api/admin/ai-settings',config());assert.equal(c.revision,1);
  await f.owner.reauth();const target=(await f.owner.ok('/api/admin/users/'+f.all[1].user.id,undefined,'GET')).user;
  const other=await f.owner.request('/api/admin/users/'+target.id+'/revoke-sessions',{method:'POST',data:{reason:'test',expectedVersion:target.authVersion}});assert.equal(other.body.code,'MFA_STEPUP_REQUIRED');
  const partial=f.client();await partial.ok('/api/auth/login',{email:'owner@example.test',password:PASSWORD});assert.equal((await partial.request('/api/admin/ai-settings',{method:'POST',data:config({expectedRevision:1})})).body.code,'MFA_REQUIRED');
  assert.equal(enabled.recoveryCodes.length,10);
 }finally{await f.close();}
});
test('invalid root encryption does not block new AI keys; database faults carry safe diagnostic id',async()=>{
 const f=await fixture({partners:2,activate:false,fund:false});try{
  f.rt.env.CONFIG_ENCRYPTION_KEY='invalid';
  const r=await f.owner.request('/api/admin/ai-settings',{method:'POST',data:config()});assert.equal(r.status,200);assert.ok(!JSON.stringify(r.body).includes(env.AI_API_KEY));
  assert.equal(JSON.parse((await one(f.rt.env,"SELECT value FROM settings WHERE key='admin_ai_config'")).value).key,env.AI_API_KEY);
  const a=aiSettingsError(new Error('no such table: settings; '+env.AI_API_KEY));assert.equal(a.code,'AI_DATABASE_NOT_READY');assert.ok(!a.message.includes(env.AI_API_KEY));assert.match(a.message,/诊断编号/);
  const b=aiSettingsError(new Error('private error '+env.AI_API_KEY));assert.equal(b.code,'AI_CONFIG_STORAGE_ERROR');assert.ok(!b.message.includes(env.AI_API_KEY));
 }finally{await f.close();}
});
