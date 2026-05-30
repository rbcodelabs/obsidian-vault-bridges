import './obsidian-mock'; // must be first — patches HTMLElement.prototype
import { mockApp, MarkdownView, WorkspaceLeaf } from './obsidian-mock';
import { VaultBridgesSettingsTab } from '../../src/SettingsTab';
import { ConflictResolutionModal } from '../../src/ConflictResolutionModal';
import { FileCommandBar } from '../../src/FileCommandBar';
import { fixtureBridges, emptyBridges, fixturePlan, dirtyBridge, fixtureChangedFiles } from './fixtures';
import type { Bridge, VaultBridgesSettings } from '../../src/types';

// ─── Determine which scenario to render (driven by ?scenario= query param) ───

const params = new URLSearchParams(window.location.search);
const scenario = params.get('scenario') ?? 'bridges';

const bridges: Bridge[] = scenario === 'empty' ? emptyBridges : [...fixtureBridges];

// ─── Mock plugin ──────────────────────────────────────────────────────────────

const settings: VaultBridgesSettings = {
	bridges,
	syncOnStartup: true,
	claudePath: '/opt/homebrew/bin/claude',
	claudeEnabled: true,
};

const mockStatusBar = { update: () => {} };

const mockBridgeManager = {
	syncBridge: async (bridge: Bridge) => {
		bridge.status = 'ok';
		bridge.lastSynced = new Date().toISOString();
		bridge.lastError = undefined;
		tab.display();
	},
	syncAll: async () => {
		for (const b of settings.bridges) {
			b.status = 'ok';
			b.lastSynced = new Date().toISOString();
		}
		tab.display();
	},
	removeLink: async (bridge: Bridge) => {
		bridge.status = 'unlinked';
	},
	rebuildAllLinks: async () => {
		for (const b of settings.bridges) b.status = 'ok';
		tab.display();
	},
	ensureLink: async () => {},
	checkDirty: (_bridge: Bridge) => false,
	getChangedFiles: (_bridge: Bridge) => fixtureChangedFiles,
	pushBridge: async (_bridge: Bridge) => {},
	pushAll: async () => {},
};

const mockPlugin = {
	app: mockApp,
	settings,
	bridgeManager: mockBridgeManager,
	statusBar: mockStatusBar,
	saveSettings: async () => {},
	registerEvent: (_ref: unknown) => {},
};

// ─── FileCommandBar scenarios ─────────────────────────────────────────────────

function renderCommandBarScenario(openPopdown: boolean) {
	// Build a fake leaf DOM: .workspace-leaf > .view-header + .view-content
	const leafContainer = document.createElement('div');
	leafContainer.className = 'workspace-leaf';
	Object.assign(leafContainer.style, {
		display: 'flex',
		flexDirection: 'column',
		width: '860px',
		height: '480px',
		background: 'var(--background-primary)',
		border: '1px solid var(--background-modifier-border)',
		borderRadius: '6px',
		overflow: 'hidden',
		position: 'relative',
	});

	const viewHeader = document.createElement('div');
	viewHeader.className = 'view-header';
	Object.assign(viewHeader.style, {
		height: '40px',
		background: 'var(--background-secondary)',
		borderBottom: '1px solid var(--background-modifier-border)',
		display: 'flex',
		alignItems: 'center',
		padding: '0 12px',
		color: 'var(--text-muted)',
		fontSize: '13px',
	});
	viewHeader.textContent = 'Work/Docs/architecture/decisions/001-use-postgres.md';

	const viewContent = document.createElement('div');
	viewContent.className = 'view-content';
	Object.assign(viewContent.style, {
		flex: '1',
		padding: '24px 48px',
		color: 'var(--text-normal)',
		fontSize: '15px',
		lineHeight: '1.6',
		overflowY: 'auto',
	});
	viewContent.innerHTML = `
		<h1 style="margin:0 0 8px;font-size:22px;">ADR 001: Use PostgreSQL</h1>
		<p style="color:var(--text-muted);font-size:13px;margin:0 0 20px;">Status: Accepted · 2024-01-15</p>
		<h2 style="font-size:16px;margin:0 0 8px;">Context</h2>
		<p style="margin:0 0 16px;">We need a reliable relational database for the new backend service…</p>
		<h2 style="font-size:16px;margin:0 0 8px;">Decision</h2>
		<p style="margin:0;">We will use PostgreSQL 16 as our primary data store.</p>
	`;

	// The MarkdownView's containerEl is the leaf container
	const view = new MarkdownView();
	view.containerEl = leafContainer;
	view.file = { path: 'Work/Docs/architecture/decisions/001-use-postgres.md' };

	leafContainer.appendChild(viewHeader);
	leafContainer.appendChild(viewContent);

	// Set up the bridge for this file's vaultPath
	const barSettings: VaultBridgesSettings = {
		bridges: [dirtyBridge],
		syncOnStartup: true,
		claudePath: '/opt/homebrew/bin/claude',
		claudeEnabled: true,
	};

	// Create a leaf and register it with the workspace mock
	const leaf = new WorkspaceLeaf('leaf-bar-1', view);
	mockApp.workspace._leaves = [leaf];

	const barPlugin = {
		app: mockApp,
		settings: barSettings,
		bridgeManager: mockBridgeManager,
		statusBar: mockStatusBar,
		saveSettings: async () => {},
		registerEvent: (_ref: unknown) => {},
	};

	const bar = new FileCommandBar(barPlugin as never);
	bar.refresh();

	const wrapper = document.getElementById('settings-content')!;
	wrapper.style.cssText = 'padding: 24px; background: var(--background-primary);';
	wrapper.appendChild(leafContainer);

	if (openPopdown) {
		// Click the changes pill to open the popdown
		const pill = leafContainer.querySelector('.vault-bridges-changes-pill') as HTMLButtonElement | null;
		if (pill) pill.click();
	}
}

// ─── Render ───────────────────────────────────────────────────────────────────

// tab is referenced inside mockBridgeManager callbacks — forward-declare
let tab: VaultBridgesSettingsTab;

if (scenario === 'conflict-modal') {
	const modal = new ConflictResolutionModal(mockApp, fixtureBridges[0], fixturePlan, {
		onApprove: async () => {},
		onReject: () => {},
	});
	modal.open();
} else if (scenario === 'command-bar-pill') {
	renderCommandBarScenario(false);
} else if (scenario === 'command-bar-popdown') {
	renderCommandBarScenario(true);
} else {
	tab = new VaultBridgesSettingsTab(mockApp, mockPlugin as never);
	const container = document.getElementById('settings-content')!;
	container.appendChild(tab.containerEl);
	tab.display();

	// Expose for Playwright interaction
	(window as never as Record<string, unknown>).__tab = tab;
	(window as never as Record<string, unknown>).__plugin = mockPlugin;
}
