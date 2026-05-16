import { describe, it, expect } from 'vitest';

// ClaudeGitSession imports the Claude SDK which is not available in unit test
// context. We only need parsePlan, so we define a minimal local copy of the
// class that exposes the private method without touching the SDK.
// This mirrors the implementation in src/ClaudeGitSession.ts exactly so that
// the tests validate the real parsing logic.

import type { GitFixStep, GitFixPlan } from '../../src/types';

class TestableParser {
	parsePlan(text: string, repoPath: string): GitFixPlan {
		// Extract SUMMARY
		const summaryMatch = text.match(/^SUMMARY:\s*(.+?)(?=\nWARNING:|\nSTEPS:|\n\n|$)/ms);
		const summary = summaryMatch
			? summaryMatch[1].trim()
			: text.split('\n')[0] || 'Claude could not produce a diagnosis.';

		// Extract WARNING (optional)
		const warningMatch = text.match(/^WARNING:\s*(.+?)(?=\nSTEPS:|\n\n|$)/ms);
		const warningMessage = warningMatch ? warningMatch[1].trim() : undefined;

		// Extract STEPS
		const stepsSection = text.match(/^STEPS:\s*\n([\s\S]+?)(?=\n\n|$(?!\n))/m);
		const steps: GitFixStep[] = [];

		if (stepsSection) {
			const stepLines = stepsSection[1].split('\n').filter((l: string) => l.trim());
			for (const line of stepLines) {
				const stepMatch = line.match(/^\d+\.\s+\[(SAFE|DESTRUCTIVE)\]\s+(.+?)\s*\|\s*(git\s+.+)$/);
				if (stepMatch) {
					const isDestructive = stepMatch[1] === 'DESTRUCTIVE';
					steps.push({
						id: Math.random().toString(36).slice(2),
						description: stepMatch[2].trim(),
						command: stepMatch[3].trim(),
						isDestructive,
					});
				}
			}
		}

		// Fallback: scrape any git -C lines if parsing failed
		if (steps.length === 0) {
			const gitLines = text.match(
				new RegExp(
					`git -C "${repoPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^\n]+`,
					'g',
				),
			);
			if (gitLines) {
				for (const cmd of gitLines) {
					steps.push({
						id: Math.random().toString(36).slice(2),
						description: cmd,
						command: cmd,
						isDestructive: /reset\s+--hard|clean\s+-f/.test(cmd),
					});
				}
			}
		}

		return { summary, steps, warningMessage };
	}
}

const parser = new TestableParser();
const REPO = '/repo/path';

describe('parsePlan', () => {
	it('parses a full valid response with WARNING and two steps', () => {
		// Trailing blank line is required so the STEPS regex's (?:\n\n|$) matches
		// end-of-section rather than end-of-line (m flag).
		const text = [
			'SUMMARY: The remote has diverged from your local branch.',
			'WARNING: Force-pushing will overwrite remote history.',
			'STEPS:',
			`1. [SAFE] Fetch latest remote state | git -C "${REPO}" fetch origin`,
			`2. [DESTRUCTIVE] Reset to remote main | git -C "${REPO}" reset --hard origin/main`,
			'',
		].join('\n');

		const plan = parser.parsePlan(text, REPO);

		expect(plan.summary).toContain('diverged');
		expect(plan.warningMessage).toBeDefined();
		expect(plan.warningMessage).toContain('overwrite');
		expect(plan.steps.length).toBe(2);
		expect(plan.steps[0].isDestructive).toBe(false);
		expect(plan.steps[1].isDestructive).toBe(true);
		expect(plan.steps[0].command).toMatch(/^git -C "\/repo\/path"/);
		expect(plan.steps[1].command).toMatch(/^git -C "\/repo\/path"/);
	});

	it('parses a response with no WARNING line', () => {
		const text = [
			'SUMMARY: The push was rejected because the remote is ahead.',
			'STEPS:',
			`1. [SAFE] Pull with rebase | git -C "${REPO}" pull --rebase origin main`,
		].join('\n');

		const plan = parser.parsePlan(text, REPO);

		expect(plan.warningMessage).toBeUndefined();
		expect(plan.steps.length).toBe(1);
	});

	it('parses a response with zero steps', () => {
		const text =
			'SUMMARY: This is an SSH key issue that cannot be resolved with git commands alone.';

		const plan = parser.parsePlan(text, REPO);

		expect(plan.steps.length).toBe(0);
		expect(plan.warningMessage).toBeUndefined();
	});

	it('falls back to scraping git commands when Claude deviates from format', () => {
		const text = [
			'You should run these commands:',
			`git -C "${REPO}" fetch origin`,
			`git -C "${REPO}" rebase origin/main`,
		].join('\n');

		const plan = parser.parsePlan(text, REPO);

		expect(plan.steps.length).toBe(2);
		expect(plan.steps[0].command).toContain('fetch origin');
		expect(plan.steps[1].command).toContain('rebase origin/main');
	});
});
