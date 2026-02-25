// Universal API shim — works in both VS Code webview and standalone (WebSocket) modes.
// In VS Code: uses acquireVsCodeApi() for postMessage.
// Standalone: connects via WebSocket and dispatches messages as window events
// so useExtensionMessages.ts works unchanged.

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void }

let postMessageFn: (msg: unknown) => void

if (typeof acquireVsCodeApi !== 'undefined') {
	// VS Code webview mode
	const api = acquireVsCodeApi()
	postMessageFn = (msg) => api.postMessage(msg)
} else {
	// Standalone mode — WebSocket
	const WS_URL = `ws://${window.location.host}/ws`
	let ws: WebSocket | null = null
	let queue: unknown[] = []
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null

	function connect(): void {
		if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return
		ws = new WebSocket(WS_URL)

		ws.onopen = () => {
			console.log('[pixel-agents] Connected to server')
			if (reconnectTimer) {
				clearTimeout(reconnectTimer)
				reconnectTimer = null
			}
			for (const msg of queue) {
				ws!.send(JSON.stringify(msg))
			}
			queue = []
		}

		ws.onmessage = (e) => {
			try {
				const data = JSON.parse(e.data as string)
				// Dispatch as window message — compatible with useExtensionMessages listener
				window.dispatchEvent(new MessageEvent('message', { data }))
			} catch { /* ignore malformed */ }
		}

		ws.onclose = () => {
			ws = null
			reconnectTimer = setTimeout(connect, 1500)
		}

		ws.onerror = () => {
			// onclose fires after this
		}
	}

	connect()

	postMessageFn = (msg) => {
		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(msg))
		} else {
			queue.push(msg)
		}
	}
}

export const vscode = { postMessage: postMessageFn }
