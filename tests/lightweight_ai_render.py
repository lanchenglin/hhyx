"""v1.4 lightweight UI regression: actual first-party JS, explicit offline HTTP doubles.
No live accounts, external models, payments or cloud deployment.
"""
import copy
import json
import os
from pathlib import Path
import urllib.parse
from playwright.sync_api import sync_playwright
from frontend_bundle import frontend_bundle
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'artifacts';OUT.mkdir(exist_ok=True)
mobile=json.loads((OUT/'mobile-fixture.json').read_text())
admin=json.loads((OUT/'admin-fixture.json').read_text())
css='\n'.join((ROOT/'public'/x).read_text() for x in ['styles.css','mobile.css','admin.css'])
svg='data:image/svg+xml,'+urllib.parse.quote((ROOT/'public/favicon.svg').read_text())
html=(ROOT/'public/index.html').read_text().replace('<link rel="stylesheet" href="/styles.css">','<style>'+css+'</style>').replace('<link rel="stylesheet" href="/mobile.css">','').replace('<link rel="stylesheet" href="/admin.css">','').replace('<script type="module" src="/app.js"></script>','').replace('/favicon.svg',svg)
code=frontend_bundle(ROOT,svg)
MOCK=r'''({m,a,mode})=>{
 window.fx=structuredClone(m);window.ar=structuredClone(a.responses);window.writes=[];window.storage={};
 if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>String(Math.random())});
 fx.project.description='三人合作制作AI漫剧，先做两分钟样片，关注生成成本与返工，不预设客户或销售。';
 fx.project.ai.brief={version:1,data:{...(fx.project.ai.brief?.data||{}),context:'',focus:''}};
 if(mode==='admin')storage['coop.project']=a.normalId;else storage['coop.project']=fx.project.id;
 Object.defineProperty(window,'localStorage',{value:{getItem:k=>storage[k]||null,setItem:(k,v)=>storage[k]=v,removeItem:k=>delete storage[k]}});
 window.fetch=async(path,opt={})=>{
  let d;const p=String(path),write=opt.method&&opt.method!=='GET';
  if(write){
   const body=opt.body?JSON.parse(opt.body):{};writes.push({path:p,body});
   if(p==='/api/auth/reauth')return Response.json({ok:true});
   if(mode==='admin'&&p==='/api/admin/ai-settings'){d=ar[p]={...ar[p],...body,revision:ar[p].revision+1,keyConfigured:true};delete d.key;return Response.json(d);}
   if(p.endsWith('/actions')){
    if(body.type==='purchase.save'){
     const q={...body.data,id:body.data.id||'quick-test-id',status:'draft',version:1,createdAt:new Date().toISOString(),signers:[],decisions:{},history:[],comments:[],receipts:[],creatorId:fx.project.currentMemberId,readBy:{}};
     fx.project.purchases.push(q);
    }else if(body.type==='ai.materials')fx.project.ai.brief={version:3,data:{...fx.project.ai.brief.data,...body.data}};
    return Response.json(fx.project);
   }
   if(p.endsWith('/ai/policy'))return Response.json(fx.project);
   if(p.endsWith('/ai/preview'))return Response.json(fx.previews[body.kind]);
   return Response.json({error:'禁止未配置的离线测试写入'},{status:400});
  }
  if(mode==='admin'){
   d=ar[p];if(!d&&p.startsWith('/api/notifications'))d=ar['/api/notifications?limit=200'];
  }else{
   if(p==='/api/auth/me')d={user:fx.user,csrf:fx.csrf};
   else if(p==='/api/projects')d={projects:fx.projects};
   else if(p.startsWith('/api/notifications'))d={items:fx.notifications};
   else if(p===`/api/projects/${fx.project.id}`)d=fx.project;
   else if(p.includes('/ai?')||p.endsWith('/ai'))d=fx.ai;
   else if(p.includes('/ai/runs/'))d=fx.report;
  }
  return d?Response.json(d):Response.json({error:'未提供离线数据: '+p},{status:404});
 };
}'''
checks=[];errors=[]
def mount(b,w,mode='project'):
 c=b.new_context(viewport={'width':w,'height':844 if w<760 else 1000},has_touch=w<760,is_mobile=w<760)
 p=c.new_page();p.set_default_timeout(5000);p.on('pageerror',lambda e:errors.append(str(e)));p.route('**/*',lambda r:r.abort())
 p.set_content(html);p.evaluate(MOCK,{'m':mobile,'a':admin,'mode':mode});p.add_script_tag(content=code,type='module');p.wait_for_selector('.app-shell');return c,p

def nav(p,tab):
 x=p.locator(f'.nav [data-tab="{tab}"]')
 if not x.is_visible():p.locator('[data-action=menu]').click()
 x.click();p.wait_for_timeout(40)

def sheet(p,name):
 d=p.locator('dialog[open]').last;d.wait_for();g=d.evaluate('d=>{let r=d.getBoundingClientRect(),c=d.querySelector(".modal-content");return [r.left,r.right,innerWidth,c.scrollWidth,c.clientWidth]}')
 assert g[0]>=-1 and g[1]<=g[2]+1 and g[3]<=g[4]+1,(name,g)
 return d

def close(p):p.locator('dialog[open]').last.locator('[data-modal-close]').first.click()
def auth(p):
 d=p.locator('dialog[open]').last;d.get_by_role('heading',name='确认是你本人').wait_for();d.locator('[name=password]').fill('Synthetic-ui-password-only-123!');d.get_by_role('button',name='验证身份',exact=True).click()

