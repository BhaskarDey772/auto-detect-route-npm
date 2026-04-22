import * as path from 'path';
import * as fs from 'fs';
import { Router, Request, Response, json as expressJson } from 'express';
import { RouteScanner } from './routeScanner';
import { sendHttpRequest } from './httpProxy';
import { DetectedRoute, RequestState } from './types';

const WEBVIEW_DIR = path.join(__dirname, '..', 'webview');

export interface AutoDetectRouteOptions {
  /**
   * Root directory to scan for routes.
   * Defaults to process.cwd() (the project root).
   */
  rootDir?: string;
  /**
   * Default base URL shown in the UI.
   * Defaults to 'http://localhost:3000'.
   */
  baseUrl?: string;
  /**
   * Extra glob patterns to exclude from scanning (merged with built-in excludes).
   * e.g. ['tests', 'mocks', '__fixtures__']
   */
  exclude?: string[];
  /**
   * Title shown in the browser tab and header.
   * Defaults to 'Auto Detect Route'.
   */
  title?: string;
}

function generateHtml(mountPath: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escAttr(title)}</title>
  <link rel="stylesheet" href="${mountPath}/app.css">
</head>
<body>
  <script>window.__ADR_BASE__ = '${mountPath}';</script>

  <div id="app-wrapper">

    <!-- ── Header ─────────────────────────────────────────────────── -->
    <div class="app-header">
      <div class="header-brand">
        <span class="brand-icon">&#9670;</span>
        <span class="brand-title">${escHtml(title)}</span>
      </div>
      <input id="filter-input" class="filter-input" type="text" placeholder="Filter routes&hellip;">
      <div class="header-controls">
        <div class="group-toggle">
          <button class="group-btn active" id="group-file-btn" data-group="file">File</button>
          <button class="group-btn" id="group-method-btn" data-group="method">Method</button>
        </div>
        <button id="rescan-btn" class="icon-btn" title="Rescan routes">&#8635;</button>
      </div>
    </div>

    <!-- ── Main layout ─────────────────────────────────────────────── -->
    <div class="app-body">

      <!-- Sidebar -->
      <div class="app-sidebar" id="sidebar">
        <div id="route-list" class="route-list">
          <div class="sidebar-state">
            <div class="spinner"></div>
            <span>Scanning routes&hellip;</span>
          </div>
        </div>
      </div>

      <!-- Resize handle -->
      <div class="resize-handle" id="resize-handle"></div>

      <!-- Request / Response Panel -->
      <div class="app-panel" id="panel">

        <!-- Routes updated banner -->
        <div id="routes-updated-banner" class="routes-updated-banner hidden">
          <span>&#8635; Routes rescanned &mdash; </span>
          <span id="routes-updated-count"></span>
          <button id="dismiss-banner-btn" class="dismiss-btn">&#10005;</button>
        </div>

        <!-- URL Bar -->
        <div class="url-bar">
          <span id="method-badge" class="method-badge">GET</span>
          <input id="url-preview" class="url-input" type="text"
            placeholder="Select a route from the sidebar">
          <button id="reload-routes-btn" class="icon-btn" title="Reload Routes">&#8635;</button>
          <button id="open-vars-btn" class="vars-btn" title="Manage Variables ({{VAR}})">&#9674;</button>
          <button id="send-btn" class="send-btn" disabled>Send</button>
        </div>
        <div id="var-warning" class="var-warning hidden"></div>
        <div id="save-flash" class="save-flash hidden">&#10003; Saved</div>

        <!-- Source link -->
        <div id="source-link" class="source-link hidden">
          <span id="source-text"></span>
          <button id="goto-source-btn" class="link-btn">Copy path &#8599;</button>
        </div>

        <!-- Tabs -->
        <div class="tabs">
          <button class="tab active" data-tab="params">Params</button>
          <button class="tab" data-tab="headers">Headers</button>
          <button class="tab" data-tab="cookies">Cookies</button>
          <button class="tab" data-tab="body">Body</button>
        </div>

        <!-- Params Panel -->
        <div id="tab-params" class="tab-panel active">
          <section id="path-params-section" class="param-section hidden">
            <div class="section-label">Path Parameters</div>
            <div id="path-params-list" class="params-list"></div>
          </section>
          <section class="param-section">
            <div class="section-label">
              Query Parameters
              <button id="add-query-btn" class="add-btn">+ Add</button>
            </div>
            <div id="query-params-list" class="params-list">
              <div class="empty-hint">No query parameters yet.</div>
            </div>
          </section>
        </div>

        <!-- Headers Panel -->
        <div id="tab-headers" class="tab-panel hidden">
          <div class="bearer-section">
            <div class="bearer-row">
              <span class="bearer-prefix">Bearer</span>
              <input id="bearer-token" class="bearer-input" type="text"
                placeholder="Token or {{AUTH_TOKEN}}" autocomplete="off">
              <button id="clear-bearer-btn" class="remove-btn" title="Clear token">&#215;</button>
            </div>
            <div class="bearer-hint">
              Sets <code>Authorization: Bearer &lt;token&gt;</code> automatically
            </div>
          </div>
          <div class="section-label">
            Custom Headers
            <button id="add-header-btn" class="add-btn">+ Add</button>
          </div>
          <div id="headers-list" class="params-list">
            <div class="empty-hint">No custom headers yet.</div>
          </div>
        </div>

        <!-- Cookies Panel -->
        <div id="tab-cookies" class="tab-panel hidden">
          <div class="cookie-hint">
            Cookies are sent as a <code>Cookie</code> header. When a response contains
            <code>Set-Cookie</code> headers, they are saved here automatically.
          </div>
          <div class="section-label">
            Cookie Jar
            <button id="add-cookie-btn" class="add-btn">+ Add</button>
            <button id="clear-cookies-btn" class="remove-btn" title="Clear all cookies" style="margin-left:4px">Clear all</button>
          </div>
          <div id="cookies-list" class="params-list">
            <div class="empty-hint">No cookies yet. Send a request that sets cookies — they will appear here automatically.</div>
          </div>
        </div>

        <!-- Body Panel -->
        <div id="tab-body" class="tab-panel hidden">
          <div class="body-toolbar">
            <label class="checkbox-label">
              <input type="checkbox" id="body-enabled">
              <span>Include body (JSON)</span>
            </label>
          </div>
          <textarea id="body-editor" class="body-editor"
            placeholder='{\n  "key": "value"\n}'></textarea>
          <div id="body-error" class="body-error hidden"></div>
        </div>

        <!-- Response Area -->
        <div class="response-wrapper">
          <div class="response-header">
            <span class="response-title">Response</span>
            <span id="response-meta" class="response-meta hidden"></span>
          </div>
          <div class="response-tabs">
            <button class="resp-tab active" data-resp-tab="pretty">Pretty</button>
            <button class="resp-tab" data-resp-tab="raw">Raw</button>
            <button class="resp-tab" data-resp-tab="resp-headers">Headers</button>
          </div>
          <div id="resp-loading" class="resp-state hidden">
            <div class="spinner"></div>
            <span>Sending request&hellip;</span>
          </div>
          <div id="resp-empty" class="resp-state">
            <span class="muted">Hit Send to see the response here.</span>
          </div>
          <div id="resp-error" class="resp-state hidden">
            <span class="error-text" id="resp-error-text"></span>
          </div>
          <div id="resp-tab-pretty" class="resp-panel hidden">
            <pre id="resp-pretty" class="resp-body"></pre>
          </div>
          <div id="resp-tab-raw" class="resp-panel hidden">
            <pre id="resp-raw" class="resp-body"></pre>
          </div>
          <div id="resp-tab-resp-headers" class="resp-panel hidden">
            <div id="resp-headers-list" class="resp-headers-list"></div>
          </div>
        </div>

      </div><!-- /app-panel -->
    </div><!-- /app-body -->
  </div><!-- /app-wrapper -->

  <!-- ── Variables modal ─────────────────────────────────────────── -->
  <div id="vars-modal" class="vars-modal hidden" role="dialog" aria-modal="true">
    <div class="vars-modal-backdrop" id="vars-modal-backdrop"></div>
    <div class="vars-modal-panel">
      <div class="vars-modal-header">
        <span class="vars-title-icon">&#9674;</span>
        <span class="vars-title-text">Environment Variables</span>
        <button id="close-vars-btn" class="icon-btn" title="Close">&#10005;</button>
      </div>
      <div class="vars-subtitle">
        Use <code class="var-chip">{{VARIABLE_NAME}}</code> anywhere in the URL,
        headers, body, or query params.
      </div>
      <div class="vars-toolbar">
        <button id="add-var-btn" class="btn-primary">+ Add Variable</button>
      </div>
      <div id="vars-empty" class="vars-empty">
        <div>No variables yet.</div>
        <div class="vars-empty-hint">
          Click <strong>+ Add Variable</strong> to create one.
        </div>
      </div>
      <table id="vars-table" class="vars-table hidden">
        <thead>
          <tr>
            <th class="col-enabled"></th>
            <th class="col-name">Variable</th>
            <th class="col-value">Value</th>
            <th class="col-actions"></th>
          </tr>
        </thead>
        <tbody id="vars-tbody"></tbody>
      </table>
      <div class="vars-hint">
        <strong>Examples:</strong>
        <span class="var-chip">{{BASE_URL}}</span>
        <span class="var-chip">{{AUTH_TOKEN}}</span>
        <span class="var-chip">{{API_KEY}}</span>
        &mdash; uncheck a variable to temporarily disable it.
      </div>
    </div>
  </div>

  <script src="${mountPath}/app.js"></script>
