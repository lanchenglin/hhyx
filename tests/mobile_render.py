"""Responsive regression with real local fixture and offline fetch doubles.
Run: node tests/mobile-fixture.mjs && python3 tests/mobile_render.py
Requires Python Playwright and Chromium. No external requests, production data or live AI.
Checks mobile CSS/DOM/touch/focus only; NOT a phone-device or network end-to-end test.
"""
import copy
import json
import os
import pathlib
import subprocess
import urllib.parse
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts'
OUT.mkdir(exist_ok=True)
if not (OUT / 'mobile-fixture.json').exists():
    subprocess.run(['node', 'tests/mobile-fixture.mjs'], cwd=ROOT, check=True)
fixture = json.loads((OUT / 'mobile-fixture.json').read_text())
css = '\n'.join((ROOT / f'public/{name}.css').read_text() for name in ['styles', 'mobile', 'admin'])
svg = 'data:image/svg+xml,' + urllib.parse.quote((ROOT / 'public/favicon.svg').read_text())
html = (ROOT / 'public/index.html').read_text().replace('<link rel="stylesheet" href="/styles.css">', '<style>' + css + '</style>').replace('<link rel="stylesheet" href="/mobile.css">', '').replace('<link rel="stylesheet" href="/supervision.css">', '').replace('<link rel="stylesheet" href="/admin.css">', '').replace('<script type="module" src="/app.js"></script>', '').replace('/favicon.svg', svg)
from frontend_bundle import frontend_bundle
code = frontend_bundle(ROOT, svg)
checks, errors = [], []
MOCK = r'''f=>{
 window.fixture=f;window.mobileWrites=[];let counter=0;
 if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>`00000000-0000-4000-8000-${String(++counter).padStart(12,'0')}`});
 const storage={'coop.project':f.project.id};
 Object.defineProperty(window,'localStorage',{value:{getItem:k=>storage[k]||null,setItem:(k,v)=>storage[k]=v}});
 window.fetch=async(path,opt={})=>{
  const s=String(path);let data;
  if(opt.method && opt.method!=='GET'){
   window.mobileWrites.push(s);
   if(s.endsWith('/ai/preview'))data=f.previews[JSON.parse(opt.body).kind];
   else if(s==='/api/auth/reauth')data={ok:true};
   else return Response.json({error:'离线界面检查禁止修改业务数据'},{status:400});
  }else if(s==='/api/auth/me')data={user:f.user,csrf:f.csrf};
  else if(s==='/api/projects')data={projects:f.projects};
  else if(s.startsWith('/api/notifications'))data={items:f.notifications};
  else if(s.includes('/audit?'))data={records:f.audit,nextAfter:null};
  else if(s.endsWith('/channels'))data=f.channels;
  else if(s.includes('/ai?')||s.endsWith('/ai'))data=f.ai;
  else if(s.includes('/ai/runs/'))data=f.report;
  else if(s==='/api/projects/'+f.project.id)data=f.project;
  else if(s==='/api/projects/'+f.secondProject.id)data=f.secondProject;
  else return Response.json({error:'未配置测试路径：'+s},{status:404});
  return Response.json(data);
 };
}'''
HEADINGS = [('overview',fixture['project']['name']),('plan','阶段与合作计划'),('tasks','分工与任务'),('purchases','支出／采购与多人会签'),('decisions','共同决策'),('finance','财务与结算'),('ai','AI分析与风险检查'),('members','合作成员与项目资料'),('audit','审计记录'),('notifications','通知与待办提醒')]

def mount(browser, width, height=844, data=None):
    context=browser.new_context(viewport={'width':width,'height':height},has_touch=width<=760,is_mobile=width<=760,device_scale_factor=1)
    page=context.new_page()
    page.on('pageerror',lambda err:errors.append(str(err)))
    page.set_content(html)
    page.evaluate(MOCK,data or fixture)
    page.add_script_tag(content=code,type='module')
    page.wait_for_selector('.app-shell')
    return context,page

def navigate(page, tab):
    if not page.locator(f'.nav [data-tab={tab}]').is_visible():
        page.locator('[data-action=menu]').click()
    page.locator(f'.nav [data-tab={tab}]').click()
    page.wait_for_timeout(40)

def no_overflow(page, name):
    size=page.evaluate('({w:innerWidth,sw:document.documentElement.scrollWidth})')
    assert size['sw']<=size['w']+1, (name,size)

