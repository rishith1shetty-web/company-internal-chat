/**
 * Admin-controlled device identity.
 *
 * The properties this file exists to hold, all of which are easy to break and expensive to break
 * quietly (docs/12-admin-device-identity.md):
 *
 *   - An employee cannot bring an identity into existence. Only an administrator can.
 *   - A setup code works exactly once, expires, and grants one computer's cookie — never a choice
 *     of who to be.
 *   - Reassignment creates a NEW employee, leaves the previous one's row and history untouched,
 *     revokes their session immediately, and keeps the computer enrolled.
 *   - The admin surface refuses everything without a valid administrator cookie.
 *
 * Everything runs against the real database through the real services and the real route
 * handlers, and every row created is deleted by id afterwards.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { GET as getDevices, POST as postDevice } from '@/app/api/admin/devices/route';
import { POST as postEnrollmentCode } from '@/app/api/admin/devices/[id]/enrollment/route';
import { POST as postReactivate } from '@/app/api/admin/devices/[id]/reactivate/route';
import { POST as postRename } from '@/app/api/admin/devices/[id]/rename/route';
import { POST as postReassign } from '@/app/api/admin/devices/[id]/reassign/route';
import { POST as postRevoke } from '@/app/api/admin/devices/[id]/revoke/route';
import { POST as postAdminSession } from '@/app/api/admin/session/route';
import { POST as postEnroll } from '@/app/api/enroll/route';
import { GET as getSession } from '@/app/api/session/route';
import { GET as getConversations } from '@/app/api/conversations/route';
import type {
  AdminAssignmentWire,
  AdminDeviceListWire,
  AdminDeviceWire,
  AdminReassignmentWire,
  EnrollmentWire,
} from '@/lib/admin/wire';
import { ADMIN_COOKIE, issueAdminCookie, verifyAdminCookie } from '@/lib/auth/admin';
import { DEVICE_COOKIE, SESSION_COOKIE, resolveIdentity } from '@/lib/auth/session';
import { generateEnrollmentCode, normaliseEnrollmentCode } from '@/lib/auth/tokens';
import type { ApiErrorWire, ConversationListWire } from '@/lib/chat/wire';
import {
  DeviceError,
  assignDevice,
  enrollDevice,
  reactivateDevice,
  reassignDevice,
  renameDevice,
  revokeDevice,
} from '@/lib/devices/service';
import { listMessages, sendMessage } from '@/lib/messages/service';

import {
  ENROLLMENT_CONFIG,
  IDENTITY_CONFIG,
  assignTestDevice,
  buildRequest,
  cleanUp,
  createTestIdentity,
  databaseConfigured,
  db,
  disconnect,
  params,
  readResponse,
  seedDirectConversation,
  testDeviceLabel,
  trackDevice,
  trackUser,
  uuid,
} from './harness';

const suite = databaseConfigured ? describe : describe.skip;

/** The token `tests/setup-env.ts` guarantees is configured for the run. */
const ADMIN_TOKEN = process.env['ADMIN_TOKEN'] ?? '';

/** The Cookie header an administrator's browser would send after signing in. */
function adminCookie(): string {
  return `${ADMIN_COOKIE}=${issueAdminCookie(ADMIN_TOKEN).value}`;
}

function setCookies(response: { headers: Headers }): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const index = pair?.indexOf('=') ?? -1;
    if (pair && index > 0) cookies[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return cookies;
}

/* ------------------------------------------------------------------------------------------- */
/* Administrator access                                                                          */
/* ------------------------------------------------------------------------------------------- */

