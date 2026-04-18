# auto-detect-route

Auto-discover your Express.js routes and test them in the browser — zero config, no Postman needed.

Mount one route, visit it in any browser, and get a full API explorer UI with a sidebar, request builder, and response viewer.

> **Current support:** Node.js + Express.js  
> Support for Fastify, Koa, Hapi, NestJS, and other frameworks is coming soon.

---

## Requirements

- **Runtime:** Node.js `>= 16.0.0`
- **Framework:** Express.js `v4` or `v5`

---

## Install

Install as a **dev dependency** — this is a development tool and should never run in production.

```bash
npm install --save-dev auto-detect-route
```

---

## Usage

### JavaScript

```js
const express = require('express');

const app = express();

// Mount only in development
if (process.env.NODE_ENV !== 'production') {
  const { autoDetectRoute } = require('auto-detect-route');
  app.use('/api-explorer', autoDetectRoute());
}

app.listen(3000, () => {
  console.log('Open http://localhost:3000/api-explorer');
});
```

### TypeScript

```ts
import express from 'express';

const app = express();

if (process.env.NODE_ENV !== 'production') {
  const { autoDetectRoute } = require('auto-detect-route') as typeof import('auto-detect-route');
  app.use('/api-explorer', autoDetectRoute({
    rootDir: __dirname,
    baseUrl: 'http://localhost:3000',
    title: 'My API Explorer',
  }) as any);
}

app.listen(3000);
```

> Using `require()` inside the `if` block ensures the package is **never loaded in production**, even if it is accidentally present in `node_modules`.

Visit `http://localhost:3000/api-explorer` in your browser — that's it.

---

## What you get

- **Sidebar** — all your Express routes auto-detected, grouped by file or HTTP method
- **Filter & group** — live-filter routes by path or method, toggle grouping with one click
- **Request builder** — path params, query params, custom headers, bearer token shortcut, JSON body editor
- **Body pre-fill** — `req.body` fields are detected from your route handlers and pre-populated automatically
- **Response viewer** — syntax-highlighted JSON, raw text, response headers, status code, timing, and size
- **Variables** — define `{{VAR_NAME}}` placeholders for URLs, headers, tokens, and body; `BASE_URL` is seeded automatically
- **Unresolved variable warning** — amber banner if a `{{VAR}}` in any field has no matching value
- **Rescan** — re-discover routes without restarting the server
- **State persistence** — inputs saved per-route in `localStorage`, survives page refresh
- **Resizable sidebar** — drag the divider to resize the route list

---

## Options

```js
autoDetectRoute({
  rootDir: __dirname,               // Directory to scan (default: process.cwd())
  baseUrl: 'http://localhost:3000', // Default base URL shown in the UI
  exclude: ['tests', 'mocks'],      // Extra glob patterns to exclude from scanning
  title: 'My API Explorer',         // Browser tab / header title
})
```

| Option    | Type       | Default                 | Description                                      |
|-----------|------------|-------------------------|--------------------------------------------------|
| `rootDir` | `string`   | `process.cwd()`         | Root directory to scan for Express routes        |
| `baseUrl` | `string`   | `http://localhost:3000` | Default base URL (seeds the `BASE_URL` variable) |
| `exclude` | `string[]` | `[]`                    | Extra glob patterns to skip during scanning      |
| `title`   | `string`   | `Auto Detect Route`     | Page title shown in the browser tab and header   |

---

## Environment variables

Define variables with `{{VARIABLE_NAME}}` syntax anywhere in your request — URL, headers, body, or query params.

Open the variable editor with the **◇** button in the URL bar.

```
{{BASE_URL}}/api/users          ← in the URL bar
Bearer {{AUTH_TOKEN}}           ← in a header value
{ "key": "{{API_KEY}}" }        ← in the JSON body
token={{ACCESS_TOKEN}}          ← in a query param
```

- **`BASE_URL`** is automatically created from the `baseUrl` option on first load.
- Disable a variable with its checkbox to temporarily exclude it without deleting it.
- Unresolved variables show an amber ⚠ warning in the URL bar area.
- Variables are persisted in `localStorage` across page refreshes.

---

## Supported route patterns

```js
// Basic
app.get('/users', handler)
router.post('/users', handler)

// Named controller handlers (req.body fields auto-detected cross-file)
router.post('/users', userController.createUser)
router.post('/auth/signup', authController.signup)

// Nested routers with prefix mount
app.use('/api', userRoutes)
app.use('/api', require('./routes/users'))

// Chained
router.route('/users/:id').get(h).put(h).delete(h)

// ES Modules
import usersRouter from './routes/users'
app.use('/users', usersRouter)
```

---

## TypeScript support

Full type definitions are included — no `@types/` package needed.

```ts
import type { AutoDetectRouteOptions, DetectedRoute, RouteParam, HttpMethod } from 'auto-detect-route';

const options: AutoDetectRouteOptions = {
  rootDir: __dirname,
  baseUrl: 'http://localhost:3000',
  exclude: ['tests'],
  title: 'My API Explorer',
};
```

> If you're on Express 5 (`@types/express@^5`), add `as any` when mounting. This is a type-only issue and does not affect runtime behaviour.

---

## How it works

The middleware uses AST parsing (`@typescript-eslint/typescript-estree`) to scan your JS/TS files and detect Express routes across your entire project in three passes:

1. **Parse** — every JS/TS file is parsed into an AST and analyzed for route registrations (`router.get(...)`) and mount points (`app.use(...)`).
2. **Root detection** — the entry file is found via `package.json` (`main`, `scripts.start`) or by looking for `app.js`, `server.js`, `index.js`.
3. **DFS resolution** — starting from the entry file, a depth-first traversal follows `require()`/`import` chains and accumulates path prefixes so every route gets its fully-qualified path (e.g. `/api/v1/users/:id`).

`req.body` fields are extracted from handler functions — including **cross-file named handlers** — so the body editor is pre-filled automatically.

HTTP requests are **proxied through your server**, so there are no CORS issues regardless of which origin your API is on.

For a full breakdown of the internals, see [TECHNICAL.md](TECHNICAL.md).

---

## Security

This package is intended for **local development only**.

- Mount it inside a `NODE_ENV !== 'production'` guard (see Usage above)
- Sensitive files (`.env`, `.key`, `.pem`, credentials, SSH keys) are **never read** by the scanner
- Only `http:` and `https:` protocols are allowed in the proxy
- Response bodies are capped at **10 MB**
- Header values are sanitized to strip `\r\n` (header injection prevention)
- Do not expose the explorer route on a public-facing server

---

## Coming soon

Support for other Node.js frameworks will be published as separate packages:

- `auto-detect-route-fastify`
- `auto-detect-route-koa`
- `auto-detect-route-hapi`
- `auto-detect-route-nest`

---

## License

MIT
# auto-detect-route-npm
