// Test-only loopback HTTP server. Synthetic data + mocked provider; NEVER import from src/.
import http from 'node:http';
import { mkdir,writeFile } from 'node:fs/promises';
import worker from '../src/index.js';
import { fixture } from './helpers.mjs';
import { publicEngine } from '../src/ai-policy.js';
const f=await fixture();
Object.assign(f.rt.env,{AI_MODEL:'mock-browser-model',AI_API_KEY:'mock-browser-key',AI_INPUT_CENTS_PER_MILLION:'100',AI_OUTPUT_CENTS_PER_MILLION:'500'});
f.rt.env.AI_FETCH=async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({verdict:'needs_information',summary:'演示报告：<img src=x onerror=window.aiXss=1> 必须当作文本显示。',summaryRefs:['brief'],findings:[{id:'f1',severity:'high',basis:'missing',title:'缺少需求验证',detail:'当前资料未提供足够的试销记录。',refs:['brief'],evidence:[],suggestion:'先补齐试销依据。'}],missingInformation:[{topic:'试销数据',why:'尚未提供'}],recommendations:[{title:'补充试销验证资料',description:'由负责人整理试销记录',deliverable:'提交有来源的试销记录',refs:['brief']}],decisions:['共同确认是否继续试销'],limitations:['测试替身，不是真实模型结论。'],externalVerified:false})}}],usage:{prompt_tokens:1234,completion_tokens:567}});
let p=await f.owner.ok(f.base+'/ai/policy',{engineFingerprint:publicEngine(f.rt.env).fingerprint,confirmScope:true,monthlyCallLimit:30,monthlyBudgetCents:2000,autoPurchase:false,autoStage:false});
for(const c of f.all)await f.action(c,'proposal.vote',{id:p.proposals.at(-1).id,decision:'approve'});
await f.createPurchase();
const pre=await f.owner.ok(f.base+'/ai/preview',{kind:'project'});
await f.owner.ok(f.base+'/ai/runs',{kind:'project',previewHash:pre.hash,confirmSend:true});await f.rt.settle();
const visualProject=await f.owner.ok(f.base,undefined,'GET');
const ai=await f.owner.ok(f.base+'/ai',undefined,'GET');
const report=await f.owner.ok(f.base+'/ai/runs/'+ai.runs[0].id,undefined,'GET');
const previews={project:await f.owner.ok(f.base+'/ai/preview',{kind:'project'}),purchase:await f.owner.ok(f.base+'/ai/preview',{kind:'purchase',targetId:visualProject.purchases[0].id}),stage:await f.owner.ok(f.base+'/ai/preview',{kind:'stage',targetId:'stage-pilot'})};
await mkdir('artifacts',{recursive:true});
await writeFile('artifacts/ai-visual-fixture.json',JSON.stringify({user:{id:f.owner.user.id,name:f.owner.user.name,email:f.owner.user.email},project:visualProject,projects:[{id:f.pid,name:visualProject.name,status:'active',memberCount:3}],ai,report,previews,notifications:[],csrf:'offline-only'}));
if(process.argv.includes('--fixture-only')){await f.close();console.log('AI visual fixture created; no server started.');process.exit(0);}
const port=Number(process.env.PORT||8799);f.rt.env.APP_URL=`http://localhost:${port}`;
const server=http.createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const r=await worker.fetch(new Request(`http://localhost:${port}${req.url}`,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)}),f.rt.env,f.rt.ctx);res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));}catch{res.writeHead(500);res.end('test-server-error');}});
server.listen(port,'127.0.0.1',()=>console.log('AI integration browser test server ready on loopback'));
process.on('SIGTERM',()=>server.close(async()=>{await f.close();process.exit(0);}));
