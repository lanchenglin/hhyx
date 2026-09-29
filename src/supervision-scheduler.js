import {rows,one,mutate} from './store.js';
import {sha,now} from './util.js';
import {supervisionDay,supervisionNeedsSync,supervisionAlerts} from './supervision.js';

// The existing Workers Cron advances a bounded number of project checks each run.
// No external AI requests, no writes on a GET, no new payment or approval authority.
export async function scheduledSupervision(env) {
  const at=now(),today=supervisionDay(at,env.TZ||'Asia/Shanghai');
  const cursor=(await one(env,"SELECT value FROM settings WHERE key='supervision_cursor'"))?.value||'';
  let list=await rows(env,"SELECT id,state FROM projects WHERE lifecycle='active' AND id>? ORDER BY id LIMIT 3",cursor);
  if(!list.length)list=await rows(env,"SELECT id,state FROM projects WHERE lifecycle='active' ORDER BY id LIMIT 3");
  let changed=0;
  for(const row of list) {
    const p=JSON.parse(row.state);if(!supervisionNeedsSync(p,today))continue;
    const key='supervision_'+sha({today,alerts:supervisionAlerts(p,today),issues:p.supervision.issues.map(i=>[i.id,i.status]),digest:p.supervision.lastDigestDay||''}).slice(0,48);
    await mutate(env,row.id,{id:'system:supervision',name:'监督提醒服务'}, {type:'supervision.sync',data:{}},key,{supervisionSystemVerified:true});changed++;
  }
  if(list.length)await env.DB.prepare("INSERT INTO settings(key,value) VALUES('supervision_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(list.at(-1).id).run();
  return {checked:list.length,changed};
}
