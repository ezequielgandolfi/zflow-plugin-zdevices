import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { defineStudioPlugin, studioHost } from '@zflow/studio-sdk';
import { useState, type FormEvent } from 'react';
import { PROVIDER, Z_DEVICE_TYPES } from './device-types.ts';
import type { ZDevice } from './store.ts';

interface DeviceForm {
  id: string;
  name: string;
  typeId: number;
}

async function action<T>(name: string, input: unknown): Promise<T> {
  const response = await fetch(`/api/plugins/${PROVIDER}/actions/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input }),
  });
  const data = (await response.json().catch(() => undefined)) as
    { result?: T; issues?: string[]; error?: string } | undefined;
  if (!response.ok)
    throw new Error(data?.issues?.join('\n') ?? data?.error ?? `The server answered ${response.status}`);
  return data?.result as T;
}

const emptyForm = (): DeviceForm => ({ id: '', name: '', typeId: Z_DEVICE_TYPES[0]!.id });

function ProjectZDevices({ projectId }: { projectId: string }) {
  const { Icon, EmptyState, SectionActions, useToast } = studioHost();
  const toast = useToast();
  const queryClient = useQueryClient();
  // null: no form open; `editing` holds the id of the device being edited.
  const [form, setForm] = useState<DeviceForm | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const devicesKey = ['zdevices', 'devices', projectId];
  const devices = useQuery({
    queryKey: devicesKey,
    queryFn: () => action<ZDevice[]>('list', { projectId }),
    refetchInterval: 10_000,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: devicesKey });
    void queryClient.invalidateQueries({ queryKey: ['iot', 'devices', projectId] });
  };
  const close = () => {
    setForm(null);
    setEditing(null);
  };

  const save = useMutation({
    mutationFn: (values: DeviceForm) => action(editing ? 'update' : 'create', { projectId, ...values }),
    onSuccess: () => {
      toast('success', editing ? 'Device saved' : 'Device added');
      close();
      refresh();
    },
    onError: (error) => toast('error', error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => action('remove', { projectId, id }),
    onSuccess: () => {
      toast('success', 'Device removed');
      refresh();
    },
    onError: (error) => toast('error', error.message),
  });

  const startEdit = (device: ZDevice) => {
    setEditing(device.id);
    setForm({ id: device.id, name: device.name, typeId: device.typeId ?? Z_DEVICE_TYPES[0]!.id });
  };
  const confirmRemove = (device: ZDevice) => {
    if (window.confirm(`Remove "${device.name}" from this project?`)) remove.mutate(device.id);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (form) save.mutate(form);
  };

  return (
    <>
      <SectionActions>
        {!form && (
          <button className="button button-primary button-small" type="button" onClick={() => setForm(emptyForm())}>
            Add device
          </button>
        )}
      </SectionActions>
      <p className="section-intro">
        Z Devices of this project. They join the device registry, so steps and widgets can read them.
      </p>
      {form && (
        <form className="inline-form" onSubmit={submit}>
          <div className="field">
            <label className="field-label" htmlFor="zdevices-id">
              Device id
            </label>
            <input
              id="zdevices-id"
              className="input input-code"
              placeholder="MAC address, e.g. a0:b7:65:12:34:56"
              value={form.id}
              disabled={editing !== null}
              onChange={(event) => setForm({ ...form, id: event.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="zdevices-name">
              Name
            </label>
            <input
              id="zdevices-name"
              className="input"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="zdevices-type">
              Type
            </label>
            <select
              id="zdevices-type"
              className="input"
              value={form.typeId}
              onChange={(event) => setForm({ ...form, typeId: Number(event.target.value) })}
            >
              {Z_DEVICE_TYPES.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          </div>
          <div className="row-actions">
            <button
              className="button button-primary button-small"
              type="submit"
              disabled={save.isPending || !form.id.trim() || !form.name.trim()}
            >
              {editing ? 'Save' : 'Add'}
            </button>
            <button className="button button-small" type="button" onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {devices.error && <p className="field-error">{devices.error.message}</p>}
      {devices.data?.length === 0 && !form && (
        <EmptyState icon="cpu" title="No Z Devices yet">
          Add the boards of this project by their id.
        </EmptyState>
      )}
      {devices.data && devices.data.length > 0 && (
        <div className="list">
          {devices.data.map((device) => (
            <div key={device.id} className="list-row">
              <Icon name="cpu" />
              <div className="list-row-main">
                <strong>
                  {device.name}{' '}
                  {device.online !== null && (
                    <span className={device.online ? 'chip chip-success' : 'chip chip-warning'}>
                      {device.online ? 'Online' : 'Offline'}
                    </span>
                  )}
                </strong>
                <span className="list-row-meta">
                  {[device.typeName, device.id, device.sensors.join(', ')].filter(Boolean).join(' · ')}
                </span>
              </div>
              <div className="row-actions">
                <button className="button button-quiet button-small" type="button" onClick={() => startEdit(device)}>
                  Edit
                </button>
                <button
                  className="button button-quiet button-small button-danger"
                  type="button"
                  disabled={remove.isPending}
                  onClick={() => confirmRemove(device)}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
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
        description: 'Adds, edits and removes the Z Devices of the project',
        icon: 'cpu',
        Component: ProjectZDevices,
      },
    ],
  },
});
