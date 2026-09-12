import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleTree } from '../src/tree.js';

function entry(segments, props = {}) {
  return {
    relPath: (segments.length === 0 ? 'index' : segments.join('/')) + '.md',
    segments,
    mm: { default: () => ({ html: '' }), ...props },
  };
}

function child(parent, name) {
  return parent.childPages.find((c) => c.name === name);
}

test('errors when there are no entries at all', () => {
  assert.throws(() => assembleTree([]), /No page sources found/);
});

test('a missing root is synthesized: it groups children but is marked synthetic', () => {
  const root = assembleTree([entry(['foo'])]);
  assert.equal(root.__xtatic_synthetic, true);
  assert.equal(root.default, undefined);
  assert.deepEqual(
    root.childPages.map((c) => c.name),
    ['foo'],
  );
});

test('returns the root module with empty childPages for a single-file tree', () => {
  const root = assembleTree([entry([])]);
  assert.equal(typeof root.default, 'function');
  assert.deepEqual(root.childPages, []);
});

test('attaches each child to its parent and tags it with its last-segment name', () => {
  const root = assembleTree([
    entry([]),
    entry(['a']),
    entry(['b']),
    entry(['a', 'x']),
  ]);
  assert.deepEqual(
    root.childPages.map((c) => c.name),
    ['a', 'b'],
  );
  assert.deepEqual(
    child(root, 'a').childPages.map((c) => c.name),
    ['x'],
  );
});

test('childPages is sorted by name regardless of input order', () => {
  const root = assembleTree([
    entry([]),
    entry(['c']),
    entry(['a']),
    entry(['b']),
  ]);
  assert.deepEqual(
    root.childPages.map((c) => c.name),
    ['a', 'b', 'c'],
  );
});

test("a module's layout defaults to its own defaultLayout", () => {
  const tpl = { default: () => ({ html: '' }) };
  const root = assembleTree([entry([], { defaultLayout: tpl })]);
  assert.equal(root.layout, tpl);
});

test("a module without a defaultLayout inherits the nearest ancestor's", () => {
  const rootTpl = { default: () => ({ html: '' }) };
  const root = assembleTree([
    entry([], { defaultLayout: rootTpl }),
    entry(['child']),
  ]);
  assert.equal(child(root, 'child').layout, rootTpl);
});

test("the closest ancestor's defaultLayout wins, with fallback up the chain", () => {
  const rootTpl = { default: () => ({ html: '' }) };
  const sectionTpl = { default: () => ({ html: '' }) };
  const root = assembleTree([
    entry([], { defaultLayout: rootTpl }),
    entry(['section'], { defaultLayout: sectionTpl }),
    entry(['section', 'leaf']),
    entry(['other']),
    entry(['other', 'leaf']),
  ]);
  assert.equal(root.layout, rootTpl);
  const section = child(root, 'section');
  const other = child(root, 'other');
  assert.equal(section.layout, sectionTpl);
  assert.equal(child(section, 'leaf').layout, sectionTpl);
  assert.equal(other.layout, rootTpl);
  assert.equal(child(other, 'leaf').layout, rootTpl);
});

test('an explicit layout overrides defaultLayout inheritance', () => {
  const dt = { default: () => ({ html: '' }) };
  const explicit = { default: () => ({ html: '' }) };
  const root = assembleTree([
    entry([], { defaultLayout: dt }),
    entry(['foo'], { layout: explicit }),
  ]);
  assert.equal(child(root, 'foo').layout, explicit);
});

test('a module with no layout and no ancestor defaultLayout ends up with layout=undefined', () => {
  const root = assembleTree([entry([]), entry(['foo'])]);
  assert.equal(root.layout, undefined);
  assert.equal(child(root, 'foo').layout, undefined);
});

test('a missing intermediate parent is synthesized with name/title defaults', () => {
  const root = assembleTree([entry([]), entry(['missing-parent', 'leaf'])]);
  const synth = child(root, 'missing-parent');
  assert.equal(synth.__xtatic_synthetic, true);
  assert.equal(synth.name, 'missing-parent');
  assert.equal(synth.title, 'Missing Parent');
  assert.deepEqual(
    synth.childPages.map((c) => c.name),
    ['leaf'],
  );
});

test('several missing levels are all synthesized', () => {
  const root = assembleTree([entry([]), entry(['a', 'b', 'c'])]);
  const a = child(root, 'a');
  const b = child(a, 'b');
  assert.equal(a.__xtatic_synthetic, true);
  assert.equal(b.__xtatic_synthetic, true);
  assert.deepEqual(
    b.childPages.map((c) => c.name),
    ['c'],
  );
});

test('the synthetic marker is non-enumerable (stays out of spreads)', () => {
  const root = assembleTree([entry(['foo'])]);
  assert.equal({ ...root }.__xtatic_synthetic, undefined);
});

test('defaultLayout inheritance passes through a synthetic node', () => {
  const rootTpl = { default: () => ({ html: '' }) };
  const root = assembleTree([
    entry([], { defaultLayout: rootTpl }),
    entry(['section', 'leaf']),
  ]);
  const section = child(root, 'section');
  assert.equal(section.__xtatic_synthetic, true);
  assert.equal(section.layout, undefined);
  assert.equal(child(section, 'leaf').layout, rootTpl);
});

