import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, createFsFromVolume } from 'memfs';
import { build } from '../src/index.js';

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

async function exists(fs, p) {
  try {
    await fs.promises.stat(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

test('a directory with a _xtatic_verbatim marker is copied byte-for-byte to its mirrored position', async () => {
  const legacyHtml =
    '<!doctype html>\n<html><body><a href="/legacy/feed.xml">feed</a><img src="./img/logo.png"></body></html>\n';
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/legacy/_xtatic_verbatim': '',
    '/in/legacy/page.html': legacyHtml,
    '/in/legacy/feed.xml': '<?xml version="1.0"?><feed/>\n',
    '/in/legacy/deep/notes.md': '# not a page\n',
    '/in/legacy/img/logo.png': 'not really a png',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  // Mirrored positions, no foo/index.html remapping, no attribute rewriting.
  assert.equal(await fs.promises.readFile('/out/legacy/page.html', 'utf8'), legacyHtml);
  assert.equal(
    await fs.promises.readFile('/out/legacy/feed.xml', 'utf8'),
    '<?xml version="1.0"?><feed/>\n',
  );
  assert.equal(
    await fs.promises.readFile('/out/legacy/deep/notes.md', 'utf8'),
    '# not a page\n',
  );
  assert.equal(
    await fs.promises.readFile('/out/legacy/img/logo.png', 'utf8'),
    'not really a png',
  );
  // The .md under the marker did not become a page, and the marker isn't copied.
  assert.equal(await exists(fs, '/out/legacy/deep/notes/index.html'), false);
  assert.equal(await exists(fs, '/out/legacy/page/index.html'), false);
  assert.equal(await exists(fs, '/out/legacy/_xtatic_verbatim'), false);
});

test('verbatim files do not appear in the module tree', async () => {
  const fs = makeFs({
    '/in/index.md': '<ul>{childPages.map((c) => <li>{c.name}</li>)}</ul>\n',
    '/in/about.md': '# about\n',
    '/in/legacy/_xtatic_verbatim': '',
    '/in/legacy/index.html': '<html></html>\n',
    '/in/legacy/old.md': '# old\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.equal(html, '<ul><li>about</li></ul>');
});

test('links from pages to verbatim files resolve to page-relative URLs with the literal filename', async () => {
  const fs = makeFs({
    '/in/index.md':
      '[feed](./legacy/feed.xml)\n\n[home](/in/legacy/index.html#top)\n\n<img src="./legacy/logo.png" alt="l" />\n',
    '/in/docs/intro.md': '[feed](/in/legacy/feed.xml?v=2)\n',
    '/in/hand.html':
      '<html><body><a href="./legacy/feed.xml">f</a><link rel="stylesheet" href="./legacy/site.css"></body></html>\n',
    '/in/legacy/_xtatic_verbatim': '',
    '/in/legacy/feed.xml': '<feed/>',
    '/in/legacy/index.html': '<html></html>',
    '/in/legacy/logo.png': 'png',
    '/in/legacy/site.css': 'body{color:red}',
  });
  await build({ inputDir: '/in', outputDir: '/out', topDir: '/', fs });
  const root = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(root, /<a href="legacy\/feed\.xml">feed<\/a>/);
  // A verbatim index.html gets the same directory-URL cleanup as a page.
  assert.match(root, /<a href="legacy\/#top">home<\/a>/);
  assert.match(root, /<img src="legacy\/logo\.png" alt="l">/);
  const intro = await fs.promises.readFile('/out/docs/intro/index.html', 'utf8');
  assert.match(intro, /<a href="\.\.\/\.\.\/legacy\/feed\.xml\?v=2">feed<\/a>/);
  const hand = await fs.promises.readFile('/out/hand/index.html', 'utf8');
  assert.match(hand, /<a href="\.\.\/legacy\/feed\.xml">f<\/a>/);
  // A stylesheet link to a verbatim .css stays a <link> (no inlining) and is
  // not copied a second time under _assets/.
  assert.match(hand, /<link rel="stylesheet" href="\.\.\/legacy\/site\.css">/);
  assert.equal(await exists(fs, '/out/_assets'), false);
  assert.equal(await fs.promises.readFile('/out/legacy/site.css', 'utf8'), 'body{color:red}');
});

test('a directory link resolves to the index page or verbatim index.html beneath it', async () => {
  const fs = makeFs({
    '/in/index.html':
      '<html><body><a href="legacy/">v</a> <a href="legacy">vbare</a> <a href="docs/#x">d</a> <a href="./hand/">h</a></body></html>\n',
    '/in/docs/index.md': '[up](../) [legacy](/in/legacy/) [hand](../hand)\n',
    '/in/hand/index.html': '<html><body>hand</body></html>\n',
    '/in/legacy/_xtatic_verbatim': '',
    '/in/legacy/index.html': '<html></html>',
    '/in/legacy/sub/index.html': '<html>sub</html>',
    '/in/other.md': '[sub](./legacy/sub/)\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', topDir: '/', fs });
  const root = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(root, /<a href="legacy\/">v<\/a>/);
  assert.match(root, /<a href="legacy\/">vbare<\/a>/);
  assert.match(root, /<a href="docs\/#x">d<\/a>/);
  assert.match(root, /<a href="hand\/">h<\/a>/);
  const docs = await fs.promises.readFile('/out/docs/index.html', 'utf8');
  assert.match(docs, /<a href="\.\.\/">up<\/a>/);
  assert.match(docs, /<a href="\.\.\/legacy\/">legacy<\/a>/);
  assert.match(docs, /<a href="\.\.\/hand\/">hand<\/a>/);
  const other = await fs.promises.readFile('/out/other/index.html', 'utf8');
  assert.match(other, /<a href="\.\.\/legacy\/sub\/">sub<\/a>/);
  // Nothing was copied as an asset.
  assert.equal(await exists(fs, '/out/_assets'), false);
});

test('a directory link with no index page beneath it is a clear error', async () => {
  const fs = makeFs({
    '/in/index.md': '[bad](./legacy/nothing/)\n',
    '/in/legacy/_xtatic_verbatim': '',
    '/in/legacy/nothing/feed.xml': '<feed/>',
  });
  await assert.rejects(
    build({ inputDir: '/in', outputDir: '/out', topDir: '/', fs }),
    /"\.\/legacy\/nothing\/" is a directory with no index page/,
  );
});

test('a page and a verbatim file writing to the same output path is an error', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/about.md': '# about\n',
    '/in/about/_xtatic_verbatim': '',
    '/in/about/index.html': '<html></html>\n',
  });
  await assert.rejects(
    build({ inputDir: '/in', outputDir: '/out', fs }),
    /Two sources write to the same output path "\/out\/about\/index\.html": verbatim file "about\/index\.html" and "about"/,
  );
});

test('a verbatim file may not land inside the assets directory', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/_assets/_xtatic_verbatim': '',
    '/in/_assets/x.txt': 'x',
  });
  await assert.rejects(
    build({ inputDir: '/in', outputDir: '/out', fs }),
    /Verbatim file "_assets\/x\.txt" writes to "\/out\/_assets\/x\.txt", which is inside the generated assets directory/,
  );
});

