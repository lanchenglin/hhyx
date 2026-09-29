"""Real browser -> loopback HTTP -> Worker source -> isolated SQLite integration.
No production resources, model calls, notification credentials or real accounts.
Python Playwright + Chromium and Node >=22.16 are required; no tools installed here.
"""
import json, os, subprocess, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'artifacts';OUT.mkdir(exist_ok=True)
fixture_path=OUT/'supervision-live-fixture.json'
fixture_path.unlink(missing_ok=True)
checks=[];errors=[]
log=open(OUT/'supervision-server.log','w')
server=subprocess.Popen([os.environ.get('NODE','node'),'tests/supervision-server.mjs'],cwd=ROOT,stdout=log,stderr=log)

def record(name): checks.append(name)
def fit(page,modal=False):
    shape=page.evaluate('''()=>{const d=document.querySelector('dialog[open]'),c=d?.querySelector('.modal-content');return {width:innerWidth,scroll:document.documentElement.scrollWidth,left:d?.getBoundingClientRect().left,right:d?.getBoundingClientRect().right,cw:c?.clientWidth,sw:c?.scrollWidth};}''')
    assert shape['scroll']<=shape['width']+1,shape
    if modal:
        assert shape['left']>=-1 and shape['right']<=shape['width']+1 and shape['sw']<=shape['cw']+1,shape

def login(browser,account,width=390,height=844):
    ctx=browser.new_context(viewport={'width':width,'height':height},is_mobile=width<760,has_touch=width<760)
    page=ctx.new_page();page.set_default_timeout(10000)
    page.on('pageerror',lambda err:errors.append(str(err)))
    page.goto(fx['url'],wait_until='networkidle')
    page.locator('#auth-form [name=email]').fill(account['email'])
    page.locator('#auth-form [name=password]').fill(account['password'])
    page.locator('#auth-form button[type=submit]').click()
    page.wait_for_selector('.app-shell')
    page.get_by_role('heading',name='出资人总览',exact=True).wait_for()
    return ctx,page

def tab(page,name):
    nav=page.locator('.sidebar')
    if page.viewport_size['width']<=760 and not nav.locator('[data-tab="'+name+'"]').is_visible():page.locator('[data-action=menu]').click()
    nav.locator('[data-tab="'+name+'"]').click()
    page.wait_for_timeout(60)

def dialog(page,title=None):
    d=page.locator('#modal');d.wait_for(state='visible')
    if title: d.get_by_role('heading',name=title,exact=True).wait_for()
    return d

def close(page):
    d=page.locator('#modal');d.locator('[data-modal-close]').first.click();page.locator("#modal[open]").wait_for(state="hidden")

def save(page):
    page.locator('#modal button[type=submit]').click()
    try:
        page.locator("#modal[open]").wait_for(state="hidden")
    except Exception:
        print('FORM FAILURE:', page.locator('#modal #form-error').inner_text())
        print('INVALID FIELDS:',page.locator('#modal :invalid').evaluate_all('(els)=>els.map(e=>({name:e.name,message:e.validationMessage}))'))
        page.screenshot(path=str(OUT/'supervision-form-failure.png'),full_page=True)
        raise

def refresh(page,name):
    page.goto(fx['url']+'/#project='+fx['projectId']+'&tab='+name,wait_until='networkidle')
    page.reload(wait_until='networkidle')
    page.wait_for_selector('.app-shell')

def project(page):
    return page.evaluate('(id)=>fetch("/api/projects/"+id).then(r=>r.json())',fx['projectId'])

def approve(page,account,pledge=False,try_without=False):
    tab(page,'decisions')
    page.locator('[data-action=proposal-vote][data-decision=approve]').first.click()
    auth=page.locator('dialog[open]').last
    auth.get_by_role('heading',name='确认是你本人',exact=True).wait_for()
    auth.locator('[name=password]').fill(account['password'])
    auth.get_by_role('button',name='验证身份',exact=True).click()
    d=dialog(page,'确认同意此项共同决策')
    box=d.locator('[name=acceptFunding]')
    if pledge:
        assert box.count()==1 and not box.is_checked()
        if try_without:
            d.locator('button[type=submit]').click();d.locator('.field-error').wait_for()
            assert not box.is_checked()
            record('个人追加分担不勾选时前端阻止；没有自动把项目批准当作个人承诺')
        box.check()
    else: assert box.count()==0
    save(page)

