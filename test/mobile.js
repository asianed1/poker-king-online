'use strict';
// Mobile / touch end-to-end test: headless Chrome via playwright-core with phone & tablet emulation
// (isMobile + hasTouch, portrait and landscape). Mobile players act ONLY by tapping.
//  A) every profile: solo vs the computer Dealer, full hands with taps only
//  B) a 4-player table mixing phones (portrait + landscape) and a desktop keyboard player, with chat
// Checks: all 5 own cards visible + tappable, big touch targets inside the viewport, no horizontal
// overflow, showdown list, rankings sheet, chat collapse/unread/typing with a shrunken viewport, no JS errors.
// Usage: node test/mobile.js [handsPerSoloProfile] [handsAtTable]
const path = require('path'), fs = require('fs');
const PW = process.env.PW_PATH || '/tmp/pw/node_modules/playwright-core';
const { chromium, devices } = require(PW);
const { startServer, getStats, sleep } = require('./helpers');

const SOLO_HANDS = +process.argv[2] || 2, TABLE_HANDS = +process.argv[3] || 4;
const PORT = 4300 + Math.floor(Math.random() * 90), BASE = 'http://localhost:' + PORT;
const SHOTS = path.join(__dirname, '..', 'screenshots');
let pass = 0, failN = 0;
function ok(c, m) { if (c) pass++; else { failN++; console.log('FAIL:', m); } }
const rnd = Math.random;
const stat = { profiles: 0, hands: 0, showdowns: 0, taps: 0, keyActs: 0, swaps: 0, rejects: 0, stands: 0, news: 0, cardChecks: 0, btnChecks: 0, overflowChecks: 0, chatSent: 0, unreadSeen: 0, sheets: 0, kbdChecks: 0, shots: 0 };
const IOS = devices['iPhone 13'].userAgent, AND = devices['Pixel 5'].userAgent, IPAD = devices['iPad (gen 7)'].userAgent;
const mk = (name, w, h, ua, dpr) => ({ name, viewport: { width: w, height: h }, screen: { width: w, height: h }, userAgent: ua, deviceScaleFactor: dpr || 2, isMobile: true, hasTouch: true });
const ONLY = process.env.ONLY;
const PROFILES0 = [
  mk('iPhone-390x844-portrait', 390, 844, IOS, 3), mk('iPhone-844x390-landscape', 844, 390, IOS, 3),
  mk('Android-360x740-portrait', 360, 740, AND), mk('Android-740x360-landscape', 740, 360, AND),
  mk('Android-412x915-portrait', 412, 915, AND), Object.assign({ ...devices['iPhone 13'] }, { name: 'iPhone13-device-profile' }),
  Object.assign({ ...devices['Pixel 5 landscape'] }, { name: 'Pixel5-landscape-device-profile' }),
  mk('iPad-768x1024-portrait', 768, 1024, IPAD), mk('iPad-1024x768-landscape', 1024, 768, IPAD),
];
const PROFILES = PROFILES0.filter(p => !ONLY || p.name.includes(ONLY));
PROFILES0.forEach(p => delete p.defaultBrowserType);
let browser;

class P {
  constructor(name, prof) { this.name = name; this.prof = prof; this.mobile = !!prof; this.errors = []; }
  async init() {
    this.ctx = await browser.newContext(this.prof ? Object.assign({}, this.prof, { name: undefined }) : { viewport: { width: 1280, height: 720 } });
    this.page = await this.ctx.newPage();
    this.page.on('pageerror', e => this.errors.push(String(e)));
    this.page.on('console', m => { if (m.type() === 'error') this.errors.push('console: ' + m.text()); });
    await this.page.goto(BASE + '/');
    return this;
  }
  S() { return this.page.evaluate(() => { const S = window.__pk.S; return S ? { ph: S.ph, turn: S.turn, sub: S.sub, ofs: S.ofs, you: S.you, hn: S.hn, host: S.host, res: S.res ? { n: S.res.hands.length, walk: !!S.res.walk } : null, offer: S.offer, n: S.seats.filter(Boolean).length } : null; }); }
  async tap(sel) { await this.page.locator(sel).first().tap({ timeout: 5000 }); stat.taps++; }
  async waitFor(fn, arg, ms) { return this.page.waitForFunction(fn, arg, { timeout: ms || 15000 }); }
}

