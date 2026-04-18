import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import fg from 'fast-glob';
import { parse } from '@typescript-eslint/typescript-estree';
import type { TSESTree } from '@typescript-eslint/typescript-estree';
import {
  DetectedRoute,
  FileAnalysis,
  HttpMethod,
  MountPoint,
  RawRoute,
  RouteParam,
} from './types';

// ── Safety limits ─────────────────────────────────────────────────────────────
const MAX_FILE_SIZE_BYTES = 512 * 1024;
const MAX_FILES_TO_SCAN = 500;
const SKIP_FILENAME_PATTERNS = ['.min.js', '.min.ts', '-min.js', '.bundle.js', '.chunk.js'];

const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.git/**',
  '**/.env*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.crt',
  '**/.ssh/**',
  '**/.aws/**',
  '**/secrets/**',
];

const SENSITIVE_BASENAMES: ReadonlySet<string> = new Set([
  '.env', '.env.local', '.env.development', '.env.production',
  '.env.test', '.env.staging', '.env.example', '.env.sample',
  '.pem', '.key', '.p12', '.pfx', '.crt', '.cer', '.der', '.p8',
  '.netrc', '.npmrc', '.yarnrc', '.pypirc',
  'credentials', 'credentials.json', 'serviceaccount.json',
  'google-services.json', 'GoogleService-Info.plist',
  '.vault-token', '.aws', 'secrets.json', 'secrets.yaml', 'secrets.yml',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
]);

const SENSITIVE_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  '.ssh', '.aws', '.gnupg', '.secrets', 'secrets', '.credentials',
]);

const HTTP_METHODS: ReadonlySet<string> = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'all',
]);

function makeId(method: string, fullPath: string, sourceFile: string): string {
  return crypto
    .createHash('sha1')
    .update(`${method}:${fullPath}:${sourceFile}`)
    .digest('hex')
    .slice(0, 12);
}

function normalizePath(segments: string[]): string {
  const joined = segments.join('/').replace(/\/+/g, '/');
  const withLeading = joined.startsWith('/') ? joined : '/' + joined;
  return withLeading.replace(/\/$/, '') || '/';
}

function extractPathParams(routePath: string): RouteParam[] {
  const params: RouteParam[] = [];
  let match: RegExpExecArray | null;

  const colonRe = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
  while ((match = colonRe.exec(routePath)) !== null) {
    params.push({ name: match[1], type: 'path' });
  }

  const templateRe = /\$\{([^}]+)\}/g;
  while ((match = templateRe.exec(routePath)) !== null) {
    if (!params.some((p) => p.name === match![1])) {
      params.push({ name: match[1], type: 'template' });
    }
  }

  return params;
}

function isSensitiveFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (SENSITIVE_BASENAMES.has(base)) return true;
  const ext = path.extname(filePath).toLowerCase();
  if (ext && SENSITIVE_BASENAMES.has(ext)) return true;
  const segments = filePath.split(path.sep).map((s) => s.toLowerCase());
  return segments.some((seg) => SENSITIVE_DIR_SEGMENTS.has(seg));
}

function shouldSkipFile(filePath: string, statSize: number): boolean {
  if (isSensitiveFile(filePath)) return true;
  if (statSize > MAX_FILE_SIZE_BYTES) return true;
  const base = path.basename(filePath).toLowerCase();
  return SKIP_FILENAME_PATTERNS.some((p) => base.includes(p));
}

// ── Body field extraction ─────────────────────────────────────────────────────

type FunctionLike =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionExpression
  | TSESTree.FunctionDeclaration;

