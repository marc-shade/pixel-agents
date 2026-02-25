import * as esbuild from 'esbuild';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
	entryPoints: [path.join(__dirname, 'index.ts')],
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'cjs',
	outfile: path.join(__dirname, '..', 'dist', 'server.js'),
	alias: {
		'vscode': path.resolve(__dirname, 'vscode-shim.ts'),
	},
	sourcemap: true,
});

console.log('[pixel-agents] Server build complete');