test('nested markers are harmless and {placeholder} filenames are literal under a marker', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/v/_xtatic_verbatim': '',
    '/in/v/tag-{tag}.md': 'literal\n',
    '/in/v/inner/_xtatic_verbatim': '',
    '/in/v/inner/a.txt': 'a',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.equal(await fs.promises.readFile('/out/v/tag-{tag}.md', 'utf8'), 'literal\n');
  assert.equal(await fs.promises.readFile('/out/v/inner/a.txt', 'utf8'), 'a');
  assert.equal(await exists(fs, '/out/v/inner/_xtatic_verbatim'), false);
});

test('a marker at the input root leaves no page sources', async () => {
  const fs = makeFs({
    '/in/_xtatic_verbatim': '',
    '/in/index.md': '# root\n',
  });
  await assert.rejects(
    build({ inputDir: '/in', outputDir: '/out', fs }),
    /No page sources found/,
  );
});

test('verbatim output is pruned and refreshed across rebuilds', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/v/_xtatic_verbatim': '',
    '/in/v/a.txt': 'a1',
    '/in/v/b.txt': 'b',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.equal(await fs.promises.readFile('/out/v/b.txt', 'utf8'), 'b');
  await fs.promises.writeFile('/in/v/a.txt', 'a2');
  await fs.promises.unlink('/in/v/b.txt');
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.equal(await fs.promises.readFile('/out/v/a.txt', 'utf8'), 'a2');
  assert.equal(await exists(fs, '/out/v/b.txt'), false);
  // Removing the marker turns the directory back into ordinary input: the
  // stale verbatim copy is pruned and nothing references a.txt any more.
  await fs.promises.unlink('/in/v/_xtatic_verbatim');
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.equal(await exists(fs, '/out/v/a.txt'), false);
});

