import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, createFsFromVolume } from 'memfs';
import { build } from '../src/index.js';

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

test('writes the root index.md to output_dir/index.html', async () => {
  const fs = makeFs({ '/in/index.md': '# Hello\n' });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<h1>Hello<\/h1>/);
});

test('all four equivalent input forms produce the same output path', async () => {
  for (const layout of [
    { '/in/index.md': '# r\n', '/in/foo.md': '# F\n' },
    { '/in/index.md': '# r\n', '/in/foo.mdx': '# F\n' },
    { '/in/index.md': '# r\n', '/in/foo/index.md': '# F\n' },
    { '/in/index.md': '# r\n', '/in/foo/index.mdx': '# F\n' },
  ]) {
    const fs = makeFs(layout);
    await build({ inputDir: '/in', outputDir: '/out', fs });
    const html = await fs.promises.readFile('/out/foo/index.html', 'utf8');
    assert.match(html, /<h1>F<\/h1>/);
  }
});

test('a build without a root index.md works: children render, no root index.html', async () => {
  const fs = makeFs({ '/in/foo.md': '# F\n' });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/foo/index.html', 'utf8');
  assert.match(html, /<h1>F<\/h1>/);
  assert.equal(fs.existsSync('/out/index.html'), false);
});

test('errors when the input dir contains no page sources at all', async () => {
  const fs = makeFs({ '/in/notes.txt': 'not a page\n' });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /No page sources found in "\/in": create index\.md or index\.mdx there\./,
  );
});

test('compile errors include file path, line/column, and a code frame', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/broken.mdx': '<div',
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', topDir: '/in', fs }),
    (e) => {
      assert.match(e.message, /^Failed to compile "broken\.mdx" \(line 1, column \d+\):/);
      assert.match(e.message, /\n1 \| <div\n {2}\| {5}\^/);
      return true;
    },
  );
});

test('a typo in a {} expression points the caret at the typo', async () => {
  const fs = makeFs({ '/in/index.md': '# Hi {foo.}\n' });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', topDir: '/in', fs }),
    (e) => {
      assert.match(
        e.message,
        /^Failed to compile "index\.md" \(line 1, column 11\): /,
      );
      assert.match(e.message, /\n1 \| # Hi \{foo\.\}\n {2}\| {11}\^/);
      return true;
    },
  );
});

test('a top-level export that throws is reported as an evaluation error, not a compile error', async () => {
  const fs = makeFs({
    '/in/index.md':
      "export const x = (() => { throw new Error('boom from body') })();\n\n# {x}\n",
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', topDir: '/in', fs }),
    (e) => {
      assert.match(e.message, /^Failed to evaluate "index\.md": boom from body/);
      assert.doesNotMatch(e.message, /Failed to compile/);
      assert.equal(e.cause?.message, 'boom from body');
      return true;
    },
  );
});

test('a directory without index.md gets a synthetic node: leaf renders, no dir index.html', async () => {
  const fs = makeFs({
    '/in/index.md':
      '# r\n\n<ul>{childPages.map((c) => <li key={c.name}>{c.title}</li>)}</ul>\n',
    '/in/blog/2020-01-23-first-post.md': '# leaf\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const leaf = await fs.promises.readFile(
    '/out/blog/2020-01-23-first-post/index.html',
    'utf8',
  );
  assert.match(leaf, /<h1>leaf<\/h1>/);
  assert.equal(fs.existsSync('/out/blog/index.html'), false);
  // The synthetic node appears in the root's childPages with title defaults.
  const rootHtml = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(rootHtml, /<li>Blog<\/li>/);
});

test("a synthetic directory node inherits nothing but passes defaultLayout through to its children", async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\ndefaultLayout: base\n---\n# r\n',
    '/top/pages/section/leaf.md': '# leaf\n',
    '/top/_layouts/base.mdx': '<main>{props.children}</main>\n',
  });
  await build({ inputDir: '/top/pages', outputDir: '/out', topDir: '/top', fs });
  const leaf = await fs.promises.readFile('/out/section/leaf/index.html', 'utf8');
  assert.match(leaf, /<main>.*<h1>leaf<\/h1>.*<\/main>/s);
  assert.equal(fs.existsSync('/out/section/index.html'), false);
});

