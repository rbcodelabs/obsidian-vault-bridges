import { query, type Options, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { GitDiagnostics, GitFixPlan, GitFixStep } from './types';
import { buildGitFixPrompt } from './gitPromptBuilder';

export class ClaudeGitSession {
	constructor(private claudePath: string) {}

	async analyzeFix(diag: GitDiagnostics): Promise<GitFixPlan> {
		const prompt = buildGitFixPrompt(diag);

		// Only allow safe read-only git commands during analysis
		const canUseTool: CanUseTool = async (toolName, input) => {
			if (toolName !== 'Bash') {
				return { behavior: 'deny', message: 'Only Bash is available' };
			}
			const cmd = typeof input === 'object' && input !== null && 'command' in input
				? String((input as Record<string, unknown>).command)
				: '';
			// Must start with git -C "<repoPath>" and be read-only
			const repoPrefix = `git -C "${diag.repoPath}"`;
			if (!cmd.startsWith(repoPrefix)) {
				return { behavior: 'deny', message: `Commands must start with: ${repoPrefix}` };
			}
			// Block dangerous commands and shell chaining
			if (/push|reset\s+--hard|clean\s+-f|&&|;|\||\$/.test(cmd)) {
				return { behavior: 'deny', message: 'Command not allowed during analysis phase' };
			}
			return { behavior: 'allow', updatedInput: input };
		};

		const options: Options = {
			pathToClaudeCodeExecutable: this.claudePath,
			permissionMode: 'default',
			cwd: diag.repoPath,
			includePartialMessages: false,
			canUseTool,
		};

		let resultText = '';

		try {
			const q = query({ prompt, options });
			for await (const msg of q) {
				if (msg.type === 'assistant') {
					for (const block of msg.message.content) {
						if (block.type === 'text') {
							resultText = block.text; // keep the last assistant text
						}
					}
				}
			}
		} catch (err) {
			throw new Error(`Claude analysis failed: ${err instanceof Error ? err.message : String(err)}`);
		}

		return this.parsePlan(resultText, diag.repoPath);
	}

	private parsePlan(text: string, repoPath: string): GitFixPlan {
		// Extract SUMMARY
		const summaryMatch = text.match(/^SUMMARY:\s*(.+?)(?=\nWARNING:|\nSTEPS:|\n\n|$)/ms);
		const summary = summaryMatch
			? summaryMatch[1].trim()
			: text.split('\n')[0] || 'Claude could not produce a diagnosis.';

		// Extract WARNING (optional)
		const warningMatch = text.match(/^WARNING:\s*(.+?)(?=\nSTEPS:|\n\n|$)/ms);
		const warningMessage = warningMatch ? warningMatch[1].trim() : undefined;

		// Extract STEPS
		const stepsSection = text.match(/^STEPS:\s*\n([\s\S]+?)(?:\n\n|$)/m);
		const steps: GitFixStep[] = [];

		if (stepsSection) {
			const stepLines = stepsSection[1].split('\n').filter(l => l.trim());
			for (const line of stepLines) {
				// Format: "N. [SAFE|DESTRUCTIVE] description | git -C "..." args"
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
			const gitLines = text.match(new RegExp(`git -C "${repoPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^\n]+`, 'g'));
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
