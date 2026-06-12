import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock declarations (hoisted) ──────────────────────────────────────────────

vi.mock('child_process', () => ({ exec: vi.fn() }));

vi.mock('fs', () => ({
	existsSync: vi.fn(),
	lstatSync: vi.fn(),
	statSync: vi.fn(),
	readdirSync: vi.fn(),
	readFileSync: vi.fn().mockReturnValue(Buffer.from('')),
	realpathSync: vi.fn((p: string) => p),
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
import { BridgeManager } from '../../src/BridgeManager';
import { DirtyWarningModal } from '../../src/DirtyWarningModal';
import type VaultBridgesPlugin from '../../main';
import type { Bridge } from '../../src/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WT_PATH = '/tmp/worktrees/feature-x';
const WT_BRANCH = 'feature/worktree-x';

const PORCELAIN = [
	'worktree /repo/path',
	'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	'branch refs/heads/main',
	'',
	`worktree ${WT_PATH}`,
	'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
	`branch refs/heads/${WT_BRANCH}`,
	'',
].join('\n');

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

function makePlugin(): VaultBridgesPlugin {
	const settings = {
		bridges: [] as Bridge[],
		syncOnStartup: true,
		claudePath: '',
		claudeEnabled: false,
	};
	return {
		app: { vault: { adapter: { basePath: '/mock/vault' } }, workspace: {} },
		settings,
		saveSettings: vi.fn().mockResolvedValue(undefined),
		statusBar: { update: vi.fn() },
	} as unknown as VaultBridgesPlugin;
}

/**
 * Routes exec calls by command content. `remoteHasBranch` controls whether the
 * `git ls-remote --heads origin <branch>` probe finds the branch on origin.
 */
function setupExecRouter({ remoteHasBranch = true, headBranch = WT_BRANCH, mainHeadBranch = 'main', stagedChanges = false } = {}) {
	vi.mocked(exec).mockImplementation((cmd: any, opts: any, cb: any) => {
		if (cmd.includes('worktree list --porcelain')) {
			cb(null, { stdout: PORCELAIN, stderr: '' });
		} else if (cmd.includes('ls-remote --heads origin')) {
			// Non-empty stdout ⇒ origin has the branch. Empty ⇒ local-only.
			cb(null, { stdout: remoteHasBranch ? 'deadbeef\trefs/heads/branch\n' : '', stderr: '' });
		} else if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
			// The main checkout (`/repo/path`) and a linked worktree can be on
			// different branches — route by the `-C` target path.
			const branch = cmd.includes(WT_PATH) ? headBranch : mainHeadBranch;
			cb(null, { stdout: `${branch}\n`, stderr: '' });
		} else if (cmd.includes('diff --cached --name-only')) {
			cb(null, { stdout: stagedChanges ? 'file.md' : '', stderr: '' });
		} else {
			cb(null, { stdout: '', stderr: '' });
		}
		return {} as any;
	});
}

function execCalls(): string[] {
	return vi.mocked(exec).mock.calls.map(([cmd]: any[]) => cmd as string);
}

// ─── beforeEach / afterEach ───────────────────────────────────────────────────

beforeEach(() => {
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
	vi.mocked(fs.realpathSync).mockImplementation(((p: string) => p) as any);
	setupExecRouter();
});

afterEach(() => {
	vi.clearAllMocks();
});

// ─── effectiveRepoPath ────────────────────────────────────────────────────────

describe('BridgeManager.effectiveRepoPath', () => {
	it('returns repoPath when no worktree is active', () => {
		const manager = new BridgeManager(makePlugin());
		expect(manager.effectiveRepoPath(makeBridge())).toBe('/repo/path');
	});

	it('returns the active worktree path when set', () => {
		const manager = new BridgeManager(makePlugin());
		const bridge = makeBridge({ activeWorktreePath: WT_PATH });
		expect(manager.effectiveRepoPath(bridge)).toBe(WT_PATH);
	});
});

// ─── listWorktrees ────────────────────────────────────────────────────────────

describe('BridgeManager.listWorktrees', () => {
	it('parses porcelain output into WorktreeInfo entries', async () => {
		const manager = new BridgeManager(makePlugin());
		const result = await manager.listWorktrees(makeBridge());

		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			path: '/repo/path',
			branch: 'main',
			isMain: true,
			isActive: true, // no override → main checkout is active
		});
		expect(result[1]).toEqual({
			path: WT_PATH,
			branch: WT_BRANCH,
			isMain: false,
			isActive: false,
		});
	});

	it('marks the active worktree when the bridge has an override', async () => {
		const manager = new BridgeManager(makePlugin());
		const bridge = makeBridge({ activeWorktreePath: WT_PATH });
		const result = await manager.listWorktrees(bridge);

		expect(result[0].isActive).toBe(false);
		expect(result[1].isActive).toBe(true);
	});

	it('reports a detached worktree with an empty branch', async () => {
		vi.mocked(exec).mockImplementation((cmd: any, opts: any, cb: any) => {
			cb(null, {
				stdout: 'worktree /repo/path\nHEAD aaa\nbranch refs/heads/main\n\nworktree /tmp/detached\nHEAD bbb\ndetached\n',
				stderr: '',
			});
			return {} as any;
		});
		const manager = new BridgeManager(makePlugin());
		const result = await manager.listWorktrees(makeBridge());

		expect(result[1]).toMatchObject({ path: '/tmp/detached', branch: '', isMain: false });
	});
});

