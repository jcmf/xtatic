import path from 'node:path';
import { createAssetRegistry } from './assets.js';
import { createErrorCollector, makeBuildError } from './errors.js';
import { createPlainAssetRegistry } from './assets-plain.js';
import { createFontRegistry } from './font.js';
import { createImageRegistry } from './image.js';
import { createStyleRegistry } from './style.js';
import { resolveLogicalPath, hasPlaceholders } from './paths.js';
import { assembleTree } from './tree.js';
import { renderModule } from './render.js';
import { attachContext, formatContext, withFrame } from './render-context.js';
import { createOutputWriter } from './output.js';
import { createRegistry } from './registry.js';
import { wrapZipFs } from './zipfs.js';
import {
  VERBATIM_MARKER,
  collectVerbatimFiles,
  hasVerbatimMarker,
  isVerbatimByPatterns,
  parseVerbatimMarker,
  verbatimOutPath,
  writeVerbatimFiles,
} from './verbatim.js';

const PAGE_EXT_RE = /\.(?:mdx?|html)$/;
const HTML_EXT_RE = /\.html$/;
// Any registry token or emit placeholder still present in a page's HTML after
// every substitute has run. In a strict build this can't happen (the registry
// that owns the token would have thrown); in keep-going mode it means the
// asset behind the token failed, so the page can't be written correctly.
const LEFTOVER_TOKEN_RE =
  /__XTATIC_(?:IMG|STYLE|FONT|ASSET)_[a-f0-9]+__|__XTATIC_EMIT_[a-f0-9]+\.[a-z0-9]+__/;

// Walk inputDir for page sources. A directory carrying an empty
// `.xtatic-verbatim` marker is not descended for pages: every file under it is
// collected into `verbatim` instead, to be copied to the output as-is. A
// marker with pattern lines only diverts the matching files/directories and
// the walk otherwise continues; its patterns stay active for the whole
// subtree beneath it (see src/verbatim.js).
async function walkPages(fs, root) {
  const results = [];
  const verbatim = [];
  async function recurse(absDir, relDir, active) {
    const entries = await fs.promises.readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (hasVerbatimMarker(entries)) {
      const marker = parseVerbatimMarker(
        await fs.promises.readFile(`${absDir}/${VERBATIM_MARKER}`, 'utf8'),
      );
      if (marker.all) {
        verbatim.push(...(await collectVerbatimFiles(fs, absDir, relDir)));
        return;
      }
      active = [...active, { baseRel: relDir, rules: marker.rules }];
    }
    for (const ent of entries) {
      if (ent.name === VERBATIM_MARKER) continue;
      const childAbs = `${absDir}/${ent.name}`;
      const childRel = relDir === '' ? ent.name : `${relDir}/${ent.name}`;
      const isDir = ent.isDirectory();
      if (
        active.length > 0 &&
        (isDir || ent.isFile()) &&
        isVerbatimByPatterns(active, childRel, isDir)
      ) {
        if (isDir) {
          verbatim.push(...(await collectVerbatimFiles(fs, childAbs, childRel)));
        } else {
          verbatim.push({ absPath: childAbs, relPath: childRel });
        }
      } else if (isDir) {
        await recurse(childAbs, childRel, active);
      } else if (ent.isFile() && PAGE_EXT_RE.test(ent.name)) {
        results.push({ absPath: childAbs, relPath: childRel });
      }
    }
  }
  await recurse(root, '', []);
  return { pages: results, verbatim };
}

function computeOutPath(mm, segments, outputDir, pageLabel) {
  if (mm.outputPath === undefined) {
    return [outputDir, ...segments, 'index.html'].join('/');
  }
  const op = mm.outputPath;
  const where = ` (set on page "${pageLabel}")`;
  if (typeof op !== 'string') {
    throw new Error(
      `outputPath${where} must be a string (got ${typeof op}).`,
    );
  }
  if (!op.startsWith('/') || op === '/' || op.endsWith('/')) {
    throw new Error(
      `Invalid outputPath "${op}"${where}: must be an absolute path starting with "/" and naming a file (not a directory).`,
    );
  }
  if (op.split('/').includes('..')) {
    throw new Error(
      `Invalid outputPath "${op}"${where}: must not contain ".." segments.`,
    );
  }
  return path.posix.join(outputDir, op);
}

