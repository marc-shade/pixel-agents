// Session scanner — discovers active Claude Code JSONL sessions.
// Supports local filesystem and remote cluster nodes via SSH.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';

export interface ClusterNode {
	name: string;
	host: string;
	isLocal: boolean;
}

export interface SessionInfo {
	node: ClusterNode;
	projectDir: string;
	jsonlFile: string;
	projectName: string;
}

const SETTINGS_DIR = path.join(os.homedir(), '.pixel-agents');
const CLUSTER_FILE = path.join(SETTINGS_DIR, 'cluster.json');

export function loadClusterNodes(): ClusterNode[] {
	// Try loading from config file
	try {
		if (fs.existsSync(CLUSTER_FILE)) {
			const config = JSON.parse(fs.readFileSync(CLUSTER_FILE, 'utf-8'));
			if (Array.isArray(config.nodes) && config.nodes.length > 0) {
				return config.nodes.map((n: any) => ({
					name: n.name || n.host,
					host: n.host,
					isLocal: n.host === 'localhost' || n.host === '127.0.0.1' || n.isLocal === true,
				}));
			}
		}
	} catch { /* ignore */ }

	// Default: localhost only
	const hostname = os.hostname().replace(/\.local$/, '');
	return [{ name: hostname, host: 'localhost', isLocal: true }];
}

export class SessionScanner {
	private knownFiles = new Set<string>();
	private scanTimer: ReturnType<typeof setInterval> | null = null;
	private initialScanDone = false;

	constructor(
		private nodes: ClusterNode[],
		private onNewSession: (session: SessionInfo) => void,
		private scanIntervalMs = 3000,
		private activeThresholdMin = 10,
	) {}

	start(): void {
		this.scan();
		this.scanTimer = setInterval(() => this.scan(), this.scanIntervalMs);
	}

	stop(): void {
		if (this.scanTimer) {
			clearInterval(this.scanTimer);
			this.scanTimer = null;
		}
	}

	markKnown(node: string, file: string): void {
		this.knownFiles.add(`${node}:${file}`);
	}

	private scan(): void {
		for (const node of this.nodes) {
			if (node.isLocal) {
				this.scanLocal(node);
			} else {
				this.scanRemote(node);
			}
		}
		this.initialScanDone = true;
	}

	private scanLocal(node: ClusterNode): void {
		const claudeDir = path.join(os.homedir(), '.claude', 'projects');
		let projectDirs: string[];
		try {
			projectDirs = fs.readdirSync(claudeDir, { withFileTypes: true })
				.filter(d => d.isDirectory())
				.map(d => path.join(claudeDir, d.name));
		} catch { return; }

		for (const projectDir of projectDirs) {
			let files: string[];
			try {
				files = fs.readdirSync(projectDir)
					.filter(f => f.endsWith('.jsonl'))
					.map(f => path.join(projectDir, f));
			} catch { continue; }

			for (const file of files) {
				const key = `${node.name}:${file}`;
				if (this.knownFiles.has(key)) continue;
				this.knownFiles.add(key);

				// On initial scan, only pick up recently active sessions
				if (!this.initialScanDone) {
					try {
						const stat = fs.statSync(file);
						if (Date.now() - stat.mtimeMs > this.activeThresholdMin * 60 * 1000) continue;
					} catch { continue; }
				}

				const dirName = path.basename(projectDir);
				const projectName = dirName.replace(/^-/, '/').replace(/-/g, '/');

				this.onNewSession({ node, projectDir, jsonlFile: file, projectName });
			}
		}
	}

	private scanRemote(node: ClusterNode): void {
		execFile('ssh', [
			'-o', 'BatchMode=yes',
			'-o', 'ConnectTimeout=3',
			'-o', 'StrictHostKeyChecking=no',
			node.host,
			`find ~/.claude/projects -name "*.jsonl" -mmin -${this.activeThresholdMin} 2>/dev/null`,
		], { timeout: 10000 }, (err, stdout) => {
			if (err) return; // Node unreachable — skip silently

			const files = stdout.trim().split('\n').filter(Boolean);
			for (const file of files) {
				const key = `${node.name}:${file}`;
				if (this.knownFiles.has(key)) continue;
				this.knownFiles.add(key);

				// Extract project dir and name from path
				const match = file.match(/\.claude\/projects\/([^/]+)\//);
				const dirName = match ? match[1] : 'unknown';
				const projectDir = match
					? file.substring(0, file.indexOf(dirName) + dirName.length)
					: path.dirname(file);
				const projectName = dirName.replace(/^-/, '/').replace(/-/g, '/');

				this.onNewSession({ node, projectDir, jsonlFile: file, projectName });
			}
		});
	}
}
