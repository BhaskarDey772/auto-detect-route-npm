# auto-detect-route — Technical Deep Dive

This document explains how the package is built internally, from file discovery to the browser UI. Read this if you want to understand the architecture, extend it, or just satisfy curiosity.

---

## Table of Contents

1. [Overview](#overview)
2. [Package Structure](#package-structure)
3. [How It Works — End-to-End Flow](#how-it-works--end-to-end-flow)
4. [The Route Scanner](#the-route-scanner)
   - [File Discovery](#file-discovery)
   - [AST Parsing](#ast-parsing)
   - [What the Visitor Detects](#what-the-visitor-detects)
   - [Route Resolution (3-Pass Algorithm)](#route-resolution-3-pass-algorithm)
   - [Body Field Extraction](#body-field-extraction)
   - [Chained Routes](#chained-routes)
   - [Entry Point Detection](#entry-point-detection)
   - [Security & Safety Limits](#security--safety-limits)
5. [The HTTP Proxy](#the-http-proxy)
   - [Variable Substitution](#variable-substitution)
   - [Safety Limits](#safety-limits)
6. [The Express Middleware](#the-express-middleware)
   - [API Endpoints](#api-endpoints)
   - [Scan Lifecycle](#scan-lifecycle)
7. [The Browser UI (SPA)](#the-browser-ui-spa)
   - [State Model](#state-model)
   - [Sidebar & Route Groups](#sidebar--route-groups)
   - [Request Panel](#request-panel)
   - [Variables System](#variables-system)
   - [State Persistence](#state-persistence)
8. [Type System](#type-system)
9. [Data Flow Diagram](#data-flow-diagram)

---

## Overview

`auto-detect-route` is an Express middleware that:

1. **Scans** your project's JS/TS source files for Express route definitions using a real AST parser.
2. **Serves** a single-page browser UI at a mount path you choose (e.g. `/api-explorer`).
3. **Proxies** HTTP requests from the browser to your API, avoiding CORS entirely.

No configuration file is needed. Drop it into any Express app and it works.

```js
const { autoDetectRoute } = require('auto-detect-route');
app.use('/api-explorer', autoDetectRoute());
```

---

## Package Structure

```
src/
  index.ts        — Public exports
  middleware.ts   — Express Router factory + HTML generator
  routeScanner.ts — AST-based route discovery engine
  httpProxy.ts    — Server-side HTTP proxy
  types.ts        — All shared TypeScript interfaces

webview/
  app.js          — Browser SPA (vanilla JS, no framework)
  app.css         — Styles
```

There is no frontend build step for the browser UI. `app.js` is written in plain vanilla JavaScript and shipped as-is. The TypeScript compilation (`tsc`) only covers the `src/` directory.

---

## How It Works — End-to-End Flow

```
User visits /api-explorer
        │
        ▼
middleware.ts: GET /
  └── generateHtml() injects window.__ADR_BASE__ = '/api-explorer'
  └── serves the SPA shell

Browser loads app.js, app.css
        │
        ▼
app.js: fetch /api-explorer/api/routes
        │
        ▼
middleware.ts: GET /api/routes
  └── returns { routes, scanning, baseUrl }
  └── scanning=true if initial scan is still in progress
        │
        ▼
app.js: renders sidebar with detected routes

User picks a route → fills in params → clicks Send
        │
        ▼
app.js: POST /api-explorer/api/proxy  { route, baseUrl, params, headers, body, _variables }
        │
        ▼
middleware.ts → httpProxy.ts: builds real HTTP request
  └── substitutes {{VAR}} on the server side
  └── sends request using Node's http/https module
  └── buffers response (max 10 MB)
        │
        ▼
app.js: displays response (Pretty / Raw / Headers tabs)
```

---

## The Route Scanner

**File:** [src/routeScanner.ts](src/routeScanner.ts)

This is the most complex part of the package. It reads source files, builds an AST for each one, then resolves fully-qualified route paths across the file graph.

### File Discovery

```ts
const filePaths = await fg('**/*.{js,ts,mjs,cjs}', {
  cwd: this.rootDir,
  absolute: true,
  ignore: this.excludePatterns,
  followSymbolicLinks: false,
  onlyFiles: true,
});
const cappedPaths = filePaths.slice(0, MAX_FILES_TO_SCAN); // hard cap: 500
```

`fast-glob` is used for file discovery. It respects a built-in exclude list (`node_modules`, `dist`, `build`, `.git`, credential files) plus any user-supplied patterns.

### AST Parsing

Each file is parsed with `@typescript-eslint/typescript-estree`:

```ts
ast = parse(source, {
  jsx: false,
  tolerant: true,   // don't throw on syntax errors
  loc: true,        // needed for line numbers
});
```

`tolerant: true` means a single malformed file doesn't abort the whole scan. The parser handles both JavaScript and TypeScript syntax.

### What the Visitor Detects

The AST visitor (`analyzeFile`) makes a single pass over each file and collects:

| What | How | Stored in |
|---|---|---|
| `require('./routes')` calls | `VariableDeclaration` → `CallExpression` where callee is `require` | `localVarToRequirePath` |
| `import router from './routes'` | `ImportDeclaration` | `localVarToRequirePath` |
| `express.Router()` / `Router()` calls | `VariableDeclaration` → checks callee name | `routerVars` |
| Route registrations (`router.get(...)`) | `ExpressionStatement` → `CallExpression` → method is in `{get,post,put,patch,delete}` | `rawRoutes` |
| Mount points (`app.use('/api', router)`) | `ExpressionStatement` → method is `use` | `mountPoints` |
| `module.exports = router` | `AssignmentExpression` on `module.exports` | `exportedVar` |
| Named handler functions | `FunctionDeclaration`, `ExportNamedDeclaration`, `exports.X = fn` | `localFunctions`, `exportedFunctions` |

### Route Resolution (3-Pass Algorithm)

Raw routes collected per-file have relative paths (e.g. `'/users/:id'`). To get fully-qualified paths (e.g. `'/api/v1/users/:id'`), the scanner needs to walk the `app.use()` tree.

**Pass 1 — Parse all files**

Every file in the discovered set is parsed with `analyzeFile`. Results are cached by file path + mtime, so rescans only re-parse changed files.

**Pass 2 — Find root files**

A "root file" is one that is not mounted by any other file. The scanner:
1. Collects all files that appear as mount targets.
2. Tries to detect entry points from `package.json` (`main`, `scripts.start`, `scripts.dev`).
3. Falls back to looking for `app.js`, `server.js`, `index.js`, `main.js` in the root and `src/` directory.

**Pass 3 — DFS with prefix stack**

Starting from each root file, the scanner does a depth-first traversal of the file graph, carrying a `prefixStack` of accumulated path segments:

```
app.js:  app.use('/api', require('./routes/users'))
                                │
                                ▼
           users.js:  router.get('/users/:id', handler)
                                │
                                ▼
           Resolved path: /api/users/:id
```

Cycle detection is done with a `visited` set that is cleared after each root's DFS completes, allowing shared router files to be visited from multiple mount points.

### Body Field Extraction

For `POST`/`PUT`/`PATCH` routes, the scanner tries to detect what fields the handler reads from `req.body`. This is used to pre-populate the request body editor in the UI.

It looks for these patterns in the handler function body:

```js
// Destructuring assignment
const { email, password } = req.body;        // → ["email", "password"]

// Direct property access
const name = req.body.name;                  // → ["name"]

// Member expression usage
if (req.body.active) { ... }                 // → ["active"]
```

The implementation (`extractBodyFields`) walks the function body AST, skipping nested function definitions to avoid cross-scope pollution. It identifies `req` by looking at the first parameter name of the handler function (`getReqParamName`).

For **named handlers** (e.g. `router.post('/users', authController.signup)`), the scanner:
1. Notes the reference as a `handlerRef`.
2. After all files are parsed, resolves the reference by following the `require()` path to the controller file.
3. Looks up the exported function name in that file's `exportedFunctions` map.

### Chained Routes

Express supports `router.route('/path').get(handler).post(handler)`. The scanner handles this with `extractChainedRoutes`, which walks the method chain backwards to find the `.route('/path')` call, then registers one `RawRoute` per HTTP method found in the chain.

### Entry Point Detection

`findEntryPoints` reads `package.json` and tries, in order:

1. `pkg.main` field
2. `scripts.start`, `scripts.dev`, `scripts.serve`, `scripts.develop` — parsed to extract a `.js`/`.ts` filename
3. Conventional names: `app.js`, `server.js`, `index.js`, `main.js` in root and `src/`

### Security & Safety Limits

| Limit | Value | Reason |
|---|---|---|
| Max file size | 512 KB | Skip minified bundles |
| Max files scanned | 500 | Prevent runaway scans on large repos |
| Skip patterns | `.min.js`, `.bundle.js`, `.chunk.js` | Minified code slows parsing with no benefit |
| Sensitive files | `.env`, `.pem`, `.key`, `id_rsa`, `credentials.json`, etc. | Never read secrets |
| Sensitive directories | `.ssh`, `.aws`, `secrets/`, `.gnupg` | Defense in depth |

---

## The HTTP Proxy

**File:** [src/httpProxy.ts](src/httpProxy.ts)

The browser UI cannot call your API directly because of CORS. Instead, it sends the request details to `POST /api/proxy`, and the server makes the real HTTP call using Node's built-in `http`/`https` modules.

```
Browser → POST /api/proxy { route, baseUrl, params, headers, body, _variables }
                │
                ▼
         httpProxy.ts builds the real request
                │
                ▼
         Your Express API (same machine, no CORS)
                │
                ▼
         Response buffered, returned as JSON to browser
```

**Why not `fetch` or `axios`?** Using Node's built-in modules keeps the proxy dependency-free and gives direct control over streaming and timeouts.

### Variable Substitution

The proxy performs `{{VAR}}` substitution on the server side. The browser sends the enabled variables as `_variables: { BASE_URL: 'http://...', AUTH_TOKEN: '...' }`. The proxy substitutes them in:

- The full URL (base + path)
- Path parameter values (`:id`, `${expr}`)
- Query parameter keys and values
- Header values
- Request body

```ts
const sub = (text: string): string =>
  text.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_m, name) =>
    name in variables ? variables[name] : _m
  );
```

Unresolved variables (no matching entry in the map) are left as-is (`{{UNKNOWN}}`), so the request still goes through.

### Safety Limits

| Limit | Value |
|---|---|
| Allowed protocols | `http:`, `https:` only |
| Max query params / headers | 50 each |
| Max response size | 10 MB (response is truncated, not rejected) |
| Request timeout | 30 seconds |

---

## The Express Middleware

**File:** [src/middleware.ts](src/middleware.ts)

`autoDetectRoute(options)` returns an Express `Router`. Mount it anywhere:

```js
app.use('/api-explorer', autoDetectRoute({
  rootDir: __dirname,
  baseUrl: 'http://localhost:3000',
  exclude: ['tests/**', 'mocks/**'],
  title: 'My API Explorer',
}));
```

Internally it creates a `RouteScanner` and kicks off an async scan immediately (non-blocking). While the scan runs, the API returns `{ scanning: true, routes: [] }` and the browser polls once after 2 seconds.

### API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Serves the SPA HTML shell |
| `GET` | `/app.js` | Serves the browser JavaScript |
| `GET` | `/app.css` | Serves the stylesheet |
| `GET` | `/api/routes` | Returns `{ routes, scanning, baseUrl, error }` |
| `GET` | `/api/rescan` | Triggers a fresh scan, returns updated routes |
| `POST` | `/api/proxy` | Proxies an HTTP request, returns `HttpResponse` |

The mount path is detected at runtime from `req.baseUrl` (Express sets this automatically when a Router is mounted), so the HTML and JavaScript work correctly regardless of which path you mount the middleware at.

### Scan Lifecycle

```
autoDetectRoute() called
  └── scanner.scanWorkspace() starts in background (Promise)
  └── scanning = true

GET /api/routes (during scan)
  └── returns { routes: [], scanning: true }

Browser polls again after 2s → scan may now be done
  └── returns { routes: [...], scanning: false }

GET /api/rescan (manual trigger)
  └── if already scanning: return current state immediately
  └── else: await scanner.scanWorkspace(), return new routes
```

The `RouteScanner` caches file analyses by mtime, so rescans are fast — only changed files are re-parsed.

---

## The Browser UI (SPA)

**File:** [webview/app.js](webview/app.js)

The UI is a single-file vanilla JavaScript SPA. No framework, no bundler, no `node_modules`. It runs entirely in the browser.

The server injects one global variable into the HTML:

```html
<script>window.__ADR_BASE__ = '/api-explorer';</script>
```

All fetch calls use `BASE + '/api/...'` so the UI works at any mount path.

### State Model

All mutable state lives in module-scoped variables:

```js
let allRoutes     = [];       // full list from server
let currentRoute  = null;     // selected route
let currentBaseUrl = '{{BASE_URL}}';  // resolved via variable system
let groupBy       = 'file';   // 'file' | 'method', persisted in localStorage
let filterText    = '';       // sidebar search string
let queryParams   = [];       // [{key, value, enabled}]
let customHeaders = [];       // [{key, value, enabled}]
let variables     = [];       // [{name, value, enabled}] from localStorage
let manualUrl     = null;     // set when user edits the URL bar directly
```

### Sidebar & Route Groups

`renderSidebar()` filters `allRoutes` by `filterText`, then groups them by file name or HTTP method depending on `groupBy`. Each group renders as a collapsible `<div class="route-group">` with a header and a list of route items.

Routes are colored by method via CSS classes (`method-GET`, `method-POST`, etc.).

The sidebar width is user-resizable via a drag handle (`initResizeHandle`), using `mousedown`/`mousemove`/`mouseup` events clamped between 160 px and 480 px.

### Request Panel

When a route is selected, `selectRoute(route)`:

1. Saves the current route's state to `localStorage`.
2. Loads the new route's saved state (or defaults).
3. If the route is `POST`/`PUT`/`PATCH` and has no saved body content, generates a JSON skeleton from `route.bodyFields`:
   ```js
   { email: '', password: '' }   // from const { email, password } = req.body
   ```
4. Calls `loadRoutePanel()` which populates all form fields and re-renders the UI sections.

`buildUrl(resolve)` constructs the URL shown in the URL bar:
- `resolve=false` → shows raw template e.g. `{{BASE_URL}}/users/:id`
- `resolve=true` → substitutes variables e.g. `http://localhost:3000/users/123`

The URL bar shows the raw form, with the resolved form as a tooltip. This lets you see exactly what `{{VAR}}` will expand to without losing the template.

### Variables System

Variables are `{ name, value, enabled }` objects stored in `localStorage` under `adr_variables`. They use the `{{VARIABLE_NAME}}` syntax.

`BASE_URL` is automatically seeded from the server's `baseUrl` config on first load (only if not already set by the user).

The variables modal renders a table where each row can be enabled/disabled, edited, or deleted. Changes are persisted immediately on each keystroke.

`unresolvedVars(text)` scans the URL bar, query params, header values, and body for `{{VAR}}` references that have no matching enabled variable, and displays a warning banner.

### State Persistence

Each route's form state is saved to `localStorage` under the key `adr_rs_<routeId>`:

```js
{
  queryParams: [{key, value, enabled}],
  headers: [{key, value, enabled}],
  body: '{"email":""}',
  bodyEnabled: true,
  pathParamValues: { id: '42' },
  manualUrl: undefined,
  bearerToken: 'mytoken',
}
```

A rolling cap keeps at most 200 route state entries to prevent unbounded storage growth.

`Ctrl+S` / `Cmd+S` triggers an immediate save and shows a "✓ Saved" flash.

---

## Type System

**File:** [src/types.ts](src/types.ts)

All interfaces are defined once here and imported everywhere.

| Interface | Purpose |
|---|---|
| `DetectedRoute` | One discovered route with full metadata |
| `RouteParam` | A path parameter (`:id`, `${expr}`, or query) |
| `HttpMethod` | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE'` |
| `RequestState` | Everything the UI sends to `/api/proxy` |
| `HttpResponse` | What the proxy returns after a successful request |
| `RawRoute` | Internal: a route found in a single file before prefix resolution |
| `MountPoint` | Internal: a `router.use()` mount point found in a file |
| `FileAnalysis` | Internal: per-file AST analysis result |

`DetectedRoute.id` is a 12-character SHA-1 hex prefix of `method:fullPath:sourceFile`. It is stable across rescans as long as the route's path and source file don't change, which is what allows localStorage state to survive a rescan.

---

## Data Flow Diagram

```
                         ┌─────────────────────────────────────────┐
                         │           routeScanner.ts               │
                         │                                         │
  JS/TS files ──fast-glob──► scanWorkspace()                       │
                         │      │                                  │
                         │      ├─ Pass 1: analyzeFile() per file  │
                         │      │    └─ AST parse (ts-estree)      │
                         │      │    └─ collect rawRoutes          │
                         │      │    └─ collect mountPoints        │
                         │      │    └─ cache by mtime             │
                         │      │                                  │
                         │      ├─ Pass 2: find root files         │
                         │      │    └─ package.json entry points  │
                         │      │    └─ conventional names         │
                         │      │                                  │
                         │      └─ Pass 3: DFS with prefix stack   │
                         │           └─ resolveFromFile()          │
                         │           └─ emit DetectedRoute[]       │
                         └───────────────────┬─────────────────────┘
                                             │ DetectedRoute[]
                                             ▼
                         ┌─────────────────────────────────────────┐
                         │           middleware.ts                 │
                         │                                         │
                         │  GET /              → HTML shell        │
                         │  GET /api/routes    → routes JSON       │
                         │  GET /api/rescan    → re-scan + routes  │
                         │  POST /api/proxy    → httpProxy.ts      │
                         └───────────────────┬─────────────────────┘
                                             │ HTTP
                                             ▼
                         ┌─────────────────────────────────────────┐
                         │           Browser (app.js)              │
                         │                                         │
                         │  Sidebar: route list + filter + groups  │
                         │  Panel: URL bar, Params, Headers, Body  │
                         │  Response: Pretty / Raw / Headers tabs  │
                         │  Variables modal: {{VAR}} substitution  │
                         │  State: localStorage per route          │
                         └─────────────────────────────────────────┘
```