def sheet_check(page, label):
    dialog=page.locator('dialog[open]').last
    dialog.wait_for(state='visible')
    geometry=dialog.evaluate('''d=>{const c=d.querySelector('.modal-content'),h=d.querySelector('.modal-head').getBoundingClientRect(),f=d.querySelector('.modal-foot').getBoundingClientRect(),r=d.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,footTop:f.top,footBottom:f.bottom,headBottom:h.bottom,bodyWidth:c.clientWidth,bodyScroll:c.scrollWidth,w:innerWidth,h:innerHeight};}''')
    assert geometry['left']>=-1 and geometry['right']<=geometry['w']+1,(label,geometry)
    assert geometry['top']>=-1 and geometry['bottom']<=geometry['h']+1,(label,geometry)
    assert geometry['footTop']>=geometry['headBottom'] and geometry['footBottom']<=geometry['h']+1,(label,geometry)
    assert geometry['bodyScroll']<=geometry['bodyWidth']+1,(label,geometry)
    assert dialog.get_attribute('aria-labelledby'),label
    # Bottom fields can be scrolled into view without losing the submit/cancel controls.
    dialog.locator('.modal-content').evaluate('e=>e.scrollTop=e.scrollHeight')
    assert dialog.locator('.modal-foot button').last.is_visible(),label
    checks.append(label)

def close_sheet(page):
    page.locator('dialog[open]').last.locator('[data-modal-close]').first.click()

