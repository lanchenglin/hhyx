"""Grouped sidebar regression via actual loopback HTTP and the real frontend.
Uses only isolated synthetic fixture accounts, never production or model providers.
"""
import json, os, subprocess, time
from pathlib import Path
from playwright.sync_api import sync_playwright
from navigation_helpers import click_project_tab, reveal_sidebar_control

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'artifacts';OUT.mkdir(exist_ok=True)
fixture_file=OUT/'supervision-live-fixture.json';fixture_file.unlink(missing_ok=True)
checks=[];errors=[]
log=open(OUT/'navigation-server.log','w')
server=subprocess.Popen([os.environ.get('NODE','node'),'tests/supervision-server.mjs'],cwd=ROOT,stdout=log,stderr=log)
ROUTES=['supervision','overview','plan','tasks','reports','changes','purchases','funding','decisions','finance','issues','ai','members','continuity','audit','notifications']
SIZES=[(320,700),(360,800),(390,844),(430,932),(667,375),(768,1024),(1440,1000),(1440,500)]

def record(w,text):checks.append(str(w)+'px: '+text)
def menu(p):
    if not p.locator('.sidebar').is_visible():p.locator('[data-action=menu]').click()

def fit(p):
    x=p.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
    assert x['scroll']<=x['width']+1,x

def wait_tab(p,tab):
    p.wait_for_function('(key)=>document.querySelector(".sidebar [aria-current=page]")?.dataset.tab===key',arg=tab)

def login(browser,index,width,height):
    ctx=browser.new_context(viewport={'width':width,'height':height},is_mobile=width<=760,has_touch=width<=760)
    p=ctx.new_page();p.set_default_timeout(9000);p.on('pageerror',lambda err:errors.append(str(err)))
    p.goto(fx['url'],wait_until='networkidle')
    p.locator('#auth-form [name=email]').fill(fx['accounts'][index]['email'])
    p.locator('#auth-form [name=password]').fill(fx['accounts'][index]['password'])
    p.locator('#auth-form button[type=submit]').click();p.wait_for_selector('.app-shell');wait_tab(p,'supervision')
    return ctx,p

