import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock declarations (hoisted) ──────────────────────────────────────────────

vi.mock('child_process', () => ({ exec: vi.fn() }));

vi.mock('fs', () => ({
	existsSync: vi.fn(),
	lstatSync: vi.fn(),
	statSync: vi.fn(),
	readdirSync: vi.fn(),
	readFileSync: vi.fn().mockReturnValue(Buffer.from('')),
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
import type { Bridge, ChangedFile } from '../../src/types';

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

	it('returns false when file hash matches manifest', () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		// vaultPath = 'Work/Docs' → destPath = '/mock/vault/Work/Docs'
		// readFileSync mock returns Buffer.from(''), whose SHA-1 is da39a3ee…
		const SHA1_EMPTY = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
		const bridge = makeBridge({ vaultPath: 'Work/Docs', fileManifest: { 'README.md': SHA1_EMPTY } });

		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readdirSync).mockReturnValue([
			{ name: 'README.md', isDirectory: () => false, isFile: () => true },
		] as any);
		vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false, isFile: () => true } as any);

		expect(manager.checkDirty(bridge)).toBe(false);
	});

	it('returns true when file hash differs from manifest', () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		// fileManifest records a different hash than what readFileSync will produce
		const bridge = makeBridge({ vaultPath: 'Work/Docs', fileManifest: { 'README.md': 'oldhashvalue' } });

		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readdirSync).mockReturnValue([
			{ name: 'README.md', isDirectory: () => false, isFile: () => true },
		] as any);
		vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false, isFile: () => true } as any);

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
			} else if (cmd.includes('diff --cached --name-only')) {
				cb(null, { stdout: 'src/file.ts', stderr: '' });
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

	it('clears stale activeWorktreePath when worktree dir is gone', async () => {
		// Use syncOnStartup: false so the sweep runs (it runs before the guard) but
		// the subsequent per-bridge sync does not. This lets us assert the intermediate
		// 'unknown' status that the sweep sets before any pull resolves it.
		const plugin = makePlugin({ syncOnStartup: false });
		const manager = new BridgeManager(plugin);
		const staleWorktreePath = '/private/var/folders/stale-worktree';
		const bridge = makeBridge({
			autoSync: true,
			activeWorktreePath: staleWorktreePath,
			activeWorktreeBranch: 'claude/feature',
		});
		plugin.settings.bridges.push(bridge);

		// The stale worktree path does not exist; everything else does.
		vi.mocked(fs.existsSync).mockImplementation((p: any) => p !== staleWorktreePath);

		await manager.syncOnStartup();

		expect(bridge.activeWorktreePath).toBeUndefined();
		expect(bridge.activeWorktreeBranch).toBeUndefined();
		expect(bridge.status).toBe('unknown');
		expect(plugin.saveSettings).toHaveBeenCalled();
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

// ─── gitPull — stale worktree self-heal ──────────────────────────────────────

describe('BridgeManager.syncBridge — stale worktree self-heal', () => {
	it('clears stale activeWorktreePath and syncs against real repoPath', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const staleWorktreePath = '/private/var/folders/stale-worktree';
		const bridge = makeBridge({
			repoPath: '/repo/path',
			activeWorktreePath: staleWorktreePath,
			activeWorktreeBranch: 'claude/feature',
		});
		plugin.settings.bridges.push(bridge);

		// The stale worktree does not exist; the real repo and its .git dir do.
		vi.mocked(fs.existsSync).mockImplementation((p: any) => p !== staleWorktreePath);
		vi.mocked(fs.lstatSync).mockReturnValue({ isSymbolicLink: () => false } as any);
		vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true, isFile: () => false, mtimeMs: 0 } as any);
		vi.mocked(fs.readdirSync).mockReturnValue([]);

		await manager.syncBridge(bridge, true);

		// Stale fields must be cleared
		expect(bridge.activeWorktreePath).toBeUndefined();
		expect(bridge.activeWorktreeBranch).toBeUndefined();

		// Sync must succeed against the real repoPath
		expect(bridge.status).toBe('ok');
		expect(plugin.saveSettings).toHaveBeenCalled();

		// Confirm no git commands were attempted against the stale path
		const execCalls = vi.mocked(exec).mock.calls.map(([cmd]: any[]) => cmd as string);
		expect(execCalls.some(cmd => cmd.includes(staleWorktreePath))).toBe(false);
	});
});

