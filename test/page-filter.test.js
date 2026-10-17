import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, createFsFromVolume } from 'memfs';
import { build } from '../src/index.js';

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

const exists = (fs, p) => fs.existsSync(p);
const read = (fs, p) => fs.readFileSync(p, 'utf8');

const listing =
  '<ul>{childPages.map((p) => <li key={p.name}>{p.name}</li>)}</ul>\n';

test('pageFilter drops rejected descendants from output and childPages', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/blog/index.md':
      'export const pageFilter = (p) => !p.draft\n\n' + listing,
    '/in/blog/a.md': '---\ntitle: A\n---\n# A\n',
    '/in/blog/b.md': '---\ndraft: true\n---\n# B\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.ok(exists(fs, '/out/blog/a/index.html'));
  assert.ok(!exists(fs, '/out/blog/b/index.html'));
  const html = read(fs, '/out/blog/index.html');
  assert.match(html, /<li>a<\/li>/);
  assert.doesNotMatch(html, /<li>b<\/li>/);
});

test('pageFilter can read process.env (drafts shown when an env var is set)', async () => {
  const files = {
    '/in/index.md':
      "export const pageFilter = (p) => !p.draft || process.env.XTATIC_TEST_DRAFTS === '1'\n\n# Home\n",
    '/in/post.md': '---\ndraft: true\n---\n# Post\n',
  };
  let fs = makeFs(files);
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.ok(!exists(fs, '/out/post/index.html'));
  process.env.XTATIC_TEST_DRAFTS = '1';
  try {
    fs = makeFs(files);
    await build({ inputDir: '/in', outputDir: '/out', fs });
    assert.ok(exists(fs, '/out/post/index.html'));
  } finally {
    delete process.env.XTATIC_TEST_DRAFTS;
  }
});

test('pageFilter applies at every depth and a rejected page takes its subtree', async () => {
  const fs = makeFs({
    '/in/index.md': 'export const pageFilter = (p) => !p.draft\n\n# Home\n',
    '/in/x/deep/page.md': '---\ndraft: true\n---\n# deep\n',
    '/in/x/deep/ok.md': '# ok\n',
    '/in/sec/index.md': '---\ndraft: true\n---\n# sec\n',
    '/in/sec/child.md': '# child\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.ok(!exists(fs, '/out/x/deep/page/index.html'));
  assert.ok(exists(fs, '/out/x/deep/ok/index.html'));
  assert.ok(!exists(fs, '/out/sec/index.html'));
  assert.ok(!exists(fs, '/out/sec/child/index.html'));
});

test('pageFilter does not apply to the page that exports it; nested filters compose', async () => {
  const fs = makeFs({
    '/in/index.md': 'export const pageFilter = (p) => p.name !== "a"\n\n# Home\n',
    '/in/s/index.md': 'export const pageFilter = (p) => p.name !== "b"\n\n# S\n',
    '/in/s/a.md': '# a\n',
    '/in/s/b.md': '# b\n',
    '/in/s/c.md': '# c\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.ok(exists(fs, '/out/s/index.html'));
  assert.ok(!exists(fs, '/out/s/a/index.html'));
  assert.ok(!exists(fs, '/out/s/b/index.html'));
  assert.ok(exists(fs, '/out/s/c/index.html'));
});

test('pageFilter sees name-derived date (hide future posts)', async () => {
  const fs = makeFs({
    '/in/index.md':
      "export const pageFilter = (p) => !p.date || p.date <= '2026-01-01'\n\n# Home\n",
    '/in/2025-05-01-old.md': '# old\n',
    '/in/2027-01-01-future.md': '# future\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.ok(exists(fs, '/out/2025-05-01-old/index.html'));
  assert.ok(!exists(fs, '/out/2027-01-01-future/index.html'));
});

test('getPages sees filtered childPages; generated pages are filtered too', async () => {
  const fs = makeFs({
    '/in/index.md': 'export const pageFilter = (p) => !p.draft\n\n# Home\n',
    '/in/blog/index.md': '# Blog\n',
    '/in/blog/a.md': '---\ntags: [x]\n---\n# a\n',
    '/in/blog/b.md': '---\ntags: [y]\ndraft: true\n---\n# b\n',
    '/in/tags/tag-{tag}.md':
      "import blog from '/blog/index.md'\n" +
      'export const getPages = () => [...new Set(blog.childPages.flatMap((p) => p.tags))]' +
      ".map((tag) => ({ tag, draft: tag === 'z' })).concat([{ tag: 'z', draft: true }])\n\n# {tag}\n",
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.ok(exists(fs, '/out/tags/tag-x/index.html'));
  assert.ok(!exists(fs, '/out/tags/tag-y/index.html'));
  assert.ok(!exists(fs, '/out/tags/tag-z/index.html'));
});

test('a generated page under a filtered-out section is dropped', async () => {
  const fs = makeFs({
    '/in/index.md': 'export const pageFilter = (p) => !p.draft\n\n# Home\n',
    '/in/sec/index.md': '---\ndraft: true\n---\n# sec\n',
    '/in/sec/t-{n}.md': "export const getPages = () => [{ n: '1' }]\n\n# {n}\n",
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.ok(!exists(fs, '/out/sec/t-1/index.html'));
});

test('a link to a filtered-out page is an error (its source is not copied)', async () => {
  const fs = makeFs({
    '/in/index.md':
      'export const pageFilter = (p) => !p.draft\n\n[draft](./post.md)\n',
    '/in/post.md': '---\ndraft: true\n---\n# Post\n',
  });
  await assert.rejects(
    build({ inputDir: '/in', outputDir: '/out', fs }),
    /"\.\/post\.md" \(in "index\.md"\) links to a page excluded by pageFilter in "index\.md"/,
  );
});

test('pageFilter errors: non-function, throw, non-boolean', async () => {
  for (const [src, re] of [
    ["export const pageFilter = 'nope'", /exports `pageFilter` but it is not a function \(got string\)/],
    ["export const pageFilter = () => { throw new Error('boom') }", /pageFilter in "index\.md" threw for "a": boom/],
    ['export const pageFilter = () => undefined', /pageFilter in "index\.md" must return a boolean \(got undefined for "a"\)/],
  ]) {
    const fs = makeFs({ '/in/index.md': `${src}\n\n# Home\n`, '/in/a.md': '# a\n' });
    await assert.rejects(build({ inputDir: '/in', outputDir: '/out', fs }), re);
  }
});

test('keepGoing: a broken pageFilter is reported once and its pages are skipped', async () => {
  const fs = makeFs({
    '/in/index.md': "export const pageFilter = 'nope'\n\n# Home\n",
    '/in/a.md': '# a\n',
    '/in/b/c.md': '# c\n',
  });
  let caught;
  try {
    await build({ inputDir: '/in', outputDir: '/out', fs, keepGoing: true });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof AggregateError);
  assert.equal(caught.errors.length, 1);
  assert.deepEqual(caught.skippedPages, ['a', 'b/c']);
  assert.ok(exists(fs, '/out/index.html'));
  assert.ok(!exists(fs, '/out/a/index.html'));
});
