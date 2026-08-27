import express from 'express';
import cors from 'cors';
import pg from 'pg';
import { runCollectors } from './collector.js';
import crypto from 'node:crypto';
const { Pool } = pg;
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://kwd_rate:kwd_rate_dev@localhost:5432/kwd_rate' });
const ADMIN_KEY = process.env.ADMIN_KEY || 'kwd-rate-admin';
const admin = (req,res,next)=>{ if(req.headers['x-admin-key']!==ADMIN_KEY) return res.status(401).json({error:'Unauthorized'}); next(); };
const q = async(sql,args=[]) => (await pool.query(sql,args)).rows;
const num = (v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const distanceKm=(lat1,lon1,lat2,lon2)=>{const R=6371,toRad=x=>x*Math.PI/180,dLat=toRad(lat2-lat1),dLon=toRad(lon2-lon1),a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));};
const freshness=(captured,expires)=>{ const age=Math.max(0,Math.round((Date.now()-new Date(captured).getTime())/60000)); const exp=expires?new Date(expires).getTime():null; return {age_minutes:age,is_expired:!!(exp && exp<=Date.now()),freshness_score:clamp(100-age/2,0,100)}; };


const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || 'false') === 'true';
const authAttempts = new Map();
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const normalizeEmail = e => String(e||'').trim().toLowerCase();
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const cookieOptions = `Path=/; HttpOnly; SameSite=Lax${COOKIE_SECURE?'; Secure':''}`;
function setCookie(res,name,value,maxAge){res.setHeader('Set-Cookie',`${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; ${cookieOptions}`)}
function clearCookie(res,name){setCookie(res,name,'',0)}
function getCookies(req){const out={};for(const part of String(req.headers.cookie||'').split(';')){const [k,...v]=part.trim().split('=');if(k)out[k]=decodeURIComponent(v.join('='))}return out}
function hashPassword(password,salt=crypto.randomBytes(16).toString('hex')){return new Promise((resolve,reject)=>crypto.scrypt(password,salt,64,{N:16384,r:8,p:1},(e,key)=>e?reject(e):resolve(`scrypt$${salt}$${key.toString('hex')}`)))}
async function verifyPassword(password,stored){try{const [,salt,hex]=String(stored).split('$');const key=await new Promise((resolve,reject)=>crypto.scrypt(password,salt,64,{N:16384,r:8,p:1},(e,k)=>e?reject(e):resolve(k)));return crypto.timingSafeEqual(Buffer.from(hex,'hex'),key)}catch{return false}}
async function createSession(user,req,res){const raw=randomToken(), exp=new Date(Date.now()+SESSION_DAYS*86400000);await q('INSERT INTO user_sessions(user_id,token_hash,expires_at,user_agent,ip_address) VALUES($1,$2,$3,$4,$5)',[user.id,hashToken(raw),exp,req.get('user-agent')||'',req.ip||null]);setCookie(res,'kwd_session',raw,SESSION_DAYS*86400)}
async function currentUser(req){const raw=getCookies(req).kwd_session;if(!raw)return null;const rows=await q(`SELECT u.id,u.email,u.full_name,u.role,u.email_verified,u.created_at,u.last_login_at FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.is_active=true LIMIT 1`,[hashToken(raw)]);return rows[0]||null}
async function requireUser(req,res,next){try{const u=await currentUser(req);if(!u)return res.status(401).json({error:'Authentication required'});req.user=u;next()}catch(e){res.status(500).json({error:e.message})}}
function rateLimit(req,key){const now=Date.now(), k=`${key}:${req.ip}`, a=(authAttempts.get(k)||[]).filter(t=>now-t<15*60*1000);if(a.length>=10)return false;a.push(now);authAttempts.set(k,a);return true}
function safeUser(u){return {id:u.id,email:u.email,full_name:u.full_name,role:u.role,email_verified:u.email_verified,created_at:u.created_at,last_login_at:u.last_login_at}}

