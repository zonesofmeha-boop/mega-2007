'use strict';
// NetLab: network protocol simulation and state visualisation platform.
// One file, zero dependencies. Run with:  node server.js
// Backend: protocol/automaton definitions, automaton checker, run history (saved to data.json).
// Frontend: the HTML block at the bottom of this file, served at "/".

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DB = path.join(__dirname, 'data.json');

// ---------- Protocol definitions (finite automata). Edge = [from, event, to, packetToSend] ----------
const PROTOCOLS = {
  tcp: {
    title: 'TCP connection (handshake and teardown)',
    n: { A: 'Client', B: 'Server' },
    M: {
      A: { start: 'CLOSED', acc: ['CLOSED'], sample: 'open SYN-ACK close ACK FIN timeout', E: [
        ['CLOSED', 'open', 'SYN_SENT', 'SYN'], ['SYN_SENT', 'SYN-ACK', 'ESTABLISHED', 'ACK'],
        ['ESTABLISHED', 'SYN-ACK', 'ESTABLISHED', 'ACK'], ['ESTABLISHED', 'close', 'FIN_WAIT_1', 'FIN'],
        ['FIN_WAIT_1', 'ACK', 'FIN_WAIT_2', null], ['FIN_WAIT_2', 'FIN', 'TIME_WAIT', 'ACK'],
        ['TIME_WAIT', 'FIN', 'TIME_WAIT', 'ACK'], ['TIME_WAIT', 'timeout', 'CLOSED', null]] },
      B: { start: 'CLOSED', acc: ['CLOSED'], sample: 'listen SYN ACK FIN close ACK', E: [
        ['CLOSED', 'listen', 'LISTEN', null], ['LISTEN', 'SYN', 'SYN_RCVD', 'SYN-ACK'],
        ['SYN_RCVD', 'SYN', 'SYN_RCVD', 'SYN-ACK'], ['SYN_RCVD', 'ACK', 'ESTABLISHED', null],
        ['ESTABLISHED', 'FIN', 'CLOSE_WAIT', 'ACK'], ['CLOSE_WAIT', 'FIN', 'CLOSE_WAIT', 'ACK'],
        ['CLOSE_WAIT', 'close', 'LAST_ACK', 'FIN'], ['LAST_ACK', 'ACK', 'CLOSED', null]] }
    },
    auto: { A: { ESTABLISHED: ['close', 1500], TIME_WAIT: ['timeout', 1500] }, B: { CLOSE_WAIT: ['close', 800] } },
    init: [['B', 'listen', 0], ['A', 'open', 400]]
  },
  saw: {
    title: 'Stop-and-Wait ARQ',
    n: { A: 'Sender', B: 'Receiver' },
    M: {
      A: { start: 'READY0', acc: ['READY0'], sample: 'send ACK0 send ACK1', E: [
        ['READY0', 'send', 'WAIT0', 'DATA0'], ['WAIT0', 'ACK0', 'READY1', null], ['WAIT0', 'ACK1', 'WAIT0', null],
        ['READY1', 'send', 'WAIT1', 'DATA1'], ['WAIT1', 'ACK1', 'READY0', null], ['WAIT1', 'ACK0', 'WAIT1', null]] },
      B: { start: 'EXP0', acc: ['EXP0'], sample: 'DATA0 DATA1', E: [
        ['EXP0', 'DATA0', 'EXP1', 'ACK0'], ['EXP0', 'DATA1', 'EXP0', 'ACK1'],
        ['EXP1', 'DATA1', 'EXP0', 'ACK1'], ['EXP1', 'DATA0', 'EXP1', 'ACK0']] }
    },
    auto: { A: { READY0: ['send', 300], READY1: ['send', 300] }, B: {} },
    init: [['A', 'send', 300]]
  }
};

