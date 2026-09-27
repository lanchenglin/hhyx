import {scheduledBackups} from './backups.js';
import {readNotifyConfig,resolveNotifyEnv,adminAlert} from './notification-config.js';
import {mfaRoute,requireFactor,consumeFactor,mfaEnabled,requireFreshFactor} from './mfa.js';
import {adminRoute} from './admin.js';
import { Buffer } from 'node:buffer';
import { assert, AppError, body, json, now, uid, sha, token, email, text, hashPassword, verifyPassword, encrypt, csv } from './util.js';
import { authenticate, bootstrap, login, ensureInitialAdmin, publicUser, startSession, originCheck, requireReauth, rateLimit, sessionCookie } from './auth.js';
import { one, rows, load, readProject, newProject, mutate, auditRows, verifyAudit } from './store.js';
import { getMember, partner, projectView } from './domain.js';
import { aiRoute, autoAnalysis, processAiJobs } from './ai.js';
import { validateWecom, kick, scheduled, deliverOne } from './notifications.js';

const SENSITIVE = new Set(['exit.payment','proposal.vote','purchase.vote','purchase.order','purchase.pay','ledger.verify','ledger.reverse','project.pause','settlement.pay','ai.suspend']);
const INTERNAL = new Set(['admin.lifecycle','admin.member.role','member.join','attachment.add','channel.update','invite.create','ai.run.request','ai.run.finish','ai.review']);
const MIME = new Set(['application/pdf','image/png','image/jpeg','image/webp','text/plain','text/csv','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
const MAX_FILE=10*1024*1024;
const keyOf=req=>req.headers.get('x-idempotency-key');
const pageLimit=(v,max=100)=>Math.min(max,Math.max(1,Number.parseInt(v||'50',10)||50));
function sessionResponse(data,req,status=200){const {cookie,...rest}=data;return json(rest,status,{'Set-Cookie':cookie});}
const routeMatch=(path,re)=>path.match(re);

async function handle(req,env,ctx){
 const url=new URL(req.url),path=url.pathname,method=req.method;
 if(!path.startsWith('/api/'))return env.ASSETS.fetch(req);
 if(method==='OPTIONS')return new Response(null,{status:405});
 if(!['GET','HEAD'].includes(method))originCheck(req,env);
 if(path==='/api/health'&&method==='GET')return json({ok:true,service:'coop-plan',version:'1.3.0'});
 if((path==='/api/auth/status'&&method==='GET')||(path==='/api/auth/login'&&method==='POST'))await ensureInitialAdmin(env);
 if(path==='/api/auth/status'&&method==='GET')return json({initialized:!!await one(env,"SELECT value FROM settings WHERE key='bootstrapped'")});
 if(['/api/auth/bootstrap','/api/auth/login','/api/auth/accept'].includes(path)&&method==='POST') {
  await rateLimit(env,`auth-ip:${sha(req.headers.get('cf-connecting-ip')||'local')}`,60);
  const a=await body(req);
  if(path.endsWith('/bootstrap'))return sessionResponse(await bootstrap(env,a,req),req,201);
  if(path.endsWith('/login'))return sessionResponse(await login(env,a,req),req);
  assert(typeof a.token==='string'&&a.token.length<200,'邀请链接无效');
  const invitation=await one(env,'SELECT * FROM invites WHERE token_hash=? AND expires_at>?',sha(a.token),Math.floor(Date.now()/1000));
  assert(invitation,'邀请已过期或无效',400);const {state,row:inviteProject}=await load(env,invitation.project_id);assert(inviteProject.lifecycle==='active','项目已归档或进入回收站，不能接受邀请',409);const m=state.members.find(m=>m.id===invitation.member_id&&m.active);
  assert(m&&m.email===invitation.email,'邀请对应的成员已变更或退出',403);
  let user=await one(env,'SELECT * FROM users WHERE email=?',invitation.email),inviteFactorVersion=0;
  if(user){assert(!user.disabled&&!user.must_change_password,'该账号已停用或需要先登录修改临时密码',403);assert(verifyPassword(a.password,user.password_hash),'已存在账号，请输入该账号密码',401);}
  if(user&&await mfaEnabled(env,user.id)){assert(a.mfaCode,'此账号启用了二次验证，请同时填写动态验证码或恢复码',403,'MFA_INVITE_REQUIRED');inviteFactorVersion=(await consumeFactor(env,user,a.mfaCode)).version;}
  if(!user) {assert(!invitation.used_by,'邀请已使用',409);user={id:uid(),email:invitation.email,name:text(a.name,'姓名',60),password_hash:hashPassword(a.password)};await env.DB.prepare('INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)').bind(user.id,user.email,user.name,user.password_hash,now()).run();}
  assert(!invitation.used_by||invitation.used_by===user.id,'邀请已由其他账号使用',409);
  if(!m.userId)await mutate(env,invitation.project_id,user,{type:'member.join',data:{memberId:m.id}},`accept_${sha(a.token).slice(0,40)}`,{inviteVerified:true,extraStatements:(e,pid,op)=>[e.DB.prepare('UPDATE invites SET used_by=? WHERE token_hash=? AND EXISTS(SELECT 1 FROM projects WHERE id=? AND last_operation=?)').bind(user.id,sha(a.token),pid,op)]});
  else assert(m.userId===user.id,'邀请已绑定其他成员',409);
  return sessionResponse({...await startSession(env,req,user,{factorVersion:inviteFactorVersion}),projectId:invitation.project_id},req);
 }
 if(path==='/api/invite'&&method==='GET') {
  const t=url.searchParams.get('token')||'';assert(t.length<200,'邀请无效');
  const i=await one(env,'SELECT i.email,i.expires_at,p.name FROM invites i JOIN projects p ON p.id=i.project_id WHERE i.token_hash=? AND i.expires_at>?',sha(t),Math.floor(Date.now()/1000));assert(i,'邀请无效或过期',404);return json(i);
 }
 const auth=await authenticate(env,req,!['GET','HEAD'].includes(method)),{user,session}=auth;
 if(path==='/api/auth/me'&&method==='GET')return json({user:publicUser(user),csrf:session.csrf});
 if(path==='/api/auth/logout'&&method==='POST'){await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(session.hash).run();return json({ok:true},200,{'Set-Cookie':sessionCookie(req,'',0)});}
 if(path.startsWith('/api/auth/mfa/'))return mfaRoute(req,env,{user,session,url});
 requireFactor(session);
 if(path==='/api/auth/reauth'&&method==='POST'){await rateLimit(env,`reauth:${user.id}`,10);const a=await body(req);assert(verifyPassword(a.password,user.password_hash),'密码不正确',403);await env.DB.prepare('UPDATE sessions SET reauth_at=? WHERE token_hash=?').bind(Math.floor(Date.now()/1000),session.hash).run();return json({ok:true,validForSeconds:300});}
 if(path==='/api/auth/password'&&method==='POST'){
  requireReauth(session);requireFreshFactor(user,session);const a=await body(req);const hash=hashPassword(a.password);
  assert(!verifyPassword(a.password,user.password_hash),'新密码不能与当前密码相同');
  const nextVersion=user.auth_version+1;
  const changed=await env.DB.batch([
   env.DB.prepare('UPDATE users SET password_hash=?,must_change_password=0,auth_version=auth_version+1,updated_at=? WHERE id=? AND auth_version=? AND disabled=0').bind(hash,now(),user.id,user.auth_version),
   env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>? AND EXISTS(SELECT 1 FROM users WHERE id=? AND auth_version=? AND password_hash=?)').bind(user.id,session.hash,user.id,nextVersion,hash),
   env.DB.prepare('UPDATE sessions SET auth_version=?,reauth_at=0 WHERE token_hash=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND auth_version=? AND password_hash=?)').bind(nextVersion,session.hash,user.id,nextVersion,hash),
   env.DB.prepare("INSERT INTO admin_audit(id,actor_id,actor_name,action,target_id,details,created_at) SELECT ?,?,?,'account.password_changed',?,'{}',? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND auth_version=? AND password_hash=?)").bind(uid(),user.id,user.name,user.id,now(),user.id,nextVersion,hash)
  ]);assert(changed[0].meta.changes===1,'账号同时发生变化，请重新登录',409);return json({ok:true,mustChangePassword:false});
 }
 if(user.must_change_password)throw new AppError('请先修改临时密码，暂不能访问业务或管理功能',403,'PASSWORD_CHANGE_REQUIRED');
 if(path.startsWith('/api/admin/'))return adminRoute(req,env,ctx,{user,session,url});
 if(path==='/api/auth/revoke-others'&&method==='POST'){requireReauth(session);await env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').bind(user.id,session.hash).run();return json({ok:true});}
 if(path==='/api/profile'&&method==='POST'){requireReauth(session);const a=await body(req);assert(typeof a.smsOptIn==='boolean','请明确是否启用短信');const phone=text(a.phone,'手机号',20,false);assert(!phone||/^(?:\+?86)?1[3-9]\d{9}$/.test(phone),'第一版短信支持中国大陆手机号');assert(!a.smsOptIn||phone,'启用短信需要手机号');await env.DB.prepare('UPDATE users SET phone=?,sms_opt_in=? WHERE id=?').bind(phone,a.smsOptIn?1:0,user.id).run();return json({ok:true});}
 if(path==='/api/projects'&&method==='GET') {
  const list=await rows(env,"SELECT p.id,p.name,p.state,p.revision,p.updated_at,p.lifecycle FROM project_access a JOIN projects p ON p.id=a.project_id WHERE a.user_id=? AND p.lifecycle!='trashed' ORDER BY p.updated_at DESC",user.id);
  return json({projects:list.filter(r=>JSON.parse(r.state).members.some(m=>m.active&&m.userId===user.id)).map(r=>{const p=JSON.parse(r.state);return {id:r.id,name:r.name,status:p.status,lifecycle:r.lifecycle,description:p.description,memberCount:p.members.filter(m=>m.active).length,revision:r.revision,updatedAt:r.updated_at};})});
 }
 if(path==='/api/projects'&&method==='POST') {assert(user.can_create_projects!==0,'管理员未授予新建项目权限；仍可加入获邀请的项目',403);await rateLimit(env,`project-create:${user.id}`,20,3600);return json(await newProject(env,await body(req),user),201);}
 if(path==='/api/notifications'&&method==='GET')return json({items:await rows(env,'SELECT n.* FROM notifications n JOIN project_access a ON a.project_id=n.project_id AND a.user_id=n.user_id WHERE n.user_id=? ORDER BY n.created_at DESC LIMIT ?',user.id,pageLimit(url.searchParams.get('limit'),200))});
 let match=routeMatch(path,/^\/api\/notifications\/([^/]+)\/read$/);
 if(match&&method==='POST'){await env.DB.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?').bind(now(),decodeURIComponent(match[1]),user.id).run();return json({ok:true});}
 match=routeMatch(path,/^\/api\/projects\/([^/]+)(?:\/(.*))?$/);
 if(!match)throw new AppError('接口不存在',404);
 const pid=match[1],sub=match[2]||'';const {state,row}=await load(env,pid);getMember(state,user);
 assert(row.lifecycle!=='trashed','项目已被管理员放入回收站，历史保留；请联系管理员恢复',410,'PROJECT_TRASHED');
 if(!['GET','HEAD'].includes(method))assert(row.lifecycle==='active','项目已归档，当前只读；请管理员取消归档后再操作',409,'PROJECT_READ_ONLY');
 if(sub==='ai'||sub.startsWith('ai/'))return aiRoute(req,env,ctx,{pid,state,user,session,sub,url});
 if(!sub&&method==='GET')return json({...projectView(state,user),revision:row.revision});
 if(sub==='actions'&&method==='POST') {
  const action=await body(req);assert(!INTERNAL.has(action.type),'不能直接调用内部操作',403);if(SENSITIVE.has(action.type))requireReauth(session);
  const data=await mutate(env,pid,user,action,keyOf(req));ctx.waitUntil(kick(env,pid).catch(()=>{}));if(['purchase.submit','proposal.vote'].includes(action.type))ctx.waitUntil(autoAnalysis(env,pid,user,action).catch(()=>{}));return json(data);
 }
 if(sub==='invites'&&method==='POST') {
  partner(state,user);const a=await body(req),m=state.members.find(m=>m.id===a.memberId&&m.active&&!m.userId);assert(m,'成员已加入或不存在');const t=token(),expires=Math.floor(Date.now()/1000)+7*86400;
  await mutate(env,pid,user,{type:'invite.create',data:{memberId:m.id}},keyOf(req),{inviteCreateVerified:true,extraHash:sha(t),extraStatements:(e,pid,op)=>[
   e.DB.prepare('DELETE FROM invites WHERE project_id=? AND member_id=? AND used_by IS NULL AND EXISTS(SELECT 1 FROM projects WHERE id=? AND last_operation=?)').bind(pid,m.id,pid,op),
   e.DB.prepare('INSERT INTO invites(token_hash,project_id,member_id,email,expires_at,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM projects WHERE id=? AND last_operation=?)').bind(sha(t),pid,m.id,m.email,expires,now(),pid,op)
  ]});return json({url:`${env.APP_URL}/#invite=${t}`,expiresAt:new Date(expires*1000).toISOString(),email:m.email});
 }
 if(sub==='audit'&&method==='GET'){const after=Math.max(0,Number(url.searchParams.get('after'))||0),limit=pageLimit(url.searchParams.get('limit'),200);const records=await auditRows(env,pid,after,limit);return json({records,nextAfter:records.length===limit?records.at(-1).revision:null});}
 if(sub==='audit/verify'&&method==='GET'){const records=await auditRows(env,pid,0,10000);return json(verifyAudit(records,state,row.audit_head));}
 if(sub==='export'&&method==='GET') {
  const records=await auditRows(env,pid,0,10000);assert(records.length===row.revision,'审计记录超过单次导出限制，请使用数据库备份',409);
  const aiManifest=await rows(env,'SELECT id,kind,target_id,snapshot_hash,status,created_at,finished_at FROM ai_jobs WHERE project_id=? ORDER BY created_at',pid);
  return json({schemaVersion:2,aiManifest:aiManifest.map(j=>({...j,downloadPath:`/api/projects/${pid}/ai/runs/${j.id}/export`})),exportedAt:now(),project:state,revision:row.revision,audit:records,auditVerification:verifyAudit(records,state,row.audit_head),attachments:state.attachments.map(f=>({...f,downloadPath:`/api/projects/${pid}/files/${f.id}`}))},200,{'Content-Disposition':`attachment; filename="coop-${pid}.json"`});
 }
 if(sub==='ledger.csv'&&method==='GET')return new Response(csv([['编号','日期','类型','金额(元)','说明','登记人','复核人','未经事前批准','凭证说明'],...state.ledger.map(e=>[e.id,e.at,e.kind,(e.amountCents/100).toFixed(2),e.description,state.members.find(m=>m.id===e.actorId)?.name,state.members.find(m=>m.id===e.verifiedBy)?.name,e.unauthorized?'是':'否',e.evidence])]),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="ledger-${pid}.csv"`}});
 if(sub==='files'&&method==='POST') {
  assert(getMember(state,user).role!=='viewer','只读成员不能上传附件',403);
  assert(Number(req.headers.get('content-length')||0)<=MAX_FILE+10000,'文件超过10MB上限',413);
  // 流式限制整个 multipart 请求，防止无 Content-Length 的大请求占满内存。
  const reader=req.body.getReader(),chunks=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_FILE+10000){await reader.cancel();throw new AppError('文件超过10MB上限',413);}chunks.push(value);}
  const form=await new Response(new Blob(chunks),{headers:{'Content-Type':req.headers.get('content-type')}}).formData(),file=form.get('file');
  assert(file&&typeof file.arrayBuffer==='function','未收到文件');assert(file.size>0&&file.size<=MAX_FILE,'文件须为1字节–10MB');assert(MIME.has(file.type),'仅支持 PDF、PNG/JPEG/WebP、文本、CSV、DOCX、XLSX 凭证');
  const bytes=await file.arrayBuffer(),id=uid(),objectKey=`${pid}/${id}`,at=now(),filename=file.name.replace(/[\x00-\x1f\x7f/\\]/g,'_').slice(0,180);
  const meta={id,name:filename,mime:file.type,size:file.size,sha256:sha(Buffer.from(bytes)),uploadedAt:at,uploaderId:user.id};
  await env.FILES.put(objectKey,bytes,{httpMetadata:{contentType:file.type},customMetadata:{sha256:meta.sha256}});
  try {await mutate(env,pid,user,{type:'attachment.add',data:{file:meta}},keyOf(req),{attachmentVerified:true,extraHash:meta.sha256,extraStatements:(e,pid,op)=>[e.DB.prepare('INSERT INTO attachments(id,project_id,uploader_id,name,mime,size,sha256,object_key,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM projects WHERE id=? AND last_operation=?)').bind(id,pid,user.id,filename,file.type,file.size,meta.sha256,objectKey,at,pid,op)]});}
  catch(e){await env.FILES.delete(objectKey);throw e;}
  return json(meta,201);
 }
 const fm=sub.match(/^files\/([^/]+)$/);
 if(fm&&method==='GET'){const f=await one(env,'SELECT * FROM attachments WHERE id=? AND project_id=?',fm[1],pid);assert(f,'文件不存在',404);const object=await env.FILES.get(f.object_key);assert(object,'文件对象缺失，请检查备份',404);return new Response(object.body,{headers:{'Content-Type':f.mime,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'"}});}
 if(sub==='channels'&&method==='GET'){
  const c=await one(env,'SELECT enabled,inherit_global,global_revision,updated_at FROM channel_settings WHERE project_id=?',pid),global=await readNotifyConfig(env),resolved=await resolveNotifyEnv(env);
  return json({wecomConfigured:!!c?.enabled&&(c.inherit_global?!!(global?.deliveryEnabled&&global.wecomEnabled&&global.wecomEncrypted&&c.global_revision===global.revision):!!c.wecom_encrypted),mode:c?.enabled?(c.inherit_global?'global':'project'):'off',globalAvailable:!!(global?.deliveryEnabled&&global.wecomEnabled&&global.wecomEncrypted),globalRevision:global?.revision||0,globalAudience:global?.wecomAudience||'',globalReconfirmationRequired:!!c?.inherit_global&&c.global_revision!==global?.revision,smsProviderConfigured:!!(resolved.ALIYUN_ACCESS_KEY_ID&&resolved.ALIYUN_ACCESS_KEY_SECRET&&resolved.ALIYUN_SMS_SIGN_NAME&&resolved.ALIYUN_SMS_TEMPLATE_CODE),updatedAt:c?.updated_at||null,outbox:await rows(env,'SELECT id,channel,title,status,attempts,error,provider_receipt,created_at,sent_at FROM outbox WHERE project_id=? ORDER BY created_at DESC LIMIT 100',pid)});
 }
 if(sub==='channels'&&method==='POST'){
  requireReauth(session);partner(state,user);assert(user.id===state.ownerId,'仅项目负责人可配置项目接收范围',403);const a=await body(req),mode=a.mode||(a.enabled?'project':'off');assert(['off','project','global'].includes(mode),'通知模式无效');
  let endpoint='',encrypted=null,revision=0;
  if(mode==='global'){const c=await readNotifyConfig(env);assert(c?.deliveryEnabled&&c.wecomEnabled&&c.wecomEncrypted,'管理员尚未配置全站企业微信');assert(a.confirmAudience===true&&a.expectedGlobalRevision===c.revision,'请核对全站接收群人员范围并明确确认；配置变化后需重新确认');revision=c.revision;}
  if(mode==='project'){if(a.webhook){endpoint=validateWecom(a.webhook);encrypted=encrypt(endpoint,env.CONFIG_ENCRYPTION_KEY);}else{const old=await one(env,'SELECT wecom_encrypted,inherit_global FROM channel_settings WHERE project_id=?',pid);assert(old?.wecom_encrypted&&!old.inherit_global,'请填写本项目独立机器人地址');encrypted=old.wecom_encrypted;}}
  await mutate(env,pid,user,{type:'channel.update',data:{enabled:mode!=='off',mode,globalRevision:revision}},keyOf(req),{channelVerified:true,extraHash:sha(endpoint||encrypted||''),extraStatements:(e,pid,op)=>[e.DB.prepare('INSERT INTO channel_settings(project_id,wecom_encrypted,enabled,updated_by,updated_at,inherit_global,global_revision) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM projects WHERE id=? AND last_operation=?) ON CONFLICT(project_id) DO UPDATE SET wecom_encrypted=excluded.wecom_encrypted,enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=excluded.updated_at,inherit_global=excluded.inherit_global,global_revision=excluded.global_revision').bind(pid,encrypted,mode==='off'?0:1,user.id,now(),mode==='global'?1:0,revision,pid,op)]});return json({ok:true});
 }
 if(sub==='channels/test'&&method==='POST'){requireReauth(session);partner(state,user);const id=uid();await env.DB.prepare("INSERT INTO outbox(id,project_id,channel,title,body,target,severity,created_at) VALUES(?,?,'wecom','通知渠道测试','由用户主动发起','','info',?)").bind(id,pid,now()).run();await deliverOne(env,id);return json(await one(env,'SELECT status,error FROM outbox WHERE id=?',id));}
 if(sub==='channels/retry'&&method==='POST'){
  requireReauth(session);partner(state,user);const a=await body(req),item=await one(env,'SELECT * FROM outbox WHERE id=? AND project_id=?',a.id,pid);
  assert(item,'通知不存在',404);assert(['failed','not_configured','uncertain'].includes(item.status),'该状态不可人工重试');assert(item.status!=='uncertain'||a.acceptPossibleDuplicate===true,'结果不确定，核查服务商回执后确认可能重复发送');
  const key=keyOf(req);assert(typeof key==='string'&&/^[a-zA-Z0-9_-]{12,100}$/.test(key),'缺少有效的请求幂等键');const newId='retry:'+sha(user.id+':'+item.id+':'+key);
  await env.DB.prepare("INSERT OR IGNORE INTO outbox(id,project_id,user_id,channel,title,body,target,severity,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(newId,pid,item.user_id,item.channel,item.title,item.body,item.target,item.severity,now()).run();await deliverOne(env,newId);return json({...await one(env,'SELECT status,error FROM outbox WHERE id=?',newId),id:newId,originalId:item.id});
 }
 throw new AppError('接口不存在或方法不支持',404);
}
function secure(response,req) {
 const r=new Response(response.body,response);r.headers.set('X-Content-Type-Options','nosniff');r.headers.set('Referrer-Policy','same-origin');r.headers.set('X-Frame-Options','DENY');r.headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
 if(!r.headers.has('Content-Security-Policy'))r.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
 if(new URL(req.url).protocol==='https:')r.headers.set('Strict-Transport-Security','max-age=31536000');if(new URL(req.url).pathname.startsWith('/api/'))r.headers.set('Cache-Control','no-store');return r;
}
export default {
 async fetch(req,env,ctx){try{return secure(await handle(req,env,ctx),req);}catch(e){if(e instanceof AppError)return secure(json({error:e.message,code:e.code},e.status),req);const id=uid();console.error('request_failed',id,e?.stack||e);return secure(json({error:'操作未完成，请刷新后重试或联系管理员',code:'INTERNAL_ERROR',requestId:id},500),req);}},
 async scheduled(controller,env,ctx){
  const failures=[];for(const [name,job] of [['notifications',scheduled],['ai',processAiJobs],['backups',scheduledBackups]])try{await job(env);}catch(error){failures.push(name);await adminAlert(env,'schedule:'+name+':'+now().slice(0,10),'定时任务执行异常',{task:name,note:'请检查部署日志、绑定与配额'}).catch(()=>{});}
  if(failures.length)throw new Error('Scheduled subsystems failed: '+failures.join(','));
 },
 async queue(batch,env,ctx){for(const msg of batch.messages){try{await deliverOne(env,msg.body.id);msg.ack();}catch{msg.retry({delaySeconds:60});}}}
};
