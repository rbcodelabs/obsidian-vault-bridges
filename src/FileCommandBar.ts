import { WorkspaceLeaf, MarkdownView } from 'obsidian';
import type VaultBridgesPlugin from '../main';
import type { Bridge } from './types';
import { PushCommitModal } from './PushCommitModal';

/**
 * FileCommandBar injects a slim action bar between the view header and the
 * editor content for every Markdown leaf whose open file lives inside a
 * vault bridge. The bar surfaces sync state and Pull / Push controls so
 * the user can act without leaving the document.
 */
export class FileCommandBar {
	/** Map from leaf.id to the injected bar element */
	private bars: Map<string, HTMLElement> = new Map();

	constructor(private plugin: VaultBridgesPlugin) {
		plugin.registerEvent(
			plugin.app.workspace.on('file-open', () => {
				// Give the view DOM one tick to settle before injecting
				setTimeout(() => this.refresh(), 60);
			})
		);
		plugin.registerEvent(
			plugin.app.workspace.on('layout-change', () => {
				this.refresh();
			})
		);
	}

	/**
	 * Call after any bridge state change (dirty, status, timestamps, etc.)
	 * to re-render all currently visible bars.
	 */
	update(): void {
		this.refresh();
	}

	/** Remove all injected bars — call on plugin unload. */
	destroy(): void {
		for (const bar of this.bars.values()) {
			bar.remove();
		}
		this.bars.clear();
	}

	/**
	 * Reconcile bars across every open leaf:
	 *  - Leaves showing a bridge file get a bar (created or content-updated).
	 *  - Leaves showing a non-bridge file have any bar removed.
	 *  - Bars whose leaf has since closed are cleaned up.
	 */
	refresh(): void {
		const activeLeafIds = new Set<string>();

		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof MarkdownView)) return;
			const file = (leaf.view as MarkdownView).file;
			if (!file) return;

			const id = this.leafId(leaf);
			activeLeafIds.add(id);

			const bridge = this.findBridgeForFile(file.path);
			if (bridge) {
				this.renderBar(leaf, id, bridge);
			} else {
				this.removeBar(id);
			}
		});

		// Clean up bars for leaves that are no longer open
		for (const id of [...this.bars.keys()]) {
			if (!activeLeafIds.has(id)) {
				this.removeBar(id);
			}
		}
	}

	// ── Private helpers ────────────────────────────────────────────────────

	private leafId(leaf: WorkspaceLeaf): string {
		return (leaf as unknown as { id: string }).id;
	}

	private findBridgeForFile(filePath: string): Bridge | undefined {
		return this.plugin.settings.bridges.find(
			(b) => filePath.startsWith(b.vaultPath + '/') || filePath === b.vaultPath
		);
	}

	private removeBar(leafId: string): void {
		const existing = this.bars.get(leafId);
		if (existing) {
			existing.remove();
			this.bars.delete(leafId);
		}
	}

	private renderBar(leaf: WorkspaceLeaf, leafId: string, bridge: Bridge): void {
		let bar = this.bars.get(leafId);

		if (!bar) {
			// Insert the bar between .view-header and .view-content
			const viewContent = leaf.view.containerEl.querySelector('.view-content');
			if (!viewContent || !viewContent.parentElement) return;

			bar = createEl('div', { cls: 'vault-bridges-command-bar' });
			viewContent.parentElement.insertBefore(bar, viewContent);
			this.bars.set(leafId, bar);
		}

		this.buildBarContent(bar, bridge);
	}

	private buildBarContent(bar: HTMLElement, bridge: Bridge): void {
		const { isDirty, status, lastError, lastPulled, lastPushed, branch, name } = bridge;
		const isSyncing = status === 'syncing';
		const isError   = status === 'error';

		// Reset state classes
		bar.className = 'vault-bridges-command-bar';
		if (isDirty)   bar.addClass('is-dirty');
		if (isError)   bar.addClass('is-error');
		if (isSyncing) bar.addClass('is-syncing');

		bar.empty();

		// ── Left: status icon + bridge identity ─────────────────────────
		const info = bar.createEl('div', { cls: 'vault-bridges-bar-info' });

		const iconText = isSyncing ? '↻' : isError ? '✕' : isDirty ? '●' : '✓';
		info.createEl('span', {
			cls: 'vault-bridges-bar-icon',
			text: iconText,
			attr: { 'aria-hidden': 'true' },
		});

		info.createEl('span', { cls: 'vault-bridges-bar-name', text: name });
		info.createEl('span', { cls: 'vault-bridges-bar-branch', text: branch });

		if (isSyncing) {
			info.createEl('span', { cls: 'vault-bridges-bar-status-label is-syncing', text: 'syncing…' });
		} else if (isError && lastError) {
			info.createEl('span', {
				cls: 'vault-bridges-bar-status-label is-error',
				text: lastError,
				attr: { title: lastError },
			});
		} else if (isDirty) {
			info.createEl('span', { cls: 'vault-bridges-bar-status-label is-dirty', text: 'modified' });
		} else {
			const ts = lastPushed ?? lastPulled;
			if (ts) {
				const rel = this.relativeTime(ts);
				info.createEl('span', {
					cls: 'vault-bridges-bar-status-label is-clean',
					text: `synced ${rel}`,
					attr: { title: new Date(ts).toLocaleString() },
				});
			}
		}

		// ── Right: action buttons ────────────────────────────────────────
		const actions = bar.createEl('div', { cls: 'vault-bridges-bar-actions' });

		const pullBtn = actions.createEl('button', {
			cls: 'vault-bridges-bar-btn',
			text: '↓ Pull',
			attr: { 'aria-label': `Pull latest from ${branch}` },
		});
		pullBtn.disabled = isSyncing;
		pullBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.plugin.bridgeManager.syncBridge(bridge);
		});

		const pushBtnCls = isDirty
			? 'vault-bridges-bar-btn is-cta'
			: 'vault-bridges-bar-btn';
		const pushBtn = actions.createEl('button', {
			cls: pushBtnCls,
			text: '↑ Push',
			attr: { 'aria-label': `Commit and push to ${branch}` },
		});
		pushBtn.disabled = isSyncing;
		pushBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			new PushCommitModal(this.plugin.app, bridge, (msg) => {
				this.plugin.bridgeManager.pushBridge(bridge, msg || undefined);
			}).open();
		});
	}

	/** Returns a human-friendly relative time string (e.g. "3 min ago"). */
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