// `ctx`: {outputDir, topDir, assetsDirAbs, pages, seen, errors, unrenderable,
// skipped}. Every page's failure is reported to `ctx.errors` (which throws in
// strict mode, ends the walk, and matches the old behavior); in keep-going
// mode the page is left out, its label pushed onto `ctx.skipped`, and the walk
// continues with its siblings and children.
function renderTree(mm, segments, ctx) {
  // A synthetic node (directory with no index.md) groups its children in the
  // tree but has no source module and emits no output file.
  if (!mm.__xtatic_synthetic) {
    const page = segments.length ? segments.join('/') : '/';
    try {
      renderPage(mm, segments, page, ctx);
    } catch (err) {
      ctx.skipped.push(page);
      ctx.errors.report(err);
    }
  }
  for (const child of mm.childPages) {
    renderTree(child, [...segments, child.name], ctx);
  }
}

function renderPage(mm, segments, page, ctx) {
  const { outputDir, topDir, assetsDirAbs, pages, seen, unrenderable, skipped } =
    ctx;
  const outPath = computeOutPath(mm, segments, outputDir, page);
  // Source-tree position of this page, used by the plain-asset registry to map
  // <a href="./other.md"> link targets onto their rendered output paths.
  const srcPath =
    mm.__xtatic_path != null
      ? path.posix.join(topDir, mm.__xtatic_path)
      : null;
  if (isInsideOrSame(assetsDirAbs, outPath)) {
    throw new Error(
      `Page "${page}" writes to "${outPath}", which is inside the generated assets directory "${assetsDirAbs}". ` +
        `Rename the page (or its outputPath), or set a different xtatic.assetsDir.`,
    );
  }
  const prior = seen.get(outPath);
  if (prior !== undefined) {
    // `prior` is either another page's label or a `verbatim file "…"` label
    // seeded by buildImpl before rendering began.
    const isVerbatim = prior.startsWith('verbatim file ');
    throw new Error(
      `Two ${isVerbatim ? 'sources' : 'pages'} write to the same output path "${outPath}": ${isVerbatim ? prior : `"${prior}"`} and "${page}".`,
    );
  }
  seen.set(outPath, page);
  // The record goes in before rendering so a page that fails (or was already
  // unrenderable because its layout chain didn't resolve) still claims its
  // output path: a link to it then resolves to that URL instead of the
  // plain-asset registry copying the page's source file as an asset. Consumers
  // treat `html: null` as "not rendered".
  const record = { page, outPath, srcPath, html: null };
  pages.push(record);
  if (unrenderable.has(mm)) {
    skipped.push(page);
    return;
  }
  record.html = withFrame(
    { kind: 'page', page, file: mm.__xtatic_path ?? null },
    () => {
      try {
        return renderModule(mm);
      } catch (err) {
        throw attachContext(err);
      }
    },
  ).html;
}

// Write every rendered page. In keep-going mode a page whose HTML still holds
// a token after substitution (its asset job failed) is left out and recorded
// in `skipped` — the failure itself was already reported by the registry.
async function writePages(pages, substitute, writer, { keepGoing, skipped }) {
  for (const { page, outPath, html } of pages) {
    if (html == null) continue;
    const out = substitute(html, outPath);
    if (keepGoing && LEFTOVER_TOKEN_RE.test(out)) {
      skipped.push(page);
      continue;
    }
    await writer.writeFile(outPath, out);
  }
}

function isInsideOrSame(parent, child) {
  if (parent === child) return true;
  const sep = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(sep);
}

