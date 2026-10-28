# PR Review

A local Git PR review app built with React, Vite, shadcn/ui, tRPC, and Pierre Diffs. Add comments to diff lines and collect them in a Markdown file automatically.

## Run

Requires Node.js 22.12+ or 24+, pnpm, and [GitHub CLI](https://cli.github.com/).

```sh
cd pr-review
pnpm install
gh auth login
pnpm dev
```

Open **http://127.0.0.1:4318**. Vite serves the UI with hot module replacement; the watched API runs on port 4319 and is proxied through Vite. Keep `pnpm dev` running while editing. If `gh` is already authenticated, skip the login step. GitHub supplies your PR titles and stack relationships. Diffs come from local Git. Credentials never enter the browser.

For a production build served by the same Node server:

```sh
pnpm build
pnpm start
```

Then open **http://127.0.0.1:4318**. Both modes bind to loopback for use on your own machine.

## Review

The app has two places: **Home** (`gh`) to choose what to review, and the **review** of one branch or PR.

**Home** lists the checkouts a T3 Code thread works in, your open PRs in stack order (`o` for recently updated), and local branches, each with its reading progress and what its agent is doing. `gp` and `gb` open it on the PR or branch section. `Enter` opens a row: a PR, or a branch as a whole (its commits are a scope inside the review). `gu` opens any PR URL; the palette's **Open a branch…** opens any local branch.

A review has three regions; `Tab` and `Shift-Tab` move between them, `Esc` returns to the reader:

- The **guide rail** (`\` hides it): the map's chapters (`M`), the files (`f` picks one), the branch's own commits (`C`), and search results (`/` in the diff, `*` across the repository).
- The **reader**: the diff of the current scope with the vim cursor. A review with a map opens on its first unread chapter, with the chapter's why and check list on top (`x` ticks the next check item, `2x` the second). Questions and comments show as one-line markers next to their lines; `Enter` on one opens it in the panel.
- The **agent panel** (`|` hides it): the thread the review talks to (`gA`) and what it is doing, an inbox of every question and comment grouped by state (new replies, agent working, waiting, open, answered, resolved), and the open conversation with its composer.

The top bar shows the scope (whole branch `gB`, chapter `<` `>`, commit `g<` `g>`, [changes since you looked](#changes-since-you-looked) `gn`), reading progress, and the **agent pill**: what the agent is doing in a few words (writing the map, answering, new replies, T3 Code unreachable). `I` focuses the inbox.

1. Read: `Space` marks the chapter (or, without a map, the file) read and moves to the next unread one. `m` toggles read. Read state is kept per hunk for the branch or PR, so a hunk read in a commit counts in the whole branch when the change is the same.
2. Ask: `a` on a line or selection opens the composer in the panel; `Ctrl-Enter` sends it to the agent thread. `A` sends "Explain this code" without typing. `c` writes a review comment the same way.
3. Replies: the pill counts new replies and the inbox lists them; `i` jumps the reader to the lines and opens the conversation. `r` replies, `x` resolves.
4. Done: past the last chapter the reader lists open questions, unresolved comments and comments queued for GitHub; `gs` opens the GitHub review, `gm` copies the Markdown.

`o` shows the whole file at the cursor (the head version with the review's changes marked); `*` searches the word under the cursor across the repository at the head, and `Enter` on a result opens that file. `Esc` returns.

**Copy Markdown** (`gm`) copies the full review; downloading it and copying the agent file path are in the palette. The status line shows the path to the continuously updated file:

```text
.reviews/<snapshot-id>/review.md
```

Set `REVIEW_DIR=/absolute/path` when starting the app to change the storage directory. Each snapshot also has `review.json`, containing the patch and review state, and a small `summary.json`. JSON is the source of truth. Reopening a review regenerates Markdown, so edit comments in the app rather than editing the generated file.

## Configuration

pr-review reviews one repository at a time:

- `LOCAL_REPO`: the default checkout, used when a tab has no `?checkout=`. Defaults to the directory the server starts in.
- `GITHUB_REPO`: the GitHub repository as `owner/name`. Defaults to the checkout's `origin` remote.

Put them in `.env.local` (git-ignored; `pnpm dev` and `pnpm start` load it):

```sh
LOCAL_REPO=/path/to/your/checkout
# GITHUB_REPO=owner/name
```

Opening `?checkout=<absolute path>` (for example from a hyprnav browser slot, which passes a T3 thread's worktree) reviews that checkout instead: its repository and current branch come from Git, so any project works without configuration. If the branch has an open PR, the PR opens; otherwise the whole branch opens. The parameter stays in the URL (an opened review adds `&review=`), so jumping to the same checkout again leaves the URL unchanged and the browser only focuses the tab.

- `T3CODE_TOKEN`: a T3 Code session token for [Ask the agent](#ask-the-agent). Issue one with `node <t3code>/apps/server/dist/bin.mjs auth session issue --token-only --label pr-review --scope orchestration:read --scope orchestration:operate`.
- `T3CODE_URL`: the T3 Code server, by default the `origin` in `~/.t3/userdata/server-runtime.json`.
- `PORT` and `API_PORT`: the UI and API ports (4318 and 4319), for running a second instance.

GitHub remotes are recognised in HTTPS, SSH and scp-like form, including SSH host aliases from `~/.ssh/config` (resolved with `ssh -G`).

## Local diffs and snapshots

Opening a PR resolves its head and base names to local branches. The diff starts at their local merge base. If the PR branch is checked out in a worktree, the review includes its unpushed commits, staged and unstaged edits, and untracked files. Ignored files are excluded. Otherwise it shows that branch's committed changes. When the head branch is missing locally (or the PR comes from a fork), the app fetches the PR head and base into `refs/pr-review/<number>/` and compares those commits. A missing base for a local head is fetched too. Reopening refreshes these refs; unchanged diffs reuse the saved snapshot. Fetching never checks out branches, stages files, or modifies your working tree.

Each combination of local commits and diff content gets a separate snapshot. Reopening unchanged content reuses its comments. Full context is captured alongside changed files so expanding skipped lines still shows the original snapshot after further edits. **Reload local changes** takes a fresh snapshot. Earlier reviews and Markdown remain on disk; comments are not automatically moved to new code.

Pierre CodeView virtualizes files and lines in one continuous list. A shared worker pool handles syntax highlighting.

## Scope

Local opening works for PRs in the configured repository. GitHub supplies PR metadata and missing Git commits; Git computes diffs locally. Previously saved GitHub snapshots remain readable. Comments stay local and are not posted to GitHub.

## Checks

```sh
pnpm check
pnpm test
pnpm build
```

Tests cover comment anchors, Markdown fences, persistence, concurrent writes, cache reuse, base/head invalidation, URL validation, and PR changes during download.

UI strings live in `config/i18n/en/webapp.json` and use `use-intl`. English is the initial locale.

## Keyboard

The whole app is driven from the keyboard. Press `?` for the full list of shortcuts in the current view, or `:` (also `Ctrl-K`) for a searchable command palette. Number prefixes repeat motions (`5t`). The status line at the bottom shows the mode, cursor position, pending keys and save state.

Defaults follow a Dvorak home row, with `j`/`k`/`l` and the arrow keys as aliases:

- **Cursor:** `h` `t` `n` `s` left/down/up/right, `T`/`N` 8 lines, `w` `b` `W` `B` words, `_` `-` line start/end, `Ctrl-d`/`Ctrl-u` half page, `gg`/`G` top/bottom, `Alt-h`/`Alt-s` old/new side, `Alt-t`/`Alt-n` reveal skipped lines.
- **Jump:** `]` `[` next/previous file, `f` go to file, `}` `{` hunk, `)` `(` comment, `/` search, `;` `,` next/previous match, `o` whole file, `*` search the repository.
- **Scope and reading:** `M` map, `>`/`<` next/previous chapter to read, `C` commits, `g>`/`g<` next/previous commit, `gB` whole branch, `gn` changes since you looked (again: refresh), `gd` mark them reviewed, `Space` read and next, `m` toggle read, `gM` ask the agent thread for a map (in the changes scope: a map of the changes to your asks).
- **Files:** `za` `zc` `zo` toggle/collapse/expand, `zM` `zR` all files, `gf` file filters, `zf` filtered files.
- **Comments and the agent:** `a` ask, `A` explain, `c` comment (or return to an unfinished draft), `gA` pick the thread, `Enter` open the thread at the cursor, `i` next new reply, `I` or `gc` the inbox. On a thread (at the cursor, or selected in the inbox): `r` reply, `x` resolve/reopen, `e` edit, `D` twice to delete. In the composer, `Ctrl-Enter` sends, `Ctrl-g` switches a comment between local and GitHub, and `Esc` returns to the reader, keeping a non-empty draft.
- **Selection:** `v` characters, `V` lines, `y` copy, `Esc` cancel.
- **View:** `Tab`/`Shift-Tab` rail, reader, panel; `u` split/unified, `gw` wrap, `\` rail, `|` panel, `gt` theme. With the rail or panel focused, `t`/`n` move in its list and `Enter` opens; in the rail `h`/`s` switch tabs.
- **Review:** `p` switch PR in the stack, `gs` GitHub review, `gr` reload, `go` open on GitHub, `gm` copy Markdown.
- **App:** `gh` Home (`gp`, `gb` its PR and branch sections; `gn` on an agent row opens its changes since you looked), `gu` open a PR URL, `Esc` back to the open review.

Commands live in one table per view (`useCommands` in `src/keys.ts`). To rebind, store a JSON object of command id to key list in `localStorage["pr-review:keymap"]`, for example `{"cursorDown": ["j"], "fileNext": ["J"]}`. Command ids are the keys under `keys.cmd` in `config/i18n/en/webapp.json`.

## File filters

`gf` opens the repository's file filters: named lists of gitignore-style patterns (`tests/`, `*.test.ts`, `/docs/`). Files matching an enabled filter stay in every review of that repository but start collapsed, like generated files, and are dimmed in the sidebar, which also shows how many matched. `zf` expands or collapses them all for the current review. Filters are stored in `.reviews/filters/`, keyed by the GitHub repository, so all its checkouts share them and nothing is written to the reviewed repository.

## Ask the agent

The T3 Code thread that wrote the code can answer questions about it in place. Put the cursor on a line or select a range, press `a`, type the question and press `Ctrl-Enter`; `A` sends "Explain this code" without opening the editor. pr-review sends the thread the question, the file and line range, the selected lines, and the diff hunks around them, with a `curl` command for the `reply` mutation. The agent's answer then appears in the panel, and the question's marker next to the lines says it was answered.

Until it does, the question waits in the inbox, moves to **Agent working** while the thread runs, or says the agent finished without replying; a follow-up reply on the question starts this again. New agent replies are counted by the pill and listed under **New replies** with a preview, and their chapter row and marker get a dot; `i` jumps to the next one, and opening a conversation (or putting the cursor on its marker) marks its replies seen (kept per review in `localStorage`). The app asks T3 Code about the threads every three seconds while the tab is visible and something is pending; when it cannot reach T3 Code, the pill says so and the panel header shows the error.

Questions go to the most recently active thread working in the review's checkout (its worktree, or the project root for threads without one). The panel header shows it; `gA` lists the matching threads to pick another. Questions are saved as local comments marked with the thread, so `r`, `x` and the inbox work on them as on any comment. This needs `T3CODE_TOKEN` (see [Configuration](#configuration)).

## Review map

A review map groups the diff's hunks into chapters in reading order, each with why it exists, a risk (low, medium, high) and what to check, plus notes on why particular lines were written the way they were. Press `gM`: the agent thread gets the exact diff (`map-diff.patch`) and runs the `review-map` skill (`~/.agents/skills/review-map/SKILL.md`), which writes `map.json` beside `comments.json`. The app polls for it every two seconds. The request is kept in `map-request.json`; while the thread writes it, the pill, the rail's map card and the inbox follow it (sent, picked up, working), and nothing moves under the cursor when it lands: the pill says **Map ready** and `M` starts chapter 1. An invalid file shows its errors in the map card.

`>` and `<` move between chapters, passing over skip-safe ones. Every hunk lands in exactly one chapter: hunks the map does not name are listed in a final **Uncovered** chapter, and references to hunks that are not in the diff are listed as stale on their chapter. Skip-safe chapters show their reason (moved code, generated, formatting, rename). For moved code the app checks that the chapter's removed lines are exactly its added lines, ignoring whitespace, and shows "verified" or "not verified"; unverified moves are not skipped. A file split across chapters shows no unchanged context (`o` shows the whole file).

A chapter's `notes` explain lines: `{ "file", "side": "new" | "old", "start", "end", "why" }`. Each shows under its last line, in the chapter and the whole branch. A note on lines the diff does not show is listed in red on its chapter's brief. In a commit scope, the commit list shows which chapters each commit touches, and the commit's brief counts its hunks the map does not cover.

## Changes since you looked

After asking the agent thread for changes, `gn` shows what it changed since you last looked: the thread's turns after the last one you marked reviewed, each with what you wrote in it, and the diff of the agent's own changes in them. Home shows the count on the thread's row ("2 turns since you looked"); `gn` there opens the review on it.

The snapshots are T3 Code's own checkpoints: after each turn T3 commits the whole working tree (uncommitted and untracked files too) to `refs/t3/orchestration-v2/checkpoints/…/ordinal/<turn>`, with HEAD as the parent. pr-review reads them and the thread's messages from T3 Code (`GET /api/orchestration/threads/<id>`) and never writes to them. A turn whose snapshot is missing is reported, not skipped.

The diff leaves out what merges and rebases brought in from other branches (`agentChanges` in `server/changes.ts`). A merge made in those turns shows only its conflict resolutions and edits beyond the automatic merge, as `git show --remerge-diff` does; commits fast-forwarded from main (or the PR's base) are left out the same way. After a rebase onto a moved main, the branch's own changes before and after are compared, as `git range-diff` does, so main's changes do not show.

`gM` in this scope asks the thread to map the changes to what you asked: one chapter per ask with the ask quoted, notes on the lines, and what was asked but not done listed on the chapter's brief. Changes no ask explains land in Uncovered. `gd` marks the turns reviewed: the next `gn` starts after them. pr-review keeps the marker and this map per thread in `.reviews/threads/<hash of the thread ID>/` (`reviewed.json`, `map.json`, `map-diff.patch`, `map-request.json`); marking reviewed renames the map to `turn-<n>-map.json`. The changes are a snapshot in the review's conversation folder, so questions and comments on them work as anywhere else.

## Agent conversations

Use **Copy agent file path** (palette) and give that path to the agent.
Each PR has a stable folder under `.reviews/prs/<pr-key>/`:

- `comments.json`: user requests, including relative file paths, line ranges, original code and snapshot IDs.
- `replies.json`: agent replies keyed by `commentId`.
- `pr.json`: PR URL, title and snapshot ID.
- `AGENTS.md`: file format and tRPC reply instructions.
- `review.md`: Markdown export generated when saving the review. Export in the app includes current replies.
- `read.json`: read hunk ids and ticked check items of the branch or PR.

The app polls the tRPC `comments` query every two seconds. It updates comment threads without fetching or parsing diffs. Agents can atomically replace `replies.json`, preserving existing replies, or call the `reply` tRPC mutation. Prefer tRPC with multiple writers. Saved requests are shared across snapshots; older requests link to their original diff. Browser drafts remain local until saved.

Existing saved comments were migrated into these PR folders. Migration is idempotent and preserves existing replies.

## Branch commits

A branch or PR is one review; its commits are a scope inside it. The Commits tab (`C`) lists the review's own commits, oldest first: first-parent history from the merge base, without merges. Each shows a read tick and the chapters it touches. `Enter`, `g>` or `g<` scopes the reader to a commit; `gB` returns to the whole branch. A commit's diff compares it with its first parent; working-tree edits are not part of commits.

A commit is its own snapshot in the review's conversation folder (`.reviews/branches/<branch-key>/` or `.reviews/prs/<pr-key>/`), so comments, replies, read state and the map are shared. Comments keep the snapshot they were written on and show inline there; the inbox lists them all. Single-commit reviews saved before this change open as their branch, scoped to that commit.

## GitHub review sync

Comments default to **Local only**. Choose **Local + GitHub review** in the comment editor to queue a comment. Open **GitHub review** to inspect queued comments and submit a Comment, Approve, or Request changes review using the current `gh` account. GitHub disallows approving or requesting changes on your own PR.

The open PR polls GitHub every five seconds while the tab is visible, with backoff after errors. Threads, replies, edits, outdated locations, resolutions, review decisions, and PR discussion are imported. Replies, edits, and resolve/reopen actions on published threads go to GitHub immediately. Local-only comments and agent replies stay local. Published comments can be deleted on GitHub; their local copies remain marked as deleted.

Branch comparisons can be linked to a PR using its URL. Submission checks the reviewed commit and each comment's lines against the actual PR diff. Drafts that no longer match must be recreated at the current location. The submission dialog lists invalid drafts before sending.

Draft bodies are retained during remote edits and submission errors. If a comment changed remotely, choose its GitHub version or explicitly keep the local edit before saving. Ambiguous network failures keep an operation record and are reconciled before retrying. Use the manual retry override only after checking GitHub for the previous submission.

Sync state and recovery records live in `github.json` beside each conversation's `comments.json`. Do not edit the sync file by hand. GitHub writes use hidden request markers to recognize retries; the app hides those markers from displayed text.
