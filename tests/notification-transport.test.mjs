import test from 'node:test';
import assert from 'node:assert/strict';
import {notificationFetch} from '../src/notification-transport.js';
import {deliverOne} from '../src/notifications.js';
import {fixture} from './helpers.mjs';
import {encrypt,now,uid} from '../src/util.js';

test('通知传输使用明确的manual模式，所有重定向均停止且不泄露上游内容',async()=>{
  for(const status of [300,301,302,303,304,305,307,308,399]) {
    let calls=0,read=false,cancelled=false;
    const stream=status===304?null:new ReadableStream({pull(c){read=true;c.enqueue(new TextEncoder().encode('synthetic-private-upstream'));c.close();},cancel(){cancelled=true;}},{highWaterMark:0});
    const fetcher=async(url,opts)=>{calls++;assert.equal(url,'https://example.com/notify');assert.equal(opts.redirect,'manual');return new Response(stream,{status,headers:{location:'https://redirect.example/collect?secret=synthetic'}});};
    await assert.rejects(notificationFetch(fetcher,'https://example.com/notify',{method:'POST',body:'synthetic-only'}),err=>{assert.equal(err.code,'NOTIFICATION_REDIRECT');assert.equal(err.httpStatus,status);assert.ok(!err.message.includes('synthetic-private')&&!err.message.includes('secret='));return true;});
    assert.equal(calls,1);assert.equal(read,false);if(stream)assert.equal(cancelled,true);
  }
});

test('实际通知任务遇到重定向停止，不当成成功、不自动重发；新提醒仍需渠道与本人同意',async()=>{
 const f=await fixture();try{
  const endpoint='https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-notification-key';
  f.rt.db.prepare('INSERT INTO channel_settings(project_id,wecom_encrypted,enabled,updated_by,updated_at) VALUES(?,?,?,?,?)').run(f.pid,encrypt(endpoint,f.rt.env.CONFIG_ENCRYPTION_KEY),1,f.owner.user.id,now());
  Object.assign(f.rt.env,{ALIYUN_ACCESS_KEY_ID:'synthetic-test-id',ALIYUN_ACCESS_KEY_SECRET:'synthetic-test-secret',ALIYUN_SMS_SIGN_NAME:'合成测试',ALIYUN_SMS_TEMPLATE_CODE:'SMS_000000'});
  f.rt.db.prepare('UPDATE users SET phone=?,sms_opt_in=1 WHERE id=?').run('13800138000',f.owner.user.id);
  for(const channel of ['wecom','sms']){
    const id=uid();f.rt.db.prepare('INSERT INTO outbox(id,project_id,user_id,channel,title,body,target,severity,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,f.pid,f.owner.user.id,channel,'监督异常提醒','合成测试','issues','critical',now());
    let calls=0;const fetcher=async(url,opts)=>{calls++;assert.equal(opts.redirect,'manual');return new Response(null,{status:307,headers:{location:'https://unrelated.example/receive'}});};
    await deliverOne(f.rt.env,id,fetcher);await deliverOne(f.rt.env,id,fetcher);
    const row=f.rt.db.prepare('SELECT status,error FROM outbox WHERE id=?').get(id);assert.equal(row.status,'failed');assert.match(row.error,/重定向/);assert.equal(calls,1);assert.ok(!row.error.includes('unrelated'));
  }
 }finally{await f.close();}
});