// Reject two entries (ordinary or generator-produced) that resolve to the same
// logical path. Mirrors resolveLogicalPaths' check but spans the merged set;
// generator-produced entries carry an `origin` ("template → substituted") for a
// clearer message than the virtual substituted relPath alone. Returns the
// entries that survive: in keep-going mode the later claimant of a path is
// reported and dropped, in strict mode the first collision throws.
function uniqueLogicalPaths(entries, errors, skipped) {
  const claimed = new Map();
  const out = [];
  for (const e of entries) {
    const key = e.segments.join('/');
    const existing = claimed.get(key);
    if (existing !== undefined) {
      const label = key === '' ? '(root)' : key;
      skipped.push(pageLabel(e));
      errors.report(
        new Error(
          `Multiple input files map to the same output path "${label}": ${existing} and ${e.origin ?? e.relPath}`,
        ),
      );
      continue;
    }
    claimed.set(key, e.origin ?? e.relPath);
    out.push(e);
  }
  return out;
}

// The label a page goes by in error messages and the skipped-pages summary:
// its logical path ("blog/post-1", or "/" for the root).
function pageLabel(entry) {
  return entry.segments.length ? entry.segments.join('/') : '/';
}

// Suggest a generator filename for a file that exported `getPages` without one:
// foo.md → foo-{slug}.md, blog/post.mdx → blog/post-{slug}.mdx.
function placeholderHint(relPath) {
  const slash = relPath.lastIndexOf('/');
  const dir = slash === -1 ? '' : relPath.slice(0, slash + 1);
  const file = slash === -1 ? relPath : relPath.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  const base = dot === -1 ? file : file.slice(0, dot);
  const ext = dot === -1 ? '' : file.slice(dot);
  return `${dir}${base}-{slug}${ext}`;
}

function assertValidAssetsDir(assetsDir) {
  if (typeof assetsDir !== 'string' || assetsDir === '') {
    throw new Error(
      `assetsDir must be a non-empty string (got ${JSON.stringify(assetsDir)}).`,
    );
  }
  if (assetsDir.includes('/') || assetsDir === '.' || assetsDir === '..') {
    throw new Error(
      `assetsDir "${assetsDir}" must be a single path segment (no "/", ".", or "..").`,
    );
  }
}

function assertSafeOutputDir(outputDir, sources) {
  if (!outputDir || outputDir === '/' || outputDir === '.') {
    throw new Error(
      `outputDir must be a non-root directory path (got "${outputDir}").`,
    );
  }
  for (const [name, dir] of Object.entries(sources)) {
    if (isInsideOrSame(outputDir, dir)) {
      throw new Error(
        `outputDir "${outputDir}" must not be the same as or an ancestor of ${name} "${dir}" (files it doesn't generate are deleted at the end of every build).`,
      );
    }
  }
}

// Read a source file named by a render-context frame (a topDir-relative display
// path, or an absolute path for sources outside topDir) so formatContext can
// print its code frame. Sync (formatContext is sync), best-effort (a missing or
// unreadable file just means no frame), and memoized since a trace can name the
// same file twice.
function makeSourceReader(fs, topDir) {
  if (!fs || typeof fs.readFileSync !== 'function') return () => null;
  const cache = new Map();
  return (file) => {
    if (!file) return null;
    if (cache.has(file)) return cache.get(file);
    let text = null;
    try {
      const abs = path.posix.isAbsolute(file)
        ? file
        : path.posix.join(topDir, file);
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      text = null;
    }
    cache.set(file, text);
    return text;
  };
}

// A render error (possibly deferred to a registry's processAll) carries a
// snapshot of the page / layout / component chain that led to it; fold it
// into the message so every consumer (cli, watch, serve-error) shows it.
function renderContextInto(err, options) {
  if (
    !err ||
    typeof err !== 'object' ||
    !err.xtaticContext ||
    err.xtaticContextRendered
  ) {
    return;
  }
  const topDir =
    options.topDir != null
      ? path.posix.resolve(options.topDir)
      : path.posix.resolve(options.inputDir);
  const ctx = formatContext(err.xtaticContext, {
    readSource: makeSourceReader(options.fs, topDir),
    codeFrameWidth: options.codeFrameWidth ?? 120,
  });
  if (ctx) {
    err.message = `${err.message}\n\n${ctx}`;
    err.xtaticContextRendered = true;
  }
}

