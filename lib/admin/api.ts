'use client';

/**
 * The admin console's view of the admin API.
 *
 * A separate module from `lib/chat/api.ts` on purpose: the two have different audiences and
 * different trust levels, and a shared client would make it easy to call an admin endpoint from
 * the employee interface by reaching for the nearest helper.
 *
 * Like the employee client, this sends no identity of its own. The admin cookie is `HttpOnly`;
 * the only place a token is ever transmitted is `signIn`, which exchanges it for that cookie.
 */

import type {
  AdminAssignmentWire,
  AdminDeviceListWire,
  AdminDeviceWire,
  AdminReassignmentWire,
  AdminSessionWire,
  EnrollmentWire,
} from '@/lib/admin/wire';
import { ApiError } from '@/lib/chat/api';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(input, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection.');
  }

  if (response.status === 204) return undefined as T;

  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const error = (body as { error?: { code: string; message: string } } | undefined)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? 'Something went wrong. Please try again.',
    );
  }

  return body as T;
}

/* ------------------------------------------------------------------------------------------- */
/* Administrator session                                                                         */
/* ------------------------------------------------------------------------------------------- */

/**
 * Does this browser already hold a valid admin cookie?
 *
 * The endpoint answers 204 for "no", so not being signed in is an ordinary answer rather than an
 * error, and the admin page loads without putting a failed request in the browser console.
 */
export async function fetchAdminSession(): Promise<boolean> {
  const session = await request<AdminSessionWire | undefined>('/api/admin/session');
  return session?.administrator === true;
}

/** The one call that carries the token. Everything after it uses the cookie. */
export function adminSignIn(token: string): Promise<AdminSessionWire> {
  return request<AdminSessionWire>('/api/admin/session', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ token }),
  });
}

export function adminSignOut(): Promise<void> {
  return request<void>('/api/admin/session', { method: 'DELETE' });
}

/* ------------------------------------------------------------------------------------------- */
/* Devices                                                                                       */
/* ------------------------------------------------------------------------------------------- */

export function fetchDevices(): Promise<AdminDeviceListWire> {
  return request<AdminDeviceListWire>('/api/admin/devices');
}

export function registerDevice(
  label: string,
  displayName: string,
): Promise<AdminAssignmentWire> {
  return request<AdminAssignmentWire>('/api/admin/devices', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ label, displayName }),
  });
}

/** Hands a computer to a different employee. Creates a new user; never renames the old one. */
export function reassignDevice(
  deviceId: string,
  displayName: string,
): Promise<AdminReassignmentWire> {
  return request<AdminReassignmentWire>(
    `/api/admin/devices/${encodeURIComponent(deviceId)}/reassign`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ displayName }) },
  );
}

/** Only for a computer whose browser identity was lost. Not part of a staff change. */
export function reissueEnrollmentCode(deviceId: string): Promise<AdminAssignmentWire> {
  return request<AdminAssignmentWire>(
    `/api/admin/devices/${encodeURIComponent(deviceId)}/enrollment`,
    { method: 'POST' },
  );
}

/**
 * Changes the administrator's name for a computer.
 *
 * Writes one column. Works in or out of service, and never moves an assignment or any history.
 */
export function renameDevice(deviceId: string, label: string): Promise<AdminDeviceWire> {
  return request<AdminDeviceWire>(
    `/api/admin/devices/${encodeURIComponent(deviceId)}/rename`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ label }) },
  );
}

/** Takes a computer out of service. Reversible with `reactivateDevice`. */
export function revokeDevice(deviceId: string): Promise<AdminDeviceWire> {
  return request<AdminDeviceWire>(
    `/api/admin/devices/${encodeURIComponent(deviceId)}/revoke`,
    { method: 'POST' },
  );
}

/**
 * Brings a retired computer back into service.
 *
 * Acts on the same `Device` row — same id, same label, same assigned employee — and returns a
 * fresh one-time setup code, because retirement destroyed the old device cookie on purpose.
 */
export function reactivateDevice(deviceId: string): Promise<AdminAssignmentWire> {
  return request<AdminAssignmentWire>(
    `/api/admin/devices/${encodeURIComponent(deviceId)}/reactivate`,
    { method: 'POST' },
  );
}

/* ------------------------------------------------------------------------------------------- */
/* Enrollment, run on the company computer itself                                                */
/* ------------------------------------------------------------------------------------------- */

export function redeemEnrollmentCode(code: string): Promise<EnrollmentWire> {
  return request<EnrollmentWire>('/api/enroll', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ code }),
  });
}
