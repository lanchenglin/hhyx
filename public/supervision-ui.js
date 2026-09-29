// Lightweight investor-oriented views. All writes use existing project actions and unanimous proposals.
export function createSupervisionUI({S,e,act,showForm,showInfo,btn,panel,money,shortDate,toCents,amountInput,isPartner,toast,navigate,selectProject}) {
  const p=()=>S.project, data=()=>p().supervision||{reports:[],issues:[],fundings:[],changes:[]};
  const view=()=>p().supervisionView||{}, member=id=>p().members.find(m=>m.id===id), mine=()=>p().currentMemberId;
  const writable=()=> (p().lifecycle||'active')==='active'&&['active','paused'].includes(p().status);
  const canWrite=()=>writable()&&member(mine())?.role!=='viewer';
  const partnerWrite=()=>writable()&&isPartner();
  const peers=()=>p().members.filter(m=>m.active&&m.userId&&m.role==='partner');
  const workers=()=>p().members.filter(m=>m.active&&m.userId&&m.role!=='viewer');
  const b=(title,action,id='',extra='',cls='')=>btn(title,'supervision-'+action,`${id?`data-id="${e(id)}"`:''} ${extra}`,cls);
  const go=(title,tab)=>`<button class="btn small" data-tab="${e(tab)}">${e(title)}</button>`;
  const day=()=>view().today||new Date().toISOString().slice(0,10);
  const plus=n=>new Date(Date.parse(day()+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
  const note=(name,label,required=true,value='')=>({name,label,type:'textarea',full:true,required,value,maxLength:3000});
  const choices=list=>list.map(x=>[x.id,x.name||x.title]);
  const stageChoices=()=>choices(p().stages.filter(s=>s.status==='open'));
  const reason=()=>note('reason','为什么需要共同决定');
  const intro='不自动付款、不代替任何人同意。提交后在「共同决策」由各自账号确认。';
  const pending=k=>p().proposals.filter(g=>g.kind===k&&g.status==='pending');
  const empty=t=>`<p class="muted">${e(t)}</p>`;
  const textBlock=t=>`<p class="sup-text">${e(t||'未补充')}</p>`;
  const kv=(key,value)=>`<dt>${e(key)}</dt><dd>${value}</dd>`;
  const status=value=>`<span class="badge ${['critical','needs_verification'].includes(value)?'bad':['open','doing','review','waiting','partial'].includes(value)?'warn':'good'}">${e({open:'待处理',doing:'处理中',review:'待独立复核',closed:'已复核关闭',waiting:'尚未核实到账',partial:'部分到账',funded:'已核实到账',cancelled:'已共同撤销',critical:'重要异常',warning:'需关注'}[value]||value)}</span>`;
  const header=(title,description,buttons='')=>`<div class="page-head"><div><div class="eyebrow">COOPERATION / SUPERVISION</div><h1>${e(title)}</h1><p>${e(description)}</p></div><div class="buttons">${buttons}</div></div>`;
  function attachments(ids=[]) {return ids.map(id=>{const f=p().attachments.find(f=>f.id===id);return f?`<a class="btn small" href="/api/projects/${encodeURIComponent(p().id)}/files/${encodeURIComponent(id)}" download>${e(f.name)}</a>`:'';}).join('');}
  function attachmentField() {return {name:'attachmentId',label:'关联已有附件（可选）',type:'select',full:true,required:false,options:[['','不选择；也可在成果说明中填写位置'],...choices(p().attachments)]};}
  const selectedFile=a=>a.attachmentId?[a.attachmentId]:[];
  const reportFundingField=old=>({name:'fundingId',label:'本次是否复盘一笔追加投入（可选）',type:'select',full:true,required:false,value:old?.fundingIds?.[0]||'',options:[['','一般汇报，不关联追加投入'],...data().fundings.filter(f=>f.status!=='cancelled').map(f=>[f.id,money(f.additionalCents)+' · '+f.reason])]});
  const metric=(title,value,detail)=>`<article class="sup-metric"><span>${e(title)}</span><strong>${value}</strong><small>${e(detail)}</small></article>`;
  async function propose(kind,payload,reasonText) {await act('proposal.submit',{kind,payload,reason:reasonText});toast('已提交全体会签，尚未生效；请各成员独立确认');}

  function overview() {
    const v=view(),s=data(),f=p().finance,latest=s.reports.at(-1),my=v.myPending||{};
    const needs=v.informationStatus==='needs_verification';
    return header('出资人总览','不盯日常细节，只看成果、资金、偏差和需要你决定的事。',b('刷新资料','refresh')+(isPartner()&&(p().lifecycle||'active')==='active'?b('监督规则','policy','','','primary'):''))+
      `<div class="sup-banner ${needs?'sup-warning':''}"><strong>${needs?'资料待核实，不显示“一切正常”':'已有执行汇报，仍需结合成果和对账核实'}</strong><p>最近汇报：${e(v.lastReportAt?shortDate(v.lastReportAt):'尚未提交')}（进展覆盖至 ${e(v.reportedThrough||'未知')}） · 最近真实资金对账：${e(v.lastReconciledAt?shortDate(v.lastReconciledAt):'尚未完成')}</p>${!v.policy?.enabled?'<p>周期提醒和新增投入限制尚未共同启用。先在监督规则中约定负责人、频率与适用条件。</p>':`<p>下次汇报截止：${e(v.reportDueDate||'—')}；汇报负责人：${e(member(v.policy.reporterId)?.name||'待核实')}。</p>`}</div>`+
      `<div class="sup-metrics">${metric('已登记实际支出',money(v.reportedOutCents||0),'含返还与分配等现金流出，不等于亏损')}${metric('已承诺尚未支付',money(v.committedUnpaidCents||0),'采购、分配、退出及手工应付；按已登记资料')}${metric('可用于新安排',money(f.availableCents),'不把未到账承诺当作现金')}${metric('待复核账目',String(f.unverifiedCount)+' 笔待复核','银行及支付平台未自动同步')}</div>`+
      ((v.holds||[]).length?`<div class="alert bad"><strong>新增投入目前受限</strong>${v.holds.map(h=>textBlock(h.message)).join('')}已有账目、收付和责任仍须如实处理。</div>`:'')+
      panel('当前阶段与成果',`<div class="panel-body">${(v.currentStages||[]).map(st=>`<article class="sup-card"><h3>${e(st.name)}</h3>${textBlock(st.goal)}<dl class="kv">${kv('验收标准',e(st.acceptance))}${kv('阶段预算',money(st.budgetCents))}${kv('截止日期',e(st.endDate||'未约定'))}${kv('成果状态',st.reportAccepted&&st.reportCurrent?'已独立验收，仍须阶段会签':st.reportId?'已提交，需核对验收及版本':'尚未提交阶段成果')}</dl><div class="buttons">${go('查看／提交成果','reports')}${partnerWrite()?btn('申请阶段验收','stage-proposal',`data-kind="stage_close" data-id="${e(st.id)}"`,'small'):''}</div></article>`).join('')||empty('尚无已开放阶段。先确认合作基准，不能因为总预算有余额就直接扩大。')}</div>`)+
      panel('需要你处理',`<div class="panel-body sup-actions">${go(`共同决策 ${my.decisions?.length||0} 项`,'decisions')}${go(`支出会签 ${my.purchases?.length||0} 项`,'purchases')}${go(`未阅汇报 ${my.unreadReports?.length||0} 份／待验收 ${my.stageReviews?.length||0} 份`,'reports')}${go(`异常处理 ${my.issues?.length||0} 项`,'issues')}${go('追加投入与到账','funding')}${go('计划变更对比','changes')}</div>`)+
      panel('最新执行说明',`<div class="panel-body">${latest?`<h3>${e(member(latest.authorId)?.name||'成员')} · ${e(latest.toDate)}</h3>${textBlock(latest.completed)}<div class="buttons">${b('看成果和冻结数据','report-view',latest.id)}</div>`:empty('尚未提交汇报。没有消息不代表按计划执行，也不代表线下没有花钱。')}</div>`)+
      panel('已发现的偏差线索',`<div class="panel-body">${(v.alerts||[]).map(a=>`<article class="sup-card">${status(a.severity)}<strong>${e(a.title)}</strong>${textBlock(a.detail)}</article>`).join('')||empty('当前已登记资料未发现上述规则异常；这不是对未录入线下行为的保证。')}${go('进入异常闭环','issues')}</div>`);
  }
  function reportsPage() {
    return header('简短汇报与阶段成果','完成什么、成果在哪里、有什么变化、接下来做什么。已阅不等于批准。',canWrite()?b('提交简短汇报','report-new','','','primary')+b('提交阶段成果','report-stage'):'' )+
      panel('汇报记录',`<div class="panel-body">${data().reports.slice().reverse().map(r=>`<article class="sup-card"><div class="sup-row"><h3>${e(r.kind==='stage'?'阶段成果':'简短汇报')} · ${e(p().stages.find(st=>st.id===r.stageId)?.name||'阶段')}</h3><span class="badge">V${r.version}</span></div><p class="muted">${e(r.fromDate)}—${e(r.toDate)} · ${e(member(r.authorId)?.name)} · ${shortDate(r.at)}</p>${textBlock(r.completed)}<p>${r.review?r.review.accept?'独立验收通过（非阶段会签）':'验收退回，等待更正':r.kind==='stage'?'等待指定人员独立验收':'供成员查看；不自动改变计划'}</p><p class="muted">${Object.keys(r.readBy).length} 人已阅；${data().reports.some(x=>x.supersedesId===r.id)?'已有更正版本，旧内容保留':'当前记录保留不覆盖'}</p><div class="buttons">${b('查看成果／已阅／验收','report-view',r.id)}${canWrite()&&r.authorId===mine()&&!data().reports.some(x=>x.supersedesId===r.id)?b('提交更正版本','report-correct',r.id):''}</div></article>`).join('')||empty('暂时没有汇报，不要求填写客户、市场或供应链资料。')}</div>`);
  }
  function reportHtml(r) {
    const snap=r.snapshot,own=mine(),can=writable(),last=!data().reports.some(x=>x.supersedesId===r.id)&&(r.kind!=='stage'||data().reports.filter(x=>x.kind==='stage'&&x.stageId===r.stageId).at(-1)?.id===r.id);
    return `<p class="muted">${e(r.fromDate)}—${e(r.toDate)} · ${e(member(r.authorId)?.name)} · V${r.version}</p><h3>实际完成</h3>${textBlock(r.completed)}<h3>成果位置／依据</h3>${textBlock(r.evidence)}<div class="buttons">${attachments(r.attachments)}</div>${(r.fundingIds||[]).length?'<p>本次关联追加投入：'+r.fundingIds.map(id=>e(data().fundings.find(f=>f.id===id)?.reason||id)).join('；')+'。提交复盘不代表验证成功或批准下一轮。</p>':''}<h3>问题与偏差</h3>${textBlock(r.problems)}<h3>下一步／需要共同决定</h3>${textBlock(r.nextSteps)}<div class="alert info">阅读汇报不代表批准上述计划变化或追加投入；需要另外提交共同决策。</div><h3>提交时自动带入的数据</h3><dl class="kv">${kv('当期已登记支出',money(snap.period.reportedOutCents))}${kv('当期已登记流入',money(snap.period.reportedInCents))}${kv('当时可用于新安排',money(snap.finance.availableCents))}${kv('当时待复核账目',e(snap.finance.unverifiedCount)+' 笔')}</dl>${snap.tasks.map(t=>`<p>${e(t.title)} · ${e(t.status)} · 原定 ${e(t.dueDate)}</p>`).join('')}<details><summary>展开冻结快照与来源编号</summary><pre class="sup-json">${e(JSON.stringify(snap,null,2))}</pre></details><h3>已阅与验收分别记录</h3>${peers().map(m=>`<p>${e(m.name)}：${r.readBy[m.id]?'已阅 '+shortDate(r.readBy[m.id]):'尚未确认已阅'}</p>`).join('')}${r.review?textBlock((r.review.accept?'验收通过：':'验收退回：')+r.review.note):''}<div class="buttons">${can&&!r.readBy[own]?b('我已阅读，不代表同意变更','report-read',r.id):''}${partnerWrite()&&r.kind==='stage'&&!r.review&&last&&r.reviewerId===own?b('独立验收此阶段成果','report-review',r.id,'','primary'):''}</div>`;
  }
  function changeDiff(d) {
    const labels={description:'项目方向／说明',name:'阶段名称',goal:'阶段目标',acceptance:'验收标准',startDate:'开始日期',endDate:'关键截止日期',title:'任务名称',deliverable:'交付成果',dueDate:'任务截止日期'};
    return `<div class="table-wrap"><table><thead><tr><th>项目</th><th>原批准安排</th><th>拟调整安排</th></tr></thead><tbody>${Object.keys(d.after).map(k=>`<tr><td>${e(labels[k]||k)}</td><td class="sup-text">${e(d.before[k]||'未填写')}</td><td class="sup-text">${e(d.after[k]||'未填写')}</td></tr>`).join('')}</tbody></table></div>${textBlock(d.impact)}${d.earlyStageId?`<div class="alert bad">申请提前开放阶段，不代表前阶段已验收。${e(d.exceptionReason)}</div>`:''}`;
  }
  function changesPage() {
    return header('计划变更对比','日常做法在批准范围内自主安排；方向、规模、标准或关键期限改变要共同确认。',partnerWrite()?b('提出计划变更','change-new','','','primary'):'' )+
      panel('待确认的变更',`<div class="panel-body">${pending('plan_change').map(g=>`<article class="sup-card"><h3>${e(g.reason)}</h3>${changeDiff(g.payload)}${go('进入共同决策表态','decisions')}</article>`).join('')||empty('暂无待确认计划变更。预算重新分配用原预算变更，增加总投入用追加投入单。')}</div>`)+
      panel('已经共同批准的版本',`<div class="panel-body">${data().changes.slice().reverse().map(c=>`<article class="sup-card"><h3>${e(c.reason)}</h3><p class="muted">${shortDate(c.at)} · 共同决定 ${e(c.id)}</p>${changeDiff(c)}</article>`).join('')||empty('暂无已生效变更；原始基准和历史审批仍保留。')}</div>`);
  }
  function fundingHtml(f) {
    return `<div class="alert info">项目追加预算≠个人已承诺≠实际到账；比例不会自动改变，只有独立复核来款计入资金。</div><h3>前一轮结果</h3>${textBlock(f.previousResults)}<dl class="kv">${kv('本次追加',money(f.additionalCents))}${kv('追加用途',e({complete_original:'完成原约定',new_experiment:'新的试验',scale_up:'扩大规模',new_direction:'新增方向'}[f.purposeType]))}${kv('复盘日期',e(f.reviewDate))}${kv('当前已核实到账',money(f.receivedCents||0))}</dl><h3>验证什么／何时停止</h3>${textBlock(f.validation)}${textBlock(f.stopConditions)}${textBlock(f.terms)}<div class="buttons">${attachments(f.attachments)}</div><div class="table-wrap"><table><thead><tr><th>出资人</th><th>类型</th><th>本人确认的金额</th><th>已登记／已核实</th><th>操作</th></tr></thead><tbody>${f.allocations.map(a=>`<tr><td>${e(a.name||member(a.memberId)?.name)}</td><td>${a.kind==='loan_in'?'借款流入':'追加出资'}</td><td>${money(a.amountCents)}</td><td>${money(a.reportedCents||0)}／${money(a.verifiedCents||0)}</td><td>${partnerWrite()&&f.status!=='cancelled'&&a.remainingCents>0?b('登记真实到账','funding-receipt',f.id,`data-member="${e(a.memberId)}"`,'small')+b('关联已有流水','funding-link',f.id,`data-member="${e(a.memberId)}"`,'small'):''}</td></tr>`).join('')}</tbody></table></div><details><summary>提交时的资金与前轮资料</summary><pre class="sup-json">${e(JSON.stringify(f.before||{},null,2))}</pre></details>`;
  }
  function fundingPage() {
    const list=view().fundings||[];
    return header('追加投入与个人分担','先核对前一轮成果，再决定新增试验、投入分担和停止条件。',partnerWrite()?b('申请追加投入','funding-new','','','primary'):'' )+
      panel('等待共同决定',`<div class="panel-body">${pending('funding_request').map(g=>`<article class="sup-card"><strong>${money(g.payload.additionalCents)} · ${e(g.reason)}</strong>${textBlock(g.payload.previousResults)}${go('查看分担并逐人确认','decisions')}</article>`).join('')||empty('没有待批准的追加投入申请。')}</div>`)+
      panel('已批准追加与实际到账',`<div class="panel-body">${list.slice().reverse().map(f=>`<article class="sup-card"><div class="sup-row"><h3>${money(f.additionalCents)} · ${e(f.reason)}</h3>${status(f.progress)}</div><p>已登记 ${money(f.reportedCents)}／已核实 ${money(f.receivedCents)}；复盘日期 ${e(f.reviewDate)}</p><div class="buttons">${b('查看分担与登记到账','funding-view',f.id)}${partnerWrite()&&f.status!=='cancelled'&&!p().ledger.some(x=>x.fundingId===f.id)?b('申请撤销未到账承诺','funding-cancel',f.id):''}</div></article>`).join('')||empty('暂无已共同批准的追加投入。申请和承诺不会凭空增加现金余额。')}</div>`);
  }
  function issueHtml(i) {
    return `${status(i.status)} ${status(i.severity)}${textBlock(i.detail)}<dl class="kv">${kv('处理负责人',e(member(i.assigneeId)?.name))}${kv('独立复核人',e(member(i.reviewerId)?.name))}${kv('处理截止',e(i.dueDate))}</dl>${i.updates.map(u=>`<article class="sup-card"><p class="muted">${e(member(u.by)?.name)} · ${shortDate(u.at)}</p>${textBlock(u.cause||u.result||u.note)}${u.plan?textBlock(u.plan):''}${u.type==='review'?`<p>复核：${u.accept?'通过':'退回'} · ${e({resolved:'已消除',accepted:'风险仍在，知情处理',false_positive:'误报，已有依据'}[u.disposition])}</p>`:''}<div class="buttons">${attachments(u.attachments)}</div></article>`).join('')}<div class="buttons">${canWrite()&&i.status!=='closed'&&i.status!=='review'&&i.assigneeId===mine()?b('说明原因和处理办法','issue-respond',i.id)+b('提交处理结果','issue-resolve',i.id):''}${partnerWrite()&&i.status==='review'&&i.reviewerId===mine()?b('复核关闭／退回','issue-review',i.id,'','primary'):''}</div>`;
  }
  function issuesPage() {
    const s=data(),fresh=(view().alerts||[]).filter(a=>!s.issues.some(i=>i.sourceKey===a.key&&i.sourceFingerprint===a.fingerprint));
    return header('异常处理闭环','发现 → 负责人说明 → 提交结果 → 另一人复核。点已读不能让问题消失。',partnerWrite()?b('登记异常','issue-new','','','primary'):'' )+
      panel('当前规则发现的待核实线索',`<div class="panel-body">${fresh.map(a=>`<article class="sup-card">${status(a.severity)}<h3>${e(a.title)}</h3>${textBlock(a.detail)}${partnerWrite()?b('建立处理单','issue-new','',`data-source="${e(a.key)}"`):''}</article>`).join('')||empty('没有尚未建单的新线索。启用监督规则后，定时检查会自动建单并升级提醒。')}</div>`)+
      panel('处理与复核记录',`<div class="panel-body">${s.issues.slice().reverse().map(i=>`<article class="sup-card"><div class="sup-row"><h3>${e(i.title)}</h3>${status(i.status)}</div><p>${e(member(i.assigneeId)?.name)}处理，${e(member(i.reviewerId)?.name)}复核；截止${e(i.dueDate)}${i.status!=='closed'&&i.dueDate<day()?' · 已逾期':''}</p>${b('查看并处理','issue-view',i.id)}</article>`).join('')||empty('尚无异常处理单。没有更新资料也会在总览标记待核实。')}</div>`);
  }
  function page(tab) {return `<div class="sup-shell">${({supervision:overview,reports:reportsPage,changes:changesPage,funding:fundingPage,issues:issuesPage}[tab]||overview)()}</div>`;}
  function reportForm(kind,old=null) {
    const policy=data().policy,own=mine();
    showForm(old?'更正汇报（旧版本仍保留）':kind==='stage'?'提交阶段成果':'提交简短汇报',[
      {name:'stageId',label:'当前阶段',type:'select',options:stageChoices(),value:old?.stageId},
      {name:'fromDate',label:'本次汇报开始日期',type:'date',value:old?.fromDate||plus(-6)},
      {name:'toDate',label:'本次汇报结束日期',type:'date',value:day()},
      note('completed','实际完成了什么（没有进展也可如实说明）',true,old?.completed),
      note('evidence','成果在哪里／没有成果的原因',true,old?.evidence),
      note('problems','遇到什么问题，有没有偏离计划（可选）',false,old?.problems),
      note('nextSteps','接下来做什么，需要大家决定什么（可选）',false,old?.nextSteps),
      {name:'reviewerId',label:'阶段成果的独立验收人',type:'select',options:choices(peers().filter(m=>m.id!==own)),value:old?.reviewerId||policy?.reviewerId},reportFundingField(old),attachmentField()
    ],a=>act('report.submit',{...a,kind,supersedesId:old?.id,attachments:selectedFile(a),fundingIds:a.fundingId?[a.fundingId]:[]}),{intro:'任务、支出和承诺自动带入并冻结。此处只写进展，不必填客户、市场或商业计划书。',submit:'提交并通知成员'});
  }
  function policyForm() {
    const c=data().policy||{},own=mine();
    showForm('共同约定监督规则',[
      {name:'enabled',label:'启用监督',type:'checkbox',value:c.enabled??true,full:true,checkboxText:'启用周期检查、异常建单和升级提醒'},
      {name:'reporterId',label:'谁负责提交简短汇报',type:'select',options:choices(workers()),value:c.reporterId||own},
      {name:'reviewerId',label:'另一位阶段验收／异常复核人',type:'select',options:choices(peers()),value:c.reviewerId||peers().find(m=>m.id!==own)?.id},
      {name:'intervalDays',label:'多少天汇报一次',type:'number',min:1,max:30,value:c.intervalDays||7},
      {name:'firstDueDate',label:'首次／重置后的汇报截止',type:'date',value:plus(7)},
      {name:'reconcileDays',label:'多少天至少完成一次真实资金对账',type:'number',min:1,max:90,value:c.reconcileDays||14},
      {name:'escalateDays',label:'未处理事项升级提醒的宽限天数',type:'number',min:1,max:30,value:c.escalateDays||3},
      {name:'requireStageReport',label:'阶段成果前置验收',type:'checkbox',value:c.requireStageReport??true,full:true,checkboxText:'关闭阶段前，必须先提交成果并由另一位合伙人验收；之后仍须全体会签'},
      {name:'blockCritical',label:'重要异常限制新增投入',type:'checkbox',value:c.blockCritical??true,full:true,checkboxText:'重要异常未复核关闭时限制新增支出承诺，不影响登记已有责任'},
      {name:'blockStaleReport',label:'严重缺报限制新增投入（可选）',type:'checkbox',value:c.blockStaleReport??false,full:true,checkboxText:'汇报超过截止及宽限期后限制新增投入；普通延期默认只提醒'},reason()
    ],a=>propose('supervision_policy',{...a,enabled:!!a.enabled,requireStageReport:!!a.requireStageReport,blockCritical:!!a.blockCritical,blockStaleReport:!!a.blockStaleReport,intervalDays:Number(a.intervalDays),reconcileDays:Number(a.reconcileDays),escalateDays:Number(a.escalateDays)},a.reason),{intro:'旧项目不会被升级自动加锁。全体合伙人确认本规则后才启用相应限制，管理员不能代替他们同意。',submit:'提交全员确认'});
  }
  function changeForm(type,id) {
    const target=type==='project'?p():(type==='stage'?p().stages:p().tasks).find(x=>x.id===id);if(!target)throw Error('变更对象不存在');
    const list=type==='project'?[note('description','拟调整后的项目方向／说明',false,target.description)]:type==='stage'?[
      {name:'name',label:'阶段名称',value:target.name},note('goal','阶段目标',true,target.goal),note('acceptance','怎样算完成',true,target.acceptance),
      {name:'startDate',label:'开始日期（可选）',type:'date',required:false,value:target.startDate},{name:'endDate',label:'关键截止日期（可选）',type:'date',required:false,value:target.endDate},
      ...(target.status==='locked'?[{name:'openEarly',label:'提前开放例外',type:'checkbox',full:true,checkboxText:'申请在前阶段未验收时提前开放本阶段；需全员确认，仍需单独申请开放'},note('exceptionReason','提前开放的依据与尚未验证的风险（勾选时必填）',false)]:[])
    ]:[{name:'title',label:'任务名称',value:target.title},note('description','任务说明',false,target.description),note('deliverable','交付成果／验收标准',true,target.deliverable),{name:'dueDate',label:'关键截止日期',type:'date',value:target.dueDate}];
    showForm('提出计划变更',[
      {name:'original',label:'原批准安排',type:'html',full:true,html:`<pre class="sup-json">${e(JSON.stringify(Object.fromEntries(list.filter(f=>f.name in target).map(f=>[f.label,target[f.name]])),null,2))}</pre>`},
      ...list,note('impact','为什么这样改，对投入、时间和范围有什么影响'),reason()
    ],a=>propose('plan_change',{targetType:type,targetId:target.id,after:Object.fromEntries(list.filter(f=>f.name in target).map(f=>[f.name,a[f.name]||''])),openEarly:!!a.openEarly,exceptionReason:a.exceptionReason||'',impact:a.impact},a.reason),{intro,submit:'提交变更对比供全员确认'});
  }
  function fundingForm() {
    showForm('申请追加投入',[
      {name:'stageId',label:'投入用于哪个阶段',type:'select',options:choices(p().stages.filter(s=>s.status!=='completed'))},
      {name:'purposeType',label:'这次是完成原承诺，还是新增探索',type:'select',options:[['complete_original','完成原约定的交付'],['new_experiment','新的试验／渠道'],['scale_up','扩大规模'],['new_direction','新增项目方向']]},
      note('previousResults','前一轮换来了什么成果，还有什么没完成'),
      {name:'additional',label:'本次追加总额（元）',type:'money'},
      ...peers().flatMap(m=>[{name:'share_'+m.id,label:m.name+' 拟承担（元，0表示不承担）',type:'money',value:'0.00'},
        {name:'kind_'+m.id,label:m.name+' 投入类型',type:'select',options:[['contribution','追加出资，不自动改比例'],['loan_in','借款，条款另行约定']]}]),
      note('validation','本次用这笔投入验证什么'),note('stopConditions','什么情况下不再继续投入'),
      {name:'reviewDate',label:'何时提交本轮验证结果复盘',type:'date',value:plus(7)},note('terms','分担或借款补充约定（可选）',false),attachmentField(),reason()
    ],a=>{const allocations=peers().map(m=>({memberId:m.id,amountCents:toCents(a['share_'+m.id]),kind:a['kind_'+m.id]})).filter(x=>x.amountCents>0);return propose('funding_request',{stageId:a.stageId,purposeType:a.purposeType,additionalCents:toCents(a.additional),allocations,previousResults:a.previousResults,validation:a.validation,stopConditions:a.stopConditions,reviewDate:a.reviewDate,terms:a.terms,attachments:selectedFile(a)},a.reason);},{intro:'已有账目和最近成果自动冻结。每位承担人须额外确认自己的金额；批准预算不代表已经到账。',submit:'提交分担与投入会签'});
  }
  function issueForm(source) {
    const a=(view().alerts||[]).find(x=>x.key===source),policy=data().policy;
    showForm('建立异常处理单',[
      ...(a?[{name:'source',label:'当前线索',type:'html',full:true,html:`<p>${e(a.title)}</p><p>${e(a.detail)}</p>`}]:[{name:'title',label:'发生了什么'},note('detail','具体情况与已有依据'),{name:'severity',label:'异常等级',type:'select',options:[['warning','一般问题：说明与处理'],['critical','重要异常：可能触发已约定的新增投入限制']]}]),
      {name:'assigneeId',label:'谁负责处理',type:'select',options:choices(workers()),value:policy?.reporterId||mine()},
      {name:'reviewerId',label:'由哪位合伙人独立复核',type:'select',options:choices(peers()),value:policy?.reviewerId||peers().find(m=>m.id!==mine())?.id},
      {name:'dueDate',label:'处理截止',type:'date',value:plus(policy?.escalateDays||3)}
    ],a=>act('issue.create',{...a,sourceKey:source||null}),{intro:'这是待核实与处理记录，不自动认定违约或赔偿责任。',submit:'建立处理单并通知'});
  }
  function proposalHtml(g) {
    const d=g.payload;if(g.kind==='plan_change')return changeDiff(d);
    if(g.kind==='supervision_policy')return `<dl class="kv">${kv('监督规则',d.enabled?'启用':'停用')}${kv('汇报负责人',e(member(d.reporterId)?.name))}${kv('独立验收／复核',e(member(d.reviewerId)?.name))}${kv('汇报／对账周期',`${d.intervalDays}天／${d.reconcileDays}天`)}${kv('首次汇报',e(d.firstDueDate))}${kv('阶段成果前置',d.requireStageReport?'要求独立验收':'不要求新增成果门槛')}${kv('限制新增投入',`${d.blockCritical?'重要异常未关闭；':''}${d.blockStaleReport?'汇报严重逾期；':''}只对启用规则生效`)}</dl><p>仅在全员批准后生效；汇报已阅不是采购或变更批准。</p>`;
    if(g.kind==='funding_request')return `<h3>追加 ${money(d.additionalCents)}</h3>${textBlock(d.previousResults)}${textBlock(d.validation)}<p>停止条件：${e(d.stopConditions)}</p><p>复盘日期：${e(d.reviewDate)}</p>${d.allocations.map(a=>`<p>${e(a.name||member(a.memberId)?.name)}：${money(a.amountCents)} · ${a.kind==='loan_in'?'借款':'追加出资'}（须本人另行勾选确认分担）</p>`).join('')}<div class="alert info">全员通过后只增加批准预算，不伪造现金、不改变分配比例。未到账不能凭此新增可用资金。</div>`;
    if(g.kind==='funding_cancel')return '<p>共同取消尚无关联到账的追加承诺，并扣回未使用追加预算。已有流水、承诺和审计不会被删除。</p>';
    return null;
  }
  async function action(name,el) {
    const id=el?.dataset.id;
    if(name==='supervision-refresh'){await selectProject(p().id);return;}
    if(name==='supervision-report-view'){showInfo('汇报成果与来源',reportHtml(data().reports.find(x=>x.id===id)));return;}
    if(name==='supervision-funding-view'){showInfo('追加投入与到账核对',fundingHtml((view().fundings||[]).find(x=>x.id===id)));return;}
    if(name==='supervision-issue-view'){showInfo('异常处理与独立复核',issueHtml(data().issues.find(x=>x.id===id)));return;}
    if(name==='supervision-policy'){if(!isPartner()||(p().lifecycle||'active')!=='active')throw Error('仅本项目合伙人可提出监督规则');policyForm();return;}
    if(name==='supervision-report-new'||name==='supervision-report-stage'){if(!canWrite())throw Error('当前只读');reportForm(name.endsWith('-stage')?'stage':'weekly');return;}
    if(name==='supervision-report-correct'){if(!canWrite())throw Error('当前只读');const old=data().reports.find(x=>x.id===id);reportForm(old.kind,old);return;}
    if(name==='supervision-report-read'){if(!writable())throw Error('归档项目只读');const r=data().reports.find(x=>x.id===id);await act('report.read',{id,contentHash:r.contentHash});showInfo('已记录阅读（没有批准变更）',reportHtml(data().reports.find(x=>x.id===id)));return;}
    if(!canWrite())throw Error('当前只读或项目尚未生效');
    if(name==='supervision-report-review'){showForm('独立验收阶段成果',[{name:'accept',label:'验收结果',type:'select',options:[['false','退回补充'],['true','已核对成果，验收通过']]},note('note','核对了哪些成果，或者为什么退回')],a=>act('report.review',{id,accept:a.accept==='true',note:a.note}),{intro:'验收不代替全体阶段会签；资料有变化时需更正后重新验收。'});return;}
    if(name==='supervision-change-new'){if(!isPartner())throw Error('需要合伙人身份');showForm('选择要调整的安排',[{name:'target',label:'变更对象',type:'select',full:true,options:[['project:'+p().id,'项目方向／范围'],...p().stages.filter(s=>s.status!=='completed').map(s=>['stage:'+s.id,'阶段：'+s.name]),...p().tasks.filter(t=>t.status!=='done').map(t=>['task:'+t.id,'任务：'+t.title])]}],a=>{const split=a.target.indexOf(':');setTimeout(()=>changeForm(a.target.slice(0,split),a.target.slice(split+1)),0);},{submit:'下一步：填写新旧对比'});return;}
    if(name==='supervision-funding-new'){if(!isPartner())throw Error('需要合伙人身份');fundingForm();return;}
    if(name==='supervision-funding-cancel'){showForm('共同撤销未到账追加',[reason()],a=>propose('funding_cancel',{fundingId:id},a.reason),{intro});return;}
    if(name==='supervision-funding-receipt'||name==='supervision-funding-link') {
      const f=view().fundings.find(x=>x.id===id),m=el.dataset.member,line=f.allocations.find(x=>x.memberId===m),link=name.endsWith('-link');
      const candidates=p().ledger.filter(e=>e.kind===line.kind&&e.amountCents>0&&!e.fundingId&&!e.reversesId&&!p().ledger.some(x=>x.reversesId===e.id));
      showForm(link?'关联已登记的到账，不重复记钱':'登记实际到账',[
        {name:'who',label:'本次关联成员',type:'html',full:true,html:`<p>${e(line.name)} · 尚未登记 ${money(line.remainingCents)}</p>`},
        link?{name:'entryId',label:'已有流水',type:'select',full:true,options:candidates.map(e=>[e.id,e.description+' · '+money(e.amountCents)])}:{name:'amount',label:'实际到账金额（元）',type:'money'},
        note('evidence','真实流水依据及核对说明'),attachmentField(),{name:'confirm',label:'确认真实来款',type:'checkbox',full:true,checkboxText:'确有该笔实际来款；登记后需另一人复核，不把承诺当作到账'}
      ],a=>{if(!a.confirm)throw Error('请确认实际到账');return act(link?'funding.link':'funding.receipt',{id,memberId:m,entryId:a.entryId,amountCents:link?undefined:toCents(a.amount),evidence:a.evidence,attachments:selectedFile(a)});},{submit:link?'关联原记录':'登记并等待独立复核'});return;
    }
    if(name==='supervision-issue-new'){issueForm(el.dataset.source);return;}
    if(name==='supervision-issue-respond'){showForm('说明异常原因与处理办法',[note('cause','为什么发生'),note('plan','准备怎么处理、预计什么时候完成')],a=>act('issue.respond',{id,...a}));return;}
    if(name==='supervision-issue-resolve'){showForm('提交处理结果',[note('result','实际处理了什么，结果和依据在哪里'),attachmentField()],a=>act('issue.resolve',{id,result:a.result,attachments:selectedFile(a)}),{intro:'提交结果后仍待另一人复核，不能自行关闭。'});return;}
    if(name==='supervision-issue-review'){showForm('复核异常并关闭或退回',[
      {name:'accept',label:'处理结果',type:'select',options:[['false','退回继续处理'],['true','复核通过并关闭']]},
      {name:'disposition',label:'来源问题的实际状态',type:'select',options:[['resolved','问题已消除'],['accepted','问题仍存在，明确记录知情处理'],['false_positive','该线索为误报，说明核对依据']]},note('note','复核依据和仍需承担的事项')
    ],a=>act('issue.review',{id,accept:a.accept==='true',disposition:a.disposition,note:a.note}),{intro:'规则线索仍存在时，不能直接写成已消除；关闭记录不取消其他审批要求。'});return;}
    throw Error('未识别的监督操作');
  }
  return {page,action,proposalHtml};
}
