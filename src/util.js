import { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
export class AppError extends Error {
  constructor(message, status = 400, code = 'INVALID_INPUT') { super(message); this.status = status; this.code = code; }
}
export const assert = (ok, message, status = 400, code) => { if (!ok) throw new AppError(message, status, code); };
export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : JSON.stringify(value)).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export const safeEqual = (a, b) => { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length === y.length && timingSafeEqual(x, y); };
export function text(value, name = '内容', max = 3000, required = true) {
  assert(typeof value === 'string' || (!required && value == null), `${name}格式不正确`);
  const s = (value || '').trim(); assert((!required || s.length > 0) && s.length <= max, `${name}长度须为${required ? '1' : '0'}–${max}字符`); return s;
}
export function cents(v, name = '金额', allowZero = false) {
  assert(Number.isSafeInteger(v) && v >= (allowZero ? 0 : 1) && v <= 100000000000, `${name}必须为整数分且在有效范围内`); return v;
}
export function email(v) { const e = text(v, '邮箱', 254).toLowerCase(); assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e), '邮箱格式不正确'); return e; }
export function date(v, required = false) { if (!v && !required) return ''; assert(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)), '日期格式应为 YYYY-MM-DD'); assert(new Date(`${v}T00:00:00Z`).toISOString().slice(0,10) === v, '日期不存在'); return v; }
export function hashPassword(password) {
  assert(typeof password === 'string' && password.length >= 12 && password.length <= 128, '密码须为12–128字符');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString('hex');
  return `scrypt$32768$8$3$${salt}$${hash}`;
}
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [, N, r, p, salt, expected] = stored.split('$');
  return safeEqual(scryptSync(password, salt, 32, { N:+N, r:+r, p:+p, maxmem:64*1024*1024 }).toString('hex'), expected);
}
export function encrypt(value, key) { const k = Buffer.from(key || '', 'base64'); assert(k.length === 32, '尚未配置通知加密密钥 CONFIG_ENCRYPTION_KEY', 503); const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', k, iv); return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString('base64'); }
export function decrypt(value, key) { const data = Buffer.from(value, 'base64'), d = createDecipheriv('aes-256-gcm', Buffer.from(key,'base64'), data.subarray(0,12)); d.setAuthTag(data.subarray(-16)); return Buffer.concat([d.update(data.subarray(12,-16)),d.final()]).toString(); }
export const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...extra}});
export async function body(req, max = 100000) {
  assert((req.headers.get('content-type') || '').includes('application/json'), '请使用 JSON 请求', 415);
  assert(Number(req.headers.get('content-length') || 0) <= max, '请求过大', 413);
  const raw = await req.text(); assert(new TextEncoder().encode(raw).length <= max, '请求过大', 413);
  try { const v = JSON.parse(raw); assert(v && typeof v === 'object' && !Array.isArray(v), '请求应为对象'); return v; } catch(e) { if(e instanceof AppError) throw e; throw new AppError('JSON 格式不正确'); }
}
export function csv(rows) { return '\ufeff' + rows.map(r => r.map(v => { let s=String(v??''); if (/^[=+\-@\t\r]/.test(s)) s="'"+s; return '"'+s.replaceAll('"','""')+'"'; }).join(',')).join('\r\n'); }
