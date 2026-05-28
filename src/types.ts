export interface Bridge {
	id: string;
	name: string;
	repoPath: string;      // absolute local path to git repo root
	sourcePath: string;    // subfolder within repo to link (empty = whole repo)
	vaultPath: string;     // destination path inside vault
	branch: string;
	autoSync: boolean;
	lastSynced?: string;   // ISO timestamp (kept for backward compat, mirrors lastPulled)
	lastPulled?: string;   // ISO timestamp of last successful pull
	lastPushed?: string;   // ISO timestamp of last successful push
	fileManifest?: Record<string, string>; // vault-relative path → SHA-1 hash, recorded after each pull
	isDirty?: boolean;     // true if vault files have been modified since last pull
	status: 'ok' | 'error' | 'syncing' | 'unlinked' | 'unknown';
	lastError?: string;
}

export interface VaultBridgesSettings {
	bridges: Bridge[];
	syncOnStartup: boolean;
	claudePath: string;
	claudeEnabled: boolean;
}

export const DEFAULT_SETTINGS: VaultBridgesSettings = {
	bridges: [],
	syncOnStartup: true,
	claudePath: '/opt/homebrew/bin/claude',
	claudeEnabled: true,
};

export type GitErrorType = 'conflict' | 'pull_rejected' | 'push_rejected' | 'auth_failure' | 'network_error' | 'generic';

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
