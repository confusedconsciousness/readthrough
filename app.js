// Odyssey front end: one IIFE. state → helpers → routing → home → PR panes → flow map → events.
(() => {
  'use strict';

  // ---------- state ----------

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const view = $('#view'), crumb = $('#crumb'), status = $('#status');
  // cur: { key, pr, story, err, serr, t0, sel } — sel is 'overview' | stop index | 'unread' | 'merge'
  let cur = null;

  const store = {
    get: (k, d) => { try { return JSON.parse(localStorage.getItem('odyssey:' + k)) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem('odyssey:' + k, JSON.stringify(v)); } catch {} },
  };
  const doneKey = () => `done:${cur.key}@${cur.story.meta.sha}`;
  const done = () => new Set(cur?.story ? store.get(doneKey(), []) : []);

  // ---------- helpers ----------

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = (p) => fetch(p).then(async (r) => {
    const j = await r.json().catch(() => ({}));
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
    history.replaceState(null, '', `#/${cur.key}${sel === 'overview' && !hasSince(cur.pr) ? '' : '/' + (typeof sel === 'number' ? sel + 1 : sel)}`);
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

  const VERDICT = { done: ['Does what was asked', 'ok', 'Yes'], partly: ['Partly does what was asked', 'warn', 'Partly'], not: ["Doesn't do what was asked", 'bad', 'No'], unclear: ["Can't tell from the diff", 'muted', '?'] };
  const STATUS = { met: ['Met', 'ok', '✓'], partial: ['Partly', 'warn', '◐'], missing: ['Missing', 'bad', '✕'], unclear: ['Unclear', 'muted', '?'] };

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
          <span class="muted">${esc(pretty(t.model))} · ${ago(t.at)}</span>
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
      ${s.stops.map((st, i) => `<a class="row stop${d.has(i) ? ' done' : ''}" data-sel="${i}"><span class="mark" aria-hidden="true"></span><span class="n">${i + 1}</span><span class="t">${esc(st.title)}</span><span class="c" title="lines changed">${size(st) || ''}</span></a>`).join('')}
      <p class="group">Check</p>
      ${hasIntent(s) ? `<a class="row" data-sel="intent">Does it do what was asked?<span class="c ${VERDICT[s.intent.verdict]?.[1] || ''}">${VERDICT[s.intent.verdict]?.[2] || ''}</span></a>` : ''}
      ${u.hunks.length || u.files.length ? `<a class="row" data-sel="unread">Unexplained<span class="c warn">${u.hunks.length + u.files.length}</span></a>` : ''}
      <a class="row" data-sel="merge">Before merging<span class="c">${s.checks.length || ''}</span></a>`;
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
    $('#note').scrollTop = $('#code').scrollTop = 0;
    $$('.tour [data-sel]').forEach((a) => a.classList.toggle('sel', a.dataset.sel === String(sel)));
    $('.tour .sel')?.scrollIntoView({ block: 'nearest' });
    bar();
  }

  function bar() {
    const s = cur.story;
    if (!s) {
      status.innerHTML = cur.serr ? `<span class="bad">${esc(cur.serr)}</span>` : `<span>Reading with ${esc(reader())} · <span class="elapsed" data-since="${cur.t0}">${clock(Date.now() - cur.t0)}</span></span>`;
      return;
    }
    const d = done(), n = s.stops.length, u = unread(cur.pr, s);
    status.innerHTML = `<span class="segs" aria-hidden="true">${s.stops.map((_, i) => `<i class="${d.has(i) ? 'on' : ''}${cur.sel === i ? ' here' : ''}"></i>`).join('')}</span>
      <span><b>${d.size}</b>/${n} understood</span>
      ${u.hunks.length ? `<span class="warn">${plural(u.hunks.length, 'hunk')} unexplained</span>` : '<span>Every hunk explained</span>'}
      <span class="muted">Read by <button class="link quiet" data-settings title="Change who reads PRs">${esc(pretty(s.meta.model))}</button> in ${clock(s.meta.ms)} · <button class="link" data-fresh>Re-read</button></span>
      <span class="keys"><kbd>j</kbd><kbd>k</kbd> move <kbd>x</kbd> understood <kbd>/</kbd> open</span>`;
  }

  function waiting() {
    const { pr } = cur;
    return [`${heading(pr)}
      ${cur.serr ? `<div class="notice bad"><p>${esc(cur.serr)}</p><button class="btn" data-fresh>Try again</button></div>`
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
       ${hasIntent(s) ? `<p class="asked"><a data-sel="intent" class="verdict ${VERDICT[s.intent.verdict][1]}">${VERDICT[s.intent.verdict][0]}</a> <span class="muted">· ${s.intent.items.filter((r) => r.status === 'met').length} of ${s.intent.items.length} requirements met, from ${s.intent.source === 'issue' ? 'the linked issue' : 'the description'}</span></p>` : ''}
       <h2>Why</h2><p>${prose(s.why)}</p>
       ${s.changes.length ? `<h2>Behaviour</h2><table class="changes"><thead><tr><th>Before</th><th>After</th></tr></thead><tbody>${s.changes.map((c) => `<tr><td>${prose(c.before)}</td><td>${prose(c.after)}</td></tr>`).join('')}</tbody></table>` : ''}
       ${facts(pr)}${desc(pr)}
       <div class="actions"><button class="btn primary" data-sel="0">Start the tour <kbd>j</kbd></button></div>`,
      `${s.flow.nodes.length ? `<div class="block"><div class="block-head"><h2>How it connects</h2><p class="legend"><span class="lg a">A</span>added <span class="lg m">M</span>modified <span class="lg d">D</span>deleted <span class="lg c"></span>unchanged</p></div><div class="map">${flowMap(s.flow, n)}</div></div>` : ''}
       <div class="block"><div class="block-head"><h2>Files</h2></div>${files(pr, s)}</div>`,
    ];
    if (sel === 'merge') {
      const ids = [...new Set(s.checks.map((c) => c.hunk).filter(Boolean))];
      return [
        `<h1 class="title">Before merging</h1>
         ${s.checks.length ? `<ol class="checks">${s.checks.map((c) => `<li><p>${prose(c.text)}</p>${c.hunk ? `<a class="loc" data-hunk="${esc(c.hunk)}">${esc(loc(c.hunk))}</a>` : ''}</li>`).join('')}</ol>` : '<p class="muted">The model flagged nothing.</p>'}
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
       ${pointList(pts)}
       ${st.check ? `<div class="verify"><b>Verify</b><p>${prose(st.check)}</p></div>` : ''}
       <div class="actions">
         <button class="btn${d.has(sel) ? ' on' : ''}" data-ack="${sel}" aria-pressed="${d.has(sel)}"><span class="tick" aria-hidden="true"></span>${d.has(sel) ? 'Understood' : 'Mark understood'} <kbd>x</kbd></button>
         <button class="btn" data-step="1">Next <kbd>j</kbd></button>
       </div>`,
      codeFor(pr, pts, st.hunks) || `<p class="code-empty">This stop has no code of its own.</p>`,
    ];
  }

  // Points are numbered in reading order; the same numbers mark their rows in the code pane.
  const numbered = (points) => (points || []).map((pt, k) => ({ ...pt, k: k + 1 }));
  const pointList = (pts) => (pts.length ? `<ol class="points">${pts.map((pt) => `<li${pt.hunk ? ` data-pt="${pt.k}" tabindex="0"` : ''}><span class="pn">${pt.k}</span><span class="pt-t">${prose(pt.text)}</span>${pt.hunk ? `<span class="pt-at">${esc(loc(pt.hunk, pt.from))}</span>` : ''}</li>`).join('')}</ol>` : '');
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
       <p class="verdict-big ${tone}">${label}</p>
       <p class="lead">${prose(it.summary)}</p>
       <p class="small muted">${src}</p>
       <ul class="reqs">${it.items.map((r) => {
         const [l, t, g] = STATUS[r.status] || ['', '', ''];
         return `<li class="${t}"><span class="ri" aria-hidden="true">${g}</span><div><p class="rq">${prose(r.requirement)} <span class="rs">${l}</span></p><p class="re">${prose(r.evidence)}</p>${r.hunk ? `<a class="loc" data-hunk="${esc(r.hunk)}">${esc(loc(r.hunk))}</a>` : ''}</div></li>`;
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

  // marks: [{ k, from, to }] in 1-based rows. Marked rows get a gutter number and stay visible even in long hunks.
  function hunk(pr, f, h, marks = []) {
    const MAX = 80, long = h.lines.length > MAX + 20 && !marks.some((m) => m.to > MAX), L = LETTER[f.status] || 'M';
    const rows = h.lines.map(([s, o, n, t], i) => {
      const on = marks.filter((m) => i + 1 >= m.from && i + 1 <= m.to), first = marks.find((m) => m.from === i + 1);
      const cls = [s === '+' ? 'add' : s === '-' ? 'del' : '', long && i >= MAX ? 'more' : '', on.length ? 'pt' : ''].filter(Boolean).join(' ');
      return `<tr${cls ? ` class="${cls}"` : ''}${on.length ? ` data-pts="${on.map((m) => m.k).join(' ')}"` : ''}><td class="pg">${first ? `<span class="pb" data-pt="${first.k}">${first.k}</span>` : ''}</td><td class="ln">${o ?? ''}</td><td class="ln">${n ?? ''}</td><td class="sg">${s === ' ' ? '' : s === '-' ? '−' : '+'}</td><td class="tx">${esc(t)}</td></tr>`;
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
    if (typeof i !== 'number' || !cur?.story) return;
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
      return `<g class="node s-${esc(n.status)}${st >= 0 ? ' link' : ''}" data-node="${i}"${st >= 0 ? ` data-sel="${st}" tabindex="0" role="button" aria-label="${esc(n.label)}, stop ${st + 1}"` : ''} transform="translate(${x},${y})">
        <title>${esc(n.label)} — ${esc(n.where)}</title>
        <rect width="${W}" height="${H}" rx="4"/>
        ${l ? `<text class="nst" x="10" y="20">${l}</text>` : ''}
        <text class="nl" x="${l ? 24 : 10}" y="20">${esc(cut(n.label, l ? 19 : 21))}</text>
        <text class="nw" x="10" y="37">${esc(cutL(n.where, st >= 0 ? 22 : 27))}</text>
        ${st >= 0 ? `<text class="ns" x="${W - 8}" y="37" text-anchor="end">stop ${st + 1}</text>` : ''}
      </g>`;
    }).join('');

    return `<svg viewBox="0 0 ${width} ${height}" ${thumb ? 'preserveAspectRatio="xMidYMid meet"' : `style="width:100%;max-width:${width}px;min-width:${Math.round(width * 0.7)}px"`} role="img" aria-label="How the changed parts connect">
      <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z"/></marker></defs>
      ${edges}${nodes}</svg>`;
  }

  // ---------- settings: who reads the PR ----------

  const dlg = $('#settings'), form = $('#settings-form');
  let cfg = null;
  const pretty = (m) => String(m || '').replace(/^claude-([a-z]+)-(\d+)-(\d+)$/, (_, a, b, c) => `${a[0].toUpperCase()}${a.slice(1)} ${b}.${c}`);
  const reader = () => (cfg ? pretty(cfg.model) || { codex: 'Codex', api: 'the API', claude: 'Claude' }[cfg.provider] : 'Claude');
  api('/api/settings').then((c) => { cfg = c; }, () => {});

  const syncFields = () => $$('.fields', form).forEach((d) => { d.hidden = d.dataset.for !== form.elements.provider.value; });

  async function openSettings() {
    cfg = await api('/api/settings');
    const f = form.elements, mine = (p) => (cfg.provider === p ? cfg.model : '');
    f.provider.value = cfg.provider;
    const cm = mine('claude') || 'claude-sonnet-5-5';
    if (![...f.claudeModel.options].some((o) => o.value === cm)) f.claudeModel.add(new Option(cm, cm));
    f.claudeModel.value = cm;
    f.codexModel.value = mine('codex');
    f.apiModel.value = mine('api');
    f.baseURL.value = cfg.baseURL;
    f.key.value = '';
    f.key.placeholder = cfg.hasKey ? 'Saved. Leave blank to keep it.' : 'Paste your key';
    for (const r of f.provider) {
      const missing = r.value !== 'api' && cfg.installed[r.value] === false;
      r.disabled = missing;
      r.closest('label').classList.toggle('off', missing);
      if (missing) r.closest('label').querySelector('small').textContent = `Not available: the ${r.value} command wasn't found on this machine.`;
    }
    $('#settings-err').textContent = '';
    syncFields();
    dlg.showModal();
  }

  form.addEventListener('change', (e) => { if (e.target.name === 'provider') syncFields(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = form.elements, provider = f.provider.value;
    const model = { claude: f.claudeModel.value, codex: f.codexModel.value, api: f.apiModel.value }[provider];
    try {
      const r = await fetch('/api/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, model, baseURL: f.baseURL.value.trim() || undefined, key: f.key.value }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      cfg = j;
      dlg.close();
      if (cur) open(cur.key, cur.sel);
    } catch (err) {
      $('#settings-err').textContent = err.message;
    }
  });
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === dlg) dlg.close(); });
  $('#gear').addEventListener('click', () => openSettings().catch((e) => alert(e.message)));

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
    const t = e.target.closest('[data-sort],[data-settings],[data-pt],[data-sel],[data-hunk],[data-ack],[data-step],[data-expand],[data-fresh]');
    if (!t) return;
    const ds = t.dataset;
    if (ds.sort) { store.set('sort', ds.sort); lists(); }
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
    if (e.target.closest('input,textarea')) { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.key === '/') { e.preventDefault(); ($('.home .go input') || $('#pr-input')).focus(); return; }
    if (e.key === 'Enter' && e.target.matches?.('.node.link')) return select(+e.target.dataset.sel);
    if (!cur?.pr) return;
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
  route();

  // ---------- self-checks ----------

  console.assert(refOf('https://github.com/a/b/pull/12') === 'a/b/12', 'refOf url');
  console.assert(refOf('a/b#3') === 'a/b/3' && refOf('a/b') === null, 'refOf short');
  console.assert(prose('use `x<y`') === 'use <code>x&lt;y</code>', 'prose escapes');
  console.assert(clock(72000) === '1:12', 'clock');
  console.assert(effort(5, 3, 1) === 1 && effort(88, 22, 5) === 2 && effort(300, 50, 10) === 3 && effort(3932, 232, 27) === 5, 'effort');
  console.assert(pretty('claude-sonnet-5-5') === 'Sonnet 5.5' && pretty('gpt-x') === 'gpt-x', 'pretty');
})();
