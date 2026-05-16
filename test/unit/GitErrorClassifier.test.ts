import { describe, it, expect } from 'vitest';
import { classifyGitError } from '../../src/GitErrorClassifier';

describe('classifyGitError', () => {
	it('identifies merge conflicts', () => {
		const input = 'CONFLICT (content): Merge conflict in README.md\nautomatic merge failed';
		expect(classifyGitError(input)).toBe('conflict');
	});

	it('identifies authentication failures', () => {
		const input = "error: Authentication failed for 'https://github.com/org/repo.git'";
		expect(classifyGitError(input)).toBe('auth_failure');
	});

	it('identifies network errors', () => {
		const input = 'fatal: unable to access: Could not resolve host: github.com';
		expect(classifyGitError(input)).toBe('network_error');
	});

	it('identifies push rejections', () => {
		const input =
			'error: failed to push some refs\n! [rejected] main -> main (non-fast-forward)';
		expect(classifyGitError(input)).toBe('push_rejected');
	});

	it('identifies pull rejections', () => {
		const input =
			'error: Your local changes to the following files would be overwritten';
		expect(classifyGitError(input)).toBe('pull_rejected');
	});

	it('falls back to generic for unrecognized errors', () => {
		const input = 'fatal: not a git repository';
		expect(classifyGitError(input)).toBe('generic');
	});

	it('is case-insensitive — AUTHENTICATION FAILED maps to auth_failure', () => {
		const input = 'AUTHENTICATION FAILED for remote origin';
		expect(classifyGitError(input)).toBe('auth_failure');
	});
});
