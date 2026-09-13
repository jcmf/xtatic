import crypto from 'node:crypto';
import path from 'node:path';
import { VALID_PLACEMENTS } from './asset-rules.js';
import { rewriteCssUrls } from './css-urls.js';
import { createErrorCollector } from './errors.js';
import { createOutputWriter } from './output.js';
import { attachContext, currentStack } from './render-context.js';

const TOKEN_RE = /__XTATIC_ASSET_[a-f0-9]+__/g;
// Any registry token (asset/image/style/font), anchored — used to make asset()
// idempotent when a manual asset() result flows into a whitelisted attribute.
const ANY_XTATIC_TOKEN_RE = /^__XTATIC_(?:ASSET|IMG|STYLE|FONT)_[a-f0-9]+__$/;
const EXT_RE = /\.([a-z0-9]+)$/i;

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  css: 'text/css',
  js: 'application/javascript',
  mjs: 'application/javascript',
  json: 'application/json',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
};

function makeToken() {
  return `__XTATIC_ASSET_${crypto.randomBytes(12).toString('hex')}__`;
}

// Anything carrying a URL scheme (`https:`, `mailto:`, `tel:`, `javascript:`,
// `data:`, `blob:`, …) is not a file reference. Per RFC 3986 a scheme is
// ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) followed by ":", so `./a:b.png`
// (starts with `.`) and `/x:y` (starts with `/`) are still paths.
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function isPassthroughUrl(s) {
  return SCHEME_RE.test(s) || s.startsWith('//') || s.startsWith('#');
}

function mimeFromExt(ext) {
  return MIME[ext] ?? 'application/octet-stream';
}

