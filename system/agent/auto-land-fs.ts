// The auto-land gate's filesystem-write hold (see auto-land.ts, check 5 "reach"),
// split out of auto-land.ts so the analysis and its tests stay readable.

import { createRequire } from 'node:module';
import { dirname, join, normalize } from 'node:path';

/**
 * Source with comments removed and formatting normalized (TypeScript printer),
 * so a comment can't stand in for code and a split expression can't hide.
 * Unparseable or non-script text is returned as-is.
 */
export function codeOnly(file: string, src: string): string {
  if (!src) return src;
  try {
    const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, false);
    return ts.createPrinter({ removeComments: true }).printFile(sf);
  } catch {
    return src;
  }
}

// ── Filesystem writes. A landed test runs unsandboxed the next time anyone runs
//    the suite, and landed code runs unsandboxed in the daemon, so a NEW write
//    (to ~/.zshrc, a git hook, a LaunchAgent) is code execution later. Every fs
//    use that can create or change a file must target a path provably inside a
//    fresh mkdtemp dir — a bare tmpdir() name is predictable, and the gate's own
//    sandbox may create /tmp symlinks — or the change waits for review. Whole
//    files, staged vs HEAD, keyed by call + target text like the integrity guard.
//    Fail closed throughout (security review, 2026-10-31): an allowlist of
//    read-only fs members, not a deny-list of writers; fs reached any other way
//    (require, createRequire, dynamic import, a local re-export) is unverified;
//    and a path builder counts only when bound to the real node:path/os/fs.

/** fs members that can't create or change anything: any use of them passes. */
const FS_READ = new Set([
  'access',
  'accessSync',
  'exists',
  'existsSync',
  'stat',
  'statSync',
  'lstat',
  'lstatSync',
  'fstat',
  'fstatSync',
  'statfs',
  'statfsSync',
  'readdir',
  'readdirSync',
  'opendir',
  'opendirSync',
  'readlink',
  'readlinkSync',
  'realpath',
  'realpathSync',
  'read',
  'readSync',
  'readv',
  'readvSync',
  'glob',
  'globSync',
  // Watchers only observe.
  'watch',
  'watchFile',
  'unwatchFile',
  'constants',
  'Dirent',
  'Stats',
]);
/** Reads that take open flags — `{ flag: 'w' }` truncates or creates the target —
 *  so they pass only as a direct call whose options are visibly flag-free. */
const FS_READ_OPTS = new Set(['readFile', 'readFileSync', 'createReadStream']);

/** Writes whose target arguments can be located → their positions. Any other fs
 *  member off FS_READ is a write whose target can't be located: always held. */
const FS_WRITE = new Map<string, number[]>([
  ...[
    'writeFile',
    'appendFile',
    'mkdir',
    'mkdtemp',
    'mkdtempDisposable',
    'rm',
    'rmdir',
    'unlink',
    'open',
    'createWriteStream',
    'truncate',
    'chmod',
    'lchmod',
    'chown',
    'lchown',
    'utimes',
    'lutimes',
  ].flatMap(
    (n): Array<[string, number[]]> => [
      [n, [0]],
      [`${n}Sync`, [0]],
    ],
  ),
  ...['copyFile', 'cp'].flatMap(
    (n): Array<[string, number[]]> => [
      [n, [1]],
      [`${n}Sync`, [1]],
    ],
  ),
  // A link's target counts too: a temp-dir symlink to ~ makes a later temp write a ~ write.
  ...['rename', 'symlink', 'link'].flatMap(
    (n): Array<[string, number[]]> => [
      [n, [0, 1]],
      [`${n}Sync`, [0, 1]],
    ],
  ),
]);
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
/** node:module hands out `require`, and with it fs under any name. */
const MODULE_MODULES = new Set(['module', 'node:module']);
const PATH_MODULES = new Set(['path', 'node:path']);
const OS_MODULES = new Set(['os', 'node:os']);
/** Names nothing but fs uses; the rest (open, rm, link…) are also common fields
 *  and locals, so they count only when imported from fs or called on fs. */
const FS_ONLY = (name: string) =>
  name.endsWith('Sync') ||
  ['writeFile', 'appendFile', 'createWriteStream', 'mkdtemp', 'copyFile', 'symlink'].includes(name);
