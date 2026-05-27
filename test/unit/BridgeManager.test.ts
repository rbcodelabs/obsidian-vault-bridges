import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock declarations (hoisted) ──────────────────────────────────────────────

vi.mock('child_process', () => ({ exec: vi.fn() }));

vi.mock('fs', () => ({
	existsSync: vi.fn(),
	lstatSync: vi.fn(),
	statSync: vi.fn(),
	readdirSync: vi.fn(),
	cpSync: vi.fn(),
	copyFileSync: vi.fn(),
	rmSync: vi.fn(),
	mkdirSync: vi.fn(),
	unlinkSync: vi.fn(),
}));

vi.mock('obsidian', () => ({ Notice: vi.fn() }));

vi.mock('../../src/DirtyWarningModal', () => ({
	DirtyWarningModal: vi.fn().mockImplementation(function () {
		this.open = vi.fn();
	}),
}));

vi.mock('../../src/ConflictResolutionModal', () => ({
	ConflictResolutionModal: vi.fn().mockImplementation(function () {
		this.open = vi.fn();
	}),
}));

vi.mock('../../src/ClaudeGitSession', () => ({
	ClaudeGitSession: vi.fn(),
}));

// ─── Imports (after mock declarations) ───────────────────────────────────────

import { exec } from 'child_process';
import * as fs from 'fs';
import { Notice } from 'obsidian';
import { BridgeManager } from '../../src/BridgeManager';
import { DirtyWarningModal } from '../../src/DirtyWarningModal';
import type VaultBridgesPlugin from '../../main';
import type { Bridge } from '../../src/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBridge(overrides: Partial<Bridge> = {}): Bridge {
	return {
		id: crypto.randomUUID(),
		name: 'Test Bridge',
		repoPath: '/repo/path',
		sourcePath: '',
		vaultPath: 'Work/Docs',
		branch: 'main',
		autoSync: true,
		status: 'unknown',
		...overrides,
	};
}

function makePlugin(overrides: Partial<{ syncOnStartup: boolean; claudeEnabled: boolean }> = {}): VaultBridgesPlugin {
	const settings = {
		bridges: [] as Bridge[],
		syncOnStartup: true,
		claudePath: '',
		claudeEnabled: false,
		...overrides,
	};
	return {
		app: { vault: { adapter: { basePath: '/mock/vault' } }, workspace: {} },
		settings,
		saveSettings: vi.fn().mockResolvedValue(undefined),
		statusBar: { update: vi.fn() },
	} as unknown as VaultBridgesPlugin;
}

// Default exec: succeeds with empty output
function setupExecSuccess(stdout = '', stderr = '') {
	vi.mocked(exec).mockImplementation((cmd: any, opts: any, cb: any) => {
		cb(null, { stdout, stderr });
		return {} as any;
	});
}

// ─── beforeEach / afterEach ───────────────────────────────────────────────────

beforeEach(() => {
	// Happy-path filesystem defaults
	vi.mocked(fs.existsSync).mockReturnValue(true);
	vi.mocked(fs.lstatSync).mockReturnValue({
		isSymbolicLink: () => false,
		isDirectory: () => false,
	} as any);
	vi.mocked(fs.statSync).mockReturnValue({
		isDirectory: () => true,
		isFile: () => false,
		mtimeMs: 0,
	} as any);
	vi.mocked(fs.readdirSync).mockReturnValue([]);
	setupExecSuccess();
});

afterEach(() => {
	vi.clearAllMocks();
});

// ─── checkDirty ───────────────────────────────────────────────────────────────

