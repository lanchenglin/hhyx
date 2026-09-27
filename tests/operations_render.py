"""Actual frontend, synthetic backend-derived snapshots, explicit HTTP doubles.
No real credentials, authenticator device, browser network E2E or cloud services.
"""
import json, os, urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright
from frontend_bundle import frontend_bundle
ROOT=Path(__file__).resolve().parents[1]; OUT=ROOT/'artifacts';OUT.mkdir(exist_ok=True)
f=json.loads((OUT/'operations-fixture.json').read_text())
css='\n'.join((ROOT/'public'/n).read_text() for n in ['styles.css','mobile.css','admin.css'])
svg='data:image/svg+xml,'+urllib.parse.quote((ROOT/'public/favicon.svg').read_text())
html=(ROOT/'public/index.html').read_text().replace('<link rel="stylesheet" href="/styles.css">','<style>'+css+'</style>').replace('<link rel="stylesheet" href="/mobile.css">','').replace('<link rel="stylesheet" href="/admin.css">','').replace('<script type="module" src="/app.js"></script>','').replace('/favicon.svg',svg)
code=frontend_bundle(ROOT,svg)
MOCK=r'''({f,kind})=>{
 window.f=structuredClone(f);window.writes=[];window.store={};window.failFactor=false;const r=window.f.responses,base='/api/projects/'+f.pid;
 let counter=0;if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>`00000000-0000-4000-8000-${String(++counter).padStart(12,'0')}`});
 Object.defineProperty(window,'localStorage',{value:{getItem:k=>store[k]||null,setItem:(k,v)=>store[k]=v,removeItem:k=>delete store[k]}});store['coop.project']=f.pid;
 const me=r['/api/auth/me'];
 if(kind==='original')r[base]=f.original;
 if(kind==='target'){me.user=f.others[0].user;r[base]=f.transfer;}
 if(kind==='leaving'){me.user=f.others[1].user;r[base]=f.exitProposal;}
 if(kind==='member')me.user=f.others[0].user;
 if(kind==='partial'){me.user.mfaEnabled=true;me.user.mfaRequired=true;}
 if(kind==='enforced-empty'){r['/api/projects']={projects:[]};r['/api/auth/mfa/status'].requireAdmins=true;}
 window.fetch=async(path,opt={})=>{
  if(opt.method&&opt.method!=='GET'){
   const body=JSON.parse(opt.body||'{}');writes.push({path,body});
   if(path==='/api/auth/reauth')return Response.json({ok:true});
   if(path==='/api/auth/mfa/enroll')return Response.json({secret:'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',expiresIn:600});
   if(path==='/api/auth/mfa/confirm'){me.user.mfaEnabled=true;r['/api/auth/mfa/status']={enabled:true,verified:true,fresh:true,recoveryCodesRemaining:10,encryptionReady:true,requireAdmins:false};return Response.json({ok:true,recoveryCodes:Array.from({length:10},(_,i)=>'SYNTHETIC-RECOVERY-ONLY-'+i)});}
   if(path==='/api/auth/mfa/verify'){if(window.failFactor){window.failFactor=false;return Response.json({error:'测试验证码不正确',code:'MFA_INVALID'},{status:403});}me.user.mfaRequired=false;return Response.json({...me,csrf:'rotated-test-csrf'});}
   if(path===base+'/actions')return Response.json(r[base]);
   if(path==='/api/admin/backups/run')return Response.json({id:'test-job-id',status:'queued'},{status:202});
   if(path==='/api/admin/notification-settings')return Response.json({...r[path],...body,revision:r[path].revision+1,webhook:undefined,accessKeyId:undefined,accessKeySecret:undefined});
   if(path==='/api/admin/notification-settings/test')return Response.json({accepted:true,status:'accepted',message:'测试替身：服务商已接受，不代表阅读'});
   if(path.startsWith('/api/admin/'))return Response.json({ok:true});
   return Response.json({error:'Mock forbids unconfigured write'},{status:400});
  }
  if(kind==='enforced-empty'&&path==='/api/admin/overview')return Response.json({error:'管理员需先绑定',code:'MFA_SETUP_REQUIRED'},{status:403});
  if(r[path])return Response.json(r[path]);
  if(path.startsWith('/api/notifications'))return Response.json({items:[]});
  return Response.json({error:'Missing test fixture '+path},{status:404});
 };
}'''
checks=[];errors=[]
def record(w,s):checks.append(f'{w}px: {s}')
def mount(b,w,kind='admin'):
 c=b.new_context(viewport={'width':w,'height':844 if w<760 else 1000},is_mobile=w<760,has_touch=w<760);p=c.new_page();p.set_default_timeout(6000);p.on('pageerror',lambda e:errors.append(str(e)));p.route('**/*',lambda route:route.abort());p.set_content(html);p.evaluate(MOCK,{'f':f,'kind':kind});p.add_script_tag(content=code,type='module');p.wait_for_selector('#mfa-login-form' if kind=='partial' else '.app-shell');return c,p

