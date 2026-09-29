// Local integration harness only. Binds an ephemeral loopback port with synthetic accounts.
// Does not run against a production database, call models or send external messages.
import {createServer} from 'node:http';
import worker from '../src/index.js';
import {supervisionFixture} from './supervision-fixture.mjs';
import {mkdir,writeFile} from 'node:fs/promises';

const fixture=await supervisionFixture(),{f}=fixture;
const server=createServer(async(req,res)=>{
  try {
    const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>11000000)throw Error('test request too large');chunks.push(part);}
    const request=new Request(f.rt.env.APP_URL+req.url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)});
    const response=await worker.fetch(request,f.rt.env,f.rt.ctx);
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500,{'content-type':'application/json'});res.end('{"error":"local test adapter error"}');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port;f.rt.env.APP_URL=url;
await mkdir('artifacts',{recursive:true});
await writeFile('artifacts/supervision-live-fixture.json',JSON.stringify({url,projectId:f.pid,project:fixture.project,accounts:fixture.accounts},null,2),{mode:0o600});
console.log(JSON.stringify({ready:true,url,projectId:f.pid}));
let closing=false;
async function stop(){if(closing)return;closing=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fixture.close();process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
