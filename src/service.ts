import { randomUUID } from 'node:crypto';
import { defineService, type ServiceContext, type ServiceInstance, type TableStorage } from '@zflow/sdk';
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
import { parseSettings, type Settings } from './settings.ts';
import {
  centralsOf,
  detailsOf,
  DISCOVERY_WINDOW,
  readingsOf,
  relaysOf,
  toDetails,
  toRelay,
  type Details,
} from './store.ts';
import { deviceId, IOT, MQTT, type IotService, type MqttEvent, type MqttService } from './zflow-plugins.ts';

const SEEN_TIMEOUT = 5_000;
const AVAILABILITY_EVERY = 60_000;
const RETENTION_EVERY = 60 * 60_000;
const UNKNOWN_DEVICE_EVERY = 60 * 60_000;
const DEFAULT_REPORT_INTERVAL = 300;
const DAY = 24 * 60 * 60_000;

export type CentralEvent =
  | { event: 'online' | 'offline'; central: string }
  | { event: 'unknown-device'; central: string; device: string; model?: string };

/** What a running Z Central integration gives the service, to hear about its central. */
export interface CentralHandle {
  emit(event: CentralEvent): void;
}

interface Discovered {
  connection: string;
  online: boolean | null;
  info: CentralInfo;
  /** The latest sign of life: a ping or an online state. */
  lastPing: number;
}

interface Claim {
  projectId: string;
  handle: CentralHandle;
}

interface Pending {
  central: string;
  resolve(devices: SeenDevice[]): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export type SeenState = 'new' | 'relayed' | 'in-project';

export interface SeenEntry extends SeenDevice {
  modelName: string;
  /** New to the project, already relayed by this central, or in the project through another central. */
  state: SeenState;
  name?: string;
}

/** Discovers centrals on the configured brokers and keeps the devices they relay in each project's registry. */
export class ZDevicesService implements ServiceInstance {
  private readonly ctx: ServiceContext;
  private settings: Settings;
  private readonly subscriptions = new Map<string, () => void>();
  private readonly discovered = new Map<string, Discovered>();
  private readonly claims = new Map<string, Claim>();
  private readonly pending = new Map<string, Pending>();
  private readonly seenLists = new Map<string, Map<string, SeenDevice>>();
  private readonly unknownNotified = new Map<string, number>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private unregister: (() => void) | undefined;

  readonly commands = {
    seen: async (input: unknown) => {
      const { projectId, central } = this.target(input);
      const since = Number((input as { since?: unknown }).since) || 3600;
      return this.annotate(projectId, central, await this.requestSeen(central, since));
    },
    add: (input: unknown) => {
      const { projectId, central } = this.target(input);
      const fields = input as { id?: unknown; name?: unknown };
      return this.add(projectId, central, normalizeDeviceId(fields.id), fields.name);
    },
    remove: (input: unknown) => {
      const fields = (input ?? {}) as { projectId?: unknown; central?: unknown; id?: unknown };
      const projectId = projectOf(fields);
      const central = typeof fields.central === 'string' && fields.central !== '' ? fields.central : undefined;
      this.remove(projectId, normalizeDeviceId(fields.id), central);
      return null;
    },
  };

  constructor(ctx: ServiceContext) {
    this.ctx = ctx;
    this.settings = parseSettings(ctx.settings);
  }

  start(): void {
    this.unregister = this.iot().registerProvider(PROVIDER, {
      write: (device) => {
        throw new Error(`"${device.name}" only sends readings; Z Devices can't be controlled yet`);
      },
    });
    // Claims belong to running integrations, which attach again as they start.
    const centrals = centralsOf(this.ctx.storage);
    for (const row of centrals.rows()) {
      if (row.projectId) centrals.put({ ...row, projectId: null }, row.at);
    }
    this.listen();
    this.timers.push(
      setInterval(() => this.checkAvailability(), AVAILABILITY_EVERY),
      setInterval(() => this.applyRetention(), RETENTION_EVERY),
    );
  }

