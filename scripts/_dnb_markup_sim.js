// Calibration sim for the soccer DNB favorite markup (config.vigDnbFavMarkup).
// Replicates the heavy-fav markup MAX-gate compound + American conversion
// against recorded parlay 019ee30e (the 5-leg WC DNB stack that priced +103
// with ~0.96%/leg margin while FanDuel's DNB betslip was -154 / 5.46%/leg).
//
// Run: node scripts/_dnb_markup_sim.js
//
// Confirms: (a) the DNB markup path dominates the MAX (so result is
// insensitive to the chalk/slope knobs that produced the +103), (b) the
// coefficient lands us inside FD's -154 and well above the +103 leak, and
// (c) NON-DNB legs of the same fair are untouched (isDNB gate).

// Recorded per-leg DNB fair probs (our pricing input — verified vs Pinnacle's
// actual de-vigged DNB market within ~0.1pp by the root-cause workflow).
const LEGS = [
  { name: 'Japan',     fair: 0.7996 },
  { name: 'Argentina', fair: 0.7948 },
  { name: 'France',    fair: 0.9633 },
  { name: 'England',   fair: 0.9191 },
  { name: 'Colombia',  fair: 0.8259 },
];

// pricer.js decimalToAmerican (exact copy).
function decimalToAmerican(dec) {
  if (!dec || dec <= 1) return 0;
  if (dec >= 2.0) return Math.round((dec - 1) * 100);
  return Math.round(-100 / (dec - 1));
}
const probToAmerican = (p) => decimalToAmerican(1 / p);

// The heavy-fav markup compound, DNB-scoped, as written in pricer.js:
//   for each DNB leg above threshold: leg *= min(0.99, fair*(1+markup))
const DNB_THRESHOLD = 0.55;
function markupCompound(legs, markup, { isDNB = true } = {}) {
  let prod = 1;
  for (const l of legs) {
    if (isDNB && markup > 0 && l.fair > DNB_THRESHOLD) {
      prod *= Math.min(0.99, l.fair * (1 + markup));
    } else {
      prod *= l.fair; // baseline: no markup (stand-in — real path uses payout-vig)
    }
  }
  return prod;
}

const fairProduct = LEGS.reduce((p, l) => p * l.fair, 1);

console.log('=== Recorded parlay 019ee30e ===');
console.log(`fair product       : ${(fairProduct * 100).toFixed(2)}%  (${probToAmerican(fairProduct) >= 0 ? '+' : ''}${probToAmerican(fairProduct)})`);
console.log('recorded OFFERED   : 49.28%  (+103)   <- what got picked off');
console.log('FanDuel DNB betslip: 60.49%  (-154)   <- FD fair + ~5.46%/leg vig');
console.log('');
console.log('=== DNB markup sweep (offered = compound of fair*(1+m), MAX-gated) ===');
console.log('markup |  offered  | American | impliedMargin/leg | vs +103 leak | vs FD -154');
for (const m of [0.025, 0.03, 0.035, 0.04, 0.045, 0.05, 0.06]) {
  const off = markupCompound(LEGS, m);
  const am = probToAmerican(off);
  // effective per-leg implied margin = geometric (off/fair)^(1/n) - 1
  const perLeg = Math.pow(off / fairProduct, 1 / LEGS.length) - 1;
  const tighterThanLeak = off > 0.4928;
  const insideFD = off < 0.6049;
  console.log(
    `${m.toFixed(3)}  |  ${(off * 100).toFixed(2)}%  | ${am >= 0 ? '+' : ''}${am}`.padEnd(40) +
    `| ${(perLeg * 100).toFixed(2)}%`.padEnd(20) +
    `| ${tighterThanLeak ? 'YES (+EV)' : 'no'}`.padEnd(15) +
    `| ${insideFD ? 'YES (competitive)' : 'NO (>= FD)'}`,
  );
}

console.log('');
console.log('=== Guard: NON-DNB legs of identical fair are UNTOUCHED ===');
const dnbOff = markupCompound(LEGS, 0.04, { isDNB: true });
const nonDnbOff = markupCompound(LEGS, 0.04, { isDNB: false });
console.log(`isDNB=true,  markup 0.04 -> ${(dnbOff * 100).toFixed(2)}%  (${probToAmerican(dnbOff)})`);
console.log(`isDNB=false, markup 0.04 -> ${(nonDnbOff * 100).toFixed(2)}%  (${probToAmerican(nonDnbOff)})  (== fair product, markup skipped)`);
console.log(`non-DNB unchanged: ${Math.abs(nonDnbOff - fairProduct) < 1e-9 ? 'PASS' : 'FAIL'}`);
console.log('');
console.log('=== Per-leg detail @ markup 0.04 ===');
for (const l of LEGS) {
  const marked = Math.min(0.99, l.fair * 1.04);
  const clamp = marked >= 0.99 && l.fair * 1.04 > 0.99 ? ' (clamped 0.99)' : '';
  console.log(`${l.name.padEnd(11)} fair ${(l.fair * 100).toFixed(2)}% -> ${(marked * 100).toFixed(2)}%  (+${((marked - l.fair) * 100).toFixed(2)}pp)${clamp}`);
}
