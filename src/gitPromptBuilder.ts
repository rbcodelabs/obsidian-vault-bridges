import type { GitDiagnostics } from './types';

export function buildGitFixPrompt(diag: GitDiagnostics): string {
	const typeInstructions: Record<string, string> = {
		conflict: 'Prefer rebase to resolve. Do NOT suggest `git push --force` under any circumstances.',
		pull_rejected: 'Use fetch + rebase. Hard reset is DESTRUCTIVE — only suggest if there are no local commits to lose.',
		push_rejected: 'Use fetch + rebase then push. No `--force`. `--force-with-lease` only if user has their own unpushed commits at risk.',
		auth_failure: 'Suggest ssh-add, credential cache reset, or verifying remote URL. Do NOT include plaintext credentials.',
		network_error: 'Suggest verifying the remote URL and checking connectivity. Do NOT run shell network diagnostics.',
		generic: 'Analyze the error carefully. Rank options by likelihood. Flag any step that could lose data as DESTRUCTIVE.',
	};

	const instruction = typeInstructions[diag.errorType] ?? typeInstructions.generic;

	return `You are a git expert helping an Obsidian plugin recover from a git error. Analyze the error below and produce a concrete fix plan.

## Context
- Operation: ${diag.operation}
- Repo: ${diag.repoPath}
- Error type: ${diag.errorType}

## Error
\`\`\`
${diag.errorText}
\`\`\`

## git status
\`\`\`
${diag.gitStatus || '(empty)'}
\`\`\`

## git log (last 5)
\`\`\`
${diag.gitLog || '(empty)'}
\`\`\`

## git diff --name-only
\`\`\`
${diag.gitDiff || '(empty)'}
\`\`\`

## Instructions
${instruction}

You MUST use exactly this output format. Do not add any text outside this structure:

SUMMARY: <one paragraph diagnosis of what went wrong and why>
WARNING: <one sentence about data-loss risk — OMIT THIS LINE ENTIRELY if there is no data-loss risk>
STEPS:
1. [SAFE] <short description> | git -C "${diag.repoPath}" <args>
2. [DESTRUCTIVE] <short description> | git -C "${diag.repoPath}" <args>

Rules:
- Every command MUST start with: git -C "${diag.repoPath}"
- Do NOT use &&, ;, |, or $ in commands — one atomic git command per step
- Mark each step [SAFE] or [DESTRUCTIVE]
- Destructive = could delete or overwrite data (reset --hard, clean -f, checkout -- .)
- Maximum 6 steps
- If this error cannot be fixed with git commands alone, explain why in SUMMARY and output zero STEPS`;
}
