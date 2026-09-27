"""Account password visibility regression; offline real frontend + HTTP doubles.
No real passwords, accounts, model requests, servers or cloud resources are used.
"""
import json,os,urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]; OUT=ROOT/'artifacts';OUT.mkdir(exist_ok=True)
css='\n'.join((ROOT/'public'/n).read_text() for n in ['styles.css','mobile.css','admin.css'])
svg='data:image/svg+xml,'+urllib.parse.quote((ROOT/'public/favicon.svg').read_text())
html=(ROOT/'public/index.html').read_text().replace('<link rel="stylesheet" href="/styles.css">','<style>'+css+'</style>').replace('<link rel="stylesheet" href="/mobile.css">','').replace('<link rel="stylesheet" href="/admin.css">','').replace('<script type="module" src="/app.js"></script>','').replace('/favicon.svg',svg)
code='\n'.join((ROOT/'public'/n).read_text().replace('export function','function') for n in ['admin-ui.js','ai-ui.js'])+'\n'+(ROOT/'public/app.js').read_text().replace("import { createAdminUI } from './admin-ui.js';",'').replace("import { createAiUI } from './ai-ui.js';",'').replace('/favicon.svg',svg)
SETUP=r'''()=>{
 window.testWrites=[];window.testStorage={};window.failNextPassword=false;
 if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>String(Math.random())});
 Object.defineProperty(window,'localStorage',{value:{getItem:k=>testStorage[k]||null,setItem:(k,v)=>testStorage[k]=v}});
 window.fetch=async(path,opt={})=>{
  if(opt.method&&opt.method!=='GET'){
   testWrites.push({path,body:JSON.parse(opt.body)});
   if(path==='/api/auth/password'&&failNextPassword){failNextPassword=false;return Response.json({error:'模拟服务失败'},{status:503});}
   if(['/api/auth/reauth','/api/profile','/api/auth/password'].includes(path))return Response.json({ok:true});
   return Response.json({error:'Unexpected write in UI test'},{status:400});
  }
  if(path==='/api/auth/me')return Response.json({user:{id:'synthetic-user',name:'测试用户',phone:'',smsOptIn:false,systemRole:'member'},csrf:'test-csrf'});
  if(path==='/api/projects')return Response.json({projects:[]});
  if(path.startsWith('/api/notifications'))return Response.json({items:[]});
  return Response.json({error:'Unconfigured UI test endpoint'},{status:404});
 };
}'''
checks=[];errors=[];CURRENT='Current-UI-Test-123!';NEW='New-UI-Test-<>-&"123!'
def record(w,s):checks.append(f'{w}px：{s}')
def open_account(p,w):
    if not p.locator('[data-action="profile"]').is_visible():p.locator('[data-action="menu"]').click()
    p.locator('[data-action="profile"]').click();p.get_by_role('heading',name='确认是你本人',exact=True).wait_for();return p.locator('dialog[open]').last
def authenticate(p,w):
    d=open_account(p,w);d.locator('[name="password"]').fill(CURRENT);d.get_by_role('button',name='验证身份',exact=True).click()
    p.get_by_role('heading',name='账号与通知偏好',exact=True).wait_for();return p.locator('#modal')
def closed(p):p.wait_for_function('!document.querySelector("#modal").open && document.querySelector("#modal input[name=newPassword]").value===""')
def control(p,d,i,w,label):
    t=d.locator('.password-toggle');assert t.count()==1 and t.get_attribute('type')=='button'
    assert t.get_attribute('aria-controls')==i.get_attribute('id');assert d.locator('label[for="'+i.get_attribute('id')+'"]').count()==1
    assert t.bounding_box()['width']>=44 and t.bounding_box()['height']>=44
    geo=d.evaluate('d=>({w:innerWidth,left:d.getBoundingClientRect().left,right:d.getBoundingClientRect().right,scroll:d.querySelector(".modal-content").scrollWidth,client:d.querySelector(".modal-content").clientWidth})')
    assert geo['left']>=-1 and geo['right']<=geo['w']+1 and geo['scroll']<=geo['client']+1
    count=p.evaluate('testWrites.length');value=i.input_value();i.evaluate('e=>e.setSelectionRange(2,5)')
    t.click();assert i.get_attribute('type')=='text' and i.input_value()==value and i.evaluate('e=>[e.selectionStart,e.selectionEnd]')==[2,5]
    assert t.get_attribute('aria-label')=='隐藏'+label;t.press('Enter');assert i.get_attribute('type')=='password';t.press('Space');assert i.get_attribute('type')=='text'
    assert p.evaluate('testWrites.length')==count and p.evaluate('Object.keys(testStorage).length')==0
    record(w,label+'点击/键盘切换不提交，保留原值和选区；触控/标签/布局通过')
with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
    for w,h in [(320,700),(390,844),(1440,1000)]:
        ctx=browser.new_context(viewport={'width':w,'height':h},has_touch=w<=760,is_mobile=w<=760);p=ctx.new_page();p.set_default_timeout(5000)
        p.on('pageerror',lambda e:errors.append(str(e)));p.route('**/*',lambda r:r.abort());p.set_content(html);p.evaluate(SETUP);p.add_script_tag(content=code,type='module');p.wait_for_selector('.app-shell')
        d=open_account(p,w);i=d.locator('[name="password"]');assert i.input_value()=='' and i.get_attribute('type')=='password';i.fill(CURRENT);control(p,d,i,w,'当前账号密码');d.get_by_role('button',name='取消',exact=True).click()
        d=authenticate(p,w);i=d.locator('[name="newPassword"]');assert i.input_value()=='' and i.get_attribute('type')=='password' and i.get_attribute('autocomplete')=='new-password' and i.get_attribute('maxlength')=='128';assert not i.evaluate('e=>e.required');record(w,'本人验证后新密码默认隐藏且可留空')
        i.fill(NEW);control(p,d,i,w,'新密码');d.get_by_role('button',name='取消',exact=True).click();closed(p)
        d=authenticate(p,w);i=d.locator('[name="newPassword"]');assert i.input_value()=='' and i.get_attribute('type')=='password';record(w,'取消/再次打开清空并隐藏，不重复添加控件')
        n=p.evaluate('testWrites.filter(x=>x.path==="/api/auth/password").length');d.get_by_role('button',name='保存',exact=True).click();closed(p);assert p.evaluate('testWrites.filter(x=>x.path==="/api/auth/password").length')==n;record(w,'留空不修改密码')
        d=authenticate(p,w);i=d.locator('[name="newPassword"]');i.fill(NEW);d.get_by_role('button',name='显示新密码').click();p.evaluate('failNextPassword=true');d.get_by_role('button',name='保存',exact=True).click();d.locator('.field-error').wait_for();assert i.get_attribute('type')=='password' and i.input_value()==NEW;record(w,'模拟请求失败隐藏但保留输入，可再次提交')
        d.get_by_role('button',name='显示新密码').click();d.get_by_role('button',name='保存',exact=True).click();closed(p);assert p.evaluate('testWrites.filter(x=>x.path==="/api/auth/password").at(-1).body.password')==NEW;record(w,'显示状态提交原值，成功后清空')
        ctx.close()
    browser.close()
assert not errors,errors
report={'scope':'Offline Chromium; real frontend + explicit HTTP doubles, no live account/device/cloud tests','passed':len(checks),'checks':checks,'pageErrors':errors}
(OUT/'password-visibility-results-v1.2.0.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False))
