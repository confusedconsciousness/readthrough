// Odyssey front end: one IIFE. state → helpers → routing → home → PR panes → flow map → events.
(() => {
  'use strict';

  // ---------- state ----------

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const view = $('#view'), crumb = $('#crumb'), status = $('#status');
  // cur: { key, pr, story, err, serr, t0, sel } — sel is 'overview' | stop index | 'unread' | 'merge'
  let cur = null;
  let me = null;    // { mode: 'hosted'|'local', user, installs, installURL } from /api/me

  const store = {
    get: (k, d) => { try { return JSON.parse(localStorage.getItem('odyssey:' + k)) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem('odyssey:' + k, JSON.stringify(v)); } catch {} },
  };
  const doneKey = () => `done:${cur.key}@${cur.story.meta.sha}`;
  const done = () => new Set(cur?.story ? store.get(doneKey(), []) : []);

  // ---------- helpers ----------

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // A dropped connection (the server restarted, say) gets a plain message instead of the browser's "Failed to fetch".
  const LOST = 'Lost the connection to Odyssey. If it restarted, a read in progress stopped with it. Press Try again.';
  const api = (p) => fetch(p).catch(() => { throw new Error(LOST); }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && me?.user) { me.user = null; account(); landing(); }
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  });
  const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  const ago = (iso) => {
    const m = (Date.now() - Date.parse(iso)) / 60000;
    return m < 60 ? `${Math.max(1, m | 0)}m` : m < 1440 ? `${(m / 60) | 0}h` : `${(m / 1440) | 0}d`;
  };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const base = (p) => p.split('/').pop();
  const pathHtml = (p) => {
    const i = p.lastIndexOf('/') + 1;
    return `<span class="dir">${esc(p.slice(0, i))}</span>${esc(p.slice(i))}`;
  };
  const refOf = (v) => {
    const m = String(v).trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//, '').match(/^([\w.-]+)\/([\w.-]+)(?:\/pull\/|#|\/)(\d+)/);
    return m && `${m[1]}/${m[2]}/${m[3]}`;
  };
  const delta = (a, d) => `<span class="up">+${a}</span> <span class="down">−${d}</span>`;
  const LETTER = { added: 'A', modified: 'M', removed: 'D', renamed: 'R', copied: 'C', changed: 'M' };

  const index = (pr) => pr._ix || (pr._ix = new Map([...pr.files, ...(pr.since?.files || [])].flatMap((f) => f.hunks.map((h) => [h.id, { f, h }]))));
  const hasSince = (pr) => !!(pr?.since && (pr.since.rewritten || pr.since.commits.length));
  const loc = (id, row) => {
    const x = cur?.pr && index(cur.pr).get(id);
    if (!x) return id;
    const l = row && x.h.lines[row - 1];
    return `${base(x.f.path)}:${l ? l[2] ?? l[1] : x.h.start}`;
  };

  // Backticks → code; hunk ids the model cites (f9h1) → links that reveal that code.
  const prose = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/(?:<code>)?\b(f\d+h\d+)\b(?:<\/code>)?/g, (m, id) =>
    cur?.pr && index(cur.pr).has(id) ? `<a class="loc" data-hunk="${id}">${esc(loc(id))}</a>` : m);

  function unread(pr, s) {
    const seen = new Set(s.stops.flatMap((st) => st.hunks));
    const live = pr.files.filter((f) => !f.generated);
    return {
      hunks: live.flatMap((f) => f.hunks.filter((h) => !seen.has(h.id)).map((h) => h.id)),
      files: live.filter((f) => f.nodiff),
    };
  }

  // ---------- routing ----------

  function parse() {
    const m = location.hash.match(/^#\/([\w.-]+)\/([\w.-]+)\/(\d+)(?:\/(\w+))?/);
    if (!m) return null;
    return { key: `${m[1]}/${m[2]}/${m[3]}`, sel: !m[4] ? 'auto' : /^\d+$/.test(m[4]) ? +m[4] - 1 : m[4] };
  }

  function route() {
    // The bare address is the front door: the landing page. The app itself lives under #/ (your tours) and #/owner/repo/n.
    if (!me?.user || ['', '#', '#/about'].includes(location.hash)) return landing();
    const h = parse();
    document.body.dataset.view = h ? 'pr' : 'home';
    if (!h) return home();
    if (cur?.key === h.key) { cur.sel = h.sel; return show(); }
    open(h.key, h.sel);
  }

  // Moving within a PR replaces the history entry, so Back leaves the PR instead of replaying every stop.
  function select(sel) {
    if (!cur) return;
    cur.sel = sel;
    if (!cur.demo) history.replaceState(null, '', `#/${cur.key}${sel === 'overview' && !hasSince(cur.pr) ? '' : '/' + (typeof sel === 'number' ? sel + 1 : sel)}`);
    show();
  }

  function order() {
    const s = cur?.story, first = [...(hasSince(cur?.pr) ? ['since'] : []), 'overview'];
    if (!s) return first;
    return [...first, ...s.stops.map((_, i) => i), ...(hasIntent(s) ? ['intent'] : []), ...(unread(cur.pr, s).hunks.length ? ['unread'] : []), 'merge'];
  }
  const hasIntent = (s) => s?.intent && s.intent.source !== 'none' && s.intent.verdict !== 'none';
  const step = (d) => { const o = order(), i = o.indexOf(cur.sel); select(o[Math.max(0, Math.min(o.length - 1, (i < 0 ? 0 : i) + d))]); };

  // One entry per PR for this page's lifetime: leaving a PR mid-read and coming back joins the same read
  // instead of starting over. Re-read (fresh) starts a new entry. Failed requests are dropped so a retry refetches.
  const memo = new Map();

  function open(key, sel = 'overview', fresh) {
    let m = memo.get(key);
    if (!m || fresh) memo.set(key, (m = { t0: Date.now() }));
    const c = cur = { key, pr: m.pr || null, story: m.story || null, err: null, serr: null, t0: m.t0, sel };
    render();
    m.prP ||= api(`/api/pr?pr=${key}`).then((pr) => { m.pr = pr; if (pr.reading && !m.story) m.t0 = pr.reading; return pr; });
    m.storyP ||= api(`/api/story?pr=${key}${fresh ? '&fresh' : ''}`).then((st) => (m.story = st));
    m.prP.then((pr) => { if (c === cur) { c.pr = pr; c.t0 = m.t0; render(); } }, (e) => { m.prP = null; if (c === cur) { c.err = e.message; render(); } });
    m.storyP.then((st) => { if (c === cur) { c.story = st; render(); } else if (!cur) refreshRecent(); }, (e) => { m.storyP = null; if (c === cur) { c.serr = e.message; render(); } });
  }

  // The reviewer: seven dimensions, each graded good / fair / poor (or unclear when the diff can't tell).
  const DIMS = [
    ['necessity', 'Necessity', 'Does every change serve the goal?'],
    ['correctness', 'Correctness', 'Does it work, edge cases included?'],
    ['bugs', 'Bugs', 'Concrete defects'],
    ['errors', 'Error handling', 'Are failures handled?'],
    ['duplication', 'Duplication', 'Repeated or reinvented logic'],
    ['cognitive_load', 'Cognitive load', 'How hard it is to hold in your head'],
    ['tests', 'Tests', 'Is the new behaviour exercised?'],
  ];
  const DIM_NAME = Object.fromEntries(DIMS.map(([k, n]) => [k, n]));
  // Small line icons in the spirit of GitHub's octicons. Colour goes on the icon only, never on boxes or text.
  const ICON = {
    check: '<circle cx="8" cy="8" r="6.25"/><path d="M5.4 8.3l1.8 1.8 3.4-3.8"/>',
    diff: '<path d="M3.75 1.75h6l2.5 2.5v10h-8.5z"/><path d="M8 5.25v3.5M6.25 7h3.5M6.25 11.25h3.5"/>',
    discuss: '<path d="M1.75 2.75h9v6.5H6.5L4 11.5V9.25H1.75z"/><path d="M11 6h3.25v6.25H12.5v2l-2.25-2H7"/>',
    alert: '<path d="M8 1.9 1.6 13.6h12.8z"/><path d="M8 6.2v3.4"/><circle cx="8" cy="11.7" r=".4" class="fill"/>',
    dot: '<circle cx="8" cy="8" r="2.25" class="fill"/>',
    minus: '<circle cx="8" cy="8" r="6.25"/><path d="M5.25 8h5.5"/>',
    half: '<circle cx="8" cy="8" r="6.25"/><path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" class="fill"/>',
    question: '<circle cx="8" cy="8" r="6.25"/><path d="M6.3 6.4a1.75 1.75 0 1 1 2.5 1.6c-.5.25-.8.6-.8 1.15"/><circle cx="8" cy="11.3" r=".4" class="fill"/>',
    task: '<rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2.5"/>',
  };
  const ic = (name, tone = '') => `<svg class="ic ${tone}" viewBox="0 0 16 16" aria-hidden="true">${ICON[name] || ''}</svg>`;

  const GRADE = { good: ['Good', '', 3], fair: ['Fair', '', 2], poor: ['Poor', 'bad', 1], unclear: ['Unclear', 'muted', 0] };
  const REC = { approve: ['Approve', 'ok', 'Approve'], approve_with_nits: ['Approve with comments', 'ok', 'Approve'], request_changes: ['Changes requested', 'bad', 'Changes'], discuss: ['Needs discussion', 'muted', 'Discuss'] };
  const REC_IC = { approve: 'check', approve_with_nits: 'check', request_changes: 'diff', discuss: 'discuss' };
  // Phrased the way GitHub heads a review: "<who> requested changes".
  const REC_SAYS = { approve: 'approved these changes', approve_with_nits: 'approved, with a few comments', request_changes: 'requested changes', discuss: 'suggests talking this through before a line-by-line review' };
  const recIc = (rec) => ic(REC_IC[rec] || 'dot', REC[rec]?.[1] || '');
  const SEV = { blocker: ['Blocker', 'bad'], major: ['Major', ''], minor: ['Minor', 'muted'], nit: ['Nit', 'muted'] };
  const meter = (g) => { const [label, tone, n] = GRADE[g] || GRADE.unclear; return `<span class="meter ${tone}" role="img" aria-label="${label}">${[1, 2, 3].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`; };
  const dimsOf = (r) => DIMS.map(([k, n, q]) => ({ key: k, name: n, q, ...(r.dimensions.find((x) => x.key === k) || { grade: 'unclear', summary: '' }), count: r.findings.filter((f) => f.dimension === k).length }));
  const tally = (r) => ['blocker', 'major'].map((sv) => { const n = r.findings.filter((f) => f.severity === sv).length; return n ? plural(n, SEV[sv][0].toLowerCase()) : ''; }).filter(Boolean).join(', ');

  // Is this stop needed for the PR's goal? Questionable and unrelated stops are what a reviewer should push back on.
  const NEED = { needed: ['Needed', 'muted'], supporting: ['Supporting', 'muted'], questionable: ['Questionable', 'warn'], unrelated: ['Not part of the goal', 'bad'] };
  const NEED_IC = { needed: 'check', supporting: 'dot', questionable: 'alert', unrelated: 'alert' };
  const needIc = (v) => ic(NEED_IC[v] || 'dot', NEED[v]?.[1] || '');
  const flagged = (st) => ['questionable', 'unrelated'].includes(st.necessity?.verdict);
  const VERDICT = { done: ['Does what was asked', 'ok', 'Yes'], partly: ['Partly does what was asked', 'muted', 'Partly'], not: ["Doesn't do what was asked", 'bad', 'No'], unclear: ["Can't tell from the diff", 'muted', '?'] };
  const STATUS = { met: ['Met', 'ok', 'check'], partial: ['Partly', 'muted', 'half'], missing: ['Missing', 'bad', 'minus'], unclear: ['Unclear', 'muted', 'question'] };
  const VERDICT_IC = { done: 'check', partly: 'half', not: 'minus', unclear: 'question' };

  // Review effort 1–5 from size alone, so it's there before any read. Thresholds are rough reading-time buckets.
  const EFFORT = ['', 'Quick', 'Small', 'Medium', 'Large', 'Very large'];
  const effort = (add, del, files) => { const n = add + del; return n <= 20 && files <= 2 ? 1 : n <= 120 && files <= 6 ? 2 : n <= 400 && files <= 15 ? 3 : n <= 1200 && files <= 40 ? 4 : 5; };
  const effortChip = (e) => `<span class="eff e${e}" title="Review effort ${e} of 5, from the size of the change"><span class="pips" aria-hidden="true">${'<i></i>'.repeat(5)}</span>${EFFORT[e]}</span>`;

  // ---------- home ----------

  const STATE = { merged: 'Merged', draft: 'Draft', closed: 'Closed', open: 'Open' };
  const REVIEW = { APPROVED: ['Approved', 'ok'], CHANGES_REQUESTED: ['Changes requested', 'bad'], REVIEW_REQUIRED: ['Needs review', ''] };
  const keyLabel = (k) => esc(k.replace(/\/(\d+)$/, '')) + `<span class="num"> #${esc(k.split('/').pop())}</span>`;

  // GitHub-style diffstat: five blocks split between additions and deletions.
  function diffstat(a, d) {
    const t = a + d, g = t ? Math.round((a / t) * 5) : 0, r = t ? Math.min(5 - g, Math.round((d / t) * 5)) : 0;
    return `<span class="ds"><span class="up">+${a}</span> <span class="down">−${d}</span> <span class="blocks" aria-hidden="true">${'<i class="g"></i>'.repeat(g)}${'<i class="r"></i>'.repeat(r)}${'<i></i>'.repeat(5 - g - r)}</span></span>`;
  }

  async function home() {
    cur = null;
    crumb.innerHTML = '';
    status.innerHTML = '';
    view.innerHTML = `<div class="home">
      <section class="start">
        <form class="go big" autocomplete="off">
          <input name="pr" placeholder="Paste a pull request link: github.com/owner/repo/pull/123" aria-label="Pull request link" spellcheck="false" autofocus>
          <button class="btn primary">Open</button>
        </form>
        <p class="hint">Odyssey turns a pull request into a guided tour, with each step pinned to the code it explains. Press <kbd>/</kbd> to come back here from anywhere.</p>
      </section>
      <section id="recent"></section>
      ${me?.mode === 'hosted' && me.installs === 0 ? `<div class="notice-plain">Odyssey's GitHub App isn't installed on any repository you can access, so there are no pull requests to list yet. ${me.installURL ? `<a href="${esc(me.installURL)}" target="_blank" rel="noopener">Install it</a> on your organization, or ask an organization admin to.` : 'Ask an organization admin to install it.'}</div>` : ''}
      <div class="lists" id="inbox">${['Waiting on your review', 'Your pull requests'].map((t) => `<section><h2>${t}</h2><ul class="prs">${'<li class="skel"><span></span></li>'.repeat(3)}</ul></section>`).join('')}</div>
    </div>`;
    refreshRecent();
    try {
      inbox = await api('/api/inbox');
      lists();
    } catch (e) {
      if ($('#inbox')) $('#inbox').innerHTML = `<p class="muted">Couldn't list pull requests: ${esc(e.message)}</p>`;
    }
  }

  let inbox = null;
  function lists() {
    if (!inbox || !$('#inbox')) return;
    const by = store.get('sort', 'recent'), sorted = (a) => (by === 'effort' ? [...a].sort((x, y) => effort(x.add, x.del, x.files) - effort(y.add, y.del, y.files) || x.add + x.del - (y.add + y.del)) : a);
    $('#inbox').innerHTML = `<div class="lists-head"><span class="muted">Sort</span><span class="seg-btns">${[['recent', 'Recent'], ['effort', 'Smallest first']].map(([k, l]) => `<button data-sort="${k}" class="${by === k ? 'on' : ''}" aria-pressed="${by === k}">${l}</button>`).join('')}</span></div>`
      + prList('Waiting on your review', sorted(inbox.review), 'Nothing is waiting on your review.') + prList('Your pull requests', sorted(inbox.mine), 'You have no open pull requests.');
  }

  function prList(title, items, empty) {
    return `<section><h2>${title} <span class="count">${items.length || ''}</span></h2>${items.length ? `<ul class="prs">${items.map((p) => {
      const [label, tone] = p.draft ? ['Draft', 'muted'] : REVIEW[p.review] || ['', ''];
      return `<li><a href="#/${esc(p.ref)}">
        ${p.avatar ? `<img class="av" src="${esc(p.avatar)}" alt="" width="20" height="20" loading="lazy">` : '<span class="av"></span>'}
        <span class="main"><span class="title">${esc(p.title)}</span><span class="sub">${esc(p.repo)} #${p.num} · ${esc(p.author)} · ${ago(p.updated)}${label ? ` · <span class="rv ${tone}">${label}</span>` : ''}</span></span>
        <span class="side">${diffstat(p.add, p.del)}<span class="files">${plural(p.files, 'file')} · ${effortChip(effort(p.add, p.del, p.files))}</span></span>
        <span class="tt ${p.tour ? 'ready' : p.reading ? 'busy' : ''}">${p.tour ? 'Tour ready' : p.reading ? 'Reading' : 'Not read'}</span>
      </a></li>`;
    }).join('')}</ul>` : `<p class="empty">${empty}</p>`}</section>`;
  }

  // Reads in progress and saved tours. Polls while something is being read, so finished reads move into the grid.
  let recentTimer;
  async function refreshRecent() {
    clearTimeout(recentTimer);
    if (!$('#recent')) return;
    let r;
    try { r = await api('/api/recent'); } catch { return; }
    const box = $('#recent');
    if (!box) return;
    const reading = r.reading.length ? `<h2>Reading now</h2><ul class="reading">${r.reading.map((x) => `<li><a href="#/${esc(x.key)}">
        <span class="pulse"></span><span class="k">${keyLabel(x.key)}</span><span class="title">${esc(x.title || '')}</span>
        <span class="muted">${esc(pretty(x.model))}</span><span class="elapsed" data-since="${x.since}">${clock(Date.now() - x.since)}</span></a></li>`).join('')}</ul>` : '';
    const cards = r.tours.map((t) => {
      const d = new Set(store.get(`done:${t.key}@${t.sha}`, [])), n = t.stops;
      return `<a class="card" href="#/${esc(t.key)}">
        <div class="thumb">${t.flow?.nodes?.length ? flowMap(t.flow, n, true) : ''}</div>
        <div class="card-body">
          <p class="card-k">${keyLabel(t.key)}${t.state ? `<span class="state s-${esc(t.state)}">${STATE[t.state] || esc(t.state)}</span>` : ''}</p>
          <h3>${esc(t.title || t.key)}</h3>
          <p class="card-gist">${prose(t.gist)}</p>
        </div>
        <div class="card-foot">
          <span class="pbar" aria-hidden="true"><i style="width:${n ? (d.size / n) * 100 : 0}%"></i></span>
          <span>${d.size === n && n ? 'All stops understood' : `${d.size}/${n} understood`}</span>
          ${t.rec ? `<span class="rec-mini">${recIc(t.rec)}${REC[t.rec]?.[0] || ''}</span>` : ''}<span class="muted">${esc(pretty(t.model))} · ${ago(t.at)}</span>
        </div>
      </a>`;
    }).join('');
    box.innerHTML = `${reading}<h2>Your tours <span class="count">${r.tours.length || ''}</span></h2>${cards
      ? `<div class="cards">${cards}</div>`
      : `<p class="empty">No tours yet. Open a pull request above and its tour is kept here. Try a public one: <a href="#/cli/cli/15002">cli/cli #15002</a>.</p>`}`;
    if (r.reading.length) recentTimer = setTimeout(refreshRecent, 4000);
  }

  // ---------- PR ----------

  function render() {
    if (!cur) return;
    const { pr, err } = cur;
    if (err || !pr) {
      crumb.innerHTML = `<span class="repo">${esc(cur.key.replace(/\/(\d+)$/, ' #$1'))}</span>`;
      status.innerHTML = err ? '' : `<span class="elapsed-wrap">Fetching from GitHub…</span>`;
      view.innerHTML = err
        ? `<div class="empty-state"><h1>Couldn't open this pull request</h1><p>${esc(err)}</p><p class="muted">Odyssey reads GitHub through <code>gh</code>. Check <code>gh auth status</code> and that you can see this repository.</p></div>`
        : `<div class="empty-state"><div class="bar-indef"></div></div>`;
      return;
    }
    const state = { merged: 'Merged', draft: 'Draft', closed: 'Closed', open: 'Open' }[pr.state] || pr.state;
    crumb.innerHTML = `<a class="repo" href="${esc(pr.url)}" target="_blank" rel="noopener">${esc(cur.key.replace(/\/(\d+)$/, ''))}<span class="num"> #${pr.ref.num}</span></a>
      <span class="ttl" title="${esc(pr.title)}">${esc(pr.title)}</span><span class="state s-${esc(pr.state)}">${state}</span>`;
    view.innerHTML = `<div class="app"><nav class="tour" aria-label="Tour">${tour()}</nav><section class="note" id="note"></section><section class="code" id="code"></section></div>`;
    show();
  }

  function tour() {
    const { pr, story: s, serr } = cur;
    const sinceRow = hasSince(pr) ? `<a class="row" data-sel="since">Since last tour<span class="c new">${pr.since.rewritten ? 'rebased' : `${pr.since.commits.length} new`}</span></a>` : '';
    if (!s) return `${sinceRow}<a class="row" data-sel="overview">Overview</a>
      ${serr ? `<p class="tour-msg bad">The tour couldn't be written.<br><button class="link" data-fresh>Try again</button></p>`
        : `<p class="tour-msg">Reading ${plural(pr.files.length, 'file')} · <span class="elapsed" data-since="${cur.t0}">${clock(Date.now() - cur.t0)}</span></p><div class="bar-indef"></div>`}`;
    const d = done(), ix = index(pr), u = unread(pr, s);
    const size = (st) => st.hunks.reduce((n, id) => n + (ix.get(id)?.h.add || 0) + (ix.get(id)?.h.del || 0), 0);
    return `${sinceRow}<a class="row" data-sel="overview">Overview</a>
      <p class="group">Stops</p>
      ${s.stops.map((st, i) => `<a class="row stop${d.has(i) ? ' done' : ''}" data-sel="${i}"><span class="mark" aria-hidden="true"></span><span class="n">${i + 1}</span><span class="t">${esc(st.title)}</span>${flagged(st) ? `<span class="c" title="${esc(NEED[st.necessity.verdict][0])}: ${esc(st.necessity.reason)}">${needIc(st.necessity.verdict)}</span>` : `<span class="c" title="lines changed">${size(st) || ''}</span>`}</a>`).join('')}
      <p class="group">Check</p>
      ${hasIntent(s) ? `<a class="row" data-sel="intent">Does it do what was asked?<span class="c">${ic(VERDICT_IC[s.intent.verdict] || 'dot', VERDICT[s.intent.verdict]?.[1] || '')}${VERDICT[s.intent.verdict]?.[2] || ''}</span></a>` : ''}
      ${u.hunks.length || u.files.length ? `<a class="row" data-sel="unread">Unexplained<span class="c warn">${u.hunks.length + u.files.length}</span></a>` : ''}
      ${s.review ? `<a class="row" data-sel="merge">Review<span class="c">${recIc(s.review.recommendation)}${REC[s.review.recommendation]?.[2] || ''}</span></a>`
        : `<a class="row" data-sel="merge">Before merging<span class="c">${s.checks?.length || ''}</span></a>`}`;
  }

  // Swap the two content panes and the selection; the tour list keeps its scroll.
  function show() {
    if (!cur?.pr || !$('#note')) return;
    const { pr, story: s } = cur;
    if (cur.sel === 'auto') cur.sel = hasSince(pr) ? 'since' : 'overview';
    // Until the tour arrives the overview stands in, but cur.sel keeps the deep link. The since view needs only the PR.
    let sel = cur.sel;
    if (sel === 'since' ? !hasSince(pr) : !s || (typeof sel === 'number' && !s.stops[sel]) || (sel === 'intent' && !hasIntent(s))) sel = 'overview';
    const [note, code] = sel === 'since' ? sincePane() : s ? pane(sel) : waiting();
    $('#note').innerHTML = note;
    $('#code').innerHTML = diffBar() + code;
    if (sel === 'overview' && s) paintView(); else stopPlay();
    $('#note').scrollTop = $('#code').scrollTop = 0;
    $$('.tour [data-sel]').forEach((a) => a.classList.toggle('sel', a.dataset.sel === String(sel)));
    if (!cur.demo) $('.tour .sel')?.scrollIntoView({ block: 'nearest' });
    bar();
  }

  // The tour on screen was written by a different model than the one now chosen in Settings.
  const stale = () => !!(cfg && cur?.story?.meta && (cfg.provider !== cur.story.meta.provider || (cfg.model && !String(cur.story.meta.model).startsWith(cfg.model))));

  function bar() {
    if (cur.demo) return;
    const s = cur.story;
    if (!s) {
      status.innerHTML = cur.serr ? `<span class="bad">The read failed. The reason is in the left-hand pane.</span>` : `<span>Reading with ${esc(reader())} · <span class="elapsed" data-since="${cur.t0}">${clock(Date.now() - cur.t0)}</span></span>`;
      return;
    }
    const d = done(), n = s.stops.length, u = unread(cur.pr, s);
    status.innerHTML = `<span class="segs" aria-hidden="true">${s.stops.map((_, i) => `<i class="${d.has(i) ? 'on' : ''}${cur.sel === i ? ' here' : ''}"></i>`).join('')}</span>
      <span><b>${d.size}</b>/${n} understood</span>
      ${u.hunks.length ? `<span class="warn">${plural(u.hunks.length, 'hunk')} unexplained</span>` : '<span>Every hunk explained</span>'}
      <span class="muted">Read by <button class="link quiet" data-settings title="Change who reads PRs">${esc(pretty(s.meta.model))}</button> in ${clock(s.meta.ms)}${s.meta.from ? ` · <span title="Only the commits after ${esc(s.meta.from.slice(0, 7))} were read; the rest of the tour carried over">updated from <code>${esc(s.meta.from.slice(0, 7))}</code></span>` : ''} · <button class="link${stale() ? ' strong' : ''}" data-fresh title="Read the whole PR again with ${esc(reader())}">${stale() ? `Re-read with ${esc(reader())}` : 'Re-read all'}</button></span>
      <span class="keys"><kbd>j</kbd><kbd>k</kbd> move <kbd>x</kbd> understood <kbd>/</kbd> open</span>`;
  }

  function waiting() {
    const { pr } = cur;
    return [`${heading(pr)}
      ${cur.serr ? `<div class="notice bad"><p>${prose(cur.serr)}</p><div class="row-end"><button class="btn" data-settings>Settings</button><button class="btn primary" data-fresh>Try again</button></div></div>`
        : `<p class="muted">The tour is being written. The diff is on the right in file order until then.</p>`}
      ${facts(pr)}${desc(pr, true)}`,
    pr.files.map((f) => fileHunks(pr, f)).join('')];
  }

  function heading(pr) {
    return `<h1 class="title">${esc(pr.title)}</h1>
      <p class="byline">${esc(pr.author)} · <code>${esc(pr.head)}</code> → <code>${esc(pr.base)}</code><br>${plural(pr.files.length, 'file')} · ${delta(pr.add, pr.del)} · ${plural(pr.commits.length, 'commit')} · ${effortChip(effort(pr.add, pr.del, pr.files.length))}</p>`;
  }

  function facts(pr) {
    if (!pr.signals.length) return '';
    return `<h2>From the file list</h2><dl class="facts">${pr.signals.map((s) => `<div class="${s.tone}"><dt>${esc(s.label)}</dt><dd>${s.files.slice(0, 3).map((p) => `<code>${esc(base(p))}</code>`).join(' ')}${s.files.length > 3 ? ` <span class="muted">+${s.files.length - 3}</span>` : ''}</dd></div>`).join('')}</dl>`;
  }

  const desc = (pr, openIt) => `<details class="desc"${openIt ? ' open' : ''}><summary>Author's description</summary><div>${pr.body.trim() ? esc(pr.body) : '<span class="muted">Empty.</span>'}</div></details>`;

  function pane(sel) {
    const { pr, story: s } = cur, d = done(), u = unread(pr, s), n = s.stops.length;
    if (sel === 'overview') return [
      `${heading(pr)}
       ${hasSince(pr) ? `<a class="banner" data-sel="since"><b>${pr.since.rewritten ? 'Rebased' : plural(pr.since.commits.length, 'new commit')}</b> since the last tour${pr.since.at ? `, ${ago(pr.since.at)} ago` : ''}<span>See what changed →</span></a>` : ''}
       <p class="lead">${prose(s.gist)}</p>
       ${s.goal ? `<p class="goal"><b>Goal.</b> ${prose(s.goal)}</p>` : ''}
       ${s.review ? `<a class="glance" data-sel="merge">
         <span class="glance-h">${recIc(s.review.recommendation)}<b>${REC[s.review.recommendation][0]}</b>${tally(s.review) ? `<span class="muted"> · ${tally(s.review)}</span>` : ''}<span class="glance-go">Open the review</span></span>
         <span class="glance-dims">${dimsOf(s.review).map((x) => `<span class="gd" title="${esc(x.name)}: ${esc(GRADE[x.grade]?.[0] || '')}. ${esc(x.summary)}">${meter(x.grade)}<span>${x.name}</span></span>`).join('')}</span>
       </a>` : ''}
       ${hasIntent(s) ? `<p class="asked"><a data-sel="intent">${ic(VERDICT_IC[s.intent.verdict] || 'dot', VERDICT[s.intent.verdict][1])}${VERDICT[s.intent.verdict][0]}</a> <span class="muted">· ${s.intent.items.filter((r) => r.status === 'met').length} of ${s.intent.items.length} requirements met, from ${s.intent.source === 'issue' ? 'the linked issue' : 'the description'}</span></p>` : ''}
       <h2>Why</h2><p>${prose(s.why)}</p>
       ${s.changes.length ? `<h2>Behaviour</h2><table class="changes"><thead><tr><th>Before</th><th>After</th></tr></thead><tbody>${s.changes.map((c) => `<tr><td>${prose(c.before)}</td><td>${prose(c.after)}</td></tr>`).join('')}</tbody></table>` : ''}
       ${facts(pr)}${desc(pr)}
       <div class="actions"><button class="btn primary" data-sel="0">Start the tour <kbd>j</kbd></button></div>`,
      `${s.flow.nodes.length ? flowBlock(s) : ''}
       <div class="block"><div class="block-head"><h2>Files</h2></div>${files(pr, s)}</div>`,
    ];
    if (sel === 'merge' && s.review) {
      const r = s.review, [recLabel, recTone] = REC[r.recommendation] || ['', ''];
      const fs = numbered(r.findings);
      return [
        `<p class="kicker">Review</p>
         <h1 class="title">Odyssey's review</h1>
         <div class="review-box">
           <div class="rb-head">${recIc(r.recommendation)}<span><b>Odyssey</b> ${REC_SAYS[r.recommendation] || ''}</span>${tally(r) ? `<span class="rb-tally">${tally(r)}</span>` : ''}</div>
           <div class="rb-body"><p>${prose(r.summary)}</p></div>
         </div>
         <h2>Scorecard</h2>
         <table class="scorecard"><tbody>${dimsOf(r).map((x) => `<tr title="${esc(x.q)}"><th>${x.name}</th><td class="m">${meter(x.grade)}<span class="grade ${x.grade}">${GRADE[x.grade]?.[0] || ''}</span></td><td class="sum">${prose(x.summary)}${x.count ? ` <span class="muted">· ${plural(x.count, 'finding')}</span>` : ''}</td></tr>`).join('')}</tbody></table>
         <p class="small muted">Graded from the diff, the description and linked issues, not the whole repository. Treat it as a second reviewer's notes, not a verdict.</p>
         <h2>Findings</h2>
         ${fs.length ? `<ol class="points findings">${fs.map((f) => `<li${f.hunk ? ` data-pt="${f.k}" tabindex="0"` : ''}><span class="pn">${f.k}</span><span class="pt-t"><span class="f-tags"><span class="sev ${f.severity}">${SEV[f.severity]?.[0] || ''}</span><span class="f-dim">${DIM_NAME[f.dimension] || ''}</span></span>${prose(f.text)}${f.suggestion ? `<span class="pt-fix">${prose(f.suggestion)}</span>` : ''}</span>${f.hunk ? `<span class="pt-at">${esc(loc(f.hunk, f.from))}</span>` : ''}</li>`).join('')}</ol>`
           : '<p class="muted">No findings. Nothing in this diff stood out as wrong.</p>'}
         ${s.stops.some(flagged) ? `<h2>Possibly unnecessary</h2><p class="small muted">Parts of the PR the goal may not need. Each reason is written so you can paste it into a review comment.</p>
           <ul class="unneeded">${s.stops.map((st, i) => (flagged(st) ? `<li>${needIc(st.necessity.verdict)}<a data-sel="${i}">${i + 1}. ${esc(st.title)}</a> <span class="need-w">${NEED[st.necessity.verdict][0]}</span><p>${prose(st.necessity.reason)}</p></li>` : '')).join('')}</ul>` : ''}
         ${s.questions.length ? `<h2>Questions for the author</h2><ul class="questions">${s.questions.map((q) => `<li>${prose(q)}</li>`).join('')}</ul>` : ''}`,
        codeFor(pr, fs, []) || '<p class="code-empty">No finding is tied to a specific line.</p>',
      ];
    }
    if (sel === 'merge') {
      const ids = [...new Set(s.checks.map((c) => c.hunk).filter(Boolean))];
      return [
        `<h1 class="title">Before merging</h1>
         ${s.checks.length ? `<ol class="checks">${s.checks.map((c) => `<li><p>${prose(c.text)}</p>${c.hunk ? `<a class="loc" data-hunk="${esc(c.hunk)}">${esc(loc(c.hunk))}</a>` : ''}</li>`).join('')}</ol>` : '<p class="muted">The model flagged nothing.</p>'}
         ${s.stops.some(flagged) ? `<h2>Possibly unnecessary</h2><p class="small muted">Parts of the PR the goal may not need. Each reason is written so you can paste it into a review comment.</p>
           <ul class="unneeded">${s.stops.map((st, i) => (flagged(st) ? `<li>${needIc(st.necessity.verdict)}<a data-sel="${i}">${i + 1}. ${esc(st.title)}</a> <span class="need-w">${NEED[st.necessity.verdict][0]}</span><p>${prose(st.necessity.reason)}</p></li>` : '')).join('')}</ul>` : ''}
         ${s.questions.length ? `<h2>Questions for the author</h2><ul class="questions">${s.questions.map((q) => `<li>${prose(q)}</li>`).join('')}</ul>` : ''}`,
        ids.length ? ids.map((id) => hunkById(pr, id)).join('') : `<p class="code-empty">No code is tied to these.</p>`,
      ];
    }
    if (sel === 'unread') return [
      `<h1 class="title">Unexplained</h1>
       <p>${plural(u.hunks.length, 'hunk')} ${u.hunks.length === 1 ? "isn't" : "aren't"} covered by any stop. Odyssey works this out itself, so nothing in the diff gets skipped quietly. Read these directly.</p>
       ${u.files.length ? `<h2>No diff available</h2><ul class="plain">${u.files.map((f) => `<li><code>${esc(f.path)}</code></li>`).join('')}</ul>` : ''}`,
      u.hunks.map((id) => hunkById(pr, id)).join('') || `<p class="code-empty">Nothing here.</p>`,
    ];
    if (sel === 'intent') return intentPane();
    const st = s.stops[sel], pts = numbered(st.points);
    return [
      `<p class="kicker">Stop ${sel + 1} of ${n}</p>
       <h1 class="title">${esc(st.title)}</h1>
       <p class="lead">${prose(st.summary ?? st.story)}</p>
       ${st.purpose ? `<h2>Why it's here</h2>
       <p>${prose(st.purpose)}</p>
       ${st.necessity ? `<p class="need-line">${needIc(st.necessity.verdict)}<span><b>${NEED[st.necessity.verdict][0]}.</b> ${prose(st.necessity.reason)}</span></p>` : ''}` : ''}
       ${pts.length && st.purpose ? '<h2>What happens</h2>' : ''}
       ${pointList(pts)}
       ${st.check ? `<p class="verify">${ic('task', 'muted')}<span><b>Verify yourself.</b> ${prose(st.check)}</span></p>` : ''}
       <div class="actions">
         <button class="btn${d.has(sel) ? ' on' : ''}" data-ack="${sel}" aria-pressed="${d.has(sel)}"><span class="tick" aria-hidden="true"></span>${d.has(sel) ? 'Understood' : 'Mark understood'} <kbd>x</kbd></button>
         <button class="btn" data-step="1">Next <kbd>j</kbd></button>
       </div>`,
      codeFor(pr, pts, st.hunks) || `<p class="code-empty">This stop has no code of its own.</p>`,
    ];
  }

  // Points are numbered in reading order; the same numbers mark their rows in the code pane.
  const numbered = (points) => (points || []).map((pt, k) => ({ ...pt, k: k + 1 }));
  const pointList = (pts) => (pts.length ? `<ol class="points">${pts.map((pt) => `<li${pt.hunk ? ` data-pt="${pt.k}" tabindex="0"` : ''}><span class="pn">${pt.k}</span><span class="pt-t">${prose(pt.text)}${pt.why ? `<span class="pt-why">${prose(pt.why)}</span>` : ''}</span>${pt.hunk ? `<span class="pt-at">${esc(loc(pt.hunk, pt.from))}</span>` : ''}</li>`).join('')}</ol>` : '');
  const codeFor = (pr, pts, ids) => [...new Set([...pts.map((pt) => pt.hunk).filter(Boolean), ...ids])].map((id) => hunkById(pr, id, pts.filter((pt) => pt.hunk === id))).join('');

  // Only the commits pushed since the last tour. The diff comes straight from GitHub, so it shows before any read.
  function sincePane() {
    const { pr, story: s } = cur, d = pr.since, when = d.at ? `${ago(d.at)} ago` : 'earlier';
    if (d.rewritten) return [
      `<p class="kicker">Since the last tour · ${when}</p>
       <h1 class="title">The branch was rebased</h1>
       <p>The last tour covered commit <code>${esc(d.sha.slice(0, 7))}</code>. Since then the branch was rebased or force-pushed, so there is no clean diff of only the new work.</p>
       <p>The tour you're reading covers the whole PR as it is now.</p>
       <div class="actions"><button class="btn primary" data-sel="overview">Go to the tour <kbd>j</kbd></button></div>`,
      `<p class="code-empty">No separate diff to show.</p>`,
    ];
    const sum = s?.since && (s.since.summary || s.since.points.length) ? s.since : null, pts = numbered(sum?.points);
    return [
      `<p class="kicker">Since the last tour · ${when}</p>
       <h1 class="title">${plural(d.commits.length, 'new commit')}</h1>
       ${sum ? `<p class="lead">${prose(sum.summary)}</p>${pointList(pts)}`
        : s ? `<p class="muted">This tour was written without the earlier one to compare against. The new commits' diff is on the right; Re-read to have it explained.</p>`
        : `<p class="muted">The explanation arrives with the tour. The diff of only the new commits is already on the right.</p>`}
       <h2>Commits</h2><ul class="commits">${d.commits.map((c) => `<li><code>${esc(c.sha)}</code><span>${esc(c.msg)}</span><span class="muted">${esc(c.author)}</span></li>`).join('')}</ul>
       <p class="small"><a href="${esc(d.compare)}" target="_blank" rel="noopener">Compare on GitHub ↗</a></p>
       <div class="actions"><button class="btn primary" data-sel="overview">Go to the full tour <kbd>j</kbd></button></div>`,
      (codeFor(pr, pts, d.files.flatMap((f) => f.hunks.map((h) => h.id))) + d.files.filter((f) => f.generated || f.nodiff).map((f) => fileHunks(pr, f)).join('')) || `<p class="code-empty">No file changes.</p>`,
    ];
  }

  // The requirements the PR was asked to meet (linked issues, else the description), each with its evidence.
  function intentPane() {
    const { pr, story: s } = cur, it = s.intent, [label, tone] = VERDICT[it.verdict] || ['', ''];
    const src = it.source === 'issue' && pr.issues?.length
      ? `Checked against ${pr.issues.map((i) => `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.ref)}</a> ${esc(i.title)}`).join('; ')}.`
      : it.source === 'issue' ? 'Checked against the linked issue.' : 'There is no linked issue, so this is checked against the PR description.';
    return [
      `<p class="kicker">Check</p>
       <h1 class="title">Does it do what was asked?</h1>
       <p class="verdict-line">${ic(VERDICT_IC[it.verdict] || 'dot', tone)}<b>${label}</b></p>
       <p class="lead">${prose(it.summary)}</p>
       <p class="small muted">${src}</p>
       <ul class="reqs">${it.items.map((r) => {
         const [l, t, g] = STATUS[r.status] || ['', '', 'dot'];
         return `<li class="${t}"><span class="ri">${ic(g, t)}</span><div><p class="rq">${prose(r.requirement)} <span class="rs">${l}</span></p><p class="re">${prose(r.evidence)}</p>${r.hunk ? `<a class="loc" data-hunk="${esc(r.hunk)}">${esc(loc(r.hunk))}</a>` : ''}</div></li>`;
       }).join('')}</ul>`,
      codeFor(pr, [], [...new Set(it.items.map((r) => r.hunk).filter(Boolean))]) || `<p class="code-empty">No code is tied to these.</p>`,
    ];
  }

  function files(pr, s) {
    const owner = new Map();
    s.stops.forEach((st, i) => st.hunks.forEach((id) => { const f = index(pr).get(id)?.f.i; if (f != null) (owner.get(f) || owner.set(f, new Set()).get(f)).add(i); }));
    return `<table class="files"><tbody>${pr.files.map((f) => {
      const stops = [...(owner.get(f.i) || [])].sort((a, b) => a - b);
      const where = f.generated ? '<span class="muted">generated</span>'
        : f.nodiff ? '<span class="muted">no diff</span>'
        : stops.length ? stops.map((i) => `<a class="pill" data-sel="${i}" title="${esc(s.stops[i].title)}">${i + 1}</a>`).join('')
        : '<a class="warn" data-sel="unread">unexplained</a>';
      const partly = stops.length && f.hunks.some((h) => !s.stops.some((st) => st.hunks.includes(h.id)));
      return `<tr><td class="st st-${LETTER[f.status] || 'M'}">${LETTER[f.status] || 'M'}</td><td class="p">${pathHtml(f.path)}</td><td class="n">${delta(f.add, f.del)}</td><td class="w">${where}${partly ? ' <a class="warn" data-sel="unread">+ unexplained</a>' : ''}</td></tr>`;
    }).join('')}</tbody></table>`;
  }

  function fileHunks(pr, f) {
    if (f.generated || f.nodiff) return `<div class="hunk stub"><div class="hh"><span class="st st-${LETTER[f.status] || 'M'}">${LETTER[f.status] || 'M'}</span><span class="p">${pathHtml(f.path)}</span><span class="at">${f.generated ? 'generated, skipped' : 'no diff available'}</span></div></div>`;
    return f.hunks.map((h) => hunk(pr, f, h)).join('');
  }

  const hunkById = (pr, id, marks) => { const x = index(pr).get(id); return x ? hunk(pr, x.f, x.h, marks) : ''; };

  // Server-side syntax colours: only accept text and highlight.js <span class="…"> wrappers, never other markup.
  const colored = (hl) => (typeof hl === 'string' && /^(?:[^<]|<span class="[\w -]+">|<\/span>)*$/.test(hl) ? hl : null);

  // Side by side: context lines sit on both sides; a run of deletions is paired row by row with the additions
  // that follow it, so each removed line faces the line that replaced it. Returns [{ l, r }] line indexes (or null).
  function pairs(lines) {
    const out = [];
    for (let i = 0; i < lines.length;) {
      if (lines[i][0] === ' ') { out.push({ l: i, r: i }); i++; continue; }
      const dels = [], adds = [];
      while (i < lines.length && lines[i][0] === '-') dels.push(i++);
      while (i < lines.length && lines[i][0] === '+') adds.push(i++);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ l: dels[k] ?? null, r: adds[k] ?? null });
    }
    return out;
  }
  const diffView = () => (store.get('diff', 'unified') === 'split' && !matchMedia('(max-width: 860px)').matches ? 'split' : 'unified');
  const diffBar = () => `<div class="code-bar"><span class="seg-btns" role="group" aria-label="Diff view">${[['unified', 'Unified'], ['split', 'Split']].map(([k, l]) => `<button type="button" data-diff="${k}" class="${store.get('diff', 'unified') === k ? 'on' : ''}" aria-pressed="${store.get('diff', 'unified') === k}">${l}</button>`).join('')}</span></div>`;

  function splitRows(h, marks, long, MAX) {
    const side = (i, which) => {
      if (i == null) return `<td class="ln empty"></td><td class="sg empty"></td><td class="tx empty"></td>`;
      const [s, o, n, t, hl] = h.lines[i], c = s === '+' ? 'add' : s === '-' ? 'del' : '';
      return `<td class="ln ${c}">${(which === 'l' ? o : n) ?? ''}</td><td class="sg ${c}">${s === ' ' ? '' : s === '-' ? '−' : '+'}</td><td class="tx ${c}">${colored(hl) ?? esc(t)}</td>`;
    };
    return pairs(h.lines).map(({ l, r }) => {
      const idx = [l, r].filter((x) => x != null), rows = idx.map((x) => x + 1);
      const on = marks.filter((m) => rows.some((x) => x >= m.from && x <= m.to)), first = marks.find((m) => rows.includes(m.from));
      const cls = [long && idx.every((x) => x >= MAX) ? 'more' : '', on.length ? 'pt' : ''].filter(Boolean).join(' ');
      return `<tr${cls ? ` class="${cls}"` : ''}${on.length ? ` data-pts="${on.map((m) => m.k).join(' ')}"` : ''}><td class="pg">${first ? `<span class="pb" data-pt="${first.k}">${first.k}</span>` : ''}</td>${side(l, 'l')}${side(r, 'r')}</tr>`;
    }).join('');
  }

  // marks: [{ k, from, to }] in 1-based rows. Marked rows get a gutter number and stay visible even in long hunks.
  function hunk(pr, f, h, marks = []) {
    const MAX = 80, long = h.lines.length > MAX + 20 && !marks.some((m) => m.to > MAX), L = LETTER[f.status] || 'M';
    // A hunk that only adds has nothing to set side by side, so it stays unified.
    const split = diffView() === 'split' && h.lines.some((l) => l[0] === '-');
    const rows = split ? splitRows(h, marks, long, MAX) : h.lines.map(([s, o, n, t, hl], i) => {
      const on = marks.filter((m) => i + 1 >= m.from && i + 1 <= m.to), first = marks.find((m) => m.from === i + 1);
      const cls = [s === '+' ? 'add' : s === '-' ? 'del' : '', long && i >= MAX ? 'more' : '', on.length ? 'pt' : ''].filter(Boolean).join(' ');
      return `<tr${cls ? ` class="${cls}"` : ''}${on.length ? ` data-pts="${on.map((m) => m.k).join(' ')}"` : ''}><td class="pg">${first ? `<span class="pb" data-pt="${first.k}">${first.k}</span>` : ''}</td><td class="ln">${o ?? ''}</td><td class="ln">${n ?? ''}</td><td class="sg">${s === ' ' ? '' : s === '-' ? '−' : '+'}</td><td class="tx">${colored(hl) ?? esc(t)}</td></tr>`;
    }).join('');
    return `<div class="hunk${marks.length ? ' marked' : ''}" id="h-${h.id}">
      <div class="hh"><span class="st st-${L}" title="${esc(f.status)}">${L}</span><a class="p" href="${esc(h.id[0] === 'd' && pr.since ? pr.since.compare : `${pr.url}/files`)}#${f.anchor}" target="_blank" rel="noopener" title="Open on GitHub">${pathHtml(f.path)}</a><span class="at">${h.at ? esc(h.at) : `line ${h.start}`}</span><span class="n">${delta(h.add, h.del)}</span></div>
      <div class="scroll"><table class="diff${split ? ' split' : ''}">${split ? '<colgroup><col class="c-pg"><col class="c-ln"><col class="c-sg"><col><col class="c-ln"><col class="c-sg"><col></colgroup>' : ''}<tbody>${rows}</tbody></table></div>
      ${long ? `<button class="expand" data-expand>${h.lines.length - MAX} more lines</button>` : ''}
    </div>`;
  }

  // Light up a point and its rows together; scroll the code to it when asked.
  function point(k, scroll) {
    $$('.hl').forEach((el) => el.classList.remove('hl'));
    if (!k) return;
    $$(`.points [data-pt="${k}"], .diff tr[data-pts~="${k}"]`).forEach((el) => el.classList.add('hl'));
    const row = $(`.diff tr[data-pts~="${k}"]`);
    if (scroll && row) row.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  // Show a hunk: in the open pane if it's there, otherwise on the first stop (or list) that holds it.
  function reveal(id) {
    let el = document.getElementById('h-' + id);
    if (!el && cur?.story) {
      const i = cur.story.stops.findIndex((st) => st.hunks.includes(id));
      select(i >= 0 ? i : 'unread');
      el = document.getElementById('h-' + id);
    }
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }

  function toggle(i) {
    if (typeof i !== 'number' || !cur?.story || cur.demo) return;
    const d = done();
    d.has(i) ? d.delete(i) : d.add(i);
    store.set(doneKey(), [...d]);
    $(`.tour [data-sel="${i}"]`)?.classList.toggle('done', d.has(i));
    const b = $(`[data-ack="${i}"]`);
    if (b) { b.classList.toggle('on', d.has(i)); b.setAttribute('aria-pressed', d.has(i)); b.firstChild.nextSibling.textContent = d.has(i) ? 'Understood ' : 'Mark understood '; }
    bar();
  }

  // ---------- flow map ----------

  // Layered left to right: break cycles, longest path from the sources, then one barycentre pass to cut crossings.
  // ponytail: no real crossing minimisation; fine for the 3–14 nodes the prompt asks for.
  function flowMap(flow, nStops, thumb) {
    const N = flow.nodes.slice(0, 24), at = new Map(N.map((n, i) => [n.id, i]));
    const E = flow.edges.filter((e) => at.has(e.from) && at.has(e.to) && e.from !== e.to).map((e) => ({ ...e, a: at.get(e.from), b: at.get(e.to) }));
    const seen = N.map(() => 0), out = N.map(() => []);
    E.forEach((e) => out[e.a].push(e));
    const visit = (i) => { seen[i] = 1; for (const e of out[i]) { if (seen[e.b] === 1) e.back = true; else if (!seen[e.b]) visit(e.b); } seen[i] = 2; };
    N.forEach((_, i) => !E.some((e) => e.b === i) && !seen[i] && visit(i));
    N.forEach((_, i) => !seen[i] && visit(i));
    const L = N.map(() => 0);
    for (let k = 0; k < N.length; k++) {
      let moved = false;
      for (const e of E) if (!e.back && L[e.b] < L[e.a] + 1) { L[e.b] = L[e.a] + 1; moved = true; }
      if (!moved) break;
    }
    const cols = [];
    N.forEach((_, i) => (cols[L[i]] ||= []).push(i));
    const C = cols.filter(Boolean), pos = [];
    C.forEach((col, c) => {
      const bary = (i) => { const p = E.filter((e) => e.b === i && pos[e.a]).map((e) => pos[e.a].r); return p.length ? p.reduce((x, y) => x + y) / p.length : col.indexOf(i); };
      if (c) col.sort((x, y) => bary(x) - bary(y));
      col.forEach((i, r) => (pos[i] = { c, r }));
    });
    const W = 176, H = 48, GX = 84, GY = 16, P = 8;
    const tall = Math.max(...C.map((c) => c.length)) * (H + GY) - GY;
    const hasBack = E.some((e) => e.back);
    C.forEach((col) => col.forEach((i, r) => { pos[i].x = P + pos[i].c * (W + GX); pos[i].y = P + (tall - (col.length * (H + GY) - GY)) / 2 + r * (H + GY); }));
    const width = P * 2 + C.length * (W + GX) - GX, height = P * 2 + tall + (hasBack ? 40 : 0);
    const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
    const cutL = (s, n) => (s.length > n ? '…' + s.slice(-(n - 1)) : s);

    // Labels that would overlap one already placed stay hidden until their edge is hovered.
    const placed = [];
    const free = (x, y, w) => {
      const box = [x - w / 2, y - 10, x + w / 2, y + 3];
      if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) return false;
      placed.push(box);
      return true;
    };
    const edges = E.map((e) => {
      const A = pos[e.a], B = pos[e.b];
      let d, lx, ly;
      if (!e.back) {
        const x1 = A.x + W, y1 = A.y + H / 2, x2 = B.x, y2 = B.y + H / 2;
        d = `M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2 - 2},${y2}`;
        lx = (x1 + x2) / 2; ly = (y1 + y2) / 2 - 5;
      } else { // along the bottom lane, under every box
        const x1 = A.x + W / 2, y1 = A.y + H, x2 = B.x + W / 2, y2 = B.y + H, low = P + tall + 30;
        d = `M${x1},${y1} C${x1},${low} ${x2},${low} ${x2},${y2 + 2}`;
        lx = (x1 + x2) / 2; ly = low - 4;
      }
      const label = cut(e.label || '', 16), shown = label && free(lx, ly, label.length * 5.8 + 6);
      return `<g class="edge${e.back ? ' back' : ''}${label && !shown ? ' crowded' : ''}" data-a="${e.a}" data-b="${e.b}"><path d="${d}" marker-end="url(#arrow)"/>${label ? `<text x="${lx}" y="${ly}" text-anchor="middle">${esc(label)}</text>` : ''}</g>`;
    }).join('');

    const SL = { new: 'A', changed: 'M', removed: 'D' };
    const nodes = N.map((n, i) => {
      const { x, y } = pos[i], st = !thumb && n.stop >= 0 && n.stop < nStops ? n.stop : -1, l = SL[n.status];
      return `<g class="node s-${esc(n.status)}${st >= 0 ? ' link' : ''}" data-node="${i}" data-id="${esc(n.id)}"${st >= 0 ? ` data-sel="${st}" tabindex="0" role="button" aria-label="${esc(n.label)}, stop ${st + 1}"` : ''} transform="translate(${x},${y})">
        <title>${esc(n.label)} — ${esc(n.where)}</title>
        <rect width="${W}" height="${H}" rx="4"/>
        ${l ? `<text class="nst" x="10" y="20">${l}</text>` : ''}
        <text class="nl" x="${l ? 24 : 10}" y="20">${esc(cut(n.label, l ? 19 : 21))}</text>
        <text class="nw" x="10" y="37">${esc(cutL(n.where, st >= 0 ? 22 : 27))}</text>
        ${st >= 0 ? `<text class="ns" x="${W - 8}" y="37" text-anchor="end">stop ${st + 1}</text>` : ''}
      </g>`;
    }).join('');

    if (!thumb) layout = { pos: new Map(N.map((n, i) => [n.id, pos[i]])), W, H };
    return `<svg viewBox="0 0 ${width} ${height}" ${thumb ? 'preserveAspectRatio="xMidYMid meet"' : `style="width:100%;max-width:${width}px;min-width:${Math.round(width * 0.7)}px"`} role="img" aria-label="How the changed parts connect">
      <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z"/></marker>${thumb ? '' : HOP_MARKER}</defs>
      ${edges}${nodes}${thumb ? '' : '<g class="play"></g>'}</svg>`;
  }

  // ---------- flow player: walk a runtime scenario hop by hop, on the map or as a sequence diagram ----------

  const HOP_MARKER = '<marker id="arrow-hop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z"/></marker>';
  let layout = null; // boxes of the last full-size map, by flow node id
  const play = { key: null, sc: 0, i: 0, view: 'map', timer: null };
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stopPlay = () => { clearInterval(play.timer); play.timer = null; };

  function flowBlock(s) {
    const sc = s.scenarios || [];
    if (play.key !== cur.key) { stopPlay(); Object.assign(play, { key: cur.key, sc: 0, i: 0 }); }
    return `<div class="block flowblock">
      <div class="block-head"><h2>How it works</h2>
        ${sc.length ? `<span class="seg-btns">${[['map', 'Map'], ['seq', 'Sequence']].map(([v, l]) => `<button data-view="${v}" class="${play.view === v ? 'on' : ''}" aria-pressed="${play.view === v}">${l}</button>`).join('')}</span>` : ''}
        <p class="legend"><span class="lg a">A</span>added <span class="lg m">M</span>modified <span class="lg d">D</span>deleted <span class="lg c"></span>unchanged</p></div>
      ${sc.length ? `<div class="scn-tabs" role="tablist" aria-label="Runtime walkthroughs">${sc.map((x, k) => `<button role="tab" data-scn="${k}" class="${k === play.sc ? 'on' : ''}" aria-selected="${k === play.sc}">${esc(x.title)}</button>`).join('')}</div>` : ''}
      <div class="map" id="flowview"></div>
      ${sc.length ? '<div class="player" id="player"></div>' : '<p class="small muted nosc">Re-read this PR to get step-by-step walkthroughs of what happens at runtime.</p>'}
    </div>`;
  }

  // Draw the map or the sequence for the current scenario, then the current hop.
  function paintView() {
    const s = cur?.story, box = $('#flowview');
    if (!s || !box) return;
    const sc = s.scenarios?.[play.sc];
    box.innerHTML = play.view === 'seq' && sc ? seqSVG(sc, s.flow.nodes) : flowMap(s.flow, s.stops.length);
    paintStep();
  }

  // A curve between two boxes: left to right, right to left, within a column, or a loop for work inside one box.
  function hopPath(A, B, W, H) {
    if (A === B) { const x = A.x + W, y = A.y + H / 2; return { d: `M${x},${y - 10} C${x + 48},${y - 36} ${x + 48},${y + 36} ${x + 2},${y + 10}`, mx: x + 40, my: y - 26 }; }
    const y1 = A.y + H / 2, y2 = B.y + H / 2;
    if (B.x > A.x) { const x1 = A.x + W, x2 = B.x, m = (x2 - x1) / 2; return { d: `M${x1},${y1} C${x1 + m},${y1} ${x2 - m},${y2} ${x2 - 2},${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 - 9 }; }
    if (B.x < A.x) { const x1 = A.x, x2 = B.x + W, m = (x1 - x2) / 2; return { d: `M${x1},${y1} C${x1 - m},${y1} ${x2 + m},${y2} ${x2 + 2},${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 - 9 }; }
    const x = A.x + W;
    return { d: `M${x},${y1} C${x + 64},${y1} ${x + 64},${y2} ${x + 2},${y2}`, mx: x + 52, my: (y1 + y2) / 2 };
  }

  const packet = (d) => (reduced() ? '' : `<circle class="pkt-dot" r="5"><animateMotion dur="1.4s" repeatCount="indefinite" path="${d}"/></circle>`);

  function seqSVG(sc, nodes) {
    const N = new Map(nodes.map((n) => [n.id, n])), parts = [...new Set(sc.steps.flatMap((x) => [x.from, x.to]))];
    const CW = 156, TOP = 46, ROW = 44, P = 8, w = P * 2 + parts.length * CW, h = TOP + sc.steps.length * ROW + 24;
    const cx = (id) => P + parts.indexOf(id) * CW + CW / 2, cut = (t, k) => (t.length > k ? t.slice(0, k - 1) + '…' : t);
    const heads = parts.map((id) => { const n = N.get(id) || { label: id, status: 'context' }, x = cx(id);
      return `<g class="head s-${esc(n.status)}"><title>${esc(n.label)} — ${esc(n.where || '')}</title><rect x="${x - CW / 2 + 6}" y="4" width="${CW - 12}" height="30" rx="4"/><text x="${x}" y="23" text-anchor="middle">${esc(cut(n.label, 20))}</text></g><line class="life" x1="${x}" y1="34" x2="${x}" y2="${h - 6}"/>`; }).join('');
    const msgs = sc.steps.map((st, k) => {
      const y = TOP + 22 + k * ROW, a = cx(st.from), b = cx(st.to), cls = `msg k-${esc(st.kind)}${k === play.i ? ' on' : k < play.i ? ' seen' : ''}`;
      const d = a === b ? `M${a},${y - 6} C${a + 46},${y - 18} ${a + 46},${y + 12} ${a + 3},${y + 6}` : `M${a},${y} L${b + (b > a ? -3 : 3)},${y}`;
      const lx = a === b ? a + 52 : (a + b) / 2, anchor = a === b ? 'start' : 'middle';
      return `<g class="${cls}" data-hop="${k}"><title>${esc(st.what)}</title><path d="${d}" marker-end="url(#arrow${k === play.i ? '-hop' : ''})"/><text x="${lx}" y="${y - 7}" text-anchor="${anchor}">${k + 1}. ${esc(cut(st.data || st.kind, 24))}</text>${k === play.i ? packet(d) : ''}</g>`;
    }).join('');
    return `<svg class="seq" viewBox="0 0 ${w} ${h}" style="width:100%;max-width:${w}px;min-width:${Math.min(w, 560)}px" role="img" aria-label="Sequence of ${esc(sc.title)}">
      <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z"/></marker>${HOP_MARKER}</defs>${heads}${msgs}</svg>`;
  }

  // The current hop: controls, the numbered hop list, the code that does it, and its highlight on the diagram.
  function paintStep() {
    const s = cur?.story, sc = s?.scenarios?.[play.sc], box = $('#player');
    if (!sc || !box) return;
    play.i = Math.max(0, Math.min(sc.steps.length - 1, play.i));
    const st = sc.steps[play.i], last = play.i === sc.steps.length - 1, N = new Map(s.flow.nodes.map((n) => [n.id, n]));
    const name = (id) => `<code>${esc(N.get(id)?.label || id)}</code>`;
    box.innerHTML = `<div class="pbar-row">
        <button class="btn primary" data-play>${play.timer ? 'Pause' : last && play.i ? 'Replay' : 'Play'} <kbd>space</kbd></button>
        <button class="icon-btn" data-pstep="-1" aria-label="Previous step" ${play.i ? '' : 'disabled'}>‹</button>
        <span class="pcount">Step <b>${play.i + 1}</b> of ${sc.steps.length}</span>
        <button class="icon-btn" data-pstep="1" aria-label="Next step" ${last ? 'disabled' : ''}>›</button>
        <span class="trigger"><span class="muted">Starts when</span> ${prose(sc.trigger)}</span>
      </div>
      <ol class="hops">${sc.steps.map((x, k) => `<li data-hop="${k}" class="${k === play.i ? 'on' : k < play.i ? 'seen' : ''}"${k === play.i ? ' aria-current="step"' : ''}>
        <span class="pn">${k + 1}</span>
        <span><span class="hop-ft">${name(x.from)}${x.from === x.to ? '' : ` <span class="arr" aria-label="to">→</span> ${name(x.to)}`}<span class="kind">${esc(x.kind)}</span>${x.data ? `<span class="pkt">${esc(x.data)}</span>` : ''}</span>
        <span class="hop-w">${prose(x.what)}</span></span></li>`).join('')}</ol>
      <div class="hop-code">${st.hunk ? hunkById(cur.pr, st.hunk, [{ k: play.i + 1, from: st.start, to: st.end }]) : '<p class="code-empty">This hop runs code the PR leaves unchanged.</p>'}</div>`;
    const svg = $('#flowview svg');
    if (!svg) return;
    if (play.view === 'seq') { svg.outerHTML = seqSVG(sc, s.flow.nodes); return; }
    if (!layout) return;
    const used = new Set(sc.steps.flatMap((x) => [x.from, x.to])), seen = new Set(sc.steps.slice(0, play.i).flatMap((x) => [x.from, x.to]));
    svg.classList.add('playing');
    $$('.node', svg).forEach((g) => {
      const id = g.dataset.id;
      g.classList.toggle('p-on', id === st.from || id === st.to);
      g.classList.toggle('p-seen', seen.has(id));
      g.classList.toggle('p-off', !used.has(id));
    });
    const A = layout.pos.get(st.from), B = layout.pos.get(st.to);
    if (!A || !B) return;
    const { d, mx, my } = hopPath(A, B, layout.W, layout.H);
    $('.play', svg).innerHTML = `<path class="hop" d="${d}" marker-end="url(#arrow-hop)"/>${packet(d)}${st.data ? `<text class="hop-label" x="${mx}" y="${my}" text-anchor="middle">${esc(st.data)}</text>` : ''}`;
  }

  function goHop(i) { play.i = i; paintStep(); }
  function togglePlay() {
    const sc = cur?.story?.scenarios?.[play.sc];
    if (!sc) return;
    if (play.timer) { stopPlay(); return paintStep(); }
    if (play.i >= sc.steps.length - 1) play.i = 0;
    play.timer = setInterval(() => {
      if (!$('#player') || play.i >= sc.steps.length - 1) stopPlay();
      else play.i++;
      paintStep();
    }, reduced() ? 4000 : 2600);
    paintStep();
  }

  // ---------- settings: who reads the PR ----------

  const dlg = $('#settings'), form = $('#settings-form');
  let cfg = null;
  const pretty = (m) => String(m || '').replace(/^claude-([a-z]+)-(\d+)-(\d+)$/, (_, a, b, c) => `${a[0].toUpperCase()}${a.slice(1)} ${b}.${c}`);
  const reader = () => (cfg ? pretty(cfg.model) || { codex: 'Codex', openai: 'the API', claude: 'Claude Code', anthropic: 'Claude' }[cfg.provider] : 'Claude');
  const DESC = {
    anthropic: 'Your Anthropic API key. Reads are billed to your Anthropic account.',
    openai: 'OpenAI, OpenRouter or any OpenAI-compatible API, with your own key.',
    claude: "This machine's Claude Code login. Only when Odyssey runs on your own machine.",
    codex: "This machine's Codex login, which uses your ChatGPT plan. Only when Odyssey runs on your own machine.",
  };
  const MODEL_NOTE = { 'claude-sonnet-5-5': 'fast, the default', 'claude-opus-5-5': 'most thorough, slower', 'claude-haiku-5-5': 'quickest, lightest' };

  function settingsForm(c) {
    return `<h2 id="settings-h">Who reads the pull request</h2>
      <p class="muted">The PR's diff, description and commits are sent to this AI to write the tour.</p>
      <fieldset class="providers"><legend class="sr">Provider</legend>${c.providers.map((p) => {
        const missing = !p.key && c.installed[p.id] === false;
        return `<label class="opt${missing ? ' off' : ''}"><input type="radio" name="provider" value="${p.id}"${p.id === c.provider ? ' checked' : ''}${missing ? ' disabled' : ''}><span><b>${esc(p.label)}</b><small>${missing ? `Not available: the ${p.id} command wasn't found on this machine.` : DESC[p.id]}</small></span></label>`;
      }).join('')}</fieldset>
      ${c.providers.map((p) => `<div class="fields" data-for="${p.id}">
        ${p.id === 'openai' ? `<label>Base URL <input name="baseURL-openai" value="${esc(c.baseURL)}" spellcheck="false"></label>` : ''}
        ${p.models
          ? `<label>Model <select name="model-${p.id}">${p.models.map((m) => `<option value="${m}"${c.provider === p.id && c.model === m ? ' selected' : ''}>${pretty(m)}${MODEL_NOTE[m] ? ` · ${MODEL_NOTE[m]}` : ''}</option>`).join('')}</select></label>`
          : `<label>Model <input name="model-${p.id}" value="${c.provider === p.id ? esc(c.model) : ''}" placeholder="${p.id === 'codex' ? 'Blank uses your Codex default' : 'The model id your provider lists'}" spellcheck="false"></label>`}
        ${p.key ? `<label>API key <input name="key-${p.id}" type="password" autocomplete="off" spellcheck="false" placeholder="${c.saved.includes(p.id) ? 'Saved. Leave blank to keep it.' : 'Paste your key'}"></label>
          <p class="small muted">Encrypted before it's stored, and never sent back to your browser.${c.saved.includes(p.id) ? ` <button type="button" class="link" data-clearkey="${p.id}">Remove saved key</button>` : ''}</p>` : ''}
      </div>`).join('')}
      <p class="small muted">Tours you already have stay as they are. New PRs are read with this choice; use Re-read on a PR to read it again with it.</p>
      <p class="err" id="settings-err" role="alert"></p>
      <div class="row-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div>`;
  }

  const syncFields = () => $$('.fields', form).forEach((d) => { d.hidden = d.dataset.for !== form.elements.provider.value; });

  async function openSettings() {
    cfg = await api('/api/settings');
    form.innerHTML = settingsForm(cfg);
    syncFields();
    if (!dlg.open) dlg.showModal();
  }

  async function postSettings(payload) {
    const r = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }

  form.addEventListener('change', (e) => { if (e.target.name === 'provider') syncFields(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = form.elements, provider = f.provider.value;
    try {
      cfg = await postSettings({ provider, model: f[`model-${provider}`]?.value, key: f[`key-${provider}`]?.value || '', baseURL: f['baseURL-openai']?.value });
      dlg.close();
      if (cur && !cur.demo) { open(cur.key, cur.sel); if (cur.story) bar(); }
    } catch (err) {
      $('#settings-err').textContent = err.message;
    }
  });
  dlg.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]') || e.target === dlg) return dlg.close();
    const clear = e.target.closest('[data-clearkey]');
    if (!clear) return;
    const id = clear.dataset.clearkey;
    try { await postSettings({ provider: id, model: form.elements[`model-${id}`]?.value, clearKey: true }); await openSettings(); }
    catch (err) { $('#settings-err').textContent = err.message; }
  });
  $('#gear').addEventListener('click', () => openSettings().catch((e) => alert(e.message)));

  // ---------- account ----------

  function account() {
    const el = $('#account'), u = me?.user;
    document.body.dataset.auth = u ? 'in' : 'out';
    if (!el) return;
    el.innerHTML = !u ? (me?.mode === 'hosted' ? '<a class="signin" href="/auth/login">Sign in</a>' : '') : `<details class="menu">
      <summary aria-label="Account menu"><img class="av" src="${esc(u.avatar || '')}" alt="" width="22" height="22"><span class="who">${esc(u.login)}</span>${me.mode === 'local' ? '<span class="local">local</span>' : ''}</summary>
      <div class="menu-pop">
        <p class="menu-who">Signed in as <b>${esc(u.login)}</b>${me.mode === 'local' ? '<br><span class="muted">through the <code>gh</code> CLI on this machine</span>' : ''}</p>
        <a href="#/" data-menu>Your pull requests</a>
        <a href="#/about" data-menu>About Odyssey</a>
        <button type="button" data-settings data-menu>AI settings</button>
        ${me.mode === 'hosted'
          ? '<button type="button" data-signout>Sign out</button>'
          : '<p class="menu-note">Local mode has no Odyssey sign-in. To use another GitHub account, run <code>gh auth logout</code> and <code>gh auth login</code>, then reload.</p>'}
      </div>
    </details>`;
  }

  async function signOut() {
    await fetch('/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
    location.href = '/';
  }

  // ---------- landing: what Odyssey is, for signed-out visitors ----------

  const GH_MARK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>';

  // The same sequence diagram the app draws, frozen on one hop for the page.
  function seqAt(sc, nodes, i) { const k = play.i; play.i = i; const svg = seqSVG(sc, nodes); play.i = k; return svg; }

  // Feature cards for the landing page. Every visual is drawn from the demo tour, never mocked.
  function bento(demo) {
    const st = demo.story, pr = demo.pr, sc = st.scenarios?.[0];
    const total = pr.files.reduce((n, f) => n + f.hunks.length, 0), covered = new Set(st.stops.flatMap((x) => x.hunks)).size;
    const card = (span, vis, h, p) => `<article class="b-card s${span}"><div class="b-vis">${vis}</div><div class="b-txt"><h3>${h}</h3><p>${p}</p></div></article>`;
    const s0 = st.stops[0];
    const stops = `<div class="b-stops"><ol>${st.stops.map((x, i) => `<li class="${i ? '' : 'on'}"><span class="b-n">${i + 1}</span>${esc(x.title)}<em>${x.hunks.length}</em></li>`).join('')}</ol>
      <div class="b-pts"><p class="b-k">Stop 1 · ${esc(s0.title)}</p>${s0.points.slice(0, 3).map((x, i) => `<p><span class="pb">${i + 1}</span><span>${prose(x.text)}</span></p>`).join('')}</div></div>`;
    const hunksVis = `<div class="b-big"><b>${covered}<span>/${total}</span></b><div class="b-bar">${Array.from({ length: total }, (_, i) => `<i class="${i < covered ? 'on' : ''}"></i>`).join('')}</div><p>hunks explained in this tour</p></div>`;
    const verdicts = `<ul class="b-list">${st.stops.filter((x) => x.necessity).slice(0, 4).map((x) => `<li>${needIc(x.necessity.verdict)}<span>${esc(x.title)}</span><em>${NEED[x.necessity.verdict][0]}</em></li>`).join('')}</ul>`;
    const reqs = `<ul class="b-list">${(st.intent?.items || []).slice(0, 4).map((r) => { const [l, t, g] = STATUS[r.status] || ['', '', 'dot']; return `<li class="${t}">${ic(g, t)}<span>${prose(r.requirement)}</span><em>${l}</em></li>`; }).join('')}</ul>`;
    // ponytail: the demo has no second tour, so the last commit plays "new since you last looked"
    const commits = `<ul class="b-list b-commits">${pr.commits.map((c, i) => `<li><i class="b-dot"></i><span>${esc(typeof c === 'string' ? c : c.message || '')}</span>${i === pr.commits.length - 1 ? '<em class="b-new">New</em>' : '<em>Toured</em>'}</li>`).join('')}</ul>`;
    return [
      card(4, stops, 'Read it in the order it runs.', 'The diff is split into stops, starting where execution starts. Each sentence is pinned to the lines it describes.'),
      card(2, hunksVis, 'Nothing in the diff is skipped.', 'Odyssey counts coverage itself, without the model. If no stop explains a hunk, it is listed separately so you still read it.'),
      card(2, verdicts, 'Is each change needed?', 'Each part is marked needed, supporting or questionable, with a reason you can paste into your review.'),
      sc ? card(4, `<div class="b-seq">${seqAt(sc, st.flow.nodes, Math.min(3, sc.steps.length - 1))}</div>`, 'Step through a request.', `Follow one request call by call, on a map or as a sequence diagram. This one: ${esc(sc.title.toLowerCase())}.`) : '',
      st.intent?.items?.length ? card(3, reqs, 'Checked against the linked issue.', 'Each requirement in the issue is matched to the code that meets it. Requirements with no matching code are listed too.') : '',
      pr.commits?.length ? card(3, commits, 'Only the new commits.', 'After a push, Odyssey opens on the commits you haven\'t seen yet.') : '',
    ].join('');
  }

  async function landing() {
    cur = null;
    crumb.innerHTML = '';
    status.innerHTML = '';
    document.body.dataset.view = 'landing';
    const local = me?.mode === 'local';
    const cta = me?.user
      ? `<a class="l-btn" href="#/">Open your pull requests</a><a class="l-link" href="#tour" data-jump="tour">See a real tour</a>`
      : local
      ? '<p class="l-note">This Odyssey runs on your machine and reads GitHub through the <code>gh</code> CLI. Run <code>gh auth login</code>, then reload.</p>'
      : `<a class="l-btn" href="/auth/login">${GH_MARK}Sign in with GitHub</a><a class="l-link" href="#tour" data-jump="tour">See a real tour</a>`;
    view.innerHTML = `<div class="landing">
      <header class="l-hero">
        <div class="l-hero-in">
          <h1>Ship what you understand.</h1>
          <p class="l-sub">Odyssey walks you through a pull request in the order its code runs. At each stop it shows the lines that changed, explains why they're there, and says what to check before you merge.</p>
          <div class="l-cta">${cta}</div>
        </div>
      </header>

      <section class="l-window-wrap" id="tour">
        <div class="l-window">
          <div class="l-chrome"><span class="l-dot"></span><span class="l-url">odyssey <span>/</span> <b id="demo-name">loading…</b></span><span class="l-live">Live demo · click around</span></div>
          <div class="app l-app" id="demo-app"><nav class="tour" aria-label="Tour"></nav><section class="note" id="note"></section><section class="code" id="code"></section></div>
        </div>
      </section>

      <section class="l-works" aria-label="Works with"><span>Works with</span><b>GitHub</b><b>Claude</b><b>OpenAI</b><b>OpenRouter</b><b>Claude Code</b><b>Codex</b><b>Postgres</b><b>SQLite</b></section>

      <section class="l-feat" id="features">
        <div class="l-head"><h2>Built for code you didn't write.</h2>
          <p>Each part of a tour links to the lines it describes, so you can check what it says against the code.</p></div>
        <div class="bento" id="bento"></div>
      </section>

      <section class="l-band" id="security">
        <h2>What Odyssey can access</h2>
        <div class="l-trust">
          <div><b>GitHub, read-only</b><p>Your organization installs a read-only GitHub App. Each person sees only the pull requests their own account can read.</p></div>
          <div><b>Your AI provider</b><p>Anthropic, OpenAI or OpenRouter with your own key, or the Claude Code and Codex logins on your machine. Odyssey has no model of its own.</p></div>
          <div><b>Your database</b><p>Tours are saved in your Postgres or SQLite database, so a teammate can reopen one without paying for another read. API keys are encrypted at rest.</p></div>
        </div>
      </section>

      <footer class="l-foot">
        <div class="f-top">
          <div class="f-brand"><span class="brand-sm"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="12.5" r="2"/><circle cx="12.5" cy="3.5" r="2"/><path d="M3.5 10.5V8a3 3 0 0 1 3-3h4"/></svg>Odyssey</span>
            <h2>Read it before you merge it.</h2>
            <p>Odyssey explains pull requests for teams that review AI-written code.</p></div>
          <nav aria-label="Product"><h4>Product</h4><a href="#tour" data-jump="tour">Live demo</a><a href="#features" data-jump="features">Features</a><a href="#security" data-jump="security">Security</a></nav>
          <nav aria-label="Account"><h4>Account</h4>${me?.user ? '<a href="#/">Your pull requests</a>' : local ? '' : '<a href="/auth/login">Sign in with GitHub</a>'}<a href="#tour" data-jump="tour">See a real tour</a></nav>
          <div><h4>Bring your AI</h4><span>Claude</span><span>OpenAI</span><span>OpenRouter</span><span>Claude Code</span><span>Codex</span></div>
        </div>
        <p class="f-mark" aria-hidden="true">Odys<span>sey</span></p>
        <div class="f-bot"><span>© 2026 Odyssey</span><span>Read-only GitHub access · Your own AI keys</span></div>
      </footer>
    </div>`;
    try {
      const demo = await api('/demo.json');
      if (document.body.dataset.view !== 'landing') return;
      cur = { key: 'demo', demo: true, pr: demo.pr, story: demo.story, sel: 1 };
      $('#demo-name').textContent = `${demo.label.replace(/ \(.*/, '')} · ${demo.pr.title}`;
      $('#demo-app .tour').innerHTML = tour();
      show();
      $('#bento').innerHTML = bento(demo);
    } catch {
      $('#tour')?.remove();
      $('#features')?.remove();
    }
  }

  // ---------- events ----------

  document.addEventListener('submit', (e) => {
    if (!e.target.matches('.go')) return;
    e.preventDefault();
    const input = e.target.elements.pr, key = refOf(input.value);
    if (!key) { input.setCustomValidity('Paste a link like github.com/owner/repo/pull/123'); input.reportValidity(); return; }
    input.value = ''; input.blur();
    location.hash = `#/${key}`;
  });
  document.addEventListener('input', (e) => e.target.setCustomValidity?.(''));

  document.addEventListener('click', (e) => {
    if (e.target.closest?.('[data-menu]')) e.target.closest?.('details')?.removeAttribute('open');
    if (e.target.closest?.('[data-signout]')) return signOut();
    const jump = e.target.closest?.('[data-jump]');
    if (jump) { e.preventDefault(); return document.getElementById(jump.dataset.jump)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }
    const t = e.target.closest?.('[data-diff],[data-view],[data-scn],[data-pstep],[data-play],[data-hop],[data-sort],[data-settings],[data-pt],[data-sel],[data-hunk],[data-ack],[data-step],[data-expand],[data-fresh]');
    if (!t) return;
    const ds = t.dataset;
    if (ds.view) { play.view = ds.view; $$('[data-view]').forEach((b) => { b.classList.toggle('on', b === t); b.setAttribute('aria-pressed', b === t); }); paintView(); }
    else if (ds.scn) { stopPlay(); play.sc = +ds.scn; play.i = 0; $$('[data-scn]').forEach((b) => { b.classList.toggle('on', b === t); b.setAttribute('aria-selected', b === t); }); paintView(); }
    else if (ds.pstep) { stopPlay(); goHop(play.i + +ds.pstep); }
    else if ('play' in ds) togglePlay();
    else if (ds.hop) { stopPlay(); goHop(+ds.hop); }
    else if (ds.diff) { const y = $('#code')?.scrollTop; store.set('diff', ds.diff); show(); if ($('#code')) $('#code').scrollTop = y; }
    else if (ds.sort) { store.set('sort', ds.sort); lists(); }
    else if ('settings' in ds) openSettings();
    else if (ds.pt) { point(ds.pt, true); if (t.matches('.pb')) $(`.points [data-pt="${ds.pt}"]`)?.scrollIntoView({ block: 'nearest' }); }
    else if (ds.sel != null) { e.preventDefault(); select(/^\d+$/.test(ds.sel) ? +ds.sel : ds.sel); }
    else if (ds.hunk) { e.preventDefault(); reveal(ds.hunk); }
    else if (ds.ack != null) toggle(+ds.ack);
    else if (ds.step) step(+ds.step);
    else if ('expand' in ds) { t.closest('.hunk').classList.add('open'); t.remove(); }
    else if ('fresh' in ds) open(cur.key, cur.sel, true);
  });

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || dlg.open) return;
    if (e.target.closest?.('input,textarea')) { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.key === '/') { e.preventDefault(); ($('.home .go input') || $('#pr-input')).focus(); return; }
    if (e.key === 'Enter' && e.target.matches?.('.node.link')) return select(+e.target.dataset.sel);
    if (!cur?.pr) return;
    if ($('#player') && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); stopPlay(); return goHop(play.i + (e.key === 'ArrowRight' ? 1 : -1)); }
    if ($('#player') && e.key === ' ' && !e.target.closest?.('button')) { e.preventDefault(); return togglePlay(); }
    if (e.key === 'j') step(1);
    else if (e.key === 'k') step(-1);
    else if (e.key === 'x') toggle(cur.sel);
  });

  // Hovering a point (or its marked rows) lights up both sides.
  const PT = '.points [data-pt], .diff tr[data-pts]';
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest?.(PT);
    if (t) point(t.dataset.pt || t.dataset.pts.split(' ')[0]);
  });
  document.addEventListener('mouseout', (e) => { if (e.target.closest?.(PT) && !e.relatedTarget?.closest?.(PT)) point(null); });
  document.addEventListener('focusin', (e) => { if (e.target.matches?.('.points [data-pt]')) point(e.target.dataset.pt, true); });

  // Hovering a box dims everything it doesn't touch.
  document.addEventListener('mouseover', (e) => {
    const svg = e.target.closest?.('.map svg');
    if (!svg) return;
    const node = e.target.closest('.node');
    svg.classList.toggle('focus', !!node);
    if (!node) return;
    const i = node.dataset.node, near = new Set([i]);
    $$('.edge', svg).forEach((g) => {
      const on = g.dataset.a === i || g.dataset.b === i;
      g.classList.toggle('on', on);
      if (on) { near.add(g.dataset.a); near.add(g.dataset.b); }
    });
    $$('.node', svg).forEach((g) => g.classList.toggle('on', near.has(g.dataset.node)));
  });
  document.addEventListener('mouseout', (e) => { if (e.target.closest?.('.map svg') && !e.relatedTarget?.closest?.('.map svg')) e.target.closest('svg').classList.remove('focus'); });

  // ---------- appearance: palette and light/dark ----------

  // A palette is two token sets, one per mode. Unset tokens fall back to the stylesheet (diff colours, status colours,
  // GitHub-style syntax colours), so only Monokai brings its own syntax colours.
  const N = (bg, bg2, bg3, line, line2, fg, fg2, fg3) => ({ '--bg': bg, '--bg-2': bg2, '--bg-3': bg3, '--line': line, '--line-2': line2, '--fg': fg, '--fg-2': fg2, '--fg-3': fg3 });
  const A = (accent, wash, brand, on) => ({ '--blue': accent, '--blue-bg': wash, '--brand': brand || accent, '--on-accent': on });
  const DARK = N('#0e0e0f', '#151516', '#1e1e20', '#262628', '#38383b', '#ececec', '#a3a3a8', '#6f6f75');
  const LIGHT = N('#ffffff', '#f6f6f7', '#ededef', '#e3e3e6', '#cfcfd4', '#18181a', '#55555c', '#8a8a91');
  const PALETTES = {
    graphite: { name: 'Graphite', dark: { ...DARK, ...A('#f2f2f2', '#2a2a2d', '#f2f2f2', '#111112') }, light: { ...LIGHT, ...A('#18181a', '#ececef', '#18181a', '#ffffff') } },
    tidewater: { name: 'Tidewater', dark: { ...N('#101214', '#16191c', '#1f2328', '#262b31', '#363c44', '#e3e6ea', '#a1a9b3', '#6d7580'), ...A('#5fcdbd', '#10302e', null, '#06201d') }, light: { ...LIGHT, ...A('#0b7a72', '#e2f3f0', null, '#ffffff') } },
    harbor: { name: 'Harbor', dark: { ...N('#0c1117', '#111821', '#18212c', '#1f2a36', '#2e3b4a', '#e2e8f0', '#94a3b8', '#64748b'), ...A('#4cc2ff', '#0f2a3d', null, '#04192a') }, light: { ...LIGHT, ...A('#0969da', '#e6f1fb', null, '#ffffff') } },
    lagoon: { name: 'Lagoon', dark: { ...N('#0d1311', '#121a17', '#18231f', '#22302b', '#30413a', '#e2ece7', '#93a69d', '#64776e'), ...A('#3ddc97', '#0f2e22', null, '#04201a') }, light: { ...LIGHT, ...A('#0f8a5f', '#e2f5ec', null, '#ffffff') } },
    aegean: { name: 'Aegean', dark: { ...N('#0b1222', '#0f1830', '#15203b', '#1e2a47', '#2b3a5c', '#e6ecf7', '#9aa7c2', '#66749a'), ...A('#6ea8ff', '#13254a', '#e9c46a', '#071533') }, light: { ...LIGHT, ...A('#2457d6', '#e3eaf9', '#b8862b', '#ffffff') } },
    fjord: { name: 'Fjord', dark: { ...N('#0e1518', '#131c20', '#192529', '#24323a', '#33444d', '#e4edf0', '#94a7ad', '#64777d'), ...A('#9ad1ff', '#17303f', null, '#0b2230') }, light: { ...LIGHT, ...A('#2f6f9f', '#e5f0f8', null, '#ffffff') } },
    iris: { name: 'Iris', dark: { ...N('#111018', '#17161f', '#1f1e29', '#2a2836', '#3a3849', '#e8e6f2', '#a29fb6', '#716e86'), ...A('#9aa5ff', '#22264a', null, '#12163a') }, light: { ...LIGHT, ...A('#5b5bd6', '#ecebfd', null, '#ffffff') } },
    ember: { name: 'Ember', dark: { ...N('#121011', '#191617', '#221e1f', '#2c2526', '#3d3435', '#ece6e3', '#a89e9a', '#7a706c'), ...A('#ff8a4c', '#3a2016', null, '#2a1206') }, light: { ...LIGHT, ...A('#c2410c', '#fdeee6', null, '#ffffff') } },
    saffron: { name: 'Saffron', dark: { ...N('#0f141a', '#141b23', '#1b242e', '#243040', '#334256', '#e5e9ef', '#97a2b0', '#687384'), ...A('#f4b942', '#33290f', null, '#2a1d02') }, light: { ...LIGHT, ...A('#a16207', '#fbf1d9', null, '#ffffff') } },
    moss: { name: 'Moss and copper', dark: { ...N('#11140f', '#171b14', '#1f241b', '#2a3125', '#3a4333', '#e7ebe1', '#a0a896', '#727a68'), ...A('#d98e4a', '#36261a', null, '#2a1606') }, light: { ...LIGHT, ...A('#a35a1c', '#f6ece2', null, '#ffffff') } },
    rose: { name: 'Ink and rose', dark: { ...N('#121014', '#19161b', '#221e25', '#2d2830', '#3e3842', '#efe8ee', '#aa9fa8', '#7b717a'), ...A('#f07fa6', '#3a1d2a', null, '#2e0a19') }, light: { ...LIGHT, ...A('#be3a6b', '#fbe8ef', null, '#ffffff') } },
    paper: { name: 'Paper', dark: { ...N('#1a1917', '#201f1c', '#292723', '#2f2d29', '#403d37', '#ede9e1', '#a9a59b', '#77736a'), ...A('#8fb0ff', '#1f2a44', null, '#0d1630') }, light: { ...N('#fbfaf7', '#f3f1ec', '#ebe8e1', '#e2ded5', '#cfc9bd', '#1d1d1f', '#5f5e5a', '#8b897f'), ...A('#2457d6', '#e3eaf9', null, '#ffffff') } },
    monokai: {
      name: 'Monokai',
      dark: {
        ...N('#272822', '#2d2e27', '#3e3d32', '#3b3c35', '#49483e', '#f8f8f2', '#cfcfc2', '#8f8b77'), ...A('#66d9ef', '#3e3d32', '#f92672', '#1b1c17'),
        '--add': '#2f3a22', '--add-ln': '#384628', '--del': '#422432', '--del-ln': '#512a3b',
        '--sx-keyword': '#f92672', '--sx-title': '#a6e22e', '--sx-string': '#e6db74', '--sx-number': '#ae81ff', '--sx-comment': '#75715e', '--sx-builtin': '#66d9ef', '--sx-tag': '#f92672', '--sx-meta': '#fd971f',
      },
      light: {
        ...N('#fafaf8', '#f2f2ee', '#e8e8e2', '#e0e0d8', '#cbcbc0', '#272822', '#5c5c52', '#8e8a76'), ...A('#0a8fa8', '#e3f4f7', '#d0175a', '#ffffff'),
        '--sx-keyword': '#d0175a', '--sx-title': '#5d8a00', '--sx-string': '#9a7d00', '--sx-number': '#7b4fd6', '--sx-comment': '#8e8a76', '--sx-builtin': '#0a8fa8', '--sx-tag': '#d0175a', '--sx-meta': '#c26b00',
      },
    },
  };
  const ALL_KEYS = [...new Set(Object.values(PALETTES).flatMap((p) => [...Object.keys(p.dark), ...Object.keys(p.light)]))];
  const isDark = () => { const t = document.documentElement.dataset.theme; return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; };

  // Applies the palette for the current mode as custom properties on <html>, and remembers the result so the
  // inline script in index.html can paint it before anything else loads (no flash of the wrong colours).
  function applyPalette() {
    const root = document.documentElement, p = PALETTES[store.get('palette', 'graphite')] || PALETTES.graphite, vars = isDark() ? p.dark : p.light;
    ALL_KEYS.forEach((k) => root.style.removeProperty(k));
    Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
    store.set('vars', vars);
  }

  function appearanceMenu() {
    const mode = document.documentElement.dataset.theme || 'system', cur = store.get('palette', 'graphite');
    $('#appearance-pop').innerHTML = `<p class="menu-h">Mode</p>
      <span class="seg-btns">${[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button type="button" data-mode="${k}" class="${mode === k ? 'on' : ''}" aria-pressed="${mode === k}">${l}</button>`).join('')}</span>
      <p class="menu-h">Palette</p>
      <div class="palettes" role="radiogroup" aria-label="Palette">${Object.entries(PALETTES).map(([k, p]) => {
        const v = isDark() ? p.dark : p.light;
        return `<button type="button" role="radio" aria-checked="${k === cur}" data-palette="${k}" class="${k === cur ? 'on' : ''}"><span class="pal-sw" style="background:${v['--bg']};border-color:${v['--line-2']}"><i style="background:${v['--blue']}"></i>${v['--brand'] !== v['--blue'] ? `<i style="background:${v['--brand']}"></i>` : ''}</span>${p.name}${k === 'graphite' ? ' <span class="muted">· default</span>' : ''}</button>`;
      }).join('')}</div>`;
  }

  $('#appearance').addEventListener('toggle', (e) => { if (e.target.open) appearanceMenu(); });
  $('#appearance-pop').addEventListener('click', (e) => {
    const m = e.target.closest('[data-mode]'), pal = e.target.closest('[data-palette]');
    if (m) {
      if (m.dataset.mode === 'system') { delete document.documentElement.dataset.theme; store.set('theme', null); }
      else { document.documentElement.dataset.theme = m.dataset.mode; store.set('theme', m.dataset.mode); }
    }
    if (pal) store.set('palette', pal.dataset.palette);
    if (m || pal) { applyPalette(); appearanceMenu(); }
  });
  // Close the open menus when clicking elsewhere.
  document.addEventListener('click', (e) => $$('details.menu[open]').forEach((dm) => { if (!e.composedPath().includes(dm)) dm.removeAttribute('open'); }));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyPalette);
  applyPalette();

  setInterval(() => $$('.elapsed[data-since]').forEach((el) => (el.textContent = clock(Date.now() - +el.dataset.since))), 1000);

  addEventListener('hashchange', route);
  api('/api/me').then((m) => { me = m; }, () => { me = { mode: 'local', user: null }; }).then(() => {
    account();
    if (me.user) api('/api/settings').then((c) => { cfg = c; }, () => {});
    route();
  });

  // ---------- self-checks ----------

  console.assert(refOf('https://github.com/a/b/pull/12') === 'a/b/12', 'refOf url');
  console.assert(refOf('a/b#3') === 'a/b/3' && refOf('a/b') === null, 'refOf short');
  console.assert(prose('use `x<y`') === 'use <code>x&lt;y</code>', 'prose escapes');
  console.assert(clock(72000) === '1:12', 'clock');
  console.assert(JSON.stringify(pairs([[' '], ['-'], ['-'], ['+'], [' '], ['+']])) === '[{"l":0,"r":0},{"l":1,"r":3},{"l":2,"r":null},{"l":4,"r":4},{"l":null,"r":5}]', 'split pairs');
  console.assert(colored('<span class="hljs-keyword">if</span> x &lt; 1') && !colored('<img src=x onerror=alert(1)>') && !colored('<span onclick="x">a</span>'), 'colored');
  console.assert(effort(5, 3, 1) === 1 && effort(88, 22, 5) === 2 && effort(300, 50, 10) === 3 && effort(3932, 232, 27) === 5, 'effort');
  console.assert(pretty('claude-sonnet-5-5') === 'Sonnet 5.5' && pretty('gpt-x') === 'gpt-x', 'pretty');
})();