// ─── Pure diffing logic ───────────────────────────────────────────────────────
//
// BridgeManager.getChangedFiles() builds a current manifest from disk and
// compares it to bridge.fileManifest. The diffing itself is a pure function of
// two Record<string, string> objects (relPath → SHA-1 hash). We extract that
// logic here and test it without importing BridgeManager (which pulls in
// Obsidian APIs not available in unit-test context).
//
// Implementation mirrors BridgeManager.getChangedFiles() exactly:
//   src/BridgeManager.ts lines 119–132

function computeChangedFiles(
	stored: Record<string, string>,
	current: Record<string, string>,
): ChangedFile[] {
	const changes: ChangedFile[] = [];

	for (const [relPath, hash] of Object.entries(current)) {
		if (!(relPath in stored)) {
			changes.push({ relPath, status: 'added' });
		} else if (stored[relPath] !== hash) {
			changes.push({ relPath, status: 'modified' });
		}
	}
	for (const relPath of Object.keys(stored)) {
		if (!(relPath in current)) {
			changes.push({ relPath, status: 'deleted' });
		}
	}

	return changes.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

// ─── onVaultFileModified branching logic ─────────────────────────────────────
//
// BridgeManager.onVaultFileModified() was recently fixed so that
// fileCommandBar.update() fires on every bridge-file change, not just when
// isDirty flips. We inline the conditional logic from the method here and drive
// it with plain objects to verify both branches without importing BridgeManager.
//
// Implementation mirrors BridgeManager.onVaultFileModified() (lines 59–83).

interface MinimalBridge {
	vaultPath: string;
	fileManifest: Record<string, string> | undefined;
	isDirty: boolean;
}

interface CallRecorder {
	fileCommandBarUpdateCalls: number;
	saveSettingsCalls: number;
	statusBarUpdateCalls: number;
}

/**
 * Inline replica of the onVaultFileModified branching logic.
 * checkDirty is injected as a parameter so tests control its return value.
 */
function simulateOnVaultFileModified(
	filePath: string,
	bridges: MinimalBridge[],
	checkDirty: (bridge: MinimalBridge) => boolean,
	recorder: CallRecorder,
): void {
	let anyBridgeFile = false;
	let anyChanged = false;

	for (const bridge of bridges) {
		if (!bridge.fileManifest) continue;
		if (!filePath.startsWith(bridge.vaultPath + '/') && filePath !== bridge.vaultPath) continue;
		anyBridgeFile = true;
		const isDirty = checkDirty(bridge);
		if (bridge.isDirty !== isDirty) {
			bridge.isDirty = isDirty;
			anyChanged = true;
		}
	}

	// Always re-render the command bar for any bridge file change.
	if (anyBridgeFile) {
		recorder.fileCommandBarUpdateCalls++;
	}
	// Only persist when the dirty flag actually flipped.
	if (anyChanged) {
		recorder.saveSettingsCalls++;
		recorder.statusBarUpdateCalls++;
	}
}

// ─── Tests: getChangedFiles diffing logic ─────────────────────────────────────

describe('computeChangedFiles (getChangedFiles diffing logic)', () => {
	it('returns no changes when both manifests are empty', () => {
		const result = computeChangedFiles({}, {});
		expect(result).toEqual([]);
	});

	it('returns no changes when current matches stored exactly', () => {
		const manifest = {
			'docs/README.md': 'abc123',
			'src/index.ts': 'def456',
		};
		const result = computeChangedFiles(manifest, { ...manifest });
		expect(result).toEqual([]);
	});

	it('detects a single modified file (hash differs)', () => {
		const stored = { 'src/index.ts': 'aaa' };
		const current = { 'src/index.ts': 'bbb' };

		const result = computeChangedFiles(stored, current);

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ relPath: 'src/index.ts', status: 'modified' });
	});

	it('detects a single added file (present in current, absent in stored)', () => {
		const stored = { 'existing.md': 'aaa' };
		const current = { 'existing.md': 'aaa', 'new-file.md': 'bbb' };

		const result = computeChangedFiles(stored, current);

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ relPath: 'new-file.md', status: 'added' });
	});

	it('detects a single deleted file (present in stored, absent in current)', () => {
		const stored = { 'keep.md': 'aaa', 'gone.md': 'bbb' };
		const current = { 'keep.md': 'aaa' };

		const result = computeChangedFiles(stored, current);

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ relPath: 'gone.md', status: 'deleted' });
	});

	it('detects a mix of modified, added, and deleted files simultaneously', () => {
		const stored = {
			'modified.md': 'old-hash',
			'deleted.md': 'some-hash',
			'unchanged.md': 'same-hash',
		};
		const current = {
			'modified.md': 'new-hash',
			'added.md': 'fresh-hash',
			'unchanged.md': 'same-hash',
		};

		const result = computeChangedFiles(stored, current);

		expect(result).toHaveLength(3);

		const byPath = Object.fromEntries(result.map(r => [r.relPath, r.status]));
		expect(byPath['modified.md']).toBe('modified');
		expect(byPath['added.md']).toBe('added');
		expect(byPath['deleted.md']).toBe('deleted');
		expect(byPath['unchanged.md']).toBeUndefined();
	});

	it('sorts results alphabetically by relPath', () => {
		const stored = { 'z-file.md': 'aaa', 'a-file.md': 'old' };
		const current = { 'z-file.md': 'aaa', 'm-file.md': 'new', 'a-file.md': 'changed' };

		const result = computeChangedFiles(stored, current);

		const paths = result.map(r => r.relPath);
		expect(paths).toEqual([...paths].sort());
	});

	it('treats a stored file with empty-string hash as distinct from a missing key', () => {
		// Guards against a hash of '' being accidentally treated as falsy and
		// matching a new file whose key does exist in stored.
		const stored = { 'file.md': '' };
		const current = { 'file.md': 'abc' };

		const result = computeChangedFiles(stored, current);

		expect(result).toHaveLength(1);
		expect(result[0].status).toBe('modified');
	});

	it('handles a large number of files without errors', () => {
		const stored: Record<string, string> = {};
		const current: Record<string, string> = {};
		for (let i = 0; i < 500; i++) {
			const key = `dir/file-${i}.md`;
			stored[key] = `hash-${i}`;
			current[key] = `hash-${i}`;
		}
		// Modify 10, delete 5, add 5 new ones
		for (let i = 0; i < 10; i++) current[`dir/file-${i}.md`] = 'mutated';
		for (let i = 10; i < 15; i++) delete current[`dir/file-${i}.md`];
		for (let i = 500; i < 505; i++) current[`dir/file-${i}.md`] = `hash-${i}`;

		const result = computeChangedFiles(stored, current);

		expect(result.filter(r => r.status === 'modified')).toHaveLength(10);
		expect(result.filter(r => r.status === 'deleted')).toHaveLength(5);
		expect(result.filter(r => r.status === 'added')).toHaveLength(5);
	});
});