try:
    deadline=time.time()+35
    while not fixture_file.exists() and time.time()<deadline:
        if server.poll() is not None:raise RuntimeError('Test server did not start; see navigation-server.log')
        time.sleep(.1)
    fx=json.loads(fixture_file.read_text())
    with sync_playwright() as pw:
        browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
        for width,height in SIZES:
            ctx,p=login(browser,0,width,height);menu(p)
            groups=p.locator('.nav-group');assert groups.count()==5
            assert p.locator('.nav-group[open]').count()==1
            assert p.locator('.nav-group[open]').get_attribute('data-nav-group')=='overview'
            assert p.locator('.sidebar [data-tab]').evaluate_all('(els)=>els.map(x=>x.dataset.tab)')==ROUTES
            assert p.locator('.sidebar [aria-current=page]').count()==1
            assert p.locator('.sidebar [data-tab] svg').evaluate_all('(els)=>els.every(x=>x.innerHTML!==\'<path d="m5 12 4 4L20 5"></path>\')')
            record(width,'五组分类、16个原页面完整保留；初始仅展开总览，独立图标及唯一当前页标记')
            # Native keyboard and pointer disclosure must not cause fetches/writes or close mobile drawer.
            requests=[]
            p.on('request',lambda r,items=requests:items.append(r.method+' '+r.url.split('?')[0]))
            before=len(requests)
            header=p.locator('[data-nav-group=execution] > summary');header.focus();header.press('Enter')
            p.wait_for_function('document.querySelector("[data-nav-group=execution]").open')
            header.press('Space');p.wait_for_function('!document.querySelector("[data-nav-group=execution]").open')
            p.locator('[data-nav-group=funds] > summary').click();p.wait_for_timeout(30)
            assert p.locator('.nav-group[open]').count()==1
            assert p.locator('.nav-group[open]').get_attribute('data-nav-group')=='funds'
            assert len(requests)==before
            if width<=760:assert p.locator('.main').evaluate('e=>e.inert')
            record(width,'鼠标及Enter/空格展开折叠正常；同时只展开一组，分组操作不发送请求')
            for tab in ROUTES:
                click_project_tab(p,tab);wait_tab(p,tab);fit(p)
                if tab!='notifications':
                    assert p.locator('.nav-group[open] [data-tab="'+tab+'"]').count()==1
                assert p.locator('.sidebar [aria-current=page]').count()==1
                assert not p.locator('.main').evaluate('e=>e.inert')
                if width<=760:assert not p.locator('.sidebar').is_visible()
            record(width,'16个原页面经真实HTTP逐个可达；自动定位当前分组，选择后手机菜单关闭且背景解锁')
            click_project_tab(p,'funding');wait_tab(p,'funding');menu(p)
            if height>620:
                assert p.locator('.sidebar').evaluate('e=>e.scrollHeight<=e.clientHeight+1')
                r=p.locator('.sidebar-footer').bounding_box();assert r['y']>=0 and r['y']+r['height']<=height+1,r
            else:
                p.locator('.sidebar [data-action=logout]').scroll_into_view_if_needed()
                r=p.locator('.sidebar [data-action=logout]').bounding_box();assert r['y']>=0 and r['y']+r['height']<=height+1,r
            record(width,'通知和账号入口始终可达；常规高度独立滚动菜单，横屏/短窗口可滚动整个侧栏')
            if width in [390,1440] and height>620:
                p.locator('.sidebar .project-picker').scroll_into_view_if_needed()
                p.locator('[data-nav-group=funds] > summary').scroll_into_view_if_needed()
                p.screenshot(path=str(OUT/f'navigation-{width}.png'))
                p.locator('.sidebar').screenshot(path=str(OUT/f'navigation-sidebar-{width}.png'))
            if width<=760:
                p.keyboard.press('Escape');assert not p.locator('.sidebar').is_visible()
                assert p.locator('[data-action=menu]').evaluate('e=>e===document.activeElement')
                menu(p);p.locator('[data-nav-group=risk] > summary').focus();p.keyboard.press('Tab')
                assert p.locator('.sidebar').evaluate('e=>e.contains(document.activeElement)')
                p.locator('.nav-backdrop').click(position={'x':width-2,'y':100})
                assert not p.locator('.main').evaluate('e=>e.inert')
                menu(p);p.set_viewport_size({'width':1200,'height':850});p.wait_for_timeout(50)
                assert not p.locator('.main').evaluate('e=>e.inert')
                assert not p.locator('.sidebar').evaluate('e=>e.classList.contains("open")')
                record(width,'抽屉Escape/遮罩/焦点限制与切换宽屏正常，不遗留背景锁定')
            ctx.close()
        # Direct links should open the right group, not depend on prior expanded state.
        ctx,p=login(browser,1,390,844)
        assert p.locator('[data-action=admin-open]').count()==0
        for tab in ['funding','reports','ai','continuity']:
            p.goto(fx['url']+'/#project='+fx['projectId']+'&tab='+tab,wait_until='networkidle');p.reload(wait_until='networkidle');wait_tab(p,tab);menu(p)
            assert p.locator('.nav-group[open] [data-tab='+tab+']').count()==1
        record(390,'普通合伙人无系统管理入口；追加/汇报/AI/移交旧直达链接刷新后自动展开对应组')
        ctx.close()
        ctx,p=login(browser,0,390,844);menu(p)
        p.locator('.sidebar [data-action=admin-open]').click();p.wait_for_selector('.admin-tabs')
        assert p.locator('.sidebar [aria-current=page]').get_attribute('data-action')=='admin-open'
        assert p.locator('.sidebar [data-tab][aria-current=page]').count()==0
        click_project_tab(p,'reports');wait_tab(p,'reports')
        assert p.locator('.admin-tabs').count()==0
        menu(p);p.locator('#project-picker').select_option('')
        menu(p);assert p.locator('.nav-empty').count()==1
        assert p.locator('.sidebar [data-tab=notifications]').is_disabled()
        assert p.locator('.sidebar [data-action=admin-open]').is_enabled()
        assert p.locator('.sidebar [data-action=security-open]').is_enabled()
        p.locator('#project-picker').select_option(fx['projectId']);wait_tab(p,'reports');menu(p)
        assert p.locator('.nav-group[open]').get_attribute('data-nav-group')=='execution'
        record(390,'系统管理不误标项目页；返回项目、未选择项目和重新选择均正常，账号入口保留')
        ctx.close();browser.close()
    assert not errors,errors
    result={'version':'1.5.1','scope':'Real Chromium -> loopback HTTP -> actual Worker handlers, isolated SQLite test adapter. No production or real phone/provider calls.', 'passed':len(checks),'checks':checks,'pageErrors':errors,'viewports':[f'{w}x{h}' for w,h in SIZES]}
    (OUT/'navigation-results-v1.5.1.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'passed':len(checks),'pageErrors':errors},ensure_ascii=False))
finally:
    server.terminate()
    try:server.wait(timeout=10)
    except subprocess.TimeoutExpired:server.kill();server.wait(timeout=5)
    log.close()