test('a marker with pattern lines makes only the matching files verbatim', async () => {
  const fs = makeFs({
    '/in/_xtatic_verbatim': '# root-level files the browser fetches by name\nfavicon.ico\n*.gif\n/robots.txt\nnotes.md\n',
    '/in/index.md': '# root\n',
    '/in/about.md': '# about\n',
    '/in/notes.md': '# copied literally\n',
    '/in/favicon.ico': 'ico',
    '/in/bg.gif': 'gif',
    '/in/robots.txt': 'User-agent: *\n',
    '/in/docs/robots.txt': 'nested, not anchored\n',
    '/in/docs/deep/anim.gif': 'gif2',
    '/in/docs/index.md': '# docs\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  // Pages in a pattern-marked directory are still pages.
  assert.match(await fs.promises.readFile('/out/index.html', 'utf8'), /root/);
  assert.match(await fs.promises.readFile('/out/about/index.html', 'utf8'), /about/);
  assert.match(await fs.promises.readFile('/out/docs/index.html', 'utf8'), /docs/);
  // Matching files land at their literal positions, unprocessed.
  assert.equal(await fs.promises.readFile('/out/favicon.ico', 'utf8'), 'ico');
  assert.equal(await fs.promises.readFile('/out/bg.gif', 'utf8'), 'gif');
  assert.equal(await fs.promises.readFile('/out/robots.txt', 'utf8'), 'User-agent: *\n');
  assert.equal(await fs.promises.readFile('/out/notes.md', 'utf8'), '# copied literally\n');
  assert.equal(await exists(fs, '/out/notes/index.html'), false);
  // Unanchored patterns apply at any depth below the marker; anchored ones
  // only at the marker's own directory.
  assert.equal(await fs.promises.readFile('/out/docs/deep/anim.gif', 'utf8'), 'gif2');
  assert.equal(await exists(fs, '/out/docs/robots.txt'), false);
  assert.equal(await exists(fs, '/out/_xtatic_verbatim'), false);
});

test('a directory pattern copies the whole subtree; a nested empty marker still means everything', async () => {
  const fs = makeFs({
    '/in/_xtatic_verbatim': 'legacy/\n',
    '/in/index.md': '# root\n',
    '/in/legacy/page.md': '# not a page\n',
    '/in/legacy/sub/x.txt': 'x',
    '/in/other/_xtatic_verbatim': '\n\n# nothing but comments\n',
    '/in/other/y.md': '# also not a page\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  assert.equal(await fs.promises.readFile('/out/legacy/page.md', 'utf8'), '# not a page\n');
  assert.equal(await fs.promises.readFile('/out/legacy/sub/x.txt', 'utf8'), 'x');
  assert.equal(await fs.promises.readFile('/out/other/y.md', 'utf8'), '# also not a page\n');
  assert.equal(await exists(fs, '/out/legacy/page/index.html'), false);
  assert.equal(await exists(fs, '/out/other/y/index.html'), false);
});

test('an html page can reference pattern-verbatim files from inline CSS and <link rel=icon>', async () => {
  // The motivating case: a hand-written index.html with a background image in
  // an inline stylesheet, plus a favicon the browser fetches at /favicon.ico
  // without any reference in the document.
  const fs = makeFs({
    '/in/_xtatic_verbatim': 'favicon.ico\nbg.gif\n',
    '/in/index.html':
      '<!doctype html>\n<html><head><link rel="icon" href="favicon.ico">\n<style>body{background:url(bg.gif)}</style></head><body>hi</body></html>\n',
    '/in/favicon.ico': 'ico',
    '/in/bg.gif': 'gif',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<link rel="icon" href="favicon\.ico">/);
  assert.match(html, /body\{background:url\("bg\.gif"\)\}/);
  assert.equal(await fs.promises.readFile('/out/favicon.ico', 'utf8'), 'ico');
  assert.equal(await fs.promises.readFile('/out/bg.gif', 'utf8'), 'gif');
  assert.equal(await exists(fs, '/out/_assets'), false);
});

test('a pattern-verbatim file colliding with a page output path is an error', async () => {
  const fs = makeFs({
    '/in/_xtatic_verbatim': 'about/index.html\n',
    '/in/index.md': '# root\n',
    '/in/about.md': '# about\n',
    '/in/about/index.html': '<html></html>\n',
  });
  await assert.rejects(
    build({ inputDir: '/in', outputDir: '/out', fs }),
    /Two sources write to the same output path "\/out\/about\/index\.html": verbatim file "about\/index\.html" and "about"/,
  );
});

test('verbatimMarker renames the marker file; the default name is then just a file', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/legacy/.keep': '',
    '/in/legacy/old.md': '# old\n',
    // The default name is not special under a custom marker.
    '/in/other/_xtatic_verbatim': '',
    '/in/other/page.md': '# page\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', verbatimMarker: '.keep', fs });
  assert.equal(await fs.promises.readFile('/out/legacy/old.md', 'utf8'), '# old\n');
  assert.equal(await exists(fs, '/out/legacy/.keep'), false);
  assert.equal(await exists(fs, '/out/legacy/old/index.html'), false);
  assert.equal(await exists(fs, '/out/other/page/index.html'), true);
  // Not a marker, not a page source, not referenced: pruned like any stray file.
  assert.equal(await exists(fs, '/out/other/_xtatic_verbatim'), false);
});

test('an invalid verbatimMarker is rejected', async () => {
  const fs = makeFs({ '/in/index.md': '# root\n' });
  await assert.rejects(
    build({ inputDir: '/in', outputDir: '/out', verbatimMarker: 'a/b', fs }),
    /verbatimMarker must be a single file name/,
  );
  await assert.rejects(
    build({ inputDir: '/in', outputDir: '/out', verbatimMarker: '', fs }),
    /verbatimMarker must be a non-empty string/,
  );
});
