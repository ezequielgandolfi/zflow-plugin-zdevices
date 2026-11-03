import { randomUUID } from 'node:crypto';
import { defineService, type ServiceContext, type ServiceInstance } from '@zflow/sdk';
import { capabilitiesOf, MANUFACTURER, modelOf, PROPERTIES, PROVIDER, propertyKinds, type PropertyKind } from './catalogue.ts';
import {
  normalizeDeviceId,
  parseMessage,
  ROOT,
  topics,
  type CentralInfo,
  type ReportMessage,
  type SeenDevice,
} from './protocol.ts';
import { asSettings, type Settings } from './settings.ts';
import { centralsOf, detailsOf, linksOf, toDetails, type Details } from './store.ts';
import { deviceId, IOT, MQTT, type IotService, type MqttEvent, type MqttService } from './zflow-plugins.ts';

/** A central counts as reachable while its pings (every 60 s) keep arriving. */
export const DISCOVERY_WINDOW = 3 * 60_000;
export const DEFAULT_JOIN_SECONDS = 254;
const MAX_JOIN_SECONDS = 600;
const PAIRING_POLL = 10_000;
const PAIRING_SINCE = 3600;
const SEEN_TIMEOUT = 5_000;
const AVAILABILITY_EVERY = 60_000;
const DEFAULT_REPORT_INTERVAL = 300;

export interface CentralStatus {
  central: string;
  paired: boolean;
  /** Null when it hasn't been heard since zflow started. */
  online: boolean | null;
  info: CentralInfo;
  lastPing?: number;
}

export interface PairingEntry {
  id: string;
  model?: number;
  modelName: string;
  firmware?: string;
  reportInterval?: number;
  batteryPowered: boolean;
  properties: string[];
  heardBy: { central: string; linkquality?: number; lastSeen?: number }[];
  /** When it was first listed. */
  at: number;
}

export interface ZDevicesStatus {
  state: 'off' | 'running' | 'failed';
  error?: string;
  joinUntil?: number;
  centrals: CentralStatus[];
  devices: number;
  offline: number;
  pairing: PairingEntry[];
}

interface Heard {
  online: boolean;
  info: CentralInfo;
  lastPing: number;
}

interface Pending {
  central: string;
  resolve(devices: SeenDevice[]): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Listens to the centrals on one broker and keeps the devices they relay in the device registry. */
export class ZDevicesService implements ServiceInstance {
  private readonly ctx: ServiceContext;
  private settings: Settings;
  private state: ZDevicesStatus['state'] = 'off';
  private error: string | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly heard = new Map<string, Heard>();
  private readonly pending = new Map<string, Pending>();
  private readonly pairing = new Map<string, PairingEntry>();
  private joinUntil: number | undefined;
  private joinTimer: ReturnType<typeof setInterval> | undefined;
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private unregister: (() => void) | undefined;

  readonly commands = {
    permitJoin: (input: unknown) => {
      const { seconds } = (input ?? {}) as { seconds?: unknown };
      const time = seconds === undefined ? DEFAULT_JOIN_SECONDS : Number(seconds);
      if (!Number.isInteger(time) || time < 1 || time > MAX_JOIN_SECONDS) {
        throw new Error(`Look for devices for 1 to ${MAX_JOIN_SECONDS} seconds`);
      }
      this.permitJoin(time);
      return this.status();
    },
    stopJoin: () => {
      this.stopJoin();
      return this.status();
    },
    pair: (input: unknown) => {
      const { id, name } = (input ?? {}) as { id?: unknown; name?: unknown };
      return this.pair(normalizeDeviceId(id), name);
    },
    pairCentral: (input: unknown) => {
      this.pairCentral(centralOf(input));
      return this.status();
    },
    unpairCentral: (input: unknown) => {
      this.unpairCentral(centralOf(input));
      return this.status();
    },
    remove: (input: unknown) => {
      this.remove(normalizeDeviceId((input as { id?: unknown } | null)?.id));
      return null;
    },
  };

  constructor(ctx: ServiceContext) {
    this.ctx = ctx;
    this.settings = asSettings(ctx.settings);
  }

  start(): void {
    this.provide();
    this.listen();
    this.timers.push(setInterval(() => this.checkAvailability(), AVAILABILITY_EVERY));
  }

  stop(): void {
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    this.quiet();
    this.unregister?.();
    this.unregister = undefined;
  }

  update(settings: unknown): void {
    const next = asSettings(settings);
    const restart = next.enabled !== this.settings.enabled || next.connection !== this.settings.connection;
    const keep = next.historyDays !== this.settings.historyDays;
    this.settings = next;
    if (keep) {
      this.unregister?.();
      this.provide();
    }
    if (!restart) return;
    this.quiet();
    this.listen();
  }

