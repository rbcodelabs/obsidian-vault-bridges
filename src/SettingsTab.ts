import { App, PluginSettingTab, Setting } from 'obsidian';
import type VaultBridgesPlugin from '../main';
import type { Bridge } from './types';
import { AddBridgeModal } from './AddBridgeModal';
import { WorktreeSwitchModal } from './WorktreeSwitchModal';

export class VaultBridgesSettingsTab extends PluginSettingTab {
	constructor(app: App, private plugin: VaultBridgesPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Vault Bridges' });
		containerEl.createEl('p', {
			text: 'Connect external Git repositories into your vault. Each bridge pulls the latest from a local repo and copies the files to your chosen vault path so they are fully indexed.',
			cls: 'vault-bridges-description',
		});

		// Global toggle
		new Setting(containerEl)
			.setName('Sync on startup')
			.setDesc('Pull and verify all auto-sync bridges when Obsidian opens.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.syncOnStartup)
					.onChange(async value => {
						this.plugin.settings.syncOnStartup = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Auto-flip worktrees with Claude sessions')
			.setDesc('When a Claude Threads session enters or exits a git worktree of a bridged repo, automatically point the bridge at the same worktree.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.autoFlipWorktrees)
					.onChange(async value => {
						this.plugin.settings.autoFlipWorktrees = value;
						await this.plugin.saveSettings();
					})
			);

		// Claude integration section
		containerEl.createEl('h3', { text: 'Claude Code Integration' });
		containerEl.createEl('p', {
			text: 'When a git error occurs, Claude will analyze it and propose a fix for your approval.',
			cls: 'vault-bridges-description',
		});

		new Setting(containerEl)
			.setName('Enable Claude error recovery')
			.setDesc('When a pull or push fails, automatically ask Claude to diagnose and propose a fix.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.claudeEnabled)
					.onChange(async value => {
						this.plugin.settings.claudeEnabled = value;
						await this.plugin.saveSettings();
						this.display(); // re-render to show/hide path field
					})
			);

		if (this.plugin.settings.claudeEnabled) {
			new Setting(containerEl)
				.setName('Claude executable path')
				.setDesc('Full path to the claude binary (e.g. /opt/homebrew/bin/claude).')
				.addText(text =>
					text
						.setPlaceholder('/opt/homebrew/bin/claude')
						.setValue(this.plugin.settings.claudePath)
						.onChange(async value => {
							this.plugin.settings.claudePath = value;
							await this.plugin.saveSettings();
						})
				);
		}

		// Bridges list
		containerEl.createEl('h3', { text: 'Bridges' });

		if (this.plugin.settings.bridges.length === 0) {
			containerEl.createEl('p', {
				text: 'No bridges yet. Add one below.',
				cls: 'vault-bridges-empty',
			});
		} else {
			this.renderBridges(containerEl);
		}

		// Add bridge
		new Setting(containerEl)
			.addButton(btn =>
				btn
					.setButtonText('+ Add Bridge')
					.setCta()
					.onClick(() => {
						new AddBridgeModal(this.app, this.plugin, null, () => this.display()).open();
					})
			);

		// Bulk actions
		if (this.plugin.settings.bridges.length > 0) {
			new Setting(containerEl)
				.setName('Bulk actions')
				.addButton(btn =>
					btn
						.setButtonText('Pull All')
						.setTooltip('Pull all bridges: repo → vault')
						.onClick(async () => {
							await this.plugin.bridgeManager.syncAll();
							this.display();
						})
				)
				.addButton(btn =>
					btn
						.setButtonText('Push All')
						.setTooltip('Push all bridges: vault → repo (commit + push)')
						.onClick(async () => {
							await this.plugin.bridgeManager.pushAll();
							this.display();
						})
				)
				.addButton(btn =>
					btn
						.setButtonText('Rebuild All Copies')
						.setTooltip('Re-copy all bridge files into the vault — useful after moving the vault or if files get out of sync')
						.onClick(async () => {
							await this.plugin.bridgeManager.rebuildAllLinks();
							this.display();
						})
				);
		}
	}

	private renderBridges(containerEl: HTMLElement): void {
		for (const bridge of this.plugin.settings.bridges) {
			const isDirty = this.plugin.bridgeManager.checkDirty(bridge);
			bridge.isDirty = isDirty;

			const setting = new Setting(containerEl)
				.setName(bridge.name)
				.setDesc(this.descriptionFor(bridge, isDirty));

			// Inline status badge
			setting.nameEl.createSpan({
				text: ` ${this.statusEmoji(bridge.status)}`,
				cls: `vault-bridges-badge vault-bridges-badge-${bridge.status}`,
			});

			// Dirty badge
			if (isDirty) {
				setting.nameEl.createSpan({
					text: ' ⚠️ unsaved edits',
					cls: 'vault-bridges-badge vault-bridges-badge-dirty',
				});
			}

			// Worktree badge
			if (bridge.activeWorktreePath) {
				setting.nameEl.createSpan({
					text: ` ⎇ ${bridge.activeWorktreeBranch ?? 'worktree'}`,
					cls: 'vault-bridges-badge vault-bridges-badge-worktree',
					attr: { title: `Tracking worktree: ${bridge.activeWorktreePath}` },
				});
			}

			setting
				.addButton(btn =>
					btn
						.setIcon('git-branch')
						.setTooltip('Switch worktree')
						.onClick(() => {
							new WorktreeSwitchModal(this.app, this.plugin, bridge).open();
						})
				)
				.addButton(btn =>
					btn
						.setIcon('arrow-down-circle')
						.setTooltip('Pull: repo → vault')
						.onClick(async () => {
							await this.plugin.bridgeManager.syncBridge(bridge);
							await this.plugin.saveSettings();
							this.display();
						})
				)
				.addButton(btn =>
					btn
						.setIcon('arrow-up-circle')
						.setTooltip('Push: vault → repo (commit + push)')
						.onClick(async () => {
							await this.plugin.bridgeManager.pushBridge(bridge);
							this.display();
						})
				)
				.addButton(btn =>
					btn
						.setIcon('pencil')
						.setTooltip('Edit bridge')
						.onClick(() => {
							new AddBridgeModal(this.app, this.plugin, bridge, () => this.display()).open();
						})
				)
				.addButton(btn =>
					btn
						.setIcon('trash')
						.setTooltip('Remove bridge and delete vault copy')
						.setWarning()
						.onClick(async () => {
							await this.plugin.bridgeManager.removeLink(bridge);
							this.plugin.settings.bridges = this.plugin.settings.bridges.filter(
								b => b.id !== bridge.id
							);
							await this.plugin.saveSettings();
							this.plugin.statusBar.update();
							this.display();
						})
				);
		}
	}

	private descriptionFor(bridge: Bridge, isDirty = false): string {
		const src = bridge.sourcePath
			? `${bridge.repoPath}/${bridge.sourcePath}`
			: bridge.repoPath;
		const arrow = '→';

		const pulledLabel = bridge.lastPulled
			? `Pulled ${new Date(bridge.lastPulled).toLocaleString()}`
			: 'Never pulled';
		const pushedLabel = bridge.lastPushed
			? ` · Pushed ${new Date(bridge.lastPushed).toLocaleString()}`
			: '';
		const dirtyNote = isDirty ? ' · ⚠️ Push before pulling' : '';
		const errorNote = bridge.lastError ? ` · Error: ${bridge.lastError}` : '';
		const prNote = bridge.prMode ? ' · PR mode' : '';
		const prUrlNote = bridge.lastPrUrl ? ` · PR: ${bridge.lastPrUrl}` : '';
		const worktreeNote = bridge.activeWorktreePath
			? ` · Worktree: ${bridge.activeWorktreeBranch ?? bridge.activeWorktreePath}`
			: '';

		return `${src} ${arrow} ${bridge.vaultPath}${worktreeNote} · ${pulledLabel}${pushedLabel}${prNote}${prUrlNote}${dirtyNote}${errorNote}`;
	}

	private statusEmoji(status: Bridge['status']): string {
		const map: Record<Bridge['status'], string> = {
			ok: '✅',
			error: '❌',
			syncing: '🔄',
			unlinked: '🔗',
			unknown: '⚪',
		};
		return map[status] ?? '⚪';
	}
}
