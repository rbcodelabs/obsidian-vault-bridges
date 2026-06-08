import { Plugin, WorkspaceLeaf } from 'obsidian';
import { VaultBridgesSettings, DEFAULT_SETTINGS, Bridge } from './src/types';
import { BridgeManager } from './src/BridgeManager';
import { VaultBridgesSettingsTab } from './src/SettingsTab';
import { StatusBarManager } from './src/StatusBar';
import { VaultBridgesAPI } from './src/VaultBridgesAPI';
import { FileCommandBar } from './src/FileCommandBar';
import { BridgesSidebarView, BRIDGES_SIDEBAR_VIEW_TYPE } from './src/BridgesSidebarView';

export type { VaultBridgesAPI } from './src/VaultBridgesAPI';
export type { AddBridgeOptions } from './src/VaultBridgesAPI';

export default class VaultBridgesPlugin extends Plugin {
	settings!: VaultBridgesSettings;
	bridgeManager!: BridgeManager;
	statusBar!: StatusBarManager;
	/** Public API for other plugins. See src/VaultBridgesAPI.ts for full docs. */
	api!: VaultBridgesAPI;
	fileCommandBar!: FileCommandBar;
	sidebarView?: BridgesSidebarView;
	settingsTab?: VaultBridgesSettingsTab;

	async onload() {
		await this.loadSettings();

		this.bridgeManager = new BridgeManager(this);
		this.statusBar = new StatusBarManager(this);
		this.api = new VaultBridgesAPI(this);
		this.fileCommandBar = new FileCommandBar(this);

		// Register sidebar view
		this.registerView(BRIDGES_SIDEBAR_VIEW_TYPE, (leaf: WorkspaceLeaf) => {
			this.sidebarView = new BridgesSidebarView(leaf, this);
			return this.sidebarView;
		});

		// Ribbon icon to open/reveal the sidebar
		this.addRibbonIcon('git-fork', 'Vault Bridges', () => {
			this.activateSidebarView();
		});

		this.settingsTab = new VaultBridgesSettingsTab(this.app, this);
		this.addSettingTab(this.settingsTab);

		this.addCommand({
			id: 'open-sidebar',
			name: 'Open Bridges Sidebar',
			callback: () => this.activateSidebarView(),
		});

		this.addCommand({
			id: 'sync-all-bridges',
			name: 'Sync All Bridges',
			callback: () => this.bridgeManager.syncAll(),
		});

		this.addCommand({
			id: 'rebuild-all-links',
			name: 'Rebuild All Links',
			callback: () => this.bridgeManager.rebuildAllLinks(),
		});

		this.addCommand({
			id: 'push-all-bridges',
			name: 'Push All Bridges',
			callback: () => this.bridgeManager.pushAll(),
		});

		// Register pull + push commands for each existing bridge
		for (const bridge of this.settings.bridges) {
			this.registerBridgeCommands(bridge);
		}

		// Auto-sync on startup after layout is ready
		this.app.workspace.onLayoutReady(() => {
			this.bridgeManager.syncOnStartup();
		});

		// Watch for vault file changes to update dirty state in real time
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				this.bridgeManager.onVaultFileModified(file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				// Check both sides: old path (now deleted from bridge) and new path (added)
				this.bridgeManager.onVaultFileModified(oldPath);
				this.bridgeManager.onVaultFileModified(file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				this.bridgeManager.onVaultFileModified(file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on('create', (file) => {
				this.bridgeManager.onVaultFileModified(file.path);
			})
		);

		console.log('Vault Bridges: loaded');
	}

	/**
	 * Registers (or re-registers) the per-bridge Pull and Push commands.
	 * Safe to call on an existing id — Obsidian replaces the previous registration,
	 * so calling this after a bridge name edit keeps the palette label fresh.
	 */
	registerBridgeCommands(bridge: Bridge): void {
		const id = bridge.id;

		this.addCommand({
			id: `pull-bridge-${id}`,
			name: `Pull "${bridge.name}"`,
			callback: () => {
				const b = this.settings.bridges.find(b => b.id === id);
				if (b) this.bridgeManager.syncBridge(b);
			},
		});

		this.addCommand({
			id: `push-bridge-${id}`,
			name: `Push "${bridge.name}"`,
			callback: () => {
				const b = this.settings.bridges.find(b => b.id === id);
				if (b) this.bridgeManager.pushBridge(b);
			},
		});
	}

	/** Open the sidebar view, or reveal it if already open. */
	async activateSidebarView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(BRIDGES_SIDEBAR_VIEW_TYPE);
		if (existing.length > 0) {
			workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: BRIDGES_SIDEBAR_VIEW_TYPE, active: true });
			workspace.revealLeaf(leaf);
		}
	}

	onunload() {
		this.fileCommandBar?.destroy();
		this.app.workspace.detachLeavesOfType(BRIDGES_SIDEBAR_VIEW_TYPE);
		console.log('Vault Bridges: unloaded');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