function extractBodyFields(fn: FunctionLike): string[] {
  const reqParamNameOrNull = getReqParamName(fn);
  if (!reqParamNameOrNull) return [];
  const reqParamName: string = reqParamNameOrNull;

  const fields = new Set<string>();

  function walkNode(node: TSESTree.Node | null | undefined): void {
    if (!node) return;

    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        if (!decl.init) continue;

        if (
          decl.id.type === 'ObjectPattern' &&
          isReqBodyExpr(decl.init, reqParamName)
        ) {
          for (const prop of decl.id.properties) {
            if (prop.type === 'Property' && prop.key.type === 'Identifier') {
              fields.add(prop.key.name);
            }
          }
        }

        if (
          decl.id.type === 'Identifier' &&
          decl.init.type === 'MemberExpression' &&
          isReqBodyExpr(decl.init.object, reqParamName) &&
          decl.init.property.type === 'Identifier'
        ) {
          fields.add(decl.init.property.name);
        }
      }
    }

    if (
      node.type === 'MemberExpression' &&
      isReqBodyExpr(node.object, reqParamName) &&
      node.property.type === 'Identifier' &&
      !node.computed
    ) {
      fields.add(node.property.name);
    }

    if (
      node.type === 'ArrowFunctionExpression' ||
      node.type === 'FunctionExpression' ||
      node.type === 'FunctionDeclaration'
    ) {
      if (node !== fn) return;
    }

    for (const key of Object.keys(node)) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (child && typeof child === 'object') {
        if (Array.isArray(child)) {
          for (const item of child) {
            if (item && typeof item === 'object' && 'type' in item) {
              walkNode(item as TSESTree.Node);
            }
          }
        } else if ('type' in child) {
          walkNode(child as TSESTree.Node);
        }
      }
    }
  }

  walkNode(fn.body);
  return [...fields];
}

function getReqParamName(fn: FunctionLike): string | null {
  const firstParam = fn.params[0];
  if (!firstParam) return null;
  if (firstParam.type === 'Identifier') return firstParam.name;
  return null;
}

function isReqBodyExpr(node: TSESTree.Node, reqParamName: string): boolean {
  return (
    node.type === 'MemberExpression' &&
    node.object.type === 'Identifier' &&
    node.object.name === reqParamName &&
    node.property.type === 'Identifier' &&
    node.property.name === 'body' &&
    !node.computed
  );
}

function extractBodyFieldsFromArgs(
  args: TSESTree.CallExpressionArgument[],
): string[] {
  const fields: string[] = [];
  for (const arg of args) {
    if (
      arg.type === 'ArrowFunctionExpression' ||
      arg.type === 'FunctionExpression'
    ) {
      fields.push(...extractBodyFields(arg));
    }
  }
  return [...new Set(fields)];
}

/** Return a handler reference when the handler is a named function, not an inline one. */
function extractHandlerRef(
  args: TSESTree.CallExpressionArgument[],
): RawRoute['handlerRef'] {
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i];
    // authController.signup
    if (
      arg.type === 'MemberExpression' &&
      arg.object.type === 'Identifier' &&
      arg.property.type === 'Identifier' &&
      !arg.computed
    ) {
      return {
        type: 'member',
        objectVar: (arg.object as TSESTree.Identifier).name,
        method: (arg.property as TSESTree.Identifier).name,
      };
    }
    // signup (local function reference)
    if (arg.type === 'Identifier') {
      return { type: 'local', name: arg.name };
    }
  }
  return undefined;
}

