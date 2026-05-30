/**
 * Obsidian API mock for the Playwright harness.
 * Must be imported first — patches HTMLElement.prototype with Obsidian's DOM extensions.
 */

// ─── HTMLElement.prototype extensions ────────────────────────────────────────

interface CreateElOptions {
	cls?: string;
	text?: string;
	attr?: Record<string, string | boolean>;
	placeholder?: string;
	type?: string;
	value?: string;
	title?: string;
}

function applyCreateEl<K extends keyof HTMLElementTagNameMap>(
	el: HTMLElementTagNameMap[K],
	opts?: CreateElOptions | string,
): HTMLElementTagNameMap[K] {
	if (!opts) return el;
	if (typeof opts === 'string') { el.className = opts; return el; }
	if (opts.cls) el.className = opts.cls;
	if (opts.text) el.textContent = opts.text;
	if (opts.attr) {
		for (const [k, v] of Object.entries(opts.attr)) {
			if (typeof v === 'boolean') { if (v) el.setAttribute(k, ''); else el.removeAttribute(k); }
			else el.setAttribute(k, v);
		}
	}
	if (opts.placeholder) el.setAttribute('placeholder', opts.placeholder);
	if (opts.type) el.setAttribute('type', opts.type);
	if (opts.value) (el as HTMLInputElement).value = opts.value;
	if (opts.title) el.setAttribute('title', opts.title);
	return el;
}

declare global {
	interface HTMLElement {
		createEl<K extends keyof HTMLElementTagNameMap>(tag: K, opts?: CreateElOptions | string): HTMLElementTagNameMap[K];
		createDiv(opts?: CreateElOptions | string): HTMLDivElement;
		createSpan(opts?: CreateElOptions | string): HTMLSpanElement;
		empty(): void;
		addClass(...classes: string[]): void;
		removeClass(...classes: string[]): void;
		hasClass(cls: string): boolean;
		toggleClass(cls: string, force?: boolean): void;
		setText(text: string): void;
	}
}

HTMLElement.prototype.createEl = function <K extends keyof HTMLElementTagNameMap>(tag: K, opts?: CreateElOptions | string) {
	const el = document.createElement(tag);
	applyCreateEl(el, opts);
	this.appendChild(el);
	return el;
};
HTMLElement.prototype.createDiv = function (opts?: CreateElOptions | string) { return this.createEl('div', opts); };
HTMLElement.prototype.createSpan = function (opts?: CreateElOptions | string) { return this.createEl('span', opts); };
HTMLElement.prototype.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
HTMLElement.prototype.addClass = function (...classes: string[]) { for (const c of classes) if (c) this.classList.add(c); };
HTMLElement.prototype.removeClass = function (...classes: string[]) { for (const c of classes) if (c) this.classList.remove(c); };
HTMLElement.prototype.hasClass = function (cls: string) { return this.classList.contains(cls); };
HTMLElement.prototype.toggleClass = function (cls: string, force?: boolean) {
	if (force !== undefined) this.classList.toggle(cls, force); else this.classList.toggle(cls);
};
HTMLElement.prototype.setText = function (text: string) { this.textContent = text; };

// ─── Icons (Lucide SVG strings) ───────────────────────────────────────────────

