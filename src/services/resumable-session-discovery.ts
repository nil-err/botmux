/**
 * Resumable-session discovery — scan a CLI's on-disk transcript store and
 * surface the sessions a user can *resume* (paseo-style import), independent of
 * whether the original CLI is still running in tmux. This powers the second
 * filter of `/adopt`: pick a stored session → botmux spawns a fresh worker that
 * runs `<cli> --resume <id>` in the recorded cwd.
 *
 * Three storage shapes are covered (one parser each, shared across CLIs):
 *   - Claude-family JSONL  (`claude-code`, `seed`): <dataDir>/projects/<hash>/<id>.jsonl
 *   - Codex/TRAE rollout   (`codex`, `traex`):       <sessionsRoot>/YYYY/MM/DD/rollout-*.jsonl
 *   - Antigravity history  (`antigravity`):          <home>/history.jsonl (flat submit log)
 *
 * All scans are daemon-side, pure filesystem (no PTY / subprocess), and run
 * only on an explicit `/adopt` — so we favour correctness + bounded I/O over
 * cleverness: take the most-recent files by mtime, read a bounded prefix of
 * each (session id / cwd / first prompt all live near the top), parse line by
 * line, stop early.
 */
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type { ResumableSession } from '../adapters/cli/types.js';

/** Bytes read from the head of each transcript. The session id, cwd and the
 *  first user prompt all appear within the first handful of lines, so a bounded
 *  prefix avoids loading multi-MB transcripts while still finding everything. */
const PREFIX_BYTES = 128 * 1024;
const TITLE_MAX = 80;

/** Read at most `maxBytes` from the head of a file. Returns '' on any error
 *  (missing / unreadable). A trailing partial line is fine — JSON.parse simply
 *  skips it. */
async function readPrefix(path: string, maxBytes = PREFIX_BYTES): Promise<string> {
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(path, 'r');
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    try { await fh?.close(); } catch { /* ignore */ }
  }
}

function* iterJsonLines(content: string): Generator<unknown> {
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // Partial trailing line (prefix cut) or corrupt entry — skip.
    }
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function truncateTitle(text: string): string {
  const norm = text.replace(/\s+/g, ' ').trim();
  if (!norm) return '';
  return norm.length > TITLE_MAX ? `${norm.slice(0, TITLE_MAX - 1)}…` : norm;
}

/** botmux wraps every forwarded user message before handing it to the CLI, in
 *  one of two historical shapes: `<user_message>…</user_message>` (current) or
 *  `用户发送了：\n---\n<text>\n---\n…` (older). For a cleaner picker title, peel the
 *  wrapper off when present; otherwise return as-is (sessions started outside
 *  botmux carry the raw prompt and are left untouched). */
function unwrapBotmuxPrompt(text: string): string {
  const xml = text.match(/<user_message>\s*([\s\S]*?)\s*<\/user_message>/);
  if (xml) return xml[1]!;
  const legacy = text.match(/^用户发送了：\s*\n-{3,}\n([\s\S]*?)\n-{3,}/);
  return legacy ? legacy[1]! : text;
}

interface FileEntry { path: string; mtimeMs: number; }

/** Recursively collect `*.jsonl` files under `root`, returning the most-recently
 *  modified `limit` of them. Bounded depth so a pathological tree can't wedge
 *  the scan. */
async function collectRecentJsonl(root: string, limit: number, maxDepth = 4): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(dirents.map(async (d) => {
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        await walk(full, depth + 1);
      } else if (d.isFile() && d.name.endsWith('.jsonl')) {
        try {
          const st = await fs.stat(full);
          out.push({ path: full, mtimeMs: st.mtimeMs });
        } catch { /* ignore */ }
      }
    }));
  }
  await walk(root, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

// ─── Claude-family JSONL (claude-code, seed) ─────────────────────────────────

/** Parse one Claude JSONL transcript head. The session id is the filename;
 *  cwd + first user prompt come from the content. Sidechain / synthetic /
 *  slash-command entries are skipped so the title is the user's real first turn. */
function parseClaudeTranscript(path: string, content: string, mtimeMs: number): ResumableSession | null {
  const cliSessionId = basename(path, '.jsonl');
  if (!cliSessionId) return null;
  let cwd: string | null = null;
  let title = '';
  for (const entry of iterJsonLines(content)) {
    const rec = asRecord(entry);
    if (!rec) continue;
    if (rec.isSidechain === true) continue;
    if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;
    if (!title && rec.type === 'user') {
      const text = extractClaudeUserText(rec.message);
      if (text) title = truncateTitle(text);
    }
    if (cwd && title) break;
  }
  if (!cwd) return null;
  return { cliSessionId, cwd, title: title || `Claude ${cliSessionId.slice(0, 8)}`, lastActivityAt: mtimeMs };
}

/** Pull plain user text out of a Claude `message` field, skipping tool-result
 *  array content and slash-command meta lines (which start with `<command-…>`
 *  or are pure `/cmd` invocations — not a meaningful conversation title). */
function extractClaudeUserText(message: unknown): string | null {
  const msg = asRecord(message);
  if (!msg || msg.role !== 'user') return null;
  let text: string | null = null;
  if (typeof msg.content === 'string') {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    const part = msg.content.find((p) => asRecord(p)?.type === 'text');
    const t = asRecord(part)?.text;
    if (typeof t === 'string') text = t;
  }
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('<command-') || trimmed.startsWith('<local-command')) return null;
  return unwrapBotmuxPrompt(trimmed);
}

