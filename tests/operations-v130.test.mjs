import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {fixture,PASSWORD} from './helpers.mjs';
import {base32,totp} from '../src/mfa.js';
import {one,rows} from '../src/store.js';
import {sha} from '../src/util.js';
import {memoryBucket,isolatedD1} from '../scripts/local-runtime.mjs';
import {requestBackup,processBackupJobs,readBackup,backupDownload,backupReady,scheduledBackups} from '../src/backups.js';
import {notifyView} from '../src/notification-config.js';

function backupBindings(f){Object.assign(f.rt.env,{BACKUPS:memoryBucket(),RESTORE_DB:isolatedD1(),RESTORE_FILES:memoryBucket(),BACKUP_ENCRYPTION_KEY:randomBytes(32).toString('base64'),FILES_BUCKET_NAME:'source-files',BACKUP_BUCKET_NAME:'backup-files',RESTORE_BUCKET_NAME:'drill-files'});}
const getProject=f=>f.owner.ok(f.base,undefined,'GET');
const vote=async(f,p,extra={})=>{for(const c of f.all)p=await f.action(c,'proposal.vote',{id:p.proposals.at(-1).id,decision:'approve',note:'已核对测试资料',...extra});return p;};

test('RFC6238 official SHA1 vectors',()=>{const secret=base32(Buffer.from('12345678901234567890'));for(const [time,expected] of [[59,'94287082'],[1111111109,'07081804'],[1111111111,'14050471'],[1234567890,'89005924'],[2000000000,'69279037'],[20000000000,'65353130']])assert.equal(totp(secret,time,8),expected);});
test('MFA: enrollment, partial login, replay rejection, single-use recovery and admin policy',async()=>{
 const f=await fixture({partners:2});try{
  const old=f.client();await old.ok('/api/auth/login',{email:'owner@example.test',password:PASSWORD});
  const start=await f.owner.ok('/api/auth/mfa/enroll',{});assert.match(start.secret,/^[A-Z2-7]+$/);
  const code=totp(start.secret),enabled=await f.owner.ok('/api/auth/mfa/confirm',{code});assert.equal(enabled.recoveryCodes.length,10);
  assert.equal((await old.request('/api/auth/me')).status,401);
  const stored=await one(f.rt.env,'SELECT * FROM mfa_credentials WHERE user_id=?',f.owner.user.id);assert.ok(!stored.secret_encrypted.includes(start.secret));
  assert.ok(!JSON.stringify(await rows(f.rt.env,'SELECT * FROM admin_audit')).includes(start.secret));
  const login=f.client(),r=await login.ok('/api/auth/login',{email:'owner@example.test',password:PASSWORD});assert.equal(r.user.mfaRequired,true);
  assert.equal((await login.request('/api/projects')).body.code,'MFA_REQUIRED');
  assert.equal((await login.request('/api/auth/password',{method:'POST',data:{password:'New-Synthetic-Password-123!'}})).body.code,'MFA_REQUIRED');
  assert.equal((await login.request('/api/auth/mfa/verify',{method:'POST',data:{code}})).status,403);
  const before=login.cookie;await login.ok('/api/auth/mfa/verify',{code:enabled.recoveryCodes[0]});assert.notEqual(login.cookie,before);assert.equal((await login.request('/api/projects')).status,200);
  const again=f.client();await again.ok('/api/auth/login',{email:'owner@example.test',password:PASSWORD});assert.equal((await again.request('/api/auth/mfa/verify',{method:'POST',data:{code:enabled.recoveryCodes[0]}})).status,403);await again.ok('/api/auth/mfa/verify',{code:enabled.recoveryCodes[1]});
  assert.equal((await again.ok('/api/auth/mfa/status',undefined,'GET')).recoveryCodesRemaining,8);
  await f.owner.reauth();await f.owner.ok('/api/admin/security/policy',{requireAdmins:true,reason:'测试管理员强制策略'});
  assert.equal((await f.owner.request('/api/auth/mfa/disable',{method:'POST',data:{}})).status,409);
 }finally{await f.close();}
});
test('MFA pending seed belongs to the initiating session; ordinary users cannot administer',async()=>{
 const f=await fixture({partners:2});try{const seed=await f.owner.ok('/api/auth/mfa/enroll',{}),other=f.client();await other.ok('/api/auth/login',{email:'owner@example.test',password:PASSWORD});await other.reauth();assert.equal((await other.request('/api/auth/mfa/confirm',{method:'POST',data:{code:totp(seed.secret)}})).status,409);assert.equal((await f.all[1].request('/api/admin/backups')).status,403);}finally{await f.close();}
});
test('backup encrypts real SQLite snapshot + attachments; restores in independent DB/bucket and verifies source unchanged',async()=>{
 const f=await fixture();try{backupBindings(f);
  const form=new FormData();form.set('file',new File(['SYNTHETIC-PRIVATE-INVOICE-DO-NOT-PUBLISH'],'invoice.txt',{type:'text/plain'}));
  const uploaded=await f.owner.request(f.base+'/files',{method:'POST',form});assert.equal(uploaded.status,201,JSON.stringify(uploaded.body));await f.rt.settle();
  const original=sha(await one(f.rt.env,'SELECT * FROM projects WHERE id=?',f.pid));
  const j=await requestBackup(f.rt.env,f.owner.user.id,{requestKey:'test-backup-once'});await processBackupJobs(f.rt.env,{steps:100});const done=await one(f.rt.env,'SELECT * FROM backup_jobs WHERE id=?',j.id);assert.equal(done.status,'completed',done.error);
  const allCipher=Buffer.concat([...f.rt.env.BACKUPS.objects.values()].map(x=>Buffer.from(x)));assert.ok(!allCipher.includes(Buffer.from('SYNTHETIC-PRIVATE-INVOICE')));
  const read=await readBackup(f.rt.env,done);assert.equal(read.snapshot.tables.projects.length,1);assert.equal(read.manifest.files.length,1);
  const d=await requestBackup(f.rt.env,f.owner.user.id,{kind:'drill',sourceId:j.id,requestKey:'test-drill-once'});await processBackupJobs(f.rt.env,{steps:200});const drill=await one(f.rt.env,'SELECT * FROM backup_jobs WHERE id=?',d.id);assert.equal(drill.status,'completed',drill.error);assert.equal(JSON.parse(drill.report).passed,true);
  assert.equal(sha(await one(f.rt.env,'SELECT * FROM projects WHERE id=?',f.pid)),original);assert.equal(f.rt.env.RESTORE_FILES.objects.size,1);
  const tar=Buffer.from(await (await backupDownload(f.rt.env,j.id)).arrayBuffer());assert.ok(tar.includes(Buffer.from('manifest.bin')));assert.ok(!tar.includes(Buffer.from('SYNTHETIC-PRIVATE-INVOICE')));
 }finally{await f.close();}
});
test('backup rejects same resource bindings and detects tampered ciphertext with visible failure alert',async()=>{
 const f=await fixture({partners:2});try{assert.throws(()=>backupReady(f.rt.env));backupBindings(f);const j=await requestBackup(f.rt.env,'test');await processBackupJobs(f.rt.env,{steps:30});const job=await one(f.rt.env,'SELECT * FROM backup_jobs WHERE id=?',j.id);assert.equal(job.status,'completed',job.error);
  const data=f.rt.env.BACKUPS.objects.get(job.manifest_key);data[20]^=1;
  const d=await requestBackup(f.rt.env,'test',{kind:'drill',sourceId:j.id});await processBackupJobs(f.rt.env,{steps:40});assert.equal((await one(f.rt.env,'SELECT status FROM backup_jobs WHERE id=?',d.id)).status,'failed');assert.ok((await rows(f.rt.env,'SELECT * FROM admin_alerts')).length);
  f.rt.env.RESTORE_DB=f.rt.env.DB;assert.throws(()=>backupReady(f.rt.env,true));
 }finally{await f.close();}
});
test('global notification secrets masked; project opt-in binds explicit revision; rotation suspends inheritance',async()=>{
 const f=await fixture({partners:2});try{const sent=[];f.rt.env.NOTIFY_TEST_FETCH=async(u,o)=>{sent.push({url:u,body:o.body});return Response.json({errcode:0});};
  const initial=await f.owner.ok('/api/admin/notification-settings',undefined,'GET');
  const input={expectedRevision:initial.revision,deliveryEnabled:true,wecomEnabled:true,wecomAudience:'虚构测试群，所有成员仅为测试账号',webhook:'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SYNTHETIC-NOT-REAL-KEY',smsEnabled:false,dailySmsLimit:20,adminAlertsEnabled:false,reason:'测试全站通知配置'};
  const saved=await f.owner.ok('/api/admin/notification-settings',input);assert.ok(!JSON.stringify(saved).includes('SYNTHETIC-NOT-REAL-KEY'));
  await f.owner.ok(f.base+'/channels',{mode:'global',confirmAudience:true,expectedGlobalRevision:saved.revision});await f.rt.settle();
  assert.equal((await f.owner.ok(f.base+'/channels',undefined,'GET')).mode,'global');
  await f.owner.ok('/api/admin/notification-settings',{...input,expectedRevision:saved.revision,webhook:'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SYNTHETIC-NEW-KEY'});await f.rt.settle();
  const view=await f.owner.ok(f.base+'/channels',undefined,'GET');assert.equal(view.globalReconfirmationRequired,true);
  const n=sent.length;await f.action(f.owner,'project.pause',{reason:'检查失效授权不外发'});await f.rt.settle();assert.equal(sent.length,n);
 }finally{await f.close();}
});
test('project ownership requires all original partners and target explicit acceptance',async()=>{
 const f=await fixture();try{let p=await getProject(f);const target=p.members[1];p=await f.action(f.owner,'proposal.submit',{kind:'ownership_transfer',reason:'测试交接',payload:{newOwnerMemberId:target.id,handover:'权限渠道与文件完成交接'}});const id=p.proposals.at(-1).id;
  await f.action(f.owner,'proposal.vote',{id,decision:'approve'});assert.equal((await f.all[1].request(f.base+'/actions',{method:'POST',data:{type:'proposal.vote',data:{id,decision:'approve'}}})).status,400);
  await f.action(f.all[1],'proposal.vote',{id,decision:'approve',acceptOwnership:true});p=await f.action(f.all[2],'proposal.vote',{id,decision:'approve'});assert.equal(p.ownerId,target.userId);assert.equal(p.originalCreatorId,f.owner.user.id);assert.equal(p.ownershipHistory.length,1);
 }finally{await f.close();}
});
test('exit settlement retains outgoing partner until actual payment, independent verification and final unanimous vote',async()=>{
 const f=await fixture();try{let p=await getProject(f);const leaving=p.members[2];p=await f.action(f.owner,'proposal.submit',{kind:'exit_plan',reason:'测试退出清算',payload:{memberId:leaving.id,shares:{[p.members[0].id]:5000,[p.members[1].id]:5000},capitalCents:10000,profitCents:0,reimburseCents:0,owedCents:0,handover:{tasks:[],purchases:[]},basis:'约定退款，库存与未结责任已核对',responsibilities:'清算不豁免已有合同义务',dueDate:'2027-01-01'}});p=await vote(f,p,{acceptExit:true});const plan=p.exits.at(-1);assert.equal(plan.status,'settling');assert.equal(p.members[2].active,true);assert.equal(p.finance.exitHoldCents,10000);
  assert.equal((await f.owner.request(f.base+'/actions',{method:'POST',data:{type:'purchase.save',data:f.purchaseData()}})).status,409);
  assert.equal((await f.owner.request(f.base+'/actions',{method:'POST',data:{type:'proposal.submit',data:{kind:'exit_finalize',reason:'不能提前退出',payload:{exitId:plan.id,confirmation:'已结清'}}}})).status,409);
  p=await f.action(f.owner,'exit.payment',{id:plan.id,amountCents:10000,evidence:'虚构退款流水',description:'约定清算实际支出'});const entry=p.ledger.at(-1);assert.equal(entry.kind,'exit_payment');
  assert.equal((await f.owner.request(f.base+'/actions',{method:'POST',data:{type:'ledger.verify',data:{id:entry.id,note:'本人不能自验'}}})).status,403);
  p=await f.action(f.all[1],'ledger.verify',{id:entry.id,note:'另一人核对'});
  p=await f.action(f.owner,'proposal.submit',{kind:'exit_finalize',reason:'实际收付完成并核对',payload:{exitId:plan.id,confirmation:'交接款项均已确认'}});const g=p.proposals.at(-1);for(const c of f.all)p=await f.action(c,'proposal.vote',{id:g.id,decision:'approve'});
  assert.equal(p.removedFromProject,true);p=await getProject(f);assert.equal(p.members[2].active,false);assert.equal(p.exits[0].status,'completed');assert.equal((await f.all[2].request(f.base)).status,403);
 }finally{await f.close();}
});

