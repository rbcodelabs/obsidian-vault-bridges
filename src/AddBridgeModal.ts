import { App, Modal, Setting, Notice } from 'obsidian';
import type VaultBridgesPlugin from '../main';
import type { Bridge } from './types';

function generateId(): string {
	return crypto.randomUUID();
}

export class AddBridgeModal extends Modal {
	private bridge: Partial<Bridge>;
	private isEdit: boolean;

	constructor(
		app: App,
		private plugin: VaultBridgesPlugin,
		existingBridge: Bridge | null,
		private onSave: () => void,
	) {
		super(app);
		this.isEdit = existingBridge !== null;
		this.bridge = existingBridge
			? { ...existingBridge }
			: {
				id: generateId(),
				name: '',
				repoPath: '',
				sourcePath: '',
				vaultPath: '',
				branch: 'main',
				autoSync: true,
				status: 'unknown',
			};
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: this.isEdit ? 'Edit Bridge' : 'Add Bridge' });

		new Setting(contentEl)
			.setName('Name')
			.setDesc('A friendly label for this bridge (e.g. "Work Docs", "Team Wiki")')
			.addText(text =>
				text
					.setPlaceholder('Work Docs')
					.setValue(this.bridge.name ?? '')
					.onChange(value => { this.bridge.name = value; })
			);

		new Setting(contentEl)
			.setName('Local repo path')
			.setDesc('Absolute path to the git repository root on your machine')
			.addText(text => {
				text
					.setPlaceholder('/Users/you/projects/my-docs')
					.setValue(this.bridge.repoPath ?? '')
					.onChange(value => { this.bridge.repoPath = value.trim(); });
				text.inputEl.style.width = '100%';
			});

		new Setting(contentEl)
			.setName('Source subfolder')
			.setDesc('Optional: subfolder within the repo to copy (leave blank to copy the whole repo)')
			.addText(text =>
				text
					.setPlaceholder('docs/adr')
					.setValue(this.bridge.sourcePath ?? '')
					.onChange(value => { this.bridge.sourcePath = value.trim(); })
			);

		new Setting(contentEl)
			.setName('Vault destination path')
			.setDesc('Where to copy files inside your vault (relative path, e.g. "Work/ADRs")')
			.addText(text =>
				text
					.setPlaceholder('Work/ADRs')
					.setValue(this.bridge.vaultPath ?? '')
					.onChange(value => { this.bridge.vaultPath = value.trim(); })
			);

		new Setting(contentEl)
			.setName('Branch')
			.setDesc('Git branch to pull from')
			.addText(text =>
				text
					.setPlaceholder('main')
					.setValue(this.bridge.branch ?? 'main')
					.onChange(value => { this.bridge.branch = value.trim() || 'main'; })
			);

		new Setting(contentEl)
			.setName('Auto sync on startup')
			.setDesc('Automatically pull this repo when Obsidian opens')
			.addToggle(toggle =>
				toggle
					.setValue(this.bridge.autoSync ?? true)
					.onChange(value => { this.bridge.autoSync = value; })
			);

		new Setting(contentEl)
			.addButton(btn =>
				btn
					.setButtonText(this.isEdit ? 'Save Changes' : 'Add Bridge')
					.setCta()
					.onClick(async () => {
						if (this.validate()) {
							await this.save();
							this.close();
						}
					})
			)
			.addButton(btn =>
				btn
					.setButtonText('Cancel')
					.onClick(() => this.close())
			);
	}

	private validate(): boolean {
		if (!this.bridge.name?.trim()) {
			new Notice('Vault Bridges: Bridge name is required.');
			return false;
		}
		if (!this.bridge.repoPath?.trim()) {
			new Notice('Vault Bridges: Local repo path is required.');
			return false;
		}
		if (!this.bridge.vaultPath?.trim()) {
			new Notice('Vault Bridges: Vault destination path is required.');
			return false;
		}
		return true;
	}

	private async save(): Promise<void> {
		const completeBridge = this.bridge as Bridge;

		if (this.isEdit) {
			const idx = this.plugin.settings.bridges.findIndex(b => b.id === completeBridge.id);
			if (idx >= 0) {
				this.plugin.settings.bridges[idx] = completeBridge;
			}
		} else {
			this.plugin.settings.bridges.push(completeBridge);
		}

		await this.plugin.saveSettings();
		this.plugin.statusBar.update();
		// Register (or refresh) per-bridge commands so the palette is up-to-date
		// immediately — no Obsidian restart required.
		this.plugin.registerBridgeCommands(completeBridge);
		this.onSave();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
