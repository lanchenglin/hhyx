import {assert,AppError,body,json,now,uid,sha,text,decrypt} from './util.js';
import {one,rows} from './store.js';
import {siteChange,adminAuditStatement} from './admin.js';
import {rateLimit} from './auth.js';
import {mfaPolicy} from './mfa.js';
import {NOTIFY_CONFIG_KEY,readNotifyConfig,notifyView,validateNotifyConfig,resolveNotifyEnv,reserveSms,validateWecomURL} from './notification-config.js';
import {aliyunSignedParams} from './notifications.js';
import {BACKUP_CONFIG_KEY,backupReady,backupConfig,backupStatus,requestBackup,processBackupJobs,backupDownload} from './backups.js';
const keyOf=req=>req.headers.get('x-idempotency-key');
const why=a=>text(a.reason,'操作原因',1000);
export async function operationsAdminRoute(req,env,ctx,{user,session,url}){
 const p=url.pathname.slice('/api/admin'.length),method=req.method;
 if(p==='/security'&&method==='GET')return json({policy:await mfaPolicy(env),admins:await rows(env,"SELECT u.id,u.name,u.username,CASE WHEN m.secret_encrypted IS NOT NULL THEN 1 ELSE 0 END AS enrolled FROM users u LEFT JOIN mfa_credentials m ON u.id=m.user_id WHERE u.system_role='admin' AND u.disabled=0"),selfEnrolled:session.mfaEnabled});
 if(p==='/security/policy'&&method==='POST'){
  const a=await body(req),reason=why(a);assert(typeof a.requireAdmins==='boolean','请明确是否要求管理员二次验证');
  assert(session.mfaEnabled,'修改强制验证策略前，请先为本人绑定动态验证码',409);
  return json(await siteChange(env,user,keyOf(req),{...a,action:'security.mfa_policy'},async({guarded,condition})=>{
   if(a.requireAdmins){const missing=await one(env,"SELECT COUNT(*) AS n FROM users u LEFT JOIN mfa_credentials m ON u.id=m.user_id WHERE u.system_role='admin' AND u.disabled=0 AND m.secret_encrypted IS NULL");assert(missing.n===0,'先让全部现有有效管理员完成绑定，再开启强制策略',409);}
   return {details:{reason,requireAdmins:a.requireAdmins},statements:[guarded('INSERT INTO settings(key,value) SELECT ?,? WHERE '+condition+' ON CONFLICT(key) DO UPDATE SET value=excluded.value','mfa_policy',JSON.stringify({requireAdmins:a.requireAdmins,updatedAt:now()}))]};
  }));
 }
 if(p==='/notification-settings'&&method==='GET')return json(notifyView(env,await readNotifyConfig(env)));
 if(p==='/notification-settings'&&method==='POST'){
  const a=await body(req),reason=why(a);
  await siteChange(env,user,keyOf(req),{...a,action:'notifications.configure'},async({condition,guarded})=>{
   const c=validateNotifyConfig(env,a,await readNotifyConfig(env));
   return {details:{reason,revision:c.revision,deliveryEnabled:c.deliveryEnabled,wecomEnabled:c.wecomEnabled,smsEnabled:c.smsEnabled,adminAlertsEnabled:c.adminAlertsEnabled,keyChanged:!!(a.webhook||a.accessKeyId||a.accessKeySecret||a.clearSms||a.clearWecom)},statements:[guarded('INSERT INTO settings(key,value) SELECT ?,? WHERE '+condition+' ON CONFLICT(key) DO UPDATE SET value=excluded.value',NOTIFY_CONFIG_KEY,JSON.stringify(c))]};
  });return json(notifyView(env,await readNotifyConfig(env)));
 }
 if(p==='/notification-settings/test'&&method==='POST'){
  const a=await body(req);assert(a.confirmSend===true,'必须明确确认向授权测试接收方发送，短信可能计费');assert(['wecom','sms'].includes(a.channel),'测试渠道无效');await rateLimit(env,'notification-provider-test',5,3600);
  const c=await readNotifyConfig(env);assert(c?.deliveryEnabled&&a.expectedRevision===c.revision,'先保存有效配置，刷新后再测试',409);
  const fetcher=env.NOTIFY_TEST_FETCH||fetch;let result;
  if(a.channel==='wecom'){
   assert(c.wecomEnabled&&c.wecomEncrypted,'企业微信尚未配置');assert(a.confirmAudience===true,'请确认接收群已同意接收此测试');
   try{const r=await fetcher(validateWecomURL(decrypt(c.wecomEncrypted,env.CONFIG_ENCRYPTION_KEY)),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({msgtype:'text',text:{content:'【合伙有序】管理员发起的通知连接测试，不包含任何项目资料。'}}),redirect:'error',signal:AbortSignal.timeout(10000)});const d=await r.json();result={accepted:r.ok&&d.errcode===0,status:r.ok&&d.errcode===0?'accepted':'failed',httpStatus:r.status};}catch{result={accepted:false,status:'uncertain'};}
  }else{
   const n=await resolveNotifyEnv(env);assert(n.ALIYUN_ACCESS_KEY_ID&&n.ALIYUN_ACCESS_KEY_SECRET,'短信尚未配置');assert(user.phone&&user.sms_opt_in,'短信测试仅能发给管理员本人：请先在账号偏好填写手机并同意短信');
   const id='probe:'+uid();assert(await reserveSms(n,id,user.id),'短信额度或个人小时限制已用完',429);
   const params={AccessKeyId:n.ALIYUN_ACCESS_KEY_ID,Action:'SendSms',Version:'2017-05-25',Format:'JSON',RegionId:'cn-hangzhou',SignatureMethod:'HMAC-SHA1',SignatureVersion:'1.0',SignatureNonce:uid(),Timestamp:now().replace(/\.\d{3}Z$/,'Z'),PhoneNumbers:user.phone,SignName:n.ALIYUN_SMS_SIGN_NAME,TemplateCode:n.ALIYUN_SMS_TEMPLATE_CODE,TemplateParam:JSON.stringify({project:'系统测试',title:'管理员连接测试'}),OutId:sha(id).slice(0,32)};
   try{const r=await fetcher('https://dysmsapi.aliyuncs.com/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:aliyunSignedParams(params,n.ALIYUN_ACCESS_KEY_SECRET),redirect:'error',signal:AbortSignal.timeout(10000)});const d=await r.json();result={accepted:r.ok&&d.Code==='OK',status:r.ok&&d.Code==='OK'?'accepted':r.status>=500?'uncertain':'failed',httpStatus:r.status};}catch{result={accepted:false,status:'uncertain'};}
  }
  await adminAuditStatement(env,user,'notifications.test',a.channel,result).run();return json({...result,message:result.accepted?'服务商已接受测试，不代表接收人已阅读':'未确认发送成功；不自动重试，请核对服务商回执'});
 }
 if(p==='/delivery'&&method==='GET')return json({records:await rows(env,"SELECT id,project_id,channel,title,status,attempts,error,created_at,sent_at FROM outbox ORDER BY created_at DESC LIMIT 100"),alerts:(await rows(env,'SELECT * FROM admin_alerts ORDER BY created_at DESC LIMIT 100')).map(r=>({...r,details:JSON.parse(r.details)}))});
 if(p==='/delivery/retry'&&method==='POST'){
  const a=await body(req),reason=why(a);assert(a.confirmDuplicate===true,'请确认已核对回执，重发可能重复通知或产生短信费用');
  return json(await siteChange(env,user,keyOf(req),{...a,action:'notifications.retry'},async({condition,guarded})=>{
   const old=await one(env,'SELECT * FROM outbox WHERE id=?',a.id);assert(old&&['failed','uncertain','not_configured','disabled'].includes(old.status),'只能重发终止或不确定状态的消息');const newId=uid();
   return {target:old.id,result:{ok:true,outboxId:newId},details:{reason,sourceId:old.id,newId,originalStatus:old.status},statements:[guarded("INSERT INTO outbox(id,project_id,user_id,channel,title,body,target,severity,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE "+condition,newId,old.project_id,old.user_id,old.channel,old.title,old.body,old.target,old.severity,now())]};
  }));
 }
 if(p==='/alerts/acknowledge'&&method==='POST'){
  const a=await body(req),reason=why(a);return json(await siteChange(env,user,keyOf(req),{...a,action:'alert.acknowledge'},async({condition,guarded})=>({target:a.id,details:{reason},statements:[guarded('UPDATE admin_alerts SET acknowledged_at=?,acknowledged_by=? WHERE id=? AND acknowledged_at IS NULL AND '+condition,now(),user.id,a.id)]})));
 }
 if(p==='/backups'&&method==='GET')return json(await backupStatus(env));
 if(p==='/backups/settings'&&method==='POST'){
  const a=await body(req),reason=why(a);assert(typeof a.enabled==='boolean'&&typeof a.autoDrill==='boolean'&&Number.isInteger(a.utcHour)&&a.utcHour>=0&&a.utcHour<=23,'请设置UTC时刻和明确的开关');if(a.enabled)backupReady(env,a.autoDrill);assert(!a.autoDrill||a.enabled,'自动演练须同时启用自动备份');
  return json(await siteChange(env,user,keyOf(req),{...a,action:'backup.settings'},async({condition,guarded})=>{const old=await backupConfig(env);assert(a.expectedRevision===old.revision,'备份设置已变化',409);const c={revision:old.revision+1,enabled:a.enabled,utcHour:a.utcHour,autoDrill:a.autoDrill,updatedAt:now()};return {details:{reason,...c},statements:[guarded('INSERT INTO settings(key,value) SELECT ?,? WHERE '+condition+' ON CONFLICT(key) DO UPDATE SET value=excluded.value',BACKUP_CONFIG_KEY,JSON.stringify(c))]};}));
 }
 if(p==='/backups/run'&&method==='POST'){
  const a=await body(req);assert(a.confirmStorage===true,'请确认创建私有加密备份，可能产生存储与请求费用');const reason=why(a),kind=a.kind||'backup';assert(kind!=='drill'||a.confirmIsolation===true,'请确认使用独立的演练库和演练桶，不切换生产服务');
  const key=keyOf(req);assert(typeof key==='string'&&key.length>=12&&key.length<=100,'缺少有效幂等键');const requestKey='admin:'+user.id+':'+key;
  const prior=await one(env,'SELECT kind,source_id FROM backup_jobs WHERE request_key=?',requestKey);if(prior)assert(prior.kind===kind&&(prior.source_id||null)===(a.sourceId||null),'同一请求不能更换备份任务',409);
  const result=await requestBackup(env,user.id,{kind,sourceId:a.sourceId||null,requestKey});if(!result.idempotent)await adminAuditStatement(env,user,'backup.request',result.id,{reason,kind,sourceId:a.sourceId||null}).run();ctx.waitUntil(processBackupJobs(env));return json(result,202);
 }
 const dl=p.match(/^\/backups\/([a-f0-9-]+)\/download$/);if(dl&&method==='GET'){assert(session.reauthAt>=Math.floor(Date.now()/1000)-300,'下载全站备份前请重新验证密码',403,'REAUTH_REQUIRED');if(session.mfaEnabled)assert(session.mfaAt>=Math.floor(Date.now()/1000)-300,'下载前请重新验证动态验证码',403,'MFA_STEPUP_REQUIRED');await adminAuditStatement(env,user,'backup.download',dl[1],{encrypted:true}).run();return backupDownload(env,dl[1]);}
 return null;
}
