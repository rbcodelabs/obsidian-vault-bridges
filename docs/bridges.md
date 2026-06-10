# Bridges Reference

A **bridge** is the core concept in Vault Bridges. Each bridge represents a connection between a source location (a path inside a local Git repo) and a destination location (a path inside your vault).

---

## How a Bridge Works

A bridge supports two operations: **Pull** and **Push**.

### Pull (repo → vault)

1. Runs `git pull origin <branch>` in the repo directory to fetch the latest changes from the remote
2. Copies files from the source path in the repo into the vault destination using a recursive file copy — the `.git/` folder is excluded
3. If a legacy symlink exists at the vault destination, it is removed first and replaced with real files

The result is a set of real files in your vault that reflect the state of the repo after the last pull. These files are fully indexed by Obsidian — they appear in search, Quick Switcher, backlinks, and the graph view just like any other vault note.

### Push (vault → repo)

There are two ways to push: **Push all** and **Push selected**.

**Push all** (the ⬆ button in the settings panel, **↑ Push all** in the command bar, or `Vault Bridges: Push All Bridges`):

1. Copies all files from the vault destination back to the source path in the repo
2. Stages all changes with `git add -A`
3. Checks `git status --porcelain` — if nothing changed, the commit and push are skipped
4. Commits with an auto-generated message: `Update from Obsidian vault (<timestamp>)`
5. Pushes to `origin <branch>`

**Push selected** (via the "● N changes ▾" pill in the in-editor command bar):

1. Opens a popdown listing each modified (`M`), added (`A`), or deleted (`D`) file with a checkbox
2. You uncheck any files you want to hold back, and optionally type a custom commit message
3. Only the checked files are copied back to the repo
4. Stages only those files, commits, and pushes to `origin <branch>`
5. The bridge remains dirty if any files were left unchecked; they will appear again in the next push

