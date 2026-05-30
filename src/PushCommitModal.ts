import { App, Modal, Setting } from 'obsidian';
import type { Bridge } from './types';

/**
 * Small modal that asks for an optional commit message before pushing a
 * bridge. Leaves the message empty to get the auto-generated timestamp one.
 */
export class PushCommitModal extends Modal {
	private message = '';
	private inputEl!: HTMLInputElement;

	constructor(
		app: App,
		private bridge: Bridge,
		private onConfirm: (message: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: `Push "${this.bridge.name}"` });
		contentEl.createEl('p', {
			text: `Commit all vault edits and push to branch "${this.bridge.branch}".`,
			cls: 'vault-bridges-description',
		});

		new Setting(contentEl)
			.setName('Commit message')
			.setDesc('Leave blank to auto-generate a timestamped message')
			.addText((text) => {
				text
					.setPlaceholder('Update docs…')
					.onChange((v) => { this.message = v; });
				this.inputEl = text.inputEl;
				this.inputEl.style.width = '100%';
				// Allow Enter to submit
				this.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') { this.confirm(); }
					if (e.key === 'Escape') { this.close(); }
				});
			});

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText('Push')
					.setCta()
					.onClick(() => this.confirm())
			)
			.addButton((btn) =>
				btn.setButtonText('Cancel').onClick(() => this.close())
			);

		// Focus input after DOM settles
		setTimeout(() => this.inputEl?.focus(), 50);
	}

	private confirm(): void {
		this.close();
		this.onConfirm(this.message);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
