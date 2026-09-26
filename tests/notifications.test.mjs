import test from 'node:test';import assert from 'node:assert/strict';import {fixture} from './helpers.mjs';import {aliyunSignedParams,percentEncode,validateWecom,deliverOne,scheduled} from '../src/notifications.js';import {encrypt,now,uid} from '../src/util.js';

test('通知安全、重试与到期提醒',async t=>{
 const f=await fixture(),{rt,owner,base,action}=f;
 const add=async(channel='wecom')=>{const id=uid();rt.db.prepare('INSERT INTO outbox(id,project_id,user_id,channel,title,body,target,severity,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,f.pid,owner.user.id,channel,'采购待确认','待办提醒','notifications','critical',now());return id;};
 const row=id=>rt.db.prepare('SELECT * FROM outbox WHERE id=?').get(id);
 await t.test('阿里云 RPC 编码保留 RFC3986 语义',()=>{assert.equal(percentEncode(" !'()*~"),'%20%21%27%28%29%2A~');const p={Timestamp:'2016-02-23T12:46:24Z',Format:'XML',AccessKeyId:'testid',Action:'DescribeRegions',SignatureMethod:'HMAC-SHA1',SignatureNonce:'3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf',Version:'2014-05-26',SignatureVersion:'1.0'};const params=aliyunSignedParams(p,'testsecret','GET');assert.equal(new URLSearchParams(params).get('Signature'),'OLeaidS1JvxuMvnyHOwuJ+uX5qY=');});
 await t.test('Webhook 主机白名单阻止任意地址和 SSRF',()=>{for(const u of ['http://127.0.0.1/x','https://evil.example/cgi-bin/webhook/send?key=abcdefghijk','https://qyapi.weixin.qq.com.evil.example/cgi-bin/webhook/send?key=abcdefghijk','https://user:pass@qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefghijk'])assert.throws(()=>validateWecom(u));assert.ok(validateWecom('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefghijk'));});
 await t.test('未配置渠道明确标注，不伪装成已送达',async()=>{const id=await add();let calls=0;await deliverOne(rt.env,id,async()=>{calls++;throw Error('不应该调用');});assert.equal(calls,0);assert.equal(row(id).status,'not_configured');});
 const endpoint='https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefghijk';rt.db.prepare('INSERT INTO channel_settings(project_id,wecom_encrypted,enabled,updated_by,updated_at) VALUES(?,?,?,?,?)').run(f.pid,encrypt(endpoint,rt.env.CONFIG_ENCRYPTION_KEY),1,owner.user.id,now());
 await t.test('企业微信 API 接受后不重复发送，但不标记为用户已阅读',async()=>{const id=await add();let calls=0;const fetcher=async(url,opts)=>{calls++;assert.equal(url,endpoint);assert.equal(JSON.parse(opts.body).msgtype,'text');return Response.json({errcode:0,errmsg:'ok'});};await Promise.all([deliverOne(rt.env,id,fetcher),deliverOne(rt.env,id,fetcher)]);assert.equal(calls,1);assert.equal(row(id).status,'accepted');assert.equal(row(id).provider_receipt,'wecom-api-accepted');await deliverOne(rt.env,id,fetcher);assert.equal(calls,1);});
 await t.test('企业微信限流会有限退避重试',async()=>{const id=await add();await deliverOne(rt.env,id,async()=>Response.json({errcode:45009}));assert.equal(row(id).status,'retry');assert.ok(row(id).next_at>Math.floor(Date.now()/1000));});
 await t.test('短信配置不完整不会发送',async()=>{const id=await add('sms');await deliverOne(rt.env,id,async()=>{throw Error('不能调用');});assert.equal(row(id).status,'not_configured');});
 Object.assign(rt.env,{ALIYUN_ACCESS_KEY_ID:'example-test-key',ALIYUN_ACCESS_KEY_SECRET:'example-test-secret',ALIYUN_SMS_SIGN_NAME:'测试签名',ALIYUN_SMS_TEMPLATE_CODE:'SMS_TEST_ONLY'});
 rt.db.prepare('UPDATE users SET phone=?,sms_opt_in=1 WHERE id=?').run('13800138000',owner.user.id);
 await t.test('短信接口返回 OK 只表示服务商接受，并保存回执号',async()=>{const id=await add('sms');await deliverOne(rt.env,id,async(url,opts)=>{assert.equal(url,'https://dysmsapi.aliyuncs.com/');assert.equal(new URLSearchParams(opts.body).get('Action'),'SendSms');assert.equal(new URLSearchParams(opts.body).get('PhoneNumbers'),'13800138000');return Response.json({Code:'OK',BizId:'mock-biz-id'});});assert.equal(row(id).status,'accepted');assert.equal(row(id).provider_receipt,'mock-biz-id');});
 await t.test('短信超时标记不确定，不盲目自动重试',async()=>{const id=await add('sms');let calls=0;const fetcher=async()=>{calls++;throw Error('timeout');};await deliverOne(rt.env,id,fetcher);await deliverOne(rt.env,id,fetcher);assert.equal(row(id).status,'uncertain');assert.equal(calls,1);});
 await t.test('到期任务和未会签事项生成待办，重复触发不会重复堆积',async()=>{rt.db.prepare('UPDATE channel_settings SET enabled=0').run();delete rt.env.ALIYUN_ACCESS_KEY_ID;const p=await owner.ok(base,undefined,'GET');await action(owner,'task.add',{title:'到期测试任务',stageId:'stage-pilot',assigneeId:p.members[0].id,reviewerId:p.members[1].id,dueDate:'2026-01-01',deliverable:'测试成果'});await f.submitPurchase();await scheduled(rt.env);const first=rt.db.prepare("SELECT count(*) n FROM notifications WHERE id LIKE 'task:%' OR id LIKE 'approval:%'").get().n;await scheduled(rt.env);const second=rt.db.prepare("SELECT count(*) n FROM notifications WHERE id LIKE 'task:%' OR id LIKE 'approval:%'").get().n;assert.ok(first>=4);assert.equal(first,second);});
 await t.test('大量任务按游标分批提醒，后排任务不会饥饿',async()=>{
  const raw=rt.db.prepare('SELECT state FROM projects WHERE id=?').get(f.pid);const p=JSON.parse(raw.state);
  const template=p.tasks[0];for(let i=0;i<83;i++)p.tasks.push({...template,id:`reminder-load-${i}`,title:`批量任务${i}`});
  rt.db.prepare('UPDATE projects SET state=? WHERE id=?').run(JSON.stringify(p),f.pid);
  for(let i=0;i<4;i++)await scheduled(rt.env);
  const n=rt.db.prepare("SELECT count(*) n FROM notifications WHERE id LIKE '%:reminder-load-%:%'").get().n;
  assert.equal(n,83);
 });
 await f.close();
});
