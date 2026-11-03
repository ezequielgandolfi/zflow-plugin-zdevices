import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PropertySchema } from '@zflow/sdk';
import { defineStudioPlugin, studioHost, studioPart } from '@zflow/studio-sdk';
import { useEffect, useState, type ReactNode } from 'react';
import { PROVIDER } from './catalogue.ts';
import type { CentralStatus, PairingEntry, ZDevicesStatus } from './service.ts';
import type { Settings } from './settings.ts';
import type { ZDevice } from './store.ts';
import { deviceId, IOT, type Device } from './zflow-plugins.ts';

type DeviceContent = ReactNode | ((device: Device) => ReactNode);

/** The Devices plugin's `DevicePage` part, as its docs describe it. */
interface DevicePageProps {
  device: string;
  back: { to: string; label: string };
  actions?: DeviceContent;
  sections?: { before?: DeviceContent; after?: DeviceContent };
  missing?: ReactNode;
}

/** What the row and page actions need of a device, from the plugin's list or the registry. */
type DeviceRef = Pick<Device, 'id' | 'externalId' | 'name'>;

interface ServiceResult {
  ok: boolean;
  error?: string;
  status?: { state: string; error?: string; details?: ZDevicesStatus };
}

async function api<T>(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => undefined)) as { issues?: string[]; error?: string } | undefined;
  if (!response.ok)
    throw new Error(data?.issues?.join('\n') ?? data?.error ?? `The server answered ${response.status}`);
  return data as T;
}

/** History comes from the Devices plugin, which keeps it. */
const action = async <T,>(name: string, input: unknown = {}, plugin: typeof PROVIDER | typeof IOT = PROVIDER) =>
  (await api<{ result: T }>('POST', `/plugins/${plugin}/actions/${name}`, { input })).result;

const keys = {
  settings: ['zdevices', 'settings'] as const,
  status: ['zdevices', 'status'] as const,
  devices: ['zdevices', 'devices'] as const,
};

function useStatus() {
  return useQuery({
    queryKey: keys.status,
    queryFn: () => api<ServiceResult>('GET', `/plugins/${PROVIDER}/status`),
    // Faster while looking for devices, so new ones show up as the centrals hear them.
    refetchInterval: (query) => (query.state.data?.status?.details?.joinUntil ? 2000 : 5000),
  });
}

function useDevices() {
  return useQuery({ queryKey: keys.devices, queryFn: () => action<ZDevice[]>('devices'), refetchInterval: 10_000 });
}

function useRefresh() {
  const client = useQueryClient();
  return () =>
    Promise.all(
      [keys.status, keys.devices, ['options'], ['iot']].map((queryKey) => client.invalidateQueries({ queryKey })),
    );
}

/** Runs a page action, then refreshes what it may have changed. */
function useAction<Input>(name: string, success?: string, plugin: typeof PROVIDER | typeof IOT = PROVIDER) {
  const refresh = useRefresh();
  const toast = studioHost().useToast();
  return useMutation({
    mutationFn: (input: Input) => action(name, input, plugin),
    onSuccess: async () => {
      if (success) toast('success', success);
      await refresh();
    },
    onError: (error: Error) => toast('error', error.message),
  });
}

function useCountdown(until: number | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return until ? Math.max(0, Math.round((until - now) / 1000)) : 0;
}

const formatSeconds = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
const formatTime = (at: number | undefined) => (at ? new Date(at).toLocaleString() : undefined);
const devicePath = (id: string) => `/zdevices/devices/${encodeURIComponent(id)}`;
const deviceIcon = (device: { model?: string }) =>
  device.model === 'Water detector' ? 'droplets' : device.model === 'Power meter' ? 'zap' : 'cpu';

function OnlineChip({ online }: { online: boolean | null }) {
  if (online === null) return <span className="chip">Not heard yet</span>;
  return <span className={online ? 'chip chip-success' : 'chip chip-danger'}>{online ? 'Online' : 'Offline'}</span>;
}

