import {readdir,readFile} from 'node:fs/promises';import {spawnSync} from 'node:child_process';import path from 'node:path';
async function walk(dir){let out=[];for(const e of await readdir(dir,{withFileTypes:true})){if(['node_modules','.git','.local','.wrangler','artifacts'].includes(e.name))continue;const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await walk(p));else if(/\.(m?js)$/.test(e.name))out.push(p);}return out;}
let failed=false;const files=await walk('.');for(const file of files){const r=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(r.status)failed=true;}
const config=JSON.parse(await readFile('wrangler.jsonc','utf8'));if(!config.d1_databases?.length||!config.r2_buckets?.length||config.main!=='src/index.js')throw Error('Workers 配置缺少必要绑定');
if(failed)process.exit(1);console.log(`语法检查通过：${files.length} 个 JavaScript 文件；Workers D1/R2 绑定声明完整。`);