// ---------- UI assertions (run inside the page)
async function layoutCheck(p, tag) {
  const r = await p.page.evaluate(() => {
    const iw = innerWidth, ih = innerHeight, de = document.documentElement;
    const inV = b => b.left >= -1 && b.top >= -1 && b.right <= iw + 1 && b.bottom <= ih + 1;
    const over = [];
    document.querySelectorAll('#app *').forEach(e => {
      const b = e.getBoundingClientRect(); if (!b.width || !b.height) return;
      if (b.right > iw + 1 || b.left < -1) { let x = e, clip = false; while ((x = x.parentElement)) { const cs = getComputedStyle(x); if (cs.overflowX !== 'visible' && x.getBoundingClientRect().right <= iw + 1) { clip = true; break; } } if (!clip || e.closest('.main') && b.right > iw + 1) over.push((e.id || e.className || e.tagName) + ':' + Math.round(b.left) + '-' + Math.round(b.right)); }
    });
    const card = [...document.querySelectorAll('#myhand .card')].map(c => { const b = c.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return { w: b.width, h: b.height, inV: inV(b), hit: !!hit && hit.closest('.card') === c }; });
    const btns = [...document.querySelectorAll('#btns button')].map(e => { const b = e.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return { id: e.id, w: b.width, h: b.height, inV: inV(b), hit: !!hit && (hit === e || e.contains(hit)) }; });
    const hdr = [...document.querySelectorAll('header button')].map(e => { const b = e.getBoundingClientRect(); return { id: e.id, h: b.height, inV: inV(b) }; });
    const meta = (document.querySelector('meta[name=viewport]') || {}).content || '';
    return { sw: de.scrollWidth, bw: document.body.scrollWidth, iw, ih, over: over.slice(0, 4), card, btns, hdr, mob: de.classList.contains('mob'), touch: de.classList.contains('touch'), meta, tips: document.getElementById('tips').textContent };
  });
  stat.overflowChecks++;
  ok(r.mob, p.name + ' ' + tag + ': mobile layout active');
  ok(r.touch && /^Tap:/.test(r.tips), p.name + ' ' + tag + ': tap hints instead of keys help (' + r.tips.slice(0, 20) + ')');
  ok(/width=device-width/.test(r.meta) && /initial-scale=1/.test(r.meta) && /viewport-fit=cover/.test(r.meta), 'viewport meta ' + r.meta);
  ok(r.sw <= r.iw && r.bw <= r.iw, p.name + ' ' + tag + ': no horizontal scroll (' + r.sw + '/' + r.iw + ')');
  ok(r.over.length === 0, p.name + ' ' + tag + ': elements overflowing horizontally ' + r.over.join(' '));
  ok(r.hdr.every(b => b.inV && b.h >= 44), p.name + ' ' + tag + ': header buttons in view and >=44px ' + JSON.stringify(r.hdr));
  return r;
}
async function handCheck(p, tag) {
  const r = await layoutCheck(p, tag);
  stat.cardChecks++;
  ok(r.card.length === 5, p.name + ' ' + tag + ': 5 own cards (' + r.card.length + ')');
  ok(r.card.every(c => c.inV && c.hit), p.name + ' ' + tag + ': all own cards visible & tappable ' + JSON.stringify(r.card));
  ok(r.card.every(c => c.w >= Math.min(54, (r.iw - 72) / 5) && c.h >= c.w * 1.38), p.name + ' ' + tag + ': own cards large enough ' + r.card.map(c => Math.round(c.w)).join(','));
  return r;
}
function btnCheck(p, r, ids, tag) {
  stat.btnChecks++;
  for (const id of ids) {
    const b = r.btns.find(x => x.id === id);
    ok(b && b.inV && b.hit && b.h >= 44 && b.w >= 44, p.name + ' ' + tag + ': button #' + id + ' visible, tappable, >=44px ' + JSON.stringify(b));
  }
}

