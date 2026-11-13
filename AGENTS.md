# AGENTS.md

Guide for coding agents working on Readthrough, a guided review of GitHub pull requests. [README.md](README.md) describes the product and every setting; this file is how to bring it up, how it's built, and how to change it without breaking it.

## Bring it up

Run every command from the repository root. Follow the steps in order; each ends with a check, and you don't go on until it passes.

Two kinds of step need the human:

- **(person)** steps open a browser or ask for a password. Tell them the exact command, wait for them to say it's done, then run the check yourself. Never type a password, token or API key for them.
- **(ask)** steps install software. Ask first.

Don't repeat anything personal a check prints (email addresses, organisation names, tokens) back into the conversation beyond what the step needs.

1. **Node 22.13 or newer (ask).** Check: `node --version`. Older versions lack the built-in SQLite the app uses. To install: `brew install node` on macOS, otherwise https://nodejs.org.
2. **GitHub CLI (ask).** Check: `gh --version`. To install: `brew install gh` on macOS, otherwise https://cli.github.com. Local mode reads GitHub through it.
3. **The code.** Check: `ls server.js app.js package.json` lists all three, and you're in the folder that holds them. If they aren't there, run `git clone https://github.com/confusedconsciousness/readthrough.git && cd readthrough`.
4. **Dependencies.** `npm ci`. Check: it exits 0 and `node_modules/pg` exists. There's no build step after this.
5. **GitHub sign-in (person).** Check: `gh auth status`. Readthrough uses the **active** account and sees exactly what it can see.
   - Not logged in: ask the person to run `gh auth login`. The default scopes are enough.
   - Several accounts listed: tell the person which one is active and ask which they want. To change it: `gh auth switch --user <login>`.
6. **An AI.** One working option is enough. Check what's there:
   - **Claude Code:** `claude --version`, then `claude auth status` and read only its `loggedIn` field. If it's false, ask the person to run `claude auth login` **(person)**.
   - **Codex:** `codex --version`, then `codex login status`. If it isn't logged in, ask the person to run `codex login` **(person)**.
   - **Neither:** once the app is up, the person pastes an Anthropic or OpenAI-compatible API key in Settings (the gear button). Don't handle the key for them.

   The app starts on Claude Code with Sonnet 5.5. If only Codex or a key works, tell the person to choose it in Settings before the first read.
7. **Start it.** Pick the port: 4400 unless it's taken. Check with `lsof -iTCP:4400 -sTCP:LISTEN`, which prints nothing when the port is free. If it's taken, `curl -s http://localhost:4400/api/me` tells you whether it's a Readthrough (it answers with `"mode"`); ask the person whether to stop it. Otherwise use 4401. Below, `PORT` means the port you picked.
   - **In Claude Code,** on 4400 only: start the preview server `readthrough` from `.claude/launch.json`.
   - **Anywhere else, or on another port:** `PORT=4401 npm start > readthrough.log 2>&1 &` (with your port). `readthrough.log` is gitignored.

   Wait until it listens: `until lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null; do sleep 1; done`. In the log, npm's own lines and `.env not found. Continuing without it.` are normal, since `.env` is optional locally. Look for `readthrough (local mode, SQLite at …) on http://localhost:PORT`. Then:

   ```bash
   curl -s http://localhost:4400/api/me
   ```

   This should return `"mode":"local"` and a `"user"` whose `login` is the account from step 5. `"user":null` means `gh` isn't signed in. Use your port in this check and the ones below.
8. **Open it.** With a browser, open http://localhost:4400: the landing page shows a live demo tour and the console is empty. Then `#/` shows the home page. "Your tours" is empty on a first run, and open PRs and review requests from GitHub appear beside it. Without a browser, check that these each return 200:

   ```bash
   for p in / /app.js /styles.css /demo.json /api/recent /api/inbox; do curl -s -o /dev/null -w "%{http_code} $p\n" http://localhost:4400$p; done
   ```

9. **First read (ask).** A read spends the person's AI plan or API credit and takes one to five minutes, so ask before starting one. A small public PR is a good test: `http://localhost:4400/#/cli/cli/14815`. Check: the page shows each step ("Reading N files with …", "Pinning the tour to the code") and ends on the tour's overview.

To stop it, stop the preview server, or stop whatever listens on the port: `lsof -tiTCP:4400 -sTCP:LISTEN | xargs kill`. Killing only the `npm` process can leave `node server.js` running. Stopping or restarting it ends any read in progress (see "Things that bite").