// ---------- Storage ----------
let runs = [];
try { runs = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch (e) { runs = []; }
const persist = () => { try { fs.writeFileSync(DB, JSON.stringify(runs)); } catch (e) { console.error('save failed:', e.message); } };

// ---------- Automaton check (does the string take q0 into F?) ----------
function check(proto, who, events) {
  const m = PROTOCOLS[proto] && PROTOCOLS[proto].M[who];
  if (!m) return { error: 'Unknown protocol or machine' };
  let q = m.start; const trail = [q];
  for (const ev of events) {
    const e = m.E.find(t => t[0] === q && t[1] === ev);
    if (!e) return { accepted: false, trail, reason: `No transition defined for (${q}, ${ev})` };
    q = e[2]; trail.push(q);
  }
  const accepted = m.acc.includes(q);
  return { accepted, trail, reason: accepted ? '' : `Stopped in ${q}, which is not a final state` };
}

// ---------- HTTP helpers ----------
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise((ok, no) => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 10000) { no(new Error('Body too large')); req.destroy(); } });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(new Error('Invalid JSON')); } });
});
const num = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));

const A = '/*' + 'HTML\n', Z = '\nHTML' + '*/';
const PAGE = fs.readFileSync(__filename, 'utf8').split(A)[1].split(Z)[0];

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (req.method === 'GET' && url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
    if (req.method === 'GET' && url === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url === '/api/protocols') return json(res, 200, PROTOCOLS);
    if (req.method === 'POST' && url === '/api/check') {
      const b = await body(req);
      if (!Array.isArray(b.events) || b.events.length > 200 || b.events.some(x => typeof x !== 'string' || x.length > 30)) return json(res, 400, { error: 'events must be a list of short strings' });
      const r = check(b.proto, b.who, b.events);
      return json(res, r.error ? 400 : 200, r);
    }
    if (url === '/api/runs') {
      if (req.method === 'GET') return json(res, 200, runs.slice().reverse());
      if (req.method === 'POST') {
        const b = await body(req);
        if (!PROTOCOLS[b.proto]) return json(res, 400, { error: 'Unknown protocol' });
        const run = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), proto: b.proto, loss: num(b.loss, 0, 100),
          sent: num(b.sent, 0, 1e6), lost: num(b.lost, 0, 1e6), retx: num(b.retx, 0, 1e6), ms: num(b.ms, 0, 1e9), at: new Date().toISOString() };
        runs.push(run); if (runs.length > 100) runs.shift(); persist();
        return json(res, 201, run);
      }
      if (req.method === 'DELETE') { runs = []; persist(); return json(res, 200, { ok: true }); }
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) { json(res, 400, { error: e.message }); }
});

server.listen(PORT, () => console.log(`NetLab running at http://localhost:${PORT}`));

