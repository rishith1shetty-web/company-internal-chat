/**
 * The guards `server.ts` applies before Next.js sees a request (Phase 9).
 *
 * These are matching rules, and matching rules are where a control quietly stops covering what it
 * claims to. So the tests below spend most of their effort on the ways a path can be written to
 * mean `/api/admin` without looking like it, and on the cases where an `Origin` header must NOT be
 * treated as same-origin.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BODY_LIMIT,
  bodyLimitFor,
  guardedEndpointFor,
  isSameOriginWrite,
  isUnsafeMethod,
  normalisePath,
} from '@/lib/http/request-guard';

describe('normalising a request target', () => {
  it('drops the query string and the fragment', () => {
    expect(normalisePath('/api/enroll?code=ABC')).toBe('/api/enroll');
    expect(normalisePath('/api/enroll#x')).toBe('/api/enroll');
  });

  it('percent-decodes, so an encoded path cannot hide from the rules', () => {
    // `/api/%65nroll` is `/api/enroll` to the router. If it were not decoded here, the rate limit
    // would be a rate limit somebody could spell their way around.
    expect(normalisePath('/api/%65nroll')).toBe('/api/enroll');
    expect(normalisePath('/%61pi/admin/session')).toBe('/api/admin/session');
  });

  it('collapses repeated separators and a trailing slash', () => {
    expect(normalisePath('//api//enroll')).toBe('/api/enroll');
    expect(normalisePath('/api/enroll/')).toBe('/api/enroll');
  });

  it('leaves a malformed encoding alone rather than throwing', () => {
    // Attacker-controlled input, not a server error. It matches nothing, which is the safe answer.
    expect(normalisePath('/api/%zz')).toBe('/api/%zz');
  });

  it('treats a missing target as the root', () => {
    expect(normalisePath(undefined)).toBe('/');
  });
});

describe('which methods are guarded', () => {
  it('covers everything that writes', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete']) {
      expect(isUnsafeMethod(method)).toBe(true);
    }
  });

  it('leaves reads alone', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', undefined]) {
      expect(isUnsafeMethod(method)).toBe(false);
    }
  });
});

describe('body size', () => {
  it('bounds every ordinary write', () => {
    expect(bodyLimitFor('POST', '/api/conversations')).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimitFor('DELETE', '/api/conversations/x/members/y')).toBe(DEFAULT_BODY_LIMIT);
  });

  it('does not bound a read, which has no body worth measuring', () => {
    expect(bodyLimitFor('GET', '/api/conversations')).toBeNull();
  });

  it('leaves the file upload to the storage layer, which counts the bytes itself', () => {
    /*
     * The upload body IS a file, up to MAX_FILE_SIZE. Bounding it here would mean either refusing
     * legitimate files or trusting `Content-Length` — a number the sender chose. lib/files/storage.ts
     * counts them as they arrive instead, which is the only measurement that cannot be lied to.
     */
    expect(
      bodyLimitFor('POST', '/api/conversations/2b8e3d02-1f4a-4c7e-9a1b-0d5f6e7a8b9c/attachments'),
    ).toBeNull();
  });

  it('still bounds a path that only looks like the upload route', () => {
    expect(bodyLimitFor('POST', '/api/conversations/x/attachments/extra')).toBe(DEFAULT_BODY_LIMIT);
    expect(bodyLimitFor('POST', '/api/attachments')).toBe(DEFAULT_BODY_LIMIT);
  });

  it('is small enough to matter', () => {
    // A limit larger than the memory it protects is decoration. Every JSON body this application
    // accepts is a short object.
    expect(DEFAULT_BODY_LIMIT).toBeLessThanOrEqual(1024 * 1024);
  });
});

describe('cross-site writes', () => {
  const HOST = 'chat.internal:3000';

  it('accepts a write from this application itself', () => {
    expect(isSameOriginWrite('http://chat.internal:3000', HOST)).toBe(true);
  });

  it('accepts it over either scheme, because the scheme is the proxy’s business', () => {
    // The application is reached over plain HTTP on the LAN today and over HTTPS once a reverse
    // proxy terminates TLS. Both are the same origin as far as `Host` is concerned, and refusing
    // one would break the deployment this phase is preparing for.
    expect(isSameOriginWrite('https://chat.internal:3000', HOST)).toBe(true);
  });

  it('refuses a write announced from another site', () => {
    expect(isSameOriginWrite('http://evil.example', HOST)).toBe(false);
  });

  it('refuses a lookalike host', () => {
    expect(isSameOriginWrite('http://chat.internal.evil.example', HOST)).toBe(false);
    expect(isSameOriginWrite('http://chat.internal:3001', HOST)).toBe(false);
  });

  it('refuses the opaque `null` origin', () => {
    // Sent by a sandboxed iframe and by a `file://` page. Neither is this application.
    expect(isSameOriginWrite('null', HOST)).toBe(false);
  });

  it('refuses an unparsable origin rather than shrugging', () => {
    expect(isSameOriginWrite('not a url', HOST)).toBe(false);
  });

  it('allows a request that carries no Origin at all', () => {
    /*
     * Deliberate, and worth stating because it looks like a hole. A browser attaches `Origin` to
     * exactly the cross-site requests this check exists to catch. A client that sends none — curl,
     * a script, a health check — is not a browser being used against its user, which is the whole
     * of what CSRF describes. Refusing them would break every non-browser caller and stop nothing.
     */
    expect(isSameOriginWrite(undefined, HOST)).toBe(true);
    expect(isSameOriginWrite('', HOST)).toBe(true);
  });

  it('refuses when there is an Origin but no Host to compare it with', () => {
    expect(isSameOriginWrite('http://chat.internal:3000', undefined)).toBe(false);
  });

  it('compares hosts case-insensitively, as a hostname is', () => {
    expect(isSameOriginWrite('http://CHAT.internal:3000', 'chat.INTERNAL:3000')).toBe(true);
  });
});

describe('which endpoints answer a guess at a secret', () => {
  it('finds the administrator sign-in and device enrollment', () => {
    expect(guardedEndpointFor('POST', '/api/admin/session')).toBe('admin-sign-in');
    expect(guardedEndpointFor('POST', '/api/enroll')).toBe('device-enrollment');
  });

  it('recognises them however the path was spelled', () => {
    expect(guardedEndpointFor('POST', normalisePath('/api/enroll/?x=1'))).toBe('device-enrollment');
    expect(guardedEndpointFor('POST', normalisePath('//api//admin//session'))).toBe('admin-sign-in');
    expect(guardedEndpointFor('POST', normalisePath('/api/%65nroll'))).toBe('device-enrollment');
  });

  it('does not throttle the admin sign-in PROBE, which is a question, not a guess', () => {
    // `GET /api/admin/session` answers "are you signed in?" and is called on every visit to the
    // admin page. Counting it would lock an administrator out of their own console.
    expect(guardedEndpointFor('GET', '/api/admin/session')).toBeNull();
    expect(guardedEndpointFor('DELETE', '/api/admin/session')).toBeNull();
  });

  it('leaves ordinary work alone', () => {
    /*
     * Nothing else is throttled, on purpose. Every other endpoint requires an identity a guess
     * cannot produce, so a limit there would spend memory to protect nothing — and would risk
     * throttling somebody sending messages quickly, which is an outage wearing a control's badge.
     */
    for (const path of ['/api/conversations', '/api/users', '/api/session', '/api/admin/devices']) {
      expect(guardedEndpointFor('POST', path)).toBeNull();
    }
  });
});
