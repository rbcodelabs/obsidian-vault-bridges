import { describe, it, expect } from 'vitest';
import { buildGitFixPrompt } from '../../src/gitPromptBuilder';
import type { GitDiagnostics } from '../../src/types';

function makeDiag(overrides: Partial<GitDiagnostics> = {}): GitDiagnostics {
	return {
		errorText: 'some git error output',
		repoPath: '/mock/repos/work-docs',
		errorType: 'generic',
		gitStatus: '',
		gitLog: '',
		gitDiff: '',
		operation: 'pull',
		...overrides,
	};
}

describe('buildGitFixPrompt', () => {
	it('contains required format headings', () => {
		const result = buildGitFixPrompt(makeDiag());
		expect(result).toContain('SUMMARY:');
		expect(result).toContain('WARNING:');
		expect(result).toContain('STEPS:');
	});

	it('contains the repoPath in the STEPS prefix instruction', () => {
		const diag = makeDiag({ repoPath: '/my/custom/repo' });
		const result = buildGitFixPrompt(diag);
		expect(result).toContain('/my/custom/repo');
	});

	it('contains the verbatim errorText', () => {
		const diag = makeDiag({ errorText: 'fatal: unique-error-text-12345' });
		const result = buildGitFixPrompt(diag);
		expect(result).toContain('fatal: unique-error-text-12345');
	});

	it('includes conflict-specific instruction mentioning rebase', () => {
		const result = buildGitFixPrompt(makeDiag({ errorType: 'conflict' }));
		expect(result).toContain('rebase');
	});

	it('includes push_rejected-specific instruction', () => {
		const result = buildGitFixPrompt(makeDiag({ errorType: 'push_rejected' }));
		// The push_rejected instruction tells Claude to use fetch + rebase then push
		expect(result).toContain('fetch');
		expect(result).toContain('rebase');
	});
});