// ─── switchWorktree ───────────────────────────────────────────────────────────

describe('BridgeManager.switchWorktree', () => {
	it('sets the worktree fields and triggers a forced re-pull', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge();
		plugin.settings.bridges.push(bridge);
		setupExecRouter({ remoteHasBranch: false }); // local-only worktree branch (not on origin)

		await manager.switchWorktree(bridge, WT_PATH);

		expect(bridge.activeWorktreePath).toBe(WT_PATH);
		expect(bridge.activeWorktreeBranch).toBe(WT_BRANCH);
		expect(bridge.status).toBe('ok');
		expect(bridge.lastPulled).toBeDefined();
		expect(plugin.saveSettings).toHaveBeenCalled();
	});

	it('skips the network pull when the worktree branch is not on origin', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge();
		plugin.settings.bridges.push(bridge);
		setupExecRouter({ remoteHasBranch: false });

		await manager.switchWorktree(bridge, WT_PATH);

		expect(bridge.status).toBe('ok');
		expect(execCalls().some(cmd => cmd.includes('pull origin'))).toBe(false);
	});

	it('pulls over the network when the worktree branch has an upstream', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge();
		plugin.settings.bridges.push(bridge);
		setupExecRouter({ remoteHasBranch: true });

		await manager.switchWorktree(bridge, WT_PATH);

		expect(bridge.status).toBe('ok');
		expect(execCalls().some(cmd =>
			cmd.includes(`git -C "${WT_PATH}" pull origin "${WT_BRANCH}"`)
		)).toBe(true);
	});

	it('clears the override when switching back to null (main repo)', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ activeWorktreePath: WT_PATH, activeWorktreeBranch: WT_BRANCH });
		plugin.settings.bridges.push(bridge);

		await manager.switchWorktree(bridge, null);

		expect(bridge.activeWorktreePath).toBeUndefined();
		expect(bridge.activeWorktreeBranch).toBeUndefined();
		expect(bridge.status).toBe('ok');
		// Pull went back to the configured branch at the main repo path
		expect(execCalls().some(cmd =>
			cmd.includes('git -C "/repo/path" pull origin "main"')
		)).toBe(true);
	});

	it('treats selecting the main checkout path as clearing the override', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ activeWorktreePath: WT_PATH, activeWorktreeBranch: WT_BRANCH });
		plugin.settings.bridges.push(bridge);

		await manager.switchWorktree(bridge, '/repo/path');

		expect(bridge.activeWorktreePath).toBeUndefined();
		expect(bridge.activeWorktreeBranch).toBeUndefined();
	});

	it('throws when the path is not a linked worktree of the repo', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge();
		plugin.settings.bridges.push(bridge);

		await expect(manager.switchWorktree(bridge, '/some/random/path')).rejects.toThrow(
			/Not a linked worktree/
		);
		expect(bridge.activeWorktreePath).toBeUndefined();
	});

	it('opens DirtyWarningModal and does not switch when the vault has unsaved edits', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ fileManifest: { 'README.md': 'oldhash' } });
		plugin.settings.bridges.push(bridge);

		// Make checkDirty return true: a tracked file hash differs
		vi.mocked(fs.readdirSync).mockReturnValue([
			{ name: 'README.md', isDirectory: () => false, isFile: () => true },
		] as any);
		vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false, isFile: () => true } as any);

		await manager.switchWorktree(bridge, WT_PATH);

		expect(DirtyWarningModal).toHaveBeenCalled();
		expect(bridge.activeWorktreePath).toBeUndefined(); // switch aborted
	});

	it('bypasses the dirty check when force=true', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ fileManifest: { 'README.md': 'oldhash' } });
		plugin.settings.bridges.push(bridge);

		vi.mocked(fs.readdirSync).mockReturnValue([
			{ name: 'README.md', isDirectory: () => false, isFile: () => true },
		] as any);

		await manager.switchWorktree(bridge, WT_PATH, true);

		expect(DirtyWarningModal).not.toHaveBeenCalled();
		expect(bridge.activeWorktreePath).toBe(WT_PATH);
	});

	it('matches worktree paths through symlinks (realpath comparison)', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge();
		plugin.settings.bridges.push(bridge);

		// /var/... is a symlink to /private/var/... (macOS): git reports the
		// resolved path, the caller passes the symlinked one.
		vi.mocked(fs.realpathSync).mockImplementation(((p: string) =>
			p.replace(/^\/var\//, '/private/var/')) as any);

		const symlinked = WT_PATH.replace('/tmp/', '/tmp/'); // same path; realpath maps both sides
		await manager.switchWorktree(bridge, symlinked);

		expect(bridge.activeWorktreePath).toBe(WT_PATH);
	});
});

