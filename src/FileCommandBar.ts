import { WorkspaceLeaf, MarkdownView, setIcon } from 'obsidian';
import type VaultBridgesPlugin from '../main';
import type { Bridge, ChangedFile } from './types';

/**
 * FileCommandBar injects a slim action bar between the view header and the
 * editor content for every Markdown leaf whose open file lives inside a
 * vault bridge. The bar surfaces sync state and Pull / Push controls so
 * the user can act without leaving the document.
 *
 * When the bridge has pending changes a "● N changes ▾" pill is shown. Clicking
 * it opens an inline popdown that lists each changed file with a checkbox so the
 * user can cherry-pick which files to include in the next commit.
 */
export class FileCommandBar {
	/** Map from leaf.id → the injected bar wrapper element */
	private bars: Map<string, HTMLElement> = new Map();
	/**
	 * Map from leaf.id → the currently open popdown element (if any).
	 * Only one popdown is open at a time per bar.
	 */
	private popdowns: Map<string, HTMLElement> = new Map();

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
	 * to re-render all currently visible bars without destroying open popdowns.
	 */
	update(): void {
		this.refresh();
	}

	/** Remove all injected bars and popdowns — call on plugin unload. */
	destroy(): void {
		for (const bar of this.bars.values()) bar.remove();
		for (const pd of this.popdowns.values()) pd.remove();
		this.bars.clear();
		this.popdowns.clear();
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
		this.closePopdown(leafId);
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

		this.buildBarContent(bar, bridge, leafId);
	}

