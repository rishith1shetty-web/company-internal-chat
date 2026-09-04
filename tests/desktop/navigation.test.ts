/**
 * Where the desktop window is allowed to go.
 *
 * The rules being protected here are not equal in weight, and the file is written to keep that
 * distinction visible:
 *
 *   - Refusing another origin and refusing a non-http scheme are REAL containment properties.
 *     Nothing else in the system can enforce them, and getting one wrong turns a chat client into
 *     a way to render arbitrary content — or a file off the employee's own disk — inside a window
 *     that looks like a company application.
 *
 *   - Refusing /admin is a product boundary. `/api/admin/*` refuses without a valid admin cookie
 *     whatever asks it, so no privilege turns on the tests below. They protect the employee from
 *     landing on a page they cannot use, not the administration surface from the employee.
 */

import { describe, expect, it } from 'vitest';

import {
  decideNavigation,
  fallbackPathFor,
  isAdminPath,
  isSafeExternalUrl,
} from '@/desktop/navigation';

const SERVER = 'http://192.0.2.10:3000';
const OFFLINE_FILE = 'file:///C:/Program%20Files/Chat/dist-desktop/offline.html';

/** Shorthand: the action alone, which is what most of these assertions are about. */
const act = (target: string, origin = SERVER) => decideNavigation(target, origin, OFFLINE_FILE).action;

describe('the employee’s own application', () => {
  it('allows the chat interface', () => {
    expect(act(`${SERVER}/`)).toBe('allow');
    expect(act(SERVER)).toBe('allow');
  });

  it('allows enrollment, which is how a new computer is set up at all', () => {
    // §8: an unenrolled client has to be able to reach /setup, or an administrator cannot
    // complete the one-time enrollment on the employee's machine.
    expect(act(`${SERVER}/setup`)).toBe('allow');
    expect(act(`${SERVER}/setup?code=ABCD-1234`)).toBe('allow');
  });

  it('allows the ordinary chat APIs, uploads and downloads', () => {
    expect(act(`${SERVER}/api/session`)).toBe('allow');
    expect(act(`${SERVER}/api/conversations`)).toBe('allow');
    expect(act(`${SERVER}/api/conversations/c1/attachments`)).toBe('allow');
    expect(act(`${SERVER}/api/attachments/a1/download`)).toBe('allow');
    expect(act(`${SERVER}/socket.io/?EIO=4&transport=websocket`)).toBe('allow');
  });

  it('allows the brand assets and the notification sound', () => {
    expect(act(`${SERVER}/brand/rising-path-mark.png`)).toBe('allow');
    expect(act(`${SERVER}/sounds/notification.wav`)).toBe('allow');
  });

  it('allows its own offline page, which is a file: URL it loaded itself', () => {
    expect(act(OFFLINE_FILE)).toBe('allow');
  });
});

describe('administration is not in the employee client', () => {
  it('blocks the console and its API', () => {
    for (const path of ['/admin', '/admin/', '/admin/devices', '/api/admin', '/api/admin/devices']) {
      const decision = decideNavigation(`${SERVER}${path}`, SERVER, OFFLINE_FILE);
      expect(decision.action, path).toBe('block');
      expect(decision.reason, path).toBe('admin');
    }
  });

  it('blocks it however the path is written', () => {
    /*
     * Percent-encoding and Windows separators are both decoded or normalised somewhere between a
     * link and the server, so a check that compared raw strings would wave these through. This is
     * the case a path filter is usually defeated by.
     */
    expect(act(`${SERVER}/%61dmin`)).toBe('block');
    expect(act(`${SERVER}/ADMIN/devices`)).toBe('block');
    expect(act(`${SERVER}//admin`)).toBe('block');
    expect(act(`${SERVER}/admin%2Fdevices`)).toBe('block');
    expect(act(`${SERVER}/api/%61dmin/devices`)).toBe('block');
  });

  it('blocks a malformed encoding rather than trying to interpret it', () => {
    // `%zz` cannot be decoded. Something that will not parse is not something to wave through.
    expect(isAdminPath('/%zz')).toBe(true);
  });

  it('does not block a path that merely begins with the same letters', () => {
    // A filter that matched on prefix alone would refuse this, and refusing real pages is how a
    // rule like this gets removed later.
    expect(isAdminPath('/administration-policy')).toBe(false);
    expect(isAdminPath('/admins-only-group')).toBe(false);
    expect(act(`${SERVER}/api/administrivia`)).toBe('allow');
  });

  it('sends the employee back to chat rather than to enrollment', () => {
    // A client that reached /admin already has an identity; bouncing it to /setup would be
    // alarming and wrong.
    expect(fallbackPathFor('admin')).toBe('/');
  });
});