  stop(): void {
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    for (const [transaction, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Z Devices stopped'));
      this.pending.delete(transaction);
    }
    this.unregister?.();
    this.unregister = undefined;
  }

  update(settings: unknown): void {
    this.settings = parseSettings(settings);
    this.listen();
  }

  status() {
    const now = Date.now();
    return {
      connections: this.settings.connections.map((connection) => ({
        connection,
        listening: this.subscriptions.has(connection),
      })),
      centrals: [...this.discovered].map(([central, found]) => ({
        central,
        connection: found.connection,
        online: found.online,
        lastPing: found.lastPing,
        stale: now - found.lastPing > DISCOVERY_WINDOW,
        projectId: this.claims.get(central)?.projectId ?? null,
      })),
    };
  }

  diagnose() {
    return {
      ...this.status(),
      historyDays: this.settings.historyDays,
      claims: [...this.claims].map(([central, claim]) => ({ central, projectId: claim.projectId })),
      pendingRequests: this.pending.size,
    };
  }

  projectDeleted(projectId: string): void {
    for (const [central, claim] of this.claims) {
      if (claim.projectId === projectId) this.release(central);
    }
  }

  /** Takes the central into a project; it can be in one project at a time. Returns what lets it go. */
  attach(projectId: string, central: string, handle: CentralHandle): () => void {
    const claim = this.claims.get(central);
    if (claim) {
      throw new Error(
        claim.projectId === projectId
          ? `The project already has a Z Central integration for "${central}"`
          : `The central "${central}" is in another project. Remove it there first`,
      );
    }
    this.claims.set(central, { projectId, handle });
    this.saveCentral(central);
    void this.publishRelays(central);
    return () => {
      if (this.claims.get(central)?.handle === handle) this.release(central);
    };
  }

  /** Sends the central its relay list, which it keeps (retained) to answer handshakes. */
  async publishRelays(central: string): Promise<void> {
    const claim = this.claims.get(central);
    const found = this.discovered.get(central);
    if (!claim || !found) return;
    const devices = relaysOf(this.project(claim.projectId))
      .rows({ where: { central } })
      .map((row) => row.externalId as string)
      .sort();
    try {
      await this.mqtt().publish(found.connection, {
        topic: topics.relays(central),
        payload: { devices },
        qos: 1,
        retain: true,
      });
    } catch (error) {
      this.ctx.logger.warn(`Couldn't send "${central}" its relay list: ${(error as Error).message}`);
    }
  }

  handle(event: MqttEvent): void {
    if (event.event === 'disconnected') {
      const found = this.discovered.get(event.clientId);
      if (found?.connection === event.connectionId) this.noteState(event.clientId, event.connectionId, false);
      return;
    }
    if (event.event !== 'message' || event.clientId === null || !event.topic.startsWith(`${ROOT}/`)) return;
    const message = parseMessage(event.topic, event.payload);
    if (!message) return;
    switch (message.kind) {
      case 'state':
        return this.noteState(message.central, event.connectionId, message.online);
      case 'info':
        return this.notePing(message.central, event.connectionId, message.info);
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

  private listen(): void {
    const wanted = new Set(this.settings.connections);
    for (const [connection, unsubscribe] of this.subscriptions) {
      if (wanted.has(connection)) continue;
      unsubscribe();
      this.subscriptions.delete(connection);
    }
    for (const connection of wanted) {
      if (this.subscriptions.has(connection)) continue;
      try {
        this.subscriptions.set(
          connection,
          this.mqtt().subscribe(connection, (event) => this.safely(() => this.handle(event))),
        );
      } catch (error) {
        this.ctx.logger.warn(`Couldn't listen to the MQTT connection "${connection}": ${(error as Error).message}`);
      }
    }
  }

  private notePing(central: string, connection: string, info: CentralInfo): void {
    const known = this.discovered.get(central);
    const moved = known?.connection !== connection;
    this.discovered.set(central, { connection, online: true, info, lastPing: Date.now() });
    this.saveCentral(central);
    if (known?.online !== true) this.claims.get(central)?.handle.emit({ event: 'online', central });
    if (moved) void this.publishRelays(central);
  }

  private noteState(central: string, connection: string, online: boolean): void {
    const known = this.discovered.get(central);
    if (!known && !online) return;
    this.discovered.set(central, {
      connection,
      online,
      info: known?.info ?? {},
      lastPing: online ? Date.now() : (known?.lastPing ?? Date.now()),
    });
    this.saveCentral(central);
    if (known?.online !== online) {
      this.claims.get(central)?.handle.emit({ event: online ? 'online' : 'offline', central });
    }
    if (online && known?.connection !== connection) void this.publishRelays(central);
  }

  private saveCentral(central: string): void {
    const found = this.discovered.get(central);
    const claim = this.claims.get(central);
    centralsOf(this.ctx.storage).put(
      {
        central,
        connection: found?.connection ?? '',
        online: found?.online ?? null,
        info: found?.info ?? {},
        projectId: claim?.projectId ?? null,
      },
      found?.lastPing ?? 0,
    );
  }

  private release(central: string): void {
    this.claims.delete(central);
    this.seenLists.delete(central);
    this.saveCentral(central);
  }

  private report(central: string, externalId: string, report: ReportMessage): void {
    const claim = this.claims.get(central);
    if (!claim) return;
    const { projectId } = claim;
    const storage = this.project(projectId);
    const [relay] = relaysOf(storage).rows({ where: { central, externalId }, limit: 1 });
    if (!relay) return this.unknownDevice(claim, central, externalId, report.model);

    const details = detailsOf(storage);
    const [row] = details.rows({ where: { externalId }, limit: 1 });
    const known = row ? toDetails(row) : undefined;
    // A device sends each report once, to one central; the same seq again is a radio retry.
    if (!report.boot && report.seq !== undefined && known?.lastSeq === report.seq) return;

    const now = Date.now();
    const next: Details = {
      externalId,
      ...known,
      ...(report.model !== undefined && { model: report.model }),
      ...(report.firmware !== undefined && { firmware: report.firmware }),
      ...(report.reportInterval !== undefined && { reportInterval: report.reportInterval }),
      properties: { ...known?.properties, ...propertyKinds(report.values) },
      ...(report.seq !== undefined && { lastSeq: report.seq }),
      lastCentral: central,
      lastReport: now,
    };
    if (!known || changed(known, next)) this.upsert(projectId, next);
    details.put({ ...next });

    const state = { ...report.values, ...(report.linkquality !== undefined && { linkquality: report.linkquality }) };
    this.iot().report(PROVIDER, externalId, { state, online: true, at: now }, projectId);
    readingsOf(storage).insert({ externalId, central, values: state }, now);
    relaysOf(storage).put({ central, externalId, linkquality: report.linkquality ?? null, lastSeen: now });
  }

  private unknownDevice(claim: Claim, central: string, device: string, model: number | undefined): void {
    const key = `${claim.projectId}:${device}`;
    const now = Date.now();
    if (now - (this.unknownNotified.get(key) ?? 0) < UNKNOWN_DEVICE_EVERY) return;
    this.unknownNotified.set(key, now);
    claim.handle.emit({ event: 'unknown-device', central, device, model: modelOf(model).name });
  }

  private upsert(projectId: string, details: Details, name?: string) {
    const model = modelOf(details.model);
    return this.iot().upsert(
      PROVIDER,
      {
        externalId: details.externalId,
        name: name ?? model.name,
        type: model.type,
        model: model.name,
        manufacturer: MANUFACTURER,
        capabilities: capabilitiesOf(details.properties),
      },
      projectId,
    );
  }

  private requestSeen(central: string, since: number): Promise<SeenDevice[]> {
    const found = this.discovered.get(central);
    if (!found) return Promise.reject(new Error(`"${central}" hasn't been heard from lately. Is it online?`));
    const transaction = randomUUID();
    return new Promise<SeenDevice[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(transaction);
        reject(new Error(`"${central}" didn't answer in time. Is it online?`));
      }, SEEN_TIMEOUT);
      this.pending.set(transaction, { central, resolve, reject, timer });
      this.mqtt()
        .publish(found.connection, {
          topic: topics.seenRequest(central),
          payload: { since: Math.max(1, Math.floor(since)), transaction },
          qos: 1,
        })
        .catch((error: Error) => {
          clearTimeout(timer);
          this.pending.delete(transaction);
          reject(new Error(`Couldn't ask "${central}": ${error.message}`));
        });
    }).then((devices) => {
      this.seenLists.set(central, new Map(devices.map((device) => [device.id, device])));
      return devices;
    });
  }

