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
- **Depth:** Glance, Review or Deep (above the stop list) sets how much of the tour you see, from the top risks only to every step. Comments people left on the PR in GitHub show under the lines they're about.

## Run it on your own machine

This is the quickest way in and needs no accounts beyond GitHub and an AI. Readthrough reads GitHub through your `gh` login and writes tours with Claude Code, Codex or an API key. Everything stays in one SQLite file next to the app.

> Using a coding agent? Point it at [AGENTS.md](AGENTS.md). Its "Bring it up" section walks it through every step below and says which ones need you.

### 1. What you need

| | Why | Check |
|---|---|---|
| **Node 22.13 or newer** | runs the server; SQLite is built into Node from 22.13 | `node --version` |
| **git** | to get the code | `git --version` |
| **GitHub CLI (`gh`), signed in** | Readthrough reads PRs with your `gh` login (the active account, if you have several) | `gh auth status` |
| **One AI**, any of these: | writes the tours | |
| &nbsp;&nbsp;Claude Code, signed in | uses your Claude plan | `claude --version`, then `claude auth status` |
| &nbsp;&nbsp;Codex, signed in | uses your ChatGPT plan | `codex --version`, then `codex login status` |
| &nbsp;&nbsp;an Anthropic or OpenAI-compatible API key | billed to that account | you paste it in Settings later |