app.post('/api/auth/register',async(req,res)=>{try{if(!rateLimit(req,'register'))return res.status(429).json({error:'Too many attempts. Try again later.'});const email=normalizeEmail(req.body.email),password=String(req.body.password||''),fullName=String(req.body.full_name||'').trim();if(!validEmail(email))return res.status(400).json({error:'بريد إلكتروني غير صالح'});if(password.length<8)return res.status(400).json({error:'كلمة المرور يجب أن تكون 8 أحرف على الأقل'});if(fullName.length>160)return res.status(400).json({error:'الاسم طويل جدًا'});const exists=(await q('SELECT id FROM users WHERE email=$1',[email]))[0];if(exists)return res.status(409).json({error:'هذا البريد مسجل بالفعل'});const ph=await hashPassword(password);const u=(await q('INSERT INTO users(email,password_hash,full_name) VALUES($1,$2,$3) RETURNING id,email,full_name,role,email_verified,created_at',[email,ph,fullName]))[0];const raw=randomToken();await q(`INSERT INTO user_tokens(user_id,token_hash,token_type,expires_at) VALUES($1,$2,'VERIFY_EMAIL',NOW()+INTERVAL '24 hours')`,[u.id,hashToken(raw)]);await createSession(u,req,res);res.status(201).json({user:safeUser(u),verification:{dev_token:process.env.NODE_ENV==='production'?undefined:raw,dev_url:process.env.NODE_ENV==='production'?undefined:`${APP_BASE_URL}/api/auth/verify-email?token=${encodeURIComponent(raw)}`}})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/auth/login',async(req,res)=>{try{if(!rateLimit(req,'login'))return res.status(429).json({error:'Too many login attempts. Try again later.'});const email=normalizeEmail(req.body.email),password=String(req.body.password||'');const u=(await q('SELECT id,email,password_hash,full_name,role,email_verified,created_at,last_login_at FROM users WHERE email=$1 AND is_active=true',[email]))[0];if(!u||!(await verifyPassword(password,u.password_hash)))return res.status(401).json({error:'البريد الإلكتروني أو كلمة المرور غير صحيحة'});await q('UPDATE users SET last_login_at=NOW(),updated_at=NOW() WHERE id=$1',[u.id]);await createSession(u,req,res);delete u.password_hash;res.json({user:safeUser(u)})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/auth/logout',async(req,res)=>{try{const raw=getCookies(req).kwd_session;if(raw)await q('DELETE FROM user_sessions WHERE token_hash=$1',[hashToken(raw)]);clearCookie(res,'kwd_session');res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/auth/me',async(req,res)=>{try{const u=await currentUser(req);res.json({authenticated:!!u,user:u?safeUser(u):null})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/auth/verify-email',async(req,res)=>{try{const token=String(req.query.token||'');const rows=await q(`SELECT user_id FROM user_tokens WHERE token_hash=$1 AND token_type='VERIFY_EMAIL' AND used_at IS NULL AND expires_at>NOW() LIMIT 1`,[hashToken(token)]);if(!rows[0])return res.status(400).send('<h2>رابط التحقق غير صالح أو منتهي.</h2>');await q('UPDATE users SET email_verified=true,updated_at=NOW() WHERE id=$1',[rows[0].user_id]);await q('UPDATE user_tokens SET used_at=NOW() WHERE token_hash=$1',[hashToken(token)]);res.send('<h2>تم تأكيد البريد الإلكتروني بنجاح. يمكنك العودة إلى KWD Rate.</h2>')}catch(e){res.status(500).send('Verification error')}});
app.post('/api/auth/forgot-password',async(req,res)=>{try{if(!rateLimit(req,'forgot'))return res.status(429).json({error:'Too many attempts. Try again later.'});const email=normalizeEmail(req.body.email),u=(await q('SELECT id FROM users WHERE email=$1 AND is_active=true',[email]))[0];const out={ok:true,message:'إذا كان البريد مسجلًا فسيتم إنشاء رابط استعادة.'};if(!u)return res.json(out);await q(`UPDATE user_tokens SET used_at=NOW() WHERE user_id=$1 AND token_type='RESET_PASSWORD' AND used_at IS NULL`,[u.id]);const raw=randomToken();await q(`INSERT INTO user_tokens(user_id,token_hash,token_type,expires_at) VALUES($1,$2,'RESET_PASSWORD',NOW()+INTERVAL '30 minutes')`,[u.id,hashToken(raw)]);if(process.env.NODE_ENV!=='production')out.dev_url=`${APP_BASE_URL}/auth.html?reset=${encodeURIComponent(raw)}`;res.json(out)}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/auth/reset-password',async(req,res)=>{try{const token=String(req.body.token||''),password=String(req.body.password||'');if(password.length<8)return res.status(400).json({error:'كلمة المرور يجب أن تكون 8 أحرف على الأقل'});const row=(await q(`SELECT id,user_id FROM user_tokens WHERE token_hash=$1 AND token_type='RESET_PASSWORD' AND used_at IS NULL AND expires_at>NOW() LIMIT 1`,[hashToken(token)]))[0];if(!row)return res.status(400).json({error:'رابط الاستعادة غير صالح أو منتهي'});const ph=await hashPassword(password);await q('UPDATE users SET password_hash=$1,updated_at=NOW() WHERE id=$2',[ph,row.user_id]);await q('UPDATE user_tokens SET used_at=NOW() WHERE id=$1',[row.id]);await q('DELETE FROM user_sessions WHERE user_id=$1',[row.user_id]);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/account',requireUser,async(req,res)=>{try{const [curr,companies,alerts,notifications,history]=await Promise.all([q('SELECT currency_code FROM user_favorite_currencies WHERE user_id=$1 ORDER BY created_at',[req.user.id]),q('SELECT f.company_id,c.name_ar,c.name_en FROM user_favorite_companies f JOIN exchange_companies c ON c.id=f.company_id WHERE f.user_id=$1 ORDER BY f.created_at',[req.user.id]),q('SELECT * FROM user_alerts WHERE user_id=$1 ORDER BY created_at DESC',[req.user.id]),q('SELECT n.*,e.observed_rate,e.reason FROM notification_outbox n JOIN alert_events e ON e.id=n.alert_event_id WHERE n.user_id=$1 ORDER BY n.created_at DESC LIMIT 50',[req.user.id]),q('SELECT * FROM user_comparisons WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30',[req.user.id])]);res.json({user:req.user,favorite_currencies:curr.map(x=>x.currency_code),favorite_companies:companies,alerts,notifications,history})}catch(e){res.status(500).json({error:e.message})}});
app.put('/api/account/profile',requireUser,async(req,res)=>{try{const fullName=String(req.body.full_name||'').trim();if(fullName.length>160)return res.status(400).json({error:'الاسم طويل جدًا'});const u=(await q('UPDATE users SET full_name=$1,updated_at=NOW() WHERE id=$2 RETURNING id,email,full_name,role,email_verified,created_at,last_login_at',[fullName,req.user.id]))[0];res.json({user:u})}catch(e){res.status(500).json({error:e.message})}});
app.put('/api/account/password',requireUser,async(req,res)=>{try{const old=String(req.body.current_password||''),nw=String(req.body.new_password||''),row=(await q('SELECT password_hash FROM users WHERE id=$1',[req.user.id]))[0];if(!await verifyPassword(old,row.password_hash))return res.status(401).json({error:'كلمة المرور الحالية غير صحيحة'});if(nw.length<8)return res.status(400).json({error:'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل'});const ph=await hashPassword(nw);await q('UPDATE users SET password_hash=$1,updated_at=NOW() WHERE id=$2',[ph,req.user.id]);await q('DELETE FROM user_sessions WHERE user_id=$1 AND token_hash<>$2',[req.user.id,hashToken(getCookies(req).kwd_session||'')]);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/account/favorites/currency',requireUser,async(req,res)=>{try{const code=String(req.body.currency_code||'').toUpperCase();if(!(await q('SELECT 1 FROM currencies WHERE code=$1 AND is_active=true',[code]))[0])return res.status(400).json({error:'عملة غير صالحة'});await q('INSERT INTO user_favorite_currencies(user_id,currency_code) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.user.id,code]);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.delete('/api/account/favorites/currency/:code',requireUser,async(req,res)=>{await q('DELETE FROM user_favorite_currencies WHERE user_id=$1 AND currency_code=$2',[req.user.id,String(req.params.code).toUpperCase()]);res.status(204).end()});
app.post('/api/account/favorites/company',requireUser,async(req,res)=>{try{const id=Number(req.body.company_id);if(!(await q("SELECT 1 FROM exchange_companies WHERE id=$1 AND kind='EXCHANGE' AND is_active=true",[id]))[0])return res.status(400).json({error:'شركة غير صالحة'});await q('INSERT INTO user_favorite_companies(user_id,company_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.user.id,id]);res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.delete('/api/account/favorites/company/:id',requireUser,async(req,res)=>{await q('DELETE FROM user_favorite_companies WHERE user_id=$1 AND company_id=$2',[req.user.id,req.params.id]);res.status(204).end()});
app.post('/api/account/alerts',requireUser,async(req,res)=>{try{const {from_currency='KWD',to_currency,target_rate,direction='ABOVE',method='CASH',company_id=null,channel='IN_APP',cooldown_minutes=60,amount=1,notes='',webhook_url=null}=req.body;if(!to_currency||!Number(target_rate)||!Number(amount)||!['ABOVE','BELOW'].includes(direction)||!['CASH','TRANSFER','CARD'].includes(method)||!['IN_APP','EMAIL','PUSH','WHATSAPP','WEBHOOK'].includes(channel)||Number(cooldown_minutes)<5)return res.status(400).json({error:'بيانات التنبيه غير صحيحة'});const a=(await q('INSERT INTO user_alerts(user_id,from_currency,to_currency,target_rate,direction,method,company_id,channel,cooldown_minutes,amount,notes,webhook_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',[req.user.id,from_currency,to_currency,target_rate,direction,method,company_id||null,channel,Number(cooldown_minutes),Number(amount),String(notes||''),webhook_url?String(webhook_url):null]))[0];res.status(201).json(a)}catch(e){res.status(400).json({error:e.message})}});
app.delete('/api/account/alerts/:id',requireUser,async(req,res)=>{await q('DELETE FROM user_alerts WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id]);res.status(204).end()});
app.patch('/api/account/alerts/:id',requireUser,async(req,res)=>{try{const {is_active}=req.body;const row=(await q('UPDATE user_alerts SET is_active=$1 WHERE id=$2 AND user_id=$3 RETURNING *',[!!is_active,req.params.id,req.user.id]))[0];if(!row)return res.status(404).json({error:'التنبيه غير موجود'});res.json(row)}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/account/notifications',requireUser,async(req,res)=>{try{const limit=Math.min(100,Math.max(1,Number(req.query.limit||50)));const rows=await q(`SELECT n.id,n.channel,n.subject,n.body,n.status,n.created_at,n.sent_at,n.read_at,e.observed_rate,e.target_rate,e.direction,e.method,e.reason FROM notification_outbox n LEFT JOIN alert_events e ON e.id=n.alert_event_id WHERE n.user_id=$1 ORDER BY n.created_at DESC LIMIT $2`,[req.user.id,limit]);const unread=(await q("SELECT COUNT(*)::int count FROM notification_outbox WHERE user_id=$1 AND read_at IS NULL AND status<>'FAILED'",[req.user.id]))[0].count;res.json({notifications:rows,unread_count:unread})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/account/notifications/:id/read',requireUser,async(req,res)=>{const row=(await q("UPDATE notification_outbox SET read_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING id,status,read_at",[req.params.id,req.user.id]))[0];if(!row)return res.status(404).json({error:'الإشعار غير موجود'});res.json(row)});
app.post('/api/account/notifications/read-all',requireUser,async(req,res)=>{const r=await q("UPDATE notification_outbox SET read_at=NOW() WHERE user_id=$1 AND read_at IS NULL",[req.user.id]);res.json({ok:true,count:r.length})});
app.get('/api/account/notification-preferences',requireUser,async(req,res)=>{const row=(await q('SELECT * FROM notification_preferences WHERE user_id=$1',[req.user.id]))[0]||{};res.json(row)});
app.put('/api/account/notification-preferences',requireUser,async(req,res)=>{try{const b=req.body||{};const phone=b.whatsapp_phone?String(b.whatsapp_phone).replace(/[^0-9+]/g,''):null;const row=(await q(`INSERT INTO notification_preferences(user_id,email_enabled,push_enabled,whatsapp_enabled,whatsapp_phone,quiet_hours_enabled,quiet_start,quiet_end,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT(user_id) DO UPDATE SET email_enabled=EXCLUDED.email_enabled,push_enabled=EXCLUDED.push_enabled,whatsapp_enabled=EXCLUDED.whatsapp_enabled,whatsapp_phone=EXCLUDED.whatsapp_phone,quiet_hours_enabled=EXCLUDED.quiet_hours_enabled,quiet_start=EXCLUDED.quiet_start,quiet_end=EXCLUDED.quiet_end,updated_at=NOW() RETURNING *`,[req.user.id,b.email_enabled!==false,b.push_enabled!==false,b.whatsapp_enabled===true,phone,b.quiet_hours_enabled===true,b.quiet_start||null,b.quiet_end||null]))[0];res.json(row)}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/notifications/vapid-public-key',async(_req,res)=>res.json({publicKey:process.env.VAPID_PUBLIC_KEY||null,enabled:!!process.env.VAPID_PUBLIC_KEY}));
app.post('/api/account/push/subscribe',requireUser,async(req,res)=>{try{const sub=req.body?.subscription||req.body;if(!sub?.endpoint||!sub?.keys?.p256dh||!sub?.keys?.auth)return res.status(400).json({error:'Push subscription غير صالحة'});await q(`INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,user_agent) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,endpoint) DO UPDATE SET p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,user_agent=EXCLUDED.user_agent`,[req.user.id,sub.endpoint,sub.keys.p256dh,sub.keys.auth,req.get('user-agent')||'']);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.delete('/api/account/push/subscribe',requireUser,async(req,res)=>{await q('DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2',[req.user.id,req.body?.endpoint||'']);res.status(204).end()});
app.post('/api/account/comparisons',requireUser,async(req,res)=>{try{const {from_currency='KWD',to_currency,amount,method='CASH'}=req.body;if(!to_currency||!Number(amount))return res.status(400).json({error:'بيانات المقارنة غير صحيحة'});const x=(await q('INSERT INTO user_comparisons(user_id,from_currency,to_currency,amount,method) VALUES($1,$2,$3,$4,$5) RETURNING *',[req.user.id,from_currency,to_currency,amount,method]))[0];res.status(201).json(x)}catch(e){res.status(400).json({error:e.message})}});

app.get('/api/health',async(_req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,service:'kwd-rate-api',engine:'pro-comparison-v1'})}catch(e){res.status(503).json({ok:false,error:e.message})}});
app.get('/api/currencies',async(_req,res)=>{try{res.json(await q('SELECT * FROM currencies WHERE is_active=true ORDER BY sort_order,code'))}catch(e){res.status(500).json({error:e.message})}});

// Professional comparison engine. For KWD -> foreign, the customer buys foreign currency, so the relevant quote is SELL/TRANSFER.
// For foreign -> KWD, the customer sells foreign currency, so the relevant quote is BUY.
app.get('/api/compare',async(req,res)=>{
  try{
    const amount=clamp(num(req.query.amount),0,1e12);
    const to=String(req.query.to||'USD').toUpperCase();
    const from=String(req.query.from||'KWD').toUpperCase();
    const method=String(req.query.method||'CASH').toUpperCase();
    if(from!=='KWD' && to!=='KWD') return res.status(400).json({error:'One side of the comparison must be KWD.'});
    if(!amount) return res.status(400).json({error:'amount must be greater than zero'});
    if(!['CASH','TRANSFER','CARD'].includes(method)) return res.status(400).json({error:'method must be CASH, TRANSFER or CARD'});
    const code=from==='KWD'?to:from;
    const rows=await q(`
      SELECT r.*, c.name_ar company_name_ar,c.name_en company_name_en,c.slug,c.rating,
             s.name source_name,s.type source_type,s.status source_status,s.last_success,cur.code currency_code
      FROM exchange_rates r
      JOIN currencies cur ON cur.id=r.currency_id
      JOIN exchange_companies c ON c.id=r.company_id
      LEFT JOIN rate_sources s ON s.id=r.source_id
      WHERE cur.code=$1 AND c.kind='EXCHANGE' AND c.is_active=true AND r.status='ACTIVE'
        AND r.quote_type=$2
        AND (r.min_amount IS NULL OR $3>=r.min_amount)
        AND (r.max_amount IS NULL OR $3<=r.max_amount)
      ORDER BY r.company_id,r.captured_at DESC,r.priority ASC`,[code,method,amount]);
    const latest=new Map();
    for(const r of rows){if(!latest.has(r.company_id)) latest.set(r.company_id,r);}
    const reference=(await q(`SELECT r.*,s.name source_name,s.type source_type
      FROM exchange_rates r
      JOIN currencies cur ON cur.id=r.currency_id
      JOIN exchange_companies c ON c.id=r.company_id
      LEFT JOIN rate_sources s ON s.id=r.source_id
      WHERE cur.code=$1 AND c.kind='REFERENCE' AND r.status='ACTIVE'
      ORDER BY r.captured_at DESC LIMIT 1`,[code]))[0]||null;

    const isKwdToForeign=from==='KWD';
    const refRate=reference ? (isKwdToForeign ? num(reference.sell_rate||reference.transfer_rate||reference.buy_rate) : num(reference.buy_rate||reference.sell_rate||reference.transfer_rate)) : null;
    const candidates=[];
    for(const r of latest.values()){
      const f=freshness(r.captured_at,r.expires_at);
      const rawRate=isKwdToForeign
        ? (method==='TRANSFER' ? num(r.transfer_rate||r.sell_rate) : num(r.sell_rate||r.transfer_rate))
        : num(r.buy_rate);
      if(!rawRate || rawRate<=0) continue;
      const basis=r.rate_basis||'FOREIGN_PER_KWD';
      const feeType=r.fee_type||'FIXED';
      const feeValue=Math.max(0,num(r.fees));
      const feeCurrency=r.fee_currency||'KWD';
      const inputCurrency=from;
      const outputCurrency=to;
      const feeOnInput=feeType==='PERCENT'
        ? amount*(feeValue/100)
        : (feeCurrency===inputCurrency?feeValue:0);
      const netInput=Math.max(0,amount-feeOnInput);
      let gross;
      if(isKwdToForeign){
        gross=basis==='FOREIGN_PER_KWD'?netInput*rawRate:netInput/rawRate;
      }else{
        gross=basis==='KWD_PER_FOREIGN'?netInput*rawRate:netInput/rawRate;
      }
      const feeOnOutput=feeType==='PERCENT'?0:(feeCurrency===outputCurrency?feeValue:0);
      const finalAmount=Math.max(0,gross-feeOnOutput);
      const effectiveRate=amount?finalAmount/amount:0;
      const sourceBase = ({REFERENCE:98,API:95,PARTNER:96,WEB:84,IMPORT:80,MANUAL:68})[String(r.source_type||'').toUpperCase()] ?? 65;
      const sourceStatusPenalty = String(r.source_status||'ACTIVE').toUpperCase()==='ERROR' ? 25 : 0;
      const sourceReliability=clamp(sourceBase-sourceStatusPenalty+(r.last_success?0:-10),0,100);
      const completenessFields=[r.source_id,r.source_reference,r.observed_at||r.captured_at,r.rate_basis,r.quote_type,r.fee_type,r.fee_currency];
      const completeness=completenessFields.filter(Boolean).length/completenessFields.length*100;
      const agePenalty=Math.max(0,f.age_minutes-10);
      const freshnessTrust=clamp(100-(agePenalty/170)*100,0,100);
      const plausible=effectiveRate>0 && effectiveRate<1e9;
      candidates.push({...r,selected_rate:rawRate,rate_basis:basis,quote_type:method,gross_amount:gross,fee_applied:feeValue,fee_type:feeType,fee_currency:feeCurrency,input_after_fee:netInput,output_after_fee:finalAmount,final_amount:finalAmount,effective_rate:effectiveRate,...f,
        _source_reliability:sourceReliability,_completeness:completeness,_freshness_trust:freshnessTrust,_plausible:plausible,
        _raw_effective_rate:effectiveRate
      });
    }
    const rates=candidates.map(x=>x._raw_effective_rate).filter(Number.isFinite).sort((a,b)=>a-b);
    const median=rates.length?rates[Math.floor(rates.length/2)]:null;
    const deviations=candidates.map(x=>Math.abs(x._raw_effective_rate-(median||x._raw_effective_rate))/(median||1));
    const devSorted=[...deviations].sort((a,b)=>a-b);
    const mad=devSorted.length?devSorted[Math.floor(devSorted.length/2)]:0;
    for(const x of candidates){
      const consensusDeviation=Math.abs(x._raw_effective_rate-(median||x._raw_effective_rate))/(median||1);
      const robustZ=mad>0?consensusDeviation/mad:0;
      const consensusTrust=rates.length<3?75:(robustZ<=2?100:robustZ<=4?82:robustZ<=8?55:20);
      const refDeviation=refRate?Math.abs(x.effective_rate/refRate-1):0;
      const referenceTrust=!refRate?70:(refDeviation<=0.005?100:refDeviation<=0.01?92:refDeviation<=0.02?78:refDeviation<=0.04?52:20);
      const reasons=[];
      const hard=[];
      if(x.is_expired) hard.push('EXPIRED');
      if(x.age_minutes>180) hard.push('STALE');
      if(!x._plausible) hard.push('INVALID_RATE');
      if(consensusDeviation>0.05 && rates.length>=3) hard.push('MARKET_OUTLIER');
      if(Number(x.confidence||0)<40) hard.push('LOW_SOURCE_CONFIDENCE');
      if(x.age_minutes<=10) reasons.push('السعر حديث جدًا'); else if(x.age_minutes<=60) reasons.push('السعر حديث'); else if(x.age_minutes<=180) reasons.push('السعر يحتاج مراقبة بسبب العمر'); else reasons.push('السعر قديم');
      if(consensusTrust>=90) reasons.push('متسق مع أسعار السوق'); else if(consensusTrust<60) reasons.push('منحرف عن أسعار السوق');
      if(referenceTrust>=90) reasons.push('متوافق مع مرجع CBK'); else if(referenceTrust<60) reasons.push('انحراف ملحوظ عن مرجع CBK');
      if(x._source_reliability>=90) reasons.push('مصدر عالي الاعتمادية'); else if(x._source_reliability<70) reasons.push('اعتمادية المصدر محدودة');
      if(x._completeness>=95) reasons.push('بيانات السعر مكتملة');
      const trust=clamp(Math.round(.25*x._freshness_trust+.20*x._source_reliability+.25*consensusTrust+.20*referenceTrust+.10*x._completeness),0,100);
      let status=trust>=85?'VERY_TRUSTED':trust>=70?'TRUSTED':trust>=55?'REVIEW':'UNTRUSTED';
      if(hard.length) status='BLOCKED';
      x.consensus_deviation_pct=consensusDeviation*100;
      x.reference_deviation_pct=refRate?((x.effective_rate/refRate)-1)*100:null;
      x.spread_from_reference=x.reference_deviation_pct;
      x.freshness_trust=Math.round(x._freshness_trust); x.source_reliability=Math.round(x._source_reliability); x.consensus_trust=Math.round(consensusTrust); x.reference_trust=Math.round(referenceTrust); x.completeness_score=Math.round(x._completeness);
      x.trust_score=trust; x.trust_status=status; x.trust_reasons=reasons; x.trust_flags=hard;
      x.eligible=hard.length===0 && trust>=65;
      delete x._source_reliability; delete x._completeness; delete x._freshness_trust; delete x._plausible; delete x._raw_effective_rate;
    }
    const ranked=[...candidates].sort((a,b)=>{
      if(a.eligible!==b.eligible) return a.eligible?-1:1;
      if(a.eligible && b.eligible && Math.abs(a.final_amount-b.final_amount)>1e-12) return b.final_amount-a.final_amount;
      return (b.trust_score-a.trust_score)||(b.final_amount-a.final_amount);
    });
    const best=ranked.find(x=>x.eligible)||null;
    res.json({engine_version:'trust-v1',from,to,amount,method,reference,market:{median_effective_rate:median,observations:rates.length,mad},best,results:ranked,meta:{trust_threshold:65,hard_block_flags:['EXPIRED','STALE','INVALID_RATE','MARKET_OUTLIER','LOW_SOURCE_CONFIDENCE'],weights:{freshness:25,source_reliability:20,market_consensus:25,cbk_reference:20,completeness:10},formula:isKwdToForeign?'net KWD → normalized rate → output − applicable fee':'net foreign input → normalized rate → KWD output − applicable fee'}});
  }catch(e){res.status(500).json({error:e.message})}
});

app.get('/api/trust/:code',async(req,res)=>{
  try{
    const code=String(req.params.code||'USD').toUpperCase();
    const method=String(req.query.method||'CASH').toUpperCase();
    const amount=clamp(num(req.query.amount,1000),0,1e12);
    const result={};
    // Reuse the public comparison engine logic without duplicating calculations: call it internally is not practical,
    // so expose a compact diagnostics view from the latest stored observations.
    const rows=await q(`SELECT c.name_ar company_name_ar,c.slug,r.captured_at,r.expires_at,r.confidence,r.source_reference,
      s.name source_name,s.type source_type,s.status source_status,s.last_success
      FROM exchange_rates r JOIN currencies cur ON cur.id=r.currency_id JOIN exchange_companies c ON c.id=r.company_id
      LEFT JOIN rate_sources s ON s.id=r.source_id
      WHERE cur.code=$1 AND c.kind='EXCHANGE' AND c.is_active=true AND r.status='ACTIVE' AND r.quote_type=$2
      ORDER BY r.captured_at DESC`,[code,method]);
    const seen=new Set();
    for(const r of rows){if(seen.has(r.slug))continue;seen.add(r.slug);const f=freshness(r.captured_at,r.expires_at);result[r.slug]={company:r.company_name_ar,source:r.source_name,age_minutes:f.age_minutes,freshness_score:Math.round(f.freshness_score),confidence:Number(r.confidence||0),source_status:r.source_status,has_reference:!!r.source_reference,eligible:f.age_minutes<=180&&!f.is_expired&&Number(r.confidence||0)>=40};}
    res.json({code,method,amount,trust_model:'trust-v1',companies:result});
  }catch(e){res.status(500).json({error:e.message})}
});

app.get('/api/rates/:code',async(req,res)=>{try{res.json(await q(`SELECT DISTINCT ON (r.company_id,r.quote_type) r.*, c.name_ar company_name_ar,c.name_en company_name_en,c.slug FROM exchange_rates r JOIN currencies cur ON cur.id=r.currency_id JOIN exchange_companies c ON c.id=r.company_id WHERE cur.code=$1 AND r.status='ACTIVE' AND c.kind='EXCHANGE' ORDER BY r.company_id,r.quote_type,r.captured_at DESC`,[req.params.code.toUpperCase()]))}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/reference/:code',async(req,res)=>{try{res.json((await q(`SELECT r.*,c.name_ar company_name_ar,c.name_en company_name_en,cur.code FROM exchange_rates r JOIN currencies cur ON cur.id=r.currency_id JOIN exchange_companies c ON c.id=r.company_id WHERE cur.code=$1 AND c.kind='REFERENCE' ORDER BY r.captured_at DESC LIMIT 1`,[req.params.code.toUpperCase()]))[0]||null)}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/history/:code',async(req,res)=>{try{const code=String(req.params.code||'USD').toUpperCase(),days=Math.min(90,Math.max(1,Number(req.query.days)||30)),method=String(req.query.method||'CASH').toUpperCase();const points=await q(`SELECT DATE_TRUNC('day',r.captured_at) AS day,ROUND(AVG(COALESCE(r.sell_rate,r.transfer_rate))::numeric,8) avg_rate,MIN(COALESCE(r.sell_rate,r.transfer_rate)) min_rate,MAX(COALESCE(r.sell_rate,r.transfer_rate)) max_rate,COUNT(*)::int observations FROM exchange_rates r JOIN currencies cur ON cur.id=r.currency_id JOIN exchange_companies c ON c.id=r.company_id WHERE cur.code=$1 AND c.kind='EXCHANGE' AND r.status='ACTIVE' AND r.quote_type=$3 AND r.captured_at>=NOW()-($2::int*INTERVAL '1 day') GROUP BY 1 ORDER BY 1`,[code,days,method]);res.json({code,days,method,points})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/market-summary/:code',async(req,res)=>{try{const code=String(req.params.code||'USD').toUpperCase(),method=String(req.query.method||'CASH').toUpperCase();const current=await q(`SELECT DISTINCT ON (r.company_id) COALESCE(r.sell_rate,r.transfer_rate) rate,r.captured_at,c.name_ar FROM exchange_rates r JOIN currencies cur ON cur.id=r.currency_id JOIN exchange_companies c ON c.id=r.company_id WHERE cur.code=$1 AND c.kind='EXCHANGE' AND r.status='ACTIVE' AND r.quote_type=$2 AND (r.expires_at IS NULL OR r.expires_at>NOW()) ORDER BY r.company_id,r.captured_at DESC`,[code,method]);const vals=current.map(x=>Number(x.rate)).filter(Number.isFinite),best=vals.length?Math.max(...vals):null;const hist=(await q(`SELECT AVG(COALESCE(r.sell_rate,r.transfer_rate)) avg_rate,MIN(COALESCE(r.sell_rate,r.transfer_rate)) min_rate,MAX(COALESCE(r.sell_rate,r.transfer_rate)) max_rate FROM exchange_rates r JOIN currencies cur ON cur.id=r.currency_id JOIN exchange_companies c ON c.id=r.company_id WHERE cur.code=$1 AND c.kind='EXCHANGE' AND r.status='ACTIVE' AND r.quote_type=$2 AND r.captured_at>=NOW()-INTERVAL '30 days'`,[code,method]))[0];const week=(await q(`SELECT AVG(COALESCE(r.sell_rate,r.transfer_rate)) avg_rate FROM exchange_rates r JOIN currencies cur ON cur.id=r.currency_id JOIN exchange_companies c ON c.id=r.company_id WHERE cur.code=$1 AND c.kind='EXCHANGE' AND r.status='ACTIVE' AND r.quote_type=$2 AND r.captured_at>=NOW()-INTERVAL '7 days'`,[code,method]))[0];const prior=(await q(`SELECT AVG(COALESCE(r.sell_rate,r.transfer_rate)) avg_rate FROM exchange_rates r JOIN currencies cur ON cur.id=r.currency_id JOIN exchange_companies c ON c.id=r.company_id WHERE cur.code=$1 AND c.kind='EXCHANGE' AND r.status='ACTIVE' AND r.quote_type=$2 AND r.captured_at>=NOW()-INTERVAL '14 days' AND r.captured_at<NOW()-INTERVAL '7 days'`,[code,method]))[0];const avg=Number(hist?.avg_rate||0),score=best&&avg?clamp(Math.round(70+((best/avg)-1)*300),0,100):null;res.json({code,method,current_best:best,average_30d:avg||null,low_30d:hist?.min_rate?Number(hist.min_rate):null,high_30d:hist?.max_rate?Number(hist.max_rate):null,average_7d:week?.avg_rate?Number(week.avg_rate):null,average_prior_7d:prior?.avg_rate?Number(prior.avg_rate):null,change_7d:week?.avg_rate&&prior?.avg_rate?((Number(week.avg_rate)/Number(prior.avg_rate)-1)*100):null,quality_score:score})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/sources',async(_req,res)=>{try{res.json(await q('SELECT id,name,type,endpoint,update_frequency_minutes,last_success,status FROM rate_sources ORDER BY name'))}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/exchanges',async(_req,res)=>{try{res.json(await q("SELECT * FROM exchange_companies WHERE kind='EXCHANGE' AND is_active=true ORDER BY name_ar"))}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/branches',async(req,res)=>{try{
 const qstr=String(req.query.q||'').trim(); const params=[]; let where="b.is_active=true AND c.kind='EXCHANGE'";
 if(qstr){params.push('%'+qstr+'%'); where+=` AND (b.name ILIKE $${params.length} OR b.area ILIKE $${params.length} OR b.address ILIKE $${params.length} OR c.name_ar ILIKE $${params.length} OR c.name_en ILIKE $${params.length})`;}
 res.json(await q(`SELECT b.*,c.name_ar company_name_ar,c.name_en company_name_en,c.logo_url FROM branches b JOIN exchange_companies c ON c.id=b.company_id WHERE ${where} ORDER BY c.name_ar,b.name`,params));
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/branches/nearby',async(req,res)=>{try{
 const lat=Number(req.query.lat),lng=Number(req.query.lng),radius=Math.min(100,Math.max(1,Number(req.query.radius)||15));
 if(!Number.isFinite(lat)||!Number.isFinite(lng)) return res.status(400).json({error:'lat and lng are required'});
 const rows=await q(`SELECT b.*,c.name_ar company_name_ar,c.name_en company_name_en,c.logo_url FROM branches b JOIN exchange_companies c ON c.id=b.company_id WHERE b.is_active=true AND c.kind='EXCHANGE' AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL`);
 const result=rows.map(b=>({...b,distance_km:distanceKm(lat,lng,Number(b.latitude),Number(b.longitude))})).filter(b=>b.distance_km<=radius).sort((a,b)=>a.distance_km-b.distance_km);
 res.json({lat,lng,radius_km:radius,count:result.length,branches:result.slice(0,100)});
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/branches/:id',async(req,res)=>{try{const rows=await q(`SELECT b.*,c.name_ar company_name_ar,c.name_en company_name_en,c.logo_url,c.phone company_phone,c.website FROM branches b JOIN exchange_companies c ON c.id=b.company_id WHERE b.id=$1 AND b.is_active=true`,[req.params.id]); if(!rows[0]) return res.status(404).json({error:'Branch not found'}); res.json(rows[0]);}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/nearby-best',async(req,res)=>{try{
 const lat=Number(req.query.lat),lng=Number(req.query.lng),radius=Math.min(100,Math.max(1,Number(req.query.radius)||15)),amount=clamp(num(req.query.amount),1,1e12),to=String(req.query.to||'USD').toUpperCase(),method=String(req.query.method||'CASH').toUpperCase();
 if(!Number.isFinite(lat)||!Number.isFinite(lng)) return res.status(400).json({error:'lat and lng are required'}); if(!['CASH','TRANSFER','CARD'].includes(method)) return res.status(400).json({error:'invalid method'});
 const rows=await q(`SELECT b.id branch_id,b.name branch_name,b.area,b.address,b.latitude,b.longitude,b.phone,b.working_hours,b.services,b.last_verified_at,c.id company_id,c.name_ar company_name_ar,c.name_en company_name_en,c.logo_url,r.buy_rate,r.sell_rate,r.transfer_rate,r.fees,r.fee_type,r.fee_currency,r.rate_basis,r.captured_at,r.expires_at,r.trust_score,r.trust_status,r.source_reliability,r.consensus_trust,r.reference_trust,s.name source_name FROM branches b JOIN exchange_companies c ON c.id=b.company_id JOIN currencies cur ON cur.code=$1 JOIN LATERAL (SELECT r.* FROM exchange_rates r WHERE r.company_id=c.id AND r.currency_id=cur.id AND r.status='ACTIVE' AND r.quote_type=$2 ORDER BY r.captured_at DESC LIMIT 1) r ON true LEFT JOIN rate_sources s ON s.id=r.source_id WHERE b.is_active=true AND c.kind='EXCHANGE' AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL`,[to,method]);
 const isKwdToForeign=true; const result=rows.map(r=>{const distance=distanceKm(lat,lng,Number(r.latitude),Number(r.longitude)); const rate=method==='TRANSFER'?Number(r.transfer_rate||r.sell_rate):Number(r.sell_rate||r.transfer_rate); const fee=Number(r.fees||0); const finalAmount=rate?Math.max(0,amount*rate-(r.fee_type==='FIXED'&&r.fee_currency==='KWD'?fee:0)):0; const fresh=Math.max(0,Math.round((Date.now()-new Date(r.captured_at).getTime())/60000)); const eligible=r.trust_status!=='BLOCKED'&&fresh<=180&&Number(r.trust_score||0)>=65; const proximity=clamp(100-(distance/Math.max(1,radius))*100,0,100); const score=Math.round(.55*Number(r.trust_score||0)+.30*proximity+.15*Number(r.source_reliability||0)); return {...r,distance_km:distance,selected_rate:rate,final_amount:finalAmount,age_minutes:fresh,eligible,nearby_score:score};}).filter(x=>x.distance_km<=radius).sort((a,b)=>(b.eligible-a.eligible)||(b.nearby_score-a.nearby_score)||(a.distance_km-b.distance_km));
 res.json({lat,lng,radius_km:radius,amount,to,method,best:result.find(x=>x.eligible)||null,branches:result.slice(0,100)});
}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/alerts',async(req,res)=>{try{const {email,to_currency,target_rate,direction='ABOVE'}=req.body;if(!email||!to_currency||!target_rate)return res.status(400).json({error:'email, to_currency and target_rate are required'});const rows=await q('INSERT INTO price_alerts(email,to_currency,target_rate,direction) VALUES($1,$2,$3,$4) RETURNING *',[email,to_currency,target_rate,direction]);res.status(201).json(rows[0])}catch(e){res.status(500).json({error:e.message})}});

// Admin
app.get('/api/admin/intelligence/overview',admin,async(_req,res)=>{try{
  const [overall,trust,health,top,source]=await Promise.all([
    q(`SELECT COUNT(*)::int total_rates,
              COUNT(*) FILTER (WHERE captured_at>=NOW()-INTERVAL '24 hours')::int rates_24h,
              COUNT(*) FILTER (WHERE captured_at>=NOW()-INTERVAL '60 minutes')::int rates_60m,
              COUNT(*) FILTER (WHERE trust_status='BLOCKED')::int blocked,
              COUNT(*) FILTER (WHERE trust_score IS NOT NULL AND trust_score>=85)::int very_trusted,
              COUNT(*) FILTER (WHERE trust_score IS NOT NULL AND trust_score<65)::int low_trust,
              COUNT(*) FILTER (WHERE captured_at<NOW()-INTERVAL '180 minutes')::int stale,
              COUNT(DISTINCT company_id)::int companies_reporting,
              COUNT(DISTINCT source_id)::int sources_reporting
       FROM exchange_rates WHERE status='ACTIVE'`),
    q(`SELECT COALESCE(ROUND(AVG(trust_score)::numeric,1),0) avg_trust,
              COALESCE(ROUND(AVG(freshness_trust)::numeric,1),0) avg_freshness,
              COALESCE(ROUND(AVG(source_reliability)::numeric,1),0) avg_source_reliability,
              COALESCE(ROUND(AVG(consensus_trust)::numeric,1),0) avg_consensus,
              COALESCE(ROUND(AVG(reference_trust)::numeric,1),0) avg_reference,
              COALESCE(ROUND(AVG(completeness_score)::numeric,1),0) avg_completeness
       FROM exchange_rates WHERE status='ACTIVE' AND captured_at>=NOW()-INTERVAL '24 hours' AND trust_score IS NOT NULL`),
    q(`SELECT s.id,s.name,s.type,s.status,s.last_success,s.update_frequency_minutes,
              COUNT(r.id)::int observations,
              COUNT(r.id) FILTER (WHERE r.captured_at>=NOW()-INTERVAL '24 hours')::int recent_observations,
              ROUND(AVG(EXTRACT(EPOCH FROM (NOW()-r.captured_at))/60)::numeric,1) avg_age_minutes,
              ROUND(AVG(r.trust_score)::numeric,1) avg_trust,
              COUNT(r.id) FILTER (WHERE r.trust_status='BLOCKED')::int blocked,
              COUNT(r.id) FILTER (WHERE r.captured_at<NOW()-INTERVAL '180 minutes')::int stale
       FROM rate_sources s LEFT JOIN exchange_rates r ON r.source_id=s.id AND r.status='ACTIVE'
       GROUP BY s.id ORDER BY avg_trust DESC NULLS LAST`),
    q(`SELECT c.id,c.name_ar,c.name_en,c.rating,
              COUNT(r.id)::int observations,
              COUNT(r.id) FILTER (WHERE r.captured_at>=NOW()-INTERVAL '24 hours')::int observations_24h,
              ROUND(AVG(r.trust_score)::numeric,1) avg_trust,
              ROUND(AVG(r.freshness_trust)::numeric,1) avg_freshness,
              ROUND(AVG(r.source_reliability)::numeric,1) avg_source_reliability,
              ROUND(AVG(r.consensus_trust)::numeric,1) avg_consensus,
              ROUND(AVG(r.reference_trust)::numeric,1) avg_reference,
              ROUND(AVG(r.completeness_score)::numeric,1) avg_completeness,
              COUNT(r.id) FILTER (WHERE r.trust_status='BLOCKED')::int blocked,
              COUNT(r.id) FILTER (WHERE r.captured_at<NOW()-INTERVAL '180 minutes')::int stale,
              COUNT(r.id) FILTER (WHERE r.trust_score>=85)::int trusted
       FROM exchange_companies c LEFT JOIN exchange_rates r ON r.company_id=c.id AND r.status='ACTIVE'
       WHERE c.kind='EXCHANGE' GROUP BY c.id ORDER BY avg_trust DESC NULLS LAST`),
    q(`SELECT cur.code,DATE_TRUNC('hour',r.captured_at) AS hour,ROUND(AVG(r.trust_score)::numeric,1) avg_trust,
              COUNT(*)::int observations
       FROM exchange_rates r JOIN currencies cur ON cur.id=r.currency_id
       WHERE r.status='ACTIVE' AND r.captured_at>=NOW()-INTERVAL '24 hours'
       GROUP BY cur.code,2 ORDER BY 2`)
  ]);
  res.json({generated_at:new Date().toISOString(),overall:overall[0],trust:trust[0],sources:health,companies:top,trust_history:source});
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/admin/intelligence/company/:id',admin,async(req,res)=>{try{
 const id=Number(req.params.id);
 const [summary,history,flags]=await Promise.all([
   q(`SELECT c.id,c.name_ar,c.name_en,c.rating,COUNT(r.id)::int observations,
       ROUND(AVG(r.trust_score)::numeric,1) avg_trust,ROUND(AVG(r.freshness_trust)::numeric,1) avg_freshness,
       ROUND(AVG(r.source_reliability)::numeric,1) avg_source_reliability,ROUND(AVG(r.consensus_trust)::numeric,1) avg_consensus,
       ROUND(AVG(r.reference_trust)::numeric,1) avg_reference,ROUND(AVG(r.completeness_score)::numeric,1) avg_completeness,
       COUNT(*) FILTER (WHERE r.trust_status='BLOCKED')::int blocked,
       COUNT(*) FILTER (WHERE r.captured_at<NOW()-INTERVAL '180 minutes')::int stale
      FROM exchange_companies c LEFT JOIN exchange_rates r ON r.company_id=c.id AND r.status='ACTIVE'
      WHERE c.id=$1 GROUP BY c.id`,[id]),
   q(`SELECT DATE_TRUNC('day',r.captured_at) AS day,ROUND(AVG(r.trust_score)::numeric,1) avg_trust,COUNT(*)::int observations
      FROM exchange_rates r WHERE r.company_id=$1 AND r.status='ACTIVE' AND r.captured_at>=NOW()-INTERVAL '30 days' GROUP BY 1 ORDER BY 1`,[id]),
   q(`SELECT jsonb_array_elements_text(r.trust_flags) flag,COUNT(*)::int count FROM exchange_rates r WHERE r.company_id=$1 AND r.status='ACTIVE' GROUP BY 1 ORDER BY count DESC`,[id])
 ]); res.json({summary:summary[0]||null,history,flags});
}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/admin/sources',admin,async(_req,res)=>res.json(await q('SELECT * FROM rate_sources ORDER BY name')));
app.post('/api/admin/sync',admin,async(_req,res)=>{try{res.json(await runCollectors())}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/admin/stats',admin,async(_req,res)=>{try{const [c,e,b,r,a]=await Promise.all(['currencies','exchange_companies','branches','exchange_rates','price_alerts'].map(t=>q(`SELECT COUNT(*)::int count FROM ${t}`)));res.json({currencies:c[0].count,companies:e[0].count,branches:b[0].count,rates:r[0].count,alerts:a[0].count})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/admin/currencies',admin,async(_req,res)=>res.json(await q('SELECT * FROM currencies ORDER BY sort_order,code')));
app.post('/api/admin/currencies',admin,async(req,res)=>{try{const {code,name_ar,name_en,symbol='',flag='',decimal_places=2,sort_order=0,is_active=true}=req.body;res.status(201).json((await q('INSERT INTO currencies(code,name_ar,name_en,symbol,flag,decimal_places,sort_order,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[code.toUpperCase(),name_ar,name_en,symbol,flag,decimal_places,sort_order,is_active]))[0])}catch(e){res.status(400).json({error:e.message})}});
app.put('/api/admin/currencies/:id',admin,async(req,res)=>{try{const {code,name_ar,name_en,symbol,flag,decimal_places,sort_order,is_active}=req.body;res.json((await q('UPDATE currencies SET code=$1,name_ar=$2,name_en=$3,symbol=$4,flag=$5,decimal_places=$6,sort_order=$7,is_active=$8 WHERE id=$9 RETURNING *',[code.toUpperCase(),name_ar,name_en,symbol,flag,decimal_places,sort_order,is_active,req.params.id]))[0])}catch(e){res.status(400).json({error:e.message})}});
app.delete('/api/admin/currencies/:id',admin,async(req,res)=>{try{await q('UPDATE currencies SET is_active=false WHERE id=$1',[req.params.id]);res.status(204).end()}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/admin/companies',admin,async(_req,res)=>res.json(await q('SELECT * FROM exchange_companies ORDER BY name_ar')));
app.post('/api/admin/companies',admin,async(req,res)=>{try{const {name_ar,name_en='',slug,logo_url='',description_ar='',phone='',website='',rating=null,is_active=true,kind='EXCHANGE'}=req.body;res.status(201).json((await q('INSERT INTO exchange_companies(name_ar,name_en,slug,logo_url,description_ar,phone,website,rating,is_active,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[name_ar,name_en,slug,logo_url,description_ar,phone,website,rating,is_active,kind]))[0])}catch(e){res.status(400).json({error:e.message})}});
app.put('/api/admin/companies/:id',admin,async(req,res)=>{try{const {name_ar,name_en,slug,logo_url,description_ar,phone,website,rating,is_active,kind='EXCHANGE'}=req.body;res.json((await q('UPDATE exchange_companies SET name_ar=$1,name_en=$2,slug=$3,logo_url=$4,description_ar=$5,phone=$6,website=$7,rating=$8,is_active=$9,kind=$10,updated_at=NOW() WHERE id=$11 RETURNING *',[name_ar,name_en,slug,logo_url,description_ar,phone,website,rating,is_active,kind,req.params.id]))[0])}catch(e){res.status(400).json({error:e.message})}});
app.delete('/api/admin/companies/:id',admin,async(req,res)=>{try{await q('UPDATE exchange_companies SET is_active=false,updated_at=NOW() WHERE id=$1',[req.params.id]);res.status(204).end()}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/admin/branches',admin,async(_req,res)=>res.json(await q('SELECT b.*,c.name_ar company_name_ar FROM branches b JOIN exchange_companies c ON c.id=b.company_id ORDER BY c.name_ar,b.name')));
app.post('/api/admin/branches',admin,async(req,res)=>{try{const {company_id,name,area='',address='',latitude=null,longitude=null,phone='',working_hours={},services=[],last_verified_at=null,map_label='',is_active=true}=req.body;res.status(201).json((await q('INSERT INTO branches(company_id,name,area,address,latitude,longitude,phone,working_hours,services,last_verified_at,map_label,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',[company_id,name,area,address,latitude,longitude,phone,working_hours,services,last_verified_at,map_label,is_active]))[0])}catch(e){res.status(400).json({error:e.message})}});
app.put('/api/admin/branches/:id',admin,async(req,res)=>{try{const {company_id,name,area='',address='',latitude=null,longitude=null,phone='',working_hours={},services=[],last_verified_at=null,map_label='',is_active=true}=req.body;res.json((await q('UPDATE branches SET company_id=$1,name=$2,area=$3,address=$4,latitude=$5,longitude=$6,phone=$7,working_hours=$8,services=$9,last_verified_at=$10,map_label=$11,is_active=$12 WHERE id=$13 RETURNING *',[company_id,name,area,address,latitude,longitude,phone,working_hours,services,last_verified_at,map_label,is_active,req.params.id]))[0])}catch(e){res.status(400).json({error:e.message})}});
app.delete('/api/admin/branches/:id',admin,async(req,res)=>{try{await q('UPDATE branches SET is_active=false WHERE id=$1',[req.params.id]);res.status(204).end()}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/admin/rates',admin,async(_req,res)=>res.json(await q(`SELECT r.*,c.name_ar company_name_ar,cur.code currency_code FROM exchange_rates r JOIN exchange_companies c ON c.id=r.company_id JOIN currencies cur ON cur.id=r.currency_id ORDER BY r.captured_at DESC LIMIT 250`)));
app.post('/api/admin/rates',admin,async(req,res)=>{try{const {company_id,currency_id,buy_rate,sell_rate,transfer_rate=null,fees=0,source_id=null,expires_at=null,status='ACTIVE',rate_basis='FOREIGN_PER_KWD',quote_type='CASH',fee_type='FIXED',fee_currency='KWD',min_amount=null,max_amount=null,priority=100,confidence=80,source_reference=null}=req.body;res.status(201).json((await q('INSERT INTO exchange_rates(company_id,currency_id,buy_rate,sell_rate,transfer_rate,fees,source_id,expires_at,status,rate_basis,quote_type,fee_type,fee_currency,min_amount,max_amount,priority,confidence,observed_at,source_reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),$18) RETURNING *',[company_id,currency_id,buy_rate,sell_rate,transfer_rate,fees,source_id,expires_at,status,rate_basis,quote_type,fee_type,fee_currency,min_amount,max_amount,priority,confidence,source_reference]))[0])}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/admin/alerts',admin,async(_req,res)=>res.json(await q('SELECT * FROM price_alerts ORDER BY created_at DESC LIMIT 250')));
app.get('/admin',(req,res)=>res.sendFile(process.cwd()+'/public/admin.html'));
app.get('/*splat',(req,res)=>res.sendFile(process.cwd()+'/public/index.html'));
const SYNC_MINUTES=Number(process.env.RATE_SYNC_MINUTES||30);
if(process.env.ENABLE_AUTO_SYNC!=='false'){setTimeout(()=>runCollectors().then(x=>console.log('Initial rate sync',x)).catch(e=>console.error('Initial rate sync failed',e.message)),5000);setInterval(()=>runCollectors().then(x=>console.log('Scheduled rate sync',x)).catch(e=>console.error('Scheduled rate sync failed',e.message)),SYNC_MINUTES*60*1000)}
const port=process.env.PORT||3000;app.listen(port,()=>console.log(`KWD Rate running on http://localhost:${port}`));
