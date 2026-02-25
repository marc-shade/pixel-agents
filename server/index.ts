// Pixel Agents — Standalone server with cluster support.
// Watches Claude Code JSONL sessions across local + remote nodes.
// Serves the pixel art office UI via HTTP + WebSocket.

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';

// Import reusable modules — 'vscode' resolved to shim via esbuild alias
import { startFileWatching } from '../src/fileWatcher.js';
import { processTranscriptLine } from '../src/transcriptParser.js';
import { readLayoutFromFile, writeLayoutToFile, watchLayoutFile } from '../src/layoutPersistence.js';
import type { LayoutWatcher } from '../src/layoutPersistence.js';
import {
	loadFurnitureAssets,
	loadFloorTiles,
	loadWallTiles,
	loadCharacterSprites,
	loadDefaultLayout,
	type LoadedAssets,
	type LoadedFloorTiles,
	type LoadedWallTiles,
	type LoadedCharacterSprites,
} from '../src/assetLoader.js';
import type { AgentState } from '../src/types.js';

import { SessionScanner, loadClusterNodes, type SessionInfo } from './sessionScanner.js';
import { RemoteWatcher } from './remoteWatcher.js';

// ── Configuration ──────────────────────────────────────────────

const PORT = parseInt(process.env.PIXEL_AGENTS_PORT || '3777', 10);
const STALE_TIMEOUT_MS = 10 * 60 * 1000;
const STALE_CHECK_INTERVAL_MS = 60 * 1000;

// ── Static file server ─────────────────────────────────────────

const DIST_WEBVIEW = path.resolve(__dirname, 'webview');

const MIME_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript',
	'.mjs': 'application/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.wav': 'audio/wav',
	'.mp3': 'audio/mpeg',
};

function handleStatic(req: IncomingMessage, res: ServerResponse): void {
	const url = (req.url?.split('?')[0] || '/').replace(/\.\./g, '');
	const filePath = path.join(DIST_WEBVIEW, url === '/' ? 'index.html' : url);

	if (!filePath.startsWith(DIST_WEBVIEW)) {
		res.writeHead(403);
		res.end('Forbidden');
		return;
	}

	try {
		const content = fs.readFileSync(filePath);
		const ext = path.extname(filePath);
		res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
		res.end(content);
	} catch {
		try {
			const index = fs.readFileSync(path.join(DIST_WEBVIEW, 'index.html'));
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(index);
		} catch {
			res.writeHead(404);
			res.end('Not Found — run: npm run build:standalone');
		}
	}
}

// ── State ──────────────────────────────────────────────────────

const clients = new Set<WebSocket>();
const agents = new Map<number, AgentState>();
const agentNodeNames = new Map<number, string>();
const agentProjectNames = new Map<number, string>();

/** Node color palette for frontend badges */
const NODE_COLORS: Record<string, string> = {
	'mac-studio': '#00ffff',   // cyan (orchestrator)
	'macbook-air': '#00ff88',  // green (researcher)
	'macmini': '#ff00ff',      // magenta (developer)
	'macpro51': '#ffaa00',     // amber (builder)
};
const fileWatchers = new Map<number, fs.FSWatcher>();
const pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
const remoteWatchers = new Map<number, RemoteWatcher>();
let nextAgentId = 1;

// ── Persistence (file-based, replaces VS Code workspaceState) ──

const SETTINGS_DIR = path.join(os.homedir(), '.pixel-agents');
const SEATS_FILE = path.join(SETTINGS_DIR, 'seats.json');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

function ensureSettingsDir(): void {
	if (!fs.existsSync(SETTINGS_DIR)) {
		fs.mkdirSync(SETTINGS_DIR, { recursive: true });
	}
}

function loadSeats(): Record<string, unknown> {
	try {
		if (fs.existsSync(SEATS_FILE)) {
			return JSON.parse(fs.readFileSync(SEATS_FILE, 'utf-8'));
		}
	} catch { /* ignore */ }
	return {};
}

function saveSeats(seats: Record<string, unknown>): void {
	ensureSettingsDir();
	fs.writeFileSync(SEATS_FILE, JSON.stringify(seats, null, 2), 'utf-8');
}

function loadSettings(): { soundEnabled: boolean } {
	try {
		if (fs.existsSync(SETTINGS_FILE)) {
			return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
		}
	} catch { /* ignore */ }
	return { soundEnabled: true };
}