	private buildBarContent(bar: HTMLElement, bridge: Bridge, leafId: string): void {
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
			// Show the changes pill instead of plain "modified" text
			const changedFiles = this.plugin.bridgeManager.getChangedFiles(bridge);
			this.buildChangesPill(info, bar, leafId, bridge, changedFiles);
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
			this.closePopdown(leafId);
			this.plugin.bridgeManager.syncBridge(bridge);
		});

		// "Push all" / "Open PR" quick-action button (always visible on right)
		const pushBtnCls = isDirty ? 'vault-bridges-bar-btn is-cta' : 'vault-bridges-bar-btn';
		const pushBtnLabel = bridge.prMode ? '↑ Open PR' : '↑ Push all';
		const pushBtnAriaLabel = bridge.prMode
			? `Create a PR with all changes against ${branch}`
			: `Commit and push all changes to ${branch}`;
		const pushBtn = actions.createEl('button', {
			cls: pushBtnCls,
			text: pushBtnLabel,
			attr: { 'aria-label': pushBtnAriaLabel },
		});
		pushBtn.disabled = isSyncing;
		pushBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.closePopdown(leafId);
			this.plugin.bridgeManager.pushBridge(bridge);
		});

		// ── PR panel (shown when a PR is open) ──────────────────────────
		if (bridge.lastPrUrl) {
			this.buildPrPanel(bar, bridge);
		}
	}

	private buildPrPanel(bar: HTMLElement, bridge: Bridge): void {
		const prUrl = bridge.lastPrUrl!;
		// Extract PR number from URL for display
		const prNum = prUrl.match(/\/pull\/(\d+)/)?.[1];
		const label = prNum ? `PR #${prNum}` : 'PR open';

		const panel = bar.createEl('div', { cls: 'vault-bridges-pr-panel' });

		// Status badge
		const status = bridge.prStatus ?? 'open';
		const statusText = status === 'checking' ? '…' : status;
		panel.createEl('span', {
			cls: `vault-bridges-pr-status is-${status}`,
			text: statusText,
			attr: { 'aria-label': `PR status: ${status}` },
		});

		panel.createEl('span', { cls: 'vault-bridges-pr-label', text: label });

		// Refresh status button
		const refreshBtn = panel.createEl('button', {
			cls: 'vault-bridges-bar-btn vault-bridges-pr-btn',
			text: '↻',
			attr: { 'aria-label': 'Check PR status' },
		});
		refreshBtn.disabled = status === 'checking';
		refreshBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.plugin.bridgeManager.checkPrStatus(bridge);
		});

		// Merge button (only when open)
		if (status === 'open' || status === 'checking') {
			const mergeBtn = panel.createEl('button', {
				cls: 'vault-bridges-bar-btn vault-bridges-pr-btn is-cta',
				text: '⤲ Merge',
				attr: { 'aria-label': 'Squash-merge the PR' },
			});
			mergeBtn.disabled = status === 'checking';
			mergeBtn.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.plugin.bridgeManager.mergePr(bridge);
			});
		}

		// View in browser button
		const viewBtn = panel.createEl('button', {
			cls: 'vault-bridges-bar-btn vault-bridges-pr-btn',
			text: '↗',
			attr: { 'aria-label': 'Open PR in browser' },
		});
		viewBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			window.open(prUrl, '_blank');
		});
	}

	// ── Changes pill & popdown ─────────────────────────────────────────────

	/**
	 * Renders the clickable "● N changes ▾" pill inside the info section.
	 * Clicking it toggles the pending-changes popdown.
	 */
	private buildChangesPill(
		info: HTMLElement,
		bar: HTMLElement,
		leafId: string,
		bridge: Bridge,
		changedFiles: ChangedFile[]
	): void {
		const count = changedFiles.length;
		const label = count === 1 ? '1 change' : `${count} changes`;

		const pill = info.createEl('button', {
			cls: 'vault-bridges-changes-pill',
			attr: { 'aria-label': 'Show pending changes', 'aria-expanded': 'false' },
		});
		pill.createEl('span', { text: `● ${label}` });
		pill.createEl('span', { cls: 'vault-bridges-pill-chevron', text: ' ▾' });

		pill.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();

			if (this.popdowns.has(leafId)) {
				this.closePopdown(leafId);
				pill.setAttribute('aria-expanded', 'false');
			} else {
				pill.setAttribute('aria-expanded', 'true');
				this.openPopdown(bar, leafId, bridge, changedFiles, () => {
					pill.setAttribute('aria-expanded', 'false');
				});
			}
		});
	}

	/**
	 * Creates and attaches the pending-changes popdown below the bar.
	 * @param onClose  Called when the popdown self-closes (outside click / Escape / push).
	 */
	private openPopdown(
		bar: HTMLElement,
		leafId: string,
		bridge: Bridge,
		changedFiles: ChangedFile[],
		onClose: () => void
	): void {
		// Only one popdown per bar
		this.closePopdown(leafId);

		const pd = bar.createEl('div', { cls: 'vault-bridges-changes-popdown' });
		this.popdowns.set(leafId, pd);

		// ── Header ─────────────────────────────────────────────────────
		const header = pd.createEl('div', { cls: 'vault-bridges-popdown-header' });
		header.createEl('span', {
			cls: 'vault-bridges-popdown-title',
			text: `${changedFiles.length} pending change${changedFiles.length !== 1 ? 's' : ''}`,
		});
		const closeBtn = header.createEl('button', {
			cls: 'vault-bridges-popdown-close',
			text: '×',
			attr: { 'aria-label': 'Close' },
		});
		closeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.closePopdown(leafId);
			onClose();
		});

		// ── File list with checkboxes ───────────────────────────────────
		const list = pd.createEl('div', { cls: 'vault-bridges-popdown-list' });
		const checkboxes: Map<string, HTMLInputElement> = new Map();

		for (const cf of changedFiles) {
			const row = list.createEl('label', { cls: 'vault-bridges-popdown-row' });

			const cb = row.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
			cb.checked = true;
			checkboxes.set(cf.relPath, cb);

			const badge = row.createEl('span', {
				cls: `vault-bridges-change-badge is-${cf.status}`,
				text: cf.status === 'modified' ? 'M' : cf.status === 'added' ? 'A' : 'D',
				attr: { title: cf.status },
			});

			row.createEl('span', { cls: 'vault-bridges-popdown-filepath', text: cf.relPath });

			// Open-in-new-tab button (right side of row)
			const openBtn = row.createEl('button', {
				cls: 'vault-bridges-popdown-open-btn',
				attr: {
					type: 'button',
					'aria-label': cf.status === 'deleted'
						? `${cf.relPath} (deleted — cannot open)`
						: `Open ${cf.relPath} in new tab`,
					title: cf.status === 'deleted' ? 'File deleted' : 'Open in new tab',
				},
			});
			setIcon(openBtn, 'arrow-up-right');
			if (cf.status === 'deleted') {
				openBtn.disabled = true;
			} else {
				openBtn.addEventListener('click', (e) => {
					e.preventDefault();
					e.stopPropagation();
					const fullPath = bridge.vaultPath + '/' + cf.relPath;
					const vaultFile = this.plugin.app.vault.getFileByPath(fullPath);
					if (vaultFile) {
						this.plugin.app.workspace.getLeaf('tab').openFile(vaultFile);
					}
				});
			}

			// When checkbox changes, update the push button count
			cb.addEventListener('change', () => updatePushBtn());

			// Suppress click-through to the pill toggle
			row.addEventListener('click', (e) => e.stopPropagation());

			void badge; // used for side-effect (appended to row)
		}

		// ── Footer: commit message + push button ────────────────────────
		const footer = pd.createEl('div', { cls: 'vault-bridges-popdown-footer' });

		const msgInput = footer.createEl('input', {
			cls: 'vault-bridges-popdown-message',
			attr: {
				type: 'text',
				placeholder: 'Commit message (optional)',
				'aria-label': 'Commit message',
			},
		}) as HTMLInputElement;

		const pushVerb = bridge.prMode ? 'Open PR' : 'Push selected';
		const pushBtn = footer.createEl('button', {
			cls: 'vault-bridges-bar-btn is-cta vault-bridges-popdown-push',
			text: `↑ ${pushVerb} (${changedFiles.length})`,
		});

		const updatePushBtn = () => {
			const selectedCount = [...checkboxes.values()].filter(c => c.checked).length;
			pushBtn.textContent = `↑ ${pushVerb} (${selectedCount})`;
			pushBtn.disabled = selectedCount === 0;
		};

		pushBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			const selected = changedFiles.filter(cf => checkboxes.get(cf.relPath)?.checked);
			if (selected.length === 0) return;

			const msg = msgInput.value.trim() || undefined;
			this.closePopdown(leafId);
			onClose();
			this.plugin.bridgeManager.pushBridge(bridge, msg, selected);
		});

		// ── Keyboard / outside-click dismissal ─────────────────────────
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				this.closePopdown(leafId);
				onClose();
				document.removeEventListener('keydown', onKeyDown);
			}
		};
		document.addEventListener('keydown', onKeyDown);

		// Delay so the current click event doesn't immediately re-trigger close
		const onOutsideClick = (e: MouseEvent) => {
			if (!pd.contains(e.target as Node) && !bar.contains(e.target as Node)) {
				this.closePopdown(leafId);
				onClose();
				document.removeEventListener('mousedown', onOutsideClick);
				document.removeEventListener('keydown', onKeyDown);
			}
		};
		setTimeout(() => document.addEventListener('mousedown', onOutsideClick), 0);

		// Focus the message input for keyboard convenience
		setTimeout(() => msgInput.focus(), 50);
	}

	private closePopdown(leafId: string): void {
		const pd = this.popdowns.get(leafId);
		if (pd) {
			pd.remove();
			this.popdowns.delete(leafId);
		}
	}

	// ── Utilities ──────────────────────────────────────────────────────────

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
