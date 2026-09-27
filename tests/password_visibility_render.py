"""Account-password UI regression: real frontend, in-memory HTTP doubles, no secrets.
Run: npm run test:password-ui (requires Python Playwright and Chromium).
Does not exercise a live server, real account, mobile device or Cloudflare deployment.
"""
import json
import os
from pathlib import Path
import urllib.parse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts'
OUT.mkdir(exist_ok=True)
css = '\n'.join((ROOT/'public'/name).read_text() for name in ('styles.css', 'mobile.css'))
svg = 'data:image/svg+xml,' + urllib.parse.quote((ROOT/'public/favicon.svg').read_text())
html = (ROOT/'public/index.html').read_text().replace('<link rel="stylesheet" href="/styles.css">', '<style>'+css+'</style>').replace('<link rel="stylesheet" href="/mobile.css">', '').replace('<script type="module" src="/app.js"></script>', '').replace('/favicon.svg', svg)
code = (ROOT/'public/ai-ui.js').read_text().replace('export function', 'function')+'\n'+(ROOT/'public/app.js').read_text().replace("import { createAiUI } from './ai-ui.js';", '').replace('/favicon.svg', svg)
SETUP = r'''()=>{
 window.testWrites=[];window.testStorage={};window.failNextPassword=false;
 if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>String(Math.random())});
 Object.defineProperty(window,'localStorage',{value:{getItem:k=>window.testStorage[k]||null,setItem:(k,v)=>{window.testStorage[k]=v;}}});
 window.fetch=async(path,opt={})=>{
  if(opt.method&&opt.method!=='GET'){
   window.testWrites.push({path,body:JSON.parse(opt.body)});
   if(path==='/api/auth/password'&&window.failNextPassword){window.failNextPassword=false;return Response.json({error:'测试服务暂时不可用，请重试'},{status:503});}
   if(['/api/auth/reauth','/api/profile','/api/auth/password'].includes(path))return Response.json({ok:true});
   return Response.json({error:'测试禁止该写入'},{status:400});
  }
  if(path==='/api/auth/me')return Response.json({user:{id:'test-owner',name:'测试用户',phone:'',smsOptIn:false},csrf:'test-csrf'});
  if(path==='/api/projects')return Response.json({projects:[]});
  if(path.startsWith('/api/notifications'))return Response.json({items:[]});
  return Response.json({error:'未配置测试路径'},{status:404});
 };
}'''
CURRENT='Current-UI-Test-123!'
NEW='New-UI-Test-<>-&"123!'
checks=[]
errors=[]

def record(width,name):
    checks.append(f'{width}px: {name}')

def open_account(page,width):
    if width<=760 and not page.locator('[data-action="profile"]').is_visible(): page.locator('[data-action="menu"]').click()
    page.locator('[data-action="profile"]').click()
    page.get_by_role('heading',name='确认是你本人',exact=True).wait_for()
    return page.locator('dialog[open]').last

def authenticate(page,width):
    d=open_account(page,width)
    d.locator('[name="password"]').fill(CURRENT)
    d.get_by_role('button',name='验证身份',exact=True).click()
    page.get_by_role('heading',name='账号与通知偏好',exact=True).wait_for()
    return page.locator('#modal')

def closed(page):
    page.wait_for_function("!document.querySelector('#modal').open && document.querySelector('#modal input[name=newPassword]').value==='' ")

