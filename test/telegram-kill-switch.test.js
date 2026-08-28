// Telegram alerts master kill-switch.
//
// Operator directive 2026-08-28: "Disable all Telegram alerts for now."
// Gated inside sendMessage rather than at the call sites, because every alert
// funnels through that one function — a future caller cannot bypass it.
//
// Run: npm test   (or: node --test test/telegram-kill-switch.test.js)

const { test } = require('node:test');
const assert = require('node:assert');

function fresh(env) {
  for (const k of ['TELEGRAM_ALERTS_ENABLED', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) delete process.env[k];
  Object.assign(process.env, env || {});
  delete require.cache[require.resolve('../services/telegram')];
  return require('../services/telegram');
}

test('alerts are DISABLED by default — no env set', async () => {
  const tg = fresh({ TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '123' });
  const r = await tg.sendMessage('should not send');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'alerts_disabled');
});

test('THE POINT: fully configured credentials still do NOT send while disabled', async () => {
  // The pre-existing no-op only covered MISSING credentials. With a token and
  // chat id present the old code would have sent — this is what the switch adds.
  const tg = fresh({ TELEGRAM_BOT_TOKEN: 'realtoken', TELEGRAM_CHAT_ID: '999' });
  assert.strictEqual(tg.isConfigured(), true, 'credentials are present');
  const r = await tg.sendMessage('still must not send');
  assert.strictEqual(r.error, 'alerts_disabled');
});

test('an explicit false / 0 / yes does not enable it — only the literal "true"', async () => {
  for (const v of ['false', '0', 'no', 'TRUE', '1', 'yes', '']) {
    const tg = fresh({ TELEGRAM_ALERTS_ENABLED: v, TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '123' });
    const r = await tg.sendMessage('x');
    assert.strictEqual(r.error, 'alerts_disabled', `value "${v}" must not enable alerts`);
  }
});

test('the switch is read per call, so re-enabling needs no restart', async () => {
  const tg = fresh({ TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '123' });
  assert.strictEqual((await tg.sendMessage('a')).error, 'alerts_disabled');
  process.env.TELEGRAM_ALERTS_ENABLED = 'true';
  // Now past the kill-switch. It will fail at the network call against a fake
  // token, which is fine — what matters is that it is no longer short-circuited.
  const r = await tg.sendMessage('b');
  assert.notStrictEqual(r.error, 'alerts_disabled', 'must get past the switch once enabled');
  delete process.env.TELEGRAM_ALERTS_ENABLED;
});

test('alertsEnabled() reports the switch state', async () => {
  const tg = fresh({ TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '123' });
  assert.strictEqual(tg.alertsEnabled(), false);
  process.env.TELEGRAM_ALERTS_ENABLED = 'true';
  assert.strictEqual(tg.alertsEnabled(), true);
  delete process.env.TELEGRAM_ALERTS_ENABLED;
});
