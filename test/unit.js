'use strict';
// Unit tests: evaluator, multi-way showdown ranking vs an independent reference evaluator,
// tie splits, explanations, and a direct (no network) Room simulation checking card
// conservation, reshuffles, leaks, turn order, button rotation and host hand-off.
const assert = require('assert');
const E = require('../public/evaluator.js');
const { refScore } = require('./ref-evaluator.js');
const { buildResult } = require('../lib/explain');
const { parse, str, freshDeck, shuffle } = require('../lib/cards');
const { Room } = require('../lib/room');
const fs = require('fs'), path = require('path');

let pass = 0, fail = 0;
function ok(c, msg) { if (c) pass++; else { fail++; if (fail < 40) console.log('FAIL:', msg); } }
const H = s => s.split(' ').map(parse);

// ---- 0. evaluator is an unmodified copy of the single-player one
const spPath = '/workspace/poker-king/evaluator.js';
if (fs.existsSync(spPath)) ok(fs.readFileSync(spPath, 'utf8') === fs.readFileSync(path.join(__dirname, '../public/evaluator.js'), 'utf8'), 'evaluator.js identical to single-player copy');

// ---- 1. evaluator categories & comparisons
const cases = [['As Ks Qs Js Ts', 9], ['9h 8h 7h 6h 5h', 8], ['5c 4c 3c 2c Ac', 8], ['Kd Kh Ks Kc 2d', 7], ['Qd Qh Qs 4c 4d', 6],
['2h 7h 9h Jh Kh', 5], ['Ad 2c 3h 4s 5d', 4], ['Td Jc Qh Ks Ad', 4], ['7d 7c 7h Ks 2d', 3], ['9d 9c 4h 4s Ad', 2], ['Kd Kc 4h 8s Ad', 1], ['Ad Jc 4h 8s 2d', 0], ['Qs Kd Ac 2h 3s', 0]];
for (const [h, c] of cases) ok(E.evaluate(H(h)).cat === c, h + ' -> ' + E.CATS[c] + ' got ' + E.evaluate(H(h)).catName);
const cmp = (a, b) => E.compare(E.evaluate(H(a)), E.evaluate(H(b)));
ok(cmp('6d 5c 4h 3s 2d', '5c 4c 3d 2c Ah') > 0, '6-high straight beats wheel');
ok(cmp('Ad Kc 4h 8s 2d', 'Ah Qc 4d 8c 2c') > 0, 'high card kicker');
ok(cmp('Kd Kc 9h 8s 2d', 'Kh Ks 9c 7s 3d') > 0, 'pair kicker');
ok(cmp('9d 9c 4h 4s Ad', '9h 9s 4c 4d Kd') > 0, 'two pair kicker');
ok(cmp('2h 3h 4h 5h 7h', '2s 3s 4s 5s 7s') === 0, 'suits never break ties');

// ---- 2. random cross-check evaluator vs reference (single hands)
for (let t = 0; t < 30000; t++) {
  const d = shuffle(freshDeck()), a = d.slice(0, 5), b = d.slice(5, 10);
  const c1 = Math.sign(E.compare(E.evaluate(a), E.evaluate(b))), c2 = Math.sign(refScore(a).v - refScore(b).v);
  if (c1 !== c2) ok(false, 'cross-check ' + a.map(str) + ' vs ' + b.map(str));
  else pass++;
  ok(E.evaluate(a).cat === refScore(a).cat, 'category ' + a.map(str));
}

// ---- 3. multi-way showdown ranking vs reference (2..8 players)
let splits = 0;
const names = ['Maria', 'Tom', 'Ali', 'Bo', 'Chen', 'Dee', 'Eva', 'Femi'];
for (let t = 0; t < 40000; t++) {
  const n = 2 + (t % 7), d = shuffle(freshDeck());
  const entries = []; for (let i = 0; i < n; i++) entries.push({ seat: (i * 3 + t) % 8 === i ? i : i, name: names[i], color: '#ffffff', cards: d.slice(i * 5, i * 5 + 5) });
  const r = buildResult(entries);
  const sc = entries.map(e => refScore(e.cards).v), best = Math.max(...sc);
  const refW = entries.filter((e, i) => sc[i] === best).map(e => e.seat).sort();
  const got = r.win.slice().sort();
  ok(JSON.stringify(refW) === JSON.stringify(got), 'winners ' + n + 'p: ref ' + refW + ' got ' + got);
  if (got.length > 1) splits++;
  // rank order consistent with reference
  for (let k = 1; k < r.hands.length; k++) {
    const a = refScore(r.hands[k - 1].cards.map(parse)).v, b = refScore(r.hands[k].cards.map(parse)).v;
    if (!(a >= b)) ok(false, 'rank order'); else pass++;
    if ((a === b) !== (r.hands[k - 1].rank === r.hands[k].rank)) ok(false, 'tie ranks'); else pass++;
  }
  ok(r.hands.length === n, 'all hands listed');
  ok(!/undefined|NaN|null/.test(r.text + r.head), 'no undefined in text: ' + r.text);
  for (const s of r.win) ok(r.text.includes(names[s]) && r.head.includes(names[s]), 'winner named in text');
  for (const h of r.hands) ok(Array.isArray(h.used) && h.used.length >= 1 && h.used.every(i => i >= 0 && i < 5), 'used indices');
}
console.log('random multi-way showdowns: 40000 (' + splits + ' natural splits)');

