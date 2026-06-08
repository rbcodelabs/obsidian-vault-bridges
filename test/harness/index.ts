import './obsidian-mock'; // must be first — patches HTMLElement.prototype
import { mockApp, MarkdownView, WorkspaceLeaf } from './obsidian-mock';
import { VaultBridgesSettingsTab } from '../../src/SettingsTab';
import { ConflictResolutionModal } from '../../src/ConflictResolutionModal';
import { FileCommandBar } from '../../src/FileCommandBar';
import { BridgesSidebarView } from '../../src/BridgesSidebarView';
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

// ─── BridgesSidebarView scenarios ────────────────────────────────────────────

function renderSidebarScenario(variant: 'clean' | 'dirty-expanded' | 'empty') {
	// Build a mock leaf — BridgesSidebarView extends ItemView which needs a leaf
	const fakeLeaf = new WorkspaceLeaf('sidebar-leaf', null as never);

	// Choose fixture data
	let sidebarBridges: Bridge[];
	if (variant === 'empty') {
		sidebarBridges = [];
	} else if (variant === 'dirty-expanded') {
		sidebarBridges = [
			{ ...dirtyBridge },
			...fixtureBridges.slice(1),
		];
	} else {
		sidebarBridges = [...fixtureBridges];
	}

	const sidebarSettings: VaultBridgesSettings = {
		bridges: sidebarBridges,
		syncOnStartup: true,
		claudePath: '/opt/homebrew/bin/claude',
		claudeEnabled: true,
	};

	const sidebarPlugin = {
		app: mockApp,
		settings: sidebarSettings,
		bridgeManager: {
			...mockBridgeManager,
			checkPrStatus: (_bridge: Bridge) => {},
			mergePr: (_bridge: Bridge) => {},
		},
		statusBar: mockStatusBar,
		saveSettings: async () => {},
		registerEvent: (_ref: unknown) => {},
	};

	const view = new BridgesSidebarView(fakeLeaf, sidebarPlugin as never);
	view.onOpen();

	// If dirty-expanded, also expand the dirty bridge's file list
	if (variant === 'dirty-expanded') {
		// Simulate clicking the changes pill by expanding via the internal set
		(view as never as { expandedBridges: Set<string> }).expandedBridges.add(dirtyBridge.id);
		view.update();
	}

	// Mount the sidebar pane into a realistic chrome
	const wrapper = document.getElementById('settings-content')!;
	wrapper.style.cssText = '';

	// Replace the mock-window with a sidebar-style layout
	const mockWindow = document.querySelector('.mock-window') as HTMLElement;
	if (mockWindow) {
		mockWindow.style.flexDirection = 'row';
		// Shrink the main area and show a sidebar pane on the left
		const sidePane = document.createElement('div');
		sidePane.className = 'mock-sidebar-pane';
		Object.assign(sidePane.style, {
			width: '280px',
			height: '100%',
			background: 'var(--background-secondary)',
			borderRight: '1px solid var(--background-modifier-border)',
			overflow: 'hidden',
			display: 'flex',
			flexDirection: 'column',
			flexShrink: '0',
		});
		sidePane.appendChild(view.contentEl);
		// Insert sidebar before the modal area
		const mockModal = document.querySelector('.mock-modal');
		if (mockModal) {
			mockModal.insertBefore(sidePane, mockModal.firstChild);
		}
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
} else if (scenario === 'sidebar') {
	renderSidebarScenario('clean');
} else if (scenario === 'sidebar-dirty') {
	renderSidebarScenario('dirty-expanded');
} else if (scenario === 'sidebar-empty') {
	renderSidebarScenario('empty');
} else {
	tab = new VaultBridgesSettingsTab(mockApp, mockPlugin as never);
	const container = document.getElementById('settings-content')!;
	container.appendChild(tab.containerEl);
	tab.display();

	// Expose for Playwright interaction
	(window as never as Record<string, unknown>).__tab = tab;
	(window as never as Record<string, unknown>).__plugin = mockPlugin;
}
