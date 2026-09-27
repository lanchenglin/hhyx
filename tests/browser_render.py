"""使用真实 Chromium 对已运行后端产生的本地演示数据做离线 UI 检查。
只检查渲染/导航/表单/响应式布局；fetch 为静态测试替身，不是浏览器端到端联调。
当前执行环境的托管 Chromium 禁止访问 localhost，不修改或绕过该策略。
"""
import json, pathlib, os, urllib.parse
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path(__file__).resolve().parents[1];OUT=ROOT/'artifacts';OUT.mkdir(exist_ok=True)
fixture=json.loads((OUT/'visual-fixture.json').read_text())
css=(ROOT/'public/styles.css').read_text()+'\n'+(ROOT/'public/mobile.css').read_text()
svg='data:image/svg+xml,'+urllib.parse.quote((ROOT/'public/favicon.svg').read_text())
code=(ROOT/'public/ai-ui.js').read_text().replace('export function','function')+'\n'+(ROOT/'public/app.js').read_text().replace("import { createAiUI } from './ai-ui.js';",'').replace('/favicon.svg',svg)
errors=[];checks=[]
with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
    page=browser.new_page(viewport={'width':1440,'height':1080},device_scale_factor=1)
    page.on('pageerror',lambda err:errors.append(str(err)))
    page.set_content('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>'+css+'</style></head><body><div id="app"></div><div id="toast"></div><dialog id="modal"></dialog></body></html>')
    page.evaluate('''(f)=>{window.fixture=f;let testId=0;if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>`00000000-0000-4000-8000-${String(++testId).padStart(12,'0')}`});const storage={};Object.defineProperty(window,'localStorage',{value:{getItem:k=>storage[k]||null,setItem:(k,v)=>{storage[k]=v}}});window.fetch=async(path,opt={})=>{if(opt.method&&opt.method!=='GET')return new Response(JSON.stringify({error:'离线视觉检查不执行写入'}),{status:400,headers:{'Content-Type':'application/json'}});let d;const s=String(path);if(s==='/api/auth/me')d={user:f.user,csrf:f.csrf};else if(s==='/api/projects')d={projects:f.projects};else if(s.startsWith('/api/notifications'))d={items:f.notifications};else if(s.includes('/audit?'))d={records:f.audit,nextAfter:null};else if(s.endsWith('/channels'))d=f.channels;else if(s==='/api/projects/'+f.project.id)d=f.project;else d={ok:true};return new Response(JSON.stringify(d),{headers:{'Content-Type':'application/json'}});};}''',fixture)
    page.add_script_tag(content=code,type='module')
    page.wait_for_selector('.app-shell');page.wait_for_timeout(250)
    assert page.locator('h1').inner_text()=='秋季商品试销合作'
    checks.append('桌面项目总览渲染（来自真实本地后端演示数据）')
    page.screenshot(path=str(OUT/'desktop-overview.png'),full_page=True)
    for tab,heading in [('plan','阶段与合作计划'),('tasks','分工与任务'),('purchases','采购与多人会签'),('decisions','共同决策'),('finance','财务与结算'),('members','合作成员与项目资料'),('audit','审计记录'),('notifications','通知与待办提醒')]:
        page.locator(f'.nav [data-tab={tab}]').click()
        page.wait_for_function('(h)=>document.querySelector("h1")?.textContent===h',arg=heading)
        assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1'),heading
        checks.append('桌面导航与布局：'+heading)
    page.locator('.nav [data-tab=purchases]').click()
    page.locator('[data-action=purchase-open]').filter(has_text='第二批').click()
    assert '第二批' in page.locator('h1').inner_text()
    assert page.get_by_text('尚未确认已阅').count()>0
    page.screenshot(path=str(OUT/'desktop-purchase.png'),full_page=True)
    checks.append('采购详情、冻结三人名单、2/3意见与未阅区分')
    page.locator('.nav [data-tab=purchases]').click()
    page.locator('[data-action=new-purchase]').click()
    assert page.locator('#dialog-form input[name=title]').count()==1, {'toast':page.locator('#toast').inner_text(),'errors':errors,'dialog':page.locator('#modal').inner_html()}
    assert page.locator('#item-rows .repeat-row').count()==1
    page.locator('[data-add-item]').click()
    assert page.locator('#item-rows .repeat-row').count()==2
    checks.append('新建采购表单与动态商品行')
    page.locator('[data-modal-close]').first.click()
    page.locator('.nav [data-tab=tasks]').click();page.locator('[data-action=new-task]').click()
    assert page.locator('#dialog-form select[name=assigneeId]').input_value()!=page.locator('#dialog-form select[name=reviewerId]').input_value()
    checks.append('任务表单默认使用不同的负责人和验收人')
    page.locator('[data-modal-close]').first.click()
    page.set_viewport_size({'width':390,'height':844})
    page.locator('[data-action=menu]').click();page.locator('.nav [data-tab=overview]').click()
    assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1'), page.evaluate('[...document.querySelectorAll("body *")].map(e=>({tag:e.tagName,cls:e.className,w:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right})).filter(e=>e.right>391)')
    page.screenshot(path=str(OUT/'mobile-overview.png'),full_page=True)
    checks.append('390px 手机看板与菜单，页面无横向溢出')
    page.locator('[data-action=menu]').click();page.locator('.nav [data-tab=purchases]').click()
    page.locator('[data-action=purchase-open]').filter(has_text='第二批').click()
    assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1')
    page.screenshot(path=str(OUT/'mobile-purchase.png'),full_page=True)
    checks.append('390px 手机采购详情，页面无横向溢出')
    browser.close()
report={'mode':'offline-ui-rendering-with-real-local-demo-fixture','passed':len(checks),'cases':checks,'pageErrors':errors,'limitation':'托管浏览器阻止 localhost；未执行当前环境的浏览器到后端在线联调。后端接口另由 Node 集成测试验证。'}
(OUT/'browser-render-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
if errors:raise SystemExit(1)
