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

**Pull requests** lists your open pull requests in the configured repository (see [Configuration](#configuration)) using your current `gh` account, in stack order: a PR whose base branch matches another listed PR's head branch is indented under that parent. Press `o` for a flat, recently updated list. Only your listed open PRs participate; merged parents or PRs by other authors are shown as a base branch rather than an inferred dependency.

1. Select a PR and press `Enter`, or press `gu` and paste any PR URL from that repository (including another author's).
2. Move through all changed files in one continuous list. The file sidebar groups files by directory and tracks viewed files and comment counts. Skipped sections reveal 20 lines at a time.
3. Put the cursor on a line, or select a range with `V`, and press `c`.
4. Write your feedback and press `Ctrl-Enter`. Each save, edit, and deletion updates Markdown on disk.
5. Press `p` to switch between PRs in the current stack. Unfinished comment drafts remain in browser storage. Saved comments and viewed files live on disk.

**Copy Markdown** (`gm`) copies the full review. **Download .md** (`gd`) downloads it. The status line shows the path to the continuously updated file:

```text
.reviews/<snapshot-id>/review.md
```

Set `REVIEW_DIR=/absolute/path` when starting the app to change the storage directory. Each snapshot also has `review.json`, containing the patch and review state, and a small `summary.json` for the PR picker. JSON is the source of truth. Reopening a review regenerates Markdown, so edit comments in the app rather than editing the generated file.

## Configuration

pr-review reviews one repository at a time:

- `LOCAL_REPO`: the default checkout, used when a tab has no `?checkout=`. Defaults to the directory the server starts in.
- `GITHUB_REPO`: the GitHub repository as `owner/name`. Defaults to the checkout's `origin` remote.

Put them in `.env.local` (git-ignored; `pnpm dev` and `pnpm start` load it):

```sh
LOCAL_REPO=/path/to/your/checkout
# GITHUB_REPO=owner/name
```

Opening `?checkout=<absolute path>` (for example from a hyprnav browser slot, which passes a T3 thread's worktree) reviews that checkout instead: its repository and current branch come from Git, so any project works without configuration. If the branch has an open PR, the PR opens; otherwise the branch's commits are listed. The tab keeps that checkout for the rest of its session.

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
- **Jump:** `]` `[` next/previous file, `f` go to file, `}` `{` hunk, `)` `(` comment, `/` search, `;` `,` next/previous match.
- **Files:** `Space` marks the file viewed, collapses it and moves to the next unviewed file. `m` toggles viewed. `za` `zc` `zo` toggle/collapse/expand, `zM` `zR` all files.
- **Comments:** `c` comments on the cursor line or selection (or returns to an unfinished draft). In the editor, `Ctrl-Enter` saves, `Ctrl-g` switches between local and GitHub, and `Esc` returns to the diff, keeping a non-empty draft. On a thread: `r` reply, `x` resolve/reopen, `e` edit, `D` twice to delete. `gc` lists all comments.
- **Selection:** `v` characters, `V` lines, `y` copy, `Esc` cancel.
- **View:** `u` split/unified, `gw` wrap, `\` file sidebar, `gt` theme.
- **Review:** `p` switch PR in the stack, `gs` GitHub review, `gr` reload, `go` open on GitHub, `gm` copy Markdown, `gd` download, `ga` copy agent file path.
- **Lists:** `gp` pull requests, `gb` branches, `t`/`n` move, `Enter` open, `/` filter, `Esc` back to the open review. `gu` opens a PR from a URL.

Commands live in one table per view (`useCommands` in `src/keys.ts`). To rebind, store a JSON object of command id to key list in `localStorage["pr-review:keymap"]`, for example `{"cursorDown": ["j"], "fileNext": ["J"]}`. Command ids are the keys under `keys.cmd` in `config/i18n/en/webapp.json`.

## Agent conversations

Use **Copy agent file path** (`ga`) and give that path to the agent.
Each PR has a stable folder under `.reviews/prs/<pr-key>/`:

- `comments.json`: user requests, including relative file paths, line ranges, original code and snapshot IDs.
- `replies.json`: agent replies keyed by `commentId`.
- `pr.json`: PR URL, title and snapshot ID.
- `AGENTS.md`: file format and tRPC reply instructions.
- `review.md`: Markdown export generated when saving the review. Export in the app includes current replies.

The app polls the tRPC `comments` query every two seconds. It updates comment threads without fetching or parsing diffs. Agents can atomically replace `replies.json`, preserving existing replies, or call the `reply` tRPC mutation. Prefer tRPC with multiple writers. Saved requests are shared across snapshots; older requests link to their original diff. Browser drafts remain local until saved.

Existing saved comments were migrated into these PR folders. Migration is idempotent and preserves existing replies.

## Branch commits

Press `gb`, choose a local branch with `b`, then select a commit. The list follows first-parent history and loads 100 commits at a time. Each diff compares the selected commit with its first parent; root commits compare against an empty tree. Working-tree edits are not included in commit reviews.

Every commit on a branch shares `.reviews/branches/<branch-key>/comments.json` and `review.md`. Requests retain their original snapshot IDs, so replies and resolutions persist while switching commits. **Copy agent file path** copies the shared branch comments file. Branches and PRs keep separate conversations.


## GitHub review sync

Comments default to **Local only**. Choose **Local + GitHub review** in the comment editor to queue a comment. Open **GitHub review** to inspect queued comments and submit a Comment, Approve, or Request changes review using the current `gh` account. GitHub disallows approving or requesting changes on your own PR.

The open PR polls GitHub every five seconds while the tab is visible, with backoff after errors. Threads, replies, edits, outdated locations, resolutions, review decisions, and PR discussion are imported. Replies, edits, and resolve/reopen actions on published threads go to GitHub immediately. Local-only comments and agent replies stay local. Published comments can be deleted on GitHub; their local copies remain marked as deleted.

Branch comparisons can be linked to a PR using its URL. Submission checks the reviewed commit and each comment's lines against the actual PR diff. Drafts that no longer match must be recreated at the current location. The submission dialog lists invalid drafts before sending.

Draft bodies are retained during remote edits and submission errors. If a comment changed remotely, choose its GitHub version or explicitly keep the local edit before saving. Ambiguous network failures keep an operation record and are reconciled before retrying. Use the manual retry override only after checking GitHub for the previous submission.

Sync state and recovery records live in `github.json` beside each conversation's `comments.json`. Do not edit the sync file by hand. GitHub writes use hidden request markers to recognize retries; the app hides those markers from displayed text.
