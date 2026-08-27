import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://kwd_rate:kwd_rate_dev@localhost:5432/kwd_rate' });
const num=v=>Number(v||0);
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));

function fresh(r){
  const age=Math.max(0,(Date.now()-new Date(r.captured_at).getTime())/60000);
  const expired=r.expires_at && new Date(r.expires_at).getTime()<=Date.now();
  return {age,expired};
}
function rawRate(r,from,method){
  if(from==='KWD') return method==='TRANSFER'?num(r.transfer_rate||r.sell_rate):num(r.sell_rate||r.transfer_rate);
  return num(r.buy_rate);
}
function effectiveRate(r,from,to,method,amount){
  const raw=rawRate(r,from,method); if(!raw||raw<=0)return null;
  const basis=r.rate_basis||'FOREIGN_PER_KWD'; const feeType=r.fee_type||'FIXED'; const fee=Math.max(0,num(r.fees)); const fc=r.fee_currency||'KWD';
  const feeInput=feeType==='PERCENT'?amount*fee/100:(fc===from?fee:0); const net=Math.max(0,amount-feeInput);
  let gross;
  if(from==='KWD') gross=basis==='FOREIGN_PER_KWD'?net*raw:net/raw;
  else gross=basis==='KWD_PER_FOREIGN'?net*raw:net/raw;
  const feeOutput=feeType==='PERCENT'?0:(fc===to?fee:0); const final=Math.max(0,gross-feeOutput);
  return amount?final/amount:null;
}

async function evaluateAlert(client,a){
  const code=a.from_currency==='KWD'?a.to_currency:a.from_currency;
  const rows=(await client.query(`SELECT DISTINCT ON (r.company_id) r.*, c.name_ar company_name_ar, s.name source_name, s.type source_type, s.status source_status, s.last_success
    FROM exchange_rates r JOIN currencies cur ON cur.id=r.currency_id JOIN exchange_companies c ON c.id=r.company_id
    LEFT JOIN rate_sources s ON s.id=r.source_id
    WHERE cur.code=$1 AND c.kind='EXCHANGE' AND c.is_active=true AND r.status='ACTIVE' AND r.quote_type=$2
    ORDER BY r.company_id,r.captured_at DESC`,[code,a.method])).rows;
  const valid=rows.map(r=>{const f=fresh(r); const rate=effectiveRate(r,a.from_currency,a.to_currency,a.method,num(a.amount||1)); const sourceBase=({API:95,PARTNER:96,WEB:84,IMPORT:80,MANUAL:68})[String(r.source_type||'').toUpperCase()]??65; const trust=clamp(Math.round(.6*sourceBase+.4*(f.age<=10?100:f.age<=60?85:f.age<=180?65:20)),0,100); return {...r,rate,age:f.age,expired:f.expired,trust};}).filter(x=>x.rate&&x.rate>0&&!x.expired&&x.age<=180&&x.trust>=65);
  if(!valid.length)return {trigger:false};
  let candidates=valid;
  if(a.company_id)candidates=valid.filter(x=>Number(x.company_id)===Number(a.company_id));
  if(!candidates.length)return {trigger:false};
  // For KWD -> foreign, higher rate is better. For foreign -> KWD, higher KWD output per input is better too.
  const best=candidates.sort((x,y)=>y.rate-x.rate)[0];
  const condition=a.direction==='ABOVE'?best.rate>=num(a.target_rate):best.rate<=num(a.target_rate);
  const cooldownOk=!a.last_triggered_at || (Date.now()-new Date(a.last_triggered_at).getTime())>=num(a.cooldown_minutes||60)*60000;
  const shouldTrigger=condition && (!a.last_condition_state || cooldownOk);
  return {trigger:shouldTrigger,condition,rate:best.rate,trust:best.trust,companyId:best.company_id,companyName:best.company_name_ar,source:best.source_name,age:best.age};
}

