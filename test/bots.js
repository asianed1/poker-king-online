'use strict';
// Protocol-level stress test: many concurrent tables (2..8 players) of random bots that
// stand, take, decline, time out, disconnect/reconnect (also mid-turn and mid-selection),
// leave mid-turn / mid-showdown, hand off host, all-but-one leave, 9th player rejected.
// Every message is scanned for card leaks; every showdown is checked against an
// independent reference evaluator; the server checks 52-card conservation on every update.
const WebSocket = require('ws');
const { startServer, getStats, sleep, cardStrings } = require('./helpers');
const { refScore } = require('./ref-evaluator.js');
const { parse } = require('../lib/cards');

const PORT = 3400 + Math.floor(Math.random() * 500);
const URL = 'ws://localhost:' + PORT + '/ws';
const TARGET = +(process.argv[2] || 45); // showdowns per table
const SIZES = [2, 3, 4, 5, 6, 7, 8, 2, 3, 4, 5, 6, 7, 8];
const TURN_MS = 500;
const fails = []; const counts = { showdowns: 0, walkovers: 0, msgs: 0, leakChecks: 0, timeouts: 0, dcs: 0, dcTurn: 0, dcSelect: 0, resumes: 0, resumeCardsKept: 0, leavesTurn: 0, leavesShow: 0, hostLeaves: 0, allButOne: 0, rejected9: 0, takes: 0, stands: 0, discards: 0, cancels: 0, expired: 0, reshuffleMsgs: 0, bySize: {}, byTable: {} };
function fail(m) { if (fails.length < 60) console.log('FAIL:', m); fails.push(m); }
const rnd = () => Math.random();
let botId = 0;