const HOME_REF =
  /\bhomedir\b|\buserInfo\b|\benv\s*(?:\.\s*(?:HOME|USERPROFILE)\b|\[\s*['"`](?:HOME|USERPROFILE)['"`]\s*\])/g;
/** Contexts through which a module can hand fs to its importers. */
const FS_ROUTE = /^(?:ref:|reexport:|import[:(=]|require:)/;

/**
 * Path segments a write must never reach: shell startup files, git hooks, launchd
 * jobs, ssh, tool config and hooks, the shared toolchain. A string naming one is
 * held when new even with no fs call in sight — a helper in an UNCHANGED module
 * isn't followed, so `saveJson('githooks/pre-commit', …)` is otherwise invisible.
 */
const SENSITIVE_SEGMENT = new Set([
  'githooks',
  '.git',
  '.husky',
  'Library',
  'LaunchAgents',
  'LaunchDaemons',
  '.ssh',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zlogin',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.gitconfig',
  '.npmrc',
  '.config',
  '.claude',
  'node_modules',
]);
/** An absolute or home path (when `start`: the text begins the string), `$HOME`,
 *  or a sensitive segment anywhere. A bare `/` is a separator, not a path. */
const sensitivePath = (t: string, start: boolean) =>
  (start && (/^\/[^/\s]/.test(t) || /^~(?:[\\/]|$)/.test(t))) ||
  /\$\{?HOME\b/.test(t) ||
  t.split(/[\\/]/).some((seg) => SENSITIVE_SEGMENT.has(seg));

interface FsAnalysis {
  /** Unverified writes / fs routes, `home:` references, `lit:` sensitive paths. */
  contexts: Map<string, number>;
  /** Relative module specifiers the file loads (static, re-export, dynamic). */
  localImports: string[];
  /** The subset it re-exports from (`export … from './x'`): fs passes through these. */
  reexports: string[];
}

/** Multiset of unverified writes (`writeFileSync(<target>)`, `ref:fs`), fs routes,
 *  home references (`home:`) and sensitive path literals (`lit:`). */
export function fsWriteContexts(file: string, src: string): Map<string, number> {
  return analyzeFs(file, src).contexts;
}

function analyzeFs(file: string, src: string): FsAnalysis {
  const out = new Map<string, number>();
  const localImports: string[] = [];
  const reexports: string[] = [];
  const add = (k: string) => out.set(k, (out.get(k) ?? 0) + 1);
  const code = codeOnly(file, src);
  for (const m of code.matchAll(HOME_REF)) add(`home:${m[0].replace(/\s+/g, '')}`);
  if (!code) return { contexts: out, localImports, reexports };
  const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
  type Node = import('typescript').Node;
  type Expr = import('typescript').Expression;
  type Ident = import('typescript').Identifier;
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const text = (n: Node | undefined) => (n ? n.getText(sf).replace(/\s+/g, ' ') : '');
  const literal = (n: Node | undefined): n is import('typescript').StringLiteralLike =>
    n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));

  // Every value bound to each name (null = a binding that can't be followed:
  // parameter, destructuring, loop/catch variable, compound assignment, import).
  const binds = new Map<string, Array<Node | null>>();
  const bind = (name: string, e: Node | null) => binds.set(name, [...(binds.get(name) ?? []), e]);
  const bindAll = (n: Node) => {
    if (ts.isIdentifier(n)) bind(n.text, null);
    else n.forEachChild(bindAll);
  };
  const fsNs = new Set<string>(); // namespace/default/`promises` imports of fs
  const fsLocal = new Map<string, string>(); // local name → the fs member imported under it
  const pathNs = new Set<string>(); // namespace/default imports of node:path
  const osNs = new Set<string>(); // … of node:os
  const named = new Map<string, string>(); // local → `path:join`, `os:tmpdir`, …
  const collect = (n: Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text;
      const clause = n.importClause;
      if (clause && !clause.isTypeOnly) {
        const mod = FS_MODULES.has(spec)
          ? 'fs'
          : PATH_MODULES.has(spec)
            ? 'path'
            : OS_MODULES.has(spec)
              ? 'os'
              : '';
        const ns = mod === 'fs' ? fsNs : mod === 'path' ? pathNs : mod === 'os' ? osNs : null;
        if (clause.name) {
          bind(clause.name.text, null);
          ns?.add(clause.name.text);
        }
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) {
          bind(nb.name.text, null);
          ns?.add(nb.name.text);
        }
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (el.isTypeOnly) continue;
            const local = el.name.text;
            const member = (el.propertyName ?? el.name).text;
            bind(local, null);
            if (mod === 'fs' && (member === 'promises' || member === 'default')) fsNs.add(local);
            else if (mod === 'fs') fsLocal.set(local, member);
            else if (mod && member === 'default') ns?.add(local);
            else if (mod) named.set(local, `${mod}:${member}`);
          }
        }
      }
      return;
    }
    if (ts.isImportEqualsDeclaration(n)) {
      bind(n.name.text, null);
    } else if (ts.isVariableDeclaration(n)) {
      const loopOrCatch =
        !ts.isVariableDeclarationList(n.parent) ||
        ts.isForOfStatement(n.parent.parent) ||
        ts.isForInStatement(n.parent.parent);
      if (!ts.isIdentifier(n.name)) bindAll(n.name);
      else if (n.initializer) bind(n.name.text, n.initializer);
      else if (loopOrCatch) bind(n.name.text, null);
    } else if (ts.isParameter(n)) {
      bindAll(n.name);
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      if (n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
        bind(n.left.text, n.right);
      } else if (
        ts.isIdentifier(n.left) ||
        ts.isArrayLiteralExpression(n.left) ||
        ts.isObjectLiteralExpression(n.left)
      ) {
        bindAll(n.left);
      }
    } else if (ts.isFunctionDeclaration(n) && n.name) {
      bind(n.name.text, n);
    } else if (
      (ts.isClassDeclaration(n) || ts.isEnumDeclaration(n) || ts.isModuleDeclaration(n)) &&
      n.name &&
      ts.isIdentifier(n.name)
    ) {
      bind(n.name.text, null);
    }
    n.forEachChild(collect);
  };
  collect(sf);

  /** An imported name bound nowhere else in the file — no shadowing, no re-binding. */
  const sole = (name: string) => (binds.get(name)?.length ?? 0) === 1;
  /** `e` is the real node:path/node:os `member` (`join`, `path.join`, `os.tmpdir`). */
  const isBound = (e: Expr, mod: 'path' | 'os', member: string): boolean => {
    if (ts.isIdentifier(e)) return named.get(e.text) === `${mod}:${member}` && sole(e.text);
    return (
      ts.isPropertyAccessExpression(e) &&
      e.name.text === member &&
      ts.isIdentifier(e.expression) &&
      (mod === 'path' ? pathNs : osNs).has(e.expression.text) &&
      sole(e.expression.text)
    );
  };
  /** `fs` / `fs.promises` — the receiver of an fs member. Detection takes any
   *  such spelling (a shadowed `fs` still counts as fs: fail closed); `trusted`
   *  — proving a temp path — also needs the namespace bound nowhere else (sole),
   *  like the path builders. */
  const fsReceiver = (r: Expr, trusted = false): boolean => {
    const ns = ts.isIdentifier(r)
      ? r
      : ts.isPropertyAccessExpression(r) &&
          r.name.text === 'promises' &&
          ts.isIdentifier(r.expression)
        ? r.expression
        : null;
    return ns !== null && fsNs.has(ns.text) && (!trusted || sole(ns.text));
  };
  /** The real fs member `e` names (`mkdtempSync`, `fs.mkdtempSync`), or null. */
  const realFsMember = (e: Expr): string | null => {
    if (ts.isIdentifier(e)) return sole(e.text) ? (fsLocal.get(e.text) ?? null) : null;
    return ts.isPropertyAccessExpression(e) && fsReceiver(e.expression, true) ? e.name.text : null;
  };

  const unwrap = (e: Expr): Expr => {
    while (
      ts.isParenthesizedExpression(e) ||
      ts.isAwaitExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isTypeAssertionExpression(e)
    ) {
      e = e.expression;
    }
    return e;
  };
  /** A literal path segment that stays below its base. */
  const safeSegment = (e: Expr) =>
    literal(e) && !/^[\\/]/.test(e.text) && !e.text.split(/[\\/]/).includes('..');
  /** `${base}` alone or `${base}/sub/path` — never `${base}x`, a sibling. */
  const safeTail = (t: string) => t === '' || (t.startsWith('/') && !t.split('/').includes('..'));
  const isTmpdir = (e: Expr) =>
    ts.isCallExpression(e) && e.arguments.length === 0 && isBound(e.expression, 'os', 'tmpdir');
  const isJoin = (e: import('typescript').CallExpression) =>
    isBound(e.expression, 'path', 'join') || isBound(e.expression, 'path', 'resolve');
  /** An mkdtemp prefix in the OS temp dir. */
  const tmpPrefix = (raw: Expr): boolean => {
    const e = unwrap(raw);
    if (isTmpdir(e)) return true;
    if (ts.isCallExpression(e) && isJoin(e) && e.arguments.length > 0) {
      const [first, ...rest] = e.arguments;
      return first !== undefined && isTmpdir(unwrap(first)) && rest.every(safeSegment);
    }
    if (ts.isTemplateExpression(e) && e.head.text === '' && e.templateSpans.length === 1) {
      const span = e.templateSpans[0];
      return span !== undefined && isTmpdir(unwrap(span.expression)) && safeTail(span.literal.text);
    }
    return false;
  };
  const temps = new Set<string>();
  const factories = new Set<string>(); // functions whose every return is a temp path
  /** Whether `raw` is a path inside a fresh mkdtemp dir. */
  const rooted = (raw: Expr): boolean => {
    const e = unwrap(raw);
    if (ts.isIdentifier(e)) return temps.has(e.text);
    if (ts.isCallExpression(e)) {
      if (ts.isIdentifier(e.expression) && factories.has(e.expression.text)) return true;
      const [first, ...rest] = e.arguments;
      const member = realFsMember(e.expression);
      if (member === 'mkdtemp' || member === 'mkdtempSync') {
        return first !== undefined && tmpPrefix(first);
      }
      if (isJoin(e)) return first !== undefined && rooted(first) && rest.every(safeSegment);
      return false;
    }
    if (ts.isTemplateExpression(e) && e.head.text === '' && e.templateSpans.length === 1) {
      const span = e.templateSpans[0];
      return span !== undefined && rooted(span.expression) && safeTail(span.literal.text);
    }
    return false;
  };
  const isFn = (v: Node) =>
    ts.isArrowFunction(v) || ts.isFunctionExpression(v) || ts.isFunctionDeclaration(v);
  /** A function's returned expressions, or null if one returns nothing / it has none. */
  const returnsOf = (fn: Node): Expr[] | null => {
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return [fn.body];
    const found: Expr[] = [];
    let bare = false;
    const walk = (n: Node): void => {
      if (n !== fn && isFn(n)) return; // a nested function's returns aren't ours
      if (ts.isReturnStatement(n)) {
        if (n.expression) found.push(n.expression);
        else bare = true;
      }
      n.forEachChild(walk);
    };
    walk(fn);
    return bare || found.length === 0 ? null : found;
  };
  // Least fixed point: a name is temp once every value bound to it is a temp
  // path, and a factory once every value is a function returning only temp paths.
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, values] of binds) {
      if (temps.has(name) || factories.has(name)) continue;
      if (values.some((v) => v === null)) continue;
      const vs = values as Node[];
      if (vs.every((v) => !isFn(v) && rooted(v as Expr))) {
        temps.add(name);
        grew = true;
      } else if (vs.every((v) => isFn(v) && (returnsOf(v)?.every(rooted) ?? false))) {
        factories.add(name);
        grew = true;
      }
    }
  }

  const DEFINES = (p: Node, n: Node) =>
    (ts.isPropertyAssignment(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p)) &&
    p.name === n;
  /** Erased at runtime: inside a type (`fs.Stats`, `typeof fs.rm`). A class's
   *  `extends fs.WriteStream` is a value, so heritage clauses never count. */
  const inType = (n: Node): boolean => {
    for (let a = n.parent; a; a = a.parent) {
      if (ts.isExpressionWithTypeArguments(a)) return false;
      if (ts.isTypeNode(a)) return true;
    }
    return false;
  };
  /** Options (and callbacks) a flag-taking read may get: an encoding, or a plain
   *  object literal with no `flag`/`flags`/`fs` key. */
  const flagFree = (a: Expr) =>
    literal(a) ||
    a.kind === ts.SyntaxKind.NullKeyword ||
    ts.isArrowFunction(a) ||
    ts.isFunctionExpression(a) ||
    (ts.isObjectLiteralExpression(a) &&
      a.properties.every(
        (pr) =>
          (ts.isPropertyAssignment(pr) || ts.isShorthandPropertyAssignment(pr)) &&
          (ts.isIdentifier(pr.name) || ts.isStringLiteral(pr.name)) &&
          !['flag', 'flags', 'fs'].includes(pr.name.text),
      ));
  /** The call `n` is the callee of — `n(…)` or `recv.n(…)` — or null. */
  const callOf = (n: Ident) => {
    const p = n.parent;
    if (ts.isCallExpression(p) && p.expression === n) return p;
    if (
      ts.isPropertyAccessExpression(p) &&
      p.name === n &&
      ts.isCallExpression(p.parent) &&
      p.parent.expression === p
    ) {
      return p.parent;
    }
    return null;
  };
  /** A use of fs member `member` at identifier `n`. */
  const fsUse = (member: string, n: Ident) => {
    if (FS_READ.has(member)) return;
    const call = callOf(n);
    const args = call?.arguments;
    if (FS_READ_OPTS.has(member)) {
      if (!args) add(`ref:${member}`);
      else if (!args.slice(1).every(flagFree)) add(`${member}(${text(args[1])})`);
      return;
    }
    const positions = FS_WRITE.get(member);
    if (!args || !positions) {
      // Referenced, constructed, or a member whose target can't be located.
      add(args ? `fs:${member}(${args.map((a) => text(a)).join(', ')})` : `ref:${member}`);
      return;
    }
    const ok = member.startsWith('mkdtemp')
      ? args[0] !== undefined && tmpPrefix(args[0])
      : positions.every((i) => {
          const a = args[i];
          return a !== undefined && rooted(a);
        });
    if (!ok) add(`${member}(${positions.map((i) => text(args[i])).join(', ')})`);
  };
  const visit = (n: Node): void => {
    if (ts.isImportDeclaration(n)) {
      const spec = ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : '';
      if (n.importClause?.isTypeOnly) return;
      if (MODULE_MODULES.has(spec)) add(`import:${spec}`);
      else if (spec.startsWith('.')) localImports.push(spec);
      return;
    }
    if (ts.isImportEqualsDeclaration(n)) {
      if (!n.isTypeOnly) add(`import=${text(n.moduleReference)}`);
      return;
    }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
      const spec = literal(n.moduleSpecifier) ? n.moduleSpecifier.text : '';
      if (n.isTypeOnly) return;
      if (FS_MODULES.has(spec) || MODULE_MODULES.has(spec)) add(`reexport:${spec}`);
      else if (spec.startsWith('.')) {
        localImports.push(spec);
        reexports.push(spec);
      }
      return; // its specifiers name the other module's bindings, not ours
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      if (!literal(arg)) add(`import(${text(arg)})`);
      else if (FS_MODULES.has(arg.text) || MODULE_MODULES.has(arg.text)) {
        add(`import(${arg.text})`);
      } else if (arg.text.startsWith('.')) localImports.push(arg.text);
    }
    const p = n.parent;
    if (ts.isIdentifier(n) && p && !DEFINES(p, n) && !inType(n)) {
      const isName = ts.isPropertyAccessExpression(p) && p.name === n;
      // Any `require` — bare, `module.require`, `process.mainModule.require`.
      if (n.text === 'require') {
        const call = callOf(n);
        add(`require:${call ? text(call.arguments[0]) : 'ref'}`);
      } else if (n.text === 'createRequire' || n.text === 'getBuiltinModule') {
        add(`ref:${n.text}`);
      }
      let member: string | undefined;
      if (isName) {
        if (fsReceiver(p.expression)) member = n.text;
        else if (FS_WRITE.has(n.text) && FS_ONLY(n.text)) member = n.text;
      } else if (fsLocal.has(n.text)) {
        member = fsLocal.get(n.text);
      } else if (FS_WRITE.has(n.text) && FS_ONLY(n.text)) {
        member = n.text;
      }
      if (member === 'promises' && isName) {
        // `fs.promises` is a receiver like `fs`; only as a value is it a way out.
        if (!ts.isPropertyAccessExpression(p.parent)) add(`ref:${text(p)}`);
      } else if (member !== undefined) {
        fsUse(member, n);
      }
      // An fs namespace may only be used as `fs.member`: aliased, indexed or
      // passed on, its writes can't be followed.
      if (fsNs.has(n.text) && !(ts.isPropertyAccessExpression(p) && p.expression === n)) {
        add(`ref:${n.text}`);
      }
    } else if (literal(n) && p && !inType(n)) {
      if (FS_WRITE.has(n.text) && ts.isElementAccessExpression(p)) add(`ref:['${n.text}']`);
      if (sensitivePath(n.text, true)) add(`lit:${n.text}`);
    } else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      if (sensitivePath(n.text, ts.isTemplateHead(n))) add(`lit:${n.text}`);
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return { contexts: out, localImports, reexports };
}