// ---------- Frontend (served at "/") ----------
/*HTML
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NetLab: protocol simulator</title>
<style>
:root{color-scheme:light;--bg:#e9eef1;--pan:#fff;--ink:#12212b;--mut:#5d6f7a;--line:#cdd8de;--acc:#0a7b85;--accbg:#d5eef0;--warn:#b86f00;--bad:#c23a2b;--ok:#2a7d3f}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0f1a20;--pan:#17252d;--ink:#e3edf1;--mut:#92a6b1;--line:#2c4049;--acc:#4cc3cd;--accbg:#14484d;--warn:#f0a63a;--bad:#ff7a69;--ok:#6fcf86}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:18px 16px 40px}
h1{font-size:24px;margin:0 0 2px}
.sub{color:var(--mut);margin:0 0 14px;max-width:70ch}
.bar{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;background:var(--pan);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin-bottom:14px}
.bar label{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--mut)}
select,input[type=text],button{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:5px 10px}
button{cursor:pointer;background:var(--acc);color:#fff;border-color:var(--acc);font-weight:600}
button.g{background:var(--bg);color:var(--ink);border-color:var(--line);font-weight:400}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.grid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:14px}
@media (max-width:860px){.grid{grid-template-columns:1fr}}
.card{background:var(--pan);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:14px}
.card h2{font-size:15px;margin:0 0 6px}
svg{width:100%;height:auto;display:block}
.host{fill:var(--bg);stroke:var(--line);stroke-width:1.5}
.ht{fill:var(--ink);font-size:13px;font-weight:600;text-anchor:middle}
.hs{fill:var(--acc);font-size:12px;text-anchor:middle;font-weight:600}
.ch{stroke:var(--line);stroke-dasharray:4 5}
.pk{fill:var(--accbg);stroke:var(--acc)}.pk.lost{fill:none;stroke:var(--bad)}
.pt{fill:var(--ink);font-size:11px}.x{fill:var(--bad);font-size:16px}
.nd{fill:var(--bg);stroke:var(--line);stroke-width:1.5}.nd.on{fill:var(--acc);stroke:var(--acc)}
.nt{font-size:10px;text-anchor:middle;fill:var(--ink)}.on+.nt{fill:#fff;font-weight:600}
.ed{fill:none;stroke:var(--mut);stroke-width:1.2}.ed.on{stroke:var(--acc);stroke-width:2.4}
.el{font-size:9.5px;text-anchor:middle;fill:var(--mut);paint-order:stroke;stroke:var(--pan);stroke-width:3px}
.fs{display:grid;grid-template-columns:1fr 1fr;gap:8px}
@media (max-width:560px){.fs{grid-template-columns:1fr}}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.chip{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:2px 10px;font-size:13px;color:var(--mut)}
.chip b{color:var(--ink)}
ul.l{list-style:none;margin:0;padding:0;overflow:auto;font:12.5px/1.55 ui-monospace,Menlo,Consolas,monospace}
ul.l li{border-bottom:1px solid var(--line);padding:1px 0}
#log{height:240px}#hist{max-height:180px}
.warn{color:var(--warn)}.ok{color:var(--ok)}.bad{color:var(--bad)}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0}
#tr{flex:1;min-width:160px}
#res{font-size:14px;margin-top:6px}.fm{font-size:13px;color:var(--mut)}
.hh{display:flex;justify-content:space-between;align-items:center}
:root{--bg:#efe9ff;--pan:#fff;--ink:#1f1840;--mut:#6a6490;--line:#dcd3f7;--acc:#6d4aff;--accbg:#e6defe;--warn:#e07b00;--bad:#e6286a;--ok:#0f9d6b;--pink:#e8337a;--teal:#00a99b;--amb:#ffb020}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#150f2e;--pan:#211946;--ink:#f1ecff;--mut:#a79fd1;--line:#3a2f70;--acc:#9b83ff;--accbg:#34276b;--warn:#ffb55a;--bad:#ff6f9c;--ok:#4be0ad;--pink:#ff6fa5;--teal:#2de0d0;--amb:#ffc247}}
body{background:radial-gradient(900px 500px at 10% -10%,color-mix(in srgb,var(--pink) 22%,transparent),transparent),radial-gradient(800px 500px at 100% 0,color-mix(in srgb,var(--teal) 22%,transparent),transparent),var(--bg)}
h1{font-size:30px;background:linear-gradient(90deg,var(--acc),var(--pink),var(--amb));-webkit-background-clip:text;background-clip:text;color:transparent;width:fit-content}
.card,.bar{border-top:3px solid var(--acc);box-shadow:0 8px 20px -12px color-mix(in srgb,var(--acc) 60%,transparent)}
.bar{border-top-color:var(--pink)}
button{background:linear-gradient(135deg,var(--acc),var(--pink));border:0}
button.g{background:var(--pan);color:var(--ink);border:1px solid var(--line)}
.host{fill:color-mix(in srgb,var(--acc) 14%,var(--pan));stroke:var(--acc)}
.ch{stroke:var(--acc);opacity:.5}
.pk{fill:color-mix(in srgb,var(--teal) 30%,var(--pan));stroke:var(--teal)}.pk.lost{fill:none;stroke:var(--bad)}
.hs{fill:var(--pink)}
.nd.on{fill:var(--pink);stroke:var(--pink)}
.chip:nth-child(1) b{color:var(--acc)}.chip:nth-child(2) b{color:var(--bad)}.chip:nth-child(3) b{color:var(--warn)}.chip:nth-child(4) b{color:var(--teal)}
input[type=range]{accent-color:var(--pink)}
</style>
</head>
<body>
<div class="wrap">
<h1>NetLab: protocol simulator</h1>
<p class="sub">Run a protocol over a lossy link and watch each endpoint’s finite automaton change state. Test your own event strings against the same automaton, and review past runs.</p>

<div class="bar">
<label>Protocol <select id="proto"></select></label>
<label>Packet loss <input id="loss" type="range" min="0" max="60" value="20"> <span id="lv">20%</span></label>
<label>Speed <input id="spd" type="range" min="0.25" max="3" step="0.25" value="1"></label>
<button id="run">Pause</button><button id="step" class="g">Step</button><button id="rst" class="g">Restart</button>
</div>

<div class="grid">
<div>
<div class="card"><h2>Link</h2>
<svg viewBox="0 0 700 220" role="img" aria-label="Packets travelling between two hosts">
<rect class="host" x="14" y="30" width="104" height="160" rx="10"/><rect class="host" x="582" y="30" width="104" height="160" rx="10"/>
<text class="ht" x="66" y="62" id="na">A</text><text class="ht" x="634" y="62" id="nb">B</text>
<text class="hs" x="66" y="120" id="sa"></text><text class="hs" x="634" y="120" id="sb"></text>
<line class="ch" x1="130" y1="88" x2="570" y2="88"/><line class="ch" x1="130" y1="152" x2="570" y2="152"/>
<g id="pk"></g></svg>
<div class="chips"><span class="chip">Sent <b id="c1">0</b></span><span class="chip">Lost <b id="c2">0</b></span><span class="chip">Retransmits <b id="c3">0</b></span><span class="chip">Time <b id="c4">0</b> ms</span></div>
</div>
<div class="card"><h2>State machines</h2><div class="fs"><div><svg id="fa" viewBox="0 0 420 270"></svg></div><div><svg id="fb" viewBox="0 0 420 270"></svg></div></div></div>
</div>

<div>
<div class="card"><h2>Event log</h2><ul class="l" id="log"></ul></div>
<div class="card"><h2>Automaton tester (checked by the server)</h2>
<div class="fm" id="fm"></div>
<div class="row"><select id="who"></select><button class="g" id="smp">Load sample</button></div>
<div class="row"><input type="text" id="tr" aria-label="Event string" placeholder="events separated by spaces"><button id="chk">Check string</button></div>
<div id="res"></div></div>
<div class="card"><div class="hh"><h2>Saved runs</h2><button class="g" id="clr">Clear</button></div><ul class="l" id="hist"></ul></div>
</div>
</div>
</div>
<script>
const $=s=>document.querySelector(s);
let P,S,run=true,last=0;
const RTO=2600,DUR=1000;
function after(ms,fn){S.tm.push({at:S.t+ms,fn})}
function log(m,c){c=c||'';S.log.push(m);const li=document.createElement('li');li.className=c;li.textContent=String(Math.round(S.t)).padStart(5)+' ms  '+m;const L=$('#log');L.appendChild(li);L.scrollTop=1e9}
function tx(x,l){const lost=Math.random()<S.loss;S.pk.push({x:x,l:l,t0:S.t,lost:lost});S.c.sent++;if(lost)S.c.lost++;log(x+' sends '+l+(lost?' (lost in transit)':''),lost?'bad':'')}
function send(x,l){tx(x,l);if(/^ACK/.test(l))return;const id=++S.pend[x],st=S.st[x];
const rt=()=>{if(S.pend[x]==id&&S.st[x]==st){S.c.retx++;log(x+': timeout, resending '+l,'warn');tx(x,l);after(RTO,rt)}};after(RTO,rt)}
function fire(x,ev){const m=S.p.M[x],cur=S.st[x],e=m.E.find(e=>e[0]==cur&&e[1]==ev);
if(!e){log(x+': "'+ev+'" ignored in '+cur,'warn');return}
S.last[x]=e;S.st[x]=e[2];if(e[2]!=cur)S.pend[x]++;if(ev=='send')S.sentN++;
log(x+': '+cur+' -'+ev+'-> '+e[2],'ok');if(e[3])send(x,e[3]);
const a=S.p.auto[x][e[2]];if(a&&e[2]!=cur&&!(a[0]=='send'&&S.sentN>=5))after(a[1],()=>fire(x,a[0]))}
function adv(dt){S.t+=dt;
for(const k of S.pk){if(!k.done&&S.t>=k.t0+DUR){k.done=1;if(!k.lost){fire(k.x=='A'?'B':'A',k.l)}}}
S.pk=S.pk.filter(k=>S.t<k.t0+DUR);
for(;;){let i=-1;S.tm.forEach((m,j)=>{if(m.at<=S.t&&(i<0||m.at<S.tm[i].at))i=j});if(i<0)break;S.tm.splice(i,1)[0].fn()}
if(!S.pk.length&&!S.tm.length&&!S.done){S.done=1;log('Run complete. Saved to history.','ok');setRun(false);saveRun()}}
function reset(){const p=P[$('#proto').value];$('#log').innerHTML='';
S={p:p,t:0,pk:[],tm:[],st:{A:p.M.A.start,B:p.M.B.start},last:{},pend:{A:0,B:0},c:{sent:0,lost:0,retx:0},sentN:0,loss:$('#loss').value/100,key:$('#proto').value};
$('#na').textContent='A · '+p.n.A;$('#nb').textContent='B · '+p.n.B;
$('#who').innerHTML='<option value="A">'+p.n.A+'</option><option value="B">'+p.n.B+'</option>';
buildFsm('A');buildFsm('B');info();p.init.forEach(i=>after(i[2],()=>fire(i[0],i[1])));setRun(true)}
// FSM drawing: states Q, events, transition function
function buildFsm(x){const m=S.p.M[x],Q=[...new Set(m.E.flatMap(e=>[e[0],e[2]]))],n=Q.length,pos={};
Q.forEach((q,i)=>{const a=-Math.PI/2+2*Math.PI*i/n;pos[q]=[210+148*Math.cos(a),135+96*Math.sin(a)]});
m.Q=Q;let h='<defs><marker id="h'+x+'" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" fill="var(--mut)"/></marker><marker id="g'+x+'" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" fill="var(--acc)"/></marker></defs>';
const clip=(dx,dy)=>Math.min(44/Math.abs(dx||1e-6),14/Math.abs(dy||1e-6));
m.E.forEach((e,i)=>{const a=pos[e[0]],b=pos[e[2]],lab=e[1]+(e[3]?' / '+e[3]:'');let d,lx,ly;
if(a==b){let ux=a[0]-210,uy=a[1]-135;const l=Math.hypot(ux,uy)||1;ux/=l;uy/=l;const px=-uy,py=ux,bx=a[0]+ux*16,by=a[1]+uy*16;
d='M'+(bx-px*14)+' '+(by-py*14)+'A14 14 0 1 1 '+(bx+px*14)+' '+(by+py*14);lx=a[0]+ux*60;ly=a[1]+uy*40}
else{const dx=b[0]-a[0],dy=b[1]-a[1],s=clip(dx,dy),p0=[a[0]+dx*s,a[1]+dy*s],p1=[b[0]-dx*s,b[1]-dy*s],L=Math.hypot(dx,dy),c=[(a[0]+b[0])/2-dy/L*26,(a[1]+b[1])/2+dx/L*26];
d='M'+p0[0]+' '+p0[1]+'Q'+c[0]+' '+c[1]+' '+p1[0]+' '+p1[1];lx=.25*p0[0]+.5*c[0]+.25*p1[0];ly=.25*p0[1]+.5*c[1]+.25*p1[1]}
h+='<path class="ed" id="e'+x+i+'" d="'+d+'" marker-end="url(#h'+x+')"/><text class="el" x="'+lx+'" y="'+(ly+3)+'">'+lab+'</text>'});
Q.forEach(q=>{const px=pos[q][0],py=pos[q][1];h+='<rect class="nd" id="n'+x+q+'" x="'+(px-42)+'" y="'+(py-13)+'" width="84" height="26" rx="13"/><text class="nt" x="'+px+'" y="'+(py+3.5)+'">'+q+'</text>';if(m.acc.includes(q))h+='<rect x="'+(px-46)+'" y="'+(py-17)+'" width="92" height="34" rx="17" fill="none" stroke="var(--mut)"/>'});
const s=pos[m.start];h+='<text class="el" x="'+s[0]+'" y="'+(s[1]-24)+'">start</text>';
$('#f'+x.toLowerCase()).innerHTML=h}
function paint(){for(const x of['A','B']){const m=S.p.M[x];m.Q.forEach(q=>$('#n'+x+q).classList.toggle('on',S.st[x]==q));
m.E.forEach((e,i)=>{const el=$('#e'+x+i),on=S.last[x]==e;el.classList.toggle('on',on);el.setAttribute('marker-end','url(#'+(on?'g':'h')+x+')')});$('#s'+x.toLowerCase()).textContent=S.st[x]}
let h='';for(const k of S.pk){let g=(S.t-k.t0)/DUR,o=1;if(g>1)continue;if(k.lost&&g>.55){o=Math.max(0,1-(g-.55)/.25);g=.55}
const f=k.x=='A'?140:560,t=k.x=='A'?560:140,x=f+(t-f)*g,y=k.x=='A'?88:152,w=k.l.length*6.5+18;
h+='<g opacity="'+o+'"><rect class="pk '+(k.lost?'lost':'')+'" x="'+(x-w/2)+'" y="'+(y-12)+'" width="'+w+'" height="24" rx="12"/><text class="pt" x="'+x+'" y="'+(y+4)+'" text-anchor="middle">'+k.l+'</text>'+(k.lost&&g>=.55?'<text class="x" x="'+(x+w/2+6)+'" y="'+(y+6)+'">✕</text>':'')+'</g>'}
$('#pk').innerHTML=h;$('#c1').textContent=S.c.sent;$('#c2').textContent=S.c.lost;$('#c3').textContent=S.c.retx;$('#c4').textContent=Math.round(S.t)}
// Tester: the backend decides whether the string is accepted
function info(){const m=S.p.M[$('#who').value],sig=[...new Set(m.E.map(e=>e[1]))];
$('#fm').textContent='M = (Q, Σ, δ, q0, F) with |Q| = '+m.Q.length+', Σ = {'+sig.join(', ')+'}, q0 = '+m.start+', F = {'+m.acc.join(', ')+'}';$('#res').textContent='';$('#tr').value=''}
async function check(){const R=$('#res');R.textContent='Checking…';
try{const r=await fetch('/api/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({proto:S.key,who:$('#who').value,events:$('#tr').value.trim().split(/\s+/).filter(Boolean)})});
const d=await r.json();if(!r.ok)throw new Error(d.error);
R.textContent='';const b=document.createElement('b');b.style.color=d.accepted?'var(--ok)':'var(--bad)';b.textContent=d.accepted?'Accepted. ':'Rejected. ';
R.append(b,(d.reason?d.reason+'. ':'')+'Path: '+d.trail.join(' → '))}catch(e){R.textContent='Could not check: '+e.message}}
// Run history (stored by the backend)
async function loadRuns(){try{const r=await (await fetch('/api/runs')).json(),u=$('#hist');u.innerHTML='';
if(!r.length){u.innerHTML='<li>No saved runs yet. A run is saved when it completes.</li>';return}
r.forEach(x=>{const li=document.createElement('li');li.textContent=new Date(x.at).toLocaleTimeString()+'  '+x.proto.toUpperCase()+'  loss '+x.loss+'%  sent '+x.sent+'  lost '+x.lost+'  retx '+x.retx+'  '+x.ms+' ms';u.appendChild(li)})}catch(e){}}
async function saveRun(){try{await fetch('/api/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({proto:S.key,loss:Math.round(S.loss*100),sent:S.c.sent,lost:S.c.lost,retx:S.c.retx,ms:Math.round(S.t)})});loadRuns()}catch(e){}}
function setRun(v){run=v;$('#run').textContent=v?'Pause':'Resume'}
$('#proto').onchange=reset;$('#rst').onclick=reset;$('#run').onclick=()=>setRun(!run);
$('#step').onclick=()=>{setRun(false);adv(250);paint()};
$('#loss').oninput=e=>{S.loss=e.target.value/100;$('#lv').textContent=e.target.value+'%'};
$('#who').onchange=info;$('#chk').onclick=check;$('#smp').onclick=()=>{$('#tr').value=S.p.M[$('#who').value].sample;check()};
$('#clr').onclick=async()=>{await fetch('/api/runs',{method:'DELETE'});loadRuns()};
function tick(ts){const dt=Math.min(50,ts-last);last=ts;if(run&&S)adv(dt*$('#spd').value);if(S)paint();requestAnimationFrame(tick)}
(async function boot(){try{P=await (await fetch('/api/protocols')).json()}catch(e){document.body.textContent='Could not load protocols from the server.';return}
$('#proto').innerHTML=Object.keys(P).map(k=>'<option value="'+k+'">'+P[k].title+'</option>').join('');
reset();loadRuns();requestAnimationFrame(tick)})();
</script>
</body>
</html>
HTML*/
