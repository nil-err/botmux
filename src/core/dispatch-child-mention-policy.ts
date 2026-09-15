import { resolveVerifiedDispatchReportTarget } from './dispatch-report-binding.js';

type DispatchChildRegistryEntry = {
  targetChatId?: unknown;
  targetAppIds?: unknown;
  bots?: unknown;
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)
    : [];
}

/**
 * Identify control-plane chatter in a dispatch child thread.
 *
 * A Worker ack/progress message can carry a footer mention of the Coordinator.
 * That mention is not an instruction to create a second Coordinator session in
 * the child thread: formal completion returns through the signed report binding.
 *
 * This predicate deliberately fails open. Suppression requires all durable
 * dispatch coordinates to agree:
 * - the anchor is a registered dispatch root;
 * - its host-signed binding names the receiving app as the Coordinator;
 * - the sender is one of that dispatch's exact target Workers (stable app id or
 *   receiver-scoped bot open_id);
 * - no Coordinator child session exists yet; and
 * - the inbound is ordinary bot chatter, not @steer or a slash/control command.
 */
export function shouldSuppressDispatchChildMentionAutoCreate(input: {
  registry: Record<string, unknown>;
  bindingSecret: string;
  dispatchRoot: string;
  receiverLarkAppId: string;
  senderLarkAppId?: string;
  senderOpenId?: string;
  chatId?: string;
  senderIsBot: boolean;
  existingSession: boolean;
  explicitSteer: boolean;
  slashCommand: boolean;
}): boolean {
  if (!input.senderIsBot
    || input.existingSession
    || input.explicitSteer
    || input.slashCommand) {
    return false;
  }

  const raw = input.registry[input.dispatchRoot];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const entry = raw as DispatchChildRegistryEntry;
  if (typeof entry.targetChatId === 'string'
    && input.chatId
    && entry.targetChatId !== input.chatId) {
    return false;
  }

  const verified = resolveVerifiedDispatchReportTarget({
    registry: input.registry,
    dispatchRoot: input.dispatchRoot,
    secret: input.bindingSecret,
  });
  if (!verified.ok
    || verified.binding.targetLarkAppId !== input.receiverLarkAppId) {
    return false;
  }

  const targetAppIds = stringArray(entry.targetAppIds);
  const targetOpenIds = stringArray(entry.bots);
  const exactWorker = (!!input.senderLarkAppId
      && targetAppIds.includes(input.senderLarkAppId))
    || (!!input.senderOpenId && targetOpenIds.includes(input.senderOpenId));
  return exactWorker;
}