// ─── gitPull on a worktree (via syncBridge) ──────────────────────────────────

describe('BridgeManager.syncBridge — on a worktree', () => {
	it('derives the branch from the worktree HEAD instead of bridge.branch', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ activeWorktreePath: WT_PATH, branch: 'main' });
		plugin.settings.bridges.push(bridge);
		setupExecRouter({ remoteHasBranch: true, headBranch: WT_BRANCH });

		await manager.syncBridge(bridge, true);

		expect(bridge.status).toBe('ok');
		expect(bridge.activeWorktreeBranch).toBe(WT_BRANCH);
		expect(execCalls().some(cmd =>
			cmd.includes(`pull origin "${WT_BRANCH}"`)
		)).toBe(true);
		expect(execCalls().some(cmd => cmd.includes('pull origin "main"'))).toBe(false);
	});

	it('errors when the worktree is on a detached HEAD', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ activeWorktreePath: WT_PATH });
		plugin.settings.bridges.push(bridge);
		setupExecRouter({ headBranch: 'HEAD' }); // rev-parse output on detached HEAD

		await manager.syncBridge(bridge, true);

		expect(bridge.status).toBe('error');
		expect(bridge.lastError).toMatch(/detached HEAD/);
	});

	it('skips the pull for a local-only worktree branch even when it has an inherited upstream', async () => {
		// Regression: a worktree branch created from `main` inherits
		// `@{u} = origin/main`, so an upstream-existence check would say "pull".
		// But origin has no ref for the branch, so `pull origin <branch>` fails
		// with `couldn't find remote ref`. We must gate on the remote branch.
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ activeWorktreePath: WT_PATH, branch: 'main' });
		plugin.settings.bridges.push(bridge);
		setupExecRouter({ remoteHasBranch: false, headBranch: WT_BRANCH });

		await manager.syncBridge(bridge, true);

		expect(bridge.status).toBe('ok');
		expect(execCalls().some(cmd => cmd.includes('pull origin'))).toBe(false);
		// And it actually probed the remote for that specific branch.
		expect(execCalls().some(cmd =>
			cmd.includes(`ls-remote --heads origin "${WT_BRANCH}"`)
		)).toBe(true);
	});

	it('skips the pull (copies locally) when ls-remote itself fails', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ activeWorktreePath: WT_PATH, branch: 'main' });
		plugin.settings.bridges.push(bridge);
		// ls-remote errors (offline / no origin); everything else succeeds.
		vi.mocked(exec).mockImplementation((cmd: any, opts: any, cb: any) => {
			if (cmd.includes('worktree list --porcelain')) {
				cb(null, { stdout: PORCELAIN, stderr: '' });
			} else if (cmd.includes('ls-remote --heads origin')) {
				cb(new Error('fatal: unable to access origin'), { stdout: '', stderr: '' });
			} else if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
				cb(null, { stdout: `${WT_BRANCH}\n`, stderr: '' });
			} else {
				cb(null, { stdout: '', stderr: '' });
			}
			return {} as any;
		});

		await manager.syncBridge(bridge, true);

		expect(bridge.status).toBe('ok');
		expect(execCalls().some(cmd => cmd.includes('pull origin'))).toBe(false);
	});
});

// ─── gitPull when the main checkout is parked on a different branch ──────────

