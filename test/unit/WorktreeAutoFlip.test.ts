import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock declarations (hoisted) ──────────────────────────────────────────────

vi.mock('fs', () => ({
	existsSync: vi.fn().mockReturnValue(true),
	realpathSync: vi.fn((p: string) => p),
}));

vi.mock('obsidian', () => ({ Notice: vi.fn() }));

// ─── Imports (after mock declarations) ───────────────────────────────────────

import * as fs from 'fs';
import { Notice } from 'obsidian';
import { WorktreeAutoFlip, WORKTREE_CHANGED_EVENT } from '../../src/WorktreeAutoFlip';
import type VaultBridgesPlugin from '../../main';
import type { Bridge, WorktreeChangeEvent } from '../../src/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const REPO = '/repo/alpha';
const OTHER_REPO = '/repo/beta';
const WT_PATH = '/tmp/claude-worktrees/abc123';

function makeBridge(overrides: Partial<Bridge> = {}): Bridge {
	return {
		id: crypto.randomUUID(),
		name: 'Alpha Bridge',
		repoPath: REPO,
		sourcePath: '',
		vaultPath: 'Work/Alpha',
		branch: 'main',
		autoSync: true,
		status: 'ok',
		...overrides,
	};
}

interface TestContext {
	plugin: VaultBridgesPlugin;
	autoFlip: WorktreeAutoFlip;
	switchWorktree: ReturnType<typeof vi.fn>;
	checkDirty: ReturnType<typeof vi.fn>;
	workspaceOn: ReturnType<typeof vi.fn>;
	registerEvent: ReturnType<typeof vi.fn>;
}

function makeContext(bridges: Bridge[], { autoFlipWorktrees = true } = {}): TestContext {
	const switchWorktree = vi.fn().mockResolvedValue(undefined);
	const checkDirty = vi.fn().mockReturnValue(false);
	const workspaceOn = vi.fn().mockReturnValue({ /* EventRef */ });
	const registerEvent = vi.fn();

	const plugin = {
		app: { workspace: { on: workspaceOn } },
		settings: { bridges, syncOnStartup: true, claudePath: '', claudeEnabled: false, autoFlipWorktrees },
		bridgeManager: { switchWorktree, checkDirty },
		registerEvent,
	} as unknown as VaultBridgesPlugin;

	return { plugin, autoFlip: new WorktreeAutoFlip(plugin), switchWorktree, checkDirty, workspaceOn, registerEvent };
}

function enterEvent(overrides: Partial<WorktreeChangeEvent> = {}): WorktreeChangeEvent {
	return { repoPath: REPO, worktreePath: WT_PATH, branch: 'claude/12345', ...overrides };
}

function exitEvent(overrides: Partial<WorktreeChangeEvent> = {}): WorktreeChangeEvent {
	return { repoPath: REPO, worktreePath: null, removedWorktreePath: WT_PATH, ...overrides };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(fs.existsSync).mockReturnValue(true);
	vi.mocked(fs.realpathSync).mockImplementation((p) => p as string);
});

// ─── register ─────────────────────────────────────────────────────────────────

describe('register', () => {
	it('subscribes to the claude-threads worktree-changed event via registerEvent', () => {
		const { autoFlip, workspaceOn, registerEvent } = makeContext([makeBridge()]);
		autoFlip.register();
		expect(workspaceOn).toHaveBeenCalledWith(WORKTREE_CHANGED_EVENT, expect.any(Function));
		expect(registerEvent).toHaveBeenCalledTimes(1);
	});

	it('the registered callback routes the payload into handleWorktreeChange', async () => {
		const bridge = makeBridge();
		const { autoFlip, workspaceOn, switchWorktree } = makeContext([bridge]);
		autoFlip.register();
		const callback = vi.mocked(workspaceOn).mock.calls[0][1] as (p: WorktreeChangeEvent) => void;
		callback(enterEvent());
		await vi.waitFor(() => expect(switchWorktree).toHaveBeenCalled());
		expect(switchWorktree).toHaveBeenCalledWith(bridge, WT_PATH, false);
	});
});

// ─── enter_worktree ───────────────────────────────────────────────────────────

