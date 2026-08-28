/**
 * Phase 1 placeholder page.
 *
 * Its only job is to prove the custom server, Next.js App Router, TypeScript and Tailwind are
 * wired together correctly. The actual chat interface is Phase 2 (docs/00-phase-0-overview.md).
 */

const PHASE_STATUS = [
  { phase: 'Phase 0', title: 'Requirements & architecture', state: 'complete' },
  { phase: 'Phase 1', title: 'Development environment', state: 'current' },
  { phase: 'Phase 2', title: 'Chat UI', state: 'pending' },
  { phase: 'Phase 3', title: 'PostgreSQL database', state: 'pending' },
  { phase: 'Phase 4', title: 'Real-time messaging', state: 'pending' },
] as const;

const STATE_STYLES: Record<(typeof PHASE_STATUS)[number]['state'], string> = {
  complete: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  current: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  pending: 'bg-slate-100 text-slate-500 ring-slate-500/20',
};

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
        Company Internal Chat
      </h1>
      <p className="mt-2 text-sm text-slate-600">
        Development environment is running. The application interface has not been built yet.
      </p>

      <ul className="mt-8 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
        {PHASE_STATUS.map((item) => (
          <li key={item.phase} className="flex items-center justify-between gap-4 px-4 py-3">
            <span className="text-sm text-slate-700">
              <span className="font-medium text-slate-900">{item.phase}</span>
              <span className="mx-2 text-slate-300">·</span>
              {item.title}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                STATE_STYLES[item.state]
              }`}
            >
              {item.state}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-6 text-xs text-slate-500">
        Served by the custom Node server (Next.js and, from Phase 4, Socket.IO on one port).
      </p>
    </main>
  );
}