See [In-Editor Command Bar](../README.md#in-editor-command-bar) for full details on the pill and popdown UI.

---

## Bridge Fields

### Name
A human-readable label used throughout the UI and command palette. Choose something descriptive — you may have several bridges and will need to distinguish them.

### Local Repo Path
The absolute filesystem path to the root of a locally-cloned Git repo. This is the directory that contains the `.git/` folder.

The repo must already exist on disk. Vault Bridges does not clone repos from a URL.

```
/Users/you/projects/company-docs       ← correct: contains .git/
/Users/you/projects/company-docs/docs  ← wrong: use Source Subfolder for this
```

### Source Subfolder
Optional. A path relative to the repo root specifying which subfolder to copy into the vault.

| Source Subfolder | What gets copied |
|---|---|
| *(blank)* | The entire repo root (excluding `.git/`) |
| `docs` | The `docs/` folder only |
| `docs/architecture/decisions` | A deeply nested subfolder |

For most use cases, specifying a `docs` or `notes` subfolder is cleaner than copying the entire repo root.

### Vault Destination Path
The path inside your vault where the copied files will be placed. This is relative to the vault root.

```
Work/Docs              ← copies files into a "Docs" folder inside "Work"
References/Handbook    ← copies files into "Handbook" inside "References"
ADRs                   ← copies files into "ADRs" at the vault root level
```

Parent folders are created automatically if they don't exist.

### Branch
The Git branch to pull from and push to. Defaults to `main`.

If your repo uses a different default branch (`master`, `develop`, `trunk`), set this accordingly per bridge.

**The bridge follows the branch the repo is actually checked out on.** If the main checkout is parked on a feature branch (e.g. you ran `git checkout feat/x` in the repo directly instead of in a worktree), the bridge pulls and pushes that branch rather than the configured one. This avoids a cross-branch pull that would otherwise abort with `fatal: Need to specify how to reconcile divergent branches`. A notice tells you when this override is in effect. To go back to the configured branch, check the repo back out onto it (`git checkout main`). When a worktree is pinned via the branch pill, that worktree's branch takes precedence as before.

### Auto Sync on Startup
When enabled, this bridge is included in the startup sync batch. This is subject to the global **Sync on startup** toggle also being enabled.

Disable this for bridges that are large, slow to pull, or that you only want to sync manually.

---

## Bridge Status

Each bridge tracks its current state:

| Status | Meaning |
|---|---|
| `ok` | Last sync completed without errors. |
| `error` | Last sync or push failed. The error message is shown in settings. |
| `syncing` | A sync or push operation is currently in progress. |
| `unlinked` | The bridge destination has been removed (bridge was deleted from settings). |
| `unknown` | Bridge was just added and has never been synced. |

The `lastSynced` timestamp records the ISO timestamp of the most recent successful sync.

---

## Sync Behavior

### What "sync" (pull) does

For each bridge, sync:
1. Checks the repo path exists and contains a `.git/` directory
2. Runs `git pull origin <branch>` with a 30-second timeout
3. Copies files from the repo source path into the vault destination (`.git/` excluded)
4. Updates `status`, `lastSynced`, and `lastError`

### What "push" does

**Push all** (the default; stages everything):

1. Validates the branch name
2. Checks the vault destination path exists
3. Copies all files from the vault destination back to the repo source path
4. Stages all changes with `git add -A`
5. Checks `git status --porcelain` — if nothing has changed, skips the commit and push
6. Commits with the message `Update from Obsidian vault (<timestamp>)` and pushes to `origin <branch>`

**Push selected** (only the files you checked in the popdown):

1. Validates the branch name
2. Copies only the selected files back to the repo source path
3. Stages only those files
4. Commits with your custom message (or the auto-generated timestamp) and pushes to `origin <branch>`
5. Any unchecked files remain in the vault but are not staged — the bridge stays dirty until they are pushed or the bridge is re-pulled

### What bridges do NOT do

- Clone repos from a URL — the repo must already exist on disk
- Handle merge conflicts — if `git pull` results in a conflict, the error is surfaced and the bridge is marked as errored
- Resolve merge conflicts — if you have pushed vault edits and the remote has also moved on, you'll need to resolve the conflict in the repo via terminal

---

## Editing Bridged Files

Files at the vault destination are real copies, not symlinks. You can edit them directly in Obsidian like any other note.

Workflow for making edits:

1. Edit the file in your vault. The command bar at the top of the file shows a "● N changes ▾" pill as soon as a file is saved — the count updates in real time with each save.
2. Click **↑ Push all** to commit and push every changed file at once, or click the pill to open the popdown and choose which files to include in the commit.

**Overwrite protection:** The plugin tracks file modification times since the last pull. If you try to Pull with unsaved vault edits, a warning modal appears with three options:
- **Push then Pull** — commits your edits and pushes them first, then pulls the latest (the safe path)
- **Pull anyway** — discards your vault edits and overwrites with the repo state
- **Cancel** — does nothing

On startup auto-pull, dirty bridges are skipped entirely with a notice rather than silently overwriting your work.

---

## Managing Multiple Bridges

There's no limit on the number of bridges. Each is synced and pushed independently and can have its own branch, subfolder, and auto-sync setting.

**Recommended layout for multiple bridges:**

```
vault/
  Work/
    Company Handbook/    ← bridge from company-docs repo, docs/ subfolder
    ADRs/                ← bridge from backend-api repo, docs/adr/ subfolder
  Open Source/
    Plugin Notes/        ← bridge from obsidian-plugin repo, notes/ subfolder
```

---

## Plugin Settings

The following global settings are available in **Settings -> Vault Bridges**.

### Sync on startup

When enabled, all bridges with **Auto sync on startup** turned on are pulled automatically each time Obsidian opens. Disable this to manage sync entirely by hand.

### Enable Claude error recovery (`claudeEnabled`)

When enabled, the plugin invokes Claude Code to analyze any git error that occurs during a pull or push. Claude produces a structured fix plan (diagnosis + proposed commands) which is shown in a recovery modal for your review before anything is run. Auth and network errors bypass Claude and show a targeted hint instead.

Default: `true`

### Claude executable path (`claudePath`)

The full filesystem path to the `claude` binary. The plugin calls this executable directly when error recovery is triggered.

Default: `/opt/homebrew/bin/claude`

If Claude Code is installed elsewhere (e.g. via a different package manager or a custom path), update this field to match the output of `which claude` in your terminal.

---

## Coexistence with Obsidian Git

If your vault is itself a Git repo managed by [Obsidian Git](https://github.com/Vinzent03/obsidian-git), add your bridge destination paths to the vault's `.gitignore`. This prevents Obsidian Git from staging and committing the copied files, which would double-track content that is already versioned in its own repo.

Example `.gitignore` entry at your vault root:

```
# Vault Bridges destinations
Work/Company Handbook/
Work/ADRs/
Open Source/Plugin Notes/
```