  status(): ZDevicesStatus {
    const now = Date.now();
    const paired = this.pairedCentrals();
    const names = new Set([...paired, ...[...this.heard].filter(([, heard]) => recent(heard, now)).map(([name]) => name)]);
    const devices = this.iot().devices(undefined, { provider: PROVIDER });
    return {
      state: this.state,
      ...(this.error && { error: this.error }),
      ...(this.joinUntil && { joinUntil: this.joinUntil }),
      centrals: [...names].sort().map((central) => {
        const heard = this.heard.get(central);
        return {
          central,
          paired: paired.has(central),
          online: heard ? heard.online && recent(heard, now) : null,
          info: heard?.info ?? {},
          ...(heard && { lastPing: heard.lastPing }),
        };
      }),
      devices: devices.length,
      offline: devices.filter((device) => device.online === false).length,
      pairing: [...this.pairing.values()],
    };
  }

  diagnose() {
    return {
      ...this.status(),
      connection: this.settings.connection,
      historyDays: this.settings.historyDays ?? null,
      pendingRequests: this.pending.size,
    };
  }

  handle(event: MqttEvent): void {
    if (event.event === 'disconnected') {
      const heard = this.heard.get(event.clientId);
      if (heard) this.heard.set(event.clientId, { ...heard, online: false });
      return;
    }
    if (event.event !== 'message' || event.clientId === null || !event.topic.startsWith(`${ROOT}/`)) return;
    const message = parseMessage(event.topic, event.payload);
    if (!message) return;
    switch (message.kind) {
      case 'state':
        if (message.online) this.noteAlive(message.central, this.heard.get(message.central)?.info ?? {});
        else this.markOffline(message.central);
        return;
      case 'info':
        return this.noteAlive(message.central, message.info);
      case 'seen': {
        const pending = this.pending.get(message.transaction);
        if (!pending || pending.central !== message.central) return;
        this.pending.delete(message.transaction);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.devices);
        return;
      }
      case 'report':
        return this.report(message.central, message.device, message.report);
    }
  }

  /** Registers with the registry again on each retention change, so it keeps readings for as long as they say. */
  private provide(): void {
    const days = this.settings.historyDays;
    this.unregister = this.iot().registerProvider(PROVIDER, {
      write: (device) => {
        throw new Error(`"${device.name}" only sends readings; Z Devices can't be controlled yet`);
      },
      history: days === undefined ? {} : { days },
    });
  }

  private listen(): void {
    this.error = undefined;
    if (!this.settings.enabled || !this.settings.connection) {
      this.state = 'off';
      return;
    }
    try {
      this.unsubscribe = this.mqtt().subscribe(this.settings.connection, (event) => this.safely(() => this.handle(event)));
      this.state = 'running';
    } catch (error) {
      this.state = 'failed';
      this.error = `Couldn't listen to the MQTT broker: ${(error as Error).message}`;
      this.ctx.logger.warn(this.error);
    }
  }