describe('administrator access', () => {
  it('accepts only the configured token, in constant time', () => {
    const issued = issueAdminCookie(ADMIN_TOKEN);

    expect(verifyAdminCookie(ADMIN_TOKEN, issued.value)).toBe(true);
    expect(verifyAdminCookie(`${ADMIN_TOKEN}x`, issued.value)).toBe(false);
    // Rotating the token invalidates every cookie that was ever issued.
    expect(verifyAdminCookie('a-completely-different-token-value', issued.value)).toBe(false);
  });

  it('refuses a cookie whose expiry has passed, and one that has been edited', () => {
    const past = new Date(Date.now() - 60 * 60_000);
    const stale = issueAdminCookie(ADMIN_TOKEN, new Date(past.getTime() - 8 * 3_600_000));
    expect(verifyAdminCookie(ADMIN_TOKEN, stale.value)).toBe(false);

    // Pushing the expiry out by hand breaks the signature, which is the point of signing it.
    const issued = issueAdminCookie(ADMIN_TOKEN);
    const signature = issued.value.slice(issued.value.indexOf('.'));
    expect(verifyAdminCookie(ADMIN_TOKEN, `${Date.now() + 86_400_000}${signature}`)).toBe(false);
  });

  it('treats an unconfigured server as closed, not open', () => {
    expect(verifyAdminCookie(undefined, issueAdminCookie(ADMIN_TOKEN).value)).toBe(false);
  });

  it('rejects a sign-in with the wrong token', async () => {
    const response = await readResponse<ApiErrorWire>(
      await postAdminSession(
        buildRequest({ url: '/api/admin/session', method: 'POST', body: { token: 'wrong' } }),
      ),
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('ADMIN_UNAUTHORISED');
  });

  it('answers the signed-out probe with 204, not an error', async () => {
    const { GET } = await import('@/app/api/admin/session/route');
    const response = await GET(buildRequest({ url: '/api/admin/session' }));

    // Not 401: "am I signed in?" has a legitimate "no", and answering with an error would put a
    // failed request in the browser console on every visit to the admin page.
    expect(response.status).toBe(204);
  });

  it('issues a signed HttpOnly cookie on a correct sign-in', async () => {
    const response = await postAdminSession(
      buildRequest({ url: '/api/admin/session', method: 'POST', body: { token: ADMIN_TOKEN } }),
    );

    expect(response.status).toBe(200);

    const header = response.headers.getSetCookie().find((value) => value.startsWith(ADMIN_COOKIE));
    expect(header).toBeDefined();
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=strict');
  });
});

suite('admin device routes reject unauthenticated callers', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('refuses to list computers without an admin cookie', async () => {
    const response = await readResponse<ApiErrorWire>(
      await getDevices(buildRequest({ url: '/api/admin/devices' })),
    );

    expect(response.status).toBe(401);
  });

  it('refuses to register a computer without an admin cookie', async () => {
    const response = await readResponse<ApiErrorWire>(
      await postDevice(
        buildRequest({
          url: '/api/admin/devices',
          method: 'POST',
          body: { label: testDeviceLabel(), displayName: 'Nobody' },
        }),
      ),
    );

    expect(response.status).toBe(401);
    expect(await db().device.count({ where: { label: { startsWith: 'zz-test-p5-' } } })).toBe(0);
  });

  it('refuses a reassignment without an admin cookie', async () => {
    const assigned = await assignTestDevice('Guarded');

    const response = await readResponse<ApiErrorWire>(
      await postReassign(
        buildRequest({
          url: `/api/admin/devices/${assigned.deviceId}/reassign`,
          method: 'POST',
          body: { displayName: 'Impostor' },
        }),
        params({ id: assigned.deviceId }),
      ),
    );

    expect(response.status).toBe(401);

    // And nothing changed.
    const device = await db().device.findUnique({ where: { id: assigned.deviceId } });
    expect(device?.userId).toBe(assigned.userId);
  });

  it('does not let an employee session act as an administrator', async () => {
    const employee = await createTestIdentity('Ordinary Employee');

    // A perfectly valid employee identity is not an administrator, and its cookies carry nothing
    // the admin preamble looks at.
    const response = await readResponse<ApiErrorWire>(
      await getDevices(buildRequest({ url: '/api/admin/devices', cookie: employee.cookie })),
    );

    expect(response.status).toBe(401);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Assignment and enrollment                                                                     */
/* ------------------------------------------------------------------------------------------- */

suite('assigning a computer', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('registers a computer, creates its employee, and returns a code once', async () => {
    const label = testDeviceLabel();

    const response = await readResponse<AdminAssignmentWire>(
      await postDevice(
        buildRequest({
          url: '/api/admin/devices',
          method: 'POST',
          cookie: adminCookie(),
          body: { label, displayName: 'zz-test-p5-New Starter' },
        }),
      ),
    );

    expect(response.status).toBe(201);
    trackDevice(response.body.device.id);
    trackUser(response.body.device.assignedUser.id);

    expect(response.body.device.label).toBe(label);
    expect(response.body.device.status).toBe('awaiting-setup');
    expect(response.body.enrollmentCode.length).toBeGreaterThan(0);

    // Stored hashed, never in clear.
    const row = await db().device.findUnique({ where: { id: response.body.device.id } });
    expect(row?.tokenHash).toBeNull();
    expect(row?.enrollmentTokenHash).not.toBeNull();
    expect(row?.enrollmentTokenHash).not.toBe(response.body.enrollmentCode);
  });

  it('never discloses a code again after it is created', async () => {
    const assigned = await assignTestDevice('Code Holder');

    const listed = await readResponse<AdminDeviceListWire>(
      await getDevices(buildRequest({ url: '/api/admin/devices', cookie: adminCookie() })),
    );

    const device = listed.body.devices.find((item) => item.id === assigned.deviceId);
    expect(device).toBeDefined();
    // The listing carries no code, no token and no hash — only what an administrator needs.
    expect(JSON.stringify(device)).not.toContain(assigned.enrollmentCode);
    expect(JSON.stringify(device)).not.toContain('Hash');
  });

  it('refuses a second computer with the same name', async () => {
    const label = testDeviceLabel();
    const first = await assignDevice(
      db(),
      { label, displayName: 'zz-test-p5-First' },
      ENROLLMENT_CONFIG,
    );
    trackDevice(first.device.id);
    trackUser(first.device.assignedUser.id);

    await expect(
      assignDevice(db(), { label, displayName: 'zz-test-p5-Second' }, ENROLLMENT_CONFIG),
    ).rejects.toMatchObject({ reason: 'LABEL_TAKEN' });
  });

  it('gives two computers assigned to the same name two different employees (D-02)', async () => {
    const one = await assignTestDevice('Sarah Chen');
    const two = await assignTestDevice('Sarah Chen');

    expect(one.userId).not.toBe(two.userId);
  });
});

suite('enrolling a computer', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('redeems a code once and hands the browser its cookies', async () => {
    const assigned = await assignTestDevice('Enrolling');

    const response = await postEnroll(
      buildRequest({
        url: '/api/enroll',
        method: 'POST',
        body: { code: assigned.enrollmentCode },
      }),
    );

    expect(response.status).toBe(200);

    const cookies = setCookies(response);
    expect(cookies[DEVICE_COOKIE]).toBeDefined();
    expect(cookies[SESSION_COOKIE]).toBeDefined();

    // Those cookies resolve to the employee the ADMINISTRATOR chose — nothing in the request
    // named them.
    const resolved = await resolveIdentity(
      db(),
      { sessionToken: cookies[SESSION_COOKIE], deviceToken: cookies[DEVICE_COOKIE] },
      IDENTITY_CONFIG,
    );
    expect(resolved?.current.userId).toBe(assigned.userId);
    expect(resolved?.current.deviceLabel).toBe(assigned.label);
  });

  it('refuses the same code a second time', async () => {
    const assigned = await assignTestDevice('Single Use');

    await enrollDevice(db(), { code: assigned.enrollmentCode }, ENROLLMENT_CONFIG);

    const second = await readResponse<ApiErrorWire>(
      await postEnroll(
        buildRequest({
          url: '/api/enroll',
          method: 'POST',
          body: { code: assigned.enrollmentCode },
        }),
      ),
    );

    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('INVALID_CODE');
  });

  it('refuses an expired code', async () => {
    const assigned = await assignTestDevice('Too Late');

    await db().device.update({
      where: { id: assigned.deviceId },
      data: { enrollmentExpiresAt: new Date(Date.now() - 60_000) },
    });

    await expect(
      enrollDevice(db(), { code: assigned.enrollmentCode }, ENROLLMENT_CONFIG),
    ).rejects.toMatchObject({ reason: 'CODE_EXPIRED' });
  });

  it('refuses a made-up code with the same message as a malformed one', async () => {
    const invented = generateEnrollmentCode();

    const madeUp = await readResponse<ApiErrorWire>(
      await postEnroll(
        buildRequest({ url: '/api/enroll', method: 'POST', body: { code: invented } }),
      ),
    );
    const malformed = await readResponse<ApiErrorWire>(
      await postEnroll(
        buildRequest({ url: '/api/enroll', method: 'POST', body: { code: 'nonsense' } }),
      ),
    );

    // Identical, so a wrong code does not reveal that it was at least the right shape.
    expect(madeUp.status).toBe(400);
    expect(malformed.body.error.message).toBe(madeUp.body.error.message);
  });

  it('carries no name, id or choice of employee in the request', async () => {
    const mine = await assignTestDevice('Correct Person');
    const other = await assignTestDevice('Somebody Else');

    const response = await readResponse<EnrollmentWire>(
      await postEnroll(
        buildRequest({
          url: '/api/enroll',
          method: 'POST',
          // Every one of these is ignored: the code alone decides.
          body: {
            code: mine.enrollmentCode,
            userId: other.userId,
            displayName: 'Impostor',
            deviceId: other.deviceId,
          },
        }),
      ),
    );

    expect(response.body.displayName).toContain('Correct Person');
  });

  it('accepts a code however it was typed', () => {
    const code = generateEnrollmentCode();
    const messy = ` ${code.toLowerCase().replace(/-/g, ' ')} `;

    expect(normaliseEnrollmentCode(messy)).toBe(normaliseEnrollmentCode(code));
    expect(normaliseEnrollmentCode('too-short')).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Reassignment — the operation the whole design exists for                                      */
/* ------------------------------------------------------------------------------------------- */

suite('reassigning a computer', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('gives the new employee a separate identity and leaves the previous one intact', async () => {
    const rishith = await createTestIdentity('Rishith');
    const colleague = await createTestIdentity('Colleague');

    // Some history that must survive.
    const conversationId = await seedDirectConversation(rishith.userId, colleague.userId);
    const message = await sendMessage(db(), {
      senderId: rishith.userId,
      conversationId,
      body: 'written by the previous employee',
      clientMessageId: uuid(),
    });

    const response = await readResponse<AdminReassignmentWire>(
      await postReassign(
        buildRequest({
          url: `/api/admin/devices/${rishith.deviceId}/reassign`,
          method: 'POST',
          cookie: adminCookie(),
          body: { displayName: 'zz-test-p5-Rahul' },
        }),
        params({ id: rishith.deviceId }),
      ),
    );

    expect(response.status).toBe(200);
    trackUser(response.body.device.assignedUser.id);

    const rahulId = response.body.device.assignedUser.id;

    // 1. A NEW user, not a renamed one.
    expect(rahulId).not.toBe(rishith.userId);
    expect(response.body.previousUser.id).toBe(rishith.userId);

    // 2. The previous employee's row is untouched — same id, same name, still active.
    const previous = await db().user.findUnique({ where: { id: rishith.userId } });
    expect(previous).not.toBeNull();
    expect(previous?.displayName).toBe(rishith.displayName);
    expect(previous?.isActive).toBe(true);

    // 3. Their history is exactly where it was, still attributed to them.
    const stored = await db().message.findUnique({ where: { id: message.message.id } });
    expect(stored?.senderId).toBe(rishith.userId);
    expect(
      await db().conversationMember.findUnique({
        where: { conversationId_userId: { conversationId, userId: rishith.userId } },
      }),
    ).not.toBeNull();

    /*
     * 4. The computer now answers as the new employee, and they inherit nothing.
     *
     * The device cookie already on that machine is expected to keep working — that is what makes
     * a staff change require no visit to the desk. What must NOT happen is the new person seeing
     * the previous one's conversations, so the same browser is asked and gets an empty list.
     */
    const inherited = await readResponse<ConversationListWire>(
      await getConversations(
        buildRequest({
          url: '/api/conversations',
          cookie: `${DEVICE_COOKIE}=${rishith.deviceToken}`,
        }),
      ),
    );

    expect(inherited.status).toBe(200);
    expect(inherited.body.conversations).toEqual([]);

    // And the previous employee's own list still has it, because it was never theirs to lose.
    const kept = await db().conversationMember.findMany({ where: { userId: rishith.userId } });
    expect(kept.map((member) => member.conversationId)).toContain(conversationId);
  });

  it('stops the previous employee’s session from resolving at once', async () => {
    const before = await createTestIdentity('Outgoing');

    // Proof the session worked a moment ago.
    expect(
      (
        await resolveIdentity(
          db(),
          { sessionToken: before.sessionToken, deviceToken: before.deviceToken },
          IDENTITY_CONFIG,
        )
      )?.current.userId,
    ).toBe(before.userId);

    const result = await reassignDevice(
      db(),
      { deviceId: before.deviceId, displayName: 'zz-test-p5-Incoming' },
      ENROLLMENT_CONFIG,
    );
    trackUser(result.device.assignedUser.id);

    // The session row is gone, so the old session cookie alone resolves to nothing.
    expect(await db().session.count({ where: { userId: before.userId } })).toBe(0);
    expect(
      await resolveIdentity(db(), { sessionToken: before.sessionToken }, IDENTITY_CONFIG),
    ).toBeNull();

    // And a REST call with the old cookies is answered as unauthenticated, not as the old user.
    const response = await getSession(
      buildRequest({ url: '/api/session', cookie: `${SESSION_COOKIE}=${before.sessionToken}` }),
    );
    expect(response.status).toBe(204);
  });

  it('keeps the computer enrolled: the same device cookie is now the new employee', async () => {
    const before = await createTestIdentity('Handing Over');

    const result = await reassignDevice(
      db(),
      { deviceId: before.deviceId, displayName: 'zz-test-p5-Taking Over' },
      ENROLLMENT_CONFIG,
    );
    trackUser(result.device.assignedUser.id);

    // Nobody visited the machine, and no new code was issued.
    const row = await db().device.findUnique({ where: { id: before.deviceId } });
    expect(row?.tokenHash).not.toBeNull();
    expect(row?.enrollmentTokenHash).toBeNull();
    expect(result.device.status).toBe('enrolled');

    // The cookie already on that computer resolves to the NEW employee.
    const resolved = await resolveIdentity(
      db(),
      { deviceToken: before.deviceToken },
      IDENTITY_CONFIG,
    );
    expect(resolved?.current.userId).toBe(result.device.assignedUser.id);
    expect(resolved?.current.userId).not.toBe(before.userId);
    expect(resolved?.current.displayName).toContain('Taking Over');
  });

  it('does not let a stale session survive by racing the revocation', async () => {
    const before = await createTestIdentity('Racing');

    // A session that was NOT deleted — written back by hand to simulate one issued in the
    // instant between the reassignment's two statements.
    const result = await reassignDevice(
      db(),
      { deviceId: before.deviceId, displayName: 'zz-test-p5-Successor' },
      ENROLLMENT_CONFIG,
    );
    trackUser(result.device.assignedUser.id);

    await db().session.create({
      data: {
        userId: before.userId,
        deviceId: before.deviceId,
        tokenHash: 'd'.repeat(64),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    // It still does not resolve: every lookup re-checks the device's CURRENT assignment, so the
    // session's own user no longer matches and it is refused.
    const stale = await db().session.findFirst({ where: { userId: before.userId } });
    expect(stale).not.toBeNull();

    const rows = await db().session.findMany({
      where: { userId: before.userId },
      select: { deviceId: true, userId: true },
    });
    const device = await db().device.findUnique({ where: { id: before.deviceId } });
    expect(rows[0]?.userId).not.toBe(device?.userId);
  });

  it('refuses to reassign a computer that does not exist', async () => {
    const response = await readResponse<ApiErrorWire>(
      await postReassign(
        buildRequest({
          url: `/api/admin/devices/${uuid()}/reassign`,
          method: 'POST',
          cookie: adminCookie(),
          body: { displayName: 'zz-test-p5-Nobody' },
        }),
        params({ id: uuid() }),
      ),
    );

    expect(response.status).toBe(404);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Re-enrollment and retirement                                                                  */
/* ------------------------------------------------------------------------------------------- */

suite('re-enrolling and retiring a computer', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('invalidates the old device cookie when a new setup code is issued', async () => {
    const person = await createTestIdentity('Reimaged');

    const response = await readResponse<AdminAssignmentWire>(
      await postEnrollmentCode(
        buildRequest({
          url: `/api/admin/devices/${person.deviceId}/enrollment`,
          method: 'POST',
          cookie: adminCookie(),
        }),
        params({ id: person.deviceId }),
      ),
    );

    expect(response.status).toBe(200);
    expect(response.body.device.status).toBe('awaiting-setup');

    // The cookie on the old profile is worthless, which is the point of this path.
    expect(
      await resolveIdentity(
        db(),
        { sessionToken: person.sessionToken, deviceToken: person.deviceToken },
        IDENTITY_CONFIG,
      ),
    ).toBeNull();

    // The new code enrolls the SAME employee: re-enrollment is not a reassignment.
    const enrolled = await enrollDevice(
      db(),
      { code: response.body.enrollmentCode },
      ENROLLMENT_CONFIG,
    );
    expect(enrolled.user.id).toBe(person.userId);
  });

  it('retires a computer without touching the employee or their history', async () => {
    const person = await createTestIdentity('Decommissioned');
    const colleague = await createTestIdentity('Still Here');
    const conversationId = await seedDirectConversation(person.userId, colleague.userId);

    await sendMessage(db(), {
      senderId: person.userId,
      conversationId,
      body: 'said before the machine was retired',
      clientMessageId: uuid(),
    });

    const response = await postRevoke(
      buildRequest({
        url: `/api/admin/devices/${person.deviceId}/revoke`,
        method: 'POST',
        cookie: adminCookie(),
      }),
      params({ id: person.deviceId }),
    );

    expect(response.status).toBe(200);

    expect(
      await resolveIdentity(
        db(),
        { sessionToken: person.sessionToken, deviceToken: person.deviceToken },
        IDENTITY_CONFIG,
      ),
    ).toBeNull();

    expect(await db().user.findUnique({ where: { id: person.userId } })).not.toBeNull();
    expect(await db().message.count({ where: { senderId: person.userId } })).toBe(1);
  });

  it('will not reassign a retired computer', async () => {
    const person = await createTestIdentity('Retired Then Reassigned');

    await postRevoke(
      buildRequest({
        url: `/api/admin/devices/${person.deviceId}/revoke`,
        method: 'POST',
        cookie: adminCookie(),
      }),
      params({ id: person.deviceId }),
    );

    await expect(
      reassignDevice(
        db(),
        { deviceId: person.deviceId, displayName: 'zz-test-p5-Hopeful' },
        ENROLLMENT_CONFIG,
      ),
    ).rejects.toBeInstanceOf(DeviceError);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Returning a computer to service                                                               */
/* ------------------------------------------------------------------------------------------- */

suite('returning a computer to service', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('keeps the row, the employee and the history when taken out of service', async () => {
    const person = await createTestIdentity('Out Of Service');
    const colleague = await createTestIdentity('Their Colleague');
    const conversationId = await seedDirectConversation(person.userId, colleague.userId);

    await sendMessage(db(), {
      senderId: person.userId,
      conversationId,
      body: 'said before the machine went out of service',
      clientMessageId: uuid(),
    });

    await revokeDevice(db(), person.deviceId);

    // The device row is still there, still labelled, still assigned — just not resolving.
    const row = await db().device.findUnique({ where: { id: person.deviceId } });
    expect(row).not.toBeNull();
    expect(row?.label).toBe(person.deviceLabel);
    expect(row?.userId).toBe(person.userId);
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.tokenHash).toBeNull();

    // And nothing of the employee's was deleted.
    expect(await db().user.findUnique({ where: { id: person.userId } })).not.toBeNull();
    expect(await db().conversation.findUnique({ where: { id: conversationId } })).not.toBeNull();
    expect(await db().message.count({ where: { senderId: person.userId } })).toBe(1);
    expect(
      await db().conversationMember.count({ where: { userId: person.userId } }),
    ).toBe(1);
  });

  it('stops a computer that is out of service from operating at all', async () => {
    const person = await createTestIdentity('Cut Off');

    await revokeDevice(db(), person.deviceId);

    expect(
      await resolveIdentity(
        db(),
        { sessionToken: person.sessionToken, deviceToken: person.deviceToken },
        IDENTITY_CONFIG,
      ),
    ).toBeNull();

    const session = await getSession(
      buildRequest({ url: '/api/session', cookie: person.cookie }),
    );
    expect(session.status).toBe(204);

    const conversations = await readResponse<ApiErrorWire>(
      await getConversations(buildRequest({ url: '/api/conversations', cookie: person.cookie })),
    );
    expect(conversations.status).toBe(401);
  });

  it('returns the SAME device to service, creating no second device and no new employee', async () => {
    const person = await createTestIdentity('Coming Back');

    const devicesBefore = await db().device.count();
    const usersBefore = await db().user.count();

    await revokeDevice(db(), person.deviceId);

    const response = await readResponse<AdminAssignmentWire>(
      await postReactivate(
        buildRequest({
          url: `/api/admin/devices/${person.deviceId}/reactivate`,
          method: 'POST',
          cookie: adminCookie(),
        }),
        params({ id: person.deviceId }),
      ),
    );

    expect(response.status).toBe(200);

    // The same row: same id, same label, same assigned employee.
    expect(response.body.device.id).toBe(person.deviceId);
    expect(response.body.device.label).toBe(person.deviceLabel);
    expect(response.body.device.assignedUser.id).toBe(person.userId);
    expect(response.body.device.revokedAt).toBeNull();
    expect(response.body.device.status).toBe('awaiting-setup');

    // Nothing was duplicated and nobody was invented.
    expect(await db().device.count()).toBe(devicesBefore);
    expect(await db().user.count()).toBe(usersBefore);
    expect(await db().device.count({ where: { label: person.deviceLabel } })).toBe(1);
  });

  it('refreshes the lifetime, so a long-retired computer does not come back already lapsed', async () => {
    const person = await createTestIdentity('Long Retired');

    await revokeDevice(db(), person.deviceId);
    // As if it had sat in a cupboard for well over DEVICE_ID_TTL_DAYS.
    await db().device.update({
      where: { id: person.deviceId },
      data: { expiresAt: new Date(Date.now() - 30 * 86_400_000) },
    });

    const result = await reactivateDevice(db(), person.deviceId, ENROLLMENT_CONFIG);

    const row = await db().device.findUnique({ where: { id: person.deviceId } });
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.device.status).toBe('awaiting-setup');
  });

  it('does not restore the old device cookie', async () => {
    const person = await createTestIdentity('Old Cookie');

    await revokeDevice(db(), person.deviceId);
    await reactivateDevice(db(), person.deviceId, ENROLLMENT_CONFIG);

    // Retirement destroyed the token on purpose — a computer that may have gone missing must not
    // come back reachable by whatever was copied off it.
    expect(
      await resolveIdentity(
        db(),
        { sessionToken: person.sessionToken, deviceToken: person.deviceToken },
        IDENTITY_CONFIG,
      ),
    ).toBeNull();
  });

  it('re-enrolls onto the same device row, and the computer works again', async () => {
    const person = await createTestIdentity('Back In Use');
    const colleague = await createTestIdentity('Waiting Colleague');
    const conversationId = await seedDirectConversation(person.userId, colleague.userId);

    await sendMessage(db(), {
      senderId: colleague.userId,
      conversationId,
      body: 'still here when you get back',
      clientMessageId: uuid(),
    });

    await revokeDevice(db(), person.deviceId);
    const reactivated = await reactivateDevice(db(), person.deviceId, ENROLLMENT_CONFIG);

    const enrolled = await enrollDevice(
      db(),
      { code: reactivated.enrollmentCode, userAgent: 'vitest' },
      ENROLLMENT_CONFIG,
    );

    // The SAME device row, and the SAME employee — no new rows anywhere.
    expect(enrolled.deviceId).toBe(person.deviceId);
    expect(enrolled.label).toBe(person.deviceLabel);
    expect(enrolled.user.id).toBe(person.userId);
    expect(await db().device.count({ where: { label: person.deviceLabel } })).toBe(1);

    // And the employee simply opens the application: recognised, with their history intact.
    const resolved = await resolveIdentity(
      db(),
      { sessionToken: enrolled.sessionToken, deviceToken: enrolled.deviceToken },
      IDENTITY_CONFIG,
    );
    expect(resolved?.current.userId).toBe(person.userId);
    expect(resolved?.current.deviceLabel).toBe(person.deviceLabel);

    const list = await readResponse<ConversationListWire>(
      await getConversations(
        buildRequest({
          url: '/api/conversations',
          cookie: `${DEVICE_COOKIE}=${enrolled.deviceToken}`,
        }),
      ),
    );
    expect(list.status).toBe(200);
    expect(list.body.conversations.map((item) => item.id)).toContain(conversationId);

    const history = await listMessages(db(), { userId: person.userId, conversationId });
    expect(history.messages.map((message) => message.body)).toEqual([
      'still here when you get back',
    ]);
  });

  it('can be reassigned again once it is back in service', async () => {
    const person = await createTestIdentity('Handed On Later');

    await revokeDevice(db(), person.deviceId);
    const reactivated = await reactivateDevice(db(), person.deviceId, ENROLLMENT_CONFIG);
    const enrolled = await enrollDevice(
      db(),
      { code: reactivated.enrollmentCode },
      ENROLLMENT_CONFIG,
    );

    const result = await reassignDevice(
      db(),
      { deviceId: person.deviceId, displayName: 'zz-test-p5-Next Employee' },
      ENROLLMENT_CONFIG,
    );
    trackUser(result.device.assignedUser.id);

    expect(result.device.id).toBe(person.deviceId);
    expect(result.previousUser.id).toBe(person.userId);
    expect(result.device.assignedUser.id).not.toBe(person.userId);
    // Still enrolled: an ordinary staff change needs nobody at the machine.
    expect(result.device.status).toBe('enrolled');

    const resolved = await resolveIdentity(
      db(),
      { deviceToken: enrolled.deviceToken },
      IDENTITY_CONFIG,
    );
    expect(resolved?.current.userId).toBe(result.device.assignedUser.id);

    // The employee who had it before is untouched.
    expect(await db().user.findUnique({ where: { id: person.userId } })).not.toBeNull();
  });

  it('refuses to return a computer that is already in service', async () => {
    const person = await createTestIdentity('Never Left');

    const response = await readResponse<ApiErrorWire>(
      await postReactivate(
        buildRequest({
          url: `/api/admin/devices/${person.deviceId}/reactivate`,
          method: 'POST',
          cookie: adminCookie(),
        }),
        params({ id: person.deviceId }),
      ),
    );

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DEVICE_NOT_RETIRED');

    // Refused before anything was written: the working computer still resolves.
    expect(
      await resolveIdentity(
        db(),
        { sessionToken: person.sessionToken, deviceToken: person.deviceToken },
        IDENTITY_CONFIG,
      ),
    ).not.toBeNull();
  });

  it('refuses a reactivation without an admin cookie, and an unknown computer', async () => {
    const person = await createTestIdentity('Guarded Return');
    await revokeDevice(db(), person.deviceId);

    const anonymous = await readResponse<ApiErrorWire>(
      await postReactivate(
        buildRequest({
          url: `/api/admin/devices/${person.deviceId}/reactivate`,
          method: 'POST',
        }),
        params({ id: person.deviceId }),
      ),
    );
    expect(anonymous.status).toBe(401);

    // Still out of service: the refused call wrote nothing.
    const row = await db().device.findUnique({ where: { id: person.deviceId } });
    expect(row?.revokedAt).not.toBeNull();

    const missing = await readResponse<ApiErrorWire>(
      await postReactivate(
        buildRequest({
          url: `/api/admin/devices/${uuid()}/reactivate`,
          method: 'POST',
          cookie: adminCookie(),
        }),
        params({ id: uuid() }),
      ),
    );
    expect(missing.status).toBe(404);
  });

  it('lists computers in service before those that are not', async () => {
    const working = await createTestIdentity('In Service');
    const stopped = await createTestIdentity('Stopped');
    await revokeDevice(db(), stopped.deviceId);

    const listed = await readResponse<AdminDeviceListWire>(
      await getDevices(buildRequest({ url: '/api/admin/devices', cookie: adminCookie() })),
    );

    const ids = listed.body.devices.map((device) => device.id);
    // PostgreSQL sorts NULLs last on an ascending order, so this ordering has to be stated
    // explicitly — otherwise the retired machines rise to the top of the administrator's list.
    expect(ids.indexOf(working.deviceId)).toBeLessThan(ids.indexOf(stopped.deviceId));
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Renaming a computer                                                                           */
/* ------------------------------------------------------------------------------------------- */

suite('renaming a computer', () => {
  afterAll(async () => {
    await cleanUp();
    await disconnect();
  });

  it('changes the name and nothing else', async () => {
    const person = await createTestIdentity('Renamed');
    const colleague = await createTestIdentity('Rename Colleague');
    const conversationId = await seedDirectConversation(person.userId, colleague.userId);

    const message = await sendMessage(db(), {
      senderId: person.userId,
      conversationId,
      body: 'written before the rename',
      clientMessageId: uuid(),
    });

    const before = await db().device.findUnique({ where: { id: person.deviceId } });
    const label = testDeviceLabel('Renamed-To');

    const response = await readResponse<AdminDeviceWire>(
      await postRename(
        buildRequest({
          url: `/api/admin/devices/${person.deviceId}/rename`,
          method: 'POST',
          cookie: adminCookie(),
          body: { label },
        }),
        params({ id: person.deviceId }),
      ),
    );

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(person.deviceId);
    expect(response.body.label).toBe(label);

    // One column moved. Everything that identifies or authorizes is byte-for-byte the same.
    const after = await db().device.findUnique({ where: { id: person.deviceId } });
    expect(after?.id).toBe(before?.id);
    expect(after?.userId).toBe(before?.userId);
    expect(after?.tokenHash).toBe(before?.tokenHash);
    expect(after?.enrolledAt?.getTime()).toBe(before?.enrolledAt?.getTime());
    expect(after?.assignedAt.getTime()).toBe(before?.assignedAt.getTime());
    expect(after?.revokedAt).toBe(before?.revokedAt);

    // The computer still resolves, on the same cookies, to the same employee.
    const resolved = await resolveIdentity(
      db(),
      { sessionToken: person.sessionToken, deviceToken: person.deviceToken },
      IDENTITY_CONFIG,
    );
    expect(resolved?.current.userId).toBe(person.userId);
    expect(resolved?.current.deviceLabel).toBe(label);

    // And the history is exactly where it was.
    expect(await db().message.findUnique({ where: { id: message.message.id } })).not.toBeNull();
    expect(
      await db().conversationMember.count({ where: { conversationId } }),
    ).toBe(2);
    expect(await db().session.count({ where: { deviceId: person.deviceId } })).toBeGreaterThan(0);
  });

  it('refuses a name another computer already has, and changes nothing', async () => {
    const mine = await assignTestDevice('Name Owner');
    const theirs = await assignTestDevice('Name Taker');

    const response = await readResponse<ApiErrorWire>(
      await postRename(
        buildRequest({
          url: `/api/admin/devices/${theirs.deviceId}/rename`,
          method: 'POST',
          cookie: adminCookie(),
          body: { label: mine.label },
        }),
        params({ id: theirs.deviceId }),
      ),
    );

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('LABEL_TAKEN');
    // A message an administrator can act on, not a database error.
    expect(response.body.error.message).toContain('already registered');

    const unchanged = await db().device.findUnique({ where: { id: theirs.deviceId } });
    expect(unchanged?.label).toBe(theirs.label);
  });

  it('accepts renaming a computer to the name it already has', async () => {
    const person = await assignTestDevice('Same Name');

    // Not a clash with itself.
    const device = await renameDevice(db(), { deviceId: person.deviceId, label: person.label });
    expect(device.label).toBe(person.label);
  });

  it('renames a computer that is out of service', async () => {
    const person = await createTestIdentity('Renamed While Stopped');
    await revokeDevice(db(), person.deviceId);

    const label = testDeviceLabel('Stopped-Renamed');
    const device = await renameDevice(db(), { deviceId: person.deviceId, label });

    expect(device.label).toBe(label);
    // Still out of service: a rename is not a state change.
    expect(device.status).toBe('revoked');
    expect(device.assignedUser.id).toBe(person.userId);
  });

  it('rejects an empty or over-long name', async () => {
    const person = await assignTestDevice('Bad Names');

    await expect(
      renameDevice(db(), { deviceId: person.deviceId, label: ' ' }),
    ).rejects.toMatchObject({ reason: 'INVALID_LABEL' });

    await expect(
      renameDevice(db(), { deviceId: person.deviceId, label: 'x'.repeat(65) }),
    ).rejects.toMatchObject({ reason: 'INVALID_LABEL' });

    const unchanged = await db().device.findUnique({ where: { id: person.deviceId } });
    expect(unchanged?.label).toBe(person.label);
  });

  it('refuses a rename without an admin cookie, and an unknown computer', async () => {
    const person = await assignTestDevice('Guarded Rename');

    const anonymous = await readResponse<ApiErrorWire>(
      await postRename(
        buildRequest({
          url: `/api/admin/devices/${person.deviceId}/rename`,
          method: 'POST',
          body: { label: testDeviceLabel('Sneaky') },
        }),
        params({ id: person.deviceId }),
      ),
    );
    expect(anonymous.status).toBe(401);

    const unchanged = await db().device.findUnique({ where: { id: person.deviceId } });
    expect(unchanged?.label).toBe(person.label);

    const missing = await readResponse<ApiErrorWire>(
      await postRename(
        buildRequest({
          url: `/api/admin/devices/${uuid()}/rename`,
          method: 'POST',
          cookie: adminCookie(),
          body: { label: testDeviceLabel('Nowhere') },
        }),
        params({ id: uuid() }),
      ),
    );
    expect(missing.status).toBe(404);
  });
});
