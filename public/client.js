// POKER KING online — browser client. The server is authoritative; this file only renders
// the personalised state it receives and sends the player's choices.
(function () {
  'use strict';
  var E = window.PokerEval, $ = function (i) { return document.getElementById(i); };
  var SUITS = { s: '♠', h: '♥', d: '♦', c: '♣' }, RL = { T: '10' };
  var RNAME = { '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9', T: '10', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace' };
  var SNAME = { s: 'Spades', h: 'Hearts', d: 'Diamonds', c: 'Clubs' };
  var ws = null, S = null, me = -1, cursor = 0, wantClose = false, retry = 0, dlAt = 0, nxAt = 0, pending = 0, ladderOn = true;
  var prevK = {}, prevHand = -1, prevSub = null, prevOffer = null, inRoom = false, queued = null, retryTimer = null;
  var LOG = [];
  function rid() { var a = new Uint8Array(9); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }
  function store(k, v) { try { if (v == null) { sessionStorage.removeItem(k); localStorage.removeItem(k); } else { sessionStorage.setItem(k, v); localStorage.setItem(k, v); } } catch (e) { } }
  function load(k) { try { return sessionStorage.getItem(k) || localStorage.getItem(k); } catch (e) { return null; } }
  var tab; try { tab = sessionStorage.getItem('pkTab') || rid(); sessionStorage.setItem('pkTab', tab); } catch (e) { tab = rid(); }

  // ---------------- connection
  function wsUrl() { return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'; }
  function connect(first) {
    clearTimeout(retryTimer);
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) { if (ws.readyState === 1 && first) send(first); else if (first) queued = first; return; }
    queued = first || null;
    var sock = ws = new WebSocket(wsUrl());
    sock.onopen = function () {
      retry = 0;
      var tok = load('pkTok');
      if (inRoom && tok) send({ t: 'resume', tok: tok, tab: tab });
      if (queued) { send(queued); queued = null; }
    };
    sock.onmessage = function (ev) { var m; try { m = JSON.parse(ev.data); } catch (e) { return; } LOG.push(m.t); if (LOG.length > 200) LOG.shift(); onMsg(m); };
    sock.onclose = function () {
      if (sock !== ws) return;
      ws = null;
      if (inRoom && !wantClose) {
        banner('Connection lost — reconnecting…');
        retry++; retryTimer = setTimeout(function () { connect(); }, Math.min(5000, 500 * retry));
      }
    };
  }
  function send(m) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return true; } return false; }
  function onMsg(m) {
    switch (m.t) {
      case 'welcome':
        inRoom = true; wantClose = false; me = m.seat; banner(null);
        store('pkTok', m.tok); store('pkRoom', m.code); try { localStorage.setItem('pkName', m.name.replace(/ \d+$/, '')); } catch (e) { }
        $('lobby').classList.add('hidden'); $('code').textContent = m.code;
        try { history.replaceState(null, '', '?room=' + m.code); } catch (e) { }
        if (m.resumed) toast('Welcome back, ' + m.name + '! Your seat and cards were kept.');
        break;
      case 'hist': $('chatlog').innerHTML = ''; m.l.forEach(addChat); break;
      case 'chat': addChat(m); break;
      case 'st': onState(m); break;
      case 'err':
        if (!inRoom) $('lobbyMsg').textContent = m.m; else toast(m.m);
        break;
      case 'resume_fail':
        if (!m.inuse) { store('pkTok', null); store('pkRoom', null); }
        toLobby(m.m + (m.inuse ? ' You can join again as a new player.' : ''));
        break;
      case 'kicked': wantClose = true; toLobby(m.m); break;
      case 'left': toLobby(''); break;
    }
  }
  function toLobby(msg) {
    inRoom = false; S = null; me = -1; banner(null);
    $('lobby').classList.remove('hidden'); $('lobbyMsg').textContent = msg || '';
    if (load('pkRoom') && !$('codeIn').value) $('codeIn').value = load('pkRoom');
    setTimeout(function () { var n = $('nameIn'); if (!n.value) n.focus(); }, 0);
  }

  // ---------------- cards
  function cardEl(cs, down, anim, mini) {
    var e = document.createElement('div');
    e.className = 'card' + (mini ? ' mini' : '') + (down ? ' down' : '') + (anim ? ' dealt' : '');
    if (!cs) cs = '2s';
    var r = RL[cs[0]] || cs[0], s = SUITS[cs[1]], red = cs[1] === 'h' || cs[1] === 'd';
    if (!down) e.title = RNAME[cs[0]] + ' of ' + SNAME[cs[1]];
    var face = down ? '<div class="face"></div>' : '<div class="face' + (red ? ' red' : '') + '"><div class="c">' + r + '<br>' + s + '</div><div class="m">' + s + '</div><div class="c c2">' + r + '<br>' + s + '</div></div>';
    e.innerHTML = '<div class="inner">' + face + '<div class="back"></div></div>';
    return e;
  }
  function cardName(cs) { return (RL[cs[0]] || cs[0]) + SUITS[cs[1]]; }
  function parseCard(cs) { return { r: { T: 10, J: 11, Q: 12, K: 13, A: 14 }[cs[0]] || +cs[0], s: cs[1] }; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function safeColor(c) { return /^#[0-9a-fA-F]{6}$/.test(c || '') ? c : '#ffffff'; }

  // ---------------- state & rendering
  var SLOTS = { L2: [12, 280], L1: [12, 138], T1: [157, 6], T2: [374, 6], T3: [591, 6], R1: [736, 138], R2: [736, 280] };
  var LAYOUT = { 1: ['T2'], 2: ['T1', 'T3'], 3: ['L1', 'T2', 'R1'], 4: ['L1', 'T1', 'T3', 'R1'], 5: ['L1', 'T1', 'T2', 'T3', 'R1'], 6: ['L2', 'L1', 'T1', 'T3', 'R1', 'R2'], 7: ['L2', 'L1', 'T1', 'T2', 'T3', 'R1', 'R2'] };
  function onState(m) {
    var old = S; S = m; me = m.you; pending = 0;
    dlAt = performance.now() + (m.dl || 0); nxAt = performance.now() + (m.nx || 0);
    if (m.hn !== prevHand) { prevK = {}; prevHand = m.hn; }
    var myTurn = isMyTurn();
    if (myTurn && m.sub === 'select' && prevSub !== 'select') cursor = 0;
    prevSub = myTurn ? m.sub : null;
    render(old);
  }
  function isMyTurn() { return !!S && S.ph === 'draw' && S.turn === me && me >= 0; }
  function nm(s) { var q = S && S.seats[s]; return q ? q.n : 'A player'; }
  function resHand(s) { var q = S.seats[s]; if (!q || !S.res || !S.res.hands) return null; for (var i = 0; i < S.res.hands.length; i++) if (S.res.hands[i].s === s && S.res.hands[i].id === q.id) return S.res.hands[i]; return null; }
  var ORD = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
  function isWinner(s) { var h = resHand(s); return !!(h && S.res.win.indexOf(s) >= 0) || !!(S.res && S.res.walk && S.res.win.indexOf(s) >= 0); }
  function render() {
    if (!S) return;
    $('code').textContent = S.code; $('handn').textContent = S.hn; $('deckn').textContent = S.deck; $('discn').textContent = S.disc;
    renderOpps(); renderMe(); renderCenter(); renderScore(); renderLadder(); tick();
  }
  function badges(q, s, box) {
    if (S.btn === s && S.hn > 0) box.appendChild(el('span', 'badge btn', 'D')).title = 'Dealer button';
    if (S.host === s) box.appendChild(el('span', 'badge host', '★ Host'));
    if (!q.on) box.appendChild(el('span', 'badge off', 'offline'));
    else if (!q.ih && (S.ph === 'deal' || S.ph === 'draw')) box.appendChild(el('span', 'badge wait', 'next hand'));
    if (S.turn === s) { var t = el('span', 'badge tm tmr', ''); t.dataset.tm = 'dl'; box.appendChild(t); }
    else if (q.d && S.ph === 'draw') box.appendChild(el('span', 'badge done', '✓ done'));
  }
  function handRow(q, s, row, mini, res) {
    row.innerHTML = '';
    var k = q.k, pk = prevK[s] || 0;
    for (var i = 0; i < k; i++) {
      var cs = res ? res.cards[i] : (q.cards ? q.cards[i] : null);
      var c = cardEl(cs, !cs, i >= pk, mini);
      if (res && res.used.indexOf(i) >= 0) c.classList.add('hl');
      if (!res && cs && s !== me) c.classList.add('pubc'), c.title += ' (taken face up)';
      c.dataset.i = i; row.appendChild(c);
    }
    prevK[s] = k;
  }
  function renderOpps() {
    var box = $('opps'); box.innerHTML = '';
    var list = [];
    for (var k = 1; k < 8; k++) { var s = (me + k) % 8; if (S.seats[s]) list.push(s); }
    var lay = LAYOUT[list.length] || [];
    list.forEach(function (s, j) {
      var q = S.seats[s], pos = SLOTS[lay[j]], res = S.ph === 'show' ? resHand(s) : null;
      var pod = el('div', 'pod'); pod.style.left = pos[0] + 'px'; pod.style.top = pos[1] + 'px'; pod.dataset.seat = s;
      if (S.turn === s) pod.classList.add('turn');
      if (S.ph === 'show' && S.res && isWinner(s)) pod.classList.add('win');
      if (!q.on) pod.classList.add('off');
      var head = el('div', 'nm'); var who = el('span', 'who', q.n); who.style.color = safeColor(q.c); head.appendChild(who); badges(q, s, head); pod.appendChild(head);
      var row = el('div', 'row'); handRow(q, s, row, true, res); pod.appendChild(row);
      var hn = el('div', 'hn');
      if (res) { hn.appendChild(el('span', 'badge rk', ORD[res.rank])); hn.appendChild(document.createTextNode(' ' + res.hn)); hn.title = E.DESC[res.cat]; }
      else if (S.ph === 'draw' && q.ih) hn.textContent = S.turn === s ? 'Offer ' + Math.min(3, S.ofs + (S.sub === 'ask' ? 1 : 0)) + ' of 3' : (q.d ? 'Finished drawing' : 'Waiting to draw');
      else if (!q.ih && S.hn > 0 && S.ph !== 'show') hn.textContent = 'Joins next hand';
      else if (!q.ih && S.ph === 'wait') hn.textContent = 'Ready';
      pod.appendChild(hn);
      box.appendChild(pod);
    });
  }
  function renderMe() {
    var q = S.seats[me]; if (!q) return;
    var box = $('me'), head = $('mehead'); head.innerHTML = '';
    var who = el('span', 'who', q.n + ' (you)'); who.style.color = safeColor(q.c); head.appendChild(who); badges(q, me, head);
    var res = S.ph === 'show' ? resHand(me) : null, myTurn = isMyTurn(), sel = myTurn && S.sub === 'select';
    box.classList.toggle('turn', myTurn); box.classList.toggle('win', !!(S.ph === 'show' && S.res && isWinner(me)));
    var row = $('myhand'); handRow(q, me, row, false, res);
    row.classList.toggle('sel', sel);
    Array.prototype.forEach.call(row.children, function (c, i) {
      if (sel) c.classList.toggle('cur', i === cursor);
      c.onmousemove = function () { if (isMyTurn() && S.sub === 'select' && cursor !== i) { cursor = i; markCursor(); } };
      c.onclick = function () { if (isMyTurn() && S.sub === 'select') { cursor = i; act('swap', i); } };
    });
    var name = '', desc = '';
    if (res) { name = ORD[res.rank] + ' place — ' + res.hn; desc = E.DESC[res.cat]; }
    else if (q.cards && q.cards.length === 5) { var ev = E.evaluate(q.cards.map(parseCard)); name = 'You have: ' + ev.name; desc = E.DESC[ev.cat]; }
    else if (!q.ih && S.hn > 0 && S.ph !== 'show') name = 'You will be dealt in next hand';
    $('myname').textContent = name; $('mydesc').textContent = desc;
  }
  function markCursor() { Array.prototype.forEach.call($('myhand').children, function (c, i) { c.classList.toggle('cur', i === cursor); }); }
  function setPrompt(html, btns) {
    $('prompt').innerHTML = html; var bx = $('btns'); bx.innerHTML = '';
    (btns || []).forEach(function (b) { var e = el('button', null, b[0]); e.onclick = b[1]; if (b[2]) e.id = b[2]; bx.appendChild(e); });
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function lastText() {
    var L = S.last; if (!L || !S.seats[L.s] && L.s == null) return '';
    var n = esc(nm(L.s)), c = L.c ? cardName(L.c) : '';
    switch (L.a) {
      case 'new': return n + ' asked for a new card: ' + c;
      case 'stand': return n + ' stands (keeps their cards).';
      case 'discard': return n + ' discarded the ' + c + '.';
      case 'take': return n + ' took the ' + c + ', replacing card #' + (L.i + 1) + '.';
      case 'tstand': return n + ' ran out of time and stands.';
      case 'tdiscard': return n + ' ran out of time; the ' + c + ' was discarded.';
      case 'ostand': return n + ' is offline, so they stand.';
      case 'odiscard': return n + ' went offline; the ' + c + ' was discarded.';
    }
    return '';
  }
  function canStart() { if (!S || S.host !== me) return false; var n = 0; S.seats.forEach(function (q) { if (q && q.on) n++; }); return n >= 2; }
  function renderCenter() {
    var st = $('status'), center = $('center'), q = S.seats[me];
    var tp = S.turn >= 0 ? S.seats[S.turn] : null, myTurn = isMyTurn();
    center.classList.toggle('wide', S.ph === 'show' || S.ph === 'wait');
    // face-up offered card (public)
    var spot = $('newspot');
    if (S.offer !== prevOffer || !spot.firstChild) {
      spot.innerHTML = '';
      if (S.offer) spot.appendChild(cardEl(S.offer, false, true)); else spot.innerHTML = '<div class="slot">new card</div>';
      prevOffer = S.offer;
    }
    $('newcap').textContent = S.offer && tp ? (S.turn === me ? 'Your new card' : tp.n + "'s new card") : 'New card';
    var host = S.seats[S.host], hostName = host ? esc(host.n) : 'the host';
    if (S.ph === 'wait') {
      var n = S.seats.filter(Boolean).length;
      st.textContent = 'Waiting for players — ' + n + ' of 8 seated';
      if (S.nx) { st.appendChild(document.createTextNode(' · next hand in ')); var tw = el('span', 'tmr'); tw.dataset.tm = 'nx'; st.appendChild(tw); }
      if (S.host === me) {
        if (canStart()) setPrompt('<div class="q">Everyone here?</div>Start when you are ready. More friends can join any time with the invite link.', [['Start game (Enter)', startGame, 'startBtn']]);
        else setPrompt('<div class="q">You are the host.</div>Share the invite link or table code <b>' + esc(S.code) + '</b>. You need at least 2 players to start.', []);
      } else setPrompt('<div class="q">Waiting for ' + hostName + ' to start…</div>The host deals the first hand when everyone is ready.', []);
    } else if (S.ph === 'deal') {
      st.textContent = 'Hand #' + S.hn + ' — dealing one card at a time, starting left of ' + nm(S.btn) + ' (the dealer button)';
      setPrompt('<div class="q">Dealing…</div>' + (q && q.ih ? 'Only you can see your own cards.' : 'You will be dealt in next hand.'), []);
    } else if (S.ph === 'draw' && tp) {
      st.innerHTML = '';
      st.appendChild(document.createTextNode((myTurn ? 'Your turn' : tp.n + "'s turn") + ' · offer ' + Math.min(3, S.ofs + (S.sub === 'ask' ? 1 : 0)) + ' of 3 · '));
      var t = el('span', 'tmr'); t.dataset.tm = 'dl'; st.appendChild(t);
      var lt = lastText(), lastHtml = lt && !(S.last.a === 'new' && S.sub !== 'ask') ? '<div class="desc">' + lt + '</div>' : '';
      if (myTurn) {
        if (S.sub === 'ask') setPrompt('<div class="q">Do you want a new card? (Y/N)</div>Offer ' + (S.ofs + 1) + ' of 3. Saying No means you stand with these cards.' + lastHtml, [['Yes (Y)', function () { act('new'); }, 'yesBtn'], ['No (N) — Stand', function () { act('stand'); }, 'noBtn']]);
        else if (S.sub === 'take') setPrompt('<div class="q">Take this card? (Y/N)</div>Everyone can see it. If you take it, you choose which of your cards to replace.', [['Yes (Y) — choose a card', function () { act('sel'); }, 'yesBtn'], ['No (N) — Discard', function () { act('discard'); }, 'noBtn']]);
        else setPrompt('<div class="q">Choose a card to replace</div>Arrows/Tab or mouse to choose · Enter/click to swap · Esc to cancel', [['Cancel (Esc)', function () { act('cancel'); }, 'cancelBtn']]);
      } else {
        var who = esc(tp.n), what = S.sub === 'ask' ? who + ' is deciding whether to ask for a new card…' : S.sub === 'take' ? who + ' is deciding whether to take the ' + cardName(S.offer) + '…' : who + ' is choosing which card to replace with the ' + cardName(S.offer) + '…';
        setPrompt('<div class="q">' + what + '</div>' + (q && !q.ih ? 'You will be dealt in next hand. ' : '') + lastHtml, []);
      }
    } else if (S.ph === 'show' && S.res) {
      st.innerHTML = ''; st.appendChild(document.createTextNode('Hand #' + S.hn + ' — showdown'));
      if (S.nx) { st.appendChild(document.createTextNode(' · next hand in ')); var t2 = el('span', 'tmr'); t2.dataset.tm = 'nx'; st.appendChild(t2); }
      var b = [];
      if (S.host === me && canStart()) b.push(['Deal next hand (Enter)', startGame, 'startBtn']);
      setPrompt('<div class="res">' + esc(S.res.head) + '</div><div class="exp">' + esc(S.res.text) + '</div>' + (S.host !== me ? '<div class="desc">' + hostName + ' (host) deals the next hand.</div>' : ''), b);
    }
  }
  function renderScore() {
    var box = $('score'); box.innerHTML = '';
    var list = [];
    S.seats.forEach(function (q, s) { if (q) list.push([q, s]); });
    list.sort(function (a, b) { return b[0].w - a[0].w || b[0].sp - a[0].sp || a[1] - b[1]; });
    list.forEach(function (x) {
      var r = el('div', 'sr' + (x[1] === me ? ' me' : '')), n = el('span', 'nm', x[0].n + (x[1] === me ? ' (you)' : ''));
      n.style.color = safeColor(x[0].c); r.appendChild(n);
      var v = el('span'); v.appendChild(el('b', null, String(x[0].w))); v.appendChild(document.createTextNode(' won' + (x[0].sp ? ' · ' + x[0].sp + ' split' : '')));
      r.appendChild(v); box.appendChild(r);
    });
  }
  function ladderHTML(youCat, winCat) {
    var h = '<h3>Hand Rankings (best to worst)</h3>';
    for (var c = 9; c >= 0; c--) {
      var ex = E.EXAMPLES[c].replace(/(\S+[♥♦])/g, '<span class="r">$1</span>');
      h += '<div class="lr' + (c === youCat ? ' hp' : '') + (c === winCat ? ' hd' : '') + '" title="' + E.DESC[c] + '"><span>' + (10 - c) + '. ' + E.CATS[c] +
        (c === youCat ? '<span class="tag tp">YOU</span>' : '') + (c === winCat ? '<span class="tag td">WIN</span>' : '') + '</span><span class="ex">' + ex + '</span></div>';
    }
    return h;
  }
  function renderLadder() {
    var you = -1, win = -1, q = S && S.seats[me];
    if (S && S.ph === 'show' && S.res && S.res.hands && S.res.hands.length) { win = S.res.hands[0].cat; var mh = resHand(me); if (mh) you = mh.cat; }
    else if (q && q.cards && q.cards.length === 5) you = E.evaluate(q.cards.map(parseCard)).cat;
    var key = you + ',' + win;
    if ($('ladder').dataset.k !== key) { $('ladder').innerHTML = ladderHTML(you, win); $('ladder').dataset.k = key; }
  }
  function toggleLadder(force) {
    ladderOn = force !== undefined ? force : !ladderOn;
    $('ladder').classList.toggle('hidden', !ladderOn); $('ladder2').classList.toggle('hidden', !ladderOn);
  }
  function tick() {
    var now = performance.now();
    Array.prototype.forEach.call(document.querySelectorAll('[data-tm]'), function (e) {
      var ms = e.dataset.tm === 'nx' ? nxAt - now : dlAt - now, s = Math.max(0, Math.ceil(ms / 1000));
      e.textContent = '⏱ ' + s + 's';
    });
  }
  setInterval(tick, 250);

  // ---------------- actions
  function act(a, i) {
    if (!isMyTurn() || pending) return;
    pending = setTimeout(function () { pending = 0; }, 1500);
    var m = { t: 'act', a: a }; if (i !== undefined) m.i = i;
    send(m);
  }
  function startGame() { if (canStart() && (S.ph === 'wait' || S.ph === 'show')) send({ t: 'start' }); }

  // ---------------- chat
  function addChat(m) {
    var log = $('chatlog'), atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
    var d = el('div', 'msg'), t = new Date(m.ts);
    d.appendChild(el('span', 'ts', ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2)));
    if (m.sys) d.appendChild(el('span', 'sys', m.m));
    else { var w = el('span', 'who', m.n + ':'); w.style.color = safeColor(m.c); d.appendChild(w); d.appendChild(el('span', 'txt', m.m)); }
    log.appendChild(d);
    while (log.children.length > 150) log.removeChild(log.firstChild);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  $('chatform').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('chatin').value.trim(); if (!v) return;
    if (send({ t: 'chat', m: v.slice(0, 200) })) { $('chatin').value = ''; $('chatcount').textContent = '0/200'; }
    else toast('Not connected — message not sent.');
  });
  $('chatin').addEventListener('input', function () { $('chatcount').textContent = this.value.length + '/200'; });

  // ---------------- keyboard (never while typing in a text box)
  document.addEventListener('keydown', function (e) {
    var t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) {
      if (e.key === 'Escape' && t.blur) t.blur();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key.toLowerCase();
    if (k === 'enter' || k === ' ') { e.preventDefault(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }
    if (!$('lobby').classList.contains('hidden')) { if (k === 'h') toggleLadder(); return; }
    if (k === 'h') { toggleLadder(); return; }
    if (!S) return;
    if (isMyTurn()) {
      if (S.sub === 'ask') { if (k === 'y') act('new'); else if (k === 'n') act('stand'); }
      else if (S.sub === 'take') { if (k === 'y') act('sel'); else if (k === 'n') act('discard'); }
      else if (S.sub === 'select') {
        if (k === 'arrowright' || (k === 'tab' && !e.shiftKey)) { e.preventDefault(); cursor = (cursor + 1) % 5; markCursor(); }
        else if (k === 'arrowleft' || (k === 'tab' && e.shiftKey)) { e.preventDefault(); cursor = (cursor + 4) % 5; markCursor(); }
        else if (k === 'enter') act('swap', cursor);
        else if (k === 'escape') act('cancel');
      }
    } else if (k === 'enter' && (S.ph === 'wait' || S.ph === 'show')) startGame();
  });

  // ---------------- lobby
  function nameVal() { var n = $('nameIn').value.trim(); if (!n) { $('lobbyMsg').textContent = 'Please enter a display name first.'; $('nameIn').focus(); } return n; }
  $('createBtn').onclick = function () { var n = nameVal(); if (!n) return; $('lobbyMsg').textContent = 'Creating table…'; wantClose = false; connect({ t: 'create', name: n, tab: tab }); };
  function doJoin() {
    var n = nameVal(); if (!n) return;
    var c = $('codeIn').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(c)) { $('lobbyMsg').textContent = 'Table codes are 5 letters/numbers, e.g. K7PQX.'; $('codeIn').focus(); return; }
    $('lobbyMsg').textContent = 'Joining table ' + c + '…'; wantClose = false; connect({ t: 'join', room: c, name: n, tab: tab });
  }
  $('joinBtn').onclick = doJoin;
  $('codeIn').addEventListener('keydown', function (e) { if (e.key === 'Enter') doJoin(); });
  $('nameIn').addEventListener('keydown', function (e) { if (e.key === 'Enter') { if ($('codeIn').value.trim()) doJoin(); else $('createBtn').click(); } });
  $('copyBtn').onclick = function () {
    if (!S) return;
    var link = location.origin + '/?room=' + S.code;
    var done = function () { toast('Invite link copied: ' + link); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, function () { toast('Share this link: ' + link); });
    else toast('Share this link: ' + link);
  };
  $('leaveBtn').onclick = function () { if (!inRoom) return; send({ t: 'leave' }); store('pkTok', null); store('pkRoom', null); try { history.replaceState(null, '', '/'); } catch (e) { } toLobby('You left the table.'); };
  $('hrBtn').onclick = function () { toggleLadder(); };

  var toastT = null;
  function toast(m) { var t = $('toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.add('hidden'); }, 3500); }
  function banner(m) { var b = $('banner'); if (m) { b.textContent = m; b.classList.remove('hidden'); } else b.classList.add('hidden'); }
  function fit() { var k = Math.min(innerWidth / 1280, innerHeight / 720); $('app').style.transform = 'translate(' + (innerWidth - 1280 * k) / 2 + 'px,' + (innerHeight - 720 * k) / 2 + 'px) scale(' + k + ')'; }
  addEventListener('resize', fit); fit();
  $('ladder2').innerHTML = ladderHTML(-1, -1); $('ladder').innerHTML = ladderHTML(-1, -1);
  $('tips').innerHTML = '<b>Keys:</b> Y / N answer · ← → or Tab choose a card · Enter confirm · Esc go back · H show/hide rankings. Typing in the chat box never triggers game keys.';

  // ---------------- boot
  try { $('nameIn').value = localStorage.getItem('pkName') || ''; } catch (e) { }
  var qs = /[?&]room=([A-Za-z0-9]{5})/.exec(location.search), want = qs ? qs[1].toUpperCase() : null;
  if (want) $('codeIn').value = want;
  var tok = load('pkTok'), troom = load('pkRoom');
  if (tok && (!want || want === troom)) { inRoom = true; $('lobby').classList.add('hidden'); banner('Reconnecting to your table…'); connect(); }
  else toLobby('');
  window.__pk = { get S() { return S; }, get cursor() { return cursor; }, get me() { return me; }, get ws() { return ws; }, log: LOG };
})();
