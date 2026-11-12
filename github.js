// GitHub: the REST/GraphQL client every request uses, with the signed-in user's own token, and the GitHub App login.
// GitHub is the access control: a user only ever sees PRs their token can read.
const { execFile } = require('node:child_process');

const API = 'https://api.github.com';

function ghError(status, body) {
  const e = new Error(
    status === 401 ? 'Your GitHub sign-in has expired. Sign in again.'
      : status === 404 ? "GitHub can't find that, or you can't see it. On a hosted Readthrough, the GitHub App must also be installed on that repository."
      : status === 403 && /rate limit/i.test(body?.message || '') ? 'GitHub rate limit reached. Try again in a few minutes.'
      : `GitHub answered ${status}: ${body?.message || 'no details'}`,
  );
  e.status = status === 401 ? 401 : status === 404 ? 404 : 502;
  return e;
}

// One call, or every page of a list when `all` is set (follows the Link header).
async function gh(token, p, { all, method = 'GET', body } = {}) {
  let url = p.startsWith('https://') ? p : `${API}/${p}`;
  const out = [];
  for (;;) {
    const r = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        'user-agent': 'readthrough', ...(body && { 'content-type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw ghError(r.status, j);
    if (!all) return j;
    out.push(...j);
    const next = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') || '')?.[1];
    if (!next || !next.startsWith(API)) return out;
    url = next;
  }
}

async function graphql(token, query, variables) {
  const j = await gh(token, 'graphql', { method: 'POST', body: { query, variables } });
  if (j.errors?.length) throw new Error(`GitHub: ${j.errors[0].message}`);
  return j.data;
}

// ---------- GitHub App user login (hosted mode) ----------

// GitHub App user tokens last 8 hours and come with a 6-month refresh token; both are rotated on refresh.
function oauth({ clientId, clientSecret, publicURL }) {
  const authorizeURL = (state) => 'https://github.com/login/oauth/authorize?' + new URLSearchParams({ client_id: clientId, redirect_uri: `${publicURL}/auth/callback`, state });
  async function exchange(params) {
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'readthrough' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, ...params }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error || !j.access_token) throw new Error(j.error_description || j.error || `GitHub answered ${r.status}`);
    return { access: j.access_token, refresh: j.refresh_token || null, expires: j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : null };
  }
  return {
    authorizeURL,
    fromCode: (code) => exchange({ code, redirect_uri: `${publicURL}/auth/callback` }),
    refresh: (refresh) => exchange({ grant_type: 'refresh_token', refresh_token: refresh }),
  };
}

// ---------- local mode: the `gh` CLI's login on this machine ----------

let local = { token: null, at: 0 };
function localToken() {
  if (local.token && Date.now() - local.at < 5 * 60_000) return Promise.resolve(local.token);
  return new Promise((resolve, reject) => execFile('gh', ['auth', 'token'], { timeout: 10_000 }, (err, out) => {
    if (err || !out.trim()) return reject(Object.assign(new Error('Local mode reads GitHub through the `gh` CLI. Run `gh auth login`, then reload.'), { status: 401 }));
    local = { token: out.trim(), at: Date.now() };
    resolve(local.token);
  }));
}

module.exports = { gh, graphql, oauth, localToken };
