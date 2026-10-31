// What this plugin uses of the built-in `iot` plugin. Its types aren't published in @zflow/sdk, so these mirror
// zflow's packages/plugins/iot/src (devices.ts, service.ts); keep them in step with it.
import type { ServiceInstance } from '@zflow/sdk';

export const IOT_PLUGIN = 'iot';

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
  type: string;
  model?: string;
  manufacturer?: string;
  capabilities: Capability[];
  state: Record<string, unknown>;
  online: boolean | null;
  lastSeen?: number;
  addedAt: number;
}

export type DeviceInput = Pick<Device, 'externalId' | 'name' | 'type' | 'capabilities'> &
  Partial<Pick<Device, 'model' | 'manufacturer' | 'online'>>;

export interface DeviceProvider {
  write(device: Device, values: Record<string, unknown>): Promise<void> | void;
  refresh?(device: Device): Promise<void> | void;
}

export interface IotService extends ServiceInstance {
  registerProvider(pluginId: string, provider: DeviceProvider): () => void;
  devices(projectId?: string, filter?: { provider?: string; type?: string }): Device[];
  upsert(provider: string, input: DeviceInput, projectId?: string): Device;
  rename(id: string, name: string, projectId?: string): Device;
  remove(provider: string, externalId: string, projectId?: string): void;
}

export const deviceId = (provider: string, externalId: string) => `${provider}:${externalId}`;
