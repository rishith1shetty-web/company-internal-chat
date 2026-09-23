/**
 * Structural guarantees about global search (Batch 1.6).
 *
 * THESE ARE SOURCE ASSERTIONS, labelled as such deliberately, as in `clipboard-wiring.test.ts`,
 * `sidebar-wiring.test.ts` and `spellcheck-wiring.test.ts`. The project has no DOM test
 * environment by design, so the parts of this batch that live in a rendered tree cannot be driven
 * behaviourally. Everything that CAN be tested properly is: the authorization rules in
 * `search-service.test.ts`, the route in `search-route.test.ts`, and the debounce and race
 * protection in `search-controller.test.ts`.
 *
 * What is left for here is the wiring, and it is mostly about what search must NOT do: no socket
 * event, no notification, no unread change, no schema change, no desktop dependency — and no
 * damage to the sidebar Batch 1.4 shipped three days ago.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SEARCH_DEBOUNCE_MS, SEARCH_MIN_QUERY_LENGTH } from '@/lib/chat/search';
import { SEARCH_MIN_QUERY_LENGTH as SERVER_MIN } from '@/lib/search/service';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function source(path: string): string {
  return readFileSync(new URL(path, `file://${ROOT.replace(/\\/g, '/')}`), 'utf8');
}

/** The file with its comments removed, so "never does X" is a claim about the code. */
function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SERVICE = 'lib/search/service.ts';
const ROUTE = 'app/api/search/route.ts';
const CONTROLLER = 'lib/chat/search.ts';
const RESULTS = 'components/chat/SearchResults.tsx';
const SIDEBAR = 'components/chat/Sidebar.tsx';
const SCHEMA = 'prisma/schema.prisma';

/* -------------------------------------------------------------------------------------------- */
/* 5 — the authorization rule is REUSED, not re-implemented                                       */
/* -------------------------------------------------------------------------------------------- */

