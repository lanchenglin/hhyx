// TOTP and recovery codes stay in the active dialog only: no storage, analytics or QR service.
export function createSecurityUI({S,api,e,app,showForm,showInfo,reauth,openAccessibleDialog,afterLogin,toast}){
 const base='/api/auth/mfa';
 const codeField={name:'code',label:'六位动态验证码或一次性恢复码',autocomplete:'one-time-code',maxLength:100,full:true};
 async function accept(code){const value=await api(base+'/verify',{method:'POST',body:{code},key:crypto.randomUUID()});S.user=value.user;S.csrf=value.csrf;return value;}
 function verify(){return new Promise((resolve,reject)=>{
  const d=document.createElement('dialog');d.className='factor-dialog';d.innerHTML=`<form><div class="modal-head"><h2>二次验证</h2></div><div class="modal-content"><p>打开自己的验证器输入六位验证码。无法使用设备时，填写一枚未使用的恢复码。验证通过会轮换当前登录会话。</p><label for="factor-stepup">动态验证码 / 恢复码</label><input id="factor-stepup" name="code" type="text" autocomplete="one-time-code" autocapitalize="none" spellcheck="false" maxlength="100" required><p class="factor-error" role="alert"></p></div><div class="modal-foot"><button class="btn" type="button" data-cancel>取消</button><button class="btn primary" type="submit">验证</button></div></form>`;
  const close=()=>{d.querySelector('form').reset();d.close();d.remove();};const cancel=()=>{close();reject(Error('已取消身份确认'));};d.querySelector('[data-cancel]').onclick=cancel;d.oncancel=ev=>{ev.preventDefault();cancel();};
  d.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const b=d.querySelector('[type=submit]');b.disabled=true;try{await accept(new FormData(ev.target).get('code'));close();resolve();}catch(err){d.querySelector('.factor-error').textContent=err.message;d.querySelector('[name=code]').value='';b.disabled=false;}};
  document.body.appendChild(d);openAccessibleDialog(d);
 });}
 function renderChallenge(){app.innerHTML=`<main class="panel password-required"><div class="eyebrow">ACCOUNT SECURITY</div><h1>完成二次验证</h1><p>密码已经确认，请使用账号绑定的验证器或恢复码。验证完成前不能进入项目或系统管理。</p><form id="mfa-login-form"><div class="field"><label for="factor-login">动态验证码 / 一次性恢复码</label><input id="factor-login" name="code" type="text" required maxlength="100" autocomplete="one-time-code" autocapitalize="none" spellcheck="false"></div><p class="factor-error" role="alert"></p><div class="buttons"><button class="btn primary" type="submit">验证并登录</button><button class="btn" type="button" data-action="logout">退出登录</button></div></form></main>`;}
 app.addEventListener('submit',async ev=>{if(ev.target.id!=='mfa-login-form')return;ev.preventDefault();const form=ev.target,b=form.querySelector('[type=submit]');b.disabled=true;try{await accept(new FormData(form).get('code'));form.reset();await afterLogin();}catch(err){form.querySelector('.factor-error').textContent=err.message;form.querySelector('[name=code]').value='';}finally{b.disabled=false;}});
 function clearSecretOnClose(d,content){const cleanup=()=>{if(d.open)return;if(content?.isConnected)content.replaceChildren();d.removeEventListener('close',cleanup);};d.addEventListener('close',cleanup);}
 function secretDialog(title,html){showInfo(title,html);const d=document.getElementById('modal'),content=d.querySelector('.modal-content');clearSecretOnClose(d,content);}
 function showCodes(v){secretDialog('请离线保存恢复码（仅显示这一次）',`<div class="alert">每枚恢复码只能使用一次，相当于账号第二道凭证。不要保存在公开笔记、聊天记录或截图仓库中。关闭后无法再次查看；遗失全部验证方式需要可信部署者处理。</div><pre class="secret-codes">${v.recoveryCodes.map(e).join('\n')}</pre><p>请安全记录后关闭此窗口。系统只保存恢复码散列。</p>`);}
 async function open(){const status=await api(base+'/status');showInfo('账号安全 · 动态验证码',`<dl class="kv"><dt>二次验证</dt><dd>${status.enabled?'已启用':'未启用'}</dd><dt>剩余恢复码</dt><dd>${status.recoveryCodesRemaining}</dd><dt>管理员强制策略</dt><dd>${status.requireAdmins?'已开启':'尚未开启'}</dd></dl><p>使用兼容 TOTP 的验证器，30秒更新一次；已使用的验证码不可重复提交。系统不向外部网站发送绑定密钥。</p>${!status.encryptionReady?'<div class="alert">请部署者先配置 CONFIG_ENCRYPTION_KEY，再绑定验证器。</div>':''}<div class="buttons">${!status.enabled?'<button class="btn primary" data-action="security-enroll">绑定验证器</button>':'<button class="btn" data-action="security-recovery">重新生成恢复码</button><button class="btn danger" data-action="security-disable">停用二次验证</button>'}</div>`);}
 async function action(name){
  if(name==='security-open')return open();
  if(name==='security-enroll'){
   await reauth();const v=await api(base+'/enroll',{method:'POST',body:{},key:crypto.randomUUID()});
   showForm('绑定验证器：手动录入密钥',[
    {name:'instructions',type:'html',label:'仅本次会话有效',full:true,html:`<div class="alert">在验证器里选择“手动输入密钥”：账户填写自己的用户名，类型选择基于时间，SHA1、6位、30秒。绑定操作10分钟内有效。</div><pre class="secret-codes">${e(v.secret)}</pre><p>不要将此密钥发给他人。这里没有调用外部二维码服务。</p>`},codeField
   ],async a=>{const result=await api(base+'/confirm',{method:'POST',body:{code:a.code},key:crypto.randomUUID()});const current=await api('/api/auth/me');S.user=current.user;S.csrf=current.csrf;showCodes(result);},{submit:'确认绑定'});
   const d=document.getElementById('modal'),content=d.querySelector('.modal-content');clearSecretOnClose(d,content);return;
  }
  if(name==='security-recovery'||name==='security-disable'){
   showForm(name==='security-recovery'?'作废旧恢复码并生成新码':'停用账号二次验证',[{name:'confirm',label:'确认影响',type:'checkbox',full:true,checkboxText:name==='security-recovery'?'旧恢复码将全部失效，我会离线保管新的恢复码':'确认降低账号保护；管理员强制策略开启时不允许单独停用'}],async a=>{
    if(!a.confirm)throw Error('请先确认影响');await reauth();const v=await api(base+(name==='security-recovery'?'/recovery-codes':'/disable'),{method:'POST',body:{},key:crypto.randomUUID()});if(v.recoveryCodes)showCodes(v);else{const u=await api('/api/auth/me');S.user=u.user;S.csrf=u.csrf;toast('二次验证已停用');}
   },{submit:'继续并验证本人'});return;
  }
 }
 return {open,action,verify,renderChallenge};
}
