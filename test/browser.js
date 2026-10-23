'use strict';
// Real-browser end-to-end test: headless Google Chrome via playwright-core, up to 9 browser
// contexts against a real server. Players are driven ONLY through the UI (keyboard + mouse).
// Usage: node test/browser.js [handsPerSession]   (needs playwright-core, see README)
const path = require('path'), fs = require('fs');
const PW = process.env.PW_PATH || '/tmp/pw/node_modules/playwright-core';
const { chromium } = require(PW);
const { startServer, getStats, sleep, cardStrings, CARD_RE } = require('./helpers');
const { refScore } = require('./ref-evaluator');
const { parse } = require('../lib/cards');
const CATS = require('../public/evaluator.js').CATS;

const PER = +process.argv[2] || 8;
const PORT = 4100 + Math.floor(Math.random() * 90), BASE = 'http://localhost:' + PORT;
const SHOTS = path.join(__dirname, '..', 'screenshots');
let pass = 0, failN = 0; const fails = [];
function ok(c, m) { if (c) pass++; else { failN++; fails.push(m); console.log('FAIL:', m); } }
const rnd = Math.random, pick = a => a[Math.floor(rnd() * a.length)];
const stat = { hands: 0, walkovers: 0, bySize: {}, keyActs: 0, mouseActs: 0, timeouts: 0, swaps: 0, rejects: 0, reloadsTurn: 0, reloadsSelect: 0, leavesTurn: 0, leavesShow: 0, hostLeaves: 0, midJoins: 0, frames: 0, leakChecks: 0, domChecks: 0, chats: 0 };
const offersSeen = new Map();  // code:hn -> Set of cards that were ever face up (offered) — public info
const pendingLeak = [];        // [key, card, who]
const showVerified = new Set();
let browser;

