// Readthrough server: the app, GitHub sign-in, and the JSON API.
// Hosted mode (GITHUB_CLIENT_ID set): people sign in through the GitHub App and bring their own AI key.
// Local mode: one person, GitHub through the `gh` CLI, and the Claude Code / Codex CLIs on this machine allowed.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const { gh, graphql, oauth, localToken } = require('./github');
const ai = require('./ai');
const hljs = require('highlight.js');

// ---------- config ----------

const PORT = +process.env.PORT || 4400;
const MODE = process.env.GITHUB_CLIENT_ID ? 'hosted' : 'local';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const HOST = process.env.HOST || (MODE === 'hosted' ? '0.0.0.0' : '127.0.0.1');
const SECURE = PUBLIC_URL.startsWith('https://');
const ALLOWED = (process.env.READTHROUGH_ALLOWED_ORGS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const APP_SLUG = process.env.GITHUB_APP_SLUG || '';

function fail(msg) { console.error(`readthrough: ${msg}`); process.exit(1); }
// Postgres when DATABASE_URL is set; otherwise SQLite in one file (default ./readthrough.db).
const SQLITE = process.env.READTHROUGH_SQLITE || path.join(__dirname, 'readthrough.db');
if (MODE === 'hosted') {
  if (!process.env.GITHUB_CLIENT_SECRET) fail('hosted mode needs GITHUB_CLIENT_SECRET from your GitHub App.');
  if (!process.env.PUBLIC_URL) fail('hosted mode needs PUBLIC_URL, e.g. https://readthrough.example.com');
  if ((process.env.READTHROUGH_SECRET || '').length < 32) fail('hosted mode needs READTHROUGH_SECRET, 32+ random characters (openssl rand -base64 48).');
}

// Locally the sealing secret is generated once and kept next to the app, readable only by you.
function secret() {
  if (process.env.READTHROUGH_SECRET) return process.env.READTHROUGH_SECRET;
  const f = path.join(__dirname, '.readthrough-secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(48).toString('base64'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}

const auth = MODE === 'hosted' && oauth({ clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET, publicURL: PUBLIC_URL });

// ---------- PR ----------

// Accepts github.com/o/r/pull/12, o/r#12 or o/r/12. Owner and repo are lowercased so one PR has one key.
function parseRef(s) {
  const m = String(s || '').trim().match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+)(?:\/pull\/|#|\/)(\d+)/);
  return m && { owner: m[1].toLowerCase(), repo: m[2].toLowerCase(), num: +m[3] };
}
const refKey = (ref) => `${ref.owner}/${ref.repo}/${ref.num}`;

// ponytail: a filename heuristic, not linguist. Add patterns as they show up.
const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|Gemfile\.lock|composer\.lock|Podfile\.lock)$|\.min\.(js|css)$|\.map$|(^|\/)(dist|vendor|__snapshots__)\/|\.snap$|\.pb\.go$|_pb2\.py$|\.generated\.\w+$/;
const TEST = /(^|\/)(tests?|__tests__|spec|e2e)\/|[._-](test|spec)\.\w+$|_test\.go$|(^|\/)test_[^/]+\.py$/;
const DEPS = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|pom\.xml|build\.gradle(\.kts)?|Podfile)$/;
const MIGRATION = /migrat|(^|\/)schema\.(sql|prisma|rb)$/i;
const CI = /^\.github\/workflows\/|(^|\/)(Dockerfile|docker-compose[^/]*|\.gitlab-ci\.yml|Jenkinsfile)$/;
const ENV = /(^|\/)\.env[^/]*$|(^|\/)(config|settings)\/|\.(tf|tfvars)$/;

// GitHub's per-file patch → hunks of [sign, oldLine, newLine, text].
function hunks(patch, f, pre = 'f') {
  const out = [];
  let h, o, n;
  for (const line of (patch || '').split('\n')) {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)/);
    if (m) {
      o = +m[1]; n = +m[2];
      out.push(h = { id: `${pre}${f}h${out.length}`, at: m[3], start: n, add: 0, del: 0, lines: [] });
    } else if (!h || line[0] === '\\') continue; // "\ No newline at end of file"
    else if (line[0] === '+') { h.lines.push(['+', null, n++, line.slice(1)]); h.add++; }
    else if (line[0] === '-') { h.lines.push(['-', o++, null, line.slice(1)]); h.del++; }
    else h.lines.push([' ', o++, n++, line.slice(1)]);
  }
  return out;
}

// A GitHub file entry (PR files or compare) → our file with parsed hunks.
const fileOf = (x, i, pre) => ({
  i, path: x.filename, prev: x.previous_filename || null, status: x.status,
  add: x.additions, del: x.deletions,
  generated: GENERATED.test(x.filename),
  nodiff: !x.patch,
  anchor: 'diff-' + crypto.createHash('sha256').update(x.filename).digest('hex'),
  hunks: paint(hunks(x.patch, i, pre), langOf(x.filename)),
});

