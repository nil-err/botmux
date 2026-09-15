import { describe, expect, it } from 'vitest';

import {
  shouldSuppressDispatchChildMentionAutoCreate,
} from '../src/core/dispatch-child-mention-policy.js';
import { createDispatchReportBinding } from '../src/core/dispatch-report-binding.js';

const SECRET = 'dispatch-binding-secret';
const ROOT = 'om_dispatch_child';
const COORDINATOR = 'cli_coordinator';
const WORKER = 'cli_worker';

function registry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [ROOT]: {
      orchAppId: COORDINATOR,
      orchSessionId: 'session-orchestrator',
      targetAppIds: [WORKER],
      reportBinding: createDispatchReportBinding(SECRET, {
        dispatchRoot: ROOT,
        targetLarkAppId: COORDINATOR,
        targetSessionId: 'session-orchestrator',
        sourceName: 'child task',
        issuedAt: '2026-09-15T00:00:00.000Z',
      }),
      ...overrides,
    },
  };
}

function decide(overrides: Partial<Parameters<typeof shouldSuppressDispatchChildMentionAutoCreate>[0]> = {}) {
  return shouldSuppressDispatchChildMentionAutoCreate({
    registry: registry(),
    bindingSecret: SECRET,
    dispatchRoot: ROOT,
    receiverLarkAppId: COORDINATOR,
    senderLarkAppId: WORKER,
    senderIsBot: true,
    existingSession: false,
    explicitSteer: false,
    slashCommand: false,
    ...overrides,
  });
}

describe('dispatch child bot mention auto-create policy', () => {
  it('suppresses an ordinary target-worker mention to its coordinator when no child session exists', () => {
    expect(decide()).toBe(true);
  });

  it.each([
    ['explicit @steer', { explicitSteer: true }],
    ['slash or daemon command', { slashCommand: true }],
    ['human sender', { senderIsBot: false }],
    ['existing coordinator child session', { existingSession: true }],
  ] as const)('preserves %s routing', (_label, overrides) => {
    expect(decide(overrides)).toBe(false);
  });

  it('preserves ordinary non-dispatch bot collaboration', () => {
    expect(decide({ dispatchRoot: 'om_ordinary_thread' })).toBe(false);
  });

  it('preserves bot traffic from a peer that is not a registered target worker', () => {
    expect(decide({ senderLarkAppId: 'cli_other_bot' })).toBe(false);
  });

  it('preserves the dispatch worker own session and any other receiver', () => {
    expect(decide({ receiverLarkAppId: WORKER })).toBe(false);
  });

  it('fails open when the dispatch binding cannot prove the coordinator identity', () => {
    expect(decide({ registry: registry({
      reportBinding: createDispatchReportBinding(SECRET, {
        dispatchRoot: ROOT,
        targetLarkAppId: 'cli_someone_else',
        targetSessionId: 'session-other',
        sourceName: 'tampered route',
        issuedAt: '2026-09-15T00:00:00.000Z',
      }),
    }) })).toBe(false);
  });
});
