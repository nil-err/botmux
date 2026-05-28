import {
  createServer,
  request as httpRequest,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';
import { logger } from '../utils/logger.js';

/**
 * Single fixed reverse-proxy port per daemon. Each session's xterm.js web
 * terminal runs on its own dynamically-assigned worker port, which makes SSH
 * port-forwarding painful on dev machines (one `ssh -L` per topic). This proxy
 * fronts all of a daemon's session terminals under one stable port, routing by
 * sub-path: `http://host:{proxyPort}/s/{sessionId}/...` → the worker's port.
 * Forward one port, reach every session.
 */

export interface TerminalProxyOptions {
  port: number;
  host?: string;
  /** Resolve a sessionId to its live worker HTTP port (undefined if not running). */
  resolvePort: (sessionId: string) => number | undefined;
}

export interface TerminalProxyHandle {
  port: number;
  close: () => Promise<void>;
}

/**
 * Split a request URL of the form `/s/{sessionId}{rest}` into its sessionId and
 * the remainder that should be forwarded to the worker. The remainder always
 * starts with `/` so the worker sees a normal request (`/`, `/?token=x`, …).
 * Returns null when the URL is not a session route.
 */
export function parseTarget(rawUrl: string): { sessionId: string; rest: string } | null {
  if (!rawUrl.startsWith('/s/')) return null;
  const after = rawUrl.slice(3);
  const m = /^([^/?#]+)(.*)$/.exec(after);
  if (!m || !m[1]) return null;
  const sessionId = m[1];
  let rest = m[2] ?? '';
  // '' → '/', '?x' → '/?x', '#x' → '/#x'; an explicit '/...' is kept as-is.
  if (rest === '' || rest[0] === '?' || rest[0] === '#') rest = '/' + rest;
  return { sessionId, rest };
}

export function startTerminalProxy(opts: TerminalProxyOptions): Promise<TerminalProxyHandle> {
  const host = opts.host ?? '0.0.0.0';

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const parsed = parseTarget(req.url ?? '');
    if (!parsed) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const port = opts.resolvePort(parsed.sessionId);
    if (!port) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('session not running');
      return;
    }
    const upstream = httpRequest(
      { host: '127.0.0.1', port, method: req.method, path: parsed.rest, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('proxy error');
    });
    req.pipe(upstream);
  });

  server.on('upgrade', (req: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
    const parsed = parseTarget(req.url ?? '');
    if (!parsed) return clientSocket.destroy();
    const port = opts.resolvePort(parsed.sessionId);
    if (!port) return clientSocket.destroy();

    const upstream = httpRequest({
      host: '127.0.0.1',
      port,
      method: req.method,
      path: parsed.rest,
      headers: req.headers,
    });
    upstream.on('upgrade', (upRes, upstreamSocket, upstreamHead) => {
      // rawHeaders is a flat [k, v, k, v, ...] list — preserves duplicates/casing.
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
      const rh = upRes.rawHeaders;
      for (let i = 0; i + 1 < rh.length; i += 2) lines.push(`${rh[i]}: ${rh[i + 1]}`);
      lines.push('', '');
      clientSocket.write(lines.join('\r\n'));
      if (upstreamHead?.length) clientSocket.write(upstreamHead);
      if (head?.length) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
      const cleanup = () => { upstreamSocket.destroy(); clientSocket.destroy(); };
      upstreamSocket.on('error', cleanup);
      clientSocket.on('error', cleanup);
      upstreamSocket.on('close', () => clientSocket.destroy());
      clientSocket.on('close', () => upstreamSocket.destroy());
    });
    // Upstream answered without upgrading (e.g. worker rejected the handshake).
    // Relay the response and close the client socket so it doesn't hang. The
    // body arrives already de-chunked, so drop framing headers and let the
    // socket close delimit the response (HTTP/1.1 connection-close framing).
    upstream.on('response', (upRes) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`, 'connection: close'];
      const rh = upRes.rawHeaders;
      for (let i = 0; i + 1 < rh.length; i += 2) {
        const name = rh[i].toLowerCase();
        if (name === 'transfer-encoding' || name === 'content-length' || name === 'connection') continue;
        lines.push(`${rh[i]}: ${rh[i + 1]}`);
      }
      lines.push('', '');
      clientSocket.write(lines.join('\r\n'));
      upRes.on('data', (chunk) => clientSocket.write(chunk));
      upRes.on('end', () => { clientSocket.end(); upRes.socket?.destroy(); });
      upRes.on('error', () => clientSocket.destroy());
    });
    upstream.on('error', () => clientSocket.destroy());
    upstream.end();
  });

  server.on('error', (err) => {
    logger.error(`[terminal-proxy] server error: ${(err as Error).message}`);
  });

  return new Promise<TerminalProxyHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      server.removeListener('error', reject);
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
