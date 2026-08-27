import pg from 'pg';
import { evaluatePriceAlerts } from './alert-engine.js';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://kwd_rate:kwd_rate_dev@localhost:5432/kwd_rate' });
const UA = 'KWD-Rate/1.0 (+currency comparison service)';
const fetchText = async (url) => { const r = await fetch(url,{headers:{'user-agent':UA,'accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'}}); if(!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.text(); };
const clean = (s) => s.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
const upsertRate = async ({companySlug,sourceName,code,buy,sell,transfer,capturedAt=new Date()}) => {
  if(!buy && !sell && !transfer) return false;
  const client=await pool.connect();
  try { await client.query('BEGIN');
    const company=(await client.query('SELECT id FROM exchange_companies WHERE slug=$1',[companySlug])).rows[0];
    const currency=(await client.query('SELECT id FROM currencies WHERE code=$1',[code])).rows[0];
    const source=(await client.query('SELECT id FROM rate_sources WHERE name=$1',[sourceName])).rows[0];
    if(!company||!currency||!source) throw new Error(`Missing mapping for ${companySlug}/${code}/${sourceName}`);
    await client.query(`INSERT INTO exchange_rates(company_id,currency_id,buy_rate,sell_rate,transfer_rate,fees,source_id,captured_at,status) VALUES($1,$2,$3,$4,$5,0,$6,$7,'ACTIVE')`,[company.id,currency.id,buy??null,sell??null,transfer??null,source.id,capturedAt]);
    await client.query('UPDATE rate_sources SET last_success=NOW(),status=\'ACTIVE\' WHERE id=$1',[source.id]); await client.query('COMMIT'); return true;
  } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }
};

async function collectCBK(){
  const html=await fetchText('https://www.cbk.gov.kw/en/monetary-policy/market-operations/exchange-rates');
  const text=clean(html);
  const labels={USD:'US Dollar',EUR:'EURO',GBP:'Pound Sterling',JPY:'Japanese Yen',CHF:'Swiss Franc',SAR:'Saudi Riyal',AED:'Emirati Dirham',QAR:'Qatari Riyal',BHD:'Bahraini Dinar',OMR:'Omani Rial'};
  let count=0;
  for(const [code,label] of Object.entries(labels)){
    const re=new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s+([0-9,]+(?:\\.[0-9]+)?)\\s+Fils/Unit','i'); const m=text.match(re); if(!m) continue;
    const kdPerUnit=Number(m[1].replace(/,/g,''))/1000; const perKwd=1/kdPerUnit;
    if(await upsertRate({companySlug:'cbk-reference',sourceName:'Central Bank of Kuwait',code,buy:perKwd,sell:perKwd,transfer:perKwd})) count++;
  }
  return count;
}
async function collectKBE(){
  const html=await fetchText('https://kbe.com.kw/currencyrate.php'); const text=clean(html); let count=0;
  const codes=['USD','EUR','GBP','SAR','AED','EGP','INR','BDT','PKR','PHP','LKR','NPR','BHD','JOD','IDR'];
  for(const code of codes){
    const re=new RegExp(code+'\\s+([0-9,]+(?:\\.[0-9]+)?)\\s+([0-9,]+(?:\\.[0-9]+)?)\\s+([0-9]{2}-[0-9]{2}-[0-9]{4})','i'); const m=text.match(re); if(!m) continue;
    const perUnit=Number(m[1].replace(/,/g,'')); const perKwd=Number(m[2].replace(/,/g,''));
    const buySellRe=new RegExp(code+'\\s+([0-9.]+)\\s+([0-9.]+)\\s+([0-9]{2}-[0-9]{2}-[0-9]{4})','gi'); const matches=[...text.matchAll(buySellRe)];
    const last=matches.at(-1); let buy=null,sell=null; if(last){buy=Number(last[1]);sell=Number(last[2]);}
    // KBE's first table explicitly publishes rate per KD; use it as transfer/reference rate.
    if(perKwd) { buy=buy?1/buy:perKwd; sell=sell?1/sell:perKwd; }
    if(await upsertRate({companySlug:'kbe-kuwait',sourceName:'KBE Kuwait',code,buy,sell,transfer:perKwd})) count++;
  }
  return count;
}
async function collectBEC(){
  const html=await fetchText('https://www.bec.com.kw/'); const text=clean(html); let count=0;
  // BEC currently exposes KWD-based pairs only for some currencies on its public landing page.
  // We only ingest an explicitly KWD-labelled pair; we never infer a base currency from the table heading.
  const re=/Kuwaiti Dinar\(KWD\) to ([A-Za-z ]+)\((\w{3})\) Exchange Rate\s+\2\s+([0-9.]+)\s+([0-9.]+)/i;
  const m=text.match(re); if(m){ const code=m[2].toUpperCase(); const buy=Number(m[3]),sell=Number(m[4]); if(await upsertRate({companySlug:'bec-kuwait',sourceName:'BEC Kuwait',code,buy,sell,transfer:sell})) count++; }
  return count;
}
export async function runCollectors(){
  const out={startedAt:new Date().toISOString(),sources:{}};
  for(const [name,fn] of Object.entries({cbk:collectCBK,kbe:collectKBE,bec:collectBEC})){
    try{out.sources[name]={ok:true,inserted:await fn()};}catch(e){out.sources[name]={ok:false,error:e.message}; await pool.query('UPDATE rate_sources SET status=\'ERROR\' WHERE name IN ($1,$2,$3)',[name==='cbk'?'Central Bank of Kuwait':name==='kbe'?'KBE Kuwait':'BEC Kuwait', '','']).catch(()=>{});}
  }
  try { out.alerts=await evaluatePriceAlerts(); } catch(e) { out.alerts={ok:false,error:e.message}; }
  out.finishedAt=new Date().toISOString(); return out;
}
if(process.argv.includes('--once')){runCollectors().then(x=>{console.log(JSON.stringify(x,null,2));return pool.end()}).catch(e=>{console.error(e);pool.end().finally(()=>process.exit(1))});}
