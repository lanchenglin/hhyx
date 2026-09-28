import test from 'node:test';
import assert from 'node:assert/strict';
import {publicEngine} from '../src/ai-policy.js';
import {invokeProvider,probeProvider} from '../src/ai-provider.js';

const key='synthetic-redirect-test-key';
const baseUrl='https://relay.example.com/v1';
const location='https://redirect-target.example/collect?key='+key;
const upstream='private upstream redirect content '+key;
const snapshot={kind:'project',sources:[{id:'project',data:{name:'合成测试'}}]};

for(const provider of ['openai_compatible','anthropic']){
 for(const operation of ['probe','invoke']){
  test(`${provider} ${operation} rejects 302/307 and all other 3xx without following or exposing upstream data`,async()=>{
   for(let status=300;status<400;status++){
    const calls=[];let read=false,cancelled=false;
    const body=status===304?null:new ReadableStream({
     pull(controller){read=true;controller.enqueue(new TextEncoder().encode(upstream));controller.close();},
     cancel(){cancelled=true;}
    },{highWaterMark:0});
    const fetcher=async(url,opts)=>{
     calls.push({url,opts});
     // Workers rejects redirect:error before any upstream response is available.
     if(opts.redirect==='error')throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
     return new Response(body,{status,headers:{Location:location,'Content-Type':'text/html','X-Upstream-Secret':key}});
    };
    const env={AI_PROVIDER:provider,AI_BASE_URL:baseUrl,AI_MODEL:'test-model',AI_API_KEY:key,AI_FETCH:fetcher,AI_TEST_FETCH:fetcher};
    const engine=publicEngine(env);
    const result=operation==='probe'?await probeProvider(env,engine):await invokeProvider(env,engine,snapshot);
    assert.equal(calls.length,1,`HTTP ${status}: no follow-up or retry`);
    assert.equal(calls[0].url,baseUrl+(provider==='anthropic'?'/messages':'/chat/completions'));
    assert.equal(calls[0].opts.redirect,'manual',`HTTP ${status}: Workers-compatible no-follow mode`);
    assert.equal(calls[0].opts.headers[provider==='anthropic'?'x-api-key':'Authorization'],provider==='anthropic'?key:'Bearer '+key);
    if(operation==='probe'){
     assert.equal(result.ok,false);assert.equal(result.httpStatus,status);assert.equal(result.usageKnown,false);
     assert.match(result.message,/重定向/);
    }else{
     assert.equal(result.status,'failed');assert.equal(result.errorCode,'PROVIDER_HTTP_'+status);assert.equal(result.usage,null);
     assert.match(result.error,/重定向/);
    }
    const serialized=JSON.stringify(result);
    for(const secret of [key,location,upstream])assert.ok(!serialized.includes(secret),`HTTP ${status}: sanitized result`);
    assert.equal(read,false,`HTTP ${status}: do not read upstream body`);
    if(body)assert.equal(cancelled,true,`HTTP ${status}: cancel upstream body`);
   }
  });
 }
}
