import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChangedFile } from '../../src/types';

// ─── Pure diffing logic ───────────────────────────────────────────────────────
//
// BridgeManager.getChangedFiles() builds a current manifest from disk and
// compares it to bridge.fileManifest. The diffing itself is a pure function of
// two Record<string, string> objects (relPath → SHA-1 hash). We extract that
// logic here and test it without importing BridgeManager (which pulls in
// Obsidian APIs not available in unit-test context).
//
// Implementation mirrors BridgeManager.getChangedFiles() exactly:
//   src/BridgeManager.ts lines 119–132

function computeChangedFiles(
	stored: Record<string, string>,
	current: Record<string, string>,
): ChangedFile[] {
	const changes: ChangedFile[] = [];

	for (const [relPath, hash] of Object.entries(current)) {
		if (!(relPath in stored)) {
			changes.push({ relPath, status: 'added' });
		} else if (stored[relPath] !== hash) {
			changes.push({ relPath, status: 'modified' });
		}
	}
	for (const relPath of Object.keys(stored)) {
		if (!(relPath in current)) {
			changes.push({ relPath, status: 'deleted' });
		}
	}

	return changes.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

// ─── onVaultFileModified branching logic ─────────────────────────────────────
//
// BridgeManager.onVaultFileModified() was recently fixed so that
// fileCommandBar.update() fires on every bridge-file change, not just when
// isDirty flips. We inline the conditional logic from the method here and drive
// it with plain objects to verify both branches without importing BridgeManager.
//
// Implementation mirrors BridgeManager.onVaultFileModified() (lines 59–83).

interface MinimalBridge {
	vaultPath: string;
	fileManifest: Record<string, string> | undefined;
	isDirty: boolean;
}

interface CallRecorder {
	fileCommandBarUpdateCalls: number;
	saveSettingsCalls: number;
	statusBarUpdateCalls: number;
}

/**
 * Inline replica of the onVaultFileModified branching logic.
 * checkDirty is injected as a parameter so tests control its return value.
 */
function simulateOnVaultFileModified(
	filePath: string,
	bridges: MinimalBridge[],
	checkDirty: (bridge: MinimalBridge) => boolean,
	recorder: CallRecorder,
): void {
	let anyBridgeFile = false;
	let anyChanged = false;

	for (const bridge of bridges) {
		if (!bridge.fileManifest) continue;
		if (!filePath.startsWith(bridge.vaultPath + '/') && filePath !== bridge.vaultPath) continue;
		anyBridgeFile = true;
		const isDirty = checkDirty(bridge);
		if (bridge.isDirty !== isDirty) {
			bridge.isDirty = isDirty;
			anyChanged = true;
		}
	}

	// Always re-render the command bar for any bridge file change.
	if (anyBridgeFile) {
		recorder.fileCommandBarUpdateCalls++;
	}
	// Only persist when the dirty flag actually flipped.
	if (anyChanged) {
		recorder.saveSettingsCalls++;
		recorder.statusBarUpdateCalls++;
	}
}

// ─── Tests: getChangedFiles diffing logic ─────────────────────────────────────

describe('computeChangedFiles (getChangedFiles diffing logic)', () => {
	it('returns no changes when both manifests are empty', () => {
		const result = computeChangedFiles({}, {});
		expect(result).toEqual([]);
	});

	it('returns no changes when current matches stored exactly', () => {
		const manifest = {
			'docs/README.md': 'abc123',
			'src/index.ts': 'def456',
		};
		const result = computeChangedFiles(manifest, { ...manifest });
		expect(result).toEqual([]);
	});

	it('detects a single modified file (hash differs)', () => {
		const stored = { 'src/index.ts': 'aaa' };
		const current = { 'src/index.ts': 'bbb' };

		const result = computeChangedFiles(stored, current);

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ relPath: 'src/index.ts', status: 'modified' });
	});

	it('detects a single added file (present in current, absent in stored)', () => {
		const stored = { 'existing.md': 'aaa' };
		const current = { 'existing.md': 'aaa', 'new-file.md': 'bbb' };

		const result = computeChangedFiles(stored, current);

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ relPath: 'new-file.md', status: 'added' });
	});

	it('detects a single deleted file (present in stored, absent in current)', () => {
		const stored = { 'keep.md': 'aaa', 'gone.md': 'bbb' };
		const current = { 'keep.md': 'aaa' };

		const result = computeChangedFiles(stored, current);

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ relPath: 'gone.md', status: 'deleted' });
	});

	it('detects a mix of modified, added, and deleted files simultaneously', () => {
		const stored = {
			'modified.md': 'old-hash',
			'deleted.md': 'some-hash',
			'unchanged.md': 'same-hash',
		};
		const current = {
			'modified.md': 'new-hash',
			'added.md': 'fresh-hash',
			'unchanged.md': 'same-hash',
		};

		const result = computeChangedFiles(stored, current);

		expect(result).toHaveLength(3);

		const byPath = Object.fromEntries(result.map(r => [r.relPath, r.status]));
		expect(byPath['modified.md']).toBe('modified');
		expect(byPath['added.md']).toBe('added');
		expect(byPath['deleted.md']).toBe('deleted');
		expect(byPath['unchanged.md']).toBeUndefined();
	});

	it('sorts results alphabetically by relPath', () => {
		const stored = { 'z-file.md': 'aaa', 'a-file.md': 'old' };
		const current = { 'z-file.md': 'aaa', 'm-file.md': 'new', 'a-file.md': 'changed' };

		const result = computeChangedFiles(stored, current);

		const paths = result.map(r => r.relPath);
		expect(paths).toEqual([...paths].sort());
	});

	it('treats a stored file with empty-string hash as distinct from a missing key', () => {
		// Guards against a hash of '' being accidentally treated as falsy and
		// matching a new file whose key does exist in stored.
		const stored = { 'file.md': '' };
		const current = { 'file.md': 'abc' };

		const result = computeChangedFiles(stored, current);

		expect(result).toHaveLength(1);
		expect(result[0].status).toBe('modified');
	});

	it('handles a large number of files without errors', () => {
		const stored: Record<string, string> = {};
		const current: Record<string, string> = {};
		for (let i = 0; i < 500; i++) {
			const key = `dir/file-${i}.md`;
			stored[key] = `hash-${i}`;
			current[key] = `hash-${i}`;
		}
		// Modify 10, delete 5, add 5 new ones
		for (let i = 0; i < 10; i++) current[`dir/file-${i}.md`] = 'mutated';
		for (let i = 10; i < 15; i++) delete current[`dir/file-${i}.md`];
		for (let i = 500; i < 505; i++) current[`dir/file-${i}.md`] = `hash-${i}`;

		const result = computeChangedFiles(stored, current);

		expect(result.filter(r => r.status === 'modified')).toHaveLength(10);
		expect(result.filter(r => r.status === 'deleted')).toHaveLength(5);
		expect(result.filter(r => r.status === 'added')).toHaveLength(5);
	});
});

