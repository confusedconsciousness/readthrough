// Storage: users and their sessions, per-user AI settings, tours, and which PRs each user has opened.
// Postgres when DATABASE_URL is set; otherwise SQLite in a single file (node:sqlite, built into Node).
// The queries are written once for both: times are ISO-8601 text made in JS, JSON is stored as text,
// and nothing Postgres-only (DISTINCT ON, = ANY, make_interval) is used.
// Secrets (GitHub tokens, AI keys) are sealed with AES-256-GCM under ODYSSEY_SECRET before they reach a row.
const crypto = require('node:crypto');

let kind, pool, lite, KEY;

// Postgres placeholders ($1) become SQLite numbered ones (?1); rows come back as plain objects either way.
async function q(sql, args = []) {
  if (kind === 'pg') return (await pool.query(sql, args)).rows;
  return lite.prepare(sql.replace(/\$(\d+)/g, '?$1')).all(...args.map((v) => (v === undefined ? null : v)));
}

const PG_SCHEMA = `
create table if not exists users (
  id bigserial primary key,
  github_id bigint unique not null,
  login text not null,
  name text,
  avatar text,
  gh_access text,
  gh_refresh text,
  gh_expires timestamptz,
  created_at timestamptz not null default now(),
  seen_at timestamptz not null default now()
);
create table if not exists sessions (
  id text primary key,
  user_id bigint not null references users on delete cascade,
  expires_at timestamptz not null
);
create index if not exists sessions_user on sessions (user_id);
create table if not exists ai_settings (
  user_id bigint primary key references users on delete cascade,
  provider text not null,
  model text not null default '',
  base_url text,
  keys jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
create table if not exists tours (
  owner text not null,
  repo text not null,
  num int not null,
  sha text not null,
  reader text not null,
  data jsonb not null,
  created_by bigint references users on delete set null,
  created_at timestamptz not null default now(),
  primary key (owner, repo, num, sha, reader)
);
create index if not exists tours_pr on tours (owner, repo, num, created_at desc);
create table if not exists opened (
  user_id bigint not null references users on delete cascade,
  owner text not null,
  repo text not null,
  num int not null,
  at timestamptz not null default now(),
  primary key (user_id, owner, repo, num)
);`;

const LITE_SCHEMA = `
create table if not exists users (
  id integer primary key autoincrement,
  github_id integer unique not null,
  login text not null,
  name text,
  avatar text,
  gh_access text,
  gh_refresh text,
  gh_expires text,
  created_at text not null,
  seen_at text not null
);
create table if not exists sessions (
  id text primary key,
  user_id integer not null references users (id) on delete cascade,
  expires_at text not null
);
create index if not exists sessions_user on sessions (user_id);
create table if not exists ai_settings (
  user_id integer primary key references users (id) on delete cascade,
  provider text not null,
  model text not null default '',
  base_url text,
  keys text not null default '{}',
  updated_at text not null
);
create table if not exists tours (
  owner text not null,
  repo text not null,
  num integer not null,
  sha text not null,
  reader text not null,
  data text not null,
  created_by integer references users (id) on delete set null,
  created_at text not null,
  primary key (owner, repo, num, sha, reader)
);
create index if not exists tours_pr on tours (owner, repo, num, created_at desc);
create table if not exists opened (
  user_id integer not null references users (id) on delete cascade,
  owner text not null,
  repo text not null,
  num integer not null,
  at text not null,
  primary key (user_id, owner, repo, num)
);`;

// Returns which store is in use. A DATABASE_URL that can't be reached is an error, never a quiet switch to SQLite:
// that would split a team's data between two databases.
async function init({ url, file, secret }) {
  KEY = crypto.createHash('sha256').update(secret).digest();
  if (url) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: url, max: 10 });
    await pool.query(PG_SCHEMA);
    kind = 'pg';
  } else {
    const { DatabaseSync } = require('node:sqlite');
    lite = new DatabaseSync(file);
    lite.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;');
    lite.exec(LITE_SCHEMA);
    kind = 'sqlite';
  }
  return kind;
}

const now = () => new Date().toISOString();
const iso = (d) => (d ? new Date(d).toISOString() : null);
const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// ---------- sealing ----------

