import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import type VaultBridgesPlugin from '../main';
import type { Bridge, ChangedFile } from './types';

export const BRIDGES_SIDEBAR_VIEW_TYPE = 'vault-bridges-sidebar';

/**
 * BridgesSidebarView renders an Obsidian ItemView (side panel) that lists
 * every configured bridge with its current status, pending change count,
 * an expandable file list, and Pull / Push action buttons.
 *
 * This lets you act on any bridge without first navigating to a file inside
 * that bridge's vault folder — solving the "you have to find a file first"
 * friction of the FileCommandBar.
 */
export class BridgesSidebarView extends ItemView {
	private plugin: VaultBridgesPlugin;

	/** Track which bridge IDs have their file list expanded */
	private expandedBridges: Set<string> = new Set();

	/** Which bridge is currently showing its commit-message input */
	private activeMessageInputs: Map<string, HTMLInputElement> = new Map();

	constructor(leaf: WorkspaceLeaf, plugin: VaultBridgesPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return BRIDGES_SIDEBAR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Vault Bridges';
	}

	getIcon(): string {
		return 'git-fork';
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	/**
	 * Re-render the sidebar. Called by BridgeManager after any state change.
	 * Preserves expanded state and any in-progress commit message text.
	 */
	update(): void {
		// Snapshot message input values before re-render so they survive
		for (const [id, input] of this.activeMessageInputs.entries()) {
			const val = input.value;
			// Store temporarily on the element so render() can restore it
			(input as unknown as Record<string, string>)['__pendingValue'] = val;
			void id; // used for map iteration side effect
		}
		this.render();
	}

	// ── Rendering ────────────────────────────────────────────────────────────

	private render(): void {
		// Snapshot any in-flight commit messages before wiping the DOM
		const savedMessages = new Map<string, string>();
		for (const [id, input] of this.activeMessageInputs.entries()) {
			savedMessages.set(id, input.value);
		}
		this.activeMessageInputs.clear();

		const container = this.contentEl;
		container.empty();
		container.addClass('vault-bridges-sidebar');

		const { bridges } = this.plugin.settings;

		if (bridges.length === 0) {
			const empty = container.createEl('div', { cls: 'vault-bridges-sidebar-empty' });
			empty.createEl('p', { text: 'No bridges configured.' });
			const settingsBtn = empty.createEl('button', {
				cls: 'vault-bridges-sidebar-settings-btn',
				text: 'Open Settings',
			});
			settingsBtn.addEventListener('click', () => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const setting = (this.plugin.app as any).setting;
				setting?.open();
				setting?.openTabById('vault-bridges');
			});
			return;
		}

		// Header row with global sync-all action
		const header = container.createEl('div', { cls: 'vault-bridges-sidebar-header' });
		const titleEl = header.createEl('span', {
			cls: 'vault-bridges-sidebar-title',
			text: `${bridges.length} bridge${bridges.length !== 1 ? 's' : ''}`,
		});
		void titleEl;

		const headerActions = header.createEl('div', { cls: 'vault-bridges-sidebar-header-actions' });
		const pullAllBtn = headerActions.createEl('button', {
			cls: 'vault-bridges-sidebar-header-btn',
			attr: { 'aria-label': 'Pull all bridges' },
		});
		setIcon(pullAllBtn, 'arrow-down-circle');
		pullAllBtn.createEl('span', { text: 'Pull all' });
		pullAllBtn.addEventListener('click', () => {
			this.plugin.bridgeManager.syncAll();
		});

		const pushAllBtn = headerActions.createEl('button', {
			cls: 'vault-bridges-sidebar-header-btn',
			attr: { 'aria-label': 'Push all bridges' },
		});
		setIcon(pushAllBtn, 'arrow-up-circle');
		pushAllBtn.createEl('span', { text: 'Push all' });
		pushAllBtn.addEventListener('click', () => {
			this.plugin.bridgeManager.pushAll();
		});

		// Bridge cards
		const list = container.createEl('div', { cls: 'vault-bridges-sidebar-list' });
		for (const bridge of bridges) {
			const savedMsg = savedMessages.get(bridge.id) ?? '';
			this.renderBridgeCard(list, bridge, savedMsg);
		}
	}

