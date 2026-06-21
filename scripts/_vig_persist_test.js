const db = require('../services/db');
const _kv = {}; db.saveKV = async (k,v)=>{ _kv[k]=v; }; db.loadKV = async (k)=> (_kv[k] ?? null);
const { config } = require('../config');
const vcs = require('../services/vig-config-store');
const setEnv = (vbs, dv=0.06, plv=false)=>{ config.pricing.vigBySport={...vbs}; config.pricing.defaultVig=dv; config.pricing.parlayLevelVig=plv; };
const wait = ()=>new Promise(r=>setTimeout(r,30));
(async()=>{
  // boot 1: env baseline
  setEnv({ baseball_mlb:0.01, soccer:0.025 });
  await vcs.hydrate(); // no record yet
  // operator edits via Config tab: soccer 0.025->0.02, add tennis 0.03, default->0.05
  config.pricing.vigBySport.soccer=0.02; config.pricing.vigBySport.tennis=0.03; config.pricing.defaultVig=0.05;
  vcs.persist(); await wait();
  console.log('persisted record present:', !!_kv['vig_config_overrides']);

  // --- RESTART A: env UNCHANGED -> overrides should be restored ---
  setEnv({ baseball_mlb:0.01, soccer:0.025 }); // pure env again
  let r = await vcs.hydrate();
  console.log(`RESTART(env unchanged): reason=${r.reason} applied=${r.applied} | soccer=${config.pricing.vigBySport.soccer} tennis=${config.pricing.vigBySport.tennis} default=${config.pricing.defaultVig}`);
  console.log('  expect: applied=true, soccer=0.02, tennis=0.03, default=0.05 ->',
    r.applied && config.pricing.vigBySport.soccer===0.02 && config.pricing.vigBySport.tennis===0.03 && config.pricing.defaultVig===0.05 ? 'PASS':'FAIL');

  // --- RESTART B: env CHANGED in Railway (soccer 0.025->0.04) -> env wins, override discarded ---
  setEnv({ baseball_mlb:0.01, soccer:0.04 }); // new env
  r = await vcs.hydrate();
  console.log(`RESTART(env changed): reason=${r.reason} discarded=${!!r.discarded} | soccer=${config.pricing.vigBySport.soccer} tennis=${config.pricing.vigBySport.tennis} default=${config.pricing.defaultVig}`);
  console.log('  expect: discarded=true, soccer=0.04 (env), tennis=undefined, default=0.06 ->',
    r.discarded && config.pricing.vigBySport.soccer===0.04 && config.pricing.vigBySport.tennis===undefined && config.pricing.defaultVig===0.06 ? 'PASS':'FAIL');
  console.log('  record cleared after discard:', _kv['vig_config_overrides']==null ? 'PASS':'FAIL');

  // --- RESTART C: after discard, env stable -> nothing to apply ---
  setEnv({ baseball_mlb:0.01, soccer:0.04 });
  r = await vcs.hydrate();
  console.log(`RESTART(post-discard): reason=${r.reason} -> expect 'none':`, r.reason==='none'?'PASS':'FAIL');
})();