describe('other origins', () => {
  it('hands an ordinary web address to the default browser', () => {
    expect(act('https://example.com/help')).toBe('external');
    expect(act('http://intranet.example.local/policy.pdf')).toBe('external');
  });

  it('treats a different port on the same host as a different origin', () => {
    // It is: a service on another port is another service, and it is not this one.
    expect(act('http://192.0.2.10:3001/')).toBe('external');
  });

  it('treats http and https on the same host as different origins', () => {
    expect(act('https://192.0.2.10:3000/')).toBe('external');
  });

  it('is not fooled by an address that merely starts with the server’s', () => {
    /*
     * Both of these begin with the configured origin as a string, and a prefix comparison would
     * let either of them load. Neither is allowed here, though they fail differently and it is
     * worth being precise about which is which:
     *
     *   `...:3000@evil.test`  parses, with `192.0.2.10:3000` as userinfo and `evil.test` as the
     *                         host. A different origin, so it goes to the default browser.
     *   `...:3000.evil.test`  does not parse at all — `3000.evil.test` is not a port — so it is
     *                         refused outright rather than guessed at.
     */
    expect(act('http://192.0.2.10:3000@evil.test/')).toBe('external');

    const lookalike = decideNavigation('http://192.0.2.10:3000.evil.test/', SERVER, OFFLINE_FILE);
    expect(lookalike.action).toBe('block');
    expect(lookalike.reason).toBe('malformed');
  });

  it('does not route an admin path on another origin back to chat', () => {
    // It is somebody else's /admin. Not ours to interpret — it is simply not this application.
    expect(act('https://example.com/admin')).toBe('external');
  });
});

describe('schemes that are not the web', () => {
  it('blocks every one of them', () => {
    const dangerous = [
      'javascript:alert(document.cookie)',
      'data:text/html,<script>fetch("/api/session")</script>',
      'file:///C:/Windows/System32/drivers/etc/hosts',
      'file:///C:/Users/employee/Documents/private.docx',
      'blob:http://192.0.2.10:3000/8f2b',
      'ms-settings:windowsupdate',
      'vbscript:msgbox(1)',
      'ftp://192.0.2.10/files',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
    ];

    for (const target of dangerous) {
      const decision = decideNavigation(target, SERVER, OFFLINE_FILE);
      expect(decision.action, target).toBe('block');
      expect(decision.reason, target).toBe('scheme');
    }
  });

  it('blocks a file: URL that is not our own offline page', () => {
    /*
     * The offline page is compared in full, not by scheme. Allowing file: as a class would mean
     * any document on the employee's disk could be rendered inside the application window — the
     * exact hole the scheme rule exists to close.
     */
    expect(act('file:///C:/Program%20Files/Chat/dist-desktop/../../secrets.html')).toBe('block');
    expect(act('file:///C:/Program%20Files/Chat/dist-desktop/offline.html.txt')).toBe('block');
  });

  it('blocks something that is not a URL at all', () => {
    for (const target of ['', 'not a url', '://missing-scheme', 'http://']) {
      expect(act(target), target).toBe('block');
    }
  });
});

describe('handing a link to Windows', () => {
  /*
   * A separate allow-list from the navigation decision, and deliberately stricter, because this
   * one ends in `shell.openExternal` — a string handed to the operating system. Windows will
   * launch a registered handler for a custom scheme, which is a way to start a program from a
   * link somebody sent in a chat message.
   */
  it('accepts web addresses', () => {
    expect(isSafeExternalUrl('https://example.com')).toBe(true);
    expect(isSafeExternalUrl('http://intranet.example.local:8080/x')).toBe(true);
  });

  it('refuses everything else', () => {
    for (const target of [
      'file:///C:/Windows/System32/cmd.exe',
      'javascript:alert(1)',
      'ms-msdt:/id',
      'steam://run/1',
      'mailto:someone@example.com',
      'not a url',
      '',
    ]) {
      expect(isSafeExternalUrl(target), target).toBe(false);
    }
  });
});

describe('when the server address was never configured', () => {
  it('refuses to treat an empty origin as a match for anything', () => {
    /*
     * `new URL('...').origin` is the string 'null' for opaque origins and never the empty string,
     * so an unconfigured client allows nothing rather than allowing everything — which is the
     * direction this particular mistake has to fail in.
     */
    expect(decideNavigation('http://anywhere.test/', '').action).toBe('external');
    expect(decideNavigation('file:///C:/secrets.txt', '').action).toBe('block');
  });
});
