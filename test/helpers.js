'use strict';
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
function startServer(env, port) {
  return new Promise((res, rej) => {
    const out = [];
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(port), TEST_HOOKS: '1' }, env), stdio: ['ignore', 'pipe', 'pipe'] });
    p.out = out;
    p.stdout.on('data', d => { out.push(String(d)); if (/listening/.test(String(d))) res(p); });
    p.stderr.on('data', d => out.push('[stderr] ' + String(d)));
    p.on('exit', c => rej(new Error('server exited ' + c + '\n' + out.join(''))));
  });
}
function getStats(port) {
  return new Promise((res, rej) => http.get('http://localhost:' + port + '/__test/stats', r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CARD_RE = /^[2-9TJQKA][shdc]$/;
function cardStrings(obj, acc = []) {
  if (typeof obj === 'string') { if (CARD_RE.test(obj)) acc.push(obj); }
  else if (Array.isArray(obj)) obj.forEach(x => cardStrings(x, acc));
  else if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) cardStrings(obj[k], acc);
  return acc;
}
module.exports = { startServer, getStats, sleep, cardStrings, CARD_RE };