</body>
</html>`;
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escAttr(str: string): string {
  return escHtml(str).replace(/"/g, '&quot;');
}

/**
 * Creates an Express middleware that serves the Auto Detect Route UI.
 *
 * Usage:
 * ```js
 * const { autoDetectRoute } = require('auto-detect-route');
 * app.use('/api-explorer', autoDetectRoute());
 * // Now visit http://localhost:3000/api-explorer in your browser
 * ```
 */
export function autoDetectRoute(options: AutoDetectRouteOptions = {}): Router {
  const rootDir = options.rootDir ?? process.cwd();
  const defaultBaseUrl = options.baseUrl ?? 'http://localhost:3000';
  const title = options.title ?? 'Auto Detect Route';

  const scanner = new RouteScanner(rootDir, { exclude: options.exclude });
  let routes: DetectedRoute[] = [];
  let scanning = false;
  let lastScanError: string | null = null;

  // Kick off initial scan immediately (non-blocking)
  scanning = true;
  scanner.scanWorkspace()
    .then((detected) => {
      routes = detected;
      scanning = false;
      lastScanError = null;
    })
    .catch((err: Error) => {
      console.error('[auto-detect-route] Initial scan failed:', err.message);
      lastScanError = err.message;
      scanning = false;
    });

  const router = Router();

  // ── Static assets ──────────────────────────────────────────────────────────

  router.get('/app.js', (_req: Request, res: Response) => {
    const filePath = path.join(WEBVIEW_DIR, 'app.js');
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('app.js not found — did you run npm run build?');
    }
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(filePath);
  });

  router.get('/app.css', (_req: Request, res: Response) => {
    const filePath = path.join(WEBVIEW_DIR, 'app.css');
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('app.css not found — did you run npm run build?');
    }
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(filePath);
  });

  // ── Main UI ────────────────────────────────────────────────────────────────

  router.get('/', (req: Request, res: Response) => {
    // req.baseUrl is the mount path (e.g. '/api-explorer')
    const mountPath = req.baseUrl.replace(/\/$/, '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(generateHtml(mountPath, title));
  });

  // ── API: get routes ────────────────────────────────────────────────────────

  router.get('/api/routes', (_req: Request, res: Response) => {
    res.json({
      routes,
      scanning,
      baseUrl: defaultBaseUrl,
      error: lastScanError,
    });
  });

  // ── API: rescan ────────────────────────────────────────────────────────────

  router.get('/api/rescan', async (_req: Request, res: Response) => {
    if (scanning) {
      return res.json({ routes, scanning: true, baseUrl: defaultBaseUrl });
    }
    scanning = true;
    lastScanError = null;
    try {
      routes = await scanner.scanWorkspace();
      res.json({ routes, scanning: false, baseUrl: defaultBaseUrl });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      lastScanError = message;
      res.status(500).json({ error: message, routes, scanning: false });
    } finally {
      scanning = false;
    }
  });

  // ── API: proxy HTTP requests ───────────────────────────────────────────────

  router.post('/api/proxy', expressJson({ limit: '5mb' }), async (req: Request, res: Response) => {
    const body = req.body as RequestState & { _variables?: Record<string, string> };

    if (!body || !body.route) {
      return res.status(400).json({ error: 'Missing route in request body' });
    }

    // Extract variables (sent by browser for server-side substitution)
    const variables: Record<string, string> = body._variables ?? {};

    // Remove the _variables key before passing to httpProxy
    const state: RequestState = { ...body };
    delete state._variables;

    try {
      const response = await sendHttpRequest(state, variables);
      res.json(response);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  return router;
}
