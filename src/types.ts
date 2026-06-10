export interface Bridge {
	id: string;
	name: string;
	repoPath: string;      // absolute local path to git repo root
	sourcePath: string;    // subfolder within repo to link (empty = whole repo)
	vaultPath: string;     // destination path inside vault
	branch: string;
	autoSync: boolean;
	prMode?: boolean;      // when true, pushes create a feature branch + PR instead of pushing directly to `branch`
	lastSynced?: string;   // ISO timestamp (kept for backward compat, mirrors lastPulled)
	lastPulled?: string;   // ISO timestamp of last successful pull
	lastPushed?: string;   // ISO timestamp of last successful push
	lastPrUrl?: string;    // URL of the most recently opened PR (cleared on next successful pull)
	prStatus?: 'open' | 'merged' | 'closed' | 'checking';
	fileManifest?: Record<string, string>; // vault-relative path → SHA-1 hash, recorded after each pull
	isDirty?: boolean;     // true if vault files have been modified since last pull
	activeWorktreePath?: string;   // when set, all git/file ops target this linked worktree instead of repoPath
	activeWorktreeBranch?: string; // cached HEAD branch of the active worktree (refreshed on pull/push)
	status: 'ok' | 'error' | 'syncing' | 'unlinked' | 'unknown';
	lastError?: string;
}

/** A single entry from `git worktree list --porcelain`. */
export interface WorktreeInfo {
	/** Absolute path of the worktree checkout */
	path: string;
	/** Branch checked out in this worktree ('' when detached HEAD) */
	branch: string;
	/** True for the main repo checkout (first entry in the list) */
	isMain: boolean;
	/** True when this worktree is the bridge's currently active target */
	isActive: boolean;
}

/**
 * Payload of the `claude-threads:worktree-changed` workspace event, fired by
 * the Claude Threads plugin when an agent session enters or exits a git
 * worktree via the `enter_worktree` / `exit_worktree` MCP tools.
 */
export interface WorktreeChangeEvent {
	/** Git root of the repo whose worktree state changed (main checkout path) */
	repoPath: string;
	/** Path of the worktree the session moved into, or null when restored to the main checkout */
	worktreePath: string | null;
	/** Branch checked out in the new worktree (enter only) */
	branch?: string;
	/** On exit: the worktree path that was just removed from disk */
	removedWorktreePath?: string;
}

/**
 * Payload of the `vault-bridges:worktree-switched` workspace event, fired by
 * this plugin whenever a bridge is pointed at a different worktree (manually
 * via the UI or automatically via auto-flip). Other plugins (e.g. Claude
 * Threads) can subscribe to keep their own state in sync.
 */
export interface WorktreeSwitchedEvent {
	bridgeId: string;
	bridgeName: string;
	repoPath: string;
	/** The worktree now tracked, or null when back on the main checkout */
	worktreePath: string | null;
	/** Branch now tracked */
	branch: string;
}

export interface VaultBridgesSettings {
	bridges: Bridge[];
	syncOnStartup: boolean;
	claudePath: string;
	claudeEnabled: boolean;
	/** Auto-flip bridges when a Claude Threads session enters/exits a worktree of a bridged repo */
	autoFlipWorktrees: boolean;
}

export const DEFAULT_SETTINGS: VaultBridgesSettings = {
	bridges: [],
	syncOnStartup: true,
	claudePath: '/opt/homebrew/bin/claude',
	claudeEnabled: true,
	autoFlipWorktrees: true,
};

export interface ChangedFile {
	/** Path relative to the bridge's vaultPath (and to the repo's sourcePath) */
	relPath: string;
	status: 'modified' | 'added' | 'deleted';
}

export type GitErrorType = 'conflict' | 'pull_rejected' | 'push_rejected' | 'auth_failure' | 'network_error' | 'repo_dirty' | 'generic';

export interface GitFixStep {
	id: string;
	description: string;
	command: string;      // complete runnable shell command
	isDestructive: boolean;
}

export interface GitFixPlan {
	summary: string;
	steps: GitFixStep[];
	warningMessage?: string;
}

export interface GitDiagnostics {
	errorText: string;
	repoPath: string;
	errorType: GitErrorType;
	gitStatus: string;
	gitLog: string;
	gitDiff: string;
	operation: 'pull' | 'push';
}