try:
    deadline=time.time()+35
    while not fixture_path.exists() and time.time()<deadline:
        if server.poll() is not None:raise RuntimeError('local test server did not start; see artifacts/supervision-server.log')
        time.sleep(.1)
    assert fixture_path.exists(),'local fixture was not ready'
    fx=json.loads(fixture_path.read_text())
    with sync_playwright() as pw:
        browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True)
        for width,height in [(320,700),(390,844),(768,1024),(1440,1000)]:
            ctx,page=login(browser,fx['accounts'][0],width,height)
            assert page.locator('.sup-metrics').is_visible()
            assert page.get_by_text('尚未完成',exact=False).count()>0
            record(f'{width}px: 真实HTTP登录并进入出资人总览，未对账不显示为正常')
            for name in ['supervision','reports','funding','changes','issues']:
                tab(page,name);fit(page)
                page.screenshot(path=str(OUT/f'supervision-{width}-{name}.png'),full_page=True)
            record(f'{width}px: 五个页面无横向溢出，真实数据与导航可用')
            tab(page,'reports')
            assert page.locator('.sup-shell img[src=x]').count()==0
            assert not page.evaluate('window.badReport||false')
            page.locator('[data-action=supervision-report-view]').first.click();fit(page,True)
            assert dialog(page).get_by_text('已阅与验收分别记录',exact=True).is_visible()
            close(page)
            page.locator('[data-action=supervision-report-new]').click();d=dialog(page,'提交简短汇报');fit(page,True)
            assert d.locator('[name=completed]').is_visible() and d.locator('[name=evidence]').is_visible()
            assert d.locator('[name=customer]').count()==0
            close(page)
            tab(page,'funding');page.locator('[data-action=supervision-funding-new]').click();fit(page,True)
            assert dialog(page).locator('[name=previousResults]').is_visible()
            assert dialog(page).locator('[name=stopConditions]').count()==1
            close(page)
            tab(page,'changes');page.locator('[data-action=supervision-change-new]').click();d=dialog(page);d.locator('button[type=submit]').click()
            dialog(page,'提出计划变更');fit(page,True);assert dialog(page).locator('.sup-json').count()==1;close(page)
            tab(page,'supervision');page.locator('[data-action=supervision-policy]').click();fit(page,True)
            assert not dialog(page).locator('[name=blockStaleReport]').is_checked()
            close(page)
            record(f'{width}px: 汇报、追加、变更、规则表单可操作；没有客户必填或新增密码弹窗')
            ctx.close()

        owner_ctx,owner=login(browser,fx['accounts'][0])
        reviewer_ctx,reviewer=login(browser,fx['accounts'][1])
        third_ctx,third=login(browser,fx['accounts'][2])
        tab(owner,'reports');owner.locator('[data-action=supervision-report-view]').last.click()
        before=project(owner)
        dialog(owner).locator('[data-action=supervision-report-read]').click()
        dialog(owner).get_by_role('heading',name='已记录阅读（没有批准变更）',exact=True).wait_for()
        after=project(owner)
        assert before['stages']==after['stages'] and before['proposals']==after['proposals']
        assert after['supervision']['reports'][0]['readBy']
        close(owner)
        record('真实HTTP：确认已阅只留下阅读记录，不批准阶段、计划或资金')

        tab(owner,'funding');owner.locator('[data-action=supervision-funding-new]').click();d=dialog(owner)
        d.locator('[name=previousResults]').fill('首轮已交付合成样片，新增一次小规模渠道验证')
        d.locator('[name=additional]').fill('500.00')
        mid=project(owner)['currentMemberId'];d.locator('[name="share_'+mid+'"]').fill('500.00')
        d.locator('[name=validation]').fill('验证一种发布方式')
        d.locator('[name=stopConditions]').fill('花完500元仍无验证结果即停止')
        d.locator('[name=reason]').fill('合成测试追加，不是真实资金')
        save(owner)
        before=project(owner);assert before['proposals'][-1]['status']=='pending'
        approve(owner,fx['accounts'][0],pledge=True,try_without=True)
        refresh(reviewer,'decisions');approve(reviewer,fx['accounts'][1])
        assert project(owner)['proposals'][-1]['status']=='pending'
        refresh(third,'decisions');approve(third,fx['accounts'][2])
        after=project(owner)
        assert after['proposals'][-1]['status']=='approved'
        assert after['settings']['totalBudgetCents']==before['settings']['totalBudgetCents']+50000
        assert after['finance']['verifiedCash']==before['finance']['verifiedCash']
        assert after['members']==before['members']
        record('真实HTTP：三个独立账号全部批准追加；只增加预算，不增加现金、不改分配比例')

        refresh(owner,'reports');owner.locator('[data-action=supervision-report-stage]').click();d=dialog(owner)
        d.locator('[name=completed]').fill('更新后样片及资金说明已经交付')
        d.locator('[name=evidence]').fill('合成工程与样片记录')
        save(owner)
        refresh(reviewer,'reports');reviewer.locator('[data-action=supervision-report-view]').first.click()
        dialog(reviewer).locator('[data-action=supervision-report-review]').click();d=dialog(reviewer,'独立验收阶段成果')
        d.locator('[name=accept]').select_option('true');d.locator('[name=note]').fill('实际核对合成样片和快照')
        save(reviewer)
        assert project(owner)['stages'][0]['status']=='open'
        record('真实HTTP：另一人验收成果不等于阶段已经全员批准关闭')
        refresh(owner,'supervision');owner.locator('[data-action=stage-proposal][data-kind=stage_close]').first.click();d=dialog(owner)
        d.locator('[name=evidence]').fill('引用刚刚独立验收的成果')
        d.locator('[name=reason]').fill('提交本阶段共同验收')
        save(owner)
        approve(owner,fx['accounts'][0]);refresh(reviewer,'decisions');approve(reviewer,fx['accounts'][1]);refresh(third,'decisions');approve(third,fx['accounts'][2])
        assert project(owner)['stages'][0]['status']=='completed'
        assert project(owner)['stages'][1]['status']=='locked'
        record('真实HTTP：成果验收后仍需三人阶段会签；下一阶段不自动放开')

        refresh(owner,'issues');owner.locator('[data-action=supervision-issue-view]').first.click()
        dialog(owner).locator('[data-action=supervision-issue-respond]').click();d=dialog(owner)
        d.locator('[name=cause]').fill('流程尚未稳定导致重复返工')
        d.locator('[name=plan]').fill('先完成流程检查，并记录耗时')
        save(owner)
        owner.locator('[data-action=supervision-issue-view]').first.click()
        dialog(owner).locator('[data-action=supervision-issue-resolve]').click();d=dialog(owner)
        d.locator('[name=result]').fill('已补充流程检查和实际耗时记录')
        save(owner)
        assert project(owner)['supervision']['issues'][0]['status']=='review'
        refresh(reviewer,'issues');reviewer.locator('[data-action=supervision-issue-view]').first.click()
        dialog(reviewer).locator('[data-action=supervision-issue-review]').click();d=dialog(reviewer)
        d.locator('[name=accept]').select_option('true');d.locator('[name=note]').fill('已独立核对处理结果，保留历史原因')
        save(reviewer)
        assert project(owner)['supervision']['issues'][0]['status']=='closed'
        record('真实HTTP：异常从原因、处理结果到另一人复核关闭，负责人不能自关')
        for ctx in [owner_ctx,reviewer_ctx,third_ctx]:ctx.close()
        browser.close()
    assert not errors,errors
    report={'scope':'Real Chromium and loopback HTTP, actual Worker source via isolated Node/SQLite adapter; not Cloudflare production or a physical phone','passed':len(checks),'checks':checks,'pageErrors':errors,'externalModelsCalled':False,'realNotificationsSent':False}
    (OUT/'supervision-ui-results-v1.5.0.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'passed':len(checks),'pageErrors':errors},ensure_ascii=False))
finally:
    server.terminate()
    try:server.wait(timeout=10)
    except subprocess.TimeoutExpired:server.kill();server.wait()
    log.close()
