'use strict';
// Solo mode (play vs the computer Dealer) over the real server with protocol bots.
// Many concurrent tables, each with one human bot playing random decisions (takes, discards,
// cancels, timeouts, disconnects during its own turn). Every so often a second human joins
// (usually mid-hand): the Dealer must finish the current hand, step aside at the next one,
// and come back (scoreboard kept) when the table is down to one human again.
// Checks every message: Dealer cards never leak before showdown, Dealer never host / never
// has a turn / always stands, alternate dealing, 52-card conservation, winner vs reference.
const WebSocket = require('ws');
const { startServer, getStats, sleep, cardStrings } = require('./helpers');
const { refScore } = require('./ref-evaluator.js');
const { parse } = require('../lib/cards');
const PORT = 5200 + Math.floor(Math.random() * 400), URL = 'ws://localhost:' + PORT + '/ws';
const TABLES = 12, TARGET = +(process.argv[2] || 12);   // solo showdowns per table
const fails = []; const c = { solo: 0, duo: 0, walk: 0, dealerWins: 0, splits: 0, humanWins: 0, joinsMidHand: 0, dealerLeft: 0, dealerBack: 0, dcTurn: 0, timeouts: 0, takes: 0, leaks: 0, msgs: 0, scoreKept: 0 };
function fail(m) { if (fails.length < 40) console.log('FAIL:', m); fails.push(m); }
const rnd = Math.random;
let stopping = false;
const offers = new Map(); // code:hn -> Set of public cards

