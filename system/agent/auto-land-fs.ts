// The auto-land gate's filesystem-write hold (see auto-land.ts, check 5 "reach"),
// split out of auto-land.ts so the analysis and its tests stay readable.

import { createRequire } from 'node:module';

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
//    call that creates or changes a file must target a path provably inside a
//    fresh mkdtemp dir — a bare tmpdir() name is predictable, and the gate's own
//    sandbox may create /tmp symlinks — or the change waits for review. Whole
//    files, staged vs HEAD, keyed by call + target text like the integrity guard.

/** fs calls that create or change files → argument positions naming a target. */
const FS_WRITE = new Map<string, number[]>([
  ...[
    'writeFile',
    'appendFile',
    'mkdir',
    'mkdtemp',
    'rm',
    'rmdir',
    'unlink',
    'open',
    'createWriteStream',
    'truncate',
    'chmod',
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
/** Names nothing but fs uses; the rest (open, rm, link…) are also common fields
 *  and locals, so they count only when imported from fs or called on fs. */
const FS_ONLY = (name: string) =>
  name.endsWith('Sync') ||
  ['writeFile', 'appendFile', 'createWriteStream', 'mkdtemp', 'copyFile', 'symlink'].includes(name);
const HOME_REF =
  /\bhomedir\b|\buserInfo\b|\benv\s*(?:\.\s*(?:HOME|USERPROFILE)\b|\[\s*['"`](?:HOME|USERPROFILE)['"`]\s*\])/g;

/** Multiset of unverified writes (`writeFileSync(<target>)`, `ref:fs`) and home references. */
export function fsWriteContexts(file: string, src: string): Map<string, number> {
  const out = new Map<string, number>();
  const add = (k: string) => out.set(k, (out.get(k) ?? 0) + 1);
  const code = codeOnly(file, src);
  for (const m of code.matchAll(HOME_REF)) add(`home:${m[0].replace(/\s+/g, '')}`);
  if (!code) return out;
  const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
  type Node = import('typescript').Node;
  type Expr = import('typescript').Expression;
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const text = (n: Node | undefined) => (n ? n.getText(sf).replace(/\s+/g, ' ') : '');

  // Every value bound to each name (null = a binding that can't be followed:
  // parameter, destructuring, loop/catch variable, compound assignment, import).
  const binds = new Map<string, Array<Node | null>>();
  const bind = (name: string, e: Node | null) => binds.set(name, [...(binds.get(name) ?? []), e]);
  const bindAll = (n: Node) => {
    if (ts.isIdentifier(n)) bind(n.text, null);
    else n.forEachChild(bindAll);
  };
  const fsNs = new Set<string>(); // namespace/default/`promises` imports of fs
  const fsNamed = new Set<string>(); // local names of fs functions imported by name
  const collect = (n: Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const clause = n.importClause;
      if (clause && FS_MODULES.has(n.moduleSpecifier.text)) {
        if (clause.name) fsNs.add(clause.name.text);
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) fsNs.add(nb.name.text);
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            const imported = (el.propertyName ?? el.name).text;
            if (imported === 'promises') fsNs.add(el.name.text);
            if (FS_WRITE.has(imported)) fsNamed.add(el.name.text);
          }
        }
      }
      if (clause) bindAll(clause);
      return;
    }
    if (ts.isVariableDeclaration(n)) {
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
    } else if (ts.isClassDeclaration(n) && n.name) {
      bind(n.name.text, null);
    }
    n.forEachChild(collect);
  };
  collect(sf);

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
  const calleeName = (c: import('typescript').CallExpression) =>
    ts.isIdentifier(c.expression)
      ? c.expression.text
      : ts.isPropertyAccessExpression(c.expression)
        ? c.expression.name.text
        : '';
  /** A literal path segment that stays below its base. */
  const safeSegment = (e: Expr) =>
    (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) &&
    !/^[\\/]/.test(e.text) &&
    !e.text.split(/[\\/]/).includes('..');
  /** `${base}` alone or `${base}/sub/path` — never `${base}x`, a sibling. */
  const safeTail = (t: string) => t === '' || (t.startsWith('/') && !t.split('/').includes('..'));
  const isTmpdir = (e: Expr) =>
    ts.isCallExpression(e) && calleeName(e) === 'tmpdir' && e.arguments.length === 0;
  /** An mkdtemp prefix in the OS temp dir. */
  const tmpPrefix = (raw: Expr): boolean => {
    const e = unwrap(raw);
    if (isTmpdir(e)) return true;
    if (ts.isCallExpression(e) && calleeName(e) === 'join' && e.arguments.length > 0) {
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
      const name = calleeName(e);
      if (ts.isIdentifier(e.expression) && factories.has(name)) return true;
      const [first, ...rest] = e.arguments;
      if (name === 'mkdtemp' || name === 'mkdtempSync')
        return first !== undefined && tmpPrefix(first);
      if (name === 'join' || name === 'resolve') {
        return first !== undefined && rooted(first) && rest.every(safeSegment);
      }
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
    const out: Expr[] = [];
    let bare = false;
    const walk = (n: Node): void => {
      if (n !== fn && isFn(n)) return; // a nested function's returns aren't ours
      if (ts.isReturnStatement(n)) {
        if (n.expression) out.push(n.expression);
        else bare = true;
      }
      n.forEachChild(walk);
    };
    walk(fn);
    return bare || out.length === 0 ? null : out;
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
  const visit = (n: Node): void => {
    if (ts.isImportDeclaration(n)) {
      // `import { writeFileSync as w }` hides every later call behind another name.
      const nb = n.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          if (el.propertyName && FS_WRITE.has(el.propertyName.text)) {
            add(`ref:${el.propertyName.text} as ${el.name.text}`);
          }
        }
      }
      return;
    }
    const p = n.parent;
    const fsReceiver = (r: Expr) =>
      (ts.isIdentifier(r) && fsNs.has(r.text)) ||
      (ts.isPropertyAccessExpression(r) &&
        r.name.text === 'promises' &&
        ts.isIdentifier(r.expression) &&
        fsNs.has(r.expression.text));
    const relevant = (id: import('typescript').Identifier) =>
      FS_ONLY(id.text) ||
      (p && ts.isPropertyAccessExpression(p) && p.name === id
        ? fsReceiver(p.expression)
        : fsNamed.has(id.text));
    if (ts.isIdentifier(n) && FS_WRITE.has(n.text) && p && !DEFINES(p, n) && relevant(n)) {
      const call =
        ts.isCallExpression(p) && p.expression === n
          ? p
          : ts.isPropertyAccessExpression(p) &&
              p.name === n &&
              ts.isCallExpression(p.parent) &&
              p.parent.expression === p
            ? p.parent
            : null;
      if (!call) {
        add(`ref:${n.text}`);
      } else {
        const positions = FS_WRITE.get(n.text) ?? [0];
        const args = call.arguments;
        const ok = n.text.startsWith('mkdtemp')
          ? args[0] !== undefined && tmpPrefix(args[0])
          : positions.every((i) => {
              const a = args[i];
              return a !== undefined && rooted(a);
            });
        if (!ok) add(`${n.text}(${positions.map((i) => text(args[i])).join(', ')})`);
      }
    } else if (ts.isIdentifier(n) && fsNs.has(n.text) && p) {
      // An fs namespace may only be used as `fs.call(...)`/`fs.promises.call(...)`:
      // aliased, indexed or passed on, its writes can't be followed.
      const member = ts.isPropertyAccessExpression(p) && p.expression === n;
      const promisesAsValue =
        member && p.name.text === 'promises' && !ts.isPropertyAccessExpression(p.parent);
      if (!member || promisesAsValue) add(`ref:${n.text}`);
    } else if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      FS_WRITE.has(n.text) &&
      p &&
      ts.isElementAccessExpression(p)
    ) {
      add(`ref:['${n.text}']`);
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/**
 * For every changed script file (tests included), ANY write the staged file makes
 * outside a fresh temp dir holds — fail closed, not just new call texts, since an
 * unchanged `writeFileSync(statePath)` writes wherever the diff re-binds
 * `statePath`, and a new caller can hand a same-file writer any path. New
 * home-directory references hold too (compared with HEAD as a multiset).
 * Limit: a write in an UNCHANGED module, reached through an existing import, is
 * not followed — that closure covers nearly every file in scope.
 */
export function fsWriteViolation(
  files: string[],
  staged: (file: string) => string | null,
  head: (file: string) => string | null,
): string | null {
  const writes: string[] = [];
  const home: string[] = [];
  for (const file of files.filter((f) => /\.(?:[cm]?[jt]sx?)$/.test(f))) {
    const now = fsWriteContexts(file, staged(file) ?? '');
    const before = fsWriteContexts(file, head(file) ?? '');
    for (const [ctx, n] of now) {
      if (!ctx.startsWith('home:')) writes.push(`${file}: ${ctx}`);
      else if (n > (before.get(ctx) ?? 0)) home.push(`${file}: ${ctx.slice(5)}`);
    }
  }
  if (writes.length > 0) {
    return `writes files outside a fresh temp dir: ${writes.slice(0, 3).join('; ')}`;
  }
  return home.length > 0 ? `reaches the home directory: ${home.slice(0, 3).join('; ')}` : null;
}