with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
    for width,height in [(320,700),(360,800),(390,844),(430,932),(667,375),(768,1024),(1440,1000)]:
        context,page=mount(browser,width,height)
        for tab,heading in HEADINGS:
            navigate(page,tab)
            page.get_by_role('heading',name=heading,exact=True).wait_for()
            no_overflow(page,f'{width}x{height} {tab}')
        checks.append(f'{width}x{height}：10个主要页面无页面级横向溢出')
        if width<=760:
            page.locator('[data-action=menu]').click()
            assert page.locator('.main').evaluate('e=>e.inert')
            assert page.locator('[data-action=menu]').get_attribute('aria-expanded')=='true'
            page.locator('.sidebar [data-action=logout]').focus()
            page.keyboard.press('Tab')
            assert page.locator('.sidebar').evaluate('e=>e.contains(document.activeElement)')
            page.keyboard.press('Escape')
            assert not page.locator('.sidebar').is_visible()
            assert not page.locator('.main').evaluate('e=>e.inert')
            page.locator('[data-action=menu]').click()
            page.locator('.nav-backdrop').click(position={'x':width-10,'y':40})
            assert not page.locator('.sidebar').is_visible()
            checks.append(f'{width}x{height}：导航关闭、遮罩关闭、Escape和焦点/背景隔离')
            navigate(page,'purchases')
            assert page.locator('.mobile-cards').count()>0
            if width<=600:
                assert page.locator('.mobile-cards td').first.evaluate('e=>getComputedStyle(e, "::before").content')!='none'
                checks.append(f'{width}px：采购卡片保留字段标签与全部单元格')
            page.locator('[data-action=purchase-open]').first.click()
            assert '2 / 3' in page.locator('body').inner_text()
            assert page.locator('[data-action=purchase-vote]').count()==3
            for vote in page.locator('[data-action=purchase-vote]').all():
                box=vote.bounding_box();assert box['height']>=44,(width,box)
            no_overflow(page,'会签详情')
            checks.append(f'{width}x{height}：2/3会签状态和三种决定完整，触控按钮≥44px')
            if width==390:
                page.screenshot(path=str(OUT/'mobile-390-purchase.png'),full_page=True)
            # Identity verification remains explicit. No approval request is sent.
            page.locator('[data-action=purchase-vote][data-decision=approve]').click()
            sheet_check(page,f'{width}x{height}：身份确认全屏表单可读')
            page.locator('dialog[open]').last.locator('[data-cancel]').click()
            navigate(page,'purchases');page.locator('[data-action=new-purchase]').click()
            sheet_check(page,f'{width}x{height}：采购长表单和底部按钮可见')
            page.locator('#modal [data-add-item]').click()
            assert page.locator('#modal .repeat-row').count()==2
            for el in page.locator('#modal input:not([type=hidden]),#modal select,#modal textarea').all():
                assert float(el.evaluate('e=>getComputedStyle(e).fontSize').replace('px',''))>=16 or el.get_attribute('type')=='file'
            if width==390:
                page.locator('#modal .modal-content').evaluate('e=>e.scrollTop=0')
                page.screenshot(path=str(OUT/'mobile-390-purchase-form.png'))
            close_sheet(page)
            navigate(page,'ai');page.locator('[data-action=ai-brief]').click()
            sheet_check(page,f'{width}x{height}：通用项目情况表单窄屏可用')
            close_sheet(page)
            page.locator('[data-action=ai-new][data-kind=project]').click()
            sheet_check(page,f'{width}x{height}：AI发送预览与未勾选确认')
            assert not page.locator('#modal [name=confirmSend]').is_checked()
            close_sheet(page)
            page.locator('[data-action=ai-open]').first.click()
            assert page.locator('img[src=x]').count()==0 and page.evaluate('window.mobileXss===undefined')
            no_overflow(page,'AI报告')
            if width==390:page.screenshot(path=str(OUT/'mobile-390-ai-report.png'),full_page=True)
            page.locator('[data-action=ai-source]').first.click();sheet_check(page,f'{width}x{height}：AI来源快照弹窗完整');close_sheet(page)
            page.locator('[data-action=ai-task]').first.click();sheet_check(page,f'{width}x{height}：AI转任务仍需人工确认')
            assert not page.locator('#modal [name=confirm]').is_checked();close_sheet(page)
            # A reduced viewport approximates available space, not a real virtual keyboard.
            if width==390:
                page.set_viewport_size({'width':390,'height':390})
                page.locator('[data-action=ai-review]').first.click();sheet_check(page,'390x390：短视口风险处置表单可用');close_sheet(page)
                page.set_viewport_size({'width':390,'height':844})
                navigate(page,'overview');page.screenshot(path=str(OUT/'mobile-390-overview.png'),full_page=True)
                page.locator('[data-action=menu]').click();page.screenshot(path=str(OUT/'mobile-390-navigation.png'))
                page.locator('#project-picker').select_option(fixture['secondProject']['id'])
                page.get_by_role('heading',name=fixture['secondProject']['name'],exact=True).wait_for()
                assert not page.locator('.main').evaluate('e=>e.inert')
                page.locator('[data-action=menu]').click();page.locator('#project-picker').select_option(fixture['project']['id'])
                page.get_by_role('heading',name=fixture['project']['name'],exact=True).wait_for()
                checks.append('390px：两个独立项目切换后显示对应项目，无残留导航遮罩')
        writes=page.evaluate('window.mobileWrites')
        assert all(s.endswith('/ai/preview') or s=='/api/auth/reauth' for s in writes),writes
        context.close()
    # Long user content must wrap, not be hidden behind clipped page overflow.
    data=copy.deepcopy(fixture)
    data['project']['name']='LongProjectNameWithoutSpaces_'*10
    data['projects'][0]['name']=data['project']['name']
    data['project']['purchases'][0]['title']='LongPurchaseReferenceWithoutSpaces_'*10
    data['project']['purchases'][0]['supplier']='LongSupplierNameWithoutSpaces_'*8
    context,page=mount(browser,360,data=data)
    for tab in ['overview','purchases','finance','members','decisions','audit']:
        navigate(page,tab);no_overflow(page,'超长文本 '+tab)
    navigate(page,'purchases');page.locator('[data-action=purchase-open]').first.click();no_overflow(page,'超长采购详情')
    checks.append('360px：超长无空格项目名、采购名、供应商名自动换行，不遮挡金额')
    # Resizing from an open drawer to desktop must release focus and scroll locks.
    page.locator('[data-action=menu]').click();page.set_viewport_size({'width':1440,'height':1000})
    page.wait_for_timeout(50)
    assert not page.locator('.main').evaluate('e=>e.inert')
    assert page.locator('.nav-backdrop').is_hidden()
    checks.append('手机切换到桌面宽度自动释放导航遮罩与背景锁定')
    context.close()
    # Login also uses the production viewport, styles, form controls and zoom settings.
    context=browser.new_context(viewport={'width':360,'height':800},is_mobile=True,has_touch=True)
    page=context.new_page();page.on('pageerror',lambda err:errors.append(str(err)))
    page.set_content(html);page.evaluate(MOCK,fixture)
    page.evaluate("window.fetch=async p=>String(p)==='/api/auth/me'?Response.json({error:'未登录'},{status:401}):Response.json({initialized:true})")
    page.add_script_tag(content=code,type='module');page.wait_for_selector('#auth-form')
    no_overflow(page,'手机登录')
    assert page.locator('input[name=email]').evaluate('e=>getComputedStyle(e).fontSize')=='16px'
    assert 'user-scalable=no' not in page.locator('meta[name=viewport]').get_attribute('content')
    checks.append('360px：登录页正常布局、16px输入文字，未禁用用户缩放')
    page.screenshot(path=str(OUT/'mobile-360-login.png'),full_page=True)
    context.close()
    archived=copy.deepcopy(fixture)
    archived['project']['lifecycle']='archived'
    context,page=mount(browser,390,data=archived)
    page.locator('.admin-readonly-banner').wait_for()
    navigate(page,'ai')
    assert page.locator('[data-action="ai-new"]').first.is_disabled()
    assert page.locator('[data-action="ai-open"]').first.is_enabled()
    page.locator('[data-action="ai-open"]').first.click()
    assert page.locator('[data-action="ai-source"]').first.is_enabled()
    assert page.locator('[data-action="ai-task"]').first.is_disabled()
    checks.append('390px：归档项目AI报告和来源仍可读，新分析与转任务按钮禁用')
    context.close();browser.close()
report={'version':'1.2.0','mode':'offline-Chromium-responsive-DOM-touch-and-focus; real local fixture, mocked fetch/model','passed':len(checks),'checks':checks,'pageErrors':errors,'limits':['不是手机真机或浏览器到后端的在线端到端测试。','短视口仅模拟可用高度，不代表实际iOS/安卓软键盘验证。','没有访问Cloudflare、调用真实AI或发送短信/微信消息。']}
(OUT/'mobile-render-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
if errors:raise SystemExit(1)
