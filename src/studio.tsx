import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PropertySchema } from '@zflow/sdk';
import { defineStudioPlugin, studioHost } from '@zflow/studio-sdk';
import { useEffect, useState } from 'react';
import { PROVIDER } from './catalogue.ts';
import type { SeenEntry } from './service.ts';
import { DEFAULT_HISTORY_DAYS } from './settings.ts';
import type { CentralRow, ZDevice } from './store.ts';

async function api<T>(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/plugins/${PROVIDER}${path}`, {
    method,
    ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => undefined)) as { issues?: string[]; error?: string } | undefined;
  if (!response.ok)
    throw new Error(data?.issues?.join('\n') ?? data?.error ?? `The server answered ${response.status}`);
  return data as T;
}

const action = async <T,>(name: string, input: unknown = {}) =>
  (await api<{ result: T }>('POST', `/actions/${name}`, { input })).result;

const keys = {
  centrals: (projectId?: string) => ['zdevices', 'centrals', projectId ?? ''],
  devices: (projectId: string) => ['zdevices', 'devices', projectId],
};

const ago = (at: number | undefined) => {
  if (!at) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(at).toLocaleDateString();
};

function StatusChip({ online }: { online: boolean | null }) {
  if (online === null) return <span className="chip">Unknown</span>;
  return <span className={online ? 'chip chip-success' : 'chip chip-warning'}>{online ? 'Online' : 'Offline'}</span>;
}

function ProjectZDevices({ projectId }: { projectId: string }) {
  const { EmptyState } = studioHost();
  const centrals = useQuery({
    queryKey: keys.centrals(projectId),
    queryFn: () => action<CentralRow[]>('centrals', { projectId }),
    refetchInterval: 15_000,
  });
  const devices = useQuery({
    queryKey: keys.devices(projectId),
    queryFn: () => action<ZDevice[]>('devices', { projectId }),
    refetchInterval: 15_000,
  });
  const mine = (centrals.data ?? []).filter((central) => central.projectId === projectId);
  const unrelayed = (devices.data ?? []).filter((device) => device.relays.length === 0);
  const error = centrals.error ?? devices.error;

  return (
    <>
      <p className="section-intro">
        The Z Devices the project's centrals relay. They join the device registry, so steps and widgets can read them.
      </p>
      {error && <p className="field-error">{error.message}</p>}
      {centrals.data && mine.length === 0 && (
        <EmptyState icon="radio-tower" title="No Z Central running in this project">
          Add a Z Central integration and publish the project. Centrals show up there once they ping a broker picked
          on the Z Devices admin page.
        </EmptyState>
      )}
      {mine.map((central) => (
        <CentralCard
          key={central.central}
          projectId={projectId}
          central={central}
          devices={(devices.data ?? []).filter((device) =>
            device.relays.some((relay) => relay.central === central.central),
          )}
        />
      ))}
      {unrelayed.length > 0 && <Unrelayed projectId={projectId} devices={unrelayed} />}
    </>
  );
}

function useRefresh(projectId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: keys.devices(projectId) });
    void queryClient.invalidateQueries({ queryKey: ['iot'] });
    void queryClient.invalidateQueries({ queryKey: ['options'] });
  };
}

function CentralCard(props: { projectId: string; central: CentralRow; devices: ZDevice[] }) {
  const { projectId, central, devices } = props;
  const { CollapsibleCard, DataTable, RowActions, useToast } = studioHost();
  const toast = useToast();
  const refresh = useRefresh(projectId);
  const [finding, setFinding] = useState(false);

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => action('rename', { projectId, id, name }),
    onSuccess: refresh,
    onError: (error) => toast('error', error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => action('remove', { projectId, central: central.central, id }),
    onSuccess: () => {
      toast('success', 'Device removed from the central');
      refresh();
    },
    onError: (error) => toast('error', error.message),
  });

  const { info } = central;
  const details = [
    info.firmware && `firmware ${info.firmware}`,
    info.channel !== undefined && `channel ${info.channel}`,
    info.ip,
    `${devices.length} relayed`,
    `last ping ${ago(central.at)}`,
  ].filter(Boolean);

  return (
    <CollapsibleCard storageKey={`zdevices.central.${central.central}`} title={central.central} icon="radio-tower">
      <p className="list-row-meta">
        <StatusChip online={central.online} /> {details.join(' · ')}
      </p>
      {devices.length > 0 && (
        <DataTable
          rows={devices}
          rowKey={(device) => device.id}
          columns={[
            { label: 'Name', render: (device) => device.name },
            { label: 'Model', render: (device) => `${device.model} · ${device.id}` },
            { label: 'Properties', render: (device) => device.properties.join(', ') },
            {
              label: 'Link quality',
              numeric: true,
              render: (device) =>
                device.relays.find((relay) => relay.central === central.central)?.linkquality ?? '—',
            },
            { label: 'Battery', numeric: true, render: (device) => (device.battery !== undefined ? `${device.battery}%` : '—') },
            { label: 'Last seen', render: (device) => ago(device.lastSeen) },
            { label: 'Status', render: (device) => <StatusChip online={device.online} /> },
            {
              label: '',
              render: (device) => (
                <RowActions>
                  <button
                    className="button button-quiet button-small"
                    type="button"
                    onClick={() => {
                      const name = window.prompt('Name', device.name)?.trim();
                      if (name && name !== device.name) rename.mutate({ id: device.id, name });
                    }}
                  >
                    Rename
                  </button>
                  <button
                    className="button button-quiet button-small button-danger"
                    type="button"
                    disabled={remove.isPending}
                    onClick={() => {
                      const last = device.relays.length === 1;
                      const question = last
                        ? `Remove "${device.name}" from the project? Its readings are deleted too.`
                        : `Stop relaying "${device.name}" through ${central.central}?`;
                      if (window.confirm(question)) remove.mutate(device.id);
                    }}
                  >
                    Remove
                  </button>
                </RowActions>
              ),
            },
          ]}
        />
      )}
      {finding ? (
        <FindDevices projectId={projectId} central={central.central} onClose={() => setFinding(false)} />
      ) : (
        <div className="row-actions">
          <button className="button button-small" type="button" onClick={() => setFinding(true)}>
            Find devices
          </button>
        </div>
      )}
    </CollapsibleCard>
  );
}

const SEEN_LABELS: Record<SeenEntry['state'], string> = {
  new: '',
  relayed: 'Relayed here',
  'in-project': 'In the project: add this central as another relay',
};

function FindDevices({ projectId, central, onClose }: { projectId: string; central: string; onClose: () => void }) {
  const { DataTable, EmptyState, useToast } = studioHost();
  const toast = useToast();
  const refresh = useRefresh(projectId);
  const [names, setNames] = useState<Record<string, string>>({});

  const seen = useQuery({
    queryKey: ['zdevices', 'seen', projectId, central],
    queryFn: () => action<SeenEntry[]>('seen', { projectId, central, since: 3600 }),
    retry: false,
    gcTime: 0,
  });
  const add = useMutation({
    mutationFn: (device: SeenEntry) =>
      action('add', { projectId, central, id: device.id, name: names[device.id] ?? device.name ?? device.modelName }),
    onSuccess: () => {
      toast('success', 'Device added');
      refresh();
      void seen.refetch();
    },
    onError: (error) => toast('error', error.message),
  });

  return (
    <div className="inline-form">
      <strong>Heard by {central} in the last hour</strong>
      {seen.isPending && <p className="list-row-meta">Asking the central…</p>}
      {seen.error && <p className="field-error">{seen.error.message}</p>}
      {seen.data?.length === 0 && (
        <EmptyState icon="search" title="Nothing heard lately">
          Power on a device near the central, wait for its first broadcast and try again.
        </EmptyState>
      )}
      {seen.data && seen.data.length > 0 && (
        <DataTable
          rows={seen.data}
          rowKey={(device) => device.id}
          columns={[
            {
              label: 'Name',
              render: (device) =>
                device.state === 'new' ? (
                  <input
                    className="input"
                    aria-label={`Name for ${device.id}`}
                    value={names[device.id] ?? device.modelName}
                    onChange={(event) => setNames({ ...names, [device.id]: event.target.value })}
                  />
                ) : (
                  (device.name ?? device.modelName)
                ),
            },
            { label: 'Model', render: (device) => `${device.modelName} · ${device.id}` },
            { label: 'Properties', render: (device) => device.properties.join(', ') },
            { label: 'Link quality', numeric: true, render: (device) => device.linkquality ?? '—' },
            { label: 'Last heard', render: (device) => ago(device.lastSeen) },
            {
              label: '',
              render: (device) =>
                device.state === 'relayed' ? (
                  SEEN_LABELS.relayed
                ) : (
                  <button
                    className="button button-primary button-small"
                    type="button"
                    title={SEEN_LABELS[device.state] || undefined}
                    disabled={add.isPending}
                    onClick={() => add.mutate(device)}
                  >
                    {device.state === 'new' ? 'Add' : 'Relay here'}
                  </button>
                ),
            },
          ]}
        />
      )}
      <div className="row-actions">
        <button className="button button-small" type="button" disabled={seen.isFetching} onClick={() => void seen.refetch()}>
          Search again
        </button>
        <button className="button button-small" type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function Unrelayed({ projectId, devices }: { projectId: string; devices: ZDevice[] }) {
  const { CollapsibleCard, Icon, useToast } = studioHost();
  const toast = useToast();
  const refresh = useRefresh(projectId);
  const remove = useMutation({
    mutationFn: (id: string) => action('remove', { projectId, id }),
    onSuccess: refresh,
    onError: (error) => toast('error', error.message),
  });
  return (
    <CollapsibleCard storageKey="zdevices.unrelayed" title="Not relayed by any central" icon="unplug">
      <div className="list">
        {devices.map((device) => (
          <div key={device.id} className="list-row">
            <Icon name="cpu" />
            <div className="list-row-main">
              <strong>{device.name}</strong>
              <span className="list-row-meta">{[device.model, device.id].join(' · ')}</span>
            </div>
            <div className="row-actions">
              <button
                className="button button-quiet button-small button-danger"
                type="button"
                disabled={remove.isPending}
                onClick={() => {
                  if (window.confirm(`Remove "${device.name}" from the project?`)) remove.mutate(device.id);
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </CollapsibleCard>
  );
}

const SETTINGS_SCHEMA: Record<string, PropertySchema> = {
  connections: {
    type: 'list',
    label: 'Brokers',
    description: 'The MQTT connections centrals publish to. zflow lists every central that pings one of them',
    items: {
      connection: { type: 'enum', label: 'Connection', optionsFrom: 'mqtt.connections', required: true },
    },
  },
  historyDays: {
    type: 'number',
    label: 'Keep readings for (days)',
    description: 'Older readings are deleted every hour',
    default: DEFAULT_HISTORY_DAYS,
  },
};

function AdminZDevices() {
  const { SettingsForm, DataTable, EmptyState, useToast } = studioHost();
  const toast = useToast();
  const queryClient = useQueryClient();
  const saved = useQuery({
    queryKey: ['zdevices', 'settings'],
    queryFn: () => api<{ settings: Record<string, unknown> }>('GET', '/settings'),
  });
  const centrals = useQuery({
    queryKey: keys.centrals(),
    queryFn: () => action<CentralRow[]>('centrals'),
    refetchInterval: 15_000,
  });
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    if (saved.data && values === null) setValues(saved.data.settings ?? {});
  }, [saved.data, values]);

  const save = useMutation({
    mutationFn: (settings: Record<string, unknown>) => api('PUT', '/settings', { settings }),
    onSuccess: () => {
      toast('success', 'Z Devices settings saved');
      void queryClient.invalidateQueries({ queryKey: ['zdevices'] });
      void queryClient.invalidateQueries({ queryKey: ['options'] });
    },
    onError: (error) => toast('error', error.message),
  });

  return (
    <>
      {saved.error && <p className="field-error">{saved.error.message}</p>}
      {values && (
        <>
          <SettingsForm schema={SETTINGS_SCHEMA} values={values} onChange={setValues} />
          <div className="row-actions">
            <button
              className="button button-primary button-small"
              type="button"
              disabled={save.isPending}
              onClick={() => save.mutate(values)}
            >
              Save
            </button>
          </div>
        </>
      )}
      <h4>Discovered centrals</h4>
      {centrals.data?.length === 0 && (
        <EmptyState icon="radio-tower" title="No central heard in the last 3 minutes">
          Point a central at one of the brokers above; it shows up with its first ping.
        </EmptyState>
      )}
      {centrals.data && centrals.data.length > 0 && (
        <DataTable
          rows={centrals.data}
          rowKey={(central) => central.central}
          columns={[
            { label: 'Central', render: (central) => central.central },
            { label: 'Status', render: (central) => <StatusChip online={central.online} /> },
            { label: 'Firmware', render: (central) => central.info.firmware ?? '—' },
            { label: 'Relaying', numeric: true, render: (central) => central.info.relaying ?? '—' },
            { label: 'Last ping', render: (central) => ago(central.at) },
            { label: 'Project', render: (central) => (central.projectId ? 'In a project' : 'Free') },
          ]}
        />
      )}
    </>
  );
}

export default defineStudioPlugin({
  id: PROVIDER,
  sections: {
    project: [
      {
        id: 'zdevices.devices',
        title: 'Z Devices',
        description: "Finds, adds and removes the Z Devices the project's centrals relay",
        icon: 'cpu',
        Component: ProjectZDevices,
      },
    ],
    admin: [
      {
        id: 'zdevices.settings',
        title: 'Z Devices',
        description: 'Picks the brokers centrals are discovered on and how long readings are kept',
        icon: 'radio-tower',
        Component: AdminZDevices,
      },
    ],
  },
});
