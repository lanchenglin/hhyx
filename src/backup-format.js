import {Buffer} from 'node:buffer';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {assert,sha} from './util.js';
export const BACKUP_VERSION=1;
export const DATA_TABLES=['users','settings','projects','project_access','operations','audit','invites','attachments','notifications','channel_settings','outbox','reminder_keys','ai_jobs','ai_reports','admin_audit','admin_operations','mfa_credentials','mfa_recovery_codes','sms_dispatches','admin_alerts'];
export const SCHEMA_TABLES=[...DATA_TABLES,'sessions','rate_limits','backup_jobs'];
export const MAX_SNAPSHOT_BYTES=16*1024*1024;
export const MAX_ROWS=10000;
export const MAX_FILE_BYTES=10*1024*1024;
export function backupKey(env,id=null){
 const current=Buffer.from(env.BACKUP_ENCRYPTION_KEY||'','base64');assert(current.length===32,'需单独配置32字节 BACKUP_ENCRYPTION_KEY',503,'BACKUP_NOT_CONFIGURED');
 const currentId=sha(current).slice(0,24);if(!id||id===currentId)return {id:currentId,key:current};
 let old;try{old=JSON.parse(env.BACKUP_OLD_KEYS_JSON||'{}')[id];}catch{}
 const k=Buffer.from(old||'','base64');assert(k.length===32&&sha(k).slice(0,24)===id,'缺少该备份对应的旧加密密钥，请从离线保管处恢复',409,'BACKUP_KEY_MISSING');return {id,key:k};
}
export function sealBytes(plain,key,aad){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(aad));return Buffer.concat([Buffer.from('HXB1'),iv,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);}
export function openBytes(data,key,aad){data=Buffer.from(data);assert(data.length>=32&&data.subarray(0,4).toString()==='HXB1','备份格式不正确');try{const d=createDecipheriv('aes-256-gcm',key,data.subarray(4,16));d.setAAD(Buffer.from(aad));d.setAuthTag(data.subarray(-16));return Buffer.concat([d.update(data.subarray(16,-16)),d.final()]);}catch{assert(false,'备份解密或完整性校验失败',409,'BACKUP_INTEGRITY');}}
export function safePart(name){assert(typeof name==='string'&&/^(metadata\.json|manifest\.bin|snapshot\.bin|files\/\d{6}\.bin)$/.test(name),'备份文件路径不正确');return name;}
export async function objectBytes(bucket,key,max=MAX_FILE_BYTES+1024){const obj=await bucket.get(key);assert(obj,'备份或附件对象缺失',409,'BACKUP_MISSING_OBJECT');if(obj.size!=null)assert(obj.size<=max,'备份对象超过本版容量',413);const bytes=Buffer.from(obj.arrayBuffer?await obj.arrayBuffer():await new Response(obj.body).arrayBuffer());assert(bytes.length<=max,'备份对象超过本版容量',413);return bytes;}
export function renameSchema(sql,names,prefix){
 assert(/^[a-z0-9_]*$/.test(prefix),'演练命名空间无效');
 // Rewrite identifiers but not string literals (e.g. CHECK values or trigger errors).
 return sql.split(/('(?:[^']|'')*')/g).map((part,i)=>i%2?part:part.replace(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g,x=>names.has(x)?prefix+x:x)).join('');
}
export function validateSnapshot(s){
 assert(s?.format==='hhyx-data-v1'&&Array.isArray(s.schema)&&s.tables&&s.schemaVersion===4,'备份数据库版本不兼容');
 assert(Object.keys(s.tables).length===DATA_TABLES.length&&DATA_TABLES.every(n=>Array.isArray(s.tables[n])&&s.tables[n].length<=MAX_ROWS),'备份表数据不完整或超限');
 assert(s.schema.every(o=>['table','index','trigger'].includes(o.type)&&SCHEMA_TABLES.includes(o.tbl_name)&&/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(o.name)&&typeof o.sql==='string'&&/^CREATE\s/i.test(o.sql)),'备份数据库结构无效');
 assert(SCHEMA_TABLES.every(n=>s.schema.some(o=>o.type==='table'&&o.name===n)),'备份数据库缺少表结构');return s;
}
export function tarHeader(name,size){safePart(name);const b=Buffer.alloc(512);b.write(name,0,100,'utf8');const oct=(n,len)=>n.toString(8).padStart(len-1,'0')+'\0';b.write(oct(0o600,8),100);b.write(oct(0,8),108);b.write(oct(0,8),116);b.write(oct(size,12),124);b.write(oct(0,12),136);b.fill(32,148,156);b[156]=48;b.write('ustar\0',257);b.write('00',263);b.write(oct([...b].reduce((a,x)=>a+x,0),7)+' ',148);return b;}
export async function* tarFiles(files){for await(const f of files){yield tarHeader(f.name,f.bytes.length);yield f.bytes;const pad=(512-f.bytes.length%512)%512;if(pad)yield Buffer.alloc(pad);}yield Buffer.alloc(1024);}

export function validateManifestSnapshot(m,s){
 assert(m.snapshot?.name==='snapshot.bin'&&Array.isArray(m.files)&&m.files.length===s.tables.attachments.length,'附件清单与数据库不完整');
 const ids=new Set();for(let i=0;i<m.files.length;i++){const f=m.files[i],a=s.tables.attachments.find(a=>a.id===f.id);assert(!ids.has(f.id)&&a&&f.objectKey===a.object_key&&f.bytes===a.size&&f.sha256===a.sha256&&f.part.name===`files/${String(i).padStart(6,'0')}.bin`&&f.part.sha256===a.sha256&&f.part.bytes===a.size,'附件清单与数据库登记不一致');ids.add(f.id);}
 return true;
}