**Optional, Postgres instead of SQLite.** Only if the person asks:

```bash
docker run -d --name readthrough-pg -e POSTGRES_USER=readthrough -e POSTGRES_PASSWORD=readthrough -e POSTGRES_DB=readthrough -p 127.0.0.1:5433:5432 postgres:17-alpine
```

Then add `DATABASE_URL=postgres://readthrough:readthrough@127.0.0.1:5433/readthrough` to `.env` and restart. Check: the start line says Postgres.

## Ground rules

- **No build step.** The front end is plain HTML, CSS and JS: `index.html` loads `styles.css` and `app.js` with ordinary tags. The server is CommonJS on Node built-ins (`node:http`, `node:sqlite`, `fetch`) plus three packages: `@anthropic-ai/sdk`, `pg` and `highlight.js`. (The `@neon/*` dev dependencies come from `neon init` and aren't used at runtime.) Don't add a framework, bundler or package unless the person asks.
- **Keep the file count small.** New logic goes into the existing file it belongs to.
- **Do the least that works.** Reuse what's in the file before writing a helper. Mark a deliberate shortcut with a `// ponytail:` comment that names its limit and how to lift it.
- **Write plainly.** UI text and docs are short, specific sentences. No marketing tone, no em dashes.
- **Commit or push only when the person says so.** A push to `main` deploys the hosted site.

## How it's built

### Two modes

`MODE` in `server.js` is `hosted` when `GITHUB_CLIENT_ID` is set, otherwise `local`.

- **Local:** no sign-in. GitHub calls use the token from `gh auth token`. Claude Code and Codex are allowed as AIs. It binds 127.0.0.1.
- **Hosted:** sign-in through a GitHub App, an allowlist and waitlist, sessions in the database, only API-key AIs. It binds 0.0.0.0 behind HTTPS.

### A read, end to end

1. `app.js` `open(key)` fetches `GET /api/pr` (the diff, straight from GitHub) and starts `readStream()`.
2. `readStream()` POSTs `/api/story/stream` with `{ pr, fresh, key }` and parses the Server-Sent Events response by hand. It's a POST, not `EventSource`, so the browser's AI key travels in the body and never in a URL. A dropped stream reconnects up to three times and joins the same read.
3. `story()` in `server.js` loads the PR, then:
   - returns a saved tour for this commit and model;
   - or joins a read already running (the `inflight` map, keyed by PR, commit and reader);
   - or starts one.
4. A new commit on a toured PR takes the incremental path: `carry()` re-pins the old tour to the new diff by matching line text, and `ai.update` reads only what's new. Otherwise it's a full read with `ai.analyse`.
5. `tidy()` pins every point, finding and premortem item to real diff lines, and normalises chapters. `anchorsOf()` records the hunk text for the next incremental read. The tour is saved with `db.putTour`.
6. The stream sends `progress` steps, a `: still reading` comment every 15 seconds (so proxies don't time out), and finally `done` (the tour without `anchors`) or `failed`.

### Files

| File | What's in it |
|---|---|
| `server.js` | Config; PR loading and diff parsing (`loadPR`, `threadsOf` for review comments); AI settings (`aiConfig`, `saveSettings`); tours (`story`, `tidy`, `carry`, `recent`); sessions and sign-in (`context`, `signIn`, the allowlist); the HTTP router (`handle`); the waitlist; self-checks at the end. |
| `ai.js` | `SYSTEM` and `SCHEMA` for a full read, `UPDATE` and `UPDATE_SCHEMA` for new commits, and the providers (`viaAnthropic`, `viaOpenAI`, `viaClaudeCode`, `viaCodex`). |
| `db.js` | `PG_SCHEMA` and `LITE_SCHEMA`, one set of queries written to run on both, and the sealing of GitHub tokens. |
| `github.js` | REST and GraphQL with a per-person token; GitHub App OAuth; `localToken()` from `gh`. |
| `app.js` | One IIFE, in sections marked `// ---------- name ----------`: state, helpers, routing, home, PR, flow map, flow player, settings, account, landing, events, appearance, self-checks. |
| `styles.css` | Colour tokens on `:root`, dark values under the media query and `[data-theme="dark"]`, the palettes, then components by view. Responsive rules at 1100, 980, 860 and 560px. |
| `index.html` | The shell, link-preview tags (`%SITE%` is filled in by the server) and one inline script (the theme, set before paint). |

### State in the browser

- `me` holds the result of `/api/me`: mode, user, `installs`, and `app` and `site` when the hosts are split. `cfg` holds the AI settings.
- `cur` is the open PR. `homeData` holds the home page's data.
- `store` wraps `localStorage` under the `readthrough:` prefix. It holds understood marks, theme, palette, depth, diff layout and AI keys (`key:<provider>`).
- Routing is the hash: `#/` is home, `#/owner/repo/123` a PR, `#/owner/repo/123/2` a stop, and an empty hash is the landing page.

## Changing things

| When you… | also… |
|---|---|
| add a file the server serves | add it to `STATIC` (text) or `FILES` (binary) in `server.js`, **and** to the `COPY` line in `Dockerfile`. The image copies an explicit list; a missing file works locally and returns an error in production. |
| add an environment variable | document it in `.env.example`, the README's configuration table, and `render.yaml` (`sync: false` for anything secret). |
| change the database schema | change both `PG_SCHEMA` and `LITE_SCHEMA`, make the change safe to run on every start (`create … if not exists`, `alter … if exists`), and cover it in `db.check.js`. |
| change what the AI returns | change `SCHEMA` (and `UPDATE_SCHEMA` if new commits produce it), the prompt that asks for it, and `tidy()` so old tours without the field still render. |
| add an API route | put it after the session check in `handle()` unless it's public. Non-GET routes must check `content-type: application/json`. The cross-site check at the top covers every `/api/` route. |
| put user or AI text into HTML | pass it through `esc()` (`escHTML` on the server). |
| change the inline script in `index.html` | nothing else: its CSP hash is computed when the server starts. |
| change UI | check light and dark, and widths of 1440, 860 and 375. Use the colour tokens, never hard-coded colours. |

Never put a secret in a URL, a log line or the database. GitHub tokens are sealed with `READTHROUGH_SECRET`. AI keys aren't stored on the server at all.

## Verify

After any change:

```bash
node --check server.js && node --check app.js
```

```bash
npm run check
```

Then restart the server and load the page. The browser console must be empty, because the `console.assert` self-checks at the end of `app.js` run there; the server's own run on start and print to its log only when one fails. Click through what you changed.

For anything that touches deployment (the Dockerfile, served files, hosted-only code), build and run the real image in hosted mode with throwaway values:

```bash
docker build -t readthrough-test .
```

```bash
docker run --rm -p 4498:4400 -e PUBLIC_URL=https://app.example.com -e GITHUB_CLIENT_ID=test -e GITHUB_CLIENT_SECRET=test -e READTHROUGH_SECRET=0123456789abcdef0123456789abcdef -e READTHROUGH_WAITLIST=1 readthrough-test
```

Then `curl -H 'Host: example.com' http://127.0.0.1:4498/og.png` and the other files you touched should each return 200.

## Deploying

The hosted site runs on Render (`render.yaml`) with Postgres on Neon. A push to `main` deploys in about a minute. To confirm the new version is live, fetch a file that changed and look for the change; `app.readthrough.xyz` serves the app and `readthrough.xyz` the landing page. Environment variables marked `sync: false` are set in Render's dashboard by the person, not in the repo.

## Things that bite

- **Restarting the server stops reads in progress.** Reads run inside the server process. Before restarting a local server, check `curl -s http://localhost:4400/api/recent` for a non-empty `reading` list. For Claude Code reads, use `pgrep -f "claude -p"`, which prints only process ids; `pgrep -fl` and `ps` print the full command line, which can include secrets.
- **Opening a toured PR with new commits starts a read.** When testing, open PRs whose tour is current, or ask first.
- **Signing in isn't installing.** On a hosted site, a person who signed in sees nothing until the GitHub App is installed on their repositories. A private GitHub App shows a 404 to anyone but its owner.
- **Split hosts.** With `PUBLIC_URL` on `app.`, the session cookie exists only on the app host. The bare domain can't tell who's signed in, so it only ever shows the landing page.
- **The waitlist closes sign-in.** With `READTHROUGH_WAITLIST=1`, only logins in `READTHROUGH_ALLOWED_USERS` (or members of `READTHROUGH_ALLOWED_ORGS`) get in, and nobody does while both are empty.
- **Render's free plan sleeps** after 15 minutes idle; the first request after that takes about a minute.
- **Link previews are cached** by WhatsApp, Slack and the like. Test a changed preview with a new query string (`/?v=3`).