describe('search reuses the existing authorization logic', () => {
  const service = code(SERVICE);

  it('derives the visible conversations from the shared membership module', () => {
    /*
     * The single most important structural fact about this feature. A second implementation of
     * "which conversations may this person read" is a second chance to get it wrong, and the
     * weaker of the two is the one that decides.
     */
    expect(service).toContain("from '../authz/membership'");
    expect(service).toContain('listActiveMemberships(db, userId)');
  });

  it('never queries ConversationMember itself to decide access', () => {
    // If it did, `leftAt IS NULL` would be somebody's job to remember here too.
    expect(service).not.toContain('conversationMember.findMany');
    expect(service).not.toContain('conversationMember.findUnique');
  });

  it('applies the D-03 boundary per conversation, not once globally', () => {
    // One OR branch per membership, each carrying its own joinedAt.
    expect(service).toContain('memberships.map');
    expect(service).toContain('createdAt: { gte: membership.joinedAt }');
  });

  it('excludes hidden messages and tombstones in the shared window', () => {
    expect(service).toContain('hiddenFor: { none: { userId } }');
    expect(service).toContain('deletedAt: null');
  });

  it('builds the window ONCE and gives it to both messages and files', () => {
    /*
     * A file must be exactly as reachable as the message that carries it. Two separately written
     * filters would eventually disagree, and the file one is the easier to get wrong — the schema
     * says as much about downloads.
     */
    expect(service).toContain('message: { is: window }');
    expect(service.match(/visibleMessageFilter\(/g)).toHaveLength(2); // definition + one call
  });

  it('reuses the existing directory for people', () => {
    expect(service).toContain("from '../users/directory'");
    expect(service).toContain('listDirectory(db, userId');
  });

  it('bounds every query with a limit', () => {
    // Four categories, four `take`s, all the same constant.
    expect(service.match(/take: SEARCH_CATEGORY_LIMIT/g)).toHaveLength(3); // groups, messages, files
    expect(service).toContain('limit: SEARCH_CATEGORY_LIMIT'); // people, via the directory
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Safe queries                                                                                   */
/* -------------------------------------------------------------------------------------------- */

describe('queries are parameterised and bounded', () => {
  it('uses no raw SQL anywhere in search', () => {
    const service = code(SERVICE);
    for (const forbidden of ['$queryRaw', '$executeRaw', 'Prisma.sql', 'Prisma.raw']) {
      expect(service, forbidden).not.toContain(forbidden);
    }
  });

  it('matches with `contains` and an explicit insensitive mode', () => {
    const service = code(SERVICE);
    expect(service).toContain("mode: 'insensitive'");
    expect(service.match(/contains:/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('escapes LIKE wildcards before matching', () => {
    expect(code(SERVICE)).toContain('escapeLikePattern(query)');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 20, 21, 22 — no realtime, no notifications, no unread                                          */
/* -------------------------------------------------------------------------------------------- */

describe('search touches nothing else in the application', () => {
  it('adds no socket event on the server', () => {
    for (const path of [SERVICE, ROUTE]) {
      const text = code(path);
      for (const forbidden of ['socket', 'emitTo', 'gateway', 'realtime', 'broadcast']) {
        expect(text, `${path}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('adds no socket event on the client', () => {
    for (const path of [CONTROLLER, RESULTS]) {
      expect(code(path), path).not.toContain('socket');
    }
  });

  it('raises no notification and plays no sound', () => {
    for (const path of [SERVICE, ROUTE, CONTROLLER, RESULTS]) {
      const text = code(path);
      for (const forbidden of ['Notification', 'notify', 'playSound', 'notifications/']) {
        expect(text, `${path}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('never writes a read marker or an unread count', () => {
    const service = code(SERVICE);
    for (const forbidden of ['lastReadAt', 'lastReadMessageId', 'markConversationRead', 'unread']) {
      expect(service, forbidden).not.toContain(forbidden);
    }
  });

  it('performs no write of any kind', () => {
    const service = code(SERVICE);
    for (const forbidden of ['.create(', '.update(', '.upsert(', '.delete(', '$transaction']) {
      expect(service, forbidden).not.toContain(forbidden);
    }
  });

  it('is a GET route and nothing else', () => {
    const route = code(ROUTE);
    expect(route).toContain('export async function GET');
    for (const method of ['export async function POST', 'export async function DELETE']) {
      expect(route, method).not.toContain(method);
    }
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Privacy of the query itself                                                                    */
/* -------------------------------------------------------------------------------------------- */

describe('what an employee types is not written down', () => {
  it('the route logs nothing itself', () => {
    /*
     * A search term is as sensitive as the messages it searches. The shared route wrapper already
     * records the method, the path and the outcome, which is what diagnosing this actually needs.
     */
    const route = code(ROUTE);
    expect(route).not.toContain('logger');
    expect(route).not.toContain('console.');
  });

  it('the service logs nothing either', () => {
    const service = code(SERVICE);
    expect(service).not.toContain('logger');
    expect(service).not.toContain('console.');
  });

  it('sends the query to no external service', () => {
    for (const path of [SERVICE, ROUTE, CONTROLLER, RESULTS]) {
      const text = code(path);
      for (const forbidden of ['http://', 'https://', 'openai', 'elastic', 'meili', 'redis']) {
        expect(text, `${path}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 23, 24 — Batch 1.4's sidebar survives                                                          */
/* -------------------------------------------------------------------------------------------- */

describe('the existing sidebar is not regressed', () => {
  const sidebar = source(SIDEBAR);

  it('still renders the GROUPS / CHATS conversation list', () => {
    expect(sidebar).toContain('<ConversationList');
    expect(sidebar).toContain('entries={entries}');
    expect(sidebar).toContain('searchTerm={searchTerm}');
  });

  it('keeps ONE search box, driving both the local filter and the server search', () => {
    expect(sidebar.match(/<SearchField/g)).toHaveLength(1);
  });

  it('renders results BELOW the conversation list, not instead of it', () => {
    expect(sidebar.indexOf('<ConversationList')).toBeLessThan(sidebar.indexOf('<SearchResults'));
  });

  it('renders nothing at all when the search is idle, so clearing restores the sidebar', () => {
    // `status: 'idle'` is what an empty or too-short query produces (search-controller.test.ts).
    expect(source(RESULTS)).toContain("if (state.status === 'idle') return null;");
  });

  it('still has both creation buttons and the heading', () => {
    expect(sidebar).toContain('New chat');
    expect(sidebar).toContain('New group');
    expect(sidebar).toContain('Conversations');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 25-29 — navigation                                                                             */
/* -------------------------------------------------------------------------------------------- */

describe('clicking a result opens the right thing', () => {
  const workspace = source('components/chat/ChatWorkspace.tsx');

  it('a PERSON goes through the existing direct-conversation flow', () => {
    /*
     * Which is what makes a duplicate impossible: that call resolves an existing conversation by
     * `Conversation.directKey`, whose uniqueness is enforced by the database rather than by a
     * check here that could be raced.
     */
    expect(workspace).toContain('session.startDirectConversation(userId)');
  });

  it('a MESSAGE or FILE selects its conversation through the same call as the sidebar', () => {
    expect(workspace).toContain('selectConversation(conversationId)');
  });

  it('a FILE result does not download anything', () => {
    const results = code(RESULTS);
    for (const forbidden of ['download', 'attachments/', 'href=']) {
      expect(results, forbidden).not.toContain(forbidden);
    }
  });

  it('parks the jump until the conversation history has rendered', () => {
    // Rather than guessing at a delay, which is the brittle version of this.
    expect(workspace).toContain('pendingJumpRef');
    expect(workspace).toContain('jumpToMessage(pending.messageId)');
  });

  it('drops a parked jump when the conversation changes', () => {
    // So a jump can never fire into the wrong conversation later.
    expect(workspace).toContain('pending.conversationId !== selectedId');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 30, 31, 32 — clients, desktop and schema                                                       */
/* -------------------------------------------------------------------------------------------- */

describe('standard web, no desktop dependency, no schema change', () => {
  it('uses only standard browser APIs', () => {
    /*
     * `fetch` and `AbortController` are in Chrome, Safari and Chromium alike, so Mac Chrome, Mac
     * Safari and the Windows desktop client all run the same code.
     */
    for (const path of [CONTROLLER, RESULTS, 'lib/chat/useGlobalSearch.ts']) {
      const text = code(path);
      for (const forbidden of ['risingPathDesktop', 'ipcRenderer', 'electron', 'require(']) {
        expect(text, `${path}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('cancels with AbortController, the standard mechanism', () => {
    expect(code(CONTROLLER)).toContain('new AbortController()');
  });

  it('adds no model, field or index to the Prisma schema', () => {
    const schema = source(SCHEMA);
    for (const forbidden of ['model Search', 'searchVector', 'tsvector', 'pg_trgm', 'GIN']) {
      expect(schema, forbidden).not.toContain(forbidden);
    }
  });

  it('SEARCH adds no model of its own to the schema', () => {
    /*
     * The list is the whole schema, so it moves when a LATER batch legitimately adds a model —
     * Batch 1.7 added `MessageMention`, which is asserted in its own wiring test. What this
     * assertion is for is narrower and still exactly true: nothing search-shaped is in here.
     * A `SearchIndex`, a `MessageSearch` or a materialised view would fail it.
     */
    const models = [...source(SCHEMA).matchAll(/^model (\w+)/gm)].map((match) => match[1]);

    expect(models).toEqual([
      'User',
      'Session',
      'Device',
      'Conversation',
      'ConversationMember',
      'Message',
      'Attachment',
      'MessageReaction',
      'MessageMention',
      'MessageHide',
    ]);
    expect(models.filter((name) => /search|index/i.test(name ?? ''))).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Client and server agree                                                                        */
/* -------------------------------------------------------------------------------------------- */

describe('the client and the server agree about the rules', () => {
  it('use the same minimum query length', () => {
    /*
     * The client checks first so a short query costs no request; the server checks anyway because
     * a client's restraint is not an access control. They must agree, or one of them is wrong
     * about when a search is allowed to happen.
     */
    expect(SEARCH_MIN_QUERY_LENGTH).toBe(SERVER_MIN);
  });

  it('debounce is stated, and is the value the brief asked for', () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(300);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Accessibility                                                                                  */
/* -------------------------------------------------------------------------------------------- */

describe('search results are usable from the keyboard', () => {
  const results = source(RESULTS);

  it('every result is a real button', () => {
    // Focusable, in the tab order, and activated by Enter and Space without a key handler.
    expect(results).toContain('<button');
    expect(results).toContain('type="button"');
    expect(results).not.toMatch(/<div[^>]*\sonClick=/);
  });

  it('has a visible focus ring, like every other row in the sidebar', () => {
    expect(results).toContain('focus-visible:outline');
  });

  it('announces the outcome once, politely', () => {
    expect(results).toContain('aria-live="polite"');
  });

  it('labels the region and each category with real headings', () => {
    expect(results).toContain('aria-labelledby="search-results-heading"');
    expect(results).toContain('<h4');
  });

  it('the search box says it searches more than conversations now', () => {
    expect(source(SIDEBAR)).toContain('label="Search messages, files, people and conversations"');
  });

  it('Escape clears the box', () => {
    expect(source(SIDEBAR)).toContain("event.key === 'Escape'");
  });
});
