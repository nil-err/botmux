/**
 * Regression for PR #467 二审 finding 4: a sandbox-enabled bot switched to the
 * riff backend must NOT hit the worker's fail-safe "backend not sandboxable"
 * hard error — riff runs in its own remote sandbox and has no local process.
 *
 * Run:  pnpm vitest run test/riff-sandbox-bypass.test.ts
 */
import { describe, it, expect } from 'vitest';
import { localSandboxApplies } from '../src/adapters/backend/sandbox.js';

describe('localSandboxApplies', () => {
  it('bypasses the local file sandbox for the riff backend on Linux', () => {
    expect(localSandboxApplies('linux', 'riff')).toBe(false);
  });

  it('keeps the sandbox for local backends on Linux', () => {
    expect(localSandboxApplies('linux', 'pty')).toBe(true);
    expect(localSandboxApplies('linux', 'tmux')).toBe(true);
  });

  it('never applies on macOS (Seatbelt handles sandbox there)', () => {
    expect(localSandboxApplies('darwin', 'pty')).toBe(false);
    expect(localSandboxApplies('darwin', 'riff')).toBe(false);
  });
});
