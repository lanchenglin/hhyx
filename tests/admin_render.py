"""Offline Chromium admin UI checks with real frontend and explicit HTTP doubles.
Generate data first with `node tests/admin-fixture.mjs`. No network/model/cloud calls.
"""
import json, os, urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'artifacts'; OUT.mkdir(exist_ok=True)
fixture=json.loads((OUT/'admin-fixture.json').read_text())
css='\n'.join((ROOT/'public'/n).read_text() for n in ['styles.css','mobile.css','admin.css'])
svg='data:image/svg+xml,'+urllib.parse.quote((ROOT/'public/favicon.svg').read_text())
html=(ROOT/'public/index.html').read_text().replace('<link rel="stylesheet" href="/styles.css">','<style>'+css+'</style>').replace('<link rel="stylesheet" href="/mobile.css">','').replace('<link rel="stylesheet" href="/admin.css">','').replace('<script type="module" src="/app.js"></script>','').replace('/favicon.svg',svg)
from frontend_bundle import frontend_bundle
code = frontend_bundle(ROOT, svg)
MOCK=r'''({fixture,kind})=>{
 window.writes=[];window.saved={};window.f=structuredClone(fixture);window.mockFailure=false;
 if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>String(Math.random())});
 Object.defineProperty(window,'localStorage',{value:{getItem:k=>saved[k]||null,setItem:(k,v)=>saved[k]=v,removeItem:k=>delete saved[k]}});
 const r=f.responses;const me=r['/api/auth/me'];
 if(kind==='member'){me.user={...f.ordinary.user,systemRole:'member'};}
 if(kind==='forced')me.user.mustChangePassword=true;
 if(kind==='empty')r['/api/projects']={projects:[]};
 saved['coop.project']=f.normalId;
 window.fetch=async(path,opt={})=>{
  if(opt.method&&opt.method!=='GET'){
   const body=opt.body?JSON.parse(opt.body):{};writes.push({path,body});
   if(path==='/api/auth/reauth')return Response.json({ok:true});
   if(path==='/api/auth/password'){me.user.mustChangePassword=false;return Response.json({ok:true});}
   if(path==='/api/profile')return Response.json({ok:true});
   if(path==='/api/admin/ai-settings/test')return Response.json({ok:true,message:'测试替身：基础响应已收到（未联网）',usageKnown:true});
   if(path==='/api/admin/ai-settings'){
    const old=r[path];r[path]={...old,...body,revision:old.revision+1,keyConfigured:true};delete r[path].key;
    return Response.json(r[path]);
   }
   if(path.startsWith('/api/admin/'))return Response.json({ok:true,message:'测试替身已记录'});
   return Response.json({error:'未配置此写入的测试替身'},{status:400});
  }
  if(r[path])return Response.json(r[path]);
  if(path.startsWith('/api/admin/users?'))return Response.json(r['/api/admin/users']);
  if(path.startsWith('/api/notifications'))return Response.json(r['/api/notifications?limit=200']);
  if(path.endsWith('/audit/verify'))return Response.json({valid:true});
  if(path.endsWith('/audit?after=0&limit=200'))return Response.json({records:[],nextAfter:null});
  return Response.json({error:'Missing explicit fixture: '+path},{status:404});
 };
}'''
checks=[];errors=[]
def record(name): checks.append(name)
def mount(browser,width,kind='admin',height=844):
    ctx=browser.new_context(viewport={'width':width,'height':height},has_touch=width<=760,is_mobile=width<=760)
    p=ctx.new_page();p.set_default_timeout(5000);p.on('pageerror',lambda e:errors.append(str(e)))
    p.route('**/*',lambda r:r.abort());p.set_content(html);p.evaluate(MOCK,{'fixture':fixture,'kind':kind});p.add_script_tag(content=code,type='module')
    p.wait_for_selector('.password-required' if kind=='forced' else '.app-shell');return ctx,p
def admin(p):
    button=p.locator('[data-action="admin-open"]')
    if not button.is_visible():p.locator('[data-action="menu"]').click()
    button.click();p.locator('.admin-tabs').wait_for()
