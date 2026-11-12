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
    if (!me?.user || location.hash === '#/about') return landing();
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
        <p class="hint">Odyssey turns a pull request into a guided tour: what it changes, how the pieces connect, and each step pinned to its code. <kbd>/</kbd> jumps here from anywhere.</p>
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
    $('#code').innerHTML = code;
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
      <span class="muted">Read by <button class="link quiet" data-settings title="Change who reads PRs">${esc(pretty(s.meta.model))}</button> in ${clock(s.meta.ms)} · <button class="link${stale() ? ' strong' : ''}" data-fresh title="Read this PR again with ${esc(reader())}">${stale() ? `Re-read with ${esc(reader())}` : 'Re-read'}</button></span>
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

  // marks: [{ k, from, to }] in 1-based rows. Marked rows get a gutter number and stay visible even in long hunks.
  function hunk(pr, f, h, marks = []) {
    const MAX = 80, long = h.lines.length > MAX + 20 && !marks.some((m) => m.to > MAX), L = LETTER[f.status] || 'M';
    const rows = h.lines.map(([s, o, n, t, hl], i) => {
      const on = marks.filter((m) => i + 1 >= m.from && i + 1 <= m.to), first = marks.find((m) => m.from === i + 1);
      const cls = [s === '+' ? 'add' : s === '-' ? 'del' : '', long && i >= MAX ? 'more' : '', on.length ? 'pt' : ''].filter(Boolean).join(' ');
      return `<tr${cls ? ` class="${cls}"` : ''}${on.length ? ` data-pts="${on.map((m) => m.k).join(' ')}"` : ''}><td class="pg">${first ? `<span class="pb" data-pt="${first.k}">${first.k}</span>` : ''}</td><td class="ln">${o ?? ''}</td><td class="ln">${n ?? ''}</td><td class="sg">${s === ' ' ? '' : s === '-' ? '−' : '+'}</td><td class="tx">${colored(hl) ?? esc(t)}</td></tr>`;
    }).join('');
    return `<div class="hunk${marks.length ? ' marked' : ''}" id="h-${h.id}">
      <div class="hh"><span class="st st-${L}" title="${esc(f.status)}">${L}</span><a class="p" href="${esc(h.id[0] === 'd' && pr.since ? pr.since.compare : `${pr.url}/files`)}#${f.anchor}" target="_blank" rel="noopener" title="Open on GitHub">${pathHtml(f.path)}</a><span class="at">${h.at ? esc(h.at) : `line ${h.start}`}</span><span class="n">${delta(h.add, h.del)}</span></div>
      <div class="scroll"><table class="diff"><tbody>${rows}</tbody></table></div>
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

  // The hero's voyage: a route with a waypoint for each thing a review should pass through.
  const ROUTE = [['the entry point', 150, 210], ['what it calls', 250, 110], ['the data it writes', 360, 230], ['why it exists', 470, 90], ['what to verify', 580, 200], ['merge', 670, 50]];
  function routeSVG() {
    const d = ROUTE.reduce((acc, [, x, y], i) => {
      if (!i) return `M${x},${y}`;
      const [, px, py] = ROUTE[i - 1], mx = (px + x) / 2;
      return `${acc} C${mx},${py} ${mx},${y} ${x},${y}`;
    }, '');
    return `<svg class="route-art" viewBox="0 0 760 340" preserveAspectRatio="xMaxYMid meet" aria-hidden="true">
      <path class="route-line" d="${d}" pathLength="1"/>
      ${ROUTE.map(([t, x, y], i) => `<g class="wp" style="--i:${i}"><circle cx="${x}" cy="${y}" r="${i === ROUTE.length - 1 ? 7 : 5}"/><text x="${x + 12}" y="${y - 10}">${i + 1 < ROUTE.length ? `${String(i + 1).padStart(2, '0')} ` : ''}${t}</text></g>`).join('')}
    </svg>`;
  }

  // The same sequence diagram the app draws, frozen on one hop for the page.
  function seqAt(sc, nodes, i) { const k = play.i; play.i = i; const svg = seqSVG(sc, nodes); play.i = k; return svg; }

  function landingRows(demo) {
    const st = demo.story, it = st.intent;
    const verdicts = st.stops.filter((x) => x.necessity).slice(0, 4).map((x) => `<li><div class="v-head">${needIc(x.necessity.verdict)}<b>${esc(x.title)}</b><span class="need-w">${NEED[x.necessity.verdict][0]}</span></div><p>${prose(x.necessity.reason)}</p></li>`).join('');
    const reqs = (it?.items || []).map((r) => { const [l, t, g] = STATUS[r.status] || ['', '', 'dot']; return `<li class="${t}"><span class="ri">${ic(g, t)}</span><div><p class="rq">${prose(r.requirement)} <span class="rs">${l}</span></p><p class="re">${prose(r.evidence)}</p></div></li>`; }).join('');
    const sc = st.scenarios?.[0];
    return `
      <section class="l-row">
        <div class="l-copy"><h2>Every change has to earn its place.</h2>
          <p>Each part of the PR is measured against the goal it was written for, and marked needed, supporting or questionable. The reason is written so you can paste it straight into your review.</p></div>
        <div class="l-visual"><ul class="verdicts">${verdicts}</ul></div>
      </section>
      ${sc ? `<section class="l-row flip">
        <div class="l-copy"><h2>Press play on the runtime.</h2>
          <p>Follow a request hop by hop: who calls whom, what data moves, and what happens when a condition holds. On the map or as a sequence diagram, with the code for every hop.</p>
          <p class="l-cite">${esc(sc.title)}. ${prose(sc.trigger)}</p></div>
        <div class="l-visual seq-card">${seqAt(sc, st.flow.nodes, Math.min(3, sc.steps.length - 1))}</div>
      </section>` : ''}
      ${reqs ? `<section class="l-row">
        <div class="l-copy"><h2>Check it against the ticket.</h2>
          <p>Requirements from the linked issue, ticked off against the code that meets them. The gaps get listed too, which is usually where the review is.</p></div>
        <div class="l-visual"><ul class="reqs">${reqs}</ul></div>
      </section>` : ''}`;
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
        ${routeSVG()}
        <div class="l-hero-in">
          <h1>Ship what you<br>understand.</h1>
          <p class="l-sub">AI writes more of every pull request. Odyssey reads each one with you, stop by stop: what changed, why each part is there, how it runs, and what to check before you merge.</p>
          <div class="l-cta">${cta}</div>
        </div>
      </header>

      <section class="l-window-wrap" id="tour">
        <div class="l-glow" aria-hidden="true"></div>
        <div class="l-window">
          <div class="l-chrome"><span class="l-dot"></span><span class="l-url">odyssey <span>/</span> <b id="demo-name">loading…</b></span><span class="l-live">Live demo · click around</span></div>
          <div class="app l-app" id="demo-app"><nav class="tour" aria-label="Tour"></nav><section class="note" id="note"></section><section class="code" id="code"></section></div>
        </div>
      </section>

      <section class="l-row l-first">
        <div class="l-copy"><h2>Read it in the order it runs.</h2>
          <p>Odyssey breaks the diff into stops, starting where the code starts. Every sentence points at the lines it describes, and the real diff, coloured like GitHub's, is always right beside it.</p></div>
        <div class="l-visual l-facts">
          <div><b>Every hunk accounted for</b><p>Counted without AI. If the tour misses a change, it's listed for you to read.</p></div>
          <div><b>Only what's new</b><p>After a push, you land on the new commits and nothing else.</p></div>
          <div><b>A link for every stop</b><p>Send a teammate straight to the part you want to talk about.</p></div>
        </div>
      </section>
      <div id="l-rows"></div>

      <section class="l-band" id="security">
        <h2>Your code, your keys.</h2>
        <div class="l-trust">
          <div><b>Read-only GitHub</b><p>A GitHub App your organization installs. Everyone sees exactly the PRs their own account can read.</p></div>
          <div><b>Bring your own AI</b><p>Anthropic, OpenAI or OpenRouter with your key, or the Claude Code and Codex logins on your own machine. Odyssey has no model of its own.</p></div>
          <div><b>Kept by your team</b><p>Tours live in your Postgres, so anyone can reopen one without paying for another read. Keys are encrypted at rest.</p></div>
        </div>
      </section>

      <section class="l-final">
        <h2>Ship what you understand.</h2>
        ${me?.user ? '<a class="l-btn" href="#/">Open your pull requests</a>' : local ? '' : `<a class="l-btn" href="/auth/login">${GH_MARK}Sign in with GitHub</a>`}
      </section>

      <footer class="l-foot">
        <span class="brand-sm"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="12.5" r="2"/><circle cx="12.5" cy="3.5" r="2"/><path d="M3.5 10.5V8a3 3 0 0 1 3-3h4"/></svg>Odyssey</span>
        <span>Pull request tours for teams that review AI-written code.</span>
        <nav><a href="#tour" data-jump="tour">Demo</a><a href="#security" data-jump="security">Security</a>${me?.user ? '<a href="#/">Your pull requests</a>' : local ? '' : '<a href="/auth/login">Sign in</a>'}</nav>
      </footer>
    </div>`;
    try {
      const demo = await api('/demo.json');
      if (document.body.dataset.view !== 'landing') return;
      cur = { key: 'demo', demo: true, pr: demo.pr, story: demo.story, sel: 1 };
      $('#demo-name').textContent = `${demo.label.replace(/ \(.*/, '')} · ${demo.pr.title}`;
      $('#demo-app .tour').innerHTML = tour();
      show();
      $('#l-rows').innerHTML = landingRows(demo);
    } catch {
      $('#tour')?.remove();
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
    const t = e.target.closest?.('[data-view],[data-scn],[data-pstep],[data-play],[data-hop],[data-sort],[data-settings],[data-pt],[data-sel],[data-hunk],[data-ack],[data-step],[data-expand],[data-fresh]');
    if (!t) return;
    const ds = t.dataset;
    if (ds.view) { play.view = ds.view; $$('[data-view]').forEach((b) => { b.classList.toggle('on', b === t); b.setAttribute('aria-pressed', b === t); }); paintView(); }
    else if (ds.scn) { stopPlay(); play.sc = +ds.scn; play.i = 0; $$('[data-scn]').forEach((b) => { b.classList.toggle('on', b === t); b.setAttribute('aria-selected', b === t); }); paintView(); }
    else if (ds.pstep) { stopPlay(); goHop(play.i + +ds.pstep); }
    else if ('play' in ds) togglePlay();
    else if (ds.hop) { stopPlay(); goHop(+ds.hop); }
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

  $('#theme').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    store.set('theme', root.dataset.theme);
  });

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
  console.assert(colored('<span class="hljs-keyword">if</span> x &lt; 1') && !colored('<img src=x onerror=alert(1)>') && !colored('<span onclick="x">a</span>'), 'colored');
  console.assert(effort(5, 3, 1) === 1 && effort(88, 22, 5) === 2 && effort(300, 50, 10) === 3 && effort(3932, 232, 27) === 5, 'effort');
  console.assert(pretty('claude-sonnet-5-5') === 'Sonnet 5.5' && pretty('gpt-x') === 'gpt-x', 'pretty');
})();