  private annotate(projectId: string, central: string, devices: SeenDevice[]): SeenEntry[] {
    const storage = this.project(projectId);
    const relays = relaysOf(storage).rows().map(toRelay);
    const names = new Map(
      this.iot()
        .devices(projectId, { provider: PROVIDER })
        .filter((device) => device.projectId === projectId)
        .map((device) => [device.externalId, device.name]),
    );
    return devices.map((device) => {
      const mine = relays.filter((relay) => relay.externalId === device.id);
      const state: SeenState = mine.some((relay) => relay.central === central)
        ? 'relayed'
        : mine.length > 0 || names.has(device.id)
          ? 'in-project'
          : 'new';
      const name = names.get(device.id);
      return { ...device, modelName: modelOf(device.model).name, state, ...(name && { name }) };
    });
  }

  private add(projectId: string, central: string, externalId: string, rawName: unknown) {
    const storage = this.project(projectId);
    const details = detailsOf(storage);
    const [row] = details.rows({ where: { externalId }, limit: 1 });
    const seen = this.seenLists.get(central)?.get(externalId);
    const known: Details = row
      ? toDetails(row)
      : {
          externalId,
          ...(seen?.model !== undefined && { model: seen.model }),
          ...(seen?.firmware && { firmware: seen.firmware }),
          ...(seen?.reportInterval !== undefined && { reportInterval: seen.reportInterval }),
          ...(seen && { batteryPowered: seen.batteryPowered }),
          properties: Object.fromEntries(
            (seen?.properties ?? []).map((property): [string, PropertyKind] => [
              property,
              (PROPERTIES[property]?.kind as PropertyKind | undefined) ?? 'numeric',
            ]),
          ),
        };
    const name = typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim() : undefined;
    let device = this.upsert(projectId, known, name);
    // upsert keeps the name a device already has, so a new name for a known device goes through the registry.
    if (name && device.name !== name) device = this.iot().rename(deviceId(PROVIDER, externalId), name, projectId);
    if (!row) details.put({ ...known });
    relaysOf(storage).put({
      central,
      externalId,
      linkquality: seen?.linkquality ?? null,
      lastSeen: seen?.lastSeen ?? null,
    });
    void this.publishRelays(central);
    return device;
  }

