'use strict';
// Malicious / edge-case client tests: out-of-turn, duplicate, malformed, oversized, binary and
// flood messages; stale timers; races; seat-limit race; path traversal; room/memory cleanup.
const WebSocket = require('ws');
const http = require('http');
const { startServer, getStats, sleep, cardStrings } = require('./helpers');
const PORT = 3900 + Math.floor(Math.random() * 90);
const URL = 'ws://localhost:' + PORT + '/ws';
const TURN = 400;
let pass = 0, failN = 0;
function ok(c, m) { if (c) pass++; else { failN++; console.log('FAIL:', m); } }

class C {
  constructor(name) { this.name = name; this.msgs = []; this.S = null; this.closed = false; this.closeCode = 0; this.waiters = []; }
  open() {
    return new Promise(res => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', res);
      this.ws.on('message', d => { const m = JSON.parse(d); this.msgs.push(m); if (m.t === 'st') this.S = m; if (m.t === 'welcome') { this.tok = m.tok; this.code = m.code; this.seat = m.seat; } this.waiters = this.waiters.filter(w => !w(m)); });
      this.ws.on('close', c => { this.closed = true; this.closeCode = c; });
      this.ws.on('error', () => { });
    });
  }
  send(m) { this.ws.send(typeof m === 'string' || Buffer.isBuffer(m) ? m : JSON.stringify(m)); }
  wait(pred, ms = 3000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(this.name + ' wait timeout')), ms);
      const w = m => { if (pred(m)) { clearTimeout(t); res(m); return true; } return false; };
      this.waiters.push(w);
    });
  }
  waitState(pred, ms) { if (this.S && pred(this.S)) return Promise.resolve(this.S); return this.wait(m => m.t === 'st' && pred(m), ms); }
}
async function table(n) {
  const cs = []; const h = new C('P0'); await h.open(); h.send({ t: 'create', name: 'P0' }); await h.wait(m => m.t === 'welcome'); cs.push(h);
  for (let i = 1; i < n; i++) { const c = new C('P' + i); await c.open(); c.send({ t: 'join', room: h.code.toLowerCase(), name: 'P' + i }); await c.wait(m => m.t === 'welcome'); cs.push(c); }
  return cs;
}
const bySeat = (cs, s) => cs.find(c => c.seat === s);
function get(path) { return new Promise(res => http.get({ host: 'localhost', port: PORT, path }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ code: r.statusCode, body: b })); })); }