// Syntax colours, GitHub style: each hunk is highlighted as one block (so strings and comments that span lines
// stay coloured), then split back into lines with any open <span> closed and reopened at the line breaks.
// highlight.js escapes the code itself; its output is only <span class="hljs-…"> wrappers.
function langOf(file) {
  const base = file.split('/').pop().toLowerCase();
  const name = { dockerfile: 'dockerfile', makefile: 'makefile', gemfile: 'ruby', rakefile: 'ruby' }[base];
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return name || (ext && hljs.getLanguage(ext) ? ext : null);
}
function paint(hs, lang) {
  if (!lang) return hs;
  for (const h of hs) {
    let html;
    try { html = hljs.highlight(h.lines.map((l) => l[3]).join('\n'), { language: lang, ignoreIllegals: true }).value; } catch { continue; }
    const rows = html.split('\n');
    if (rows.length !== h.lines.length) continue;
    const open = [];
    rows.forEach((row, i) => {
      const start = open.join('');
      for (const m of row.matchAll(/<span[^>]*>|<\/span>/g)) m[0] === '</span>' ? open.pop() : open.push(m[0]);
      h.lines[i][4] = start + row + '</span>'.repeat(open.length);
    });
  }
  return hs;
}


// Issues the PR says it closes ("Fixes #12" or linked in the sidebar). GitHub only; Jira keys aren't followed.
const ISSUES = `query($o: String!, $r: String!, $n: Int!) { repository(owner: $o, name: $r) { pullRequest(number: $n) {
  closingIssuesReferences(first: 5) { nodes { number title body url repository { nameWithOwner } } } } } }`;
async function linkedIssues(ctx, ref) {
  try {
    const d = await graphql(ctx.token, ISSUES, { o: ref.owner, r: ref.repo, n: ref.num });
    return d.repository.pullRequest.closingIssuesReferences.nodes.map((n) => ({
      ref: `${n.repository.nameWithOwner}#${n.number}`, title: n.title, url: n.url, body: (n.body || '').slice(0, 6000),
    }));
  } catch { return []; } // ponytail: a failed lookup reads as "no linked issue"; surface the error if it ever matters
}

// What changed since the newest tour of an older commit of this PR. Only a fast-forward has a clean delta;
// after a rebase or force-push the old commit isn't an ancestor, so we say so instead of diffing unrelated history.
async function sinceLast(ctx, ref, pr) {
  const old = await db.previousTour(ref, pr.sha);
  if (!old) return null;
  const base = { sha: old.sha, at: old.at, compare: `${pr.url}/files/${old.sha}..${pr.sha}` };
  try {
    const c = await gh(ctx.token, `repos/${ref.owner}/${ref.repo}/compare/${old.sha}...${pr.sha}`);
    if (c.status !== 'ahead') return { ...base, rewritten: true, commits: [], files: [] };
    return {
      ...base, rewritten: false,
      commits: c.commits.map((x) => ({ sha: x.sha.slice(0, 7), msg: x.commit.message.split('\n')[0], author: x.author?.login || x.commit.author?.name || '' })),
      files: (c.files || []).map((x, i) => fileOf(x, i, 'd')),
    };
  } catch {
    return { ...base, rewritten: true, commits: [], files: [] };
  }
}

// Line comments from the PR's reviews, as threads (a comment and its replies), each pinned to the row of our diff it
// was written on: by file, then the new line number (or the old one for comments on removed lines). A thread whose
// line is no longer in the diff has hunk '' and is shown as outdated.
function threadsOf(comments, files) {
  const at = new Map(), out = [];
  for (const c of [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const item = { author: c.user?.login || 'ghost', avatar: c.user?.avatar_url || '', body: String(c.body || '').slice(0, 4000), at: c.created_at, url: c.html_url };
    const parent = c.in_reply_to_id && at.get(c.in_reply_to_id);
    if (parent) { parent.items.push(item); at.set(c.id, parent); continue; }
    const t = { path: c.path, side: c.side === 'LEFT' ? 'LEFT' : 'RIGHT', line: c.line ?? null, hunk: '', row: 0, items: [item] };
    const f = files.find((x) => x.path === c.path);
    if (f && t.line != null) {
      for (const h of f.hunks) {
        const r = h.lines.findIndex(([s, o, n]) => (t.side === 'LEFT' ? s !== '+' && o === t.line : s !== '-' && n === t.line));
        if (r >= 0) { t.hunk = h.id; t.row = r; break; }
      }
    }
    at.set(c.id, t);
    out.push(t);
  }
  return out;
}

async function loadPR(ctx, ref) {
  const base = `repos/${ref.owner}/${ref.repo}/pulls/${ref.num}`;
  const [pr, files, commits, issues, comments] = await Promise.all([
    gh(ctx.token, base), gh(ctx.token, `${base}/files?per_page=100`, { all: true }), gh(ctx.token, `${base}/commits?per_page=100`, { all: true }), linkedIssues(ctx, ref),
    gh(ctx.token, `${base}/comments?per_page=100`, { all: true }).catch(() => []), // ponytail: comments are a bonus; a failed fetch shows none
  ]);
  const fs_ = files.map((x, i) => fileOf(x, i, 'f'));
  const pick = (re) => fs_.filter((f) => re.test(f.path)).map((f) => f.path);
  const code = fs_.filter((f) => !f.generated && !TEST.test(f.path) && /\.\w+$/.test(f.path) && !/\.(md|txt|json|ya?ml|toml|lock)$/.test(f.path));
  const tests = pick(TEST), signals = [];
  if (code.length && !tests.length) signals.push({ tone: 'warn', label: 'No test files changed', files: [] });
  if (tests.length) signals.push({ tone: 'info', label: `Tests · ${tests.length}`, files: tests });
  for (const [re, label, tone] of [[DEPS, 'Dependencies', 'warn'], [MIGRATION, 'Schema / migration', 'warn'], [CI, 'CI / build', 'info'], [ENV, 'Config', 'info']]) {
    const hit = pick(re);
    if (hit.length) signals.push({ tone, label, files: hit });
  }
  const gone = fs_.filter((f) => f.status === 'removed').map((f) => f.path);
  if (gone.length) signals.push({ tone: 'info', label: `Deleted · ${gone.length}`, files: gone });
  const gen = fs_.filter((f) => f.generated).map((f) => f.path);
  if (gen.length) signals.push({ tone: 'quiet', label: `Generated · ${gen.length} skipped`, files: gen });

  const out = {
    ref, url: pr.html_url, title: pr.title, body: pr.body || '', author: pr.user?.login,
    state: pr.merged_at ? 'merged' : pr.draft ? 'draft' : pr.state,
    base: pr.base.ref, head: pr.head.ref, sha: pr.head.sha,
    add: pr.additions, del: pr.deletions,
    commits: commits.map((c) => c.commit.message.split('\n')[0]),
    files: fs_, signals, issues, comments: threadsOf(comments, fs_),
  };
  out.since = await sinceLast(ctx, ref, out);
  return out;
}

// ---------- AI settings ----------

const available = () => Object.entries(ai.PROVIDERS).filter(([, p]) => p.hosted || MODE === 'local').map(([id, p]) => ({ id, ...p }));
const DEFAULT_AI = MODE === 'local' ? { provider: 'claude', model: 'claude-sonnet-5-5' } : { provider: 'anthropic', model: 'claude-sonnet-5-5' };

async function aiConfig(user) {
  const s = (await db.getAI(user.id)) || { ...DEFAULT_AI, keys: {} };
  let key = s.keys[s.provider];
  // Locally a key in the environment works too; a hosted server never lends its own key to users.
  if (!key && MODE === 'local') key = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY }[s.provider];
  return { provider: s.provider, model: s.model, baseURL: s.baseURL, key, saved: Object.keys(s.keys) };
}

