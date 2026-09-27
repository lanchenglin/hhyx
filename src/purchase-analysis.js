import {DEFAULT_AI_THRESHOLD_CENTS} from './ai-policy.js';
const accepted=new Set(['pending','approved','ordered','received']);
const total=q=>q.items.reduce((n,x)=>n+x.quantity*x.unitCents,0);
const norm=x=>String(x||'').normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g,' ');
export function purchaseAnalysisDecision(p,q,at=new Date().toISOString()) {
 const thresholdCents=p.ai?.policy?.purchaseThresholdCents??DEFAULT_AI_THRESHOLD_CENTS;
 const amountCents=total(q),cutoff=Date.parse(at)-7*86400000;
 // Match explicit shared commitment even across stages; otherwise only same-stage payee/supplier+purpose.
 const related=p.purchases.filter(x=>x.id!==q.id&&accepted.has(x.status)&&(
  q.commitmentGroup&&norm(q.commitmentGroup)===norm(x.commitmentGroup)||
  x.stageId===q.stageId&&Date.parse(x.submittedAt||x.createdAt)>=cutoff&&(
   norm(q.supplier)&&norm(q.supplier)===norm(x.supplier)&&(q.purpose||'other')===(x.purpose||'other')||
   norm(q.title)&&norm(q.title)===norm(x.title)
  )
 ));
 const cumulativeCents=related.reduce((n,x)=>n+total(x),amountCents);
 const anomaly=amountCents<=thresholdCents&&related.length>0&&cumulativeCents>thresholdCents;
 return {thresholdCents,amountCents,cumulativeCents,relatedIds:related.map(x=>x.id),anomaly,
  required:amountCents>thresholdCents||anomaly,
  code:amountCents>thresholdCents?'over_threshold':anomaly?'related_total':'small_routine',
  reason:amountCents>thresholdCents?'本次承诺总额超过项目阈值':anomaly?'关联支出累计超过阈值，请核对是否同一事项；不直接认定拆单违规':'小额普通支出，默认不自动调用AI（仍须记录、通知和会签）'};
}