class Bot {
  constructor(table) { this.table = table; this.id = ++botId; this.name = 'Bot' + this.id; this.tab = 'tab' + this.id; this.S = null; this.seat = -1; this.tok = null; this.pub = new Set(); this.hn = -1; this.gone = false; this.turnSeq = []; this.decided = ''; this.lastHandCards = null; this.prev = null; }
  open(first) {
    this.ws = new WebSocket(URL);
    this.ws.on('open', () => this.ws.send(JSON.stringify(first)));
    this.ws.on('message', d => { counts.msgs++; let m; try { m = JSON.parse(d); } catch (e) { return fail('bad json from server'); } this.onMsg(m); });
    this.ws.on('close', () => { });
    this.ws.on('error', () => { });
  }
  send(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
  create() { this.open({ t: 'create', name: this.name, tab: this.tab }); }
  join(code) { this.open({ t: 'join', room: code, name: this.name, tab: this.tab }); }
  onMsg(m) {
    if (this.gone) return;
    if (m.t === 'welcome') { this.tok = m.tok; this.seat = m.seat; this.table.code = m.code; if (m.resumed) counts.resumes++; return; }
    if (m.t === 'err') {
      if (m.code === 'nf' && this.seat < 0) { this.create(); return; }       // table vanished: start a new one
      if (m.code === 'full' && this.seat < 0) { this.gone = true; this.ws.close(); this.table.botGone(this, true); return; }
      return;
    }
    if (m.t === 'chat') { if (m.sys && /deck ran out/.test(m.m)) counts.reshuffleMsgs++; return; }
    if (m.t === 'resume_fail') { this.gone = true; this.ws.close(); this.table.botGone(this); return; }
    if (m.t !== 'st') return;
    this.check(m);
    this.prev = this.S; this.S = m;
    this.act();
  }
  check(m) {
    const me = m.seats[m.you];
    if (!me) return fail('own seat missing');
    if (m.hn !== this.hn) {
      // new hand: button rotation check
      if (this.S && this.S.hn === m.hn - 1 && this.S.btn >= 0 && m.ph === 'deal' && m.seats.every(q => !q || q.k === 0)) {
        let exp = -1; for (let k = 1; k <= 8; k++) { const s = (this.S.btn + k) % 8; if (m.seats[s] && m.seats[s].ih) { exp = s; break; } }
        if (exp !== m.btn) fail('button rotation: prev ' + this.S.btn + ' expected ' + exp + ' got ' + m.btn);
      }
      this.hn = m.hn; this.turnSeq = []; this.decided = '';
    }
    // cards that were dealt face up are public; collected table-wide because a player who
    // joined or reconnected mid-hand legitimately sees face-up cards taken before they arrived
    const T = this.table, pk = m.code + ':' + m.hn;
    if (!T.pub.has(pk)) T.pub.set(pk, new Set());
    this.pub = T.pub.get(pk);
    if (m.offer) this.pub.add(m.offer);
    // leak scan: any card string in this message must be mine, public (seen face-up), or part of the showdown
    const mine = new Set(me.cards || []);
    const scan = Object.assign({}, m); if (m.ph === 'show') delete scan.res;
    for (const c of cardStrings(scan)) { counts.leakChecks++; if (!mine.has(c) && !this.pub.has(c)) fail('LEAK to ' + this.name + ': ' + c + ' ph=' + m.ph); }
    if (m.ph !== 'show' && m.res) fail('result sent before showdown');
    if (m.dl > TURN_MS + 50) fail('deadline too long ' + m.dl);
    if (m.ph === 'draw') {
      for (const q of m.seats) if (q && q.ih && q.k !== 5) fail('in-hand player without 5 cards during draw');
      if (m.turn >= 0 && this.turnSeq[this.turnSeq.length - 1] !== m.turn) this.turnSeq.push(m.turn);
      if (m.ofs > 3) fail('more than 3 offers');
    }
    // host hand-off
    if (this.S && this.S.host !== m.host) {
      const old = this.S.host;
      if (m.seats[old] && this.S.seats[old] && m.seats[old].n === this.S.seats[old].n) fail('host changed while host still seated');
      else { let exp = -1, any = -1; for (let k = 1; k <= 8; k++) { const s = (old + k) % 8; if (s !== old && m.seats[s] && !m.seats[s].b && m.seats[s].on) { exp = s; break; } if (m.seats[s] && !m.seats[s].b && any < 0) any = s; } if (exp < 0) exp = any; if (exp !== m.host) fail('host handoff expected ' + exp + ' got ' + m.host); }
    }
    if (!m.seats[m.host]) fail('host seat empty');
    if (m.seats[m.host] && m.seats[m.host].b) fail('Dealer became host');
    if (m.ph === 'show' && (!this.S || this.S.ph !== 'show' || this.S.hn !== m.hn)) this.onShowdown(m);
  }
  onShowdown(m) {
    const r = m.res; if (!r) return fail('showdown without result');
    const T = this.table;
    if (r.walk) { if (T.seenWalk.has(m.hn + T.code)) return; T.seenWalk.add(m.hn + T.code); counts.walkovers++; return; }
    // turn order: strictly clockwise from left of the button, each player once
    const rel = s => (s - m.btn + 7) % 8;
    for (let i = 1; i < this.turnSeq.length; i++) if (!(rel(this.turnSeq[i - 1]) < rel(this.turnSeq[i]))) fail('turn order not clockwise: btn ' + m.btn + ' seq ' + this.turnSeq);
    const all = [];
    for (const h of r.hands) { if (h.cards.length !== 5) fail('showdown hand without 5 cards'); all.push(...h.cards); }
    if (new Set(all).size !== all.length) fail('duplicate card at showdown');
    if (m.offer) fail('offer still showing at showdown');
    const sc = r.hands.map(h => refScore(h.cards.map(parse)).v), best = Math.max(...sc);
    const refW = r.hands.filter((h, i) => sc[i] === best).map(h => h.s).sort().join();
    if (refW !== r.win.slice().sort().join()) fail('winner mismatch ref=' + refW + ' got=' + r.win);
    const me = m.seats[m.you], mineRes = r.hands.find(h => h.s === m.you && h.id === me.id);
    if (mineRes && JSON.stringify(mineRes.cards) !== JSON.stringify(me.cards)) fail('my showdown cards differ from my hand');
    for (let s = 0; s < 8; s++) if (m.seats[s] && m.seats[s].ih && !r.hands.find(h => h.s === s && h.id === m.seats[s].id)) fail('in-hand seat missing from showdown');
    for (const h of r.hands) if (m.seats[h.s] && m.seats[h.s].id !== h.id && m.seats[h.s].ih) fail('result seat reused by an in-hand player');
    const key = T.code + ':' + m.hn;
    if (!T.seen.has(key)) { T.seen.add(key); T.shows++; counts.showdowns++; counts.byTable[T.size] = (counts.byTable[T.size] || 0) + 1; counts.bySize[r.hands.length] = (counts.bySize[r.hands.length] || 0) + 1; T.onShow(m); }
  }
  act() {
    const S = this.S; if (!S || this.gone) return;
    if ((S.ph === 'wait' || S.ph === 'show') && S.host === S.you && !this.table.done) {
      const n = S.seats.filter(q => q && q.on).length;
      if (n >= 2 && (S.ph === 'wait' || rnd() < 0.5)) setTimeout(() => this.send({ t: 'start' }), 20 + rnd() * 100);
    }
    if (S.ph === 'show' && rnd() < 0.006 && !this.table.done && !this.table.calm) { counts.leavesShow++; return this.leave(); }
    if (S.ph !== 'draw' || S.turn !== S.you) return;
    const key = S.hn + ':' + S.ofs + ':' + S.sub;
    if (this.decided === key) return; this.decided = key;
    const r = this.table.calm ? (rnd() < 0.03 ? 0 : 0.1 + rnd() * 0.9) : rnd(); // calm tables: only timeouts, no drops/leaves
    if (r < 0.04) { counts.timeouts++; return; }                                   // let the timer expire
    if (r < 0.055) { counts.dcs++; counts.dcTurn++; if (S.sub === 'select') counts.dcSelect++; return this.dropAndReturn(); }
    if (r < 0.06) { counts.leavesTurn++; if (S.host === S.you) counts.hostLeaves++; return this.leave(); }
    setTimeout(() => {
      if (this.gone || !this.S || this.S.turn !== this.S.you) return;
      const s = this.S.sub;
      if (rnd() < 0.03) this.send({ t: 'act', a: 'new' });           // duplicate / stale
      this.lastActAt = Date.now();
      if (s === 'ask') { if (rnd() < 0.7) this.send({ t: 'act', a: 'new' }); else { counts.stands++; this.send({ t: 'act', a: 'stand' }); } }
      else if (s === 'take') { if (rnd() < 0.6) this.send({ t: 'act', a: 'sel' }); else { counts.discards++; this.send({ t: 'act', a: 'discard' }); } }
      else if (s === 'select') { if (rnd() < 0.15) { counts.cancels++; this.send({ t: 'act', a: 'cancel' }); } else { counts.takes++; this.send({ t: 'act', a: 'swap', i: Math.floor(rnd() * 5) }); } }
      if (rnd() < 0.05) this.send({ t: 'act', a: 'swap', i: 2 });    // double-submit race
    }, rnd() * 25);
  }
  dropAndReturn() {
    const before = this.S, hand = before.seats[before.you].cards;
    const hn = before.hn, racy = Date.now() - (this.lastActAt || 0) < 200; // an action may still be in flight
    this.ws.close();
    const forever = rnd() < 0.12;
    if (forever) { counts.expired++; this.gone = true; this.table.botGone(this); return; }
    const delay = rnd() < 0.5 ? 50 + rnd() * 400 : 700 + rnd() * 1500;   // before / after the turn grace
    setTimeout(() => {
      if (this.table.finished || this.gone) return;
      this.ws = new WebSocket(URL);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'resume', tok: this.tok, tab: this.tab })));
      this.ws.on('error', () => { });
      this.ws.on('message', d => {
        counts.msgs++; const m = JSON.parse(d);
        if (m.t === 'st' && this.checkResume && !racy) {
          this.checkResume = false;
          if (m.hn === hn && m.seats[m.you].ih) { if (JSON.stringify(m.seats[m.you].cards) !== JSON.stringify(hand)) fail('cards changed across reconnect'); else counts.resumeCardsKept++; }
        }
        this.onMsg(m);
      });
      this.checkResume = true;
    }, delay);
  }
  leave() { this.send({ t: 'leave' }); this.gone = true; setTimeout(() => this.ws.close(), 50); this.table.botGone(this); }
}