describe('BridgeManager.syncBridge — main checkout on a non-configured branch', () => {
	it('follows the checked-out branch instead of the configured branch', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ branch: 'main' }); // no worktree
		plugin.settings.bridges.push(bridge);
		// Main repo is parked on a feature branch with an upstream.
		setupExecRouter({ remoteHasBranch: true, mainHeadBranch: 'feat/parked' });

		await manager.syncBridge(bridge, true);

		expect(bridge.status).toBe('ok');
		expect(execCalls().some(cmd =>
			cmd.includes('git -C "/repo/path" pull origin "feat/parked"')
		)).toBe(true);
		// Never attempts the doomed cross-branch pull of the configured branch.
		expect(execCalls().some(cmd => cmd.includes('pull origin "main"'))).toBe(false);
	});

	it('skips the network pull when the parked branch is not on origin', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ branch: 'main' });
		plugin.settings.bridges.push(bridge);
		setupExecRouter({ remoteHasBranch: false, mainHeadBranch: 'feat/local-only' });

		await manager.syncBridge(bridge, true);

		expect(bridge.status).toBe('ok');
		expect(execCalls().some(cmd => cmd.includes('pull origin'))).toBe(false);
	});

	it('pulls the configured branch normally when the checkout is on it', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ branch: 'main' });
		plugin.settings.bridges.push(bridge);
		setupExecRouter({ remoteHasBranch: true, mainHeadBranch: 'main' });

		await manager.syncBridge(bridge, true);

		expect(bridge.status).toBe('ok');
		expect(execCalls().some(cmd =>
			cmd.includes('git -C "/repo/path" pull origin "main"')
		)).toBe(true);
	});

	it('falls back to the configured branch on a detached HEAD', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ branch: 'main' });
		plugin.settings.bridges.push(bridge);
		// A detached main checkout reports "HEAD" from rev-parse --abbrev-ref.
		setupExecRouter({ remoteHasBranch: true, mainHeadBranch: 'HEAD' });

		await manager.syncBridge(bridge, true);

		expect(bridge.status).toBe('ok');
		expect(execCalls().some(cmd =>
			cmd.includes('git -C "/repo/path" pull origin "main"')
		)).toBe(true);
	});

	it('pushes the checked-out branch when parked on a non-configured branch', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ branch: 'main' }); // no worktree, no prMode
		plugin.settings.bridges.push(bridge);
		setupExecRouter({ stagedChanges: true, mainHeadBranch: 'feat/parked' });

		await manager.pushBridge(bridge);

		expect(bridge.status).toBe('ok');
		const calls = execCalls();
		expect(calls.some(cmd =>
			cmd.includes('git -C "/repo/path" push -u origin "feat/parked"')
		)).toBe(true);
		expect(calls.some(cmd => cmd.includes('push -u origin "main"'))).toBe(false);
	});
});

// ─── hasGitDirtyState ─────────────────────────────────────────────────────────

describe('BridgeManager.hasGitDirtyState', () => {
	it('returns true when git status --porcelain has output', async () => {
		const manager = new BridgeManager(makePlugin());
		const bridge = makeBridge();
		vi.mocked(exec).mockImplementation((cmd: any, opts: any, cb: any) => {
			if (cmd.includes('status --porcelain')) {
				cb(null, { stdout: ' M src/foo.ts\n', stderr: '' });
			} else {
				cb(null, { stdout: '', stderr: '' });
			}
			return {} as any;
		});

		expect(await manager.hasGitDirtyState(bridge)).toBe(true);
	});

	it('returns false when the working tree is clean', async () => {
		const manager = new BridgeManager(makePlugin());
		// setupExecRouter default returns empty stdout for status --porcelain
		expect(await manager.hasGitDirtyState(makeBridge())).toBe(false);
	});

	it('returns false (non-fatal) when git status fails', async () => {
		const manager = new BridgeManager(makePlugin());
		vi.mocked(exec).mockImplementation((cmd: any, opts: any, cb: any) => {
			if (cmd.includes('status --porcelain')) {
				cb(new Error('not a git repo'), { stdout: '', stderr: '' });
			} else {
				cb(null, { stdout: '', stderr: '' });
			}
			return {} as any;
		});

		expect(await manager.hasGitDirtyState(makeBridge())).toBe(false);
	});

	it('targets the active worktree path when one is set', async () => {
		const manager = new BridgeManager(makePlugin());
		const bridge = makeBridge({ activeWorktreePath: WT_PATH });

		await manager.hasGitDirtyState(bridge);

		expect(execCalls().some(cmd =>
			cmd.includes(`git -C "${WT_PATH}" status --porcelain`)
		)).toBe(true);
	});
});

