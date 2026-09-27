import {Buffer} from 'node:buffer';
import {assert,now,sha,uid,AppError} from './util.js';
import {one,rows,verifyAudit} from './store.js';
import {adminAlert} from './notification-config.js';
import {DATA_TABLES,SCHEMA_TABLES,MAX_ROWS,MAX_SNAPSHOT_BYTES,MAX_FILE_BYTES,backupKey,sealBytes,openBytes,objectBytes,validateSnapshot,validateManifestSnapshot,renameSchema,tarFiles} from './backup-format.js';
export const BACKUP_CONFIG_KEY='admin_backup_config';
const epoch=()=>Math.floor(Date.now()/1000);
const quote=s=>'"'+s.replaceAll('"','""')+'"';
export const backupConfig=async env=>JSON.parse((await one(env,'SELECT value FROM settings WHERE key=?',BACKUP_CONFIG_KEY))?.value||'{"revision":0,"enabled":false,"utcHour":3,"autoDrill":false}');
export function backupReady(env,drill=false){
 const k=backupKey(env);assert(!env.CONFIG_ENCRYPTION_KEY||!k.key.equals(Buffer.from(env.CONFIG_ENCRYPTION_KEY,'base64')),'备份加密密钥必须独立于CONFIG_ENCRYPTION_KEY',503);assert(env.BACKUPS&&env.FILES&&env.BACKUPS!==env.FILES,'需独立绑定私有BACKUPS存储桶，不能复用业务FILES',503);
 assert(env.BACKUP_BUCKET_NAME&&env.FILES_BUCKET_NAME&&env.BACKUP_BUCKET_NAME!==env.FILES_BUCKET_NAME,'需填写并核对不同的BACKUP_BUCKET_NAME和FILES_BUCKET_NAME',503);
 if(drill){assert(env.RESTORE_DB&&env.RESTORE_DB!==env.DB,'恢复演练需独立RESTORE_DB，不能绑定生产DB',503);assert(env.RESTORE_FILES&&env.RESTORE_FILES!==env.FILES&&env.RESTORE_FILES!==env.BACKUPS,'恢复演练需独立RESTORE_FILES',503);assert(env.RESTORE_BUCKET_NAME&&![env.FILES_BUCKET_NAME,env.BACKUP_BUCKET_NAME].includes(env.RESTORE_BUCKET_NAME),'请核对演练、备份和业务使用三个不同存储桶',503);}
 return k;
}
export async function backupStatus(env){
 let ready=true,drillReady=true,error='',drillError='',keyId='';try{keyId=backupReady(env).id;}catch(e){ready=false;error=e.message;}try{backupReady(env,true);}catch(e){drillReady=false;drillError=e.message;}
 const jobs=await rows(env,'SELECT id,kind,source_id,status,phase,key_id,created_at,updated_at,finished_at,error,report FROM backup_jobs ORDER BY created_at DESC LIMIT 50');
 const config=await backupConfig(env),latest=await one(env,"SELECT created_at FROM backup_jobs WHERE kind='backup' AND status='completed' ORDER BY created_at DESC LIMIT 1");
 return {config,lastSuccessfulAt:latest?.created_at||null,stale:config.enabled&&(!latest||Date.now()-Date.parse(latest.created_at)>36*3600000),ready,drillReady,error,drillError,keyId,jobs:jobs.map(j=>({...j,report:j.report?JSON.parse(j.report):null})),limits:{snapshotBytes:MAX_SNAPSHOT_BYTES,rowsPerTable:MAX_ROWS,files:1000,fileBytes:MAX_FILE_BYTES},notice:'自动任务受Cron实际执行和平台配额影响。没有成功记录不代表已有备份；归档项目也包含在备份中。历史备份/演练不自动删除。'};
}
export async function requestBackup(env,actorId,{kind='backup',sourceId=null,requestKey=uid()}={}){
 const key=backupReady(env,kind==='drill');assert(['backup','drill'].includes(kind),'备份任务类型无效');
 let source=null;if(kind==='drill'){source=await one(env,"SELECT * FROM backup_jobs WHERE id=? AND kind='backup' AND status='completed'",sourceId);assert(source,'需选择已完成的备份',409);backupKey(env,source.key_id);}
 const id=uid(),at=now();
 // One task at a time, with an atomic claim, prevents overlapping captures/restores.
 const b=await env.DB.prepare("INSERT OR IGNORE INTO backup_jobs(id,kind,source_id,status,actor_id,phase,state,key_id,created_at,updated_at,request_key) SELECT ?,?,?,'queued',?,?,'{}',?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM backup_jobs WHERE status IN ('queued','running'))").bind(id,kind,sourceId,actorId,kind==='backup'?'snapshot':'prepare',source?.key_id||key.id,at,at,requestKey).run();
 if(!b.meta.changes){const previous=await one(env,'SELECT id,status FROM backup_jobs WHERE request_key=?',requestKey);assert(previous,'已有备份/演练排队或执行中，请先查看结果',409);return {...previous,idempotent:true};}return {id,status:'queued'};
}
function snapshotSchemaQuery(){return "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index','trigger') AND tbl_name IN ("+SCHEMA_TABLES.map(n=>"'"+n+"'").join(',')+") ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,rowid";}
export async function captureSnapshot(env){
 const schema=await rows(env,snapshotSchemaQuery());
 const columns=Object.fromEntries(await Promise.all(DATA_TABLES.map(async n=>[n,(await rows(env,'PRAGMA table_info('+quote(n)+')')).map(c=>c.name)])));
 // Every SELECT has the same in-transaction byte guard: an over-limit DB is not
 // materialised in memory even if it grew between the preflight and the batch.
 const byteExpr=DATA_TABLES.map(n=>'(SELECT coalesce(sum('+columns[n].map(c=>'coalesce(length(cast('+quote(c)+' AS BLOB)),0)').join('+')+'),0) FROM '+quote(n)+')').join('+');
 const condition='('+byteExpr+')<='+MAX_SNAPSHOT_BYTES;
 const b=await env.DB.batch([env.DB.prepare(snapshotSchemaQuery()),env.DB.prepare('SELECT ('+byteExpr+') AS bytes'),...DATA_TABLES.map(n=>env.DB.prepare('SELECT * FROM '+quote(n)+' WHERE '+condition+' ORDER BY rowid LIMIT '+(MAX_ROWS+1)))]);
 assert(b[1].results[0].bytes<=MAX_SNAPSHOT_BYTES,'数据库内容超过16MiB备份容量，请改用运维D1导出，不会生成截断备份',413);
 assert(sha(b[0].results)===sha(schema),'捕获期间数据库结构变化，请部署稳定后重试',409);
 const tables=Object.fromEntries(DATA_TABLES.map((n,i)=>[n,b[i+2].results]));for(const n of DATA_TABLES)assert(tables[n].length<=MAX_ROWS,'表 '+n+' 超过单次10000行容量，未生成部分备份',413);
 const s={format:'hhyx-data-v1',schemaVersion:4,capturedAt:now(),schema,tables,omitted:['sessions','rate_limits','backup_jobs'],note:'会话、临时限流和运行中备份任务不恢复；部署Secrets与外部服务账号须另外安全保管。'};
 validateSnapshot(s);const bytes=Buffer.from(JSON.stringify(s));assert(bytes.length<=MAX_SNAPSHOT_BYTES,'序列化备份超过16MiB容量，未生成截断备份',413);return {snapshot:s,bytes};
}
async function putPart(env,job,name,plain){const key=backupKey(env,job.key_id).key,cipher=sealBytes(plain,key,`${job.id}:${name}`),objectKey=`v1/${job.id}/${name}`;await env.BACKUPS.put(objectKey,cipher,{httpMetadata:{contentType:'application/octet-stream'}});return {name,objectKey,bytes:plain.length,cipherBytes:cipher.length,sha256:sha(plain),cipherSha256:sha(cipher)};}
async function readPart(env,job,part){const encrypted=await objectBytes(env.BACKUPS,part.objectKey,Math.max(MAX_FILE_BYTES,MAX_SNAPSHOT_BYTES)+1024);assert(sha(encrypted)===part.cipherSha256,'密文哈希不匹配',409);const plain=openBytes(encrypted,backupKey(env,job.key_id).key,`${job.id}:${part.name}`);assert(plain.length===part.bytes&&sha(plain)===part.sha256,'备份内容哈希不匹配',409);return plain;}
export async function readBackup(env,job){
 assert(job.manifest_key===`v1/${job.id}/manifest.bin`,'备份清单位置无效',409);const sealed=await objectBytes(env.BACKUPS,job.manifest_key,1024*1024);const m=JSON.parse(openBytes(sealed,backupKey(env,job.key_id).key,`${job.id}:manifest.bin`).toString());
 assert(m.format==='hhyx-backup-v1'&&m.id===job.id&&m.keyId===job.key_id&&m.files.length<=1000,'备份清单无效',409);
 const parts=[m.snapshot,...m.files.map(x=>x.part)];assert(parts.every(p=>p.objectKey===`v1/${job.id}/${p.name}`)&&new Set(parts.map(p=>p.name)).size===parts.length,'备份部件引用无效',409);
 const snapshot=validateSnapshot(JSON.parse((await readPart(env,job,m.snapshot)).toString()));validateManifestSnapshot(m,snapshot);return {manifest:m,snapshot};
}
async function guardSandbox(env){
 backupReady(env,true);const db=env.RESTORE_DB;
 const known=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results.map(x=>x.name);
 assert(!known.some(n=>!n.startsWith('sqlite_')&&!['d1_migrations','_cf_KV','hhyx_restore_guard'].includes(n)&&!/^r_[a-f0-9]{32}_/.test(n)),'演练库发现生产表名，拒绝写入；请提供专用空D1',409,'RESTORE_NOT_ISOLATED');
 await db.prepare("CREATE TABLE IF NOT EXISTS hhyx_restore_guard(id TEXT PRIMARY KEY, purpose TEXT NOT NULL)").run();
 await db.prepare("INSERT OR IGNORE INTO hhyx_restore_guard(id,purpose) VALUES('only','isolated-recovery-drill-v1')").run();
 const guard=await db.prepare("SELECT purpose FROM hhyx_restore_guard WHERE id='only'").first();assert(guard?.purpose==='isolated-recovery-drill-v1','演练库隔离标记无效',409);return db;
}
async function update(env,job,lease,phase,state,extra={}){
 const result=await env.DB.prepare('UPDATE backup_jobs SET status=?,phase=?,state=?,updated_at=?,lease_until=0,lease_token=NULL,finished_at=?,manifest_key=coalesce(?,manifest_key),report=? WHERE id=? AND lease_token=?').bind(extra.completed?'completed':'queued',phase,JSON.stringify(state),now(),extra.completed?now():null,extra.manifestKey||null,extra.report?JSON.stringify(extra.report):null,job.id,lease).run();assert(result.meta.changes===1,'任务租约已变化',409);
}
async function backupStep(env,job,lease){
 const state=JSON.parse(job.state),k=backupKey(env,job.key_id);
 if(job.phase==='snapshot'){
  const {snapshot,bytes}=await captureSnapshot(env);assert(snapshot.tables.attachments.length<=1000,'附件超过本版1000份容量',413);const part=await putPart(env,job,'snapshot.bin',bytes);
  await update(env,job,lease,'files',{snapshot:part,capturedAt:snapshot.capturedAt,files:[],next:0,attachments:snapshot.tables.attachments.map(f=>({id:f.id,objectKey:f.object_key,bytes:f.size,sha256:f.sha256})),rowCounts:Object.fromEntries(DATA_TABLES.map(n=>[n,snapshot.tables[n].length]))});return;
 }
 if(job.phase==='files'&&state.next<state.attachments.length){
  const file=state.attachments[state.next],plain=await objectBytes(env.FILES,file.objectKey,MAX_FILE_BYTES);
  assert(plain.length===file.bytes&&sha(plain)===file.sha256,'业务附件与数据库登记的尺寸/哈希不符，停止备份',409);
  const name=`files/${String(state.next).padStart(6,'0')}.bin`,part=await putPart(env,job,name,plain);state.files.push({...file,part});state.next++;
  await update(env,job,lease,'files',state);return;
 }
 const manifest={format:'hhyx-backup-v1',id:job.id,keyId:k.id,capturedAt:state.capturedAt,snapshot:state.snapshot,files:state.files};
 const manifestKey=`v1/${job.id}/manifest.bin`;await env.BACKUPS.put(manifestKey,sealBytes(Buffer.from(JSON.stringify(manifest)),k.key,`${job.id}:manifest.bin`));
 await update(env,job,lease,'complete',state,{completed:true,manifestKey,report:{capturedAt:state.capturedAt,rows:state.rowCounts,files:state.files.length,encrypted:true,consistentDatabaseBatch:true,notice:'备份完成不等于演练通过；环境Secrets请单独保管。'}});
 const config=await backupConfig(env);if(config.autoDrill){try{await requestBackup(env,'system:backup',{kind:'drill',sourceId:job.id,requestKey:'auto-drill:'+job.id});}catch(e){await adminAlert(env,'auto-drill:'+job.id,'自动恢复演练未启动',{backupId:job.id,error:e instanceof AppError?e.message:'无法排队'});}}
}
async function drillStep(env,job,lease){
 const original=await one(env,"SELECT * FROM backup_jobs WHERE id=? AND status='completed' AND kind='backup'",job.source_id);assert(original,'原备份不可用',409);
 const {manifest,snapshot}=await readBackup(env,original),db=await guardSandbox(env),state=JSON.parse(job.state),prefix='r_'+job.id.replaceAll('-','')+'_';
 const names=new Set(snapshot.schema.map(s=>s.name));
 if(job.phase==='prepare'){
  // All identifiers are namespaced; repeated attempts can only affect this drill.
  for(const item of snapshot.schema){const exists=await db.prepare('SELECT name FROM sqlite_master WHERE name=?').bind(prefix+item.name).first();if(!exists)await db.prepare(renameSchema(item.sql,names,prefix)).run();}
  await update(env,job,lease,'rows',{table:0,offset:0,file:0,prefix});return;
 }
 if(job.phase==='rows'&&state.table<DATA_TABLES.length){
  const table=DATA_TABLES[state.table],list=snapshot.tables[table],chunk=list.slice(state.offset,state.offset+25);
  if(chunk.length){const cols=Object.keys(chunk[0]);assert(cols.every(c=>/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c)),'列名无效');await db.batch(chunk.map(r=>db.prepare('INSERT OR IGNORE INTO '+quote(prefix+table)+'('+cols.map(quote).join(',')+') VALUES('+cols.map(()=>'?').join(',')+')').bind(...cols.map(c=>r[c]))));}
  state.offset+=chunk.length;if(state.offset>=list.length){state.table++;state.offset=0;}
  await update(env,job,lease,state.table<DATA_TABLES.length?'rows':'files',state);return;
 }
 if(job.phase==='files'&&state.file<manifest.files.length){
  const file=manifest.files[state.file],plain=await readPart(env,original,file.part),target=`drills/${job.id}/${file.part.name}`;
  await env.RESTORE_FILES.put(target,plain);assert(sha(await objectBytes(env.RESTORE_FILES,target,MAX_FILE_BYTES))===file.sha256,'演练文件写回校验不一致',409);
  state.file++;await update(env,job,lease,'files',state);return;
 }
 const counts={};for(const table of DATA_TABLES){const actual=(await db.prepare('SELECT * FROM '+quote(prefix+table)+' ORDER BY rowid').all()).results;assert(sha(actual)===sha(snapshot.tables[table]),'恢复后的表数据哈希不一致：'+table,409);counts[table]=actual.length;const fk=(await db.prepare('PRAGMA foreign_key_check('+quote(prefix+table)+')').all()).results;assert(!fk.length,'恢复后的外键不一致：'+table,409);}
 // Audit checks run on data read from the restored database, not merely the input.
 const projectRows=(await db.prepare('SELECT * FROM '+quote(prefix+'projects')).all()).results;
 for(const p of projectRows){const a=(await db.prepare('SELECT * FROM '+quote(prefix+'audit')+' WHERE project_id=? ORDER BY revision').bind(p.id).all()).results;assert(verifyAudit(a,JSON.parse(p.state),p.audit_head).valid,'恢复项目审计链校验失败',409);}
 for(const r of (await db.prepare('SELECT * FROM '+quote(prefix+'ai_reports')).all()).results)assert(sha(JSON.parse(r.report))===r.report_hash,'恢复后的AI报告哈希不匹配',409);
 const report={passed:true,sourceId:original.id,prefix,rowCounts:counts,files:manifest.files.length,checks:['解密认证','全部业务表写入独立D1并逐表哈希比对','外键一致性','项目审计链','AI报告哈希','附件解密、写入独立R2、重新读取哈希'],productionWritten:false,notice:'这是数据恢复演练；不启动生产站点、不发送通知、不调用AI，不能代替完整灾备切换和域名验收。演练库/桶仍含敏感数据，请保持私有。'};
 await update(env,job,lease,'complete',state,{completed:true,report});
}
export async function processBackupJobs(env,{steps=4}={}){
 for(let n=0;n<steps;n++){
  const nowEpoch=epoch();await env.DB.prepare("UPDATE backup_jobs SET status='queued',lease_token=NULL WHERE status='running' AND lease_until<?").bind(nowEpoch).run();
  const job=await one(env,"SELECT * FROM backup_jobs WHERE status='queued' ORDER BY created_at LIMIT 1");if(!job)return;
  const lease=uid(),claim=await env.DB.prepare("UPDATE backup_jobs SET status='running',lease_token=?,lease_until=?,updated_at=? WHERE id=? AND status='queued'").bind(lease,nowEpoch+120,now(),job.id).run();if(!claim.meta.changes)continue;
  try{backupReady(env,job.kind==='drill');if(job.kind==='backup')await backupStep(env,job,lease);else await drillStep(env,job,lease);}
  catch(e){const error=e instanceof AppError?e.message:'备份/演练失败，请检查绑定、配额、日志及密钥（未记录明文）';await env.DB.prepare("UPDATE backup_jobs SET status='failed',error=?,finished_at=?,updated_at=?,lease_until=0 WHERE id=? AND lease_token=?").bind(error,now(),now(),job.id,lease).run();await adminAlert(env,'backup:'+job.id,job.kind==='backup'?'自动备份未完成':'恢复演练未通过',{jobId:job.id,error});}
 }
}
export async function scheduledBackups(env){
 const c=await backupConfig(env);if(c.enabled){const d=new Date(),day=d.toISOString().slice(0,10);if(d.getUTCHours()>=c.utcHour){try{await requestBackup(env,'system:cron',{requestKey:'daily:'+day});}catch(e){if(!(e instanceof AppError&&e.status===409))await adminAlert(env,'backup-schedule:'+day,'计划备份未能启动',{error:e instanceof AppError?e.message:'调度错误'});}}}
 await processBackupJobs(env,{steps:8});
 const newest=await one(env,"SELECT created_at FROM backup_jobs WHERE kind='backup' AND status='completed' ORDER BY created_at DESC LIMIT 1");
 if(c.enabled&&(!newest||Date.now()-Date.parse(newest.created_at)>36*3600000))await adminAlert(env,'backup-stale:'+now().slice(0,10),'超过36小时没有成功备份',{lastSuccessAt:newest?.created_at||null});
}
export async function backupDownload(env,id){
 const job=await one(env,"SELECT * FROM backup_jobs WHERE id=? AND kind='backup' AND status='completed'",id);assert(job,'备份尚未完成',404);
 const {manifest}=await readBackup(env,job),metadata=Buffer.from(JSON.stringify({format:'hhyx-archive-v1',id:job.id,keyId:job.key_id}));
 async function* parts(){yield {name:'metadata.json',bytes:metadata};yield {name:'manifest.bin',bytes:await objectBytes(env.BACKUPS,job.manifest_key,1024*1024)};for(const part of [manifest.snapshot,...manifest.files.map(x=>x.part)]){const bytes=await objectBytes(env.BACKUPS,part.objectKey,MAX_SNAPSHOT_BYTES+1024);assert(sha(bytes)===part.cipherSha256,'密文哈希不一致');yield {name:part.name,bytes};}}
 const iter=tarFiles(parts());return new Response(new ReadableStream({async pull(controller){try{const r=await iter.next();r.done?controller.close():controller.enqueue(r.value);}catch(e){controller.error(e);}},async cancel(){await iter.return?.();}}),{headers:{'Content-Type':'application/x-tar','Content-Disposition':`attachment; filename="hhyx-backup-${id}.hhyx.tar"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