function ZDevicesPage() {
  const { Page } = studioHost();
  const status = useStatus();
  const details = status.data?.status?.details;
  const running = details?.state === 'running';
  const canPair = details?.centrals.some((central) => central.paired && central.online) ?? false;
  const open = useAction<{ seconds?: number }>('permitJoin');
  const stop = useAction<Record<string, never>>('stopJoin');
  const remaining = useCountdown(details?.joinUntil);

  return (
    <Page
      title="Z Devices"
      subtitle="Z Devices reach zflow through the centrals that relay them to an MQTT broker. Once paired, every project can use them with the device steps and widgets, and their readings are kept as history."
      actions={
        running &&
        (remaining > 0 ? (
          <>
            <span className="chip chip-accent">Looking for {formatSeconds(remaining)}</span>
            <button className="button" onClick={() => stop.mutate({})} disabled={stop.isPending}>
              Stop adding devices
            </button>
          </>
        ) : (
          <button
            className="button button-primary"
            title={canPair ? undefined : 'Pair a central and check it is online first'}
            onClick={() => open.mutate({})}
            disabled={open.isPending || !canPair}
          >
            Add devices
          </button>
        ))
      }
    >
      <ServiceCard result={status.data} />
      {details && <CentralsSection centrals={details.centrals} running={running} />}
      {details && (remaining > 0 || details.pairing.length > 0) && (
        <PairingSection pairing={details.pairing} open={remaining > 0} />
      )}
      <DevicesSection running={running} />
    </Page>
  );
}

const SETTINGS_SCHEMA: Record<string, PropertySchema> = {
  enabled: { type: 'boolean', label: 'Service', default: false },
  connection: {
    type: 'enum',
    label: 'MQTT broker',
    description: 'The broker the centrals publish to. Brokers are set up on the MQTT page',
    optionsFrom: 'mqtt.connections',
  },
  historyDays: {
    type: 'number',
    label: 'Keep readings for (days)',
    description: 'Leave empty to keep everything',
  },
};

function ServiceCard({ result }: { result: ServiceResult | undefined }) {
  const { Icon } = studioHost();
  const settings = useQuery({
    queryKey: keys.settings,
    queryFn: async () => (await api<{ settings: Settings }>('GET', `/plugins/${PROVIDER}/settings`)).settings,
  });
  const details = result?.status?.details;
  const error = result && !result.ok ? result.error : (details?.error ?? result?.status?.error);
  const paired = details?.centrals.filter((central) => central.paired).length ?? 0;
  const state =
    details?.state === 'running' ? (
      <span className="chip chip-success">Running</span>
    ) : details?.state === 'failed' ? (
      <span className="chip chip-danger">Failed</span>
    ) : (
      <span className="chip">Off</span>
    );

  return (
    <section className="card" aria-label="Service">
      <div className="card-header">
        <span className="tile">
          <Icon name="radio-tower" size={18} />
        </span>
        <span className="card-title">
          <strong>Service</strong>
          <span className="list-row-meta">
            {details
              ? [
                  paired === 1 ? '1 central' : `${paired} centrals`,
                  details.devices === 1 ? '1 device' : `${details.devices} devices`,
                ].join(' · ')
              : 'Listens to the centrals on one MQTT broker'}
          </span>
        </span>
        {state}
      </div>
      {error && <p className="field-error">{error}</p>}
      {settings.error && <p className="field-error">{settings.error.message}</p>}
      {settings.data && <SettingsEditor key={JSON.stringify(settings.data)} saved={settings.data} />}
    </section>
  );
}

