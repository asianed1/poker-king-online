'use strict';
// One poker table. Server-authoritative: deck, shuffle, dealing, turn order, timers and
// showdown all live here. Clients only ever receive personalised views (see view()).
const crypto = require('crypto');
const { freshDeck, shuffle, str } = require('./cards');
const { buildResult } = require('./explain');

const MAX_SEATS = 8, MAX_OFFERS = 3, CHAT_KEEP = 100, CHAT_MAX = 200;
const COLORS = ['#ffd54a', '#5ad1ff', '#ff8a8a', '#9dff7a', '#d59bff', '#ffb35a', '#7affd9', '#ff9ad5'];

class Room {
  constructor(code, cfg, hooks) {
    this.code = code; this.cfg = cfg; this.hooks = hooks;
    this.seats = new Array(MAX_SEATS).fill(null);
    this.host = -1; this.phase = 'wait'; this.button = -1; this.handNo = 0;
    this.deck = []; this.discards = []; this.offer = null;
    this.order = []; this.ti = -1; this.sub = null; this.dl = 0; this.dlFull = 0;
    this.timer = null; this.tseq = 0; this.nextTimer = null; this.nextAt = 0;
    this.dealQ = []; this.result = null; this.last = null;
    this.chat = []; this.chatId = 0; this.pid = 0; this.dead = false; this.created = Date.now();
    this.dealerW = 0; this.dealerS = 0; // the computer Dealer's scoreboard survives it stepping aside
  }
  players() { return this.seats.filter(Boolean); }
  count() { return this.players().length; }
  humans() { return this.players().filter(q => !q.bot); }
  dealer() { return this.players().find(q => q.bot) || null; }
  alive(p) { return !!p && p.inHand && this.seats[p.seat] === p; }
  turnPlayer() { return this.phase === 'draw' && this.ti >= 0 ? this.order[this.ti] : null; }

  // ---------- timers (every callback is guarded by a sequence number so stale timers are no-ops)
  setTimer(ms, fn) {
    clearTimeout(this.timer);
    const seq = ++this.tseq;
    this.timer = setTimeout(() => {
      if (this.dead || seq !== this.tseq) return;
      this.timer = null;
      this.safe(fn);
    }, Math.max(0, ms));
  }
  clearTimer() { clearTimeout(this.timer); this.timer = null; this.tseq++; }
  safe(fn) { try { fn(); } catch (e) { this.hooks.error(e); } }

  // ---------- messaging
  send(p, msg) { if (p && p.connected && p.ws) this.hooks.send(p.ws, msg); }
  broadcast() { if (this.dead) return; this.check(); for (const p of this.players()) if (p.connected) this.send(p, this.view(p)); }
  pushChat(entry) {
    entry.id = ++this.chatId; entry.ts = Date.now();
    this.chat.push(entry); if (this.chat.length > CHAT_KEEP) this.chat.shift();
    const msg = Object.assign({ t: 'chat' }, entry);
    for (const p of this.players()) if (p.connected) this.send(p, msg);
  }
  sys(m) { this.pushChat({ sys: 1, m }); }
  chatMsg(p, raw) {
    if (typeof raw !== 'string') return;
    const m = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
    if (!m) return;
    const now = Date.now();
    p.chatTimes = p.chatTimes.filter(t => now - t < this.cfg.chatWindowMs);
    if (p.chatTimes.length >= this.cfg.chatMax) {
      this.send(p, { t: 'err', code: 'slow', m: 'Whoa, slow down! You can send up to ' + this.cfg.chatMax + ' messages every ' + Math.round(this.cfg.chatWindowMs / 1000) + ' seconds.' });
      return;
    }
    p.chatTimes.push(now);
    this.pushChat({ n: p.name, c: p.color, m });
  }

