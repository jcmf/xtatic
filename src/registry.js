import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { html as htmlBuiltin, makeReadfile } from './builtins.js';
import { BUILTIN_SPECS } from './builtins-registry.js';
import { compileJsxSource } from './compile-jsx.js';
import { compileSource } from './compile.js';
import { processHtml } from './html.js';
import { resolveLogicalPath, substituteFilename } from './paths.js';

const MDX_EXT_RE = /\.mdx?$/;
const JSX_EXT_RE = /\.jsx$/;
const JS_EXT_RE = /\.js$/;
const HTML_EXT_RE = /\.html$/;

function compileErrorPosition(cause) {
  const line =
    cause.line ??
    cause.place?.start?.line ??
    cause.place?.line ??
    null;
  const column =
    cause.column ??
    cause.place?.start?.column ??
    cause.place?.column ??
    null;
  return { line, column };
}

function codeFrame(source, line, column) {
  const lines = source.split('\n');
  if (line < 1 || line > lines.length) return null;
  const errorLine = lines[line - 1];
  const gutter = String(line).length;
  const head = `${String(line).padStart(gutter)} | ${errorLine}`;
  if (!column) return head;
  const caretIndent = ' '.repeat(Math.max(0, column - 1));
  return `${head}\n${' '.repeat(gutter)} | ${caretIndent}^`;
}

function makeCompileError(displayPath, source, cause) {
  const { line, column } = compileErrorPosition(cause);
  const reason = cause.reason ?? cause.message ?? String(cause);
  const where = line != null && column != null ? ` (line ${line}, column ${column})` : '';
  let msg = `Failed to compile "${displayPath}"${where}: ${reason}`;
  if (line != null) {
    const frame = codeFrame(source, line, column);
    if (frame) msg += `\n\n${frame}`;
  }
  if (cause.url) msg += `\n\nSee: ${cause.url}`;
  const err = new Error(msg);
  err.xtaticFormatted = true;
  return err;
}

// xtatic's own source dir — used to drop internal frames from an eval error's
// stack so what's left points at the user's code.
const XTATIC_SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

