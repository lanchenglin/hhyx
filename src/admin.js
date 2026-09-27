import {getReport} from './ai.js';
import {createHmac} from 'node:crypto';
import {assert,AppError,body,json,uid,now,sha,text,email,hashPassword} from './util.js';
import {one,rows,load,mutate,auditRows,verifyAudit} from './store.js';
import {requireReauth,rateLimit,publicUser} from './auth.js';
import {finance} from './domain.js';
import {AI_CONFIG_KEY,readAiConfig,resolveAiEnv,aiSettingsView,validateAiSettings} from './system-config.js';
import {publicEngine} from './ai-policy.js';

export const isAdmin=user=>user.system_role==='admin'&&!user.disabled;
export const requireAdmin=user=>assert(isAdmin(user),'仅系统管理员可以访问管理后台',403,'ADMIN_REQUIRED');
const logData=(user,action,target,details)=>[uid(),user.id,user.name,action,target,JSON.stringify(details),now()];
export function adminAuditStatement(env,user,action,target,details,guardSql='',guardArgs=[]){
 return env.DB.prepare('INSERT INTO admin_audit(id,actor_id,actor_name,action,target_id,details,created_at) SELECT ?,?,?,?,?,?,?'+(guardSql?' WHERE '+guardSql:''))
  .bind(...logData(user,action,target,details),...guardArgs);
}
const keyOf=req=>req.headers.get('x-idempotency-key');
export function username(value){const s=text(value,'用户名',64).toLowerCase();assert(/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(s),'用户名须为3–64位英文、数字、下划线、点或短横线');return s;}
const reasonOf=a=>text(a.reason,'操作原因',1000);
const adminColumns='id,email,name,username,system_role,disabled,can_create_projects,must_change_password,auth_version,created_at,updated_at';
const userView=u=>({...publicUser(u),authVersion:u.auth_version,createdAt:u.created_at,updatedAt:u.updated_at});

// Site-level updates serialize on a CAS revision. Every side effect, revocation,
// result and audit row is guarded by the successful revision claim.
async function siteChange(env,user,key,payload,build){
 requireAdmin(user);assert(typeof key==='string'&&/^[a-zA-Z0-9_-]{12,100}$/.test(key),'缺少有效的请求幂等键');
 const op=sha(user.id+':admin:'+key),requestHash=createHmac('sha256',user.password_hash).update(JSON.stringify(payload)).digest('hex');
 for(let attempt=0;attempt<5;attempt++){
  const current=await one(env,'SELECT * FROM users WHERE id=?',user.id);
  assert(current&&isAdmin(current)&&current.auth_version===user.auth_version,'管理员权限或会话已变化，请重新登录',403,'ADMIN_REQUIRED');
  const previous=await one(env,'SELECT * FROM admin_operations WHERE id=?',op);
  if(previous){assert(previous.request_hash===requestHash,'同一幂等键不能提交不同内容',409);return {...JSON.parse(previous.result),idempotent:true};}
  const revision=(await one(env,"SELECT value FROM settings WHERE key='admin_revision'"))?.value;
  assert(revision!=null,'管理员数据库迁移尚未完成',503);
  const guard=uid(),condition="EXISTS(SELECT 1 FROM settings WHERE key='admin_revision' AND value=?)";
  const guarded=(sql,...args)=>env.DB.prepare(sql).bind(...args,guard);
  const plan=await build({guard,condition,guarded});
  const start=env.DB.prepare("UPDATE settings SET value=? WHERE key='admin_revision' AND value=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND system_role='admin' AND disabled=0 AND auth_version=?)"+(plan.condition?' AND '+plan.condition:''))
   .bind(guard,revision,user.id,user.auth_version,...(plan.conditionArgs||[]));
  const result=plan.result||{ok:true};
  const batch=await env.DB.batch([start,...plan.statements,
   adminAuditStatement(env,user,payload.action,plan.target||payload.targetId||'',plan.details||{},condition,[guard]),
   guarded('INSERT INTO admin_operations(id,actor_id,request_hash,result,created_at) SELECT ?,?,?,?,? WHERE '+condition,op,user.id,requestHash,JSON.stringify(result),now())]);
  if(batch[0].meta.changes===1)return result;
 }
 throw new AppError('管理设置同时发生变化，请刷新后重试',409,'CONFLICT');
}
function obligations(state){
 return {pendingApprovals:state.purchases.filter(q=>q.status==='pending').length+state.proposals.filter(g=>g.status==='pending').length,
  unfinishedPurchases:state.purchases.filter(q=>q.order&&q.status!=='received').length,
  unfinishedTasks:state.tasks.filter(t=>t.status!=='done').length,unverifiedEntries:state.ledger.filter(l=>!l.verifiedBy).length,
  payableCents:finance(state).payableCents,receivableCents:finance(state).receivableCents,
  aiInFlight:(state.ai?.runs||[]).filter(r=>['queued','running'].includes(r.status)).length};
}
function projectSummary(row){const p=JSON.parse(row.state);return {id:p.id,name:p.name,description:p.description,status:p.status,lifecycle:row.lifecycle||'active',
 revision:row.revision,ownerId:p.ownerId,memberCount:p.members.filter(m=>m.active).length,updatedAt:row.updated_at,createdAt:row.created_at,
 lifecycleHistory:p.lifecycleHistory||[],obligations:obligations(p)};}