export async function discoverClaudeFamilySessions(dataDir: string, limit: number): Promise<ResumableSession[]> {
  const projectsRoot = join(dataDir, 'projects');
  const files = await collectRecentJsonl(projectsRoot, limit * 3, 2);
  const parsed = await Promise.all(files.map(async (f) =>
    parseClaudeTranscript(f.path, await readPrefix(f.path), f.mtimeMs)));
  return parsed.filter((s): s is ResumableSession => s !== null).slice(0, limit);
}

// ─── Codex / TRAE rollout (codex, traex) ─────────────────────────────────────

/** Parse one Codex/TRAE rollout head. `session_meta` carries the resume id +
 *  cwd; the first `event_msg`/`user_message` carries the user's first prompt
 *  (the `response_item` role:user entries include the synthetic
 *  <environment_context>/<permissions> preamble, so we prefer user_message). */
function parseRolloutTranscript(content: string, mtimeMs: number): ResumableSession | null {
  let cliSessionId: string | null = null;
  let cwd: string | null = null;
  let title = '';
  for (const entry of iterJsonLines(content)) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const payload = asRecord(rec.payload);
    if (rec.type === 'session_meta' && payload) {
      if (typeof payload.id === 'string') cliSessionId = payload.id;
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
    } else if (!title && rec.type === 'event_msg' && payload?.type === 'user_message') {
      if (typeof payload.message === 'string') title = truncateTitle(unwrapBotmuxPrompt(payload.message));
    }
    if (cliSessionId && cwd && title) break;
  }
  if (!cliSessionId || !cwd) return null;
  return { cliSessionId, cwd, title: title || `Session ${cliSessionId.slice(0, 8)}`, lastActivityAt: mtimeMs };
}

export async function discoverRolloutSessions(sessionsRoot: string, limit: number): Promise<ResumableSession[]> {
  const files = await collectRecentJsonl(sessionsRoot, limit * 3, 5);
  const parsed = await Promise.all(files.map(async (f) =>
    parseRolloutTranscript(await readPrefix(f.path), f.mtimeMs)));
  return parsed.filter((s): s is ResumableSession => s !== null).slice(0, limit);
}

// ─── Antigravity flat history log (antigravity) ──────────────────────────────

/** Antigravity appends one line per submit: `{display, timestamp, workspace,
 *  conversationId}`. Dedup by conversationId keeping the latest timestamp; the
 *  first display seen for a conversation is its title. */
export async function discoverAntigravitySessions(historyPath: string, limit: number): Promise<ResumableSession[]> {
  const content = await readPrefix(historyPath, 4 * 1024 * 1024);
  if (!content) return [];
  const byConversation = new Map<string, ResumableSession>();
  for (const entry of iterJsonLines(content)) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const conversationId = rec.conversationId;
    const workspace = rec.workspace;
    if (typeof conversationId !== 'string' || !conversationId || typeof workspace !== 'string' || !workspace) continue;
    const ts = typeof rec.timestamp === 'number' ? rec.timestamp : 0;
    const display = typeof rec.display === 'string' ? rec.display : '';
    const existing = byConversation.get(conversationId);
    if (!existing) {
      byConversation.set(conversationId, {
        cliSessionId: conversationId,
        cwd: workspace,
        title: truncateTitle(unwrapBotmuxPrompt(display)) || `Conversation ${conversationId.slice(0, 8)}`,
        lastActivityAt: ts,
      });
    } else if (ts > existing.lastActivityAt) {
      existing.lastActivityAt = ts;
    }
  }
  return [...byConversation.values()]
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, limit);
}