On macOS with Homebrew: `brew install node gh`. Elsewhere: [nodejs.org](https://nodejs.org) and [cli.github.com](https://cli.github.com). Claude Code: see [its install guide](https://docs.claude.com/en/docs/claude-code/setup).

### 2. Get the code and install

```bash
git clone https://github.com/confusedconsciousness/readthrough.git
```

```bash
cd readthrough && npm ci
```

The app uses three packages: the Anthropic SDK, `pg` (Postgres) and `highlight.js`. There is no build step.

### 3. Sign in to GitHub and your AI

```bash
gh auth login
```

```bash
claude auth login
```

Skip the second one if you'll use Codex (`codex login`) or an API key.

### 4. Start it

```bash
npm start
```

You should see `readthrough (local mode, SQLite at …/readthrough.db) on http://localhost:4400` (after a harmless `.env not found` line if you haven't made one). Open http://localhost:4400 and paste a pull request link, like `https://github.com/cli/cli/pull/14815`.

The first read of a PR takes one to five minutes, depending on its size and the model; the page shows each step as it goes. After that the tour is saved, and opening it again is instant. When the PR gets new commits, Readthrough reads only the new ones.

### 5. Choose the AI (optional)

The gear button opens **Settings**. Locally the default is Claude Code with Sonnet 5.5.

| Provider | Needs | Notes |
|---|---|---|
| Claude Code | `claude` signed in | Sonnet 5.5 (default, fast), Opus 5.5 (most thorough), Haiku 5.5 (quickest) |
| Codex | `codex` signed in | your Codex default model, or name one |
| Anthropic API | an API key | same three models |
| OpenAI-compatible API | a base URL, a model id and a key | OpenAI, OpenRouter, or anything that supports JSON-schema output |

A provider whose CLI isn't installed is greyed out. API keys stay in your browser and go to the server only with each read; locally you can also put `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `.env`.

### If something goes wrong

| You see | Do this |
|---|---|
| "Local mode reads GitHub through the `gh` CLI" | `gh auth login`, then reload |
| PRs from the wrong GitHub account | Readthrough uses `gh`'s active account: `gh auth switch --user <login>`, then restart |
| "Claude Code is not signed in on this machine" | `claude auth login`, then press Try again; or pick another AI in Settings |
| `EADDRINUSE` when starting | something already uses port 4400 (`lsof -iTCP:4400 -sTCP:LISTEN` shows what): stop it, or `PORT=4401 npm start` |
| "couldn't reach Postgres at DATABASE_URL" when starting | `DATABASE_URL` is set but the database is down. Start it, or take the line out of `.env` to use SQLite |
| "GitHub can't find that, or you can't see it" | your `gh` account can't see that repository, or the link is wrong |
| A read stopped with "Lost the connection" | the server restarted mid-read. Reads run inside the server process, so restarting it stops them; press Try again |

## Configuration

Copy `.env.example` to `.env`; `npm start` reads it. Locally you need none of it. Everything here is optional unless the column says otherwise.

| Variable | Used for | Default |
|---|---|---|
| `PORT` | the port to listen on | `4400` |
| `HOST` | the address to bind | `127.0.0.1` locally, `0.0.0.0` hosted |
| `DATABASE_URL` | Postgres instead of SQLite | unset (SQLite) |
| `READTHROUGH_SQLITE` | where the SQLite file lives | `./readthrough.db` |
| `READTHROUGH_EFFORT` | how hard Claude thinks per read: `low` to `max` | `high` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | a key for local mode, so you needn't paste one | unset |
| `GITHUB_CLIENT_ID` | **switches on hosted mode** (GitHub sign-in) | unset (local mode) |
| `GITHUB_CLIENT_SECRET` | hosted: the GitHub App's client secret | required when hosted |
| `GITHUB_APP_SLUG` | hosted: makes the "Choose repositories" link | unset |
| `PUBLIC_URL` | hosted: the address people open; on `app.` it splits the hosts (below) | required when hosted |
| `READTHROUGH_SECRET` | hosted: encrypts GitHub tokens, 32+ characters | required when hosted |
| `READTHROUGH_WAITLIST` | `1` puts a waitlist on the landing page and closes sign-in | off |
| `READTHROUGH_ALLOWED_USERS` | GitHub logins allowed to sign in | unset |
| `READTHROUGH_ALLOWED_ORGS` | GitHub organizations whose members may sign in | unset |

### Database

With no `DATABASE_URL`, everything is kept in `readthrough.db` (SQLite, built into Node). Back it up by copying the file; start fresh by stopping the server and deleting it.

For Postgres, set `DATABASE_URL`. Tables are created on start. A local one in Docker:

```bash
docker run -d --name readthrough-pg -e POSTGRES_USER=readthrough -e POSTGRES_PASSWORD=readthrough -e POSTGRES_DB=readthrough -p 127.0.0.1:5433:5432 postgres:17-alpine
```

Then put `DATABASE_URL=postgres://readthrough:readthrough@127.0.0.1:5433/readthrough` in `.env`. If `DATABASE_URL` is set but Postgres can't be reached, Readthrough stops with an error. It never falls back to SQLite on its own, because during an outage that would quietly split sign-ins, settings and tours across two databases.

## Two ways to run it

| | **Local** (on your own machine) | **Hosted** (for a team) |
|---|---|---|
| Switched on by | `GITHUB_CLIENT_ID` empty | `GITHUB_CLIENT_ID` set |
| Sign-in | none; uses the `gh` CLI's login | GitHub, through your GitHub App |
| Who it serves | you | everyone you let in |
| AI | Claude Code, Codex, or API keys | each person's own API key |
| Database | SQLite (or Postgres) | Postgres, or SQLite for a small team |

Subscription logins only work locally. Anthropic doesn't allow Claude Pro/Max logins in third-party hosted apps, so a hosted Readthrough uses API keys. OpenAI's "Sign in with ChatGPT" can spend a ChatGPT plan from a hosted app, but only for apps OpenAI has approved; Readthrough doesn't use it yet.

## Deploy (hosted)

### 1. Create the GitHub App

In your account or organization: Settings → Developer settings → GitHub Apps → New GitHub App.

- **Homepage URL:** your site. **Callback URL:** `PUBLIC_URL/auth/callback`.
- Keep **Expire user authorization tokens** on. Turn **Webhook → Active** off.
- **Repository permissions,** all Read-only: Contents, Pull requests, Issues (Metadata is added automatically). No account or organization permissions.
- **Where can this app be installed:** "Any account" to let other people use it; "Only on this account" keeps it to you. A private app shows a 404 to anyone else who tries to sign in.

Create it, copy the **Client ID**, generate a **client secret**, and note the slug from the app's address (`github.com/apps/<slug>`). Upload a logo under Display information, or GitHub shows a generated pattern on its sign-in screen.

Signing in and installing are separate. Signing in only tells Readthrough who you are. Installing the app on an account or organization, and choosing repositories, is what lets it read them; until then the home page asks you to choose repositories. Only an owner can install it on an organization.

### 2. Run the container

```bash
docker build -t readthrough .
```

```bash
docker run -p 4400:4400 --env-file .env -v readthrough-data:/data readthrough
```

Without `DATABASE_URL` the container keeps SQLite at `/data/readthrough.db`, so mount a volume there or it's lost when the container is replaced. Put it behind HTTPS at `PUBLIC_URL`; cookies are marked `Secure` and HSTS is sent when `PUBLIC_URL` starts with `https://`.

The Dockerfile copies an explicit list of files. A new file the app serves has to be added there too.

### Or: free on Render, with Neon for Postgres

`render.yaml` describes the whole service.

1. On [Neon](https://neon.com), create a project and copy its pooled connection string.
2. Create the GitHub App (step 1) with the callback `https://app.<your domain>/auth/callback`.
3. On [Render](https://render.com): New → Blueprint, and pick this repository. Render reads `render.yaml`, generates `READTHROUGH_SECRET`, and asks for `DATABASE_URL`, the GitHub App values and `READTHROUGH_ALLOWED_USERS`.
4. In the service's Custom Domains, Render shows the DNS records for the bare domain, `www` and `app`. Add them at your registrar; HTTPS is issued automatically.
5. Every push to `main` deploys.

Render's free plan sleeps after 15 minutes without traffic, and the next visit takes about a minute to wake it. Reads aren't cut off by proxy timeouts: the page follows a read over a Server-Sent Events stream with a heartbeat, and a dropped stream reconnects to the same read.

### App and landing on separate hosts

When `PUBLIC_URL` is on an `app.` subdomain (`https://app.readthrough.xyz`), point the bare domain at the same server too. The bare domain then shows only the landing page; its sign-in and PR links go to the app host, and `www` redirects to the bare domain. The session cookie stays on the app host. Link previews (`og:` tags and `og.png`) use the bare domain.

### Who can sign in

People only ever see PRs their own GitHub account can read, in repositories where the app is installed.

- `READTHROUGH_ALLOWED_USERS` lists GitHub logins, comma-separated (case and spaces don't matter). Taking a login off ends that person's sessions on their next request.
- `READTHROUGH_ALLOWED_ORGS` lets members of those organizations in. Membership is checked at sign-in.
- `READTHROUGH_WAITLIST=1` puts a waitlist form on the landing page and closes sign-in to everyone not on one of the two lists, even when both are empty. Read the list with `select email, created_at from waitlist order by created_at;`. To invite someone, add their GitHub login to `READTHROUGH_ALLOWED_USERS`.

People turned away see "Not on the list yet" with a link to the waitlist.

## Development

```bash
node --check server.js && node --check app.js
```

```bash
npm run check
```

`npm run check` exercises every storage function on SQLite, and on Postgres too when `DATABASE_URL` points at a scratch database. `server.js` and `app.js` end with `console.assert` self-checks; the server's run on start and the page's run in the browser, so a clean console in both means they passed. [AGENTS.md](AGENTS.md) has the architecture, conventions and the checks to run after a change.

## Security

- GitHub access is read-only and per person; GitHub decides what each person can see.
- Sessions are random 256-bit cookies (HttpOnly, SameSite=Lax); the database stores only their SHA-256.
- GitHub tokens are encrypted at rest (AES-256-GCM under `READTHROUGH_SECRET`); rotating it signs everyone out.
- AI keys aren't stored on the server. Each person's key stays in their browser and is sent over HTTPS in the body of the request that starts a read, never in a URL; the server holds it only while that read runs. Signing out clears it.
- The API refuses cross-site requests; pages are served with a strict Content-Security-Policy and `frame-ancestors 'none'`.
- The PR's diff, description, commits and linked issues go to the AI each person chooses. A hosted Readthrough also stores the tours, which quote code, in its database. Check that your employer allows that before installing the app on work repositories; local mode keeps everything on your machine apart from the AI call.

## Files

| File | Role |
|---|---|
| `server.js` | HTTP server, sign-in, access rules, PR loading and diff parsing, syntax highlighting, tours, waitlist. |
| `github.js` | GitHub REST/GraphQL client (per-person token), GitHub App sign-in, the local `gh` token. |
| `ai.js` | The prompts and schemas, and the four providers. |
| `db.js` | Storage on Postgres or SQLite (one set of queries for both); encryption of GitHub tokens. |
| `db.check.js` | `npm run check`. |
| `app.js` | The front end: landing, home, the PR panes, flow player, settings. |
| `styles.css`, `index.html` | Styles (light and dark) and the page shell with its link-preview tags. |
| `demo.json` | The landing page's live demo: a real tour of cli/cli #14815 (MIT licensed). |
| `og.png`, `readthrough-logo.png` | The link-preview image and the GitHub App logo. |
| `fonts/` | Schibsted Grotesk, self-hosted (SIL OFL). |
| `Dockerfile`, `render.yaml` | The container, and the Render Blueprint. |
| `neon.ts` | Neon project settings from `neon init`; not used by the app at runtime. |

## Limits

- The model sees the diff, description, commits and linked issues, not the rest of the repository; the map shows what can be inferred from those.
- Reads in progress are tracked in memory, so run one server process, and restarting it stops reads in progress.
- Your "understood" marks are kept in your browser.
- A tour stays on someone's home page after they lose access to its repository.
- Generated files are detected by file name.
