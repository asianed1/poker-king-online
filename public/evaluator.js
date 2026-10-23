// POKER KING hand evaluator (shared by index.html and test-evaluator.js)
(function(root){
var RN={2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'Jack',12:'Queen',13:'King',14:'Ace'};
var RP={2:'2s',3:'3s',4:'4s',5:'5s',6:'6s',7:'7s',8:'8s',9:'9s',10:'10s',11:'Jacks',12:'Queens',13:'Kings',14:'Aces'};
var CATS=['High Card','One Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush','Royal Flush'];
function evaluate(h){
  var cnt={},i;for(i=0;i<5;i++)cnt[h[i].r]=(cnt[h[i].r]||0)+1;
  var groups=Object.keys(cnt).map(Number).sort(function(a,b){return cnt[b]-cnt[a]||b-a;});
  var flush=h.every(function(c){return c.s===h[0].s;});
  var sorted=h.map(function(c){return c.r;}).sort(function(a,b){return b-a;});
  var straight=false,high=0;
  if(groups.length===5){
    if(sorted[0]-sorted[4]===4){straight=true;high=sorted[0];}
    else if(sorted[0]===14&&sorted[1]===5){straight=true;high=5;}
  }
  var cat,tb,used,name;var all=[0,1,2,3,4];
  function idx(r){var o=[];h.forEach(function(c,k){if(c.r===r)o.push(k);});return o;}
  if(straight&&flush){cat=high===14?9:8;tb=[high];used=all;name=cat===9?'Royal Flush':RN[high]+'-high Straight Flush';}
  else if(cnt[groups[0]]===4){cat=7;tb=groups;used=idx(groups[0]);name='Four '+RP[groups[0]];}
  else if(cnt[groups[0]]===3&&cnt[groups[1]]===2){cat=6;tb=groups;used=all;name='Full House, '+RP[groups[0]]+' full of '+RP[groups[1]];}
  else if(flush){cat=5;tb=sorted;used=all;name=RN[sorted[0]]+'-high Flush';}
  else if(straight){cat=4;tb=[high];used=all;name=RN[high]+'-high Straight';}
  else if(cnt[groups[0]]===3){cat=3;tb=groups;used=idx(groups[0]);name='Three '+RP[groups[0]];}
  else if(cnt[groups[0]]===2&&cnt[groups[1]]===2){cat=2;tb=groups;used=idx(groups[0]).concat(idx(groups[1]));name='Two Pair, '+RP[groups[0]]+' and '+RP[groups[1]];}
  else if(cnt[groups[0]]===2){cat=1;tb=groups;used=idx(groups[0]);name='Pair of '+RP[groups[0]];}
  else{cat=0;tb=sorted;used=[h.findIndex(function(c){return c.r===sorted[0];})];name=RN[sorted[0]]+' High';}
  return {cat:cat,catName:CATS[cat],tb:tb,used:used,name:name};
}
function compare(a,b){ // a,b evaluations; >0 a wins
  if(a.cat!==b.cat)return a.cat-b.cat;
  for(var i=0;i<a.tb.length;i++)if(a.tb[i]!==b.tb[i])return a.tb[i]-b.tb[i];
  return 0;
}
function explain(a,b){ // winner a over loser b, or tie
  var c=compare(a,b);
  if(c===0)return 'Exact tie: '+a.name+' vs '+b.name+' (suits never break ties)';
  if(c<0){var t=a;a=b;b=t;}
  if(a.cat!==b.cat)return a.name+' beats '+b.name;
  var i=0;while(a.tb[i]===b.tb[i])i++;
  var primary={0:0,1:0,2:1,3:0,4:0,5:-1,6:1,7:0,8:0}[a.cat];
  if(i<=primary||a.cat===4||a.cat===8)return a.name+' beats '+b.name;
  return a.name+' vs '+b.name+': kicker '+RN[a.tb[i]]+' beats '+RN[b.tb[i]];
}
var DESC=['High Card: no matching cards, so your highest card counts','One Pair: two cards of the same rank','Two Pair: two different pairs','Three of a Kind: three cards of the same rank','Straight: five ranks in a row, any suits','Flush: five cards of the same suit','Full House: three of one rank plus a pair','Four of a Kind: four cards of the same rank','Straight Flush: five in a row, all the same suit','Royal Flush: A-K-Q-J-10 all the same suit (the best hand)'];
var EXAMPLES=['A♠ J♥ 8♦ 5♣ 2♠','9♠ 9♥ K♦ 6♣ 2♠','J♠ J♥ 4♦ 4♣ A♠','7♠ 7♥ 7♦ K♣ 2♠','5♠ 6♥ 7♦ 8♣ 9♠','K♥ J♥ 8♥ 5♥ 2♥','Q♠ Q♥ Q♦ 4♣ 4♠','K♠ K♥ K♦ K♣ 3♠','5♣ 6♣ 7♣ 8♣ 9♣','A♦ K♦ Q♦ J♦ 10♦'];
function phrase(e){var t=e.tb;switch(e.cat){
case 9:return 'a Royal Flush';case 8:return 'a Straight Flush ('+RN[t[0]]+'-high)';case 7:return 'Four of a Kind ('+RP[t[0]]+')';
case 6:return 'a Full House ('+RP[t[0]]+' full of '+RP[t[1]]+')';case 5:return 'a Flush ('+RN[t[0]]+'-high)';case 4:return 'a Straight ('+RN[t[0]]+'-high)';
case 3:return 'Three of a Kind ('+RP[t[0]]+')';case 2:return 'Two Pair ('+RP[t[0]]+' and '+RP[t[1]]+')';case 1:return 'One Pair ('+RP[t[0]]+')';default:return 'High Card ('+RN[t[0]]+')';}}
function article(r){return (r===14||r===8)?'an ':'a ';}
// p = player's evaluation, d = dealer's. Returns {outcome:'player'|'dealer'|'push', headline, text}
function explainFull(p,d){
  var c=compare(p,d),pw=c>0;
  var W=pw?'You':'The Dealer',L=pw?"the Dealer's":'your',wPoss=pw?'your':"the Dealer's",w=pw?p:d,l=pw?d:p;
  var head=c>0?'You win!':c<0?'The Dealer wins.':"Push — it's a tie.";
  if(c===0)return {outcome:'push',headline:head,text:'Both of you have '+phrase(p)+' with exactly the same card ranks. Suits never count in poker, so neither hand is better and it\'s a tie (a push).'};
  var text;
  if(w.cat!==l.cat){
    text=W+(pw?' have ':' has ')+phrase(w)+', which beats '+L+' '+phrase(l).replace(/^an? /,'')+'. '+CATS[w.cat]+' ranks above '+CATS[l.cat]+' on the hand-rankings ladder.';
    if(w.cat===9)text+=' A Royal Flush is the highest hand in poker.';
  } else {
    var i=0;while(w.tb[i]===l.tb[i])i++;
    var a=w.tb[i],b=l.tb[i],cmpTxt=wPoss+' '+RN[a]+' beats '+L+' '+RN[b]+'.';
    var nth=['highest','second-highest','third-highest','fourth-highest','lowest'][i];
    switch(w.cat){
    case 8:case 4:text='Both of you have a '+CATS[w.cat]+'. With straights, the highest card decides: '+wPoss+' '+RN[a]+'-high beats '+L+' '+RN[b]+'-high.'+(b===5?' (In A-2-3-4-5 the Ace counts low, so it is only 5-high.)':'');break;
    case 5:case 0:text='Both of you have '+(w.cat===5?'a Flush':'only a High Card')+'. Compare the highest card, then the next, and so on'+(i?': the top '+(i===1?'card matches':i+' cards match')+', so the '+nth+' card decides':'')+': '+cmpTxt;break;
    case 7:case 6:case 3:text='Both of you have '+CATS[w.cat]+'. The higher rank wins: '+wPoss+' '+RP[a]+' beat '+L+' '+RP[b]+'.';break;
    case 1:text=i===0?'Both of you have One Pair. The higher pair wins: '+wPoss+' '+RP[a]+' beat '+L+' '+RP[b]+'.':'Both of you have a Pair of '+RP[w.tb[0]]+'. When pairs match, the highest other card (the kicker) decides: '+cmpTxt;break;
    case 2:text=i===0?'Both of you have Two Pair. Compare the higher pair first: '+wPoss+' '+RP[a]+' beat '+L+' '+RP[b]+'.':i===1?'Both of you have Two Pair with '+RP[w.tb[0]]+' on top, so the lower pair decides: '+wPoss+' '+RP[a]+' beat '+L+' '+RP[b]+'.':'Both of you have Two Pair ('+RP[w.tb[0]]+' and '+RP[w.tb[1]]+'). When both pairs match, the fifth card (the kicker) decides: '+cmpTxt;break;
    }
  }
  return {outcome:pw?'player':'dealer',headline:head,text:text};
}
var api={evaluate:evaluate,compare:compare,explain:explain,explainFull:explainFull,phrase:phrase,CATS:CATS,DESC:DESC,EXAMPLES:EXAMPLES};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PokerEval=api;
})(this);
