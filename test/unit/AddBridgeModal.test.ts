import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock obsidian ────────────────────────────────────────────────────────────
// No DOM needed — we test validate() and save() directly without calling onOpen().

vi.mock('obsidian', () => ({
	App: class {},
	Modal: class {
		app: unknown;
		contentEl = { createEl: () => ({}), empty: () => {} };
		constructor(app: unknown) {
			this.app = app;
		}
		open() {}
		close() {}
		onOpen() {}
		onClose() {}
	},
	Setting: class {
		setName() { return this; }
		setDesc() { return this; }
		setHeading() { return this; }
		addText(cb: Function) {
			cb({
				setPlaceholder: () => ({}),
				setValue: () => ({}),
				onChange: () => ({}),
				inputEl: { style: {} },
			});
			return this;
		}
		addToggle(cb: Function) {
			cb({ setValue: () => ({}), onChange: () => ({}) });
			return this;
		}
		addButton(cb: Function) {
			cb({
				setButtonText: () => ({}),
				setCta: () => ({}),
				setWarning: () => ({}),
				setDisabled: () => ({}),
				setTooltip: () => ({}),
				onClick: () => ({}),
			});
			return this;
		}
	},
	Notice: vi.fn(),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { AddBridgeModal } from '../../src/AddBridgeModal';
import { Notice } from 'obsidian';
import type VaultBridgesPlugin from '../../main';
import type { Bridge } from '../../src/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBridge(overrides: Partial<Bridge> = {}): Bridge {
	return {
		id: crypto.randomUUID(),
		name: 'Existing Bridge',
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

// ─── validate() ───────────────────────────────────────────────────────────────

describe('AddBridgeModal.validate()', () => {
	let plugin: VaultBridgesPlugin;
	const fakeApp = {};

	beforeEach(() => {
		vi.clearAllMocks();
		plugin = makePlugin();
	});

	it('returns false and calls Notice when name is empty', () => {
		const modal = new AddBridgeModal(fakeApp as any, plugin, null, vi.fn());
		(modal as any).bridge = { name: '', repoPath: '/r', vaultPath: 'V' };

		const result = (modal as any).validate();

		expect(result).toBe(false);
		expect(Notice).toHaveBeenCalledWith('Vault Bridges: Bridge name is required.');
	});

	it('returns false and calls Notice when repoPath is empty', () => {
		const modal = new AddBridgeModal(fakeApp as any, plugin, null, vi.fn());
		(modal as any).bridge = { name: 'My Bridge', repoPath: '', vaultPath: 'V' };

		const result = (modal as any).validate();

		expect(result).toBe(false);
		expect(Notice).toHaveBeenCalledWith('Vault Bridges: Local repo path is required.');
	});

	it('returns false and calls Notice when vaultPath is empty', () => {
		const modal = new AddBridgeModal(fakeApp as any, plugin, null, vi.fn());
		(modal as any).bridge = { name: 'My Bridge', repoPath: '/r', vaultPath: '' };

		const result = (modal as any).validate();

		expect(result).toBe(false);
		expect(Notice).toHaveBeenCalledWith('Vault Bridges: Vault destination path is required.');
	});

	it('returns true when all required fields are filled', () => {
		const modal = new AddBridgeModal(fakeApp as any, plugin, null, vi.fn());
		(modal as any).bridge = { name: 'My Bridge', repoPath: '/r', vaultPath: 'V' };

		const result = (modal as any).validate();

		expect(result).toBe(true);
		expect(Notice).not.toHaveBeenCalled();
	});
});

// ─── save() — new bridge ──────────────────────────────────────────────────────

describe('AddBridgeModal.save() — new bridge', () => {
	const fakeApp = {};

	it('pushes the bridge to plugin.settings.bridges', async () => {
		const plugin = makePlugin();
		const onSave = vi.fn();
		const modal = new AddBridgeModal(fakeApp as any, plugin, null, onSave);

		(modal as any).bridge = {
			id: 'new-id',
			name: 'X',
			repoPath: '/r',
			vaultPath: 'V',
			branch: 'main',
			autoSync: true,
			status: 'unknown',
		};

		await (modal as any).save();

		expect(plugin.settings.bridges).toHaveLength(1);
		expect(plugin.settings.bridges[0].id).toBe('new-id');
		expect(plugin.settings.bridges[0].name).toBe('X');
	});

	it('calls saveSettings', async () => {
		const plugin = makePlugin();
		const modal = new AddBridgeModal(fakeApp as any, plugin, null, vi.fn());
		(modal as any).bridge = {
			id: 'new-id', name: 'X', repoPath: '/r', vaultPath: 'V',
			branch: 'main', autoSync: true, status: 'unknown',
		};

		await (modal as any).save();

		expect(plugin.saveSettings).toHaveBeenCalledOnce();
	});

	it('calls statusBar.update', async () => {
		const plugin = makePlugin();
		const modal = new AddBridgeModal(fakeApp as any, plugin, null, vi.fn());
		(modal as any).bridge = {
			id: 'new-id', name: 'X', repoPath: '/r', vaultPath: 'V',
			branch: 'main', autoSync: true, status: 'unknown',
		};

		await (modal as any).save();

		expect(plugin.statusBar.update).toHaveBeenCalledOnce();
	});

	it('calls registerBridgeCommands with the new bridge', async () => {
		const plugin = makePlugin();
		const modal = new AddBridgeModal(fakeApp as any, plugin, null, vi.fn());
		const bridge = {
			id: 'new-id', name: 'X', repoPath: '/r', vaultPath: 'V',
			branch: 'main', autoSync: true, status: 'unknown' as const,
		};
		(modal as any).bridge = bridge;

		await (modal as any).save();

		expect(plugin.registerBridgeCommands).toHaveBeenCalledWith(bridge);
	});

	it('calls the onSave callback', async () => {
		const plugin = makePlugin();
		const onSave = vi.fn();
		const modal = new AddBridgeModal(fakeApp as any, plugin, null, onSave);
		(modal as any).bridge = {
			id: 'new-id', name: 'X', repoPath: '/r', vaultPath: 'V',
			branch: 'main', autoSync: true, status: 'unknown',
		};

		await (modal as any).save();

		expect(onSave).toHaveBeenCalledOnce();
	});
});

// ─── save() — edit existing bridge ───────────────────────────────────────────

describe('AddBridgeModal.save() — edit existing bridge', () => {
	const fakeApp = {};

	it('updates the bridge in place without pushing a new entry', async () => {
		const existing = makeBridge({ id: 'edit-me', name: 'Old Name' });
		const plugin = makePlugin([existing]);
		const onSave = vi.fn();
		const modal = new AddBridgeModal(fakeApp as any, plugin, existing, onSave);

		// Mutate the internal copy to simulate the user changing the name
		(modal as any).bridge.name = 'New Name';

		await (modal as any).save();

		expect(plugin.settings.bridges).toHaveLength(1);
		expect(plugin.settings.bridges[0].name).toBe('New Name');
	});

	it('calls registerBridgeCommands after an edit', async () => {
		const existing = makeBridge({ id: 'edit-me' });
		const plugin = makePlugin([existing]);
		const modal = new AddBridgeModal(fakeApp as any, plugin, existing, vi.fn());

		await (modal as any).save();

		expect(plugin.registerBridgeCommands).toHaveBeenCalled();
	});

	it('calls saveSettings after an edit', async () => {
		const existing = makeBridge({ id: 'edit-me' });
		const plugin = makePlugin([existing]);
		const modal = new AddBridgeModal(fakeApp as any, plugin, existing, vi.fn());

		await (modal as any).save();

		expect(plugin.saveSettings).toHaveBeenCalledOnce();
	});
});