	private renderBridgeCard(parent: HTMLElement, bridge: Bridge, savedMessage: string): void {
		const changedFiles = this.plugin.bridgeManager.getChangedFiles(bridge);
		const isExpanded = this.expandedBridges.has(bridge.id);
		const isSyncing = bridge.status === 'syncing';
		const isError   = bridge.status === 'error';

		const card = parent.createEl('div', { cls: 'vault-bridges-sidebar-card' });
		if (bridge.isDirty) card.addClass('is-dirty');
		if (isError)        card.addClass('is-error');
		if (isSyncing)      card.addClass('is-syncing');

		// ── Card header ──────────────────────────────────────────────────────
		const cardHeader = card.createEl('div', { cls: 'vault-bridges-sidebar-card-header' });

		// Left: status icon + name + branch pill
		const left = cardHeader.createEl('div', { cls: 'vault-bridges-sidebar-card-left' });

		const iconText = isSyncing ? '↻' : isError ? '✕' : bridge.isDirty ? '●' : '✓';
		left.createEl('span', {
			cls: 'vault-bridges-sidebar-status-icon',
			text: iconText,
			attr: { 'aria-hidden': 'true' },
		});

		left.createEl('span', { cls: 'vault-bridges-sidebar-card-name', text: bridge.name });

		left.createEl('span', {
			cls: bridge.activeWorktreePath
				? 'vault-bridges-sidebar-card-branch is-worktree'
				: 'vault-bridges-sidebar-card-branch',
			text: bridge.activeWorktreePath
				? `⎇ ${bridge.activeWorktreeBranch ?? 'worktree'}`
				: bridge.branch,
			attr: bridge.activeWorktreePath
				? { title: `Tracking worktree: ${bridge.activeWorktreePath}` }
				: {},
		});

		// Right: action buttons
		const right = cardHeader.createEl('div', { cls: 'vault-bridges-sidebar-card-actions' });

		const pullBtn = right.createEl('button', {
			cls: 'vault-bridges-sidebar-btn',
			attr: { 'aria-label': `Pull "${bridge.name}"`, title: 'Pull' },
		});
		setIcon(pullBtn, 'arrow-down');
		pullBtn.disabled = isSyncing;
		pullBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.plugin.bridgeManager.syncBridge(bridge);
		});

		const pushLabel = bridge.prMode ? 'Open PR' : 'Push';
		const pushBtn = right.createEl('button', {
			cls: bridge.isDirty
				? 'vault-bridges-sidebar-btn is-cta'
				: 'vault-bridges-sidebar-btn',
			attr: { 'aria-label': `${pushLabel} "${bridge.name}"`, title: pushLabel },
		});
		setIcon(pushBtn, 'arrow-up');
		pushBtn.disabled = isSyncing;
		pushBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.plugin.bridgeManager.pushBridge(bridge);
		});

		// ── Status / summary row ─────────────────────────────────────────────
		const summary = card.createEl('div', { cls: 'vault-bridges-sidebar-card-summary' });

		if (isSyncing) {
			summary.createEl('span', {
				cls: 'vault-bridges-sidebar-status-text is-syncing',
				text: 'Syncing…',
			});
		} else if (isError && bridge.lastError) {
			summary.createEl('span', {
				cls: 'vault-bridges-sidebar-status-text is-error',
				text: bridge.lastError,
				attr: { title: bridge.lastError },
			});
		} else if (bridge.isDirty && changedFiles.length > 0) {
			// Clickable pill to expand/collapse the file list
			const count = changedFiles.length;
			const pill = summary.createEl('button', {
				cls: 'vault-bridges-sidebar-changes-pill',
				attr: { 'aria-expanded': String(isExpanded) },
			});
			pill.createEl('span', { text: `● ${count} change${count !== 1 ? 's' : ''}` });
			pill.createEl('span', {
				cls: 'vault-bridges-sidebar-pill-chevron',
				text: isExpanded ? ' ▴' : ' ▾',
			});
			pill.addEventListener('click', (e) => {
				e.stopPropagation();
				if (this.expandedBridges.has(bridge.id)) {
					this.expandedBridges.delete(bridge.id);
				} else {
					this.expandedBridges.add(bridge.id);
				}
				this.render();
			});
		} else {
			const ts = bridge.lastPushed ?? bridge.lastPulled;
			summary.createEl('span', {
				cls: 'vault-bridges-sidebar-status-text is-clean',
				text: ts ? `synced ${this.relativeTime(ts)}` : 'never synced',
				attr: ts ? { title: new Date(ts).toLocaleString() } : {},
			});
		}

		// PR panel (when a PR is open)
		if (bridge.lastPrUrl) {
			this.renderPrPanel(card, bridge);
		}

		// ── Expanded file list ───────────────────────────────────────────────
		if (isExpanded && changedFiles.length > 0) {
			this.renderFileList(card, bridge, changedFiles, savedMessage);
		}
	}

	private renderPrPanel(card: HTMLElement, bridge: Bridge): void {
		const prUrl = bridge.lastPrUrl!;
		const prNum = prUrl.match(/\/pull\/(\d+)/)?.[1];
		const label = prNum ? `PR #${prNum}` : 'PR open';

		const panel = card.createEl('div', { cls: 'vault-bridges-sidebar-pr-panel' });

		const status = bridge.prStatus ?? 'open';
		const statusText = status === 'checking' ? '…' : status;
		panel.createEl('span', {
			cls: `vault-bridges-pr-status is-${status}`,
			text: statusText,
			attr: { 'aria-label': `PR status: ${status}` },
		});

		panel.createEl('span', { cls: 'vault-bridges-sidebar-pr-label', text: label });

		const btnGroup = panel.createEl('div', { cls: 'vault-bridges-sidebar-pr-btns' });

		const refreshBtn = btnGroup.createEl('button', {
			cls: 'vault-bridges-sidebar-btn vault-bridges-pr-btn',
			attr: { 'aria-label': 'Check PR status', title: 'Refresh status' },
		});
		setIcon(refreshBtn, 'refresh-cw');
		refreshBtn.disabled = status === 'checking';
		refreshBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.plugin.bridgeManager.checkPrStatus(bridge);
		});

		if (status === 'open' || status === 'checking') {
			const mergeBtn = btnGroup.createEl('button', {
				cls: 'vault-bridges-sidebar-btn is-cta vault-bridges-pr-btn',
				attr: { 'aria-label': 'Squash-merge the PR', title: 'Merge' },
			});
			setIcon(mergeBtn, 'git-merge');
			mergeBtn.disabled = status === 'checking';
			mergeBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.plugin.bridgeManager.mergePr(bridge);
			});
		}

		const viewBtn = btnGroup.createEl('button', {
			cls: 'vault-bridges-sidebar-btn vault-bridges-pr-btn',
			attr: { 'aria-label': 'Open PR in browser', title: 'View in browser' },
		});
		setIcon(viewBtn, 'external-link');
		viewBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			window.open(prUrl, '_blank');
		});
	}

	private renderFileList(
		card: HTMLElement,
		bridge: Bridge,
		changedFiles: ChangedFile[],
		savedMessage: string
	): void {
		const fileList = card.createEl('div', { cls: 'vault-bridges-sidebar-file-list' });

		for (const cf of changedFiles) {
			const row = fileList.createEl('div', { cls: 'vault-bridges-sidebar-file-row' });

			const badgeText = cf.status === 'modified' ? 'M' : cf.status === 'added' ? 'A' : 'D';
			row.createEl('span', {
				cls: `vault-bridges-change-badge is-${cf.status}`,
				text: badgeText,
				attr: { title: cf.status },
			});

			row.createEl('span', {
				cls: 'vault-bridges-sidebar-filepath',
				text: cf.relPath,
			});

			// Open-in-tab button
			const openBtn = row.createEl('button', {
				cls: 'vault-bridges-sidebar-file-open-btn',
				attr: {
					'aria-label': cf.status === 'deleted'
						? `${cf.relPath} (deleted)`
						: `Open ${cf.relPath} in new tab`,
					title: cf.status === 'deleted' ? 'Deleted' : 'Open in new tab',
				},
			});
			setIcon(openBtn, 'arrow-up-right');
			if (cf.status === 'deleted') {
				openBtn.disabled = true;
			} else {
				openBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					const fullPath = bridge.vaultPath + '/' + cf.relPath;
					const vaultFile = this.plugin.app.vault.getFileByPath(fullPath);
					if (vaultFile) {
						this.plugin.app.workspace.getLeaf('tab').openFile(vaultFile);
					}
				});
			}
		}

		// ── Push footer ──────────────────────────────────────────────────────
		const footer = fileList.createEl('div', { cls: 'vault-bridges-sidebar-file-footer' });

		const msgInput = footer.createEl('input', {
			cls: 'vault-bridges-sidebar-message-input',
			attr: {
				type: 'text',
				placeholder: 'Commit message (optional)',
				'aria-label': 'Commit message',
				value: savedMessage,
			},
		}) as HTMLInputElement;
		this.activeMessageInputs.set(bridge.id, msgInput);

		const pushVerb = bridge.prMode ? 'Open PR' : 'Push';
		const footerPushBtn = footer.createEl('button', {
			cls: 'vault-bridges-sidebar-btn is-cta',
			text: `↑ ${pushVerb} (${changedFiles.length})`,
			attr: { 'aria-label': `${pushVerb} all changed files for "${bridge.name}"` },
		});
		footerPushBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			const msg = msgInput.value.trim() || undefined;
			this.plugin.bridgeManager.pushBridge(bridge, msg);
		});
	}

	// ── Utilities ─────────────────────────────────────────────────────────────

	private relativeTime(isoString: string): string {
		const diffMs = Date.now() - new Date(isoString).getTime();
		const diffMin = Math.floor(diffMs / 60_000);
		if (diffMin < 1)  return 'just now';
		if (diffMin < 60) return `${diffMin} min ago`;
		const diffHr = Math.floor(diffMin / 60);
		if (diffHr < 24) return `${diffHr} hr ago`;
		return `${Math.floor(diffHr / 24)} days ago`;
	}
}
