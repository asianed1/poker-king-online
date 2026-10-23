// Independent brute-force reference evaluator: scores a hand as a comparable number.
function refScore(h){
  const rs=h.map(c=>c.r), suits=new Set(h.map(c=>c.s));
  const hist=new Array(15).fill(0); rs.forEach(r=>hist[r]++);
  // find straight by scanning every window, including wheel (ace=1)
  let st=0; for(let top=14;top>=5;top--){let ok=true;for(let k=0;k<5;k++){const r=top-k===1?14:top-k;if(hist[r]!==1)ok=false}if(ok){st=top;break}}
  const fl=suits.size===1;
  const ord=[];for(let c=4;c>=1;c--)for(let r=14;r>=2;r--)if(hist[r]===c)ord.push(r);
  const shape=[...hist].filter(x=>x).sort((a,b)=>b-a).join('');
  let cat;
  if(st&&fl)cat=st===14?9:8;else if(shape==='41')cat=7;else if(shape==='32')cat=6;else if(fl)cat=5;else if(st)cat=4;
  else if(shape==='311')cat=3;else if(shape==='221')cat=2;else if(shape==='2111')cat=1;else cat=0;
  const keys=(cat===8||cat===9||cat===4)?[st]:ord;
  let v=cat;for(let i=0;i<5;i++)v=v*16+(keys[i]||0);return {cat,v};
}
module.exports={refScore};
