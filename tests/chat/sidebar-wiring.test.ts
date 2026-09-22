/**
 * Structural guarantees about the GROUPS / CHATS sidebar that a Node test cannot demonstrate
 * behaviourally (Batch 1.4).
 *
 * THESE ARE SOURCE ASSERTIONS, labelled as such deliberately, exactly as in
 * `clipboard-wiring.test.ts`. The project has no DOM test environment by design, so the
 * accessibility and no-regression requirements of this batch cannot be driven through a rendered
 * tree. They are not unverifiable: each one below is a property of the source that would have to
 * be broken deliberately, and a regression in any of them fails this file.
 *
 * The rules themselves — classification, ordering, collapse resolution, persistence — are pure and
 * are tested properly in `sidebar-sections.test.ts`. What is left for here is the wiring:
 *
 *   - the header is a real button with real button semantics, so the keyboard works for free;
 *   - `aria-expanded` actually tracks the open state rather than being pinned to a constant;
 *   - a conversation row still renders everything it rendered before this batch;
 *   - the sidebar is presentation over existing data — no new socket event, no schema change.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function source(path: string): string {
  return readFileSync(new URL(path, `file://${ROOT.replace(/\\/g, '/')}`), 'utf8');
}

/**
 * The same file with its comments removed.
 *
 * An assertion that a module "never mentions X" is a claim about the CODE, and this file's own
 * prose kept tripping it — the note explaining that classification ignores the counterpart is not
 * the same thing as classifying by the counterpart. Stripping comments first makes each assertion
 * mean what it says instead of quietly depending on how the module is documented.
 */
function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SECTION = 'components/chat/ConversationSection.tsx';
const LIST = 'components/chat/ConversationList.tsx';
const SIDEBAR = 'components/chat/Sidebar.tsx';
const RULES = 'lib/chat/sidebar-sections.ts';

/* -------------------------------------------------------------------------------------------- */
/* Accessibility and keyboard                                                                     */
/* -------------------------------------------------------------------------------------------- */

