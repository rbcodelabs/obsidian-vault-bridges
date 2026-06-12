import { exec } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as fs from 'fs';
import * as path from 'path';
import { Notice } from 'obsidian';
import type VaultBridgesPlugin from '../main';
import type { Bridge, ChangedFile, GitDiagnostics, WorktreeInfo } from './types';
import { DirtyWarningModal } from './DirtyWarningModal';
import { classifyGitError } from './GitErrorClassifier';
import { ClaudeGitSession } from './ClaudeGitSession';
import { ConflictResolutionModal } from './ConflictResolutionModal';

export const execAsync = promisify(exec);

/**
 * A PATH-extended env object that includes Homebrew and common tool directories.
 * Obsidian is launched as a macOS .app bundle and does not inherit the user's
 * shell PATH, so `gh`, `git`, and other CLI tools installed via Homebrew are
 * not found unless we add their directories explicitly.
 */
const SHELL_ENV: NodeJS.ProcessEnv = {
	...process.env,
	PATH: [
		'/opt/homebrew/bin',   // Apple-silicon Homebrew
		'/usr/local/bin',      // Intel Homebrew / custom installs
		'/usr/bin',
		'/bin',
		process.env.PATH ?? '',
	]
		.filter(Boolean)
		.join(':'),
};

function hashFile(filePath: string): string {
	return createHash('sha1').update(readFileSync(filePath)).digest('hex');
}

