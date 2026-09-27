// Offline restoration into an exclusively NEW directory. No network or production writes.
import {open,mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {backupKey,openBytes,safePart,validateSnapshot,validateManifestSnapshot,DATA_TABLES,MAX_SNAPSHOT_BYTES,MAX_FILE_BYTES} from '../src/backup-format.js';
import {sha,assert} from '../src/util.js';
import {verifyAudit} from '../src/store.js';
const q=name=>'"'+name.replaceAll('"','""')+'"';
const string=(b,start,n)=>b.subarray(start,start+n).toString().replace(/\0.*$/s,'');
async function tarIndex(file){
 const size=(await file.stat()).size;assert(size<=12*1024**3,'备份归档超过离线工具12GiB限制');let offset=0;const entries=new Map();
 while(offset+512<=size){const header=Buffer.alloc(512);assert((await file.read(header,0,512,offset)).bytesRead===512,'归档头不完整');if(header.every(b=>b===0))break;
  const supplied=parseInt(string(header,148,8).trim(),8);const temp=Buffer.from(header);temp.fill(32,148,156);assert(temp.reduce((a,b)=>a+b,0)===supplied,'归档头校验失败');
  const name=safePart(string(header,0,100));assert(string(header,345,155)===''&&['0',''].includes(string(header,156,1)),'禁止链接、目录或带前缀的归档部件');
  const n=parseInt(string(header,124,12).trim(),8);assert(Number.isSafeInteger(n)&&n>=0&&n<=MAX_SNAPSHOT_BYTES+1024,'归档部件尺寸无效');assert(!entries.has(name)&&offset+512+n<=size,'归档部件重复或被截断');entries.set(name,{offset:offset+512,size:n});assert(entries.size<=1003,'归档附件过多');offset+=512+Math.ceil(n/512)*512;
 }
 assert(entries.has('metadata.json')&&entries.has('manifest.bin')&&entries.has('snapshot.bin'),'归档不完整');return entries;
}
async function partBytes(file,entry){assert(entry,'缺少归档部件');const out=Buffer.alloc(entry.size);let n=0;while(n<out.length){const r=await file.read(out,n,out.length-n,entry.offset+n);assert(r.bytesRead>0,'归档被截断');n+=r.bytesRead;}return out;}
export async function restoreArchive({archive,output,env=process.env}){
 assert(archive&&output,'需要 --archive 和 --output');const source=path.resolve(archive),target=path.resolve(output);assert(source!==target,'输入和输出路径不能相同');
 const file=await open(source,'r');let created=false,db;
 try{
  const entries=await tarIndex(file),meta=JSON.parse((await partBytes(file,entries.get('metadata.json'))).toString());assert(meta.format==='hhyx-archive-v1'&&/^[a-f0-9-]{36}$/.test(meta.id),'归档元数据无效');
  const key=backupKey(env,meta.keyId).key;
  const manifest=JSON.parse(openBytes(await partBytes(file,entries.get('manifest.bin')),key,meta.id+':manifest.bin').toString());assert(manifest.format==='hhyx-backup-v1'&&manifest.id===meta.id&&manifest.keyId===meta.keyId&&Array.isArray(manifest.files)&&manifest.files.length<=1000,'归档清单无效');
  const parts=[manifest.snapshot,...manifest.files.map(f=>f.part)];assert(parts.length+2===entries.size&&new Set(parts.map(p=>safePart(p.name))).size===parts.length&&manifest.snapshot.name==='snapshot.bin','归档清单与文件不一致');
  const decryptPart=async part=>{const encrypted=await partBytes(file,entries.get(part.name));assert(sha(encrypted)===part.cipherSha256,'部件密文哈希失败');const plain=openBytes(encrypted,key,meta.id+':'+part.name);assert(plain.length===part.bytes&&sha(plain)===part.sha256,'部件内容哈希失败');return plain;};
  const snapshot=validateSnapshot(JSON.parse((await decryptPart(manifest.snapshot)).toString()));validateManifestSnapshot(manifest,snapshot);
  // Exclusive mkdir: never reuse, clear or overwrite a pre-existing directory.
  await mkdir(target,{mode:0o700});created=true;await mkdir(path.join(target,'files'),{mode:0o700});
  db=new DatabaseSync(path.join(target,'restored.sqlite'));db.exec('PRAGMA foreign_keys=ON');
  db.exec('BEGIN IMMEDIATE');try{
   for(const item of snapshot.schema)db.exec(item.sql);
   for(const table of DATA_TABLES)for(const row of snapshot.tables[table]){const cols=Object.keys(row);assert(cols.every(c=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(c)),'列名无效');db.prepare('INSERT INTO '+q(table)+'('+cols.map(q).join(',')+') VALUES('+cols.map(()=>'?').join(',')+')').run(...cols.map(c=>row[c]));}
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  const rowCounts={};for(const table of DATA_TABLES){const restored=db.prepare('SELECT * FROM '+q(table)+' ORDER BY rowid').all();assert(sha(restored)===sha(snapshot.tables[table]),'恢复表哈希不符：'+table);rowCounts[table]=restored.length;}
  assert(db.prepare('PRAGMA foreign_key_check').all().length===0,'恢复数据外键异常');
  for(const p of db.prepare('SELECT * FROM projects').all())assert(verifyAudit(db.prepare('SELECT * FROM audit WHERE project_id=? ORDER BY revision').all(p.id),JSON.parse(p.state),p.audit_head).valid,'恢复审计链异常');
  for(const r of db.prepare('SELECT * FROM ai_reports').all())assert(sha(JSON.parse(r.report))===r.report_hash,'AI报告哈希异常');
  const fileMap=[];for(let i=0;i<manifest.files.length;i++){const info=manifest.files[i],bytes=await decryptPart(info.part);assert(bytes.length<=MAX_FILE_BYTES&&sha(bytes)===info.sha256,'附件哈希异常');const local='files/'+String(i).padStart(6,'0')+'.bin';await writeFile(path.join(target,local),bytes,{mode:0o600,flag:'wx'});assert(sha(await readFile(path.join(target,local)))===info.sha256,'附件写回校验异常');fileMap.push({attachmentId:info.id,originalObjectKey:info.objectKey,local,sha256:info.sha256});}
  await writeFile(path.join(target,'attachment-map.json'),JSON.stringify(fileMap,null,2),{mode:0o600,flag:'wx'});
  const report={passed:true,sourceId:meta.id,capturedAt:snapshot.capturedAt,checkedAt:new Date().toISOString(),rowCounts,files:fileMap.length,networkUsed:false,productionWritten:false,notice:'独立离线数据恢复演练。没有启动网站或发送消息；恢复目录含敏感数据，部署Secrets不在归档内。请勿直接公开此目录或当成灾备切换成功。'};
  await writeFile(path.join(target,'restore-report.json'),JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});return report;
 }catch(error){if(created)await writeFile(path.join(target,'RESTORE_FAILED.txt'),'恢复未通过。保留本次隔离目录供核验，不可投入使用。\n',{mode:0o600}).catch(()=>{});throw error;}finally{db?.close();await file.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];
 try{assert(args.includes('--archive')&&args.includes('--output'),'用法：node scripts/restore-drill.mjs --archive 文件.hhyx.tar --output 尚不存在的新目录；从环境变量读取BACKUP_ENCRYPTION_KEY，不通过命令参数传密钥。');const r=await restoreArchive({archive:get('--archive'),output:get('--output')});console.log(JSON.stringify(r,null,2));}catch(error){console.error('离线恢复未通过：'+error.message);process.exitCode=1;}
}