async function userMemberships(env,userId){const list=await rows(env,'SELECT p.id,p.name,p.state,p.lifecycle,p.revision FROM projects p JOIN project_access a ON a.project_id=p.id WHERE a.user_id=?',userId);return list.flatMap(row=>{const p=JSON.parse(row.state),m=p.members.find(m=>m.active&&m.userId===userId);return m?[{projectId:p.id,projectName:p.name,lifecycle:row.lifecycle,revision:row.revision,memberId:m.id,role:m.role,isOwner:p.ownerId===userId,pendingTasks:p.tasks.filter(t=>t.status!=='done'&&(t.assigneeId===m.id||t.reviewerId===m.id)).length}]:[];});}

export async function adminRoute(req,env,ctx,{user,session,url}){
 requireAdmin(user);const method=req.method,path=url.pathname.slice('/api/admin'.length)||'/';
 if(method==='POST')requireReauth(session);
 if(path==='/overview'&&method==='GET'){
  const userCounts=await one(env,"SELECT COUNT(*) AS total,SUM(disabled=1) AS disabled,SUM(system_role='admin' AND disabled=0) AS admins,SUM(must_change_password=1) AS passwordChangesRequired FROM users");
  const projectCounts=await rows(env,'SELECT lifecycle,COUNT(*) AS count FROM projects GROUP BY lifecycle');
  const jobs=await rows(env,'SELECT status,COUNT(*) AS count FROM ai_jobs GROUP BY status');
  const notifications=await rows(env,'SELECT status,COUNT(*) AS count FROM outbox GROUP BY status');
  let ai;try{ai=await aiSettingsView(env);}catch(e){ai={engine:{configured:false,error:e.message}};}
  return json({version:'1.2.0',userCounts,projectCounts,jobs,notifications,aiConfigured:ai.enabled&&ai.keyConfigured,
   diagnostics:{database:'reachable',filesBinding:!!env.FILES,configurationEncryption:!!env.CONFIG_ENCRYPTION_KEY,notifyQueue:!!env.NOTIFY_QUEUE,
    aiConfiguration:ai.engine?.error||'',note:'绑定存在不等于云端服务已验收；备份需同时包含D1及私有R2。'}});
 }
 if(path==='/users'&&method==='GET'){
  const q=(url.searchParams.get('q')||'').slice(0,100).toLowerCase(),offset=Math.max(0,Number.parseInt(url.searchParams.get('offset')||'0',10)||0);
  const params=['%'+q+'%','%'+q+'%','%'+q+'%'];
  const filter=' WHERE lower(name) LIKE ? OR lower(email) LIKE ? OR lower(COALESCE(username,\'\')) LIKE ?';
  const list=await rows(env,'SELECT '+adminColumns+', (SELECT COUNT(*) FROM sessions s WHERE s.user_id=users.id AND s.expires_at>?) AS active_sessions FROM users'+filter+' ORDER BY created_at,id LIMIT 50 OFFSET ?',Math.floor(Date.now()/1000),...params,offset);
  const n=await one(env,'SELECT COUNT(*) AS n FROM users'+filter,...params);
  return json({users:list.map(u=>({...userView(u),activeSessions:u.active_sessions})),total:n.n,nextOffset:offset+list.length<n.n?offset+list.length:null});
 }
 const um=path.match(/^\/users\/([^/]+)(?:\/(reset-password|revoke-sessions))?$/);
 if(um&&method==='GET'&&!um[2]){
  const target=await one(env,'SELECT '+adminColumns+' FROM users WHERE id=?',um[1]);assert(target,'账号不存在',404);
  return json({user:userView(target),memberships:await userMemberships(env,um[1])});
 }
 if(path==='/users'&&method==='POST'){
  const a=await body(req),reason=reasonOf(a),id=uid(),at=now(),name=text(a.name,'姓名',60),un=username(a.username),em=email(a.email);
  assert(['admin','member'].includes(a.systemRole),'系统角色不正确');assert(typeof a.canCreateProjects==='boolean','请明确新建项目权限');
  const hash=hashPassword(a.temporaryPassword);
  return json(await siteChange(env,user,keyOf(req),{...a,action:'user.create'},async({condition,guarded})=>{
   assert(!await one(env,'SELECT id FROM users WHERE username=? OR email=?',un,em),'用户名或邮箱已被使用',409);
   return {target:id,result:{ok:true,id},details:{name,username:un,email:em,systemRole:a.systemRole,canCreateProjects:a.canCreateProjects,reason},statements:[
    guarded('INSERT INTO users(id,email,name,password_hash,username,system_role,can_create_projects,must_change_password,created_at,updated_at) SELECT ?,?,?,?,?,?,?,1,?,? WHERE '+condition,id,em,name,hash,un,a.systemRole,+a.canCreateProjects,at,at)]};
  }),201);
 }
 if(um&&method==='POST'){
  const a=await body(req),reason=reasonOf(a),targetId=um[1],action=um[2]||'update';
  return json(await siteChange(env,user,keyOf(req),{...a,targetId,action:'user.'+action},async({condition,guarded})=>{
   const target=await one(env,'SELECT * FROM users WHERE id=?',targetId);assert(target,'账号不存在',404);
   assert(a.expectedVersion===target.auth_version,'账号已被修改，请刷新后重试',409,'USER_CONFLICT');
   const details={reason,username:target.username||target.email},at=now();let statement;
   if(action==='reset-password'){
    assert(targetId!==user.id,'本人密码请在账号设置中修改，不能给自己强制重置',409);
    const hash=hashPassword(a.temporaryPassword);
    statement=guarded('UPDATE users SET password_hash=?,must_change_password=1,auth_version=auth_version+1,updated_at=? WHERE id=? AND '+condition,hash,at,targetId);
   }else if(action==='revoke-sessions'){
    statement=guarded('UPDATE users SET auth_version=auth_version+1,updated_at=? WHERE id=? AND '+condition,at,targetId);
   }else{
    assert(['admin','member'].includes(a.systemRole),'系统角色不正确');
    assert(typeof a.disabled==='boolean'&&typeof a.canCreateProjects==='boolean','权限开关不正确');
    assert(targetId!==user.id||(!a.disabled&&a.systemRole==='admin'),'不能停用自己或撤销自己的管理员权限',409);
    if(target.system_role==='admin'&&!target.disabled&&(a.disabled||a.systemRole!=='admin')){
     const n=await one(env,"SELECT COUNT(*) AS n FROM users WHERE system_role='admin' AND disabled=0");assert(n.n>1,'必须保留至少一位有效管理员',409);
    }
    const un=username(a.username||target.username||target.email.split('@')[0]),name=text(a.name,'姓名',60);
    assert(!await one(env,'SELECT id FROM users WHERE username=? AND id<>?',un,targetId),'用户名已被使用',409);
    if(a.disabled&&!target.disabled)assert(a.confirmImpact===true,'停用将撤销会话，但不会移除其必签资格；请确认对在办事项的影响');
    Object.assign(details,{before:{systemRole:target.system_role,disabled:!!target.disabled,canCreateProjects:!!target.can_create_projects,username:target.username,name:target.name},after:{systemRole:a.systemRole,disabled:a.disabled,canCreateProjects:a.canCreateProjects,username:un,name}});
    statement=guarded('UPDATE users SET username=?,name=?,system_role=?,disabled=?,can_create_projects=?,auth_version=auth_version+1,updated_at=? WHERE id=? AND '+condition,un,name,a.systemRole,+a.disabled,+a.canCreateProjects,at,targetId);
   }
   return {target:targetId,details,result:{ok:true,requiresRelogin:targetId===user.id},condition:'EXISTS(SELECT 1 FROM users WHERE id=? AND auth_version=?)',conditionArgs:[targetId,target.auth_version],
    statements:[statement,guarded('DELETE FROM sessions WHERE user_id=? AND '+condition,targetId),
     guarded(`INSERT INTO notifications(id,project_id,user_id,title,body,target,severity,created_at)
       SELECT ?||':'||a.project_id||':'||a.user_id,a.project_id,a.user_id,?,?, 'members','warning',?
       FROM project_access a JOIN project_access changed ON a.project_id=changed.project_id JOIN projects p ON p.id=a.project_id
       WHERE changed.user_id=? AND p.lifecycle!='trashed' AND `+condition,
       uid(),'项目成员账号管理变更',`${target.name}的${action==='reset-password'?'临时密码已重置，原登录已撤销':action==='revoke-sessions'?'登录会话已撤销':'系统账号权限或状态已调整，原登录已撤销'}。历史意见与必签资格不会自动删除，请留意后续操作。`,at,targetId)]};
  }));
 }
 if(path==='/projects'&&method==='GET'){
  const lifecycle=url.searchParams.get('lifecycle')||'active';assert(['active','archived','trashed','all'].includes(lifecycle),'项目筛选无效');
  const q=(url.searchParams.get('q')||'').slice(0,100),offset=Math.max(0,Number.parseInt(url.searchParams.get('offset')||'0',10)||0);
  const where='WHERE (?=\'all\' OR lifecycle=?) AND name LIKE ?',args=[lifecycle,lifecycle,'%'+q+'%'];
  const list=await rows(env,'SELECT * FROM projects '+where+' ORDER BY updated_at DESC,id LIMIT 30 OFFSET ?',...args,offset);
  const n=await one(env,'SELECT COUNT(*) AS n FROM projects '+where,...args);
  return json({projects:list.map(projectSummary),total:n.n,nextOffset:offset+list.length<n.n?offset+list.length:null});
 }
 const resource=path.match(/^\/projects\/([^/]+)\/(files|ai)\/([^/]+)$/);
 if(resource&&method==='GET'){
  const [,pid,type,id]=resource,{state}=await load(env,pid);
  if(type==='ai'){
   const result=await getReport(env,pid,id,state);
   await adminAuditStatement(env,user,'project.ai_inspect',pid,{projectName:state.name,runId:id,readOnly:true}).run();
   return json(result);
  }
  const file=await one(env,'SELECT * FROM attachments WHERE id=? AND project_id=?',id,pid);assert(file,'附件不存在或不属于项目',404);
  const object=await env.FILES.get(file.object_key);assert(object,'附件对象缺失，请检查备份',404);
  await adminAuditStatement(env,user,'project.file_download',pid,{projectName:state.name,fileId:id}).run();
  return new Response(object.body,{headers:{'Content-Type':file.mime,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'"}});
 }
 const pm=path.match(/^\/projects\/([^/]+)(?:\/(lifecycle|members|export))?$/);
 if(pm){
  const pid=pm[1],{row,state}=await load(env,pid);
  if(method==='GET'&&(!pm[2]||pm[2]==='export')){
   await adminAuditStatement(env,user,pm[2]==='export'?'project.export':'project.inspect',pid,{projectName:state.name,readOnly:true}).run();
   const data={...projectSummary(row),project:{...state,finance:finance(state)},readOnly:true};
   if(pm[2]==='export'){
    const audit=await auditRows(env,pid,0,10000);assert(audit.length===row.revision,'超过单次导出范围，请执行运维数据库备份',409);
    data.audit=audit;data.auditVerification=verifyAudit(audit,state,row.audit_head);
    data.aiManifest=await rows(env,'SELECT id,kind,target_id,status,created_at,finished_at FROM ai_jobs WHERE project_id=?',pid);
    data.note='此导出不包含R2原文件和完整AI报告；完整备份须导出D1并单独备份R2。';
   }
   return json(data,200,pm[2]?{'Content-Disposition':`attachment; filename="admin-project-${pid}.json"`}:{});
  }
  if(method==='POST'&&['lifecycle','members'].includes(pm[2])){
   const a=await body(req),reason=reasonOf(a);assert(a.expectedRevision===row.revision,'项目已变化，请刷新后重新核对',409);
   let type,data;
   if(pm[2]==='lifecycle'){
    assert(['archive','unarchive','trash','restore'].includes(a.action),'项目生命周期操作无效');assert(a.confirmName===state.name,'请准确输入项目名称确认');
    if(['archive','trash'].includes(a.action)){assert(a.confirmImpact===true,'请确认未完成任务、付款责任及历史数据处理方式');}
    type='admin.lifecycle';data={action:a.action,reason,confirmImpact:a.confirmImpact===true};
   }else{type='admin.member.role';data={memberId:a.memberId,role:a.role,reason};}
   await mutate(env,pid,user,{type,data},keyOf(req),{adminVerified:true,requiredRevision:row.revision,
    extraStatements:(e,p,op)=>[adminAuditStatement(e,user,type,pid,{...data,projectName:state.name},'EXISTS(SELECT 1 FROM projects WHERE id=? AND last_operation=?)',[p,op])]});
   const fresh=await load(env,pid);return json({ok:true,project:projectSummary(fresh.row),message:pm[2]==='members'&&state.status!=='draft'?'角色变更已提交全员会签，未直接生效':'操作已记录'});
  }
 }
 if(path==='/ai-settings'&&method==='GET')return json(await aiSettingsView(env));
 if(path==='/ai-settings'&&method==='POST'){
  const a=await body(req),reason=reasonOf(a);
  await siteChange(env,user,keyOf(req),{...a,action:'ai.settings'},async({condition,guarded})=>{
   const previous=await readAiConfig(env),c=validateAiSettings(env,a,previous,now());
   return {target:'system-ai',result:{ok:true,revision:c.revision},details:{reason,revision:c.revision,provider:c.provider,baseUrl:c.baseUrl,model:c.model,enabled:c.enabled,keyAction:a.key?'replaced':a.clearKey?'cleared':'retained'},
    statements:[guarded('INSERT INTO settings(key,value) SELECT ?,? WHERE '+condition+' ON CONFLICT(key) DO UPDATE SET value=excluded.value',AI_CONFIG_KEY,JSON.stringify(c))]};
  });return json(await aiSettingsView(env));
 }
 if(path==='/ai-settings/test'&&method==='POST'){
  const a=await body(req);assert(a.confirmCost===true,'测试会调用模型且可能计费，需明确确认');await rateLimit(env,'admin-model-test',5,3600);
  const resolved=await resolveAiEnv(env),engine=publicEngine(resolved);assert(engine.configured,engine.error||'请先保存有效的AI配置',503);
  const settings=await aiSettingsView(env);assert(a.expectedRevision===settings.revision,'配置已变化，请刷新后再测试',409);
  // A generic tiny probe contains no project or user information and requests no tools.
  const headers={'Content-Type':'application/json'},data={model:engine.model};let endpoint;
  if(engine.provider==='anthropic'){endpoint=engine.baseUrl+'/messages';headers['x-api-key']=resolved.AI_API_KEY;headers['anthropic-version']='2023-06-01';Object.assign(data,{max_tokens:128,messages:[{role:'user',content:'Reply with the word OK. This is a connection test with no business data.'}]});}
  else{endpoint=engine.baseUrl+'/chat/completions';headers.Authorization='Bearer '+resolved.AI_API_KEY;Object.assign(data,{max_completion_tokens:128,messages:[{role:'user',content:'Reply with the word OK. This is a connection test with no business data.'}]});}
  const fetcher=env.AI_TEST_FETCH||fetch;let result;
  try{
   const response=await fetcher(endpoint,{method:'POST',headers,body:JSON.stringify(data),signal:AbortSignal.timeout(10000),redirect:'error'});
   const reader=response.body?.getReader();let length=0;const chunks=[];
   if(reader)while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>65536){await reader.cancel();throw Error('oversized');}chunks.push(value);}
   let value;try{value=JSON.parse(await new Blob(chunks).text());}catch{value=null;}
   const content=engine.provider==='anthropic'?value?.content?.find(x=>x.type==='text')?.text:value?.choices?.[0]?.message?.content;
   const ok=response.ok&&typeof content==='string'&&content.trim().length>0;
   result={ok,httpStatus:response.status,message:ok?'已收到模型文本响应；仅验证鉴权及基础接口，不代表正式分析质量或结构化输出已验收。':`未获得有效文本响应（HTTP ${response.status}）；请核对模型、权限和协议。未展示服务商原始内容。`,usageKnown:!!value?.usage};
  }catch{result={ok:false,message:'请求失败或超时，服务商是否计费不确定；不会自动重试。',usageKnown:false};}
  await adminAuditStatement(env,user,'ai.connection_test','system-ai',{provider:engine.provider,model:engine.model,revision:settings.revision,...result}).run();
  return json(result);
 }
 if(path==='/audit'&&method==='GET'){
  const before=Math.max(0,Number.parseInt(url.searchParams.get('before')||'0',10)||0),action=(url.searchParams.get('action')||'').slice(0,100);
  const list=await rows(env,'SELECT * FROM admin_audit WHERE (?=0 OR sequence<?) AND action LIKE ? ORDER BY sequence DESC LIMIT 100',before,before,'%'+action+'%');
  return json({records:list.map(r=>({...r,details:JSON.parse(r.details)})),nextBefore:list.length===100?list.at(-1).sequence:null});
 }
 throw new AppError('管理接口不存在或方法不支持',404);
}
