// What this plugin uses of the built-in `iot` and `mqtt` plugins. Only the SDK is published, so these are copied from
// zflow-types' BUILT-IN-PLUGINS.md (iot 0.1.0, mqtt 0.1.0); keep them in step with it.
import type { ServiceInstance } from '@zflow/sdk';

export const IOT = 'iot';
export const MQTT = 'mqtt';

export type DeviceType =
  'light' | 'switch' | 'plug' | 'sensor' | 'contact' | 'motion' | 'button' | 'cover' | 'lock' | 'climate' | 'other';

export interface Capability {
  property: string;
  label: string;
  kind: 'binary' | 'numeric' | 'enum' | 'text' | 'event';
  access: 'read' | 'write' | 'both';
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  values?: string[];
  on?: unknown;
  off?: unknown;
  health?: 'battery' | 'signal';
}

export interface Device {
  id: string;
  provider: string;
  externalId: string;
  projectId?: string;
  name: string;
  type: DeviceType;
  model?: string;
  manufacturer?: string;
  capabilities: Capability[];
  state: Record<string, unknown>;
  online: boolean | null;
  lastSeen?: number;
  battery?: number;
  signal?: number;
  addedAt: number;
}

export type DeviceInput = Pick<Device, 'externalId' | 'name' | 'type' | 'capabilities'> &
  Partial<Pick<Device, 'model' | 'manufacturer' | 'online'>>;

export interface DeviceReport {
  state?: Record<string, unknown>;
  online?: boolean;
  at?: number;
}

export interface IotService extends ServiceInstance {
  registerProvider(
    pluginId: string,
    provider: {
      write(device: Device, values: Record<string, unknown>): Promise<void> | void;
      refresh?(device: Device): Promise<void> | void;
    },
  ): () => void;
  upsert(provider: string, input: DeviceInput, projectId?: string): Device;
  report(provider: string, externalId: string, report: DeviceReport, projectId?: string): Device | undefined;
  remove(provider: string, externalId: string, projectId?: string): void;
  devices(projectId?: string, filter?: { provider?: string; type?: string }): Device[];
  rename(id: string, name: string, projectId?: string): Device;
}

export const deviceId = (provider: string, externalId: string) => `${provider}:${externalId}`;

export type MqttEvent =
  | {
      event: 'message';
      connectionId: string;
      clientId: string | null;
      topic: string;
      payload: unknown;
      qos: number;
      retain: boolean;
    }
  | { event: 'connected' | 'disconnected'; connectionId: string; clientId: string };

export interface MqttService extends ServiceInstance {
  subscribe(connectionId: string, listener: (event: MqttEvent) => void): () => void;
  publish(
    connectionId: string,
    message: { topic: string; payload: unknown; qos?: 0 | 1 | 2; retain?: boolean },
  ): Promise<void>;
}