  // ---------- personalised state snapshot (the ONLY place hidden cards leave the server)
  view(p) {
    const now = Date.now(), tp = this.turnPlayer();
    return {
      t: 'st', code: this.code, ph: this.phase, you: p.seat, host: this.host, btn: this.button, hn: this.handNo,
      turn: tp ? tp.seat : -1, sub: tp ? this.sub : null, ofs: tp ? tp.offers : 0,
      offer: this.offer ? str(this.offer) : null,
      dl: tp ? Math.max(0, this.dl - now) : 0,
      nx: (this.phase === 'show' || this.phase === 'wait') && this.nextAt ? Math.max(0, this.nextAt - now) : 0,
      deck: this.deck.length, disc: this.discards.length, last: this.last,
      seats: this.seats.map(q => {
        if (!q) return null;
        const o = { id: q.id, n: q.name, c: q.color, on: q.connected ? 1 : 0, ih: q.inHand ? 1 : 0, k: q.hand.length, d: q.done ? 1 : 0, w: q.wins, sp: q.splits };
        if (q.bot) o.b = 1; // the computer Dealer (its cards stay hidden like anyone else's)
        if (q === p) o.cards = q.hand.map(str);
        else if (q.inHand && q.pub.size) o.cards = q.hand.map((c, i) => q.pub.has(i) ? str(c) : null); // face-up cards taken from the table
        return o;
      }),
      res: this.phase === 'show' ? this.result : null
    };
  }

  // ---------- joining / leaving / reconnecting
  join(name, ws, tab) {
    if (this.humans().length >= MAX_SEATS) return null;
    // humans always take priority: if the computer Dealer holds the last free seat, it steps aside
    if (this.count() >= MAX_SEATS && this.dealer()) this.leave(this.dealer(), 'dealer');
    const seat = this.seats.indexOf(null);
    let n = name, k = 2;
    const taken = new Set(this.players().map(q => q.name.toLowerCase())); taken.add('dealer'); // "Dealer" is reserved for the computer
    while (taken.has(n.toLowerCase())) n = name.slice(0, 13) + ' ' + (k++);
    const p = {
      token: crypto.randomBytes(18).toString('base64url'), id: ++this.pid, name: n, seat, color: COLORS[seat], ws, tab, connected: true,
      hand: [], pub: new Set(), inHand: false, done: false, offers: 0, wins: 0, splits: 0, chatTimes: [], expire: null, room: this
    };
    this.seats[seat] = p;
    if (this.host < 0 || !this.seats[this.host]) this.host = seat;
    this.hooks.onJoin(p, ws);
    this.send(p, { t: 'welcome', tok: p.token, code: this.code, seat, name: n });
    this.send(p, { t: 'hist', l: this.chat });
    const mid = this.phase === 'deal' || this.phase === 'draw';
    this.sys(n + ' joined the table' + (mid ? ' and will be dealt in next hand.' : '.'));
    this.maybeAutoStart();
    this.broadcast();
    return p;
  }
  reconnect(p, ws, tab) {
    if (p.ws && p.ws !== ws) { this.hooks.send(p.ws, { t: 'kicked', m: 'This seat was opened in another window.' }); this.hooks.detach(p.ws); }
    const wasOff = !p.connected;
    p.ws = ws; p.tab = tab; p.connected = true;
    clearTimeout(p.expire); p.expire = null;
    this.hooks.onJoin(p, ws);
    if (this.turnPlayer() === p && this.dlFull > this.dl) { this.dl = this.dlFull; this.setTimer(this.dl - Date.now(), () => this.timeout()); }
    this.send(p, { t: 'welcome', tok: p.token, code: this.code, seat: p.seat, name: p.name, resumed: 1 });
    this.send(p, { t: 'hist', l: this.chat });
    if (wasOff) this.sys(p.name + ' reconnected.');
    this.maybeAutoStart();
    this.broadcast();
  }
  disconnect(p, ws) {
    if (p.ws !== ws || !p.connected || this.seats[p.seat] !== p) return;
    p.connected = false; p.ws = null;
    clearTimeout(p.expire);
    p.expire = setTimeout(() => this.safe(() => this.leave(p, 'timeout')), this.cfg.reconnectMs);
    if (this.turnPlayer() === p) {
      // short grace period to come back during your own turn, then the turn auto-stands
      this.dl = Math.min(this.dl, Date.now() + this.cfg.dcGraceMs);
      this.setTimer(this.dl - Date.now(), () => this.timeout());
    }
    this.sys(p.name + ' lost connection. Their seat is held for ' + Math.round(this.cfg.reconnectMs / 1000) + ' seconds.');
    this.broadcast();
  }
  leave(p, why) {
    if (this.dead || this.seats[p.seat] !== p) return;
    clearTimeout(p.expire); p.expire = null;
    const wasTurn = this.turnPlayer() === p;
    const midHand = this.phase === 'deal' || this.phase === 'draw';
    if (p.inHand) {
      this.discards.push(...p.hand);               // folded cards go to the discard pile
      if (wasTurn && this.offer) { this.discards.push(this.offer); this.offer = null; }
    }
    p.hand = []; p.pub.clear(); p.inHand = false;
    this.seats[p.seat] = null;
    if (p.bot) { this.dealerW = p.wins; this.dealerS = p.splits; } else this.hooks.onLeave(p);
    if (p.ws) { const ws = p.ws; p.ws = null; p.connected = false; this.hooks.detach(ws, why !== 'left'); }
    this.sys(p.bot ? 'The Dealer (computer) leaves the table' + (this.humans().length > 1 ? ' — now it\'s humans only.' : '.')
      : p.name + (why === 'timeout' ? ' did not come back in time and left the table.' : ' left the table.'));
    if (this.humans().length === 0) return this.destroy();
    if (this.host === p.seat) {
      this.host = this.nextHost(p.seat);
      this.sys(this.seats[this.host].name + ' is now the host.');
    }
    if (midHand) {
      const left = this.order.filter(q => this.alive(q));
      if (left.length < 2) return this.walkover(left);
      if (wasTurn) return this.endTurn(p, true);
    }
    this.broadcast();
  }
  // host passes clockwise to the next seated player, preferring someone who is online
  nextHost(from) {
    let any = -1;
    for (let k = 1; k <= MAX_SEATS; k++) {
      const s = (from + k) % MAX_SEATS, q = this.seats[s];
      if (q && !q.bot && q.connected) return s;
      if (q && !q.bot && any < 0) any = s;
    }
    return any;
  }
  destroy() {
    if (this.dead) return;
    this.dead = true; this.clearTimer(); clearTimeout(this.nextTimer); this.nextTimer = null;
    for (const p of this.seats) if (p) { clearTimeout(p.expire); if (!p.bot) this.hooks.onLeave(p); }
    this.seats.fill(null);
    this.hooks.onEmpty(this);
  }