  /** Stops listening; what's paired stays as it is. */
  private quiet(): void {
    this.stopJoin();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.heard.clear();
    for (const [transaction, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Z Devices stopped'));
      this.pending.delete(transaction);
    }
    this.state = 'off';
  }

  private noteAlive(central: string, info: CentralInfo): void {
    const known = this.heard.get(central);
    this.heard.set(central, { online: true, info, lastPing: Date.now() });
    // A central heard for the first time (or back after a restart of zflow) gets the relay list again.
    if (!known && this.pairedCentrals().has(central)) void this.publishRelays(central);
  }

  private markOffline(central: string): void {
    const known = this.heard.get(central);
    if (known) this.heard.set(central, { ...known, online: false });
  }

  private pairedCentrals(): Set<string> {
    return new Set(centralsOf(this.ctx.storage).rows().map((row) => row.central as string));
  }

  private pairedDevices(): string[] {
    return detailsOf(this.ctx.storage)
      .rows()
      .map((row) => row.externalId as string)
      .sort();
  }

  /** Sends centrals the relay list, which they keep (retained) to answer the handshakes of paired devices. */
  async publishRelays(only?: string, devices = this.pairedDevices()): Promise<void> {
    const targets = only ? [only] : [...this.pairedCentrals()];
    for (const central of targets) {
      if (!this.heard.has(central) || this.state !== 'running') continue;
      try {
        await this.mqtt().publish(this.settings.connection, {
          topic: topics.relays(central),
          payload: { devices },
          qos: 1,
          retain: true,
        });
      } catch (error) {
        this.ctx.logger.warn(`Couldn't send "${central}" its relay list: ${(error as Error).message}`);
      }
    }
  }

  private pairCentral(central: string): void {
    if (!this.heard.has(central)) throw new Error(`"${central}" hasn't been heard from lately. Is it online?`);
    centralsOf(this.ctx.storage).put({ central });
    void this.publishRelays(central);
  }

  private unpairCentral(central: string): void {
    void this.publishRelays(central, []);
    centralsOf(this.ctx.storage).delete({ where: { central } });
    linksOf(this.ctx.storage).delete({ where: { central } });
    for (const entry of this.pairing.values()) {
      entry.heardBy = entry.heardBy.filter((heard) => heard.central !== central);
    }
  }

  private permitJoin(seconds: number): void {
    if (this.state !== 'running') throw new Error('Turn Z Devices on to add devices');
    const online = this.onlineCentrals();
    if (online.length === 0) throw new Error('Pair a central first, and check it is online');
    this.stopJoin();
    this.pairing.clear();
    this.joinUntil = Date.now() + seconds * 1000;
    const poll = () => {
      if (!this.joinUntil || Date.now() >= this.joinUntil) return this.stopJoin();
      for (const central of this.onlineCentrals()) {
        this.requestSeen(central, PAIRING_SINCE)
          .then((devices) => this.notePairing(central, devices))
          .catch((error: Error) => this.ctx.logger.debug(`"${central}" didn't list what it heard: ${error.message}`));
      }
    };
    poll();
    this.joinTimer = setInterval(poll, PAIRING_POLL);
  }

  private stopJoin(): void {
    if (this.joinTimer) clearInterval(this.joinTimer);
    this.joinTimer = undefined;
    this.joinUntil = undefined;
  }

  private onlineCentrals(): string[] {
    const now = Date.now();
    return [...this.pairedCentrals()].filter((central) => {
      const heard = this.heard.get(central);
      return heard?.online === true && recent(heard, now);
    });
  }

  notePairing(central: string, devices: SeenDevice[]): void {
    const paired = new Set(this.pairedDevices());
    for (const device of devices) {
      if (paired.has(device.id)) {
        linksOf(this.ctx.storage).put(linkRow(central, device));
        continue;
      }
      const entry: PairingEntry = this.pairing.get(device.id) ?? {
        id: device.id,
        modelName: modelOf(device.model).name,
        batteryPowered: device.batteryPowered,
        properties: device.properties,
        heardBy: [],
        at: Date.now(),
      };
      Object.assign(entry, {
        ...(device.model !== undefined && { model: device.model, modelName: modelOf(device.model).name }),
        ...(device.firmware && { firmware: device.firmware }),
        ...(device.reportInterval !== undefined && { reportInterval: device.reportInterval }),
        batteryPowered: device.batteryPowered,
        properties: device.properties,
      });
      entry.heardBy = [
        ...entry.heardBy.filter((heard) => heard.central !== central),
        {
          central,
          ...(device.linkquality !== undefined && { linkquality: device.linkquality }),
          ...(device.lastSeen !== undefined && { lastSeen: device.lastSeen }),
        },
      ];
      this.pairing.set(device.id, entry);
    }
  }

  private pair(externalId: string, rawName: unknown) {
    const entry = this.pairing.get(externalId);
    if (!entry) throw new Error("That device isn't among the ones the centrals heard. Add devices again");
    const details: Details = {
      externalId,
      ...(entry.model !== undefined && { model: entry.model }),
      ...(entry.firmware && { firmware: entry.firmware }),
      ...(entry.reportInterval !== undefined && { reportInterval: entry.reportInterval }),
      batteryPowered: entry.batteryPowered,
      properties: Object.fromEntries(
        entry.properties.map((property): [string, PropertyKind] => [
          property,
          (PROPERTIES[property]?.kind as PropertyKind | undefined) ?? 'numeric',
        ]),
      ),
    };
    const name = typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim() : entry.modelName;
    let device = this.upsert(details, name);
    // upsert keeps the name of a device the registry already had, so a new name goes through its rename.
    if (device.name !== name) device = this.iot().rename(deviceId(PROVIDER, externalId), name);
    detailsOf(this.ctx.storage).put({ ...details });
    for (const heard of entry.heardBy) {
      linksOf(this.ctx.storage).put({
        central: heard.central,
        externalId,
        linkquality: heard.linkquality ?? null,
        lastSeen: heard.lastSeen ?? null,
      });
    }
    this.pairing.delete(externalId);
    void this.publishRelays();
    return device;
  }

  /** The registry drops the device's history with it. */
  private remove(externalId: string): void {
    const storage = this.ctx.storage;
    this.iot().remove(PROVIDER, externalId);
    detailsOf(storage).delete({ where: { externalId } });
    linksOf(storage).delete({ where: { externalId } });
    void this.publishRelays();
  }

  private report(central: string, externalId: string, report: ReportMessage): void {
    if (!this.pairedCentrals().has(central)) return;
    const storage = this.ctx.storage;
    const details = detailsOf(storage);
    const [row] = details.rows({ where: { externalId }, limit: 1 });
    if (!row) return;
    const known = toDetails(row);
    // A device sends each report once, to one central; the same seq again is a radio retry.
    if (!report.boot && report.seq !== undefined && known.lastSeq === report.seq) return;

    const now = Date.now();
    const next: Details = {
      ...known,
      ...(report.model !== undefined && { model: report.model }),
      ...(report.firmware !== undefined && { firmware: report.firmware }),
      ...(report.reportInterval !== undefined && { reportInterval: report.reportInterval }),
      properties: { ...known.properties, ...propertyKinds(report.values) },
      ...(report.seq !== undefined && { lastSeq: report.seq }),
      lastCentral: central,
      lastReport: now,
    };
    if (changed(known, next)) this.upsert(next);
    details.put({ ...next });

    const state = { ...report.values, ...(report.linkquality !== undefined && { linkquality: report.linkquality }) };
    this.iot().report(PROVIDER, externalId, { state, online: true, at: now });
    linksOf(storage).put({ central, externalId, linkquality: report.linkquality ?? null, lastSeen: now });
  }

  private upsert(details: Details, name?: string) {
    const model = modelOf(details.model);
    return this.iot().upsert(PROVIDER, {
      externalId: details.externalId,
      name: name ?? model.name,
      type: model.type,
      model: model.name,
      manufacturer: MANUFACTURER,
      capabilities: capabilitiesOf(details.properties),
    });
  }

  requestSeen(central: string, since: number): Promise<SeenDevice[]> {
    const transaction = randomUUID();
    return new Promise<SeenDevice[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(transaction);
        reject(new Error(`"${central}" didn't answer in time`));
      }, SEEN_TIMEOUT);
      this.pending.set(transaction, { central, resolve, reject, timer });
      this.mqtt()
        .publish(this.settings.connection, {
          topic: topics.seenRequest(central),
          payload: { since, transaction },
          qos: 1,
        })
        .catch((error: Error) => {
          clearTimeout(timer);
          this.pending.delete(transaction);
          reject(new Error(`Couldn't ask "${central}": ${error.message}`));
        });
    });
  }

  checkAvailability(now = Date.now()): void {
    if (this.state !== 'running') return;
    const online = new Set(
      this.iot()
        .devices(undefined, { provider: PROVIDER })
        .filter((device) => device.online !== false)
        .map((device) => device.externalId),
    );
    for (const details of detailsOf(this.ctx.storage).rows().map(toDetails)) {
      if (!online.has(details.externalId) || details.lastReport === undefined) continue;
      const allowed = 2 * (details.reportInterval ?? DEFAULT_REPORT_INTERVAL) * 1000 + 60_000;
      if (now - details.lastReport > allowed) {
        this.iot().report(PROVIDER, details.externalId, { online: false, at: now });
      }
    }
  }

  private safely(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.ctx.logger.error(`Couldn't handle a Z Devices message: ${(error as Error).message}`);
    }
  }

  private iot() {
    return this.ctx.service<IotService>(IOT);
  }

  private mqtt() {
    return this.ctx.service<MqttService>(MQTT);
  }
}

const recent = (heard: Heard, now: number) => now - heard.lastPing <= DISCOVERY_WINDOW;

function centralOf(input: unknown): string {
  const { central } = (input ?? {}) as { central?: unknown };
  if (typeof central !== 'string' || central === '') throw new Error('Say which central');
  return central;
}

const linkRow = (central: string, device: SeenDevice) => ({
  central,
  externalId: device.id,
  linkquality: device.linkquality ?? null,
  lastSeen: device.lastSeen ?? null,
});

const changed = (before: Details, after: Details) =>
  before.model !== after.model ||
  before.firmware !== after.firmware ||
  before.reportInterval !== after.reportInterval ||
  JSON.stringify(before.properties) !== JSON.stringify(after.properties);

export const zDevicesService = defineService({ create: (ctx) => new ZDevicesService(ctx) });
