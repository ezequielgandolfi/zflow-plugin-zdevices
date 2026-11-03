import { defineComponent, defineRunner } from '@zflow/sdk';
import { PROVIDER } from './catalogue.ts';
import { isCentralId } from './protocol.ts';
import type { CentralEvent, ZDevicesService } from './service.ts';

export const CENTRAL_TRIGGER = 'zdevices.central';

const EVENT_LABELS: Record<CentralEvent['event'], string> = {
  online: 'Central came online',
  offline: 'Central went offline',
  'unknown-device': 'A device not in the project was heard',
};

export const centralRunner = defineRunner({
  type: 'zdevices.central',
  name: 'Z Central',
  description: 'Relays the Z Devices a central hears into the project',
  icon: 'radio-tower',
  triggerType: CENTRAL_TRIGGER,
  bindingLabel: 'Central event',
  configSchema: {
    central: {
      type: 'enum',
      label: 'Central',
      description: 'Centrals show up here once they ping a broker picked on the Z Devices admin page',
      optionsFrom: 'zdevices.centrals',
      required: true,
    },
  },
  bindingSchema: {
    event: {
      type: 'enum',
      label: 'Event',
      default: 'offline',
      options: Object.entries(EVENT_LABELS).map(([value, label]) => ({ value, label })),
    },
  },
  create(ctx) {
    let detach: (() => void) | undefined;
    return {
      start() {
        const central = ctx.config.central;
        if (!isCentralId(central)) throw new Error('Pick the central this integration relays');
        detach = ctx.service<ZDevicesService>(PROVIDER).attach(ctx.project.id, central, {
          emit(event) {
            for (const binding of ctx.bindings) {
              if (binding.config.event !== event.event) continue;
              ctx.logger.info(`${EVENT_LABELS[event.event]} on "${central}": started "${binding.automationName}"`);
              void ctx.runAutomation(binding.automationId, event);
            }
          },
        });
      },
      stop() {
        detach?.();
        detach = undefined;
      },
    };
  },
});

export const centralEvent = defineComponent({
  id: 'zdevices.central-event',
  icon: 'radio-tower',
  name: 'Z Central event',
  description: 'Starts the automation when a central goes online or offline, or hears a device not in the project',
  category: 'Start',
  inputMode: 'none',
  triggerTypes: [CENTRAL_TRIGGER],
  outputs: [{ name: 'ok' }],
  properties: {
    event: { type: 'string', label: 'Event', readOnly: true },
    central: { type: 'string', label: 'Central', readOnly: true },
    device: { type: 'string', label: 'Device', description: 'For unknown devices: its MAC', readOnly: true },
    model: { type: 'string', label: 'Model', description: 'For unknown devices', readOnly: true },
  },
  execute(ctx) {
    const trigger = ctx.trigger as CentralEvent;
    ctx.set('event', trigger.event);
    ctx.set('central', trigger.central);
    if (trigger.event === 'unknown-device') {
      ctx.set('device', trigger.device);
      ctx.set('model', trigger.model);
    }
  },
});