class Table {
  constructor(size, calm) { this.size = size; this.calm = calm; this.bots = []; this.code = null; this.shows = 0; this.seen = new Set(); this.seenWalk = new Set(); this.pub = new Map(); this.done = false; this.finished = false; }
  async start() {
    const h = new Bot(this); this.bots.push(h); h.create();
    while (!this.code) await sleep(10);
    for (let i = 1; i < this.size; i++) { const b = new Bot(this); this.bots.push(b); b.join(this.code); await sleep(5); }
  }
  live() { return this.bots.filter(b => !b.gone); }
  botGone(b, rejected) {
    this.bots = this.bots.filter(x => x !== b);
    if (rejected) return;
    if (this.done) return;
    setTimeout(() => { if (this.done) return; if (this.live().length < this.size) { const nb = new Bot(this); this.bots.push(nb); nb.join(this.code); } }, 100 + rnd() * 400);
  }
  onShow(m) {
    if (this.shows >= TARGET) { this.done = true; return; }
    // occasionally: all but one player leave in the middle of the next hand
    if (rnd() < 0.04 && this.size > 2 && !this.calm) {
      this.abo = m.hn + 1;
    }
  }
  tickChaos() {
    const any = this.live().find(b => b.S);
    if (!any || this.done) return;
    const host = this.live().find(b => b.S && b.S.host === b.S.you && b.S.ph === 'wait');
    if (host && Date.now() - (this.lastKick || 0) > 500) { this.lastKick = Date.now(); host.send({ t: 'start' }); }
    if (this.abo && any.S.hn === this.abo && any.S.ph === 'draw') {
      this.abo = 0; counts.allButOne++;
      const ls = this.live(); ls.slice(1).forEach(b => b.leave());
    }
  }
}