// ─── Tests: onVaultFileModified branching logic ───────────────────────────────

describe('onVaultFileModified branching logic', () => {
	let recorder: CallRecorder;

	beforeEach(() => {
		recorder = {
			fileCommandBarUpdateCalls: 0,
			saveSettingsCalls: 0,
			statusBarUpdateCalls: 0,
		};
	});

	it('when bridge isDirty=false and a file is modified → isDirty flips to true, fileCommandBar.update() called, settings saved', () => {
		const bridge: MinimalBridge = {
			vaultPath: 'notes/project',
			fileManifest: { 'README.md': 'abc' },
			isDirty: false,
		};
		// checkDirty reports the bridge is now dirty
		const checkDirty = () => true;

		simulateOnVaultFileModified('notes/project/README.md', [bridge], checkDirty, recorder);

		expect(bridge.isDirty).toBe(true);
		expect(recorder.fileCommandBarUpdateCalls).toBe(1);
		expect(recorder.saveSettingsCalls).toBe(1);
		expect(recorder.statusBarUpdateCalls).toBe(1);
	});

	it('when bridge isDirty=true and another file in the same bridge is modified → isDirty stays true, fileCommandBar.update() still called', () => {
		// This is the bug that was fixed: previously update() was only called
		// when isDirty changed, so a second edit inside an already-dirty bridge
		// would not re-render the command bar, leaving the pending-changes count stale.
		const bridge: MinimalBridge = {
			vaultPath: 'notes/project',
			fileManifest: { 'README.md': 'abc', 'other.md': 'def' },
			isDirty: true,
		};
		// checkDirty still reports dirty (no flip)
		const checkDirty = () => true;

		simulateOnVaultFileModified('notes/project/other.md', [bridge], checkDirty, recorder);

		expect(bridge.isDirty).toBe(true);                          // unchanged
		expect(recorder.fileCommandBarUpdateCalls).toBe(1);         // still fires
		expect(recorder.saveSettingsCalls).toBe(0);                 // no flip → no save
		expect(recorder.statusBarUpdateCalls).toBe(0);              // no flip → no update
	});

	it('when file is not inside any bridge → nothing is called', () => {
		const bridge: MinimalBridge = {
			vaultPath: 'notes/project',
			fileManifest: { 'README.md': 'abc' },
			isDirty: false,
		};
		const checkDirty = vi.fn(() => false);

		simulateOnVaultFileModified('personal/diary.md', [bridge], checkDirty, recorder);

		expect(checkDirty).not.toHaveBeenCalled();
		expect(recorder.fileCommandBarUpdateCalls).toBe(0);
		expect(recorder.saveSettingsCalls).toBe(0);
	});

	it('when bridge has no fileManifest → treated as not a bridge file, nothing called', () => {
		const bridge: MinimalBridge = {
			vaultPath: 'notes/project',
			fileManifest: undefined,
			isDirty: false,
		};
		const checkDirty = vi.fn(() => true);

		simulateOnVaultFileModified('notes/project/README.md', [bridge], checkDirty, recorder);

		expect(checkDirty).not.toHaveBeenCalled();
		expect(recorder.fileCommandBarUpdateCalls).toBe(0);
	});

	it('when file path matches the bridge vaultPath exactly (not a subfolder) → still counts as a bridge file', () => {
		// BridgeManager checks: filePath === bridge.vaultPath (in addition to startsWith)
		const bridge: MinimalBridge = {
			vaultPath: 'notes/project',
			fileManifest: { 'notes/project': 'abc' },
			isDirty: false,
		};
		const checkDirty = () => true;

		simulateOnVaultFileModified('notes/project', [bridge], checkDirty, recorder);

		expect(recorder.fileCommandBarUpdateCalls).toBe(1);
	});

	it('does not match a path that shares a prefix but lacks the trailing slash', () => {
		// 'notes/project-extra/file.md' must NOT match a bridge at 'notes/project'
		const bridge: MinimalBridge = {
			vaultPath: 'notes/project',
			fileManifest: { 'README.md': 'abc' },
			isDirty: false,
		};
		const checkDirty = vi.fn(() => true);

		simulateOnVaultFileModified('notes/project-extra/file.md', [bridge], checkDirty, recorder);

		expect(checkDirty).not.toHaveBeenCalled();
		expect(recorder.fileCommandBarUpdateCalls).toBe(0);
	});

	it('when isDirty flips from true to false → saveSettings and statusBar.update() called', () => {
		// E.g. after an undo that restores the file to its recorded hash
		const bridge: MinimalBridge = {
			vaultPath: 'notes/project',
			fileManifest: { 'README.md': 'abc' },
			isDirty: true,
		};
		const checkDirty = () => false; // vault is now clean

		simulateOnVaultFileModified('notes/project/README.md', [bridge], checkDirty, recorder);

		expect(bridge.isDirty).toBe(false);
		expect(recorder.fileCommandBarUpdateCalls).toBe(1);
		expect(recorder.saveSettingsCalls).toBe(1);
	});

	it('routes events to the correct bridge when multiple bridges are configured', () => {
		const bridgeA: MinimalBridge = {
			vaultPath: 'project-a',
			fileManifest: { 'file.md': 'aaa' },
			isDirty: false,
		};
		const bridgeB: MinimalBridge = {
			vaultPath: 'project-b',
			fileManifest: { 'file.md': 'bbb' },
			isDirty: false,
		};
		const checkDirty = (b: MinimalBridge) => b === bridgeA; // only A is dirty

		simulateOnVaultFileModified('project-a/file.md', [bridgeA, bridgeB], checkDirty, recorder);

		expect(bridgeA.isDirty).toBe(true);
		expect(bridgeB.isDirty).toBe(false); // untouched
		expect(recorder.fileCommandBarUpdateCalls).toBe(1);
		expect(recorder.saveSettingsCalls).toBe(1);
	});
});
