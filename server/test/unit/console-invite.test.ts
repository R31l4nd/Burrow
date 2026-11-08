import { describe, expect, it } from 'vitest';
import { auditLog } from '../../src/db/schema.js';
import { consoleAdminInvite, openInvite } from '../../src/auth/users.js';
import { makeApp, setupAdmin } from '../helpers.js';

describe('locked out (2026-11-07)', () => {
  it("the console's admin invite makes a new admin account, once, and is in the audit log", async () => {
    const t = await makeApp();
    await setupAdmin(t);
    const invite = consoleAdminInvite(t.ctx);
    expect(invite.role).toBe('admin');
    const token = invite.url!.split('/#/invite/')[1]!;
    expect(invite.url).toBe(`${t.ctx.config.origin}/#/invite/${token}`);
    expect(openInvite(t.ctx, token)).toMatchObject({ role: 'admin', createdBy: null });
    // The page that takes it knows it, as any invite.
    expect((await t.request('GET', `/api/invites/${token}`)).statusCode).toBe(200);
    expect(t.ctx.db.select().from(auditLog).all().filter((r) => r.action === 'invite.create').at(-1)).toMatchObject({ ip: 'console', userId: null });
    await t.close();
  });
});
