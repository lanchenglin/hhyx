import { createOperationsUI } from './ops-ui.js';
// The UI hides administration for non-admins; every corresponding API also checks
// the current account, CSRF, recent reauthentication and optimistic revisions.
export function createAdminUI({S,e,api,reauth,showForm,showInfo,render,btn,panel,money,shortDate,toast,toCents,amountInput,openSecurity}){
 const tabs=[['overview','管理总览'],['projects','项目与回收站'],['users','用户与权限'],['ai','AI模型配置'],['security','二次验证'],['backups','备份与恢复'],['notification-settings','通知服务商'],['delivery','投递与告警'],['audit','管理员日志']];
 const life={active:'正常项目',archived:'已归档（只读）',trashed:'回收站'},roles={partner:'合伙人',operator:'执行成员',viewer:'只读成员'};
 let tab='overview',data=null,filter='active',query='',offset=0,before=0;
 const base='/api/admin';
 const OPS=createOperationsUI({S,e,api,reauth,showForm,showInfo,btn,panel,money,shortDate,toast,openSecurity});
 const button=(title,action,attrs='',cls='')=>btn(title,'admin-'+action,attrs,cls);
 const fieldReason={name:'reason',label:'操作原因（写入管理员日志）',type:'textarea',full:true,maxLength:1000};
 function reset(){tab='overview';data=null;filter='active';query='';offset=0;before=0;}
 async function load(){
  const routes={overview:'/overview',projects:`/projects?lifecycle=${filter}&q=${encodeURIComponent(query)}&offset=${offset}`,users:`/users?q=${encodeURIComponent(query)}&offset=${offset}`,ai:'/ai-settings',security:'/security',backups:'/backups','notification-settings':'/notification-settings',delivery:'/delivery',audit:`/audit?before=${before}`};
  const expected=tab;const result=await api(base+routes[tab]);if(tab===expected)data=result;
 }
 async function open(section='overview'){if(S.user?.systemRole!=='admin')throw Error('仅系统管理员可以访问');S.adminMode=true;tab=section;offset=0;before=0;query='';data=null;try{await load();render();}catch(err){S.adminMode=false;render();throw err;}}
 async function refresh(){await load();render();}
 function pager(){const next=data.nextOffset??data.nextBefore;return `<div class="admin-pagination">${offset||before?button('返回第一页','first','','small'):''}${next!=null?button('下一页','next',`data-next="${next}"`,'small'):''}</div>`;}
 function card(title,value,note){return `<section class="metric"><div class="metric-label">${e(title)}</div><div class="metric-value">${e(value)}</div><p class="metric-note">${e(note)}</p></section>`;}
 function page(){
  let html=`<div class="page-head"><div><div class="eyebrow">SYSTEM ADMIN / V1.4.0</div><h1>系统管理</h1><p>管理账号、项目生命周期和平台配置；不代替任何合伙人审批。</p></div><div class="buttons">${button('刷新','refresh','','small')}${button('返回我的项目','exit','','small')}</div></div>`;
  html+=`<nav class="admin-tabs" aria-label="系统管理栏目">${tabs.map(([id,title])=>button(title,'tab',`data-section="${id}" aria-current="${tab===id?'page':'false'}"`,tab===id?'primary':'')).join('')}</nav>`;
  if(!data)return html+'<p>正在读取管理数据…</p>';
  if(tab==='overview'){
   const u=data.userCounts||{},counts=Object.fromEntries((data.projectCounts||[]).map(x=>[x.lifecycle,x.count]));
   html+=`<div class="metrics">${card('系统用户',u.total||0,`${u.admins||0} 位有效管理员 · ${u.disabled||0} 个停用账号`)}${card('正常项目',counts.active||0,'按原有规则分工与会签')}${card('归档 / 回收站',`${counts.archived||0} / ${counts.trashed||0}`,'删除为逻辑删除，历史数据保留')}${card('外部 AI',data.aiConfigured?'已配置':'待配置','保存配置不会调用模型或自动授权项目')}</div>`;
   html+=panel('运行状态',`<div class="panel-body"><dl class="kv"><dt>数据库</dt><dd>${e(data.diagnostics.database)}</dd><dt>私有文件存储绑定</dt><dd>${data.diagnostics.filesBinding?'已绑定，仍需验收':'未绑定'}</dd><dt>配置加密密钥</dt><dd>${data.diagnostics.configurationEncryption?'已设置':'未设置，不能保存AI Key'}</dd><dt>通知队列</dt><dd>${data.diagnostics.notifyQueue?'已绑定':'未绑定，使用定时处理'}</dd><dt>AI配置提示</dt><dd>${e(data.diagnostics.aiConfiguration||'无配置错误')}</dd></dl><p class="muted">${e(data.diagnostics.note)}</p></div>`);
   html+=`<div class="grid-2">${panel('AI任务状态',`<div class="panel-body">${(data.jobs||[]).map(x=>`<p>${e(x.status)}：${x.count}</p>`).join('')||'<p>暂无任务</p>'}</div>`)}${panel('通知投递状态',`<div class="panel-body">${(data.notifications||[]).map(x=>`<p>${e(x.status)}：${x.count}</p>`).join('')||'<p>暂无通知投递</p>'}</div>`)}</div>`;
   html+=`<div class="alert info">备份不是一个“成功”按钮：完整备份需要数据库、私有附件以及安全保存的加密密钥。此页面仅展示运行指标，没有替你创建云端备份。</div>`;
  }
  if(tab==='projects'){
   html+=`<div class="admin-toolbar"><div class="buttons">${Object.entries({...life,all:'全部'}).map(([k,v])=>button(v,'filter',`data-filter="${k}"`,filter===k?'primary small':'small')).join('')}</div>${button('搜索项目','search','','small')}<span class="muted">共 ${data.total} 个${query?' · '+e(query):''}</span></div>`;
   html+=`<div class="admin-projects">${data.projects.map(p=>`<section class="panel"><div class="panel-head"><h3>${e(p.name)}</h3><span class="badge ${p.lifecycle==='trashed'?'bad':p.lifecycle==='archived'?'warn':'good'}">${e(life[p.lifecycle])}</span></div><div class="panel-body"><p>${e(p.description||'暂无项目说明')}</p><dl class="kv"><dt>成员 / 版本</dt><dd>${p.memberCount} 人 / R${p.revision}</dd><dt>待审批 / 未完任务</dt><dd>${p.obligations.pendingApprovals} / ${p.obligations.unfinishedTasks}</dd><dt>未完成采购 / 待复核账目</dt><dd>${p.obligations.unfinishedPurchases} / ${p.obligations.unverifiedEntries}</dd><dt>已登记应付</dt><dd>${money(p.obligations.payableCents)}</dd></dl><div class="buttons">${button('只读审阅','inspect',`data-id="${e(p.id)}"`,'small')}${button('成员权限','members',`data-id="${e(p.id)}"`,'small')}${button('导出记录','export',`data-id="${e(p.id)}"`,'small')}${p.lifecycle==='active'?button('归档','lifecycle',`data-id="${e(p.id)}" data-operation="archive"`,'small'):p.lifecycle==='archived'?button('取消归档','lifecycle',`data-id="${e(p.id)}" data-operation="unarchive"`,'small'):button('恢复到归档','lifecycle',`data-id="${e(p.id)}" data-operation="restore"`,'small')}${p.lifecycle!=='trashed'?button('删除到回收站','lifecycle',`data-id="${e(p.id)}" data-operation="trash"`,'danger small'):''}</div></div></section>`).join('')||'<div class="empty">没有匹配项目</div>'}</div>${pager()}`;
   html+='<p class="muted">归档及回收站停止新的业务写入、AI发送及外发提醒；已有请求无法撤回，已有合同债务不消失。没有物理清库入口。</p>';
  }
  if(tab==='users'){
   html+=`<div class="admin-toolbar"><div class="buttons">${button('新建用户','new-user','','primary')}${button('搜索用户','search','','small')}</div><span class="muted">共 ${data.total} 个用户${query?' · '+e(query):''}</span></div>`;
   html+=panel('账号权限与会话',`<div class="table-wrap"><table><thead><tr><th>用户</th><th>系统权限</th><th>状态</th><th>操作</th></tr></thead><tbody>${data.users.map(u=>`<tr><td><strong>${e(u.name)}</strong><div class="cell-sub">${e(u.username||'尚未设置用户名')}</div><div class="cell-sub">${e(u.email)}</div></td><td>${u.systemRole==='admin'?'系统管理员':'普通用户'}<div class="cell-sub">${u.canCreateProjects?'可创建项目':'不可创建项目'}</div></td><td><span class="badge ${u.disabled?'bad':'good'}">${u.disabled?'已停用':'正常'}</span>${u.mustChangePassword?'<div class="cell-sub">首登须修改临时密码</div>':''}<div class="cell-sub">${u.activeSessions} 个会话</div></td><td><div class="buttons">${button('编辑权限','edit-user',`data-id="${e(u.id)}"`,'small')}${button('所属项目','user-projects',`data-id="${e(u.id)}"`,'small')}${u.id!==S.user.id?button('重置密码','reset-password',`data-id="${e(u.id)}"`,'small'):''}${button('撤销登录会话','revoke',`data-id="${e(u.id)}"`,'small')}</div></td></tr>`).join('')}</tbody></table></div>`)+pager();
   html+='<div class="alert info">系统管理员身份不等于项目合伙人。停用用户不会删除他的历史意见或从必签名单中移除；在办事项可能因此等待处理。</div>';
  }
  if(tab==='ai'){
   html+=panel('AI 服务连接配置',`<div class="panel-body"><dl class="kv"><dt>配置来源</dt><dd>${data.source==='database'?'管理员后台配置':'部署环境变量（尚未在后台保存）'}</dd><dt>全站启用</dt><dd>${data.enabled?'已启用':'未启用'}</dd><dt>API Key</dt><dd>${data.keyConfigured?'已保存 · 不回显原值':'未配置'}</dd><dt>接口协议</dt><dd>${e(data.provider)}</dd><dt>API URL</dt><dd class="admin-wrap">${e(data.baseUrl)}</dd><dt>Model</dt><dd class="admin-wrap">${e(data.model||'未配置')}</dd><dt>配置版本</dt><dd>${data.revision}</dd></dl><div class="buttons">${button('配置 Key / Model / URL','ai-edit','','primary')}${button('测试连接（可能计费）','ai-test','','small')}${button('内置分析提示词','ai-prompts','','small')}${button('补充分析偏好（可选）','ai-guidance','','small')}</div><p class="muted">Key只以加密形式保存在服务端，管理员也不能读取已存明文。普通成员没有此管理入口。</p></div>`);
   if(!data.encryptionReady)html+='<div class="alert bad">部署者还需设置 CONFIG_ENCRYPTION_KEY，网页不能安全地替你生成并保管服务端根密钥。</div>';
   html+='<div class="alert info">保存不会发起模型调用。只需配置URL、Model和Key，无须填写价格或输出长度。提示词已内置，默认简短且通用。修改配置后项目须重新全员确认；用量不代表账单。</div>';
  }
  if(tab==='audit')html+=panel('管理员操作日志',`<div class="panel-body">${data.records.map(x=>`<article class="comment"><div class="comment-meta"><span>#${x.sequence} · ${e(x.actor_name)}</span><time>${shortDate(x.created_at)}</time></div><strong>${e(x.action)}</strong><p class="admin-wrap">对象：${e(x.target_id||'系统')}</p><pre class="admin-json">${e(JSON.stringify(x.details,null,2))}</pre></article>`).join('')||'<p>暂无管理操作记录。</p>'}</div>`)+pager()+'<p class="muted">日志为应用层只追加记录，不是第三方不可篡改存证。用户密码、API Key不会写入日志。</p>';
  html+=OPS.page(tab,data);
  return html;
 }
 async function save(path,body){await reauth();return api(base+path,{method:'POST',body});}
 function passwordField(label='临时密码（12–128字符）'){return {name:'temporaryPassword',label,type:'password',revealPassword:true,passwordLabel:'临时密码',autocomplete:'new-password',maxLength:128,full:true,help:'请通过可信渠道单独交给本人；首次登录必须改密，系统不提供明文找回。'};}
 async function userForm(user=null){
  showForm(user?'修改用户权限':'新建系统用户',[
   {name:'name',label:'显示姓名',value:user?.name||''},{name:'username',label:'登录用户名',value:user?.username||'',maxLength:64},
   ...(!user?[{name:'email',label:'邮箱（用于关联邀请）',type:'email'},passwordField()]:[{name:'emailDisplay',label:'账号邮箱（不直接改写项目邀请绑定）',value:user.email,readonly:true,full:true}]),
   {name:'systemRole',label:'系统角色',type:'select',value:user?.systemRole||'member',options:[['member','普通用户'],['admin','系统管理员：管理全部项目、账号和配置']]},
   {name:'canCreateProjects',label:'允许创建项目',type:'checkbox',value:user?user.canCreateProjects:true,full:true},
   ...(user?[{name:'disabled',label:'停用账号并撤销已有登录',type:'checkbox',value:user.disabled,full:true},{name:'confirmImpact',label:'确认影响',type:'checkbox',full:true,checkboxText:'变更将撤销该账号已有会话；停用不会取消其必签资格，可能阻塞在办事项'}]:[]),fieldReason
  ],async a=>{
   if(user?.id===S.user.id&&(a.disabled||a.systemRole!=='admin'))throw Error('不能停用或降级自己的管理员身份');
   const result=await save(user?'/users/'+user.id:'/users',{name:a.name,username:a.username,...(!user?{email:a.email,temporaryPassword:a.temporaryPassword}:{}),systemRole:a.systemRole,canCreateProjects:!!a.canCreateProjects,disabled:!!a.disabled,confirmImpact:!!a.confirmImpact,reason:a.reason,expectedVersion:user?.authVersion});
   if(result.requiresRelogin){location.reload();return;}await refresh();toast(user?'权限已更新，原登录已撤销':'用户已建立，首次登录必须修改密码');
  },{intro:'系统权限和项目身份分开管理。这里不能替用户投票、直接抹掉旧意见，或读取其密码。'});
 }
 async function action(name,el){
  if(name.startsWith('admin-ops-'))return OPS.action(name,el,{data,refresh});
  if(name==='admin-open')return open(el.dataset.section||'overview');
  if(name==='admin-tab'){tab=el.dataset.section;offset=0;before=0;query='';return refresh();}
  if(name==='admin-exit'){S.adminMode=false;render();return;}
  if(name==='admin-refresh')return refresh();
  if(name==='admin-filter'){filter=el.dataset.filter;offset=0;return refresh();}
  if(name==='admin-first'){offset=0;before=0;return refresh();}
  if(name==='admin-next'){if(tab==='audit')before=Number(el.dataset.next);else offset=Number(el.dataset.next);return refresh();}
  if(name==='admin-search'){showForm(tab==='users'?'搜索用户':'搜索项目',[{name:'q',label:'名称 / 用户名 / 邮箱关键词',required:false,value:query,full:true}],async a=>{query=a.q;offset=0;await refresh();},{submit:'搜索'});return;}
  if(name==='admin-new-user')return userForm();
  if(name==='admin-report'){const v=await api(base+'/projects/'+el.dataset.projectId+'/ai/'+el.dataset.id);showInfo('AI报告只读审阅',`<p>状态：${e(v.status)} · ${v.stale?'资料已变化，报告可能过期':'按该次冻结资料生成'}</p><pre class="admin-json">${e(JSON.stringify(v,null,2))}</pre>`);return;}
  if(['admin-edit-user','admin-user-projects','admin-reset-password','admin-revoke'].includes(name)){
   const v=await api(base+'/users/'+el.dataset.id),u=v.user;
   if(name==='admin-edit-user')return userForm(u);
   if(name==='admin-user-projects'){showInfo('用户所属项目',`<p>${e(u.name)} · ${e(u.email)}</p>${v.memberships.map(m=>`<article class="comment"><strong>${e(m.projectName)}</strong><p>${e(roles[m.role])} · ${e(life[m.lifecycle])} · ${m.pendingTasks} 项未完成分工</p></article>`).join('')||'<p>未加入项目</p>'}`);return;}
   showForm(name==='admin-reset-password'?'重置用户密码':'撤销该用户全部登录',[
    ...(name==='admin-reset-password'?[passwordField()]:[]),fieldReason
   ],async a=>{const result=await save(`/users/${u.id}/${name==='admin-reset-password'?'reset-password':'revoke-sessions'}`,{...a,expectedVersion:u.authVersion});if(result.requiresRelogin){location.reload();return;}await refresh();toast('已处理，原会话已失效');},{intro:'旧密码与其他会话按操作失效；账号及项目历史不会删除。'});return;
  }
  if(['admin-inspect','admin-lifecycle','admin-members','admin-export'].includes(name)){
   const v=await api(base+'/projects/'+el.dataset.id),p=v.project;
   if(name==='admin-inspect'){
    showInfo('管理员只读审阅',`<p><strong>${e(p.name)}</strong> · ${e(life[v.lifecycle])}</p><p>${e(p.description)}</p><div class="alert info">这里只读，不提供任何代签或代付款按钮。审阅已记录在管理日志。</div><dl class="kv"><dt>预算 / 已报告现金</dt><dd>${money(p.settings.totalBudgetCents)} / ${money(p.finance.reportedCash)}</dd><dt>已登记应收 / 应付</dt><dd>${money(p.finance.receivableCents)} / ${money(p.finance.payableCents)}</dd></dl>${[['成员',p.members],['阶段',p.stages],['任务',p.tasks],['采购',p.purchases],['共同决策',p.proposals],['账目',p.ledger],['生命周期记录',p.lifecycleHistory||[]]].map(([label,list])=>`<details><summary>${label} · ${list.length}</summary><pre class="admin-json">${e(JSON.stringify(list,null,2))}</pre></details>`).join('')}<h3>私有附件</h3>${p.attachments.map(a=>`<p><a href="/api/admin/projects/${encodeURIComponent(p.id)}/files/${encodeURIComponent(a.id)}" download>${e(a.name)}</a></p>`).join('')||'<p>暂无附件</p>'}<h3>AI报告历史</h3>${(p.ai?.runs||[]).map(r=>button(`${r.kind} · ${r.status}`,'report',`data-project-id="${e(p.id)}" data-id="${e(r.id)}"`,'small')).join('')||'<p>暂无报告</p>'}`);return;
   }
   if(name==='admin-export'){
    const value=await api(base+'/projects/'+p.id+'/export'),blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'}),link=document.createElement('a'),url=URL.createObjectURL(blob);
    link.href=url;link.download='project-'+p.id+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);toast('已导出业务记录，不含附件原文件和完整AI报告');return;
   }
   if(name==='admin-members'){
    if(v.lifecycle!=='active')throw Error('归档或回收站项目只读，请先恢复');
    showForm('调整项目成员角色',[
     {name:'memberId',label:'项目成员',type:'select',options:p.members.filter(m=>m.active).map(m=>[m.id,`${m.name} · ${roles[m.role]}`]),full:true},
     {name:'role',label:'调整为',type:'select',options:Object.entries(roles),full:true},fieldReason
    ],async a=>{const r=await save('/projects/'+p.id+'/members',{...a,expectedRevision:v.revision});await refresh();toast(r.message);},{intro:p.status==='draft'?'筹备期无待决策时可以调整，正式基准仍须共同确认。':'正式项目只创建成员权限变更提议。原全体合伙人逐人同意后才生效，不能删除反对者的必签权。'});return;
   }
   const op=el.dataset.operation,title={archive:'归档项目',unarchive:'取消归档',trash:'删除到回收站',restore:'从回收站恢复到归档'}[op];
   showForm(title,[
    {name:'impact',label:'当前待处理事项',type:'html',full:true,html:`<div class="alert warn">待退出清算 ${v.obligations.exitSettlements||0}，清算预占 ${money(v.obligations.exitHoldCents||0)}，待审批 ${v.obligations.pendingApprovals}，未完成任务 ${v.obligations.unfinishedTasks}，执行中采购 ${v.obligations.unfinishedPurchases}，待复核账目 ${v.obligations.unverifiedEntries}，已登记应付 ${money(v.obligations.payableCents)}。</div>`},
    {name:'confirmName',label:'准确输入项目名称：'+p.name,full:true},{name:'confirmImpact',label:'确认影响',type:'checkbox',full:true,checkboxText:'我理解归档/删除会停止新操作，不会消灭真实债务或历史责任；回收站可以恢复，不物理清库'},fieldReason
   ],async a=>{if(!a.confirmImpact)throw Error('请先确认影响');await save('/projects/'+p.id+'/lifecycle',{...a,confirmImpact:true,expectedRevision:v.revision,action:op});S.projects=(await api('/api/projects')).projects;if(S.project?.id===p.id)S.project=null;await refresh();toast('项目状态已更新，历史数据保留');},{intro:'回收站恢复后先保持归档只读，需要另行取消归档才能继续执行。',submit:'确认'+title});return;
  }
  if(name==='admin-ai-edit'){
   const c=await api(base+'/ai-settings');
   showForm('AI模型配置（仅系统管理员）',[
    {name:'enabled',label:'全站启用外部AI',type:'checkbox',value:c.enabled,full:true},
    {name:'provider',label:'API协议',type:'select',options:[['openai_compatible','OpenAI兼容 Chat Completions'],['anthropic','Anthropic Messages']],value:c.provider,full:true},
    {name:'baseUrl',label:'API URL基址（含 /v1，不含最终接口路径）',value:c.baseUrl,full:true,maxLength:500},
    {name:'model',label:'Model（真实模型ID）',value:c.model,full:true,maxLength:120},
    {name:'key',label:c.keyConfigured?'替换 API Key（留空保留原值）':'API Key',type:'password',required:false,full:true,maxLength:8192,autocomplete:'off'},
    {name:'clearKey',label:'清除已保存Key（须同时关闭AI）',type:'checkbox',full:true},
    {name:'confirmExternalHost',label:'确认第三方接收方',type:'checkbox',full:true,checkboxText:'如使用第三方网关，我已核对域名与数据处理方式，同意将其加入本应用允许名单'},fieldReason
   ],async a=>{await save('/ai-settings',{...a,enabled:!!a.enabled,clearKey:!!a.clearKey,confirmExternalHost:!!a.confirmExternalHost,expectedRevision:c.revision});await refresh();toast('配置已加密保存；项目需重新确认AI规则，未调用模型');},
   {intro:'不回显已有Key。保存后覆盖原环境变量AI配置；Key/配置变更使旧项目授权失效。不填写token价格或输出字数。实际费用以服务商账单为准。',submit:'加密保存配置'});return;
  }
  if(name==='admin-ai-prompts'){
   const c=await api(base+'/ai-settings'),p=c.prompts;
   showInfo('内置通用分析提示词',`<p>版本：${e(p.version)}。不需要自己写提示词，核心规则不能被补充偏好覆盖。</p><details open><summary>共同核心规则</summary><pre class="admin-json">${e(p.core)}</pre></details>${Object.entries(p.tasks).map(([k,t])=>`<details><summary>${e({project:'项目合理性',purchase:'支出／采购',stage:'阶段复盘'}[k])}</summary><p class="long-text">${e(t)}</p></details>`).join('')}`);return;
  }
  if(name==='admin-ai-guidance'){
   const c=await api(base+'/ai-settings');
   showForm('补充分析偏好（可留空）',[{name:'analysisGuidance',label:'例如：优先关注制作时间和返工，不必假设有客户或库存',type:'textarea',full:true,required:false,maxLength:2000,value:c.analysisGuidance||''},fieldReason],async a=>{
    await save('/ai-settings',{enabled:c.enabled,provider:c.provider,baseUrl:c.baseUrl,model:c.model,analysisGuidance:a.analysisGuidance,reason:a.reason,expectedRevision:c.revision});await refresh();toast('补充偏好已保存；原提示词核心规则不变，项目需重新确认');
   },{intro:'默认内置通用提示词已可直接使用。不要填写密钥或隐私；补充内容只能影响关注重点，不能赋予AI审批权。'});return;
  }
  if(name==='admin-ai-test'){
   const c=await api(base+'/ai-settings');
   showForm('测试AI连接', [{name:'confirmCost',label:'确认可能计费',type:'checkbox',full:true,checkboxText:'确认仅发送通用测试句，不包含项目数据；调用可能计费，失败不会自动重试'}],async a=>{
    if(!a.confirmCost)throw Error('请先确认测试及可能费用');const v=await save('/ai-settings/test',{confirmCost:true,expectedRevision:c.revision});toast(v.message,!v.ok);
   },{submit:'发起一次测试'});return;
  }
 }
 return {page,action,open,load,reset};
}
