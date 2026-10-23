'use strict';
// Card helpers. Cards are {r:2..14, s:'s'|'h'|'d'|'c'} (same shape as evaluator.js).
// On the wire a card is a 2-char string: rank (2-9,T,J,Q,K,A) + suit, e.g. "Ts" = 10 of spades.
const crypto = require('crypto');
const RCH = { 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const CHR = { T: 10, J: 11, Q: 12, K: 13, A: 14 };
const SUITS = ['s', 'h', 'd', 'c'];
function str(c) { return (RCH[c.r] || String(c.r)) + c.s; }
function parse(s) {
  const m = /^([2-9TJQKA])([shdc])$/.exec(s);
  if (!m) return null;
  return { r: CHR[m[1]] || +m[1], s: m[2] };
}
function freshDeck() {
  const d = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push({ r, s });
  return d;
}
// Fisher-Yates with a cryptographically secure, unbiased RNG.
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
module.exports = { str, parse, freshDeck, shuffle, SUITS };
