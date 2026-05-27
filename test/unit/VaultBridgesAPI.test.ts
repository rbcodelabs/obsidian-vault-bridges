import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('obsidian', () => ({ Notice: vi.fn() }));

import { VaultBridgesAPI } from '../../src/VaultBridgesAPI';
import type VaultBridgesPlugin from '../../main';
import type { Bridge } from '../../src/types';
import { Notice } from 'obsidian';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBridge(overrides: Partial<Bridge> = {}): Bridge {
	return {
		id: crypto.randomUUID(),
		name: 'Test Bridge',
		repoPath: '/repo/path',
		sourcePath: '',
		vaultPath: 'Vault/Path',
		branch: 'main',
		autoSync: true,
		status: 'unknown',
		...overrides,
	};
}

function makePlugin(bridges: Bridge[] = []): VaultBridgesPlugin {
	return {
		settings: {
			bridges,
			syncOnStartup: true,
			claudePath: '',
			claudeEnabled: false,
		},
		saveSettings: vi.fn().mockResolvedValue(undefined),
		statusBar: { update: vi.fn() },
		registerBridgeCommands: vi.fn(),
		bridgeManager: {
			syncBridge: vi.fn().mockResolvedValue(undefined),
			pushBridge: vi.fn().mockResolvedValue(undefined),
		},
	} as unknown as VaultBridgesPlugin;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('VaultBridgesAPI', () => {
	let plugin: VaultBridgesPlugin;
	let api: VaultBridgesAPI;

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = makePlugin();
		api = new VaultBridgesAPI(plugin);
	});

	// ── getBridges ─────────────────────────────────────────────────────────────

	describe('getBridges', () => {
		it('returns an empty array when no bridges are configured', () => {
			expect(api.getBridges()).toEqual([]);
		});

		it('returns a snapshot — mutating the returned array does not affect settings.bridges', () => {
			const bridge = makeBridge();
			plugin.settings.bridges.push(bridge);

			const result = api.getBridges();
			result.push(makeBridge({ name: 'Intruder' }));

			expect(plugin.settings.bridges).toHaveLength(1);
		});

		it('returns all bridges when multiple are present', () => {
			const b1 = makeBridge({ name: 'Alpha' });
			const b2 = makeBridge({ name: 'Beta' });
			plugin.settings.bridges.push(b1, b2);

			const result = api.getBridges();
			expect(result).toHaveLength(2);
			expect(result.map(b => b.name)).toEqual(['Alpha', 'Beta']);
		});
	});

	// ── addBridge ──────────────────────────────────────────────────────────────

	describe('addBridge', () => {
		it('adds a bridge with correct defaults when only required fields provided', async () => {
			const bridge = await api.addBridge({
				name: 'My Docs',
				repoPath: '/repo',
				vaultPath: 'Docs',
			});

			expect(bridge.sourcePath).toBe('');
			expect(bridge.branch).toBe('main');
			expect(bridge.autoSync).toBe(true);
			expect(bridge.status).toBe('unknown');
		});

		it('assigns a valid UUID as the bridge id', async () => {
			const bridge = await api.addBridge({
				name: 'My Docs',
				repoPath: '/repo',
				vaultPath: 'Docs',
			});

			expect(bridge.id).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
			);
		});

		it('honours explicit overrides for sourcePath, branch, and autoSync', async () => {
			const bridge = await api.addBridge({
				name: 'Typed',
				repoPath: '/repo',
				vaultPath: 'Typed',
				sourcePath: 'docs/sub',
				branch: 'develop',
				autoSync: false,
			});

			expect(bridge.sourcePath).toBe('docs/sub');
			expect(bridge.branch).toBe('develop');
			expect(bridge.autoSync).toBe(false);
		});

		it('calls saveSettings when adding a new bridge', async () => {
			await api.addBridge({ name: 'N', repoPath: '/r', vaultPath: 'V' });
			expect(plugin.saveSettings).toHaveBeenCalledOnce();
		});

		it('calls statusBar.update when adding a new bridge', async () => {
			await api.addBridge({ name: 'N', repoPath: '/r', vaultPath: 'V' });
			expect(plugin.statusBar.update).toHaveBeenCalledOnce();
		});

		it('calls registerBridgeCommands with the new bridge', async () => {
			const bridge = await api.addBridge({ name: 'N', repoPath: '/r', vaultPath: 'V' });
			expect(plugin.registerBridgeCommands).toHaveBeenCalledWith(bridge);
		});

		it('calls syncBridge when syncNow=true', async () => {
			const bridge = await api.addBridge({
				name: 'N',
				repoPath: '/r',
				vaultPath: 'V',
				syncNow: true,
			});
			expect(plugin.bridgeManager.syncBridge).toHaveBeenCalledWith(bridge);
		});

		it('does NOT call syncBridge when syncNow is omitted', async () => {
			await api.addBridge({ name: 'N', repoPath: '/r', vaultPath: 'V' });
			expect(plugin.bridgeManager.syncBridge).not.toHaveBeenCalled();
		});

		it('deduplicates: returns existing bridge when repoPath + vaultPath match', async () => {
			const existing = makeBridge({ repoPath: '/repo', vaultPath: 'Vault' });
			plugin.settings.bridges.push(existing);

			const result = await api.addBridge({
				name: 'Duplicate',
				repoPath: '/repo',
				vaultPath: 'Vault',
			});

			expect(result).toBe(existing);
		});

		it('deduplicates: does NOT add a second bridge for the same repoPath + vaultPath', async () => {
			plugin.settings.bridges.push(makeBridge({ repoPath: '/repo', vaultPath: 'Vault' }));

			await api.addBridge({ name: 'Dup', repoPath: '/repo', vaultPath: 'Vault' });

			expect(plugin.settings.bridges).toHaveLength(1);
		});

		it('deduplicates: does NOT call saveSettings for a duplicate', async () => {
			plugin.settings.bridges.push(makeBridge({ repoPath: '/repo', vaultPath: 'Vault' }));

			await api.addBridge({ name: 'Dup', repoPath: '/repo', vaultPath: 'Vault' });

			expect(plugin.saveSettings).not.toHaveBeenCalled();
		});

		it('shows a Notice when adding a new bridge', async () => {
			await api.addBridge({ name: 'My Docs', repoPath: '/r', vaultPath: 'V' });
			expect(Notice).toHaveBeenCalledWith('Vault Bridges: added "My Docs"');
		});
	});

	// ── removeBridge ──────────────────────────────────────────────────────────

	describe('removeBridge', () => {
		it('removes the bridge with the matching id', async () => {
			const bridge = makeBridge({ id: 'target-id' });
			plugin.settings.bridges.push(bridge);

			await api.removeBridge('target-id');

			expect(plugin.settings.bridges).toHaveLength(0);
		});

		it('calls saveSettings after removing a bridge', async () => {
			const bridge = makeBridge({ id: 'target-id' });
			plugin.settings.bridges.push(bridge);

			await api.removeBridge('target-id');

			expect(plugin.saveSettings).toHaveBeenCalledOnce();
		});

		it('is a no-op when the id is not found', async () => {
			const bridge = makeBridge({ id: 'existing-id' });
			plugin.settings.bridges.push(bridge);

			await api.removeBridge('nonexistent-id');

			expect(plugin.settings.bridges).toHaveLength(1);
		});

		it('does NOT call saveSettings when the id is not found', async () => {
			plugin.settings.bridges.push(makeBridge({ id: 'existing-id' }));

			await api.removeBridge('nonexistent-id');

			expect(plugin.saveSettings).not.toHaveBeenCalled();
		});
	});

	// ── syncBridge ────────────────────────────────────────────────────────────

	describe('syncBridge', () => {
		it('delegates to bridgeManager.syncBridge with the correct bridge object', async () => {
			const bridge = makeBridge({ id: 'sync-me' });
			plugin.settings.bridges.push(bridge);

			await api.syncBridge('sync-me');

			expect(plugin.bridgeManager.syncBridge).toHaveBeenCalledWith(bridge);
		});

		it('is a no-op for an unknown id', async () => {
			await api.syncBridge('ghost-id');
			expect(plugin.bridgeManager.syncBridge).not.toHaveBeenCalled();
		});
	});

	// ── pushBridge ────────────────────────────────────────────────────────────

	describe('pushBridge', () => {
		it('delegates to bridgeManager.pushBridge with the correct bridge object', async () => {
			const bridge = makeBridge({ id: 'push-me' });
			plugin.settings.bridges.push(bridge);

			await api.pushBridge('push-me');

			expect(plugin.bridgeManager.pushBridge).toHaveBeenCalledWith(bridge);
		});

		it('is a no-op for an unknown id', async () => {
			await api.pushBridge('ghost-id');
			expect(plugin.bridgeManager.pushBridge).not.toHaveBeenCalled();
		});
	});
});
