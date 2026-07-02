import { execFileSync as defaultExecFileSync } from 'node:child_process';

type GitDescribe = (
  file: string,
  args: string[],
  options: { cwd: string; encoding: BufferEncoding; timeout: number; stdio: ['ignore', 'pipe', 'ignore'] },
) => string;

export interface EffectiveBotmuxVersionOptions {
  /** Desktop can pass a runtimeVersion query override from the native shell. */
  versionOverride?: string | null;
  /** Raw package.json version. Linked local checkouts commonly expose 0.0.0. */
  rawVersion?: string | null;
  /** Install root used as the cwd for git describe fallback. */
  rootDir?: string;
  /** Injectable for tests and desktop discovery probes. */
  execFileSync?: GitDescribe;
}

/**
 * User-facing botmux version. Published installs use package.json; linked
 * local checkouts can carry placeholder 0.0.0, so derive the nearest release
 * tag instead.
 */
export function resolveEffectiveBotmuxVersion(options: EffectiveBotmuxVersionOptions): string {
  const override = normalizeBotmuxVersion(options.versionOverride);
  if (override) return override;

  const normalizedRaw = normalizeBotmuxVersion(options.rawVersion);
  if (normalizedRaw && normalizedRaw !== '0.0.0') return normalizedRaw;

  const tag = options.rootDir ? resolveGitTagVersion(options.rootDir, options.execFileSync) : null;
  return tag ?? normalizedRaw ?? '0.0.0';
}

export function normalizeBotmuxVersion(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const version = raw.trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

function resolveGitTagVersion(rootDir: string, execFile: GitDescribe = defaultExecFileSync as unknown as GitDescribe): string | null {
  try {
    const tag = execFile('git', ['describe', '--tags', '--abbrev=0'], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return normalizeBotmuxVersion(tag);
  } catch {
    return null;
  }
}
