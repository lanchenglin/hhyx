// Provider transport policy. No probes, automatic retries or provider credentials here.
import {assert,AppError} from './util.js';
export function normalizeAiUrl(value,provider='openai_compatible') {
 const raw=String(value||'').trim();assert(!/[\s%\\]/.test(raw),'API URL不能包含空白、反斜杠或编码路径');
 let u;try{u=new URL(raw);}catch{throw new AppError('API URL格式不正确，请填写完整的HTTPS地址');}
 assert(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&(!u.port||u.port==='443'),'API URL须为HTTPS地址，不能带账号、密码、查询参数或非443端口');
 assert(!u.pathname.includes('//')&&!/%/.test(u.pathname),'API URL路径不正确');
 let path=u.pathname.replace(/\/+$/,'');
 const endpoint=provider==='anthropic'?'/messages':'/chat/completions';
 const wrong=provider==='anthropic'?/\/(?:chat\/completions|responses)$/:/\/(?:messages|responses)$/;
 assert(!wrong.test(path),'API URL与所选协议不匹配，请选择对应协议或填写API基址');
 if(path.endsWith(endpoint))path=path.slice(0,-endpoint.length);
 u.pathname=path||'/v1';
 return u.href.replace(/\/$/,'');
}
export function transportPolicy(env,provider,baseUrl) {
 const host=new URL(baseUrl).hostname;
 const requested=env.AI_REQUEST_MODE||'auto';
 assert(['auto','modern','relay'].includes(requested),'服务端AI_REQUEST_MODE只能为auto、modern或relay');
 const modern=requested==='modern'||(requested==='auto'&&(provider==='anthropic'?host==='api.anthropic.com':host==='api.openai.com'));
 const tokenField=provider==='anthropic'?'max_tokens':(env.AI_TOKEN_PARAMETER||(modern?'max_completion_tokens':'max_tokens'));
 assert(['max_tokens','max_completion_tokens'].includes(tokenField),'服务端AI_TOKEN_PARAMETER不正确');
 const responseMode=env.AI_STRUCTURED_OUTPUT==='false'?'prompt':(env.AI_JSON_MODE||(modern?'json_schema':'prompt'));
 assert(['prompt','json_object','json_schema'].includes(responseMode),'服务端AI_JSON_MODE不正确');
 assert(provider!=='anthropic'||responseMode!=='json_object','Anthropic协议不支持json_object参数，请使用prompt或json_schema');
 return {requestMode:modern?'modern':'relay',tokenField,responseMode};
}
export function setOpenAiOutput(body,engine,schema=null,continuation=false) {
 body[engine.tokenField||'max_completion_tokens']=engine.outputTokens;
 const mode=engine.responseMode||(engine.structured?'json_schema':'prompt');
 if(schema&&!continuation&&mode==='json_schema')body.response_format={type:'json_schema',json_schema:{name:'cooperation_review',strict:true,schema}};
 else if(schema&&!continuation&&mode==='json_object')body.response_format={type:'json_object'};
 return body;
}
// Return our own troubleshooting text, never raw upstream JSON/HTML or echoed keys.
export function providerHttpMessage(status,{html=false}={}) {
 if(html)return `接口返回网页而不是模型JSON（HTTP ${status}），请核对API地址、/v1路径及中转站防护设置。`;
 const hints={400:'中转站或模型拒绝参数，请核对协议、模型ID及兼容模式',401:'API Key无效或已过期，请核对中转站密钥',402:'服务商账户额度不足或需要付费',403:'服务商拒绝访问，请核对Key权限、模型分组和站点防护',404:'接口路径或模型不存在，请核对API URL和中转站模型ID',413:'请求超过服务商容量，请缩小分析资料',422:'服务商不接受当前参数，请核对接口兼容模式',429:'服务商限流或额度不足，请核对该账号配额后稍后重试'};
 return `${hints[status]||(status>=500?'模型服务或中转站暂时异常，请稍后核对服务商状态':'未收到有效的模型响应，请核对协议和服务商配置')}（HTTP ${status}）。不会自动重试。`;
}