test('offline archive restores into new directory, rejects overwrite/wrong key, and has no network dependency',async()=>{
 const {restoreArchive}=await import('../scripts/restore-drill.mjs');const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
 const f=await fixture({partners:2}),dir=await mkdtemp(path.join(os.tmpdir(),'hhyx-offline-test-'));try{backupBindings(f);const b=await requestBackup(f.rt.env,'test');await processBackupJobs(f.rt.env,{steps:40});const archive=path.join(dir,'test.hhyx.tar');await writeFile(archive,Buffer.from(await (await backupDownload(f.rt.env,b.id)).arrayBuffer()));
  const output=path.join(dir,'isolated');const r=await restoreArchive({archive,output,env:f.rt.env});assert.equal(r.passed,true);assert.equal(r.productionWritten,false);assert.equal(JSON.parse(await readFile(path.join(output,'restore-report.json'),'utf8')).rowCounts.projects,1);
  await assert.rejects(restoreArchive({archive,output,env:f.rt.env}),/EEXIST/);
  await assert.rejects(restoreArchive({archive,output:path.join(dir,'wrong-key'),env:{BACKUP_ENCRYPTION_KEY:randomBytes(32).toString('base64')}}));
 }finally{await f.close();await rm(dir,{recursive:true,force:true});}
});
test('MFA recovery concurrent submissions are one-use; stale second factor cannot write admin configuration',async()=>{
 const f=await fixture({partners:2});try{const s=await f.owner.ok('/api/auth/mfa/enroll',{}),codes=(await f.owner.ok('/api/auth/mfa/confirm',{code:totp(s.secret)})).recoveryCodes;
  const a=f.client(),b=f.client();for(const c of [a,b])await c.ok('/api/auth/login',{email:'owner@example.test',password:PASSWORD});
  const results=await Promise.all([a,b].map(c=>c.request('/api/auth/mfa/verify',{method:'POST',data:{code:codes[0]}})));assert.deepEqual(results.map(r=>r.status).sort(),[200,403]);
  await f.rt.env.DB.prepare('UPDATE sessions SET mfa_at=0 WHERE user_id=?').bind(f.owner.user.id).run();
  const denied=await f.owner.request('/api/admin/security/policy',{method:'POST',data:{requireAdmins:false,reason:'expired'}});assert.equal(denied.body.code,'MFA_STEPUP_REQUIRED');
 }finally{await f.close();}
});
test('cleared global SMS secrets never resurrect from old deployment variables; quota is atomic',async()=>{
 const {validateNotifyConfig,resolveNotifyEnv,reserveSms,NOTIFY_CONFIG_KEY}=await import('../src/notification-config.js');const f=await fixture({partners:2});try{
  Object.assign(f.rt.env,{ALIYUN_ACCESS_KEY_ID:'synthetic-old-id',ALIYUN_ACCESS_KEY_SECRET:'synthetic-old-secret'});
  const base={expectedRevision:0,deliveryEnabled:false,wecomEnabled:false,smsEnabled:false,adminAlertsEnabled:false,dailySmsLimit:1,signName:'测试',templateCode:'SMS_1234',clearSms:true};
  const c=validateNotifyConfig(f.rt.env,base,null);await f.rt.env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?)').bind(NOTIFY_CONFIG_KEY,JSON.stringify(c)).run();
  const next=validateNotifyConfig(f.rt.env,{...base,expectedRevision:1,clearSms:false},c);assert.equal(next.smsIdEncrypted,null);assert.equal(next.smsSecretEncrypted,null);
  const resolved=await resolveNotifyEnv(f.rt.env);assert.equal(resolved.ALIYUN_ACCESS_KEY_ID,'');
  const outcomes=await Promise.all([reserveSms({...resolved,NOTIFY_DAILY_SMS_LIMIT:1},'test-1',f.owner.user.id),reserveSms({...resolved,NOTIFY_DAILY_SMS_LIMIT:1},'test-2',f.all[1].user.id)]);assert.equal(outcomes.filter(Boolean).length,1);
 }finally{await f.close();}
});
test('automatic backup is idempotent by UTC date and decrypts old backups after key rotation using explicit old-key ring',async()=>{
 const f=await fixture({partners:2});try{backupBindings(f);await f.rt.env.DB.prepare("INSERT INTO settings(key,value) VALUES('admin_backup_config',?)").bind(JSON.stringify({revision:1,enabled:true,utcHour:0,autoDrill:false})).run();await scheduledBackups(f.rt.env);await scheduledBackups(f.rt.env);const jobs=await rows(f.rt.env,"SELECT * FROM backup_jobs WHERE kind='backup'");assert.equal(jobs.length,1);assert.equal(jobs[0].status,'completed',jobs[0].error);
  const old=f.rt.env.BACKUP_ENCRYPTION_KEY;f.rt.env.BACKUP_ENCRYPTION_KEY=randomBytes(32).toString('base64');await assert.rejects(readBackup(f.rt.env,jobs[0]));f.rt.env.BACKUP_OLD_KEYS_JSON=JSON.stringify({[jobs[0].key_id]:old});assert.equal((await readBackup(f.rt.env,jobs[0])).snapshot.tables.projects.length,1);
 }finally{await f.close();}
});
test('a second wrapper to the production database is rejected by restore sandbox inspection',async()=>{
 const {LocalD1}=await import('../scripts/local-runtime.mjs');const f=await fixture({partners:2});try{backupBindings(f);const b=await requestBackup(f.rt.env,'test');await processBackupJobs(f.rt.env,{steps:40});f.rt.env.RESTORE_DB=new LocalD1(f.rt.db);const d=await requestBackup(f.rt.env,'test',{kind:'drill',sourceId:b.id});await processBackupJobs(f.rt.env,{steps:40});assert.equal((await one(f.rt.env,'SELECT status FROM backup_jobs WHERE id=?',d.id)).status,'failed');assert.equal(await one(f.rt.env,"SELECT name FROM sqlite_master WHERE name='hhyx_restore_guard'"),null);
 }finally{await f.close();}
});
test('exit plan rejects stale finance, stages all handover and retains money/decisions for shared responsibility',async()=>{
 const f=await fixture();try{let p=await getProject(f),m=p.members[2];p=await f.action(f.owner,'proposal.submit',{kind:'exit_plan',reason:'测试需重新核对',payload:{memberId:m.id,capitalCents:0,profitCents:0,reimburseCents:0,owedCents:5000,shares:{[p.members[0].id]:5000,[p.members[1].id]:5000},handover:{tasks:[],purchases:[]},basis:'应补缴测试款项',responsibilities:'不得据此自动免责',dueDate:'2027-01-01'}});const id=p.proposals.at(-1).id;
  await f.action(f.owner,'proposal.vote',{id,decision:'approve'});await f.action(f.all[1],'proposal.vote',{id,decision:'approve'});
  p=await f.action(f.owner,'ledger.add',{kind:'revenue',amountCents:1000,description:'期间发生真实业务',evidence:'测试'});await f.action(f.all[1],'ledger.verify',{id:p.ledger.at(-1).id,note:'核对'});
  assert.equal((await f.all[2].request(f.base+'/actions',{method:'POST',data:{type:'proposal.vote',data:{id,decision:'approve',acceptExit:true}}})).status,409);
  assert.ok(!(await getProject(f)).exits?.length);
 }finally{await f.close();}
});

