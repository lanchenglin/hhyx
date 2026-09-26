"""本地真实 Chromium 浏览器回归。先 npm run dev，再 npm run demo。
依赖：Python playwright；浏览器使用环境变量 CHROMIUM_PATH 或 /usr/bin/chromium。
此脚本会操作本地演示项目，不允许面向远端生产站。
"""
import json, os, pathlib, time
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path(__file__).resolve().parents[1]
accounts=json.loads((ROOT/'.local/demo-accounts.json').read_text())
assert accounts['origin'].startswith('http://localhost:')
OUT=ROOT/'artifacts';OUT.mkdir(exist_ok=True)
errors=[];results=[]
with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
    page=browser.new_page(viewport={'width':1440,'height':1080},device_scale_factor=1)
    page.on('pageerror',lambda err:errors.append(str(err)))
    page.on('console',lambda msg: errors.append(msg.text) if msg.type=='error' and '401' not in msg.text else None)
    page.goto(accounts['origin'],wait_until='networkidle')
    page.locator('#auth-form input[name=email]').fill(accounts['accounts'][0]['email'])
    page.locator('#auth-form input[name=password]').fill(accounts['accounts'][0]['password'])
    page.locator('#auth-form button[type=submit]').click()
    page.wait_for_selector('.app-shell');page.wait_for_timeout(600)
    assert page.locator('h1').inner_text()=='秋季商品试销合作'
    results.append('桌面登录与真实项目看板')
    page.screenshot(path=str(OUT/'desktop-overview.png'),full_page=True)
    for tab,heading in [('plan','阶段与合作计划'),('tasks','分工与任务'),('purchases','采购与多人会签'),('decisions','共同决策'),('finance','财务与结算'),('members','合作成员与项目资料'),('audit','审计记录'),('notifications','通知与待办提醒')]:
        page.locator(f'.nav [data-tab={tab}]').click()
        page.wait_for_function('(heading)=>document.querySelector("h1")?.textContent===heading',arg=heading)
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')
        results.append('桌面页面：'+heading)
    page.locator('.nav [data-tab=purchases]').click();page.wait_for_timeout(300)
    page.locator('[data-action=purchase-open]').filter(has_text='第二批').click()
    page.wait_for_selector('h1')
    assert '第二批' in page.locator('h1').inner_text()
    page.screenshot(path=str(OUT/'desktop-purchase.png'),full_page=True)
    results.append('采购详情、冻结名单与逐人意见展示')
    approve=page.locator('[data-action=purchase-vote][data-decision=approve]')
    if approve.count():
        approve.click()
        auth=page.locator('dialog[open]').last
        auth.locator('input[name=password]').fill(accounts['accounts'][0]['password'])
        auth.locator('button[type=submit]').click()
        page.locator('#dialog-form textarea[name=note]').wait_for()
        page.locator('#dialog-form textarea[name=note]').fill('浏览器回归：本人已阅读并同意当前版本。')
        page.locator('#dialog-form button[type=submit]').click()
        page.wait_for_function('!document.querySelector("#modal").open')
        assert page.locator('.badge').filter(has_text='已批准').count()>0
        results.append('重要操作重新验证身份 + 浏览器提交第三人会签')
    page.locator('.nav [data-tab=tasks]').click()
    page.locator('[data-action=new-task]').click()
    page.locator('#dialog-form input[name=title]').fill('浏览器回归：核对凭证清单')
    page.locator('#dialog-form textarea[name=deliverable]').fill('列出对应订单、付款凭证和验收结果。')
    page.locator('#dialog-form button[type=submit]').click()
    page.wait_for_function('!document.querySelector("#modal").open')
    assert page.get_by_text('浏览器回归：核对凭证清单',exact=True).count()>0
    results.append('浏览器新建任务与独立验收人选择')
    # 移动端复用同一登录会话，检查菜单和宽度。
    page.set_viewport_size({'width':390,'height':844})
    page.locator('[data-action=menu]').click();page.locator('.nav [data-tab=overview]').click()
    page.wait_for_timeout(200)
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')
    page.screenshot(path=str(OUT/'mobile-overview.png'),full_page=True)
    results.append('390px 手机看板与导航，无页面级横向溢出')
    page.locator('[data-action=menu]').click();page.locator('.nav [data-tab=purchases]').click()
    page.locator('[data-action=purchase-open]').filter(has_text='第二批').click()
    page.wait_for_timeout(200)
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')
    results.append('390px 手机采购详情，无页面级横向溢出')
    browser.close()
report={'passed':len(results),'cases':results,'browserErrors':errors}
(OUT/'browser-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
if errors:raise SystemExit(1)
