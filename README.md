# xtatic

A small static-site generator: MDX in, plain HTML out. The MDX is compiled and executed at build time, so the output is just HTML — no client-side runtime, no hydration.

## Install & run

```sh
npm install --save-dev xtatic
npx xtatic build [TOP_DIR]
```

`TOP_DIR` defaults to the current directory. By default, xtatic walks `TOP_DIR/pages/**/*.{md,mdx}` and writes to `TOP_DIR/site/`.

The first positional argument is a command. The available commands are:

- `init [top_dir]` — scaffold or update `top_dir/package.json`: add `xtatic` to `devDependencies` (when not already declared as a regular or dev dependency) and enable [`xtatic.autoInstall`](#auto-installing-optional-peer-deps). Creates a minimal `package.json` if none exists. Idempotent.
- `build [top_dir]` — build the site (the default if no command is given).
- `watch [top_dir]` — build, then rebuild on every change under `top_dir`. Errors don't kill the watcher; fix the file and save again.
- `serve [top_dir]` — watch and serve the output over HTTP. Defaults to <http://localhost:3000/>; override the port with `XTATIC_PORT=…`. Each request is logged to the console; set `XTATIC_REQUEST_LOG=off` to silence it, or `=all` to also log the requests that hit the build-error page while a build is broken.
- `browse [top_dir]` — same as `serve`, then open the root page in your default browser.
- `help` — print usage.

If you invoke `xtatic` with no arguments, it runs `build` against the current directory. To build a different directory, pass it as the second argument: `xtatic build path/to/site`.

### Keep going after errors

By default a build stops at the first error and writes nothing (the previous output is left untouched). Pass `-k` / `--keep-going` to `build`, `watch`, `serve`, or `browse` to do the opposite: build everything that *can* be built, then report every error at once.

```sh
npx xtatic build --keep-going
```

What changes under `--keep-going`:

- Every page that fails — to compile, to load an import, to resolve its layout, to render, or because an asset it references is missing or broken — is left out of the output. Everything else is written and stale files are pruned as usual, so the output reflects this build minus the broken pages (a page that used to work and now fails is *removed*, not left stale).
- All errors are collected and printed together, numbered, each with its usual context trace, followed by the list of pages that weren't written. One underlying error is reported once even when it affects many pages: a broken layout imported by fifty pages is listed once, with all fifty in the not-written list.
- A [lint](#lint) failure doesn't stop the build either. Both reports are printed, the lint one first.
- The exit status is still `1` whenever anything failed.

In `watch`/`serve` mode the same applies to every rebuild; the dev server's error page shows the combined report while any error remains. Programmatically, `build({ keepGoing: true })` rejects with an `AggregateError` whose `errors` holds the individual errors and whose `skippedPages` lists the pages left out.

To override the input or output location, add an `xtatic` section to `TOP_DIR/package.json`:

```json
{
  "xtatic": {
    "inputDir": "src/pages",
    "outputDir": "dist",
    "layoutsDir": "src/layouts",
    "assetsDir": "_assets"
  }
}
```

Relative paths in config are resolved against `TOP_DIR`, not the working directory; absolute paths are used as-is.

`OUTPUT_DIR` is fully owned by xtatic: every build regenerates the whole site, and anything under it that the build didn't produce is deleted at the end of the run — so renames and deletions can't leave stale files behind. Don't point it at a directory that holds anything you want to keep, and don't hand-edit files inside it. As a guard against catastrophic misconfiguration, xtatic refuses to build if `outputDir` is `/`, equal to a source directory, or an ancestor of `topDir`/`inputDir`/`layoutsDir`.

Within that, writes are conservative: an output file whose content is unchanged from the previous build is skipped, preserving its timestamp — friendly to `rsync`-style deploys, HTTP caching, and anything else that keys off mtimes. (A build that fails partway also leaves the previous output in place rather than half-erasing it — unless you asked it to [keep going](#keep-going-after-errors), in which case whatever could be built is written and the rest pruned.)

Shared, content-addressed assets (the hashed images, stylesheets, and fonts that aren't inlined or co-located) are written under `OUTPUT_DIR/_assets/`. Rename that directory with `xtatic.assetsDir` — it must be a single path segment (no `/`, `.`, or `..`). Because the build owns this directory, **a page may not write into it**: if a page's output path (whether the default `dir/index.html` or an `outputPath` override) lands inside the assets directory, the build fails with an error. Renaming `assetsDir` frees the original name for use as a page.

## How input maps to output

`xtatic` walks `INPUT_DIR/**/*.{md,mdx,html}`. Each file becomes `OUTPUT_DIR/<path>/index.html` (for `.html` inputs, see [HTML pages](#html-pages)). The four forms below are **equivalent and mutually exclusive** — putting two of them in the same input tree is an error:

| Input                                | Output                            |
| ------------------------------------ | --------------------------------- |
| `INPUT_DIR/foo/bar.md`               | `OUTPUT_DIR/foo/bar/index.html`   |
| `INPUT_DIR/foo/bar.mdx`              | same                              |
| `INPUT_DIR/foo/bar/index.md`         | same                              |
| `INPUT_DIR/foo/bar/index.mdx`        | same                              |

`INPUT_DIR/index.md` (or `.mdx`) is the root and writes to `OUTPUT_DIR/index.html`.

A directory doesn't need an `index.md` of its own. A position in the tree that has pages beneath it but no source file (including the root) becomes a *grouping node*: it appears in its parent's `childPages` with the usual name-derived `title`/`date` defaults so listings can still show it, and `defaultLayout` inheritance passes through it — but no output file is written there, and since there's no page to link to, its `url` is `undefined` (check for it, or link to a child instead).

A page can override its destination by exporting `outputPath` (frontmatter or a named `export`) — useful for `/feed.xml`, `/sitemap.xml`, `/robots.txt`, etc.:

```mdx
---
outputPath: /feed.xml
layout: null
---
import {html} from 'xtatic:builtins';

{html('<?xml version="1.0"?>')}
<rss version="2.0">
  <channel>
    {childPages.map((p) => <item><title>{p.title}</title></item>)}
  </channel>
</rss>
```

The value must be an absolute path (starting with `/`) naming a file. `name`, `childPages`, `date`, and `title` still derive from the source file's tree position — only the written file's location changes. Layouts still apply; set `layout: null` (or just have no `defaultLayout` in scope) to opt out of HTML wrapping, as RSS/XML output usually wants.

## Generating multiple pages from one file

One source file can fan out into many pages — a tag page per tag, a post page per row of data, etc. Two things make a file a **page generator**:

1. Its filename contains one or more `{placeholder}` tokens, e.g. `tag-{tag}.md`.
2. It exports a **function** named `getPages` that returns an array. Each item is a plain object that becomes **the exports of one generated page**.

`getPages()` runs *after* xtatic has assembled the ordinary pages into a tree, so it can import another page and read its tree-derived fields — most usefully a parent's `childPages`. That's how you build a tag index: import the section page, walk its children, and group them by tag.

```mdx
<!-- INPUT_DIR/tag-{tag}.md -->
import blog from '/pages/blog/index.md';

export const getPages = () => {
  const byTag = new Map();
  for (const post of blog.childPages)
    for (const t of post.tags ?? []) {
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t).push(post);
    }
  return [...byTag].map(([tag, posts]) => ({ tag, posts }));
};

# Posts tagged "{tag}"

<ul>{posts.map((p) => <li><a href={p.url}>{p.title}</a></li>)}</ul>
```

If `blog/` holds posts tagged `rust` and `js`, this emits `OUTPUT_DIR/tag-rust/index.html` and `OUTPUT_DIR/tag-js/index.html`. For each item, the value of each filename placeholder is taken from the matching field (`{tag}` ← `item.tag`), and **every field is an export of that generated page** — readable as a bare identifier in the body (`{tag}`, `{posts}`) exactly like frontmatter, and visible from outside as `page.tag` / via `{...page}`. The generator file itself does **not** render at its own slot; it only produces the items.

`blog.childPages` are the post modules themselves, so each carries `tags` (from its frontmatter), `title`, `date`, and a working `url`. `childPages` is direct children only, already sorted by name. (`getPages` doesn't have to use `childPages` — return any array of objects you like, e.g. one page per row of imported data.)

The generated pages are ordinary tree nodes: they appear in their parent's `childPages`, each has a working `url`, and `name`/`date`/`title` default from the substituted filename (so `2026-01-02-{slug}.md` yields a `date`, and `tag-rust` titles as "Tag Rust"). A field on the item overrides those defaults — an item of `{ tag: 'js', title: 'JavaScript posts' }` would override the name-derived title. So a separate listing page can link them the usual way:

```mdx
<ul>{childPages.map((c) => <li><a href={c.url}>{c.tag}</a></li>)}</ul>
```

Other details:

- **`outputPath` works per item**, redirecting just that page's written file (`{ slug: 'feed', outputPath: '/feed.xml' }`).
- **The generator's own exports are inherited as defaults** by each generated page (so a shared `layout`, `defaultLayout`, or helper export carries through). A template-level const is shared by every page and can be read in the body; per-page values go in the items.
- **A page field can't share a name with a template export** — it's an error (rename one). This avoids an item silently shadowing the file's own `export const`, which the body wouldn't even reflect (a declared const binds lexically, so `{author}` always renders the template's value). The name-derived `title`/`date` defaults aren't template exports, so an item setting `title`/`date` is fine.

Rules and limits: a `{placeholder}`-named file must export a `getPages` function (and vice-versa — exporting `getPages` from a file with no placeholder is an error, since there'd be nothing to distinguish the pages). `getPages` must return an array of objects; placeholder values must be path-safe strings, every placeholder must be filled, and two items must not resolve to the same path (nor collide with a real file). Generated pages can't themselves be generators, so a generator only ever sees the ordinary pages — you can't build tag pages out of other tag pages. In this version, placeholders may appear only in the **filename** (not directory segments), and values are used verbatim (no slugifying).

## Pages

Markdown is rendered normally. JSX inside MDX is evaluated against xtatic's JSX runtime, which produces HTML strings directly — no React, no virtual DOM.

[`remark-smartypants`](https://github.com/silvenon/remark-smartypants) is enabled by default, so straight quotes/apostrophes/dashes/ellipses in prose become typographic ones. To disable it, set `xtatic.smartypants` to `false` in `package.json`; to override its options, set it to an options object (passed through to the plugin):

```json
{
  "xtatic": {
    "smartypants": { "dashes": false }
  }
}
```

Frontmatter and named exports become metadata on the compiled module:

```mdx
---
title: About
---
export const tags = ['general'];

# About me
```

After compilation, this module exposes `mm.title === 'About'`, `mm.tags === ['general']`, and a default render function.

Inside JSX expressions, a module's own properties are also accessible as bare identifiers — handy for templating against frontmatter and the synthesized `childPages` / `layout`:

```mdx
---
title: Index
---
# {title}

<ul>{childPages.map((c) => <li>{c.title}</li>)}</ul>
```

Identifiers shadowed by parameters or local declarations resolve normally; it's only otherwise-unbound identifiers that fall through to the module object.

## HTML pages

A `.html` file in the input tree is a page too — handy for dropping in hand-written or legacy pages. It maps to the same output location a `.md` at that path would (`foo/bar.html` → `foo/bar/index.html`), participates in the module tree (`name`, `title`, `date`, `childPages`, `url`), and its [asset references](#asset-references) go through the same pipeline as tags rendered from markdown: `<img src>`, `<link rel="stylesheet" href>`, `<script src>`, `<a href="./other.md">` page links, `data-xtatic-placement`, and the rest of the whitelist all behave identically. Path resolution is the same, too — a leading `/` roots at `TOP_DIR`, everything else resolves against the `.html` file's own directory.

Inline CSS is covered as well: a `url(...)` inside a `<style>` block or a `style=""` attribute is resolved and copied/inlined like any other reference (`body { background: url(bg.gif) }` becomes a `data:` URL, a hashed `_assets/` file, or a link to a [verbatim](#verbatim-directories) copy, by the usual rules). A `data-xtatic-placement` on the `<style>` element or the styled element applies to every `url()` it contains. The bare-string `@import "x.css"` form is not rewritten — use `@import url(...)`.

Everything *outside* the rewritten references ships byte-for-byte: comments, doctype, whitespace, and formatting are preserved (a rewritten attribute is re-emitted double-quoted; a rewritten `url()` is re-emitted as `url("…")`).

Differences from `.md`/`.mdx`:

- **No compilation.** The file isn't MDX — no JSX, no frontmatter, no imports, no exports (so no `outputPath` override, and a `{placeholder}` filename can't be a page generator).
- **No layout.** The file is taken to be a complete document, so the `defaultLayout` walk skips it and `layout:` can't be set on it.
- **`title` defaults from `<title>`.** A non-empty `<title>` in the document becomes the page's `title` (visible to a parent iterating `childPages`); otherwise the usual filename-derived default applies. `date` still comes from a `YYYY-MM-DD` filename prefix.

Other pages can link to it by source path (`<a href="./legacy.html">` → `legacy/`) or import it (`import legacy from './legacy.html'`) to read its `url`/`title` — the default import binds the module object, like `.md`.

## Verbatim directories

Drop an empty file named `.xtatic-verbatim` into any directory under `INPUT_DIR` and everything beneath it is copied to the output **as-is**, mirroring its source-tree position: `pages/legacy/foo/bar.html` lands at `OUTPUT_DIR/legacy/foo/bar.html`, byte-for-byte. Nothing in the subtree is parsed or rewritten — no `foo/index.html` remapping, no layout, no HTML/markdown compilation, no asset hashing or inlining, no link rewriting. This is for pre-rendered content (an old site, a generated API reference, a feed directory) that you want to keep in the one input tree without xtatic touching it.

```
pages/
  index.md
  legacy/
    .xtatic-verbatim      ← marker; not copied
    index.html            → OUTPUT_DIR/legacy/index.html
    feed.xml              → OUTPUT_DIR/legacy/feed.xml
    docs/intro.html       → OUTPUT_DIR/legacy/docs/intro.html
```

Rules:

- **Not pages.** Verbatim files don't join the [module tree](#the-module-tree) (no `childPages` entry, `title`, `date`, or `url`), and the directory produces no node of its own. A `.md`/`.html` under the marker is just a file. `{placeholder}` filenames are literal, not generators.
- **Link to them by source path**, like pages: `<a href="./legacy/feed.xml">`, `<img src="/pages/legacy/logo.png">`, `<link rel="stylesheet" href="./legacy/site.css">` — any [whitelisted attribute](#asset-references) whose target resolves into a verbatim directory becomes a page-relative URL to the copied file. The literal filename is kept, except that an `index.html` is linked as its directory (`legacy/index.html` → `legacy/`, exactly like a page), and `<a href="./legacy/">` resolves to that same `index.html`. The file isn't copied a second time into `_assets/`. Links *inside* verbatim files are not rewritten, so they must already be correct for the output layout — which they are for relative links within the subtree, since positions are mirrored.
- **Collisions are errors.** A verbatim file and a page resolving to the same output path (`pages/about.md` alongside a verbatim `pages/about/index.html`) fails the build, as does a verbatim file landing under the [assets directory](#install--run).
- **Lint skips the subtree** (or, for a [pattern marker](#verbatim-files-by-pattern), the matched files), so pre-generated `.js`/`.md` in there won't be linted as sources.
- **Explicit processing still works.** `import`, `readfile`, and `<Image>` treat a file in a verbatim directory like any other source file; the marker only governs what the walker does with the file on its own.
- Nested markers are harmless. An empty marker at the `INPUT_DIR` root makes the whole tree verbatim and fails with "No page sources found".

Output is written through the same incremental writer as everything else: unchanged files keep their timestamps and files removed from the source (or a whole directory whose marker is removed) are pruned from the output.

### Verbatim files by pattern

A marker that isn't empty lists **patterns**, one per line, and only what they match is verbatim — the rest of the directory is walked for pages as usual. This is how you keep a `favicon.ico`, `robots.txt`, or a background image at its literal root-level path next to your pages:

```
pages/
  .xtatic-verbatim      ← contains:  favicon.ico
                                     robots.txt
                                     *.gif
                                     legacy/
  index.html            → page, as usual (OUTPUT_DIR/index.html)
  favicon.ico           → OUTPUT_DIR/favicon.ico
  robots.txt            → OUTPUT_DIR/robots.txt
  bg.gif                → OUTPUT_DIR/bg.gif
  about/hero.gif        → OUTPUT_DIR/about/hero.gif
  legacy/…              → whole subtree copied as-is
```

Pattern syntax is a gitignore subset:

- Blank lines and `#` comments are ignored. A marker containing only those is an empty marker (everything verbatim).
- `*` matches within one path segment, `?` one character, `**` any number of segments.
- A pattern with no `/` matches a **basename at any depth** below the marker's directory (`*.gif` catches `about/hero.gif` too). A pattern containing a `/` is **anchored** to the marker's directory (`/robots.txt` or `docs/**/*.pdf`); a leading `/` is optional.
- A trailing `/` matches directories only. A matched directory is copied whole, exactly as if it had an empty marker of its own.
- A pattern marker's rules apply to every subdirectory beneath it; a subdirectory may add its own marker (patterns accumulate; an empty one makes that subtree fully verbatim).
- No negation (`!`).

A matched `.md`/`.mdx`/`.html` is copied as a file, not built as a page. Everything else about verbatim files — no tree entry, [link resolution](#linking-between-pages) by source path, collision checks, lint skipping — is the same whether they were matched by pattern or by an empty marker. Note that a page's own reference to a matched file (`<link rel="icon" href="favicon.ico">`, `url(bg.gif)` in an inline `<style>`) links to the literal copy rather than emitting a hashed `_assets/` file.

## Layouts

A layout wraps another module's content. It's just an MDX module whose `default` render function reads the wrapped module from `props.children`:

```mdx
<!-- LAYOUTS_DIR/main.mdx -->
<html>
  <head><title>{props.children.title}</title></head>
  <body>{props.children}</body>
</html>
```

A module gets a layout in one of two ways:

1. **Explicit**: set `layout: <name>` in frontmatter (or as a named export). The string is treated as a path relative to `LAYOUTS_DIR` (default: `TOP_DIR/layouts`, configurable via `xtatic.layoutsDir` in `package.json`). The `.md`/`.mdx` suffix is optional; with no suffix `.mdx` is preferred. Subpaths work: `layout: posts/article`.
2. **Inherited via `defaultLayout`**: if `layout` isn't set, xtatic walks from the module up to the root looking for a `defaultLayout`, and uses the first one it finds. The walk starts at the module itself, so a module's own `defaultLayout` applies to it. Set `defaultLayout` on the root to give every page a default; set it on a subdirectory's `index.md` to override for that subtree.

Layouts loaded by name can themselves declare `layout:` (or `defaultLayout:`) for nesting. You can also set `layout` directly to a module object via `import`, bypassing the layoutsDir lookup.

## The module tree

After compilation, every page is a module object exposing:

- `default(props)` — render function returning `{html: string}`
- `childPages` — `Array` of child modules sorted by `name`
- `layout` — the page's layout module (inherited or explicitly set; may be `undefined`)
- `name` — the module's last path segment (set on every module that's a child of another; the root has no `name`)
- `parent` — the module this one is a child of (`undefined` on the root)
- `prevSibling` / `nextSibling` — the neighbours in the parent's `childPages` (same `name` order), or `undefined` at either end
- `url` — a link to this page's rendered output. The natural way to link a `childPages` entry: `<a href={p.url}>`. It resolves to a clean directory URL relative to whatever page the link lands on, with `outputPath` overrides honored (`feed.xml` rather than `feed/`). Because it's the same kind of deferred token [`asset`](#builtins) returns, it works wherever it lands — a whitelisted attribute, a custom component prop, even bare text. Tool-owned: exporting your own `url` is overridden.
- frontmatter keys + any named exports

A directory without its own `index.md` shows up in this tree as a grouping node (see [How input maps to output](#how-input-maps-to-output)): it has `childPages`, `name`, and the name-derived `title`/`date` defaults, but no `default` render function and no `url`.

`childPages` is a plain JavaScript array, so `mm.childPages.map(...)`, `.find(...)`, `.length`, and `for (const child of mm.childPages) { ... }` all work directly. Linking the children is just:

```mdx
<ul>
  {childPages.map((p) => <li><a href={p.url}>{p.title}</a></li>)}
</ul>
```

`parent`, `prevSibling`, and `nextSibling` point the other way — up and sideways — so a layout can navigate from the page it wraps without importing anything. Blog posts named `YYYY-MM-DD-slug.md` sort chronologically, which makes previous/next links a couple of lines in the post layout:

```mdx
{props.children}
<nav>
  {props.children.prevSibling && <a rel="prev" href={props.children.prevSibling.url}>← {props.children.prevSibling.title}</a>}
  {props.children.nextSibling && <a rel="next" href={props.children.nextSibling.url}>{props.children.nextSibling.title} →</a>}
</nav>
```

(Swap the two if you want "previous" to mean the newer post.) A sibling can be a grouping node with no `url` — check for it if a section mixes leaf pages and subdirectories. Like `childPages` and `name`, these three are tool-owned: an export of the same name is overridden.

## Custom components

Any module can be used as a JSX tag. The runtime calls its `default(props)` and inlines the result.

## Imports

An MDX file can import other `.md`, `.mdx`, `.js`, and `.html` files. Specs use file paths *with* extensions, either relative to the importing file or absolute-from-`TOP_DIR` (leading `/`):

```mdx
import About from './about.mdx';
import { greet } from './lib/util.js';
import Card from '/components/card.mdx';
```

Absolute imports are rooted at `TOP_DIR`, not `INPUT_DIR`, so shared components and helpers can live alongside (rather than inside) the pages tree.

**Default import asymmetry.** `import X from spec`:

- For `.md`/`.mdx` (and `.html` pages), `X` is the *whole module object* (same shape as a `childPages` entry). Use `X` as a JSX tag, read frontmatter as `X.title`, etc.
- For `.js`, `X` is the module's ESM `default` export — standard JS semantics.

Named (`import { a, b } from ...`) and namespace (`import * as X from ...`) imports work for both, with the obvious meaning.

**Cycles are allowed.** Two `.mdx` files can import each other. During compile, an importer may briefly see a partially-initialized module — but by the time anything renders, every module on the cycle is fully populated, so component references resolve correctly.

**`.js` files are evaluated by Node's normal `import()`**, so they can use npm packages, Node built-ins, and relative `.js` imports of their own. They cannot import `.md`/`.mdx` (Node doesn't know how to load those). In `watch`/`serve`, editing an imported `.js` triggers a rebuild that picks up the change. (A `.js` that itself imports another `.js` is the one exception: edits to that nested file won't reload on their own — save the directly-imported `.js` to force it.)

Imports with bare specifiers (`import x from 'react'`), unknown extensions, or paths that escape `INPUT_DIR` are not formally supported and may fail or behave unexpectedly.

## Asset references

Plain HTML tags that point at a file get their reference auto-processed at build time. The referenced file is read, content-hashed, and either inlined as a `data:` URL, written alongside the page that uses it, or written to a shared `OUTPUT_DIR/_assets/<hash>.<ext>` — with the rendered URL rewritten to match. This works without any explicit `<Image>`/`<Style>` builtin; markdown's `![alt](src)` (which lowers to `<img>`) is covered too.

```mdx
![Sunset](./hero.jpg)
<img src="./icon.svg" alt="" />
<link rel="stylesheet" href="/css/site.css" />
<link rel="icon" href="/favicon.png" />
<script src="./main.js"></script>
<video src="./clip.mp4" poster="./clip-poster.jpg" />
```

The whitelisted (tag, attribute) pairs are:

- `img.src`, `script.src`, `source.src`, `audio.src`, `video.src`, `video.poster`
- `link.href` — only when `rel` is `stylesheet`, `icon`, `shortcut`, `apple-touch-icon`(`-precomposed`), `mask-icon`, `preload`, `prefetch`, `modulepreload`, or `manifest`. Other rels (`canonical`, `alternate`, …) are left untouched since their hrefs aren't file references.
- `a.href`, `area.href` — see [Linking between pages](#linking-between-pages) below.
- In [`.html` pages](#html-pages) only: every `url(...)` inside a `<style>` element or a `style=""` attribute. (In `.md`/`.mdx`, use [`<Style>`](#stylesheets) or a `<link rel="stylesheet">` to a `.css` file; `url()` inside a literal `<style>` block there isn't rewritten.)

Values that aren't files — anything with a URL scheme (`data:`, `http(s):`, `mailto:`, `tel:`, `javascript:`, …), `//`, `#`, and empty strings — pass through verbatim, so a `<link rel="stylesheet" href="https://…">` to a CDN is unchanged. Dynamic values like `<img src={x}>` are wrapped at runtime, so the same passthrough applies after evaluation.

Path resolution matches `<Image>`/`<Style>`/`readfile`: a leading `/` is rooted at `TOP_DIR`; everything else is relative to the importing file's directory. A trailing `?query` or `#fragment` is split off before resolving and re-attached to the rewritten URL.

### Linking between pages

`<a href>` and `<area href>` are processed the same way, but with one extra rule: **if the target resolves to another page's source file (a `.md`/`.mdx` in the build), the link is rewritten to that page's rendered output URL instead of copying the file.** This lets you link by the source path — just like `import` and `readfile` — and have it translated to the right output location automatically:

```mdx
[About](./about.md)            <!-- → <a href="about/">About</a> -->
<a href="/blog/intro.md#setup">Setup</a>
```

Because each page renders to its own `dir/index.html`, the input→output path differs: a link from `a.md` to its source sibling `./b.md` comes out as `../b/` (both pages now live one directory deep). Targets are linked to the directory (clean URL, e.g. `about/`); a page that overrides its location with `outputPath` (e.g. `/feed.xml`) is linked to that exact file. Fragments and queries are preserved (`about/#setup`).

A link to a **directory** (`./docs/`, `../`, or `/pages/docs` — the trailing slash is optional) stands for the index page inside it: `docs/index.md`, `docs/index.mdx`, or `docs/index.html`, whichever exists. So `<a href="docs/">` in `pages/index.html` comes out as `docs/`, verified at build time. A directory with no index page is an error (link to a file inside it instead).

A target inside a [verbatim directory](#verbatim-directories) is linked at its copied location, literal filename kept (an `index.html` there is shortened to its directory, and a directory link resolves to it). A relative or `/`-rooted href that points at any other **non-page** file (`./report.pdf`, `./photo.jpg`, …) falls through to the normal asset pipeline — it's content-hashed and copied/inlined like any other asset. Markdown link syntax `[text](./about.md)` (which lowers to `<a>`) is covered too. Passthrough values (any scheme like `mailto:`, `tel:`, `javascript:`, `http(s):`, plus `#anchor`, …) are left untouched.

When you already hold a page *module* rather than a path string — e.g. iterating `childPages` — link it through its [`url` property](#the-module-tree) (`<a href={p.url}>`) instead. It produces the same rewritten output URL.

**Placement chooser.** For each referenced file:

1. ≤ **4096 bytes** → inlined as a `data:` URL.
2. Used by exactly one page, *and* the source sits inside that page's output directory → co-located (copied alongside the page, mirroring its source-tree position).
3. Otherwise → shared at `OUTPUT_DIR/_assets/<hash>.<ext>`.

The inline threshold is configurable project-wide via `package.json` `xtatic.assetInlineThreshold`. Shared assets share `_assets/` with `<Image>`/`<Style>`/`<Font>` output and are content-addressed, so the same file referenced from many pages (or many tags) writes once. All rendered URLs are page-relative, so the site works served from any subpath.

Override the chooser per call with `data-xtatic-placement`:

```mdx
<img src="./tiny.png" alt="" data-xtatic-placement="shared" />
<img src="./huge.jpg" alt="" data-xtatic-placement="inline" />
```

Valid values are `"auto"` (default), `"inline"`, `"shared"`, and `"co-located"`. The attribute is stripped from the output. Requesting `co-located` for a file whose source isn't at-or-below a consuming page's output directory is a build error.

**Inlined stylesheets.** When a `<link rel="stylesheet" href="…">` resolves to an inlined `.css` file, the whole `<link>` is replaced with a `<style>` block (rather than a `data:text/css` URL), and the CSS's own `url(...)` references are rewritten through the same pass as `<Style>`. Attributes other than `rel`/`href` (`media`, `nonce`, `class`, …) carry over. A `.css` file referenced from a non-stylesheet rel (e.g. `rel="preload" as="style"`) still gets the regular `data:` treatment.

**When to reach for the explicit builtins instead.** `<img>` ships the source file as-is, so use [`<Image>`](#image) when you want sharp-driven resizing, format conversion, or dimension stamping. `<link rel="stylesheet">` rewrites `url(...)` references but doesn't get you anything else `<Style>` does — they're broadly equivalent for hand-written CSS.

## Builtins

A small set of helpers ship with xtatic. Like Node's `node:*` modules, they're exposed under an `xtatic:` scheme and must be imported explicitly:

```mdx
import {html, readfile} from 'xtatic:builtins';

{html('<!DOCTYPE html>')}

<pre>{readfile('./snippet.txt')}</pre>
```

Available named exports:

- `html(s)` — wrap a string so the JSX runtime emits it raw, without HTML-escaping. Useful for doctypes, inline SVG, or any time you've already got trusted markup.
- `readfile(spec)` — synchronously read a file as UTF-8 at build time. Specs starting with `/` resolve against `TOP_DIR`; everything else resolves against the importing file's directory. Throws a clear error if the file is missing.
- `asset(value, opts?)` — the same function the auto-processing wires onto whitelisted attributes (see [Asset references](#asset-references)). Call it directly for attributes/expressions the whitelist doesn't cover — e.g. `<a href={asset('./report.pdf')}>`. `opts.placement` (`"auto"`/`"inline"`/`"shared"`/`"co-located"`) overrides the chooser. Returns a rewritten URL (a deferred token resolved at the end of the build).

To link to another *page*, you don't need a builtin — read its [`url` property](#the-module-tree) (`<a href={p.url}>`), which goes through the same machinery.

Importing from `xtatic:builtins` works identically in `.md`, `.mdx`, and `.jsx` files. Names you don't import don't shadow anything, so you're free to define a local `html` or `readfile` of your own.

### `<Image>`

`xtatic:image` exports a build-time image component. It reads a source image, processes it with [sharp](https://sharp.pixelplumbing.com/), and emits an `<img>` tag whose `src` is either a `data:` URL (for small outputs) or a content-addressed file under `OUTPUT_DIR/_assets/`.

```mdx
import {Image} from 'xtatic:image';

<Image src="./hero.jpg" alt="Sunset over the bay" width={1200} />
```

`sharp` is an optional peer dep — install it with `npm install sharp` when you first use `<Image>`. The component is loaded lazily, so projects that don't use it don't pay the install cost.

**Props specific to `<Image>`:**

- `src` (required) — path to the source image. Same resolution rules as `readfile`: `/foo` is rooted at `TOP_DIR`, anything else is relative to the importing file.
- `alt` (required) — accessible text. Use `alt=""` for purely decorative images. A missing `alt` is a build error.
- `width`, `height` — pixel dimensions to resize to. If only one is given, aspect ratio is preserved. Sharp's `withoutEnlargement` is on, so a small source won't be upscaled.
- `format` — `'avif'` (default), `'webp'`, `'jpeg'`, `'png'`. SVG sources are passed through unchanged; specifying a format on an SVG is an error.
- `quality` — encoder quality (sharp's per-format defaults if unset).
- `fit` — sharp fit mode: `'cover' | 'contain' | 'fill' | 'inside' | 'outside'`. Default `'inside'`.
- `inlineThreshold` — bytes. Outputs at or below this size are inlined as `data:` URLs; outputs above it are written to `OUTPUT_DIR/_assets/<hash>.<ext>` and referenced by a page-relative URL. Defaults to **8192 bytes**, configurable project-wide via `package.json` `xtatic.imageInlineThreshold`.

**Behavior baked in by default:**

- EXIF rotation is auto-applied; all other metadata is stripped (privacy + bytes).
- Output `width` and `height` attributes are always emitted, computed from the *processed* image, so the browser doesn't reflow on load.
- Identical `(src, processing-options)` deduplicates to a single asset file across the whole site.

Any extra props (`className`, `loading`, `decoding`, `id`, `data-*`, etc.) pass through to the rendered `<img>`. `className` is rewritten to `class`. Shared assets live under `OUTPUT_DIR/_assets/` but are referenced by a URL relative to each page, so the site works served from the domain root or any subpath.

Single-output-per-call only for now — `<picture>`/`srcset` for responsive images is a planned follow-up. There's no build cache yet either, so sharp re-runs on every build.

### `<Style>`

`xtatic:style` exports a build-time stylesheet component. It reads a CSS file, rewrites any `url(...)` references to point at hashed copies of the referenced assets, and emits either a `<style>` block (for small CSS) or a `<link rel="stylesheet">` pointing at a content-addressed file under `OUTPUT_DIR/_assets/`.

```mdx
import {Style} from 'xtatic:style';

<Style src="/css/main.css" />
```

**Props:**

- `src` (required) — path to the source CSS file. Same resolution rules as `<Image>`: `/foo` is rooted at `TOP_DIR`, anything else is relative to the importing file.
- `inlineThreshold` — bytes. CSS at or below this size is emitted inline as `<style>...</style>`; above, it goes to `OUTPUT_DIR/_assets/<hash>.css` and the call site gets a `<link>` instead. Defaults to **2048 bytes**, configurable project-wide via `package.json` `xtatic.styleInlineThreshold`.

**`url()` rewriting.** Any `url(...)` token inside the CSS — `background-image`, `@font-face src`, `cursor`, etc. — is resolved relative to the source CSS file's directory (or against `TOP_DIR` for `/`-rooted paths), the referenced bytes are hashed, copied under `OUTPUT_DIR/_assets/`, and the URL is rewritten to point there by a path relative to wherever the CSS ends up (inlined into the page, a shared `.css`, or co-located). URLs starting with `data:`, `http://`, `https://`, `//`, or `#` (SVG fragment refs like `clip-path: url(#mask)`) are passed through unchanged. Identical references across multiple CSS files share a single asset file.

Any extra props (`media`, `nonce`, `crossorigin`, `id`, `data-*`, etc.) pass through to the rendered `<style>` or `<link>`. `className` is rewritten to `class`.

**Caveats:** `@import "..."` (the bare-string form) is not rewritten — only `url(...)` tokens are. SCSS / minification / autoprefixing are not built in; pre-compile to CSS yourself for now (a transform hook is on the roadmap).

### `<Font>`

`xtatic:font` exports a build-time `@font-face` component meant for `<head>`. Each call expands to a `<style>` with one `@font-face` rule (and an optional `<link rel="preload">`) pointing at a content-addressed copy of the font under `OUTPUT_DIR/_assets/`.

```mdx
import {Font} from 'xtatic:font';

<Font src="./fonts/Inter-Regular.ttf" family="Inter" weight={400} />
<Font src="./fonts/Inter-Bold.ttf"    family="Inter" weight={700} />
<Font src="./fonts/Inter-Italic.ttf"  family="Inter" weight={400} style="italic" display="swap" preload />
<Font src="./fonts/Logotype.otf"      family="Logotype" text="xtatic" preload />
```

`.ttf` and `.otf` sources are transcoded to WOFF2 at build time via [wawoff2](https://github.com/fontello/wawoff2.js); `.woff` and `.woff2` sources are emitted verbatim. `wawoff2` is an optional peer dep — install it with `npm install wawoff2` the first time you use a `.ttf`/`.otf` source.

**Subsetting.** Pass `text="…"` and the font is reduced to just the glyphs needed to render those characters before being emitted (always as WOFF2, whatever the input format). This is aimed at the small-fixed-text case — a logotype, a heading face, an icon set — where shipping a full Unicode face would be wasteful; a few-glyph subset of a typical text font is commonly a 10–100× size reduction. Subsetting is done via [subset-font](https://github.com/papandreou/subset-font) (HarfBuzz), an optional peer dep — `npm install subset-font` the first time you use `text=` (or [auto-subsetting](#auto-subsetting), below). Two `<Font src>`s pointing at the same file with the same set of characters (order and duplicates don't matter) dedupe to one asset; different character sets, or a subsetted vs. non-subsetted reference, are separate assets.

For the common case where the glyphs you need aren't a fixed string but "whatever my pages actually render," skip `text=` and turn on [auto-subsetting](#auto-subsetting) — xtatic figures the set out from the rendered HTML and the CSS reaching each page, then ships a tight subset (and optionally a lazy-loaded complement so anything missed never tofus).

**Props:**

- `src` (required) — path to a `.ttf`, `.otf`, `.woff`, or `.woff2` file. Same resolution rules as `<Image>`/`<Style>`.
- `family` (required) — the CSS `font-family` value. Quoted in the output and CSS-escaped.
- `weight` — number or string (e.g. `400`, `"100 900"` for variable fonts). Omitted when absent (browser defaults to `normal`).
- `style` — `"normal" | "italic" | "oblique"`. Omitted when absent.
- `display` — `"auto" | "block" | "swap" | "fallback" | "optional"`. Omitted when absent (browser default = `auto`; `<Font>` does not impose `swap`).
- `unicodeRange` — string passed through to `unicode-range:` verbatim.
- `text` — when set (a non-empty string), subset the font to the characters in this string (see above). Output is WOFF2 regardless of source format. Always wins over auto-subsetting on the same call.
- `subset` — boolean. Per-call opt-in/out for [auto-subsetting](#auto-subsetting). `subset={true}` opts this one font in even without the global flag; `subset={false}` opts it out when the global flag is on. Has no effect if `text=` is also set.
- `preload` — boolean (default `false`). When set, a `<link rel="preload" as="font" type="font/woff2" href="…" crossorigin>` is emitted just before the `<style>` block.

Identical `src` files dedupe to a single asset across the whole site, regardless of how many `<Font>` calls reference them (modulo `text` — see above). Asset URLs are page-relative (the `@font-face src:` and any `<link rel=preload>` point at `_assets/` relative to the page), so the site can be served from any path.

`<Font>` rejects unknown props (no silent pass-through) — if you need to customize the emitted `<style>` or `<link>` further, write the markup by hand.

**Note on `<Style>` interaction:** writing your own `@font-face { src: url('./x.ttf') }` inside a `<Style>`-loaded CSS file no longer auto-transcodes the TTF to WOFF2 — the CSS path emits the file as-is now. Use `<Font>` for the transcode behavior.

### Auto-subsetting

Set `xtatic.fontSubset` in `package.json` and every `<Font>` in the build is reduced to just the glyphs that actually appear on a page using that face — no `text=` needed. Per-page text is computed from the rendered HTML; for `mode: 'css-static'` (the default) the CSS reaching each page is parsed too, so the cascade decides which `@font-face` each text run resolves to.

The simplest form turns it on with safe defaults:

```json
{
  "xtatic": {
    "fontSubset": true
  }
}
```

Equivalent to `{ "mode": "css-static", "precision": "face", "scope": "site", "hedge": "full", "preloadHedge": false }`. Per-call `<Font subset={false}>` opts a single font out; `<Font subset={true}>` opts a single font in when the global flag isn't set.

Pass an object instead for explicit control over the five knobs:

| Key | Values | What it does |
| --- | --- | --- |
| `mode` | `'css-static'` (default), `'all-text'` | `'css-static'` parses the CSS that reaches each page and attributes glyphs by the cascade. `'all-text'` skips CSS and just unions the rendered text — every font gets the same glyph set. Cheaper, no parse5/css-tree work, over-includes a touch but never under-includes for literal text. |
| `precision` | `'face'` (default), `'family'` | Only meaningful in `css-static`. `'face'` keys glyph sets by `(family, weight, style)` so regular and bold get distinct subsets. `'family'` collapses all weights/styles of one family into one subset (fewer assets, slightly larger each). |
| `scope` | `'site'` (default), `'page'` | `'site'` ships one subset per face for the whole build — fewer files, cross-page HTTP-cache reuse. `'page'` issues one subset per `(face, page)` — minimal first-paint bytes per page, but the same `<Font>` call in a layout produces a different asset URL on each page it renders into. |
| `hedge` | `'none'`, `'latin1'`, `'full'` | The hedge against missed glyphs. `'full'` emits a *second* `@font-face` per call carrying the rest of the source font's coverage with a disjoint `unicode-range`; the browser only fetches it on demand for any character outside the primary set. `'latin1'` caps the complement at U+00FF. `'none'` ships only the primary subset (under-include = silent tofu). The boolean `fontSubset: true` form defaults to `'full'`; the explicit-object form defaults to `'none'` (treat the explicit form as "I'm being deliberate"). |
| `preloadHedge` | `false` (default), `'prefetch'`, `'preload'` | When the complement face is emitted (`hedge` ≠ `'none'`), optionally also emit a `<link>` for it. By default the complement is fetched lazily only when the browser actually hits an out-of-primary code point — zero perf cost on the common path. |

Auto-subsetting needs three extra dependencies (all hard, already installed): [parse5](https://github.com/inikulin/parse5) for HTML, [css-tree](https://github.com/csstree/csstree) for CSS, and [fontkit](https://github.com/foliojs/fontkit) for source-font glyph enumeration. Subsetting itself still goes through `subset-font` (the optional peer dep above), so the first auto-subsetted build prompts for `npm install subset-font` unless you've enabled `autoInstall`.

**Known gaps in v1:**

- `::before` / `::after` `content:` is not extracted yet, so an icon font driven entirely by `content: "\f001"` won't have those code points attributed by the cascade. With `hedge: 'full'` the icons still ship in the complement subset (the failure mode is byte-bloat, not tofu); without hedge, set `text=` on the call to list them explicitly.
- `font-weight: bolder` / `lighter` round to fixed steps rather than walking the spec's relative-table.
- Pseudo-classes like `:hover`, `:focus`, `:nth-child(...)`, `:not(...)` evaluate as always-true so weight/style overrides applied only in those states still contribute glyphs (over-includes a touch, never under-includes).
- A face that no rule attributes any glyphs to falls back to transcode-only (the whole font ships) rather than emitting a zero-glyph subset — keeps the failure mode safe.

## Auto-installing optional peer deps

`<Image>`, `<Font>`, and font subsetting each need an optional peer dependency (`sharp`, `wawoff2`, `subset-font`). By default a missing one is a build error suggesting `npm install <pkg>`. Set `xtatic.autoInstall` in `package.json` to flip that to on-the-fly installation:

```json
{
  "xtatic": {
    "autoInstall": true
  }
}
```

When enabled, the first time a build needs a missing peer dep, xtatic shells out to `npm install --save-dev <pkg>` in `TOP_DIR` and then retries the import. Subsequent rebuilds in the same process reuse the installed module. Defaults to `false`. `xtatic init` enables this flag.

## Lint

`xtatic` runs ESLint over your `.md`/`.mdx`/`.jsx`/`.js` files automatically before each build, with an opinionated zero-config baseline focused on catching import bugs early — typo'd named imports, missing files, default-vs-named confusion on the `xtatic:*` builtins. A lint failure exits 1 with the formatted ESLint output before any HTML is written.

**What's checked:**

- `import/no-unresolved` — flags imports of files that don't exist on disk. Leading-`/` specs in `.md`/`.mdx`/`.jsx` are resolved against `TOP_DIR` (matching the build), so `import Card from '/components/card.mdx'` checks correctly rather than being mistaken for a filesystem-absolute path.
- `import/named` — flags `import {Foo}` when `Foo` isn't actually exported.
- `import/no-duplicates` — flags two `import` statements for the same module.
- `xtatic/builtin-imports` — flags default imports, namespace imports, and unknown export names against `xtatic:builtins`/`xtatic:image`/`xtatic:style`/`xtatic:font`. Errors carry the suggested fix (e.g. *"`xtatic:style` has no default export. Use `import {Style} from 'xtatic:style'` instead."*).
- `import/default` and `no-undef` — applied to `.js`/`.jsx` only. Off for `.md`/`.mdx` because xtatic's default-import semantics there bind the whole module object rather than `mm.default` (a deliberate divergence from ESM).

Parse errors print a source-code frame pointing at the offending spot. When color is available (a TTY, or the dev server's browser error page), the bad characters are highlighted inline on the source line; otherwise (piped output, CI) a `^` caret is drawn on the line below. Long lines are windowed around the error — clipped to **120 columns** with `…` markers — so the highlight stays on screen instead of scrolling off. Set `xtatic.codeFrameWidth` in `package.json` to change that width, or `0` to disable windowing and always show the full line:

The same code frame is shown for **render-time** errors. When a `<Component/>`, an imported page, or an asset (`<img>`, `<Image>`, `<Font>`, `<a href>`, …) fails during the build, xtatic prints a trace of the page → layout → component chain that led there, and under each call site that has a known location it shows the offending source line:

```
<Image>: source not found at /site/layouts/missing.png

  in <Image> at layouts/base.mdx:5:1
      4 | <html><body>
    > 5 | <Image src='./missing.png' alt='x' />
        | ^
      6 | {props.children}
  in layout layouts/base.mdx
  while building page /
```

A third category: if a top-level `export` (or `{}` expression) throws while the module body runs — e.g. `export const x = compute()` where `compute()` is imported from a `.js` file and raises — the error is reported as `Failed to evaluate "<file>": <message>` (distinct from a `Failed to compile` syntax error) and is followed by the throwing call's stack frame, so it points at the actual source of the throw (e.g. `at compute (lib.js:2:9)`) rather than just naming the page.

```json
{
  "xtatic": {
    "codeFrameWidth": 80
  }
}
```

The lint rule set itself is currently frozen — no user override knob yet; that's a planned follow-up. `eslint`, `eslint-plugin-import`, and `eslint-plugin-mdx` are hard runtime dependencies, so there's nothing to install.

## Limitations

- No client-side runtime, hydration, or watch mode.
- `style` prop accepts strings only.
- Components must be synchronous.
- Path handling assumes POSIX separators.
- `.js` files cannot import `.md`/`.mdx` (Node has no loader for those).
- Auto-subsetting (`<Font>`) doesn't see `::before`/`::after` `content:` glyphs; rely on `hedge: 'full'` (default for `fontSubset: true`) or set `text=` explicitly for icon fonts.

## Tests

```sh
npm test
```

Tests use Node's built-in `node:test` runner. Most tests inject `memfs` and never touch disk; tests that need `.js` imports (and one no-injection smoke test) write to a `./test-tmp/` scratch directory at the repo root, which is gitignored and wiped at the start of each run.