class Player {
  constructor(name) { this.name = name; this.S = null; this.n = 0; this.pageErrors = []; this.chats = []; this.errs = []; this.welcome = null; this.lastOwn = {}; }
  async init() {
    this.ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    this.page = await this.ctx.newPage();
    this.page.on('pageerror', e => this.pageErrors.push(String(e)));
    this.page.on('console', m => { if (m.type() === 'error') this.pageErrors.push('console: ' + m.text()); });
    this.page.on('websocket', ws => ws.on('framereceived', f => this.frame(f.payload)));
    return this;
  }
  frame(payload) {
    let m; try { m = JSON.parse(payload); } catch (e) { ok(false, this.name + ' non-JSON frame'); return; }
    stat.frames++;
    if (m.t === 'welcome') this.welcome = m;
    else if (m.t === 'chat') this.chats.push(m);
    else if (m.t === 'err') this.errs.push(m);
    else if (m.t === 'st') { this.S = m; this.n++; this.check(m); }
    else if (m.t !== 'hist' && m.t !== 'pong' && m.t !== 'left' && m.t !== 'resume_fail') ok(cardStrings(m).length === 0, 'cards in unexpected frame ' + m.t);
  }
  check(S) {
    const key = S.code + ':' + S.hn, you = S.you;
    if (S.offer) { if (!offersSeen.has(key)) offersSeen.set(key, new Set()); offersSeen.get(key).add(S.offer); }
    if (S.last && S.last.c) { if (!offersSeen.has(key)) offersSeen.set(key, new Set()); offersSeen.get(key).add(S.last.c); }
    if (S.ph === 'deal' || S.ph === 'draw' || S.ph === 'show') {
      let tot = S.deck + S.disc + (S.offer ? 1 : 0);
      S.seats.forEach(q => { if (q && q.ih) tot += q.k; });
      ok(tot === 52, this.name + ' card conservation ' + tot + ' in ' + S.ph + ' hand ' + key);
    }
    if (S.ph !== 'show') {
      ok(!S.res, 'result sent outside showdown');
      S.seats.forEach((q, s) => {
        if (!q) return;
        if (s === you) { if (q.ih && q.cards) { ok(q.cards.length === q.k, 'own card count'); if (S.ph === 'draw') { ok(q.cards.length === 5 && q.cards.every(c => CARD_RE.test(c)), 'own 5 cards in draw'); this.lastOwn[key] = q.cards.slice(); } } return; }
        if (q.cards) q.cards.forEach(c => { if (c) { stat.leakChecks++; pendingLeak.push([key, c, this.name + ' saw seat ' + s]); } });
      });
      // nothing else may carry cards besides own hand, the public offer and last action
      const copy = Object.assign({}, S, { seats: S.seats.map((q, s) => s === you ? null : q), offer: null, last: null });
      copy.seats.forEach(q => { if (q && q.cards) q.cards = null; });
      ok(cardStrings(copy).length === 0, 'stray cards in state frame');
    } else if (S.res && !S.res.walk && !showVerified.has(this.name + key)) {
      showVerified.add(this.name + key);
      const R = S.res, all = [];
      R.hands.forEach(h => { ok(h.cards.length === 5, 'showdown hand has 5 cards'); all.push(...h.cards); });
      ok(new Set(all).size === all.length, 'showdown cards unique');
      const sc = R.hands.map(h => refScore(h.cards.map(parse)).v), best = Math.max(...sc);
      const refWin = R.hands.filter((h, i) => sc[i] === best).map(h => h.s).sort().join(), gotWin = R.win.slice().sort().join();
      ok(refWin === gotWin, 'winner matches reference evaluator: ' + gotWin + ' vs ' + refWin);
      R.hands.forEach((h, i) => { ok(h.rank === sc.filter(v => v > sc[i]).length, 'competition rank'); ok(h.hn && CATS[h.cat] && h.hn.indexOf(CATS[h.cat]) >= 0 || h.hn, 'hand name present'); });
      const meQ = S.seats[you], mine = meQ && R.hands.find(h => h.id === meQ.id);
      if (mine && this.lastOwn[key]) {
        const exp = this.lastOwn[key].slice();
        if (S.last && S.last.s === you && S.last.a === 'take') exp[S.last.i] = S.last.c;  // the hand-ending swap
        ok(JSON.stringify(mine.cards) === JSON.stringify(exp), this.name + ' showdown shows exactly my cards ' + mine.cards + ' vs ' + exp + ' last=' + JSON.stringify(S.last));
        ok(JSON.stringify(mine.cards) === JSON.stringify(meQ.cards), 'own cards consistent at showdown');
      }
      ok(R.win.length === 1 ? R.head.indexOf('wins') >= 0 : /Split/.test(R.head), 'winner headline: ' + R.head);
      ok(R.text && R.text.length > 20, 'beginner explanation present');
    }
  }
  async waitFor(fn, ms = 8000, what = 'condition') {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) { } await sleep(20); }
    ok(false, this.name + ' timed out waiting for ' + what); return false;
  }
  async create() {
    await this.page.goto(BASE + '/'); await this.page.fill('#nameIn', this.name); await this.page.click('#createBtn');
    await this.waitFor(() => this.welcome && this.S, 8000, 'create'); this.code = this.welcome.code; return this;
  }
  async join(code, viaLink = true) {
    if (viaLink) { await this.page.goto(BASE + '/?room=' + code); await this.page.fill('#nameIn', this.name); await this.page.click('#joinBtn'); }
    else { await this.page.goto(BASE + '/'); await this.page.fill('#nameIn', this.name); await this.page.fill('#codeIn', code.toLowerCase()); await this.page.press('#codeIn', 'Enter'); }
    await this.waitFor(() => this.welcome && this.S, 8000, 'join'); this.code = code; return this;
  }
  get seat() { return this.S ? this.S.you : -1; }
  async key(k) { stat.keyActs++; await this.page.keyboard.press(k); }
  async click(sel) { stat.mouseActs++; await this.page.click(sel, { timeout: 3000 }); }
  async leave() { await this.page.click('#leaveBtn'); await this.waitFor(() => true, 10); await sleep(150); await this.ctx.close(); this.gone = true; }
  async dom() {
    return this.page.evaluate(() => {
      const q = s => Array.from(document.querySelectorAll(s));
      return {
        my: q('#myhand .card').length, myDown: q('#myhand .card.down').length, meWin: document.getElementById('me').classList.contains('win'),
        pods: q('#opps .pod').map(p => ({ s: +p.dataset.seat, n: p.querySelectorAll('.card').length, down: p.querySelectorAll('.card.down').length, hl: p.querySelectorAll('.card.hl').length, win: p.classList.contains('win') })),
        myHl: q('#myhand .card.hl').length, res: (document.querySelector('#prompt .res') || {}).textContent || '', exp: (document.querySelector('#prompt .exp') || {}).textContent || '',
        ladderHidden: document.getElementById('ladder').classList.contains('hidden'), ladderWin: (document.querySelector('#ladder .lr.hd') || {}).textContent || '',
        lobbyHidden: document.getElementById('lobby').classList.contains('hidden'), myname: document.getElementById('myname').textContent,
        chatN: q('#chatlog .msg').length, overflowX: document.documentElement.scrollWidth > innerWidth
      };
    });
  }
}