def tab(p,name):p.locator('[data-action="admin-tab"][data-section="'+name+'"]').click();p.wait_for_timeout(50)
def overflow(p,label):
    m=p.evaluate('({w:innerWidth,sw:document.documentElement.scrollWidth})');assert m['sw']<=m['w']+1,(label,m)
def sheet(p,label):
    d=p.locator('dialog[open]').last;d.wait_for()
    m=d.evaluate('d=>{const r=d.getBoundingClientRect(),c=d.querySelector(".modal-content");return {l:r.left,r:r.right,t:r.top,b:r.bottom,w:innerWidth,h:innerHeight,cw:c.clientWidth,sw:c.scrollWidth}}')
    assert m['l']>=-1 and m['r']<=m['w']+1 and m['t']>=-1 and m['b']<=m['h']+1 and m['sw']<=m['cw']+1,(label,m)
    return d
def close(p):p.locator('dialog[open]').last.locator('[data-modal-close]').first.click()
def reauth(p):
    d=p.locator('dialog[open]').last;d.get_by_role('heading',name='确认是你本人').wait_for();d.locator('[name="password"]').fill('Synthetic-current-password-123!');d.get_by_role('button',name='验证身份',exact=True).click()
with sync_playwright() as pw:
    b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
    for width,height in [(320,700),(390,844),(430,932),(768,1024),(1440,1000)]:
        ctx,p=mount(b,width,height=height);admin(p)
        for section in ['overview','projects','users','ai','audit']:
            tab(p,section);overflow(p,f'{width} {section}')
            assert p.locator('.admin-tabs .btn').first.bounding_box()['height']>=44
        record(f'{width}px：五个管理页面与移动导航可用，无页面级横向溢出')
        tab(p,'projects')
        for f in ['archived','trashed','all','active']:
            p.locator('[data-action="admin-filter"][data-filter="'+f+'"]').click();p.wait_for_timeout(40);overflow(p,f'{width} {f}')
        p.locator('[data-action="admin-inspect"]').first.click();d=sheet(p,'管理员只读审阅');assert not d.locator('[data-action="purchase-vote"]').count();close(p)
        p.locator('[data-action="admin-lifecycle"][data-operation="trash"]').first.click();d=sheet(p,'回收站确认')
        assert d.locator('[name="confirmName"]').input_value()=='' and not d.locator('[name="confirmImpact"]').is_checked()
        assert not p.evaluate('writes.filter(x=>x.path.includes("lifecycle")).length');close(p)
        record(f'{width}px：项目筛选、只读审阅和删除二次确认；打开表单不执行删除')
        tab(p,'users');p.locator('[data-action="admin-new-user"]').click();d=sheet(p,'新建用户')
        assert d.locator('[name="temporaryPassword"]').get_attribute('type')=='password'
        d.locator('[name="temporaryPassword"]').fill('Synthetic-temporary-123!');d.locator('.password-toggle').click();assert d.locator('[name="temporaryPassword"]').get_attribute('type')=='text';close(p)
        assert p.locator('#modal [name="temporaryPassword"]').input_value()==''
        p.locator('[data-action="admin-edit-user"]').last.click();d=sheet(p,'修改用户权限');assert d.locator('[name="confirmImpact"]').count()==1;close(p)
        record(f'{width}px：用户权限表单、临时密码显示切换、取消后清空')
        tab(p,'ai');assert 'mock-not-a-real-key' not in p.content()
        assert not p.evaluate('writes.some(x=>x.path.includes("ai-settings"))')
        p.locator('[data-action="admin-ai-edit"]').click();d=sheet(p,'AI配置')
        assert d.locator('[name="key"]').input_value()=='' and d.locator('[name="key"]').get_attribute('type')=='password'
        assert not d.locator('[name="key"]').locator('..').locator('.password-toggle').count()
        assert d.locator('[name="model"]').input_value()=='example-test-model'
        assert d.locator('[name="baseUrl"]').input_value()=='https://api.openai.com/v1'
        if width==390:p.screenshot(path=str(OUT/'admin-390-ai-settings.png'),full_page=True)
        d.locator('[name="key"]').fill('Synthetic-new-Key-123!');close(p)
        assert p.locator('#modal [name="key"]').input_value()==''
        p.locator('[data-action="admin-ai-test"]').click();d=sheet(p,'连接测试')
        assert not d.locator('[name="confirmCost"]').is_checked();d.get_by_role('button',name='发起一次测试').click();d.locator('.field-error').wait_for()
        assert not p.evaluate('writes.some(x=>x.path.endsWith("/ai-settings/test"))');close(p)
        record(f'{width}px：Key不回显/不持久化，配置和测试入口独立，测试不默认同意计费')
        if width in [390,1440]:
            tab(p,'projects');p.screenshot(path=str(OUT/f'admin-{width}-projects.png'),full_page=True)
            tab(p,'overview');p.screenshot(path=str(OUT/f'admin-{width}-overview.png'),full_page=True)
        ctx.close()
    ctx,p=mount(b,390);admin(p);tab(p,'ai');p.locator('[data-action="admin-ai-edit"]').click();d=sheet(p,'保存配置')
    d.locator('[name="reason"]').fill('虚构测试配置更新');d.locator('[name="key"]').fill('Synthetic-config-key-234!');d.get_by_role('button',name='加密保存配置').click();reauth(p)
    p.wait_for_function('writes.some(x=>x.path==="/api/admin/ai-settings")');p.wait_for_function('!document.querySelector("#modal").open')
    payload=p.evaluate('writes.find(x=>x.path==="/api/admin/ai-settings").body');assert 'inputCentsPerMillion' not in payload and 'outputCentsPerMillion' not in payload and 'outputTokens' not in payload and payload['expectedRevision']==1
    assert not p.evaluate('writes.some(x=>x.path.endsWith("/ai-settings/test"))');assert p.locator('#modal [name="key"]').input_value()==''
    p.locator('[data-action="admin-ai-test"]').click();p.locator('#modal [name="confirmCost"]').check();p.locator('#modal').get_by_role('button',name='发起一次测试').click();reauth(p)
    p.wait_for_function('writes.some(x=>x.path.endsWith("/ai-settings/test"))');assert p.evaluate('writes.filter(x=>x.path.endsWith("/ai-settings/test")).length')==1
    record('配置保存通过本人验证、无需填写价格/长度且校验版本；保存不测试，单独确认才发起一次测试请求');ctx.close()
    ctx,p=mount(b,390,kind='member');assert p.locator('[data-action="admin-open"]').count()==0;assert p.locator('.admin-tabs').count()==0;record('普通用户没有管理员导航或配置控件');ctx.close()
    ctx,p=mount(b,390,kind='empty');p.locator('.admin-tabs').wait_for();record('管理员无项目时仍自动进入管理后台，不被项目列表阻挡');ctx.close()
    ctx,p=mount(b,390,kind='forced');assert not p.locator('.app-shell').count();assert not p.evaluate('writes.length')
    p.locator('[name="current"]').fill('Temporary-test-123!');p.locator('[name="password"]').fill('Changed-Strong-123!');p.locator('[name="confirm"]').fill('Different-value-123!');p.get_by_role('button',name='修改后进入').click()
    assert p.locator('#required-password-error').inner_text()=='两次输入的新密码不一致';assert not p.evaluate('writes.length')
    p.locator('[name="confirm"]').fill('Changed-Strong-123!');p.get_by_role('button',name='修改后进入').click();p.locator('.app-shell').wait_for()
    assert p.evaluate('writes.map(x=>x.path)')==['/api/auth/reauth','/api/auth/password'];record('首次临时密码强制修改页：不一致不提交，通过本人核验并修改后才进入业务');ctx.close()
    b.close()
assert not errors,errors
report={'scope':'Offline Chromium: real frontend, explicit HTTP doubles, synthetic fixture; no real device or cloud/API calls','passed':len(checks),'checks':checks,'pageErrors':errors}
(OUT/'admin-render-results-v1.2.0.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False,indent=2))
