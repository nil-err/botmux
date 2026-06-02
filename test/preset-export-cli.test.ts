/**
 * End-to-end CLI boundary tests for `botmux preset export`, run against the
 * built `dist/cli.js` as a subprocess (mirrors test/workflow-c0-isolation).
 *
 * Covers the review's CLI-boundary asks: default filename slugification,
 * non-TTY without --yes fails (without blocking), `--out - --yes` emits ONLY
 * JSON on stdout with logs on stderr, empty team role still exits 0, and
 * value-less --from-chat / --out error out instead of silently defaulting.
 *
 * Requires a prior `pnpm build`. Run: pnpm vitest run test/preset-export-cli.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js');

let home: string;
let dataDir: string;

const SECRET = 'SECRET_SHOULD_NOT_LEAK_123';
const APP_WITH_ROLE = 'cli_fake_app_001';
const APP_NO_ROLE = 'cli_fake_app_002';

beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    throw new Error('dist/cli.js missing — run `pnpm build` first');
  }

  home = mkdtempSync(join(tmpdir(), 'botmux-preset-cli-'));
  dataDir = join(home, 'data');
  mkdirSync(join(home, '.botmux'), { recursive: true });
  mkdirSync(join(dataDir, 'team-roles'), { recursive: true });
  mkdirSync(join(dataDir, 'bot-profiles'), { recursive: true });

  writeFileSync(
    join(home, '.botmux', 'bots.json'),
    JSON.stringify([
      {
        name: 'Backend Bot/01', // intentionally illegal-for-filename chars
        larkAppId: APP_WITH_ROLE,
        larkAppSecret: SECRET,
        cliId: 'claude-code',
        model: 'sonnet',
        allowedUsers: ['alice@example.com'],
        workingDir: '/tmp/secret-workdir',
      },
      {
        name: 'norole',
        larkAppId: APP_NO_ROLE,
        larkAppSecret: SECRET,
        cliId: 'aiden',
      },
    ]),
    'utf-8',
  );

  writeFileSync(join(dataDir, 'team-roles', `${APP_WITH_ROLE}.md`), '# 后端\nINTERNAL_NOTE_xyz', 'utf-8');
  writeFileSync(
    join(dataDir, 'bot-profiles', `${APP_WITH_ROLE}.json`),
    JSON.stringify({ capability: '后端能力标签', updatedAt: 1 }),
    'utf-8',
  );
});

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  // spawnSync (not execFileSync) so we capture stderr on success too — several
  // assertions check stderr while the command exits 0 (stdout stays JSON-clean).
  const r = spawnSync('node', [CLI_PATH, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, SESSION_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'], // stdin ignored ⇒ not a TTY
    encoding: 'utf-8',
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('botmux preset export — CLI boundary', () => {
  it('default filename is slugified from the bot name', () => {
    const out = runCli(['preset', 'export', APP_WITH_ROLE, '--yes']);
    expect(out.status).toBe(0);
    const expected = join(home, 'Backend-Bot-01.botmux-preset.json');
    expect(existsSync(expected)).toBe(true);
    const body = readFileSync(expected, 'utf-8');
    expect(body).not.toContain(SECRET);
    expect(body).toContain('INTERNAL_NOTE_xyz'); // role resolved & included
    expect(body).toContain('后端能力标签'); // capability resolved & included
  });

  it('--out - --yes emits ONLY JSON on stdout; logs go to stderr', () => {
    const out = runCli(['preset', 'export', APP_WITH_ROLE, '--out', '-', '--yes']);
    expect(out.status).toBe(0);
    // stdout must parse as a single JSON object and carry no secret.
    const parsed = JSON.parse(out.stdout);
    expect(parsed.botmuxPreset).toBe(1);
    expect(parsed.teamRole).toContain('INTERNAL_NOTE_xyz');
    expect(out.stdout).not.toContain(SECRET);
    // the human hint is on stderr, keeping stdout clean.
    expect(out.stderr).toContain('不含任何密钥');
  });

  it('non-TTY without --yes fails fast (does not block on a prompt)', () => {
    const out = runCli(['preset', 'export', APP_WITH_ROLE, '--out', '-']);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('--yes');
    expect(out.stdout).toBe(''); // nothing written to stdout
  });

  it('empty team role still exits 0 (warns on stderr)', () => {
    const out = runCli(['preset', 'export', APP_NO_ROLE, '--out', '-', '--yes']);
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.botmuxPreset).toBe(1);
    expect(parsed.teamRole).toBeUndefined();
    expect(out.stderr).toMatch(/没有 team 级角色|没有.*角色/);
  });

  it('value-less --from-chat errors instead of silently exporting team role', () => {
    const out = runCli(['preset', 'export', APP_WITH_ROLE, '--from-chat', '--yes']);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('--from-chat');
  });

  it('value-less --out errors', () => {
    const out = runCli(['preset', 'export', APP_WITH_ROLE, '--out']);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('--out');
  });

  it('unknown bot prints a friendly list and exits 1', () => {
    const out = runCli(['preset', 'export', '__nope__', '--yes']);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('找不到 bot');
  });
});