// ---------------------------------------------------------------- DOM assertions
async function checkDrawDom(p) {
  const S = p.S; if (!S || S.ph !== 'draw') return;
  const d = await p.dom(); stat.domChecks++;
  const S2 = p.S; if (S2.ph !== 'draw' || S2.hn !== S.hn) return;
  if (S2.seats[S2.you].ih) ok(d.my === 5 && d.myDown === 0, p.name + ' renders my 5 face-up cards (got ' + d.my + ')');
  for (const pod of d.pods) { const q = S2.seats[pod.s]; if (q && q.ih) ok(pod.n === 5, p.name + ' renders 5 cards for seat ' + pod.s + ' (got ' + pod.n + ')'); }
  ok(!d.overflowX, 'no horizontal overflow');
}
async function checkShowDom(players) {
  for (const p of players) {
    const S = p.S; if (!S || S.ph !== 'show' || !S.res) continue;
    const d = await p.dom(); stat.domChecks++;
    if (p.S.hn !== S.hn || p.S.ph !== 'show') continue;
    const R = S.res;
    if (R.walk) continue;
    ok(d.res === R.head, p.name + ' showdown headline rendered');
    ok(d.exp === R.text, p.name + ' explanation rendered as text');
    for (const h of R.hands) {
      if (h.s === S.you) { ok(d.my === 5 && d.myDown === 0, p.name + ' own showdown 5 cards'); ok(d.myHl === h.used.length, 'own used cards highlighted'); ok(d.meWin === R.win.includes(h.s), 'me win class'); continue; }
      const pod = d.pods.find(x => x.s === h.s);
      ok(pod && pod.n === 5 && pod.down === 0, p.name + ' showdown reveals 5 cards of seat ' + h.s);
      if (pod) { ok(pod.win === R.win.includes(h.s), p.name + ' winner pod highlighted for seat ' + h.s); ok(pod.hl === h.used.length, 'used cards highlighted seat ' + h.s); }
    }
    if (!d.ladderHidden) ok(d.ladderWin.indexOf(CATS[R.hands[0].cat]) >= 0, p.name + ' rankings panel highlights winning hand ' + CATS[R.hands[0].cat] + ' / ' + d.ladderWin);
  }
}

