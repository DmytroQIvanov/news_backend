import * as net from 'node:net';

/**
 * Socket-level traffic meter: counts bytes written/read per remote host for every outbound
 * connection (fetch/undici, pg, R2, LLM APIs). Logs a top-hosts summary periodically so the
 * source of Render "Service-Initiated" bandwidth is visible in the service logs.
 *
 * EGRESS_METER=false disables it; EGRESS_LOG_INTERVAL_MS sets the summary interval (default 10 min).
 */

interface HostStat {
  sent: number;
  recv: number;
  conns: number;
}

const windowStats = new Map<string, HostStat>();
const totalStats = new Map<string, HostStat>();
const live = new Map<net.Socket, { host: string; w: number; r: number }>();
let startedAt = 0;

function hostFrom(args: unknown[]): string {
  const first = args[0];
  if (Array.isArray(first)) return hostFrom(first);
  if (first && typeof first === 'object') {
    const o = first as { path?: string; servername?: string; host?: string; port?: number | string };
    if (o.path) return `unix:${o.path}`;
    return `${o.servername || o.host || 'localhost'}:${o.port ?? ''}`;
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    const host = typeof args[1] === 'string' ? args[1] : 'localhost';
    return `${host}:${first}`;
  }
  if (typeof first === 'string') return `unix:${first}`;
  return 'unknown';
}

function bump(map: Map<string, HostStat>, host: string, sent: number, recv: number, conns: number) {
  const s = map.get(host) ?? { sent: 0, recv: 0, conns: 0 };
  s.sent += sent;
  s.recv += recv;
  s.conns += conns;
  map.set(host, s);
}

function account(socket: net.Socket) {
  const entry = live.get(socket);
  if (!entry) return;
  const w = socket.bytesWritten ?? 0;
  const r = socket.bytesRead ?? 0;
  const dw = Math.max(0, w - entry.w);
  const dr = Math.max(0, r - entry.r);
  entry.w = w;
  entry.r = r;
  if (dw || dr) {
    bump(windowStats, entry.host, dw, dr, 0);
    bump(totalStats, entry.host, dw, dr, 0);
  }
}

const mb = (n: number) => `${(n / 1048576).toFixed(2)}MB`;

function format(map: Map<string, HostStat>, limit = 10): string {
  const rows = [...map.entries()].sort((a, b) => b[1].sent - a[1].sent).slice(0, limit);
  const sent = [...map.values()].reduce((s, v) => s + v.sent, 0);
  const recv = [...map.values()].reduce((s, v) => s + v.recv, 0);
  const lines = rows.map(([h, s]) => `  ${h} sent=${mb(s.sent)} recv=${mb(s.recv)} conns=${s.conns}`);
  return `sent=${mb(sent)} recv=${mb(recv)}\n${lines.join('\n')}`;
}

export function getEgressStats() {
  for (const socket of live.keys()) account(socket);
  return {
    since: new Date(startedAt).toISOString(),
    hosts: Object.fromEntries([...totalStats.entries()].sort((a, b) => b[1].sent - a[1].sent)),
  };
}

export function startEgressMeter(): void {
  if (startedAt || process.env.EGRESS_METER === 'false' || process.env.NODE_ENV === 'test') return;
  startedAt = Date.now();

  const originalConnect = net.Socket.prototype.connect as (...args: unknown[]) => net.Socket;
  (net.Socket.prototype as unknown as { connect: (...args: unknown[]) => net.Socket }).connect = function patchedConnect(
    this: net.Socket,
    ...args: unknown[]
  ) {
    if (!live.has(this)) {
      const host = hostFrom(args);
      live.set(this, { host, w: this.bytesWritten ?? 0, r: this.bytesRead ?? 0 });
      bump(windowStats, host, 0, 0, 1);
      bump(totalStats, host, 0, 0, 1);
      this.once('close', () => {
        account(this);
        live.delete(this);
      });
    }
    return originalConnect.apply(this, args);
  };

  const intervalMs = Math.max(60_000, Number(process.env.EGRESS_LOG_INTERVAL_MS) || 10 * 60_000);
  const timer = setInterval(() => {
    for (const socket of live.keys()) account(socket);
    console.warn(`[EgressMeter] last ${Math.round(intervalMs / 60_000)} min: ${format(windowStats)}`);
    console.warn(`[EgressMeter] since start ${new Date(startedAt).toISOString()}: ${format(totalStats, 5)}`);
    windowStats.clear();
  }, intervalMs);
  timer.unref?.();
}
