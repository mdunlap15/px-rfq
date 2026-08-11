// Manual MoV board ingest (POST /ufc-mov/paste) — the DK-blocks-Railway
// fallback. Must run the SAME _buildFight validation + 6-way power de-vig
// as the live scrape, merge into a fresh board, and reject junk.
// Run: npm test

const { test } = require('node:test');
const assert = require('node:assert');
const mov = require('../services/ufc-mov');

const FIGHT = {
  slug: 'alsaghir-vs-escarrega',
  fighters: [
    { name: 'Abe Alsaghir', KO: 350, SUB: 600, DEC: 250 },
    { name: 'Fabrizio Escarrega', KO: 150, SUB: 900, DEC: 500 },
  ],
};

test('valid payload builds a priceable board and getMovFairSync serves it', () => {
  const r = mov.ingestBoard({ fights: [FIGHT] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.built, 1);
  const fair = mov.getMovFairSync('Abe Alsaghir', 'mov_sub', 'Fabrizio Escarrega');
  assert.ok(fair && fair.fairProb > 0 && fair.fairProb < 1, 'sub fair must price: ' + JSON.stringify(fair));
  // ITD = KO + SUB exactly.
  const ko = mov.getMovFairSync('Abe Alsaghir', 'mov_ko', 'Fabrizio Escarrega');
  const itd = mov.getMovFairSync('Abe Alsaghir', 'mov_itd', 'Fabrizio Escarrega');
  assert.ok(Math.abs(itd.fairProb - (ko.fairProb + fair.fairProb)) < 1e-9, 'ITD must equal KO+SUB');
});

test('partial boards are rejected (missing DEC)', () => {
  const bad = { slug: 'partial', fighters: [
    { name: 'A Fighter', KO: 200, SUB: 400, DEC: null },
    { name: 'B Fighter', KO: 300, SUB: 500, DEC: 250 },
  ] };
  const r = mov.ingestBoard({ fights: [bad] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.skipped, ['partial']);
});

test('merge keeps prior fresh fights, junk payload rejected outright', () => {
  const second = { slug: 'kunneman-vs-kropschot', fighters: [
    { name: 'Jon Kunneman', KO: 120, SUB: 700, DEC: 400 },
    { name: 'Joseph Kropschot', KO: 400, SUB: 800, DEC: 600 },
  ] };
  const r = mov.ingestBoard({ fights: [second] });
  assert.equal(r.ok, true);
  assert.equal(r.boardFights, 2, 'must merge with the still-fresh first fight');
  assert.equal(mov.ingestBoard({}).ok, false);
  assert.equal(mov.ingestBoard({ fights: [] }).ok, false);
});
