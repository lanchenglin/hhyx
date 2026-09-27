import { assert, now, sha, token, uid, safeEqual, hashPassword, verifyPassword, text, email } from './util.js';
import { one } from './store.js';
export const publicUser = u => ({id:u.id,email:u.email,name:u.name,phone:u.phone||'',smsOptIn:!!u.sms_opt_in,username:u.username||'',systemRole:u.system_role||'member',disabled:!!u.disabled,canCreateProjects:u.can_create_projects!==0,mustChangePassword:!!u.must_change_password});
export async function rateLimit(env,key,limit=12,seconds=900){
 const epoch=Math.floor(Date.now()/1000), bucket=`${key}:${Math.floor(epoch/seconds)}`;
 await env.DB.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').bind(bucket,epoch+seconds).run();
 const r=await one(env,'SELECT count FROM rate_limits WHERE key=?',bucket);assert(r.count<=limit,'尝试过于频繁，请稍后再试',429,'RATE_LIMITED');
}
export function originCheck(req,env) {
 const expected=new URL(env.APP_URL||req.url).origin;
 assert(req.headers.get('origin')===expected,'请求来源校验失败',403,'ORIGIN_MISMATCH');
}
function cookieName(req){return new URL(req.url).protocol==='https:'?'__Host-coop_session':'coop_session';}
export function sessionCookie(req,value,maxAge=43200){const secure=new URL(req.url).protocol==='https:';return `${cookieName(req)}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure?'; Secure':''}`;}
export async function startSession(env,req,user) {
 const t=token(),csrf=token(),expires=Math.floor(Date.now()/1000)+43200;
 await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at,reauth_at,auth_version) VALUES(?,?,?,?,0,?)').bind(sha(t),user.id,csrf,expires,user.auth_version||0).run();
 return {user:publicUser(user),csrf,cookie:sessionCookie(req,t)};
}
export async function authenticate(env,req,csrfRequired=false) {
 const cookies=Object.fromEntries((req.headers.get('cookie')||'').split(';').map(s=>s.trim().split('=')));
 const raw=cookies[cookieName(req)]||'';assert(raw,'请先登录',401,'AUTH_REQUIRED');
 const hash=sha(raw),row=await one(env,'SELECT s.*,u.email,u.name,u.password_hash,u.phone,u.sms_opt_in,u.username,u.system_role,u.disabled,u.can_create_projects,u.must_change_password,u.auth_version AS account_version FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=? AND expires_at>? AND u.disabled=0 AND s.auth_version=u.auth_version',hash,Math.floor(Date.now()/1000));
 assert(row,'登录已过期，请重新登录',401,'AUTH_REQUIRED');if(csrfRequired)assert(safeEqual(req.headers.get('x-csrf-token'),row.csrf),'安全校验失败，请刷新后重试',403,'CSRF_FAILED');
 return {user:{id:row.user_id,email:row.email,name:row.name,password_hash:row.password_hash,phone:row.phone,sms_opt_in:row.sms_opt_in,username:row.username,system_role:row.system_role,disabled:row.disabled,can_create_projects:row.can_create_projects,must_change_password:row.must_change_password,auth_version:row.account_version},session:{hash,csrf:row.csrf,reauthAt:row.reauth_at}};
}
export const requireReauth = session => assert(session.reauthAt>=Math.floor(Date.now()/1000)-300,'重要操作请重新输入密码确认身份',403,'REAUTH_REQUIRED');
export async function bootstrap(env,a,req){
 assert(env.BOOTSTRAP_TOKEN&&safeEqual(a.token,env.BOOTSTRAP_TOKEN),'初始化口令不正确',403);
 assert(!(await one(env,"SELECT value FROM settings WHERE key='bootstrapped'")),'系统已经初始化',409);
 const u={id:uid(),email:email(a.email),name:text(a.name,'姓名',60),password_hash:hashPassword(a.password),username:'admin',system_role:'admin',auth_version:0};
 const result=await env.DB.batch([
  env.DB.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('bootstrapped',?)").bind(u.id),
  env.DB.prepare("INSERT INTO users(id,email,name,password_hash,created_at,username,system_role) SELECT ?,?,?,?,?,'admin','admin' WHERE EXISTS(SELECT 1 FROM settings WHERE key='bootstrapped' AND value=?)").bind(u.id,u.email,u.name,u.password_hash,now(),u.id)
 ]);assert(result[1].meta.changes===1,'系统已经初始化',409);return startSession(env,req,u);
}
export async function login(env,a,req){
 const e=text(a.login??a.email,'用户名或邮箱',254).toLowerCase();await rateLimit(env,`login-email:${sha(e)}`,10);const u=await one(env,'SELECT * FROM users WHERE email=? OR username=?',e,e);
 // 不存在的账号也进行相同成本的散列校验，避免明显的计时枚举。
 const dummy='scrypt$32768$8$3$00000000000000000000000000000000$'+ '0'.repeat(64);
 const valid=verifyPassword(a.password,u?.password_hash||dummy);assert(u&&valid&&!u.disabled,'账号或密码不正确',401,'LOGIN_FAILED');return startSession(env,req,u);
}

// Explicit deployment opt-in, only for an empty installation. Never overwrites an
// existing account, bootstrap sentinel or password on upgrades/restarts.
export async function ensureInitialAdmin(env){
 if(env.INITIAL_ADMIN_ENABLED!=='true'||!env.INITIAL_ADMIN_PASSWORD)return false;
 if(await one(env,"SELECT value FROM settings WHERE key='bootstrapped'"))return false;
 assert(!(await one(env,'SELECT id FROM users LIMIT 1')),'存在账号但初始化标记缺失，请管理员恢复，不自动建立默认账号',409);
 const at=now(),id=uid(),em=email(env.INITIAL_ADMIN_EMAIL||'admin@local.invalid');
 const hash=hashPassword(env.INITIAL_ADMIN_PASSWORD,{temporary:true});
 const result=await env.DB.batch([
  env.DB.prepare("INSERT OR IGNORE INTO settings(key,value) SELECT 'bootstrapped',? WHERE NOT EXISTS(SELECT 1 FROM users)").bind(id),
  env.DB.prepare("INSERT INTO users(id,email,name,password_hash,created_at,username,system_role,must_change_password) SELECT ?,?,'系统管理员',?,?,'admin','admin',1 WHERE EXISTS(SELECT 1 FROM settings WHERE key='bootstrapped' AND value=?)").bind(id,em,hash,at,id),
  env.DB.prepare("INSERT INTO admin_audit(id,actor_id,actor_name,action,target_id,details,created_at) SELECT ?,?,'初始化服务','admin.initialized',?,? ,? WHERE EXISTS(SELECT 1 FROM users WHERE id=?)").bind(uid(),'system:bootstrap',id,JSON.stringify({username:'admin',mustChangePassword:true}),at,id)
 ]);
 return result[1].meta.changes===1;
}