describe('BridgeManager.checkDirty', () => {
	it('returns false when bridge has no fileManifest', () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ fileManifest: undefined });

		expect(manager.checkDirty(bridge)).toBe(false);
	});

	it('returns false when fileManifest is empty {}', () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ fileManifest: {} });

		expect(manager.checkDirty(bridge)).toBe(false);
	});

	it('returns false when destPath does not exist', () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		// Bridge has a manifest entry, but the dest path doesn't exist
		const bridge = makeBridge({ fileManifest: { 'README.md': 1000 } });

		// First existsSync (for destPath) returns false
		vi.mocked(fs.existsSync).mockReturnValueOnce(false);

		expect(manager.checkDirty(bridge)).toBe(false);
	});

	it('returns false when file mtime is unchanged', () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		// vaultPath = 'Work/Docs' → destPath = '/mock/vault/Work/Docs'
		const bridge = makeBridge({ vaultPath: 'Work/Docs', fileManifest: { 'README.md': 1000 } });

		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readdirSync).mockReturnValue([
			{ name: 'README.md', isDirectory: () => false, isFile: () => true },
		] as any);
		vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false, isFile: () => true, mtimeMs: 1000 } as any);

		expect(manager.checkDirty(bridge)).toBe(false);
	});

	it('returns true when file mtime has changed', () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ vaultPath: 'Work/Docs', fileManifest: { 'README.md': 1000 } });

		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readdirSync).mockReturnValue([
			{ name: 'README.md', isDirectory: () => false, isFile: () => true },
		] as any);
		vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false, isFile: () => true, mtimeMs: 9999 } as any);

		expect(manager.checkDirty(bridge)).toBe(true);
	});

	it('returns true when a tracked file has been deleted', () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ vaultPath: 'Work/Docs', fileManifest: { 'README.md': 1000 } });

		vi.mocked(fs.existsSync).mockReturnValue(true);
		// readdirSync returns empty — file is gone
		vi.mocked(fs.readdirSync).mockReturnValue([]);

		expect(manager.checkDirty(bridge)).toBe(true);
	});
});

// ─── syncBridge — error paths ─────────────────────────────────────────────────

describe('BridgeManager.syncBridge — error paths', () => {
	it('sets status=error when repo path does not exist', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge();
		plugin.settings.bridges.push(bridge);

		// First existsSync call is for repoPath
		vi.mocked(fs.existsSync).mockReturnValueOnce(false);

		await manager.syncBridge(bridge, true);

		expect(bridge.status).toBe('error');
		expect(plugin.saveSettings).toHaveBeenCalled();
	});

	it('sets status=error when .git directory is missing (not a git repo)', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge();
		plugin.settings.bridges.push(bridge);

		// First existsSync (repoPath) → true, second (gitDir) → false
		vi.mocked(fs.existsSync)
			.mockReturnValueOnce(true)  // repoPath exists
			.mockReturnValueOnce(false); // .git does not exist

		await manager.syncBridge(bridge, true);

		expect(bridge.status).toBe('error');
		expect(plugin.saveSettings).toHaveBeenCalled();
	});

	it('sets status=error for an invalid branch name with shell metacharacters', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ branch: 'bad$branch' });
		plugin.settings.bridges.push(bridge);

		await manager.syncBridge(bridge, true);

		expect(bridge.status).toBe('error');
		expect(plugin.saveSettings).toHaveBeenCalled();
	});
});

// ─── syncBridge — dirty check (force=false) ───────────────────────────────────

describe('BridgeManager.syncBridge — dirty check', () => {
	it('opens DirtyWarningModal and returns early when vault has unsaved edits', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({
			vaultPath: 'Work/Docs',
			fileManifest: { 'README.md': 1000 },
		});
		plugin.settings.bridges.push(bridge);

		// Make checkDirty return true: file mtime changed
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readdirSync).mockReturnValue([
			{ name: 'README.md', isDirectory: () => false, isFile: () => true },
		] as any);
		vi.mocked(fs.statSync).mockReturnValue({
			isDirectory: () => false,
			isFile: () => true,
			mtimeMs: 9999, // different from manifest value of 1000
		} as any);

		// Call with force=false (default)
		await manager.syncBridge(bridge);

		expect(DirtyWarningModal).toHaveBeenCalled();
		// Bridge should NOT reach 'ok' — was aborted before git pull
		expect(bridge.status).not.toBe('ok');
	});
});

// ─── syncBridge — happy path ──────────────────────────────────────────────────

describe('BridgeManager.syncBridge — happy path', () => {
	it('sets status=ok and records lastPulled when sync succeeds', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge();
		plugin.settings.bridges.push(bridge);

		// existsSync: repoPath true, .git true, sourcePath true, destParent true, destPath true (for lstatSync)
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.lstatSync).mockReturnValue({ isSymbolicLink: () => false } as any);
		vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true, isFile: () => false, mtimeMs: 0 } as any);
		vi.mocked(fs.readdirSync).mockReturnValue([]);

		// force=true to skip dirty check
		await manager.syncBridge(bridge, true);

		expect(bridge.status).toBe('ok');
		expect(bridge.lastPulled).toBeDefined();
		expect(plugin.saveSettings).toHaveBeenCalled();
	});
});

// ─── pushBridge — nothing to push ─────────────────────────────────────────────

