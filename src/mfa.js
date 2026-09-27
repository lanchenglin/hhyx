// RFC 6238 TOTP; no code, seed or recovery secret is written to audit logs.
import {Buffer} from 'node:buffer';
import {createHmac,randomBytes} from 'node:crypto';
import {assert,now,sha,uid,encrypt,decrypt,safeEqual,body,json} from './util.js';
import {one,rows} from './store.js';
import {rateLimit,requireReauth} from './auth.js';

const epoch=()=>Math.floor(Date.now()/1000);
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes){let bits=0,value=0,out='';for(const b of bytes){value=(value<<8)|b;bits+=8;while(bits>=5){out+=alphabet[(value>>>(bits-5))&31];bits-=5;}}if(bits)out+=alphabet[(value<<(5-bits))&31];return out;}
export function unbase32(str){let bits=0,value=0,out=[];for(const ch of str.replace(/=+$/,'').toUpperCase()){const n=alphabet.indexOf(ch);assert(n>=0,'动态验证码密钥格式无效');value=(value<<5)|n;bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}}return Buffer.from(out);}
export function totp(secret,seconds=epoch(),digits=6,algorithm='sha1'){
 const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(seconds/30)));
 const h=createHmac(algorithm,unbase32(secret)).update(counter).digest(),o=h.at(-1)&15;
 return String((h.readUInt32BE(o)&0x7fffffff)%10**digits).padStart(digits,'0');
}
function matchedCounter(secret,code){if(!/^\d{6}$/.test(code||''))return null;const n=Math.floor(epoch()/30);for(const c of [n,n-1,n+1])if(safeEqual(totp(secret,c*30),code))return c;return null;}
export const mfaEnabled=async(env,id)=>!!(await one(env,'SELECT secret_encrypted FROM mfa_credentials WHERE user_id=?',id))?.secret_encrypted;
export const mfaPolicy=async env=>JSON.parse((await one(env,"SELECT value FROM settings WHERE key='mfa_policy'"))?.value||'{"requireAdmins":false}');
export function requireFactor(session){assert(!session.mfaRequired,'请完成动态验证码或恢复码验证',403,'MFA_REQUIRED');}
export function requireFreshFactor(user,session){requireFactor(session);if(session.mfaEnabled)assert(session.mfaAt>=epoch()-300,'此管理操作需要重新验证动态验证码或恢复码',403,'MFA_STEPUP_REQUIRED');}
export async function requireAdminFactor(env,user,session){requireFactor(session);if((await mfaPolicy(env)).requireAdmins)assert(session.mfaEnabled,'管理员必须先在账号安全中绑定动态验证码',403,'MFA_SETUP_REQUIRED');}
function audit(env,user,action,details={}){return env.DB.prepare('INSERT INTO admin_audit(id,actor_id,actor_name,action,target_id,details,created_at) VALUES(?,?,?,?,?,?,?)').bind(uid(),user.id,user.name,action,user.id,JSON.stringify(details),now());}
const normalized=code=>String(code||'').replace(/[\s-]/g,'').toUpperCase();
const codeHash=(id,code)=>sha(`hhyx-recovery:${id}:${normalized(code)}`);
function makeCodes(){return Array.from({length:10},()=>randomBytes(16).toString('hex').toUpperCase().match(/.{1,8}/g).join('-'));}
export async function consumeFactor(env,user,rawCode){
 await rateLimit(env,`mfa:${user.id}`,8,300);
 const row=await one(env,'SELECT * FROM mfa_credentials WHERE user_id=?',user.id);assert(row?.secret_encrypted,'尚未启用动态验证码',409);
 const code=String(rawCode||'').trim();assert(code.length<=100,'验证码格式无效',403,'MFA_INVALID');
 if(/^\d{6}$/.test(code)){
  let secret;try{secret=decrypt(row.secret_encrypted,env.CONFIG_ENCRYPTION_KEY);}catch{assert(false,'无法解密验证密钥，请联系部署者恢复加密根密钥',503,'MFA_KEY_ERROR');}
  const counter=matchedCounter(secret,code);assert(counter!==null&&counter>row.last_counter,'验证码无效、已使用或已过期，请等待下一组验证码',403,'MFA_INVALID');
  const result=await env.DB.prepare('UPDATE mfa_credentials SET last_counter=?,updated_at=? WHERE user_id=? AND version=? AND last_counter<? AND secret_encrypted=?').bind(counter,now(),user.id,row.version,counter,row.secret_encrypted).run();
  assert(result.meta.changes===1,'验证码已使用或设置已变化',403,'MFA_INVALID');return {version:row.version,recovery:false};
 }
 const result=await env.DB.batch([
  env.DB.prepare('UPDATE mfa_recovery_codes SET used_at=? WHERE user_id=? AND code_hash=? AND version=? AND used_at IS NULL AND EXISTS(SELECT 1 FROM mfa_credentials WHERE user_id=? AND version=? AND secret_encrypted IS NOT NULL)').bind(now(),user.id,codeHash(user.id,code),row.version,user.id,row.version),
 ]);assert(result[0].meta.changes===1,'恢复码无效或已经使用',403,'MFA_INVALID');
 await audit(env,user,'mfa.recovery_used').run();return {version:row.version,recovery:true};
}
export async function mfaRoute(req,env,{user,session,url}){
 const path=url.pathname.slice('/api/auth/mfa'.length),method=req.method;
 if(path==='/status'&&method==='GET'){
  const row=await one(env,'SELECT version,secret_encrypted FROM mfa_credentials WHERE user_id=?',user.id),codes=await one(env,'SELECT count(*) AS n FROM mfa_recovery_codes WHERE user_id=? AND used_at IS NULL AND version=?',user.id,row?.version||0);
  return json({enabled:!!row?.secret_encrypted,verified:!session.mfaRequired,fresh:session.mfaAt>=epoch()-300,recoveryCodesRemaining:codes.n,encryptionReady:!!env.CONFIG_ENCRYPTION_KEY,requireAdmins:(await mfaPolicy(env)).requireAdmins});
 }
 assert(method==='POST','验证接口不存在',404);const a=await body(req);
 if(path==='/verify'){
  const result=await consumeFactor(env,user,a.code);
  // Rotate the partial session to prevent fixation. This endpoint alone upgrades MFA.
  const {startSession}=await import('./auth.js');
  const next=await startSession(env,req,user,{factorVersion:result.version});
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(session.hash).run();
  const {cookie,...data}=next;await audit(env,user,'mfa.verified',{recovery:result.recovery}).run();
  return json({...data,recoveryUsed:result.recovery},200,{'Set-Cookie':cookie});
 }
 requireFactor(session);requireReauth(session);requireFreshFactor(user,session);
 assert(!user.must_change_password,'请先修改临时密码',403,'PASSWORD_CHANGE_REQUIRED');
 if(path==='/enroll'){
  assert(!await mfaEnabled(env,user.id),'已经启用；更换设备请先用现有验证方式停用再绑定',409);
  await rateLimit(env,`mfa-enroll:${user.id}`,6,3600);
  const secret=base32(randomBytes(20)),encrypted=encrypt(secret,env.CONFIG_ENCRYPTION_KEY);
  await env.DB.prepare('INSERT INTO mfa_credentials(user_id,pending_encrypted,pending_session,pending_expires,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET pending_encrypted=excluded.pending_encrypted,pending_session=excluded.pending_session,pending_expires=excluded.pending_expires,updated_at=excluded.updated_at WHERE mfa_credentials.secret_encrypted IS NULL').bind(user.id,encrypted,session.hash,epoch()+600,now()).run();
  const label='合伙有序:'+ (user.username||user.email);
  return json({secret,uri:`otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent('合伙有序')}&algorithm=SHA1&digits=6&period=30`,expiresIn:600,notice:'仅本次显示；在验证器中手动录入密钥后，输入其六位验证码完成绑定。不要上传截图或发送给他人。'});
 }
 if(path==='/confirm'){
  await rateLimit(env,`mfa-confirm:${user.id}`,8,300);
  const r=await one(env,'SELECT * FROM mfa_credentials WHERE user_id=?',user.id);
  assert(r&&!r.secret_encrypted&&r.pending_session===session.hash&&r.pending_expires>epoch(),'绑定已过期或不属于本次会话，请重新开始',409);
  const counter=matchedCounter(decrypt(r.pending_encrypted,env.CONFIG_ENCRYPTION_KEY),a.code);assert(counter!==null,'验证码不正确',403,'MFA_INVALID');
  const version=r.version+1,codes=makeCodes(),guard='EXISTS(SELECT 1 FROM mfa_credentials WHERE user_id=? AND version=? AND secret_encrypted=?)';
  const batch=await env.DB.batch([
   env.DB.prepare('UPDATE mfa_credentials SET secret_encrypted=pending_encrypted,version=?,last_counter=?,pending_encrypted=NULL,pending_session=NULL,pending_expires=NULL,updated_at=? WHERE user_id=? AND version=? AND pending_session=? AND pending_encrypted=? AND secret_encrypted IS NULL AND EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND u.id=? AND u.disabled=0 AND u.must_change_password=0 AND u.auth_version=? AND s.auth_version=u.auth_version)').bind(version,counter,now(),user.id,r.version,session.hash,r.pending_encrypted,session.hash,user.id,user.auth_version),
   env.DB.prepare('DELETE FROM mfa_recovery_codes WHERE user_id=? AND '+guard).bind(user.id,user.id,version,r.pending_encrypted),
   ...codes.map(code=>env.DB.prepare('INSERT INTO mfa_recovery_codes(user_id,code_hash,version) SELECT ?,?,? WHERE '+guard).bind(user.id,codeHash(user.id,code),version,user.id,version,r.pending_encrypted)),
   env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>? AND '+guard).bind(user.id,session.hash,user.id,version,r.pending_encrypted),
   env.DB.prepare('UPDATE sessions SET mfa_version=?,mfa_at=? WHERE token_hash=? AND '+guard).bind(version,epoch(),session.hash,user.id,version,r.pending_encrypted)
  ]);assert(batch[0].meta.changes===1,'绑定状态已变化，请重新开始',409);await audit(env,user,'mfa.enabled').run();
  return json({ok:true,recoveryCodes:codes,notice:'恢复码只显示这一次，每个只能用一次，请离线安全保存。'});
 }
 if(path==='/recovery-codes'){
  assert(session.mfaEnabled,'尚未绑定动态验证码',409);const r=await one(env,'SELECT * FROM mfa_credentials WHERE user_id=?',user.id),codes=makeCodes();
  const guard='EXISTS(SELECT 1 FROM sessions s JOIN mfa_credentials m ON m.user_id=s.user_id WHERE s.token_hash=? AND s.mfa_version=? AND s.mfa_at>=? AND m.version=s.mfa_version AND m.secret_encrypted IS NOT NULL)';
  const b=await env.DB.batch([
   env.DB.prepare('DELETE FROM mfa_recovery_codes WHERE user_id=? AND '+guard).bind(user.id,session.hash,r.version,epoch()-300),
   ...codes.map(code=>env.DB.prepare('INSERT INTO mfa_recovery_codes(user_id,code_hash,version) SELECT ?,?,? WHERE '+guard).bind(user.id,codeHash(user.id,code),r.version,session.hash,r.version,epoch()-300))
  ]);assert(b[1].meta.changes===1,'验证已过期',403,'MFA_STEPUP_REQUIRED');await audit(env,user,'mfa.recovery_regenerated').run();return json({ok:true,recoveryCodes:codes});
 }
 if(path==='/disable'){
  assert(session.mfaEnabled,'尚未启用动态验证码',409);assert(!(user.system_role==='admin'&&(await mfaPolicy(env)).requireAdmins),'管理员强制验证策略已启用，不能单独停用',409);
  const b=await env.DB.batch([
   env.DB.prepare('UPDATE mfa_credentials SET secret_encrypted=NULL,pending_encrypted=NULL,pending_session=NULL,pending_expires=NULL,version=version+1,last_counter=-1,updated_at=? WHERE user_id=? AND version=?').bind(now(),user.id,session.mfaVersion),
   env.DB.prepare('DELETE FROM mfa_recovery_codes WHERE user_id=? AND EXISTS(SELECT 1 FROM mfa_credentials WHERE user_id=? AND version=? AND secret_encrypted IS NULL)').bind(user.id,user.id,session.mfaVersion+1),
   env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>? AND EXISTS(SELECT 1 FROM mfa_credentials WHERE user_id=? AND version=? AND secret_encrypted IS NULL)').bind(user.id,session.hash,user.id,session.mfaVersion+1)
  ]);assert(b[0].meta.changes===1,'设置已变化，请重新登录',409);await audit(env,user,'mfa.disabled').run();return json({ok:true});
 }
 assert(false,'验证接口不存在',404);
}