(async () => {
  const srv = await startServer({ TURN_SECONDS: String(TURN_MS / 1000), DEAL_MS: '2', RECONNECT_SECONDS: '2.5', DISCONNECT_TURN_GRACE_SECONDS: '0.6', AUTO_STAND_MS: '60', NEXT_HAND_SECONDS: '0.6' }, PORT);
  const t0 = Date.now();
  const tables = SIZES.map((s, i) => new Table(s, i >= 7)); // second set of tables: no leave/disconnect chaos
  for (const t of tables) await t.start();
  // 9th player rejection on an 8-seat table
  await sleep(300);
  const full = tables.find(t => t.size === 8);
  await new Promise(res => {
    const ws = new WebSocket(URL);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room: full.code, name: 'Ninth' })));
    ws.on('message', d => { const m = JSON.parse(d); if (m.t === 'err' && m.code === 'full') { counts.rejected9++; ws.close(); res(); } else if (m.t === 'welcome') { /* a seat had just freed up; fine */ ws.send(JSON.stringify({ t: 'leave' })); ws.close(); res(); } });
    setTimeout(res, 2000);
  });
  const chaos = setInterval(() => tables.forEach(t => t.tickChaos()), 30);
  let last = 0;
  while (tables.some(t => !t.done)) {
    await sleep(1000);
    const tot = tables.reduce((a, t) => a + t.shows, 0);
    if (Date.now() - t0 > +(process.env.BOT_LIMIT_MS || 600000)) {
      fail('timeout: tables stuck ' + tables.filter(t => !t.done).map(t => t.size + ':' + t.shows));
      for (const t of tables.filter(t => !t.done)) {
        console.log('TABLE size', t.size, 'shows', t.shows, 'code', t.code, 'bots', t.bots.length, 'live', t.live().length);
        for (const b of t.bots) console.log('  ', b.name, 'gone', b.gone, 'seat', b.seat, 'ws', b.ws && b.ws.readyState, b.S && JSON.stringify({ ph: b.S.ph, hn: b.S.hn, turn: b.S.turn, sub: b.S.sub, host: b.S.host, nx: b.S.nx, seats: b.S.seats.map(q => q && (q.n + (q.on ? '' : '(off)') + (q.ih ? '*' : ''))) }));
      }
      break;
    }
    if (Math.floor(tot / 100) !== Math.floor(last / 100)) console.log('  showdowns so far: ' + tot);
    last = tot;
  }
  clearInterval(chaos);
  for (const t of tables) { t.done = true; t.finished = true; }
  await sleep(1500);
  for (const t of tables) for (const b of t.bots.slice()) if (!b.gone) b.leave();
  await sleep(4000); // let disconnect seats expire (2.5 s)
  const st = await getStats(PORT);
  if (st.errors) fail('server errors: ' + st.errors);
  if (st.invariant) fail('card conservation failures: ' + st.invariant + ' ' + st.invariantMsgs[0]);
  if (st.rooms !== 0) fail('rooms not cleaned up: ' + st.rooms + ' ' + JSON.stringify(st.roomsDetail));
  if (st.sessions !== 0) fail('sessions not cleaned up: ' + st.sessions);
  const stderr = srv.out.filter(l => l.startsWith('[stderr]'));
  if (stderr.length) fail('server stderr: ' + stderr.join('').slice(0, 500));
  srv.kill();
  console.log('\nbot stress test finished in ' + Math.round((Date.now() - t0) / 1000) + 's');
  console.log(JSON.stringify(counts));
  console.log('server: msgsOut=' + st.msgsOut + ' avgBytes=' + Math.round(st.bytesOut / st.msgsOut) + ' roomsCreated=' + st.roomsCreated + ' badMsgs=' + st.badMsgs);
  console.log(fails.length ? 'BOTS: ' + fails.length + ' FAILURES' : 'BOTS: ALL CHECKS PASSED');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