  // ---------- hand flow
  start(p) {
    if (p.seat !== this.host) return this.send(p, { t: 'err', code: 'host', m: 'Only the host can start the game.' });
    if (this.phase === 'deal' || this.phase === 'draw') return;
    if (this.humans().length === 1 && !this.dealer()) this.addDealer(); // alone at the table: play against the computer Dealer
    if (!this.startHand()) this.send(p, { t: 'err', code: 'few', m: 'You need at least 2 connected players to start.' });
  }
  addDealer() {
    let seat = -1;
    for (let k = 1; k <= MAX_SEATS; k++) { const s = (this.host + k) % MAX_SEATS; if (!this.seats[s]) { seat = s; break; } }
    if (seat < 0) return null;
    const d = {
      bot: 1, token: null, id: ++this.pid, name: 'Dealer', seat, color: '#c9d3dc', ws: null, tab: '', connected: true,
      hand: [], pub: new Set(), inHand: false, done: false, offers: 0, wins: this.dealerW, splits: this.dealerS, chatTimes: [], expire: null, room: this
    };
    this.seats[seat] = d;
    this.sys('The Dealer (computer) sits down so you can play right away. Friends can still join with the invite link — the Dealer steps aside when a second player arrives.');
    return d;
  }
  startHand() {
    // the Dealer only plays with exactly one human; it leaves at the start of the next hand once a second human is seated
    if (this.dealer() && this.humans().length >= 2) this.leave(this.dealer(), 'dealer');
    const hum = this.humans().filter(q => q.connected), d = this.dealer();
    if (hum.length < 2 && !(d && hum.length === 1)) return false;
    const elig = this.players().filter(q => q.connected);
    clearTimeout(this.nextTimer); this.nextTimer = null; this.nextAt = 0;
    // dealer button moves one seat clockwise each hand (skipping empty/offline seats)
    let b = -1;
    if (this.button < 0) b = (this.seats[this.host] && this.seats[this.host].connected) ? this.host : elig[0].seat;
    else for (let k = 1; k <= MAX_SEATS; k++) { const s = (this.button + k) % MAX_SEATS; const q = this.seats[s]; if (q && q.connected) { b = s; break; } }
    this.button = b;
    this.order = [];
    for (let k = 1; k <= MAX_SEATS; k++) { const q = this.seats[(b + k) % MAX_SEATS]; if (q && q.connected) this.order.push(q); } // left of button first, button last
    for (const q of this.players()) { q.inHand = false; q.hand = []; q.pub = new Set(); q.done = false; q.offers = 0; }
    for (const q of this.order) { q.inHand = true; if (q.bot) q.done = true; } // the Dealer never draws: it always stands
    this.deck = shuffle(freshDeck()); this.discards = []; this.offer = null; this.result = null; this.last = null;
    this.handNo++; this.ti = -1; this.sub = null; this.phase = 'deal';
    this.dealQ = [];
    for (let r = 0; r < 5; r++) for (const q of this.order) this.dealQ.push(q);
    this.sys('Hand #' + this.handNo + ' — ' + (this.seats[b].bot ? 'the Dealer (computer)' : this.seats[b].name) + ' has the dealer button. A fresh deck is shuffled and dealt one card at a time, starting to the left of the button.');
    this.broadcast();
    this.setTimer(this.cfg.dealMs, () => this.dealStep());
    return true;
  }
  dealStep() {
    while (this.dealQ.length) {
      const q = this.dealQ.shift();
      if (!this.alive(q)) continue;
      q.hand.push(this.draw());
      this.broadcast();
      if (this.dealQ.some(x => this.alive(x))) this.setTimer(this.cfg.dealMs, () => this.dealStep());
      else this.setTimer(this.cfg.dealMs, () => this.beginDraw());
      return;
    }
    this.beginDraw();
  }
  beginDraw() { this.phase = 'draw'; this.ti = -1; this.nextTurn(); }
  nextTurn() {
    for (let i = this.ti + 1; i < this.order.length; i++) {
      const q = this.order[i];
      if (this.alive(q) && !q.done) { this.ti = i; return this.beginTurn(q); }
    }
    this.showdown();
  }
  beginTurn(q) { this.sub = 'ask'; this.offer = null; q.offers = 0; this.startDecision(q); this.broadcast(); }
  startDecision(q) {
    const now = Date.now();
    this.dlFull = now + this.cfg.turnMs;
    this.dl = q.connected ? this.dlFull : Math.min(this.dlFull, now + this.cfg.autoStandMs); // offline player auto-stands
    this.setTimer(this.dl - now, () => this.timeout());
  }
  draw() {
    if (!this.deck.length) {
      const n = this.discards.length;
      this.deck = shuffle(this.discards); this.discards = [];
      this.sys('The deck ran out, so the ' + n + ' discarded cards were shuffled together to make a new deck.');
    }
    return this.deck.pop();
  }
  act(p, a, i) {
    const tp = this.turnPlayer();
    if (!tp || tp !== p) return this.send(p, { t: 'err', code: 'turn', m: 'Please wait for your turn.' });
    const sub = this.sub;
    if (a === 'new' && sub === 'ask' && p.offers < MAX_OFFERS) {
      this.offer = this.draw(); p.offers++; this.sub = 'select'; this.startDecision(p); // straight to choosing a card to replace
      this.last = { s: p.seat, a: 'new', c: str(this.offer) };
    } else if (a === 'stand' && sub === 'ask') {
      this.last = { s: p.seat, a: 'stand' };
      return this.endTurn(p);
    } else if (a === 'reject' && sub === 'select') {
      this.last = { s: p.seat, a: 'reject', c: str(this.offer) };
      this.discards.push(this.offer); this.offer = null;
      return this.afterOffer(p);
    } else if (a === 'swap' && sub === 'select' && Number.isInteger(i) && i >= 0 && i < p.hand.length) {
      this.last = { s: p.seat, a: 'take', c: str(this.offer), i };
      this.discards.push(p.hand[i]); p.hand[i] = this.offer; p.pub.add(i); this.offer = null;
      return this.afterOffer(p);
    } else return; // invalid / duplicate / out-of-state / retired ('sel', 'cancel', 'discard') action: ignore silently
    this.broadcast();
  }
  afterOffer(p) {
    if (p.offers >= MAX_OFFERS) return this.endTurn(p);
    this.sub = 'ask'; this.startDecision(p); this.broadcast();
  }
  endTurn(p, gone) {
    if (!gone) p.done = true;
    if (this.offer) { this.discards.push(this.offer); this.offer = null; }
    this.sub = null; this.clearTimer();
    this.nextTurn();
  }
  timeout() {
    const p = this.turnPlayer(); if (!p) return;
    if (this.sub === 'ask') this.last = { s: p.seat, a: p.connected ? 'tstand' : 'ostand' };
    else this.last = { s: p.seat, a: p.connected ? 'treject' : 'oreject', c: this.offer ? str(this.offer) : null };
    this.endTurn(p); // timing out while choosing a card rejects the new card and ends the turn
  }
  showdown() {
    this.clearTimer(); this.phase = 'show'; this.sub = null; this.ti = -1;
    const live = this.order.filter(q => this.alive(q));
    this.result = buildResult(live.map(q => ({ seat: q.seat, id: q.id, name: q.name, ref: q.bot ? 'the Dealer' : undefined, color: q.color, cards: q.hand })));
    const ws = live.filter(q => this.result.win.includes(q.seat));
    for (const q of ws) { if (ws.length === 1) q.wins++; else q.splits++; }
    this.sys('Hand #' + this.handNo + ': ' + this.result.text);
    this.scheduleNext();
    this.broadcast();
  }
  walkover(left) {
    this.clearTimer();
    if (this.offer) { this.discards.push(this.offer); this.offer = null; }
    this.phase = 'show'; this.sub = null; this.ti = -1; this.dealQ = [];
    const q = left[0] && !left[0].bot ? left[0] : null; // the Dealer never wins by default: the hand is just cancelled
    this.result = q
      ? { walk: 1, hands: [], win: [q.seat], head: q.name + ' wins by default', text: 'Everyone else left this hand, so ' + q.name + ' is the last player in it. Hands won by default are not counted on the scoreboard.' }
      : { walk: 1, hands: [], win: [], head: 'Hand cancelled', text: left.length ? 'Only the Dealer was left in this hand, so it was cancelled.' : 'Everyone left this hand.' };
    this.sys('Hand #' + this.handNo + ': ' + this.result.text);
    this.scheduleNext();
    this.broadcast();
  }
  scheduleNext() {
    clearTimeout(this.nextTimer);
    this.nextAt = Date.now() + this.cfg.nextMs;
    this.nextTimer = setTimeout(() => this.safe(() => {
      this.nextTimer = null; this.nextAt = 0;
      if (this.dead || (this.phase !== 'show' && this.phase !== 'wait')) return;
      if (!this.startHand()) this.toWait(); // not enough players: back to the waiting room
    }), this.cfg.nextMs);
  }
  toWait() {
    if (this.dealer()) this.leave(this.dealer(), 'dealer');
    if (this.dead) return;
    this.phase = 'wait'; this.result = null; this.offer = null; this.sub = null; this.ti = -1; this.order = [];
    for (const q of this.players()) { q.inHand = false; q.hand = []; q.pub = new Set(); q.done = false; q.offers = 0; }
    this.broadcast();
  }
  // after the first hand, the table keeps going on its own once 2+ players are connected again
  maybeAutoStart() {
    if (this.phase === 'wait' && this.handNo > 0 && !this.nextTimer && this.humans().filter(q => q.connected).length >= 2) this.scheduleNext();
  }

  // ---------- invariant: all 52 cards accounted for, exactly once
  check() {
    if (this.phase === 'wait' || this.handNo === 0) return true;
    const all = this.deck.concat(this.discards, this.offer ? [this.offer] : []);
    for (const q of this.order) if (this.alive(q)) all.push(...q.hand);
    const set = new Set(all.map(str));
    if (all.length !== 52 || set.size !== 52) {
      this.hooks.invariant('card conservation broken in room ' + this.code + ': ' + all.length + ' cards, ' + set.size + ' unique (phase ' + this.phase + ')');
      return false;
    }
    return true;
  }
}
module.exports = { Room, MAX_SEATS, MAX_OFFERS, COLORS };
