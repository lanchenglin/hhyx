import http from 'node:http';
import {readFile,writeFile,access} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import worker from '../src/index.js';
import {runtime,ROOT} from './local-runtime.mjs';
const port=Number(process.env.PORT||8787),host='127.0.0.1';
let raw;
try{raw=await readFile(path.join(ROOT,'.dev.vars'),'utf8');}catch{
 raw=`APP_URL=http://localhost:${port}\nBOOTSTRAP_TOKEN=${randomBytes(32).toString('base64url')}\nCONFIG_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`;
 await writeFile(path.join(ROOT,'.dev.vars'),raw,{mode:0o600});
 console.log('已生成本地初始化口令及加密密钥：.dev.vars（不要提交到 Git）');
}
const vars=Object.fromEntries(raw.split(/\r?\n/).filter(l=>l.trim()&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));
vars.APP_URL=`http://localhost:${port}`;
const rt=await runtime({vars});
const server=http.createServer(async(req,res)=>{
 try{
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>11*1024*1024){res.writeHead(413);res.end('请求过大');return;}chunks.push(chunk);}
  const request=new Request(`http://localhost:${port}${req.url}`,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)});
  const response=await worker.fetch(request,rt.env,rt.ctx);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(req.method==='HEAD'?undefined:Buffer.from(await response.arrayBuffer()));
 }catch(e){console.error(e);res.writeHead(500);res.end('local runtime error');}
});
server.listen(port,host,()=>console.log(`合伙有序（本地开发） http://localhost:${port}\n初始化口令见 .dev.vars 的 BOOTSTRAP_TOKEN\n正式部署使用 Workers；本地不会自动发送通知，除非你配置渠道。`));
const timer=setInterval(()=>worker.scheduled({},rt.env,rt.ctx).catch(e=>console.error('scheduled',e)),600000);timer.unref();
process.on('SIGTERM',()=>server.close(()=>{rt.close();process.exit(0);}));
