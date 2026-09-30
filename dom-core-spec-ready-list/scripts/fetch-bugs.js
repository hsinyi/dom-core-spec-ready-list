#!/usr/bin/env node
// Fetches open Bugzilla DOM Core bugs with WHATWG/W3C spec links,
// checks each GitHub PR/issue status, and writes index.html.
// Requires Node.js 18+ (built-in fetch).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── config ────────────────────────────────────────────────────────────────────

const COMPONENTS = [
  'DOM: Bindings (WebIDL)',
  'DOM: Copy & Paste and Drag & Drop',
  'DOM: Core & HTML',
  'DOM: Editor',
  'DOM: Events',
  'DOM: Forms',
  'DOM: Geolocation',
  'DOM: HTML Parser',
  'DOM: Navigation',
  'DOM: Selection',
  'DOM: Serializers',
  'DOM: UI Events & Focus Handling',
  'DOM: Window and Location',
  'XML',
  'XPConnect',
  'XSLT',
];

const BZ_BASE        = 'https://bugzilla.mozilla.org/rest/bug';
const GH_TOKEN       = process.env.GITHUB_TOKEN || '';
const GH_SPEC_RE     = /github\.com\/(?:whatwg|w3c)\//i;
const GH_LINK_RE     = /https?:\/\/github\.com\/(?:whatwg|w3c)\/[^\s<>"')]+\/(?:pull|issues?)\/\d+/gi;
const INCLUDE_FIELDS = [
  'id', 'summary', 'component', 'priority', 'severity',
  'keywords', 'see_also', 'creation_time', 'last_change_time',
  'assigned_to', 'status', 'type', 'bug_type',
].join(',');

// ── helpers ───────────────────────────────────────────────────────────────────

async function timedFetch(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(timer);
    return resp;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function runPool(items, concurrency, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

function log(msg) { process.stdout.write(msg); }
function logln(msg = '') { console.log(msg); }

// ── bugzilla fetch ────────────────────────────────────────────────────────────

async function bzQuery(params, timeoutMs = 35000) {
  const resp = await timedFetch(`${BZ_BASE}?${params}`,
    { headers: { Accept: 'application/json' } }, timeoutMs);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return data.bugs || [];
}

async function fetchBugs() {
  const n = COMPONENTS.length;

  logln('Phase 1 — see_also queries');
  let done = 0;
  const seeAlsoResults = await Promise.allSettled(
    COMPONENTS.map(async (component) => {
      const p = new URLSearchParams({
        product: 'Core', resolution: '---',
        f1: 'see_also', o1: 'anywordssubstr', v1: 'whatwg w3c/',
        include_fields: INCLUDE_FIELDS, limit: 500,
      });
      p.append('component', component);
      try {
        const r = await bzQuery(p);
        log(`\r  ${++done}/${n} done`);
        return r;
      } catch (e) {
        log(`\r  ${++done}/${n} done`);
        logln(`\n  [warn] see_also "${component}": ${e.message}`);
        return [];
      }
    })
  );
  logln();

  logln('Phase 2 — longdesc (description + comments) queries');
  done = 0;
  const longdescResults = await Promise.allSettled(
    COMPONENTS.map(async (component) => {
      const p = new URLSearchParams({
        product: 'Core', resolution: '---',
        f1: 'longdesc', o1: 'anywordssubstr', v1: 'whatwg w3c/',
        include_fields: INCLUDE_FIELDS, limit: 500,
      });
      p.append('component', component);
      try {
        const r = await bzQuery(p, 50000);
        log(`\r  ${++done}/${n} done`);
        return r;
      } catch (e) {
        log(`\r  ${++done}/${n} done`);
        logln(`\n  [warn] longdesc "${component}": ${e.message}`);
        return [];
      }
    })
  );
  logln();

  // Merge, deduplicating by id
  const seen = new Set();
  const bugs = [];
  for (const r of [...seeAlsoResults, ...longdescResults]) {
    for (const bug of (r.status === 'fulfilled' ? r.value : [])) {
      if (!seen.has(bug.id)) { seen.add(bug.id); bugs.push(bug); }
    }
  }
  return bugs;
}

async function fetchBugDescriptions(bugs) {
  logln(`Phase 3 — fetching descriptions for ${bugs.length} bugs without GitHub spec links`);
  let done = 0;
  await runPool(bugs, 8, async (bug) => {
    try {
      const resp = await timedFetch(
        `${BZ_BASE}/${bug.id}/comment?include_fields=count,text`,
        { headers: { Accept: 'application/json' } }, 15000
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const text = data.bugs?.[String(bug.id)]?.comments?.[0]?.text || '';
      const extracted = [...text.matchAll(new RegExp(GH_LINK_RE.source, 'gi'))].map(m => m[0]);
      if (extracted.length) {
        bug.see_also = [...new Set([...(bug.see_also || []), ...extracted])];
      }
    } catch (e) {
      logln(`\n  [warn] comment fetch bug ${bug.id}: ${e.message}`);
    }
    log(`\r  ${++done}/${bugs.length} done`);
  });
  logln();
}

// ── github check ──────────────────────────────────────────────────────────────

const ghCache = new Map();
let rateLimited = false;

async function checkGhLink(url) {
  if (ghCache.has(url)) return ghCache.get(url);
  if (rateLimited) return { status: 'rate-limited', title: '' };

  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/(pull|issues?)\/(\d+)/i);
  if (!m) return { status: 'none', title: '' };

  const [, repo, type, num] = m;
  const isPr = type.startsWith('pull');
  const endpoint = `https://api.github.com/repos/${repo}/${isPr ? 'pulls' : 'issues'}/${num}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dom-spec-gap-tracker',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GH_TOKEN) headers['Authorization'] = `Bearer ${GH_TOKEN}`;

  try {
    const resp = await timedFetch(endpoint, { headers }, 12000);
    if (resp.status === 403 || resp.status === 429) {
      logln('\n  [warn] GitHub rate limit hit');
      rateLimited = true;
      return cache(url, { status: 'rate-limited', title: '' });
    }
    if (!resp.ok) return cache(url, { status: 'error', title: '' });
    const d = await resp.json();
    const status = isPr
      ? (d.merged ? 'merged' : d.state === 'closed' ? 'pr-closed' : 'open')
      : (d.state === 'closed' ? 'closed' : 'open');
    return cache(url, { status, title: d.title || '' });
  } catch (e) {
    return cache(url, { status: 'error', title: '' });
  }
}

function cache(url, val) { ghCache.set(url, val); return val; }

function rankStatus(s) {
  return { merged: 4, 'pr-closed': 3, closed: 3, open: 2, 'rate-limited': 1, error: 1, none: 0 }[s] ?? 0;
}

function extractGhLinks(seeAlso = []) {
  const links = [];
  for (const url of seeAlso) {
    if (!url.includes('whatwg') && !url.includes('w3c/')) continue;
    const m = url.match(/github\.com\/([^/]+\/[^/]+)\/(pull|issues?)\/(\d+)/i);
    if (m) links.push({ url, repo: m[1], type: m[2].startsWith('pull') ? 'pull' : 'issue', number: +m[3] });
  }
  return links;
}

// ── html generation ───────────────────────────────────────────────────────────

function generateHtml(bugs, updatedAt) {
  // Escape </ so bug summaries like "</script>" don't break the inline script block.
  const payload = JSON.stringify(bugs.map(b => ({
    id: b.id,
    summary: b.summary,
    component: b.component,
    priority: b.priority || '--',
    severity: b.severity || '--',
    type: b.type || b.bug_type || '',
    assigned_to: b.assigned_to || '',
    creation_time: b.creation_time || '',
    last_change_time: b.last_change_time || '',
    _specStatus: b._specStatus,
    _specTitle: b._specTitle,
    _specUrl: b._specUrl,
  }))).replace(/<\//g, '<\\/');

  return `<!DOCTYPE html>
<html lang="en" data-theme="">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DOM Core Spec Gap Tracker</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap">
<style>
:root{--bg:#F0F4FA;--surface:#FFFFFF;--surface-alt:#F7F9FD;--border:#C8D4E8;--border-light:#DDE6F5;--text:#1A2540;--text-muted:#5C6E90;--text-faint:#8FA0C0;--accent:#D94F18;--accent-dim:#FFF0EB;--merged-fg:#1B7A3E;--merged-bg:#E6F7EC;--merged-bar:#2EAD5E;--closed-fg:#1B5E8A;--closed-bg:#E6F0FA;--closed-bar:#3B9FDE;--open-fg:#8B5900;--open-bg:#FFF7E0;--open-bar:#F5C518;--none-fg:#5C6E90;--none-bg:#EEF2FA;--none-bar:#B0BDD8;--font-body:'Inter',system-ui,sans-serif;--font-mono:'IBM Plex Mono','Menlo','Consolas',monospace;--radius:6px;--row-h:52px}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#080C18;--surface:#0D1425;--surface-alt:#111A30;--border:#1E2D4A;--border-light:#182038;--text:#C8D8F5;--text-muted:#6070A0;--text-faint:#3A4870;--accent:#FF7139;--accent-dim:#2A1408;--merged-fg:#3DBD62;--merged-bg:#071A10;--merged-bar:#2EAD5E;--closed-fg:#5BA8E0;--closed-bg:#071525;--closed-bar:#3B9FDE;--open-fg:#D4A017;--open-bg:#1C1200;--open-bar:#C49010;--none-fg:#6070A0;--none-bg:#0E1628;--none-bar:#2A3555}}
:root[data-theme="dark"]{--bg:#080C18;--surface:#0D1425;--surface-alt:#111A30;--border:#1E2D4A;--border-light:#182038;--text:#C8D8F5;--text-muted:#6070A0;--text-faint:#3A4870;--accent:#FF7139;--accent-dim:#2A1408;--merged-fg:#3DBD62;--merged-bg:#071A10;--merged-bar:#2EAD5E;--closed-fg:#5BA8E0;--closed-bg:#071525;--closed-bar:#3B9FDE;--open-fg:#D4A017;--open-bg:#1C1200;--open-bar:#C49010;--none-fg:#6070A0;--none-bg:#0E1628;--none-bar:#2A3555}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--font-body);font-size:14px;line-height:1.5;background:var(--bg);color:var(--text);min-height:100vh}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.page-header{background:var(--surface);border-bottom:1px solid var(--border);padding:20px 28px 16px;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.header-left{display:flex;flex-direction:column;gap:4px}
.wordmark{font-family:var(--font-mono);font-size:11px;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
.page-title{font-family:var(--font-mono);font-size:22px;font-weight:600;color:var(--text);letter-spacing:-.02em}
.page-subtitle{font-size:13px;color:var(--text-muted);margin-top:2px;max-width:560px}
.header-actions{display:flex;align-items:center;gap:10px;flex-shrink:0;margin-top:4px}
.btn{font-family:var(--font-body);font-size:13px;font-weight:500;padding:7px 14px;border-radius:var(--radius);border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;transition:background .1s,border-color .1s}
.btn:hover{background:var(--surface-alt);border-color:var(--text-faint)}
.stats-bar{background:var(--surface);border-bottom:1px solid var(--border);padding:10px 28px;display:flex;align-items:center;gap:24px;flex-wrap:wrap}
.stat{display:flex;align-items:baseline;gap:5px}
.stat-num{font-family:var(--font-mono);font-size:18px;font-weight:600;color:var(--text);font-variant-numeric:tabular-nums}
.stat-label{font-size:12px;color:var(--text-muted)}
.stat-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:4px}
.stat-dot.merged{background:var(--merged-bar)}.stat-dot.closed{background:var(--closed-bar)}.stat-dot.open{background:var(--open-bar)}
.stats-divider{width:1px;height:20px;background:var(--border)}
.freshness{font-size:11px;color:var(--text-faint);font-family:var(--font-mono);margin-left:auto}
.filter-bar{position:sticky;top:0;z-index:10;background:var(--surface-alt);border-bottom:1px solid var(--border);padding:10px 28px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.filter-group{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.filter-label{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-faint);white-space:nowrap}
.chip{font-size:12px;font-weight:500;padding:3px 10px;border-radius:100px;border:1px solid var(--border);background:var(--surface);color:var(--text-muted);cursor:pointer;transition:all .1s;white-space:nowrap}
.chip:hover{border-color:var(--text-muted);color:var(--text)}
.chip.active{background:var(--text);color:var(--bg);border-color:var(--text)}
.chip.spec-merged.active{background:var(--merged-bar);border-color:var(--merged-bar);color:#fff}
.chip.spec-closed.active{background:var(--closed-bar);border-color:var(--closed-bar);color:#fff}
.chip.spec-open.active{background:var(--open-bar);border-color:var(--open-bar);color:var(--text)}
.filter-sep{width:1px;height:18px;background:var(--border)}
.since-select{font-family:var(--font-body);font-size:12px;font-weight:500;padding:3px 24px 3px 8px;border-radius:100px;border:1px solid var(--border);background:var(--surface);color:var(--text-muted);cursor:pointer;appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%238FA0C0' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 8px center}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;table-layout:fixed}
thead{position:sticky;top:48px;z-index:5;background:var(--surface-alt)}
th{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-faint);padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap}
th.sortable{cursor:pointer;user-select:none}th.sortable:hover{color:var(--text-muted)}
th .sort-indicator{margin-left:4px;opacity:.5}
col.col-status{width:5px}col.col-id{width:88px}col.col-summary{width:auto}col.col-comp{width:180px}col.col-spec{width:140px}col.col-type{width:90px}col.col-pri{width:56px}col.col-updated{width:90px}
td{padding:0 12px;height:var(--row-h);vertical-align:middle;border-bottom:1px solid var(--border-light);color:var(--text)}
td.status-bar{padding:0;width:5px}
.status-stripe{display:block;width:4px;height:var(--row-h)}
tr.status-merged .status-stripe{background:var(--merged-bar)}
tr.status-closed .status-stripe{background:var(--closed-bar)}
tr.status-open   .status-stripe{background:var(--open-bar)}
tr.status-none   .status-stripe{background:var(--none-bar)}
tr:hover td{background:var(--surface-alt)}
tr:nth-child(even) td{background:color-mix(in srgb,var(--surface-alt) 40%,transparent)}
tr:nth-child(even):hover td{background:var(--surface-alt)}
.bug-id{font-family:var(--font-mono);font-size:12px;font-weight:500;color:var(--accent)}
.summary-cell{max-width:0;overflow:hidden}
.summary-inner{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.summary-inner a{color:var(--text);font-weight:500}.summary-inner a:hover{color:var(--accent);text-decoration:underline}
.comp-badge{font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;max-width:100%}
.spec-badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:3px 8px;border-radius:4px;white-space:nowrap;letter-spacing:.02em}
.spec-badge a{color:inherit}.spec-badge a:hover{text-decoration:underline}
.spec-merged{color:var(--merged-fg);background:var(--merged-bg)}
.spec-closed{color:var(--closed-fg);background:var(--closed-bg)}
.spec-open{color:var(--open-fg);background:var(--open-bg)}
.spec-none{color:var(--none-fg);background:var(--none-bg)}
.type-badge{font-size:11px;font-weight:500;padding:2px 7px;border-radius:4px;border:1px solid var(--border);color:var(--text-muted);white-space:nowrap}
.type-badge.enhancement{color:var(--closed-fg);border-color:var(--closed-bar);background:var(--closed-bg)}
.pri-cell{font-family:var(--font-mono);font-size:12px;color:var(--text-muted);font-variant-numeric:tabular-nums}
.pri-cell.p1{color:var(--accent);font-weight:600}.pri-cell.p2{color:var(--open-fg)}
.date-cell{font-family:var(--font-mono);font-size:11px;color:var(--text-muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.empty-msg{padding:60px 28px;text-align:center;color:var(--text-muted)}
.page-footer{padding:16px 28px;border-top:1px solid var(--border);font-size:12px;color:var(--text-faint)}
.page-footer a{color:var(--text-muted)}.page-footer a:hover{color:var(--accent)}
@media(max-width:640px){.page-header{padding:16px}.stats-bar,.filter-bar{padding:10px 16px}.filter-sep,.stats-divider{display:none}th,td{padding:0 8px}col.col-comp{width:120px}col.col-type,col.col-updated{display:none}}
</style>
</head>
<body>
<header class="page-header">
  <div class="header-left">
    <span class="wordmark">Firefox DOM Core</span>
    <h1 class="page-title">Spec Gap Tracker</h1>
    <p class="page-subtitle">Open bugs where a WHATWG or W3C spec PR/issue has merged or closed, but Firefox hasn't shipped the feature yet.</p>
  </div>
  <div class="header-actions">
    <button class="btn" id="themeBtn" title="Toggle theme">◑</button>
    <button class="btn" id="exportBtn">Export CSV</button>
  </div>
</header>

<div class="stats-bar">
  <div class="stat"><span class="stat-num" id="statTotal">—</span><span class="stat-label">bugs</span></div>
  <div class="stats-divider"></div>
  <div class="stat"><span class="stat-dot merged"></span><span class="stat-num" id="statMerged" style="color:var(--merged-fg)">—</span><span class="stat-label">spec merged</span></div>
  <div class="stat"><span class="stat-dot closed"></span><span class="stat-num" id="statClosed" style="color:var(--closed-fg)">—</span><span class="stat-label">spec closed</span></div>
  <div class="stat"><span class="stat-dot open"></span><span class="stat-num" id="statOpen" style="color:var(--open-fg)">—</span><span class="stat-label">spec still open</span></div>
  <span class="freshness" id="freshnessLabel"></span>
</div>

<div class="filter-bar">
  <div class="filter-group">
    <span class="filter-label">Spec</span>
    <button class="chip spec-merged active" data-spec="merged">Spec merged</button>
    <button class="chip spec-closed active" data-spec="closed">Spec closed</button>
    <button class="chip spec-open active" data-spec="open">Spec open</button>
    <button class="chip active" data-spec="none">Unverified</button>
  </div>
  <div class="filter-sep"></div>
  <div class="filter-group" id="compFilterGroup">
    <span class="filter-label">Component</span>
    <button class="chip active" data-comp="all">All</button>
  </div>
  <div class="filter-sep"></div>
  <div class="filter-group">
    <span class="filter-label">Created since</span>
    <select id="sinceSelect" class="since-select">
      <option value="">Any date</option>
      <option value="2022-01-01">2022+</option>
      <option value="2020-01-01">2020+</option>
      <option value="2019-01-01">2019+</option>
      <option value="2017-01-01">2017+</option>
      <option value="2015-01-01">2015+</option>
    </select>
  </div>
</div>

<main>
  <div class="table-wrap">
    <table id="bugTable">
      <colgroup>
        <col class="col-status"><col class="col-id"><col class="col-summary">
        <col class="col-comp"><col class="col-spec"><col class="col-type">
        <col class="col-pri"><col class="col-updated">
      </colgroup>
      <thead>
        <tr>
          <th></th>
          <th class="sortable" data-col="id">Bug <span class="sort-indicator"></span></th>
          <th>Summary</th>
          <th class="sortable" data-col="component">Component <span class="sort-indicator"></span></th>
          <th class="sortable" data-col="_specStatus">Spec status <span class="sort-indicator"></span></th>
          <th>Type</th>
          <th class="sortable" data-col="priority">Pri <span class="sort-indicator"></span></th>
          <th class="sortable" data-col="last_change_time">Updated <span class="sort-indicator"></span></th>
        </tr>
      </thead>
      <tbody id="bugBody"></tbody>
    </table>
    <div class="empty-msg" id="emptyMsg" hidden>No bugs match the current filters.</div>
  </div>
</main>

<footer class="page-footer">
  Updated ${updatedAt} · Data from <a href="https://bugzilla.mozilla.org" target="_blank">Bugzilla</a> and GitHub · Refreshed nightly via GitHub Actions
</footer>

<script>
const BUGS = ${payload};
const UPDATED_AT = ${JSON.stringify(updatedAt)};

// ── state ──
const activeSpec = new Set(['merged','closed','pr-closed','open','none']);
let activeComp = 'all';
let activeSince = '';
let sortCol = '_specStatus';
let sortDir = -1; // -1 = desc (best first)

// ── spec helpers ──
const STATUS_RANK = {merged:4,'pr-closed':3,closed:3,open:2,error:1,'rate-limited':1,none:0};
function specClass(b) {
  const s = b._specStatus;
  if (s === 'merged') return 'merged';
  if (s === 'closed' || s === 'pr-closed') return 'closed';
  if (s === 'open') return 'open';
  return 'none';
}
function specBadge(b) {
  const s = b._specStatus, cls = specClass(b);
  const labels = {merged:'✓ Merged','pr-closed':'PR closed',closed:'Issue closed',open:'Open',none:'—',error:'?','rate-limited':'?'};
  const label = labels[s] || '—';
  if (b._specUrl) return \`<span class="spec-badge spec-\${cls}"><a href="\${b._specUrl}" target="_blank" rel="noopener">\${label}</a></span>\`;
  return \`<span class="spec-badge spec-\${cls}">\${label}</span>\`;
}
function typeBadge(b) {
  const t = (b.type || '').toLowerCase();
  const isEnh = t.includes('enhancement') || t.includes('task');
  return \`<span class="type-badge\${isEnh?' enhancement':''}">\${b.type||'—'}</span>\`;
}
function priClass(p) { if(p==='P1')return 'p1'; if(p==='P2')return 'p2'; return ''; }

// ── components list ──
const allComps = [...new Set(BUGS.map(b => b.component))].sort();
const grp = document.getElementById('compFilterGroup');
allComps.forEach(c => {
  const btn = document.createElement('button');
  btn.className = 'chip'; btn.dataset.comp = c;
  btn.textContent = c.replace(/^DOM: /,'');
  grp.appendChild(btn);
});

// ── render ──
function render() {
  const sinceMs = activeSince ? new Date(activeSince).getTime() : 0;
  let rows = BUGS.filter(b => {
    if (!activeSpec.has(specClass(b))) return false;
    if (activeComp !== 'all' && b.component !== activeComp) return false;
    if (sinceMs && new Date(b.creation_time).getTime() < sinceMs) return false;
    return true;
  });

  rows.sort((a, b) => {
    let av = a[sortCol], bv = b[sortCol];
    if (sortCol === '_specStatus') { av = STATUS_RANK[a._specStatus]??0; bv = STATUS_RANK[b._specStatus]??0; }
    if (av < bv) return sortDir;
    if (av > bv) return -sortDir;
    return 0;
  });

  const tbody = document.getElementById('bugBody');
  tbody.innerHTML = rows.map(b => {
    const cls = specClass(b);
    const updated = b.last_change_time ? b.last_change_time.slice(0,10) : '';
    return \`<tr class="status-\${cls}">
      <td class="status-bar"><span class="status-stripe"></span></td>
      <td><a class="bug-id" href="https://bugzilla.mozilla.org/show_bug.cgi?id=\${b.id}" target="_blank" rel="noopener">\${b.id}</a></td>
      <td class="summary-cell"><div class="summary-inner"><a href="https://bugzilla.mozilla.org/show_bug.cgi?id=\${b.id}" target="_blank" rel="noopener">\${esc(b.summary)}</a></div></td>
      <td><span class="comp-badge" title="\${esc(b.component)}">\${esc(b.component.replace(/^DOM: /,''))}</span></td>
      <td>\${specBadge(b)}</td>
      <td>\${typeBadge(b)}</td>
      <td class="pri-cell \${priClass(b.priority)}">\${b.priority||'—'}</td>
      <td class="date-cell">\${updated}</td>
    </tr>\`;
  }).join('');

  document.getElementById('emptyMsg').hidden = rows.length > 0;
  document.getElementById('statTotal').textContent = rows.length;
  document.getElementById('statMerged').textContent = rows.filter(b=>b._specStatus==='merged').length;
  document.getElementById('statClosed').textContent = rows.filter(b=>['closed','pr-closed'].includes(b._specStatus)).length;
  document.getElementById('statOpen').textContent = rows.filter(b=>b._specStatus==='open').length;
}

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── freshness ──
document.getElementById('freshnessLabel').textContent = 'Updated ' + new Date(UPDATED_AT).toLocaleDateString(undefined, {year:'numeric',month:'short',day:'numeric'});

// ── sort headers ──
document.querySelectorAll('th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (sortCol === col) sortDir *= -1; else { sortCol = col; sortDir = -1; }
    document.querySelectorAll('th .sort-indicator').forEach(s => s.textContent = '');
    th.querySelector('.sort-indicator').textContent = sortDir === -1 ? ' ↓' : ' ↑';
    render();
  });
});

// ── spec filter chips ──
document.querySelectorAll('[data-spec]').forEach(btn => {
  btn.addEventListener('click', () => {
    const v = btn.dataset.spec;
    const normalized = new Set(['merged','pr-closed','closed','open','none']);
    // map chip value to status values
    const map = {merged:['merged'],closed:['closed','pr-closed'],open:['open'],none:['none','error','rate-limited']};
    const targets = map[v] || [v];
    const allOn = targets.every(t => activeSpec.has(t));
    targets.forEach(t => allOn ? activeSpec.delete(t) : activeSpec.add(t));
    btn.classList.toggle('active', !allOn);
    render();
  });
});

// ── component filter ──
document.getElementById('compFilterGroup').addEventListener('click', e => {
  const btn = e.target.closest('[data-comp]');
  if (!btn) return;
  activeComp = btn.dataset.comp;
  document.querySelectorAll('[data-comp]').forEach(b => b.classList.toggle('active', b === btn));
  render();
});

// ── since filter ──
document.getElementById('sinceSelect').addEventListener('change', e => {
  activeSince = e.target.value;
  render();
});

// ── theme toggle ──
document.getElementById('themeBtn').addEventListener('click', () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
});

// ── CSV export ──
document.getElementById('exportBtn').addEventListener('click', () => {
  const sinceMs = activeSince ? new Date(activeSince).getTime() : 0;
  const visible = BUGS.filter(b => {
    if (!activeSpec.has(specClass(b))) return false;
    if (activeComp !== 'all' && b.component !== activeComp) return false;
    if (sinceMs && new Date(b.creation_time).getTime() < sinceMs) return false;
    return true;
  });
  const q = v => '"' + String(v||'').replace(/"/g,'""') + '"';
  const header = ['Bug ID','Summary','Component','Priority','Severity','Type','Spec status','Spec URL','Created','Last changed','Assigned to'];
  const csv = [header, ...visible.map(b => [
    b.id, q(b.summary), q(b.component), b.priority, b.severity,
    b.type, b._specStatus, b._specUrl, b.creation_time?.slice(0,10),
    b.last_change_time?.slice(0,10), q(b.assigned_to),
  ])].map(r => r.join(',')).join('\\r\\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
  a.download = 'dom-spec-gaps-' + new Date().toISOString().slice(0,10) + '.csv';
  a.click(); URL.revokeObjectURL(a.href);
});

// ── initial render ──
render();
</script>
</body>
</html>`;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  logln('=== DOM Core Spec Gap Tracker ===');

  logln('\nFetching bugs from Bugzilla...');
  const rawBugs = await fetchBugs();
  logln(`  Total unique bugs: ${rawBugs.length}`);

  const descBugs = rawBugs.filter(b => !b.see_also?.some(u => GH_SPEC_RE.test(u)));
  if (descBugs.length) {
    logln();
    await fetchBugDescriptions(descBugs);
  }

  // Collect unique GitHub links
  const allLinks = new Map();
  for (const bug of rawBugs) {
    for (const link of extractGhLinks(bug.see_also)) {
      if (!allLinks.has(link.url)) allLinks.set(link.url, link);
    }
  }

  logln(`\nPhase 4 — checking ${allLinks.size} GitHub links`);
  let ghDone = 0;
  await runPool([...allLinks.values()], 8, async (link) => {
    const result = await checkGhLink(link.url);
    link.ghStatus = result.status;
    link.ghTitle  = result.title;
    log(`\r  ${++ghDone}/${allLinks.size} done`);
  });
  logln();

  // Annotate bugs
  for (const bug of rawBugs) {
    bug._specStatus = 'none';
    bug._specTitle  = '';
    bug._specUrl    = '';
    for (const link of extractGhLinks(bug.see_also)) {
      const l = allLinks.get(link.url);
      if (l && rankStatus(l.ghStatus) > rankStatus(bug._specStatus)) {
        bug._specStatus = l.ghStatus;
        bug._specTitle  = l.ghTitle;
        bug._specUrl    = link.url;
      }
    }
  }

  const updatedAt = new Date().toISOString();
  logln('\nGenerating index.html...');
  const html = generateHtml(rawBugs, updatedAt);
  fs.writeFileSync(path.join(ROOT, 'index.html'), html, 'utf8');

  logln('\nDone.');
  logln(`  Total:  ${rawBugs.length}`);
  logln(`  Merged: ${rawBugs.filter(b => b._specStatus === 'merged').length}`);
  logln(`  Closed: ${rawBugs.filter(b => ['closed','pr-closed'].includes(b._specStatus)).length}`);
  logln(`  Open:   ${rawBugs.filter(b => b._specStatus === 'open').length}`);
  logln(`  None:   ${rawBugs.filter(b => b._specStatus === 'none').length}`);
  if (rateLimited) logln('\n  [!] GitHub rate limit was hit — some statuses may be missing. Add GITHUB_TOKEN for 5000 req/hr.');
}

main().catch(e => { console.error(e); process.exit(1); });