function saveSettings(settings: { soundEnabled: boolean }): void {
	ensureSettingsDir();
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

// ── Broadcast to all connected clients ─────────────────────────

const broadcast = {
	postMessage(msg: unknown): void {
		const data = JSON.stringify(msg);
		for (const ws of clients) {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(data);
			}
		}
	},
};

// ── Cached assets ──────────────────────────────────────────────

let cachedCharSprites: LoadedCharacterSprites | null = null;
let cachedFloorTiles: LoadedFloorTiles | null = null;
let cachedWallTiles: LoadedWallTiles | null = null;
let cachedFurniture: LoadedAssets | null = null;
let cachedDefaultLayout: Record<string, unknown> | null = null;

async function loadAllAssets(): Promise<void> {
	const candidates = [
		path.resolve(__dirname, 'webview'),
		path.resolve(__dirname),
		path.resolve(__dirname, '..'),
	];

	let assetsRoot: string | null = null;
	for (const dir of candidates) {
		if (fs.existsSync(path.join(dir, 'assets', 'characters'))) {
			assetsRoot = dir;
			break;
		}
	}

	if (!assetsRoot) {
		console.log('[pixel-agents] No assets directory found — running with built-in sprites');
		console.log('[pixel-agents] Checked:', candidates.map(d => path.join(d, 'assets')).join(', '));
		return;
	}

	console.log(`[pixel-agents] Loading assets from: ${path.join(assetsRoot, 'assets')}`);

	cachedDefaultLayout = loadDefaultLayout(assetsRoot);
	cachedCharSprites = await loadCharacterSprites(assetsRoot);
	cachedFloorTiles = await loadFloorTiles(assetsRoot);
	cachedWallTiles = await loadWallTiles(assetsRoot);
	cachedFurniture = await loadFurnitureAssets(assetsRoot);
}

function sendAllAssetsToClient(ws: WebSocket): void {
	const send = (msg: unknown) => {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(msg));
		}
	};

	if (cachedCharSprites) {
		send({ type: 'characterSpritesLoaded', characters: cachedCharSprites.characters });
	}
	if (cachedFloorTiles) {
		send({ type: 'floorTilesLoaded', sprites: cachedFloorTiles.sprites });
	}
	if (cachedWallTiles) {
		send({ type: 'wallTilesLoaded', sprites: cachedWallTiles.sprites });
	}
	if (cachedFurniture) {
		const spritesObj: Record<string, string[][]> = {};
		for (const [id, spriteData] of cachedFurniture.sprites) {
			spritesObj[id] = spriteData;
		}
		send({ type: 'furnitureAssetsLoaded', catalog: cachedFurniture.catalog, sprites: spritesObj });
	}

	// Settings (before agents/layout)
	const settings = loadSettings();
	send({ type: 'settingsLoaded', soundEnabled: settings.soundEnabled });

	// Existing agents MUST be sent BEFORE layoutLoaded — the frontend buffers
	// agents in pendingAgents, and layoutLoaded drains the buffer via os.addAgent().
	const agentIds = [...agents.keys()].sort((a, b) => a - b);
	const seats = loadSeats();

	// Build per-agent metadata for frontend (node name, project name, node color)
	const agentMetaMap: Record<number, Record<string, unknown>> = {};
	for (const id of agentIds) {
		const nodeName = agentNodeNames.get(id) || 'unknown';
		const projectName = agentProjectNames.get(id) || 'unknown';
		const seatData = (seats as Record<string, any>)[String(id)];
		agentMetaMap[id] = {
			...seatData,
			nodeName,
			projectName,
			nodeColor: NODE_COLORS[nodeName] || '#888888',
		};
	}

	send({ type: 'existingAgents', agents: agentIds, agentMeta: agentMetaMap });

	// Layout (triggers agent spawning from buffer)
	const layout = readLayoutFromFile() || cachedDefaultLayout || null;
	send({ type: 'layoutLoaded', layout });

	// Current agent statuses
	for (const [agentId, agent] of agents) {
		for (const [toolId, status] of agent.activeToolStatuses) {
			send({ type: 'agentToolStart', id: agentId, toolId, status });
		}
		if (agent.isWaiting) {
			send({ type: 'agentStatus', id: agentId, status: 'waiting' });
		}
	}
}

// ── Agent lifecycle ────────────────────────────────────────────

