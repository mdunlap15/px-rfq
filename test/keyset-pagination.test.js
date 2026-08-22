const test = require('node:test');
const assert = require('node:assert');
const { _pageKeyset } = require('../services/db');

// A fake PostgREST client. It records the filters applied and serves rows from
// an in-memory table, so the tie/cap/loop behaviour can be exercised without a
// database. Only the subset of the builder the pager actually uses is modelled.
function fakeClient(rows, opts = {}) {
  const calls = [];
  let callNo = 0;
  return {
    calls,
    from() {
      const st = { gte: null, or: null, order: [], limit: null };
      const b = {
        select() { return b; },
        gte(col, v) { st.gte = [col, v]; return b; },
        or(expr) { st.or = expr; return b; },
        order(col, o) { st.order.push([col, o.ascending]); return b; },
        limit(n) {
          st.limit = n;
          calls.push(st);
          callNo++;
          if (opts.failFirstN && callNo <= opts.failFirstN) {
            return Promise.resolve({ error: { message: 'statement timeout' }, data: null });
          }
          let out = rows.filter(r => r.ts >= st.gte[1]);
          if (st.or) {
            // Parse: ts.gt."X",and(ts.eq."X",id.gt."Y")
            const m = st.or.match(/ts\.(gt|lt)\."([^"]+)",and\(ts\.eq\."[^"]+",id\.gt\."([^"]+)"\)/);
            const [, cmp, cts, cid] = m;
            out = out.filter(r => (cmp === 'gt' ? r.ts > cts : r.ts < cts)
              || (r.ts === cts && r.id > cid));
          }
          const asc = st.order[0][1];
          out.sort((a, z) => a.ts === z.ts
            ? String(a.id).localeCompare(String(z.id))
            : (asc ? (a.ts < z.ts ? -1 : 1) : (a.ts < z.ts ? 1 : -1)));
          return Promise.resolve({ error: null, data: out.slice(0, st.limit) });
        },
      };
      return b;
    },
  };
}

const base = { table: 't', cols: '*', tsCol: 'ts', idCol: 'id', gteTs: '0', pageSize: 2 };

test('returns every row exactly once across pages', async () => {
  const rows = [
    { ts: 'a', id: '1' }, { ts: 'a', id: '2' }, { ts: 'b', id: '3' },
    { ts: 'c', id: '4' }, { ts: 'd', id: '5' },
  ];
  const client = fakeClient(rows);
  const got = await _pageKeyset({ ...base, client });
  assert.strictEqual(got.length, 5);
  assert.deepStrictEqual(got.map(r => r.id), ['1', '2', '3', '4', '5']);
});

test('does not drop rows that share a timestamp across a page boundary', async () => {
  // THE bug the composite tiebreak exists to prevent: 3 rows share ts 'a' and
  // the page boundary falls in the middle of them. A timestamp-only cursor
  // would skip id 3. Prod `declines` really does have ties up to 5 deep.
  const rows = [
    { ts: 'a', id: '1' }, { ts: 'a', id: '2' }, { ts: 'a', id: '3' },
    { ts: 'b', id: '4' },
  ];
  const got = await _pageKeyset({ ...base, client: fakeClient(rows) });
  assert.deepStrictEqual(got.map(r => r.id), ['1', '2', '3', '4']);
});

test('descending order walks backwards and still keeps ties', async () => {
  const rows = [
    { ts: 'a', id: '1' }, { ts: 'b', id: '2' }, { ts: 'b', id: '3' },
    { ts: 'c', id: '4' },
  ];
  const got = await _pageKeyset({ ...base, ascending: false, client: fakeClient(rows) });
  assert.strictEqual(got.length, 4);
  assert.deepStrictEqual(got.map(r => r.ts), ['c', 'b', 'b', 'a']);
});

test('never issues an OFFSET-style range call', async () => {
  const client = fakeClient([{ ts: 'a', id: '1' }, { ts: 'b', id: '2' }]);
  await _pageKeyset({ ...base, client });
  // First page has no cursor; every later page must carry one.
  assert.strictEqual(client.calls[0].or, null);
  assert.ok(client.calls.length > 1);
  assert.ok(client.calls[1].or.includes('and(ts.eq.'), 'later pages must use a composite cursor');
});

test('honours the cap and stops early', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ ts: `t${i}`, id: String(i) }));
  const got = await _pageKeyset({ ...base, cap: 3, client: fakeClient(rows) });
  assert.strictEqual(got.length, 3);
});

test('retries a transient error then succeeds', async () => {
  const rows = [{ ts: 'a', id: '1' }, { ts: 'b', id: '2' }];
  const got = await _pageKeyset({ ...base, client: fakeClient(rows, { failFirstN: 2 }) });
  assert.strictEqual(got.length, 2);
});

test('returns partial data rather than throwing when retries are exhausted', async () => {
  const rows = [{ ts: 'a', id: '1' }];
  const got = await _pageKeyset({ ...base, maxRetries: 2, client: fakeClient(rows, { failFirstN: 99 }) });
  assert.deepStrictEqual(got, []);
});

test('stops instead of looping when the cursor column is null', async () => {
  // A null ts/id would rebuild the same query forever. Bounded by a timeout so
  // a regression fails loudly instead of hanging the suite.
  const rows = [{ ts: 'a', id: '1' }, { ts: null, id: null }];
  const got = await Promise.race([
    _pageKeyset({ ...base, pageSize: 2, client: fakeClient(rows) }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('paging looped')), 2000)),
  ]);
  assert.ok(Array.isArray(got));
});
