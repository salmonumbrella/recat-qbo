import type { LiveWorkerHealth } from './liveGates.js';

const LIVE_WORKER_HEARTBEAT_TTL_MS = 120_000;

interface WorkerHeartbeat {
  readonly workerId: string;
  readonly claimedAtMs: number | null;
  readonly running: boolean;
}

let heartbeat: WorkerHeartbeat | null = null;

export function markLiveWorkerStarted(workerId: string): void {
  if (typeof workerId !== 'string' || workerId.trim() === '') return;
  heartbeat = { workerId, claimedAtMs: null, running: true };
}

export function markLiveWorkerClaimCycle(workerId: string, at: Date): void {
  if (
    heartbeat?.running !== true
    || heartbeat.workerId !== workerId
    || !(at instanceof Date)
    || Number.isNaN(at.getTime())
  ) return;
  heartbeat = { workerId, claimedAtMs: at.getTime(), running: true };
}

export function markLiveWorkerStopped(workerId: string): void {
  if (heartbeat?.workerId === workerId) heartbeat = null;
}

export function getLiveWorkerHealth(
  _companyId: string,
  now = new Date(),
): LiveWorkerHealth {
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  const age = heartbeat?.claimedAtMs === null || heartbeat === null
    ? Number.POSITIVE_INFINITY
    : nowMs - heartbeat.claimedAtMs;
  return {
    healthy: heartbeat?.running === true
      && Number.isFinite(nowMs)
      && age >= 0
      && age <= LIVE_WORKER_HEARTBEAT_TTL_MS,
  };
}