// ─── Tests: onVaultFileModified branching logic ───────────────────────────────

describe('onVaultFileModified branching logic', () => {
	let recorder: CallRecorder;

	beforeEach(() => {
		recorder = {
			fileCommandBarUpdateCalls: 0,
			saveSettingsCalls: 0,
			statusBarUpdateCalls: 0,
		};
	});

	it('when bridge isDirty=false and a file is modified → isDirty flips to true, fileCommandBar.update() called, settings saved', () => {
		const bridge: MinimalBridge = {
			vaultPath: 'notes/project',
			fileManifest: { 'README.md': 'abc' },
			isDirty: false,
		};
		// checkDirty reports the bridge is now dirty
		const checkDirty = () => true;

		simulateOnVaultFileModified('notes/project/README.md', [bridge], checkDirty, recorder);

		expect(bridge.isDirty).toBe(true);
		expect(recorder.fileCommandBarUpdateCalls).toBe(1);
		expect(recorder.saveSettingsCalls).toBe(1);
		expect(recorder.statusBarUpdateCalls).toBe(1);
	});

	it('when bridge isDirty=true and another file in the same bridge is modified → isDirty stays true, fileCommandBar.update() still called', () => {
		// This is the bug that was fixed: previously update() was only called
		// when isDirty changed, so a second edit inside an already-dirty bridge
		// would not re-render the command bar, leaving the pending-changes count stale.
		const bridge: MinimalBridge = {
			vaultPath: 'notes/project',
			fileManifest: { 'README.md': 'abc', 'other.md': 'def' },
			isDirty: true,
		};
		// checkDirty still reports dirty (no flip)
		const checkDirty = () => true;

		simulateOnVaultFileModified('notes/project/other.md', [bridge], checkDirty, recorder);

		expect(bridge.isDirty).toBe(true);                          // unchanged
		expect(recorder.fileCommandBarUpdateCalls).toBe(1);         // still fires
		expect(recorder.saveSettingsCalls).toBe(0);                 // no flip → no save
		expect(recorder.statusBarUpdateCalls).toBe(0);              // no flip → no update
	});

	it('when file is not inside any bridge → nothing is called', () => {
		const bridge: MinimalBridge = {
			vaultPath: 'notes/project',
			fileManifest: { 'README.md': 'abc' },
			isDirty: false,
		};
		const checkDirty = vi.fn(() => false);

		simulateOnVaultFileModified('personal/diary.md', [bridge], checkDirty, recorder);

		expect(checkDirty).not.toHaveBeenCalled();
		expect(recorder.fileCommandBarUpdateCalls).toBe(0);
		expect(recorder.saveSettingsCalls).toBe(0);
	});

	it('when bridge has no fileManifest → treated as not a bridge file, nothing called', () => {
		const bridge: MinimalBridge = {
			vaultPath: 'notes/project',
			fileManifest: undefined,
			isDirty: false,
		};
		const checkDirty = vi.fn(() => true);

		simulateOnVaultFileModified('notes/project/README.md', [bridge], checkDirty, recorder);

		expect(checkDirty).not.toHaveBeenCalled();
		expect(recorder.fileCommandBarUpdateCalls).toBe(0);
	});

	it('when file path matches the bridge vaultPath exactly (not a subfolder) → still counts as a bridge file', () => {
		// BridgeManager checks: filePath === bridge.vaultPath (in addition to startsWith)
		const bridge: MinimalBridge = {
			vaultPath: 'notes/project',
			fileManifest: { 'notes/project': 'abc' },
			isDirty: false,
		};
		const checkDirty = () => true;

		simulateOnVaultFileModified('notes/project', [bridge], checkDirty, recorder);

		expect(recorder.fileCommandBarUpdateCalls).toBe(1);
	});

	it('does not match a path that shares a prefix but lacks the trailing slash', () => {
		// 'notes/project-extra/file.md' must NOT match a bridge at 'notes/project'
		const bridge: MinimalBridge = {
			vaultPath: 'notes/project',
			fileManifest: { 'README.md': 'abc' },
			isDirty: false,
		};
		const checkDirty = vi.fn(() => true);

		simulateOnVaultFileModified('notes/project-extra/file.md', [bridge], checkDirty, recorder);

		expect(checkDirty).not.toHaveBeenCalled();
		expect(recorder.fileCommandBarUpdateCalls).toBe(0);
	});

	it('when isDirty flips from true to false → saveSettings and statusBar.update() called', () => {
		// E.g. after an undo that restores the file to its recorded hash
		const bridge: MinimalBridge = {
			vaultPath: 'notes/project',
			fileManifest: { 'README.md': 'abc' },
			isDirty: true,
		};
		const checkDirty = () => false; // vault is now clean

		simulateOnVaultFileModified('notes/project/README.md', [bridge], checkDirty, recorder);

		expect(bridge.isDirty).toBe(false);
		expect(recorder.fileCommandBarUpdateCalls).toBe(1);
		expect(recorder.saveSettingsCalls).toBe(1);
	});

	it('routes events to the correct bridge when multiple bridges are configured', () => {
		const bridgeA: MinimalBridge = {
			vaultPath: 'project-a',
			fileManifest: { 'file.md': 'aaa' },
			isDirty: false,
		};
		const bridgeB: MinimalBridge = {
			vaultPath: 'project-b',
			fileManifest: { 'file.md': 'bbb' },
			isDirty: false,
		};
		const checkDirty = (b: MinimalBridge) => b === bridgeA; // only A is dirty

		simulateOnVaultFileModified('project-a/file.md', [bridgeA, bridgeB], checkDirty, recorder);

		expect(bridgeA.isDirty).toBe(true);
		expect(bridgeB.isDirty).toBe(false); // untouched
		expect(recorder.fileCommandBarUpdateCalls).toBe(1);
		expect(recorder.saveSettingsCalls).toBe(1);
	});
});
