import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';
import {encrypt} from '../src/util.js';
import {one,rows} from '../src/store.js';
import {envWithConfig,validateAiSettings,resolveAiEnv} from '../src/system-config.js';
import {publicEngine} from '../src/ai-policy.js';
import {createAdminUI} from '../public/admin-ui.js';

const key='synthetic-plaintext-ai-key';
const input={enabled:true,provider:'openai_compatible',baseUrl:'https://gateway.example.com/v1',model:'test-model',key,expectedRevision:0};
const root=Buffer.alloc(32,7).toString('base64');
const legacy=()=>({revision:1,enabled:true,provider:input.provider,baseUrl:input.baseUrl,model:input.model,keyEncrypted:encrypt(key,root)});

test('AI saves plaintext without root key, reason or host confirmation; APIs and audit omit secrets',async()=>{
 const f=await fixture({partners:2,activate:false,fund:false});try{
  delete f.rt.env.CONFIG_ENCRYPTION_KEY;delete f.rt.env.AI_ALLOWED_HOSTS;
  const saved=await f.owner.ok('/api/admin/ai-settings',input);
  const record=JSON.parse((await one(f.rt.env,"SELECT value FROM settings WHERE key='admin_ai_config'")).value);
  assert.equal(record.key,key);assert.equal(record.keyEncrypted,undefined);
  assert.equal((await resolveAiEnv(f.rt.env)).AI_API_KEY,key);
  const view=await f.owner.ok('/api/admin/ai-settings',undefined,'GET');
  assert.equal(view.keyConfigured,true);assert.equal(view.keyStorage,'plaintext');
  f.rt.env.AI_TEST_FETCH=async(url,opts)=>{assert.equal(opts.headers.Authorization,'Bearer '+key);assert.equal(opts.redirect,'manual');return Response.json({choices:[{message:{content:'OK'}}]});};
  const probe=await f.owner.ok('/api/admin/ai-settings/test',{expectedRevision:1,confirmCost:true});assert.equal(probe.ok,true);
  assert.ok(!JSON.stringify([saved,view,probe,await rows(f.rt.env,'SELECT * FROM admin_audit'),await rows(f.rt.env,'SELECT * FROM admin_operations')]).includes(key));
 }finally{await f.close();}
});

test('legacy ciphertext reads without mutation and migrates only on save',()=>{
 const old=legacy(),env={CONFIG_ENCRYPTION_KEY:root};
 assert.equal(envWithConfig(env,old).AI_API_KEY,key);assert.equal(old.key,undefined);
 const migrated=validateAiSettings(env,{...input,key:'',expectedRevision:1},old,'now');
 assert.equal(migrated.key,key);assert.equal(migrated.keyEncrypted,undefined);
 assert.equal(envWithConfig({},migrated).AI_API_KEY,key);
});

test('unreadable legacy key is retained on save and never falls back; replacement and clearing need no root',()=>{
 const old=legacy(),env={AI_API_KEY:'must-not-fall-back',CONFIG_ENCRYPTION_KEY:'invalid'};
 const retained=validateAiSettings(env,{...input,key:'',expectedRevision:1},old,'now');
 assert.equal(retained.keyEncrypted,old.keyEncrypted);assert.equal(retained.key,undefined);
 assert.throws(()=>envWithConfig(env,retained),e=>e.code==='AI_CONFIG_ERROR'&&!e.message.includes(key));
 assert.equal(envWithConfig(env,{...retained,enabled:false}).AI_API_KEY,'');
 const replaced=validateAiSettings(env,{...input,expectedRevision:1},old,'now');
 assert.equal(replaced.key,key);assert.equal(replaced.keyEncrypted,undefined);
 const cleared=validateAiSettings(env,{...input,key:'',clearKey:true,enabled:false,expectedRevision:1},old,'now');
 assert.equal(cleared.key,null);assert.equal(cleared.keyEncrypted,undefined);assert.equal(envWithConfig(env,cleared).AI_API_KEY,'');
 assert.throws(()=>validateAiSettings(env,{...input,key:'',clearKey:true,expectedRevision:1},old,'now'));
});

test('plaintext retention and first environment-key takeover do not require encryption',()=>{
 const c=validateAiSettings({AI_API_KEY:key},{...input,key:''},null,'now');assert.equal(c.key,key);
 const next=validateAiSettings({}, {...input,key:'',expectedRevision:1},c,'later');assert.equal(next.key,key);
 assert.equal(envWithConfig({}, {...next,keyEncrypted:'obsolete-invalid-ciphertext'}).AI_API_KEY,key);
});

test('arbitrary public HTTPS domains work without allowlist while unsafe targets stay blocked',()=>{
 const env={AI_MODEL:'test-model',AI_API_KEY:key,AI_ALLOWED_HOSTS:'ignored.example.com'};
 for(const host of ['gateway.example.com','another-provider.net'])assert.equal(publicEngine({...env,AI_BASE_URL:'https://'+host}).configured,true);
 for(const url of ['http://gateway.example.com','https://127.0.0.1','https://2130706433','https://[::1]','https://[::ffff:127.0.0.1]','https://169.254.169.254','https://localhost','https://host.local','https://host.internal','https://host.localhost.','https://host.local.','https://host.home.arpa','https://user:password@gateway.example.com','https://gateway.example.com:8443','https://gateway.example.com?key=secret','https://gateway.example.com/#secret'])assert.equal(publicEngine({...env,AI_BASE_URL:url}).configured,false,url);
});

test('AI forms have no reason/host confirmation/root-key gate and do not prefill saved keys',async()=>{
 let form;const ui=createAdminUI({S:{user:{systemRole:'admin'}},e:String,api:async()=>({...input,key:undefined,keyConfigured:true,keyStorage:'plaintext',revision:1}),showForm:(title,fields,submit,options)=>{form={title,fields,submit,options};}});
 for(const action of ['admin-ai-edit','admin-ai-guidance','admin-ai-test']){
  await ui.action(action,{});
  assert.ok(!form.fields.some(f=>['reason','confirmExternalHost','encryptionNotice'].includes(f.name)));
  if(action==='admin-ai-edit'){assert.equal(form.fields.find(f=>f.name==='key').value,undefined);assert.match(form.options.intro,/明文/);assert.equal(form.options.submit,'保存配置');}
 }
});