async function publicSettings(user) {
  const c = await aiConfig(user);
  return { provider: c.provider, model: c.model, baseURL: c.baseURL || 'https://api.openai.com/v1', hasKey: !!c.key, saved: c.saved, providers: available(), installed: ai.installed, mode: MODE };
}

// Trust boundary: everything the settings form sends is checked here.
async function saveSettings(user, b) {
  const p = available().find((x) => x.id === b.provider);
  if (!p) throw new Error('Pick one of the listed providers.');
  let model = String(b.model ?? '').trim();
  if (p.models) {
    model ||= p.models[0];
    if (!p.models.includes(model)) throw new Error(`Pick one of the listed ${p.label} models.`);
  } else if (model && !/^[\w.:\/@-]{1,100}$/.test(model)) throw new Error('Model names are letters, digits and . : / @ - _');
  if (b.provider === 'openai' && !model) throw new Error('Name the model the API should use.');
  let baseURL = null;
  if (b.provider === 'openai') {
    baseURL = String(b.baseURL || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
    let u;
    try { u = new URL(baseURL); } catch {}
    if (!u || !['https:', 'http:'].includes(u.protocol)) throw new Error('Base URL must start with https://');
    if (MODE === 'hosted' && u.protocol !== 'https:') throw new Error('Base URL must use https:// on a hosted Readthrough.');
  }
  const key = typeof b.key === 'string' ? b.key.trim() : '';
  if (key.length > 500) throw new Error('That key is too long.');
  const cur = await aiConfig(user);
  if (p.key && !key && !cur.saved.includes(b.provider) && !(MODE === 'local' && cur.provider === b.provider && cur.key)) throw new Error(`Paste your ${p.label} key.`);
  await db.setAI(user.id, { provider: b.provider, model, baseURL, key, clearKey: !!b.clearKey });
  return publicSettings(user);
}

// ---------- tours ----------

// In-flight reads, one per PR commit and reader: leaving a PR mid-read and coming back joins the same read.
// ponytail: in memory, so one server process; use a Postgres advisory lock per key to run several.
const inflight = new Map();
const readerOf = (cfg) => `${cfg.provider}-${cfg.model || 'default'}`;
const readingOf = (ref, sha) => [...inflight.entries()].find(([k]) => k.startsWith(`${refKey(ref)}@${sha}#`))?.[1];

// Keep only anchors that exist; clamp rows to the hunk; a point's hunk is always shown with its stop.
function tidy(s, pr) {
  const known = new Map([...pr.files, ...(pr.since?.files || [])].flatMap((f) => f.hunks.map((h) => [h.id, h.lines.length])));
  const pin = (pt) => {
    const n = known.get(pt.hunk);
    if (!n) { pt.hunk = ''; return; }
    pt.from = Math.min(Math.max(1, pt.from), n);
    pt.to = Math.min(Math.max(pt.from, pt.to), n);
  };
  s.since?.points.forEach(pin);
  const ids = new Set(s.flow.nodes.map((n) => n.id));
  s.scenarios = (s.scenarios || []).map((sc) => ({
    ...sc,
    steps: sc.steps.filter((st) => ids.has(st.from) && ids.has(st.to)).map((st) => {
      const pt = { hunk: st.hunk, from: st.start, to: st.end };
      pin(pt);
      return { ...st, hunk: pt.hunk, start: pt.hunk ? pt.from : 0, end: pt.hunk ? pt.to : 0 };
    }),
  })).filter((sc) => sc.steps.length);
  s.intent?.items.forEach((it) => { if (!known.has(it.hunk)) it.hunk = ''; });
  for (const st of s.stops) {
    st.points.forEach(pin);
    st.hunks = [...new Set([...st.hunks, ...st.points.map((pt) => pt.hunk)])].filter((id) => known.has(id));
  }
  s.premortem?.failures.forEach(pin);
  if (s.chapters?.length) {
    const seen = new Set();
    s.chapters = s.chapters.map((c) => ({ ...c, stops: c.stops.filter((i) => Number.isInteger(i) && i >= 0 && i < s.stops.length && !seen.has(i) && seen.add(i)).sort((a, b) => a - b) })).filter((c) => c.stops.length);
    const left = s.stops.map((_, i) => i).filter((i) => !seen.has(i));
    if (left.length) s.chapters.push({ title: 'Other changes', summary: '', stops: left });
  }
  // The reviewer's findings are pinned like points; a blocker always means "request changes", whatever the model said.
  if (s.review) {
    s.review.findings.forEach(pin);
    if (s.review.findings.some((f) => f.severity === 'blocker')) s.review.recommendation = 'request_changes';
  }
}

// The text of every hunk, stored with the tour so a later commit can find where each anchor moved.
const anchorsOf = (pr) => Object.fromEntries(pr.files.flatMap((f) => f.hunks.map((h) => [h.id, [f.path, h.lines.map((l) => l[0] + l[3]).join('\n')]])));

// Carry a tour of an older commit onto this one, without AI. Every anchor is re-pinned by finding its exact
// lines in the current diff; an anchor whose lines the new commits changed is dropped, and so is a stop left
// with no code. Returns the carried tour, the findings to re-check (unpinned or moved), and the hunks no stop covers.
function carry(old, pr) {
  const tour = structuredClone(old), A = old.anchors;
  delete tour.anchors; delete tour.since;
  const now = new Map(pr.files.map((f) => [f.path, f.hunks.map((h) => ({ id: h.id, rows: h.lines.map((l) => l[0] + l[3]) }))]));
  const rows = (id) => A[id]?.[1].split('\n');
  const range = (id, a, b) => {
    const seg = rows(id)?.slice(a - 1, b);
    if (!seg?.length || !a) return null;
    for (const h of now.get(A[id][0]) || []) {
      for (let j = 0; j + seg.length <= h.rows.length; j++) if (seg.every((r, k) => h.rows[j + k] === r)) return { hunk: h.id, from: j + 1, to: j + seg.length };
    }
    return null;
  };
  const hunk = (id) => { // the current hunk sharing the most changed lines with an old one
    const mine = new Set((rows(id) || []).filter((r) => r[0] !== ' '));
    let best = null, most = 0;
    for (const h of now.get(A[id]?.[0]) || []) { const k = h.rows.filter((r) => mine.has(r)).length; if (k > most) [best, most] = [h.id, k]; }
    return best;
  };
  const move = (pt, a = 'from', b = 'to') => {
    const r = range(pt.hunk, pt[a], pt[b]);
    if (r) [pt.hunk, pt[a], pt[b]] = [r.hunk, r.from, r.to];
    else [pt.hunk, pt[a], pt[b]] = ['', 0, 0];
    return !!r;
  };
  const idx = [];
  let k = 0;
  tour.stops = tour.stops.filter((st, i) => {
    st.points = st.points.filter((p) => move(p));
    st.hunks = [...new Set(st.hunks.map(hunk).filter(Boolean))];
    idx[i] = st.hunks.length ? k++ : -1;
    return st.hunks.length > 0;
  });
  tour.flow.nodes.forEach((n) => { n.stop = n.stop >= 0 ? idx[n.stop] ?? -1 : -1; });
  tour.chapters = (tour.chapters || []).map((c) => ({ ...c, stops: c.stops.map((i) => idx[i] ?? -1).filter((i) => i >= 0) })).filter((c) => c.stops.length);
  tour.premortem?.failures.forEach((f) => { if (f.hunk) move(f); });
  tour.scenarios?.forEach((sc) => sc.steps.forEach((st) => { if (st.hunk) move(st, 'start', 'end'); }));
  tour.intent?.items.forEach((it) => { it.hunk = (it.hunk && hunk(it.hunk)) || ''; });
  const open = [];
  tour.review.findings = tour.review.findings.filter((f) => (f.hunk && move(f)) || (open.push(f), false));
  const covered = new Set(tour.stops.flatMap((s) => s.hunks));
  const uncovered = pr.files.filter((f) => !f.generated && !f.nodiff).map((f) => ({ ...f, hunks: f.hunks.filter((h) => !covered.has(h.id)) })).filter((f) => f.hunks.length);
  return { tour, open, uncovered };
}

// Readers watching a read: each in-flight entry keeps its current step and who to tell when it changes.
const nice = (m) => String(m || '').replace(/^claude-([a-z]+)-(\d+)-(\d+)$/, (_, a, b, c) => `${a[0].toUpperCase()}${a.slice(1)} ${b}.${c}`) || 'the model';
const watch = (entry, onStep) => { if (!onStep) return entry.job; entry.listeners.add(onStep); if (entry.step) onStep(entry.step); return entry.job; };

async function story(ctx, ref, fresh, onStep) {
  const pr = await loadPR(ctx, ref); // also the access check: GitHub refuses PRs this user can't see
  const cfg = await aiConfig(ctx.user), reader = readerOf(cfg), key = `${refKey(ref)}@${pr.sha}#${reader}`;
  await db.markOpened(ctx.user.id, ref);
  if (!fresh) {
    // The chosen model is already reading this commit (a re-read, say): wait for it rather than show the older tour it replaces.
    if (inflight.has(key)) return watch(inflight.get(key), onStep);
    const hit = await db.getTour(ref, pr.sha, reader);
    if (hit) return hit;
    const busy = readingOf(ref, pr.sha); // already being read, perhaps by another reader: wait for that
    if (busy) return watch(busy, onStep);
  }
  if (inflight.has(key)) return watch(inflight.get(key), onStep);
  const entry = { since: Date.now(), key: refKey(ref), title: pr.title, model: cfg.model || cfg.provider, by: ctx.user.id, step: '', listeners: new Set() };
  const step = (t) => { entry.step = t; entry.listeners.forEach((f) => f(t)); };
  const job = (async () => {
    const t0 = Date.now(), local = MODE === 'local';
    // New commits on a toured PR: carry the old tour forward and read only what's new. Re-read (fresh) reads it all.
    const prev = !fresh && pr.since && !pr.since.rewritten ? await db.previousTour(ref, pr.sha) : null;
    let s, model, from = null;
    if (prev?.data.anchors && prev.data.review) { // older tours lack anchors or a review: read those in full once
      const { tour, open, uncovered } = carry(prev.data, pr);
      step(`Reading the new commits with ${nice(cfg.model || cfg.provider)}`);
      const u = await ai.update(pr, tour, open, uncovered, cfg, { local });
      ({ model } = u);
      s = tour;
      s.since = u.s.since;
      const first = s.stops.length;
      s.stops.push(...u.s.stops);
      if (s.chapters?.length && u.s.stops.length) s.chapters.push({ title: 'Added since the last tour', summary: u.s.since.summary, stops: u.s.stops.map((_, k) => first + k) });
      s.review.findings = [...u.s.findings, ...open.filter((_, i) => u.s.kept.includes(i + 1)), ...s.review.findings];
      Object.assign(s.review, u.s.review);
      from = prev.sha;
    } else {
      step(`Reading ${pr.files.length} ${pr.files.length === 1 ? 'file' : 'files'} with ${nice(cfg.model || cfg.provider)}`);
      ({ s, model } = await ai.analyse(pr, cfg, { local }));
    }
    step('Pinning the tour to the code');
    tidy(s, pr);
    s.anchors = anchorsOf(pr);
    s.meta = { sha: pr.sha, provider: cfg.provider, model, ms: Date.now() - t0, at: new Date().toISOString(), ref: pr.ref, title: pr.title, state: pr.state, from };
    await db.putTour(ref, pr.sha, reader, s, ctx.user.id);
    return s;
  })().finally(() => inflight.delete(key));
  entry.job = job;
  inflight.set(key, entry);
  return watch(entry, onStep);
}

// Home page: this user's reads in progress, and the latest tour of each PR they've opened.
const PER_PAGE = 6; // about one screen of tours in every home layout
async function recent(ctx, params) {
  const cfg = await aiConfig(ctx.user);
  const text = String(params.get('q') || '').slice(0, 200), page = Math.min(Math.max(0, parseInt(params.get('page'), 10) || 0), 1000);
  const { total, rows } = await db.recentTours(ctx.user.id, readerOf(cfg), { q: text, limit: PER_PAGE, offset: page * PER_PAGE });
  const tours = rows.map((r) => {
    const s = r.data;
    return { key: `${r.owner}/${r.repo}/${r.num}`, title: s.meta.title || null, state: s.meta.state || null, gist: s.gist, flow: s.flow, stops: s.stops.length, model: s.meta.model, sha: s.meta.sha, at: s.meta.at, rec: s.review?.recommendation || null };
  });
  const reading = [...inflight.values()].filter((x) => x.by === ctx.user.id).map(({ since, key, title, model }) => ({ key, since, title, model }));
  return { tours, reading, total, page, per: PER_PAGE };
}

// One GraphQL search per list gets the size, review state and head commit that the REST search lacks.
const SEARCH = `query($q: String!) { search(query: $q, type: ISSUE, first: 15) { nodes { ... on PullRequest {
  number title isDraft updatedAt additions deletions changedFiles reviewDecision headRefOid
  repository { nameWithOwner } author { login avatarUrl(size: 40) } } } } }`;

async function inbox(ctx) {
  const q = async (filter) => (await graphql(ctx.token, SEARCH, { q: `is:pr is:open archived:false sort:updated-desc ${filter}` })).search.nodes.filter((n) => n.number);
  const [review, mine] = await Promise.all([q('review-requested:@me'), q('author:@me')]);
  const done = await db.toured([...review, ...mine].map((n) => n.headRefOid));
  const row = (n) => {
    const [owner, repo] = n.repository.nameWithOwner.toLowerCase().split('/'), ref = { owner, repo, num: n.number };
    return {
      ref: refKey(ref), repo: n.repository.nameWithOwner, num: n.number, title: n.title,
      author: n.author?.login || 'ghost', avatar: n.author?.avatarUrl || '', draft: n.isDraft, updated: n.updatedAt,
      add: n.additions, del: n.deletions, files: n.changedFiles, review: n.reviewDecision,
      tour: done.has(`${refKey(ref)}@${n.headRefOid}`), reading: !!readingOf(ref, n.headRefOid),
    };
  };
  return { review: review.map(row), mine: mine.map(row) };
}

// ---------- who is asking ----------

// Hosted: the session cookie's user, with a GitHub token refreshed when it's about to expire.
// Local: the `gh` CLI's account, created as a user on first use.
const refreshing = new Map();
async function freshToken(user) {
  const t = await db.tokensOf(user.id);
  if (!t?.access) throw Object.assign(new Error('Sign in with GitHub again.'), { status: 401 });
  if (!t.expires || new Date(t.expires) - Date.now() > 60_000) return t.access;
  if (!t.refresh) throw Object.assign(new Error('Your GitHub sign-in has expired. Sign in again.'), { status: 401 });
  // Refresh tokens are single-use, so concurrent requests share one refresh.
  if (!refreshing.has(user.id)) {
    refreshing.set(user.id, auth.refresh(t.refresh)
      .then(async (n) => { await db.setTokens(user.id, n); return n.access; })
      .catch(() => { throw Object.assign(new Error('Your GitHub sign-in has expired. Sign in again.'), { status: 401 }); })
      .finally(() => refreshing.delete(user.id)));
  }
  return refreshing.get(user.id);
}

// One shared promise, so concurrent first requests create the user and import old tours exactly once.
let localUser = null;
async function context(req) {
  if (MODE === 'local') {
    const token = await localToken();
    localUser ||= gh(token, 'user').then(db.upsertUser).then(async (u) => { await importCache(u).catch((e) => console.error(`readthrough: import failed: ${e.message}`)); return u; });
    localUser.catch(() => { localUser = null; });
    return { user: await localUser, token };
  }
  const user = await db.sessionUser(cookies(req).readthrough_sid);
  return user && { user, token: await freshToken(user) };
}

// Tours read before Postgres lived as JSON files in .cache/. Import them once for the local user, then set the folder aside.
async function importCache(user) {
  const dir = path.join(__dirname, '.cache');
  if (!fs.existsSync(dir)) return;
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('v2__') && x.endsWith('.json'))) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), p = f.slice(0, -5).split('__');
      const ref = { owner: p[2].toLowerCase(), repo: p.slice(3, -2).join('__').toLowerCase(), num: +p.at(-2) };
      if (!s.meta?.sha) continue;
      await db.putTour(ref, s.meta.sha, p[1], s, user.id);
      await db.markOpened(user.id, ref);
      n++;
    } catch (e) { console.error(`readthrough: skipped ${f}: ${e.message}`); }
  }
  fs.renameSync(dir, `${dir}.imported`);
  console.log(`readthrough: imported ${n} tours from .cache/ (kept in .cache.imported/)`);
}

