import {fixture} from './helpers.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const f=await fixture({partners:3});try{
 const normal=await f.owner.ok(f.base,undefined,'GET');
 const archived=await f.owner.ok('/api/projects',{name:'归档项目 · 历史记录保留',description:'用于离线浏览器验收的虚构项目',totalBudgetCents:100000,minReserveCents:0});
 await f.owner.ok('/api/admin/projects/'+archived.id+'/lifecycle',{action:'archive',expectedRevision:archived.revision,confirmName:archived.name,confirmImpact:true,reason:'虚构测试归档'});
 const trash=await f.owner.ok('/api/projects',{name:'回收站项目 · 可以恢复',description:'测试回收站，不是真实业务',totalBudgetCents:100000,minReserveCents:0});
 await f.owner.ok('/api/admin/projects/'+trash.id+'/lifecycle',{action:'trash',expectedRevision:trash.revision,confirmName:trash.name,confirmImpact:true,reason:'虚构测试删除'});
 await f.owner.ok('/api/admin/ai-settings',{expectedRevision:0,enabled:true,provider:'openai_compatible',baseUrl:'https://api.openai.com/v1',model:'example-test-model',key:'mock-not-a-real-key',inputCentsPerMillion:500,outputCentsPerMillion:1000,outputTokens:2048,structured:true,reason:'测试模型配置，不实际调用'});
 const paths=['/api/auth/me','/api/projects','/api/notifications?limit=200','/api/admin/overview','/api/admin/users','/api/admin/projects?lifecycle=active&q=&offset=0','/api/admin/projects?lifecycle=archived&q=&offset=0','/api/admin/projects?lifecycle=trashed&q=&offset=0','/api/admin/projects?lifecycle=all&q=&offset=0','/api/admin/ai-settings','/api/admin/audit?before=0',f.base];
 const responses={};for(const p of paths)responses[p]=await f.owner.ok(p,undefined,'GET');
 for(const u of responses['/api/admin/users'].users)responses['/api/admin/users/'+u.id]=await f.owner.ok('/api/admin/users/'+u.id,undefined,'GET');
 for(const p of [normal,archived,trash])responses['/api/admin/projects/'+p.id]=await f.owner.ok('/api/admin/projects/'+p.id,undefined,'GET');
 responses['/api/projects/'+archived.id]=await f.owner.ok('/api/projects/'+archived.id,undefined,'GET');
 const ordinary=await f.all[1].ok('/api/auth/me',undefined,'GET');
 await mkdir('artifacts',{recursive:true});await writeFile('artifacts/admin-fixture.json',JSON.stringify({responses,ordinary,normalId:normal.id,archivedId:archived.id,trashId:trash.id},null,2));
 console.log('Wrote synthetic admin fixture. No real model requests.');
}finally{await f.close();}
