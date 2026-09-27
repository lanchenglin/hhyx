import {validateWecomURL,resolveNotifyEnv,resolveWecom,reserveSms,adminAlert} from './notification-config.js';
import { createHmac } from 'node:crypto';
import { assert, decrypt, uid, now, sha } from './util.js';
import { one, rows } from './store.js';
export const percentEncode = s => encodeURIComponent(String(s)).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
export function aliyunSignedParams(params,secret,method='POST') {
 const sorted=Object.keys(params).sort().map(k=>`${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
 const signature=createHmac('sha1',secret+'&').update(`${method}&%2F&${percentEncode(sorted)}`).digest('base64');
 return `${sorted}&Signature=${percentEncode(signature)}`;
}
export const validateWecom=validateWecomURL;
async function sendWecom(env,row,fetcher) {
 const resolved=await resolveWecom(env,row.project_id);if(!resolved.endpoint)return {status:resolved.status,error:resolved.error};
 const endpoint=resolved.endpoint;
 const project=await one(env,'SELECT name FROM projects WHERE id=?',row.project_id);
 const link=`${env.APP_URL}/#project=${encodeURIComponent(row.project_id)}&tab=notifications`;
 // 外部群只接收最小化提示，不包含账号、报价附件和详细财务信息。
 const content=`【合伙有序】${project?.name||'合作项目'}\n${row.title}\n请登录系统查看详情并处理；消息送达不代表同意。\n${link}`;
 const response=await fetcher(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({msgtype:'text',text:{content}}),signal:AbortSignal.timeout(10000),redirect:'error'});
 const data=await response.json();if(response.ok&&data.errcode===0)return {status:'accepted',receipt:'wecom-api-accepted'};
 return {status:response.status>=500||data.errcode===45009?'retry':'failed',error:`企业微信拒绝：HTTP ${response.status} / ${Number(data.errcode)||'unknown'}`};
}
async function sendSms(env,row,fetcher) {
 env=await resolveNotifyEnv(env);if(env.NOTIFY_DELIVERY_ENABLED===false)return {status:'disabled',error:'管理员已停止全站外发通知'};
 if(!env.ALIYUN_ACCESS_KEY_ID||!env.ALIYUN_ACCESS_KEY_SECRET||!env.ALIYUN_SMS_SIGN_NAME||!env.ALIYUN_SMS_TEMPLATE_CODE)return {status:'not_configured',error:'短信密钥/签名/模板尚未配置'};
 const user=await one(env,'SELECT phone,sms_opt_in,disabled FROM users WHERE id=?',row.user_id);
 if(!user?.phone||!user.sms_opt_in||user.disabled)return {status:'disabled',error:'接收人未启用短信或未提供手机号'};
 const project=await one(env,'SELECT name,state FROM projects WHERE id=?',row.project_id);
 if(!project||!JSON.parse(project.state).members.some(m=>m.active&&m.userId===row.user_id))return {status:'disabled',error:'接收人不再是有效项目成员'};
 if(!await reserveSms(env,row.id,row.user_id))return {status:'failed',error:'达到短信日额度/个人小时限制，或该请求已预占，未再次发送'};
 const params={AccessKeyId:env.ALIYUN_ACCESS_KEY_ID,Action:'SendSms',Version:'2017-05-25',Format:'JSON',RegionId:'cn-hangzhou',SignatureMethod:'HMAC-SHA1',SignatureVersion:'1.0',SignatureNonce:uid(),Timestamp:now().replace(/\.\d{3}Z$/,'Z'),PhoneNumbers:user.phone,SignName:env.ALIYUN_SMS_SIGN_NAME,TemplateCode:env.ALIYUN_SMS_TEMPLATE_CODE,TemplateParam:JSON.stringify({project:project.name.slice(0,20),title:row.title.slice(0,20)}),OutId:sha(row.id).slice(0,32)};
 const response=await fetcher('https://dysmsapi.aliyuncs.com/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:aliyunSignedParams(params,env.ALIYUN_ACCESS_KEY_SECRET),signal:AbortSignal.timeout(10000),redirect:'error'});
 const data=await response.json();if(response.ok&&data.Code==='OK')return {status:'accepted',receipt:data.BizId||data.RequestId||''};
 // SendSms 没有幂等保证；5xx 也可能已发送，因此不自动重发。
 return {status:response.status>=500?'uncertain':'failed',error:`短信服务返回：${String(data.Code||response.status).slice(0,120)}`};
}
export async function deliverOne(env,id,fetcher=env.NOTIFY_TEST_FETCH||fetch) {
 const epoch=Math.floor(Date.now()/1000),lease=uid();
 const claim=await env.DB.prepare("UPDATE outbox SET status='sending',lease_until=?,lease_token=?,attempts=attempts+1 WHERE id=? AND status IN ('pending','retry') AND next_at<=?").bind(epoch+60,lease,id,epoch).run();
 if(!claim.meta.changes)return;
 const row=await one(env,'SELECT * FROM outbox WHERE id=?',id);let result;
 const projectStatus=await one(env,'SELECT lifecycle FROM projects WHERE id=?',row.project_id);
 if(!projectStatus||projectStatus.lifecycle!=='active'){await env.DB.prepare("UPDATE outbox SET status='disabled',error='项目已归档或进入回收站，停止外发通知',lease_until=0 WHERE id=? AND lease_token=?").bind(id,lease).run();return;}
 try{result=row.channel==='sms'?await sendSms(env,row,fetcher):await sendWecom(env,row,fetcher);}catch(e){result={status:row.channel==='sms'?'uncertain':'retry',error:row.channel==='sms'?'发送结果不确定；请核查回执后人工决定重发':'发送失败或超时，将有限重试'};}
 if(result.status==='retry'&&row.attempts>=5)result.status='failed';
 if(['uncertain','failed'].includes(result.status))await adminAlert(env,'notice:'+row.id,'通知投递需要检查',{outboxId:row.id,channel:row.channel,status:result.status});
 await env.DB.prepare('UPDATE outbox SET status=?,error=?,provider_receipt=?,sent_at=?,next_at=?,lease_until=0 WHERE id=? AND lease_token=?').bind(result.status,result.error||null,result.receipt||null,result.status==='accepted'?now():null,epoch+Math.min(3600,60*2**row.attempts),id,lease).run();
}
export async function drain(env,projectId=null,limit=8,fetcher=env.NOTIFY_TEST_FETCH||fetch) {
 const epoch=Math.floor(Date.now()/1000);
 // 超时失去租约的短信保留为不确定，不能当成肯定没发送。
 await env.DB.prepare("UPDATE outbox SET status=CASE WHEN channel='sms' THEN 'uncertain' ELSE 'retry' END,error='发送进程中断，请检查渠道记录' WHERE status='sending' AND lease_until<?").bind(epoch).run();
 const list=projectId?await rows(env,"SELECT id FROM outbox WHERE project_id=? AND status IN ('pending','retry') AND next_at<=? ORDER BY created_at LIMIT ?",projectId,epoch,limit):await rows(env,"SELECT id FROM outbox WHERE status IN ('pending','retry') AND next_at<=? ORDER BY created_at LIMIT ?",epoch,limit);
 for(const row of list)await deliverOne(env,row.id,fetcher);
 return {processed:list.length};
}
export async function kick(env,pid) {
 if(env.NOTIFY_QUEUE){const list=await rows(env,"SELECT id FROM outbox WHERE project_id=? AND status='pending' ORDER BY created_at LIMIT 20",pid);if(list.length)await env.NOTIFY_QUEUE.sendBatch(list.map(r=>({body:{id:r.id}})));}
 else await drain(env,pid,5);
}
async function insertReminder(env,p,userId,key,title,body,target,severity='warning') {
 const at=now();await env.DB.batch([
  env.DB.prepare('INSERT OR IGNORE INTO reminder_keys(id,created_at) VALUES(?,?)').bind(key,at),
  env.DB.prepare('INSERT OR IGNORE INTO notifications(id,project_id,user_id,title,body,target,severity,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(key,p.id,userId,title,body,target,severity,at)
 ]);
}
export async function scheduled(env) {
 const epoch=Math.floor(Date.now()/1000), today=new Intl.DateTimeFormat('en-CA',{timeZone:env.TZ||'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const cursor=(await one(env,"SELECT value FROM settings WHERE key='reminder_cursor'"))?.value||'';
 let list=await rows(env,"SELECT id,state FROM projects WHERE lifecycle='active' AND id>? ORDER BY id LIMIT 5",cursor);
 if(!list.length)list=await rows(env,"SELECT id,state FROM projects WHERE lifecycle='active' ORDER BY id LIMIT 5");
 for(const row of list){
  const p=JSON.parse(row.state);if(p.status==='draft'||p.status==='completed')continue;
  // 限量生成提醒，避免大量任务在一次 Cron 中超过 D1 查询配额。
  // 每项目游标轮转，不用“每次只取前40项”而让后面的成员永远收不到提醒。
  const candidates=[];
  const nextDay=new Date(new Date(today+'T00:00:00Z').getTime()+86400000).toISOString().slice(0,10);
  for(const t of p.tasks.filter(t=>t.status!=='done'&&t.dueDate<=nextDay)){
   const ids=t.status==='review'?[t.reviewerId]:[t.assigneeId];
   for(const id of ids){const m=p.members.find(m=>m.id===id&&m.active&&m.userId);if(m)candidates.push([m.userId,`task:${today}:${p.id}:${t.id}:${m.id}`,t.dueDate<today?'任务已逾期':'任务即将到期',t.title,'tasks']);}
  }
  for(const q of p.purchases.filter(q=>q.status==='pending'))for(const s of q.signers){if(q.decisions[s.id]?.decision!=='approve')candidates.push([s.userId,`approval:${today}:${p.id}:${q.id}:v${q.version}:${s.id}`,'采购仍待你处理',q.title,`purchase:${q.id}`]);}
  for(const g of p.proposals.filter(g=>g.status==='pending'))for(const s of g.signers){if(!g.decisions[s.id])candidates.push([s.userId,`proposal:${today}:${p.id}:${g.id}:${s.id}`,'共同决策仍待你表态',g.reason,'decisions']);}
  const itemKey=`reminder_item_cursor:${p.id}`;
  let offset=Number((await one(env,'SELECT value FROM settings WHERE key=?',itemKey))?.value||0);
  if(!Number.isSafeInteger(offset)||offset<0||offset>=candidates.length)offset=0;
  const batch=candidates.slice(offset,offset+40);
  for(const args of batch)await insertReminder(env,p,...args);
  const next=offset+batch.length>=candidates.length?0:offset+batch.length;
  await env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(itemKey,String(next)).run();
  if(candidates.length){const key=`digest:${today}:${p.id}`;await env.DB.prepare("INSERT OR IGNORE INTO outbox(id,project_id,channel,title,body,target,severity,created_at) VALUES(?,?,'wecom',?,?,?,'warning',?)").bind(key,p.id,'今日待办与审批提醒',`有${candidates.length}项待处理，请登录查看`,'notifications',now()).run();}
 }
 if(list.length)await env.DB.prepare("INSERT INTO settings(key,value) VALUES('reminder_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(list.at(-1).id).run();
 await env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(epoch).run();await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(epoch).run();
 return drain(env,null,20);
}