/** Escape a string for safe interpolation inside a double-quoted shell argument. */
function shellEsc(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

export class BridgeManager {
	constructor(private plugin: VaultBridgesPlugin) {}

	get vaultBasePath(): string {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return (this.plugin.app.vault.adapter as any).basePath as string;
	}

	/**
	 * Re-renders the settings tab if it is currently open. Guards with
	 * isConnected so nothing is done when the settings modal is closed.
	 */
	private refreshSettingsTab(): void {
		const tab = this.plugin.settingsTab;
		if (tab?.containerEl.isConnected) {
			tab.display();
		}
	}

	/**
	 * Notify all UI surfaces (file command bar + sidebar) to re-render.
	 * Centralised here so adding a new surface only requires one edit.
	 */
	private notifyUI(): void {
		this.plugin.fileCommandBar?.update();
		this.plugin.sidebarView?.update();
	}

	// ─── Worktrees ────────────────────────────────────────────────────────────

	/**
	 * The repo path all git and file operations should target: the active
	 * worktree when one is set, otherwise the main repo checkout.
	 */
	effectiveRepoPath(bridge: Bridge): string {
		return bridge.activeWorktreePath ?? bridge.repoPath;
	}

	/** Resolve symlinks so paths compare equal (e.g. /var vs /private/var on macOS). */
	private resolvePath(p: string): string {
		try {
			return fs.realpathSync(p);
		} catch {
			return p;
		}
	}

	/**
	 * Returns true when the effective repo path (main checkout or active worktree)
	 * has uncommitted changes according to `git status --porcelain`. Non-fatal:
	 * returns false if the git command itself fails (e.g. not a git repo yet).
	 */
	async hasGitDirtyState(bridge: Bridge): Promise<boolean> {
		const repoPath = this.effectiveRepoPath(bridge);
		try {
			const { stdout } = await execAsync(
				`git -C "${shellEsc(repoPath)}" status --porcelain`,
				{ timeout: 10000 }
			);
			return stdout.trim().length > 0;
		} catch {
			return false;
		}
	}

	/**
	 * Stash uncommitted repo-side changes in the current worktree, switch to the
	 * target, and pop the stash there so the in-progress edits land on the
	 * intended branch.
	 *
	 * Git stashes are repo-wide (stored in `.git/refs/stash`), so a stash created
	 * in any linked worktree can be popped in any other worktree of the same repo.
	 *
	 * Error handling:
	 * - Stash push failure: shows a Notice and aborts (no switch happens).
	 * - Stash pop failure (conflict): shows a Notice, but the switch is kept — the
	 *   stash entry remains and the user can resolve it manually.
	 */
	async stashAndSwitch(bridge: Bridge, worktreePath: string | null): Promise<void> {
		const sourceRepoPath = this.effectiveRepoPath(bridge);

		// 1. Stash changes in the current worktree/checkout.
		let didStash = false;
		try {
			const { stdout } = await execAsync(
				`git -C "${shellEsc(sourceRepoPath)}" stash push --include-untracked -m "vault-bridges stash-and-switch"`,
				{ timeout: 15000 }
			);
			didStash = !stdout.trim().startsWith('No local changes');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Vault Bridges: "${bridge.name}" — stash failed: ${msg}`, 10000);
			return;
		}

		// 2. Switch to the target (force=true so dirty checks are bypassed).
		await this.switchWorktree(bridge, worktreePath, true);

		// 3. Pop the stash in the destination so the edits land there.
		if (didStash) {
			const destRepoPath = this.effectiveRepoPath(bridge); // now the new worktree
			try {
				await execAsync(
					`git -C "${shellEsc(destRepoPath)}" stash pop`,
					{ timeout: 15000 }
				);
				new Notice(
					`Vault Bridges: ✓ "${bridge.name}" — stashed changes reapplied to "${bridge.activeWorktreeBranch ?? bridge.branch}"`,
					6000
				);
			} catch (err) {
				new Notice(
					`Vault Bridges: "${bridge.name}" — switched but stash pop failed. ` +
					`Resolve the conflict manually in: ${destRepoPath}`,
					12000
				);
				console.error(`Vault Bridges: stash pop failed after switch for "${bridge.name}":`, err);
			}
		}
	}

	/**
	 * Lists all worktrees of the bridge's repo via `git worktree list --porcelain`.
	 * The first entry is always the main checkout.
	 */
	async listWorktrees(bridge: Bridge): Promise<WorktreeInfo[]> {
		const { stdout } = await execAsync(
			`git -C "${shellEsc(bridge.repoPath)}" worktree list --porcelain`,
			{ timeout: 10000 }
		);

		const activeResolved = this.resolvePath(this.effectiveRepoPath(bridge));

		return stdout
			.trim()
			.split(/\n\n+/)
			.map((block, i): WorktreeInfo | null => {
				const lines = block.split('\n');
				const pathLine = lines.find(l => l.startsWith('worktree '));
				if (!pathLine) return null;
				const wtPath = pathLine.slice('worktree '.length).trim();
				const branchLine = lines.find(l => l.startsWith('branch '));
				const branch = branchLine
					? branchLine.slice('branch '.length).replace(/^refs\/heads\//, '').trim()
					: '';
				return {
					path: wtPath,
					branch,
					isMain: i === 0,
					isActive: this.resolvePath(wtPath) === activeResolved,
				};
			})
			.filter((w): w is WorktreeInfo => w !== null);
	}

	/**
	 * Resolves the branch that pull/push should target.
	 *
	 * - With an active worktree: the worktree's checked-out branch (cached on the
	 *   bridge). Throws on a detached HEAD.
	 * - Without a worktree: the branch the *main checkout* is actually on. When
	 *   that differs from the configured `bridge.branch` (e.g. the repo is parked
	 *   on a feature branch instead of `main`), following the checked-out branch
	 *   keeps the vault in sync with the work in progress and avoids a doomed
	 *   cross-branch pull that aborts with "need to reconcile divergent branches".
	 *   Falls back to the configured branch on a detached HEAD or any git error.
	 */
	async refreshWorktreeBranch(bridge: Bridge): Promise<string> {
		if (!bridge.activeWorktreePath) {
			try {
				const { stdout } = await execAsync(
					`git -C "${shellEsc(bridge.repoPath)}" rev-parse --abbrev-ref HEAD`,
					{ timeout: 10000 }
				);
				const head = stdout.trim();
				// A detached HEAD has no branch to follow — pull the configured one.
				if (!head || head === 'HEAD') return bridge.branch;
				return head;
			} catch {
				// Repo unreadable here; let the configured branch drive and surface
				// any real error downstream in the pull/push itself.
				return bridge.branch;
			}
		}

		const { stdout } = await execAsync(
			`git -C "${shellEsc(bridge.activeWorktreePath)}" rev-parse --abbrev-ref HEAD`,
			{ timeout: 10000 }
		);
		const branch = stdout.trim();
		if (!branch || branch === 'HEAD') {
			throw new Error(`Worktree is on a detached HEAD: ${bridge.activeWorktreePath}`);
		}
		bridge.activeWorktreeBranch = branch;
		return branch;
	}

	/**
	 * True when `origin` actually has a branch named `branch`.
	 *
	 * This is the right gate for "is there anything to pull over the network?" —
	 * checking for an upstream tracking ref is not enough: a worktree branch
	 * created from `main` often inherits `@{u} = origin/main`, so it *has* an
	 * upstream yet `git pull origin <branch>` still fails with
	 * `couldn't find remote ref <branch>` because origin has no branch by that
	 * name. Asking the remote directly avoids that false positive.
	 *
	 * When `ls-remote` itself fails (offline, auth error, no `origin` remote) we
	 * can't confirm the branch exists, so we return `false` — the caller then
	 * operates on the local checkout instead of hard-failing the sync.
	 */
	private async remoteBranchExists(repoPath: string, branch: string): Promise<boolean> {
		try {
			const { stdout } = await execAsync(
				`git -C "${shellEsc(repoPath)}" ls-remote --heads origin "${branch}"`,
				{ timeout: 15000 }
			);
			return stdout.trim().length > 0;
		} catch (err) {
			console.warn(
				`Vault Bridges: ls-remote failed for branch "${branch}" in ${repoPath}; ` +
				`treating it as local-only and skipping the network pull.`,
				err
			);
			return false;
		}
	}

	/**
	 * Points the bridge at a different worktree (or back at the main repo when
	 * `worktreePath` is null) and re-pulls so the vault copy reflects the newly
	 * selected checkout. If the vault copy has unsaved edits, or the repo itself
	 * has uncommitted changes, the dirty-warning modal is shown first so the user
	 * can choose how to handle them (unless `force` is true).
	 */
	async switchWorktree(bridge: Bridge, worktreePath: string | null, force = false): Promise<void> {
		if (!force) {
			const vaultDirty = this.checkDirty(bridge);
			const gitDirty = await this.hasGitDirtyState(bridge);

			if (vaultDirty || gitDirty) {
				if (vaultDirty) {
					bridge.isDirty = true;
					await this.plugin.saveSettings();
				}

				let body: string;
				if (vaultDirty && gitDirty) {
					body =
						`"${bridge.name}" has vault edits and uncommitted repo changes. ` +
						`Push the vault edits first to preserve them, or use "Stash & Switch" to carry ` +
						`the repo changes to the target worktree. "Switch anyway" discards both.`;
				} else if (vaultDirty) {
					body =
						`"${bridge.name}" has vault edits that haven't been pushed yet. ` +
						`Switching worktrees will overwrite those edits with the selected checkout's state.`;
				} else {
					body =
						`"${bridge.name}" has uncommitted changes in the repo. ` +
						`Use "Stash & Switch" to carry them to the target worktree, ` +
						`or "Switch anyway" to leave them behind.`;
				}

				new DirtyWarningModal(this.plugin.app, bridge, {
					...(vaultDirty ? {
						onPushThenPull: async () => {
							await this.pushBridge(bridge);
							await this.switchWorktree(bridge, worktreePath, true);
						},
					} : {}),
					onPullAnyway: async () => {
						await this.switchWorktree(bridge, worktreePath, true);
					},
					...(gitDirty ? {
						onStashAndSwitch: async () => {
							await this.stashAndSwitch(bridge, worktreePath);
						},
					} : {}),
				}, {
					body,
					primary: vaultDirty ? 'Push then Switch' : undefined,
					warning: 'Switch anyway',
				}).open();
				return;
			}
		}

		if (worktreePath) {
			const worktrees = await this.listWorktrees(bridge);
			const resolved = this.resolvePath(worktreePath);
			const match = worktrees.find(w => this.resolvePath(w.path) === resolved);
			if (!match) {
				throw new Error(`Not a linked worktree of ${bridge.repoPath}: ${worktreePath}`);
			}
			if (match.isMain) {
				// Selecting the main checkout is the same as clearing the override
				worktreePath = null;
			} else {
				bridge.activeWorktreePath = match.path;
				bridge.activeWorktreeBranch = match.branch || undefined;
			}
		}
		if (!worktreePath) {
			bridge.activeWorktreePath = undefined;
			bridge.activeWorktreeBranch = undefined;
		}

		await this.plugin.saveSettings();
		const target = bridge.activeWorktreePath
			? `worktree "${bridge.activeWorktreeBranch ?? bridge.activeWorktreePath}"`
			: `main repo (${bridge.branch})`;
		new Notice(`Vault Bridges: "${bridge.name}" now tracking ${target} — re-pulling…`);

		// Announce the switch so other plugins (e.g. Claude Threads) can keep
		// their own state in sync. Payload: WorktreeSwitchedEvent. Optional-
		// chained because test harnesses stub workspace as a bare object.
		(this.plugin.app.workspace as unknown as {
			trigger?: (name: string, payload: import('./types').WorktreeSwitchedEvent) => void;
		}).trigger?.('vault-bridges:worktree-switched', {
			bridgeId: bridge.id,
			bridgeName: bridge.name,
			repoPath: bridge.repoPath,
			worktreePath: bridge.activeWorktreePath ?? null,
			branch: bridge.activeWorktreeBranch ?? bridge.branch,
		});

		// Forced re-pull: copies the selected checkout into the vault and
		// rebuilds the manifest so dirty tracking is relative to the new base.
		await this.syncBridge(bridge, true);
	}

	// ─── Manifest / dirty tracking ────────────────────────────────────────────

	private buildManifest(basePath: string, currentPath: string): Record<string, string> {
		const manifest: Record<string, string> = {};
		if (!fs.existsSync(currentPath)) return manifest;

		const entries = fs.readdirSync(currentPath, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(currentPath, entry.name);
			if (entry.isDirectory()) {
				Object.assign(manifest, this.buildManifest(basePath, fullPath));
			} else if (entry.isFile()) {
				const relPath = path.relative(basePath, fullPath);
				manifest[relPath] = hashFile(fullPath);
			}
		}
		return manifest;
	}

	private recordManifest(bridge: Bridge): void {
		const destPath = path.join(this.vaultBasePath, bridge.vaultPath);
		bridge.fileManifest = this.buildManifest(destPath, destPath);
		bridge.isDirty = false;
	}

	onVaultFileModified(filePath: string): void {
		let anyBridgeFile = false;
		let anyChanged = false;
		for (const bridge of this.plugin.settings.bridges) {
			if (!bridge.fileManifest) continue;
			// Check if the modified file is inside this bridge's vault path
			if (!filePath.startsWith(bridge.vaultPath + '/') && filePath !== bridge.vaultPath) continue;
			anyBridgeFile = true;
			const isDirty = this.checkDirty(bridge);
			if (bridge.isDirty !== isDirty) {
				bridge.isDirty = isDirty;
				anyChanged = true;
			}
		}
		// Always re-render the command bar for any bridge file change so the
		// pending-changes count stays current even when isDirty was already true.
		if (anyBridgeFile) {
			this.notifyUI();
		}
		// Only persist settings when the dirty flag actually flipped (avoids
		// excessive writes on every keystroke).
		if (anyChanged) {
			this.plugin.saveSettings();
			this.plugin.statusBar.update();
		}
	}

	checkDirty(bridge: Bridge): boolean {
		if (!bridge.fileManifest || Object.keys(bridge.fileManifest).length === 0) return false;

		const destPath = path.join(this.vaultBasePath, bridge.vaultPath);
		if (!fs.existsSync(destPath)) return false;

		const current = this.buildManifest(destPath, destPath);

		// Check for modified or new files
		for (const [relPath, hash] of Object.entries(current)) {
			if (bridge.fileManifest[relPath] !== hash) return true;
		}
		// Check for deleted files
		for (const relPath of Object.keys(bridge.fileManifest)) {
			if (!(relPath in current)) return true;
		}
		return false;
	}

	/**
	 * Returns the full list of files that differ from the last recorded manifest.
	 * Each entry carries a status: 'modified', 'added', or 'deleted'.
	 * Returns [] when the bridge has no manifest yet.
	 */
	getChangedFiles(bridge: Bridge): ChangedFile[] {
		if (!bridge.fileManifest) return [];

		const destPath = path.join(this.vaultBasePath, bridge.vaultPath);
		if (!fs.existsSync(destPath)) return [];

		const current = this.buildManifest(destPath, destPath);
		const changes: ChangedFile[] = [];

		for (const [relPath, hash] of Object.entries(current)) {
			if (!(relPath in bridge.fileManifest)) {
				changes.push({ relPath, status: 'added' });
			} else if (bridge.fileManifest[relPath] !== hash) {
				changes.push({ relPath, status: 'modified' });
			}
		}
		for (const relPath of Object.keys(bridge.fileManifest)) {
			if (!(relPath in current)) {
				changes.push({ relPath, status: 'deleted' });
			}
		}

		return changes.sort((a, b) => a.relPath.localeCompare(b.relPath));
	}

	async gatherDiagnostics(repoPath: string, errorText: string, operation: 'pull' | 'push'): Promise<GitDiagnostics> {
		const errorType = classifyGitError(errorText);
		const run = async (cmd: string): Promise<string> => {
			try {
				const { stdout } = await execAsync(cmd, { timeout: 10000 });
				return stdout.trim();
			} catch {
				return '';
			}
		};
		const [gitStatus, gitLog, gitDiff] = await Promise.all([
			run(`git -C "${repoPath}" status`),
			run(`git -C "${repoPath}" log --oneline -5`),
			run(`git -C "${repoPath}" diff --name-only`),
		]);
		return { errorText, repoPath, errorType, gitStatus, gitLog, gitDiff, operation };
	}

	async triggerClaudeRecovery(bridge: Bridge, errorText: string, operation: 'pull' | 'push'): Promise<void> {
		const { claudePath, claudeEnabled } = this.plugin.settings;
		if (!claudeEnabled || !claudePath) return;

		const diag = await this.gatherDiagnostics(this.effectiveRepoPath(bridge), errorText, operation);

		// For well-understood errors, a targeted hint is more useful than Claude analysis
		if (diag.errorType === 'auth_failure') {
			new Notice('Vault Bridges: Auth error — run `ssh-add` or check your git credentials, then try again.', 10000);
			return;
		}
		if (diag.errorType === 'network_error') {
			new Notice('Vault Bridges: Network error — check your internet connection and the remote URL, then try again.', 10000);
			return;
		}
		if (diag.errorType === 'repo_dirty') {
			new Notice(
				`Vault Bridges: "${bridge.name}" — the repo has uncommitted changes blocking the pull. ` +
				`Run \`git stash\` in ${this.effectiveRepoPath(bridge)} then try again.`,
				12000
			);
			return;
		}

		new Notice(`Vault Bridges: Analyzing git error with Claude…`, 4000);

		try {
			const session = new ClaudeGitSession(claudePath);
			const plan = await session.analyzeFix(diag);

			new ConflictResolutionModal(this.plugin.app, bridge, plan, {
				onApprove: async () => {
					await this.executePlan(bridge, plan.steps, operation);
				},
				onReject: () => {
					new Notice(`Vault Bridges: Fix rejected — "${bridge.name}" remains in error state.`);
				},
			}).open();
		} catch (err) {
			console.error('Vault Bridges: Claude recovery failed:', err);
			new Notice(`Vault Bridges: Claude analysis failed — ${err instanceof Error ? err.message : String(err)}`, 8000);
		}
	}

	async executePlan(bridge: Bridge, steps: import('./types').GitFixStep[], operation: 'pull' | 'push'): Promise<void> {
		new Notice(`Vault Bridges: Running fix for "${bridge.name}"…`);

		for (const step of steps) {
			try {
				const { stdout, stderr } = await execAsync(step.command, { timeout: 30000 });
				console.log(`Vault Bridges: Step "${step.description}" OK:`, stdout || stderr);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				bridge.status = 'error';
				bridge.lastError = `Fix step failed: ${msg}`;
				await this.plugin.saveSettings();
				this.plugin.statusBar.update();
				this.notifyUI();
				new Notice(`Vault Bridges: Fix step failed — "${step.description}": ${msg}`, 10000);
				return;
			}
		}

		new Notice(`Vault Bridges: Fix applied — retrying ${operation} for "${bridge.name}"…`);

		// Re-run original operation
		if (operation === 'pull') {
			await this.syncBridge(bridge, true);
		} else {
			await this.pushBridge(bridge);
		}
	}

	// ─── Sync (pull) ──────────────────────────────────────────────────────────

	async syncAll(): Promise<void> {
		const { bridges } = this.plugin.settings;
		if (bridges.length === 0) {
			new Notice('Vault Bridges: No bridges configured.');
			return;
		}

		new Notice(`Vault Bridges: Syncing ${bridges.length} bridge${bridges.length > 1 ? 's' : ''}…`);

		for (const bridge of bridges) {
			await this.syncBridge(bridge);
		}

		await this.plugin.saveSettings();
		this.plugin.statusBar.update();
		this.plugin.fileCommandBar?.update();
		new Notice('Vault Bridges: All bridges synced ✓');
	}

	async syncOnStartup(): Promise<void> {
		if (!this.plugin.settings.syncOnStartup) return;
		const autoBridges = this.plugin.settings.bridges.filter(b => b.autoSync);
		if (autoBridges.length === 0) return;

		for (const bridge of autoBridges) {
			if (this.checkDirty(bridge)) {
				bridge.isDirty = true;
				new Notice(
					`Vault Bridges: ⚠️ "${bridge.name}" has unsaved edits — skipping auto-pull. Open Settings to push or pull manually.`,
					8000
				);
				continue;
			}
			await this.syncBridge(bridge, true);
		}
		await this.plugin.saveSettings();
		this.plugin.statusBar.update();
		this.plugin.fileCommandBar?.update();
	}

	async syncBridge(bridge: Bridge, force = false): Promise<void> {
		// Warn if vault has edits since last pull (skip check when forced)
		if (!force && this.checkDirty(bridge)) {
			bridge.isDirty = true;
			await this.plugin.saveSettings();
			new DirtyWarningModal(this.plugin.app, bridge, {
				onPushThenPull: async () => {
					await this.pushBridge(bridge);
					await this.syncBridge(bridge, true);
				},
				onPullAnyway: async () => {
					await this.syncBridge(bridge, true);
				},
			}).open();
			return;
		}

		bridge.status = 'syncing';
		this.plugin.statusBar.update();
		this.plugin.fileCommandBar?.update();

		try {
			await this.gitPull(bridge);
			await this.copyFiles(bridge);
			this.recordManifest(bridge);

			bridge.status = 'ok';
			bridge.isDirty = false;
			bridge.lastPulled = new Date().toISOString();
			bridge.lastSynced = bridge.lastPulled;
			bridge.lastError = undefined;
			bridge.lastPrUrl = undefined; // PR was merged; clear the pending-PR indicator
		} catch (err) {
			bridge.status = 'error';
			bridge.lastError = err instanceof Error ? err.message : String(err);
			console.error(`Vault Bridges: Error syncing "${bridge.name}":`, err);
			new Notice(`Vault Bridges: ❌ "${bridge.name}" — ${bridge.lastError}`, 8000);
			// Fire-and-forget Claude recovery (does not block the finally block)
			if (this.plugin.settings.claudeEnabled) {
				this.triggerClaudeRecovery(bridge, bridge.lastError, 'pull').catch(e =>
					console.error('Vault Bridges: Recovery trigger failed:', e)
				);
			}
		} finally {
			await this.plugin.saveSettings();
			this.plugin.statusBar.update();
			this.notifyUI();
			this.refreshSettingsTab();
		}
	}

	private async gitPull(bridge: Bridge): Promise<void> {
		const repoPath = this.effectiveRepoPath(bridge);
		if (!fs.existsSync(repoPath)) {
			throw new Error(`Repo path does not exist: ${repoPath}`);
		}

		// In a linked worktree `.git` is a file (a pointer), not a directory —
		// existsSync covers both cases.
		const gitDir = path.join(repoPath, '.git');
		if (!fs.existsSync(gitDir)) {
			throw new Error(`Not a git repository: ${repoPath}`);
		}

		// The pull target is whatever branch the checkout (worktree or main repo)
		// is actually on, not the configured bridge branch.
		const branch = await this.refreshWorktreeBranch(bridge);

		// Validate branch contains no shell metacharacters before interpolation
		if (!/^[a-zA-Z0-9._\-/]+$/.test(branch)) {
			throw new Error(`Invalid branch name: "${branch}"`);
		}

		// The main checkout is parked on a branch other than the configured one
		// (no worktree pinned). We follow the checked-out branch rather than
		// attempting a cross-branch pull. Surface it so the override is visible.
		const followingCheckout = !bridge.activeWorktreePath && branch !== bridge.branch;
		if (followingCheckout) {
			new Notice(
				`Vault Bridges: "${bridge.name}" — repo is on "${branch}", not the configured "${bridge.branch}". ` +
				`Following the checked-out branch.`,
				8000
			);
			console.log(
				`Vault Bridges: "${bridge.name}" — following checked-out branch "${branch}" ` +
				`instead of configured "${bridge.branch}".`
			);
		}

		// Auto-stash any uncommitted repo-side changes so the pull can proceed.
		// This handles "cannot pull with rebase: You have unstaged changes" — a common
		// case when files were edited directly in the repo outside of Obsidian.
		let stashed = false;
		try {
			const { stdout: statusOut } = await execAsync(
				`git -C "${repoPath}" status --porcelain`,
				{ timeout: 10000 }
			);
			if (statusOut.trim().length > 0) {
				const { stdout: stashOut } = await execAsync(
					`git -C "${repoPath}" stash push --include-untracked -m "vault-bridges auto-stash"`,
					{ timeout: 15000 }
				);
				stashed = !stashOut.trim().startsWith('No local changes');
			}
		} catch (stashCheckErr) {
			// Non-fatal: if the stash check/push fails, proceed with the pull anyway
			console.warn(`Vault Bridges: auto-stash check failed for "${bridge.name}":`, stashCheckErr);
		}

		// A worktree branch — or a main checkout parked on a feature branch — is
		// often local-only: it exists on disk but was never pushed, so origin has
		// no ref for it. Pulling it would fail with `couldn't find remote ref`, so
		// we pull over the network only when origin actually has the branch and
		// otherwise just copy the checkout into the vault. The configured-branch
		// case keeps pulling unconditionally.
		const skipNetworkPull = (bridge.activeWorktreePath || followingCheckout)
			? !(await this.remoteBranchExists(repoPath, branch))
			: false;

		if (skipNetworkPull) {
			console.log(
				`Vault Bridges: "${bridge.name}" — branch "${branch}" is not on origin; skipping network pull.`
			);
		} else {
			try {
				const { stdout, stderr } = await execAsync(
					`git -C "${repoPath}" pull origin "${branch}"`,
					{ timeout: 30000 }
				);
				console.log(`Vault Bridges: Pulled "${bridge.name}":`, stdout || stderr);
			} catch (err) {
				// Restore stash on pull failure so no work is lost
				if (stashed) {
					await execAsync(
						`git -C "${repoPath}" stash pop`,
						{ timeout: 15000 }
					).catch(popErr =>
						console.warn(`Vault Bridges: stash pop after failed pull for "${bridge.name}":`, popErr)
					);
				}
				throw new Error(`git pull failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		// Restore stashed changes after a successful pull
		if (stashed) {
			try {
				await execAsync(
					`git -C "${repoPath}" stash pop`,
					{ timeout: 15000 }
				);
			} catch (stashPopErr) {
				// Pull succeeded but stash pop hit a conflict — warn without failing the sync
				new Notice(
					`Vault Bridges: "${bridge.name}" — pull succeeded but stash pop failed. ` +
					`Resolve the conflict manually in: ${repoPath}`,
					12000
				);
				console.error(`Vault Bridges: stash pop failed for "${bridge.name}":`, stashPopErr);
			}
		}
	}

	async copyFiles(bridge: Bridge): Promise<void> {
		const repoPath = this.effectiveRepoPath(bridge);
		const sourcePath = bridge.sourcePath
			? path.join(repoPath, bridge.sourcePath)
			: repoPath;

		const destPath = path.join(this.vaultBasePath, bridge.vaultPath);

		if (!fs.existsSync(sourcePath)) {
			throw new Error(`Source path does not exist: ${sourcePath}`);
		}

		// Ensure parent directory exists
		const destParent = path.dirname(destPath);
		if (!fs.existsSync(destParent)) {
			fs.mkdirSync(destParent, { recursive: true });
		}

		// If destination is a legacy symlink, remove it before copying
		if (this.isSymlink(destPath)) {
			fs.unlinkSync(destPath);
		}

		const stat = fs.statSync(sourcePath);
		if (stat.isDirectory()) {
			fs.cpSync(sourcePath, destPath, {
				recursive: true,
				force: true,
				preserveTimestamps: true,
				filter: (src: string) => path.basename(src) !== '.git',
			});
		} else {
			fs.copyFileSync(sourcePath, destPath);
		}
	}

	private isSymlink(p: string): boolean {
		try {
			return fs.lstatSync(p).isSymbolicLink();
		} catch {
			return false;
		}
	}

	async removeLink(bridge: Bridge): Promise<void> {
		const destPath = path.join(this.vaultBasePath, bridge.vaultPath);
		if (this.isSymlink(destPath)) {
			fs.unlinkSync(destPath);
		} else if (fs.existsSync(destPath)) {
			fs.rmSync(destPath, { recursive: true, force: true });
		}
		bridge.status = 'unlinked';
	}

	async rebuildAllLinks(): Promise<void> {
		for (const bridge of this.plugin.settings.bridges) {
			try {
				await this.copyFiles(bridge);
				this.recordManifest(bridge);
			} catch (err) {
				console.error(`Vault Bridges: Failed to rebuild copy for "${bridge.name}":`, err);
			}
		}
		await this.plugin.saveSettings();
		new Notice('Vault Bridges: All copies rebuilt ✓');
	}

	// ─── Push ─────────────────────────────────────────────────────────────────

	async pushAll(): Promise<void> {
		const { bridges } = this.plugin.settings;
		if (bridges.length === 0) {
			new Notice('Vault Bridges: No bridges configured.');
			return;
		}
		new Notice(`Vault Bridges: Pushing ${bridges.length} bridge${bridges.length > 1 ? 's' : ''}…`);
		for (const bridge of bridges) {
			await this.pushBridge(bridge);
		}
		await this.plugin.saveSettings();
		this.plugin.statusBar.update();
		this.plugin.fileCommandBar?.update();
		new Notice('Vault Bridges: All bridges pushed ✓');
	}

	/**
	 * Push vault changes back to the git repo and push to remote.
	 *
	 * When `bridge.prMode` is true the push is done via a feature branch and
	 * a GitHub PR is opened with `gh pr create` instead of pushing directly to
	 * `bridge.branch`.  The repo is left on `bridge.branch` after the call.
	 *
	 * @param bridge         - The bridge to push.
	 * @param commitMessage  - Optional commit message / PR title; auto-generated if omitted.
	 * @param selectedFiles  - When provided, only these files (and their statuses)
	 *                         are copied/removed and staged. Omit for a full push.
	 */
	async pushBridge(
		bridge: Bridge,
		commitMessage?: string,
		selectedFiles?: ChangedFile[]
	): Promise<void> {
		bridge.status = 'syncing';
		this.plugin.statusBar.update();
		this.plugin.fileCommandBar?.update();

		// Tracks the feature branch name when prMode creates one, so we can
		// clean it up on error.
		let prBranch: string | undefined;

		const repoPath = this.effectiveRepoPath(bridge);
		const onWorktree = !!bridge.activeWorktreePath;

		try {
			// On a worktree the commit/push target is the worktree's checked-out
			// branch, not the configured bridge branch.
			const targetBranch = await this.refreshWorktreeBranch(bridge);

			// Validate branch
			if (!/^[a-zA-Z0-9._\-/]+$/.test(targetBranch)) {
				throw new Error(`Invalid branch name: "${targetBranch}"`);
			}

			// PR mode: fetch origin and create a fresh feature branch BEFORE
			// touching any files so the working tree is based on the latest remote.
			//
			// Skipped while a worktree is active: git refuses to check out a branch
			// already checked out elsewhere, and the worktree branch *is* the
			// feature branch — pushing it directly is the natural PR flow.
			if (bridge.prMode && onWorktree) {
				new Notice(
					`Vault Bridges: "${bridge.name}" — PR mode is bypassed while a worktree is active; pushing directly to "${targetBranch}".`,
					8000
				);
			}
			if (bridge.prMode && !onWorktree) {
				await execAsync(
					`git -C "${bridge.repoPath}" fetch origin "${bridge.branch}"`,
					{ timeout: 30000 }
				);
				const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
				prBranch = `vault-update/${ts}`;
				await execAsync(
					`git -C "${bridge.repoPath}" checkout -b "${prBranch}" "origin/${bridge.branch}"`,
					{ timeout: 15000 }
				);
			}

			const sourcePath = bridge.sourcePath
				? path.join(repoPath, bridge.sourcePath)
				: repoPath;
			const vaultPath = path.join(this.vaultBasePath, bridge.vaultPath);

			if (!fs.existsSync(vaultPath)) {
				throw new Error(`Vault path does not exist: ${vaultPath}. Run a pull sync first.`);
			}

			if (selectedFiles && selectedFiles.length > 0) {
				// ── Selective push: copy / remove only the chosen files ───────────
				const stagedPaths: string[] = [];

				for (const { relPath, status } of selectedFiles) {
					const vaultFile = path.join(vaultPath, relPath);
					const repoFile  = path.join(sourcePath, relPath);

					if (status === 'deleted') {
						if (fs.existsSync(repoFile)) fs.unlinkSync(repoFile);
					} else {
						// modified or added
						fs.mkdirSync(path.dirname(repoFile), { recursive: true });
						fs.copyFileSync(vaultFile, repoFile);
					}
					// For `git add`, paths must be relative to the repo root
					const repoRelPath = bridge.sourcePath
						? path.join(bridge.sourcePath, relPath)
						: relPath;
					stagedPaths.push(repoRelPath);
				}

				const quoted = stagedPaths.map(p => `"${shellEsc(p)}"`).join(' ');
				await execAsync(`git -C "${repoPath}" add -- ${quoted}`, { timeout: 15000 });
			} else {
				// ── Full push: sync vault dir → repo ─────────────────────────────
				const stat = fs.statSync(vaultPath);
				if (stat.isDirectory()) {
					// Delete repo files that were removed or renamed away in the vault.
					// cpSync only adds/overwrites; it never removes, so without this step
					// deleted and renamed files would be permanently orphaned in the repo.
					const deletedFiles = this.getChangedFiles(bridge).filter(cf => cf.status === 'deleted');
					for (const cf of deletedFiles) {
						const repoFile = path.join(sourcePath, cf.relPath);
						if (fs.existsSync(repoFile)) fs.unlinkSync(repoFile);
					}
					fs.cpSync(vaultPath, sourcePath, {
						recursive: true,
						force: true,
						filter: (src: string) =>
							path.basename(src) !== '.git' &&
							!fs.lstatSync(src).isSymbolicLink(),
					});
				} else {
					fs.copyFileSync(vaultPath, sourcePath);
				}
				await execAsync(`git -C "${repoPath}" add -A`, { timeout: 15000 });
			}

			// Check if anything actually got staged
			const { stdout: diffOut } = await execAsync(
				`git -C "${repoPath}" diff --cached --name-only`,
				{ timeout: 15000 }
			);

			if (!diffOut.trim()) {
				new Notice(`Vault Bridges: "${bridge.name}" — nothing to push, already up to date`);
				bridge.status = 'ok';
				bridge.isDirty = this.checkDirty(bridge);
				// Return to base branch if a PR branch was created
				if (prBranch) {
					await execAsync(
						`git -C "${bridge.repoPath}" checkout "${bridge.branch}"`,
						{ timeout: 15000 }
					).catch(() => {});
					await execAsync(
						`git -C "${bridge.repoPath}" branch -D "${prBranch}"`,
						{ timeout: 5000 }
					).catch(() => {});
				}
				return;
			}

			// Build commit message (user-supplied or auto-generated)
			const timestamp = new Date().toLocaleString();
			const rawMsg = commitMessage?.trim() || `Update from Obsidian vault (${timestamp})`;
			await execAsync(
				`git -C "${repoPath}" commit -m "${shellEsc(rawMsg)}"`,
				{ timeout: 15000 }
			);

			const fileCount = selectedFiles
				? `${selectedFiles.length} file${selectedFiles.length !== 1 ? 's' : ''}`
				: 'all changes';

			if (prBranch) {
				// ── PR mode: push feature branch then open a PR ───────────────────
				await execAsync(
					`git -C "${bridge.repoPath}" push -u origin "${prBranch}"`,
					{ timeout: 30000 }
				);

				let prUrl = '';
				try {
					const { stdout: prOut } = await execAsync(
						`gh pr create` +
						` --base "${shellEsc(bridge.branch)}"` +
						` --head "${shellEsc(prBranch)}"` +
						` --title "${shellEsc(rawMsg)}"` +
						` --body "Changes synced from Obsidian via Vault Bridges."`,
						{ cwd: bridge.repoPath, timeout: 30000, env: SHELL_ENV }
					);
					prUrl = prOut.trim();
				} catch (prErr) {
					const errMsg = prErr instanceof Error ? prErr.message : String(prErr);
					new Notice(
						`Vault Bridges: Branch "${prBranch}" pushed but PR creation failed — ${errMsg}`,
						12000
					);
				}

				// Return to base branch regardless of PR success
				await execAsync(
					`git -C "${bridge.repoPath}" checkout "${bridge.branch}"`,
					{ timeout: 15000 }
				).catch(() => {});

				bridge.lastPrUrl = prUrl || undefined;
				bridge.prStatus = prUrl ? 'open' : undefined;
				bridge.status = 'ok';
				bridge.isDirty = this.checkDirty(bridge);
				bridge.lastPushed = new Date().toISOString();
				bridge.lastSynced = bridge.lastPushed;
				bridge.lastError = undefined;
				if (!selectedFiles) this.recordManifest(bridge);

				new Notice(
					prUrl
						? `Vault Bridges: ✓ "${bridge.name}" — PR opened: ${prUrl}`
						: `Vault Bridges: ✓ "${bridge.name}" — pushed ${fileCount} to ${prBranch}`,
					10000
				);
			} else {
				// ── Direct push ───────────────────────────────────────────────────
				// `-u` sets the upstream on first push of a local-only worktree
				// branch and is a no-op when the upstream already exists.
				await execAsync(
					`git -C "${repoPath}" push -u origin "${targetBranch}"`,
					{ timeout: 30000 }
				);

				bridge.status = 'ok';
				bridge.isDirty = this.checkDirty(bridge); // may still be dirty if partial push
				bridge.lastPushed = new Date().toISOString();
				bridge.lastSynced = bridge.lastPushed;
				bridge.lastError = undefined;
				if (!selectedFiles) this.recordManifest(bridge);

				new Notice(`Vault Bridges: ✓ "${bridge.name}" — pushed ${fileCount} to ${targetBranch}`);
			}
		} catch (err) {
			// On error in PR mode, try to clean up the feature branch and return
			// the repo to the base branch so it isn't left in a detached/unknown state.
			if (prBranch) {
				await execAsync(
					`git -C "${bridge.repoPath}" checkout "${bridge.branch}"`,
					{ timeout: 15000 }
				).catch(() => {});
				await execAsync(
					`git -C "${bridge.repoPath}" branch -D "${prBranch}"`,
					{ timeout: 5000 }
				).catch(() => {});
			}
			bridge.status = 'error';
			bridge.lastError = err instanceof Error ? err.message : String(err);
			console.error(`Vault Bridges: Error pushing "${bridge.name}":`, err);
			new Notice(`Vault Bridges: ❌ "${bridge.name}" push failed — ${bridge.lastError}`, 8000);
			if (this.plugin.settings.claudeEnabled) {
				this.triggerClaudeRecovery(bridge, bridge.lastError, 'push').catch(e =>
					console.error('Vault Bridges: Recovery trigger failed:', e)
				);
			}
		} finally {
			await this.plugin.saveSettings();
			this.plugin.statusBar.update();
			this.notifyUI();
			this.refreshSettingsTab();
		}
	}

	/** Fetch the current state of the bridge's open PR from GitHub. */
	async checkPrStatus(bridge: Bridge): Promise<void> {
		if (!bridge.lastPrUrl) return;
		bridge.prStatus = 'checking';
		this.plugin.fileCommandBar?.update();
		try {
			const { stdout } = await execAsync(
				`gh pr view "${bridge.lastPrUrl}" --json state --jq '.state'`,
				{ timeout: 15000, env: SHELL_ENV }
			);
			const state = stdout.trim().toLowerCase();
			if (state === 'open') bridge.prStatus = 'open';
			else if (state === 'merged') {
				bridge.prStatus = 'merged';
				// Clear after a beat so the bar can show "merged" briefly
				setTimeout(() => {
					bridge.lastPrUrl = undefined;
					bridge.prStatus = undefined;
					this.plugin.saveSettings();
					this.notifyUI();
				}, 4000);
			} else {
				bridge.prStatus = 'closed';
			}
		} catch {
			bridge.prStatus = 'open'; // assume still open on error
		}
		this.plugin.saveSettings();
		this.plugin.fileCommandBar?.update();
	}

	/** Merge the bridge's open PR via `gh pr merge --squash --delete-branch`. */
	async mergePr(bridge: Bridge): Promise<void> {
		if (!bridge.lastPrUrl) return;
		bridge.prStatus = 'checking';
		this.plugin.fileCommandBar?.update();
		try {
			await execAsync(
				`gh pr merge "${bridge.lastPrUrl}" --squash --delete-branch`,
				{ timeout: 60000, env: SHELL_ENV }
			);
			new Notice(`Vault Bridges: ✓ PR merged — ${bridge.lastPrUrl}`, 8000);
			bridge.prStatus = 'merged';
			this.notifyUI();
			setTimeout(() => {
				bridge.lastPrUrl = undefined;
				bridge.prStatus = undefined;
				this.plugin.saveSettings();
				this.notifyUI();
			}, 4000);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Vault Bridges: merge failed — ${msg}`, 10000);
			bridge.prStatus = 'open';
			this.notifyUI();
		}
		this.plugin.saveSettings();
	}
}
