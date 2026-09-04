/**
 * Every display-name prefix used by anything that creates rows for verification.
 *
 * SHARED BY THE AUDIT AND THE CLEANUP ON PURPOSE. Two copies of this list would drift, and the
 * two directions of drift fail differently and both badly: an audit missing a prefix reports
 * "none" while rows are still there, and a cleanup missing one leaves rows nobody is looking for.
 * One list, imported by both, is the only arrangement where adding a harness cannot half-work.
 *
 * The cleanup additionally refuses any prefix that is not in this list, so it can never be pointed
 * at real employee data by a typo on the command line.
 */
export const TEST_PREFIXES = [
  'zz-test-',
  'zz-rt-',
  'zz-test-p5-',
  'zz-e2e-',
  'zz-ui-',
  // Phase 6: the group browser regression and the connection-pool measurement.
  'zz-gui-',
  'zz-pool-',
  // Phase 7: the file browser regression and the large-file transfer check.
  'zz-fui-',
  'zz-big-',
  // The Windows desktop client's end-to-end run (docs/18-desktop-client.md). It enrolls a real
  // Electron client and a colleague to message it, so it creates a User and a Device per run.
  'zz-desk-',
] as const;

export type TestPrefix = (typeof TEST_PREFIXES)[number];

/** True when `value` is one of the known verification prefixes. */
export function isTestPrefix(value: string): value is TestPrefix {
  return (TEST_PREFIXES as readonly string[]).includes(value);
}
