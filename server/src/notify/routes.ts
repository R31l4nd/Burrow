import type { FastifyInstance } from 'fastify';
import { channelInput, pushDeviceInput, type Channel, type PushDevice } from '@burrow/shared';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import { actor, HttpError, idParam, noContent, parse, requireAuth } from '../http.js';
import { deleteChannel, listChannels, saveChannel, type Notifier } from './channels.js';
import { addPushDevice, listPushDevices, removePushDevice, vapidPublicKey } from './push.js';

// Notification channels: list, add, change, remove, and a test message.
// And the devices of the signed-in person that get Burrow's own push.

export function registerChannelRoutes(app: FastifyInstance, ctx: Ctx, notifier: Notifier): void {
  app.get('/api/channels', async (): Promise<Channel[]> => listChannels(ctx));

  // Where alerts and their secrets go: changed only after a fresh step-up (A3-SRV-07).
  app.post('/api/channels', { config: { stepUp: true } }, async (req): Promise<Channel> => {
    const b = parse(channelInput, req.body);
    const c = saveChannel(ctx, b);
    audit(ctx, actor(req), 'channel.create', c.name, { kind: c.kind, topics: c.topics });
    return c;
  });

  app.put('/api/channels/:id', { config: { stepUp: true } }, async (req): Promise<Channel> => {
    const b = parse(channelInput, req.body);
    const c = saveChannel(ctx, b, idParam(req));
    audit(ctx, actor(req), 'channel.update', c.name, { kind: c.kind, topics: c.topics, enabled: c.enabled });
    return c;
  });

  app.delete('/api/channels/:id', { config: { stepUp: true } }, async (req, reply) => {
    const c = deleteChannel(ctx, idParam(req));
    audit(ctx, actor(req), 'channel.delete', c.name, { kind: c.kind });
    return noContent(reply);
  });

  app.post('/api/channels/:id/test', async (req) => {
    const id = idParam(req);
    const r = await notifier.notify(
      {
        topic: 'test',
        title: 'Burrow test',
        body: 'Notifications from Burrow arrive here.',
        page: '/settings?s=channels',
        priority: 3,
        nl: { title: 'Burrow-test', body: 'Meldingen van Burrow komen hier aan.' },
      },
      id,
    );
    if (r.failed.length) throw new HttpError(502, 'send_failed', r.failed[0]!.error);
    // Sent to none (the channel is gone) is no test that went well (AUDIT2 MON-26).
    if (!r.sent) throw new HttpError(404, 'not_found', 'No such channel.');
    return { ok: true };
  });

  // ---- this person's devices for Burrow's own push (any signed-in user)

  app.get('/api/push/key', { config: { auth: 'user' } }, async () => ({ publicKey: vapidPublicKey(ctx) }));

  app.get('/api/push/devices', { config: { auth: 'user' } }, async (req): Promise<PushDevice[]> => listPushDevices(ctx, requireAuth(req).user.id));

  app.post('/api/push/devices', { config: { auth: 'user' } }, async (req): Promise<PushDevice> => {
    const d = addPushDevice(ctx, requireAuth(req).user.id, parse(pushDeviceInput, req.body));
    audit(ctx, actor(req), 'push.device.add', d.label, { kind: d.kind });
    return d;
  });

  app.delete('/api/push/devices/:id', { config: { auth: 'user' } }, async (req, reply) => {
    const d = removePushDevice(ctx, requireAuth(req).user.id, idParam(req));
    audit(ctx, actor(req), 'push.device.remove', d.label, { kind: d.kind });
    return noContent(reply);
  });

  app.post('/api/push/test', { config: { auth: 'user' } }, async (req) => {
    const r = await notifier.pushTo(requireAuth(req).user.id, {
      topic: 'test',
      title: 'Burrow test',
      body: 'Notifications from Burrow arrive on this device.',
      page: '/settings?s=channels',
      priority: 3,
      nl: { title: 'Burrow-test', body: 'Meldingen van Burrow komen op dit apparaat aan.' },
    });
    if (!r.total) throw new HttpError(409, 'no_devices', 'No device of yours has notifications on.');
    if (!r.ok) throw new HttpError(502, 'send_failed', r.errors[0] ?? 'not sent');
    return { sent: r.ok, failed: r.errors };
  });
}
