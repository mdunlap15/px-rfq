// The boot seed must register with the operator's saved settings, so the vig
// and Runtime Tuning overrides hydrate BEFORE it (2026-10-04: the first seed
// after a restart stripped NFL/CFB alt ladders because footballGameMainOnly's
// env default applied until the next seed).
const { test } = require('node:test');
const assert = require('node:assert');
const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');

test('runtime + vig overrides hydrate before the boot seed', () => {
  const rtc = src.indexOf('await rtc.hydrate()');
  const vcs = src.indexOf('await vcs.hydrate()');
  const seed = src.indexOf('await lineManager.seedAllLines()');
  const probe = src.indexOf('await db.bootProbe()');
  assert.ok(rtc > 0 && vcs > 0 && seed > 0 && probe > 0);
  assert.ok(probe < rtc, 'the DB boot probe runs first');
  assert.ok(rtc < seed && vcs < seed, 'overrides must be live before the first seed registers lines');
});
