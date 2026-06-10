import * as fs from 'fs';
import { Notice } from 'obsidian';
import type { EventRef } from 'obsidian';
import type VaultBridgesPlugin from '../main';
import type { Bridge, WorktreeChangeEvent } from './types';

/**
 * Workspace event fired by the Claude Threads plugin when an agent session
 * enters or exits a git worktree via its `enter_worktree` / `exit_worktree`
 * MCP tools. Payload: {@link WorktreeChangeEvent}.
 */
export const WORKTREE_CHANGED_EVENT = 'claude-threads:worktree-changed';

/**
 * MCP auto-flip: keeps bridges in sync with Claude agent sessions.
 *
 * When a Claude Threads session moves into (or out of) a git worktree of a
 * bridged repo, this module automatically points the matching bridge at the
 * same worktree so the vault copy, branch pill, and push/pull targets all
 * follow the agent session — no manual switching needed.
 *
 * Detection is a direct in-process notification: both plugins run inside the
 * same Obsidian process, so the Claude Threads MCP server fires a workspace
 * event after a successful `git worktree add`/`remove` and this module
 * subscribes to it. No file watching, no polling, and neither plugin hard-
 * depends on the other — without an emitter the listener is simply idle.
 */
export class WorktreeAutoFlip {
	constructor(private plugin: VaultBridgesPlugin) {}

	/** Subscribe to worktree-change events. Call once from plugin onload. */
	register(): void {
		// Obsidian's typed Workspace.on() does not know about custom
		// (inter-plugin) event names, so cast to the untyped signature.
		const workspace = this.plugin.app.workspace as unknown as {
			on(name: string, callback: (payload: WorktreeChangeEvent) => void): EventRef;
		};
		this.plugin.registerEvent(
			workspace.on(WORKTREE_CHANGED_EVENT, (payload: WorktreeChangeEvent) => {
				// Fire-and-forget: the emitting MCP tool must not block on the
				// re-pull, and errors are surfaced via Notice inside the handler.
				this.handleWorktreeChange(payload).catch(err =>
					console.error('Vault Bridges: auto-flip failed:', err)
				);
			})
		);
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
	 * Returns the bridges that should flip for the given event.
	 *
	 * - Only bridges whose repo matches the event's repo are considered —
	 *   with multiple bridges configured, other repos' bridges stay put.
	 * - On exit (worktreePath === null with a removedWorktreePath), only
	 *   bridges actually pinned to the *removed* worktree flip back; a bridge
	 *   the user manually pointed at a different worktree is left alone.
	 */
	matchBridges(payload: WorktreeChangeEvent): Bridge[] {
		const repoResolved = this.resolvePath(payload.repoPath);
		return this.plugin.settings.bridges
			.filter(b => this.resolvePath(b.repoPath) === repoResolved)
			.filter(b => {
				if (payload.worktreePath === null && payload.removedWorktreePath) {
					return (
						!!b.activeWorktreePath &&
						this.resolvePath(b.activeWorktreePath) ===
							this.resolvePath(payload.removedWorktreePath)
					);
				}
				return true;
			});
	}

	async handleWorktreeChange(payload: WorktreeChangeEvent): Promise<void> {
		if (!this.plugin.settings.autoFlipWorktrees) return;
		if (!payload || typeof payload.repoPath !== 'string' || !payload.repoPath) return;

		for (const bridge of this.matchBridges(payload)) {
			const current = bridge.activeWorktreePath ?? null;
			const target = payload.worktreePath;

			// No-op guard: already tracking the target checkout. Avoids a
			// redundant re-pull and breaks any potential event echo loop.
			if (current === null && target === null) continue;
			if (current && target && this.resolvePath(current) === this.resolvePath(target)) continue;

			// When the currently-tracked worktree directory is already gone
			// from disk (exit_worktree removes it before this event fires) and
			// the vault copy has unpushed edits, there is no checkout left to
			// push to — force-switching would silently destroy the edits.
			// Skip the flip and let the user resolve via the branch pill.
			const currentGone = current !== null && !fs.existsSync(current);
			if (currentGone && this.plugin.bridgeManager.checkDirty(bridge)) {
				new Notice(
					`Vault Bridges: "${bridge.name}" has unpushed vault edits but its worktree was removed. ` +
					`Auto-flip skipped — push or discard the edits, then switch back via the branch pill.`,
					12000
				);
				continue;
			}

			new Notice(
				target
					? `Vault Bridges: Claude session entered a worktree — flipping "${bridge.name}" to "${payload.branch ?? target}"…`
					: `Vault Bridges: Claude session exited its worktree — flipping "${bridge.name}" back to main…`,
				6000
			);

			try {
				// force only when the old worktree no longer exists (the
				// dirty-warning modal's "push then switch" would have nothing
				// to push to). Otherwise keep the normal dirty-check flow so
				// unpushed vault edits always get a confirmation modal.
				await this.plugin.bridgeManager.switchWorktree(bridge, target, currentGone);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`Vault Bridges: auto-flip failed for "${bridge.name}":`, err);
				new Notice(`Vault Bridges: ❌ auto-flip failed for "${bridge.name}" — ${msg}`, 10000);
			}
		}
	}
}
