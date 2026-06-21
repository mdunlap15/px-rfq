// Simulate the template-exposure DOLLAR-aggregate cap against the real settled
// book. Uses production's canonicalSignature; replays confirmed bets per
// signature (24h window). Live RFQs always carry team names, so reconstructed
// teamless rows (whose legs collapse to "?") are excluded.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const te = require('../services/template-exposure');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const WINDOW_MS = 24*60*60*1000;

(async () => {
  let all=[], from=0; const PAGE=1000;
  for(;;){
    const { data, error } = await sb.from('parlay_orders')
      .select('parlay_id,confirmed_at,confirmed_stake,pnl,legs,meta')
      .not('settled_at','is',null).not('confirmed_at','is',null)
      .order('confirmed_at',{ascending:true}).range(from, from+PAGE-1);
    if(error){console.error(error.message);process.exit(1);}
    all=all.concat(data); if(data.length<PAGE)break; from+=PAGE;
  }
  let teamless=0;
  const rows = all.map(o=>{
    const legs = o.legs || o.meta?.legs || [];
    const sig = te.canonicalSignature(legs);
    const hasTeams = legs.length>0 && legs.every(l => { const t=l.team||l.teamName; return t && String(t).trim() && t!=='?'; });
    if(sig && !hasTeams) teamless++;
    return { id:o.parlay_id, t:new Date(o.confirmed_at).getTime(), stake:o.confirmed_stake||0, pnl:o.pnl||0, sig, hasTeams };
  }).filter(r=>r.sig && r.stake>0 && !isNaN(r.t) && r.hasTeams);
  console.log('teamless (reconstructed) rows excluded:', teamless, '| replayable:', rows.length);
  rows.sort((a,b)=>a.t-b.t);

  // Concentration: repeated signatures within a rolling 24h window (what the cap sees)
  const bySig={};
  for(const r of rows){ const b=bySig[r.sig]||(bySig[r.sig]={n:0,stake:0,pnl:0}); b.n++; b.stake+=r.stake; b.pnl+=r.pnl; }
  const multi=Object.values(bySig).filter(s=>s.n>1);
  console.log(`signatures: ${Object.keys(bySig).length} total, ${multi.length} ever-repeated`);
  console.log('top repeated signatures (lifetime, not windowed):');
  Object.entries(bySig).sort((a,b)=>b[1].n-a[1].n).slice(0,6).forEach(([s,v])=>
    console.log(`  n=${v.n} stake=$${v.stake.toFixed(0)} pnl=${v.pnl>=0?'+':''}${v.pnl.toFixed(0)}  ${s.slice(0,80)}`));

  function replay(cap){
    const win={}; let decN=0,decStake=0,decPnl=0,decW=0,decL=0;
    for(const r of rows){
      const arr=(win[r.sig]=win[r.sig]||[]).filter(e=>e.t>=r.t-WINDOW_MS); win[r.sig]=arr;
      const priorCount=arr.length, priorStake=arr.reduce((s,e)=>s+e.stake,0);
      if(cap>0 && priorCount>=1 && priorStake>=cap){ decN++; decStake+=r.stake; decPnl+=r.pnl; if(r.pnl>0)decW++; else if(r.pnl<0)decL++; }
      else arr.push({t:r.t,stake:r.stake});
    }
    return {decN,decStake,decPnl,decW,decL};
  }
  console.log('\ncap      declined  declinedStake   ourSaved(=-pnl)   declined(W-L)');
  for(const cap of [500,1000,1500,2000,3000,5000]){
    const r=replay(cap);
    console.log(`$${String(cap).padEnd(6)} ${String(r.decN).padStart(7)}   $${r.decStake.toFixed(0).padStart(10)}   ${((-r.decPnl)>=0?'+':'')+(-r.decPnl).toFixed(0).padStart(9)}        ${r.decW}-${r.decL}`);
  }
  console.log('\nourSaved>0 = net good for us (declined copies the bettor would have won).');
})();