def record(w,t):checks.append(f'{w}px: {t}')
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
 for w in [320,390,430,1440]:
  c,p=mount(b,w);nav(p,'ai');p.locator('[data-action=ai-brief]').click();d=sheet(p,'项目说明')
  assert d.locator('textarea').count()==2
  assert not d.locator('[name=customers],[name=channels],[name=economics],[name*=s0_]').count()
  assert 'AI漫剧' in d.locator('[name=context]').input_value()
  assert not d.locator('[name=context]').evaluate('x=>x.required')
  d.locator('[name=context]').fill('合作做中视频与AI漫剧，先完成样片，不需要客户。')
  if w==390:p.screenshot(path=str(OUT/'lightweight-390-context.png'))
  d.get_by_role('button',name='保存',exact=True).click();p.wait_for_function('writes.some(x=>x.body.type==="ai.materials")');p.wait_for_function('!document.querySelector("#modal").open')
  q=p.evaluate('writes.find(x=>x.body.type==="ai.materials").body.data');assert set(q)=={'context','focus'}
  record(w,'项目说明仅一段话与可选重点；自动带入已有说明，保存不清空旧结构化资料')
  p.locator('[data-action=ai-policy]').click();d=sheet(p,'金额分级')
  assert not d.locator('[name=monthlyBudget],[name=monthlyBudgetCents],[name=outputTokens]').count()
  threshold=d.locator('[name=threshold]');assert threshold.count()==1
  assert threshold.input_value()=='500.00'
  threshold.fill('800');d.locator('[name=reportStyle]').select_option('standard');d.locator('[name=confirm]').check()
  d.get_by_role('button',name='提交全员共同决策').click();auth(p);p.wait_for_function('writes.some(x=>x.path.endsWith("/ai/policy"))')
  sent=p.evaluate('writes.find(x=>x.path.endsWith("/ai/policy")).body');assert sent['purchaseThresholdCents']==80000 and sent['reportStyle']=='standard';assert 'monthlyBudgetCents' not in sent
  p.wait_for_function('!document.querySelector("#modal").open');record(w,'阈值单位正确，不要求费用单价；发送的是共同决策提议，不代签')
  nav(p,'purchases');p.locator('[data-action=new-expense]').click();d=sheet(p,'快速支出')
  assert not d.locator('details').get_attribute('open')
  assert d.locator('input[required]:visible').count()==4
  for name,value in {'title':'生活用品与素材道具','amount':'300','reason':'样片制作需要','payee':'测试商家收款主体'}.items():d.locator(f'[name={name}]').fill(value)
  assert d.locator('[name=executorId]').input_value()!=d.locator('[name=receiverId]').input_value()
  if w==390:p.screenshot(path=str(OUT/'lightweight-390-expense.png'))
  d.get_by_role('button',name='保存支出草稿').click();p.wait_for_function('writes.some(x=>x.body.type==="purchase.save")');p.wait_for_function('!document.querySelector("#modal").open')
  saved=p.evaluate('writes.find(x=>x.body.type==="purchase.save").body.data')
  assert saved['items'][0]['unitCents']==30000 and saved['items'][0]['quantity']==1 and saved['simpleForm'] is True
  assert saved['supplier']==saved['payee']=='测试商家收款主体'
  assert not p.evaluate('writes.some(x=>x.path.endsWith("/ai/runs")||["purchase.vote","purchase.order","purchase.payment"].includes(x.body.type))')
  record(w,'快速支出四项可见必填，保留不同验收人；300元保存草稿，不投票、不付款、不调用AI')
  nav(p,'purchases');p.locator('[data-action=new-purchase]').click();d=sheet(p,'完整明细')
  for name in ['quote','risk','exitPlan']:assert not d.locator(f'[name={name}]').evaluate('x=>x.required')
  d.locator('[data-add-item]').click();assert d.locator('.repeat-row').count()==2;close(p)
  record(w,'复杂支出仍支持多项明细，报价/风险/退款资料可选，不强迫小额填长表')
  c.close()
  c,p=mount(b,w,'admin');x=p.locator('[data-action=admin-open]')
  if not x.is_visible():p.locator('[data-action=menu]').click()
  x.click();p.locator('[data-action=admin-tab][data-section=ai]').click()
  p.locator('[data-action=admin-ai-edit]').click();d=sheet(p,'管理员简化配置')
  assert d.locator('[name=baseUrl],[name=model],[name=key]').count()==3
  assert not d.locator('[name=inputPrice],[name=outputPrice],[name=outputTokens],[name=structured],[name=analysisGuidance]').count()
  assert d.locator('[name=key]').input_value()==''
  if w==390:p.screenshot(path=str(OUT/'lightweight-390-ai-config.png'))
  close(p);p.locator('[data-action=admin-ai-prompts]').click();d=sheet(p,'内置提示词')
  assert 'AI漫剧' in d.inner_text() and '不得默认有客户' in d.inner_text()
  assert not d.locator('textarea,input').count();close(p)
  p.locator('[data-action=admin-ai-guidance]').click();d=sheet(p,'可选补充偏好')
  assert d.locator('[name=analysisGuidance]').count()==1
  d.locator('[name=analysisGuidance]').fill('优先关注时间投入和返工成本');close(p)
  assert not p.evaluate('writes.some(x=>x.path.includes("ai-settings"))')
  record(w,'连接表单无价格/输出配额，密钥不回显；内置三类提示词只读，补充偏好独立可选')
  c.close()
 b.close()
assert not errors,errors
result={'scope':'Offline Chromium, real frontend with explicit synthetic HTTP doubles; not live cloud/device/model tests','passed':len(checks),'checks':checks,'pageErrors':errors}
(OUT/'lightweight-ui-v1.4.0.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False,indent=2))
