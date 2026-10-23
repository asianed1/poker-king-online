'use strict';
// POKER KING online — HTTP static server + WebSocket game server (single process, in-memory rooms).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Room, MAX_SEATS } = require('./lib/room');

const num = (v, d) => (v !== undefined && v !== '' && isFinite(+v) ? +v : d);
const cfg = {
  port: num(process.env.PORT, 3000),
  turnMs: num(process.env.TURN_SECONDS, 45) * 1000,          // per decision
  reconnectMs: num(process.env.RECONNECT_SECONDS, 60) * 1000, // seat held after disconnect
  dcGraceMs: num(process.env.DISCONNECT_TURN_GRACE_SECONDS, 15) * 1000, // during own turn
  autoStandMs: num(process.env.AUTO_STAND_MS, 1500),          // turn reaches an offline player
  nextMs: num(process.env.NEXT_HAND_SECONDS, 40) * 1000,      // auto next hand after showdown
  dealMs: num(process.env.DEAL_MS, 160),                      // delay between dealt cards
  chatMax: 5, chatWindowMs: 5000,
  testHooks: process.env.TEST_HOOKS === '1'
};
const stats = { errors: 0, invariant: 0, badMsgs: 0, rateDropped: 0, roomsCreated: 0, msgsOut: 0, bytesOut: 0, invariantMsgs: [] };
const rooms = new Map();     // code -> Room
const sessions = new Map();  // token -> player

function sendWs(ws, msg) {
  if (!ws || ws.readyState !== 1) return;
  const s = JSON.stringify(msg);
  stats.msgsOut++; stats.bytesOut += s.length;
  ws.send(s);
}
const hooks = {
  send: sendWs,
  onJoin(p, ws) { sessions.set(p.token, p); ws.player = p; },
  onLeave(p) { sessions.delete(p.token); },
  detach(ws, close = true) { ws.player = null; if (close) try { ws.close(4000, 'detached'); } catch (e) { /* ignore */ } },
  onEmpty(room) { rooms.delete(room.code); },
  error(e) { stats.errors++; console.error('[error]', e && e.stack || e); },
  invariant(m) { stats.invariant++; if (stats.invariantMsgs.length < 20) stats.invariantMsgs.push(m); console.error('[INVARIANT]', m); }
};

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
function newCode() {
  for (;;) {
    let c = ''; for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
function cleanName(n) {
  if (typeof n !== 'string') return '';
  return n.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16).trim();
}
const cleanTab = t => (typeof t === 'string' ? t.slice(0, 40) : '');

// ---------- static files (fixed whitelist: no path traversal possible)
const PUB = path.join(__dirname, 'public');
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/client.js': ['client.js', 'application/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/evaluator.js': ['evaluator.js', 'application/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml']
};
const cache = {};
function file(name) { if (!cache[name] || cfg.testHooks) cache[name] = fs.readFileSync(path.join(PUB, name)); return cache[name]; }
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (cfg.testHooks && url === '/__test/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const roomsDetail = [...rooms.values()].map(r => ({ code: r.code, ph: r.phase, hn: r.handNo, players: r.players().map(p => p.name + (p.connected ? '' : '(off)')) }));
    return res.end(JSON.stringify(Object.assign({ roomsDetail, rooms: rooms.size, sessions: sessions.size, sockets: wss.clients.size, mem: process.memoryUsage().heapUsed }, stats)));
  }
  const f = FILES[url];
  if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  res.writeHead(200, {
    'Content-Type': f[1], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'"
  });
  res.end(req.method === 'HEAD' ? undefined : file(f[0]));
});

// ---------- websockets
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 }); // oversized frames close the socket (1009)
wss.on('connection', ws => {
  ws.isAlive = true; ws.player = null; ws.win = Date.now(); ws.cnt = 0; ws.strikes = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => {
    try { handle(ws, data, isBinary); } catch (e) { hooks.error(e); }
  });
  ws.on('close', () => {
    const p = ws.player; ws.player = null;
    if (p && p.room && !p.room.dead) p.room.safe(() => p.room.disconnect(p, ws));
  });
  ws.on('error', () => {});
});
const hb = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, 25000);
wss.on('close', () => clearInterval(hb));

function handle(ws, data, isBinary) {
  // generic flood protection: max 30 messages per second per socket
  const now = Date.now();
  if (now - ws.win > 1000) { ws.win = now; ws.cnt = 0; }
  if (++ws.cnt > 30) { stats.rateDropped++; if (++ws.strikes > 300) ws.close(1008, 'flood'); return; }
  if (isBinary) { stats.badMsgs++; return; }
  let m;
  try { m = JSON.parse(data.toString('utf8')); } catch (e) { stats.badMsgs++; return; }
  if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') { stats.badMsgs++; return; }
  const p = ws.player;
  switch (m.t) {
    case 'create': {
      if (p) return;
      const name = cleanName(m.name);
      if (!name) return sendWs(ws, { t: 'err', code: 'name', m: 'Please enter a display name.' });
      const room = new Room(newCode(), cfg, hooks);
      rooms.set(room.code, room); stats.roomsCreated++;
      room.join(name, ws, cleanTab(m.tab));
      return;
    }
    case 'join': {
      if (p) return;
      const name = cleanName(m.name);
      if (!name) return sendWs(ws, { t: 'err', code: 'name', m: 'Please enter a display name.' });
      const code = String(m.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
      const room = rooms.get(code);
      if (!room || room.dead) return sendWs(ws, { t: 'err', code: 'nf', m: 'No table found with code "' + code + '". Check the code, or create a new table.' });
      if (room.humans().length >= MAX_SEATS) return sendWs(ws, { t: 'err', code: 'full', m: 'Sorry, table ' + code + ' is full — 8 players is the maximum. Try another table or create your own!' });
      room.join(name, ws, cleanTab(m.tab));
      return;
    }
    case 'resume': {
      if (p) return;
      const q = typeof m.tok === 'string' && m.tok.length < 64 ? sessions.get(m.tok) : null;
      if (!q || !q.room || q.room.dead) return sendWs(ws, { t: 'resume_fail', m: 'Your previous seat has expired.' });
      const tab = cleanTab(m.tab);
      if (q.connected && q.ws && q.ws.readyState === 1 && q.tab !== tab) return sendWs(ws, { t: 'resume_fail', inuse: 1, m: 'That seat is already open in another window.' });
      q.room.safe(() => q.room.reconnect(q, ws, tab));
      return;
    }
    case 'ping': return sendWs(ws, { t: 'pong' });
  }
  if (!p || !p.room || p.room.dead) return;
  const room = p.room;
  switch (m.t) {
    case 'leave': room.safe(() => room.leave(p, 'left')); ws.player = null; sendWs(ws, { t: 'left' }); return;
    case 'start': return room.safe(() => room.start(p));
    case 'act': return room.safe(() => room.act(p, typeof m.a === 'string' ? m.a : '', m.i));
    case 'chat': return room.safe(() => room.chatMsg(p, m.m));
    default: stats.badMsgs++;
  }
}

server.listen(cfg.port, () => console.log('POKER KING online listening on port ' + cfg.port));
module.exports = { server, rooms, sessions, stats, cfg };
