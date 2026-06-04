import type { GitErrorType } from './types';

export function classifyGitError(errorText: string): GitErrorType {
	const t = errorText.toLowerCase();
	if (t.includes('conflict') || t.includes('automatic merge failed')) return 'conflict';
	if (t.includes('authentication failed') || t.includes('permission denied') || t.includes('invalid credentials')) return 'auth_failure';
	if (t.includes('could not resolve host') || t.includes('connection refused') || t.includes('timed out')) return 'network_error';
	if (t.includes('unstaged changes') || t.includes('please commit or stash') || (t.includes('cannot pull') && t.includes('stash'))) return 'repo_dirty';
	if ((t.includes('rejected') || t.includes('non-fast-forward')) && (t.includes('push') || t.includes('remote'))) return 'push_rejected';
	if (t.includes('rejected') || t.includes('diverged') || t.includes('would be overwritten')) return 'pull_rejected';
	return 'generic';
}
