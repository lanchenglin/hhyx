// Validate declared optional resources before deploying. Runtime checks remain in place.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
export function verifyOperationsBindings(c){
 const buckets=new Map((c.r2_buckets||[]).map(x=>[x.binding,x.bucket_name]));const databases=new Map((c.d1_databases||[]).map(x=>[x.binding,x.database_id]));const vars=c.vars||{};
 const require=(ok,message)=>{if(!ok)throw Error(message);};
 if(buckets.has('BACKUPS')){
  require(buckets.get('FILES')&&buckets.get('BACKUPS')&&buckets.get('FILES')!==buckets.get('BACKUPS'),'BACKUPS必须使用不同于FILES的实际bucket_name');
  require(vars.FILES_BUCKET_NAME===buckets.get('FILES')&&vars.BACKUP_BUCKET_NAME===buckets.get('BACKUPS'),'备份资源声明必须匹配FILES_BUCKET_NAME/BACKUP_BUCKET_NAME');
 }
 if(buckets.has('RESTORE_FILES')||databases.has('RESTORE_DB')){
  require(buckets.has('BACKUPS')&&buckets.has('RESTORE_FILES')&&databases.has('RESTORE_DB'),'启用演练时须同时声明BACKUPS、RESTORE_DB、RESTORE_FILES');
  require(databases.get('RESTORE_DB')&&databases.get('RESTORE_DB')!==databases.get('DB'),'RESTORE_DB必须使用不同于DB的真实database_id');
  require(![buckets.get('FILES'),buckets.get('BACKUPS')].includes(buckets.get('RESTORE_FILES')),'RESTORE_FILES必须使用第三个独立bucket_name');
  require(vars.RESTORE_BUCKET_NAME===buckets.get('RESTORE_FILES'),'RESTORE_BUCKET_NAME必须匹配演练桶实际名称');
 }
 return true;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 verifyOperationsBindings(JSON.parse(await readFile(process.argv[2]||'wrangler.jsonc','utf8')));console.log('可选备份/演练绑定检查通过；不表示实际云资源已经创建或验收。');
}