// ---- 4. constructed ties & explanations
function R(hands) { return buildResult(hands.map((h, i) => ({ seat: i, name: names[i], color: '#fff', cards: H(h) }))); }
let r = R(['2h 3h 4h 5h 7h', '2s 3s 4s 5s 7s', 'Kd Kc 4c 8s Ad']);
ok(r.win.length === 2 && r.head.startsWith('Split!') && /Suits never count/.test(r.text), 'flush split: ' + r.text);
r = R(['Ah Kd 9c 7s 3h', 'As Kc 9d 7c 3d', 'Ac Ks 9h 7h 3c']);
ok(r.win.length === 3 && r.hands.every(h => h.rank === 0), '3-way high card split');
r = R(['2h 7h 9h Jh Kh', '5s 6h 7d 8c 9s', 'Js Jd 4c 4s As']);
ok(r.text === "Maria wins with a Flush (King-high), which beats Tom's Straight (9-high) and Ali's Two Pair (Jacks and 4s). Flush ranks above Straight on the hand-rankings ladder.", 'spec example: ' + r.text);
r = R(['Kh Kd 9s 4c 2d', 'Ks Kc 9c 3d 2c']);
ok(/kickers/.test(r.text) && /Maria's 4 beats Tom's 3/.test(r.text), 'kicker explanation: ' + r.text);
r = R(['5c 4c 3d 2c Ah', '6d 5h 4h 3s 2d']);
ok(r.win[0] === 1 && /Ace counts low/.test(r.text), 'wheel explanation: ' + r.text);
r = R(['As Ks Qs Js Ts', 'Ah Kh Qh Jh Th']);
ok(r.win.length === 2, 'two royal flushes split');
r = R(['Qd Qh 9s 9c 4d', 'Qs Qc 9h 9d 3d', 'Ac Kh 8d 5c 3d']);
ok(r.win.length === 1 && r.win[0] === 0 && /fifth card/.test(r.text), 'two pair kicker: ' + r.text);
r = R(['Qd Qh 9s 9c 4d', 'Qs Qc 9h 9d 4c', 'Qs Qc 8h 8d 4c'.replace('Qs Qc', 'Jd Jc')]);
ok(r.win.length === 2 && r.hands[2].rank === 2, 'split with 3rd player');

