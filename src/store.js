import { assert, sha, uid, now, AppError } from './util.js';
import { createProject, reduceProject, getMember, projectView } from './domain.js';
export const one = async (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
export const rows = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
export async function load(env,id) {const row=await one(env,'SELECT * FROM projects WHERE id=?',id);assert(row,'项目不存在',404);return {row,state:JSON.parse(row.state)};}
export async function readProject(env,id,actor) {const {row,state}=await load(env,id);return {...projectView(state,actor),revision:row.revision};}
export function auditContent(projectId,revision,actor,action,payload,summary,beforeHash,afterHash,previousHash,at) {
 return {projectId,revision,actorId:actor.id,actorName:actor.name,action,payload,summary,beforeHash,afterHash,previousHash,at};
}
export function auditStatement(env,c,id,hash,op) {
 return env.DB.prepare(`INSERT INTO audit(id,project_id,revision,actor_id,actor_name,action,payload,summary,before_hash,after_hash,previous_hash,record_hash,created_at)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM projects WHERE id=? AND last_operation=?)`)
 .bind(id,c.projectId,c.revision,c.actorId,c.actorName,c.action,JSON.stringify(c.payload),c.summary,c.beforeHash,c.afterHash,c.previousHash,hash,c.at,c.projectId,op);
}
export async function newProject(env,input,actor) {
 const at=now(),id=uid(),op=uid(),p=createProject(input,actor,{at,id});const c=auditContent(id,1,actor,'project.create',input,'创建合作项目','',sha(p),'',at), hash=sha(c);
 await env.DB.batch([
  env.DB.prepare('INSERT INTO projects(id,name,state,revision,last_operation,audit_head,created_at,updated_at) VALUES(?,?,?,1,?,?,?,?)').bind(id,p.name,JSON.stringify(p),op,hash,at,at),
  env.DB.prepare('INSERT INTO project_access(project_id,user_id) VALUES(?,?)').bind(id,actor.id),
  auditStatement(env,c,uid(),hash,op)
 ]);return {...projectView(p,actor),revision:1};
}
function conditionalInsert(env,sql,args,pid,op) {return env.DB.prepare(sql+ ' WHERE EXISTS(SELECT 1 FROM projects WHERE id=? AND last_operation=?)').bind(...args,pid,op);}
function eventStatements(env,state,events,op,at) {
 const result=[];
 for(let i=0;i<events.length;i++){
  const e=events[i], recipients=state.members.filter(m=>m.active&&m.userId&&(!e.recipients||e.recipients.includes(m.id)));
  const body=e.body||'',target=e.target||'',severity=e.severity||'info';
  for(const m of recipients){
   result.push(conditionalInsert(env,'INSERT INTO notifications(id,project_id,user_id,title,body,target,severity,created_at) SELECT ?,?,?,?,?,?,?,?', [`${op}:${i}:${m.id}`,state.id,m.userId,e.title,body,target,severity,at],state.id,op));
   if(severity==='critical')result.push(conditionalInsert(env,"INSERT INTO outbox(id,project_id,user_id,channel,title,body,target,severity,created_at) SELECT ?,?,?,'sms',?,?,?,?,?",[`${op}:${i}:sms:${m.id}`,state.id,m.userId,e.title,body,target,severity,at],state.id,op));
  }
  result.push(conditionalInsert(env,"INSERT INTO outbox(id,project_id,channel,title,body,target,severity,created_at) SELECT ?,?,'wecom',?,?,?,?,?",[`${op}:${i}:wecom`,state.id,e.title,body,target,severity,at],state.id,op));
 }
 return result;
}
export async function mutate(env,pid,actor,action,key,options={}) {
 assert(typeof key==='string'&&/^[a-zA-Z0-9_-]{12,100}$/.test(key),'缺少有效的请求幂等键 X-Idempotency-Key');
 const op=sha(`${pid}:${actor.id}:${key}`),reqHash=sha({action,extraHash:options.extraHash||''}),at=now();
 for(let attempt=0;attempt<7;attempt++) {
  const previous=await one(env,'SELECT request_hash,revision FROM operations WHERE id=?',op);
  if(previous){assert(previous.request_hash===reqHash,'同一个幂等键不能提交不同内容',409);return {...await readProject(env,pid,actor),idempotent:true};}
  const {row,state}=await load(env,pid);
  const ctx={id:op.slice(0,32),at,today:new Intl.DateTimeFormat('sv-SE',{timeZone:env.TZ||'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at)),...options};
  const result=reduceProject(state,action,actor,ctx),next=result.state;
  const revision=row.revision+1,afterHash=sha(next),guard=uid();
  const c=auditContent(pid,revision,actor,action.type,action.data||{},result.summary,sha(state),afterHash,row.audit_head,at),recordHash=sha(c);
  const stmt=[
   env.DB.prepare('UPDATE projects SET name=?,state=?,revision=?,last_operation=?,audit_head=?,updated_at=? WHERE id=? AND revision=?').bind(next.name,JSON.stringify(next),revision,guard,recordHash,at,pid,row.revision),
   conditionalInsert(env,'INSERT INTO operations(id,project_id,user_id,request_hash,revision,created_at) SELECT ?,?,?,?,?,?',[op,pid,actor.id,reqHash,revision,at],pid,guard),
   auditStatement(env,c,uid(),recordHash,guard),
   ...eventStatements(env,next,result.events,guard,at)
  ];
  // project_access 是检索索引；最终权限始终以项目聚合里的当前成员为准。
  for(const m of next.members.filter(m=>m.userId&&m.active))stmt.push(conditionalInsert(env,'INSERT OR IGNORE INTO project_access(project_id,user_id) SELECT ?,?',[pid,m.userId],pid,guard));
  for(const m of next.members.filter(m=>m.userId&&!m.active))stmt.push(env.DB.prepare('DELETE FROM project_access WHERE project_id=? AND user_id=? AND EXISTS(SELECT 1 FROM projects WHERE id=? AND last_operation=?)').bind(pid,m.userId,pid,guard));
  if(options.extraStatements)stmt.push(...options.extraStatements(env,pid,guard));
  const batch=await env.DB.batch(stmt);
  if(batch[0].meta.changes===1)return next.members.some(m=>m.active&&m.userId===actor.id)?{...projectView(next,actor),revision}:{id:pid,removedFromProject:true,revision};
  await new Promise(r=>setTimeout(r,5*(attempt+1)));
 }
 throw new AppError('多人同时操作产生冲突，请刷新后重试；本次没有重复执行',409,'CONFLICT');
}
export async function auditRows(env,pid,after=0,limit=100) {return rows(env,'SELECT * FROM audit WHERE project_id=? AND revision>? ORDER BY revision LIMIT ?',pid,after,limit);}
export function verifyAudit(records,state,head) {
 let last='',expectedRevision=1;
 for(const r of records){
  if(r.revision!==expectedRevision++)return {valid:false,error:'审计序号不连续'};
  const c=auditContent(r.project_id,r.revision,{id:r.actor_id,name:r.actor_name},r.action,JSON.parse(r.payload),r.summary,r.before_hash,r.after_hash,r.previous_hash,r.created_at);
  if(r.previous_hash!==last||sha(c)!==r.record_hash)return {valid:false,error:`第${r.revision}条记录链校验失败`};
  if(r.revision>1&&r.before_hash!==records[r.revision-2].after_hash)return {valid:false,error:'状态哈希衔接失败'};
  last=r.record_hash;
 }
 return {valid:!!records.length&&last===head&&records.at(-1).after_hash===sha(state),records:records.length,head:last,notice:'哈希链可用于一致性校验；不能防御掌握数据库权限并重写整个链的管理员。请独立保存导出副本。'};
}