// ---------- http ----------

const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css', '/demo.json': 'demo.json' };
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8' };

// The one inline script (the theme, set before paint) is allowed by its hash; nothing else inline runs.
const INLINE = /<script>([\s\S]*?)<\/script>/.exec(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'))?.[1] || '';
const CSP = [
  "default-src 'self'", `script-src 'self' 'sha256-${crypto.createHash('sha256').update(INLINE).digest('base64')}'`,
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data: https://avatars.githubusercontent.com", "connect-src 'self'",
  "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
].join('; ');
const BASE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY', ...(SECURE && { 'strict-transport-security': 'max-age=31536000' }) };

function send(res, code, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(code, { ...BASE_HEADERS, 'content-type': type, ...(type.startsWith('text/html') && { 'content-security-policy': CSP }), ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const redirect = (res, to, cookies = []) => { res.writeHead(302, { ...BASE_HEADERS, location: to, 'set-cookie': cookies }); res.end(); };

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
  }));
}
const cookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${SECURE ? '; Secure' : ''}; Max-Age=${maxAge}`;

function body(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 10_000) { reject(new Error('Request too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { reject(new Error('Expected JSON')); } });
  });
}

const page = (title, text) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<link rel="stylesheet" href="/styles.css"><div class="empty-state"><h1>${title}</h1><p>${text}</p><p><a href="/">Back to Readthrough</a></p></div>`;
const escHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function signIn(req, res, u) {
  const c = cookies(req), state = u.searchParams.get('state') || '';
  const ok = c.readthrough_state && state.length === c.readthrough_state.length && crypto.timingSafeEqual(Buffer.from(state), Buffer.from(c.readthrough_state));
  if (!ok || !u.searchParams.get('code')) return send(res, 400, page('Sign-in failed', 'The sign-in link expired or was opened in another browser. Try again.'), TYPES.html);
  try {
    const tokens = await auth.fromCode(u.searchParams.get('code'));
    const me = await gh(tokens.access, 'user');
    if (ALLOWED.length) {
      const { installations = [] } = await gh(tokens.access, 'user/installations');
      if (!installations.some((i) => ALLOWED.includes(i.account.login.toLowerCase()))) {
        return send(res, 403, page('Not on the list', `This Readthrough is for members of ${escHTML(ALLOWED.join(', '))}. Your GitHub account, ${escHTML(me.login)}, doesn't have access to any of them through Readthrough's GitHub App.`), TYPES.html);
      }
    }
    const user = await db.upsertUser(me, tokens);
    const sid = await db.createSession(user.id);
    return redirect(res, '/#/', [cookie('readthrough_sid', sid, 30 * 86400), cookie('readthrough_state', '', 0)]);
  } catch (e) {
    return send(res, 502, page('Sign-in failed', escHTML(e.message)), TYPES.html);
  }
}

