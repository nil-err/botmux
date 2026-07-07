import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { globalConfigPath } from '../src/global-config.js';

const spawnSync = vi.fn();
const execSync = vi.fn();

vi.mock('node:child_process', () => ({
  spawnSync,
  execSync,
}));

function spawnOk(stdout = '') {
  return { status: 0, stdout, stderr: '' };
}

function spawnFail(stderr = 'boom') {
  return { status: 1, stdout: '', stderr };
}

async function loadSubject() {
  vi.resetModules();
  return import('../src/setup/ensure-herdr-integrations.js');
}

describe('ensureHerdrIntegrations TraeX plugin opt-in', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-herdr-int-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_ENABLED', '');
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_SPEC', '');
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
    spawnSync.mockReset();
    execSync.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('does not install anything for traex unless the global opt-in is enabled', async () => {
    const { ensureHerdrIntegrations } = await loadSubject();
    const result = await ensureHerdrIntegrations(['traex']);

    expect(result.traexPlugin).toMatchObject({
      attempted: false,
      enabled: false,
      skippedReason: 'disabled',
    });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('requires an operator-supplied plugin spec when enabled', async () => {
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_ENABLED', 'true');
    const { ensureHerdrIntegrations } = await loadSubject();
    const result = await ensureHerdrIntegrations(['traex']);

    expect(result.traexPlugin).toMatchObject({
      attempted: false,
      enabled: true,
      skippedReason: 'missing_spec',
    });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('installs the configured spec and invokes install action only after a fresh install', async () => {
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_ENABLED', 'true');
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_SPEC', 'trusted/repo#v1');
    spawnSync
      .mockReturnValueOnce(spawnOk('{"result":{"plugins":[]}}'))
      .mockReturnValueOnce(spawnOk('installed'))
      .mockReturnValueOnce(spawnOk('hooks written'));

    const { ensureHerdrIntegrations } = await loadSubject();
    const result = await ensureHerdrIntegrations(['traex']);

    expect(result.traexPlugin).toMatchObject({
      attempted: true,
      enabled: true,
      spec: 'trusted/repo#v1',
      installed: true,
      alreadyInstalled: false,
      actionInvoked: true,
    });
    expect(spawnSync).toHaveBeenNthCalledWith(2, 'herdr', ['plugin', 'install', 'trusted/repo#v1', '--yes'], expect.any(Object));
    expect(spawnSync).toHaveBeenNthCalledWith(3, 'herdr', ['plugin', 'action', 'invoke', 'com.traex.herdr-integration.install'], expect.any(Object));
  });

  it('skips install and action when the plugin is already installed using top-level JSON shape', async () => {
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_ENABLED', 'true');
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_SPEC', 'trusted/repo#v1');
    spawnSync.mockReturnValueOnce(spawnOk('{"plugins":[{"id":"com.traex.herdr-integration"}]}'));

    const { ensureHerdrIntegrations } = await loadSubject();
    const result = await ensureHerdrIntegrations(['traex']);

    expect(result.traexPlugin).toMatchObject({
      attempted: true,
      installed: false,
      alreadyInstalled: true,
      actionInvoked: false,
    });
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it('falls back to substring detection when plugin-list JSON shape is unknown', async () => {
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_ENABLED', 'true');
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_SPEC', 'trusted/repo#v1');
    spawnSync.mockReturnValueOnce(spawnOk('{"unexpected":"com.traex.herdr-integration"}'));

    const { ensureHerdrIntegrations } = await loadSubject();
    const result = await ensureHerdrIntegrations(['traex']);

    expect(result.traexPlugin?.alreadyInstalled).toBe(true);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it('reports install and action failures with a manual command using the configured spec', async () => {
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_ENABLED', 'true');
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_SPEC', 'trusted/repo#v1');
    spawnSync
      .mockReturnValueOnce(spawnOk('{"result":{"plugins":[]}}'))
      .mockReturnValueOnce(spawnFail('network'));

    const { ensureHerdrIntegrations } = await loadSubject();
    const installFail = await ensureHerdrIntegrations(['traex']);
    expect(installFail.traexPlugin?.failed).toMatchObject({
      step: 'install',
      reason: 'network',
      manualCommand: 'herdr plugin install trusted/repo#v1 --yes && herdr plugin action invoke com.traex.herdr-integration.install',
    });

    spawnSync.mockReset();
    spawnSync
      .mockReturnValueOnce(spawnOk('{"result":{"plugins":[]}}'))
      .mockReturnValueOnce(spawnOk('installed'))
      .mockReturnValueOnce(spawnFail('action boom'));
    const actionFail = await ensureHerdrIntegrations(['traex']);
    expect(actionFail.traexPlugin?.failed).toMatchObject({ step: 'action', reason: 'action boom' });
  });
});
