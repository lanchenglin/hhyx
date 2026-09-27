import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,PASSWORD} from './helpers.mjs';

test('个人密码修改仍需本人验证；旧密码及其他会话失效，不影响其他成员',async()=>{
 const f=await fixture({partners:2,activate:false,fund:false});
 try{
  const otherSession=f.client();
  await otherSession.ok('/api/auth/login',{email:'owner@example.test',password:PASSWORD});
  const next='Password-UI-Test-Only-123!';
  const denied=await otherSession.request('/api/auth/password',{method:'POST',data:{password:next}});
  assert.equal(denied.status,403);assert.equal(denied.body.code,'REAUTH_REQUIRED');
  const invalid=await f.owner.request('/api/auth/password',{method:'POST',data:{password:'too-short'}});
  assert.equal(invalid.status,400);
  await f.owner.ok('/api/auth/password',{password:next});
  assert.equal((await otherSession.request('/api/auth/me')).status,401);
  const fresh=f.client();
  assert.equal((await fresh.request('/api/auth/login',{method:'POST',data:{email:'owner@example.test',password:PASSWORD}})).status,401);
  await fresh.ok('/api/auth/login',{email:'owner@example.test',password:next});
  assert.equal((await f.all[1].request('/api/auth/me')).status,200);
 }finally{await f.close();}
});