function createLocalAgent(session: SessionInfo): void {
	const id = nextAgentId++;
	const agent: AgentState = {
		id,
		terminalRef: null as any,
		projectDir: session.projectDir,
		jsonlFile: session.jsonlFile,
		fileOffset: 0,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: false,
		permissionSent: false,
		hadToolsInTurn: false,
	};

	// Skip to end of file — only process new events
	try {
		const stat = fs.statSync(session.jsonlFile);
		agent.fileOffset = stat.size;
	} catch { /* file might not exist yet */ }

	agents.set(id, agent);
	agentNodeNames.set(id, session.node.name);
	agentProjectNames.set(id, session.projectName);

	const nodeName = session.node.name;
	const nodeColor = NODE_COLORS[nodeName] || '#888888';
	console.log(`[pixel-agents] Agent ${id} [${nodeName}]: ${session.projectName} (local)`);
	broadcast.postMessage({ type: 'agentCreated', id, nodeName, projectName: session.projectName, nodeColor });

	startFileWatching(
		id, session.jsonlFile,
		agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
		broadcast as any,
	);
}

function createRemoteAgent(session: SessionInfo): void {
	const id = nextAgentId++;
	const agent: AgentState = {
		id,
		terminalRef: null as any,
		projectDir: session.projectDir,
		jsonlFile: session.jsonlFile,
		fileOffset: 0,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: false,
		permissionSent: false,
		hadToolsInTurn: false,
	};

	agents.set(id, agent);
	agentNodeNames.set(id, session.node.name);
	agentProjectNames.set(id, session.projectName);

	const nodeName = session.node.name;
	const nodeColor = NODE_COLORS[nodeName] || '#888888';
	console.log(`[pixel-agents] Agent ${id} [${nodeName}]: ${session.projectName} (remote)`);
	broadcast.postMessage({ type: 'agentCreated', id, nodeName, projectName: session.projectName, nodeColor });

	// Watch via SSH tail — streams JSONL lines directly to the transcript parser
	const watcher = new RemoteWatcher({
		host: session.node.host,
		filePath: session.jsonlFile,
		tailLines: 50,
		onLine: (line) => {
			processTranscriptLine(id, line, agents, waitingTimers, permissionTimers, broadcast as any);
		},
		onClose: () => {
			removeAgent(id);
		},
	});
	watcher.start();
	remoteWatchers.set(id, watcher);
}

function removeAgent(agentId: number): void {
	// Stop local file watching
	fileWatchers.get(agentId)?.close();
	fileWatchers.delete(agentId);
	const pt = pollingTimers.get(agentId);
	if (pt) clearInterval(pt);
	pollingTimers.delete(agentId);

	// Stop remote watcher
	remoteWatchers.get(agentId)?.stop();
	remoteWatchers.delete(agentId);

	// Cancel timers
	const wt = waitingTimers.get(agentId);
	if (wt) clearTimeout(wt);
	waitingTimers.delete(agentId);
	const pmt = permissionTimers.get(agentId);
	if (pmt) clearTimeout(pmt);
	permissionTimers.delete(agentId);

	agents.delete(agentId);
	agentNodeNames.delete(agentId);
	agentProjectNames.delete(agentId);

	broadcast.postMessage({ type: 'agentClosed', id: agentId });
}

// ── Stale agent cleanup ────────────────────────────────────────

function checkStaleAgents(): void {
	const now = Date.now();
	for (const [id, agent] of agents) {
		// Only check local agents — remote agents are managed by their SSH tail process
		if (remoteWatchers.has(id)) continue;

		try {
			const stat = fs.statSync(agent.jsonlFile);
			if (now - stat.mtimeMs > STALE_TIMEOUT_MS) {
				console.log(`[pixel-agents] Agent ${id}: stale (${Math.round((now - stat.mtimeMs) / 60000)}m idle)`);
				removeAgent(id);
			}
		} catch {
			removeAgent(id);
		}
	}
}

// ── Open terminal (macOS) ──────────────────────────────────────

function openClaudeTerminal(): void {
	const sessionId = crypto.randomUUID();
	const cmd = `claude --session-id ${sessionId}`;

	if (process.platform === 'darwin') {
		execFile('osascript', [
			'-e', 'tell application "Terminal"',
			'-e', 'activate',
			'-e', `do script "${cmd}"`,
			'-e', 'end tell',
		], (err) => {
			if (err) {
				console.error('[pixel-agents] Failed to open terminal:', err.message);
				console.log(`[pixel-agents] Run manually: ${cmd}`);
			}
		});
	} else {
		console.log(`[pixel-agents] Run: ${cmd}`);
	}
}

// ── Handle WebSocket messages from frontend ────────────────────

let layoutWatcher: LayoutWatcher | null = null;

