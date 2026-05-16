# Getting Started

This guide walks you through installing Vault Bridges and setting up your first bridge from scratch.

---

## Prerequisites

- **Obsidian** 0.15.0 or later (desktop only)
- **Git** installed and accessible from your terminal — run `git --version` to verify
- At least one Git repo cloned locally on your machine

Vault Bridges does not clone repos for you. It assumes the repo already exists on disk and manages the connection from there.

### Optional: Claude Code Integration

Vault Bridges can use [Claude Code](https://claude.ai/code) to automatically diagnose git errors and propose fixes. This is optional -- the plugin works without it -- but highly recommended for anyone who encounters merge conflicts or push rejections.

**Prerequisite:** Claude Code must be installed and accessible from your terminal:

```bash
claude --version
```

If that command works, you're set. The plugin looks for the `claude` binary at `/opt/homebrew/bin/claude` by default. If yours is elsewhere, update the path in **Settings -> Vault Bridges -> Claude executable path**.

---

## Step 1: Install the Plugin

### Via BRAT (easiest for beta)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from the Obsidian community plugins list
2. Open **Settings → BRAT → Add Beta Plugin**
3. Enter `richardbowman/obsidian-vault-bridges`
4. Enable **Vault Bridges** in **Settings → Community Plugins**

### Manual Install

1. Download `main.js`, `manifest.json`, `styles.css` from the latest [GitHub release](https://github.com/richardbowman/obsidian-vault-bridges/releases)
2. In your vault, create the folder: `.obsidian/plugins/vault-bridges/`
3. Copy the three files into that folder
4. Restart Obsidian
5. Go to **Settings → Community Plugins** and enable **Vault Bridges**

---

## Step 2: Add Your First Bridge

1. Open **Settings → Vault Bridges**
2. Click **+ Add Bridge**

![Add Bridge modal](../docs/screenshot-add-bridge.png)

3. Fill in the form:

**Name**
A label you'll recognize — e.g. `Work Docs`, `Team Wiki`, `My Project ADRs`.

**Local repo path**
The absolute path to the Git repo on your machine. This is the folder that contains `.git/`.

Examples:
- macOS/Linux: `/Users/you/projects/company-handbook`
- Windows: `C:\Users\you\projects\company-handbook`

**Source subfolder** *(optional)*
If you only want part of the repo, enter the subfolder path relative to the repo root. Leave blank to copy the entire repo.

Examples:
- `docs` — copies just the `docs/` folder
- `docs/architecture` — copies a nested subfolder
- *(blank)* — copies the entire repo root

**Vault destination path**
Where inside your vault the files will appear. This is a path relative to your vault root.

Examples:
- `Work/Docs`
- `References/Company Handbook`
- `Projects/My App/ADRs`

**Branch**
The Git branch to pull from. Defaults to `main`.

**Auto sync on startup**
If enabled, this bridge will be pulled automatically every time Obsidian opens (subject to the global "Sync on startup" setting also being on).

4. Click **Add Bridge** — the plugin runs a Pull immediately: it does a `git pull` on the repo, then copies the files into your vault.

Your files now appear inside Obsidian at the vault destination path you specified. They are real files — fully indexed and searchable via Cmd+Shift+F right away.

---

![Settings panel after adding bridges](../docs/screenshot-settings.png)

## Step 3: Verify It's Working

After adding the bridge:

- Navigate to the vault destination path in Obsidian's file explorer — your repo files should be there
- Search for a term you know is in those files (Cmd+Shift+F) — they should appear in results immediately
- Check the status bar at the bottom of the screen — you should see `⇅ 1 bridge ✓`

If you see ❌ in the status bar, open **Settings → Vault Bridges** — the error message will be shown next to the bridge.

If you see ❌ in the status bar and Claude Code integration is enabled, you may see a "Analyzing git error with Claude..." notice followed by a recovery modal. This is normal -- Claude will diagnose the error and propose concrete git commands to fix it. Review the plan carefully before approving, especially any steps marked [DESTRUCTIVE].

---

## Step 4: Edit and Sync

Vault Bridges is bidirectional. Once your bridge is set up, the workflow is:

**To get the latest changes from the remote repo:**
Click the **⬇ Pull** button next to the bridge. The plugin runs `git pull` on the repo and re-copies the updated files into the vault.

**To edit files and push changes back:**
Edit files in Obsidian as you normally would. When you're ready to commit and push, click the **⬆ Push** button. The plugin copies your edits back to the repo, auto-commits with a timestamped message, and pushes to the remote.

---

## Next Steps

- [Bridges Reference](bridges.md) — detailed explanation of every field and behavior
- [Use Cases](use-cases.md) — common setups and real-world examples
- [Troubleshooting](troubleshooting.md) — fixes for common problems
