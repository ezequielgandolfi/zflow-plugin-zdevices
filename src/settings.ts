export interface Settings {
  enabled: boolean;
  /** The MQTT connection (from the MQTT page) the centrals publish to. */
  connection: string;
  /** How long readings are kept; empty keeps them forever. */
  historyDays?: number;
}

export const DEFAULT_SETTINGS: Settings = { enabled: false, connection: '', historyDays: 365 };

export function asSettings(raw: unknown): Settings {
  const fields = { ...DEFAULT_SETTINGS, ...(raw as Partial<Settings> | undefined) };
  const days = fields.historyDays as unknown;
  const settings: Settings = {
    enabled: fields.enabled === true,
    connection: typeof fields.connection === 'string' ? fields.connection : '',
  };
  if (days !== undefined && days !== null && days !== '') settings.historyDays = Number(days);
  return settings;
}

export function validateSettings(raw: unknown): string[] {
  const settings = asSettings(raw);
  const issues: string[] = [];
  if (settings.enabled && !settings.connection) issues.push('Pick the MQTT broker the centrals publish to');
  const days = settings.historyDays;
  if (days !== undefined && (!Number.isInteger(days) || days < 1)) {
    issues.push('Keep readings for at least one whole day, or leave it empty to keep them forever');
  }
  return issues;
}
