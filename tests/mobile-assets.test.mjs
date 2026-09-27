import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {runtime} from '../scripts/local-runtime.mjs';
async function asset(path){
  const rt=await runtime({memory:true});
  try{return await worker.fetch(new Request('http://localhost:8787'+path),rt.env,rt.ctx);}
  finally{await rt.settle();rt.close();}
}
test('手机入口加载响应式样式，声明安全区且不禁止缩放',async()=>{
  const res=await asset('/');assert.equal(res.status,200);
  const html=await res.text();assert.match(html,/href="\/mobile\.css"/);
  assert.match(html,/viewport-fit=cover/);assert.match(html,/interactive-widget=resizes-content/);
  assert.doesNotMatch(html,/user-scalable=no|maximum-scale=1(?:[",])/);
});
test('本地开发入口返回真正的mobile.css，而不是HTML回退页',async()=>{
  const res=await asset('/mobile.css');assert.equal(res.status,200);
  assert.match(res.headers.get('content-type'),/^text\/css/);
  const css=await res.text();assert.match(css,/\.mobile-cards/);assert.match(css,/safe-area-inset-bottom/);
  assert.doesNotMatch(css,/<!doctype html>/i);
});
test('移动端继续加载原业务入口，资源响应保留CSP',async()=>{
  const res=await asset('/app.js');assert.equal(res.status,200);
  assert.match(res.headers.get('content-type'),/^text\/javascript/);
  assert.match(res.headers.get('content-security-policy'),/script-src 'self'/);
  const js=await res.text();assert.match(js,/from '\.\/ai-ui\.js'/);assert.match(js,/setMenuOpen/);
  assert.match(js,/purchase-vote/);
});
