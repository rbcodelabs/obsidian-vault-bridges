import { exec } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as fs from 'fs';
import * as path from 'path';
import { Notice } from 'obsidian';
import type VaultBridgesPlugin from '../main';
import type { Bridge, ChangedFile, GitDiagnostics } from './types';
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

		const diag = await this.gatherDiagnostics(bridge.repoPath, errorText, operation);

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
				`Run \`git stash\` in ${bridge.repoPath} then try again.`,
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
		if (!fs.existsSync(bridge.repoPath)) {
			throw new Error(`Repo path does not exist: ${bridge.repoPath}`);
		}

		const gitDir = path.join(bridge.repoPath, '.git');
		if (!fs.existsSync(gitDir)) {
			throw new Error(`Not a git repository: ${bridge.repoPath}`);
		}

		// Validate branch contains no shell metacharacters before interpolation
		if (!/^[a-zA-Z0-9._\-/]+$/.test(bridge.branch)) {
			throw new Error(`Invalid branch name: "${bridge.branch}"`);
		}

		// Auto-stash any uncommitted repo-side changes so the pull can proceed.
		// This handles "cannot pull with rebase: You have unstaged changes" — a common
		// case when files were edited directly in the repo outside of Obsidian.
		let stashed = false;
		try {
			const { stdout: statusOut } = await execAsync(
				`git -C "${bridge.repoPath}" status --porcelain`,
				{ timeout: 10000 }
			);
			if (statusOut.trim().length > 0) {
				const { stdout: stashOut } = await execAsync(
					`git -C "${bridge.repoPath}" stash push --include-untracked -m "vault-bridges auto-stash"`,
					{ timeout: 15000 }
				);
				stashed = !stashOut.trim().startsWith('No local changes');
			}
		} catch (stashCheckErr) {
			// Non-fatal: if the stash check/push fails, proceed with the pull anyway
			console.warn(`Vault Bridges: auto-stash check failed for "${bridge.name}":`, stashCheckErr);
		}

		try {
			const { stdout, stderr } = await execAsync(
				`git -C "${bridge.repoPath}" pull origin "${bridge.branch}"`,
				{ timeout: 30000 }
			);
			console.log(`Vault Bridges: Pulled "${bridge.name}":`, stdout || stderr);
		} catch (err) {
			// Restore stash on pull failure so no work is lost
			if (stashed) {
				await execAsync(
					`git -C "${bridge.repoPath}" stash pop`,
					{ timeout: 15000 }
				).catch(popErr =>
					console.warn(`Vault Bridges: stash pop after failed pull for "${bridge.name}":`, popErr)
				);
			}
			throw new Error(`git pull failed: ${err instanceof Error ? err.message : String(err)}`);
		}

		// Restore stashed changes after a successful pull
		if (stashed) {
			try {
				await execAsync(
					`git -C "${bridge.repoPath}" stash pop`,
					{ timeout: 15000 }
				);
			} catch (stashPopErr) {
				// Pull succeeded but stash pop hit a conflict — warn without failing the sync
				new Notice(
					`Vault Bridges: "${bridge.name}" — pull succeeded but stash pop failed. ` +
					`Resolve the conflict manually in: ${bridge.repoPath}`,
					12000
				);
				console.error(`Vault Bridges: stash pop failed for "${bridge.name}":`, stashPopErr);
			}
		}
	}

	async copyFiles(bridge: Bridge): Promise<void> {
		const sourcePath = bridge.sourcePath
			? path.join(bridge.repoPath, bridge.sourcePath)
			: bridge.repoPath;

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

		try {
			// Validate branch
			if (!/^[a-zA-Z0-9._\-/]+$/.test(bridge.branch)) {
				throw new Error(`Invalid branch name: "${bridge.branch}"`);
			}

			// PR mode: fetch origin and create a fresh feature branch BEFORE
			// touching any files so the working tree is based on the latest remote.
			if (bridge.prMode) {
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
				? path.join(bridge.repoPath, bridge.sourcePath)
				: bridge.repoPath;
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
				await execAsync(`git -C "${bridge.repoPath}" add -- ${quoted}`, { timeout: 15000 });
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
				await execAsync(`git -C "${bridge.repoPath}" add -A`, { timeout: 15000 });
			}

			// Check if anything actually got staged
			const { stdout: diffOut } = await execAsync(
				`git -C "${bridge.repoPath}" diff --cached --name-only`,
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
				`git -C "${bridge.repoPath}" commit -m "${shellEsc(rawMsg)}"`,
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
				// ── Direct push (original behaviour) ─────────────────────────────
				await execAsync(
					`git -C "${bridge.repoPath}" push origin "${bridge.branch}"`,
					{ timeout: 30000 }
				);

				bridge.status = 'ok';
				bridge.isDirty = this.checkDirty(bridge); // may still be dirty if partial push
				bridge.lastPushed = new Date().toISOString();
				bridge.lastSynced = bridge.lastPushed;
				bridge.lastError = undefined;
				if (!selectedFiles) this.recordManifest(bridge);

				new Notice(`Vault Bridges: ✓ "${bridge.name}" — pushed ${fileCount} to ${bridge.branch}`);
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