test('errors on collision between two equivalent forms', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/foo.md': '# A\n',
    '/in/foo.mdx': '# B\n',
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /same output path/,
  );
});

test('a deferred asset error reports the call site, layout chain, and page', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\ntitle: Home\nlayout: base\n---\n# Home\n',
    '/top/pages/blog/index.md': '---\ntitle: Blog\nlayout: base\n---\n# Blog\n',
    '/top/_layouts/base.mdx':
      "import {Image} from 'xtatic:image';\n\n" +
      '<html><body>\n\n' +
      "<Image src='./missing.png' alt='x' />\n\n" +
      '{props.children}\n\n</body></html>\n',
  });
  await assert.rejects(
    () => build({ inputDir: '/top/pages', outputDir: '/out', topDir: '/top', fs }),
    (e) => {
      assert.match(e.message, /^<Image>: source not found at \/top\/_layouts\/missing\.png/);
      assert.match(e.message, /\n {2}in <Image> at _layouts\/base\.mdx:5:1/);
      assert.match(e.message, /\n {2}in layout _layouts\/base\.mdx/);
      // The first page reached wins (build walks the tree depth-first).
      assert.match(e.message, /\n {2}while building page \//);
      return true;
    },
  );
});

test('a plain <img> error reports the element and its call site', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\ntitle: Home\nlayout: base\n---\n# Home\n',
    '/top/_layouts/base.mdx':
      '<html><body>\n\n' +
      "<img src='./logo.png' alt='x' />\n\n" +
      '{props.children}\n\n</body></html>\n',
  });
  await assert.rejects(
    () => build({ inputDir: '/top/pages', outputDir: '/out', topDir: '/top', fs }),
    (e) => {
      assert.match(e.message, /^Asset not found at \/top\/_layouts\/logo\.png/);
      assert.match(e.message, /\n {2}in <img> at _layouts\/base\.mdx:3:1/);
      assert.match(e.message, /\n {2}in layout _layouts\/base\.mdx/);
      assert.match(e.message, /\n {2}while building page \//);
      return true;
    },
  );
});

test('a markdown ![]() image error reports <img> and the markdown line', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\ntitle: Home\n---\n# Home\n\n![alt](./pic.png)\n',
  });
  await assert.rejects(
    () => build({ inputDir: '/top/pages', outputDir: '/out', topDir: '/top', fs }),
    (e) => {
      assert.match(e.message, /^Asset not found at \/top\/pages\/pic\.png/);
      assert.match(e.message, /\n {2}in <img> at pages\/index\.md:6:1/);
      return true;
    },
  );
});

test('a synchronous component error in a layout gets the same render-context trace', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\ntitle: Home\nlayout: base\n---\n# Home\n',
    '/top/_layouts/base.mdx':
      "import {Font} from 'xtatic:font';\n\n" +
      '<html><head>\n\n' +
      "<Font src='./Inter.woff2' />\n\n" +
      '</head><body>{props.children}</body></html>\n',
  });
  await assert.rejects(
    () => build({ inputDir: '/top/pages', outputDir: '/out', topDir: '/top', fs }),
    (e) => {
      assert.match(e.message, /requires a non-empty family/);
      assert.match(e.message, /\n {2}in <Font> at _layouts\/base\.mdx:5:1/);
      assert.match(e.message, /\n {2}while building page \//);
      return true;
    },
  );
});

