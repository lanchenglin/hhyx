// 仅编辑当前项目的配置文件，不调用云端、不创建资源、不修改其他项目。
import { readFile, writeFile } from 'node:fs/promises';
import { ROOT } from './local-runtime.mjs';
import path from 'node:path';
const args={};
for(let i=2;i<process.argv.length;i+=2){const k=process.argv[i],v=process.argv[i+1];if(!k?.startsWith('--')||!v)throw Error('参数格式：--database-id UUID --app-url https://域名 [--worker-name 名称 --database-name 名称 --bucket 名称]');args[k.slice(2)]=v;}
for(const k of Object.keys(args))if(!['database-id','app-url','worker-name','database-name','bucket'].includes(k))throw Error(`未知参数：${k}`);
if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args['database-id']||''))throw Error('请填写 Cloudflare 返回的真实 D1 database_id');
const url=new URL(args['app-url']);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('APP_URL 必须是 HTTPS 站点根地址，不含路径、账号和查询串');
const file=path.join(ROOT,'wrangler.jsonc'),config=JSON.parse(await readFile(file,'utf8'));
config.d1_databases[0].database_id=args['database-id'];config.vars.APP_URL=url.origin;
for(const key of ['worker-name','database-name','bucket'])if(args[key]&&!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(args[key]))throw Error(`${key} 应为3–63位小写英文、数字及连字符`);
if(args['worker-name'])config.name=args['worker-name'];if(args['database-name'])config.d1_databases[0].database_name=args['database-name'];if(args.bucket)config.r2_buckets[0].bucket_name=args.bucket;
await writeFile(file,JSON.stringify(config,null,2)+'\n');console.log('已更新 wrangler.jsonc；尚未部署，也未创建任何云资源。');