describe('enter_worktree auto-flip', () => {
	it('flips the bridge whose repoPath matches the event repo', async () => {
		const bridge = makeBridge();
		const { autoFlip, switchWorktree } = makeContext([bridge]);
		await autoFlip.handleWorktreeChange(enterEvent());
		expect(switchWorktree).toHaveBeenCalledWith(bridge, WT_PATH, false);
	});

	it('leaves bridges of other repos untouched (multi-repo)', async () => {
		const alpha = makeBridge();
		const beta = makeBridge({ name: 'Beta Bridge', repoPath: OTHER_REPO, vaultPath: 'Work/Beta' });
		const { autoFlip, switchWorktree } = makeContext([alpha, beta]);
		await autoFlip.handleWorktreeChange(enterEvent());
		expect(switchWorktree).toHaveBeenCalledTimes(1);
		expect(switchWorktree).toHaveBeenCalledWith(alpha, WT_PATH, false);
	});

	it('matches repo paths with symlinks resolved (/var vs /private/var)', async () => {
		const bridge = makeBridge({ repoPath: '/var/repo' });
		const { autoFlip, switchWorktree } = makeContext([bridge]);
		vi.mocked(fs.realpathSync).mockImplementation((p) =>
			(p as string).replace(/^\/var\//, '/private/var/')
		);
		await autoFlip.handleWorktreeChange(enterEvent({ repoPath: '/private/var/repo' }));
		expect(switchWorktree).toHaveBeenCalledWith(bridge, WT_PATH, false);
	});

	it('is a no-op when the bridge already tracks the target worktree', async () => {
		const bridge = makeBridge({ activeWorktreePath: WT_PATH, activeWorktreeBranch: 'claude/12345' });
		const { autoFlip, switchWorktree } = makeContext([bridge]);
		await autoFlip.handleWorktreeChange(enterEvent());
		expect(switchWorktree).not.toHaveBeenCalled();
	});

	it('does nothing when autoFlipWorktrees is disabled', async () => {
		const { autoFlip, switchWorktree } = makeContext([makeBridge()], { autoFlipWorktrees: false });
		await autoFlip.handleWorktreeChange(enterEvent());
		expect(switchWorktree).not.toHaveBeenCalled();
	});

	it('ignores malformed payloads', async () => {
		const { autoFlip, switchWorktree } = makeContext([makeBridge()]);
		await autoFlip.handleWorktreeChange({} as WorktreeChangeEvent);
		await autoFlip.handleWorktreeChange(undefined as unknown as WorktreeChangeEvent);
		expect(switchWorktree).not.toHaveBeenCalled();
	});

	it('surfaces switch errors via Notice without throwing', async () => {
		const bridge = makeBridge();
		const { autoFlip, switchWorktree } = makeContext([bridge]);
		switchWorktree.mockRejectedValue(new Error('boom'));
		await expect(autoFlip.handleWorktreeChange(enterEvent())).resolves.toBeUndefined();
		expect(vi.mocked(Notice).mock.calls.some(([msg]) => String(msg).includes('boom'))).toBe(true);
	});
});

// ─── exit_worktree ────────────────────────────────────────────────────────────

describe('exit_worktree auto-flip', () => {
	it('flips back the bridge pinned to the removed worktree', async () => {
		const bridge = makeBridge({ activeWorktreePath: WT_PATH, activeWorktreeBranch: 'claude/12345' });
		const { autoFlip, switchWorktree } = makeContext([bridge]);
		// The worktree dir is already removed when the event fires
		vi.mocked(fs.existsSync).mockReturnValue(false);
		await autoFlip.handleWorktreeChange(exitEvent());
		// force=true: the old checkout is gone, the dirty modal could not push to it
		expect(switchWorktree).toHaveBeenCalledWith(bridge, null, true);
	});

	it('leaves a bridge pinned to a different worktree alone', async () => {
		const bridge = makeBridge({ activeWorktreePath: '/tmp/claude-worktrees/other' });
		const { autoFlip, switchWorktree } = makeContext([bridge]);
		await autoFlip.handleWorktreeChange(exitEvent());
		expect(switchWorktree).not.toHaveBeenCalled();
	});

	it('leaves a bridge already on the main checkout alone', async () => {
		const bridge = makeBridge();
		const { autoFlip, switchWorktree } = makeContext([bridge]);
		await autoFlip.handleWorktreeChange(exitEvent());
		expect(switchWorktree).not.toHaveBeenCalled();
	});

	it('skips the flip and warns when the vault copy is dirty and the worktree is gone', async () => {
		const bridge = makeBridge({ activeWorktreePath: WT_PATH });
		const { autoFlip, switchWorktree, checkDirty } = makeContext([bridge]);
		vi.mocked(fs.existsSync).mockReturnValue(false);
		checkDirty.mockReturnValue(true);
		await autoFlip.handleWorktreeChange(exitEvent());
		expect(switchWorktree).not.toHaveBeenCalled();
		expect(vi.mocked(Notice).mock.calls.some(([msg]) => String(msg).includes('unpushed vault edits'))).toBe(true);
	});

	it('uses the normal dirty-check flow (force=false) when the old worktree still exists', async () => {
		const bridge = makeBridge({ activeWorktreePath: '/tmp/claude-worktrees/old' });
		const { autoFlip, switchWorktree } = makeContext([bridge]);
		// Entering a new worktree while the old one still exists on disk
		await autoFlip.handleWorktreeChange(enterEvent());
		expect(switchWorktree).toHaveBeenCalledWith(bridge, WT_PATH, false);
	});
});

// ─── matchBridges ─────────────────────────────────────────────────────────────

describe('matchBridges', () => {
	it('returns every bridge of the repo on enter (they should all follow the session)', () => {
		const a = makeBridge({ vaultPath: 'Work/A' });
		const b = makeBridge({ vaultPath: 'Work/B', activeWorktreePath: '/tmp/claude-worktrees/other' });
		const other = makeBridge({ repoPath: OTHER_REPO, vaultPath: 'Work/C' });
		const { autoFlip } = makeContext([a, b, other]);
		expect(autoFlip.matchBridges(enterEvent())).toEqual([a, b]);
	});

	it('on exit only returns bridges pinned to the removed worktree', () => {
		const pinned = makeBridge({ vaultPath: 'Work/A', activeWorktreePath: WT_PATH });
		const main = makeBridge({ vaultPath: 'Work/B' });
		const elsewhere = makeBridge({ vaultPath: 'Work/C', activeWorktreePath: '/tmp/claude-worktrees/other' });
		const { autoFlip } = makeContext([pinned, main, elsewhere]);
		expect(autoFlip.matchBridges(exitEvent())).toEqual([pinned]);
	});
});