def assert_control(page,dialog,input,width,name):
    toggle=dialog.locator('.password-toggle')
    assert toggle.count()==1
    assert toggle.get_attribute('type')=='button'
    assert toggle.get_attribute('aria-controls')==input.get_attribute('id')
    assert dialog.locator('label[for="'+input.get_attribute('id')+'"]').count()==1
    assert toggle.bounding_box()['height']>=44
    assert toggle.bounding_box()['width']>=44
    geom=dialog.evaluate('d=>({w:innerWidth,left:d.getBoundingClientRect().left,right:d.getBoundingClientRect().right,scroll:d.querySelector(".modal-content").scrollWidth,client:d.querySelector(".modal-content").clientWidth})')
    assert geom['left']>=-1 and geom['right']<=geom['w']+1 and geom['scroll']<=geom['client']+1
    before=page.evaluate('testWrites.length')
    original=input.input_value()
    input.evaluate('e=>e.setSelectionRange(2,5)')
    toggle.click()
    assert input.get_attribute('type')=='text' and input.input_value()==original
    assert input.evaluate('e=>[e.selectionStart,e.selectionEnd]')==[2,5]
    assert toggle.inner_text()=='隐藏' and toggle.get_attribute('aria-label')=='隐藏'+name
    toggle.press('Enter')
    assert input.get_attribute('type')=='password'
    toggle.press('Space')
    assert input.get_attribute('type')=='text'
    assert page.evaluate('testWrites.length')==before
    assert page.evaluate('Object.keys(testStorage).length')==0
    assert input.get_attribute('spellcheck')=='false' and input.get_attribute('autocapitalize')=='none'
    record(width,name+'：点击/键盘切换不提交，不改输入值或光标，不持久化；标签和触控尺寸通过')

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
    for width,height in [(320,700),(390,844),(1440,1000)]:
        ctx=browser.new_context(viewport={'width':width,'height':height},has_touch=width<760,is_mobile=width<760)
        page=ctx.new_page()
        page.set_default_timeout(6000)
        page.on('pageerror',lambda err:errors.append(str(err)))
        page.route('**/*',lambda route:route.abort())
        page.set_content(html)
        page.evaluate(SETUP)
        page.add_script_tag(content=code,type='module')
        page.wait_for_selector('.app-shell')
        d=open_account(page,width)
        current=d.locator('[name="password"]')
        assert current.get_attribute('type')=='password' and current.input_value()==''
        current.fill(CURRENT)
        assert_control(page,d,current,width,'当前账号密码')
        d.get_by_role('button',name='取消',exact=True).click()
        d=authenticate(page,width)
        new=d.locator('[name="newPassword"]')
        assert new.get_attribute('type')=='password' and new.input_value()==''
        assert new.get_attribute('autocomplete')=='new-password' and new.get_attribute('maxlength')=='128'
        assert not new.evaluate('e=>e.required')
        record(width,'本人验证后新密码仍为空且隐藏；保留可选修改与自动填充语义')
        new.fill(NEW)
        assert_control(page,d,new,width,'新密码')
        assert new.evaluate('e=>new FormData(e.form).get("newPassword")')==NEW
        d.get_by_role('button',name='取消',exact=True).click()
        closed(page)
        assert new.get_attribute('type')=='password'
        d=authenticate(page,width)
        new=d.locator('[name="newPassword"]')
        assert new.get_attribute('type')=='password' and new.input_value()==''
        record(width,'取消/重新打开不保留密码值和显示状态，也不累加开关')
        count=page.evaluate('testWrites.filter(x=>x.path==="/api/auth/password").length')
        d.get_by_role('button',name='保存',exact=True).click()
        closed(page)
        assert page.evaluate('testWrites.filter(x=>x.path==="/api/auth/password").length')==count
        record(width,'新密码留空只保存原偏好，不请求密码修改')
        d=authenticate(page,width)
        new=d.locator('[name="newPassword"]')
        new.fill(NEW)
        d.get_by_role('button',name='显示新密码',exact=True).click()
        page.evaluate('window.failNextPassword=true')
        d.get_by_role('button',name='保存',exact=True).click()
        d.locator('.field-error').wait_for()
        assert new.get_attribute('type')=='password' and new.input_value()==NEW
        assert d.get_by_role('button',name='显示新密码',exact=True).count()==1
        record(width,'模拟提交失败时恢复隐藏但保留输入，可重试')
        d.get_by_role('button',name='显示新密码',exact=True).click()
        d.get_by_role('button',name='保存',exact=True).click()
        closed(page)
        assert page.evaluate('testWrites.filter(x=>x.path==="/api/auth/password").at(-1).body.password')==NEW
        assert new.get_attribute('type')=='password'
        record(width,'显示状态下提交原值不变，成功关闭后清空并隐藏')
        # Screenshots contain only masked, clearly synthetic test input.
        d=authenticate(page,width)
        d.locator('[name="newPassword"]').fill('Synthetic-example-123!')
        page.screenshot(path=str(OUT/f'password-visibility-{width}.png'),full_page=True)
        ctx.close()
    browser.close()
assert not errors,errors
report={'scope':'Offline Chromium, real frontend + explicit HTTP doubles; no live account/device/cloud deployment', 'passed':len(checks),'checks':checks,'pageErrors':errors}
(OUT/'password-visibility-results-v1.1.2.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'passed':len(checks),'pageErrors':errors},ensure_ascii=False))
