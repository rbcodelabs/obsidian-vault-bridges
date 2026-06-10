import { Notice } from 'obsidian';
import type VaultBridgesPlugin from '../main';
import type { Bridge, WorktreeInfo } from './types';

/**
 * Options for adding a new bridge via the plugin API.
 */
export interface AddBridgeOptions {
	/** Human-readable label for the bridge (e.g. "Agentic PM Playbook") */
	name: string;
	/** Absolute local path to the git repository root */
	repoPath: string;
	/** Optional subfolder within the repo to copy. Defaults to '' (whole repo). */
	sourcePath?: string;
	/** Vault-relative destination path (e.g. "Playbooks/Agentic PM Playbook") */
	vaultPath: string;
	/** Git branch to pull from. Defaults to 'main'. */
	branch?: string;
	/** Pull this bridge when Obsidian opens. Defaults to true. */
	autoSync?: boolean;
	/** Immediately sync after adding. Defaults to false. */
	syncNow?: boolean;
}

/**
 * Public API surface for the Vault Bridges plugin.
 *
 * Other plugins access this via:
 *
 *   const vb = (this.app as any).plugins.plugins['vault-bridges'] as VaultBridgesPlugin | undefined;
 *   await vb?.api.addBridge({ name: '...', repoPath: '...', vaultPath: '...' });
 *
 * Import the types for full type safety (no runtime dependency):
 *
 *   import type { VaultBridgesAPI, AddBridgeOptions } from 'vault-bridges/src/VaultBridgesAPI';
 */
export class VaultBridgesAPI {
	constructor(private plugin: VaultBridgesPlugin) {}

	/**
	 * Returns a snapshot of all currently configured bridges.
	 */
	getBridges(): Bridge[] {
		return [...this.plugin.settings.bridges];
	}

	/**
	 * Adds a new bridge. If a bridge with the same repoPath + vaultPath already
	 * exists, the existing bridge is returned without creating a duplicate.
	 *
	 * @returns The newly created (or existing) Bridge record.
	 */
	async addBridge(options: AddBridgeOptions): Promise<Bridge> {
		const {
			name,
			repoPath,
			vaultPath,
			sourcePath = '',
			branch = 'main',
			autoSync = true,
			syncNow = false,
		} = options;

		// Deduplicate: return existing bridge if one matches repoPath + vaultPath.
		const existing = this.plugin.settings.bridges.find(
			b => b.repoPath === repoPath && b.vaultPath === vaultPath,
		);
		if (existing) {
			return existing;
		}

		const bridge: Bridge = {
			id: crypto.randomUUID(),
			name,
			repoPath,
			sourcePath,
			vaultPath,
			branch,
			autoSync,
			status: 'unknown',
		};

		this.plugin.settings.bridges.push(bridge);
		await this.plugin.saveSettings();
		this.plugin.statusBar.update();
		this.plugin.registerBridgeCommands(bridge);

		new Notice(`Vault Bridges: added "${name}"`);

		if (syncNow) {
			await this.plugin.bridgeManager.syncBridge(bridge);
		}

		return bridge;
	}

	/**
	 * Removes a bridge by its id. Does nothing if the id is not found.
	 */
	async removeBridge(id: string): Promise<void> {
		const before = this.plugin.settings.bridges.length;
		this.plugin.settings.bridges = this.plugin.settings.bridges.filter(b => b.id !== id);

		if (this.plugin.settings.bridges.length !== before) {
			await this.plugin.saveSettings();
			this.plugin.statusBar.update();
		}
	}

	/**
	 * Triggers a pull (repo → vault) for the bridge with the given id.
	 * Resolves when the sync completes or if no matching bridge is found.
	 */
	async syncBridge(id: string): Promise<void> {
		const bridge = this.plugin.settings.bridges.find(b => b.id === id);
		if (!bridge) return;
		await this.plugin.bridgeManager.syncBridge(bridge);
	}

	/**
	 * Triggers a push (vault → repo) for the bridge with the given id.
	 * Resolves when the push completes or if no matching bridge is found.
	 */
	async pushBridge(id: string): Promise<void> {
		const bridge = this.plugin.settings.bridges.find(b => b.id === id);
		if (!bridge) return;
		await this.plugin.bridgeManager.pushBridge(bridge);
	}

	/**
	 * Lists all worktrees of the bridge's repo. The first entry is the main
	 * checkout; `isActive` marks the one the bridge currently mirrors.
	 *
	 * @throws if no bridge with the given id exists.
	 */
	async listWorktrees(id: string): Promise<WorktreeInfo[]> {
		const bridge = this.plugin.settings.bridges.find(b => b.id === id);
		if (!bridge) throw new Error(`Vault Bridges: no bridge with id "${id}"`);
		return this.plugin.bridgeManager.listWorktrees(bridge);
	}

	/**
	 * Points the bridge at a different worktree and re-pulls it into the vault.
	 * Pass `null` (or the main checkout's path) to switch back to the main repo.
	 *
	 * If the vault copy has unsaved edits and `force` is false, a confirmation
	 * modal is shown to the user before anything changes. Pass `force: true`
	 * for headless callers (e.g. MCP integrations) to switch immediately,
	 * discarding unpushed vault edits.
	 *
	 * @throws if no bridge with the given id exists, or `worktreePath` is not a
	 *         linked worktree of the bridge's repo.
	 */
	async switchWorktree(
		id: string,
		worktreePath: string | null,
		options?: { force?: boolean },
	): Promise<void> {
		const bridge = this.plugin.settings.bridges.find(b => b.id === id);
		if (!bridge) throw new Error(`Vault Bridges: no bridge with id "${id}"`);
		await this.plugin.bridgeManager.switchWorktree(bridge, worktreePath, options?.force ?? false);
	}
}
