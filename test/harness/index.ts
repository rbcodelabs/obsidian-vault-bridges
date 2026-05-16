import './obsidian-mock'; // must be first — patches HTMLElement.prototype
import { mockApp } from './obsidian-mock';
import { VaultBridgesSettingsTab } from '../../src/SettingsTab';
import { ConflictResolutionModal } from '../../src/ConflictResolutionModal';
import { fixtureBridges, emptyBridges, fixturePlan } from './fixtures';
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
	pushBridge: async (_bridge: Bridge) => {},
	pushAll: async () => {},
};

const mockPlugin = {
	app: mockApp,
	settings,
	bridgeManager: mockBridgeManager,
	statusBar: mockStatusBar,
	saveSettings: async () => {},
};

// ─── Render ───────────────────────────────────────────────────────────────────

if (scenario === 'conflict-modal') {
	const modal = new ConflictResolutionModal(mockApp, fixtureBridges[0], fixturePlan, {
		onApprove: async () => {},
		onReject: () => {},
	});
	modal.open();
} else {
	const tab = new VaultBridgesSettingsTab(mockApp, mockPlugin as never);
	const container = document.getElementById('settings-content')!;
	container.appendChild(tab.containerEl);
	tab.display();

	// Expose for Playwright interaction
	(window as never as Record<string, unknown>).__tab = tab;
	(window as never as Record<string, unknown>).__plugin = mockPlugin;
}