// ---- 5. Room simulation (no network): many hands, random actions, leaves, disconnects, joins
function mkHarness() {
  const sent = new Map(); const errors = []; const inv = [];
  const hooks = {
    send(ws, msg) { ws.inbox.push(JSON.parse(JSON.stringify(msg))); },
    onJoin(p, ws) { ws.player = p; }, onLeave() { }, detach(ws) { ws.player = null; ws.closed = true; },
    onEmpty() { }, error(e) { errors.push(e); }, invariant(m) { inv.push(m); }
  };
  return { hooks, sent, errors, inv };
}
const cfg = { turnMs: 1e9, reconnectMs: 1e9, dcGraceMs: 1e9, autoStandMs: 1e9, nextMs: 1e9, dealMs: 1e9, chatMax: 5, chatWindowMs: 5000 };
const pick = a => a[Math.floor(Math.random() * a.length)];
let handsSim = 0, reshuffles = 0, leaksChecked = 0;
function checkViews(room) {
  // every player's most recent state must not reveal any other player's hidden cards
  for (const p of room.players()) {
    if (!p.connected || !p.ws.inbox.length) continue;
    const st = [...p.ws.inbox].reverse().find(m => m.t === 'st'); if (!st) continue;
    st.seats.forEach((o, s) => {
      if (!o || s === p.seat) return;
      const q = room.seats[s];
      if (o.cards) o.cards.forEach((c, i) => { leaksChecked++; if (c !== null && !(q && q.pub.has(i) && str(q.hand[i]) === c)) ok(false, 'LEAK: seat ' + s + ' card ' + c + ' shown to seat ' + p.seat); });
    });
    if (st.ph !== 'show') ok(st.res === null, 'res hidden before showdown');
    const mine = st.seats[p.seat];
    ok(JSON.stringify(mine.cards) === JSON.stringify(p.hand.map(str)), 'own cards correct');
  }
}
for (let game = 0; game < 300; game++) {
  const h = mkHarness();
  const room = new Room('TEST' + game, cfg, h.hooks);
  const mkWs = () => ({ inbox: [], player: null });
  const nPlayers = 2 + (game % 7);
  for (let i = 0; i < nPlayers; i++) room.join(names[i], mkWs(), 't' + i);
  let prevButton = -1, hostSeat = room.host;
  for (let hand = 0; hand < 12 && !room.dead; hand++) {
    for (let g = 0; g < 4 && room.players().filter(p => p.connected).length < 2; g++) {
      if (room.count() < 8) room.join(pick(names) + 'x', mkWs(), 'tx');
      else { const q = room.players().find(x => !x.connected); room.reconnect(q, mkWs(), q.tab); }
    }
    const before = room.players().filter(p => p.connected).map(p => p.seat);
    if (!room.startHand()) { ok(false, 'startHand failed with ' + before.length + ' connected'); break; }
    // button rotated to next connected seat clockwise
    if (prevButton >= 0) {
      let exp = -1; for (let k = 1; k <= 8; k++) { const s = (prevButton + k) % 8; if (before.includes(s)) { exp = s; break; } }
      ok(room.button === exp, 'button rotation: prev ' + prevButton + ' exp ' + exp + ' got ' + room.button);
    }
    prevButton = room.button;
    // order: clockwise starting left of button, button last
    ok(room.order[room.order.length - 1].seat === room.button, 'button acts last');
    for (let k = 1; k < room.order.length; k++) { const a = (room.order[k - 1].seat - room.button + 7) % 8, b = (room.order[k].seat - room.button + 7) % 8; ok(a < b, 'clockwise order'); }
    handsSim++;
    let guard = 0;
    while (room.phase === 'deal' && guard++ < 100) { room.dealStep(); checkViews(room); }
    if (room.phase === 'draw') for (const p of room.order) if (room.alive(p)) ok(p.hand.length === 5, 'everyone has 5 cards');
    const turnSeen = [];
    guard = 0;
    while (room.phase === 'draw' && guard++ < 200) {
      const tp = room.turnPlayer();
      if (!turnSeen.length || turnSeen[turnSeen.length - 1] !== tp.seat) turnSeen.push(tp.seat);
      const roll = Math.random();
      // occasional chaos
      if (roll < 0.02) { room.leave(pick(room.players()), 'left'); checkViews(room); continue; }
      if (roll < 0.04) { const q = pick(room.players()); if (q.connected) room.disconnect(q, q.ws); checkViews(room); continue; }
      if (roll < 0.05) { const q = room.players().find(x => !x.connected); if (q) room.reconnect(q, mkWs(), q.tab); continue; }
      if (roll < 0.06) { room.timeout(); continue; }
      if (roll < 0.07 && room.count() < 8) { room.join('Late' + game, mkWs(), 'late'); continue; }
      if (roll < 0.08) { const q = pick(room.players()); room.act(q, pick(['new', 'stand', 'discard', 'sel', 'cancel', 'swap', 'xx']), pick([0, 4, 5, -1, 'a', undefined])); continue; } // random (often out-of-turn) junk
      const p = tp;
      if (room.sub === 'ask') room.act(p, Math.random() < 0.75 ? 'new' : 'stand');
      else if (room.sub === 'take') room.act(p, pick(['sel', 'discard', 'sel']));
      else if (room.sub === 'select') { const r2 = Math.random(); if (r2 < 0.15) room.act(p, 'cancel'); else room.act(p, 'swap', Math.floor(Math.random() * 5)); }
      ok(p.offers <= 3, 'max 3 offers');
      checkViews(room);
    }
    ok(room.phase === 'show' || room.dead, 'hand ended in showdown, phase=' + room.phase);
    if (room.dead) break;
    // turn order seen must be a subsequence of the order (each player at most once)
    ok(new Set(turnSeen).size === turnSeen.length, 'each player gets one turn: ' + turnSeen);
    if (room.result && !room.result.walk) {
      const live = room.order.filter(q => room.alive(q));
      const sc = live.map(q => refScore(q.hand).v), best = Math.max(...sc);
      const refW = live.filter((q, i) => sc[i] === best).map(q => q.seat).sort().join();
      ok(refW === room.result.win.slice().sort().join(), 'room winner matches reference');
      for (const hd of room.result.hands) ok(hd.cards.length === 5, '5 cards revealed');
    }
    ok(room.check(), 'conservation at showdown');
    // host must be an occupied seat
    ok(room.seats[room.host], 'host seat occupied');
    // occasionally the host leaves at showdown -> next seated clockwise becomes host
    if (Math.random() < 0.2 && room.count() > 1) {
      const old = room.host; let exp = -1;
      let any = -1; for (let k = 1; k < 8; k++) { const s = (old + k) % 8; if (room.seats[s] && room.seats[s].connected) { exp = s; break; } if (room.seats[s] && any < 0) any = s; } if (exp < 0) exp = any;
      room.leave(room.seats[old], 'left');
      ok(room.host === exp, 'host handoff clockwise ' + old + ' exp ' + exp + ' got ' + room.host + ' ' + room.seats.map(q => q ? (q.connected ? 'on' : 'off') : '-').join(','));
    }
    checkViews(room);
    hostSeat = room.host;
  }
  if (h.inv.length) ok(false, 'invariant: ' + h.inv[0]);
  if (h.errors.length) ok(false, 'errors: ' + h.errors[0]);
  room.destroy();
  ok(room.dead && room.timer === null && room.nextTimer === null, 'room destroyed cleanly');
}
console.log('simulated hands:', handsSim, 'view card checks:', leaksChecked);

