import {fixture} from './helpers.mjs';
import {memoryBucket,isolatedD1} from '../scripts/local-runtime.mjs';
import {requestBackup,processBackupJobs} from '../src/backups.js';
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
const f=await fixture();try{
 Object.assign(f.rt.env,{BACKUPS:memoryBucket(),RESTORE_DB:isolatedD1(),RESTORE_FILES:memoryBucket(),BACKUP_ENCRYPTION_KEY:randomBytes(32).toString('base64'),FILES_BUCKET_NAME:'source',BACKUP_BUCKET_NAME:'backup',RESTORE_BUCKET_NAME:'drill'});
 const job=await requestBackup(f.rt.env,'test:visual');await processBackupJobs(f.rt.env,{steps:60});await requestBackup(f.rt.env,'test:visual',{kind:'drill',sourceId:job.id});await processBackupJobs(f.rt.env,{steps:120});
 let p=await f.owner.ok(f.base,undefined,'GET');const original=structuredClone(p),leaving=p.members[2];
 p=await f.action(f.owner,'proposal.submit',{kind:'ownership_transfer',reason:'虚构移交展示',payload:{newOwnerMemberId:p.members[1].id,handover:'测试渠道、文件和责任交接'}});const transfer=structuredClone(p);
 await f.action(f.owner,'proposal.cancel',{id:p.proposals.at(-1).id,reason:'测试保留移交展示快照后撤回，继续独立退出演示'});
 p=await f.action(f.owner,'proposal.submit',{kind:'exit_plan',reason:'虚构退出展示',payload:{memberId:leaving.id,capitalCents:10000,profitCents:0,reimburseCents:0,owedCents:0,shares:{[p.members[0].id]:5000,[p.members[1].id]:5000},handover:{tasks:[],purchases:[]},basis:'测试用清算方案，不涉及真实出资或转账',responsibilities:'保留约定责任，等待全体最终确认',dueDate:'2027-01-01'}});
 const exitProposal=structuredClone(p);const g=p.proposals.at(-1);for(const c of f.all)p=await f.action(c,'proposal.vote',{id:g.id,decision:'approve',acceptExit:true});
 const responses={};for(const path of ['/api/auth/me','/api/auth/mfa/status','/api/projects',f.base,f.base+'/channels','/api/notifications?limit=200','/api/admin/overview','/api/admin/security','/api/admin/backups','/api/admin/notification-settings','/api/admin/delivery'])responses[path]=await f.owner.ok(path,undefined,'GET');
 await mkdir('artifacts',{recursive:true});await writeFile('artifacts/operations-fixture.json',JSON.stringify({responses,original,transfer,exitProposal,project:p,pid:f.pid,others:await Promise.all(f.all.slice(1).map(c=>c.ok('/api/auth/me',undefined,'GET')))},null,2));console.log('Created synthetic operation UI fixture; no external services used.');
}finally{await f.close();}