/** Repo path a relative specifier in `file` names (`.js` → `.ts`), query dropped. */
function resolveLocal(file: string, spec: string): string {
  const target = normalize(join(dirname(file), spec.replace(/[?#].*$/, '')));
  return target.endsWith('.js') ? `${target.slice(0, -3)}.ts` : target;
}

/**
 * For every changed script file (tests included), ANY write the staged file makes
 * outside a fresh temp dir holds — fail closed, not just new call texts, since an
 * unchanged `writeFileSync(statePath)` writes wherever the diff re-binds
 * `statePath`, and a new caller can hand a same-file writer any path. So does any
 * fs route (require, createRequire, dynamic import, a re-export), and importing
 * a local module — changed or not, through re-export hops — that hands fs out.
 * New home-directory references and new sensitive path literals hold too
 * (compared with HEAD as a multiset).
 * Limit: a write in an UNCHANGED module, reached through an existing import, is
 * not followed — only the path literals handed to it are screened.
 */
export function fsWriteViolation(
  files: string[],
  staged: (file: string) => string | null,
  head: (file: string) => string | null,
): string | null {
  const writes: string[] = [];
  const home: string[] = [];
  const lits: string[] = [];
  const script = (f: string) => /\.(?:[cm]?[jt]sx?)$/.test(f);
  // Whether a local module hands out fs: an fs route of its own, or a chain of
  // re-export hops (`export … from './x'`) to one. Iterative: chains can be long.
  const memo = new Map<string, boolean>();
  const exposesFs = (start: string): boolean => {
    const known = memo.get(start);
    if (known !== undefined) return known;
    const seen = new Set([start]);
    const queue = [start];
    let hit = false;
    while (!hit && queue.length > 0) {
      const target = queue.shift() as string;
      const src = script(target) ? staged(target) : null;
      if (src === null) continue;
      const a = analyzeFs(target, src);
      hit = memo.get(target) ?? [...a.contexts.keys()].some((k) => FS_ROUTE.test(k));
      for (const s of a.reexports) {
        const next = resolveLocal(target, s);
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    memo.set(start, hit);
    return hit;
  };
  for (const file of files.filter(script)) {
    const a = analyzeFs(file, staged(file) ?? '');
    const before = fsWriteContexts(file, head(file) ?? '');
    for (const [ctx, n] of a.contexts) {
      const fresh = n > (before.get(ctx) ?? 0);
      if (ctx.startsWith('home:')) {
        if (fresh) home.push(`${file}: ${ctx.slice(5)}`);
      } else if (ctx.startsWith('lit:')) {
        if (fresh) lits.push(`${file}: '${ctx.slice(4)}'`);
      } else {
        writes.push(`${file}: ${ctx}`);
      }
    }
    for (const spec of new Set(a.localImports)) {
      if (exposesFs(resolveLocal(file, spec))) writes.push(`${file}: fs via ${spec}`);
    }
  }
  if (writes.length > 0) {
    return `writes files outside a fresh temp dir: ${writes.slice(0, 3).join('; ')}`;
  }
  if (home.length > 0) return `reaches the home directory: ${home.slice(0, 3).join('; ')}`;
  return lits.length > 0 ? `names a sensitive path: ${lits.slice(0, 3).join('; ')}` : null;
}
