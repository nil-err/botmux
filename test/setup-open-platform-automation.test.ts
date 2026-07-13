/**
 * Unit tests for Open Platform setup automation helpers.
 *
 * Run: pnpm vitest run test/setup-open-platform-automation.test.ts
 */
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  automateOpenPlatformSetup,
  botmuxFeishuSessionFilePath,
  buildEventSubscriptionPayload,
  buildFeishuQrPayload,
  buildSafeSettingPayload,
  buildScopeUpdatePayload,
  extractOpenPlatformCsrfToken,
  extractOpenPlatformEventState,
  extractOpenPlatformScopeEntries,
  getCookieHeader,
  mapFeishuQrPollingStatus,
  mapManifestScopesToOpenPlatformIds,
  parseSetupOpenPlatformAutoFlag,
  prepareFeishuWebSession,
  readStoredCookiesFromSessionFile,
  type StoredCookie,
  writeStoredCookiesToSessionFile,
} from '../src/setup/open-platform-automation.js';

const VC_APP_EVENTS = [
  'vc.bot.meeting_invited_v1',
  'vc.bot.meeting_activity_v1',
  'vc.bot.meeting_ended_v1',
];
const VC_USER_EVENTS = ['vc.meeting.participant_meeting_joined_v1'];

function cookie(overrides: Partial<StoredCookie> = {}): StoredCookie {
  return {
    name: 'session',
    value: 'secret-cookie-value',
    domain: '.feishu.cn',
    path: '/',
    secure: true,
    httpOnly: true,
    hostOnly: false,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function eventResponse(
  appEvents: string[] = [],
  userEvents: string[] = [],
  eventMode: number | null = 4,
) {
  const group = (ids: string[]) => ids.length > 0 ? [{ items: ids.map(id => ({ id })) }] : [];
  return Response.json({
    code: 0,
    data: {
      ...(eventMode === null ? {} : { eventMode }),
      events: [...appEvents, ...userEvents],
      appEventDetails: group(appEvents),
      userEventDetails: group(userEvents),
    },
  });
}

describe('parseSetupOpenPlatformAutoFlag', () => {
  it('is enabled by default, supports explicit skip, and keeps --open-platform-auto compatible', () => {
    expect(parseSetupOpenPlatformAutoFlag([])).toBe(true);
    expect(parseSetupOpenPlatformAutoFlag(['--open-platform-auto'])).toBe(true);
    expect(parseSetupOpenPlatformAutoFlag(['--no-open-platform-auto'])).toBe(false);
    expect(parseSetupOpenPlatformAutoFlag(['--open-platform-auto', '--no-open-platform-auto'])).toBe(false);
    expect(parseSetupOpenPlatformAutoFlag(['--no-open-platform-auto', '--open-platform-auto'])).toBe(true);
  });
});

describe('botmux Feishu session cookie adapter', () => {
  it('writes private botmux cookie jar and builds scoped cookie headers without expired cookies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const file = join(dir, 'feishu_session.json');
    writeStoredCookiesToSessionFile(file, [
      cookie(),
      cookie({ name: 'expired', value: 'gone', expiresAt: Date.now() - 10 }),
      cookie({ name: 'askOnly', value: 'nope', domain: 'ask.feishu.cn', hostOnly: true }),
    ]);

    const cookies = readStoredCookiesFromSessionFile(file);
    expect(cookies?.map(c => c.name)).toEqual(['session', 'askOnly']);
    expect(getCookieHeader(cookies ?? [], 'https://open.feishu.cn/app/cli_x/auth')).toBe('session=secret-cookie-value');
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('resolves botmux session path under config dir', () => {
    expect(botmuxFeishuSessionFilePath('/tmp/botmux-config')).toBe('/tmp/botmux-config/feishu-session.json');
  });
});

describe('Open Platform payload helpers', () => {
  it('builds Feishu QR payload and maps polling status', () => {
    expect(buildFeishuQrPayload('qr-token')).toBe(JSON.stringify({ qrlogin: { token: 'qr-token' } }));
    expect(mapFeishuQrPollingStatus(2)).toBe('已经扫码，等待手机确认');
    expect(mapFeishuQrPollingStatus(5)).toBe('二维码已过期');
    expect(mapFeishuQrPollingStatus(null)).toBe('等待飞书扫码');
  });

  it('extracts window.csrfToken from page HTML', () => {
    expect(extractOpenPlatformCsrfToken('<script>window.csrfToken = "csrf_123"</script>')).toBe('csrf_123');
  });

  it('maps tenant/user scope names to Open Platform IDs and builds payloads', () => {
    const entries = extractOpenPlatformScopeEntries({
      data: {
        appScopeList: [{ id: 101, name: 'im:message' }],
        userScopeList: [{ scopeId: '202', scopeName: 'auth:user_access_token:read' }],
      },
    });
    const mapped = mapManifestScopesToOpenPlatformIds(
      { scopes: { tenant: ['im:message'], user: ['auth:user_access_token:read'] } },
      entries,
    );

    expect(mapped).toEqual({
      tenantScopeIds: ['101'],
      userScopeIds: ['202'],
      missingTenantScopes: [],
      missingUserScopes: [],
    });
    expect(buildScopeUpdatePayload('cli_x', mapped)).toMatchObject({
      clientId: 'cli_x',
      appScopeIDs: ['101'],
      userScopeIDs: ['202'],
      operation: 'add',
      isDeveloperPanel: true,
    });
    expect(buildSafeSettingPayload('cli_x').redirectURL).toEqual(['http://127.0.0.1:9768/callback']);
  });

  it('builds the incremental event payload and extracts identity-specific subscriptions', () => {
    expect(buildEventSubscriptionPayload('cli_x', 4, VC_APP_EVENTS, VC_USER_EVENTS)).toEqual({
      clientId: 'cli_x',
      operation: 'add',
      events: [],
      appEvents: VC_APP_EVENTS,
      userEvents: VC_USER_EVENTS,
      eventMode: 4,
    });
    expect(buildEventSubscriptionPayload('cli_x', 4, VC_APP_EVENTS, VC_USER_EVENTS)).not.toMatchObject({
      eventNames: expect.anything(),
      eventNameList: expect.anything(),
      isDeveloperPanel: expect.anything(),
    });

    expect(extractOpenPlatformEventState({
      code: 0,
      data: {
        eventMode: 4,
        appEventDetails: [{ items: VC_APP_EVENTS.map(id => ({ id })) }],
        userEventDetails: [{ items: VC_USER_EVENTS.map(id => ({ id })) }],
      },
    })).toEqual({
      eventMode: 4,
      events: [...VC_APP_EVENTS, ...VC_USER_EVENTS],
      appEvents: VC_APP_EVENTS,
      userEvents: VC_USER_EVENTS,
      hasIdentityGroups: true,
    });
  });
});

describe('prepareFeishuWebSession', () => {
  it('gets a new botmux session via built-in Feishu QR login and saves it privately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    const qrPayloads: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/accounts/qrlogin/init')) {
        return Response.json(
          { code: 0, data: { step_info: { token: 'qr-token' } } },
          { headers: { 'x-flow-key': 'flow-key' } },
        );
      }
      if (href.includes('/accounts/qrlogin/polling')) {
        return Response.json({
          code: 0,
          data: {
            next_step: 'enter_app',
            step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross-login' },
          },
        });
      }
      if (href === 'https://accounts.feishu.cn/cross-login') {
        return new Response('', {
          status: 302,
          headers: {
            location: 'https://ask.feishu.cn/',
            'set-cookie': 'session=secret-cookie-value; Domain=.feishu.cn; Path=/; Secure; HttpOnly',
          },
        });
      }
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await prepareFeishuWebSession({
      sessionFilePath: sessionFile,
      fetchImpl,
      pollIntervalMs: 0,
      maxWaitMs: 1000,
      onQrCode: ({ qrPayload }) => qrPayloads.push(qrPayload),
    });

    expect(result.ok && result.source).toBe('qr_login');
    expect(qrPayloads).toEqual([JSON.stringify({ qrlogin: { token: 'qr-token' } })]);
    expect(readStoredCookiesFromSessionFile(sessionFile)?.map(c => c.name)).toContain('session');
    if (process.platform !== 'win32') {
      expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
    }
  });

  it('uses old bytedcli session file only as fallback after built-in QR login fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    const fallbackSessionFile = join(dir, 'bytedcli-feishu-session.json');
    writeFileSync(fallbackSessionFile, JSON.stringify({ cookies: [cookie()] }));
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/accounts/qrlogin/init')) throw new Error('login down');
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await prepareFeishuWebSession({
      sessionFilePath: sessionFile,
      bytedcliFallbackSessionFilePath: fallbackSessionFile,
      fetchImpl,
      onQrCode: () => {},
    });

    expect(result.ok && result.source).toBe('bytedcli_fallback');
    expect(readStoredCookiesFromSessionFile(sessionFile)?.map(c => c.name)).toContain('session');
  });
});

