"""Offline UI rendering only. Uses real backend fixture + mock model, not a network E2E test.
Run `node tests/ai-browser-server.mjs` to produce the local fixture first.
Managed Chromium blocks localhost (ERR_BLOCKED_BY_ADMINISTRATOR); no policy bypass.
"""
import json,pathlib,os,urllib.parse
from playwright.sync_api import sync_playwright
root=pathlib.Path(__file__).resolve().parents[1];out=root/'artifacts';out.mkdir(exist_ok=True)
f=json.loads((out/'ai-visual-fixture.json').read_text())
css=(root/'public/styles.css').read_text()+'\n'+(root/'public/mobile.css').read_text()+'\n'+(root/'public/admin.css').read_text();svg='data:image/svg+xml,'+urllib.parse.quote((root/'public/favicon.svg').read_text())
from frontend_bundle import frontend_bundle
code = frontend_bundle(root, svg)
checks=[];errors=[]
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
 page=b.new_page(viewport={'width':1440,'height':1000});page.on('pageerror',lambda x:errors.append(str(x)))
 page.set_content('<html lang="zh-CN"><head><meta charset="utf-8"><style>'+css+'</style></head><body><div id="app"></div><div id="toast"></div><dialog id="modal"></dialog></body></html>')
 page.evaluate('''f=>{window.fx=f;let id=0;if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>`00000000-0000-4000-8000-${String(++id).padStart(12,'0')}`});const store={};Object.defineProperty(window,'localStorage',{value:{getItem:k=>store[k]||null,setItem:(k,v)=>{store[k]=v}}});window.fetch=async(path,opt={})=>{const s=String(path);let d;if(opt.method==='POST'){if(s.endsWith('/ai/preview'))d=f.previews[JSON.parse(opt.body).kind];else return Response.json({error:'离线检查不写入业务数据'},{status:400});}else if(s==='/api/auth/me')d={user:f.user,csrf:f.csrf};else if(s==='/api/projects')d={projects:f.projects};else if(s.startsWith('/api/notifications'))d={items:[]};else if(s.includes('/ai?'))d=f.ai;else if(s.includes('/ai/runs/'))d=f.report;else if(s==='/api/projects/'+f.project.id)d=f.project;else d={};return Response.json(d);};}''',f)
 page.add_script_tag(content=code,type='module');page.wait_for_selector('.app-shell')
 page.locator('.nav [data-tab=ai]').click();page.get_by_role('heading',name='AI分析与风险检查').wait_for()
 assert page.locator('[data-action=ai-new]').count()==3;checks.append('桌面三类分析入口及统计渲染')
 assert 'mock-browser-key' not in page.locator('body').inner_text();checks.append('页面不包含模型密钥')
 page.screenshot(path=str(out/'ai-desktop-overview.png'),full_page=True)
 page.locator('[data-action=ai-open]').first.click();page.get_by_text('演示报告：',exact=False).wait_for()
 assert page.evaluate('window.aiXss===undefined');assert page.locator('img[src=x]').count()==0;checks.append('模型输出HTML作为文本，不执行脚本')
 page.locator('[data-action=ai-source]').first.click();assert page.locator('#modal pre').count()==1;page.locator('#modal [data-modal-close]').last.click();checks.append('重要结论可打开真实来源快照')
 page.locator('[data-action=ai-task]').first.click();assert page.locator('#modal [name=assigneeId]').count()==1;assert page.locator('#modal [name=reviewerId]').count()==1;assert not page.locator('#modal [name=confirm]').is_checked();page.locator('#modal [data-modal-close]').last.click();checks.append('任务草稿要求负责人、不同验收人和人工确认')
 page.locator('[data-action=ai-review]').first.click();assert page.locator('#modal [name=disposition] option').count()==3;page.locator('#modal [data-modal-close]').last.click();checks.append('风险处置有补充、减轻、知情接受三种明确选项')
 page.screenshot(path=str(out/'ai-desktop-report.png'),full_page=True)
 page.locator('[data-action=ai-back]').click();page.locator('[data-action=ai-policy]').click();page.get_by_role('heading',name='AI授权与金额分级').wait_for();assert '全体合伙人逐人确认' in page.locator('#modal').inner_text();assert not page.locator('#modal [name=confirm]').is_checked();page.locator('#modal [data-modal-close]').last.click();checks.append('AI启用提案展示发送范围及全员授权要求')
 page.locator('[data-action=ai-brief]').click();assert page.locator('#modal [name=context]').count()==1;assert page.locator('#modal textarea').count()==2;assert page.locator('#modal [name=s2_enabled]').count()==0;page.locator('#modal [data-modal-close]').last.click();checks.append('一段项目情况加可选关注点，不强制经营资料')
 page.locator('[data-action=ai-new][data-kind=project]').click();page.get_by_role('heading',name='先核对发送范围与本地规则').wait_for();assert page.locator('#modal pre').count()==1;assert not page.locator('#modal [name=confirmSend]').is_checked();page.locator('#modal [data-modal-close]').last.click();checks.append('发送前展示实际脱敏输入、本地检查和未勾选确认')
 for width in [390,360]:
  page.set_viewport_size({'width':width,'height':844});page.wait_for_timeout(50)
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'), 'overview '+str(width)
  page.locator('[data-action=ai-open]').first.click();page.wait_for_timeout(50)
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'), 'report '+str(width)
  page.screenshot(path=str(out/f'ai-mobile-{width}.png'),full_page=True)
  page.locator('[data-action=ai-back]').click();checks.append(f'{width}px手机列表和报告无横向溢出')
 b.close()
report={'mode':'offline-render-with-real-backend-fixture-and-mocked-model','passed':len(checks),'checks':checks,'pageErrors':errors,'limitations':['托管浏览器拦截localhost，未完成浏览器到后端在线联调。','没有调用真实模型或部署Cloudflare；后端接口独立由Node测试覆盖。']}
(out/'ai-browser-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False,indent=2))
if errors:raise SystemExit(1)
