export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteParam {
  name: string;
  /** 'path' = :param style, 'template' = ${expr} from template literal prefix, 'query' = query string */
  type: 'path' | 'template' | 'query';
}

export interface DetectedRoute {
  /** Stable key: sha-like string from method + fullPath + sourceFile */
  id: string;
  method: HttpMethod;
  /** Fully resolved path e.g. "/api/v1/users/:id" */
  path: string;
  /** Raw path segment as written in source e.g. "/:id" */
  rawPath: string;
  /** Absolute path to the source file */
  sourceFile: string;
  /** 1-based line number for "Go to Source" */
  sourceLine: number;
  /** Path params extracted from :param notation */
  params: RouteParam[];
  /**
   * Fields extracted from req.body destructuring in the route handler.
   * e.g. `const { email, password } = req.body` → ["email", "password"]
   * Used to pre-populate the request body in the panel.
   */
  bodyFields: string[];
}

export interface RequestState {
  route: DetectedRoute;
  baseUrl: string;
  pathParamValues: Record<string, string>;
  queryParams: Array<{ key: string; value: string; enabled: boolean }>;
  headers: Array<{ key: string; value: string; enabled: boolean }>;
  /** Cookies to send with the request — combined into the Cookie header by the proxy. */
  cookies: Array<{ name: string; value: string; enabled: boolean }>;
  body: string;
  bodyEnabled: boolean;
  /**
   * When the user manually edits the URL bar, this holds the full URL they typed.
   * The httpProxy uses it directly instead of constructing baseUrl + path.
   */
  overrideFullUrl?: string;
  /**
   * Variables map sent from the browser (name → value, only enabled vars).
   * Used by the server-side proxy for {{VAR}} substitution.
   */
  _variables?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Raw response body string */
  body: string;
  /** Parsed JSON if body is valid JSON, otherwise null */
  bodyParsed: unknown;
  durationMs: number;
  /** Body size in bytes */
  size: number;
  /**
   * Raw Set-Cookie header values from the response.
   * Returned to the browser so the UI can save them to its cookie jar.
   * e.g. ["token=abc123; HttpOnly; Path=/", "session=xyz; HttpOnly"]
   */
  setCookies: string[];
}

/** Internal: raw route found in a single file before prefix resolution */
export interface RawRoute {
  method: HttpMethod;
  /** Path string literal from AST */
  path: string;
  /** Variable name the route is registered on (e.g. "app", "router") */
  receiverVar: string;
  /** 1-based line in source file */
  sourceLine: number;
  /** Fields extracted from req.body in inline handler functions */
  bodyFields: string[];
  /** Reference to a named handler for cross-file body field resolution */
  handlerRef?:
    | { type: 'local'; name: string }
    | { type: 'member'; objectVar: string; method: string };
}

/** Internal: a router.use() / app.use() mount point found in a file */
export interface MountPoint {
  /** Variable that calls .use() */
  receiverVar: string;
  /** URL prefix string, e.g. "/api" */
  prefix: string;
  /** Local variable name of the mounted router (if known) */
  mountedVar?: string;
  /** Require path string for inline require() mounts */
  mountedRequirePath?: string;
}

/** Internal: per-file analysis result from AST parsing */
export interface FileAnalysis {
  filePath: string;
  /** Local vars bound to express.Router() */
  routerVars: Set<string>;
  rawRoutes: RawRoute[];
  mountPoints: MountPoint[];
  /** require('path') → local var name mappings */
  localVarToRequirePath: Map<string, string>;
  /** module.exports = varName  OR  export default varName */
  exportedVar: string | null;
  /** Exported function name → body fields (exports.X = fn, module.exports = {X: fn}) */
  exportedFunctions: Map<string, string[]>;
  /** Local named function / const variable → body fields */
  localFunctions: Map<string, string[]>;
}
