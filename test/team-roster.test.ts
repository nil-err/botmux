/**
 * Team-level roster builder for the platform UI.
 * Run: pnpm vitest run test/team-roster.test.ts
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { buildTeamRoster } from '../src/services/team-roster.js';
import { setBotCapability } from '../src/services/bot-profile-store.js';
import { setBotOwner } from '../src/services/bot-owner-store.js';
import { ensureDefaultTeam, addMember, DEFAULT_TEAM_ID } from '../src/services/team-store.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-roster-')); });

function writeBotsInfo(entries: any[]) {
  writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify(entries));
}
function writeTeamRole(larkAppId: string) {
  mkdirSync(join(dataDir, 'team-roles'), { recursive: true });
  writeFileSync(join(dataDir, 'team-roles', `${larkAppId}.md`), '# role');
}

describe('buildTeamRoster', () => {
  it('empty when nothing recorded', () => {
    const r = buildTeamRoster(dataDir);
    expect(r.bots).toEqual([]);
    expect(r.team).toEqual({ id: DEFAULT_TEAM_ID, name: '默认团队', memberCount: 0 });
  });

  it('lists bots enriched with capability + hasTeamRole, and team member count', () => {
    writeBotsInfo([
      { larkAppId: 'cli_a', botOpenId: 'ou_a', botName: '后端Bot', cliId: 'codex' },
      { larkAppId: 'cli_b', botOpenId: 'ou_b', botName: null, cliId: 'claude-code' },
    ]);
    setBotCapability(dataDir, 'cli_a', '服务端排查');
    writeTeamRole('cli_a');
    ensureDefaultTeam(dataDir);
    addMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_1', name: '张三' });

    const r = buildTeamRoster(dataDir);
    expect(r.team.memberCount).toBe(1);
    const a = r.bots.find(b => b.larkAppId === 'cli_a')!;
    expect(a).toEqual({ larkAppId: 'cli_a', name: '后端Bot', cliId: 'codex', capability: '服务端排查', hasTeamRole: true, owner: null });
    const b = r.bots.find(b => b.larkAppId === 'cli_b')!;
    expect(b).toEqual({ larkAppId: 'cli_b', name: 'claude-code', cliId: 'claude-code', capability: null, hasTeamRole: false, owner: null });
  });

  it('attaches owner (for grouping by person)', () => {
    writeBotsInfo([{ larkAppId: 'cli_a', botOpenId: 'ou_a', botName: '后端Bot', cliId: 'codex' }]);
    setBotOwner(dataDir, 'cli_a', { unionId: 'on_1', name: '张三' });
    const a = buildTeamRoster(dataDir).bots.find(b => b.larkAppId === 'cli_a')!;
    expect(a.owner).toEqual({ unionId: 'on_1', name: '张三' });
  });

  it('tolerates corrupt bots-info.json', () => {
    writeFileSync(join(dataDir, 'bots-info.json'), 'not json');
    expect(buildTeamRoster(dataDir).bots).toEqual([]);
  });
});