(async () => {
  const srv = await startServer({ TURN_SECONDS: String(TURN / 1000), DEAL_MS: '1', RECONNECT_SECONDS: '1', DISCONNECT_TURN_GRACE_SECONDS: '0.3', AUTO_STAND_MS: '50', NEXT_HAND_SECONDS: '30' }, PORT);

  // ---- 1. messages before joining are ignored; bad joins rejected politely
  {
    const c = new C('x'); await c.open();
    c.send({ t: 'act', a: 'new' }); c.send({ t: 'chat', m: 'hi' }); c.send({ t: 'start' }); c.send({ t: 'leave' });
    c.send({ t: 'join', room: 'ZZZZZ', name: 'A' }); let m = await c.wait(m => m.t === 'err'); ok(m.code === 'nf', 'unknown room -> nf');
    c.send({ t: 'join', room: { $ne: 1 }, name: 'A' }); m = await c.wait(m => m.t === 'err'); ok(m.code === 'nf', 'object room code -> nf');
    c.send({ t: 'create', name: '' }); m = await c.wait(m => m.t === 'err'); ok(m.code === 'name', 'empty name rejected');
    c.send({ t: 'create', name: '\u0000\u0007\u202e ' }); m = await c.wait(m => m.t === 'err'); ok(m.code === 'name', 'control-only name rejected');
    c.send({ t: 'create', name: ['a'] }); m = await c.wait(m => m.t === 'err'); ok(m.code === 'name', 'array name rejected');
    c.send({ t: 'resume', tok: 'nope' }); m = await c.wait(m => m.t === 'resume_fail'); ok(true, 'bad token -> resume_fail');
    c.send({ t: 'resume', tok: { a: 1 } }); m = await c.wait(m => m.t === 'resume_fail'); ok(true, 'object token -> resume_fail');
    c.send({ t: 'resume', tok: 'x'.repeat(1000) }); m = await c.wait(m => m.t === 'resume_fail'); ok(true, 'long token -> resume_fail');
    c.send({ t: 'create', name: '<img src=x onerror=alert(1)>LongLongLongName' }); m = await c.wait(m => m.t === 'welcome'); ok(m.name.length <= 16, 'name truncated to 16: ' + m.name);
    c.send({ t: 'create', name: 'Again' }); c.send({ t: 'join', room: m.code, name: 'Again' }); await sleep(100);
    ok(c.msgs.filter(x => x.t === 'welcome').length === 1, 'cannot create/join twice on one socket');
    c.ws.close();
  }

  // ---- 2. malformed / junk / binary / prototype pollution
  const [a, b, d] = await table(3);
  const st0 = await getStats(PORT);
  const junk = ['not json', '[]', 'null', '42', '"str"', '{}', '{"t":5}', '{"t":"act"}', '{"t":"act","a":{}}', '{"t":"act","a":"swap","i":"2"}',
    '{"t":"act","a":"swap","i":99}', '{"t":"act","a":"swap","i":-1}', '{"t":"act","a":"swap","i":2.5}', '{"t":"act","a":"swap","i":null}',
    '{"__proto__":{"polluted":1},"t":"chat","m":"x"}', '{"constructor":{"prototype":{"polluted":1}},"t":"start"}', '{"t":"chat","m":123}', '{"t":"chat","m":{"toString":1}}',
    '{"t":"nonexistent"}', '{"t":"toString"}', '{"t":"__proto__"}', '{"t":"hasOwnProperty"}'];
  for (const j of junk) a.send(j);
  a.send(Buffer.from([1, 2, 3, 4]));
  await sleep(200);
  ok(!a.closed, 'junk does not kill the connection');
  ok(({}).polluted === undefined, 'no prototype pollution (client side)');
  const st1 = await getStats(PORT);
  ok(st1.errors === 0, 'no server exceptions from junk (' + st1.errors + ')');
  ok(st1.badMsgs > st0.badMsgs, 'bad messages counted');

  // ---- 3. non-host start; out-of-turn actions; duplicates
  b.send({ t: 'start' }); let m = await b.wait(m => m.t === 'err'); ok(m.code === 'host', 'non-host cannot start');
  a.send({ t: 'start' }); a.send({ t: 'start' }); a.send({ t: 'start' });
  await a.waitState(s => s.ph === 'draw');
  ok(a.S.hn === 1, 'triple start -> exactly one hand (hn=' + a.S.hn + ')');
  const cs = [a, b, d];
  let turn = a.S.turn, tp = bySeat(cs, turn), others = cs.filter(c => c !== tp);
  const before = JSON.stringify(a.S.seats.map(s => s && s.k)) + a.S.turn + a.S.sub;
  for (const o of others) { for (const act of ['new', 'stand', 'reject', 'discard', 'sel', 'cancel', 'swap']) o.send({ t: 'act', a: act, i: 1 }); }
  m = await others[0].wait(m => m.t === 'err' && m.code === 'turn'); ok(true, 'out-of-turn rejected with message');
  await sleep(100);
  ok(a.S.turn === turn && a.S.sub === 'ask' && a.S.ofs === 0, 'out-of-turn actions changed nothing');
  tp.send({ t: 'act', a: 'new' }); tp.send({ t: 'act', a: 'new' }); tp.send({ t: 'act', a: 'new' });
  await tp.waitState(s => s.sub === 'select'); await sleep(80);
  ok(tp.S.ofs === 1 && tp.S.sub === 'select' && tp.S.offer, 'Y goes straight to selection; duplicate "new" -> one offer only (ofs=' + tp.S.ofs + ')');
  { // the retired take/decline/cancel sequence is ignored cleanly
    const n0 = tp.msgs.length, h0 = JSON.stringify(tp.S.seats[tp.seat].cards), o0 = tp.S.offer;
    for (const a of ['sel', 'cancel', 'discard', 'take', 'sel']) tp.send({ t: 'act', a, i: 0 });
    tp.send({ t: 'act', a: 'swap', i: 9 }); tp.send({ t: 'act', a: 'swap', i: '2' }); tp.send({ t: 'act', a: 'REJECT' }); tp.send({ t: 'act', a: ['reject'] });
    await sleep(80);
    ok(tp.S.sub === 'select' && tp.S.offer === o0 && JSON.stringify(tp.S.seats[tp.seat].cards) === h0 && !tp.closed, 'old take/decline/cancel actions and bad swaps ignored');
    ok(tp.msgs.slice(n0).every(m => m.t !== 'err' || m.code !== 'turn'), 'no spurious errors');
  }
  const handBefore = tp.S.seats[tp.seat].cards.slice(), offer = tp.S.offer;
  tp.send({ t: 'act', a: 'swap', i: 3 }); tp.send({ t: 'act', a: 'swap', i: 4 }); tp.send({ t: 'act', a: 'reject' });
  await tp.waitState(s => s.sub === 'ask' && s.ofs === 1); await sleep(80);
  const handAfter = tp.S.seats[tp.seat].cards;
  ok(handAfter[3] === offer && handAfter[4] === handBefore[4] && tp.S.sub === 'ask', 'double swap -> only first applied');
  // others see the taken card face up at position 3, nothing else
  const ov = others[0].S.seats[tp.seat].cards;
  ok(ov && ov[3] === offer && ov.filter(Boolean).length === 1, 'taken card public, others hidden');
  { // reject: the new card goes to the discards, hand unchanged; a double reject / late swap is ignored
    const h1 = JSON.stringify(tp.S.seats[tp.seat].cards), d1 = tp.S.disc;
    tp.send({ t: 'act', a: 'new' }); await tp.waitState(s => s.sub === 'select' && s.ofs === 2);
    tp.send({ t: 'act', a: 'reject' }); tp.send({ t: 'act', a: 'reject' }); tp.send({ t: 'act', a: 'swap', i: 0 });
    await tp.waitState(s => s.sub === 'ask' && s.ofs === 2); await sleep(80);
    ok(JSON.stringify(tp.S.seats[tp.seat].cards) === h1 && tp.S.disc === d1 + 1 && tp.S.last.a === 'reject' && tp.S.ofs === 2, 'reject counted, card discarded, extras ignored');
    // third offer: let the selection time out -> card rejected, turn ends
    tp.send({ t: 'act', a: 'new' }); await tp.waitState(s => s.sub === 'select' && s.ofs === 3);
    const seat = tp.seat;
    const after = await tp.wait(m => m.t === 'st' && (m.turn !== seat || m.ph !== 'draw'), TURN + 1500);
    ok(after.last && after.last.a === 'treject' && after.last.s === seat && JSON.stringify(after.seats[seat].cards) === h1, 'selection timeout rejects the card and ends the turn');
  }

  // ---- 4. stale timers: act just before the deadline, then make sure the NEXT player's turn is not cut short
  let staleOk = 0, staleBad = 0;
  for (let round = 0; round < 12; round++) {
    await a.waitState(s => s.ph === 'draw' || s.ph === 'show', 5000);
    if (a.S.ph === 'show') { a.send({ t: 'start' }); await a.waitState(s => s.ph === 'draw' && s.sub === 'ask', 5000); }
    const s0 = a.S, cur = bySeat(cs, s0.turn);
    if (s0.sub !== 'ask') { await sleep(TURN + 50); continue; }
    const t0 = Date.now(), dl = s0.dl;
    await sleep(Math.max(0, dl - 15 - Math.random() * 25));     // act right before expiry
    cur.send({ t: 'act', a: 'stand' });
    const nx = await a.wait(x => x.t === 'st' && (x.turn !== s0.turn || x.ph !== 'draw'), 3000);
    if (nx.ph !== 'draw') continue;
    const nt = nx.turn, tStart = Date.now();
    // next player does nothing: their turn must last ~TURN ms, not be ended by the old timer
    const end = await a.wait(x => x.t === 'st' && (x.turn !== nt || x.ph !== 'draw'), 3000);
    const dur = Date.now() - tStart;
    if (dur >= TURN - 60) staleOk++; else { staleBad++; console.log('  next turn cut short:', dur, 'ms'); }
  }
  ok(staleBad === 0 && staleOk >= 5, 'no stale timer cut the next turn short (' + staleOk + ' checked)');
  let st2 = await getStats(PORT); ok(st2.errors === 0 && st2.invariant === 0, 'no errors/invariant failures after timer races');

  // ---- 5. disconnect exactly around the grace boundary & reconnect races
  for (let round = 0; round < 6; round++) {
    await a.waitState(s => s.ph === 'draw' || s.ph === 'show', 5000);
    if (a.S.ph === 'show') { a.send({ t: 'start' }); await a.waitState(s => s.ph === 'draw', 5000); }
    const cur = bySeat(cs, a.S.turn); if (!cur || cur === a) { await sleep(TURN + 50); continue; }
    const tok = cur.tok, cards = cur.S.seats[cur.seat].cards.slice(), hn = cur.S.hn;
    cur.ws.close(); await sleep(250 + Math.random() * 100);           // grace is 300 ms
    const nc = new C(cur.name); await nc.open(); nc.send({ t: 'resume', tok, tab: 't' });
    const w = await nc.wait(x => x.t === 'welcome' || x.t === 'resume_fail');
    ok(w.t === 'welcome', 'resume within 1 s works');
    const s1 = await nc.waitState(() => true);
    if (s1.hn === hn) ok(JSON.stringify(s1.seats[s1.you].cards) === JSON.stringify(cards), 'cards kept across reconnect');
    cs[cs.indexOf(cur)] = nc; nc.seat = s1.you;
  }
  // the resumed seat must not be duplicated and the old socket must be detached
  await sleep(100);
  ok(a.S.seats.filter(Boolean).length === 3, 'still exactly 3 seats');
  // same token from two sockets at once: second (other tab) refused, same tab takes over
  {
    const x = cs[1], tok = x.tok;
    const y = new C('dup'); await y.open(); y.send({ t: 'resume', tok, tab: 'other-tab' });
    const r1 = await y.wait(m => m.t === 'resume_fail' || m.t === 'welcome');
    ok(r1.t === 'resume_fail' && r1.inuse, 'seat in use by another tab -> refused');
    y.ws.close();
  }
  st2 = await getStats(PORT); ok(st2.errors === 0 && st2.invariant === 0, 'no errors after reconnect races');

  // ---- 6. oversized and flood
  {
    const [p, q] = await table(2);
    p.send(JSON.stringify({ t: 'chat', m: 'x'.repeat(5000) }));
    await sleep(200);
    ok(p.closed && p.closeCode === 1009, 'oversized frame closes the socket with 1009 (got ' + p.closeCode + ')');
    await q.waitState(s => s.seats[0] && !s.seats[0].on, 2000).then(() => ok(true, 'oversize sender shown offline'), () => ok(false, 'oversize sender not marked offline'));
    const f = new C('flood'); await f.open(); f.send({ t: 'join', room: q.code, name: 'Flood' }); await f.wait(m => m.t === 'welcome');
    for (let i = 0; i < 2000; i++) f.send({ t: 'chat', m: 'spam' + i });
    await sleep(500);
    const got = q.msgs.filter(m => m.t === 'chat' && m.n === 'Flood').length;
    ok(got === 5, 'chat flood: only 5 messages delivered (' + got + ')');
    ok(f.closed, 'socket flooding thousands of messages gets disconnected');
    const s = await getStats(PORT); ok(s.rateDropped > 0, 'flood rate-limited');
    q.send({ t: 'leave' }); setTimeout(() => { q.ws.close(); f.ws.close(); }, 100);
  }

  // ---- 7. seat race: 12 sockets join an empty-ish table at the same time
  {
    const [h] = await table(1);
    const js = []; for (let i = 0; i < 12; i++) { const c = new C('J' + i); await c.open(); js.push(c); }
    js.forEach((c, i) => c.send({ t: 'join', room: h.code, name: 'J' + i }));
    await sleep(500);
    const welcomed = js.filter(c => c.msgs.some(m => m.t === 'welcome')).length;
    const full = js.filter(c => c.msgs.some(m => m.t === 'err' && m.code === 'full'));
    ok(welcomed === 7 && full.length === 5, '8-seat limit under a join race (welcomed ' + welcomed + ', full ' + full.length + ')');
    ok(/full/.test(full[0].msgs.find(m => m.t === 'err').m), 'friendly full message');
    ok(h.S.seats.filter(Boolean).length === 8, '8 seats filled');
    for (const c of [h, ...js]) try { c.send({ t: 'leave' }); setTimeout(() => c.ws.close(), 100); } catch (e) { }
  }

  // ---- 8. static file path traversal
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/public/../server.js', '/..%2fserver.js', '/package.json', '/lib/room.js', '/__test/../server.js'])
    ok((await get(p)).code === 404, 'no file leak via ' + p);
  ok((await get('/')).code === 200 && (await get('/evaluator.js')).code === 200 && (await get('/healthz')).body === 'ok', 'static + health ok');

  // ---- 9. no leaks to sockets that are not seated / spectators
  {
    const spy = new C('spy'); await spy.open(); spy.send({ t: 'resume', tok: a.tok.slice(0, -1) + 'A', tab: 'z' });
    await sleep(300);
    ok(spy.msgs.every(m => m.t === 'resume_fail' || cardStrings(m).length === 0), 'guessed token reveals nothing');
    spy.ws.close();
  }

  // ---- 9b. solo mode (computer Dealer): leaks, spam, disconnect on own turn, seat cap
  {
    const s = new C('Solo'); await s.open(); s.send({ t: 'create', name: 'Solo' }); await s.wait(m => m.t === 'welcome');
    s.send({ t: 'act', a: 'new' }); s.send({ t: 'start', x: 1 }); s.send({ t: 'start' }); // double start
    const st = await s.waitState(m => m.ph === 'deal');
    const ds = st.seats.findIndex(q => q && q.b);
    ok(ds >= 0 && st.seats[ds].n === 'Dealer' && st.host === s.seat, 'solo start seats the Dealer, human stays host');
    for (let i = 0; i < 15; i++) s.send({ t: 'act', a: ['sel', 'swap', 'discard', 'cancel', 'reject'][i % 5], i: i % 7, seat: ds }); // out-of-state spam (deal / ask phase)
    await s.waitState(m => m.ph === 'draw' && m.turn === s.seat, 3000);
    const before = s.msgs.length;
    s.send({ t: 'act', a: 'new' }); s.send({ t: 'act', a: 'new' }); s.send({ t: 'act', a: 'new' }); // duplicates: only the first counts
    await sleep(120);
    ok(s.S.ofs === 1 && s.S.sub === 'select', 'duplicate "new" counted once in solo (' + JSON.stringify({ ph: s.S.ph, turn: s.S.turn, me: s.seat, ofs: s.S.ofs, sub: s.S.sub, last: s.S.last, hn: s.S.hn }) + ')');
    s.send({ t: 'chat', m: 'brb' }); await sleep(30);
    // vanish on own turn: grace 0.3 s then auto-stand -> showdown, hand ends cleanly without a client
    s.ws.close(); await sleep(900);
    let sd = (await getStats(PORT)).roomsDetail.find(r => r.code === s.code);
    ok(sd && sd.ph === 'show' && sd.players.includes('Dealer'), 'offline solo player auto-stood, hand reached showdown: ' + JSON.stringify(sd));
    // every message before showdown: no Dealer cards anywhere
    const pre = s.msgs.filter(m => !(m.t === 'st' && m.ph === 'show'));
    let leak = 0; const mine = new Set();
    for (const m of pre) if (m.t === 'st') { const o = m.seats[ds]; if (o && o.cards) leak++; (m.seats[s.seat].cards || []).forEach(c => mine.add(c)); if (m.offer) mine.add(m.offer); if (m.last && m.last.c) mine.add(m.last.c); }
    const strays = pre.flatMap(m => cardStrings(m)).filter(c => !mine.has(c));
    ok(leak === 0 && strays.length === 0, 'no Dealer cards before showdown (' + leak + ' seat leaks, strays ' + strays.slice(0, 3) + ')');
    const r = new C('Solo-back'); await r.open(); r.send({ t: 'resume', tok: s.tok, tab: 'q' });
    const rs = await r.waitState(m => m.ph === 'show');
    ok(rs.res && rs.res.hands.length === 2 && rs.res.hands.some(h => h.n === 'Dealer' && h.cards.length === 5) && /Dealer/.test(rs.res.text), 'reconnected player sees the showdown vs the Dealer');
    r.send({ t: 'leave' }); await sleep(150);
    sd = (await getStats(PORT)).roomsDetail.find(x => x.code === s.code);
    ok(!sd, 'solo room removed when the human leaves');
    r.ws.close();
  }
  {
    // 8 humans can always join a solo table; the Dealer gives up its seat (mid-hand -> hand ends by default)
    const s = new C('Solo2'); await s.open(); s.send({ t: 'create', name: 'Dealer' }); const w = await s.wait(m => m.t === 'welcome');
    ok(w.name === 'Dealer 2', 'humans cannot take the name "Dealer" (' + w.name + ')');
    s.send({ t: 'start' }); await s.waitState(m => m.ph === 'draw');
    const js = [];
    for (let i = 0; i < 7; i++) { const c = new C('J' + i); await c.open(); c.send({ t: 'join', room: s.code, name: 'J' + i }); const m = await c.wait(m => m.t === 'welcome' || m.t === 'err'); ok(m.t === 'welcome', 'human ' + (i + 2) + ' seated with the Dealer present'); js.push(c); }
    await sleep(100);
    ok(s.S.seats.every(q => q && !q.b), '8 humans, Dealer gone: ' + s.S.seats.map(q => q && q.n));
    ok(s.S.ph === 'show' && s.S.res && s.S.res.walk && s.S.res.win[0] === s.seat, 'solo hand ended by default for the human when the Dealer left');
    const x = new C('X'); await x.open(); x.send({ t: 'join', room: s.code, name: 'X' }); const m = await x.wait(m => m.t === 'err' || m.t === 'welcome');
    ok(m.t === 'err' && m.code === 'full', '9th human rejected');
    // all but one leave -> host can play vs Dealer again
    for (const c of js) c.send({ t: 'leave' });
    await sleep(200);
    ok(s.S.ph === 'wait' || s.S.ph === 'show', 'phase after others left: ' + s.S.ph);
    s.send({ t: 'start' });
    const st2 = await s.waitState(m => m.ph === 'deal' || m.ph === 'draw');
    ok(st2.seats.some(q => q && q.b), 'Dealer option returns when back to one human');
    s.send({ t: 'leave' }); x.ws.close(); js.forEach(c => c.ws.close()); await sleep(150);
    s.ws.close();
  }

  // ---- 10. cleanup + memory: 300 rooms created and abandoned
  for (const c of cs) { try { c.send({ t: 'leave' }); c.ws.close(); } catch (e) { } }
  const heap0 = (await getStats(PORT)).mem;
  const socks = [];
  for (let i = 0; i < 300; i++) { const c = new C('m' + i); await c.open(); c.send({ t: 'create', name: 'M' + i }); socks.push(c); }
  await sleep(500);
  let s3 = await getStats(PORT); ok(s3.rooms >= 300, 'rooms created: ' + s3.rooms);
  socks.forEach((c, i) => { if (i % 2) c.send({ t: 'leave' }); else c.ws.close(); });   // half leave, half just vanish
  await sleep(1800); // reconnect window is 1 s in this test
  s3 = await getStats(PORT);
  ok(s3.rooms === 0, 'all empty rooms cleaned up (' + s3.rooms + ' left: ' + JSON.stringify(s3.roomsDetail.slice(0, 3)) + ')');
  ok(s3.sessions === 0, 'all sessions cleaned up (' + s3.sessions + ')');
  socks.forEach(c => c.ws.close()); await sleep(200);
  s3 = await getStats(PORT);
  ok(s3.sockets <= 1, 'sockets closed (' + s3.sockets + ')');
  ok(s3.errors === 0 && s3.invariant === 0, 'no server errors overall');
  console.log('heap before/after room churn (MB):', (heap0 / 1e6).toFixed(1), (s3.mem / 1e6).toFixed(1));
  const errs = srv.out.filter(l => l.startsWith('[stderr]'));
  ok(errs.length === 0, 'no server stderr output ' + errs.join('').slice(0, 300));
  srv.kill();
  console.log('malicious-client tests: ' + pass + ' passed, ' + failN + ' failed');
  process.exit(failN ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
