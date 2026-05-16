import { App, Modal, Setting } from 'obsidian';
import type { Bridge, GitFixPlan } from './types';

export interface ConflictResolutionCallbacks {
	onApprove: () => Promise<void>;
	onReject: () => void;
}

export class ConflictResolutionModal extends Modal {
	constructor(
		app: App,
		private bridge: Bridge,
		private plan: GitFixPlan,
		private callbacks: ConflictResolutionCallbacks,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: `Git Error Recovery: "${this.bridge.name}"` });
		contentEl.createEl('p', { text: `Repo: ${this.bridge.repoPath}`, cls: 'vault-bridges-recovery-repo' });

		// Diagnosis
		contentEl.createEl('h3', { text: 'Diagnosis' });
		contentEl.createEl('p', { text: this.plan.summary });

		// Warning box
		if (this.plan.warningMessage) {
			const warning = contentEl.createDiv({ cls: 'vault-bridges-recovery-warning' });
			warning.createEl('strong', { text: 'Warning: ' });
			warning.appendText(this.plan.warningMessage);
		}

		// Steps
		if (this.plan.steps.length > 0) {
			contentEl.createEl('h3', { text: 'Proposed Fix' });
			const stepList = contentEl.createEl('ol', { cls: 'vault-bridges-step-list' });

			for (const step of this.plan.steps) {
				const li = stepList.createEl('li', {
					cls: step.isDestructive ? 'vault-bridges-step-destructive' : 'vault-bridges-step-safe',
				});
				const desc = li.createSpan({ cls: 'vault-bridges-step-description' });
				if (step.isDestructive) {
					desc.createEl('strong', { text: '[DESTRUCTIVE] ' });
				}
				desc.appendText(step.description);
				li.createEl('code', { text: step.command, cls: 'vault-bridges-step-command' });
			}

			const hasDestructive = this.plan.steps.some(s => s.isDestructive);
			if (hasDestructive) {
				contentEl.createEl('p', {
					text: 'Destructive steps cannot be undone.',
					cls: 'vault-bridges-recovery-footer',
				});
			}
		} else {
			contentEl.createEl('p', {
				text: 'No automated fix steps could be determined. You may need to resolve this manually.',
				cls: 'vault-bridges-empty',
			});
		}

		// Buttons
		new Setting(contentEl)
			.addButton(btn =>
				btn
					.setButtonText('Approve & Run Fix')
					.setCta()
					.setDisabled(this.plan.steps.length === 0)
					.onClick(async () => {
						this.close();
						await this.callbacks.onApprove();
					})
			)
			.addButton(btn =>
				btn
					.setButtonText('Reject')
					.onClick(() => {
						this.close();
						this.callbacks.onReject();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
