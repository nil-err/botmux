/**
 * Team-level collaboration roster for the platform UI: every bot the deployment
 * runs (from bots-info.json) enriched with its team capability label and whether
 * it has a team-level role, plus the team's member count.
 *
 * This is the TEAM view (who's on the team), distinct from the per-chat roster
 * in listChatBotMembers (who's in a given group + reliably @-mentionable).
 * Pure read from `{dataDir}` files — no Lark API, no config coupling — so it is
 * trivially testable and cheap for the UI to poll.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getBotCapability } from './bot-profile-store.js';
import { getBotOwner } from './bot-owner-store.js';
import { getTeam, getDefaultTeam, DEFAULT_TEAM_ID } from './team-store.js';

export interface TeamRosterBot {
  larkAppId: string;
  name: string;
  cliId: string;
  capability: string | null;
  hasTeamRole: boolean;
  /** Owner for grouping by person; null if unassigned. unionId is the key, name for display. */
  owner: { unionId?: string; openId?: string; name?: string } | null;
}

export interface TeamRoster {
  team: { id: string; name: string; memberCount: number };
  bots: TeamRosterBot[];
}

interface BotInfoEntry { larkAppId: string; botOpenId: string | null; botName: string | null; cliId: string }

function readBotsInfo(dataDir: string): BotInfoEntry[] {
  const fp = join(dataDir, 'bots-info.json');
  if (!existsSync(fp)) return [];
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (Array.isArray(parsed)) return parsed as BotInfoEntry[];
  } catch { /* corrupt — empty roster */ }
  return [];
}

function hasTeamRoleFile(dataDir: string, larkAppId: string): boolean {
  return existsSync(join(dataDir, 'team-roles', `${larkAppId}.md`));
}

export function buildTeamRoster(dataDir: string, teamId: string = DEFAULT_TEAM_ID): TeamRoster {
  const team = getTeam(dataDir, teamId) ?? getDefaultTeam(dataDir);
  const bots: TeamRosterBot[] = readBotsInfo(dataDir).map((b) => {
    const o = getBotOwner(dataDir, b.larkAppId);
    return {
      larkAppId: b.larkAppId,
      name: b.botName ?? b.cliId,
      cliId: b.cliId,
      capability: getBotCapability(dataDir, b.larkAppId),
      hasTeamRole: hasTeamRoleFile(dataDir, b.larkAppId),
      owner: o ? { unionId: o.unionId, openId: o.openId, name: o.name } : null,
    };
  });
  return { team: { id: team.id, name: team.name, memberCount: team.members.length }, bots };
}