function SettingsEditor({ saved }: { saved: Settings }) {
  const { SettingsForm } = studioHost();
  const client = useQueryClient();
  const toast = studioHost().useToast();
  const [draft, setDraft] = useState<Record<string, unknown>>({ ...saved });
  const [error, setError] = useState<string>();
  const save = useMutation({
    mutationFn: (settings: Record<string, unknown>) => api('PUT', `/plugins/${PROVIDER}/settings`, { settings }),
    onSuccess: () => {
      toast('success', 'Saved');
      return Promise.all(
        [keys.settings, keys.status, keys.devices, ['options']].map((queryKey) => client.invalidateQueries({ queryKey })),
      );
    },
    onError: (failure: Error) => setError(failure.message),
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  studioHost().useLeaveGuard(dirty, 'The Z Devices settings have unsaved changes. Leave anyway?');

  return (
    <>
      <SettingsForm schema={SETTINGS_SCHEMA} values={draft} onChange={setDraft} />
      {error && (
        <div className="issues" role="alert">
          <h3>Fix these before saving</h3>
          <ul>
            {error.split('\n').map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="card-footer">
        {dirty && (
          <button className="button" onClick={() => setDraft({ ...saved })}>
            Discard changes
          </button>
        )}
        <button
          className="button button-primary"
          onClick={() => {
            setError(undefined);
            save.mutate(draft);
          }}
          disabled={!dirty || save.isPending}
        >
          Save
        </button>
      </div>
    </>
  );
}

function CentralsSection({ centrals, running }: { centrals: CentralStatus[]; running: boolean }) {
  const { EmptyState } = studioHost();
  const paired = centrals.filter((central) => central.paired);
  const found = centrals.filter((central) => !central.paired);

  return (
    <section className="section">
      <div className="section-header">
        <h2>Centrals</h2>
      </div>
      <p className="section-intro">
        Every paired central relays every paired device, so more centrals cover more range.
      </p>
      {paired.length === 0 && found.length === 0 && (
        <EmptyState icon="radio-tower" title="No centrals yet">
          {running
            ? "Point a central at the broker above. It shows up here with its first ping, within a minute."
            : 'Turn the service on and pick the broker the centrals publish to.'}
        </EmptyState>
      )}
      {paired.length > 0 && (
        <div className="list">
          {paired.map((central) => (
            <CentralRow key={central.central} central={central} running={running} />
          ))}
        </div>
      )}
      {found.length > 0 && (
        <>
          <h3>Found on the broker</h3>
          <div className="list">
            {found.map((central) => (
              <CentralRow key={central.central} central={central} running={running} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function CentralRow({ central, running }: { central: CentralStatus; running: boolean }) {
  const { Icon, RowActions } = studioHost();
  const pair = useAction<{ central: string }>('pairCentral', `"${central.central}" paired`);
  const unpair = useAction<{ central: string }>('unpairCentral', `"${central.central}" unpaired`);
  const { info } = central;
  const meta = [
    info.firmware && `Firmware ${info.firmware}`,
    info.channel !== undefined && `Channel ${info.channel}`,
    info.ip,
    central.lastPing && `Last ping ${formatTime(central.lastPing)}`,
  ].filter(Boolean);

  return (
    <div className="list-row">
      <span className="tile">
        <Icon name="radio-tower" size={18} />
      </span>
      <span className="list-row-main">
        <strong>{central.central}</strong>
        <span className="list-row-meta">{meta.length > 0 ? meta.join(' · ') : 'Not heard since zflow started'}</span>
      </span>
      {running && <OnlineChip online={central.online} />}
      <RowActions>
        {central.paired ? (
          <button
            className="button button-small button-danger"
            disabled={unpair.isPending}
            onClick={() => {
              if (confirm(`Unpair "${central.central}"? It stops relaying the devices; they stay paired.`)) {
                unpair.mutate({ central: central.central });
              }
            }}
          >
            Unpair
          </button>
        ) : (
          <button
            className="button button-small"
            disabled={pair.isPending || !running}
            onClick={() => pair.mutate({ central: central.central })}
          >
            Pair
          </button>
        )}
      </RowActions>
    </div>
  );
}

function PairingSection({ pairing, open }: { pairing: PairingEntry[]; open: boolean }) {
  const entries = [...pairing].sort((a, b) => b.at - a.at);
  return (
    <section className="section">
      <div className="section-header">
        <h2>New devices</h2>
      </div>
      {entries.length === 0 && (
        <p className="field-help">
          {open
            ? 'Power the device on near a paired central. It shows up here once a central hears its broadcast.'
            : 'No new device was heard.'}
        </p>
      )}
      {entries.length > 0 && (
        <div className="list">
          {entries.map((entry) => (
            <PairingRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </section>
  );
}

function PairingRow({ entry }: { entry: PairingEntry }) {
  const { Icon } = studioHost();
  const [name, setName] = useState(entry.modelName);
  const pair = useAction<{ id: string; name: string }>('pair', `"${name}" paired`);
  const heardBy = entry.heardBy
    .map((heard) => (heard.linkquality !== undefined ? `${heard.central} (${heard.linkquality})` : heard.central))
    .join(', ');

  return (
    <div className="list-row">
      <span className="tile">
        <Icon name={deviceIcon({ model: entry.modelName })} size={18} />
      </span>
      <span className="list-row-main">
        <strong>{entry.modelName}</strong>
        <span className="list-row-meta">
          {[entry.id, entry.properties.join(', '), heardBy && `Heard by ${heardBy}`].filter(Boolean).join(' · ')}
        </span>
      </span>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          pair.mutate({ id: entry.id, name });
        }}
      >
        <input
          className="input"
          aria-label={`Name for ${entry.id}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button className="button button-primary button-small" type="submit" disabled={pair.isPending || !name.trim()}>
          Pair
        </button>
      </form>
    </div>
  );
}

function DevicesSection({ running }: { running: boolean }) {
  const { EmptyState } = studioHost();
  const devices = useDevices();
  return (
    <section className="section">
      <div className="section-header">
        <h2>Devices</h2>
      </div>
      {devices.error && <p className="field-error">{devices.error.message}</p>}
      {devices.isPending && <p className="loading">Loading devices…</p>}
      {devices.data?.length === 0 && (
        <EmptyState icon="cpu" title="No devices yet">
          {running ? 'Use "Add devices" to pair the first one.' : 'Turn the service on to pair devices.'}
        </EmptyState>
      )}
      {devices.data && devices.data.length > 0 && (
        <div className="list">
          {devices.data.map((device) => (
            <DeviceRow key={device.id} device={device} running={running} />
          ))}
        </div>
      )}
    </section>
  );
}

function useDeviceActions(device: DeviceRef) {
  const remove = useAction<{ id: string }>('remove', `"${device.name}" removed`);
  const purge = useAction<{ device: string }>('purge', 'History deleted', IOT);
  return {
    remove: (onDone?: () => void) => {
      const question = `Remove "${device.name}"? Its history is deleted, and automations and widgets using it stop working.`;
      if (confirm(question)) remove.mutate({ id: device.externalId }, { onSuccess: onDone });
    },
    purge: () => {
      if (confirm(`Delete the history of "${device.name}"? Its current state is kept.`)) {
        purge.mutate({ device: device.id });
      }
    },
    pending: remove.isPending || purge.isPending,
  };
}

function DeviceRow({ device, running }: { device: ZDevice; running: boolean }) {
  const { Icon, Link, RowActions } = studioHost();
  const [renaming, setRenaming] = useState(false);
  const actions = useDeviceActions(device);

  return (
    <div className="list-row">
      <span className="tile">
        <Icon name={deviceIcon(device)} size={18} />
      </span>
      <span className="list-row-main">
        {renaming ? (
          <RenameForm device={device} onDone={() => setRenaming(false)} />
        ) : (
          <Link to={devicePath(device.externalId)}>
            <strong>{device.name}</strong>
          </Link>
        )}
        <span className="list-row-meta">
          {[
            device.model,
            device.battery !== undefined && `Battery ${device.battery}%`,
            device.signal !== undefined && `Link ${device.signal}`,
            device.lastSeen !== undefined && `Seen ${formatTime(device.lastSeen)}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      {running && device.online !== null && <OnlineChip online={device.online} />}
      <RowActions>
        <button className="button button-quiet button-small" onClick={() => setRenaming(true)}>
          Rename
        </button>
        <button className="button button-quiet button-small" onClick={actions.purge} disabled={actions.pending}>
          Delete history
        </button>
        <button
          className="button button-quiet button-small button-danger"
          onClick={() => actions.remove()}
          disabled={actions.pending}
        >
          Remove
        </button>
      </RowActions>
    </div>
  );
}

function RenameForm({ device, onDone }: { device: DeviceRef; onDone: () => void }) {
  const [name, setName] = useState(device.name);
  const rename = useAction<{ id: string; name: string }>('rename');
  return (
    <form
      className="inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        rename.mutate({ id: device.externalId, name: name.trim() }, { onSuccess: onDone });
      }}
    >
      <input
        className="input"
        aria-label="Device name"
        value={name}
        autoFocus
        onChange={(event) => setName(event.target.value)}
      />
      <button className="button button-primary button-small" type="submit" disabled={rename.isPending || !name.trim()}>
        Save
      </button>
      <button className="button button-quiet button-small" type="button" onClick={onDone}>
        Cancel
      </button>
    </form>
  );
}

function DevicePage() {
  const { useRoute, Link } = studioHost();
  const { id = '' } = useRoute().params;
  const Shared = studioPart<DevicePageProps>(IOT, 'DevicePage');
  if (!Shared) return <p className="loading">The device page comes from the Devices plugin, which isn't loaded.</p>;
  return (
    <Shared
      device={deviceId(PROVIDER, id)}
      back={{ to: '/zdevices', label: 'Z Devices' }}
      actions={(device) => <DeviceMenu device={device} />}
      sections={{ after: (device) => <ZSections externalId={device.externalId} /> }}
      missing={
        <>
          Pair it again from the <Link to="/zdevices">Z Devices page</Link>.
        </>
      }
    />
  );
}

function DeviceMenu({ device }: { device: Device }) {
  const { Menu, MenuItem, Dialog, useNavigate } = studioHost();
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const actions = useDeviceActions(device);
  return (
    <>
      <Menu label="Device actions">
        <MenuItem icon="pencil" onClick={() => setRenaming(true)}>
          Rename
        </MenuItem>
        <MenuItem icon="eraser" onClick={actions.purge} disabled={actions.pending}>
          Delete history
        </MenuItem>
        <MenuItem
          icon="trash-2"
          danger
          onClick={() => actions.remove(() => navigate('/zdevices'))}
          disabled={actions.pending}
        >
          Remove
        </MenuItem>
      </Menu>
      {renaming && (
        <Dialog title="Rename device" onClose={() => setRenaming(false)}>
          <RenameForm device={device} onDone={() => setRenaming(false)} />
        </Dialog>
      )}
    </>
  );
}

/** What only Z Devices know of a device, below the registry's state and history. */
function ZSections({ externalId }: { externalId: string }) {
  const device = useDevices().data?.find((candidate) => candidate.externalId === externalId);
  if (!device) return null;
  return (
    <>
      <InfoSection device={device} />
      <LinksSection device={device} />
    </>
  );
}

function InfoSection({ device }: { device: ZDevice }) {
  const { details } = device;
  const rows: [string, string | undefined][] = [
    ['Model code', details?.model !== undefined ? `0x${details.model.toString(16).padStart(4, '0')}` : undefined],
    ['Firmware', details?.firmware],
    ['Reports every', details?.reportInterval !== undefined ? `${details.reportInterval} s` : undefined],
    ['Power', details?.batteryPowered === undefined ? undefined : details.batteryPowered ? 'Battery' : 'Mains'],
    ['Last report through', details?.lastCentral],
  ];
  return (
    <section className="section">
      <div className="section-header">
        <h2>Details</h2>
      </div>
      <div className="list">
        {rows
          .filter((row): row is [string, string] => row[1] !== undefined)
          .map(([label, value]) => (
            <div key={label} className="list-row">
              <span className="list-row-main">
                <strong>{label}</strong>
                <span className="list-row-meta">{value}</span>
              </span>
            </div>
          ))}
      </div>
    </section>
  );
}

function LinksSection({ device }: { device: ZDevice }) {
  const { DataTable } = studioHost();
  if (device.links.length === 0) return null;
  const links = [...device.links].sort((a, b) => a.central.localeCompare(b.central));
  return (
    <section className="section">
      <div className="section-header">
        <h2>Centrals</h2>
      </div>
      <p className="section-intro">How each central hears the device. It reports through the first one that answers it.</p>
      <DataTable
        rows={links}
        rowKey={(link) => link.central}
        columns={[
          { label: 'Central', render: (link) => link.central },
          { label: 'Link quality', numeric: true, render: (link) => link.linkquality ?? '—' },
          { label: 'Last heard', render: (link) => formatTime(link.lastSeen) ?? '—' },
        ]}
      />
    </section>
  );
}

/** The service at a glance, linking to the page. */
function ZDevicesOverview() {
  const { SectionActions, Link } = studioHost();
  const status = useStatus();
  const details = status.data?.status?.details;
  const remaining = useCountdown(details?.joinUntil);
  const error = status.error?.message ?? (status.data && !status.data.ok ? status.data.error : details?.error);
  const paired = details?.centrals.filter((central) => central.paired) ?? [];
  const online = paired.filter((central) => central.online).length;

  return (
    <>
      <SectionActions>
        <Link className="button button-small" to="/zdevices">
          Open
        </Link>
      </SectionActions>
      {!details && !error && <p className="loading">Asking the service…</p>}
      {details && (
        <p>
          {details.state === 'running' ? (
            <span className="chip chip-success">Running</span>
          ) : details.state === 'failed' ? (
            <span className="chip chip-danger">Failed</span>
          ) : (
            <span className="chip">Off</span>
          )}{' '}
          {details.devices === 1 ? '1 device' : `${details.devices} devices`}
        </p>
      )}
      {error && <p className="field-error">{error}</p>}
      {details?.state === 'running' && (
        <p className="list-row-meta">
          {paired.length === 0 ? 'No central paired' : `${online} of ${paired.length} centrals online`}
        </p>
      )}
      {details && details.offline > 0 && (
        <p className="list-row-meta">
          {details.offline === 1 ? '1 device is offline' : `${details.offline} devices are offline`}
        </p>
      )}
      {remaining > 0 && <p className="list-row-meta">Looking for devices for {formatSeconds(remaining)}</p>}
    </>
  );
}

export default defineStudioPlugin({
  id: PROVIDER,
  overview: {
    cards: [
      {
        id: 'zdevices.service',
        title: 'Z Devices',
        description: 'Whether the service runs, how many centrals are online and devices offline',
        icon: 'radio-tower',
        order: 115,
        height: 164,
        Component: ZDevicesOverview,
      },
    ],
  },
  navEntries: [
    {
      id: 'zdevices',
      label: 'Z Devices',
      description: 'Sets up the broker, pairs centrals and devices, and shows their state and history',
      icon: 'radio-tower',
      path: '/zdevices',
      order: 56,
    },
  ],
  routes: [
    { path: '/zdevices', Component: ZDevicesPage },
    { path: '/zdevices/devices/:id', Component: DevicePage },
  ],
});