// ---------- waitlist ----------

// READTHROUGH_WAITLIST=1 puts a waitlist form on the landing page in place of sign-in. Anyone may join; nothing else
// about the API opens up. Read the list with: select email, note, created_at from waitlist order by created_at;
const WAITLIST = /^(1|true|yes)$/i.test(process.env.READTHROUGH_WAITLIST || '');
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>".]+(\.[^\s@<>".]+)+$/;
// ponytail: per-process memory, keyed by the address the platform's proxy saw (the last X-Forwarded-For entry);
// fine for one instance, move it into Postgres if you run several.
const tries = new Map();
function limited(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || '?';
  const now = Date.now(), recent = (tries.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  recent.push(now);
  tries.set(ip, recent);
  if (tries.size > 10_000) tries.clear();
  return recent.length > 5;
}

// Trust boundary: the one write anyone can make without signing in.
async function joinWaitlist(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, { error: 'Expected JSON' });
  if (limited(req)) return send(res, 429, { error: 'Too many tries from here. Wait a few minutes.' });
  let b;
  try { b = await body(req); } catch (e) { return send(res, 400, { error: e.message }); }
  const email = String(b.email || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) return send(res, 400, { error: "That doesn't look like an email address." });
  await db.joinWaitlist(email, String(b.note || '').trim().slice(0, 300));
  return send(res, 200, { ok: true }); // the same answer for new and existing addresses, so the list can't be probed
}