test('a render error shows the offending source line under its frame', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\ntitle: Home\nlayout: base\n---\n# Home\n',
    '/top/_layouts/base.mdx':
      "import {Image} from 'xtatic:image';\n\n" +
      '<html><body>\n\n' +
      "<Image src='./missing.png' alt='x' />\n\n" +
      '{props.children}\n\n</body></html>\n',
  });
  await assert.rejects(
    () => build({ inputDir: '/top/pages', outputDir: '/out', topDir: '/top', fs }),
    (e) => {
      assert.match(e.message, /\n {2}in <Image> at _layouts\/base\.mdx:5:1/);
      // The code frame (indented under the frame) shows the real source line,
      // not just file:line:column.
      assert.match(
        e.message,
        /\n {4}> 5 \| <Image src='\.\/missing\.png' alt='x' \/>/,
      );
      // Caret row marks the column (no-color test env).
      assert.match(e.message, /\n {4} +\| \^/);
      return true;
    },
  );
});

test('a markdown image error shows the markdown source line', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\ntitle: Home\n---\n# Home\n\n![alt](./pic.png)\n',
  });
  await assert.rejects(
    () => build({ inputDir: '/top/pages', outputDir: '/out', topDir: '/top', fs }),
    (e) => {
      assert.match(e.message, /\n {2}in <img> at pages\/index\.md:6:1/);
      assert.match(e.message, /\n {4}> 6 \| !\[alt\]\(\.\/pic\.png\)/);
      return true;
    },
  );
});

test('defaultLayout on the root applies to the root and all descendants', async () => {
  const fs = makeFs({
    '/top/pages/index.md':
      '---\ntitle: Home\ndefaultLayout: layout\n---\n# Home\n',
    '/top/pages/about.md': '---\ntitle: About\n---\n# About me\n',
    '/top/pages/blog/index.md': '---\ntitle: Blog\n---\n# Blog\n',
    '/top/pages/blog/post.md': '---\ntitle: Post\n---\n# Post\n',
    '/top/_layouts/layout.mdx':
      '<html>\n' +
      '<head><title>{props.children.title}</title></head>\n' +
      '<body>{props.children}</body>\n' +
      '</html>\n',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/out',
    topDir: '/top',
    fs,
  });

  for (const [path, title] of [
    ['/out/index.html', 'Home'],
    ['/out/about/index.html', 'About'],
    ['/out/blog/index.html', 'Blog'],
    ['/out/blog/post/index.html', 'Post'],
  ]) {
    const html = await fs.promises.readFile(path, 'utf8');
    assert.match(html, new RegExp(`<title>${title}</title>`));
  }
});

test('a subtree index can set its own defaultLayout that wins for its descendants', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\ndefaultLayout: outer\n---\n# r\n',
    '/top/pages/section/index.md':
      '---\ndefaultLayout: inner\n---\n# S\n',
    '/top/pages/section/page.md': '# P\n',
    '/top/pages/other/index.md': '# O-section\n',
    '/top/pages/other/page.md': '# O\n',
    '/top/_layouts/outer.mdx': '<outer>{props.children}</outer>\n',
    '/top/_layouts/inner.mdx': '<inner>{props.children}</inner>\n',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/out',
    topDir: '/top',
    fs,
  });

  assert.match(
    await fs.promises.readFile('/out/index.html', 'utf8'),
    /<outer><h1>r<\/h1>\s*<\/outer>/,
  );
  assert.match(
    await fs.promises.readFile('/out/section/index.html', 'utf8'),
    /<inner><h1>S<\/h1>\s*<\/inner>/,
  );
  assert.match(
    await fs.promises.readFile('/out/section/page/index.html', 'utf8'),
    /<inner><h1>P<\/h1>\s*<\/inner>/,
  );
  assert.match(
    await fs.promises.readFile('/out/other/page/index.html', 'utf8'),
    /<outer><h1>O<\/h1>\s*<\/outer>/,
  );
});

