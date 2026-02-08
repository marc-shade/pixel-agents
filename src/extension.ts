import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CLAUDE_TERMINAL_PATTERN = /^Claude Code #(\d+)$/;

interface FolderInfo {
	id: string;
	name: string;
	path: string;
}

interface AgentFolderMapping {
	agentId: number;
	folderId: string;
}

interface PersistedAgentState {
	sessionId: string;
	projectDir: string;
	folderId: string;
	lastFile?: string;  // last known JSONL path for reclaiming after reload
}

class ArcadiaViewProvider implements vscode.WebviewViewProvider {
	private nextId = 1;
	private terminals = new Map<number, vscode.Terminal>();
	private webviewView: vscode.WebviewView | undefined;
	private folders: FolderInfo[] = [];
	private agentFolders = new Map<number, string>(); // agentId → folderId
	private movingAgents = new Set<number>(); // agents currently being moved (suppress close event)

	// Transcript watching state
	private agentSessionIds = new Map<number, string>();     // agentId → session UUID (--session-id)
	private watchedFiles = new Map<number, string>();        // agentId → current JSONL path
	private agentProjectDirs = new Map<number, string>();    // agentId → project dir path
	private claimedFiles = new Set<string>();                // JSONL paths claimed by any agent
	private knownFilesAtLaunch = new Map<number, Set<string>>(); // agentId → pre-existing files
	private dirScanTimers = new Map<number, ReturnType<typeof setInterval>>();
	private lastDataTime = new Map<number, number>();        // agentId → Date.now() of last data
	private fileWatchers = new Map<number, fs.FSWatcher>();
	private pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
	private fileOffsets = new Map<number, number>();
	private lineBuffers = new Map<number, string>();
	private activeToolIds = new Map<number, Set<string>>();
	private waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();

	// Cached status for webview reconnect
	private activeToolStatuses = new Map<number, Map<string, string>>(); // agentId → (toolId → status)
	private agentWaitingStatus = new Map<number, boolean>();             // agentId → is waiting

	constructor(private readonly context: vscode.ExtensionContext) {}

	private get extensionUri(): vscode.Uri {
		return this.context.extensionUri;
	}

	resolveWebviewView(webviewView: vscode.WebviewView) {
		this.webviewView = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = getWebviewContent(webviewView.webview, this.extensionUri);

		// Adopt any existing Claude Code terminals
		this.adoptExistingTerminals();

		// Ensure a default folder exists
		this.ensureDefaultFolder();

		webviewView.webview.onDidReceiveMessage((message) => {
			if (message.type === 'openClaude') {
				const folderId = message.folderId as string | undefined;
				const folderPath = message.folderPath as string | undefined;
				const id = this.nextId++;
				const terminal = this.createClaudeTerminal(id, folderPath);
				terminal.show();
				this.terminals.set(id, terminal);
				const assignedFolderId = folderId || (this.folders.length > 0 ? this.folders[0].id : '');
				this.agentFolders.set(id, assignedFolderId);
				webviewView.webview.postMessage({ type: 'agentCreated', id, folderId: assignedFolderId });

				// Persist state for recovery after extension reload
				const sessionId = this.agentSessionIds.get(id);
				const projectDir = this.agentProjectDirs.get(id);
				if (sessionId && projectDir) {
					this.persistAgentState(id, { sessionId, projectDir, folderId: assignedFolderId });
				}
			} else if (message.type === 'focusAgent') {
				const terminal = this.terminals.get(message.id);
				if (terminal) {
					terminal.show();
				}
			} else if (message.type === 'closeAgent') {
				const terminal = this.terminals.get(message.id);
				if (terminal) {
					terminal.dispose();
				}
			} else if (message.type === 'webviewReady') {
				this.sendExistingAgents();
			} else if (message.type === 'addFolder') {
				this.handleAddFolder();
			} else if (message.type === 'moveAgent') {
				this.handleMoveAgent(
					message.agentId as number,
					message.targetFolderId as string,
					message.targetPath as string,
					message.keepAccess as boolean,
					message.sourcePath as string | undefined,
					message.continueConversation as boolean,
				);
			}
		});

		// Clean up buttons when terminals are closed (skip agents being moved)
		vscode.window.onDidCloseTerminal((closed) => {
			for (const [id, terminal] of this.terminals) {
				if (terminal === closed) {
					if (this.movingAgents.has(id)) { break; }
					this.stopWatching(id);
					this.terminals.delete(id);
					this.agentFolders.delete(id);
					webviewView.webview.postMessage({ type: 'agentClosed', id });
					break;
				}
			}
		});

		// Detect Claude Code terminals opened outside the extension
		vscode.window.onDidOpenTerminal((terminal) => {
			const match = terminal.name.match(CLAUDE_TERMINAL_PATTERN);
			if (match && !this.isTracked(terminal)) {
				const id = parseInt(match[1], 10);
				this.terminals.set(id, terminal);
				if (id >= this.nextId) {
					this.nextId = id + 1;
				}
				const folderId = this.folders.length > 0 ? this.folders[0].id : '';
				this.agentFolders.set(id, folderId);
				webviewView.webview.postMessage({ type: 'agentCreated', id, folderId });
				this.startWatchingAgent(id);
			}
		});
	}

