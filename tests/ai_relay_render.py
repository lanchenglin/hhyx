"""Real frontend, explicit HTTP doubles. No service credentials or external calls."""
import json, os, urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright
from frontend_bundle import frontend_bundle
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'artifacts';OUT.mkdir(exist_ok=True)
fixture=json.loads((OUT/'admin-fixture.json').read_text())
css='\n'.join((ROOT/'public'/n).read_text() for n in ['styles.css','mobile.css','admin.css'])
svg='data:image/svg+xml,'+urllib.parse.quote((ROOT/'public/favicon.svg').read_text())
html=(ROOT/'public/index.html').read_text().replace('<link rel="stylesheet" href="/styles.css">','<style>'+css+'</style>').replace('<link rel="stylesheet" href="/mobile.css">','').replace('<link rel="stylesheet" href="/admin.css">','').replace('<script type="module" src="/app.js"></script>','').replace('/favicon.svg',svg)
code=frontend_bundle(ROOT,svg)
MOCK=r'''f=>{
 window.writes=[];window.fx=structuredClone(f);window.failSave=false;const r=fx.responses;
 const config=r['/api/admin/ai-settings'];config.baseUrl='https://relay.example.com/v1';config.model='deepseek-flash';config.enabled=false;
 let saved={'coop.project':fx.normalId};Object.defineProperty(window,'localStorage',{value:{getItem:k=>saved[k]||null,setItem:(k,v)=>saved[k]=v,removeItem:k=>delete saved[k]}});
 if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>String(Math.random())});
 window.fetch=async(path,options={})=>{
  if(options.method&&options.method!=='GET'){
   const body=JSON.parse(options.body||'{}');writes.push({path,body});
   if(path==='/api/admin/ai-settings'){
    if(failSave){failSave=false;return Response.json({error:'AI配置读取或保存未完成，请核对D1。诊断编号：synthetic-only',code:'AI_CONFIG_STORAGE_ERROR'},{status:503});}
    const next={...r[path],...body,keyConfigured:true,revision:r[path].revision+1};delete next.key;r[path]=next;return Response.json(next);
   }
   if(path==='/api/admin/ai-settings/test')return Response.json({ok:false,httpStatus:401,message:'API Key无效或已过期，请核对中转站密钥（HTTP 401）。不会自动重试。'});
   return Response.json({error:'Unexpected write in relay UI test'},{status:400});
  }
  if(r[path])return Response.json(r[path]);
  if(path.startsWith('/api/notifications'))return Response.json({items:[]});
  return Response.json({error:'Missing fixture'},{status:404});
 };
}'''
checks=[];errors=[]
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
 for width in [320,390,1440]:
  ctx=browser.new_context(viewport={'width':width,'height':900},has_touch=width<760,is_mobile=width<760)
  p=ctx.new_page();p.set_default_timeout(5000);p.on('pageerror',lambda e:errors.append(str(e)))
  p.route('**/*',lambda r:r.abort());p.set_content(html);p.evaluate(MOCK,fixture);p.add_script_tag(content=code,type='module');p.wait_for_selector('.app-shell')
  button=p.locator('[data-action=admin-open]')
  if not button.is_visible():p.locator('[data-action=menu]').click()
  button.click();p.locator('[data-action=admin-tab][data-section=ai]').click()
  p.locator('[data-action=admin-ai-edit]').click();d=p.locator('#modal');d.wait_for(state='visible')
  assert d.locator('[name=key]').input_value()==''
  assert not d.locator('[name=enabled]').is_checked()
  assert '中转站' in d.inner_text() and '不再重复输入密码' in d.inner_text()
  assert d.evaluate('d=>d.scrollWidth<=d.clientWidth+1')
  checks.append(f'{width}px: relay explanation and masked key, disabled state and no overflow')
  d.locator('[name=key]').fill('Synthetic-relay-key-123!');d.locator('[name=reason]').fill('合成配置，不发送真实请求')
  p.evaluate('failSave=true');d.get_by_role('button',name='保存配置').click();d.locator('.field-error').wait_for()
  assert 'CONFIG_ENCRYPTION_KEY' in d.locator('.field-error').inner_text()
  assert d.locator('[name=key]').get_attribute('type')=='password'
  assert not p.evaluate('writes.some(x=>x.path.includes("reauth")||x.path.includes("mfa"))')
  checks.append(f'{width}px: save failure is actionable, no password/MFA prompt, key remains masked')
  if width==390:p.screenshot(path=str(OUT/'relay-390-settings.png'),full_page=True)
  d.get_by_role('button',name='保存配置').click();p.wait_for_function('!document.querySelector("#modal").open')
  assert p.evaluate('fx.responses["/api/admin/ai-settings"].enabled') is False
  p.wait_for_function('document.querySelector("#modal [name=key]").value===""')
  assert not p.evaluate('writes.some(x=>x.path.endsWith("/test"))')
  checks.append(f'{width}px: save reuses login, does not test or enable AI, clears key after close')
  p.locator('[data-action=admin-ai-test]').click();d=p.locator('#modal');assert not d.locator('[name=confirmCost]').is_checked()
  d.locator('[name=confirmCost]').check();d.get_by_role('button',name='发起一次测试').click();d.locator('.field-error').wait_for()
  assert '401' in d.locator('.field-error').inner_text()
  assert '已保存' not in d.locator('.field-error').inner_text()
  assert p.evaluate('writes.filter(x=>x.path.endsWith("/test")).length')==1
  assert not p.evaluate('writes.some(x=>x.path.includes("reauth")||x.path.includes("mfa"))')
  checks.append(f'{width}px: explicit test consent, one request, useful HTTP error without reauthentication')
  d.locator('[data-modal-close]').first.click()
  p.locator('[data-action=admin-ai-guidance]').click();d=p.locator('#modal');d.locator('[name=analysisGuidance]').fill('优先关注现金安排');d.locator('[name=reason]').fill('合成偏好调整');d.get_by_role('button',name='保存').click();p.wait_for_function('!document.querySelector("#modal").open')
  assert not p.evaluate('writes.some(x=>x.path.includes("reauth"))');checks.append(f'{width}px: supplemental preference also saves without reauthentication')
  ctx.close()
 browser.close()
assert not errors,errors
result={'scope':'Offline Chromium, real frontend with explicit HTTP doubles; no real relay, Cloudflare, phone device or API key', 'passed':len(checks),'checks':checks,'pageErrors':errors}
(OUT/'ai-relay-render-v1.4.1.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2))