test('a string layout in frontmatter resolves against layoutsDir (bare name → .mdx)', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\nlayout: blog\n---\n# Hi\n',
    '/top/_layouts/blog.mdx': '<wrap>{props.children}</wrap>\n',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/out',
    topDir: '/top',
    fs,
  });
  assert.match(
    await fs.promises.readFile('/out/index.html', 'utf8'),
    /<wrap><h1>Hi<\/h1>\s*<\/wrap>/,
  );
});

test('a string layout can include an explicit .md or .mdx suffix', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '# r\n',
    '/top/pages/a.md': '---\nlayout: x.md\n---\n# A\n',
    '/top/pages/b.md': '---\nlayout: x.mdx\n---\n# B\n',
    '/top/_layouts/x.md': '<md>{props.children}</md>\n',
    '/top/_layouts/x.mdx': '<mdx>{props.children}</mdx>\n',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/out',
    topDir: '/top',
    fs,
  });
  assert.match(
    await fs.promises.readFile('/out/a/index.html', 'utf8'),
    /<md><h1>A<\/h1>\s*<\/md>/,
  );
  assert.match(
    await fs.promises.readFile('/out/b/index.html', 'utf8'),
    /<mdx><h1>B<\/h1>\s*<\/mdx>/,
  );
});

test('a string layout falls back to .md when .mdx is absent', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\nlayout: only-md\n---\n# Hi\n',
    '/top/_layouts/only-md.md': '<md>{props.children}</md>\n',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/out',
    topDir: '/top',
    fs,
  });
  assert.match(
    await fs.promises.readFile('/out/index.html', 'utf8'),
    /<md><h1>Hi<\/h1>\s*<\/md>/,
  );
});

test('when both .md and .mdx exist for a bare-name layout, .mdx wins', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\nlayout: dup\n---\n# Hi\n',
    '/top/_layouts/dup.md': '<md>{props.children}</md>\n',
    '/top/_layouts/dup.mdx': '<mdx>{props.children}</mdx>\n',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/out',
    topDir: '/top',
    fs,
  });
  assert.match(
    await fs.promises.readFile('/out/index.html', 'utf8'),
    /<mdx><h1>Hi<\/h1>\s*<\/mdx>/,
  );
});

test('a string layout can use a subpath under layoutsDir', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\nlayout: posts/article\n---\n# Hi\n',
    '/top/_layouts/posts/article.mdx': '<post>{props.children}</post>\n',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/out',
    topDir: '/top',
    fs,
  });
  assert.match(
    await fs.promises.readFile('/out/index.html', 'utf8'),
    /<post><h1>Hi<\/h1>\s*<\/post>/,
  );
});

test('a layout loaded by name can itself declare a string layout (chain)', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\nlayout: inner\n---\n# Hi\n',
    '/top/_layouts/inner.mdx':
      '---\nlayout: outer\n---\n<inner>{props.children}</inner>\n',
    '/top/_layouts/outer.mdx': '<outer>{props.children}</outer>\n',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/out',
    topDir: '/top',
    fs,
  });
  assert.match(
    await fs.promises.readFile('/out/index.html', 'utf8'),
    /<outer><inner><h1>Hi<\/h1>\s*<\/inner>\s*<\/outer>/,
  );
});

test('a missing string layout errors with both candidate paths and the requesting page', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\nlayout: missing\n---\n# Hi\n',
  });
  await assert.rejects(
    () =>
      build({
        inputDir: '/top/pages',
        outputDir: '/out',
        topDir: '/top',
        fs,
      }),
    /Layout "missing" \(requested by "index\.md"\) not found: tried .*missing\.mdx and .*missing\.md\./,
  );
});

test('an explicit string layout overrides defaultLayout inherited from an ancestor', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\ndefaultLayout: auto\n---\n# r\n',
    '/top/pages/page.md': '---\nlayout: custom\n---\n# P\n',
    '/top/_layouts/auto.mdx': '<auto>{props.children}</auto>\n',
    '/top/_layouts/custom.mdx': '<custom>{props.children}</custom>\n',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/out',
    topDir: '/top',
    fs,
  });
  assert.match(
    await fs.promises.readFile('/out/page/index.html', 'utf8'),
    /<custom><h1>P<\/h1>\s*<\/custom>/,
  );
});