describe('automateOpenPlatformSetup', () => {
  it('returns login failure so setup can fall back to manual steps without aborting', async () => {
    const fetchImpl = (async () => {
      throw new Error('login down');
    }) as typeof fetch;
    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: join(tmpdir(), `botmux-missing-${Date.now()}.json`),
      disableBytedcliFallback: true,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
      onQrCode: () => {},
      maxWaitMs: 1,
    });

    expect(result).toMatchObject({ ok: false, reason: 'login_failed' });
  });

  it('uses botmux session cookies, page csrf, and calls the expected Open Platform endpoints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let eventsUpdated = false;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init: init ?? {} });
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) {
        return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      }
      if (href.includes('/scope/all/')) {
        return Response.json({
          code: 0,
          data: {
            appScopeList: [{ id: 'tenant-1', name: 'im:message' }],
            userScopeList: [{ id: 'user-1', name: 'auth:user_access_token:read' }],
          },
        });
      }
      if (href.includes('/event/update/')) {
        eventsUpdated = true;
        return Response.json({ code: 0 });
      }
      if (href.includes('/event/')) {
        return eventsUpdated ? eventResponse(VC_APP_EVENTS, VC_USER_EVENTS) : eventResponse();
      }
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: ['auth:user_access_token:read'] } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sessionSource).toBe('botmux_cache');
    expect(calls.filter(call => new URL(call.url).host === 'open.feishu.cn').map(call => new URL(call.url).pathname)).toEqual([
      '/app/cli_x/auth',
      '/developers/v1/scope/all/cli_x',
      '/developers/v1/scope/update/cli_x',
      '/developers/v1/event/cli_x',
      '/developers/v1/event/update/cli_x',
      '/developers/v1/event/cli_x',
      '/developers/v1/safe_setting/update/cli_x',
      '/developers/v1/contact_range/cli_x',
      '/developers/v1/app_version/list/cli_x',
      '/developers/v1/app_version/create/cli_x',
      '/developers/v1/publish/commit/cli_x/v1',
    ]);
    const updateCall = calls.find(call => call.url.includes('/scope/update/'));
    expect(new Headers(updateCall?.init.headers).get('x-csrf-token')).toBe('csrf_auto');
    expect(new Headers(updateCall?.init.headers).get('cookie')).toBe('session=secret-cookie-value');
    expect(JSON.parse(String(updateCall?.init.body))).toMatchObject({
      clientId: 'cli_x',
      appScopeIDs: ['tenant-1'],
      userScopeIDs: ['user-1'],
    });
    const eventUpdateCall = calls.find(call => call.url.includes('/event/update/'));
    expect(JSON.parse(String(eventUpdateCall?.init.body))).toEqual({
      clientId: 'cli_x',
      operation: 'add',
      events: [],
      appEvents: VC_APP_EVENTS,
      userEvents: VC_USER_EVENTS,
      eventMode: 4,
    });
  });

  it('uses the redirected Open Platform origin for API calls and referer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let eventsUpdated = false;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init: init ?? {} });
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href === 'https://open.feishu.cn/app/cli_x/auth') {
        return new Response('', {
          status: 302,
          headers: { location: 'https://open.larkoffice.com/app/cli_x/auth' },
        });
      }
      if (href === 'https://open.larkoffice.com/app/cli_x/auth') {
        return new Response('<script>window.csrfToken="csrf_larkoffice"</script>', {
          status: 200,
          headers: {
            'set-cookie': 'lark_oapi_csrf_token=csrf_larkoffice_cookie; Domain=.larkoffice.com; Path=/; Secure',
          },
        });
      }
      if (href.includes('/scope/all/')) {
        return Response.json({
          code: 0,
          data: {
            appScopeList: [{ id: 'tenant-1', name: 'im:message' }],
            userScopeList: [{ id: 'user-1', name: 'auth:user_access_token:read' }],
          },
        });
      }
      if (href.includes('/event/update/')) {
        eventsUpdated = true;
        return Response.json({ code: 0 });
      }
      if (href.includes('/event/')) {
        return eventsUpdated ? eventResponse(VC_APP_EVENTS, VC_USER_EVENTS) : eventResponse();
      }
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: ['auth:user_access_token:read'] } },
    });

    expect(result.ok).toBe(true);
    expect(calls.filter(call => new URL(call.url).host === 'open.larkoffice.com').map(call => new URL(call.url).pathname)).toEqual([
      '/app/cli_x/auth',
      '/developers/v1/scope/all/cli_x',
      '/developers/v1/scope/update/cli_x',
      '/developers/v1/event/cli_x',
      '/developers/v1/event/update/cli_x',
      '/developers/v1/event/cli_x',
      '/developers/v1/safe_setting/update/cli_x',
      '/developers/v1/contact_range/cli_x',
      '/developers/v1/app_version/list/cli_x',
      '/developers/v1/app_version/create/cli_x',
      '/developers/v1/publish/commit/cli_x/v1',
    ]);
    const updateCall = calls.find(call => call.url === 'https://open.larkoffice.com/developers/v1/scope/update/cli_x');
    const updateHeaders = new Headers(updateCall?.init.headers);
    expect(updateHeaders.get('origin')).toBe('https://open.larkoffice.com');
    expect(updateHeaders.get('referer')).toBe('https://open.larkoffice.com/app/cli_x');
    expect(updateHeaders.get('x-csrf-token')).toBe('csrf_larkoffice');
    expect(updateHeaders.get('cookie')).toContain('lark_oapi_csrf_token=csrf_larkoffice_cookie');
  });

  it('treats a rejected scope batch as success (partial-permission tenants) and still configures redirect + version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) {
        return Response.json({ code: 0, data: { appScopeList: [{ id: 't1', name: 'im:message' }], userScopeList: [] } });
      }
      if (href.includes('/scope/update/')) return Response.json({ code: 1, msg: 'scope not grantable for tenant' });
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopeCount).toBe(0);
      expect(result.scopeWarning).toBeTruthy();
      expect(result.versionId).toBe('v1');
    }
    // 权限被租户拒绝不阻塞后续：redirect / 版本 / 发布仍然走完。
    expect(calls.some(u => u.includes('/safe_setting/update/'))).toBe(true);
    expect(calls.some(u => u.includes('/publish/commit/'))).toBe(true);
  });

  it('skips scope update when no manifest scope exists in this tenant catalog, still succeeding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) {
        return Response.json({ code: 0, data: { appScopeList: [], userScopeList: [] } });
      }
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message', 'contact:user.base:readonly'], user: ['auth:user_access_token:read'] } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopeCount).toBe(0);
      expect(result.skippedScopeCount).toBe(3);
    }
    expect(calls.some(u => u.includes('/scope/update/'))).toBe(false);
  });

  it('accepts an already-complete manual subscription without sending an update', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) return Response.json({ code: 0, data: { appScopeList: [], userScopeList: [] } });
      if (href.includes('/event/')) return eventResponse(VC_APP_EVENTS, VC_USER_EVENTS);
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: [], user: [] } },
      requireVcMeetingEvents: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subscribedEventCount).toBe(4);
      expect(result.eventReady).toBe(true);
      expect(result.missingEventNames).toEqual([]);
    }
    expect(calls.some(url => url.includes('/event/update/'))).toBe(false);
  });

  it('adds only missing identity-specific VC events and verifies them by readback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let eventsUpdated = false;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init });
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) return Response.json({ code: 0, data: { appScopeList: [], userScopeList: [] } });
      if (href.includes('/event/update/')) {
        eventsUpdated = true;
        return Response.json({ code: 0 });
      }
      if (href.includes('/event/')) {
        return eventsUpdated
          ? eventResponse(VC_APP_EVENTS, VC_USER_EVENTS)
          : eventResponse([VC_APP_EVENTS[0]], VC_USER_EVENTS);
      }
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: [], user: [] } },
      requireVcMeetingEvents: true,
    });

    expect(result.ok).toBe(true);
    const updateCall = calls.find(call => call.url.includes('/event/update/'));
    expect(JSON.parse(String(updateCall?.init?.body))).toEqual({
      clientId: 'cli_x',
      operation: 'add',
      events: [],
      appEvents: VC_APP_EVENTS.slice(1),
      userEvents: [],
      eventMode: 4,
    });
    expect(calls.some(call => call.url.includes('/event_callback/update/'))).toBe(false);
  });

  it('fails before version publishing when update and readback leave VC events missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) return Response.json({ code: 0, data: { appScopeList: [], userScopeList: [] } });
      if (href.includes('/event/update/')) return Response.json({ code: 42, msg: 'bad event payload' });
      if (href.includes('/event/')) return eventResponse();
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: [], user: [] } },
      requireVcMeetingEvents: true,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'api_error',
      subscribedEventCount: 0,
      missingEventNames: [...VC_APP_EVENTS, ...VC_USER_EVENTS],
    });
    if (!result.ok) {
      expect(result.eventWarning).toContain('code=42');
      expect(result.eventWarning).toContain('回读后仍缺少 VC 事件');
    }
    expect(calls.some(url => url.includes('/safe_setting/update/'))).toBe(false);
    expect(calls.some(url => url.includes('/app_version/create/'))).toBe(false);
    expect(calls.some(url => url.includes('/publish/commit/'))).toBe(false);
    expect(calls.some(url => url.includes('/event_callback/update/'))).toBe(false);
  });

  it('allows a transient update error when readback confirms all VC events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    let eventReads = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) return Response.json({ code: 0, data: { appScopeList: [], userScopeList: [] } });
      if (href.includes('/event/update/')) return Response.json({ code: 42, msg: 'raced with manual update' });
      if (href.includes('/event/')) {
        eventReads += 1;
        return eventReads === 1 ? eventResponse() : eventResponse(VC_APP_EVENTS, VC_USER_EVENTS);
      }
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: [], user: [] } },
      requireVcMeetingEvents: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subscribedEventCount).toBe(4);
      expect(result.eventReady).toBe(true);
      expect(result.missingEventNames).toEqual([]);
      expect(result.eventWarning).toContain('code=42');
    }
  });

  it('returns a hard failure when publishing fails after VC events are verified', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) return Response.json({ code: 0, data: { appScopeList: [], userScopeList: [] } });
      if (href.includes('/event/')) return eventResponse(VC_APP_EVENTS, VC_USER_EVENTS);
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      if (href.includes('/publish/commit/')) return Response.json({ code: 42, msg: 'publish denied' });
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: [], user: [] } },
      requireVcMeetingEvents: true,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'api_error',
      eventReady: true,
      subscribedEventCount: 4,
      missingEventNames: [],
    });
    if (!result.ok) expect(result.message).toContain('publish denied');
    expect(calls.some(url => url.includes('/publish/commit/'))).toBe(true);
  });

  it('returns a hard failure when version creation omits the version id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) return Response.json({ code: 0, data: { appScopeList: [], userScopeList: [] } });
      if (href.includes('/event/')) return eventResponse(VC_APP_EVENTS, VC_USER_EVENTS);
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: {} });
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: [], user: [] } },
      requireVcMeetingEvents: true,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'api_error',
      eventReady: true,
      subscribedEventCount: 4,
      missingEventNames: [],
    });
    if (!result.ok) expect(result.message).toContain('versionId');
    expect(calls.some(url => url.includes('/publish/commit/'))).toBe(false);
  });

  it('rejects a complete subscription that is still in webhook mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) return Response.json({ code: 0, data: { appScopeList: [], userScopeList: [] } });
      if (href.includes('/event/')) return eventResponse(VC_APP_EVENTS, VC_USER_EVENTS, 1);
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: [], user: [] } },
      requireVcMeetingEvents: true,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'api_error',
      eventReady: false,
      subscribedEventCount: 4,
      missingEventNames: [],
    });
    if (!result.ok) expect(result.eventWarning).toContain('长连接模式 4');
    expect(calls.some(url => url.includes('/event/update/'))).toBe(false);
    expect(calls.some(url => url.includes('/safe_setting/update/'))).toBe(false);
  });

  it('rejects complete identity groups when the event mode is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) return Response.json({ code: 0, data: { appScopeList: [], userScopeList: [] } });
      if (href.includes('/event/')) return eventResponse(VC_APP_EVENTS, VC_USER_EVENTS, null);
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: [], user: [] } },
      requireVcMeetingEvents: true,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'api_error',
      eventReady: false,
      subscribedEventCount: 4,
      missingEventNames: [],
    });
    if (!result.ok) expect(result.eventWarning).toContain('缺少有效 eventMode');
    expect(calls.some(url => url.includes('/event/update/'))).toBe(false);
    expect(calls.some(url => url.includes('/safe_setting/update/'))).toBe(false);
  });

  it('does not accept a flat event list without App/User identity groups', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) return Response.json({ code: 0, data: { appScopeList: [], userScopeList: [] } });
      if (href.includes('/event/')) {
        return Response.json({
          code: 0,
          data: { eventMode: 4, events: [...VC_APP_EVENTS, ...VC_USER_EVENTS] },
        });
      }
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: [], user: [] } },
      requireVcMeetingEvents: true,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'api_error',
      eventReady: false,
      subscribedEventCount: 0,
      missingEventNames: [...VC_APP_EVENTS, ...VC_USER_EVENTS],
    });
    if (!result.ok) expect(result.eventWarning).toContain('缺少 App/User 身份分组');
    expect(calls.some(url => url.includes('/event/update/'))).toBe(false);
    expect(calls.some(url => url.includes('/safe_setting/update/'))).toBe(false);
  });

  it('does not guess an event mode when the read response omits it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) return Response.json({ code: 0, data: { appScopeList: [], userScopeList: [] } });
      if (href.includes('/event/')) return eventResponse([], [], null);
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: [], user: [] } },
      requireVcMeetingEvents: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.eventWarning).toContain('缺少有效 eventMode');
    expect(calls.some(url => url.includes('/event/update/'))).toBe(false);
    expect(calls.some(url => url.includes('/safe_setting/update/'))).toBe(false);
  });
});