// ─── stashAndSwitch ───────────────────────────────────────────────────────────

describe('BridgeManager.stashAndSwitch', () => {
	function makeStashRouter(opts: {
		stashOut?: string;
		stashFails?: boolean;
		popFails?: boolean;
	} = {}) {
		const {
			stashOut = 'Saved working directory and index state vault-bridges stash-and-switch\n',
			stashFails = false,
			popFails = false,
		} = opts;

		vi.mocked(exec).mockImplementation((cmd: any, opts: any, cb: any) => {
			if (cmd.includes('worktree list --porcelain')) {
				cb(null, { stdout: PORCELAIN, stderr: '' });
			} else if (cmd.includes('stash push')) {
				if (stashFails) {
					cb(new Error('cannot stash'), { stdout: '', stderr: '' });
				} else {
					cb(null, { stdout: stashOut, stderr: '' });
				}
			} else if (cmd.includes('stash pop')) {
				if (popFails) {
					cb(new Error('CONFLICT'), { stdout: '', stderr: '' });
				} else {
					cb(null, { stdout: '', stderr: '' });
				}
			} else if (cmd.includes('ls-remote --heads origin')) {
				cb(null, { stdout: '', stderr: '' }); // local-only branch
			} else if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
				const branch = cmd.includes(WT_PATH) ? WT_BRANCH : 'main';
				cb(null, { stdout: `${branch}\n`, stderr: '' });
			} else {
				cb(null, { stdout: '', stderr: '' });
			}
			return {} as any;
		});
	}

	it('stashes in the source, switches, then pops in the destination', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge();
		plugin.settings.bridges.push(bridge);
		makeStashRouter();

		await manager.stashAndSwitch(bridge, WT_PATH);

		const calls = execCalls();
		// Stash was pushed from the source (main repo)
		expect(calls.some(cmd =>
			cmd.includes('git -C "/repo/path" stash push --include-untracked')
		)).toBe(true);
		// Bridge now points at the worktree
		expect(bridge.activeWorktreePath).toBe(WT_PATH);
		// Stash was popped in the destination (worktree)
		expect(calls.some(cmd =>
			cmd.includes(`git -C "${WT_PATH}" stash pop`)
		)).toBe(true);
	});

	it('shows a Notice and aborts when stash push fails', async () => {
		const { Notice } = await import('obsidian');
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge();
		plugin.settings.bridges.push(bridge);
		makeStashRouter({ stashFails: true });

		await manager.stashAndSwitch(bridge, WT_PATH);

		expect(vi.mocked(Notice)).toHaveBeenCalledWith(
			expect.stringContaining('stash failed'),
			expect.any(Number),
		);
		expect(bridge.activeWorktreePath).toBeUndefined(); // switch did not happen
	});

	it('completes the switch but warns when stash pop conflicts', async () => {
		const { Notice } = await import('obsidian');
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge();
		plugin.settings.bridges.push(bridge);
		makeStashRouter({ popFails: true });

		await manager.stashAndSwitch(bridge, WT_PATH);

		// Switch still completed
		expect(bridge.activeWorktreePath).toBe(WT_PATH);
		// Warning Notice about stash pop failure
		expect(vi.mocked(Notice)).toHaveBeenCalledWith(
			expect.stringContaining('stash pop failed'),
			expect.any(Number),
		);
	});

	it('skips the stash pop when no changes were stashed', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge();
		plugin.settings.bridges.push(bridge);
		makeStashRouter({ stashOut: 'No local changes to save\n' });

		await manager.stashAndSwitch(bridge, WT_PATH);

		expect(execCalls().some(cmd => cmd.includes('stash pop'))).toBe(false);
	});
});

// ─── switchWorktree — git dirty state ────────────────────────────────────────