class H {
  constructor(t, name) { this.t = t; this.name = name; this.S = null; this.gone = false; this.tab = 'tab' + name; }
  open(first) {
    this.ws = new WebSocket(URL);
    this.ws.on('open', () => this.ws.send(JSON.stringify(first)));
    this.ws.on('message', d => { c.msgs++; this.on(JSON.parse(d)); });
    this.ws.on('error', () => { });
  }
  send(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
  on(m) {
    if (this.gone) return;
    if (m.t === 'welcome') { this.tok = m.tok; this.t.code = m.code; return; }
    if (m.t !== 'st') { if (m.t !== 'chat' && m.t !== 'hist' && m.t !== 'err' && m.t !== 'left' && cardStrings(m).length) fail('cards in ' + m.t); return; }
    this.check(m); this.S = m; this.act(m);
  }
  check(m) {
    const key = m.code + ':' + m.hn, ds = [];
    m.seats.forEach((q, s) => { if (q && q.b) ds.push(s); });
    const humans = m.seats.filter(q => q && !q.b).length;
    if (ds.length > 1) fail('two dealers');
    const d = ds.length ? ds[0] : -1, D = d >= 0 ? m.seats[d] : null;
    if (m.seats[m.host] && m.seats[m.host].b) fail('Dealer became host');
    if (d >= 0 && m.turn === d) fail('Dealer got a turn');
    if (D && D.n !== 'Dealer') fail('Dealer name');
    if (m.offer || (m.last && m.last.c)) { if (!offers.has(key)) offers.set(key, new Set()); if (m.offer) offers.get(key).add(m.offer); if (m.last && m.last.c) offers.get(key).add(m.last.c); }
    const ihH = m.seats.filter(q => q && !q.b && q.ih).length;
    if (m.ph !== 'wait' && D && D.ih && ihH !== 1) fail('Dealer dealt in with ' + ihH + ' humans');
    if ((m.ph === 'deal' || m.ph === 'draw') && !(D && D.ih) && ihH === 1 && m.seats.filter(q => q && q.ih).length < 2) fail('hand with a single player');
    if (m.ph === 'deal' || m.ph === 'draw' || m.ph === 'show') {
      let tot = m.deck + m.disc + (m.offer ? 1 : 0); m.seats.forEach(q => { if (q && q.ih) tot += q.k; });
      if (tot !== 52) fail('conservation ' + tot);
    }
    if (m.ph === 'deal') { const ks = m.seats.filter(q => q && q.ih).map(q => q.k); if (Math.max(...ks) - Math.min(...ks) > 1) fail('not dealt alternately ' + ks); }
    if (m.ph === 'draw' && D && D.ih && !D.d) fail('Dealer did not stand');
    if (m.ph !== 'show') {
      if (m.res) fail('res before showdown');
      if (D && D.cards) { c.leaks++; fail('LEAK: Dealer cards before showdown ' + D.cards); }
      m.seats.forEach((q, s) => { if (q && s !== m.you && q.cards) q.cards.forEach(x => { if (x && !(offers.get(key) || new Set()).has(x)) { c.leaks++; fail('LEAK seat ' + s + ' ' + x); } }); });
    } else if (m.res && this.t.lastShow !== key) {
      this.t.lastShow = key;
      const R = m.res;
      if (R.walk) { c.walk++; return; }
      const sc = R.hands.map(h => refScore(h.cards.map(parse)).v), best = Math.max(...sc);
      const ref = R.hands.filter((h, i) => sc[i] === best).map(h => h.s).sort().join();
      if (ref !== R.win.slice().sort().join()) fail('winner mismatch ' + JSON.stringify(R));
      const all = R.hands.flatMap(h => h.cards); if (new Set(all).size !== all.length) fail('dup cards at showdown');
      const dh = R.hands.find(h => m.seats[h.s] && m.seats[h.s].b && h.id === m.seats[h.s].id);
      if (dh) {
        c.solo++;
        if (R.hands.length !== 2) fail('solo showdown with ' + R.hands.length + ' hands');
        if (!/[Tt]he Dealer/.test(R.text)) fail('explanation does not name the Dealer: ' + R.text);
        if (R.win.length > 1) { c.splits++; if (!/Split!/.test(R.head)) fail('split head'); }
        else if (R.win[0] === dh.s) { c.dealerWins++; if (R.head !== 'The Dealer wins!') fail('dealer head ' + R.head); }
        else c.humanWins++;
        if (/\bDealer's\b/.test(R.text.replace(/the Dealer's/gi, ''))) fail('possessive without "the": ' + R.text);
      } else c.duo++;
    }
  }
  act(m) {
    const t = this.t;
    if (m.host === m.you && (m.ph === 'wait' || (m.ph === 'show' && rnd() < 0.3)) && !t.done) {
      const solo = m.seats.filter(q => q && !q.b).length === 1;
      if (m.ph === 'wait' && solo && t.hadDuo && !t.backPending) t.backPending = 1;
      setTimeout(() => this.send({ t: 'start' }), 5);
    }
    if (m.ph !== 'draw' || m.turn !== m.you) return;
    const sig = m.hn + ':' + m.ofs + ':' + m.sub;
    if (this.sig === sig) return; this.sig = sig;
    const r = rnd();
    if (r < 0.05) { c.timeouts++; return; }
    if (r < 0.08 && !this.dcing) {  // drop during own turn, come back later (grace is 0.6 s)
      c.dcTurn++; this.dcing = 1; this.ws.removeAllListeners('message'); this.ws.close();
      setTimeout(() => { this.dcing = 0; this.sig = null; if (this.gone || stopping) return; this.open({ t: 'resume', tok: this.tok, tab: this.tab }); }, 200 + rnd() * 1200);
      return;
    }
    const delay = 2 + rnd() * 20;
    setTimeout(() => {
      if (m.sub === 'ask') this.send({ t: 'act', a: rnd() < 0.7 ? 'new' : 'stand' });
      else if (rnd() < 0.35) { c.rejects = (c.rejects || 0) + 1; this.send({ t: 'act', a: 'reject' }); }
      else { c.takes++; this.send({ t: 'act', a: 'swap', i: Math.floor(rnd() * 5) }); }
    }, delay);
  }
}
class Table {
  constructor(i) { this.i = i; this.solo0 = 0; }
  start() { this.host = new H(this, 'Solo' + this.i); this.host.open({ t: 'create', name: 'Solo' + this.i }); }
  tick() {
    const S = this.host.S; if (!S || this.done) return;
    const ds = S.seats.findIndex(q => q && q.b);
    // remember the Dealer's score so we can check it is kept when it comes back
    if (ds >= 0) { if (this.dealerLeftW != null && S.seats[ds].w < this.dealerLeftW) fail('Dealer scoreboard lost'); else if (this.dealerLeftW != null) { c.scoreKept++; c.dealerBack++; this.dealerLeftW = null; } this.dw = S.seats[ds].w; }
    if (!this.guest && S.hn >= 3 && rnd() < 0.08 && (S.ph === 'draw' || S.ph === 'deal' || rnd() < 0.3)) {
      this.guest = new H(this, 'Guest' + this.i + '_' + (this.gn = (this.gn || 0) + 1)); this.guestHn = S.hn; this.hadDuo = 1;
      if (S.ph === 'draw' || S.ph === 'deal') c.joinsMidHand++;
      this.guest.open({ t: 'join', room: this.code, name: this.guest.name });
    }
    if (this.guest && !this.guest.gone && this.guest.S) {
      const G = this.guest.S, gds = G.seats.findIndex(q => q && q.b);
      if (G.hn === this.guestHn && (G.ph === 'draw' || G.ph === 'deal') && gds < 0 && this.gWasDealer === G.hn) fail('Dealer left mid-hand');
      if (gds >= 0 && (G.ph === 'draw' || G.ph === 'deal')) this.gWasDealer = G.hn;
      if (G.hn > this.guestHn && G.ph !== 'wait' && gds >= 0 && G.seats[gds].ih && G.seats.filter(q => q && !q.b && q.ih).length >= 2) fail('Dealer still dealt in with 2 humans');
      if (G.hn > this.guestHn && gds < 0 && !this.countedLeave) { this.countedLeave = 1; c.dealerLeft++; this.dealerLeftW = this.dw; }
      if (G.hn >= this.guestHn + 2 && rnd() < 0.3) { const g = this.guest; g.gone = true; g.send({ t: "leave" }); setTimeout(() => g.ws.close(), 50); this.guestOut = this.guest; this.guest = null; this.countedLeave = 0; }
    }
    if (c.solo >= TABLES * TARGET && this.host.S.ph === 'show') this.done = true;
  }
}
(async () => {
  const srv = await startServer({ TURN_SECONDS: '0.5', DEAL_MS: '2', RECONNECT_SECONDS: '5', DISCONNECT_TURN_GRACE_SECONDS: '0.6', AUTO_STAND_MS: '60', NEXT_HAND_SECONDS: '0.4' }, PORT);
  const ts = []; for (let i = 0; i < TABLES; i++) { const t = new Table(i); t.start(); ts.push(t); }
  const t0 = Date.now(); let lastLog = 0;
  while (Date.now() - t0 < 300000) {
    ts.forEach(t => t.tick());
    if (c.solo - lastLog >= 50) { lastLog = c.solo; console.log('  solo showdowns so far:', c.solo); }
    if (ts.every(t => t.done)) break;
    await sleep(20);
  }
  if (c.solo < TABLES * TARGET) fail('only ' + c.solo + ' solo showdowns');
  if (!c.dealerLeft || !c.dealerBack || !c.joinsMidHand) fail('transitions not exercised ' + JSON.stringify(c));
  // everyone leaves -> rooms gone (Dealer alone never keeps a room alive)
  stopping = true;
  for (const t of ts) for (const h of [t.host, t.guest]) if (h) { h.gone = true; h.send({ t: 'leave' }); }
  await sleep(500);
  let st0 = await getStats(PORT);
  if (st0.rooms) { console.log('  waiting for ' + st0.rooms + ' rooms with offline players to expire (5 s)…'); await sleep(5600); }
  const st = await getStats(PORT);
  if (st.errors || st.invariant) fail('server errors ' + st.errors + ' invariant ' + st.invariant + ' ' + JSON.stringify(st.invariantMsgs));
  if (st.rooms !== 0) fail('rooms left: ' + JSON.stringify(st.roomsDetail));
  if (st.sessions !== 0) fail('sessions left: ' + st.sessions);
  const errs = srv.out.filter(l => l.startsWith('[stderr]')); if (errs.length) fail('stderr ' + errs.join('').slice(0, 300));
  srv.kill();
  console.log(JSON.stringify(c));
  console.log(fails.length ? 'SOLO: ' + fails.length + ' FAILURES' : 'SOLO: ALL CHECKS PASSED');
  process.exit(fails.length ? 1 : 0);
})();
