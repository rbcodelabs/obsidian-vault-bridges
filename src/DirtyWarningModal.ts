import { App, Modal, Setting } from 'obsidian';
import type { Bridge } from './types';

export interface DirtyWarningCallbacks {
	onPushThenPull: () => Promise<void>;
	onPullAnyway: () => Promise<void>;
}

/** Optional copy overrides so the modal can be reused for non-pull actions (e.g. worktree switching). */
export interface DirtyWarningLabels {
	body?: string;
	primary?: string;
	warning?: string;
}

export class DirtyWarningModal extends Modal {
	constructor(
		app: App,
		private bridge: Bridge,
		private callbacks: DirtyWarningCallbacks,
		private labels: DirtyWarningLabels = {},
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: '⚠️ Unsaved Edits Detected' });
		contentEl.createEl('p', {
			text: this.labels.body ??
				`"${this.bridge.name}" has vault edits that haven't been pushed yet. Pulling now will overwrite those edits with the repo's current state.`,
		});
		contentEl.createEl('p', {
			text: 'What would you like to do?',
			cls: 'vault-bridges-dirty-subtitle',
		});

		new Setting(contentEl)
			.addButton(btn =>
				btn
					.setButtonText(this.labels.primary ?? 'Push then Pull')
					.setTooltip('Commit and push your vault edits to the repo first')
					.setCta()
					.onClick(async () => {
						this.close();
						await this.callbacks.onPushThenPull();
					})
			)
			.addButton(btn =>
				btn
					.setButtonText(this.labels.warning ?? 'Pull anyway')
					.setTooltip('Discard your vault edits and overwrite with the repo state')
					.setWarning()
					.onClick(async () => {
						this.close();
						await this.callbacks.onPullAnyway();
					})
			)
			.addButton(btn =>
				btn
					.setButtonText('Cancel')
					.onClick(() => this.close())
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