describe('BridgeManager.switchWorktree — git dirty state', () => {
	it('opens DirtyWarningModal with onStashAndSwitch when the repo has uncommitted changes', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge(); // no fileManifest → vault not dirty
		plugin.settings.bridges.push(bridge);

		vi.mocked(exec).mockImplementation((cmd: any, opts: any, cb: any) => {
			if (cmd.includes('status --porcelain')) {
				cb(null, { stdout: ' M src/foo.ts\n', stderr: '' });
			} else if (cmd.includes('worktree list --porcelain')) {
				cb(null, { stdout: PORCELAIN, stderr: '' });
			} else {
				cb(null, { stdout: '', stderr: '' });
			}
			return {} as any;
		});

		await manager.switchWorktree(bridge, WT_PATH);

		expect(DirtyWarningModal).toHaveBeenCalled();
		const [, , callbacks] = vi.mocked(DirtyWarningModal).mock.calls[0] as any[];
		expect(callbacks.onStashAndSwitch).toBeDefined();
		expect(callbacks.onPushThenPull).toBeUndefined(); // vault not dirty, no push button
		expect(bridge.activeWorktreePath).toBeUndefined(); // switch aborted
	});

	it('exposes both onPushThenPull and onStashAndSwitch when both are dirty', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		// Vault dirty: fileManifest present with stale hash
		const bridge = makeBridge({ fileManifest: { 'README.md': 'oldhash' } });
		plugin.settings.bridges.push(bridge);

		// readdirSync returns a file that differs from the manifest → checkDirty = true
		vi.mocked(fs.readdirSync).mockReturnValue([
			{ name: 'README.md', isDirectory: () => false, isFile: () => true },
		] as any);
		vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false, isFile: () => true } as any);

		vi.mocked(exec).mockImplementation((cmd: any, opts: any, cb: any) => {
			if (cmd.includes('status --porcelain')) {
				cb(null, { stdout: ' M src/foo.ts\n', stderr: '' }); // git also dirty
			} else if (cmd.includes('worktree list --porcelain')) {
				cb(null, { stdout: PORCELAIN, stderr: '' });
			} else {
				cb(null, { stdout: '', stderr: '' });
			}
			return {} as any;
		});

		await manager.switchWorktree(bridge, WT_PATH);

		const [, , callbacks] = vi.mocked(DirtyWarningModal).mock.calls[0] as any[];
		expect(callbacks.onPushThenPull).toBeDefined();
		expect(callbacks.onStashAndSwitch).toBeDefined();
	});

	it('does not open DirtyWarningModal when both vault and git are clean', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge();
		plugin.settings.bridges.push(bridge);
		setupExecRouter({ remoteHasBranch: false }); // clean repo, clean vault

		await manager.switchWorktree(bridge, WT_PATH);

		expect(DirtyWarningModal).not.toHaveBeenCalled();
		expect(bridge.activeWorktreePath).toBe(WT_PATH);
	});
});

// ─── pushBridge on a worktree ─────────────────────────────────────────────────

describe('BridgeManager.pushBridge — on a worktree', () => {
	it('commits at the worktree path and pushes the worktree branch with -u', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ activeWorktreePath: WT_PATH, branch: 'main' });
		plugin.settings.bridges.push(bridge);
		setupExecRouter({ stagedChanges: true });

		await manager.pushBridge(bridge);

		expect(bridge.status).toBe('ok');
		expect(bridge.lastPushed).toBeDefined();
		const calls = execCalls();
		expect(calls.some(cmd => cmd.includes(`git -C "${WT_PATH}" commit`))).toBe(true);
		expect(calls.some(cmd =>
			cmd.includes(`git -C "${WT_PATH}" push -u origin "${WT_BRANCH}"`)
		)).toBe(true);
		// Never touches the configured base branch
		expect(calls.some(cmd => cmd.includes('push -u origin "main"'))).toBe(false);
	});

	it('bypasses PR mode while a worktree is active (no feature branch, no gh pr create)', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ activeWorktreePath: WT_PATH, prMode: true });
		plugin.settings.bridges.push(bridge);
		setupExecRouter({ stagedChanges: true });

		await manager.pushBridge(bridge);

		expect(bridge.status).toBe('ok');
		const calls = execCalls();
		expect(calls.some(cmd => cmd.includes('checkout -b'))).toBe(false);
		expect(calls.some(cmd => cmd.includes('gh pr create'))).toBe(false);
		expect(calls.some(cmd =>
			cmd.includes(`push -u origin "${WT_BRANCH}"`)
		)).toBe(true);
	});

	it('still uses the PR-mode feature-branch flow when no worktree is active', async () => {
		const plugin = makePlugin();
		const manager = new BridgeManager(plugin);
		const bridge = makeBridge({ prMode: true });
		plugin.settings.bridges.push(bridge);
		setupExecRouter({ stagedChanges: true });

		await manager.pushBridge(bridge);

		const calls = execCalls();
		expect(calls.some(cmd => cmd.includes('checkout -b "vault-update/'))).toBe(true);
	});
});
