import path from 'node:path';

// A directory under inputDir containing this marker file has some or all of
// its contents copied to the output byte-for-byte, mirroring their source-tree
// position: no page mapping, no layout, no HTML parsing, no asset processing.
// An EMPTY marker (nothing but blank/comment lines) makes the whole directory
// verbatim. A marker with pattern lines makes only the matching files (and
// the whole subtree of any matching directory) verbatim; everything else in
// the directory is still walked for pages as usual. Patterns are a gitignore
// subset — see parseVerbatimMarker. The marker itself is never copied.
// The name is configurable (`xtatic.verbatimMarker`); this is the default.
export const DEFAULT_VERBATIM_MARKER = '_xtatic_verbatim';

// A marker name is a single path segment: a bare filename that can sit in
// any directory. Throws on anything else.
export function assertValidVerbatimMarker(name) {
  if (typeof name !== 'string' || name === '') {
    throw new Error(
      `verbatimMarker must be a non-empty string; got ${JSON.stringify(name)}.`,
    );
  }
  if (name.includes('/') || name === '.' || name === '..') {
    throw new Error(
      `verbatimMarker must be a single file name (no "/", not "." or ".."); got ${JSON.stringify(name)}.`,
    );
  }
}

// True when `dirent`s (from readdir withFileTypes) include the marker file.
export function hasVerbatimMarker(dirents, marker) {
  return dirents.some((d) => d.name === marker && !d.isDirectory());
}

// Pattern lines → matcher rules. Syntax (gitignore subset):
//   - blank lines and `#` comments are ignored; surrounding whitespace trimmed
//   - `*` matches within one path segment, `?` one character, `**` any
//     number of segments
//   - a pattern with no `/` (other than a trailing one) matches a basename at
//     any depth below the marker's directory; one with a `/` is anchored to
//     the marker's directory (a leading `/` is allowed and means the same)
//   - a trailing `/` matches directories only
//   - no negation (`!`) — keep the marker small, or split it across
//     directories
// Returns `{all: true}` when there are no patterns (the classic empty marker).
export function parseVerbatimMarker(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    rules.push(compilePattern(line));
  }
  return rules.length === 0 ? { all: true, rules } : { all: false, rules };
}

function compilePattern(pattern) {
  let p = pattern;
  let dirOnly = false;
  if (p.endsWith('/')) {
    dirOnly = true;
    p = p.slice(0, -1);
  }
  let anchored = false;
  if (p.startsWith('/')) {
    anchored = true;
    p = p.slice(1);
  } else if (p.includes('/')) {
    anchored = true;
  }
  const segs = p.split('/');
  let body = '';
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (seg === '**') {
      body += last ? '.*' : '(?:.*/)?';
      continue;
    }
    for (const ch of seg) {
      if (ch === '*') body += '[^/]*';
      else if (ch === '?') body += '[^/]';
      else body += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    if (!last) body += '/';
  }
  const re = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}$`);
  return { pattern, dirOnly, re };
}

// `relPath` is the candidate's path relative to the marker's directory (no
// leading `/`); `isDir` says whether it's a directory.
export function matchesVerbatimRules(rules, relPath, isDir) {
  return rules.some((r) => (isDir || !r.dirOnly) && r.re.test(relPath));
}

// The walkers carry a stack of `{baseRel, rules}` — one entry per pattern
// marker on the path from the walk root down — so a parent's patterns apply
// to descendants, like gitignore. `childRel` is the candidate's path relative
// to the walk root (the same frame `baseRel` is in).
export function isVerbatimByPatterns(active, childRel, isDir) {
  for (const { baseRel, rules } of active) {
    const rel =
      baseRel === '' ? childRel : childRel.slice(baseRel.length + 1);
    if (matchesVerbatimRules(rules, rel, isDir)) return true;
  }
  return false;
}

// Every regular file under `absDir` (recursively, sorted for determinism),
// excluding marker files, as `{absPath, relPath}` where relPath is relative to
// inputDir (`relDir` is absDir's own inputDir-relative path, '' for the root).
// `marker` is the marker file name to exclude.
export async function collectVerbatimFiles(fs, absDir, relDir, marker) {
  const results = [];
  async function recurse(dirAbs, dirRel) {
    const entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const childAbs = `${dirAbs}/${ent.name}`;
      const childRel = dirRel === '' ? ent.name : `${dirRel}/${ent.name}`;
      if (ent.isDirectory()) {
        await recurse(childAbs, childRel);
      } else if (ent.isFile() && ent.name !== marker) {
        results.push({ absPath: childAbs, relPath: childRel });
      }
    }
  }
  await recurse(absDir, relDir);
  return results;
}

// Copy each verbatim file to `outputDir/<relPath>` through the build's shared
// output writer (so unchanged files keep their mtime and prune() knows about
// them). `entries` carry `outPath` (stamped by index.js after the collision
// checks).
export async function writeVerbatimFiles({ fs, writer, entries }) {
  for (const { absPath, outPath } of entries) {
    const bytes = await fs.promises.readFile(absPath);
    await writer.writeFile(outPath, bytes);
  }
}

export function verbatimOutPath(outputDir, relPath) {
  return path.posix.join(outputDir, relPath);
}
