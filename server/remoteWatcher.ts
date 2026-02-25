// SSH-based file watcher for remote cluster nodes.
// Uses `ssh host "tail -f"` to stream JSONL lines in real time.

import { spawn, type ChildProcess } from 'child_process';

export interface RemoteWatcherOptions {
	host: string;
	filePath: string;
	onLine: (line: string) => void;
	onClose: () => void;
	tailLines?: number;
}

export class RemoteWatcher {
	private proc: ChildProcess | null = null;
	private lineBuffer = '';
	private stopped = false;

	constructor(private options: RemoteWatcherOptions) {}

	start(): void {
		const { host, filePath, tailLines = 0 } = this.options;
		const tailArg = tailLines > 0 ? `-n ${tailLines}` : '-n 0';

		this.proc = spawn('ssh', [
			'-o', 'BatchMode=yes',
			'-o', 'ConnectTimeout=5',
			'-o', 'ServerAliveInterval=30',
			'-o', 'StrictHostKeyChecking=no',
			host,
			`tail -f ${tailArg} "${filePath}" 2>/dev/null`,
		]);

		this.proc.stdout?.on('data', (chunk: Buffer) => {
			this.lineBuffer += chunk.toString('utf-8');
			const lines = this.lineBuffer.split('\n');
			this.lineBuffer = lines.pop() || '';
			for (const line of lines) {
				if (line.trim()) this.options.onLine(line);
			}
		});

		this.proc.stderr?.on('data', (chunk: Buffer) => {
			const msg = chunk.toString('utf-8').trim();
			if (msg && !msg.includes('Warning:')) {
				console.error(`[pixel-agents] SSH ${this.options.host}: ${msg}`);
			}
		});

		this.proc.on('close', (code) => {
			if (!this.stopped) {
				console.log(`[pixel-agents] SSH tail closed: ${this.options.host}:${this.options.filePath} (code ${code})`);
				this.options.onClose();
			}
		});
	}

	stop(): void {
		this.stopped = true;
		this.proc?.kill();
		this.proc = null;
	}
}