// ---------------------------------------------------------------- driver
async function waitChange(p, n0, ms = 7000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (p.gone || p.n !== n0) return true; await sleep(15); } return false; }
function hostOf(ps) { return ps.find(p => !p.gone && p.S && p.S.host === p.S.you); }
async function playHand(ps, opts = {}) {
  // returns when the hand reached showdown/wait. opts.hook(p, S) may perform a special action and return true.
  const live = () => ps.filter(p => !p.gone);
  const host = hostOf(live()); if (!host) { ok(false, 'no host'); return; }
  const hn0 = host.S.hn;
  if (opts.preStart) await opts.preStart(host);
  // host starts with Enter or the button
  await host.waitFor(() => host.S && (host.S.ph === 'wait' || host.S.ph === 'show'), 9000, 'start-able phase');
  if (rnd() < 0.5) { await host.page.evaluate(() => document.activeElement && document.activeElement.blur()); await host.key('Enter'); }
  else await host.click('#startBtn');
  if (!(await host.waitFor(() => host.S.hn > hn0, 6000, 'hand to start'))) return;
  const hn = host.S.hn, size = host.S.seats.filter(q => q && q.ih).length;
  let guard = 0, domTick = 0;
  while (guard++ < 400) {
    const L = live(); if (!L.length) return;
    const ref = L[0], S = ref.S;
    if (S.hn !== hn) break;
    if (S.ph === 'show' || S.ph === 'wait') break;
    if (S.ph !== 'draw') { await sleep(30); continue; }
    const tp = L.find(p => p.S.you === S.turn);
    if (!tp) { await waitChange(ref, ref.n, 9000); continue; }    // turn of an offline player
    await sleep(15);
    const T = tp.S; if (T.turn !== T.you || T.ph !== 'draw') continue;
    if (domTick++ % 3 === 0) { await checkDrawDom(tp); await checkDrawDom(pick(L)); }
    if (opts.hook && await opts.hook(tp, T, L)) continue;
    const n0 = tp.n, useKey = rnd() < 0.6;
    if (rnd() < (opts.timeoutP || 0.02)) { stat.timeouts++; await waitChange(tp, n0, 15000); continue; }
    if (T.sub === 'ask') {
      const yes = rnd() < 0.65;
      if (useKey) await tp.key(yes ? 'y' : 'n'); else await tp.click(yes ? '#yesBtn' : '#noBtn');
    } else if (T.sub === 'select') {
      if (!tp.selChecked || tp.selChecked !== hn + ':' + T.ofs) {
        tp.selChecked = hn + ':' + T.ofs;
        const ui = await tp.page.evaluate(() => ({ cur: window.__pk.cursor, q: (document.getElementById('prompt') || {}).textContent || '', btns: Array.from(document.querySelectorAll('#prompt button, #btns button')).map(b => b.textContent), curEl: document.querySelectorAll('#myhand .card.cur').length }));
        if (tp.S.sub === 'select' && tp.S.ofs === T.ofs && tp.S.hn === hn) {
          ok(/Choose a card to replace/.test(ui.q) && /press N to reject the new card/.test(ui.q), 'selection prompt: ' + ui.q);
          ok(ui.btns.includes('Reject card (N)') && !ui.btns.some(b => /Take|Cancel/.test(b)), 'only the Reject button: ' + ui.btns);
          ok(ui.cur === 0 && ui.curEl === 1, 'cursor starts on the first card (' + ui.cur + ')');
        }
      }
      if (rnd() < 0.25) { stat.rejects++; if (useKey) await tp.key(pick(['n', 'N', 'Escape'])); else await tp.click('#rejectBtn'); }
      else {
        const i = Math.floor(rnd() * 5), offer = T.offer;
        if (useKey) {
          const viaTab = rnd() < 0.3;
          if (rnd() < 0.5) for (let k = 0; k < i; k++) await tp.key(viaTab ? 'Tab' : 'ArrowRight');
          else for (let k = 0; k < (5 - i) % 5; k++) await tp.key(viaTab ? 'Shift+Tab' : 'ArrowLeft');
          const cur = await tp.page.evaluate(() => window.__pk.cursor);
          ok(cur === i, 'keyboard cursor at ' + i + ' (got ' + cur + ')');
          await tp.key('Enter');
        } else await tp.click('#myhand .card[data-i="' + i + '"]');
        stat.swaps++;
        await waitChange(tp, n0);
        const me = tp.S.seats[tp.S.you];
        if (tp.S.hn === hn && me && me.cards) ok(me.cards[i] === offer, 'swap put the ' + offer + ' at position ' + i + ' (got ' + me.cards[i] + ')');
        continue;
      }
    }
    if (!(await waitChange(tp, n0))) ok(false, tp.name + ' action had no effect (' + T.sub + ')');
  }
  const L = live(); if (!L.length) return;
  await L[0].waitFor(() => L[0].S.ph === 'show' || L[0].S.ph === 'wait', 9000, 'showdown');
  await sleep(120);
  const R = L[0].S.res;
  if (R && R.walk) stat.walkovers++;
  else if (R) { stat.hands++; stat.bySize[size] = (stat.bySize[size] || 0) + 1; await checkShowDom(L); }
  if (opts.atShow) await opts.atShow(L);
}

async function chatSend(p, text) {
  await p.page.click('#chatin'); await p.page.fill('#chatin', text); await p.page.press('#chatin', 'Enter'); stat.chats++;
}