function handleClientMessage(ws: WebSocket, message: Record<string, unknown>): void {
	switch (message.type) {
		case 'webviewReady':
			sendAllAssetsToClient(ws);
			break;

		case 'openClaude':
			openClaudeTerminal();
			break;

		case 'focusAgent':
			// No-op in standalone — we can't focus external terminal windows
			break;

		case 'closeAgent':
			removeAgent(message.id as number);
			break;

		case 'saveAgentSeats':
			saveSeats(message.seats as Record<string, unknown>);
			break;

		case 'saveLayout':
			layoutWatcher?.markOwnWrite();
			writeLayoutToFile(message.layout as Record<string, unknown>);
			break;

		case 'setSoundEnabled': {
			const settings = loadSettings();
			settings.soundEnabled = message.enabled as boolean;
			saveSettings(settings);
			break;
		}

		case 'openSessionsFolder': {
			const claudeDir = path.join(os.homedir(), '.claude', 'projects');
			if (process.platform === 'darwin') {
				execFile('open', [claudeDir]);
			}
			break;
		}

		case 'exportLayout': {
			const layout = readLayoutFromFile();
			if (layout) {
				const exportPath = path.join(os.homedir(), 'pixel-agents-layout.json');
				fs.writeFileSync(exportPath, JSON.stringify(layout, null, 2), 'utf-8');
				console.log(`[pixel-agents] Layout exported to: ${exportPath}`);
			}
			break;
		}

		case 'importLayout': {
			const importPath = path.join(os.homedir(), 'pixel-agents-layout.json');
			try {
				const raw = fs.readFileSync(importPath, 'utf-8');
				const imported = JSON.parse(raw) as Record<string, unknown>;
				if (imported.version === 1 && Array.isArray(imported.tiles)) {
					layoutWatcher?.markOwnWrite();
					writeLayoutToFile(imported);
					broadcast.postMessage({ type: 'layoutLoaded', layout: imported });
				}
			} catch {
				console.error('[pixel-agents] No layout file found at:', importPath);
			}
			break;
		}
	}
}

// ── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
	console.log('');
	console.log('  ████  Pixel Agents — Cluster Command Center  ████');
	console.log('');

	// Load assets
	await loadAllAssets();

	// Start layout file watcher
	layoutWatcher = watchLayoutFile((layout) => {
		console.log('[pixel-agents] External layout change detected');
		broadcast.postMessage({ type: 'layoutLoaded', layout });
	});

	// Load cluster config
	const nodes = loadClusterNodes();
	console.log(`[pixel-agents] Cluster nodes: ${nodes.map(n => `${n.name}${n.isLocal ? ' (local)' : ''}`).join(', ')}`);

	// Start session scanner
	const scanner = new SessionScanner(nodes, (session) => {
		if (session.node.isLocal) {
			createLocalAgent(session);
		} else {
			createRemoteAgent(session);
		}
	});
	scanner.start();

	// Start stale agent cleanup
	setInterval(checkStaleAgents, STALE_CHECK_INTERVAL_MS);

	// Create HTTP + WebSocket server
	const server = createServer(handleStatic);
	const wss = new WebSocketServer({ server, path: '/ws' });

	wss.on('connection', (ws) => {
		clients.add(ws);
		console.log(`[pixel-agents] Client connected (${clients.size} total)`);

		ws.on('message', (data) => {
			try {
				const msg = JSON.parse(data.toString());
				handleClientMessage(ws, msg);
			} catch (err) {
				console.error('[pixel-agents] Invalid message:', err);
			}
		});

		ws.on('close', () => {
			clients.delete(ws);
			console.log(`[pixel-agents] Client disconnected (${clients.size} total)`);
		});
	});

	server.listen(PORT, '127.0.0.1', () => {
		console.log(`[pixel-agents] Server: http://127.0.0.1:${PORT}`);
		console.log(`[pixel-agents] Watching for Claude Code sessions...`);
		console.log('');

		// Auto-open browser
		if (process.platform === 'darwin' && !process.env.NO_OPEN) {
			execFile('open', [`http://127.0.0.1:${PORT}`]);
		}
	});

	// Graceful shutdown
	const shutdown = () => {
		console.log('\n[pixel-agents] Shutting down...');
		scanner.stop();
		layoutWatcher?.dispose();
		for (const id of [...agents.keys()]) {
			removeAgent(id);
		}
		wss.close();
		server.close();
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

main().catch((err) => {
	console.error('[pixel-agents] Fatal error:', err);
	process.exit(1);
});