async function handle(req, res) {
  const u = new URL(req.url, PUBLIC_URL);
  // Only this page may call the API: another site could otherwise start reads or change your settings.
  const site = req.headers['sec-fetch-site'];
  if ((u.pathname.startsWith('/api/') || req.method !== 'GET') && site && !['same-origin', 'none'].includes(site)) return send(res, 403, { error: 'Cross-site request refused' });

  // The display typeface, self-hosted (SIL OFL, see fonts/OFL.txt) so pages make no outside font requests.
  const FONTS = { '/fonts/schibsted-600.woff2': 1, '/fonts/schibsted-700.woff2': 1 };
  if (req.method === 'GET' && FONTS[u.pathname]) {
    return send(res, 200, fs.readFileSync(path.join(__dirname, u.pathname)), 'font/woff2', { 'cache-control': 'public, max-age=31536000, immutable' });
  }
  if (req.method === 'GET' && STATIC[u.pathname]) {
    const f = STATIC[u.pathname];
    return send(res, 200, fs.readFileSync(path.join(__dirname, f), 'utf8'), TYPES[f.split('.').pop()]);
  }
  if (u.pathname === '/auth/login' && req.method === 'GET') {
    if (MODE === 'local') return redirect(res, '/');
    const state = crypto.randomBytes(24).toString('base64url');
    return redirect(res, auth.authorizeURL(state), [cookie('readthrough_state', state, 600)]);
  }
  if (u.pathname === '/auth/callback' && req.method === 'GET' && MODE === 'hosted') return signIn(req, res, u);
  if (u.pathname === '/auth/logout' && req.method === 'POST') {
    await db.deleteSession(cookies(req).readthrough_sid);
    return send(res, 200, { ok: true }, undefined, { 'set-cookie': cookie('readthrough_sid', '', 0) });
  }

  if (!u.pathname.startsWith('/api/')) return send(res, 404, page('Not found', 'There is nothing at this address.'), TYPES.html);
  if (u.pathname === '/api/waitlist') return joinWaitlist(req, res);
  let ctx;
  try { ctx = await context(req); } catch (e) { if (e.status !== 401) throw e; }
  if (u.pathname === '/api/me') {
    if (!ctx) return send(res, 200, { mode: MODE, user: null, waitlist: WAITLIST });
    let installs = null;
    if (MODE === 'hosted') installs = (await gh(ctx.token, 'user/installations').catch(() => ({ total_count: null }))).total_count;
    return send(res, 200, { mode: MODE, user: ctx.user, installs, installURL: APP_SLUG ? `https://github.com/apps/${APP_SLUG}/installations/new` : null, waitlist: WAITLIST });
  }
  if (!ctx) return send(res, 401, { error: 'Sign in with GitHub first.' });

  if (u.pathname === '/api/settings') {
    if (req.method === 'GET') return send(res, 200, await publicSettings(ctx.user));
    if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST' });
    if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, { error: 'Expected JSON' });
    try { return send(res, 200, await saveSettings(ctx.user, await body(req))); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
  if (u.pathname === '/api/inbox') return send(res, 200, await inbox(ctx));
  if (u.pathname === '/api/recent') return send(res, 200, await recent(ctx, u.searchParams));
  // A read as a Server-Sent Events stream: it starts the read (or joins one already running), reports each step, sends
  // a comment every 15 seconds so proxies keep the connection open, and ends with the tour. The read itself runs on the
  // server regardless, so a dropped stream loses nothing: the browser reconnects and joins the same read.
  if (u.pathname === '/api/story/stream') {
    const ref = parseRef(u.searchParams.get('pr'));
    if (!ref) return send(res, 400, { error: 'Expected a PR like github.com/owner/repo/pull/123' });
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const ev = (name, data) => { if (!res.writableEnded) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); };
    const beat = setInterval(() => { if (!res.writableEnded) res.write(': still reading\n\n'); }, 15_000);
    req.on('close', () => clearInterval(beat));
    res.write('retry: 3000\n\n');
    ev('progress', 'Fetching the pull request');
    try {
      const { anchors, ...s } = await story(ctx, ref, u.searchParams.has('fresh'), (t) => ev('progress', t)); // anchors stay on the server
      ev('done', s);
    } catch (e) {
      ev('failed', { error: e.message });
    } finally {
      clearInterval(beat);
      res.end();
    }
    return;
  }
  if (u.pathname === '/api/pr' || u.pathname === '/api/story') {
    const ref = parseRef(u.searchParams.get('pr'));
    if (!ref) return send(res, 400, { error: 'Expected a PR like github.com/owner/repo/pull/123' });
    if (u.pathname === '/api/story') { const { anchors, ...s } = await story(ctx, ref, u.searchParams.has('fresh')); return send(res, 200, s); } // anchors stay on the server
    const pr = await loadPR(ctx, ref);
    pr.reading = readingOf(ref, pr.sha)?.since || null; // so a page that comes back mid-read shows the real elapsed time
    pr.toured = (await db.toured([pr.sha])).has(`${ref.owner}/${ref.repo}/${ref.num}@${pr.sha}`); // so the page can say it is opening a saved tour, not reading
    return send(res, 200, pr);
  }
  send(res, 404, { error: 'not found' });
}

