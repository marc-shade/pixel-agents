// Minimal shim for 'vscode' module — satisfies runtime imports from src/ modules.
// TypeScript types are stripped at build time; this provides runtime stubs.

export const window = {
	activeTerminal: null as any,
	terminals: [] as any[],
	createTerminal: () => ({ show() {}, sendText() {}, dispose() {}, name: '' }),
	onDidChangeActiveTerminal: () => ({ dispose() {} }),
	onDidCloseTerminal: () => ({ dispose() {} }),
	showWarningMessage: (...args: any[]) => console.warn('[pixel-agents]', ...args),
	showInformationMessage: (...args: any[]) => console.log('[pixel-agents]', ...args),
	showErrorMessage: (...args: any[]) => console.error('[pixel-agents]', ...args),
	showSaveDialog: async () => null,
	showOpenDialog: async () => null,
};

export const workspace = {
	workspaceFolders: null as any,
};

export const env = {
	openExternal: () => Promise.resolve(true),
};

import * as nodePath from 'path';

export class Uri {
	fsPath: string;
	constructor(p: string) { this.fsPath = p; }
	static file(p: string) { return new Uri(p); }
	static joinPath(base: Uri, ...parts: string[]) {
		return new Uri(nodePath.join(base.fsPath, ...parts));
	}
}