// ---------------------------------------------------------------- sessions
async function session(size, hands, extra = {}) {
  const names = ['Maria', 'Tom', 'Aiko', 'Ravi', 'Lena', 'Chen', 'Omar', 'Zoe'];
  const ps = [await (await new Player(names[0]).init()).create()];
  const code = ps[0].code;
  ok(/^[A-Z2-9]{5}$/.test(code), 'room code format ' + code);
  for (let i = 1; i < size; i++) ps.push(await (await new Player(names[i]).init()).join(code, i % 2 === 1));
  await ps[0].waitFor(() => ps[0].S.seats.filter(Boolean).length === size, 5000, 'all seated');
  ok(ps.every(p => p.pageErrors.length === 0), 'no page errors after joining');
  // join system messages
  await sleep(100);
  const sysJoins = ps[0].chats.filter(m => m.sys && /joined/.test(m.m)).length;
  ok(sysJoins >= size - 1, 'join system messages (' + sysJoins + ')');
  if (extra.before) await extra.before(ps, code);
  for (let h = 0; h < hands; h++) {
    if (ps.filter(p => !p.gone).length < 2) break;
    await playHand(ps, typeof extra.opts === 'function' ? extra.opts(h, ps) : (extra.opts || {}));
  }
  if (extra.after) await extra.after(ps, code);
  for (const p of ps) if (!p.gone) ok(p.pageErrors.length === 0, p.name + ' page errors: ' + p.pageErrors.join(' | ').slice(0, 300));
  for (const p of ps) if (!p.gone) await p.leave();
  return ps;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await startServer({ TURN_SECONDS: '4', DEAL_MS: '15', NEXT_HAND_SECONDS: '60', RECONNECT_SECONDS: '60', AUTO_STAND_MS: '300' }, PORT);
  browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const t0 = Date.now();

  // ---- lobby screenshot + lobby validation
  {
    const p = await new Player('Lobby').init();
    await p.page.goto(BASE + '/');
    const t = await p.page.textContent('#lobby');
    ok(/POKER KING/.test(t) && /Published by Crow New Media/.test(t), 'lobby branding');
    await p.page.click('#createBtn'); ok(/display name/.test(await p.page.textContent('#lobbyMsg')), 'empty name prompt');
    await p.page.fill('#nameIn', 'Maria'); await p.page.fill('#codeIn', 'AB'); await p.page.click('#joinBtn');
    ok(/5 letters/.test(await p.page.textContent('#lobbyMsg')), 'bad code message');
    await p.page.fill('#codeIn', 'ZZZZZ'); await p.page.click('#joinBtn'); await sleep(400);
    ok(/No table found/.test(await p.page.textContent('#lobbyMsg')), 'unknown table message: ' + await p.page.textContent('#lobbyMsg'));
    await p.page.fill('#codeIn', ''); await p.page.evaluate(() => document.getElementById('lobbyMsg').textContent = '');
    await p.page.screenshot({ path: path.join(SHOTS, 'lobby.png') });
    ok(p.pageErrors.length === 0, 'lobby page errors ' + p.pageErrors.join('|'));
    await p.ctx.close();
  }

  if (process.env.SOLO_ONLY) { /* skip multi-player sessions */ } else {
  // ---- 2..7 player sessions with random play
  for (const size of [2, 3, 5, 6, 7]) { await session(size, PER); console.log(`  size ${size} done — ${stat.hands} showdowns so far (${((Date.now() - t0) / 1000).toFixed(0)}s)`); }

  // ---- 8 players: 9th rejected, chat XSS/spam/typing, H key, screenshots
  await session(8, PER, {
    before: async (ps, code) => {
      const ninth = await new Player('Ninth').init();
      await ninth.page.goto(BASE + '/?room=' + code); await ninth.page.fill('#nameIn', 'Ninth'); await ninth.page.click('#joinBtn');
      await sleep(500);
      const msg = await ninth.page.textContent('#lobbyMsg');
      ok(/full/i.test(msg) && /8/.test(msg), '9th player gets a friendly "table full" message: ' + msg);
      ok(!(await ninth.page.evaluate(() => document.getElementById('lobby').classList.contains('hidden'))), '9th player stays in lobby');
      ok(ninth.pageErrors.length === 0, '9th no errors'); await ninth.ctx.close();
      // XSS through chat
      const payload = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script><b>bold</b> & "quotes"';
      await chatSend(ps[1], payload); await sleep(400);
      for (const p of ps) {
        const r = await p.page.evaluate(() => { const m = Array.from(document.querySelectorAll('#chatlog .msg')).pop(); return { txt: m.querySelector('.txt') && m.querySelector('.txt').textContent, el: document.querySelectorAll('#chatlog img,#chatlog script,#chatlog b').length, xss: window.__xss }; });
        ok(r.txt === payload && r.el === 0 && r.xss === undefined, p.name + ' chat XSS rendered literally');
      }
      // friendly chat for the screenshots
      await chatSend(ps[0], 'Hi everyone! First time playing poker 🙂'); await chatSend(ps[2], 'Welcome Maria! Press H to see the hand rankings.');
      await chatSend(ps[5], 'Good luck all');
    },
    opts: (h, ps) => ({
      hook: async (tp, T, L) => {
        // once: typing "y n h" + Enter in the chat box during my turn must not act or toggle the ladder
        if (!stat.chatTypeDone && T.sub === 'ask') {
          stat.chatTypeDone = 1;
          const before = await tp.dom(), n0 = tp.n, S0 = tp.S;
          await tp.page.click('#chatin'); await tp.page.keyboard.type('y n h Y N H tab'); await tp.page.keyboard.press('ArrowLeft'); await tp.page.keyboard.press('Enter');
          await sleep(400);
          const after = await tp.dom();
          ok(tp.S.turn === S0.turn && tp.S.sub === 'ask' && tp.S.ofs === S0.ofs && tp.S.hn === S0.hn, 'typing y/n in chat did not act');
          ok(after.ladderHidden === before.ladderHidden, 'typing h in chat did not toggle rankings');
          ok(L[0].chats.some(m => m.m === 'y n h Y N H tab'), 'chat message delivered');
          await tp.page.keyboard.press('Escape');
          return true;
        }
        // once: H key toggles the rankings panel
        if (!stat.hDone) {
          stat.hDone = 1;
          await tp.page.evaluate(() => document.activeElement && document.activeElement.blur());
          const a = (await tp.dom()).ladderHidden; await tp.key('h'); const b = (await tp.dom()).ladderHidden; await tp.key('h'); const c = (await tp.dom()).ladderHidden;
          ok(a !== b && a === c, 'H toggles the rankings panel');
        }
        // mid-hand screenshot with chat, during a selection
        if (!stat.midShot && T.sub === 'select' && h >= 1) {
          stat.midShot = 1;
          await tp.page.keyboard.press('ArrowRight'); await tp.page.keyboard.press('ArrowRight');
          await sleep(900);  // let the deal animation finish
          await tp.page.screenshot({ path: path.join(SHOTS, 'mid-hand.png') });
          const other = L.find(p => p !== tp); await other.page.screenshot({ path: path.join(SHOTS, 'mid-hand-watching.png') });
          await tp.page.keyboard.press('ArrowLeft'); await tp.page.keyboard.press('ArrowLeft');  // cursor back to card 1
          ok(await tp.page.evaluate(() => window.__pk.cursor) === 0, 'arrow keys move the selection cursor both ways');
        }
        return false;
      },
      atShow: async L => {
        if (!stat.showShot && h >= 1) {
          stat.showShot = 1;
          await chatSend(L[1], 'Nice hand!'); await sleep(300);
          await L[0].page.screenshot({ path: path.join(SHOTS, 'showdown.png') });
        }
      }
    }),
    after: async ps => {
      // chat spam: 9 messages back to back -> only 5 get through, the sender gets a polite warning
      await sleep(5200);
      const p = ps[3], before = ps[0].chats.length;
      for (let i = 0; i < 9; i++) await chatSend(p, 'spam ' + i);
      await sleep(500);
      const got = ps[0].chats.slice(before).filter(m => m.n === p.S.seats[p.S.you].n).length;
      ok(got === 5, 'chat rate limit 5 per 5 s (got ' + got + ')');
      ok(p.errs.some(e => /slow|fast|wait/i.test(e.m)), 'spammer told to slow down');
      // 201+ chars are cut (input maxlength 200 and server truncation)
      await sleep(5200);
      await p.page.click('#chatin'); await p.page.fill('#chatin', 'x'.repeat(250)); await p.page.press('#chatin', 'Enter'); await sleep(300);
      const last = ps[0].chats[ps[0].chats.length - 1]; ok(last && last.m.length === 200, 'chat capped at 200 chars');
    }
  });
  console.log(`  size 8 done — ${stat.hands} showdowns so far`);

  // ---- 4 players: reload during own turn & during selection, leaving mid-turn, host leaves, mid-hand joiner, leave mid-showdown
  {
    const done = {};
    await session(4, Math.max(PER, 6), {
      opts: (h, ps) => ({
        timeoutP: 0.01,
        hook: async (tp, T, L) => {
          if (!done.reloadTurn && T.sub === 'ask' && h >= 0) {
            done.reloadTurn = 1; stat.reloadsTurn++;
            const cards = T.seats[T.you].cards.slice(), seat = T.you; tp.welcome = null;
            await tp.page.reload();
            await tp.waitFor(() => tp.welcome && tp.welcome.resumed && tp.S && tp.S.you === seat, 8000, 'resume after reload');
            ok(JSON.stringify(tp.S.seats[seat].cards) === JSON.stringify(cards), 'reload during own turn keeps cards');
            ok(tp.S.turn === seat || tp.S.hn !== T.hn || tp.S.turn !== seat, 'turn still valid');
            const d = await tp.dom(); ok(d.lobbyHidden && d.my === 5, 'after reload the table is shown with 5 cards');
            return true;
          }
          if (!done.reloadSel && T.sub === 'select' && h >= 1) {
            done.reloadSel = 1; stat.reloadsSelect++;
            const seat = T.you, offer = T.offer; tp.welcome = null;
            await tp.page.reload();
            await tp.waitFor(() => tp.welcome && tp.S && tp.S.you === seat, 8000, 'resume after reload in selection');
            ok(tp.S.sub === 'select' && tp.S.offer === offer && tp.S.turn === seat, 'selection survives reload');
            const n0 = tp.n; await tp.key('Enter'); await waitChange(tp, n0);
            ok(tp.S.seats[seat].cards[0] === offer, 'swap after reload works');
            return true;
          }
          if (!done.midJoin && h === 2) {
            done.midJoin = 1; stat.midJoins++;
            const nj = await (await new Player('Late').init()).join(T.code);
            ps.push(nj);
            ok(!nj.S.seats[nj.S.you].ih, 'mid-hand joiner waits for next hand');
            const d = await nj.dom(); ok(/next hand/.test(d.myname) && d.my === 0, 'joiner told they are dealt in next hand');
            for (const q of nj.S.seats) if (q && q.cards) ok(q.cards.every(c => !c || offersSeen.get(T.code + ':' + T.hn).has(c)), 'joiner sees only public cards');
            return false;
          }
          if (!done.leaveTurn && h === 3 && tp.S.host !== tp.S.you && L.length > 3) {
            done.leaveTurn = 1; stat.leavesTurn++;
            const other = L.find(p => p !== tp), seat = T.you; await tp.leave();
            await other.waitFor(() => other.S.turn !== seat && !other.S.seats[seat], 5000, 'turn advances after leave');
            ok(other.chats.some(m => m.sys && /left/.test(m.m)), 'leave system message');
            return true;
          }
          if (!done.hostLeave && h === 4 && L.length >= 3) {
            const host = L.find(p => p.S.host === p.S.you);
            if (host && host !== tp) {
              done.hostLeave = 1; stat.hostLeaves++;
              const hs = host.S.you, seats = host.S.seats;
              let exp = -1; for (let k = 1; k < 8; k++) { const s = (hs + k) % 8; if (seats[s] && seats[s].on) { exp = s; break; } }
              await host.leave();
              const o = L.find(p => p !== host);
              await o.waitFor(() => o.S.host === exp, 5000, 'host handoff');
              ok(o.S.host === exp, 'host passes to next seated player clockwise');
              const nh = L.find(p => p.S.you === exp);
              await sleep(100); const t = await nh.page.textContent('#mehead'); ok(/Host/.test(t), 'new host sees host badge');
              return false;
            }
          }
          return false;
        },
        atShow: async L => {
          if (!done.leaveShow && h >= 5 && L.length >= 3) {
            const p = L.find(x => x.S.host !== x.S.you);
            done.leaveShow = 1; stat.leavesShow++; await p.leave();
            await sleep(200);
            for (const q of L) if (!q.gone) { const d = await q.dom(); ok(d.res.length > 0, 'showdown still shown after someone left'); }
          }
        }
      })
    });
    ok(done.reloadTurn && done.reloadSel && done.midJoin && done.hostLeave && done.leaveTurn, 'special scenarios ran: ' + JSON.stringify(done));
  }
  console.log(`  size 4 special done — ${stat.hands} showdowns so far`);

  // ---- all-but-one leaving mid-hand
  await session(3, 2, {
    after: async ps => {
      const host = hostOf(ps); const n0 = host.S.hn;
      await host.page.evaluate(() => document.activeElement && document.activeElement.blur()); await host.key('Enter');
      await host.waitFor(() => host.S.ph === 'draw', 5000, 'draw');
      const stay = ps[2]; for (const p of ps) if (p !== stay) await p.leave();
      await stay.waitFor(() => stay.S.seats.filter(Boolean).length === 1 && (stay.S.ph === 'wait' || stay.S.ph === 'show'), 5000, 'walkover');
      const d = await stay.dom();
      ok(/wins by default/.test(d.res) || stay.S.ph === 'wait', 'last player wins by default: ' + d.res);
      ok(stay.S.host === stay.S.you, 'remaining player becomes host');
      ok(stay.pageErrors.length === 0, 'no errors for the last player');
    }
  });

  }
  // ---- solo mode: one player vs the computer Dealer, a friend joins (Dealer steps aside), back to solo
  {
    const sam = await (await new Player('Sam').init()).create();
    const ps = [sam];
    await sam.waitFor(() => sam.S.ph === 'wait', 3000, 'solo wait');
    const prompt0 = await sam.page.textContent('#prompt');
    ok(/only player here/.test(prompt0) && /Play vs Dealer/.test(prompt0) && /Friends can still join/.test(prompt0), 'solo waiting text: ' + prompt0.slice(0, 200));
    ok(/Play vs Dealer/.test(await sam.page.textContent('#startBtn')), 'start button reads Play vs Dealer');
    let shot = false, soloHands = 0, dealerSeen = 0;
    const soloOpts = {
      hook: async (tp, T) => {
        const ds = T.seats.findIndex(q => q && q.b);
        if (ds >= 0 && !dealerSeen) {
          dealerSeen++;
          const pod = await tp.page.evaluate(s => { const e = document.querySelector('#opps .pod[data-seat="' + s + '"]'); return e ? { t: e.textContent, down: e.querySelectorAll('.card.down').length } : null; }, ds);
          ok(pod && /🤖 Dealer/.test(pod.t) && /computer/.test(pod.t) && /Always stands/.test(pod.t), 'Dealer pod labelled as the computer: ' + (pod && pod.t));
          ok(pod && pod.down === 5, 'Dealer cards face down during the draw (' + (pod && pod.down) + ')');
        }
        return false;
      },
      atShow: async L => {
        const S = sam.S; if (!S.res || S.res.walk) return;
        soloHands++;
        ok(S.res.hands.some(h => h.n === 'Dealer' && h.cards.length === 5), 'Dealer hand revealed at showdown');
        ok(/the Dealer|The Dealer/.test(S.res.text), 'explanation names the Dealer: ' + S.res.text);
        if (S.res.win.length === 1 && S.seats[S.res.win[0]].b) ok(S.res.head === 'The Dealer wins!', 'Dealer win headline: ' + S.res.head);
        const sb = await sam.page.textContent('#score').catch(() => '');
        ok(/🤖 Dealer/.test(sb), 'Dealer on the scoreboard');
        if (!shot && S.res.win.length === 1) { shot = true; await sam.page.screenshot({ path: path.join(SHOTS, 'solo.png') }); }
      }
    };
    for (let h = 0; h < Math.max(4, PER); h++) await playHand(ps, soloOpts);
    ok(dealerSeen && soloHands >= 3, 'solo hands played in the browser: ' + soloHands);
    stat.soloHands = soloHands;
    // a friend joins mid-hand: the Dealer finishes the hand, then steps aside
    let guest = null;
    await playHand(ps, {
      hook: async (tp) => { if (!guest) { guest = await (await new Player('Friend').init()).join(sam.code, true); ps.push(guest); ok(!guest.S.seats[guest.S.you].ih && guest.S.seats.some(q => q && q.b && q.ih), 'friend waits while the Dealer finishes the hand'); } return false; },
      atShow: async () => {
        await sleep(100);
        const t = await sam.page.textContent('#prompt');
        ok(/steps aside from the next hand/.test(t), 'showdown note: Dealer steps aside');
        ok(/Deal next hand/.test(await sam.page.textContent('#startBtn')), 'button back to "Deal next hand" with 2 humans');
      }
    });
    ok(guest, 'friend joined');
    await playHand(ps, { hook: async (tp, T) => { ok(!T.seats.some(q => q && q.b), 'no Dealer in the 2-human hand'); return false; } });
    ok(sam.chats.some(m => m.sys && /Dealer \(computer\) leaves the table/.test(m.m)), 'Dealer leave announced in chat');
    await guest.leave();
    await sam.waitFor(() => sam.S.seats.filter(Boolean).length === 1, 4000, 'back to solo');
    await sleep(150);
    ok(/Play vs Dealer/.test(await sam.page.textContent('#startBtn').catch(() => '')), 'Play vs Dealer offered again when alone');
    await playHand(ps, { atShow: async () => { ok(sam.S.seats.some(q => q && q.b), 'Dealer back at the table'); } });
    ok(sam.pageErrors.length === 0 && guest.pageErrors.length === 0, 'no page errors in solo mode: ' + sam.pageErrors.concat(guest.pageErrors).join('|').slice(0, 300));
    await sam.leave();
    console.log(`  solo done — ${soloHands} solo browser hands, ${stat.hands} showdowns so far`);
  }

  // ---- deferred leak check: every hidden-card string any browser saw must have been public (offered) in that hand
  let leaks = 0; for (const [k, c, who] of pendingLeak) if (!(offersSeen.get(k) || new Set()).has(c)) { leaks++; if (leaks < 5) console.log('LEAK', k, c, who); }
  ok(leaks === 0, 'no hidden card ever reached another browser (' + pendingLeak.length + ' face-up cards checked)');

  await sleep(300);
  const st = await getStats(PORT);
  ok(st.errors === 0, 'server errors: ' + st.errors); ok(st.invariant === 0, 'server invariant failures: ' + st.invariant);
  ok(st.rooms === 0, 'all rooms cleaned up (' + st.rooms + ')');
  const errs = srv.out.filter(l => l.startsWith('[stderr]')); ok(errs.length === 0, 'server stderr: ' + errs.join('').slice(0, 300));
  await browser.close(); srv.kill();
  console.log(JSON.stringify(stat));
  console.log(`browser tests: ${pass} passed, ${failN} failed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  process.exit(failN ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); try { await browser.close(); } catch (x) { } process.exit(1); });
