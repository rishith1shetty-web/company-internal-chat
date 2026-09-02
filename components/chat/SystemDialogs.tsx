'use client';

import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { userDiscriminator } from '@/lib/chat/format';
import type { UserSummary } from '@/lib/chat/types';
import type { DesktopPermission } from '@/lib/notifications/desktop';
import type { NotificationPreferences } from '@/lib/notifications/preferences';
import { cn } from '@/lib/ui/cn';

/**
 * Settings.
 *
 * Two halves with different characters, and that is on purpose. The account half is READ-ONLY —
 * which identity this is and which computer it belongs to — because changing who a computer is
 * assigned to is an administrator's operation (docs/12-admin-device-identity.md), and the
 * "switch user" control that used to live here is gone for good.
 *
 * The notification half is the part an employee owns. It is stored in this browser and nowhere
 * else (lib/notifications/preferences.ts): it decides whether *this* browser makes a noise, which
 * is not company data and not something an administrator has any business setting.
 */
export function SettingsDialog({
  open,
  currentUser,
  deviceLabel,
  preferences,
  onPreferenceChange,
  desktopPermission,
  onEnableDesktop,
  soundBlocked,
  onTestSound,
  onClose,
}: {
  open: boolean;
  currentUser: UserSummary;
  deviceLabel: string;
  preferences: NotificationPreferences;
  onPreferenceChange: (key: keyof NotificationPreferences, value: boolean) => void;
  desktopPermission: DesktopPermission;
  onEnableDesktop: () => Promise<DesktopPermission>;
  soundBlocked: boolean;
  onTestSound: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title="Settings"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <section aria-labelledby="settings-notifications">
        <h3 id="settings-notifications" className="text-sm font-semibold text-ink">
          Notifications
        </h3>
        <p className="mt-1 text-sm text-ink-muted">
          These apply to this browser only, on this computer.
        </p>

        <div className="mt-3 divide-y divide-line overflow-hidden rounded-card border border-line">
          <ToggleRow
            label="Message sounds"
            description={
              soundBlocked
                ? 'Your browser is waiting for you to click the page once before it will play sounds.'
                : 'A short chime when a message arrives.'
            }
            checked={preferences.sound}
            onChange={(value) => onPreferenceChange('sound', value)}
            action={
              preferences.sound ? (
                <button
                  type="button"
                  onClick={onTestSound}
                  className="text-xs font-medium text-accent underline underline-offset-2 hover:text-accent-hover"
                >
                  Test
                </button>
              ) : null
            }
          />

          <ToggleRow
            label="In-app notifications"
            description="A card in the corner while you have the application open."
            checked={preferences.inApp}
            onChange={(value) => onPreferenceChange('inApp', value)}
          />

          <DesktopRow
            permission={desktopPermission}
            enabled={preferences.desktop}
            onEnable={onEnableDesktop}
            onChange={(value) => onPreferenceChange('desktop', value)}
          />
        </div>

        <p className="mt-2.5 text-xs text-ink-subtle">
          Sounds and in-app cards keep working while this tab is in the background. Desktop
          notifications are what you see when you are in another application.
        </p>
      </section>

      <section aria-labelledby="settings-account" className="mt-6 border-t border-line pt-5">
        <h3 id="settings-account" className="text-sm font-semibold text-ink">
          This computer
        </h3>

        <dl className="mt-2 divide-y divide-line text-sm">
          <SettingRow label="Display name">{currentUser.displayName}</SettingRow>
          <SettingRow label="Your ID">{userDiscriminator(currentUser.id)}</SettingRow>
          <SettingRow label="This computer">{deviceLabel}</SettingRow>
          <SettingRow label="Sign-in">Assigned to this computer by IT</SettingRow>
          <SettingRow label="Conversations">One-to-one and group</SettingRow>
        </dl>

        <div className="mt-4 rounded-md border border-line bg-surface-muted p-3">
          <p className="text-sm font-medium text-ink">Someone else using this computer?</p>
          <p className="mt-1 text-sm text-ink-muted">
            Messages sent from here are sent as{' '}
            <span className="font-medium text-ink">{currentUser.displayName}</span>. If this
            computer has changed hands, ask IT to reassign it — there is nothing to switch here,
            and nothing you do can send a message under somebody else&apos;s name.
          </p>
        </div>
      </section>
    </Modal>
  );
}

/**
 * The desktop-notification row.
 *
 * Four distinct states, because collapsing them into "on/off" would leave somebody staring at a
 * switch that refuses to move with no explanation:
 *
 *   unsupported  this browser has no Notification API at all
 *   default      never asked — the button is the ONLY place permission is ever requested
 *   granted      a real switch, which the employee can still turn off without revoking anything
 *   denied       the browser has been told no, and only the browser can undo that
 */
function DesktopRow({
  permission,
  enabled,
  onEnable,
  onChange,
}: {
  permission: DesktopPermission;
  enabled: boolean;
  onEnable: () => Promise<DesktopPermission>;
  onChange: (value: boolean) => void;
}) {
  if (permission === 'granted') {
    return (
      <ToggleRow
        label="Desktop notifications"
        description="Pop up outside the browser when you are working in another application."
        checked={enabled}
        onChange={onChange}
      />
    );
  }

  const detail =
    permission === 'unsupported'
      ? 'This browser does not support desktop notifications. Sounds and in-app cards still work.'
      : permission === 'denied'
        ? 'Blocked in your browser. To turn these on, allow notifications for this site in your browser’s site settings.'
        : 'Pop up outside the browser when you are working in another application.';

  return (
    <div className="flex items-start justify-between gap-4 bg-surface px-3.5 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">Desktop notifications</p>
        <p className="mt-0.5 text-sm text-ink-muted">{detail}</p>
      </div>

      {permission === 'default' ? (
        // The one and only place the browser permission is requested, and it takes a deliberate
        // press. Nothing asks on page load.
        <Button size="sm" onClick={() => void onEnable()} className="shrink-0">
          Turn on
        </Button>
      ) : (
        <span className="shrink-0 self-center text-xs font-medium text-ink-subtle">
          {permission === 'denied' ? 'Blocked' : 'Unavailable'}
        </span>
      )}
    </div>
  );
}

/**
 * A labelled switch.
 *
 * A real `<button role="switch">` with `aria-checked` rather than a styled checkbox: it announces
 * itself correctly, it is reachable by keyboard for free, and the visible state is carried by
 * position and a check-like knob rather than by colour alone.
 */
function ToggleRow({
  label,
  description,
  checked,
  onChange,
  action,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 bg-surface px-3.5 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
        {action ? <div className="mt-1.5">{action}</div> : null}
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full',
          'transition-colors duration-(--duration-quick) ease-(--ease-out-soft)',
          'focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:outline-none',
          checked ? 'bg-accent' : 'bg-line-strong',
        )}
      >
        <span
          className={cn(
            'inline-block h-4.5 w-4.5 rounded-full bg-surface shadow-subtle',
            'transition-transform duration-(--duration-quick) ease-(--ease-out-soft)',
            checked ? 'translate-x-[1.5rem]' : 'translate-x-[0.2rem]',
          )}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-2.5">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right font-medium text-ink">{children}</dd>
    </div>
  );
}