// `keepGoing: true` turns the first-error-aborts build into a best-effort one:
// every per-page / per-generator / per-layout / per-asset failure is collected
// (see errors.js), the affected pages are left out of the output, everything
// else is written and pruned as usual, and the build then rejects with one
// AggregateError listing every failure plus the pages that weren't written.
// Without it (the default) the first error is thrown as before.
export async function build(options) {
  const keepGoing = options.keepGoing === true;
  const errors = createErrorCollector({ keepGoing });
  const skipped = [];
  try {
    await buildImpl({ ...options, errors, skipped });
  } catch (err) {
    // Strict mode: the one error. Keep-going: a fatal (non-per-unit) error
    // that ended the build early, listed after everything collected so far.
    errors.add(err);
  }
  if (errors.list.length === 0) return;
  for (const err of errors.list) renderContextInto(err, options);
  if (!keepGoing) throw errors.list[0];
  const pages = [...new Set(skipped)].sort();
  throw makeBuildError(errors.list, pages);
}

async function buildImpl({
  inputDir,
  outputDir,
  topDir,
  layoutsDir,
  remarkPlugins,
  imageInlineThreshold,
  styleInlineThreshold,
  assetInlineThreshold,
  assetsDir = '_assets',
  autoInstall = false,
  install,
  fontSubset,
  reloadJs = false,
  fs,
  errors = createErrorCollector(),
  // Labels of pages left out of the output (keep-going mode); build() owns
  // the array so it survives a fatal throw.
  skipped = [],
}) {
  const { keepGoing } = errors;
  inputDir = path.posix.resolve(inputDir);
  outputDir = path.posix.resolve(outputDir);
  topDir = topDir != null ? path.posix.resolve(topDir) : inputDir;
  layoutsDir =
    layoutsDir != null
      ? path.posix.resolve(layoutsDir)
      : path.posix.join(topDir, 'layouts');
  assertSafeOutputDir(outputDir, { topDir, inputDir, layoutsDir });
  assertValidAssetsDir(assetsDir);
  const assetsDirAbs = path.posix.join(outputDir, assetsDir);
  // The writer keeps the raw injected fs: output paths never need the zip
  // interception, and the unchanged-file comparison reads would otherwise be
  // misrouted for a (pathological) output path containing a `.zip/` segment.
  // There is no upfront wipe of outputDir — unchanged files are skipped to
  // preserve their timestamps, and writer.prune() at the end deletes whatever
  // this build didn't write (so renames/deletes still can't leave stale files).
  const writer = createOutputWriter({ fs, outputDir });
  fs = wrapZipFs(fs);
  const { pages: files, verbatim } = await walkPages(fs, inputDir);
  // Verbatim files claim their output paths before any page renders, so a
  // page landing on the same path (pages/about.md vs. a verbatim
  // pages/about/index.html) is a hard error, and none may sit under assetsDir.
  const seen = new Map();
  const verbatimOk = [];
  for (const v of verbatim) {
    v.outPath = verbatimOutPath(outputDir, v.relPath);
    if (isInsideOrSame(assetsDirAbs, v.outPath)) {
      errors.report(
        new Error(
          `Verbatim file "${v.relPath}" writes to "${v.outPath}", which is inside the generated assets directory "${assetsDirAbs}". ` +
            `Move the file, or set a different xtatic.assetsDir.`,
        ),
      );
      continue;
    }
    seen.set(v.outPath, `verbatim file "${v.relPath}"`);
    verbatimOk.push(v);
  }
  // Page generators are files whose name carries `{placeholder}` tokens (e.g.
  // tag-{tag}.md); they expand into one page per item their `getPages()` returns
  // instead of rendering at their own slot. Everything else is an ordinary page.
  const templateFiles = [];
  const normalFiles = [];
  for (const f of files) {
    (hasPlaceholders(f.relPath) ? templateFiles : normalFiles).push(f);
  }
  let entries = normalFiles.map((f) => ({
    relPath: f.relPath,
    segments: resolveLogicalPath(f.relPath),
    absPath: f.absPath,
  }));

  const assetRegistry = createAssetRegistry({ fs, outputDir, assetsDir, writer });
  const imageRegistry = createImageRegistry({
    fs,
    topDir,
    assetRegistry,
    defaultInlineThreshold: imageInlineThreshold,
    autoInstall,
    install,
    errors,
  });
  const styleRegistry = createStyleRegistry({
    fs,
    topDir,
    assetRegistry,
    defaultInlineThreshold: styleInlineThreshold,
    errors,
  });
  const fontRegistry = createFontRegistry({
    fs,
    topDir,
    assetRegistry,
    autoInstall,
    install,
    fontSubset,
    errors,
  });
  const plainAssetRegistry = createPlainAssetRegistry({
    fs,
    topDir,
    inputDir,
    outputDir,
    assetRegistry,
    defaultInlineThreshold: assetInlineThreshold,
    writer,
    errors,
  });
  const registry = createRegistry({
    fs,
    topDir,
    remarkPlugins,
    imageRegistry,
    styleRegistry,
    fontRegistry,
    plainAssetRegistry,
    reloadJs,
  });
  // Load every page. A page that fails to load (compile error, a broken
  // import, …) is dropped from the entry set: in keep-going mode its slot in
  // the tree is synthesized if it has children, so listings simply omit it.
  // The registry caches the failure, so another page importing the broken
  // file fails with the very same Error object (deduped by the collector).
  const loaded = [];
  for (const entry of entries) {
    try {
      entry.mm = HTML_EXT_RE.test(entry.relPath)
        ? await registry.loadHtml(entry.absPath)
        : await registry.loadMdx(entry.absPath);
    } catch (e) {
      skipped.push(pageLabel(entry));
      errors.report(e);
      continue;
    }
    // A file that exports `getPages` but isn't a generator (no {placeholder} in
    // its name) would silently render once and drop the export — surface it.
    if (entry.mm.getPages !== undefined) {
      skipped.push(pageLabel(entry));
      errors.report(
        new Error(
          `"${entry.relPath}" exports \`getPages\` but its filename has no {placeholder}; ` +
            `rename it (e.g. ${placeholderHint(entry.relPath)}) to generate multiple pages from it.`,
        ),
      );
      continue;
    }
    loaded.push(entry);
  }
  entries = loaded;
  // Every page failed to load: there's nothing to assemble (and "No page
  // sources found" would only bury the real errors), so stop here. The
  // previous output is left as it was.
  if (entries.length === 0 && errors.list.length > 0) return;
  // Assemble the ordinary pages into a tree before expanding generators, so a
  // generator's getPages() can import a parent page and iterate its childPages
  // (which only exist post-assembly). The same mm objects are re-wired by the
  // full assembly below once the generated pages join — assembleTree rebuilds
  // childPages from scratch, so running it twice is safe. Skip when there are no
  // generators: nothing reads the intermediate state.
  if (templateFiles.length > 0) {
    assembleTree(entries, { inputDir });
  }
  // Expand each generator into its synthetic child pages, then fold them into
  // the entry set so they flow through tree assembly and rendering as usual.
  const toRelPath = (abs) => path.posix.relative(inputDir, abs);
  for (const f of templateFiles) {
    // A generator that fails (to load, or inside getPages()) produces no
    // pages at all; it's listed under its own logical label.
    try {
      if (HTML_EXT_RE.test(f.relPath)) {
        throw new Error(
          `Page generator "${f.relPath}" must be a .md or .mdx file: a .html file cannot export getPages.`,
        );
      }
      const tmplMm = await registry.loadMdx(f.absPath);
      for (const e of registry.expandTemplate(tmplMm, f.absPath, { toRelPath })) {
        entries.push(e);
      }
    } catch (e) {
      skipped.push(pageLabel({ segments: resolveLogicalPath(f.relPath) }));
      errors.report(e);
    }
  }
  entries = uniqueLogicalPaths(entries, errors, skipped);
  entries.sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
  const root = assembleTree(entries, { inputDir });
  // A page whose layout chain doesn't resolve can't render; it keeps its
  // place in the tree (listings still see it) but is skipped by renderTree.
  // Layout lookups that fail are cached by name so fifty pages sharing one
  // missing layout report it once.
  const unrenderable = new Set();
  const failedLayouts = new Map();
  for (const entry of entries) {
    try {
      await resolveLayoutChain(entry.mm, {
        fs,
        layoutsDir,
        registry,
        requesterPath: entry.relPath,
        failedLayouts,
      });
    } catch (e) {
      unrenderable.add(entry.mm);
      errors.report(e);
    }
  }
  const pages = [];
  renderTree(root, [], {
    outputDir,
    topDir,
    assetsDirAbs,
    pages,
    seen,
    errors,
    unrenderable,
    skipped,
  });
  // Pages that actually rendered; the plain-asset registry gets the full list
  // (unrendered pages still claim their output paths for link resolution).
  const rendered = pages.filter((p) => p.html != null);
  const imageSubstitute = await imageRegistry.processAll();
  const styleSubstitute = await styleRegistry.processAll();
  // Plain-asset runs before font so the font registry can ask
  // plainAssetRegistry.cssForPage(html) (alongside styleRegistry.cssForPage)
  // for the CSS that reaches each page — needed by the css-static cascade
  // engine (commit 3+). Substitute composition is order-independent because
  // token namespaces are disjoint.
  // Verbatim files are link targets too: <a href="./legacy/x.xml"> from a page
  // resolves to the copied file's page-relative URL rather than re-emitting it
  // as an asset.
  const verbatimOutBySrc = new Map(
    verbatimOk.map((v) => [v.absPath, v.outPath]),
  );
  const assetSubstitute = await plainAssetRegistry.processAll(pages, {
    verbatimOutBySrc,
  });
  const fontSubstitute = await fontRegistry.processAll(rendered, {
    cssForPage: (html) => [
      ...styleRegistry.cssForPage(html),
      ...plainAssetRegistry.cssForPage(html),
    ],
  });
  await assetRegistry.writeAll();
  await plainAssetRegistry.writeAll();
  // Relativize runs last (outermost): the four registry substitutes leave
  // `__XTATIC_EMIT_…__` placeholders for shared /_assets/ files; this rewrites
  // each to a path relative to the page's own output directory.
  const substitute = (html, outPath) =>
    assetRegistry.relativize(
      assetSubstitute(
        fontSubstitute(styleSubstitute(imageSubstitute(html)), outPath),
        outPath,
      ),
      path.posix.dirname(outPath),
    );
  await writePages(rendered, substitute, writer, { keepGoing, skipped });
  await writeVerbatimFiles({ fs, writer, entries: verbatimOk });
  // Prune runs even when pages were skipped: the output then reflects this
  // build's state (a broken page is absent, not stale), and the error lists
  // exactly which pages that applies to.
  await writer.prune();
}

async function resolveLayoutChain(mm, ctx) {
  if (typeof mm.layout !== 'string') return;
  const tmpl = await loadLayoutByName(mm.layout, ctx);
  mm.layout = tmpl;
  await resolveLayoutChain(tmpl, ctx);
}

async function loadLayoutByName(
  name,
  { fs, layoutsDir, registry, requesterPath, failedLayouts = new Map() },
) {
  if (failedLayouts.has(name)) throw failedLayouts.get(name);
  if (/\.mdx?$/.test(name)) {
    return registry.loadMdx(path.posix.join(layoutsDir, name));
  }
  const mdxPath = path.posix.join(layoutsDir, `${name}.mdx`);
  const mdPath = path.posix.join(layoutsDir, `${name}.md`);
  for (const p of [mdxPath, mdPath]) {
    try {
      await fs.promises.stat(p);
      return registry.loadMdx(p);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  const requestedBy = requesterPath ? ` (requested by "${requesterPath}")` : '';
  const err = new Error(
    `Layout "${name}"${requestedBy} not found: tried ${mdxPath} and ${mdPath}.`,
  );
  failedLayouts.set(name, err);
  throw err;
}
