// Runs every storage function against SQLite (a temp file), and against Postgres too when DATABASE_URL is set.
// Use a scratch database for Postgres: this writes test rows. `npm run check`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function check(label, opts) {
  delete require.cache[require.resolve('./db')];
  const db = require('./db');
  const store = await db.init({ ...opts, secret: 'x'.repeat(40) });
  const gid = 900000000 + Math.floor(Math.random() * 1e6); // unique per run, so reruns against Postgres don't collide

  const u = await db.upsertUser({ id: gid, login: 'octo', name: 'Octo', avatar_url: 'https://a/x.png' },
    { access: 'ghu_A', refresh: 'ghr_A', expires: new Date(Date.now() + 3600e3) });
  assert.equal(u.login, 'octo');
  const again = await db.upsertUser({ id: gid, login: 'octo2' }); // no tokens: the stored ones are kept
  assert.equal(again.id, u.id);
  assert.equal(again.login, 'octo2');
  let t = await db.tokensOf(u.id);
  assert.equal(t.access, 'ghu_A');
  assert.ok(t.expires instanceof Date && t.expires > new Date());
  await db.setTokens(u.id, { access: 'ghu_B', refresh: 'ghr_B', expires: null });
  t = await db.tokensOf(u.id);
  assert.equal(t.access, 'ghu_B');
  assert.equal(t.expires, null);

  const sid = await db.createSession(u.id);
  assert.equal((await db.sessionUser(sid)).id, u.id);
  assert.equal(await db.sessionUser('nope'), null);
  await db.deleteSession(sid);
  assert.equal(await db.sessionUser(sid), null);
  await db.pruneSessions();

  await db.setAI(u.id, { provider: 'anthropic', model: 'claude-sonnet-5-5', key: 'sk-ant-1' });
  await db.setAI(u.id, { provider: 'openai', model: 'gpt-x', baseURL: 'https://api.example.com/v1', key: 'sk-oa-1' });
  let ai = await db.getAI(u.id);
  assert.deepEqual(ai.keys, { anthropic: 'sk-ant-1', openai: 'sk-oa-1' });
  assert.equal(ai.provider, 'openai');
  await db.setAI(u.id, { provider: 'openai', model: 'gpt-x', clearKey: true });
  ai = await db.getAI(u.id);
  assert.deepEqual(ai.keys, { anthropic: 'sk-ant-1' });

  const ref = { owner: 'o', repo: `r${gid}`, num: 7 };
  await db.putTour(ref, 'sha1', 'claude-sonnet', { gist: 'one', stops: [], meta: { at: '2026-01-01T00:00:00.000Z' } }, u.id);
  await new Promise((r) => setTimeout(r, 5));
  await db.putTour(ref, 'sha2', 'claude-opus', { gist: 'two', stops: [1], meta: { at: '2026-01-02T00:00:00.000Z' } }, u.id);
  assert.equal((await db.getTour(ref, 'sha2', 'claude-opus')).gist, 'two');
  assert.equal((await db.getTour(ref, 'sha2', 'someone-else')).gist, 'two'); // falls back to any reader of that commit
  assert.equal(await db.getTour(ref, 'sha3', 'claude-opus'), null);
  assert.deepEqual(await db.previousTour(ref, 'sha2'), { sha: 'sha1', at: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual([...(await db.toured(['sha1', 'zzz']))], [`o/r${gid}/7@sha1`]);
  assert.equal((await db.toured([])).size, 0);

  await db.markOpened(u.id, ref);
  await db.markOpened(u.id, ref); // twice is fine
  const recent = await db.recentTours(u.id, 'claude-sonnet');
  assert.equal(recent.length, 1);
  assert.equal(recent[0].data.gist, 'one'); // this reader's tour wins over the newer one by another reader

  assert.equal(db.unseal('not-a-sealed-value'), null);
  await db.end();
  console.log(`ok  ${label} (${store})`);
}

(async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'odyssey-check-')), 'check.db');
  await check('sqlite', { file });
  if (process.env.DATABASE_URL) await check('postgres', { url: process.env.DATABASE_URL });
  else console.log('skip postgres (set DATABASE_URL to a scratch database to include it)');
})().catch((e) => { console.error(e); process.exit(1); });