test('deployment binding checker rejects shared resource declarations and permits disabled optional features',async()=>{
 const {verifyOperationsBindings}=await import('../scripts/verify-operations-bindings.mjs');assert.equal(verifyOperationsBindings({}),true);
 const c={r2_buckets:[{binding:'FILES',bucket_name:'files'},{binding:'BACKUPS',bucket_name:'backups'},{binding:'RESTORE_FILES',bucket_name:'drill'}],d1_databases:[{binding:'DB',database_id:'prod-id'},{binding:'RESTORE_DB',database_id:'drill-id'}],vars:{FILES_BUCKET_NAME:'files',BACKUP_BUCKET_NAME:'backups',RESTORE_BUCKET_NAME:'drill'}};
 assert.equal(verifyOperationsBindings(c),true);
 for(const change of [x=>x.r2_buckets[1].bucket_name='files',x=>x.r2_buckets[2].bucket_name='backups',x=>x.d1_databases[1].database_id='prod-id',x=>x.vars.RESTORE_BUCKET_NAME='wrong']){const copy=structuredClone(c);change(copy);assert.throws(()=>verifyOperationsBindings(copy));}
});
test('backup status warns without recent success and root key reuse is rejected',async()=>{
 const {backupStatus}=await import('../src/backups.js');const f=await fixture({partners:2});try{backupBindings(f);await f.rt.env.DB.prepare("INSERT INTO settings(key,value) VALUES('admin_backup_config',?)").bind(JSON.stringify({revision:1,enabled:true,utcHour:0,autoDrill:false})).run();
 assert.equal((await backupStatus(f.rt.env)).stale,true);await requestBackup(f.rt.env,'test');await processBackupJobs(f.rt.env,{steps:40});assert.equal((await backupStatus(f.rt.env)).stale,false);
 await f.rt.env.DB.prepare("UPDATE backup_jobs SET created_at='2000-01-01T00:00:00Z'").run();assert.equal((await backupStatus(f.rt.env)).stale,true);
 f.rt.env.BACKUP_ENCRYPTION_KEY=f.rt.env.CONFIG_ENCRYPTION_KEY;assert.throws(()=>backupReady(f.rt.env),/必须独立/);
 }finally{await f.close();}
});
test('authenticated archive manifest must cover every registered attachment with matching metadata',async()=>{
 const {validateManifestSnapshot}=await import('../src/backup-format.js');const a={id:'file1',object_key:'private/example',size:3,sha256:'digest'},s={tables:{attachments:[a]}};
 const m={snapshot:{name:'snapshot.bin'},files:[{id:a.id,objectKey:a.object_key,bytes:a.size,sha256:a.sha256,part:{name:'files/000000.bin',bytes:a.size,sha256:a.sha256}}]};assert.equal(validateManifestSnapshot(m,s),true);
 for(const edit of [x=>x.files=[],x=>x.files[0].objectKey='wrong',x=>x.files[0].part.sha256='wrong',x=>x.files[0].part.name='files/000001.bin']){const copy=structuredClone(m);edit(copy);assert.throws(()=>validateManifestSnapshot(copy,s));}
});