def sidebar(p,selector):
 if not p.locator(selector).is_visible():p.locator('[data-action="menu"]').click()
 p.locator(selector).click()
def admin_tab(p,name):
 if not p.locator('.admin-tabs').count():sidebar(p,'[data-action="admin-open"]')
 p.locator(f'[data-action="admin-tab"][data-section="{name}"]').click();p.wait_for_timeout(60)
def sheet(p):
 d=p.locator('dialog[open]').last;d.wait_for();g=d.evaluate('d=>{const r=d.getBoundingClientRect(),c=d.querySelector(".modal-content");return {left:r.left,right:r.right,width:innerWidth,cw:c.clientWidth,sw:c.scrollWidth}}');assert g['left']>=-1 and g['right']<=g['width']+1 and g['sw']<=g['cw']+1,g;return d
def close(p):p.locator('dialog[open]').last.locator('[data-modal-close]').first.click()
def reauth(p):
 d=sheet(p);d.get_by_role('heading',name='确认是你本人',exact=True).wait_for();d.locator('[name=password]').fill('Synthetic-password-only-123!');d.get_by_role('button',name='验证身份',exact=True).click()
def no_overflow(p):assert p.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
def main_tab(p,name):sidebar(p,f'.nav [data-tab="{name}"]');p.wait_for_timeout(60)
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
 for width in [320,390,768,1440]:
  ctx,p=mount(b,width)
  for tab in ['security','backups','notification-settings','delivery']:
   admin_tab(p,tab);no_overflow(p)
  record(width,'四个运维页面可读、布局无横向溢出')
  admin_tab(p,'backups');p.locator('[data-action="admin-ops-backup-settings"]').click();d=sheet(p);assert not d.locator('[name=enabled]').is_checked() and not d.locator('[name=autoDrill]').is_checked();assert not d.locator('[name=confirm]').is_checked();close(p)
  p.locator('[data-action="admin-ops-backup-run"]').click();d=sheet(p);assert not d.locator('[name=confirmStorage]').is_checked();assert not p.evaluate('writes.some(x=>x.path.endsWith("/backups/run"))');close(p)
  p.locator('[data-action="admin-ops-backup-drill"]').first.click();d=sheet(p);assert not d.locator('[name=confirmIsolation]').is_checked();assert 'RESTORE_DB' in d.inner_text();close(p)
  p.locator('[data-action="admin-ops-backup-report"]').first.click();d=sheet(p);assert 'productionWritten' in d.inner_text() or 'encrypted' in d.inner_text();close(p)
  record(width,'备份计划默认关闭，手动创建/隔离演练必须确认；可查看真实模拟恢复报告')
  if width==390:p.evaluate('window.scrollTo(0,0)');p.wait_for_timeout(50);p.screenshot(path=str(OUT/'operations-390-backups.png'),full_page=True)
  admin_tab(p,'notification-settings');p.locator('[data-action="admin-ops-notify-edit"]').click();d=sheet(p)
  for name in ['webhook','accessKeyId','accessKeySecret']:assert d.locator(f'[name={name}]').input_value()=='' and d.locator(f'[name={name}]').get_attribute('type')=='password'
  assert d.locator('[name=wecomAudience]').count()==1 and not d.locator('[name=confirmAdminAudience]').is_checked();d.locator('[name=accessKeySecret]').fill('SYNTHETIC-NOT-REAL-SECRET');close(p);assert p.locator('#modal [name=accessKeySecret]').input_value()==''
  p.locator('[data-action="admin-ops-notify-test"][data-channel=sms]').click();d=sheet(p);assert not d.locator('[name=confirmSend]').is_checked();close(p)
  record(width,'服务商密钥不回显，关闭清空；接收范围与短信测试明确确认')
  p.locator('[data-action="admin-exit"]').click();main_tab(p,'continuity');no_overflow(p)
  assert p.get_by_role('heading',name='所有权移交与退出清算',exact=True).count()==1 and p.locator('[data-action="continuity-pay"]').count()==1
  p.locator('[data-action="continuity-pay"]').click();d=sheet(p);assert not d.locator('[name=confirm]').is_checked();assert d.locator('[name=amount]').input_value()=='100.00';close(p)
  p.locator('[data-action="continuity-finalize"]').click();d=sheet(p);assert not d.locator('[name=confirm]').is_checked();assert d.locator('[name=confirmation]').count()==1;close(p)
  record(width,'退出方案展示净额和复核金额，实际收付与最终会签分开确认')
  if width==390:p.evaluate('window.scrollTo(0,0)');p.wait_for_timeout(50);p.screenshot(path=str(OUT/'operations-390-exit.png'),full_page=True)
  if width==1440:p.evaluate('window.scrollTo(0,0)');p.wait_for_timeout(50);p.screenshot(path=str(OUT/'operations-1440-exit.png'),full_page=True)
  sidebar(p,'[data-action="security-open"]');d=sheet(p);d.locator('[data-action="security-enroll"]').click();reauth(p);p.get_by_role('heading',name='绑定验证器：手动录入密钥',exact=True).wait_for();d=sheet(p);assert 'JBSWY3DPEHPK3PXP' in d.inner_text();assert not p.evaluate('JSON.stringify(store).includes("JBSWY")');d.locator('[name=code]').fill('123456');d.get_by_role('button',name='确认绑定',exact=True).click();p.get_by_role('heading',name='请离线保存恢复码（仅显示这一次）',exact=True).wait_for();assert p.locator('.secret-codes').inner_text().count('SYNTHETIC-RECOVERY')==10;close(p);assert 'SYNTHETIC-RECOVERY' not in p.locator('#modal').inner_text();assert 'JBSWY' not in p.locator('#modal').inner_text();assert not p.evaluate('JSON.stringify(store).includes("RECOVERY")');record(width,'验证码绑定交互可完成，恢复码只显示一次，关闭清除且不写本地存储')
  ctx.close()
 # Wizard validation and request payload: real frontend, explicit no-op server response.
 ctx,p=mount(b,390,'original');main_tab(p,'continuity');p.locator('[data-action="continuity-exit"]').click();d=sheet(p);d.locator('[name=memberId]').select_option(f['original']['members'][2]['id']);d.get_by_role('button',name='下一步：金额与交接安排',exact=True).click();p.get_by_role('heading',name='制定退出方案：合伙人2',exact=True).wait_for();d=sheet(p)
 for field in d.locator('[name^=share_]').all():field.fill('50')
 for name in ['basis','responsibilities','reason']:d.locator(f'[name={name}]').fill('虚构清算依据与责任核对')
 d.locator('[name=dueDate]').fill('2027-01-01');d.get_by_role('button',name='提交全体会签',exact=True).click();d.locator('.field-error').wait_for();assert not p.evaluate('writes.some(x=>x.path.endsWith("/actions"))');d.locator('[name=confirm]').check();d.get_by_role('button',name='提交全体会签',exact=True).click();reauth(p);p.wait_for_function('writes.some(x=>x.path.endsWith("/actions"))');payload=p.evaluate('writes.filter(x=>x.path.endsWith("/actions")).at(-1).body');assert payload['type']=='proposal.submit' and payload['data']['kind']=='exit_plan';assert sum(payload['data']['payload']['shares'].values())==10000;record(390,'退出多步向导校验后提交完整方案，不直接移除成员');ctx.close()
 for kind,checkbox in [('target','acceptOwnership'),('leaving','acceptExit')]:
  ctx,p=mount(b,390,kind);main_tab(p,'decisions');p.locator('[data-action="proposal-vote"][data-decision=approve]').first.click();reauth(p);d=sheet(p);assert not d.locator(f'[name={checkbox}]').is_checked();d.get_by_role('button',name='提交我的决定',exact=True).click();d.locator('.field-error').wait_for();assert not p.evaluate('writes.some(x=>x.path.endsWith("/actions"))');record(390,kind+' 的明确接受未勾选时，不提交批准');ctx.close()
 ctx,p=mount(b,390,'partial');assert not p.locator('.app-shell').count();p.evaluate('window.failFactor=true');p.locator('[name=code]').fill('000000');p.get_by_role('button',name='验证并登录',exact=True).click();p.get_by_text('测试验证码不正确',exact=True).wait_for();assert p.locator('[name=code]').input_value()=='';p.locator('[name=code]').fill('SYNTHETIC-RECOVERY-ONLY-0');p.get_by_role('button',name='验证并登录',exact=True).click();p.wait_for_selector('.app-shell');record(390,'登录第二步失败清空验证码，成功后才加载项目；会话CSRF已轮换');ctx.close()
 ctx,p=mount(b,390,'enforced-empty');assert p.locator('.app-shell').count();sidebar(p,'[data-action="security-open"]');p.locator('[data-action="security-enroll"]').wait_for();assert p.locator('[data-action="security-enroll"]').count();record(390,'无项目的新管理员受强制策略限制时仍可进入账号安全绑定，不锁死页面');ctx.close()
 ctx,p=mount(b,390,'member');assert not p.locator('[data-action="admin-open"]').count();sidebar(p,'[data-action="security-open"]');p.locator('[data-action="security-enroll"]').wait_for();assert p.locator('[data-action="security-enroll"]').count();record(390,'普通用户无全站管理入口，仅能配置自己的账号安全');ctx.close()
 b.close()
assert not errors,errors
report={'scope':'Offline Chromium, real frontend with backend-derived synthetic snapshots and explicit HTTP doubles; no real device/network/cloud', 'passed':len(checks),'checks':checks,'pageErrors':errors}
(OUT/'operations-render-results-v1.3.0.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False,indent=2))