test('a JSX expression resolves bare identifiers against the module itself (frontmatter)', async () => {
  const fs = makeFs({
    '/in/index.md': '---\ntitle: Hello\n---\n# {title}\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.match(
    await fs.promises.readFile('/out/index.html', 'utf8'),
    /<h1>Hello<\/h1>/,
  );
});

test('a page can iterate over childPages via a bare identifier', async () => {
  const fs = makeFs({
    '/in/index.mdx':
      '<ul>{childPages.map((c) => <li>{c.title}</li>)}</ul>\n',
    '/in/a.md': '---\ntitle: Alpha\n---\nA\n',
    '/in/b.md': '---\ntitle: Beta\n---\nB\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<ul><li>Alpha<\/li><li>Beta<\/li><\/ul>/);
});

test('an arrow parameter shadows would-be self lookups', async () => {
  // The arrow's param `title` shadows the module's `title` frontmatter field
  // — proving param scoping is respected (we are not just blindly destructuring).
  const fs = makeFs({
    '/in/index.mdx':
      '---\ntitle: Outer\n---\n' +
      '<p>{[\'A\',\'B\'].map((title) => title).join(\',\')}</p>\n' +
      '<h2>{title}</h2>\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<p>A,B<\/p>/);
  assert.match(html, /<h2>Outer<\/h2>/);
});

test('a layout sees its own frontmatter via bare identifiers', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '---\nlayout: main\n---\n# Body\n',
    '/top/_layouts/main.mdx':
      '---\nsiteName: My Site\n---\n' +
      '<html><head><title>{siteName}</title></head><body>{props.children}</body></html>\n',
  });
  await build({
    inputDir: '/top/pages',
    outputDir: '/out',
    topDir: '/top',
    fs,
  });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<title>My Site<\/title>/);
  assert.match(html, /<h1>Body<\/h1>/);
});

test('a referenced identifier with no matching module property renders as undefined, not a ReferenceError', async () => {
  const fs = makeFs({
    '/in/index.mdx': '<p>{missingProp ?? \'fallback\'}</p>\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.match(
    await fs.promises.readFile('/out/index.html', 'utf8'),
    /<p>fallback<\/p>/,
  );
});

test('renaming a page removes its old output on the next build', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/old-name.md': '# Old\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.match(
    await fs.promises.readFile('/out/old-name/index.html', 'utf8'),
    /<h1>Old<\/h1>/,
  );

  await fs.promises.rm('/in/old-name.md');
  await fs.promises.writeFile('/in/new-name.md', '# New\n');
  await build({ inputDir: '/in', outputDir: '/out', fs });

  await assert.rejects(
    () => fs.promises.stat('/out/old-name/index.html'),
    (e) => e.code === 'ENOENT',
  );
  assert.match(
    await fs.promises.readFile('/out/new-name/index.html', 'utf8'),
    /<h1>New<\/h1>/,
  );
});

test('deleting a page removes its old output on the next build', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/gone.md': '# G\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.match(
    await fs.promises.readFile('/out/gone/index.html', 'utf8'),
    /<h1>G<\/h1>/,
  );

  await fs.promises.rm('/in/gone.md');
  await build({ inputDir: '/in', outputDir: '/out', fs });

  await assert.rejects(
    () => fs.promises.stat('/out/gone/index.html'),
    (e) => e.code === 'ENOENT',
  );
});

test('first build succeeds when outputDir does not yet exist', async () => {
  const fs = makeFs({ '/in/index.md': '# Hi\n' });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.match(
    await fs.promises.readFile('/out/index.html', 'utf8'),
    /<h1>Hi<\/h1>/,
  );
});

