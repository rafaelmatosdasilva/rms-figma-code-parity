// Shared HTML report builder for rms-parity audit tools.
// Used by consumer-audit.mjs (Figma↔Figma) and audit.mjs (Figma↔Code).
//
// buildReport({ title, metaHtml, statCards, filterDefs, tabsHtml, sections, firstCol, extraHeadHtml })
//
// filterDefs:  [{ filter, label, dot, color }]
//   filter  — data-filter value (e.g. 'SYNCED', 'FAIL') — must match data-status on <tr>
//   label   — button text
//   dot     — CSS class for the status dot ('s','p','st','lo') or null
//   color   — active button background hex
//
// data-counts on .col-section must be a JSON object keyed by filter value:
//   { ALL: 10, SYNCED: 5, PENDING: 3, STALE: 2, LOCAL: 0 }

export function buildReport({
  title,
  metaHtml,
  statCards = [],
  filterDefs = [],
  tabsHtml = '',
  sections = '',
  firstCol = '',
  extraHeadHtml = '',
}) {
  const filterCss = filterDefs
    .filter(f => f.filter !== 'ALL' && f.color)
    .map(f => `.fbtn.on[data-filter="${f.filter}"]{background:${f.color};border-color:${f.color}}`)
    .join('\n');

  const filterBtnsHtml = filterDefs.map((f, i) =>
    `<button class="fbtn${i === 0 ? ' on' : ''}" data-filter="${f.filter}" onclick="setF('${f.filter}',this)">${f.dot ? `<span class="dot ${f.dot}"></span>` : ''}${f.label} <span class="fcount"></span></button>`
  ).join('\n    ');

  const statCardsHtml = statCards.map(c =>
    `<div class="stat ${c.cls}"><div class="n">${c.n}</div><div class="l">${c.cls && c.cls !== 'tot' ? `<span class="dot ${c.cls}"></span>` : ''}${c.label}</div><div class="d">${c.desc}</div></div>`
  ).join('\n    ');

  const safeFirst = JSON.stringify(firstCol);

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>${title}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#111;background:#fff}
.top{padding:16px 28px 10px;border-bottom:1px solid #e4e7ec;flex-shrink:0;display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap}
.flink{color:inherit;text-decoration:none;border-bottom:1px solid #9ca3af}.flink:hover{border-bottom-color:#111}
.top-title h1{font-size:17px;font-weight:700;margin-bottom:3px}
.top-title .meta{font-size:11px;color:#777}
.sum{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start}
.stat{padding:10px 16px;border-radius:10px;min-width:100px;cursor:default}
.stat .n{font-size:22px;font-weight:800;line-height:1}
.stat .l{font-size:11px;font-weight:600;margin:2px 0 4px;display:flex;align-items:center}
.stat .d{font-size:10px;opacity:.75;line-height:1.3}
.stat.s{background:#dcfce7;color:#166534}
.stat.p{background:#fef9c3;color:#854d0e}
.stat.st{background:#fee2e2;color:#991b1b}
.stat.lo{background:#ede9fe;color:#5b21b6}
.stat.tot{background:#e5e7eb;color:#374151}
.nav{position:sticky;top:0;z-index:20;background:#f8f9fc;flex-shrink:0}
.tabs-hdr{padding:8px 20px 0;font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#9ca3af}
.tabs{display:flex;gap:6px;padding:6px 20px 10px;overflow-x:auto}
.tab{display:flex;flex-direction:column;gap:3px;padding:6px 12px;border:1.5px solid #e4e7ec;border-radius:10px;background:#fff;cursor:pointer;flex-shrink:0;transition:border-color .15s,box-shadow .15s;text-align:left}
.tab:hover{border-color:#c7d2fe;box-shadow:0 1px 4px rgba(99,102,241,.08)}
.tab.active{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.12);background:#fff}
.tab-top{display:flex;align-items:baseline;gap:8px}
.tab-name{font-size:12px;font-weight:600;color:#374151;white-space:nowrap}
.tab.active .tab-name{color:#4f46e5}
.tab-count{font-size:18px;font-weight:800;color:#1e1e2e;line-height:1}
.tab.active .tab-count{color:#4f46e5}
.tab-bottom{display:flex;align-items:center;gap:4px;min-height:10px}
.tab-loc{font-size:10px;color:#9ca3af;font-style:italic}
.tab-warn{font-size:12px;margin-left:2px;cursor:default}
.toolbar{display:flex;gap:8px;align-items:center;padding:8px 20px;border-bottom:1px solid #e4e7ec;background:#fff;flex-wrap:wrap}
.fbtn{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border:1px solid #d1d5db;border-radius:14px;background:#fff;cursor:pointer;font-size:11px;color:#374151;white-space:nowrap}
.fbtn:hover{background:#f3f4f6}
.fbtn.on{color:#fff}
.fbtn.on[data-filter="ALL"]{background:#111;border-color:#111}
${filterCss}
.fcount{font-weight:700;opacity:.85}.fcount-zero{opacity:.35}
input{border:1px solid #d1d5db;border-radius:6px;padding:4px 10px;font-size:11px;width:200px;outline:none;margin-left:auto}
input:focus{border-color:#6366f1}
.col-info{font-size:10px;color:#888;margin-left:4px}
.col-section{display:none}
.col-section.active{display:block}
.col-meta{padding:6px 20px;background:#f8f9fc;border-bottom:1px solid #e4e7ec;font-size:10px;color:#666;display:flex;gap:14px}
.col-tag{padding:1px 7px;border-radius:8px;background:#e0e7ff;color:#3730a3;font-weight:600;font-size:10px}
.col-tag.local{background:#ede9fe;color:#5b21b6}
.tw{overflow-x:visible}
table{width:100%;border-collapse:collapse}
thead th{position:sticky;top:var(--nav-h,0px);z-index:10;background:#1e1e2e;color:#e2e8f0;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;padding:7px 10px;text-align:left;white-space:nowrap}
th.th-group{background:#2d2d44;color:#a5b4fc;font-size:10px;font-weight:700;letter-spacing:.6px;text-align:center;border-bottom:1px solid #3d3d5c}
th.th-group-pb{background:#312e3f;color:#c4b5fd}
th.th-mode{min-width:180px}
th:first-child{min-width:280px}
tr.tr{border-bottom:1px solid #f0f2f5}
tr.tr:hover{background:#fafbff}
tr.s-STALE .tname code,tr.s-MISSING .tname code{color:#c0c4cc}
tr.gr td{background:#f0f2f7;padding:5px 10px;border-top:2px solid #d0d7de}
.gname{font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-right:10px;color:#374151}
.gp{display:inline-flex;align-items:center;font-size:10px;margin-right:5px}.gp.s{color:#166534}.gp.p{color:#854d0e}.gp.t{color:#991b1b}.gp.l{color:#5b21b6}
td{padding:4px 10px;vertical-align:middle}
td.tname code{font-size:11px;word-break:break-all}
td.val{white-space:nowrap;padding:4px 10px}
td.val .sw{display:inline-block;width:13px;height:13px;border-radius:3px;vertical-align:middle;margin-right:4px;position:relative;top:-1px}
code.hex{font-size:11px;color:#1e1e2e;vertical-align:middle}
code.noncolor{font-size:11px;color:#444;background:#f4f4f8;border:1px solid #e0e0ea;border-radius:3px;padding:1px 5px}
.opacity-badge{font-size:10px;color:#6b21a8;background:#f3e8ff;border:1px solid #d8b4fe;border-radius:4px;padding:1px 5px;margin-left:4px;vertical-align:middle;font-weight:500}
.alias-name{font-size:11px;color:#0369a1;vertical-align:middle;max-width:260px;overflow:hidden;text-overflow:ellipsis;display:inline-block;white-space:nowrap;cursor:default}
td.empty{color:#ddd;font-size:11px;padding:4px 10px}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:middle;flex-shrink:0}
.dot.s{background:#22c55e}.dot.p{background:#eab308}.dot.st{background:#ef4444}.dot.lo{background:#a855f7}
.badge{display:inline-flex;align-items:center;padding:2px 7px;border-radius:8px;font-size:10px;font-weight:600;white-space:nowrap}
.badge.synced,.badge.match{background:#dcfce7;color:#166534}
.badge.pending,.badge.drift{background:#fef9c3;color:#854d0e}
.badge.stale,.badge.missing{background:#fee2e2;color:#991b1b}
.badge.local,.badge.alias-fail{background:#ede9fe;color:#5b21b6}
.badge.new-skip{background:#fef3c7;color:#92400e}
.tp{padding:1px 5px;border-radius:3px;font-size:10px;font-weight:500}
.tp-COLOR{background:#dbeafe;color:#1e40af}.tp-FLOAT{background:#ede9fe;color:#5b21b6}
.tp-BOOLEAN{background:#fef3c7;color:#92400e}.tp-STRING{background:#dcfce7;color:#166534}.tp-—{background:#f3f4f6;color:#6b7280}
tr.hidden{display:none}
.empty-msg{padding:40px;text-align:center;color:#aaa;font-size:13px}
</style></head><body>
<div class="top">
  <div class="top-title">
    <h1>${title}</h1>
    <div class="meta">${metaHtml}</div>
  </div>
  <div class="sum">
    ${statCardsHtml}
  </div>
</div>
${extraHeadHtml}
<div class="nav">
  <div class="tabs-hdr">Collections</div>
  <div class="tabs">${tabsHtml}</div>
  <div class="toolbar">
    ${filterBtnsHtml}
    <span class="col-info" id="col-info"></span>
    <input type="text" id="q" placeholder="Search token…" oninput="apply()">
  </div>
</div>
<div id="main">${sections}</div>
<script>
let af='ALL', activeCol=${safeFirst};
function updateFilterCounts(){
  const sec=document.querySelector('.col-section[data-col="'+activeCol+'"]');
  if(!sec)return;
  let cs={};
  try{cs=JSON.parse(decodeURIComponent(sec.dataset.counts||'{}'));}catch{}
  document.querySelectorAll('.fbtn[data-filter]').forEach(btn=>{
    const f=btn.dataset.filter;
    const el=btn.querySelector('.fcount');
    if(!el)return;
    const n=cs[f]??0;
    el.textContent=n;
    el.classList.toggle('fcount-zero',n===0);
  });
}
function switchTab(col,btn){
  activeCol=col;
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.col-section').forEach(s=>s.classList.remove('active'));
  const sec=document.querySelector('.col-section[data-col="'+col+'"]');
  if(sec)sec.classList.add('active');
  document.getElementById('q').value='';
  af='ALL';
  document.querySelectorAll('.fbtn').forEach(b=>b.classList.remove('on'));
  document.querySelectorAll('.fbtn')[0].classList.add('on');
  updateFilterCounts();
  apply();
  setNavH();
}
function setF(f,btn){af=f;document.querySelectorAll('.fbtn').forEach(b=>b.classList.remove('on'));btn.classList.add('on');apply();}
function apply(){
  const q=document.getElementById('q').value.toLowerCase();
  const sec=document.querySelector('.col-section[data-col="'+activeCol+'"]');
  if(!sec)return;
  const rows=sec.querySelectorAll('tr.tr');
  let vis=0;
  rows.forEach(r=>{
    const show=(af==='ALL'||r.dataset.status===af)&&(!q||r.querySelector('.tname code').textContent.toLowerCase().includes(q));
    r.classList.toggle('hidden',!show);
    if(show)vis++;
  });
  sec.querySelectorAll('tr.gr').forEach(g=>{
    let sib=g.nextElementSibling,hasVis=false;
    while(sib&&!sib.classList.contains('gr')){if(!sib.classList.contains('hidden'))hasVis=true;sib=sib.nextElementSibling;}
    g.classList.toggle('hidden',!hasVis);
  });
  let em=sec.querySelector('.empty-msg');
  if(!em){em=document.createElement('div');em.className='empty-msg';sec.querySelector('.tw').appendChild(em);}
  em.style.display=vis?'none':'block';
  em.textContent=vis?'':'No tokens match this filter.';
  document.getElementById('col-info').textContent=vis+' token'+(vis===1?'':'s')+' shown';
}
function setNavH(){
  const nav=document.querySelector('.nav');
  if(nav)document.documentElement.style.setProperty('--nav-h',nav.offsetHeight+'px');
}
window.addEventListener('resize',setNavH,{passive:true});
document.addEventListener('DOMContentLoaded',()=>{
  const first=document.querySelector('.col-section');
  if(first)first.classList.add('active');
  updateFilterCounts();
  apply();
  setNavH();
});
</script></body></html>`;
}