function escAttrValue(s) {
  return s.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

// A page renders to `<dir>/index.html`; a link to it should point at the
// directory (clean URL) rather than the literal index.html file. Override
// pages (outputPath naming a real file like feed.xml) are linked as-is.
function isLinkTarget(entry) {
  return (
    entry.targetPageOut !== undefined || entry.targetVerbatimOut !== undefined
  );
}

function cleanPageUrl(rel) {
  if (rel === 'index.html') return './';
  if (rel.endsWith('/index.html')) {
    return rel.slice(0, -'index.html'.length);
  }
  return rel;
}

// Index files a directory reference (`href="foo/"`, `href="foo"`) may stand
// for: a page source (any of these) or a verbatim-copied `index.html`.
const PAGE_INDEX_NAMES = ['index.html', 'index.md', 'index.mdx'];

// Resolve a link's source path to a page or verbatim output path. A direct
// hit wins; otherwise the path is treated as a directory and its index file
// is looked up, so `foo/` links to `foo/index.md` (a page) or to a verbatim
// `foo/index.html` the same way `foo/index.html` would.
function findLinkTarget(absSrc, pageOutBySrc, verbatimOutBySrc) {
  if (pageOutBySrc.has(absSrc)) {
    return { targetPageOut: pageOutBySrc.get(absSrc) };
  }
  if (verbatimOutBySrc.has(absSrc)) {
    return { targetVerbatimOut: verbatimOutBySrc.get(absSrc) };
  }
  for (const name of PAGE_INDEX_NAMES) {
    const candidate = path.posix.join(absSrc, name);
    if (pageOutBySrc.has(candidate)) {
      return { targetPageOut: pageOutBySrc.get(candidate) };
    }
  }
  const verbatimIndex = path.posix.join(absSrc, 'index.html');
  if (verbatimOutBySrc.has(verbatimIndex)) {
    return { targetVerbatimOut: verbatimOutBySrc.get(verbatimIndex) };
  }
  return {};
}

export function createPlainAssetRegistry({
  fs,
  topDir,
  // Root of the page tree. Co-located placement mirrors an asset's position
  // *relative to inputDir* into outputDir (the same mapping pages and verbatim
  // copies use), so `pages/foo/big.png` lands next to `foo/index.html`. Path
  // *resolution* (a leading `/`) is still rooted at topDir. Defaults to topDir
  // for registry-only unit tests, where the two coincide.
  inputDir = topDir,
  outputDir,
  assetRegistry,
  defaultInlineThreshold = 4096,
  writer,
  // Build-wide error collector (see errors.js); strict by default. In
  // keep-going mode a source whose read/rewrite/placement fails is marked
  // `failed` and its tokens are left in the page HTML for index.js to notice.
  errors = createErrorCollector(),
}) {
  // The build's shared output writer (skip-if-unchanged writes + prune
  // bookkeeping); registry-only unit tests get a private one.
  writer = writer ?? createOutputWriter({ fs, outputDir });
  const calls = [];
  const colocatedWrites = new Map();
  // absSrc → rewritten CSS text, populated during processAll for any `.css`
  // entry. Kept around so the font-cascade engine (commit 3) can call
  // cssForPage(html) and learn which stylesheets reach each page.
  const resolvedCss = new Map();

  function displayPath(absPath) {
    const rel = path.posix.relative(topDir, absPath);
    return rel && !rel.startsWith('..') ? rel : absPath;
  }

  function resolveSrc(importerAbsPath, src) {
    if (src.startsWith('/')) return path.posix.join(topDir, src);
    return path.posix.resolve(path.posix.dirname(importerAbsPath), src);
  }

  function forImporter(importerAbsPath) {
    return function asset(value, opts = {}) {
      if (typeof value !== 'string') return value;
      if (value === '') return value;
      if (isPassthroughUrl(value)) return value;
      // Already an xtatic placeholder/token — e.g. a manual `asset()` call whose
      // result lands in a now-whitelisted attribute like <a href={asset(...)}>,
      // which recma-assets would otherwise wrap a second time. Idempotent.
      if (ANY_XTATIC_TOKEN_RE.test(value)) return value;
      // Split off a trailing ?query / #fragment so the path portion resolves
      // and the suffix re-attaches to the rewritten URL (e.g. an <a href> to
      // "./about.md#install" or an "./icon.svg#glyph" sprite reference).
      const suffixMatch = value.match(/[?#].*$/s);
      const suffix = suffixMatch ? suffixMatch[0] : '';
      const pathPart = suffix ? value.slice(0, -suffix.length) : value;
      if (pathPart === '') return value;
      const placement = opts.placement;
      if (placement !== undefined && !VALID_PLACEMENTS.has(placement)) {
        throw new Error(
          `asset("${value}"): invalid placement "${placement}" (use "inline", "shared", "co-located", or "auto"; in "${displayPath(importerAbsPath)}").`,
        );
      }
      const absSrc = resolveSrc(importerAbsPath, pathPart);
      const token = makeToken();
      // recma-assets passes the `<img>`/`<link>`/… call site (tag + file:line:col)
      // for whitelisted attrs; the `__xtatic_asset` call itself isn't wrapped in a
      // withFrame, so synthesize that frame on top of the live stack snapshot.
      const context = currentStack();
      if (opts.locFile) {
        context.push({
          kind: 'component',
          name: opts.tag ?? null,
          atFile: opts.locFile,
          atLine: opts.locLine ?? null,
          atColumn: opts.locColumn ?? null,
        });
      }
      calls.push({
        token,
        importerAbsPath,
        absSrc,
        srcDisplay: value,
        suffix,
        placement,
        kind: opts.kind ?? null,
        context,
      });
      return token;
    };
  }

  // Where a co-located copy of `absSrc` would land, or null when the source
  // lives outside inputDir (nothing to mirror — e.g. `/assets/logo.png` beside
  // `pages/`), in which case the auto chooser falls back to shared.
  function colocatedOutPath(absSrc) {
    const rel = path.posix.relative(inputDir, absSrc);
    if (rel === '' || rel.startsWith('..')) return null;
    return path.posix.join(outputDir, rel);
  }

  function isAssetUnderPage(assetAbsSrc, pageOutPath) {
    const assetOutAbs = colocatedOutPath(assetAbsSrc);
    if (assetOutAbs === null) return false;
    const assetOutDir = path.posix.dirname(assetOutAbs);
    const pageOutDir = path.posix.dirname(pageOutPath);
    if (assetOutDir === pageOutDir) return true;
    return assetOutDir.startsWith(`${pageOutDir}/`);
  }

  // `verbatimOutBySrc` maps a verbatim-copied source file (see verbatim.js)
  // to its output path; a reference to one resolves to that file's URL. The
  // literal filename is kept, except that an `index.html` target gets the
  // same directory-URL cleanup as a page (`legacy/index.html` → `legacy/`),
  // so `href="legacy/"` and `href="legacy/index.html"` come out identical.
  async function processAll(pages, { verbatimOutBySrc = new Map() } = {}) {
    if (calls.length === 0) {
      return function substitute(html) {
        return html;
      };
    }

    const tokenToPage = new Map();
    // Source-file → output-path for every page in the build, so an <a href> /
    // <area href> pointing at another page's source (e.g. "./about.md") can be
    // rewritten to that page's rendered location rather than copied as a file.
    const pageOutBySrc = new Map();
    for (const page of pages) {
      if (page.srcPath) pageOutBySrc.set(page.srcPath, page.outPath);
      // A page that failed to render (keep-going mode) still claims its output
      // path above, so links to it resolve to a URL rather than copying its
      // source as a file — but it has no HTML to scan.
      if (page.html == null) continue;
      const found = page.html.match(TOKEN_RE);
      if (!found) continue;
      for (const t of found) tokenToPage.set(t, page.outPath);
    }

    const bySrc = new Map();
    for (const call of calls) {
      if (!tokenToPage.has(call.token)) continue;
      const pageOutPath = tokenToPage.get(call.token);
      let entry = bySrc.get(call.absSrc);
      if (!entry) {
        entry = {
          absSrc: call.absSrc,
          calls: [],
          pages: new Set(),
          explicitPlacement: undefined,
          ext: (EXT_RE.exec(call.absSrc)?.[1] ?? 'bin').toLowerCase(),
          ...findLinkTarget(call.absSrc, pageOutBySrc, verbatimOutBySrc),
        };
        bySrc.set(call.absSrc, entry);
      }
      entry.calls.push({ ...call, pageOutPath });
      entry.pages.add(pageOutPath);
      // A link to a page or a verbatim file resolves to that target's URL, not
      // a copied asset — placement is meaningless, so skip the bookkeeping.
      if (!isLinkTarget(entry) && call.placement && call.placement !== 'auto') {
        if (
          entry.explicitPlacement &&
          entry.explicitPlacement !== call.placement
        ) {
          entry.failed = true;
          errors.report(
            attachContext(
              new Error(
                `Conflicting placement for "${call.srcDisplay}": got "${entry.explicitPlacement}" and "${call.placement}" (in "${displayPath(call.importerAbsPath)}").`,
              ),
              call.context,
            ),
          );
        }
        entry.explicitPlacement = call.placement;
      }
    }

    await Promise.all(
      [...bySrc.values()]
        .filter((entry) => !isLinkTarget(entry) && !entry.failed)
        .map(async (entry) => {
        try {
          try {
            entry.bytes = await fs.promises.readFile(entry.absSrc);
          } catch (e) {
            const importer = displayPath(entry.calls[0].importerAbsPath);
            if (e.code === 'ENOENT') {
              throw new Error(
                `Asset not found at ${entry.absSrc} (referenced from "${importer}").`,
              );
            }
            if (e.code === 'EISDIR') {
              throw new Error(
                `"${entry.calls[0].srcDisplay}" is a directory with no index page (${entry.absSrc}, referenced from "${importer}"). Link to a page or file inside it, or add an index.html/index.md there.`,
              );
            }
            throw e;
          }
          if (entry.ext === 'css') {
            const rewritten = await rewriteCssUrls({
              css: entry.bytes.toString('utf8'),
              sourceAbsPath: entry.absSrc,
              fs,
              topDir,
              assetRegistry,
              notFoundMessage: (url, absRef) =>
                `Asset url("${url}") not found at ${absRef} (referenced from "${displayPath(entry.absSrc)}").`,
            });
            entry.bytes = Buffer.from(rewritten, 'utf8');
            resolvedCss.set(entry.absSrc, rewritten);
          }
        } catch (e) {
          entry.failed = true;
          errors.report(attachContext(e, entry.calls[0]?.context));
        }
      }),
    );

    function decidePlacement(entry) {
      if (entry.explicitPlacement) {
        if (entry.explicitPlacement === 'co-located') {
          for (const pageOutPath of entry.pages) {
            if (isAssetUnderPage(entry.absSrc, pageOutPath)) return 'co-located';
          }
          throw attachContext(
            new Error(
              `Cannot co-locate "${displayPath(entry.absSrc)}": its source is not at-or-below any consuming page's output directory.`,
            ),
            entry.calls[0]?.context,
          );
        }
        return entry.explicitPlacement;
      }
      if (entry.bytes.length <= defaultInlineThreshold) return 'inline';
      if (entry.pages.size === 1) {
        const [pageOutPath] = entry.pages;
        if (isAssetUnderPage(entry.absSrc, pageOutPath)) return 'co-located';
      }
      return 'shared';
    }

    const tokenToResolver = new Map();
    const stylesheetInlineTokens = new Map();

    for (const entry of bySrc.values()) {
      // Link to another page (or a verbatim file): resolve to the target's
      // output URL, relative to the linking page's own directory.
      if (isLinkTarget(entry)) {
        const targetOut = entry.targetPageOut ?? entry.targetVerbatimOut;
        for (const call of entry.calls) {
          tokenToResolver.set(call.token, (outPath) => {
            const rel = path.posix.relative(
              path.posix.dirname(outPath),
              targetOut,
            );
            return cleanPageUrl(rel) + call.suffix;
          });
        }
        continue;
      }
      if (entry.failed) continue; // keep-going: tokens stay unresolved
      let placement;
      try {
        placement = decidePlacement(entry);
        if (placement === 'co-located') {
          const assetOutAbs = colocatedOutPath(entry.absSrc);
          const existing = colocatedWrites.get(assetOutAbs);
          if (existing && !existing.equals(entry.bytes)) {
            throw attachContext(
              new Error(
                `Co-located output collision at ${assetOutAbs}: different bytes.`,
              ),
              entry.calls[0]?.context,
            );
          }
        }
      } catch (e) {
        errors.report(e);
        continue;
      }
      switch (placement) {
        case 'inline': {
          const url = `data:${mimeFromExt(entry.ext)};base64,${entry.bytes.toString('base64')}`;
          const cssText =
            entry.ext === 'css' ? entry.bytes.toString('utf8') : null;
          for (const call of entry.calls) {
            if (cssText != null && call.kind === 'stylesheet') {
              stylesheetInlineTokens.set(call.token, cssText);
            } else {
              tokenToResolver.set(call.token, () => url + call.suffix);
            }
          }
          break;
        }
        case 'shared': {
          const url = assetRegistry.emit(entry.bytes, entry.ext);
          for (const call of entry.calls) {
            tokenToResolver.set(call.token, () => url + call.suffix);
          }
          break;
        }
        case 'co-located': {
          const assetOutAbs = colocatedOutPath(entry.absSrc);
          colocatedWrites.set(assetOutAbs, entry.bytes);
          for (const call of entry.calls) {
            tokenToResolver.set(call.token, (outPath) => {
              const pageOutDir = path.posix.dirname(outPath);
              return path.posix.relative(pageOutDir, assetOutAbs) + call.suffix;
            });
          }
          break;
        }
      }
    }

    return function substitute(html, outPath) {
      if (tokenToResolver.size === 0 && stylesheetInlineTokens.size === 0) {
        return html;
      }
      let out = html;
      for (const [token, css] of stylesheetInlineTokens) {
        const re = new RegExp(
          `<link\\b([^>]*\\bhref="${token}"[^>]*)>`,
          'g',
        );
        out = out.replace(re, (_, attrs) => {
          const cleaned = attrs
            .replace(/\s+rel\s*=\s*"[^"]*"/i, '')
            .replace(/\s+href\s*=\s*"[^"]*"/i, '')
            .replace(/\s*\/$/, '')
            .trim();
          const sep = cleaned ? ' ' : '';
          return `<style${sep}${cleaned}>${css}</style>`;
        });
      }
      if (tokenToResolver.size === 0) return out;
      return out.replace(TOKEN_RE, (m) => {
        const resolver = tokenToResolver.get(m);
        if (!resolver) return m;
        return escAttrValue(resolver(outPath));
      });
    };
  }

  async function writeAll() {
    if (colocatedWrites.size === 0) return;
    for (const [absPath, bytes] of colocatedWrites) {
      // A co-located .css can carry emit placeholders for url()-referenced
      // assets that went to _assets/; rewrite them relative to this file's dir.
      const dir = path.posix.dirname(absPath);
      const ext = (EXT_RE.exec(absPath)?.[1] ?? '').toLowerCase();
      const out =
        ext === 'css'
          ? Buffer.from(
              assetRegistry.relativize(bytes.toString('utf8'), dir),
              'utf8',
            )
          : bytes;
      await writer.writeFile(absPath, out);
    }
  }

  // Returns the resolved CSS text of every stylesheet-kind asset token that
  // appears in `html`, deduped by source. Must be called after processAll();
  // counterpart to styleRegistry.cssForPage. Non-stylesheet `.css` refs (e.g.
  // <link rel=preload as=style>) are excluded — they're emitted as data:/asset
  // URLs and the browser only fetches them if the cascade calls for it, but
  // for static analysis of which CSS *rules* reach a page they don't apply.
  function cssForPage(html) {
    const tokens = html.match(TOKEN_RE);
    if (!tokens) return [];
    const tokenSet = new Set(tokens);
    const srcs = new Set();
    for (const call of calls) {
      if (call.kind !== 'stylesheet') continue;
      if (tokenSet.has(call.token)) srcs.add(call.absSrc);
    }
    const out = [];
    for (const src of srcs) {
      const css = resolvedCss.get(src);
      if (css != null) out.push(css);
    }
    return out;
  }

  return { forImporter, processAll, cssForPage, writeAll };
}