function resolveRequirePath(
  requirePath: string,
  fromFile: string,
  allFiles: Set<string>
): string | null {
  if (!requirePath.startsWith('.')) return null;
  const dir = path.dirname(fromFile);
  const base = path.resolve(dir, requirePath);
  const extensions = ['.js', '.ts', '.mjs', '.cjs'];

  const candidates: string[] = [base];
  for (const ext of extensions) candidates.push(base + ext);
  for (const ext of extensions) candidates.push(path.join(base, 'index' + ext));

  for (const candidate of candidates) {
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

function getStringLiteral(node: TSESTree.Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

function exprToString(node: TSESTree.Expression): string {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal') return String(node.value);
  if (node.type === 'MemberExpression') {
    const obj = exprToString(node.object as TSESTree.Expression);
    if (node.computed) {
      return obj + '[' + exprToString(node.property as TSESTree.Expression) + ']';
    }
    return obj + '.' + (node.property as TSESTree.Identifier).name;
  }
  return '…';
}

function templateLiteralToString(node: TSESTree.TemplateLiteral): string {
  let result = '';
  for (let i = 0; i < node.quasis.length; i++) {
    result += node.quasis[i].value.cooked ?? node.quasis[i].value.raw;
    if (i < node.expressions.length) {
      result += '${' + exprToString(node.expressions[i] as TSESTree.Expression) + '}';
    }
  }
  return result;
}

function getRouteString(node: TSESTree.Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') return templateLiteralToString(node);
  return null;
}

function getIdentifierName(node: TSESTree.Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  return null;
}

// ── AST visitor ───────────────────────────────────────────────────────────────

function analyzeFile(filePath: string, source: string): FileAnalysis {
  const analysis: FileAnalysis = {
    filePath,
    routerVars: new Set(),
    rawRoutes: [],
    mountPoints: [],
    localVarToRequirePath: new Map(),
    exportedVar: null,
    exportedFunctions: new Map(),
    localFunctions: new Map(),
  };

  // Deferred: exports.X = localVar or module.exports = { X: localVar }
  const exportedFunctionRefs = new Map<string, string>();

  let ast: TSESTree.Program;
  try {
    ast = parse(source, {
      jsx: false,
      tolerant: true,
      loc: true,
      range: false,
    });
  } catch {
    return analysis;
  }

  function visit(node: TSESTree.Node | null | undefined): void {
    if (!node) return;

    if (
      node.type === 'VariableDeclaration' &&
      (node.kind === 'const' || node.kind === 'let' || node.kind === 'var')
    ) {
      for (const decl of node.declarations) {
        if (!decl.init) continue;

        if (
          decl.init.type === 'CallExpression' &&
          decl.init.callee.type === 'Identifier' &&
          decl.init.callee.name === 'require' &&
          decl.init.arguments.length === 1
        ) {
          const reqPath = getStringLiteral(decl.init.arguments[0]);
          const localName = getIdentifierName(decl.id);
          if (reqPath && localName) {
            analysis.localVarToRequirePath.set(localName, reqPath);
          }
        }

        if (decl.id.type === 'Identifier' && decl.init) {
          const varName = decl.id.name;
          const init = decl.init;
          if (init.type === 'CallExpression') {
            const callee = init.callee;
            const isRouter =
              (callee.type === 'MemberExpression' &&
                callee.object.type === 'Identifier' &&
                callee.object.name === 'express' &&
                callee.property.type === 'Identifier' &&
                callee.property.name === 'Router') ||
              (callee.type === 'Identifier' && callee.name === 'Router');
            if (isRouter) {
              analysis.routerVars.add(varName);
            }
          }
          // Collect local arrow/function expressions (e.g. const signup = (req, res) => {})
          if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
            analysis.localFunctions.set(varName, extractBodyFields(init));
          }
        }
      }
    }

    // function signup(req, res) { ... }
    if (node.type === 'FunctionDeclaration' && node.id) {
      analysis.localFunctions.set(node.id.name, extractBodyFields(node));
    }

    // export function signup(req, res) { ... }  /  export const signup = (req, res) => { ... }
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      const decl = node.declaration;
      if (decl.type === 'FunctionDeclaration' && decl.id) {
        const fields = extractBodyFields(decl);
        analysis.exportedFunctions.set(decl.id.name, fields);
        analysis.localFunctions.set(decl.id.name, fields);
      }
      if (decl.type === 'VariableDeclaration') {
        for (const d of decl.declarations) {
          if (
            d.id.type === 'Identifier' && d.init &&
            (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression')
          ) {
            const fields = extractBodyFields(d.init);
            analysis.exportedFunctions.set(d.id.name, fields);
            analysis.localFunctions.set(d.id.name, fields);
          }
        }
      }
    }

    if (node.type === 'ImportDeclaration') {
      if (typeof node.source.value === 'string') {
        const importPath = node.source.value;
        for (const spec of node.specifiers) {
          if (
            spec.type === 'ImportDefaultSpecifier' ||
            spec.type === 'ImportNamespaceSpecifier'
          ) {
            analysis.localVarToRequirePath.set(spec.local.name, importPath);
          }
        }
      }
    }

    if (
      node.type === 'ExpressionStatement' &&
      node.expression.type === 'AssignmentExpression'
    ) {
      const assign = node.expression;
      if (
        assign.left.type === 'MemberExpression' &&
        assign.left.object.type === 'Identifier' &&
        assign.left.object.name === 'module' &&
        assign.left.property.type === 'Identifier' &&
        assign.left.property.name === 'exports'
      ) {
        const name = getIdentifierName(assign.right);
        if (name) analysis.exportedVar = name;

        // module.exports = { signup: fn, login: fn }
        if (assign.right.type === 'ObjectExpression') {
          for (const prop of assign.right.properties) {
            if (
              prop.type === 'Property' &&
              prop.key.type === 'Identifier' &&
              !prop.computed
            ) {
              const exportName = (prop.key as TSESTree.Identifier).name;
              if (
                prop.value.type === 'ArrowFunctionExpression' ||
                prop.value.type === 'FunctionExpression'
              ) {
                analysis.exportedFunctions.set(exportName, extractBodyFields(prop.value));
              } else if (prop.value.type === 'Identifier') {
                exportedFunctionRefs.set(exportName, prop.value.name);
              }
            }
          }
        }
      }

      // exports.signup = (req, res) => { ... }
      if (
        assign.left.type === 'MemberExpression' &&
        !assign.left.computed &&
        assign.left.object.type === 'Identifier' &&
        assign.left.object.name === 'exports' &&
        assign.left.property.type === 'Identifier'
      ) {
        const exportName = (assign.left.property as TSESTree.Identifier).name;
        if (
          assign.right.type === 'ArrowFunctionExpression' ||
          assign.right.type === 'FunctionExpression'
        ) {
          analysis.exportedFunctions.set(exportName, extractBodyFields(assign.right));
        } else if (assign.right.type === 'Identifier') {
          exportedFunctionRefs.set(exportName, assign.right.name);
        }
      }
    }

    if (node.type === 'ExportDefaultDeclaration') {
      const name = getIdentifierName(node.declaration);
      if (name) analysis.exportedVar = name;
    }

    if (node.type === 'ExpressionStatement') {
      const expr = node.expression;

      if (
        expr.type === 'CallExpression' &&
        expr.callee.type === 'MemberExpression' &&
        expr.callee.object.type === 'Identifier' &&
        expr.callee.property.type === 'Identifier'
      ) {
        const receiverVar = expr.callee.object.name;
        const methodName = expr.callee.property.name;
        const line = node.loc?.start.line ?? 0;

        if (HTTP_METHODS.has(methodName) && methodName !== 'use') {
          const routePath = getRouteString(expr.arguments[0]);
          if (routePath !== null) {
            const upperMethod = methodName.toUpperCase();
            const method: HttpMethod =
              upperMethod === 'ALL' ? 'GET' : (upperMethod as HttpMethod);
            const handlerArgs = expr.arguments.slice(1);
            const bodyFields = extractBodyFieldsFromArgs(handlerArgs);
            const handlerRef = bodyFields.length === 0
              ? extractHandlerRef(handlerArgs)
              : undefined;
            analysis.rawRoutes.push({ method, path: routePath, receiverVar, sourceLine: line, bodyFields, handlerRef });
          }
        }

        if (methodName === 'use') {
          const firstArg = expr.arguments[0];
          const firstIsPath = firstArg && getRouteString(firstArg) !== null;
          const prefix = firstIsPath ? (getRouteString(firstArg) ?? '') : '';
          const candidateArgs = firstIsPath
            ? expr.arguments.slice(1)
            : expr.arguments.slice(0);

          let matched = false;
          for (let i = candidateArgs.length - 1; i >= 0 && !matched; i--) {
            const arg = candidateArgs[i];
            const mountedVar = getIdentifierName(arg);
            if (mountedVar && analysis.routerVars.has(mountedVar)) {
              analysis.mountPoints.push({ receiverVar, prefix, mountedVar });
              matched = true;
            }
            if (
              !matched &&
              arg.type === 'CallExpression' &&
              (arg as TSESTree.CallExpression).callee.type === 'Identifier' &&
              ((arg as TSESTree.CallExpression).callee as TSESTree.Identifier).name === 'require' &&
              (arg as TSESTree.CallExpression).arguments.length === 1
            ) {
              const reqPath = getStringLiteral((arg as TSESTree.CallExpression).arguments[0]);
              if (reqPath) {
                analysis.mountPoints.push({ receiverVar, prefix, mountedRequirePath: reqPath });
                matched = true;
              }
            }
          }

          if (!matched) {
            for (let i = candidateArgs.length - 1; i >= 0 && !matched; i--) {
              const mountedVar = getIdentifierName(candidateArgs[i]);
              if (mountedVar) {
                analysis.mountPoints.push({ receiverVar, prefix, mountedVar });
                matched = true;
              }
            }
          }
        }
      }

      if (
        expr.type === 'CallExpression' &&
        expr.callee.type === 'MemberExpression'
      ) {
        extractChainedRoutes(expr, node.loc?.start.line ?? 0, analysis);
      }
    }

    for (const key of Object.keys(node)) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (child && typeof child === 'object') {
        if (Array.isArray(child)) {
          for (const item of child) {
            if (item && typeof item === 'object' && 'type' in item) {
              visit(item as TSESTree.Node);
            }
          }
        } else if ('type' in child) {
          visit(child as TSESTree.Node);
        }
      }
    }
  }

  for (const statement of ast.body) {
    visit(statement);
  }

  // Resolve deferred exports.X = localVar references
  for (const [exportName, localName] of exportedFunctionRefs) {
    const fields = analysis.localFunctions.get(localName) ?? [];
    analysis.exportedFunctions.set(exportName, fields);
  }

  return analysis;
}

function extractChainedRoutes(
  expr: TSESTree.CallExpression,
  line: number,
  analysis: FileAnalysis
): void {
  const methods: string[] = [];
  let current: TSESTree.Expression = expr;

  while (
    current.type === 'CallExpression' &&
    current.callee.type === 'MemberExpression' &&
    current.callee.property.type === 'Identifier'
  ) {
    const methodName = current.callee.property.name;
    if (HTTP_METHODS.has(methodName) && methodName !== 'use') {
      methods.push(methodName);
    }
    current = current.callee.object;
  }

  if (
    current.type === 'CallExpression' &&
    current.callee.type === 'MemberExpression' &&
    current.callee.property.type === 'Identifier' &&
    current.callee.property.name === 'route' &&
    current.callee.object.type === 'Identifier'
  ) {
    const receiverVar = current.callee.object.name;
    const routePath = getRouteString(current.arguments[0]);
    if (routePath !== null) {
      const bodyFields = extractBodyFieldsFromChain(expr);
      for (const method of methods) {
        analysis.rawRoutes.push({
          method: method.toUpperCase() as HttpMethod,
          path: routePath,
          receiverVar,
          sourceLine: line,
          bodyFields,
        });
      }
    }
  }
}

function extractBodyFieldsFromChain(expr: TSESTree.CallExpression): string[] {
  const fields: string[] = [];
  let current: TSESTree.Expression = expr;
  while (
    current.type === 'CallExpression' &&
    current.callee.type === 'MemberExpression'
  ) {
    fields.push(...extractBodyFieldsFromArgs(current.arguments));
    current = current.callee.object;
  }
  return [...new Set(fields)];
}

// ── Entry point detection ─────────────────────────────────────────────────────

const ENTRY_POINT_NAMES = [
  'app.js', 'app.ts',
  'server.js', 'server.ts',
  'index.js', 'index.ts',
  'main.js', 'main.ts',
];

function extractFileFromScript(script: string): string | null {
  const tokens = script.replace(/&&|\|\|/g, ' ').split(/\s+/);
  for (const token of tokens) {
    if (/\.(js|ts|mjs|cjs)$/.test(token) && !token.startsWith('-')) {
      return token;
    }
  }
  return null;
}

function resolveEntryPath(
  rel: string,
  workspaceRoot: string,
  allFiles: Set<string>
): string | null {
  const abs = path.resolve(workspaceRoot, rel);
  if (allFiles.has(abs)) return abs;
  for (const ext of ['.js', '.ts', '.mjs', '.cjs']) {
    const candidate = abs.endsWith(ext) ? abs : abs + ext;
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

function findEntryPoints(
  workspaceRoot: string,
  allFiles: Set<string>
): string[] | null {
  const pkgPath = path.join(workspaceRoot, 'package.json');
  let pkg: Record<string, unknown> = {};
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // No package.json — fall back
  }

  const candidates: string[] = [];

  if (typeof pkg.main === 'string') {
    const resolved = resolveEntryPath(pkg.main, workspaceRoot, allFiles);
    if (resolved) candidates.push(resolved);
  }

  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  for (const key of ['start', 'dev', 'serve', 'develop']) {
    const script = scripts[key];
    if (typeof script === 'string') {
      const file = extractFileFromScript(script);
      if (file) {
        const resolved = resolveEntryPath(file, workspaceRoot, allFiles);
        if (resolved && !candidates.includes(resolved)) candidates.push(resolved);
      }
    }
  }

  if (candidates.length > 0) return candidates;

  const searchDirs = [workspaceRoot, path.join(workspaceRoot, 'src')];
  for (const dir of searchDirs) {
    for (const name of ENTRY_POINT_NAMES) {
      const abs = path.join(dir, name);
      if (allFiles.has(abs)) {
        candidates.push(abs);
        break;
      }
    }
    if (candidates.length > 0) break;
  }

  return candidates.length > 0 ? candidates : null;
}

// ── Main scanner ──────────────────────────────────────────────────────────────

export interface RouteScannerOptions {
  /** Additional glob patterns to exclude (merged with default excludes) */
  exclude?: string[];
  /** Root directory to scan (default: process.cwd()) */
  rootDir?: string;
}

export class RouteScanner {
  private fileAnalyses = new Map<string, FileAnalysis>();
  private fileMtimes = new Map<string, number>();
  private resolvedRoutes: DetectedRoute[] = [];
  private rootDir: string;
  private excludePatterns: string[];

  constructor(rootDir?: string, options: RouteScannerOptions = {}) {
    this.rootDir = rootDir ?? process.cwd();
    this.excludePatterns = [
      ...DEFAULT_EXCLUDE,
      ...(options.exclude ?? []),
    ];
  }

  async scanWorkspace(): Promise<DetectedRoute[]> {
    this.resolvedRoutes = [];

    // Use fast-glob to find all JS/TS files, respecting exclude patterns
    const filePaths = await fg('**/*.{js,ts,mjs,cjs}', {
      cwd: this.rootDir,
      absolute: true,
      ignore: this.excludePatterns,
      followSymbolicLinks: false,
      onlyFiles: true,
    });

    const cappedPaths = filePaths.slice(0, MAX_FILES_TO_SCAN);
    if (filePaths.length > MAX_FILES_TO_SCAN) {
      console.warn(
        `[auto-detect-route] Found ${filePaths.length} JS/TS files — only scanning the first ${MAX_FILES_TO_SCAN}. ` +
        `Add more patterns to the exclude option to narrow the scope.`
      );
    }

    const allFiles = new Set(cappedPaths);

    // Remove stale cache entries for deleted files
    for (const cached of this.fileAnalyses.keys()) {
      if (!allFiles.has(cached)) {
        this.fileAnalyses.delete(cached);
        this.fileMtimes.delete(cached);
      }
    }

    // Pass 1: Parse files (skip unchanged ones via mtime cache)
    for (const filePath of allFiles) {
      try {
        const stat = fs.statSync(filePath);
        if (shouldSkipFile(filePath, stat.size)) continue;

        const mtime = stat.mtimeMs;
        if (this.fileMtimes.get(filePath) === mtime && this.fileAnalyses.has(filePath)) {
          continue;
        }

        const source = await fs.promises.readFile(filePath, 'utf8');
        const analysis = analyzeFile(filePath, source);
        this.fileAnalyses.set(filePath, analysis);
        this.fileMtimes.set(filePath, mtime);
      } catch {
        // Skip unreadable / deleted files
      }
    }

    // Pass 2: Find root files
    const mountedFiles = new Set<string>();
    for (const [filePath, analysis] of this.fileAnalyses) {
      for (const mount of analysis.mountPoints) {
        const resolved = this.resolveMount(mount, filePath, allFiles);
        if (resolved) mountedFiles.add(resolved);
      }
    }

    const detectedEntries = findEntryPoints(this.rootDir, allFiles);
    const rootFiles: string[] = detectedEntries
      ? detectedEntries.filter((f) => this.fileAnalyses.has(f))
      : [...allFiles].filter((f) => !mountedFiles.has(f) && this.fileAnalyses.has(f));

    // Pass 3: DFS to resolve full paths
    const visited = new Set<string>();
    for (const root of rootFiles) {
      this.resolveFromFile(root, [], visited, allFiles);
      visited.clear();
    }

    return this.resolvedRoutes;
  }

  getRoutes(): DetectedRoute[] {
    return this.resolvedRoutes;
  }

  private resolveHandlerBodyFields(
    ref: NonNullable<RawRoute['handlerRef']>,
    analysis: FileAnalysis,
    filePath: string,
    allFiles: Set<string>
  ): string[] {
    if (ref.type === 'local') {
      return (
        analysis.localFunctions.get(ref.name) ??
        analysis.exportedFunctions.get(ref.name) ??
        []
      );
    }

    // member ref: e.g. authController.signup — follow require() to the controller file
    const reqPath = analysis.localVarToRequirePath.get(ref.objectVar);
    if (!reqPath) return [];
    const resolvedFile = resolveRequirePath(reqPath, filePath, allFiles);
    if (!resolvedFile) return [];
    const controllerAnalysis = this.fileAnalyses.get(resolvedFile);
    if (!controllerAnalysis) return [];
    return (
      controllerAnalysis.exportedFunctions.get(ref.method) ??
      controllerAnalysis.localFunctions.get(ref.method) ??
      []
    );
  }

  private resolveMount(
    mount: MountPoint,
    fromFile: string,
    allFiles: Set<string>
  ): string | null {
    if (mount.mountedRequirePath) {
      return resolveRequirePath(mount.mountedRequirePath, fromFile, allFiles);
    }
    if (mount.mountedVar) {
      const analysis = this.fileAnalyses.get(fromFile);
      if (!analysis) return null;
      const reqPath = analysis.localVarToRequirePath.get(mount.mountedVar);
      if (reqPath) return resolveRequirePath(reqPath, fromFile, allFiles);
    }
    return null;
  }

  private resolveFromFile(
    filePath: string,
    prefixStack: string[],
    visited: Set<string>,
    allFiles: Set<string>
  ): void {
    if (visited.has(filePath)) return;
    visited.add(filePath);

    const analysis = this.fileAnalyses.get(filePath);
    if (!analysis) {
      visited.delete(filePath);
      return;
    }

    const activeVars = new Set([
      ...analysis.routerVars,
      'app',
      'router',
      'Router',
    ]);
    if (analysis.exportedVar) activeVars.add(analysis.exportedVar);

    for (const raw of analysis.rawRoutes) {
      if (!activeVars.has(raw.receiverVar)) continue;
      const fullPath = normalizePath([...prefixStack, raw.path]);
      const bodyFields = raw.bodyFields.length > 0
        ? raw.bodyFields
        : raw.handlerRef
          ? this.resolveHandlerBodyFields(raw.handlerRef, analysis, filePath, allFiles)
          : [];
      this.resolvedRoutes.push({
        id: makeId(raw.method, fullPath, filePath),
        method: raw.method,
        path: fullPath,
        rawPath: raw.path,
        sourceFile: filePath,
        sourceLine: raw.sourceLine,
        params: extractPathParams(fullPath),
        bodyFields,
      });
    }

    for (const mount of analysis.mountPoints) {
      if (!activeVars.has(mount.receiverVar)) continue;
      const childFile = this.resolveMount(mount, filePath, allFiles);
      if (childFile) {
        this.resolveFromFile(
          childFile,
          [...prefixStack, mount.prefix],
          visited,
          allFiles
        );
      }
    }

    visited.delete(filePath);
  }
}