test('outputDir equal to inputDir is rejected', async () => {
  const fs = makeFs({ '/in/index.md': '# r\n' });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/in', fs }),
    /outputDir "\/in" must not be the same as or an ancestor of/,
  );
});

test('outputDir as an ancestor of inputDir is rejected', async () => {
  const fs = makeFs({ '/top/pages/index.md': '# r\n' });
  await assert.rejects(
    () =>
      build({
        inputDir: '/top/pages',
        outputDir: '/top',
        topDir: '/top',
        fs,
      }),
    /outputDir "\/top" must not be the same as or an ancestor of/,
  );
});

test('outputDir of "/" is rejected', async () => {
  const fs = makeFs({ '/in/index.md': '# r\n' });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/', fs }),
    /outputDir must be a non-root directory path/,
  );
});

test('outputPath frontmatter redirects a page to a custom file', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/feed.mdx':
      '---\noutputPath: /feed.xml\nlayout: null\n---\n\n<rss>hi</rss>\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const xml = await fs.promises.readFile('/out/feed.xml', 'utf8');
  assert.match(xml, /<rss>hi<\/rss>/);
  await assert.rejects(() =>
    fs.promises.readFile('/out/feed/index.html', 'utf8'),
  );
});

test('outputPath as a named export also works', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/feed.mdx':
      "export const outputPath = '/feed.xml';\nexport const layout = null;\n\n<rss/>\n",
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const xml = await fs.promises.readFile('/out/feed.xml', 'utf8');
  assert.match(xml, /<rss>/);
});

test('outputPath errors when two pages target the same path', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/a.mdx': '---\noutputPath: /feed.xml\nlayout: null\n---\na\n',
    '/in/b.mdx': '---\noutputPath: /feed.xml\nlayout: null\n---\nb\n',
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /Two pages write to the same output path "\/out\/feed\.xml"/,
  );
});

test('outputPath errors when it collides with a default path', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/foo.mdx': '# F\n',
    '/in/bar.mdx': '---\noutputPath: /foo/index.html\nlayout: null\n---\nb\n',
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /Two pages write to the same output path "\/out\/foo\/index\.html"/,
  );
});

test('outputPath rejects a relative value', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/feed.mdx': '---\noutputPath: feed.xml\nlayout: null\n---\n',
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /Invalid outputPath "feed\.xml".*must be an absolute path starting with "\/"/s,
  );
});

test('outputPath rejects ".." segments', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/feed.mdx':
      '---\noutputPath: /../escape.xml\nlayout: null\n---\n',
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /Invalid outputPath ".*"\s*\(set on page "feed"\): must not contain "\.\." segments\./s,
  );
});

test('outputPath rejects a trailing slash (must name a file)', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/feed.mdx': '---\noutputPath: /feed/\nlayout: null\n---\n',
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /Invalid outputPath "\/feed\/".*naming a file/s,
  );
});

test('shared assets go under a custom assetsDir', async () => {
  const fs = makeFs({
    '/in/index.md': '<img src="/shared.png" alt="s" />\n',
    '/in/other.md': '<img src="/shared.png" alt="s" />\n',
  });
  await fs.promises.writeFile('/in/shared.png', Buffer.alloc(8192, 0xab));
  await build({ inputDir: '/in', outputDir: '/out', assetsDir: 'static', fs });
  const root = await fs.promises.readFile('/out/index.html', 'utf8');
  const m = root.match(/<img src="(static\/[a-f0-9]+\.png)"/);
  assert.ok(m, `expected a static/ URL in: ${root}`);
  assert.equal((await fs.promises.stat(`/out/${m[1]}`)).size, 8192);
  // The default _assets dir is not created when a custom name is configured.
  await assert.rejects(() => fs.promises.stat('/out/_assets'));
});

test('a page colliding with the default assets directory is rejected', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/_assets.md': '# clash\n',
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /Page "_assets" writes to "\/out\/_assets\/index\.html", which is inside the generated assets directory "\/out\/_assets"/,
  );
});

