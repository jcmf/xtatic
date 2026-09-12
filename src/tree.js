import title from 'title';

const NAME_PATTERN =
  /^(?:(\d{4})-(\d{2})-(\d{2})|(\d{4})(\d{2})(\d{2}))(?:-(.*))?$/;

function nameDefaults(name) {
  const m = NAME_PATTERN.exec(name);
  let date;
  let remainder = name;
  if (m) {
    const y = m[1] ?? m[4];
    const mo = m[2] ?? m[5];
    const d = m[3] ?? m[6];
    if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) {
      date = `${y}-${mo}-${d}`;
      remainder = m[7] ?? '';
    }
  }
  let titleStr;
  if (remainder !== '') {
    const spaced = remainder.replaceAll('-', ' ');
    titleStr = spaced === spaced.toLowerCase() ? title(spaced) : spaced;
  }
  return { date, title: titleStr };
}

// A tree position with pages beneath it but no source file of its own (a
// directory without index.md, possibly the root). The node exists only to
// group its children: it joins its parent's childPages with the usual
// name/title/date defaults, but renders no output file. The marker is
// non-enumerable so it stays out of recma-self's bare-identifier set and
// {...page} spreads. Fresh objects are created per assembleTree call — safe
// for buildImpl's two-pass assembly because nothing can hold a reference to a
// synthetic node across passes (they have no source file to import).
function syntheticModule() {
  const mm = {};
  Object.defineProperty(mm, '__xtatic_synthetic', { value: true });
  return mm;
}

export function assembleTree(entries, options = {}) {
  if (entries.length === 0) {
    const where = options.inputDir ? ` in "${options.inputDir}"` : '';
    throw new Error(
      `No page sources found${where}: create index.md or index.mdx there.`,
    );
  }
  const byKey = new Map();
  for (const entry of entries) {
    byKey.set(entry.segments.join('/'), entry);
  }
  const all = [...entries];
  for (const entry of entries) {
    for (let depth = entry.segments.length - 1; depth >= 0; depth--) {
      const key = entry.segments.slice(0, depth).join('/');
      if (byKey.has(key)) continue;
      const synth = { segments: entry.segments.slice(0, depth), mm: syntheticModule() };
      byKey.set(key, synth);
      all.push(synth);
    }
  }
  const root = byKey.get('');

  for (const entry of all) {
    entry.mm.childPages = [];
  }

  for (const entry of all) {
    if (entry.segments.length === 0) continue;
    const parent = byKey.get(entry.segments.slice(0, -1).join('/'));
    const name = entry.segments[entry.segments.length - 1];
    entry.mm.name = name;
    const defaults = nameDefaults(name);
    if (entry.mm.date === undefined && defaults.date !== undefined) {
      entry.mm.date = defaults.date;
    }
    if (entry.mm.title === undefined && defaults.title !== undefined) {
      entry.mm.title = defaults.title;
    }
    parent.mm.childPages.push(entry.mm);
  }

  for (const entry of all) {
    entry.mm.childPages.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }

  // Tool-owned navigation fields, rebuilt unconditionally on every call (like
  // childPages) so buildImpl's two-pass assembly can't leave a stale
  // prevSibling/nextSibling from the first pass: a page that was last among
  // its siblings before generators expanded may gain a nextSibling after.
  // The root has no parent and no siblings (all three stay undefined).
  for (const entry of all) {
    const sibs = entry.mm.childPages;
    for (let i = 0; i < sibs.length; i++) {
      sibs[i].parent = entry.mm;
      sibs[i].prevSibling = i > 0 ? sibs[i - 1] : undefined;
      sibs[i].nextSibling = i < sibs.length - 1 ? sibs[i + 1] : undefined;
    }
  }

  for (const entry of all) {
    // Synthetic nodes never render, so a layout would be dead weight; the
    // defaultLayout walk below already skips through them (byKey lookup finds
    // no defaultLayout on a synthetic ancestor and keeps climbing).
    if (entry.mm.__xtatic_synthetic) continue;
    if (entry.mm.layout !== undefined) continue;
    for (let depth = entry.segments.length; depth >= 0; depth--) {
      const ancestor = byKey.get(entry.segments.slice(0, depth).join('/'));
      if (ancestor && ancestor.mm.defaultLayout !== undefined) {
        entry.mm.layout = ancestor.mm.defaultLayout;
        break;
      }
    }
  }

  return root.mm;
}
