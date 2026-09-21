/**
 * The wording of a notification, and what must never appear in it.
 *
 * Two concerns in one file because they are the same assertion from opposite sides: the second
 * line is the only thing that reaches the operating system's notification centre, so what it says
 * has to be right AND what it omits has to stay omitted.
 */

import { describe, expect, it } from 'vitest';

import {
  PREVIEW_LIMIT,
  describeIncomingMessage,
  previewOf,
  type DescribeInput,
} from '@/lib/notifications/describe';
import type { MessageWire } from '@/lib/chat/wire';

const ME = '11111111-1111-4111-8111-111111111111';
const THEM = '22222222-2222-4222-8222-222222222222';

function message(overrides: Partial<MessageWire> = {}): MessageWire {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    conversationId: '44444444-4444-4444-8444-444444444444',
    senderId: THEM,
    clientMessageId: '55555555-5555-4555-8555-555555555555',
    type: 'TEXT',
    body: 'Can you review the report?',
    createdAt: '2026-09-02T10:15:00.000Z',
    attachment: null,
    replyTo: null,
    editedAt: null,
    isForwarded: false,
    pinnedAt: null,
    deletedAt: null,
    reactions: [],
    ...overrides,
  };
}

function input(overrides: Partial<DescribeInput> = {}): DescribeInput {
  return {
    currentUserId: ME,
    conversationTitle: 'Rishith',
    isGroup: false,
    senderName: 'Rishith',
    isOpenConversation: false,
    ...overrides,
  };
}

const FILE = {
  id: '66666666-6666-4666-8666-666666666666',
  filename: 'report.pdf',
  byteSize: '10240',
  mimeType: 'application/pdf',
  extension: 'pdf',
  createdAt: '2026-09-02T10:15:00.000Z',
};

describe('a direct message', () => {
  it('is titled by the sender and previews what they said', () => {
    const event = describeIncomingMessage(message(), input());

    expect(event.title).toBe('Rishith');
    expect(event.body).toBe('Can you review the report?');
    expect(event.isGroup).toBe(false);
  });

  /*
   * The title IS the sender in a direct conversation, so prefixing the body with it again would
   * read "Rishith / Rishith: hello".
   */
  it('does not repeat the sender inside the preview', () => {
    const event = describeIncomingMessage(message(), input());

    expect(event.body).not.toContain('Rishith:');
  });
});

describe('a group message', () => {
  it('is titled by the group and names the sender in the preview', () => {
    const event = describeIncomingMessage(
      message(),
      input({ conversationTitle: 'Engineering Team', isGroup: true }),
    );

    expect(event.title).toBe('Engineering Team');
    expect(event.body).toBe('Rishith: Can you review the report?');
    expect(event.isGroup).toBe(true);
  });

  it('copes with a sender whose name is not known yet', () => {
    const event = describeIncomingMessage(
      message(),
      input({ conversationTitle: 'Engineering Team', isGroup: true, senderName: null }),
    );

    expect(event.body).toBe('Someone: Can you review the report?');
  });
});

describe('a file message', () => {
  it('says what arrived, in a direct conversation', () => {
    const event = describeIncomingMessage(
      message({ type: 'FILE', body: null, attachment: FILE }),
      input(),
    );

    expect(event.title).toBe('Rishith');
    expect(event.body).toBe('Sent report.pdf');
    expect(event.filename).toBe('report.pdf');
  });

  it('says who sent what, in a group', () => {
    const event = describeIncomingMessage(
      message({ type: 'FILE', body: null, attachment: FILE }),
      input({ conversationTitle: 'Project Team', isGroup: true }),
    );

    expect(event.body).toBe('Rishith sent report.pdf');
  });

  /*
   * A caption does not displace the filename. "What arrived" is the useful fact at notification
   * time, and the caption is right there once the conversation is opened.
   */
  it('names the file even when a caption was sent with it', () => {
    const event = describeIncomingMessage(
      message({ type: 'FILE', body: 'here you go', attachment: FILE }),
      input(),
    );

    expect(event.body).toBe('Sent report.pdf');
  });
});

describe('what never reaches the notification', () => {
  /*
   * The rendered strings are the only thing shown outside the browser. Ids and storage details
   * exist on the event so a click can route and a duplicate can be spotted — never to be read.
   */
  it('puts no id, path or storage detail into the text', () => {
    const event = describeIncomingMessage(
      message({ type: 'FILE', body: null, attachment: FILE }),
      input({ conversationTitle: 'Project Team', isGroup: true }),
    );

    const rendered = `${event.title} ${event.body}`;

    expect(rendered).not.toContain(event.conversationId);
    expect(rendered).not.toContain(event.messageId);
    expect(rendered).not.toContain(THEM);
    expect(rendered).not.toContain(ME);
    expect(rendered).not.toContain(FILE.id);
    expect(rendered).not.toContain('application/pdf');
    expect(rendered).not.toMatch(/\/|\\/);
  });

  it('still carries the ids the pipeline needs, off the rendered text', () => {
    const event = describeIncomingMessage(message(), input());

    expect(event.messageId).toBe('33333333-3333-4333-8333-333333333333');
    expect(event.conversationId).toBe('44444444-4444-4444-8444-444444444444');
  });
});

describe('classification', () => {
  it('marks a message from the current user as their own', () => {
    expect(describeIncomingMessage(message({ senderId: ME }), input()).isOwnMessage).toBe(true);
    expect(describeIncomingMessage(message(), input()).isOwnMessage).toBe(false);
  });

  it('marks a SYSTEM message, whose sender is null', () => {
    const event = describeIncomingMessage(
      message({ type: 'SYSTEM', senderId: null, body: 'Sam joined' }),
      input({ senderName: null }),
    );

    expect(event.isSystemMessage).toBe(true);
    // A null sender is not the current user, however the ids compare.
    expect(event.isOwnMessage).toBe(false);
  });

  it('carries whether the conversation is open', () => {
    expect(describeIncomingMessage(message(), input({ isOpenConversation: true })).isOpenConversation).toBe(true);
  });
});

describe('previewOf', () => {
  it('collapses whitespace so a pasted block does not become a wall', () => {
    expect(previewOf('  hello\n\n  there  ')).toBe('hello there');
  });

  it('leaves a short message alone', () => {
    expect(previewOf('short')).toBe('short');
  });

  it('trims a long message and marks it as trimmed', () => {
    const long = 'word '.repeat(80).trim();
    const preview = previewOf(long);

    expect(preview.length).toBeLessThanOrEqual(PREVIEW_LIMIT + 1);
    expect(preview.endsWith('…')).toBe(true);
    // Cut at a word boundary rather than mid-word.
    expect(preview).not.toMatch(/wor…$/);
  });

  it('cuts a single very long token rather than returning almost nothing', () => {
    const preview = previewOf('x'.repeat(400));

    expect(preview.length).toBe(PREVIEW_LIMIT + 1);
  });

  it('treats null, undefined and blank alike', () => {
    expect(previewOf(null)).toBe('');
    expect(previewOf(undefined)).toBe('');
    expect(previewOf('   ')).toBe('');
  });

  it('gives an empty message something to say', () => {
    expect(describeIncomingMessage(message({ body: null }), input()).body).toBe('Sent a message');
  });
});