const ICONS: Record<string, string> = {
	'refresh-cw': `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`,
	'pencil': `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`,
	'trash': `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`,
	'plus': `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>`,
};
const FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>`;

// ─── Setting component helpers ────────────────────────────────────────────────

class ButtonComponent {
	buttonEl: HTMLButtonElement;

	constructor(container: HTMLElement) {
		this.buttonEl = document.createElement('button');
		this.buttonEl.className = 'mod-cta';
		container.appendChild(this.buttonEl);
	}

	setButtonText(text: string): this { this.buttonEl.textContent = text; return this; }
	setCta(): this { this.buttonEl.classList.add('mod-cta'); return this; }
	setWarning(): this { this.buttonEl.classList.add('mod-warning'); this.buttonEl.classList.remove('mod-cta'); return this; }
	setIcon(name: string): this { setIcon(this.buttonEl, name); return this; }
	setTooltip(tip: string): this { this.buttonEl.title = tip; return this; }
	onClick(cb: () => void): this { this.buttonEl.addEventListener('click', cb); return this; }
}

class ToggleComponent {
	private cb: ((val: boolean) => void) | null = null;
	private input: HTMLInputElement;

	constructor(container: HTMLElement) {
		const label = document.createElement('label');
		label.className = 'checkbox-container';
		this.input = document.createElement('input');
		this.input.type = 'checkbox';
		const slider = document.createElement('span');
		slider.className = 'slider';
		label.appendChild(this.input);
		label.appendChild(slider);
		container.appendChild(label);
		this.input.addEventListener('change', () => this.cb?.(this.input.checked));
	}

	setValue(val: boolean): this { this.input.checked = val; return this; }
	onChange(cb: (val: boolean) => void): this { this.cb = cb; return this; }
}

class TextComponent {
	inputEl: HTMLInputElement;
	private cb: ((val: string) => void) | null = null;

	constructor(container: HTMLElement) {
		this.inputEl = document.createElement('input');
		this.inputEl.type = 'text';
		this.inputEl.className = 'text-input';
		container.appendChild(this.inputEl);
		this.inputEl.addEventListener('input', () => this.cb?.(this.inputEl.value));
	}

	setPlaceholder(p: string): this { this.inputEl.placeholder = p; return this; }
	setValue(v: string): this { this.inputEl.value = v; return this; }
	onChange(cb: (val: string) => void): this { this.cb = cb; return this; }
}

// ─── Setting ─────────────────────────────────────────────────────────────────

export class Setting {
	settingEl: HTMLElement;
	nameEl: HTMLElement;
	descEl: HTMLElement;
	controlEl: HTMLElement;

	constructor(container: HTMLElement) {
		this.settingEl = document.createElement('div');
		this.settingEl.className = 'setting-item';

		const info = document.createElement('div');
		info.className = 'setting-item-info';
		this.nameEl = document.createElement('div');
		this.nameEl.className = 'setting-item-name';
		this.descEl = document.createElement('div');
		this.descEl.className = 'setting-item-description';
		info.appendChild(this.nameEl);
		info.appendChild(this.descEl);

		this.controlEl = document.createElement('div');
		this.controlEl.className = 'setting-item-control';

		this.settingEl.appendChild(info);
		this.settingEl.appendChild(this.controlEl);
		container.appendChild(this.settingEl);
	}

	setName(name: string): this { this.nameEl.textContent = name; return this; }
	setDesc(desc: string): this { this.descEl.textContent = desc; return this; }
	setHeading(): this { this.settingEl.classList.add('setting-item-heading'); return this; }

	addButton(cb: (btn: ButtonComponent) => void): this {
		cb(new ButtonComponent(this.controlEl));
		return this;
	}

	addToggle(cb: (toggle: ToggleComponent) => void): this {
		cb(new ToggleComponent(this.controlEl));
		return this;
	}

	addText(cb: (text: TextComponent) => void): this {
		cb(new TextComponent(this.controlEl));
		return this;
	}
}

// ─── PluginSettingTab ─────────────────────────────────────────────────────────

export class PluginSettingTab {
	containerEl: HTMLElement;

	constructor(protected app: unknown, protected plugin: unknown) {
		this.containerEl = document.createElement('div');
		this.containerEl.className = 'vertical-tab-content';
	}

	display(): void {}
	hide(): void {}
}

// ─── Modal ────────────────────────────────────────────────────────────────────

export class Modal {
	titleEl: HTMLElement;
	contentEl: HTMLElement;

	private overlay: HTMLElement;
	protected app: unknown;

	constructor(app: unknown) {
		this.app = app;

		this.overlay = document.createElement('div');
		this.overlay.className = 'modal-overlay';
		Object.assign(this.overlay.style, {
			position: 'fixed', inset: '0',
			background: 'rgba(0,0,0,0.6)',
			display: 'flex', alignItems: 'center', justifyContent: 'center',
			zIndex: '9999',
		});

		const container = document.createElement('div');
		container.className = 'modal-container';
		Object.assign(container.style, {
			background: 'var(--background-primary)',
			border: '1px solid var(--background-modifier-border)',
			borderRadius: '8px',
			padding: '24px',
			width: '480px',
			maxWidth: '90vw',
			boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
			maxHeight: '80vh',
			overflowY: 'auto',
		});

		this.titleEl = document.createElement('h2');
		Object.assign(this.titleEl.style, { margin: '0 0 16px', fontSize: '17px', color: 'var(--text-normal)' });

		this.contentEl = document.createElement('div');
		this.contentEl.style.color = 'var(--text-normal)';

		container.appendChild(this.titleEl);
		container.appendChild(this.contentEl);
		this.overlay.appendChild(container);
	}

	open(): void {
		document.body.appendChild(this.overlay);
		this.onOpen();
	}

	close(): void {
		if (this.overlay.parentNode) this.overlay.parentNode.removeChild(this.overlay);
		this.onClose();
	}

	onOpen(): void {}
	onClose(): void {}
}

// ─── MarkdownView / WorkspaceLeaf (needed by FileCommandBar) ─────────────────

export class MarkdownView {
	containerEl: HTMLElement;
	file: { path: string } | null = null;

	constructor() {
		this.containerEl = document.createElement('div');
		this.containerEl.className = 'workspace-leaf-content';
	}
}

export class WorkspaceLeaf {
	id: string;
	view: MarkdownView;

	constructor(id: string, view: MarkdownView) {
		this.id = id;
		this.view = view;
	}
}

// ─── Global createEl (Obsidian provides this as a window-level function) ──────

declare global {
	// eslint-disable-next-line no-var
	var createEl: <K extends keyof HTMLElementTagNameMap>(
		tag: K,
		opts?: CreateElOptions | string,
	) => HTMLElementTagNameMap[K];
}

window.createEl = function <K extends keyof HTMLElementTagNameMap>(
	tag: K,
	opts?: CreateElOptions | string,
): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	applyCreateEl(el, opts);
	return el;
};

// ─── Misc exports ─────────────────────────────────────────────────────────────

type LeafCallback = (leaf: WorkspaceLeaf) => void;

export const mockApp = {
	vault: { adapter: { basePath: '/mock/vault' } },
	workspace: {
		/** Harness tests can push fake leaves here before calling FileCommandBar.refresh() */
		_leaves: [] as WorkspaceLeaf[],
		on(_event: string, _cb: () => void) { return {}; },
		iterateAllLeaves(cb: LeafCallback) {
			for (const leaf of mockApp.workspace._leaves) cb(leaf);
		},
	},
};

export class Notice {
	constructor(_msg: string, _duration?: number) {
		// Render a toast so screenshots show notices
		const toast = document.createElement('div');
		toast.className = 'vault-bridges-notice';
		toast.textContent = _msg;
		Object.assign(toast.style, {
			position: 'fixed', bottom: '20px', right: '20px',
			background: 'var(--background-secondary-alt)',
			border: '1px solid var(--background-modifier-border)',
			borderRadius: '6px', padding: '10px 14px',
			color: 'var(--text-normal)', fontSize: '13px',
			zIndex: '99999', maxWidth: '320px',
		});
		document.body.appendChild(toast);
		setTimeout(() => toast.remove(), _duration ?? 4000);
	}
}

export const Platform = { isWin: false, isMac: true, isLinux: false };

export function setIcon(el: HTMLElement, name: string): void {
	el.innerHTML = ICONS[name] ?? FALLBACK_SVG;
}

export function sanitizeHTMLToDom(html: string): DocumentFragment {
	const tpl = document.createElement('template');
	tpl.innerHTML = html;
	return tpl.content;
}