  private remove(projectId: string, externalId: string, central?: string): void {
    const storage = this.project(projectId);
    const relays = relaysOf(storage);
    const affected = relays
      .rows({ where: { externalId } })
      .map((row) => row.central as string)
      .filter((name) => !central || name === central);
    relays.delete({ where: central ? { central, externalId } : { externalId } });
    if (relays.rows({ where: { externalId }, limit: 1 }).length === 0) {
      this.iot().remove(PROVIDER, externalId, projectId);
      detailsOf(storage).delete({ where: { externalId } });
      readingsOf(storage).delete({ where: { externalId } });
    }
    for (const name of affected) {
      if (this.claims.get(name)?.projectId === projectId) void this.publishRelays(name);
    }
  }

  checkAvailability(now = Date.now()): void {
    for (const projectId of this.projects()) {
      const storage = this.project(projectId);
      const online = new Set(
        this.iot()
          .devices(projectId, { provider: PROVIDER })
          .filter((device) => device.projectId === projectId && device.online !== false)
          .map((device) => device.externalId),
      );
      for (const details of detailsOf(storage).rows().map(toDetails)) {
        if (!online.has(details.externalId) || details.lastReport === undefined) continue;
        const allowed = 2 * (details.reportInterval ?? DEFAULT_REPORT_INTERVAL) * 1000 + 60_000;
        if (now - details.lastReport > allowed) {
          this.iot().report(PROVIDER, details.externalId, { online: false, at: now }, projectId);
        }
      }
    }
  }

  applyRetention(now = Date.now()): void {
    const before = now - this.settings.historyDays * DAY;
    for (const projectId of this.projects()) readingsOf(this.project(projectId)).deleteBefore(before);
  }

  private target(input: unknown) {
    const fields = (input ?? {}) as { projectId?: unknown; central?: unknown };
    const projectId = projectOf(fields);
    const central = fields.central;
    if (typeof central !== 'string' || this.claims.get(central)?.projectId !== projectId) {
      throw new Error("That central isn't running in this project. Add a Z Central integration and publish");
    }
    return { projectId, central };
  }

  private projects(): Set<string> {
    return new Set([...this.claims.values()].map((claim) => claim.projectId));
  }

  private project(projectId: string): TableStorage {
    return this.ctx.storage.project(projectId);
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

function projectOf(fields: { projectId?: unknown }): string {
  if (typeof fields.projectId !== 'string' || fields.projectId === '') throw new Error('Say which project');
  return fields.projectId;
}

const changed = (before: Details, after: Details) =>
  before.model !== after.model ||
  before.firmware !== after.firmware ||
  before.reportInterval !== after.reportInterval ||
  JSON.stringify(before.properties) !== JSON.stringify(after.properties);

export const zDevicesService = defineService({ create: (ctx) => new ZDevicesService(ctx) });
