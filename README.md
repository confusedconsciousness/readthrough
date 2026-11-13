# Readthrough

A guided review of a GitHub pull request: what it changes, why each part exists, how it runs, and what to check before merging. Every explanation sits next to the code it describes, so a reviewer can verify it instead of trusting it.

## What a tour shows

Open a PR and Readthrough shows it in three panes: the list of stops, the explanation of the current stop, and that stop's diff with GitHub-style syntax colours. **Unified** or **Split** (above the code) puts the old lines beside the new ones, each removed line facing its replacement (new code sits on the right with the left side empty); narrow windows always get unified. The choice is remembered.

- **Overview:** the gist, the **goal** the PR exists to achieve, why it was made, the before → after of its behaviour, and every file with the stops that explain it.
- **How it works:** the parts the PR touches (functions, routes, tables) as a map, in git colours (added, modified, deleted). Below it, 1–3 runtime walkthroughs, like "a member turns on notifications", told hop by hop: who calls whom, what data moves, and what happens if a condition holds. **Play** (or space) lights up each hop on the map with a moving dot carrying the data; ← and → step; **Sequence** shows the same walkthrough as a sequence diagram. Each hop shows the code that does it.
- **Stops:** the diff in the order the code runs. Each stop has one plain sentence, then **Why it's here**: what it contributes to the goal and what would break without it, with a verdict: **Needed**, **Supporting**, **Questionable** or **Not part of the goal**. Then 2–5 steps, each with what happens and *why*, pinned to the exact lines (the same number marks them in the code gutter). Each stop ends with one thing to **verify** yourself.
- **Since last tour:** when a toured PR gets new commits, opening it lands on just those commits and their diff, shown straight away from GitHub, then explained once the read finishes. A rebased or force-pushed branch has no clean diff of the new work, and the view says so.
- **Does it do what was asked?** Each requirement from the linked GitHub issues (or the description, when no issue is linked) is marked met, partly met, missing or unclear, with the code that shows it. Jira links aren't followed yet.
- **Unexplained:** any hunk no stop covers. Readthrough computes this itself, without AI, so nothing in the diff is skipped quietly.
- **Review:** Readthrough also reviews the PR like a sceptical senior engineer. It gives a recommendation (approve, approve with nits, request changes, or discuss first) with an opening paragraph you could post, and a scorecard of seven dimensions, each graded Good, Fair, Poor or Unclear with a one-line reason: **necessity, correctness, bugs, error handling, duplication, cognitive load, tests**. Below it are numbered findings, each with a severity (blocker, major, minor, nit), what goes wrong, a suggested fix, and the exact lines in the code gutter. A blocker always means "request changes". **Possibly unnecessary** lists the parts of the PR its goal doesn't need, and questions for the author close the review. Grades come from the diff, description and linked issues, not the whole repository, so treat them as a second reviewer's notes.
- **From the file list:** facts from file names alone: no test changes, dependency, migration, CI or config changes, deleted files, generated files skipped.

