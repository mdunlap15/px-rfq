'use strict';

/**
 * Resolve the line id of an RFQ leg.
 *
 * Replaces the `leg.line_id || leg.lineId || leg` idiom that was repeated at a
 * dozen call sites. That final `|| leg` was meant to accept a leg that is
 * ALREADY a bare id (a string), and it still does — but when the leg is an
 * OBJECT whose id field is missing, it returned the object itself. An object is
 * truthy, so every downstream `if (!lineId)` guard passed and the object was
 * used as a lookup key, stringifying to '[object Object]'. Consequences seen in
 * review:
 *
 *   - lookupLine() misses and the parlay declines with the useless log line
 *     "unknown line_id [object Object]";
 *   - the golf same-player nesting block, the MoV same-fight block and the
 *     correlation walks all stop matching, so correlated parlays price as if
 *     independent — the "silently never fired" failure those guards warn about;
 *   - in line-manager, lineIndex / _failuresByLineId / the in-flight dedup map
 *     all key on the SAME '[object Object]' string, so every distinct unknown
 *     leg collides into one entry and the first failure poisons resolution for
 *     every later line.
 *
 * A leg whose id cannot be resolved must decline explicitly, never key a lookup
 * on an object. Returns null in that case.
 *
 * NOTE: this deliberately does NOT yet read `strike_id` (the CFTC rename).
 * Accepting strike_id here without the matching `line` -> `strike` fix would
 * let selections through with a null strike, and `undefined < 0` is false —
 * tagging every spread selection 'underdog', a wrong-side registration that
 * produces a mispriced quote instead of a clean decline. Those two must land
 * together; this file is the single place that change will go.
 */
function legLineId(leg) {
  if (leg == null) return null;
  const t = typeof leg;
  // Already a bare id (the case the old `|| leg` tail existed to serve).
  if (t === 'string' || t === 'number') return leg;
  if (t !== 'object') return null;
  const v = leg.line_id != null ? leg.line_id : leg.lineId;
  if (v == null) return null;
  // Never let a nested object/array become a cache key.
  return typeof v === 'object' ? null : v;
}

module.exports = { legLineId };