test('a page colliding with a custom assetsDir is rejected', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/static.md': '# clash\n',
  });
  await assert.rejects(
    () =>
      build({ inputDir: '/in', outputDir: '/out', assetsDir: 'static', fs }),
    /Page "static" writes to "\/out\/static\/index\.html", which is inside the generated assets directory "\/out\/static"/,
  );
});

test('a page named _assets is fine once assetsDir is renamed away from it', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/_assets.md': '# fine now\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', assetsDir: 'static', fs });
  assert.match(
    await fs.promises.readFile('/out/_assets/index.html', 'utf8'),
    /fine now/,
  );
});

test('outputPath into the assets directory is rejected', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/sneaky.mdx':
      '---\noutputPath: /_assets/evil.html\nlayout: null\n---\nx\n',
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /Page "sneaky" writes to "\/out\/_assets\/evil\.html", which is inside the generated assets directory/,
  );
});

test('assetsDir containing a slash is rejected', async () => {
  const fs = makeFs({ '/in/index.md': '# r\n' });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', assetsDir: 'a/b', fs }),
    /assetsDir "a\/b" must be a single path segment/,
  );
});

test('an empty assetsDir is rejected', async () => {
  const fs = makeFs({ '/in/index.md': '# r\n' });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', assetsDir: '', fs }),
    /assetsDir must be a non-empty string/,
  );
});

test('a layout can render previous/next links via prevSibling/nextSibling', async () => {
  const fs = makeFs({
    '/top/_layouts/post.mdx':
      '<article>{props.children}</article>\n' +
      '<nav>' +
      '{props.children.prevSibling && <a rel="prev" href={props.children.prevSibling.url}>{props.children.prevSibling.title}</a>}' +
      '{props.children.nextSibling && <a rel="next" href={props.children.nextSibling.url}>{props.children.nextSibling.title}</a>}' +
      '</nav>\n',
    '/top/pages/index.md': '# Home\n',
    '/top/pages/blog/index.md': 'export const defaultLayout = "post"\n\n# Blog\n',
    '/top/pages/blog/2026-01-01-first.md': 'one\n',
    '/top/pages/blog/2026-01-02-second.md': 'two\n',
    '/top/pages/blog/2026-01-03-third.md': 'three\n',
  });
  await build({ inputDir: '/top/pages', outputDir: '/out', topDir: '/top', fs });
  const read = (p) => fs.promises.readFile(p, 'utf8');
  const first = await read('/out/blog/2026-01-01-first/index.html');
  const second = await read('/out/blog/2026-01-02-second/index.html');
  const third = await read('/out/blog/2026-01-03-third/index.html');
  assert.doesNotMatch(first, /rel="prev"/);
  assert.match(first, /<a rel="next" href="\.\.\/2026-01-02-second\/">Second<\/a>/);
  assert.match(second, /<a rel="prev" href="\.\.\/2026-01-01-first\/">First<\/a>/);
  assert.match(second, /<a rel="next" href="\.\.\/2026-01-03-third\/">Third<\/a>/);
  assert.match(third, /<a rel="prev" href="\.\.\/2026-01-02-second\/">Second<\/a>/);
  assert.doesNotMatch(third, /rel="next"/);
});

test('parent and siblings are available as bare identifiers inside a page', async () => {
  const fs = makeFs({
    '/in/index.md': '# Home\n',
    '/in/docs/index.md': '# Docs\n',
    '/in/docs/a.md': '<p>{parent.title}|{nextSibling.name}|{String(prevSibling)}</p>\n',
    '/in/docs/b.md': '<p>{prevSibling.name}</p>\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.match(
    await fs.promises.readFile('/out/docs/a/index.html', 'utf8'),
    /<p>Docs\|b\|undefined<\/p>/,
  );
  assert.match(await fs.promises.readFile('/out/docs/b/index.html', 'utf8'), /<p>a<\/p>/);
});