describe('BridgeManager.pushBridge — nothing to push', () => {
	it('sets status=ok without committing when git status --porcelain returns empty', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge();
		plugin.settings.bridges.push(bridge);

		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true, isFile: () => false, mtimeMs: 0 } as any);
		vi.mocked(fs.readdirSync).mockReturnValue([]);
		vi.mocked(fs.lstatSync).mockReturnValue({ isSymbolicLink: () => false } as any);

		vi.mocked(exec).mockImplementation((cmd: any, opts: any, cb: any) => {
			if (cmd.includes('status --porcelain')) {
				cb(null, { stdout: '', stderr: '' });
			} else {
				cb(null, { stdout: '', stderr: '' });
			}
			return {} as any;
		});

		await manager.pushBridge(bridge);

		expect(bridge.status).toBe('ok');

		// Verify commit was NOT called
		const execCalls = vi.mocked(exec).mock.calls.map(([cmd]: any[]) => cmd as string);
		const commitCalled = execCalls.some((cmd) => cmd.includes('commit'));
		expect(commitCalled).toBe(false);
	});
});

// ─── pushBridge — happy path (with changes) ──────────────────────────────────

describe('BridgeManager.pushBridge — happy path', () => {
	it('commits and pushes when git status shows pending changes', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge();
		plugin.settings.bridges.push(bridge);

		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true, isFile: () => false, mtimeMs: 0 } as any);
		vi.mocked(fs.readdirSync).mockReturnValue([]);
		vi.mocked(fs.lstatSync).mockReturnValue({ isSymbolicLink: () => false } as any);

		vi.mocked(exec).mockImplementation((cmd: any, opts: any, cb: any) => {
			if (cmd.includes('status --porcelain')) {
				cb(null, { stdout: 'M src/file.ts', stderr: '' });
			} else {
				cb(null, { stdout: '', stderr: '' });
			}
			return {} as any;
		});

		await manager.pushBridge(bridge);

		expect(bridge.status).toBe('ok');
		expect(bridge.lastPushed).toBeDefined();
		expect(plugin.saveSettings).toHaveBeenCalled();

		const execCalls = vi.mocked(exec).mock.calls.map(([cmd]: any[]) => cmd as string);
		expect(execCalls.some(cmd => cmd.includes('commit'))).toBe(true);
		expect(execCalls.some(cmd => cmd.includes('push'))).toBe(true);
	});
});

// ─── syncOnStartup ────────────────────────────────────────────────────────────

describe('BridgeManager.syncOnStartup', () => {
	it('does nothing when syncOnStartup is disabled', async () => {
		const plugin = makePlugin({ syncOnStartup: false });
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ autoSync: true });
		plugin.settings.bridges.push(bridge);

		await manager.syncOnStartup();

		expect(exec).not.toHaveBeenCalled();
	});

	it('skips and shows a Notice when a bridge has unsaved edits', async () => {
		const plugin = makePlugin({ syncOnStartup: true });
		const manager = new BridgeManager(plugin);
		// fileManifest with a changed mtime makes checkDirty return true
		const bridge = makeBridge({
			autoSync: true,
			vaultPath: 'Work/Docs',
			fileManifest: { 'README.md': 1000 },
		});
		plugin.settings.bridges.push(bridge);

		// Make checkDirty return true
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readdirSync).mockReturnValue([
			{ name: 'README.md', isDirectory: () => false, isFile: () => true },
		] as any);
		vi.mocked(fs.statSync).mockReturnValue({
			isDirectory: () => false,
			isFile: () => true,
			mtimeMs: 9999,
		} as any);

		await manager.syncOnStartup();

		expect(Notice).toHaveBeenCalledWith(
			expect.stringContaining('unsaved edits'),
			expect.any(Number),
		);

		// exec should NOT have been called with a pull command
		const execCalls = vi.mocked(exec).mock.calls.map(([cmd]: any[]) => cmd as string);
		expect(execCalls.some(cmd => cmd.includes('pull'))).toBe(false);
	});
});

// ─── syncAll ──────────────────────────────────────────────────────────────────

describe('BridgeManager.syncAll', () => {
	it('shows a Notice and does not exec when no bridges are configured', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		// plugin.settings.bridges is already []

		await manager.syncAll();

		expect(Notice).toHaveBeenCalledWith('Vault Bridges: No bridges configured.');
		expect(exec).not.toHaveBeenCalled();
	});
});
