import {notificationFetch} from './notification-transport.js';
import {assert,encrypt,decrypt,text,now,sha} from './util.js';
import {one} from './store.js';
export const NOTIFY_CONFIG_KEY='admin_notification_config';
export function validateWecomURL(value){
 let u;try{u=new URL(value);}catch{assert(false,'企业微信机器人地址格式不正确');}
 assert(u.protocol==='https:'&&u.hostname==='qyapi.weixin.qq.com'&&!u.port&&!u.username&&!u.password&&!u.hash&&u.pathname==='/cgi-bin/webhook/send'&&[...u.searchParams.keys()].length===1&&/^[A-Za-z0-9_-]{10,100}$/.test(u.searchParams.get('key')||''),'仅允许企业微信官方群机器人地址和key参数');return u.toString();
}
export async function readNotifyConfig(env){const r=await one(env,'SELECT value FROM settings WHERE key=?',NOTIFY_CONFIG_KEY);if(!r)return null;try{const c=JSON.parse(r.value);assert(Number.isInteger(c.revision)&&c.revision>0,'通知配置损坏',503);return c;}catch{assert(false,'通知配置不可读取，不回退旧凭据',503);}}
export function notifyView(env,c){return c?{revision:c.revision,source:'database',deliveryEnabled:c.deliveryEnabled,wecomEnabled:c.wecomEnabled,wecomConfigured:!!c.wecomEncrypted,wecomAudience:c.wecomAudience||'',smsEnabled:c.smsEnabled,smsConfigured:!!(c.smsIdEncrypted&&c.smsSecretEncrypted),signName:c.signName,templateCode:c.templateCode,dailySmsLimit:c.dailySmsLimit,adminAlertsEnabled:c.adminAlertsEnabled,updatedAt:c.updatedAt,encryptionReady:!!env.CONFIG_ENCRYPTION_KEY}:{revision:0,source:'environment',deliveryEnabled:true,wecomEnabled:false,wecomConfigured:false,wecomAudience:'',smsEnabled:!!env.ALIYUN_ACCESS_KEY_ID,smsConfigured:!!(env.ALIYUN_ACCESS_KEY_ID&&env.ALIYUN_ACCESS_KEY_SECRET),signName:env.ALIYUN_SMS_SIGN_NAME||'',templateCode:env.ALIYUN_SMS_TEMPLATE_CODE||'',dailySmsLimit:100,adminAlertsEnabled:false,encryptionReady:!!env.CONFIG_ENCRYPTION_KEY};}
export function validateNotifyConfig(env,a,old){
 assert(a.expectedRevision===(old?.revision||0),'通知配置已变化，请刷新后重试',409);
 for(const k of ['deliveryEnabled','wecomEnabled','smsEnabled','adminAlertsEnabled'])assert(typeof a[k]==='boolean','请明确通知开关：'+k);
 assert(Number.isInteger(a.dailySmsLimit)&&a.dailySmsLimit>=1&&a.dailySmsLimit<=1000,'短信日额度为1–1000条');
 const encryptInput=(v,previous,clear,name)=>{if(clear)return null;if(!v)return previous||null;assert(typeof v==='string'&&v.length<=8192,'密钥格式无效：'+name);return encrypt(v,env.CONFIG_ENCRYPTION_KEY);};
 if(a.webhook)validateWecomURL(a.webhook);
 const c={revision:(old?.revision||0)+1,deliveryEnabled:a.deliveryEnabled,wecomEnabled:a.wecomEnabled,smsEnabled:a.smsEnabled,adminAlertsEnabled:a.adminAlertsEnabled,dailySmsLimit:a.dailySmsLimit,
  wecomEncrypted:encryptInput(a.webhook,old?.wecomEncrypted,a.clearWecom,'Webhook'),wecomAudience:text(a.wecomAudience,'全站接收群名称与获授权范围',1000,a.wecomEnabled),
  smsIdEncrypted:encryptInput(a.accessKeyId,(old?old.smsIdEncrypted:(env.ALIYUN_ACCESS_KEY_ID?encrypt(env.ALIYUN_ACCESS_KEY_ID,env.CONFIG_ENCRYPTION_KEY):null)),a.clearSms,'AccessKeyId'),
  smsSecretEncrypted:encryptInput(a.accessKeySecret,(old?old.smsSecretEncrypted:(env.ALIYUN_ACCESS_KEY_SECRET?encrypt(env.ALIYUN_ACCESS_KEY_SECRET,env.CONFIG_ENCRYPTION_KEY):null)),a.clearSms,'AccessKeySecret'),
  signName:text(a.signName,'短信签名',100,false),templateCode:text(a.templateCode,'短信模板',100,false),updatedAt:now()};
 assert(!c.wecomEnabled||c.wecomEncrypted,'启用企业微信需配置Webhook');assert(!c.adminAlertsEnabled||(c.wecomEnabled&&a.confirmAdminAudience===true),'启用管理告警需确认接收群仅含获授权的管理人员');
 assert(!c.smsEnabled||(c.smsIdEncrypted&&c.smsSecretEncrypted&&c.signName&&/^SMS_\d+$/.test(c.templateCode)),'启用短信需有效密钥、签名和审核通过的SMS模板编号');
 return c;
}
export async function resolveNotifyEnv(env){
 const c=await readNotifyConfig(env);if(!c)return env;
 const n={...env,NOTIFY_CONFIGURATION_REVISION:c.revision,NOTIFY_DELIVERY_ENABLED:c.deliveryEnabled,NOTIFY_DAILY_SMS_LIMIT:c.dailySmsLimit,ALIYUN_ACCESS_KEY_ID:'',ALIYUN_ACCESS_KEY_SECRET:'',ALIYUN_SMS_SIGN_NAME:'',ALIYUN_SMS_TEMPLATE_CODE:''};
 if(c.deliveryEnabled&&c.smsEnabled){try{n.ALIYUN_ACCESS_KEY_ID=decrypt(c.smsIdEncrypted,env.CONFIG_ENCRYPTION_KEY);n.ALIYUN_ACCESS_KEY_SECRET=decrypt(c.smsSecretEncrypted,env.CONFIG_ENCRYPTION_KEY);}catch{assert(false,'短信配置解密失败，不回退旧凭据',503);}n.ALIYUN_SMS_SIGN_NAME=c.signName;n.ALIYUN_SMS_TEMPLATE_CODE=c.templateCode;}return n;
}
export async function resolveWecom(env,projectId){
 const c=await readNotifyConfig(env);if(c&&!c.deliveryEnabled)return {error:'管理员已停止全站外发通知',status:'disabled'};
 const own=await one(env,'SELECT * FROM channel_settings WHERE project_id=?',projectId);
 if(!own?.enabled)return {error:'项目未启用企业微信提醒',status:'not_configured'};
 let ciphertext=own.wecom_encrypted;
 if(own.inherit_global){if(!c?.wecomEnabled||!c.wecomEncrypted)return {error:'全站企业微信未配置或停用',status:'not_configured'};if(own.global_revision!==c.revision)return {error:'全站通知配置已变更，项目需重新确认接收范围',status:'disabled'};ciphertext=c.wecomEncrypted;}
 if(!ciphertext)return {error:'未配置项目机器人',status:'not_configured'};
 return {endpoint:validateWecomURL(decrypt(ciphertext,env.CONFIG_ENCRYPTION_KEY))};
}
export async function reserveSms(env,id,userId){
 const day=now().slice(0,10),limit=Number(env.NOTIFY_DAILY_SMS_LIMIT||100),revision=Number(env.NOTIFY_CONFIGURATION_REVISION||0);
 const r=await env.DB.prepare('INSERT OR IGNORE INTO sms_dispatches(id,user_id,utc_day,created_at,config_revision) SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM sms_dispatches WHERE utc_day=?)<? AND (SELECT count(*) FROM sms_dispatches WHERE user_id=? AND created_at>?)<5').bind(id,userId,day,now(),revision,day,limit,userId,new Date(Date.now()-3600000).toISOString()).run();
 return !!r.meta.changes;
}
export async function adminAlert(env,id,title,details,severity='warning'){
 const inserted=await env.DB.prepare('INSERT OR IGNORE INTO admin_alerts(id,severity,title,details,created_at) VALUES(?,?,?,?,?)').bind(id,severity,title,JSON.stringify(details),now()).run();
 if(!inserted.meta.changes)return;
 const c=await readNotifyConfig(env).catch(()=>null);if(!c?.deliveryEnabled||!c.adminAlertsEnabled||!c.wecomEnabled||!c.wecomEncrypted)return;
 // Operational alarm only; never includes account secrets, project titles or financial data.
 try{const fetcher=env.NOTIFY_TEST_FETCH||fetch;const r=await notificationFetch(fetcher,validateWecomURL(decrypt(c.wecomEncrypted,env.CONFIG_ENCRYPTION_KEY)),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({msgtype:'text',text:{content:`【合伙有序·系统告警】${title}\n请管理员登录后台检查。编号 ${sha(id).slice(0,12)}`}}),signal:AbortSignal.timeout(10000)});const d=await r.json();if(!r.ok||d.errcode!==0)throw Error('refused');}catch{await env.DB.prepare('INSERT OR IGNORE INTO admin_alerts(id,severity,title,details,created_at) VALUES(?,?,?,?,?)').bind('delivery:'+id,'warning','管理告警外发未确认',JSON.stringify({sourceId:id,note:'站内告警已保留；不自动重发'}),now()).run();}
}
