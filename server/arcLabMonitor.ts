// ARC-AGI-3 Lab Monitor — polls ARC API and event_log.db for lab status
// Broadcasts training progress, experiment status, health, and scores

import * as http from 'http';

export interface ArcLabStatus {
  health: {
    apiServer: boolean;
    webSocket: boolean;
    orchestrator: boolean;
    reactor: boolean;
  };
  experiments: ArcExperiment[];
  recentEvents: ArcEvent[];
  scores: {
    liveScore: string;
    localEval: string;
    blackBoxEval: string;
  };
  training: ArcTrainingStatus[];
}

export interface ArcExperiment {
  id: number;
  name: string;
  type: string;
  status: string; // pending | running | completed | failed
  startedAt: string;
}

export interface ArcEvent {
  id: number;
  category: string;
  severity: string;
  title: string;
  timestamp: string;
  source: string;
}

export interface ArcTrainingStatus {
  name: string;
  node: string;
  epoch: number;
  totalEpochs: number;
  status: string;
}

const ARC_API = 'http://127.0.0.1:8400';
const POLL_INTERVAL_MS = 10_000;

let currentStatus: ArcLabStatus = {
  health: { apiServer: false, webSocket: false, orchestrator: false, reactor: false },
  experiments: [],
  recentEvents: [],
  scores: { liveScore: '--', localEval: '--', blackBoxEval: '--' },
  training: [],
};

let pollTimer: ReturnType<typeof setInterval> | null = null;

function httpGet(url: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function checkHealth(): Promise<ArcLabStatus['health']> {
  const health = { apiServer: false, webSocket: false, orchestrator: false, reactor: false };
  try {
    const raw = await httpGet(`${ARC_API}/api/health`);
    const data = JSON.parse(raw);
    health.apiServer = data.status === 'healthy' || data.status === 'ok';
    if (data.services) {
      health.webSocket = data.services.websocket?.status === 'ok' || false;
      health.orchestrator = data.services.orchestrator?.status === 'ok' || false;
      health.reactor = data.services.reactor?.status === 'ok' || false;
    }
  } catch {
    // API not reachable
  }
  return health;
}

async function fetchExperiments(): Promise<ArcExperiment[]> {
  try {
    const raw = await httpGet(`${ARC_API}/api/experiments?limit=5&status=running`);
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      return data.map((e: any) => ({
        id: e.id,
        name: e.name || 'unnamed',
        type: e.type || 'unknown',
        status: e.status || 'unknown',
        startedAt: e.started_at || e.created_at || '',
      }));
    }
    if (data.experiments && Array.isArray(data.experiments)) {
      return data.experiments.map((e: any) => ({
        id: e.id,
        name: e.name || 'unnamed',
        type: e.type || 'unknown',
        status: e.status || 'unknown',
        startedAt: e.started_at || e.created_at || '',
      }));
    }
  } catch {
    // API not reachable
  }
  return [];
}

async function fetchRecentEvents(): Promise<ArcEvent[]> {
  try {
    const raw = await httpGet(`${ARC_API}/api/events?limit=8&severity=info`);
    const data = JSON.parse(raw);
    const events = Array.isArray(data) ? data : (data.events || []);
    return events.slice(0, 8).map((e: any) => ({
      id: e.id,
      category: e.category || '',
      severity: e.severity || 'info',
      title: e.title || '',
      timestamp: e.timestamp || e.created_at || '',
      source: e.source || '',
    }));
  } catch {
    // API not reachable
  }
  return [];
}

async function pollArcLab(): Promise<void> {
  const [health, experiments, events] = await Promise.all([
    checkHealth(),
    fetchExperiments(),
    fetchRecentEvents(),
  ]);

  currentStatus = {
    health,
    experiments,
    recentEvents: events,
    scores: currentStatus.scores, // preserved until we can fetch from scorecard
    training: currentStatus.training,
  };
}

export function getArcLabStatus(): ArcLabStatus {
  return currentStatus;
}

export function startArcLabMonitor(
  onUpdate: (status: ArcLabStatus) => void,
): void {
  // Initial poll
  pollArcLab().then(() => onUpdate(currentStatus));

  // Periodic polling
  pollTimer = setInterval(async () => {
    await pollArcLab();
    onUpdate(currentStatus);
  }, POLL_INTERVAL_MS);

  console.log('[ARC Lab] Monitoring ARC-AGI-3 API at', ARC_API);
}

export function stopArcLabMonitor(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
