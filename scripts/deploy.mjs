import { readFile } from 'node:fs/promises';import { spawnSync } from 'node:child_process';
const c=JSON.parse(await readFile('wrangler.jsonc','utf8'));
if(!/^[0-9a-f-]{36}$/i.test(c.d1_databases?.[0]?.database_id||'')||JSON.stringify(c).includes('REPLACE_WITH'))throw Error('请先按 docs/HERMES_DEPLOY.md 配置真实 D1 ID 和 APP_URL；拒绝使用占位配置部署。');
if(!c.vars?.APP_URL?.startsWith('https://'))throw Error('正式 APP_URL 必须使用 HTTPS');
for(const [cmd,args] of [[process.execPath,['scripts/check.mjs']],['npx',['--no-install','wrangler','deploy','--dry-run']],['npx',['--no-install','wrangler','deploy']]]){
 const r=spawnSync(cmd,args,{stdio:'inherit',shell:process.platform==='win32'});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status||1);
}
