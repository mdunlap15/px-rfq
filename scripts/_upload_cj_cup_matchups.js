// Upload Bookmaker matchups for The CJ Cup (2026-05-21) to Supabase
// kv_store['betonline_zurich'].
//
// Operator pasted Bookmaker tournament-matchup moneylines for 33 pairings;
// these are quoted AT the raw Bookmaker price (no sweetener / no vig
// rebuild), routed through the existing manual-upload cache path that
// betonline-scraper.lookupZurichMatchupFairProb reads from. Persisting
// to Supabase means the data survives Railway redeploys —
// services/betonline-scraper.restoreFromPersistence reads it on boot.
//
// Cache shape produced by loadManualMatchups (mirrored here):
//   {
//     fetchedAt: ISO,
//     source: 'bookmaker-manual',
//     matchups: [
//       { scope: 'tournament', teams: [{team, odds}, {team, odds}] },
//       ...
//     ],
//     scrapeMs: 0,
//   }
//
// devigMatchup runs lazily on first lookup, so we don't pre-compute fair
// probs here. Strict-mode pricer (post 2026-05-19) reads bookPriceOverride
// from the raw odds — vig is bypassed by design.
//
// Run after each new tournament's matchups need to go live:
//   node scripts/_upload_cj_cup_matchups.js [--dry-run]
//
// Push afterwards (or wait for the next deploy) so Railway picks up the
// data via restoreFromPersistence on boot.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SCOPE = 'tournament';

// (away, home, awayOdds, homeOdds). Order matches the operator's paste.
// teamA is the away/first listed; teamB is the home/second listed.
const MATCHUPS = [
  ['Scottie Scheffler',         'Si Woo Kim',                  -375, +277],
  ['Jordan Spieth',             'Brooks Koepka',               -167, +133],
  ['Pierceson Coody',           'Michael Thorbjornsen',        -124, -106],
  ['Davis Thompson',            'Ryo Hisatsune',               -105, -125],
  ['Rasmus Hojgaard',           'Wyndham Clark',               -120, -110],
  ['Taylor Pendrith',           'Mac Meissner',                -117, -113],
  ['Christiaan Bezuidenhout',   'Sungjae Im',                  -111, -119],
  ['Stephan Jaeger',            'Haotong Li',                  -128, -102],
  ['Max Greyserman',            'Thorbjorn Olesen',            -130, +100],
  ['Rico Hoey',                 'Blades Brown',                -106, -124],
  ['Michael Brennan',           'Tom Kim',                     +102, -132],
  ['Eric Cole',                 'Matti Schmid',                -113, -117],
  ['Zecheng Dou',               'Doug Ghim',                   +127, -160],
  ['Patrick Rodgers',           'Kevin Roy',                   -112, -118],
  ['Beau Hossler',              'Austin Eckroat',              -123, -107],
  ['Chris Kirk',                'Max McGreevy',                -117, -113],
  ['John Parry',                'Adrien Dumont De Chassart',   -136, +106],
  ['Johnny Keefer',             'Seamus Power',                -114, -116],
  ['Rasmus Neergaard Petersen', 'Kevin Yu',                    -137, +107],
  ['William Mouw',              'Tony Finau',                  -137, +107],
  ['Taylor Moore',              'Kristoffer Ventura',          -129, -101],
  ['Karl Vilips',               'Mackenzie Hughes',            -119, -111],
  ['Steven Fisk',               'Lee Hodges',                  -123, -107],
  ['Vince Whaley',              'Chad Ramey',                  -126, -104],
  ['Sam Ryder',                 'Mark Hubbard',                -104, -126],
  ['Preston Stout',             'Trace Crowe',                 -128, -102],
  ['Jhonattan Vegas',           'Hayden Springer',             -153, +122],
  ['Keita Nakajima',            'Carson Young',                -114, -116],
  ['Zac Blair',                 'Zach Bauchou',                -114, -116],
  ['Dan Brown',                 'Matt Kuchar',                 -116, -114],
  ['Billy Horschel',            'Tom Hoge',                    -112, -118],
  ['Ben Kohles',                'Chandler Blanchet',           -111, -119],
  ['Keith Mitchell',            'Jordan Smith',                -136, +106],
];

(async () => {
  const DRY = process.argv.includes('--dry-run');

  const matchupRows = MATCHUPS.map(([teamA, teamB, oddsA, oddsB]) => ({
    scope: SCOPE,
    teams: [
      { team: teamA, odds: oddsA },
      { team: teamB, odds: oddsB },
    ],
  }));

  const payload = {
    fetchedAt: new Date().toISOString(),
    source: 'bookmaker-manual',
    matchups: matchupRows,
    scrapeMs: 0,
  };

  console.log(`Prepared ${matchupRows.length} ${SCOPE}-scope matchups`);
  console.log(`First 3 samples:`);
  for (const m of matchupRows.slice(0, 3)) {
    const [a, b] = m.teams;
    console.log(`  ${a.team.padEnd(28)} ${a.odds >= 0 ? '+' : ''}${a.odds}  vs  ${b.team.padEnd(28)} ${b.odds >= 0 ? '+' : ''}${b.odds}`);
  }

  if (DRY) {
    console.log('\n[dry-run] not writing');
    return;
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // saveKV upserts into kv_store. Same key the live service uses; will be
  // read back by betonline-scraper.restoreFromPersistence on next boot.
  const { error } = await sb.from('kv_store').upsert({
    key: 'betonline_zurich',
    value: payload,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });
  if (error) { console.error('Upsert error:', error.message); process.exit(1); }
  console.log(`\n✓ Wrote kv_store['betonline_zurich'] (${matchupRows.length} matchups, source=${payload.source})`);

  // Read-back verification
  const { data: check } = await sb.from('kv_store').select('value').eq('key', 'betonline_zurich').single();
  console.log(`  verified: ${check.value.matchups.length} matchups present, source=${check.value.source}`);
  console.log(`\nThe running Railway process won't pick up this data until the next restart.`);
  console.log(`Push any commit to trigger redeploy → restoreFromPersistence loads the matchups on boot.`);
})().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
