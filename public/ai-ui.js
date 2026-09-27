// AI UI never has access to provider keys. All generated text is HTML-escaped.
export function createAiUI(h) {
 const {S,e,api,act,reauth,showForm,showInfo,render,btn,panel,pageHead,money,shortDate,toCents,amountInput,isPartner,mOptions,stageOptions,toast}=h;
 let overview=null,report=null,projectId=null,timer=null;
 const names={project:'项目合理性分析',purchase:'支出／采购分析',stage:'阶段复盘分析'};
 const statuses={queued:'等待分析',running:'分析中',completed:'已完成',failed:'分析失败',uncertain:'结果不确定',cancelled:'发送前已取消'};
 const verdicts={pilot_candidate:'可考虑小规模验证（不是批准）',needs_information:'建议补充资料后再议',major_risk:'存在重大风险',insufficient_data:'资料不足，暂无法判断'};
 const fields={context:'项目具体情况（一段话即可）',focus:'希望重点分析什么（可选）'};
 const base=()=>`/api/projects/${S.project.id}`;
 const stop=()=>{clearTimeout(timer);timer=null;};
 function reset(){stop();overview=null;report=null;projectId=null;}
 async function load(offset=0){stop();const pid=S.project.id;const result=await api(`${base()}/ai?offset=${offset}`);if(S.project?.id!==pid)return;overview=result;projectId=pid;
  if(report){const r=await api(`${base()}/ai/runs/${report.id}`);if(S.project?.id!==pid)return;report=r;}
  if(result.runs.some(j=>['queued','running'].includes(j.status))&&S.tab==='ai')timer=setTimeout(async()=>{if(S.project?.id!==pid||S.tab!=='ai')return;try{await load(offset);render();}catch{stop();}},2500);
 }
 const badge=(s)=>`<span class="badge ${['failed','uncertain'].includes(s)?'bad':s==='completed'?'good':'warn'}">${e(statuses[s]||s)}</span>`;
 const refs=ids=>(ids||[]).map(id=>btn('依据：'+id,'ai-source',`data-source="${e(id)}"`,'small')).join(' ');
 function page(){
  if(report&&projectId===S.project?.id)return reportPage();
  const d=projectId===S.project?.id?overview:null;
  return pageHead('AI分析与风险检查','辅助判断，不代替全员会签；所有正式报告和失败记录对项目成员可见。',btn('刷新记录','ai-refresh'))+
   `<div class="alert info">AI没有投票权，不能批准采购或更改预算。缺少数据时允许回答“不知道”，不要把分析结论当作盈利保证。</div>`+
   (d?`<div class="metrics ai-metrics"><div class="metric"><span>本月已用＋预占调用（UTC）</span><strong>${d.usage.calls} / ${d.policy?.monthlyCallLimit||'—'}</strong></div><div class="metric"><span>实际尝试 / 尚未发送预占</span><strong>${d.usage.actualCalls??0} / ${d.usage.reservedCalls??0}</strong><small>成功报告 ${d.usage.completed??0} · 失败 ${d.usage.failed??0} · 不确定 ${d.usage.uncertain??0}</small></div><div class="metric"><span>输入／输出 token</span><strong>${d.usage.inputTokens} / ${d.usage.outputTokens}</strong><small>用量未知的调用 ${d.usage.unknownUsageCount} 次</small></div><div class="metric"><span>外部分析授权</span><strong>${d.consented?'全员已确认':d.suspended?'已暂停':'尚未生效'}</strong><small>AI不能替代任一合伙人</small></div></div>`:'')+
   panel('三个分析入口',`<div class="panel-body ai-actions">${Object.entries(names).map(([k,n])=>btn(n,'ai-new',`data-kind="${k}" ${isPartner()?'':'disabled'}`,'primary')).join('')}<p class="muted">先查看脱敏数据与程序规则检查，再明确确认是否发送。未配置模型也可预览本地检查，不会生成伪造的AI报告。</p></div>`)+
   panel('项目依据与模型设置',`<div class="panel-body"><p>${e(d?.engine.configured?`${d.engine.provider} / ${d.engine.model} / ${d.engine.baseUrl}`:d?.engine.error||'请刷新查看服务端配置')}</p><p class="muted">${e(d?.scopeNotice||'请系统管理员在“系统管理 → AI模型配置”中填写Key、Model和URL；已保存密钥不回显。')}</p><p class="muted">${e(d?.budgetNotice||'')}</p>${S.user.systemRole==='admin'?`<div class="buttons">${btn('打开管理员模型配置','admin-open','data-section="ai"','small')}</div>`:''}<p>自动触发：采购提交 ${d?.policy?.autoPurchase?'超过 '+money(d.policy.purchaseThresholdCents??50000)+' 或关联累计异常时分析':'关闭（可手动分析）'}；阶段开放／验收 ${d?.policy?.autoStage?'开启':'关闭'}。</p>${isPartner()?`<div class="buttons">${btn('项目情况与分析重点','ai-brief')}${btn('经营场景测算（可选）','ai-scenarios','','small')}${btn('提议启用／变更AI规则','ai-policy')}${btn('暂停后续外部发送','ai-suspend','','danger')}</div>`:''}</div>`)+
   panel('完整报告历史（不隐藏失败记录）',d?.runs.length?`<div class="table-wrap"><table><thead><tr><th>分析对象</th><th>状态</th><th>数据版本</th><th>时间</th><th></th></tr></thead><tbody>${d.runs.map(j=>`<tr><td>${e(names[j.kind])}<div class="cell-sub">${e(targetTitle(j))}</div></td><td>${badge(j.status)}</td><td>${j.stale?'已过期，勿作当前依据':'对应当前已登记数据'}<div class="cell-sub">${j.accounting?.sentCalls??(j.status==='completed'?1:0)} 次实际尝试${j.accounting?.continuationPending?' · 等待补齐':''} · ${j.accounting?.usage?'已记录用量':'用量未返回'}</div></td><td>${shortDate(j.createdAt)}</td><td>${btn('查看','ai-open',`data-id="${j.id}"`,'small')}</td></tr>`).join('')}</tbody></table></div><div class="panel-body buttons">${btn('最新记录','ai-refresh')}${d.nextOffset!=null?btn('较早记录','ai-older',`data-offset="${d.nextOffset}"`):''}<small>共 ${d.total} 次请求</small></div>`:`<div class="panel-body"><p>暂无分析记录。用一段话说明项目即可；资料不全仍可分析。需先配置模型并完成全员授权。</p></div>`);
 }
 function targetTitle(j){return j.kind==='project'?S.project.name:j.kind==='purchase'?S.project.purchases.find(q=>q.id===j.targetId)?.title||j.targetId:S.project.stages.find(s=>s.id===j.targetId)?.name||j.targetId;}
 function reportPage(){const r=report,v=r.report;
  return pageHead(names[r.kind]||'分析记录',targetTitle(r),btn('返回分析列表','ai-back')+btn('刷新','ai-refresh'))+
   `<div class="alert ${r.stale?'bad':'info'}">${r.stale?'此报告对应的输入已变化或日期已更新，报告已过期。':'报告依据的是生成时的已登记资料快照。'} 未联网核查市场；未读取原附件；引用来源不代表原始资料真实。</div>`+
   `<div class="buttons">${badge(r.status)}<span>${shortDate(r.createdAt)} · ${e(r.engine.model)}</span><a class="btn small" href="${base()}/ai/runs/${r.id}/export">导出完整报告与依据</a>${isPartner()?btn('重新检查当前数据','ai-new',`data-kind="${r.kind}" data-target="${e(r.targetId)}"`):''}</div><div class="spacer"></div>`+
   (!v?panel('未形成有效AI结论',`<div class="panel-body"><p>${e(r.error||(r.accounting?.continuationPending?'输出已保存，等待后台调度补齐；刷新页面不会另起分析。':'分析已进入任务队列，等待处理。'))}</p><p class="muted">失败或超时不代表没有风险；可能已计费，不会自动重试。</p></div>`):
   panel(e(verdicts[v.verdict]),`<div class="panel-body long-text"><p>${e(v.summary)}</p><div class="buttons">${refs(v.summaryRefs)}</div></div>`)+
   panel('风险与依据',`<div class="panel-body">${v.findings.map(f=>`<article class="ai-finding"><h4><span class="badge ${f.severity==='high'?'bad':f.severity==='warning'?'warn':''}">${e({high:'高风险',warning:'需关注',info:'说明'}[f.severity])}</span> ${e(f.title)}</h4><p class="muted">${e({input:'来自输入资料，真实性仍需核实',inference:'推断，非已证实事实',missing:'缺失资料'}[f.basis])}</p><p class="long-text">${e(f.detail)}</p>${f.evidence.map(q=>`<blockquote>${e(q.quote)}</blockquote>`).join('')}<p><strong>建议：</strong>${e(f.suggestion)}</p><div class="buttons">${refs(f.refs)}${isPartner()?btn('记录风险处置','ai-review',`data-finding="${e(f.id)}"`,'small'):''}</div>${r.reviews.filter(x=>x.findingId===f.id).map(x=>`<p class="muted">${e(S.project.members.find(m=>m.id===x.memberId)?.name||'成员')} · ${e({supplement:'补充依据',mitigate:'采取措施',accept_risk:'知情接受风险'}[x.disposition])}：${e(x.note)}</p>`).join('')}</article>`).join('')}</div>`)+
   panel('缺少的资料与待共同决定事项',`<div class="panel-body">${v.missingInformation.map(x=>`<p><strong>${e(x.topic)}</strong>：${e(x.why)}</p>`).join('')}${v.decisions.map(x=>`<p>${e(x)}</p>`).join('')}</div>`)+
   panel('待人工确认的任务建议',`<div class="panel-body">${v.recommendations.map((x,i)=>`<article class="ai-finding"><h4>${e(x.title)}</h4><p>${e(x.description)}</p><p>验收成果：${e(x.deliverable)}</p>${r.linkedTasks.some(t=>t.aiSource.index===i)?'<span class="badge good">已建立正式任务</span>':isPartner()?btn('确认分工后建立任务','ai-task',`data-index="${i}"`):''}</article>`).join('')}<p class="muted">任务建议不是预算、计划或审批变更，涉及变更仍走共同决策。</p></div>`)+
   panel('分析限制',`<div class="panel-body">${v.limitations.map(x=>`<p>${e(x)}</p>`).join('')}</div>`))+
   panel('独立的程序规则检查与场景测算',`<div class="panel-body">${r.snapshot.checks.map(c=>`<p><strong>${e(c.title)}</strong>：${e(c.detail)} ${refs(c.refs)}</p>`).join('')}<details><summary>查看完整脱敏输入、整数金额及场景计算（人民币分）</summary><pre class="ai-json">${e(JSON.stringify(r.snapshot,null,2))}</pre></details></div>`);
 }
 async function refresh(){S.project=await api(base());await load();render();}
 async function preview(kind,targetId='') {
  const pid=S.project.id,v=await api(`${base()}/ai/preview`,{method:'POST',body:{kind,targetId}});if(S.project?.id!==pid)return;
  const same=(S.project.ai?.runs||[]).filter(j=>j.snapshotHash===v.hash&&['failed','uncertain'].includes(j.status)).length>0;
  showForm('先核对发送范围与本地规则',[
   {name:'local',type:'html',label:'无需调用AI的检查',full:true,html:`<div class="ai-preview">${v.body.checks.map(c=>`<p><strong>${e(c.title)}</strong>：${e(c.detail)}</p>`).join('')}<p>本次最多预占 ${v.callSlots??1} 次调用（仅长度中断时补齐一次）；按服务商账单付费。${v.purchaseAssessment?e(v.purchaseAssessment.reason)+'。本次为主动分析，不受小额免自动分析限制。':''} 数据接收方：${e(v.engine.baseUrl||'未配置')}。</p><details><summary>查看将发送的完整数据（必须检查自由文本隐私）</summary><pre class="ai-json">${e(JSON.stringify(v.body,null,2))}</pre></details></div>`},
   {name:'confirmSend',label:'确认发送',type:'checkbox',full:true,checkboxText:'我已检查数据预览，确认向全员同意的模型发送；理解AI只是辅助分析'},
   ...(same?[{name:'retry',label:'再次调用',type:'checkbox',full:true,checkboxText:'相同资料已有失败／不确定调用。我已核对记录，确认重试可能再次计费'}]:[])
  ],async a=>{if(!a.confirmSend)throw Error('请先检查并确认发送');if(same&&!a.retry)throw Error('请明确确认重试及费用');await reauth();
   const result=await api(`${base()}/ai/runs`,{method:'POST',body:{kind,targetId,previewHash:v.hash,confirmSend:true,retry:!!a.retry,acceptPossibleCharge:!!a.retry}});
   S.tab='ai';S.purchaseId=null;projectId=pid;report=await api(`${base()}/ai/runs/${result.id}`);await refresh();toast(result.cached?'已复用同一输入的报告／任务，没有新增调用':'已登记分析请求');
  },{submit:'确认并请求分析',intro:v.consented?'全员授权已生效；本次仍由你明确确认发送。':'当前尚未完成模型配置或全员授权，可以查看本地检查，但暂不能发送。'});
 }
 async function action(name,el){
  if(name==='ai-refresh'){await refresh();return;}
  if(name==='ai-older'){report=null;await load(Number(el.dataset.offset));render();return;}
  if(name==='ai-back'){report=null;await load();render();return;}
  if(name==='ai-open'){const pid=S.project.id;const r=await api(`${base()}/ai/runs/${el.dataset.id}`);if(S.project?.id!==pid)return;report=r;projectId=pid;render();return;}
  if(name==='ai-source'){const s=report?.snapshot.sources.find(x=>x.id===el.dataset.source);if(s)showInfo(s.label,`<pre class="ai-json">${e(JSON.stringify(s.data,null,2))}</pre>`);return;}
  if(name==='ai-suspend'){showForm('暂停后续外部AI发送',[{name:'confirm',type:'checkbox',full:true,checkboxText:'暂停未来发送；理解已发出的请求无法撤回'}],async a=>{if(!a.confirm)throw Error('请确认暂停');await act('ai.suspend',{},true);await refresh();});return;}
  if(name==='ai-new'){
   const kind=el.dataset.kind;if(kind==='project'||el.dataset.target)return preview(kind,el.dataset.target||'');
   const options=kind==='purchase'?S.project.purchases.map(q=>[q.id,q.title+' · V'+q.version]):stageOptions();
   if(!options.length)throw Error(kind==='purchase'?'请先建立采购草稿':'请先填写项目阶段');
   showForm(names[kind],[{name:'targetId',label:'选择分析对象',type:'select',options,full:true}],a=>preview(kind,a.targetId),{submit:'查看数据预览'});return;
  }
  if(name==='ai-policy'){
   await load();const d=overview;if(!d.engine.configured)throw Error(d.engine.error+'。请管理员打开“系统管理 → AI模型配置”完成设置。');
   showForm('AI授权与金额分级',[
    {name:'limit',label:'每月最多调用次数（UTC自然月）',type:'number',min:1,max:300,value:d.policy?.monthlyCallLimit||30},
    {name:'threshold',label:'超过多少元自动分析',type:'money',value:amountInput(d.policy?.purchaseThresholdCents??50000),help:'默认示例500元，可调整。等于或低于阈值的普通支出不自动分析，关联累计异常例外。'},
    {name:'reportStyle',label:'报告详细程度',type:'select',options:[['concise','精简：先看结论和最多3个重点'],['standard','标准：主要依据与建议'],['detailed','详细：展开方案与取舍']],value:d.policy?.reportStyle||'concise'},
    {name:'autoPurchase',type:'checkbox',full:true,value:d.policy?!!d.policy.autoPurchase:true,checkboxText:'支出提交后按金额及关联累计判断是否分析（小额免AI，不免会签）'},
    {name:'autoStage',type:'checkbox',full:true,value:!!d.policy?.autoStage,checkboxText:'阶段开放／验收通过后自动请求复盘'},
    {name:'confirm',type:'checkbox',full:true,checkboxText:'我已阅读最小发送范围、模型接收方、调用保护及金额分级，提交给全体合伙人逐人确认'}
   ],async a=>{if(!a.confirm)throw Error('请确认发送范围');await reauth();S.project=await api(`${base()}/ai/policy`,{method:'POST',body:{monthlyCallLimit:Number(a.limit),purchaseThresholdCents:toCents(a.threshold),reportStyle:a.reportStyle,autoPurchase:!!a.autoPurchase,autoStage:!!a.autoStage,confirmScope:true,engineFingerprint:d.engine.fingerprint}});await refresh();},
   {intro:`接收方 ${d.engine.baseUrl}；模型 ${d.engine.model}。${d.scopeNotice} ${d.budgetNotice}`,submit:'提交全员共同决策'});return;
  }
  if(name==='ai-brief'){
   const old=S.project.ai?.brief?.data||{};
   showForm('项目情况与分析重点',[
    {name:'context',label:'简单说明项目具体情况',type:'textarea',full:true,value:old.context||S.project.description||old.business||'',required:false,maxLength:6000,rows:5,help:'例如：三人合作做AI漫剧，先完成一条样片，验证制作成本和效果，再决定是否批量制作。未知的先不填，不要求客户或订单。'},
    {name:'focus',label:'最担心什么／希望重点分析什么（可留空）',type:'textarea',full:true,value:old.focus||'',required:false,maxLength:2000},
    {name:'legacy',label:'资料说明',type:'html',full:true,html:`<p class="muted">已有计划、预算、任务和支出会自动带入。只更新分析资料，不改原批准计划；旧结构化资料和可选场景会保留。</p>`}
   ],async a=>{await act('ai.materials',{context:a.context,focus:a.focus});await refresh();},{intro:'一段话即可，不要求商业计划书。不填写密码、API密钥或完整个人账户。'});return;
  }
  if(name==='ai-scenarios'){
   const old=S.project.ai?.brief?.data||{},f=[{name:'help',label:'仅在适用时填写',type:'html',full:true,html:'<p>项目没有销售/收入模型时无需使用。这里只记录你的假设，不是预测；留空不会影响分析。现金与利润分开，注意不要重复填支出。</p>'}];
   for(let i=0;i<3;i++){const row=old.scenarios?.[i];f.push({name:`s${i}_enabled`,label:'可选假设',type:'checkbox',full:true,value:!!row,checkboxText:`使用第${i+1}个经营场景`},{name:`s${i}_label`,label:'场景名称',value:row?.label||['较差情况','基准假设','较好情况'][i],required:false});
    for(const [key,label] of Object.entries({units:'预计数量',priceCents:'单位收入（元）',unitCostCents:'单位成本（元）',fixedCostCents:'固定成本（元）',openingCashCents:'期初现金（元）',upfrontCents:'前置付款（元）',otherCashOutCents:'其他现金支出（元）',collectionBps:'当期收款比例（%）'}))f.push({name:`s${i}_${key}`,label,type:key==='units'?'number':'money',value:row?(key==='units'?row[key]:amountInput(row[key])):'',required:false,min:0});
   }
   showForm('可选经营场景，不影响通用分析',f,async a=>{const scenarios=[];for(let i=0;i<3;i++)if(a[`s${i}_enabled`]){const row={label:a[`s${i}_label`]};for(const key of ['units','priceCents','unitCostCents','fixedCostCents','openingCashCents','upfrontCents','otherCashOutCents','collectionBps'])row[key]=key==='units'?Number(a[`s${i}_${key}`]):toCents(a[`s${i}_${key}`]);scenarios.push(row);}await act('ai.materials',{scenarios});await refresh();});return;
  }
  if(name==='ai-review'){
   const rid=report.id,findingId=el.dataset.finding;
   showForm('记录风险处置',[{name:'disposition',label:'处理方式',type:'select',options:[['supplement','补充依据'],['mitigate','采取措施'],['accept_risk','知情接受风险']]},{name:'note',label:'依据、措施或继续执行的理由',type:'textarea',full:true}],async a=>{await reauth();S.project=await api(`${base()}/ai/runs/${rid}/reviews`,{method:'POST',body:{...a,findingId}});await refresh();},{intro:'这是一条保留历史的人工说明，不等于采购批准。'});return;
  }
  if(name==='ai-task'){
   const rid=report.id,index=Number(el.dataset.index),r=report.report.recommendations[index],stale=report.stale;
   showForm('人工确认任务与验收分工',[{name:'title',label:'任务名称',value:r.title,full:true},{name:'description',label:'任务说明',type:'textarea',value:r.description,full:true},{name:'deliverable',label:'验收成果',type:'textarea',value:r.deliverable,full:true},{name:'stageId',label:'关联阶段',type:'select',options:stageOptions()},{name:'assigneeId',label:'负责人',type:'select',options:mOptions()},{name:'reviewerId',label:'不同的验收人',type:'select',options:mOptions()},{name:'dueDate',label:'截止日期',type:'date'},{name:'confirm',label:'确认任务',type:'checkbox',full:true,checkboxText:stale?'原报告已过期，我已核对当前情况，确认以上任务与分工':'我已审阅建议，确认以上任务、负责人、验收人和期限'}],async a=>{if(!a.confirm)throw Error('请明确确认');await reauth();S.project=await api(`${base()}/ai/runs/${rid}/tasks`,{method:'POST',body:{...a,index,confirm:true,confirmStale:stale}});await refresh();});return;
  }
 }
 return {page,load,action,reset,stop};
}
