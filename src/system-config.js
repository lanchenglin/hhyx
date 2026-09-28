import {normalizeAiUrl} from './ai-transport.js';
import {assert, AppError, decrypt, uid} from './util.js';
import {one} from './store.js';
import {publicEngine} from './ai-policy.js';
import {promptCatalog} from './ai-prompts.js';

export const AI_CONFIG_KEY='admin_ai_config';
export const AI_ENV_MAP={provider:'AI_PROVIDER',baseUrl:'AI_BASE_URL',model:'AI_MODEL',analysisGuidance:'AI_ANALYSIS_GUIDANCE'};
export async function readAiConfig(env) {
 let r;try{r=await one(env,'SELECT value FROM settings WHERE key=?',AI_CONFIG_KEY);}catch(error){throw aiSettingsError(error,'read');}
 if(!r)return null;
 try {const c=JSON.parse(r.value);assert(c&&Number.isInteger(c.revision)&&c.revision>0,'AI配置记录损坏',503);return c;}
 catch{throw new AppError('AI配置记录不可读取，请管理员检查；不会自动切换到旧密钥',503,'AI_CONFIG_ERROR');}
}
export function envWithConfig(env,c,{validation=false}={}) {
 if(!c)return env;
 const result={...env,AI_CONFIGURATION_REVISION:String(c.revision),AI_API_KEY:''};
 for(const [k,v] of Object.entries(AI_ENV_MAP))result[v]=String(c[k]??'');
 // Advanced protocol settings are deployment-only, not fees or form requirements.
 if(c.structured!=null&&env.AI_STRUCTURED_OUTPUT==null)result.AI_STRUCTURED_OUTPUT=String(c.structured);
 if(validation)result.AI_API_KEY='configuration-validation-only';
 else if(c.enabled&&Object.hasOwn(c,'key'))result.AI_API_KEY=c.key||'';
 else if(c.enabled&&c.keyEncrypted){
  try {result.AI_API_KEY=decrypt(c.keyEncrypted,env.CONFIG_ENCRYPTION_KEY);}
  catch{throw new AppError('AI密钥解密失败，请管理员检查配置加密密钥；不会回退到旧配置',503,'AI_CONFIG_ERROR');}
 }
 return result;
}
export async function resolveAiEnv(env){return envWithConfig(env,await readAiConfig(env));}
export async function aiSettingsView(env) {
 const c=await readAiConfig(env);
 if(c)return {source:'database',revision:c.revision,enabled:c.enabled,keyConfigured:!!(Object.hasOwn(c,'key')?c.key:c.keyEncrypted),
  keyStorage:Object.hasOwn(c,'key')?(c.key?'plaintext':'none'):(c.keyEncrypted?'legacy-encrypted':'none'),
  ...Object.fromEntries(Object.keys(AI_ENV_MAP).map(k=>[k,c[k]||''])),prompts:promptCatalog(),updatedAt:c.updatedAt,
  engine:publicEngine(envWithConfig(env,c,{validation:true}))};
 const engine=publicEngine(env);
 return {source:'environment',revision:0,enabled:engine.configured,keyConfigured:!!env.AI_API_KEY,provider:env.AI_PROVIDER||'openai_compatible',
  baseUrl:env.AI_BASE_URL||'https://api.openai.com/v1',model:env.AI_MODEL||'',
  analysisGuidance:env.AI_ANALYSIS_GUIDANCE||'',prompts:promptCatalog(),keyStorage:env.AI_API_KEY?'environment':'none',updatedAt:null,engine};
}
export function validateAiSettings(env,a,previous,at) {
 assert(typeof a.enabled==='boolean','请明确AI启用状态');
 assert(a.expectedRevision===(previous?.revision||0),'AI配置已被其他管理员更新，请刷新后重试',409,'CONFIG_CONFLICT');
 const c={revision:(previous?.revision||0)+1,enabled:a.enabled,structured:previous?.structured??(env.AI_STRUCTURED_OUTPUT!=='false'),updatedAt:at};
 for(const k of ['provider','baseUrl','model']){assert(typeof a[k]==='string',`${k}格式不正确`);c[k]=a[k].trim();assert(c[k].length<=({provider:40,baseUrl:500,model:120}[k]),`${k}内容过长`);}
 c.analysisGuidance=Object.hasOwn(a,'analysisGuidance')?a.analysisGuidance:(previous?.analysisGuidance||'');
 assert(typeof c.analysisGuidance==='string'&&c.analysisGuidance.length<=2000,'补充分析偏好最多2000字符');
 c.baseUrl=normalizeAiUrl(c.baseUrl,c.provider);
 const engine=publicEngine(envWithConfig(env,c,{validation:true}));assert(engine.configured,engine.error);
 assert(!/\/(?:chat\/completions|messages)\/?$/.test(engine.baseUrl),'填写API基址（例如 /v1），不要包含最终 /chat/completions 或 /messages 路径');
 c.baseUrl=engine.baseUrl;
 assert(a.key==null||typeof a.key==='string','Key格式不正确');
 assert(!a.key||(!/[\r\n\s]/.test(a.key)&&a.key.length<=8192&&a.key.length>=8),'API Key须为8–8192字符且不能含空白');
 assert(!(a.clearKey&&a.key),'不能同时清除和设置Key');
 if(a.key)c.key=a.key;
 else if(a.clearKey===true)c.key=null;
 else if(previous){
  if(Object.hasOwn(previous,'key'))c.key=previous.key;
  else if(previous.keyEncrypted){
   // Migrate only on an explicit save; retain unreadable ciphertext for recovery.
   try{c.key=decrypt(previous.keyEncrypted,env.CONFIG_ENCRYPTION_KEY);}
   catch{c.keyEncrypted=previous.keyEncrypted;}
  }else c.key=null;
 }else c.key=env.AI_API_KEY||null;
 assert(!c.enabled||(Object.hasOwn(c,'key')?c.key:c.keyEncrypted),'启用AI前请填写Key；留空仅保留已有Key');
 return c;
}

export function aiSettingsError(error,phase='save') {
 if(error instanceof AppError)return error;
 const id=uid(),schema=/no such (?:table|column)|has no column|admin_revision/i.test(String(error?.message||''));
 const code=schema?'AI_DATABASE_NOT_READY':'AI_CONFIG_STORAGE_ERROR';
 const message=schema?'AI配置未保存：数据库迁移不完整，请核对当前版本的D1迁移记录，不要清库':'AI配置读取或保存未完成：请检查D1绑定、迁移及运行日志，再刷新配置核对实际状态';
 console.error('ai_configuration_failed',{requestId:id,phase,code});
 return new AppError(`${message}。诊断编号：${id}`,503,code);
}