// Keep the user-facing frames of a thrown error's stack: drop Node internals
// and xtatic's own machinery (the compiled module-body wrapper runs as `eval at
// compileSource (…/src/compile.js…)`, so those frames carry the src dir too).
function userStackFrames(stack) {
  return String(stack ?? '')
    .split('\n')
    .filter((l) => /^\s*at\s/.test(l))
    .filter((l) => !/[ (]node:/.test(l) && !l.includes(XTATIC_SRC_DIR))
    .slice(0, 10);
}

// A throw while *evaluating* a module body — a top-level `export`/expression
// that called a function which threw — isn't a compile error. makeCompileError
// would mislabel it and discard the original stack (which pinpoints the real
// throw site, often an imported .js). Label it as evaluation, surface the
// underlying message, and append the surviving user frames so "where" is clear.
function makeEvalError(displayPath, cause) {
  const reason = cause?.message ?? String(cause);
  let msg = `Failed to evaluate "${displayPath}": ${reason}`;
  const frames = userStackFrames(cause?.stack);
  if (frames.length) msg += `\n\n${frames.join('\n')}`;
  const err = new Error(msg);
  err.cause = cause;
  err.xtaticFormatted = true;
  return err;
}

// Tag a compiled module object with its display path so render-context frames
// (and the layout-chain walk) can name it. Non-enumerable so it doesn't leak
// into `recma-self`'s bare-identifier set or any `Object.keys(mm)` consumer.
function stampPath(mm, displayPath) {
  Object.defineProperty(mm, '__xtatic_path', {
    value: displayPath,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

export function isMdxLike(absPath) {
  return MDX_EXT_RE.test(absPath);
}

export function isJsx(absPath) {
  return JSX_EXT_RE.test(absPath);
}

export function isJs(absPath) {
  return JS_EXT_RE.test(absPath);
}

export function isHtml(absPath) {
  return HTML_EXT_RE.test(absPath);
}

// Keys never inherited by a generated page from its template: tool-derived /
// positional (`name`, `childPages`, `url`), the trigger export (`getPages`), the
// render entry point (`default`, rebound per child), and `outputPath` (which
// must be per-item or every child would write to the same file).
const GENERATED_INHERIT_EXCLUDE = new Set([
  'name',
  'childPages',
  'parent',
  'prevSibling',
  'nextSibling',
  'url',
  'getPages',
  'default',
  'outputPath',
]);

export function createRegistry({ fs, topDir, remarkPlugins, imageRegistry, styleRegistry, fontRegistry, plainAssetRegistry, reloadJs = false }) {
  const mdxModules = new Map();
  const jsxModules = new Map();
  const jsModules = new Map();
  const htmlModules = new Map();
  // The compiled, pre-self-injection default for each loaded .md/.mdx module,
  // keyed by absPath. `loadMdx` wraps `mm.default` to inject `__xtatic_self: mm`;
  // a page generator needs the unwrapped function so each synthetic child can
  // render the same body with its OWN `__xtatic_self` (see expandTemplate).
  const rawDefaults = new Map();

  function displayPath(absPath) {
    const rel = path.posix.relative(topDir, absPath);
    return rel && !rel.startsWith('..') ? rel : absPath;
  }

  // Define `mm.url`: a deferred, page-relative link to this module's own
  // rendered output — the same kind of token `asset('/<path>')` produces, so
  // the page-link rewriting (clean dir URLs, outputPath overrides,
  // per-landing-page relative resolution) applies. Lazy via a getter, so a
  // token is only minted (and recorded for the substitute pass) when something
  // actually reads `.url`. Tool-owned: defined after Object.assign so it
  // clobbers any user export named `url` (an override would just defeat the
  // rewrite). Mirrors how `name`/`childPages` are tool-derived.
  function stampUrl(mm, importerAbsPath, displayP) {
    let token;
    Object.defineProperty(mm, 'url', {
      enumerable: true,
      configurable: true,
      get() {
        if (token === undefined) {
          const asset = plainAssetRegistry
            ? plainAssetRegistry.forImporter(importerAbsPath)
            : (v) => v;
          token = asset(`/${displayP}`);
        }
        return token;
      },
    });
  }

  function resolveSpec(importerAbsPath, spec) {
    if (spec.startsWith('/')) {
      return path.posix.join(topDir, spec);
    }
    if (spec.startsWith('./') || spec.startsWith('../')) {
      return path.posix.resolve(path.posix.dirname(importerAbsPath), spec);
    }
    throw new Error(
      `Cannot resolve import "${spec}" from "${displayPath(importerAbsPath)}": specs must start with "/", "./", or "../".`,
    );
  }

  async function loadJs(absPath) {
    if (jsModules.has(absPath)) return jsModules.get(absPath);
    // .js modules load through Node's real import(), which caches by URL for the
    // whole process — across rebuilds, not just within one. (Unlike .md/.mdx/.jsx,
    // which are read through the injected fs and recompiled every build.) In a
    // long-lived watch/serve process that means an edited .js file keeps serving
    // its first-loaded contents. When reloadJs is set, append the file's mtime as
    // a cache-busting query so a changed file gets a fresh URL (Node re-evaluates
    // it); unchanged files keep the same URL and their cached module. Caveat:
    // this only busts the directly-imported module. A .js that statically imports
    // another .js resolves that inner specifier through Node's resolver to a
    // query-less URL, so transitive .js→.js edits still won't reload — touch the
    // directly-imported file to force a reload.
    const url = pathToFileURL(absPath);
    if (reloadJs) {
      try {
        url.search = `v=${statSync(absPath).mtimeMs}`;
      } catch {
        // stat failure (e.g. a race with a delete) — fall back to the bare URL.
      }
    }
    const pending = import(url.href);
    jsModules.set(absPath, pending);
    return pending;
  }

  // A module that failed to load stays in its cache as `status: 'failed'` with
  // the error, and every later load of it rethrows that same Error object. Two
  // reasons: the placeholder `mm` is an empty object, so handing it out again
  // would surface as a baffling downstream error ("Unsupported JSX type") far
  // from the real cause; and a keep-going build (see errors.js) dedupes
  // collected errors by identity, so one broken layout imported by many pages
  // is reported once. Returns the cached mm for a done/compiling entry.
  function cachedOrThrow(cache, absPath) {
    const entry = cache.get(absPath);
    if (entry === undefined) return undefined;
    if (entry.status === 'failed') throw entry.error;
    return entry.mm;
  }

  function markFailed(cache, absPath, error) {
    const entry = cache.get(absPath);
    entry.status = 'failed';
    entry.error = error;
    return error;
  }

  async function loadJsx(absPath) {
    const cached = cachedOrThrow(jsxModules, absPath);
    if (cached !== undefined) return cached;
    const mm = {};
    jsxModules.set(absPath, { mm, status: 'compiling' });
    try {
      const source = await fs.promises.readFile(absPath, 'utf8');
      let compiled;
      try {
        compiled = await compileJsxSource(source, {
          resolve: makeResolver(absPath),
          asset: plainAssetRegistry?.forImporter(absPath),
          importerDisplay: displayPath(absPath),
        });
      } catch (e) {
        // A nested import that failed already carries a formatted xtatic error
        // naming the real culprit file — re-throw it as-is rather than wrapping it
        // again under this importer (which would bury the culprit and duplicate
        // its stack frames).
        if (e?.xtaticFormatted) throw e;
        if (e?.xtaticEvalError) throw makeEvalError(displayPath(absPath), e);
        throw makeCompileError(displayPath(absPath), source, e);
      }
      Object.assign(mm, compiled);
    } catch (e) {
      throw markFailed(jsxModules, absPath, e);
    }
    const dp = displayPath(absPath);
    stampPath(mm, dp);
    stampUrl(mm, absPath, dp);
    jsxModules.get(absPath).status = 'done';
    return mm;
  }

  // A .html input file is a page whose rendered output is the file itself,
  // with whitelisted asset/link references routed through the plain-asset
  // pipeline (tokens spliced into the source; everything else ships verbatim).
  // No MDX compile, no frontmatter, no exports — and no layout: the file is
  // taken to be a complete document, so `layout` is pinned to null (not
  // undefined) to opt out of assembleTree's defaultLayout walk. A non-empty
  // <title> defaults the page's `title` the way frontmatter would.
  async function loadHtml(absPath) {
    const cached = cachedOrThrow(htmlModules, absPath);
    if (cached !== undefined) return cached;
    const mm = {};
    htmlModules.set(absPath, { mm, status: 'processing' });
    const dp = displayPath(absPath);
    try {
      const source = await fs.promises.readFile(absPath, 'utf8');
      const asset = plainAssetRegistry
        ? plainAssetRegistry.forImporter(absPath)
        : (value) => value;
      const { html, title } = processHtml(source, {
        asset,
        importerDisplay: dp,
      });
      if (title !== undefined) mm.title = title;
      mm.layout = null;
      mm.default = () => ({ html });
    } catch (e) {
      throw markFailed(htmlModules, absPath, e);
    }
    stampPath(mm, dp);
    stampUrl(mm, absPath, dp);
    htmlModules.get(absPath).status = 'done';
    return mm;
  }

  async function loadMdx(absPath) {
    const cached = cachedOrThrow(mdxModules, absPath);
    if (cached !== undefined) return cached;
    const mm = {};
    mdxModules.set(absPath, { mm, status: 'compiling' });
    try {
      const source = await fs.promises.readFile(absPath, 'utf8');
      let compiled;
      try {
        compiled = await compileSource(source, {
          importerPath: absPath,
          importerDisplay: displayPath(absPath),
          resolve: makeResolver(absPath),
          asset: plainAssetRegistry?.forImporter(absPath),
          remarkPlugins,
        });
      } catch (e) {
        // A nested import that failed already carries a formatted xtatic error
        // naming the real culprit file — re-throw it as-is rather than wrapping it
        // again under this importer (which would bury the culprit and duplicate
        // its stack frames).
        if (e?.xtaticFormatted) throw e;
        if (e?.xtaticEvalError) throw makeEvalError(displayPath(absPath), e);
        throw makeCompileError(displayPath(absPath), source, e);
      }
      Object.assign(mm, compiled);
    } catch (e) {
      throw markFailed(mdxModules, absPath, e);
    }
    const dp = displayPath(absPath);
    stampPath(mm, dp);
    stampUrl(mm, absPath, dp);
    const original = mm.default;
    rawDefaults.set(absPath, original);
    mm.default = (props = {}) => original({ ...props, __xtatic_self: mm });
    mdxModules.get(absPath).status = 'done';
    return mm;
  }

  // Expand a page generator (a loaded .md/.mdx module that exports a `getPages`
  // function, named with `{placeholder}` tokens) into one synthetic child module
  // per item the function returns. getPages() is called here — after buildImpl
  // has assembled the ordinary-page tree — so it can import a parent page and
  // iterate its childPages (which only exist post-assembly). Each child is a
  // normal module object so it flows through the rest of the pipeline (tree
  // placement, name/title/date defaulting, layout chain, `.url`, render-context)
  // with no special-casing. `toRelPath` maps an absolute path back to the
  // inputDir-relative form used for segments — only the caller (buildImpl) knows
  // inputDir, which may differ from topDir.
  function expandTemplate(tmplMm, tmplAbsPath, { toRelPath }) {
    const tmplDisplay = displayPath(tmplAbsPath);
    const getPages = tmplMm.getPages;
    if (typeof getPages !== 'function') {
      throw new Error(
        `Page generator "${tmplDisplay}" must export a function \`getPages\` (got ${getPages === undefined ? 'undefined' : typeof getPages}).`,
      );
    }
    // getPages is user code (often reading an imported parent's childPages) —
    // surface a throw under the generator's name rather than as a bare
    // "cannot read properties of undefined" with no hint of where it came from.
    let items;
    try {
      items = getPages();
    } catch (e) {
      throw new Error(
        `Page generator "${tmplDisplay}" getPages() threw: ${e?.message ?? e}`,
        { cause: e },
      );
    }
    if (!Array.isArray(items)) {
      throw new Error(
        `Page generator "${tmplDisplay}" getPages() must return an array (got ${items === undefined ? 'undefined' : typeof items}).`,
      );
    }
    const original = rawDefaults.get(tmplAbsPath);
    const filename = path.posix.basename(tmplAbsPath);
    const dir = path.posix.dirname(tmplAbsPath);
    const entries = [];
    items.forEach((item, index) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        const got = Array.isArray(item) ? 'array' : item === null ? 'null' : typeof item;
        throw new Error(
          `Page generator "${tmplDisplay}" pages[${index}] must be an object (got ${got}).`,
        );
      }
      // Inherit the template's own exports as a base (so the body's bare refs to
      // the file's own exports + `layout`/`defaultLayout` still resolve). `url`
      // is an enumerable getter, but it's excluded, so it's skipped before being
      // read (no token minted).
      const child = {};
      const inherited = new Set();
      for (const key of Object.keys(tmplMm)) {
        if (GENERATED_INHERIT_EXCLUDE.has(key)) continue;
        child[key] = tmplMm[key];
        inherited.add(key);
      }
      // A page item may not reuse a name the template already exports: the two
      // sharing a key is ambiguous, and for a template-declared const the body
      // wouldn't even reflect the item's value (it binds to the const). So it's
      // an error, not a silent win. (Name-derived title/date defaults aren't
      // template exports, so an item setting `title`/`date` is fine.)
      const clashes = Object.keys(item).filter((k) => inherited.has(k));
      if (clashes.length > 0) {
        const list = clashes.map((k) => `"${k}"`).join(', ');
        throw new Error(
          `Page generator "${tmplDisplay}" pages[${index}] sets ${list}, which the template already exports. ` +
            `A page field can't share a name with a template export — rename one (declare per-page values only in items).`,
        );
      }
      Object.assign(child, item);
      delete child.getPages;
      // Render the shared body with `__xtatic_self` pointing at THIS child, so
      // the item's fields surface as bare identifiers ({tag}) just like any
      // other module export.
      child.default = (props = {}) => original({ ...props, __xtatic_self: child });
      const subFilename = substituteFilename(filename, child, {
        template: tmplDisplay,
        index,
      });
      const childAbs = path.posix.join(dir, subFilename);
      const childDisplay = displayPath(childAbs);
      stampPath(child, childDisplay);
      stampUrl(child, childAbs, childDisplay);
      const relPath = toRelPath(childAbs);
      entries.push({
        relPath,
        segments: resolveLogicalPath(relPath),
        mm: child,
        absPath: tmplAbsPath,
        origin: `${tmplDisplay} → ${relPath}`,
      });
    });
    return entries;
  }

  function makeResolver(importerAbsPath) {
    return async function resolve(spec) {
      if (spec.startsWith('xtatic:')) {
        if (spec === 'xtatic:builtins') {
          const asset = plainAssetRegistry
            ? plainAssetRegistry.forImporter(importerAbsPath)
            : (value) => value;
          return {
            html: htmlBuiltin,
            readfile: makeReadfile({
              fs,
              topDir,
              importerAbsPath,
              importerDisplay: displayPath(importerAbsPath),
            }),
            asset,
          };
        }
        if (spec === 'xtatic:image') {
          if (!imageRegistry) {
            throw new Error(
              `"xtatic:image" was imported from "${displayPath(importerAbsPath)}" but no image registry was provided to createRegistry.`,
            );
          }
          return { Image: imageRegistry.forImporter(importerAbsPath) };
        }
        if (spec === 'xtatic:style') {
          if (!styleRegistry) {
            throw new Error(
              `"xtatic:style" was imported from "${displayPath(importerAbsPath)}" but no style registry was provided to createRegistry.`,
            );
          }
          return { Style: styleRegistry.forImporter(importerAbsPath) };
        }
        if (spec === 'xtatic:font') {
          if (!fontRegistry) {
            throw new Error(
              `"xtatic:font" was imported from "${displayPath(importerAbsPath)}" but no font registry was provided to createRegistry.`,
            );
          }
          return { Font: fontRegistry.forImporter(importerAbsPath) };
        }
        const available = BUILTIN_SPECS.map((s) => `"${s}"`).join(', ');
        throw new Error(
          `Unknown builtin module "${spec}" imported from "${displayPath(importerAbsPath)}". Available: ${available}.`,
        );
      }
      const absPath = resolveSpec(importerAbsPath, spec);
      if (isMdxLike(absPath)) return await loadMdx(absPath);
      if (isJsx(absPath)) return await loadJsx(absPath);
      if (isJs(absPath)) return await loadJs(absPath);
      if (isHtml(absPath)) return await loadHtml(absPath);
      throw new Error(
        `Unsupported import "${spec}" from "${displayPath(importerAbsPath)}": only .md, .mdx, .jsx, .js, and .html are supported.`,
      );
    };
  }

  return { loadMdx, loadJsx, loadJs, loadHtml, expandTemplate, mdxModules, jsxModules, jsModules, htmlModules, resolveSpec };
}