test('childPages is a real Array (supports .map, .find, .length, etc.)', () => {
  const root = assembleTree([entry([]), entry(['a']), entry(['b'])]);
  assert.equal(Array.isArray(root.childPages), true);
  assert.equal(root.childPages.length, 2);
  assert.deepEqual(root.childPages.map((c) => c.name), ['a', 'b']);
});

test('the root has no name set; only attached children do', () => {
  const root = assembleTree([entry([]), entry(['a'])]);
  assert.equal(root.name, undefined);
  assert.equal(child(root, 'a').name, 'a');
});

test('dashed YYYY-MM-DD prefix sets date and title-cases the lowercase remainder', () => {
  const root = assembleTree([entry([]), entry(['2020-01-23-this-is-a-test'])]);
  const c = child(root, '2020-01-23-this-is-a-test');
  assert.equal(c.date, '2020-01-23');
  assert.equal(c.title, 'This Is a Test');
});

test('compact YYYYMMDD-only name sets date and leaves title unset', () => {
  const root = assembleTree([entry([]), entry(['20200123'])]);
  const c = child(root, '20200123');
  assert.equal(c.date, '2020-01-23');
  assert.equal(c.title, undefined);
});

test('compact YYYYMMDD prefix with remainder sets both date and title', () => {
  const root = assembleTree([entry([]), entry(['20200123-foo-bar'])]);
  const c = child(root, '20200123-foo-bar');
  assert.equal(c.date, '2020-01-23');
  assert.equal(c.title, 'Foo Bar');
});

test('mixed-case name without a date prefix sets title verbatim and leaves date unset', () => {
  const root = assembleTree([entry([]), entry(['THIS-is-a-TEST'])]);
  const c = child(root, 'THIS-is-a-TEST');
  assert.equal(c.date, undefined);
  assert.equal(c.title, 'THIS is a TEST');
});

test('all-lowercase name without a date prefix is title-cased', () => {
  const root = assembleTree([entry([]), entry(['regular-page'])]);
  const c = child(root, 'regular-page');
  assert.equal(c.date, undefined);
  assert.equal(c.title, 'Regular Page');
});

test('a bare YYYY-MM-DD name sets only the date', () => {
  const root = assembleTree([entry([]), entry(['2020-01-23'])]);
  const c = child(root, '2020-01-23');
  assert.equal(c.date, '2020-01-23');
  assert.equal(c.title, undefined);
});

test('an out-of-range date prefix is not extracted as a date', () => {
  const root = assembleTree([entry([]), entry(['2020-13-45-foo'])]);
  const c = child(root, '2020-13-45-foo');
  assert.equal(c.date, undefined);
  assert.equal(c.title, '2020 13 45 Foo');
});

test('explicit mm.date and mm.title override the name-derived defaults', () => {
  const root = assembleTree([
    entry([]),
    entry(['2020-01-23-foo'], { date: '1999-12-31', title: 'Custom' }),
  ]);
  const c = child(root, '2020-01-23-foo');
  assert.equal(c.date, '1999-12-31');
  assert.equal(c.title, 'Custom');
});

test('the root module gets no date or title defaults', () => {
  const root = assembleTree([entry([])]);
  assert.equal(root.date, undefined);
  assert.equal(root.title, undefined);
});

test('every child gets parent, prevSibling, and nextSibling in childPages order', () => {
  const root = assembleTree([
    entry([]),
    entry(['blog']),
    entry(['blog', '2026-01-03-c']),
    entry(['blog', '2026-01-01-a']),
    entry(['blog', '2026-01-02-b']),
  ]);
  const blog = child(root, 'blog');
  const [a, b, c] = blog.childPages;
  assert.equal(blog.parent, root);
  assert.equal(a.parent, blog);
  assert.equal(a.prevSibling, undefined);
  assert.equal(a.nextSibling, b);
  assert.equal(b.prevSibling, a);
  assert.equal(b.nextSibling, c);
  assert.equal(c.prevSibling, b);
  assert.equal(c.nextSibling, undefined);
  // The root is nobody's child.
  assert.equal(root.parent, undefined);
  assert.equal(root.prevSibling, undefined);
  assert.equal(root.nextSibling, undefined);
});

test('a synthetic grouping node is a parent and a sibling like any other', () => {
  const root = assembleTree([entry([]), entry(['a']), entry(['g', 'leaf'])]);
  const a = child(root, 'a');
  const g = child(root, 'g');
  assert.equal(g.__xtatic_synthetic, true);
  assert.equal(g.parent, root);
  assert.equal(a.nextSibling, g);
  assert.equal(g.prevSibling, a);
  assert.equal(child(g, 'leaf').parent, g);
});

test('parent/prevSibling/nextSibling are rebuilt when assembleTree runs again over a larger set', () => {
  const a = entry(['a']);
  const rootE = entry([]);
  assembleTree([rootE, a]);
  assert.equal(a.mm.nextSibling, undefined);
  assembleTree([rootE, a, entry(['b'])]);
  assert.equal(a.mm.nextSibling.name, 'b');
  assert.equal(a.mm.nextSibling.prevSibling, a.mm);
});