// ---- 6. reshuffle conservation: force deck exhaustion with 8 players taking every offer
{
  const h = mkHarness();
  const room = new Room('RESH', cfg, h.hooks);
  for (let i = 0; i < 8; i++) room.join(names[i], { inbox: [] }, 't');
  let reshuf = 0;
  for (let hand = 0; hand < 30; hand++) {
    room.startHand();
    while (room.phase === 'deal') room.dealStep();
    ok(room.deck.length === 12, '12 cards left after dealing 8 players');
    while (room.phase === 'draw') {
      const p = room.turnPlayer(), before = room.deck.length;
      if (room.sub === 'ask') room.act(p, 'new');
      else if (room.sub === 'take') room.act(p, 'sel');
      else room.act(p, 'swap', hand % 5);
      if (before === 0 && room.sub === 'take') reshuf++;
      ok(room.check(), 'conservation during reshuffles');
    }
    ok(room.phase === 'show', 'showdown after reshuffles');
  }
  ok(reshuf >= 30, 'deck ran out and was reshuffled every hand (' + reshuf + ')');
  ok(room.chat.some(c => c.sys && /deck ran out/.test(c.m)), 'reshuffle announced in log');
  ok(!h.inv.length && !h.errors.length, 'no invariant failures during reshuffles');
  room.destroy();
}

// ---- 7. chat rules
{
  const h = mkHarness(); const room = new Room('CHAT', cfg, h.hooks);
  const w1 = { inbox: [] }, w2 = { inbox: [] };
  const p1 = room.join('Maria', w1, 'a'); room.join('Maria', w2, 'b');
  ok(room.seats[1].name === 'Maria 2', 'duplicate names get a suffix');
  for (let i = 0; i < 8; i++) room.chatMsg(p1, 'spam ' + i);
  const got = w2.inbox.filter(m => m.t === 'chat' && !m.sys).length;
  ok(got === 5, 'rate limit 5 msgs / 5 s (got ' + got + ')');
  ok(w1.inbox.some(m => m.t === 'err' && m.code === 'slow'), 'spammer warned');
  p1.chatTimes = [];
  room.chatMsg(p1, 'x'.repeat(500)); const last = w2.inbox.filter(m => m.t === 'chat').pop();
  ok(last.m.length === 200, 'chat truncated to 200');
  room.chatMsg(p1, { evil: 1 }); room.chatMsg(p1, '   '); room.chatMsg(p1, '\u0000\u202e');
  ok(w2.inbox.filter(m => m.t === 'chat').pop() === last, 'non-string/blank/control-only messages ignored');
  for (let i = 0; i < 150; i++) { p1.chatTimes = []; room.chatMsg(p1, 'm' + i); }
  ok(room.chat.length === 100, 'only last 100 messages kept');
  room.destroy();
}

console.log('unit tests: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
