# Odyssey

A guided review of a GitHub pull request, one stop at a time.

Paste a GitHub PR link. Odyssey opens it in three panes: the list of stops, the explanation of the current stop, and that stop's real diff.

- **Overview:** the gist, the why, and the before → after of the change's behaviour. Next to it, a map of the functions, routes, and tables the PR touches, with arrows for which way calls and data go (git colours: A added, M modified, D deleted), plus every file with the stops that explain it.
- **Stops:** the diff split into stops, in the order the code runs. Each stop is one plain sentence, then 2–5 numbered steps. Each step is pinned to the exact lines it describes: the same number marks them in the code gutter, and hovering or clicking a step lights up its lines. Each stop also has one thing to **verify** yourself. Mark each stop understood; the status bar tracks progress.
- **Since last tour:** when a PR you've toured gets new commits, opening it lands here: the new commits and the diff of only those commits, shown straight away from GitHub, then a short explanation of what they change once the read finishes. If the branch was rebased or force-pushed, there's no clean diff of the new work, and the view says so.
- **Does it do what was asked?** Each requirement from the PR's linked GitHub issues (or from its description when no issue is linked) is marked met, partly met, missing or unclear, with the code that shows it. Jira links aren't followed yet.
- **Unexplained:** any hunk no stop covers. Odyssey computes this itself, without the model, so nothing in the diff gets skipped quietly.
- **Before merging:** concrete risks, each linked to its hunk, and questions to ask the author.
- **From the file list:** facts worked out from file names with no AI involved: no test changes, dependency, migration, CI, or config changes, deleted files, and generated files that were skipped.

## Run

```bash
node server.js
```

Then open http://localhost:4400.

You need Node 22+ and the [`gh`](https://cli.github.com) CLI, logged in. Odyssey reads GitHub through `gh`. There are no npm packages.

## Who reads the PR

Pick one in the settings panel (the sliders button in the top bar):

| Provider | Needs | Models |
|---|---|---|
| **Claude Code** (default) | the `claude` CLI, logged in | Sonnet 5.5 (default), Opus 5.5, Haiku 5.5 |
| **Codex** | the `codex` CLI, logged in with ChatGPT | your Codex default, or any model id |
| **OpenAI-compatible API** | a base URL, a model id and a key | OpenAI, OpenRouter, a local server: anything with `/chat/completions` and JSON-schema output |

Settings live in `.odyssey.json`, readable only by you. The API key is never sent back to the browser. `OPENAI_API_KEY` in the environment works too. `ODYSSEY_MODEL` sets the default Claude model and `ODYSSEY_EFFORT` (default `high`) sets Claude's effort. `PORT` defaults to `4400`.

The API only answers this page. Requests from other sites are refused, so a webpage can't start reads or point the provider at its own server.

Tours are kept in `.cache/`, one per reader per commit. Opening a PR shows any tour of its current commit, whichever model wrote it. A PR is read again only when it gets new commits, or when you press **Re-read**, which uses the model currently selected. A read keeps running if you leave the page, and coming back picks it up where it is.

The home page lists reads in progress, your tours (with their flow map and how many stops you've marked understood), and your open PRs and review requests, each with its size, review state, a 1–5 review-effort score (from size alone, no AI) and whether a tour is ready. **Smallest first** sorts by effort.

Keys: `j`/`k` move between stops, `x` marks the current stop understood, `/` opens another PR. Each stop has its own URL (`#/owner/repo/123/2`).

## Files

| File | Role |
|---|---|
| `server.js` | HTTP server on 127.0.0.1, `gh` fetch, hunk parsing, signals, prompt and schema, cache. |
| `app.js` | Views (home, the three PR panes), flow-map layout, progress, keyboard. |
| `styles.css` | Tokens (light and dark), layout, diff, map. |
| `index.html` | Shell. |

## Limits

- The model sees the diff, the description, and the commit messages, not the rest of the repository. The map shows only what can be inferred from those.
- Generated files are detected by name (`GENERATED` in `server.js`).
- Your "understood" marks are stored in this browser only.