The home page shows reads in progress, your tours (each with its map, gist and how many stops you've marked understood), and your open PRs and review requests with size, review state, a 1–5 effort score (from size, no AI) and whether a tour is ready.

**Appearance** (the ◐ button): System, Light or Dark, and 13 palettes: Graphite (the default), Tidewater, Harbor, Lagoon, Aegean, Fjord, Iris, Ember, Saffron, Moss and copper, Ink and rose, Paper and Monokai (which also brings Sublime's syntax colours). Each palette has a light and a dark form; diffs keep GitHub's green and red in all of them. The choice is kept in your browser and applied before the page paints.

The bare address (`http://localhost:4400`) is the landing page; your tours and PRs are at `#/`, and the logo takes you there. Keys: `j`/`k` move between stops, `x` marks the current stop understood, `/` opens another PR, ← → and space drive the walkthrough on the overview. Each stop has its own URL (`#/owner/repo/123/2`).

## Two ways to run it

| | **Hosted** (for a team) | **Local** (on your own machine) |
|---|---|---|
| Switched on by | `GITHUB_CLIENT_ID` set | `GITHUB_CLIENT_ID` empty |
| Sign-in | GitHub, through your GitHub App | none; uses the `gh` CLI's login |
| Who it serves | everyone in your orgs | you |
| AI | each person's own API key | API keys, or this machine's Claude Code / Codex login |
| Database | Postgres, or SQLite for a small team | SQLite (or Postgres) |

### AI providers

| Provider | Hosted | Local | Models |
|---|---|---|---|
| **Anthropic API** | ✓ | ✓ | Sonnet 5.5 (default), Opus 5.5, Haiku 5.5 |
| **OpenAI-compatible API** (OpenAI, OpenRouter, …) | ✓ | ✓ | any model id with JSON-schema output |
| **Claude Code** (your Claude plan) | – | ✓ | Sonnet 5.5, Opus 5.5, Haiku 5.5 |
| **Codex** (your ChatGPT plan) | – | ✓ | your Codex default, or any model id |

Subscription logins only work locally. Anthropic doesn't allow Claude Pro/Max logins in third-party hosted apps, so a hosted Readthrough uses API keys. OpenAI's "Sign in with ChatGPT" can spend a ChatGPT plan from a hosted app, but only for apps OpenAI has approved through its partner form; Readthrough doesn't use it yet.

API keys are never stored on the server. Each person's key stays in their browser (localStorage) and is sent over HTTPS, in the body of the request that starts a read, never in a URL. The server holds it in memory only while that read runs. Signing out clears it from the browser, and people enter it again on each new device.

## Run locally

```bash
npm install
```

```bash
npm start
```

Then open http://localhost:4400. You need Node 22.13+ and the [`gh`](https://cli.github.com) CLI, logged in. With no `DATABASE_URL`, everything is kept in `readthrough.db` next to the app. Tours from older versions (the `.cache/` folder) are imported on first start.

## Database

| | When | Notes |
|---|---|---|
| **SQLite** | `DATABASE_URL` unset | Built into Node, one file (`READTHROUGH_SQLITE`, default `./readthrough.db`). Right for local use and a small team on one server. Back it up by copying the file. |
| **Postgres** | `DATABASE_URL` set | For a team on managed infrastructure, or more than one server later. Tables are created on start. |

If `DATABASE_URL` is set but Postgres can't be reached, Readthrough stops with an error. It never falls back to SQLite on its own: during an outage that would quietly split sign-ins, settings and tours across two databases. Unset `DATABASE_URL` to choose SQLite deliberately.

`npm run check` runs every storage function against SQLite, and against Postgres too when `DATABASE_URL` points at a scratch database.

## Deploy (hosted)

**1. Create the GitHub App.** In your organization: Settings → Developer settings → GitHub Apps → New GitHub App.

- Homepage URL: your `PUBLIC_URL`. Callback URL: `PUBLIC_URL/auth/callback`.
- Keep **Expire user authorization tokens** on. Turn **Webhook → Active** off.
- Repository permissions, all **Read-only**: Contents, Pull requests, Issues (Metadata is added automatically). No organization or account permissions.
- Where can this app be installed: **Only on this account**.

Create it, then copy the **Client ID**, generate a **client secret**, and note the slug from the app's URL (`github.com/apps/<slug>`). Install the app on the organization and choose the repositories Readthrough may read.

**2. Choose the database.** For a team, a managed Postgres (RDS, Cloud SQL, Neon, Supabase) via `DATABASE_URL`. For a small team on one server, leave it unset: the container keeps SQLite at `/data/readthrough.db`, so mount a volume there (`-v readthrough-data:/data`) or it's lost when the container is replaced.

**3. Run the container** with the variables from `.env.example`:

```bash
docker build -t readthrough .
```

```bash
docker run -p 4400:4400 --env-file .env -v readthrough-data:/data readthrough
```

Put it behind HTTPS (your load balancer or reverse proxy) at `PUBLIC_URL`. Cookies are marked `Secure` and HSTS is sent when `PUBLIC_URL` starts with `https://`.

When `PUBLIC_URL` is on an `app.` subdomain (`https://app.readthrough.xyz`), point the bare domain at the same server too. It then shows only the landing page, its sign-in links go to the app, and `www.` redirects to it. The session cookie stays on the app host.

**Or deploy free on Render, with Neon for Postgres.** `render.yaml` describes the whole service:

1. On [Neon](https://neon.com), create a project and copy its connection string.
2. Create the GitHub App (step 1) with the callback `https://app.readthrough.xyz/auth/callback`.
3. On [Render](https://render.com): New → Blueprint, pick this repository. Render reads `render.yaml`, generates `READTHROUGH_SECRET`, and asks for `DATABASE_URL` and the three GitHub App values.
4. In the service's Custom Domains, Render shows the DNS records for `readthrough.xyz`, `www` and `app`; add them at your registrar. HTTPS is issued automatically.

Render's free plan sleeps after 15 minutes without traffic, and the next visit takes about a minute to wake it; a paid instance removes that. Reads are unaffected by proxy timeouts: the page follows a read over a Server-Sent Events stream with a heartbeat, and a dropped stream reconnects to the same read.

**Access:** people only see PRs their own GitHub account can read, in repositories where the app is installed. `READTHROUGH_ALLOWED_ORGS` restricts sign-in to members of the listed organizations. `READTHROUGH_ALLOWED_USERS` (comma-separated GitHub logins) lets only those people sign in, alongside any members of the allowed organizations. Taking a login off the list ends that person's sessions on their next request. `READTHROUGH_WAITLIST=1` puts a waitlist on the landing page: visitors leave an email (validated, rate-limited, stored once), and you read the list with `select email, created_at from waitlist order by created_at;`. With the waitlist on, sign-in is closed to everyone not on one of the two lists, even when both are empty, so invite people by adding their login.

## Security

- GitHub access is read-only and per person; GitHub decides what each person can see.
- Sessions are random 256-bit cookies (HttpOnly, SameSite=Lax); the database stores only their SHA-256.
- GitHub tokens are encrypted at rest (AES-256-GCM under `READTHROUGH_SECRET`); rotating it signs everyone out.
- AI keys aren't stored on the server at all: they stay in each person's browser and reach the server only with a read.
- The API refuses cross-site requests; pages are served with a strict Content-Security-Policy and `frame-ancestors 'none'`.
- The PR's diff, description, commits and linked issues are sent to the AI each person chooses, with their key.

## Files

| File | Role |
|---|---|
| `server.js` | HTTP server, sessions and sign-in routes, PR loading and diff parsing, syntax highlighting, tours. |
| `github.js` | GitHub REST/GraphQL client (per-user token), GitHub App login, local `gh` token. |
| `ai.js` | The prompt and schema, and the providers. |
| `db.js` | Storage on Postgres or SQLite (one set of queries for both); encryption of stored secrets. |
| `db.check.js` | `npm run check`: exercises every storage function on SQLite and, if configured, Postgres. |
| `app.js` | The front end: landing, home, the three PR panes, flow player, settings. |
| `styles.css`, `index.html` | Styles (light and dark) and the page shell. |
| `demo.json` | The landing page's live demo: a real tour of cli/cli #14815 (MIT licensed). |

## Limits

- The model sees the diff, description, commits and linked issues, not the rest of the repository; the map shows what can be inferred from those.
- Reads in progress are tracked in memory, so run one server process. ([`ponytail:` note in `server.js`](server.js))
- Your "understood" marks are kept in your browser.
- A tour stays on someone's home page after they lose access to its repository.
- Generated files are detected by file name.