function seal(s) {
  if (!s) return null;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
// A value sealed under an old ODYSSEY_SECRET reads as missing: people sign in again and re-enter keys, nothing crashes.
function unseal(b) {
  if (!b) return null;
  try {
    const buf = Buffer.from(b, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; }
}

// ---------- users and sessions ----------

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const userOf = (r) => (r ? { id: +r.id, githubId: +r.github_id, login: r.login, name: r.name, avatar: r.avatar } : null);

async function upsertUser(u, tokens = {}) {
  const [r] = await q(`insert into users (github_id, login, name, avatar, gh_access, gh_refresh, gh_expires, created_at, seen_at)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $8)
    on conflict (github_id) do update set login = $2, name = $3, avatar = $4,
      gh_access = coalesce($5, users.gh_access), gh_refresh = coalesce($6, users.gh_refresh), gh_expires = coalesce($7, users.gh_expires), seen_at = $8
    returning *`, [u.id, u.login, u.name || null, u.avatar_url || null, seal(tokens.access), seal(tokens.refresh), iso(tokens.expires), now()]);
  return userOf(r);
}

async function tokensOf(userId) {
  const [r] = await q('select gh_access, gh_refresh, gh_expires from users where id = $1', [userId]);
  return r && { access: unseal(r.gh_access), refresh: unseal(r.gh_refresh), expires: r.gh_expires ? new Date(r.gh_expires) : null };
}
const setTokens = (userId, t) => q('update users set gh_access = $2, gh_refresh = $3, gh_expires = $4 where id = $1', [userId, seal(t.access), seal(t.refresh), iso(t.expires)]);

// The cookie holds a random value; the table holds only its hash, so a leaked table can't be replayed.
async function createSession(userId, days = 30) {
  const raw = crypto.randomBytes(32).toString('base64url');
  await q('insert into sessions (id, user_id, expires_at) values ($1, $2, $3)', [hash(raw), userId, iso(Date.now() + days * 86400_000)]);
  return raw;
}
async function sessionUser(raw) {
  if (!raw) return null;
  const [r] = await q('select u.* from sessions s join users u on u.id = s.user_id where s.id = $1 and s.expires_at > $2', [hash(raw), now()]);
  return userOf(r);
}
const deleteSession = (raw) => raw && q('delete from sessions where id = $1', [hash(raw)]);
const pruneSessions = () => q('delete from sessions where expires_at < $1', [now()]);

// ---------- AI settings ----------

async function getAI(userId) {
  const [r] = await q('select * from ai_settings where user_id = $1', [userId]);
  if (!r) return null;
  const keys = Object.fromEntries(Object.entries(json(r.keys) || {}).map(([p, v]) => [p, unseal(v)]));
  return { provider: r.provider, model: r.model, baseURL: r.base_url, keys };
}
async function setAI(userId, { provider, model, baseURL, key, clearKey }) {
  const cur = (await getAI(userId)) || { keys: {} };
  const keys = { ...cur.keys };
  if (key) keys[provider] = key;
  if (clearKey) delete keys[provider];
  const sealed = Object.fromEntries(Object.entries(keys).filter(([, v]) => v).map(([p, v]) => [p, seal(v)]));
  await q(`insert into ai_settings (user_id, provider, model, base_url, keys, updated_at) values ($1, $2, $3, $4, $5, $6)
    on conflict (user_id) do update set provider = $2, model = $3, base_url = $4, keys = $5, updated_at = $6`,
  [userId, provider, model || '', baseURL || null, JSON.stringify(sealed), now()]);
}

// ---------- tours ----------

const keyOf = (ref) => [ref.owner, ref.repo, ref.num];

// The tour for this commit by this reader, else the newest by any reader: a model switch shouldn't discard a tour.
async function getTour(ref, sha, reader) {
  const [r] = await q(`select data from tours where owner = $1 and repo = $2 and num = $3 and sha = $4
    order by (reader = $5) desc, created_at desc limit 1`, [...keyOf(ref), sha, reader]);
  return r ? json(r.data) : null;
}
const putTour = (ref, sha, reader, data, userId) => q(`insert into tours (owner, repo, num, sha, reader, data, created_by, created_at)
  values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (owner, repo, num, sha, reader) do update set data = $6, created_at = $8, created_by = $7`,
[...keyOf(ref), sha, reader, JSON.stringify(data), userId, now()]);

// The newest tour of an older commit of this PR: the baseline for "since the last tour".
async function previousTour(ref, sha) {
  const [r] = await q(`select sha, data from tours where owner = $1 and repo = $2 and num = $3 and sha <> $4
    order by created_at desc limit 1`, [...keyOf(ref), sha]);
  if (!r) return null;
  const data = json(r.data);
  return { sha: r.sha, at: data.meta?.at || null, data };
}

// Which of these head commits already have a tour, as "owner/repo/num@sha" strings.
async function toured(shas) {
  if (!shas.length) return new Set();
  const rows = await q(`select distinct owner, repo, num, sha from tours where sha in (${shas.map((_, i) => `$${i + 1}`).join(', ')})`, shas);
  return new Set(rows.map((r) => `${r.owner}/${r.repo}/${r.num}@${r.sha}`));
}

const markOpened = (userId, ref) => q(`insert into opened (user_id, owner, repo, num, at) values ($1, $2, $3, $4, $5)
  on conflict (user_id, owner, repo, num) do update set at = $5`, [userId, ...keyOf(ref), now()]);

// The user's recently opened PRs, each with the tour opening it would show (their reader's first, else the newest).
async function recentTours(userId, reader, limit = 12) {
  const rows = await q(`select owner, repo, num, at, data from (
      select o.owner, o.repo, o.num, o.at, t.data,
        row_number() over (partition by o.owner, o.repo, o.num order by (t.reader = $2) desc, t.created_at desc) as rn
      from opened o join tours t on t.owner = o.owner and t.repo = o.repo and t.num = o.num
      where o.user_id = $1
    ) x where rn = 1 order by at desc limit $3`, [userId, reader, limit]);
  return rows.map((r) => ({ ...r, data: json(r.data) }));
}

module.exports = {
  init, seal, unseal, upsertUser, tokensOf, setTokens, createSession, sessionUser, deleteSession, pruneSessions,
  getAI, setAI, getTour, putTour, previousTour, toured, markOpened, recentTours,
  end: () => (kind === 'pg' ? pool?.end() : lite?.close()),
};
