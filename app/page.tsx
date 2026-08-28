/**
 * Application entry route.
 *
 * A server component whose only job is to render the chat shell. All Phase 2 behaviour lives in
 * the client boundary below it; nothing on this page reads configuration, touches a database or
 * calls an API, because none of those exist yet in this phase.
 */

import { ChatWorkspace } from '@/components/chat/ChatWorkspace';

export default function HomePage() {
  return <ChatWorkspace />;
}