db.init({ url: process.env.DATABASE_URL, file: SQLITE, secret: secret() }).then((store) => {
  const where = store === 'pg' ? 'Postgres' : `SQLite at ${SQLITE}`;
  http.createServer((req, res) => handle(req, res).catch((e) => {
    if (!res.headersSent) send(res, e.status === 401 || e.status === 404 ? e.status : 502, { error: e.message });
    else res.end();
  })).listen(PORT, HOST, () => {
    console.log(`readthrough (${MODE} mode, ${where}) on ${PUBLIC_URL}`);
    if (store === 'sqlite' && MODE === 'hosted') console.log('readthrough: SQLite suits one server; keep the file on a persistent volume, or set DATABASE_URL for Postgres.');
  });
  setInterval(() => db.pruneSessions().catch(() => {}), 6 * 3600_000).unref();
}, (e) => fail(process.env.DATABASE_URL
  ? `couldn't reach Postgres at DATABASE_URL (${e.message}). Fix the URL or start the database; Readthrough won't switch to SQLite on its own, since that would split your data. Unset DATABASE_URL to use SQLite on purpose.`
  : `couldn't open SQLite at ${SQLITE}: ${e.message}`));

// ---------- self-checks ----------

console.assert(parseRef('https://github.com/A/b/pull/12').owner === 'a' && parseRef('a/b/pull/12').num === 12, 'url ref');
console.assert(parseRef('a/b#3').repo === 'b' && parseRef('a/b/3').num === 3, 'short ref');
console.assert(!parseRef('a/b') && !parseRef('; rm -rf /'), 'bad ref');
{
  const h = hunks('@@ -1,2 +1,3 @@ fn\n a\n-b\n+c\n+d\n\\ No newline at end of file', 0)[0];
  console.assert(h.id === 'f0h0' && h.add === 2 && h.del === 1 && h.lines[3][2] === 3 && h.at === 'fn', 'hunks');
}
console.assert(GENERATED.test('web/package-lock.json') && !GENERATED.test('src/lock.js'), 'generated');
console.assert(TEST.test('src/foo.test.ts') && TEST.test('tests/a.py') && !TEST.test('src/contest.js'), 'tests');
{
  // carry: an anchor follows its lines into a moved hunk, a stop whose code is gone is dropped, the rest is left for the update
  const pr = { files: [{ path: 'a.js', hunks: [{ id: 'f0h0', lines: [['+', 0, 1, 'new()']] }, { id: 'f0h1', lines: [[' ', 1, 2, 'x'], ['+', 0, 3, 'y']] }] }] };
  const old = {
    anchors: { f0h0: ['a.js', ' x\n+y'], f0h1: ['b.js', '+gone'] },
    stops: [{ hunks: ['f0h0'], points: [{ hunk: 'f0h0', from: 2, to: 2 }] }, { hunks: ['f0h1'], points: [] }],
    flow: { nodes: [{ stop: 1 }, { stop: 0 }] }, scenarios: [], review: { findings: [{ hunk: 'f0h1', from: 1, to: 1 }] },
  };
  const { tour, open, uncovered } = carry(old, pr);
  console.assert(tour.stops.length === 1 && tour.stops[0].hunks[0] === 'f0h1' && tour.stops[0].points[0].from === 2, 'carry re-pins');
  console.assert(tour.flow.nodes[0].stop === -1 && tour.flow.nodes[1].stop === 0 && open.length === 1, 'carry drops');
  console.assert(uncovered.length === 1 && uncovered[0].hunks.map((h) => h.id).join() === 'f0h0', 'carry uncovered');
}
{
  // review comments: replies join their thread; a comment on a removed line pins by its old number; a moved-away line is outdated
  const files = [{ path: 'a.js', hunks: [{ id: 'f0h0', lines: [[' ', 4, 4, 'x'], ['-', 5, null, 'old'], ['+', null, 5, 'new']] }] }];
  const c = (id, extra) => ({ id, created_at: `2026-01-0${id}T00:00:00Z`, user: { login: 'u' }, body: 'b', path: 'a.js', side: 'RIGHT', ...extra });
  const t = threadsOf([c(1, { line: 5 }), c(2, { in_reply_to_id: 1 }), c(3, { line: 5, side: 'LEFT' }), c(4, { line: null })], files);
  console.assert(t.length === 3 && t[0].row === 2 && t[0].items.length === 2, 'threads: reply joins, new line pins');
  console.assert(t[1].row === 1 && t[1].side === 'LEFT' && t[2].hunk === '', 'threads: old line pins, outdated stays');
}
console.assert(EMAIL.test('a.b+c@example.co.uk') && !EMAIL.test('a@b') && !EMAIL.test('a b@c.com') && !EMAIL.test('<x>@y.com') && !EMAIL.test('a@b..com'), 'waitlist email check');
