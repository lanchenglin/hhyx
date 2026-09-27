import {assert, AppError, encrypt, decrypt} from './util.js';
import {one} from './store.js';
import {publicEngine} from './ai-policy.js';

export const AI_CONFIG_KEY='admin_ai_config';
export const AI_ENV_MAP={provider:'AI_PROVIDER',baseUrl:'AI_BASE_URL',model:'AI_MODEL',inputCentsPerMillion:'AI_INPUT_CENTS_PER_MILLION',outputCentsPerMillion:'AI_OUTPUT_CENTS_PER_MILLION',outputTokens:'AI_OUTPUT_TOKENS',structured:'AI_STRUCTURED_OUTPUT'};
export async function readAiConfig(env) {
 const r=await one(env,'SELECT value FROM settings WHERE key=?',AI_CONFIG_KEY);
 if(!r)return null;
 try {const c=JSON.parse(r.value);assert(c&&Number.isInteger(c.revision)&&c.revision>0,'AI配置记录损坏',503);return c;}
 catch{throw new AppError('AI配置记录不可读取，请管理员检查；不会自动切换到旧密钥',503,'AI_CONFIG_ERROR');}
}
export function envWithConfig(env,c,{validation=false}={}) {
 if(!c)return env;
 const result={...env,AI_CONFIGURATION_REVISION:String(c.revision),AI_API_KEY:'',AI_ALLOWED_HOSTS:(c.allowedHosts||[]).join(',')};
 for(const [k,v] of Object.entries(AI_ENV_MAP))result[v]=String(c[k]??'');
 if(validation)result.AI_API_KEY='configuration-validation-only';
 else if(c.enabled&&c.keyEncrypted){
  try {result.AI_API_KEY=decrypt(c.keyEncrypted,env.CONFIG_ENCRYPTION_KEY);}
  catch{throw new AppError('AI密钥解密失败，请管理员检查配置加密密钥；不会回退到旧配置',503,'AI_CONFIG_ERROR');}
 }
 return result;
}
export async function resolveAiEnv(env){return envWithConfig(env,await readAiConfig(env));}
export async function aiSettingsView(env) {
 const c=await readAiConfig(env);
 if(c)return {source:'database',revision:c.revision,enabled:c.enabled,keyConfigured:!!c.keyEncrypted,
  ...Object.fromEntries(Object.keys(AI_ENV_MAP).map(k=>[k,c[k]])),allowedHosts:c.allowedHosts,updatedAt:c.updatedAt,
  engine:publicEngine(envWithConfig(env,c,{validation:true})),encryptionReady:!!env.CONFIG_ENCRYPTION_KEY};
 const engine=publicEngine(env);
 return {source:'environment',revision:0,enabled:engine.configured,keyConfigured:!!env.AI_API_KEY,provider:env.AI_PROVIDER||'openai_compatible',
  baseUrl:env.AI_BASE_URL||'https://api.openai.com/v1',model:env.AI_MODEL||'',inputCentsPerMillion:Number(env.AI_INPUT_CENTS_PER_MILLION)||0,
  outputCentsPerMillion:Number(env.AI_OUTPUT_CENTS_PER_MILLION)||0,outputTokens:Number(env.AI_OUTPUT_TOKENS)||4096,
  structured:env.AI_STRUCTURED_OUTPUT!=='false',allowedHosts:[],updatedAt:null,engine,encryptionReady:!!env.CONFIG_ENCRYPTION_KEY};
}
export function validateAiSettings(env,a,previous,at) {
 assert(typeof a.enabled==='boolean'&&typeof a.structured==='boolean','请明确AI启用状态和结构化输出设置');
 assert(a.expectedRevision===(previous?.revision||0),'AI配置已被其他管理员更新，请刷新后重试',409,'CONFIG_CONFLICT');
 const c={revision:(previous?.revision||0)+1,enabled:a.enabled,structured:a.structured,updatedAt:at};
 for(const k of ['provider','baseUrl','model']){assert(typeof a[k]==='string',`${k}格式不正确`);c[k]=a[k].trim();assert(c[k].length<=({provider:40,baseUrl:500,model:120}[k]),`${k}内容过长`);}
 for(const k of ['inputCentsPerMillion','outputCentsPerMillion','outputTokens']){assert(Number.isSafeInteger(a[k]),`${k}须为整数`);c[k]=a[k];}
 let host;try{host=new URL(c.baseUrl).hostname;}catch{throw new AppError('API URL格式不正确');}
 const trusted=['api.openai.com','api.anthropic.com',...String(env.AI_ALLOWED_HOSTS||'').split(',')].includes(host)||previous?.allowedHosts?.includes(host);
 assert(trusted||a.confirmExternalHost===true,'第三方API接收方需管理员明确确认；不要填写不可信地址');
 c.allowedHosts=[host];
 const engine=publicEngine(envWithConfig(env,c,{validation:true}));assert(engine.configured,engine.error);
 assert(!/\/(?:chat\/completions|messages)\/?$/.test(engine.baseUrl),'填写API基址（例如 /v1），不要包含最终 /chat/completions 或 /messages 路径');
 c.baseUrl=engine.baseUrl;
 assert(a.key==null||typeof a.key==='string','Key格式不正确');
 assert(!a.key||(!/[\r\n\s]/.test(a.key)&&a.key.length<=8192&&a.key.length>=8),'API Key须为8–8192字符且不能含空白');
 assert(!(a.clearKey&&a.key),'不能同时清除和设置Key');
 if(a.key)c.keyEncrypted=encrypt(a.key,env.CONFIG_ENCRYPTION_KEY);
 else if(a.clearKey===true)c.keyEncrypted=null;
 else if(previous)c.keyEncrypted=previous.keyEncrypted||null;
 else c.keyEncrypted=env.AI_API_KEY?encrypt(env.AI_API_KEY,env.CONFIG_ENCRYPTION_KEY):null;
 assert(!c.enabled||c.keyEncrypted,'启用AI前请填写Key；留空仅保留已有Key');
 return c;
}
