import { readdir } from 'node:fs/promises';
// 仅用于本地开发/自动化测试；正式运行入口始终是 src/index.js (Cloudflare Workers)。
// 此适配器不是 Cloudflare 官方模拟器，不模拟平台配额和调度语义。
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
class Statement {
 constructor(db,sql,args=[]){this.db=db;this.sql=sql;this.args=args;}
 bind(...args){return new Statement(this.db,this.sql,args);}
 async first(column){const v=this.db.prepare(this.sql).get(...this.args)||null;return column?v?.[column]??null:v;}
 async all(){return {success:true,results:this.db.prepare(this.sql).all(...this.args),meta:{}};}
 runSync(){const q=this.db.prepare(this.sql);if(q.columns().length)return {success:true,results:q.all(...this.args),meta:{changes:0}};const v=q.run(...this.args);return {success:true,results:[],meta:{changes:Number(v.changes),last_row_id:Number(v.lastInsertRowid)}};}
 async run(){return this.runSync();}
}
export class LocalD1 {
 constructor(db){this.raw=db;}
 prepare(sql){return new Statement(this.raw,sql);}
 async batch(statements){this.raw.exec('BEGIN IMMEDIATE');try{const out=statements.map(s=>s.runSync());this.raw.exec('COMMIT');return out;}catch(e){this.raw.exec('ROLLBACK');throw e;}}
 async exec(sql){this.raw.exec(sql);return {count:1,duration:0};}
}
export async function runtime({memory=false,dir=path.join(ROOT,'.local'),vars={}}={}) {
 await mkdir(dir,{recursive:true});const db=new DatabaseSync(memory?':memory:':path.join(dir,'app.sqlite'));db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');db.exec('CREATE TABLE IF NOT EXISTS local_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
 for(const file of (await readdir(path.join(ROOT,'migrations'))).filter(f=>/^\d+.*\.sql$/.test(f)).sort()){
  if(db.prepare('SELECT name FROM local_migrations WHERE name=?').get(file))continue;
  const sql=await readFile(path.join(ROOT,'migrations',file),'utf8');
  db.exec('BEGIN IMMEDIATE');try{db.exec(sql);db.prepare('INSERT INTO local_migrations(name,applied_at) VALUES(?,?)').run(file,new Date().toISOString());db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 }
 const files=new Map();const fileRoot=path.join(dir,'files');
 const env={DB:new LocalD1(db),APP_NAME:'合伙有序',APP_URL:'http://localhost:8787',TZ:'Asia/Shanghai',...vars,
 FILES:{async put(key,value){const bytes=Buffer.from(value);if(memory)files.set(key,bytes);else{const f=path.join(fileRoot,key);await mkdir(path.dirname(f),{recursive:true});await writeFile(f,bytes);}return {key};},async get(key){try{const data=memory?files.get(key):await readFile(path.join(fileRoot,key));return data?{body:new Uint8Array(data)}:null;}catch{return null;}},async delete(key){if(memory)files.delete(key);else await rm(path.join(fileRoot,key),{force:true});}},
 ASSETS:{async fetch(req){const name=new URL(req.url).pathname;const safe=['/supervision-ui.js','/supervision.css','/index.html','/app.js','/ai-ui.js','/admin-ui.js','/ops-ui.js','/security-ui.js','/continuity-ui.js','/admin.css','/styles.css','/mobile.css','/favicon.svg'].includes(name)?name:'/index.html';const data=await readFile(path.join(ROOT,'public',safe));const ext=path.extname(safe);return new Response(data,{headers:{'Content-Type':({'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.html':'text/html; charset=utf-8'})[ext]}});}}
 };
 const pending=[];return {env,db,ctx:{waitUntil(p){pending.push(Promise.resolve(p).catch(()=>{}));}},async settle(){await Promise.all(pending.splice(0));},close(){db.close();}};
}

// Explicit isolated stores for tests; not automatic production backup bindings.
export function memoryBucket(){const objects=new Map();return {objects,async put(key,value){const b=typeof value==='string'?Buffer.from(value):value instanceof ReadableStream?Buffer.from(await new Response(value).arrayBuffer()):Buffer.from(value);objects.set(key,b);return {key,size:b.length};},async get(key){const b=objects.get(key);return b?{body:new Uint8Array(b),size:b.length,async arrayBuffer(){return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);}}:null;},async delete(key){objects.delete(key);}};}
export function isolatedD1(){const raw=new DatabaseSync(':memory:');raw.exec('PRAGMA foreign_keys=ON');return new LocalD1(raw);}
