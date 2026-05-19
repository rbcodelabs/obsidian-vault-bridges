# Development Guide

Everything you need to build, test, and extend Vault Bridges.

---

## Prerequisites

- Node.js 16+
- npm
- Git
- Obsidian desktop (for live testing)

---

## Setup

```bash
git clone https://github.com/rbcodelabs/obsidian-vault-bridges
cd obsidian-vault-bridges
npm install
```

---

## Project Structure

```
obsidian-vault-bridges/
├── main.ts                  # Plugin entry point — registers commands, settings tab, startup hook
├── src/
│   ├── types.ts             # Bridge and VaultBridgesSettings interfaces + defaults
│   ├── BridgeManager.ts     # Core logic: git pull + file copy + push
│   ├── SettingsTab.ts       # Settings UI — bridge list, add/remove/sync controls
│   ├── AddBridgeModal.ts    # Modal form for adding and editing bridges
│   └── StatusBar.ts         # Status bar item with live bridge count
├── docs/                    # User documentation
├── styles.css               # Plugin CSS
├── manifest.json            # Obsidian plugin manifest
├── package.json
├── tsconfig.json
└── esbuild.config.mjs       # Build configuration
```

---

## Scripts

```bash
# Watch mode — rebuilds main.js on every save
npm run dev

# Type-check only (no build output)
npm run typecheck

# Full production build
npm run build

# Build + copy to vault (update the path in package.json for your vault)
npm run deploy
```

### Setting Up deploy

Edit `package.json` to point at your vault's plugin folder:

```json
"deploy": "npm run build && cp main.js manifest.json styles.css \"/path/to/your/vault/.obsidian/plugins/vault-bridges/\""
```

---

## Development Loop

1. Run `npm run dev` in a terminal (watch mode)
2. In Obsidian: open Settings → Community Plugins, find Vault Bridges, and enable the **"Reload on change"** option if you have the [Hot Reload plugin](https://github.com/pjeby/hot-reload) installed
3. Without Hot Reload: use **Cmd+P → Reload App Without Saving** after each build

The watch mode build writes to `main.js` in the project root. The `deploy` script copies it to the vault.

---

## Architecture

### Plugin Lifecycle (`main.ts`)

`onload()` is Obsidian's entry point. It:
1. Loads saved settings via `loadData()`
2. Instantiates `BridgeManager` and `StatusBarManager`
3. Registers the settings tab
4. Registers commands (including "Push All Bridges")
5. Hooks into `workspace.onLayoutReady()` for startup sync

`onunload()` cleans up (currently just logs; copied files are intentionally left in place).

### BridgeManager (`src/BridgeManager.ts`)

The core class. Responsible for:
- **`syncAll()`** — iterates all bridges and calls `syncBridge()` on each
- **`syncBridge(bridge)`** — runs `gitPull()` then `copyFiles()`; updates status fields
- **`gitPull(bridge)`** — runs `git -C <repoPath> pull origin <branch>` via `child_process`
- **`copyFiles(bridge)`** — removes any legacy symlink at the destination, then copies repo source into the vault using `fs.cpSync` (with a filter that excludes `.git/`); creates parent directories as needed
- **`pushBridge(bridge)`** — copies vault destination back to the repo source, runs `git add -A`, checks `git status --porcelain` to see if there's anything to commit, and if so runs `git commit` followed by `git push`
- **`pushAll()`** — iterates all bridges and calls `pushBridge()` on each
- **`removeLink(bridge)`** — removes the copied directory from the vault with `fs.rmSync({ recursive: true })`; sets status to `unlinked`
- **`rebuildAllLinks()`** — calls `copyFiles()` for every bridge (re-copies all files from repos into the vault; used after vault move or to force a fresh copy)

`vaultBasePath` is a getter that reads the vault's absolute path from Obsidian's internal adapter. This is not a public API but is stable across Obsidian versions.

### SettingsTab (`src/SettingsTab.ts`)

Standard `PluginSettingTab` subclass. `display()` rebuilds the entire UI from settings state each time it's called. Bridge list items use Obsidian's `Setting` component with icon buttons (pull, push, pencil, trash).

### AddBridgeModal (`src/AddBridgeModal.ts`)

Used for both add and edit. When `existingBridge` is passed, it copies the bridge into local state and writes it back by ID on save. Validation ensures name, repoPath, and vaultPath are non-empty before saving.

IDs are generated with `crypto.randomUUID()` (available in Node 14.17+, no dependency needed).

### StatusBarManager (`src/StatusBar.ts`)

Creates a status bar item on construction. `update()` is called after every sync and settings change. Clicking the status bar opens the plugin's settings tab using Obsidian's internal `app.setting` API.

---

## Adding a New Feature

### Example: Add a "clone from URL" option

1. **Add the field to `types.ts`:**
   ```ts
   interface Bridge {
     // ...existing fields...
     remoteUrl?: string;  // if set, plugin will clone here if repoPath doesn't exist
   }
   ```

2. **Handle it in `BridgeManager.gitPull()`:**
   ```ts
   if (!fs.existsSync(bridge.repoPath) && bridge.remoteUrl) {
     await execAsync(`git clone ${bridge.remoteUrl} "${bridge.repoPath}"`);
   }
   ```

3. **Add a field to `AddBridgeModal.ts`:**
   ```ts
   new Setting(contentEl)
     .setName('Remote URL')
     .setDesc('Optional: clone from this URL if the repo doesn\'t exist locally')
     .addText(text =>
       text
         .setPlaceholder('https://github.com/org/repo')
         .setValue(this.bridge.remoteUrl ?? '')
         .onChange(value => { this.bridge.remoteUrl = value.trim(); })
     );
   ```

4. **Update `SettingsTab.descriptionFor()`** if you want the URL shown in the bridge list.

---

## Obsidian API Notes

### `vault.adapter.basePath`
Used to resolve absolute paths for file copy operations. Not officially documented but stable. Accessed via:
```ts
(this.plugin.app.vault.adapter as any).basePath as string
```

### `app.setting.open()` / `openTabById(id)`
Used by the status bar click handler to navigate directly to this plugin's settings tab. Also undocumented but stable.

---

## Publishing to the Obsidian Community Plugins List

To submit this plugin to the official directory:

1. Ensure the plugin passes [Obsidian's plugin review guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
2. Fork [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases)
3. Add an entry to `community-plugins.json`
4. Open a PR — the Obsidian team reviews and merges

The main review concerns for this plugin are the use of `child_process` (permitted for desktop plugins), filesystem access (permitted), and the undocumented `basePath` API (may require a comment explaining the approach).

---

## Questions / Contributing

Open an issue on GitHub before starting significant work so we can discuss the approach. PRs are welcome for bug fixes, and well-scoped features.