export async function evaluatePriceAlerts(){
  const client=await pool.connect(); let triggered=0,checked=0;
  try{await client.query('BEGIN');
    const alerts=(await client.query(`SELECT a.*,u.email,u.full_name FROM user_alerts a JOIN users u ON u.id=a.user_id WHERE a.is_active=true AND u.is_active=true FOR UPDATE`)).rows;
    for(const a of alerts){checked++; const out=await evaluateAlert(client,a); await client.query(`UPDATE user_alerts SET last_checked_at=NOW(), last_condition_state=$2, last_observed_rate=$3, last_trust_score=$4 WHERE id=$1`,[a.id,!!out.condition,out.rate??null,out.trust??null]);
      if(!out.trigger)continue;
      const reason=`${a.direction==='ABOVE'?'السعر وصل إلى أو تجاوز':'السعر انخفض إلى أو أقل من'} ${a.target_rate}. السعر المرصود ${out.rate.toFixed(8)}، الثقة ${out.trust}/100، المصدر ${out.source||'غير محدد'}.`;
      const ev=(await client.query(`INSERT INTO alert_events(alert_id,observed_rate,target_rate,direction,method,company_id,trust_score,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[a.id,out.rate,a.target_rate,a.direction,a.method,out.companyId,out.trust,reason])).rows[0];
      const subject=`KWD Rate Alert: ${a.to_currency}`;
      const body=`تنبيه KWD Rate\n\n${reason}\nالشركة: ${out.companyName||'أفضل سعر في السوق'}\nنوع العملية: ${a.method}\n\nافتح حسابك لمراجعة السعر.`;
      await client.query(`INSERT INTO notification_outbox(alert_event_id,user_id,channel,destination,subject,body) VALUES($1,$2,$3,$4,$5,$6)`,[ev.id,a.user_id,a.channel,a.channel==='EMAIL'?a.email:(a.channel==='WEBHOOK'?a.webhook_url:(a.channel==='WHATSAPP'?null:null)),subject,body]);
      await client.query('UPDATE user_alerts SET last_triggered_at=NOW() WHERE id=$1',[a.id]); triggered++;
    }
    await client.query('COMMIT'); return {checked,triggered};
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}

export async function dispatchInApp(){
  // In-app notifications are durable in notification_outbox; the account API exposes them.
  return {ok:true};
}


export async function dispatchWebhooks(){
  const client=await pool.connect(); let sent=0,failed=0;
  try{
    const rows=(await client.query(`SELECT n.*,e.reason FROM notification_outbox n JOIN alert_events e ON e.id=n.alert_event_id WHERE n.status='PENDING' AND n.channel='WEBHOOK' AND n.available_at<=NOW() ORDER BY n.id LIMIT 50`)).rows;
    for(const n of rows){
      try{ if(!n.destination) throw new Error('Missing webhook destination'); const r=await fetch(n.destination,{method:'POST',headers:{'content-type':'application/json','user-agent':'KWD-Rate-Alert/1.0'},body:JSON.stringify({event_id:n.alert_event_id,subject:n.subject,body:n.body,reason:n.reason})}); if(!r.ok)throw new Error(`Webhook ${r.status}`); await client.query(`UPDATE notification_outbox SET status='SENT',sent_at=NOW(),attempts=attempts+1,last_error=NULL WHERE id=$1`,[n.id]); sent++; }
      catch(e){ failed++; await client.query(`UPDATE notification_outbox SET attempts=attempts+1,last_error=$2,status=CASE WHEN attempts+1>=5 THEN 'FAILED' ELSE 'PENDING' END,available_at=NOW()+((attempts+1)*5*INTERVAL '1 minute') WHERE id=$1`,[n.id,e.message]); }
    }
    return {sent,failed};
  } finally {client.release();}
}

if(process.argv.includes('--once')) evaluatePriceAlerts().then(x=>{console.log(JSON.stringify(x));return pool.end()}).catch(e=>{console.error(e);pool.end().finally(()=>process.exit(1))});
