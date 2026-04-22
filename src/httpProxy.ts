import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { HttpResponse, RequestState } from './types';

// ── Safety limits ─────────────────────────────────────────────────────────────
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_PARAM_COUNT = 50;

function substitutePathParams(
  routePath: string,
  values: Record<string, string>
): string {
  let result = routePath.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name) => {
    return encodeURIComponent(values[name] ?? `:${name}`);
  });
  result = result.replace(/\$\{([^}]+)\}/g, (_match, expr) => {
    const val = values[expr];
    return val !== undefined && val !== ''
      ? encodeURIComponent(val)
      : encodeURIComponent(`\${${expr}}`);
  });
  return result;
}

/**
 * Send an HTTP request from the server side.
 * Running server-side avoids CORS issues when the target API is on a different origin.
 *
 * @param state   - The full request state from the browser UI
 * @param variables - Map of variable name → value for {{VAR}} substitution
 */
export function sendHttpRequest(
  state: RequestState,
  variables: Record<string, string> = {}
): Promise<HttpResponse> {
  const sub = (text: string): string => {
    if (!text || !text.includes('{{')) return text;
    return text.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_m, name) =>
      name in variables ? variables[name] : _m
    );
  };

  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      if (state.overrideFullUrl) {
        url = new URL(sub(state.overrideFullUrl));
      } else {
        const resolvedPath = substitutePathParams(
          state.route.path,
          Object.fromEntries(
            Object.entries(state.pathParamValues).map(([k, v]) => [k, sub(v)])
          )
        );
        url = new URL(sub(state.baseUrl).replace(/\/$/, '') + resolvedPath);
      }
    } catch {
      return reject(new Error('Invalid request URL'));
    }

    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      return reject(
        new Error(`Protocol "${url.protocol}" is not allowed. Use http or https.`)
      );
    }

    const queryParams = (state.queryParams ?? []).slice(0, MAX_PARAM_COUNT);
    const headers = (state.headers ?? []).slice(0, MAX_PARAM_COUNT);
    const cookies = (state.cookies ?? []).slice(0, MAX_PARAM_COUNT);

    for (const q of queryParams) {
      if (q.enabled && q.key.trim()) {
        url.searchParams.append(sub(q.key), sub(q.value));
      }
    }

    const reqHeaders: Record<string, string> = {};
    for (const h of headers) {
      if (!h.enabled || !h.key.trim()) continue;
      const safeKey = sub(h.key).replace(/[\r\n]/g, '');
      const safeVal = sub(h.value).replace(/[\r\n]/g, '');
      reqHeaders[safeKey] = safeVal;
    }

    // Build Cookie header from the cookie jar (only if user hasn't set one manually)
    const enabledCookies = cookies.filter(c => c.enabled && c.name.trim());
    if (enabledCookies.length > 0 && !reqHeaders['Cookie'] && !reqHeaders['cookie']) {
      reqHeaders['Cookie'] = enabledCookies
        .map(c => `${sub(c.name).replace(/[\r\n]/g, '')}=${sub(c.value).replace(/[\r\n]/g, '')}`)
        .join('; ');
    }

    let bodyBuffer: Buffer | undefined;
    if (
      state.bodyEnabled &&
      state.body?.trim() &&
      state.route.method !== 'GET'
    ) {
      bodyBuffer = Buffer.from(sub(state.body), 'utf8');
      if (!reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
        reqHeaders['Content-Type'] = 'application/json';
      }
      reqHeaders['Content-Length'] = String(bodyBuffer.length);
    }

    const lib = url.protocol === 'https:' ? https : http;
    const start = Date.now();

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: state.route.method,
      headers: reqHeaders,
    };

    const req = lib.request(options, (res) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let truncated = false;

      res.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          truncated = true;
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        const body = truncated
          ? Buffer.concat(chunks).toString('utf8') +
            `\n\n[Response truncated: exceeded ${MAX_RESPONSE_BYTES / (1024 * 1024)} MB limit]`
          : Buffer.concat(chunks).toString('utf8');

        const durationMs = Date.now() - start;

        let bodyParsed: unknown = null;
        if (!truncated) {
          try { bodyParsed = JSON.parse(body); } catch { /* not JSON */ }
        }

        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (value !== undefined && key !== 'set-cookie') {
            responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
          }
        }

        // Extract Set-Cookie headers separately (always an array in Node's http module)
        const rawSetCookie = res.headers['set-cookie'];
        const setCookies: string[] = rawSetCookie
          ? (Array.isArray(rawSetCookie) ? rawSetCookie : [rawSetCookie])
          : [];

        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          headers: responseHeaders,
          body,
          bodyParsed,
          durationMs,
          size: totalBytes,
          setCookies,
        });
      });

      res.on('error', (err: Error) => {
        if (!truncated) reject(err);
      });
    });

    req.on('error', (err: Error) => {
      if (!err.message.includes('socket hang up') || !req.destroyed) {
        reject(err);
      }
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timed out after 30 seconds'));
    });

    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}
