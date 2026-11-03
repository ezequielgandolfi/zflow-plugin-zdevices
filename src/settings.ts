export interface Settings {
  /** The MQTT connections the service listens to for centrals. */
  connections: string[];
  /** How long readings are kept. */
  historyDays: number;
}

export const DEFAULT_HISTORY_DAYS = 365;
export const DEFAULT_SETTINGS = { connections: [], historyDays: DEFAULT_HISTORY_DAYS };

/** Settings as the Studio saves them: the connections are a `list` of `{ connection }` rows. */
export function parseSettings(raw: unknown): Settings {
  const fields = (raw ?? {}) as { connections?: unknown; historyDays?: unknown };
  const rows = Array.isArray(fields.connections) ? fields.connections : [];
  const connections = rows
    .map((row) => (typeof row === 'string' ? row : (row as { connection?: unknown } | null)?.connection))
    .filter((connection): connection is string => typeof connection === 'string' && connection !== '');
  const days = Number(fields.historyDays);
  return {
    connections: [...new Set(connections)],
    historyDays: Number.isFinite(days) && days >= 1 ? Math.floor(days) : DEFAULT_HISTORY_DAYS,
  };
}

export function validateSettings(raw: unknown): string[] {
  const days = (raw as { historyDays?: unknown } | null)?.historyDays;
  if (days === undefined || days === null || days === '') return [];
  return Number.isFinite(Number(days)) && Number(days) >= 1 ? [] : ['Keep readings for at least 1 day'];
}