// ---------- one player's move (taps for mobile, keys for desktop)
async function move(p, S, shots) {
  const sig = [S.ph, S.turn, S.sub, S.ofs].join();
  if (S.sub === 'ask') {
    const pendingShot = Object.entries(shots || {}).some(([k, f]) => p.prof && p.prof.name.includes(k) && !fs.existsSync(f.tmp));
    const yes = S.ofs < 3 && (pendingShot || rnd() < 0.75);
    if (p.mobile) {
      await p.waitFor(() => document.getElementById('yesBtn'));
      const r = await handCheck(p, 'ask'); btnCheck(p, r, ['yesBtn', 'noBtn'], 'ask');
      await p.tap(yes ? '#yesBtn' : '#noBtn');
    } else { await p.page.keyboard.press(yes ? 'y' : 'n'); stat.keyActs++; }
    stat[yes ? 'news' : 'stands']++;
  } else if (S.sub === 'select') {
    const swap = rnd() < 0.65, i = Math.floor(rnd() * 5);
    if (p.mobile) {
      await p.waitFor(() => document.getElementById('rejectBtn')); await sleep(350);
      const r = await handCheck(p, 'select'); btnCheck(p, r, ['rejectBtn'], 'select');
      const ui = await p.page.evaluate(() => ({ q: document.getElementById('prompt').textContent, nc: (() => { const b = document.querySelector('#newspot .card'); if (!b) return null; const x = b.getBoundingClientRect(); return { w: x.width, inV: x.top >= 0 && x.bottom <= innerHeight && x.left >= 0 && x.right <= innerWidth }; })(), cap: document.getElementById('newcap').textContent, cur: window.__pk.cursor }));
      ok(/Tap one of your cards/.test(ui.q) && /Reject card/.test(ui.q), p.name + ' touch prompt: ' + ui.q);
      ok(ui.nc && ui.nc.inV && ui.nc.w >= 50, p.name + ' new card clearly visible ' + JSON.stringify(ui.nc));
      ok(ui.cap === 'Your new card' && ui.cur === 0, p.name + ' new card caption / cursor');
      for (const [k, f] of Object.entries(shots || {})) if (p.prof.name.includes(k) && !fs.existsSync(f.tmp)) { await p.page.screenshot({ path: f.tmp }); stat.shots++; }
      if (swap) await p.tap('#myhand .card:nth-child(' + (i + 1) + ')'); else await p.tap('#rejectBtn');
    } else {
      for (let k = 0; k < i; k++) await p.page.keyboard.press('ArrowRight');
      await p.page.keyboard.press(swap ? 'Enter' : 'n'); stat.keyActs++;
    }
    stat[swap ? 'swaps' : 'rejects']++;
  }
  await p.waitFor(s => { const S = window.__pk.S; return S && [S.ph, S.turn, S.sub, S.ofs].join() !== s; }, sig, 10000);
}

// ---------- play one hand at a table; players[0] is host
async function playHand(ps, opts) {
  const host = ps[0], H0 = await host.S();
  if (host.mobile) { await host.waitFor(() => document.getElementById('startBtn')); const r = await layoutCheck(host, 'start'); btnCheck(host, r, ['startBtn'], 'start'); await host.tap('#startBtn'); }
  else { await host.page.keyboard.press('Enter'); stat.keyActs++; }
  await host.waitFor(hn => window.__pk.S && window.__pk.S.hn > hn && window.__pk.S.ph !== 'deal', H0.hn, 15000);
  stat.hands++;
  for (let it = 0; it < 200; it++) {
    const S = await host.S();
    if (S.ph === 'show') break;
    if (S.ph !== 'draw') { await sleep(60); continue; }
    const tp = [];
    for (const p of ps) { const s = await p.S(); if (s.you === S.turn) tp.push([p, s]); }
    if (!tp.length) { await sleep(80); continue; }                    // the computer Dealer's turn
    const [p, s] = tp[0];
    if (s.ph !== 'draw' || s.turn !== s.you) continue;
    await move(p, s, opts.shots);
  }
  for (const p of ps) await p.waitFor(() => window.__pk.S && window.__pk.S.ph === 'show' && window.__pk.S.res);
  stat.showdowns++;
  await sleep(250);
  for (const p of ps.filter(x => x.mobile)) {
    const r = await layoutCheck(p, 'showdown');
    const sl = await p.page.evaluate(() => { const box = document.getElementById('showlist'), b = box.getBoundingClientRect(); return { n: box.querySelectorAll('.sl').length, cards: box.querySelectorAll('.sl .card').length, desc: [...box.querySelectorAll('.sld')].every(d => d.textContent.length > 10), vis: b.height > 30, bh: Math.round(b.height), iw: innerWidth, ih: innerHeight, opps: document.getElementById('opps').getBoundingClientRect().height, res: (document.querySelector('#prompt .res') || {}).textContent || '', exp: ((document.querySelector('#prompt .exp') || {}).textContent || '').length, win: box.querySelectorAll('.sl.win').length, me: box.querySelectorAll('.sl.me').length }; });
    const S = await p.S();
    ok(sl.n === S.res.n && sl.cards === 5 * S.res.n && sl.desc && sl.vis && sl.win >= 1 && sl.me === 1, p.name + ' showdown list ' + JSON.stringify(sl));
    ok(sl.opps === 0 && sl.res.length > 3 && sl.exp > 20, p.name + ' showdown result text shown, opponents seats replaced by list');
    // the list must be scrollable into view and the scroll container must not overflow sideways
    const sc = await p.page.evaluate(() => { const m = document.querySelector('.main'); const last = [...document.querySelectorAll('#showlist .sl')].pop(); last.scrollIntoView({ block: 'end' }); const b = last.getBoundingClientRect(); const ok = b.bottom <= innerHeight + 1 && b.top >= 0; m.scrollTop = 0; return { ok, sw: m.scrollWidth, cw: m.clientWidth }; });
    ok(sc.ok && sc.sw <= sc.cw, p.name + ' showdown list scrolls into view ' + JSON.stringify(sc));
    if (S.host === S.you) btnCheck(p, r, ['startBtn'], 'showdown');
    if (opts.shots && opts.shots.showPortrait && p.prof.name.includes('portrait') && !fs.existsSync(opts.shots.showPortrait.tmp)) { await p.page.screenshot({ path: opts.shots.showPortrait.tmp }); stat.shots++; }
  }
}

