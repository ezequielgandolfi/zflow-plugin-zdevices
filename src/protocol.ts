// MQTT side of Z Devices protocol v2 (docs/z-protocol-v2.md, section 4).

export const ROOT = 'zdevices';

const CENTRAL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DEVICE_ID = /^[0-9a-f]{12}$/;

export const isCentralId = (value: unknown): value is string => typeof value === 'string' && CENTRAL_ID.test(value);

/** The device MAC as topics carry it: lowercase hex without separators. */
export function normalizeDeviceId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim().toLowerCase().replace(/[:-]/g, '') : '';
  if (!DEVICE_ID.test(id)) throw new Error('A device id is its MAC: 12 hex digits, like aabbccddeeff');
  return id;
}

export const topics = {
  relays: (central: string) => `${ROOT}/${central}/bridge/config/devices`,
  seenRequest: (central: string) => `${ROOT}/${central}/bridge/request/seen`,
  restart: (central: string) => `${ROOT}/${central}/bridge/request/restart`,
};

export interface CentralInfo {
  firmware?: string;
  protocol?: number;
  channel?: number;
  mac?: string;
  ip?: string;
  relaying?: number;
  dropped?: number;
  uptime?: number;
}

export interface SeenDevice {
  id: string;
  model?: number;
  firmware?: string;
  batteryPowered: boolean;
  reportInterval?: number;
  properties: string[];
  linkquality?: number;
  /** Ms since epoch; undefined when the central didn't know the time. */
  lastSeen?: number;
  relayed: boolean;
}

export interface ReportMessage {
  values: Record<string, unknown>;
  linkquality?: number;
  seq?: number;
  model?: number;
  firmware?: string;
  reportInterval?: number;
  boot: boolean;
}

export type CentralMessage =
  | { kind: 'state'; central: string; online: boolean }
  | { kind: 'info'; central: string; info: CentralInfo }
  | { kind: 'seen'; central: string; transaction: string; devices: SeenDevice[]; error?: string }
  | { kind: 'report'; central: string; device: string; report: ReportMessage };

const RESERVED = new Set(['linkquality', 'seq', 'model', 'firmware', 'report_interval', 'boot']);

/** What a message under `zdevices/` says, or undefined for topics and payloads that aren't protocol v2. */
export function parseMessage(topic: string, payload: unknown): CentralMessage | undefined {
  const [root, central, ...rest] = topic.split('/');
  if (root !== ROOT || !isCentralId(central) || !isObject(payload)) return undefined;
  const path = rest.join('/');
  if (path === 'bridge/state') {
    if (payload.state !== 'online' && payload.state !== 'offline') return undefined;
    return { kind: 'state', central, online: payload.state === 'online' };
  }
  if (path === 'bridge/info') return { kind: 'info', central, info: parseInfo(payload) };
  if (path === 'bridge/response/seen') {
    if (typeof payload.transaction !== 'string') return undefined;
    const devices = Array.isArray(payload.data) ? payload.data.flatMap(parseSeen) : [];
    return {
      kind: 'seen',
      central,
      transaction: payload.transaction,
      devices,
      ...(payload.status !== 'ok' && { error: text(payload.error) ?? "The central couldn't list what it heard" }),
    };
  }
  if (rest.length === 1 && DEVICE_ID.test(path)) {
    return { kind: 'report', central, device: path, report: parseReport(payload) };
  }
  return undefined;
}

function parseInfo(payload: Record<string, unknown>): CentralInfo {
  return clean({
    firmware: text(payload.firmware),
    protocol: number(payload.protocol),
    channel: number(payload.channel),
    mac: text(payload.mac),
    ip: text(payload.ip),
    relaying: number(payload.relaying),
    dropped: number(payload.dropped),
    uptime: number(payload.uptime),
  });
}

function parseSeen(entry: unknown): SeenDevice[] {
  if (!isObject(entry)) return [];
  let id: string;
  try {
    id = normalizeDeviceId(entry.id);
  } catch {
    return [];
  }
  const lastSeen = number(entry.last_seen);
  return [
    clean({
      id,
      model: number(entry.model),
      firmware: text(entry.firmware),
      batteryPowered: entry.battery_powered === true,
      reportInterval: number(entry.report_interval),
      properties: Array.isArray(entry.properties)
        ? entry.properties.filter((property): property is string => typeof property === 'string')
        : [],
      linkquality: number(entry.linkquality),
      lastSeen: lastSeen ? lastSeen * 1000 : undefined,
      relayed: entry.relayed === true,
    }),
  ];
}

function parseReport(payload: Record<string, unknown>): ReportMessage {
  const values = Object.fromEntries(
    Object.entries(payload).filter(([name, value]) => !RESERVED.has(name) && isValue(value)),
  );
  return clean({
    values,
    linkquality: number(payload.linkquality),
    seq: number(payload.seq),
    model: number(payload.model),
    firmware: text(payload.firmware),
    reportInterval: number(payload.report_interval),
    boot: payload.boot === true,
  });
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isValue = (value: unknown) => ['number', 'boolean', 'string'].includes(typeof value);
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);

function clean<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}
