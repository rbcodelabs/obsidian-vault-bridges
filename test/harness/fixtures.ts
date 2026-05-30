import type { Bridge, ChangedFile, GitFixPlan } from '../../src/types';

const now = Date.now();

export const fixtureBridges: Bridge[] = [
	{
		id: 'bridge-work-docs',
		name: 'Work Docs',
		repoPath: '/mock/repos/work-docs',
		sourcePath: 'docs',
		vaultPath: 'Work/Docs',
		branch: 'main',
		autoSync: true,
		status: 'ok',
		lastSynced: new Date(now - 4 * 60 * 1000).toISOString(), // 4 minutes ago
	},
	{
		id: 'bridge-team-wiki',
		name: 'Team Wiki',
		repoPath: '/mock/repos/team-wiki',
		sourcePath: '',
		vaultPath: 'Shared/Team Wiki',
		branch: 'main',
		autoSync: true,
		status: 'error',
		lastSynced: new Date(now - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
		lastError: 'git pull failed: Authentication required',
	},
	{
		id: 'bridge-oss',
		name: 'OSS Project Docs',
		repoPath: '/mock/repos/oss-project',
		sourcePath: 'docs',
		vaultPath: 'Open Source/My Project',
		branch: 'main',
		autoSync: false,
		status: 'unknown',
	},
];

export const emptyBridges: Bridge[] = [];

// Bridge with pending changes — used for FileCommandBar screenshot scenarios
export const dirtyBridge: Bridge = {
	id: 'bridge-work-docs-dirty',
	name: 'Work Docs',
	repoPath: '/mock/repos/work-docs',
	sourcePath: 'docs',
	vaultPath: 'Work/Docs',
	branch: 'main',
	autoSync: true,
	status: 'ok',
	isDirty: true,
	lastSynced: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
};

export const fixtureChangedFiles: ChangedFile[] = [
	{ relPath: 'architecture/decisions/001-use-postgres.md', status: 'modified' },
	{ relPath: 'architecture/decisions/002-event-sourcing.md', status: 'added' },
	{ relPath: 'architecture/decisions/000-draft.md', status: 'deleted' },
];

export const fixturePlan: GitFixPlan = {
	summary:
		'The remote has commits your local branch does not have. A rebase will replay your local commits on top of the remote state.',
	warningMessage:
		'If the rebase encounters conflicts, you will need to resolve them manually before pushing.',
	steps: [
		{
			id: 'step-1',
			description: 'Fetch the latest remote state',
			command: 'git -C "/mock/repos/work-docs" fetch origin',
			isDestructive: false,
		},
		{
			id: 'step-2',
			description: 'Rebase local commits onto remote main',
			command: 'git -C "/mock/repos/work-docs" rebase origin/main',
			isDestructive: false,
		},
		{
			id: 'step-3',
			description: 'Reset local branch to match remote (discards local commits)',
			command: 'git -C "/mock/repos/work-docs" reset --hard origin/main',
			isDestructive: true,
		},
	],
};