async function sheetCheck(p) {
  await p.tap('#hrBtn'); await sleep(150);
  const r = await p.page.evaluate(() => { const s = document.getElementById('side').getBoundingClientRect(), l = document.getElementById('ladder').getBoundingClientRect(), c = document.getElementById('sheetClose').getBoundingClientRect(); return { on: document.documentElement.classList.contains('sheet'), s: [s.left, s.top, s.right, s.bottom], lh: l.height, rows: document.querySelectorAll('#ladder .lr').length, ch: c.height, cIn: c.top >= 0 && c.bottom <= innerHeight, iw: innerWidth, ih: innerHeight }; });
  ok(r.on && r.lh > 100 && r.rows === 10 && r.s[0] >= 0 && r.s[2] <= r.iw + 1 && r.s[3] <= r.ih + 1 && r.ch >= 44 && r.cIn, p.name + ' rankings sheet opens ' + JSON.stringify(r));
  await p.tap('#sheetClose'); await sleep(100);
  ok(!(await p.page.evaluate(() => document.documentElement.classList.contains('sheet'))), p.name + ' sheet closes');
  stat.sheets++;
}

async function chatCheck(mob, other) {
  const pg = mob.page;
  let st = await pg.evaluate(() => ({ open: window.__pk.chatOpen, log: getComputedStyle(document.getElementById('chatlog')).display, bar: document.getElementById('chatbar').getBoundingClientRect().height }));
  ok(!st.open && st.log === 'none' && st.bar >= 44, mob.name + ' chat starts collapsed below play area with 44px bar ' + JSON.stringify(st));
  const txt = 'hello from ' + other.name + ' ' + Math.floor(rnd() * 1e6);
  if (other.mobile) {
    await other.tap('#chatbar'); await other.tap('#chatin'); await other.page.keyboard.type(txt); await other.tap('#chatform button');
    await other.page.evaluate(() => document.activeElement.blur()); await other.tap('#chatbar');
  } else { await other.page.click('#chatin'); await other.page.fill('#chatin', txt); await other.page.press('#chatin', 'Enter'); await other.page.evaluate(() => document.activeElement.blur()); }
  await mob.waitFor(() => window.__pk.unread >= 1, null, 5000);
  st = await pg.evaluate(() => ({ u: document.getElementById('unread').textContent, vis: !document.getElementById('unread').classList.contains('hidden'), prev: document.getElementById('chatprev').textContent }));
  ok(st.vis && +st.u >= 1 && st.prev.includes(txt), mob.name + ' unread badge + preview ' + JSON.stringify(st)); stat.unreadSeen++;
  await mob.tap('#chatbar');
  st = await pg.evaluate(t => ({ open: window.__pk.chatOpen, u: window.__pk.unread, has: document.getElementById('chatlog').textContent.includes(t), badge: document.getElementById('unread').classList.contains('hidden') }), txt);
  ok(st.open && st.u === 0 && st.has && st.badge, mob.name + ' chat expands, unread cleared ' + JSON.stringify(st));
  await mob.tap('#chatin');
  const fs16 = await pg.evaluate(() => parseFloat(getComputedStyle(document.getElementById('chatin')).fontSize));
  ok(fs16 >= 16, mob.name + ' chat input font >= 16px (no zoom on focus): ' + fs16);
  // simulate the on-screen keyboard: the visual viewport shrinks; the input must stay visible above it
  const vp = mob.page.viewportSize();
  const kb = Math.round(vp.height * (vp.height > vp.width ? 0.42 : 0.55));
  await mob.page.setViewportSize({ width: vp.width, height: vp.height - kb }); await sleep(250);
  const v = await pg.evaluate(() => { const b = document.getElementById('chatin').getBoundingClientRect(), s = document.querySelector('#chatform button').getBoundingClientRect(), l = document.getElementById('chatlog').getBoundingClientRect(); return { inV: b.top >= 0 && b.bottom <= innerHeight + 1 && s.bottom <= innerHeight + 1 && s.right <= innerWidth + 1, logH: l.height, ih: innerHeight, typing: document.documentElement.classList.contains('typing'), focus: document.activeElement && document.activeElement.id }; });
  ok(v.inV && v.logH >= 20 && v.typing && v.focus === 'chatin', mob.name + ' chat input visible with keyboard open ' + JSON.stringify(v)); stat.kbdChecks++;
  const mine = 'tap-typed from ' + mob.name;
  await pg.keyboard.type(mine); await mob.tap('#chatform button');
  await other.waitFor(t => document.getElementById('chatlog').textContent.includes(t), mine, 5000); stat.chatSent++;
  ok(await pg.evaluate(() => window.__pk.unread === 0), mob.name + ' own message does not count as unread');
  await pg.evaluate(() => document.activeElement.blur());
  await mob.page.setViewportSize(vp); await sleep(200);
  await mob.tap('#chatbar');
  ok(!(await pg.evaluate(() => window.__pk.chatOpen)), mob.name + ' chat collapses again');
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await startServer({ TURN_SECONDS: '30', DEAL_MS: '15', NEXT_HAND_SECONDS: '120', RECONNECT_SECONDS: '60', AUTO_STAND_MS: '300' }, PORT);
  browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const t0 = Date.now();
  const tmp = n => ({ tmp: '/tmp/mob-shot-' + n + '-' + PORT + '.png', out: path.join(SHOTS, 'mobile-' + n + '.png') });
  const SH = { 'iPhone-390x844-portrait': tmp('portrait-select'), 'Android-740x360-landscape': tmp('landscape-select'), showPortrait: tmp('portrait-showdown') };
  const SOLO_SH = { 'iPhone-390x844-portrait': tmp('solo-portrait-select'), 'iPhone-844x390-landscape': tmp('solo-landscape-select') };

  // ---- B) 4-player table: desktop host + 3 phones, with chat
  if (!ONLY) {
    const desk = await new P('Dana', null).init();
    const ip = await new P('Ivy', PROFILES0[0]).init(), pl = await new P('Leo', PROFILES0[3]).init(), sm = await new P('Sam', PROFILES0[2]).init();
    await desk.page.fill('#nameIn', 'Dana'); await desk.page.click('#createBtn');
    await desk.waitFor(() => window.__pk.S);
    const code = (await desk.S()) && await desk.page.evaluate(() => window.__pk.S.code);
    for (const p of [ip, pl, sm]) {
      // lobby on a phone: no overflow, 16px+ inputs, big buttons
      const lb = await p.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, fs: [...document.querySelectorAll('#lobby input')].map(i => parseFloat(getComputedStyle(i).fontSize)), bh: [...document.querySelectorAll('#lobby button')].map(b => b.getBoundingClientRect().height), mob: document.documentElement.classList.contains('mob') }));
      ok(lb.mob && lb.sw <= lb.iw && lb.fs.every(f => f >= 16) && lb.bh.every(h => h >= 44), p.name + ' mobile lobby ' + JSON.stringify(lb));
      await p.tap('#nameIn'); await p.page.keyboard.type(p.name); await p.tap('#codeIn'); await p.page.keyboard.type(code); await p.tap('#joinBtn');
      await p.waitFor(() => window.__pk.S && document.getElementById('lobby').classList.contains('hidden'));
    }
    await desk.waitFor(() => window.__pk.S.seats.filter(Boolean).length === 4);
    await sleep(200);
    for (const p of [ip, pl, sm]) {
      const r = await layoutCheck(p, 'waiting');
      const pods = await p.page.evaluate(() => [...document.querySelectorAll('#opps .pod')].map(e => { const b = e.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth; }));
      ok(pods.length === 3 && pods.every(Boolean), p.name + ' 3 compact opponent seats in view ' + JSON.stringify(pods));
      await sheetCheck(p);
    }
    await chatCheck(ip, desk); await chatCheck(pl, sm);
    for (let h = 0; h < TABLE_HANDS; h++) {
      await playHand([desk, ip, pl, sm], { shots: SH });
      // during the next hand's draw, opponents' mini seats show name, card backs and status
    }
    // mini seats content check during a draw
    await desk.page.keyboard.press('Enter');
    await ip.waitFor(() => window.__pk.S && window.__pk.S.ph === 'draw');
    const pod = await ip.page.evaluate(() => [...document.querySelectorAll('#opps .pod')].map(e => ({ name: e.querySelector('.who').textContent, backs: e.querySelectorAll('.card.down').length + e.querySelectorAll('.card.pubc').length, st: e.querySelector('.hn').textContent, tm: !!e.querySelector('.badge.tm') })));
    ok(pod.length === 3 && pod.every(x => x.name && x.backs === 5 && x.st), 'mini seats: name, 5 small cards, status ' + JSON.stringify(pod));
    ok(pod.some(x => x.tm) || (await ip.S()).turn === (await ip.S()).you, 'turn timer shown on the active mini seat');
    for (const p of [desk, ip, pl, sm]) ok(p.errors.length === 0, p.name + ' JS errors: ' + p.errors.join(' | ').slice(0, 300));
    for (const p of [desk, ip, pl, sm]) await p.ctx.close();
    console.log('  table done', JSON.stringify(stat));
  }

  // ---- A) solo vs Dealer on every profile, taps only
  for (const prof of PROFILES) {
    const p = await new P('Solo-' + prof.name.split('-')[0], prof).init();
    stat.profiles++;
    await p.tap('#nameIn'); await p.page.keyboard.type('Mo'); await p.tap('#createBtn');
    await p.waitFor(() => window.__pk.S && window.__pk.S.ph === 'wait');
    const pr = await p.page.textContent('#startBtn'); ok(/Play vs Dealer/.test(pr), prof.name + ' Play vs Dealer button');
    for (let h = 0; h < SOLO_HANDS; h++) await playHand([p], { shots: SOLO_SH });
    await sheetCheck(p);
    // rotate the device mid-game: layout must adapt without errors
    const vp = p.page.viewportSize();
    await p.page.setViewportSize({ width: vp.height, height: vp.width }); await sleep(250);
    await layoutCheck(p, 'rotated');
    await playHand([p], {});
    ok(p.errors.length === 0, prof.name + ' JS errors: ' + p.errors.join(' | ').slice(0, 300));
    await p.tap('#leaveBtn'); await sleep(200);
    await p.ctx.close();
  }

  // ---- desktop must still be the classic stage (no mobile classes, keys help visible and not clipped)
  {
    const d = await new P('Desk', null).init();
    const r = await d.page.evaluate(() => ({ mob: document.documentElement.classList.contains('mob'), tips: document.getElementById('tips').textContent, tr: document.getElementById('app').style.transform }));
    ok(!r.mob && /^Keys:/.test(r.tips) && /scale/.test(r.tr), 'desktop keeps the scaled stage + keys help ' + JSON.stringify(r));
    await d.ctx.close();
  }

  for (const v of [...Object.values(SH), ...Object.values(SOLO_SH)]) if (fs.existsSync(v.tmp)) { fs.copyFileSync(v.tmp, v.out); fs.unlinkSync(v.tmp); }
  await sleep(300);
  const st = await getStats(PORT);
  ok(st.errors === 0 && st.invariant === 0, 'server errors/invariants ' + JSON.stringify(st));
  const errs = srv.out.filter(l => l.startsWith('[stderr]')); ok(errs.length === 0, 'server stderr: ' + errs.join('').slice(0, 300));
  await browser.close(); srv.kill();
  console.log(JSON.stringify(stat));
  console.log(`mobile tests: ${pass} passed, ${failN} failed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  process.exit(failN ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); try { await browser.close(); } catch (x) { } process.exit(1); });