	private ensureDefaultFolder() {
		if (this.folders.length === 0) {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (workspaceFolders && workspaceFolders.length > 0) {
				const wsPath = workspaceFolders[0].uri.fsPath;
				this.folders.push({
					id: 'default',
					name: path.basename(wsPath),
					path: wsPath,
				});
			}
		}
	}

	private async handleAddFolder() {
		const uris = await vscode.window.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			openLabel: 'Select Folder',
		});
		if (uris && uris.length > 0) {
			const folderPath = uris[0].fsPath;
			const folder: FolderInfo = {
				id: crypto.randomUUID(),
				name: path.basename(folderPath),
				path: folderPath,
			};
			this.folders.push(folder);
			this.webviewView?.webview.postMessage({
				type: 'folderAdded',
				id: folder.id,
				name: folder.name,
				path: folder.path,
			});
		}
	}

	private handleMoveAgent(
		agentId: number,
		targetFolderId: string,
		targetPath: string,
		keepAccess: boolean,
		sourcePath: string | undefined,
		continueConversation: boolean,
	) {
		const oldTerminal = this.terminals.get(agentId);
		if (!oldTerminal) { return; }

		// Claude Code cannot change its primary cwd mid-session, and
		// terminal.sendText() cannot submit commands to Ink's raw-mode stdin.
		// Instead, dispose the terminal and restart in the new directory.
		this.movingAgents.add(agentId);
		this.stopWatching(agentId);
		oldTerminal.dispose();

		const addDirs = keepAccess && sourcePath ? [sourcePath] : undefined;
		const newTerminal = this.createClaudeTerminal(agentId, targetPath, addDirs, continueConversation);
		newTerminal.show();
		this.terminals.set(agentId, newTerminal);
		this.agentFolders.set(agentId, targetFolderId);
		this.movingAgents.delete(agentId);

		this.webviewView?.webview.postMessage({
			type: 'agentMoved',
			agentId,
			targetFolderId,
		});

		// Persist updated state after move
		const sessionId = this.agentSessionIds.get(agentId);
		const projectDir = this.agentProjectDirs.get(agentId);
		if (sessionId && projectDir) {
			this.persistAgentState(agentId, { sessionId, projectDir, folderId: targetFolderId });
		}
	}

	private createClaudeTerminal(id: number, cwd?: string, addDirs?: string[], continueSession = false): vscode.Terminal {
		const terminal = vscode.window.createTerminal({
			name: `Claude Code #${id}`,
			cwd,
		});

		// Use --session-id with a fresh UUID so the JSONL filename is predictable.
		// Skip when --continue is used (it resumes the last session's own ID).
		const sessionId = continueSession ? undefined : crypto.randomUUID();
		if (sessionId) {
			this.agentSessionIds.set(id, sessionId);
		}

		const parts = ['claude'];
		if (sessionId) {
			parts.push('--session-id', sessionId);
		}
		if (addDirs) {
			for (const dir of addDirs) {
				parts.push(`--add-dir "${dir}"`);
			}
		}
		if (continueSession) {
			parts.push('--continue');
		}
		terminal.sendText(parts.join(' '));
		this.startWatchingAgent(id, cwd);
		return terminal;
	}

	private adoptExistingTerminals() {
		const saved = this.getPersistedStates();
		const adoptedIds = new Set<string>();

		for (const terminal of vscode.window.terminals) {
			const match = terminal.name.match(CLAUDE_TERMINAL_PATTERN);
			if (match) {
				const id = parseInt(match[1], 10);
				this.terminals.set(id, terminal);
				if (id >= this.nextId) {
					this.nextId = id + 1;
				}

				const key = String(id);
				const persisted = saved[key];
				if (persisted) {
					adoptedIds.add(key);
					this.agentSessionIds.set(id, persisted.sessionId);
					this.agentFolders.set(id, persisted.folderId);
					this.startWatchingAdoptedAgent(id, persisted);
				} else {
					// No persisted state — assign default folder and do generic scanning
					const folderId = this.folders.length > 0 ? this.folders[0].id : 'default';
					this.agentFolders.set(id, folderId);
					this.startWatchingAgent(id);
				}
			}
		}

		// Clean up persisted entries for terminals that no longer exist
		const states = this.getPersistedStates();
		let cleaned = false;
		for (const key of Object.keys(states)) {
			if (!adoptedIds.has(key) && !this.terminals.has(parseInt(key, 10))) {
				delete states[key];
				cleaned = true;
			}
		}
		if (cleaned) {
			this.context.workspaceState.update('arcadia.agentStates', states);
		}
	}

	private startWatchingAdoptedAgent(agentId: number, saved: PersistedAgentState) {
		const projectDir = saved.projectDir;
		if (!fs.existsSync(projectDir)) {
			console.log(`[Arcadia] Adopted agent ${agentId}: project dir gone, falling back to generic`);
			this.startWatchingAgent(agentId);
			return;
		}
		this.agentProjectDirs.set(agentId, projectDir);

		// Snapshot existing files, but EXCLUDE the agent's own session file and lastFile
		// so Phase 1 / Phase 2 can immediately reclaim them
		const existing = new Set<string>();
		try {
			for (const f of fs.readdirSync(projectDir)) {
				if (f.endsWith('.jsonl')) {
					existing.add(path.join(projectDir, f));
				}
			}
		} catch { /* dir may not exist yet */ }

		// Remove the agent's own files from the exclusion set so they can be claimed
		const sessionFile = path.join(projectDir, `${saved.sessionId}.jsonl`);
		existing.delete(sessionFile);
		if (saved.lastFile) {
			existing.delete(saved.lastFile);
		}

		this.knownFilesAtLaunch.set(agentId, existing);
		console.log(`[Arcadia] Adopted agent ${agentId}: watching dir ${projectDir} (session=${saved.sessionId}, ${existing.size} excluded files)`);

		const scanInterval = setInterval(() => this.scanForNewFile(agentId), 1000);
		this.dirScanTimers.set(agentId, scanInterval);
	}

	private sendExistingAgents() {
		if (!this.webviewView) { return; }
		const agents: AgentFolderMapping[] = [];
		for (const [agentId, folderId] of this.agentFolders) {
			agents.push({ agentId, folderId });
		}
		agents.sort((a, b) => a.agentId - b.agentId);
		this.webviewView.webview.postMessage({
			type: 'existingAgents',
			agents,
			folders: this.folders,
		});

		// Re-send cached tool/status state for webview reconnect
		this.sendCurrentAgentStatuses();
	}

	private sendCurrentAgentStatuses() {
		if (!this.webviewView) { return; }
		for (const [agentId] of this.terminals) {
			// Re-send active tools
			const tools = this.activeToolStatuses.get(agentId);
			if (tools) {
				for (const [toolId, status] of tools) {
					this.webviewView.webview.postMessage({
						type: 'agentToolStart',
						id: agentId,
						toolId,
						status,
					});
				}
			}
			// Re-send waiting status
			if (this.agentWaitingStatus.get(agentId)) {
				this.webviewView.webview.postMessage({
					type: 'agentStatus',
					id: agentId,
					status: 'waiting',
				});
			}
		}
	}

	private isTracked(terminal: vscode.Terminal): boolean {
		for (const t of this.terminals.values()) {
			if (t === terminal) { return true; }
		}
		return false;
	}

	// --- Persisted agent state ---

	private getPersistedStates(): Record<string, PersistedAgentState> {
		return this.context.workspaceState.get('arcadia.agentStates', {});
	}

	private persistAgentState(agentId: number, state: PersistedAgentState) {
		const states = this.getPersistedStates();
		states[String(agentId)] = state;
		this.context.workspaceState.update('arcadia.agentStates', states);
	}

	private removePersistedState(agentId: number) {
		const states = this.getPersistedStates();
		delete states[String(agentId)];
		this.context.workspaceState.update('arcadia.agentStates', states);
	}

	private updatePersistedFile(agentId: number, filePath: string) {
		const states = this.getPersistedStates();
		const key = String(agentId);
		if (states[key]) {
			states[key].lastFile = filePath;
			this.context.workspaceState.update('arcadia.agentStates', states);
		}
	}

	// --- Transcript JSONL watching ---

	private getProjectDirPath(cwd?: string): string | null {
		const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspacePath) { return null; }
		// C:\Users\Dev\Desktop\Arcadia → C--Users-Dev-Desktop-Arcadia
		const dirName = workspacePath.replace(/[:\\/]/g, '-');
		return path.join(os.homedir(), '.claude', 'projects', dirName);
	}

	private startWatchingAgent(agentId: number, cwd?: string) {
		const projectDir = this.getProjectDirPath(cwd);
		if (!projectDir) {
			console.log(`[Arcadia] No project dir for agent ${agentId}, cwd=${cwd}`);
			return;
		}
		this.agentProjectDirs.set(agentId, projectDir);

		// Snapshot existing .jsonl files so we don't claim old ones
		const existing = new Set<string>();
		try {
			if (fs.existsSync(projectDir)) {
				for (const f of fs.readdirSync(projectDir)) {
					if (f.endsWith('.jsonl')) {
						existing.add(path.join(projectDir, f));
					}
				}
			}
		} catch { /* dir may not exist yet */ }
		this.knownFilesAtLaunch.set(agentId, existing);
		console.log(`[Arcadia] Agent ${agentId}: watching dir ${projectDir} (${existing.size} existing files)`);

		// Poll directory for new .jsonl files every second
		const scanInterval = setInterval(() => this.scanForNewFile(agentId), 1000);
		this.dirScanTimers.set(agentId, scanInterval);
	}

	private scanForNewFile(agentId: number) {
		const projectDir = this.agentProjectDirs.get(agentId);
		if (!projectDir) { return; }

		const currentFile = this.watchedFiles.get(agentId);

		// Phase 1: Session-ID lookup (deterministic — no race conditions)
		const sessionId = this.agentSessionIds.get(agentId);
		if (sessionId) {
			if (!currentFile) {
				// Still looking for initial session file — try deterministic lookup
				const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
				try {
					if (fs.existsSync(expectedFile)) {
						console.log(`[Arcadia] Agent ${agentId}: found session file ${sessionId}.jsonl`);
						this.claimFile(agentId, expectedFile);
					}
				} catch { /* file may not exist yet */ }
				// Don't do generic scan while waiting for session file to appear
				return;
			}
			// Already watching session file — check staleness before allowing /clear detection
			const lastData = this.lastDataTime.get(agentId) || 0;
			const staleness = Date.now() - lastData;
			if (staleness <= 3000) {
				return;  // file is active, no need to scan
			}
			// File is stale >3s — fall through to Phase 2 to detect /clear file switch
		}

		// Phase 2: Generic scanning (for /clear file switches and adopted terminals)
		let files: string[];
		try {
			files = fs.readdirSync(projectDir)
				.filter(f => f.endsWith('.jsonl'))
				.map(f => path.join(projectDir, f));
		} catch { return; }

		const known = this.knownFilesAtLaunch.get(agentId) || new Set();
		const unclaimed = files.filter(f => !known.has(f) && !this.claimedFiles.has(f));
		if (unclaimed.length === 0) { return; }

		// Sort by mtime descending (newest first)
		unclaimed.sort((a, b) => {
			try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; }
			catch { return 0; }
		});
		const candidate = unclaimed[0];

		if (!currentFile) {
			// Adopted terminal with no session ID — claim the newest unclaimed file
			console.log(`[Arcadia] Agent ${agentId}: claiming ${path.basename(candidate)} (adopted, no session ID)`);
			this.claimFile(agentId, candidate);
		} else {
			// /clear file switching — only if current file is stale
			const lastData = this.lastDataTime.get(agentId) || 0;
			const staleness = Date.now() - lastData;
			if (staleness <= 3000) { return; }

			// Check for competing stale agents in the same project dir.
			// Only the most-recently-active agent gets priority (more likely to have just /clear'd).
			for (const [otherId, otherDir] of this.agentProjectDirs) {
				if (otherId === agentId || otherDir !== projectDir) { continue; }
				if (!this.watchedFiles.has(otherId)) { continue; }
				const otherLastData = this.lastDataTime.get(otherId) || 0;
				const otherStaleness = Date.now() - otherLastData;
				if (otherStaleness > 3000 && otherLastData > lastData) {
					console.log(`[Arcadia] Agent ${agentId}: skipping switch, agent ${otherId} has priority`);
					return;
				}
			}

			console.log(`[Arcadia] Agent ${agentId}: switching to ${path.basename(candidate)} (stale ${Math.round(staleness / 1000)}s)`);
			this.switchFile(agentId, candidate);
		}
	}

	private claimFile(agentId: number, filePath: string) {
		this.watchedFiles.set(agentId, filePath);
		this.claimedFiles.add(filePath);
		this.fileOffsets.set(agentId, 0);
		this.lineBuffers.set(agentId, '');
		this.lastDataTime.set(agentId, Date.now());
		console.log(`[Arcadia] Agent ${agentId}: watching file ${path.basename(filePath)}`);

		// Primary: fs.watch for instant response
		try {
			const watcher = fs.watch(filePath, () => {
				this.readNewLines(agentId, filePath);
			});
			this.fileWatchers.set(agentId, watcher);
		} catch (e) {
			console.log(`[Arcadia] fs.watch failed for agent ${agentId}: ${e}`);
		}

		// Backup: poll every 2s (fs.watch is unreliable on Windows)
		const interval = setInterval(() => {
			if (!this.watchedFiles.has(agentId)) { clearInterval(interval); return; }
			this.readNewLines(agentId, filePath);
		}, 2000);
		this.pollingTimers.set(agentId, interval);

		// Initial read
		this.readNewLines(agentId, filePath);

		// Persist the current file path for recovery after reload
		this.updatePersistedFile(agentId, filePath);
	}

	private switchFile(agentId: number, newFilePath: string) {
		const oldFile = this.watchedFiles.get(agentId);

		// Stop watching old file
		this.fileWatchers.get(agentId)?.close();
		this.fileWatchers.delete(agentId);
		const pt = this.pollingTimers.get(agentId);
		if (pt) { clearInterval(pt); }
		this.pollingTimers.delete(agentId);

		// Unclaim old file and mark as known so we don't reclaim it
		if (oldFile) {
			this.claimedFiles.delete(oldFile);
			this.knownFilesAtLaunch.get(agentId)?.add(oldFile);
		}

		// Clear tool state
		this.cancelWaitingTimer(agentId);
		this.activeToolIds.delete(agentId);
		this.activeToolStatuses.delete(agentId);
		this.agentWaitingStatus.delete(agentId);
		this.webviewView?.webview.postMessage({ type: 'agentToolsClear', id: agentId });

		// Claim new file
		this.claimFile(agentId, newFilePath);
	}

	private readNewLines(agentId: number, filePath: string) {
		try {
			const stat = fs.statSync(filePath);
			const offset = this.fileOffsets.get(agentId) || 0;
			if (stat.size <= offset) { return; }

			const buf = Buffer.alloc(stat.size - offset);
			const fd = fs.openSync(filePath, 'r');
			fs.readSync(fd, buf, 0, buf.length, offset);
			fs.closeSync(fd);
			this.fileOffsets.set(agentId, stat.size);
			this.lastDataTime.set(agentId, Date.now());

			// Prepend any leftover partial line from the previous read
			const text = (this.lineBuffers.get(agentId) || '') + buf.toString('utf-8');
			const lines = text.split('\n');
			// Last element may be an incomplete line — save it for next read
			this.lineBuffers.set(agentId, lines.pop() || '');

			for (const line of lines) {
				if (!line.trim()) { continue; }
				this.processTranscriptLine(agentId, line);
			}
		} catch (e) {
			console.log(`[Arcadia] Read error for agent ${agentId}: ${e}`);
		}
	}

	private clearAgentActivity(agentId: number) {
		this.activeToolIds.delete(agentId);
		this.activeToolStatuses.delete(agentId);
		this.agentWaitingStatus.delete(agentId);
		this.webviewView?.webview.postMessage({ type: 'agentToolsClear', id: agentId });
		this.webviewView?.webview.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
	}

	private cancelWaitingTimer(agentId: number) {
		const timer = this.waitingTimers.get(agentId);
		if (timer) {
			clearTimeout(timer);
			this.waitingTimers.delete(agentId);
		}
	}

	private startWaitingTimer(agentId: number, delayMs: number) {
		this.cancelWaitingTimer(agentId);
		const timer = setTimeout(() => {
			this.waitingTimers.delete(agentId);
			this.agentWaitingStatus.set(agentId, true);
			this.webviewView?.webview.postMessage({
				type: 'agentStatus',
				id: agentId,
				status: 'waiting',
			});
		}, delayMs);
		this.waitingTimers.set(agentId, timer);
	}

	private processTranscriptLine(agentId: number, line: string) {
		try {
			const record = JSON.parse(line);

			if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
				const blocks = record.message.content as Array<{
					type: string; id?: string; name?: string; input?: Record<string, unknown>;
				}>;
				const hasToolUse = blocks.some(b => b.type === 'tool_use');

				if (hasToolUse) {
					// Agent is actively working — cancel any pending waiting timer
					this.cancelWaitingTimer(agentId);
					this.agentWaitingStatus.delete(agentId);
					this.webviewView?.webview.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
					for (const block of blocks) {
						if (block.type === 'tool_use' && block.id) {
							const status = this.formatToolStatus(block.name || '', block.input || {});
							console.log(`[Arcadia] Agent ${agentId} tool start: ${block.id} ${status}`);
							let active = this.activeToolIds.get(agentId);
							if (!active) { active = new Set(); this.activeToolIds.set(agentId, active); }
							active.add(block.id);
							// Cache for webview reconnect
							let cached = this.activeToolStatuses.get(agentId);
							if (!cached) { cached = new Map(); this.activeToolStatuses.set(agentId, cached); }
							cached.set(block.id, status);
							this.webviewView?.webview.postMessage({
								type: 'agentToolStart',
								id: agentId,
								toolId: block.id,
								status,
							});
						}
					}
				} else {
					// Text-only or thinking-only assistant record.
					// Text-only records are often intermediate (followed by tool_use),
					// so debounce before declaring "waiting". The system/turn_duration
					// record will provide an immediate signal if the turn truly ended.
					const hasText = blocks.some(b => b.type === 'text');
					if (hasText) {
						this.startWaitingTimer(agentId, 2000);
					}
					// thinking-only records: ignore (no status change)
				}
			} else if (record.type === 'user') {
				const content = record.message?.content;
				if (Array.isArray(content)) {
					const blocks = content as Array<{ type: string; tool_use_id?: string }>;
					const hasToolResult = blocks.some(b => b.type === 'tool_result');
					if (hasToolResult) {
						for (const block of blocks) {
							if (block.type === 'tool_result' && block.tool_use_id) {
								console.log(`[Arcadia] Agent ${agentId} tool done: ${block.tool_use_id}`);
								this.activeToolIds.get(agentId)?.delete(block.tool_use_id);
								this.activeToolStatuses.get(agentId)?.delete(block.tool_use_id);
								const toolId = block.tool_use_id;
								setTimeout(() => {
									this.webviewView?.webview.postMessage({
										type: 'agentToolDone',
										id: agentId,
										toolId,
									});
								}, 300);
							}
						}
					} else {
						// Array content but no tool_result → new user prompt
						this.cancelWaitingTimer(agentId);
						this.clearAgentActivity(agentId);
					}
				} else if (typeof content === 'string' && content.trim()) {
					// String content → new user prompt (clear tools + waiting status)
					this.cancelWaitingTimer(agentId);
					this.clearAgentActivity(agentId);
				}
			} else if (record.type === 'system' && record.subtype === 'turn_duration') {
				// Turn complete — agent is waiting for user input.
				// This is the reliable signal; cancel any debounce timer and set immediately.
				this.cancelWaitingTimer(agentId);
				this.agentWaitingStatus.set(agentId, true);
				this.webviewView?.webview.postMessage({
					type: 'agentStatus',
					id: agentId,
					status: 'waiting',
				});
			}
		} catch {
			// Ignore malformed lines
		}
	}

	private formatToolStatus(toolName: string, input: Record<string, unknown>): string {
		const base = (p: unknown) => typeof p === 'string' ? path.basename(p) : '';
		switch (toolName) {
			case 'Read': return `Reading ${base(input.file_path)}`;
			case 'Edit': return `Editing ${base(input.file_path)}`;
			case 'Write': return `Writing ${base(input.file_path)}`;
			case 'Bash': {
				const cmd = (input.command as string) || '';
				return `Running: ${cmd.length > 30 ? cmd.slice(0, 30) + '\u2026' : cmd}`;
			}
			case 'Glob': return 'Searching files';
			case 'Grep': return 'Searching code';
			case 'WebFetch': return 'Fetching web content';
			case 'WebSearch': return 'Searching the web';
			case 'Task': return 'Running subtask';
			case 'AskUserQuestion': return 'Waiting for your answer';
			case 'EnterPlanMode': return 'Planning';
			case 'NotebookEdit': return `Editing notebook`;
			default: return `Using ${toolName}`;
		}
	}

	private stopWatching(agentId: number) {
		// Stop directory scanning
		const ds = this.dirScanTimers.get(agentId);
		if (ds) { clearInterval(ds); }
		this.dirScanTimers.delete(agentId);

		// Stop file watching
		this.fileWatchers.get(agentId)?.close();
		this.fileWatchers.delete(agentId);
		const pt = this.pollingTimers.get(agentId);
		if (pt) { clearInterval(pt); }
		this.pollingTimers.delete(agentId);

		// Unclaim file
		const file = this.watchedFiles.get(agentId);
		if (file) { this.claimedFiles.delete(file); }
		this.watchedFiles.delete(agentId);

		// Clean up remaining state
		this.cancelWaitingTimer(agentId);
		this.agentProjectDirs.delete(agentId);
		this.agentSessionIds.delete(agentId);
		this.knownFilesAtLaunch.delete(agentId);
		this.lastDataTime.delete(agentId);
		this.activeToolIds.delete(agentId);
		this.activeToolStatuses.delete(agentId);
		this.agentWaitingStatus.delete(agentId);
		this.fileOffsets.delete(agentId);
		this.lineBuffers.delete(agentId);

		// Remove persisted state so it's not restored after reload
		// (but not during dispose — we need state for recovery)
		if (!this.disposing) {
			this.removePersistedState(agentId);
		}
	}

	dispose() {
		// Stop watchers but DON'T clear persisted state — it's needed for recovery after reload.
		// stopWatching() calls removePersistedState(), so we temporarily bypass it.
		this.disposing = true;
		for (const id of [...this.agentProjectDirs.keys()]) {
			this.stopWatching(id);
		}
		this.disposing = false;
	}

	private disposing = false;
}

let providerInstance: ArcadiaViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
	const provider = new ArcadiaViewProvider(context);
	providerInstance = provider;

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('arcadia.panelView', provider)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('arcadia.showPanel', () => {
			vscode.commands.executeCommand('arcadia.panelView.focus');
		})
	);
}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const distPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
	const indexPath = vscode.Uri.joinPath(distPath, 'index.html').fsPath;

	let html = fs.readFileSync(indexPath, 'utf-8');

	// Rewrite asset paths to use webview URIs
	html = html.replace(/(href|src)="\.\/([^"]+)"/g, (_match, attr, filePath) => {
		const fileUri = vscode.Uri.joinPath(distPath, filePath);
		const webviewUri = webview.asWebviewUri(fileUri);
		return `${attr}="${webviewUri}"`;
	});

	return html;
}

export function deactivate() {
	providerInstance?.dispose();
}