describe('the section header is a real button', () => {
  it('is a <button type="button">, not a clickable div', () => {
    const text = source(SECTION);

    /*
     * The whole point. A native button is focusable, is in the tab order, is announced as a
     * button, and is activated by BOTH Enter and Space — none of which a div with onClick is.
     */
    expect(text).toContain('<button');
    expect(text).toContain('type="button"');
    expect(text).not.toMatch(/<div[^>]*\sonClick=/);
  });

  it('does not hand-roll Enter/Space with onKeyDown', () => {
    /*
     * Reimplementing what a button already does is how the mouse path and the keyboard path drift
     * apart — one of them gets a fix and the other does not. If this ever needs a key handler it
     * should be for something a button does NOT do, and this assertion should be revisited then.
     */
    expect(code(SECTION)).not.toContain('onKeyDown');
  });

  it('carries aria-expanded, and binds it to the ACTUAL open state', () => {
    const text = source(SECTION);

    // `aria-expanded={open}` — not `aria-expanded="true"`, which would lie whenever it is closed.
    expect(text).toContain('aria-expanded={open}');
    expect(text).not.toMatch(/aria-expanded="(true|false)"/);
  });

  it('associates the header with the list it controls', () => {
    const text = source(SECTION);
    expect(text).toContain('aria-controls={regionId}');
    expect(text).toContain('id={regionId}');
  });

  it('keeps a visible focus ring, like the conversation rows', () => {
    // Keyboard users have to be able to see where they are before pressing Enter.
    expect(source(SECTION)).toContain('focus-visible:outline');
  });

  it('puts the label INSIDE the button, so the whole header is the target', () => {
    const text = source(SECTION);
    const button = text.slice(text.indexOf('<button'), text.indexOf('</button>'));

    // A 16-pixel chevron is a target you have to aim at; the row beside it looks clickable anyway.
    expect(button).toContain('{section.label}');
    expect(button).toContain('ChevronRightIcon');
  });

  it('announces the unread count and the collapsed state in words', () => {
    const text = source(SECTION);
    // A bare number next to a heading is not an accessible name.
    expect(text).toContain('sr-only');
    expect(text).toContain('unread');
    expect(text).toContain('collapsed');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Collapsed still signals unread                                                                 */
/* -------------------------------------------------------------------------------------------- */

describe('a collapsed section still reports activity', () => {
  it('renders the unread badge on the header when closed', () => {
    const text = source(SECTION);

    // `!open && unread > 0` — the badge belongs to the closed state, where the rows are gone.
    expect(text).toContain('{!open && unread > 0 ?');
    expect(text).toContain('<UnreadBadge count={unread} />');
  });

  it('takes that count from the section, not from anywhere new', () => {
    // No second source of truth, and nothing asked of the database for this.
    expect(source(SECTION)).toContain('section.unreadCount');
    expect(source(RULES)).toContain('entry.unreadCount');
  });

  it('unmounts the list when closed rather than hiding it with CSS', () => {
    const text = source(SECTION);
    expect(text).toContain('hidden={!open}');
    // The empty-state text must not be announced for a section nobody has opened.
    expect(text).toContain('{open ? <div');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* No regression to the conversation rows                                                         */
/* -------------------------------------------------------------------------------------------- */

describe('conversation rows are unchanged', () => {
  const text = source(LIST);

  it('still renders every part of a row', () => {
    for (const piece of [
      'Avatar',            // avatar / initials
      'GroupAvatar',       // group avatar
      'presence={entry.counterpart.presence}', // online indicator
      '{entry.preview}',   // message preview, incl. the "You:" prefix and file previews
      'formatListTimestamp', // last-message timestamp
      '<UnreadBadge count={entry.unreadCount} />', // unread badge
      "aria-current={selected ? 'true' : undefined}", // selected state
      '{entry.discriminator', // same-name discriminator (D-02)
    ]) {
      expect(text, piece).toContain(piece);
    }
  });

  it('still routes selection through the same callback', () => {
    expect(text).toContain('onSelect={() => onSelect(entry.id)}');
    expect(text).toContain('selected={entry.id === selectedConversationId}');
  });

  it('renders rows through the one shared row component in both sections', () => {
    // One `<ConversationListItem` in the JSX means the two sections cannot drift apart.
    expect(text.match(/<ConversationListItem/g)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Order, and where the rules come from                                                           */
/* -------------------------------------------------------------------------------------------- */

describe('the sidebar is presentation over existing data', () => {
  it('renders sections in the order the rules module fixes, without sorting them', () => {
    const text = source(LIST);

    expect(text).toContain('splitConversationSections');
    expect(text).toContain('sections.map((section)');
    // No comparator anywhere in the sidebar: the order is `SIDEBAR_SECTION_ORDER`, and within a
    // section it is whatever `sortConversations` already produced.
    expect(code(LIST)).not.toContain('.sort(');
    expect(code(RULES)).not.toContain('.sort(');
  });

  it('asks the rules module whether a section is open, rather than deciding inline', () => {
    const text = source(LIST);
    expect(text).toContain('resolveSectionOpen({');
    expect(text).toContain('isSectionVisible(section, searching)');
  });

  it('classifies on the server enum and nothing else', () => {
    const rules = code(RULES);

    expect(rules).toContain("entry.type === 'GROUP'");
    // Never on a name, a member count, or whether a counterpart resolved.
    expect(rules).not.toContain('entry.title');
    expect(rules).not.toContain('memberCount');
    expect(rules).not.toContain('counterpart');
  });

  it('introduces no socket event and no server call', () => {
    for (const path of [SECTION, LIST, RULES]) {
      const text = code(path);
      expect(text, path).not.toContain('socket');
      expect(text, path).not.toContain('fetch(');
      expect(text, path).not.toContain('/api/');
    }
  });

  it('stores the preference locally and never in the database', () => {
    const rules = code(RULES);

    expect(rules).toContain('localStorage');
    expect(rules).toContain("'cic.sidebar.sections'");
    for (const forbidden of ['prisma', 'getDb', '@/lib/db']) {
      expect(rules, forbidden).not.toContain(forbidden);
    }
  });

  it('reaches nothing outside presentation', () => {
    /*
     * The rules module's only import is the row type. A collapsed section is UI state and must
     * not be able to touch authorization, membership or identity even by accident.
     */
    const imports = code(RULES)
      .split('\n')
      .filter((line) => line.startsWith('import '))
      .join('\n');

    expect(imports).toContain("import type { ConversationListEntry } from '@/lib/chat/state';");
    expect(imports.split('\n').filter((line) => line.trim().length > 0)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* The sidebar shell kept its existing controls                                                   */
/* -------------------------------------------------------------------------------------------- */

describe('the top of the sidebar is untouched', () => {
  const text = source(SIDEBAR);

  it('still has the heading, the search box and both creation buttons', () => {
    expect(text).toContain('Conversations');
    expect(text).toContain('placeholder="Search conversations"');
    expect(text).toContain('New chat');
    expect(text).toContain('New group');
  });

  it('still passes search and selection straight through', () => {
    // The search box keeps filtering BOTH kinds, because it still filters the one entry list.
    expect(text).toContain('searchTerm={searchTerm}');
    expect(text).toContain('selectedConversationId={selectedConversationId}');
  });
});
