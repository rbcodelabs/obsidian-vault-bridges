import { App, Modal, Setting, Notice } from 'obsidian';
import type VaultBridgesPlugin from '../main';
import type { Bridge, WorktreeInfo } from './types';

/**
 * Lists every worktree of the bridge's repo (via `git worktree list`) and lets
 * the user flip which one the bridge mirrors. Selecting the main checkout
 * clears the override; selecting a linked worktree sets it. Either way the
 * switch triggers a forced re-pull so the vault copy reflects the new target.
 */
export class WorktreeSwitchModal extends Modal {
	constructor(
		app: App,
		private plugin: VaultBridgesPlugin,
		private bridge: Bridge,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: `Switch Worktree — ${this.bridge.name}` });
		contentEl.createEl('p', {
			text: 'Choose which checkout of the repo this bridge mirrors. Switching re-pulls the selected checkout into the vault.',
			cls: 'vault-bridges-description',
		});

		const loading = contentEl.createEl('p', { text: 'Listing worktrees…' });

		let worktrees: WorktreeInfo[];
		try {
			worktrees = await this.plugin.bridgeManager.listWorktrees(this.bridge);
		} catch (err) {
			loading.remove();
			const msg = err instanceof Error ? err.message : String(err);
			contentEl.createEl('p', { text: `Could not list worktrees: ${msg}` });
			return;
		}
		loading.remove();

		if (worktrees.length <= 1) {
			contentEl.createEl('p', {
				text: 'This repo has no linked worktrees. Create one with `git worktree add` and reopen this dialog.',
			});
			return;
		}

		for (const wt of worktrees) {
			const name = wt.branch || '(detached HEAD)';
			const setting = new Setting(contentEl)
				.setName(wt.isMain ? `${name} — main repo` : name)
				.setDesc(wt.path);

			if (wt.isActive) {
				setting.addButton(btn => btn.setButtonText('Active').setDisabled(true));
			} else {
				setting.addButton(btn =>
					btn
						.setButtonText('Switch')
						.setCta()
						.setDisabled(!wt.isMain && !wt.branch) // can't track a detached worktree
						.onClick(async () => {
							this.close();
							try {
								await this.plugin.bridgeManager.switchWorktree(
									this.bridge,
									wt.isMain ? null : wt.path,
								);
							} catch (err) {
								const msg = err instanceof Error ? err.message : String(err);
								new Notice(`Vault Bridges: switch failed — ${msg}`, 10000);
							}
						})
				);
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
