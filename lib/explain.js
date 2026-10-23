'use strict';
// Multi-player showdown: ranks every hand and writes a beginner-friendly explanation.
// Uses the single-player POKER KING evaluator (public/evaluator.js, unmodified copy).
const E = require('../public/evaluator.js');
const { str } = require('./cards');
const RN = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
const RP = { 2: '2s', 3: '3s', 4: '4s', 5: '5s', 6: '6s', 7: '7s', 8: '8s', 9: '9s', 10: '10s', 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces' };
const CATS = E.CATS;

function poss(n) { return n + "'s"; }
function listJoin(a) { return a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
function noArticle(s) { return s.replace(/^an? /, ''); }

// Why hand w beats hand l when both are the same category (mirrors single-player explainFull).
// wN/lN: subject names, wP/lP: possessive forms.
function tiebreak(wN, wP, w, lN, lP, l) {
  let i = 0; while (w.tb[i] === l.tb[i]) i++;
  const a = w.tb[i], b = l.tb[i];
  const both = wN + ' and ' + lN + ' both have ';
  const nth = ['highest', 'second-highest', 'third-highest', 'fourth-highest', 'lowest'][i];
  const cmpTxt = wP + ' ' + RN[a] + ' beats ' + lP + ' ' + RN[b] + '.';
  switch (w.cat) {
    case 8: case 4:
      return both + 'a ' + CATS[w.cat] + '. With straights, the highest card decides: ' + wP + ' ' + RN[a] + '-high beats ' + lP + ' ' + RN[b] + '-high.' +
        (b === 5 ? ' (In A-2-3-4-5 the Ace counts low, so it is only 5-high.)' : '');
    case 5: case 0:
      return both + (w.cat === 5 ? 'a Flush' : 'only a High Card') + '. Compare the highest card, then the next, and so on' +
        (i ? ': the top ' + (i === 1 ? 'card matches' : i + ' cards match') + ', so the ' + nth + ' card decides' : '') + ': ' + cmpTxt;
    case 7: case 6: case 3:
      if (i === 0) return both + CATS[w.cat] + '. The higher rank wins: ' + wP + ' ' + RP[a] + ' beat ' + lP + ' ' + RP[b] + '.';
      return both + CATS[w.cat] + ' with the same main rank, so the next card decides: ' + cmpTxt;
    case 1:
      return i === 0 ? both + 'One Pair. The higher pair wins: ' + wP + ' ' + RP[a] + ' beat ' + lP + ' ' + RP[b] + '.'
        : both + 'a Pair of ' + RP[w.tb[0]] + '. When pairs match, the other cards (kickers) are compared from highest down' +
          (i > 1 ? ': the top ' + (i === 2 ? 'kicker matches' : (i - 1) + ' kickers match') + ', so the next one decides' : '') + ': ' + cmpTxt;
    case 2:
      return i === 0 ? both + 'Two Pair. Compare the higher pair first: ' + wP + ' ' + RP[a] + ' beat ' + lP + ' ' + RP[b] + '.'
        : i === 1 ? both + 'Two Pair with ' + RP[w.tb[0]] + ' on top, so the lower pair decides: ' + wP + ' ' + RP[a] + ' beat ' + lP + ' ' + RP[b] + '.'
          : both + 'Two Pair (' + RP[w.tb[0]] + ' and ' + RP[w.tb[1]] + '). When both pairs match, the fifth card (the kicker) decides: ' + cmpTxt;
    default:
      return wP + ' ' + w.name + ' beats ' + lP + ' ' + l.name + '.';
  }
}

// entries: [{seat, name, color, cards:[{r,s}x5]}]
// returns {hands:[...sorted best first], win:[seats], head, text}
function buildResult(entries) {
  const hs = entries.map(e => ({ e, ev: E.evaluate(e.cards) }));
  hs.sort((x, y) => E.compare(y.ev, x.ev) || x.e.seat - y.e.seat);
  let rank = 0;
  hs.forEach((h, k) => { if (k === 0 || E.compare(hs[k - 1].ev, h.ev) !== 0) rank = k; h.rank = rank; });
  const winners = hs.filter(h => h.rank === 0);
  const losers = hs.filter(h => h.rank !== 0);
  const w = winners[0].ev;
  let head, text;
  const loserList = losers.map(h => poss(h.e.name) + ' ' + noArticle(E.phrase(h.ev)));
  if (winners.length === 1) {
    const W = winners[0].e.name;
    head = W + ' wins!';
    text = W + ' wins with ' + E.phrase(w) + (losers.length ? ', which beats ' + listJoin(loserList) + '.' : '.');
    if (losers.length) {
      const ru = losers.filter(h => h.rank === losers[0].rank);
      const r = ru[0].ev, rN = listJoin(ru.map(h => h.e.name));
      if (r.cat === w.cat) text += ' ' + tiebreak(W, poss(W), w, rN, ru.length > 1 ? rN + "'s" : poss(rN), r);
      else text += ' ' + CATS[w.cat] + ' ranks above ' + CATS[r.cat] + ' on the hand-rankings ladder.';
    }
    if (w.cat === 9) text += ' A Royal Flush is the highest hand in poker.';
  } else {
    const names = listJoin(winners.map(h => h.e.name));
    head = 'Split! ' + names + ' share the win.';
    text = names + ' each have ' + E.phrase(w) + ' with exactly the same card ranks. Suits never count in poker, so it\'s a tie and they split the win.';
    if (losers.length) {
      text += ' They beat ' + listJoin(loserList) + '.';
      const ru = losers.filter(h => h.rank === losers[0].rank);
      const r = ru[0].ev, rN = listJoin(ru.map(h => h.e.name));
      if (r.cat === w.cat) text += ' ' + tiebreak('The winners', "the winners'", w, rN, poss(rN), r).replace(/^The winners and (.*?) both have/, 'The winners and $1 all have');
    }
  }
  return {
    hands: hs.map(h => ({
      s: h.e.seat, id: h.e.id, n: h.e.name, c: h.e.color, cards: h.e.cards.map(str), hn: h.ev.name, cat: h.ev.cat,
      used: h.ev.used, rank: h.rank
    })),
    win: winners.map(h => h.e.seat), head, text
  };
}
module.exports = { buildResult, tiebreak };
