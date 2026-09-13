import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, createFsFromVolume } from 'memfs';
import { build } from '../src/index.js';
import { createAssetRegistry } from '../src/assets.js';
import { createPlainAssetRegistry } from '../src/assets-plain.js';

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

function bytes(n, fill = 0xab) {
  return Buffer.alloc(n, fill);
}

test('plain <img src> with small file inlines as data: URL', async () => {
  const fs = makeFs({
    '/in/index.md': '<img src="./tiny.png" alt="t" />\n',
  });
  await fs.promises.writeFile('/in/tiny.png', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="t">/);
});

test('plain <img src> with large file used by one page co-locates', async () => {
  const fs = makeFs({
    '/in/index.md': '<img src="./big.png" alt="b" />\n',
  });
  await fs.promises.writeFile('/in/big.png', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="big\.png" alt="b">/);
  const stat = await fs.promises.stat('/out/big.png');
  assert.equal(stat.size, 8192);
});

test('co-location mirrors the inputDir-relative path when inputDir is below topDir', async () => {
  // Regression: placement used to mirror the topDir-relative path
  // (`out/pages/foo/big.png`), which is never under the page's own output dir
  // (`out/foo/`), so co-location silently never fired under the default
  // `pages/` layout and every large single-page asset went to _assets/.
  const fs = makeFs({
    '/top/pages/index.md': '# home\n',
    '/top/pages/foo/index.md': '<img src="./big.png" alt="b" />\n',
  });
  await fs.promises.writeFile('/top/pages/foo/big.png', bytes(8192));
  await build({ inputDir: '/top/pages', outputDir: '/out', topDir: '/top', fs });
  const html = await fs.promises.readFile('/out/foo/index.html', 'utf8');
  assert.match(html, /<img src="big\.png" alt="b">/);
  const stat = await fs.promises.stat('/out/foo/big.png');
  assert.equal(stat.size, 8192);
  assert.equal(fs.existsSync('/out/_assets'), false);
  assert.equal(fs.existsSync('/out/pages'), false);
});

test('an asset outside inputDir is never co-located, even when used by one page', async () => {
  const fs = makeFs({
    '/top/pages/index.md': '<img src="/assets/big.png" alt="b" />\n',
  });
  await fs.promises.mkdir('/top/assets', { recursive: true });
  await fs.promises.writeFile('/top/assets/big.png', bytes(8192));
  await build({ inputDir: '/top/pages', outputDir: '/out', topDir: '/top', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="_assets\/[a-f0-9]+\.png" alt="b">/);
  await assert.rejects(
    build({
      inputDir: '/top/pages',
      outputDir: '/out',
      topDir: '/top',
      fs: makeFs({
        '/top/pages/index.md':
          '<img src="/assets/big.png" alt="b" data-xtatic-placement="co-located" />\n',
        '/top/assets/big.png': bytes(8192).toString('latin1'),
      }),
    }),
    /co-located/,
  );
});

test('plain <img src> with large file used by multiple pages goes to _assets', async () => {
  const fs = makeFs({
    '/in/index.md': '<img src="/shared.png" alt="s" />\n',
    '/in/other.md': '<img src="/shared.png" alt="s" />\n',
  });
  await fs.promises.writeFile('/in/shared.png', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', topDir: '/in', fs });
  const root = await fs.promises.readFile('/out/index.html', 'utf8');
  const other = await fs.promises.readFile('/out/other/index.html', 'utf8');
  const m1 = root.match(/<img src="(_assets\/[a-f0-9]+\.png)"/);
  const m2 = other.match(/<img src="(\.\.\/_assets\/[a-f0-9]+\.png)"/);
  assert.ok(m1, `expected _assets URL in: ${root}`);
  assert.ok(m2, `expected _assets URL in: ${other}`);
  assert.equal(m1[1].split('/').pop(), m2[1].split('/').pop());
  const assets = await fs.promises.readdir('/out/_assets');
  assert.equal(assets.length, 1);
});

test('markdown image syntax goes through the asset pipeline', async () => {
  const fs = makeFs({
    '/in/index.md': '![alt text](./tiny.png)\n',
  });
  await fs.promises.writeFile('/in/tiny.png', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="data:image\/png;base64,/);
  assert.match(html, /alt="alt text"/);
});

test('passthrough URLs are not processed', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<img src="https://example.com/x.png" alt="a" />\n' +
      '<img src="data:image/png;base64,AAAA" alt="b" />\n' +
      '<img src="//cdn/y.png" alt="c" />\n' +
      '<img src="#frag" alt="d" />\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /src="https:\/\/example\.com\/x\.png"/);
  assert.match(html, /src="data:image\/png;base64,AAAA"/);
  assert.match(html, /src="\/\/cdn\/y\.png"/);
  assert.match(html, /src="#frag"/);
});

test('data-xtatic-placement="inline" forces inline regardless of size', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<img src="./big.png" alt="b" data-xtatic-placement="inline" />\n',
  });
  await fs.promises.writeFile('/in/big.png', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="data:image\/png;base64,/);
  assert.doesNotMatch(html, /data-xtatic-placement/);
});

test('data-xtatic-placement="shared" forces _assets even when small', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<img src="./tiny.png" alt="t" data-xtatic-placement="shared" />\n',
  });
  await fs.promises.writeFile('/in/tiny.png', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="_assets\/[a-f0-9]+\.png"/);
  assert.doesNotMatch(html, /data-xtatic-placement/);
});

test('data-xtatic-placement="co-located" forces co-location when viable', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<img src="./tiny.png" alt="t" data-xtatic-placement="co-located" />\n',
  });
  await fs.promises.writeFile('/in/tiny.png', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="tiny\.png"/);
  const stat = await fs.promises.stat('/out/tiny.png');
  assert.equal(stat.size, 10);
});

test('data-xtatic-placement="co-located" throws when not viable', async () => {
  const fs = makeFs({
    '/in/posts/index.md': '# posts\n',
    '/in/posts/p.md':
      '<img src="/shared.png" alt="x" data-xtatic-placement="co-located" />\n',
    '/in/index.md': '# root\n',
  });
  await fs.promises.writeFile('/in/shared.png', bytes(10));
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', topDir: '/in', fs }),
    /Cannot co-locate/,
  );
});

test('asset not found gives a clear error', async () => {
  const fs = makeFs({
    '/in/index.md': '<img src="./missing.png" alt="x" />\n',
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', fs }),
    /Asset not found.*missing\.png/,
  );
});

test('co-located URL inside a nested page dir uses subdir-relative path', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/posts/index.md': '# posts\n',
    '/in/posts/2024-01-01/index.md':
      '<img src="./img/cover.png" alt="c" />\n',
  });
  await fs.promises.mkdir('/in/posts/2024-01-01/img', { recursive: true });
  await fs.promises.writeFile('/in/posts/2024-01-01/img/cover.png', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile(
    '/out/posts/2024-01-01/index.html',
    'utf8',
  );
  assert.match(html, /<img src="img\/cover\.png"/);
  const stat = await fs.promises.stat('/out/posts/2024-01-01/img/cover.png');
  assert.equal(stat.size, 8192);
});

test('asset in a parent dir of the page falls back to shared _assets', async () => {
  const fs = makeFs({
    '/in/index.md': '# r\n',
    '/in/posts/index.md': '# posts\n',
    '/in/posts/2024-01-01/index.md':
      '<img src="../cover.png" alt="c" />\n',
  });
  await fs.promises.writeFile('/in/posts/cover.png', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile(
    '/out/posts/2024-01-01/index.html',
    'utf8',
  );
  assert.match(html, /<img src="\.\.\/\.\.\/_assets\/[a-f0-9]+\.png"/);
});

test('dynamic <img src={var}> classifies at runtime', async () => {
  const fs = makeFs({
    '/in/index.md':
      "export const a = './tiny.png';\nexport const b = 'https://x/y.png';\n\n" +
      '<img src={a} alt="a" />\n<img src={b} alt="b" />\n',
  });
  await fs.promises.writeFile('/in/tiny.png', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="data:image\/png;base64,[^"]+" alt="a">/);
  assert.match(html, /<img src="https:\/\/x\/y\.png" alt="b">/);
});

test('<script src> is processed', async () => {
  const fs = makeFs({
    '/in/index.md': '<script src="./app.js"></script>\n',
  });
  await fs.promises.writeFile('/in/app.js', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<script src="app\.js"><\/script>/);
});

test('<link rel="stylesheet"> is processed', async () => {
  const fs = makeFs({
    '/in/index.md': '<link rel="stylesheet" href="./big.css" />\n',
  });
  await fs.promises.writeFile('/in/big.css', bytes(8192, 0x20));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<link rel="stylesheet" href="big\.css">/);
});

test('<link rel="icon"> is processed', async () => {
  const fs = makeFs({
    '/in/index.md': '<link rel="icon" href="./favicon.ico" />\n',
  });
  await fs.promises.writeFile('/in/favicon.ico', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<link rel="icon" href="data:image\/x-icon;base64,/);
});

test('<link rel="canonical"> is NOT processed (not an asset rel)', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<link rel="canonical" href="https://example.com/page" />\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<link rel="canonical" href="https:\/\/example\.com\/page">/);
});

test('<link> with shorthand "shortcut icon" rel is processed', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<link rel="shortcut icon" href="./favicon.ico" />\n',
  });
  await fs.promises.writeFile('/in/favicon.ico', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /href="data:image\/x-icon;base64,/);
});

test('<video src> and <video poster> are both processed', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<video src="./clip.mp4" poster="./thumb.png"></video>\n',
  });
  await fs.promises.writeFile('/in/clip.mp4', bytes(8192));
  await fs.promises.writeFile('/in/thumb.png', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /src="clip\.mp4"/);
  assert.match(html, /poster="data:image\/png;base64,/);
});

test('<source src> and <audio src> are processed', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<audio><source src="./song.ogg" type="audio/ogg" /></audio>\n' +
      '<audio src="./alt.mp3"></audio>\n',
  });
  await fs.promises.writeFile('/in/song.ogg', bytes(10));
  await fs.promises.writeFile('/in/alt.mp3', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<source src="data:audio\/ogg;base64,/);
  assert.match(html, /<audio src="data:audio\/mpeg;base64,/);
});

test('CSS via plain <link> has its url() refs rewritten', async () => {
  const fs = makeFs({
    '/in/index.md': '<link rel="stylesheet" href="./main.css" />\n',
    '/in/main.css': ".bg { background: url('./bg.png'); }",
  });
  await fs.promises.writeFile('/in/bg.png', bytes(8192));
  await build({
    inputDir: '/in',
    outputDir: '/out',
    topDir: '/in',
    fs,
    assetInlineThreshold: 0,
  });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  const linkHref = html.match(/href="([^"]+)"/)[1];
  const cssPath = linkHref.startsWith('/')
    ? `/out${linkHref}`
    : `/out/${linkHref}`;
  const cssOut = await fs.promises.readFile(cssPath, 'utf8');
  // The CSS is co-located at /out/main.css, so its url() ref to the shared
  // asset is relative to /out: `_assets/<hash>.png`.
  const urlMatch = cssOut.match(/url\("(_assets\/[a-f0-9]+\.png)"\)/);
  assert.ok(urlMatch, `expected rewritten url in: ${cssOut}`);
  const referenced = await fs.promises.stat(`/out/${urlMatch[1]}`);
  assert.equal(referenced.size, 8192);
});

test('CSS via plain <link> with topDir-absolute url() resolves against topDir', async () => {
  const fs = makeFs({
    '/in/index.md': '<link rel="stylesheet" href="/css/main.css" />\n',
    '/in/css/main.css': ".bg { background: url('/img/hero.png'); }",
  });
  await fs.promises.mkdir('/in/img', { recursive: true });
  await fs.promises.writeFile('/in/img/hero.png', bytes(8192));
  await build({
    inputDir: '/in',
    outputDir: '/out',
    topDir: '/in',
    fs,
    assetInlineThreshold: 0,
  });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  const linkHref = html.match(/href="([^"]+)"/)[1];
  const cssPath = linkHref.startsWith('/')
    ? `/out${linkHref}`
    : `/out/${linkHref}`;
  const cssOut = await fs.promises.readFile(cssPath, 'utf8');
  // The CSS is co-located at /out/css/main.css, so the shared asset (in
  // /out/_assets/) is reached one level up: `../_assets/<hash>.png`.
  assert.match(cssOut, /url\("\.\.\/_assets\/[a-f0-9]+\.png"\)/);
});

test('inline CSS via <link rel=stylesheet> renders as <style>, with url() refs rewritten', async () => {
  const fs = makeFs({
    '/in/index.md': '<link rel="stylesheet" href="./main.css" />\n',
    '/in/main.css': ".bg { background: url('./bg.png'); }",
  });
  await fs.promises.writeFile('/in/bg.png', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', topDir: '/in', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(m, `expected inline <style> in: ${html}`);
  assert.match(m[1], /url\("_assets\/[a-f0-9]+\.png"\)/);
  assert.doesNotMatch(html, /data:text\/css/);
  assert.doesNotMatch(html, /<link\b[^>]*\bhref="\.\/main\.css"/);
});

test('inline CSS via <link rel=stylesheet media="print"> carries media to <style>', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<link rel="stylesheet" media="print" href="./print.css" />\n',
    '/in/print.css': '.p { color: red; }',
  });
  await build({ inputDir: '/in', outputDir: '/out', topDir: '/in', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<style media="print">\.p \{ color: red; \}<\/style>/);
});

test('explicit data-xtatic-placement="inline" on <link rel=stylesheet> still becomes <style>', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<link rel="stylesheet" href="./big.css" data-xtatic-placement="inline" />\n',
  });
  await fs.promises.writeFile('/in/big.css', bytes(8192, 0x20));
  await build({ inputDir: '/in', outputDir: '/out', topDir: '/in', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<style>[ ]+<\/style>/);
  assert.doesNotMatch(html, /<link\b/);
});

test('CSS missing url() ref surfaces a clear error', async () => {
  const fs = makeFs({
    '/in/index.md': '<link rel="stylesheet" href="./main.css" />\n',
    '/in/main.css': ".bg { background: url('./missing.png'); }",
  });
  await assert.rejects(
    () => build({ inputDir: '/in', outputDir: '/out', topDir: '/in', fs }),
    /Asset url\("\.\/missing\.png"\) not found/,
  );
});

test('plain <img src> in a .jsx component goes through the asset pipeline', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import Pic from './pic.jsx';\n\n<Pic />\n",
    '/in/pic.jsx':
      "export default function Pic() {\n" +
      "  return <img src='./tiny.png' alt='t' />;\n" +
      "}\n",
  });
  await fs.promises.writeFile('/in/tiny.png', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="data:image\/png;base64,/);
});

test('escape hatch works inside .jsx', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import Pic from './pic.jsx';\n\n<Pic />\n",
    '/in/pic.jsx':
      "export default function Pic() {\n" +
      "  return <img src='./big.png' alt='b' data-xtatic-placement='inline' />;\n" +
      "}\n",
  });
  await fs.promises.writeFile('/in/big.png', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<img src="data:image\/png;base64,/);
  assert.doesNotMatch(html, /data-xtatic-placement/);
});

test('asset builtin emits an asset and returns its URL', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {asset} from 'xtatic:builtins';\n\n" +
      "<a href={asset('./report.pdf')}>report</a>\n",
  });
  await fs.promises.writeFile('/in/report.pdf', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<a href="report\.pdf">report<\/a>/);
});

test('asset builtin supports the placement option', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import {asset} from 'xtatic:builtins';\n\n" +
      "<a href={asset('./big.pdf', {placement: 'inline'})}>x</a>\n",
  });
  await fs.promises.writeFile('/in/big.pdf', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /href="data:application\/pdf;base64,/);
});

test('respects assetInlineThreshold config', async () => {
  const fs = makeFs({
    '/in/index.md': '<img src="./mid.png" alt="m" />\n',
  });
  await fs.promises.writeFile('/in/mid.png', bytes(100));
  await build({
    inputDir: '/in',
    outputDir: '/out',
    fs,
    assetInlineThreshold: 50,
  });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.doesNotMatch(html, /data:image/);
});

// ---- <a href> / <area href> page-link rewriting ----

test('plain <a href> to another page rewrites to its output URL', async () => {
  const fs = makeFs({
    '/in/index.md': '<a href="./about.md">About</a>\n',
    '/in/about.md': '# About\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<a href="about\/">About<\/a>/);
});

test('markdown link syntax to another page is rewritten', async () => {
  const fs = makeFs({
    '/in/index.md': '[About](./about.md)\n',
    '/in/about.md': '# About\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<a href="about\/">About<\/a>/);
});

test('a /-rooted link from a nested page resolves relative to the page', async () => {
  const fs = makeFs({
    '/in/index.md': 'root\n',
    '/in/blog/index.md': 'blog\n',
    '/in/blog/post.md': '<a href="/index.md">Home</a>\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', topDir: '/in', fs });
  const html = await fs.promises.readFile('/out/blog/post/index.html', 'utf8');
  // /out/blog/post/index.html → /out/index.html  ⇒ ../../
  assert.match(html, /<a href="\.\.\/\.\.\/">Home<\/a>/);
});

test('a link between sibling pages resolves relatively', async () => {
  const fs = makeFs({
    '/in/index.md': 'root\n',
    '/in/a.md': '<a href="./b.md">to b</a>\n',
    '/in/b.md': 'b\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/a/index.html', 'utf8');
  // Source siblings a.md/b.md, but each renders to its own dir, so the
  // output link is ../b/ — the input→output path translation this provides.
  assert.match(html, /<a href="\.\.\/b\/">to b<\/a>/);
});

test('a link fragment is preserved through rewriting', async () => {
  const fs = makeFs({
    '/in/index.md': '<a href="./about.md#install">Install</a>\n',
    '/in/about.md': '# About\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<a href="about\/#install">Install<\/a>/);
});

test('a link to a non-page file is copied like an asset', async () => {
  const fs = makeFs({
    '/in/index.md': '<a href="./report.pdf">Download</a>\n',
  });
  await fs.promises.writeFile('/in/report.pdf', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<a href="report\.pdf">Download<\/a>/);
  const stat = await fs.promises.stat('/out/report.pdf');
  assert.equal(stat.size, 8192);
});

test('a link to an outputPath-override page links the real file', async () => {
  const fs = makeFs({
    '/in/index.md': '<a href="./feed.md">Feed</a>\n',
    '/in/feed.md':
      '---\noutputPath: /feed.xml\nlayout: null\n---\n\n<rss></rss>\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<a href="feed\.xml">Feed<\/a>/);
});

test('passthrough hrefs (mailto, http, anchors) are left untouched', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<a href="mailto:x@y.z">mail</a>\n\n' +
      '<a href="https://example.com">ext</a>\n\n' +
      '<a href="#top">top</a>\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /href="mailto:x@y\.z"/);
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /href="#top"/);
});

test('any scheme-prefixed href (javascript:, sms:, blob:) passes through', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<a href="javascript:void(0)">js</a>\n\n' +
      '<a href="sms:+15555550100">sms</a>\n\n' +
      '<a href="blob:https://example.com/abc">blob</a>\n\n' +
      '<a href="./a:b.pdf">colon-in-path</a>\n',
    '/in/a:b.pdf': 'pdf',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /href="javascript:void\(0\)"/);
  assert.match(html, /href="sms:\+15555550100"/);
  assert.match(html, /href="blob:https:\/\/example\.com\/abc"/);
  // a relative path containing a colon is still resolved as a file
  assert.match(html, /href="data:application\/pdf;base64,/);
});

test('plain <area href> to another page is rewritten', async () => {
  const fs = makeFs({
    '/in/index.md':
      '<map><area href="./about.md" shape="rect" /></map>\n',
    '/in/about.md': '# About\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<area href="about\/"/);
});

// ---- page.url property (linking to pages, e.g. iterating childPages) ----

test('page.url links each childPages entry to its output URL', async () => {
  const fs = makeFs({
    '/in/index.md': '{childPages.map(p => <a href={p.url}>{p.name}</a>)}\n',
    '/in/a.md': '# A\n',
    '/in/b.md': '# B\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<a href="a\/">a<\/a>/);
  assert.match(html, /<a href="b\/">b<\/a>/);
});

test('page.url resolves relative to the linking page when nested', async () => {
  const fs = makeFs({
    '/in/index.md': 'root\n',
    '/in/blog/index.md': '{childPages.map(p => <a href={p.url}>{p.name}</a>)}\n',
    '/in/blog/first.md': '# First\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/blog/index.html', 'utf8');
  // /out/blog/index.html → /out/blog/first/index.html ⇒ first/
  assert.match(html, /<a href="first\/">first<\/a>/);
});

test('page.url is a token that resolves outside whitelisted attrs', async () => {
  const fs = makeFs({
    '/in/index.md': '<span data-url={childPages[0].url} />\n',
    '/in/a.md': '# A\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /data-url="a\/"/);
});

test('page.url honors outputPath overrides on the target page', async () => {
  const fs = makeFs({
    '/in/index.md': '{childPages.map(p => <a href={p.url}>{p.name}</a>)}\n',
    '/in/feed.md':
      "export const outputPath = '/feed.xml';\n\n# Feed\n",
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<a href="feed\.xml">feed<\/a>/);
});

test('a page can self-link via the bare url identifier', async () => {
  const fs = makeFs({
    '/in/index.md': 'root\n',
    '/in/about.md': '<a href={url}>self</a>\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/about/index.html', 'utf8');
  // about/index.html linking to itself ⇒ ./
  assert.match(html, /<a href="\.\/">self<\/a>/);
});

// ---- cssForPage seam (consumed by the font-cascade engine in commit 3+) ----

// Builds a registry, runs an `asset(value, opts)` call, scans the resulting
// token in a synthetic page, runs processAll, and returns the cssForPage
// output for an html containing the token.
async function setupPlainAsset({ files, calls }) {
  const fs = makeFs(files);
  const assetRegistry = createAssetRegistry({ fs, outputDir: '/out' });
  const plainAssetRegistry = createPlainAssetRegistry({
    fs,
    topDir: '/in',
    outputDir: '/out',
    assetRegistry,
  });
  const asset = plainAssetRegistry.forImporter('/in/page.mdx');
  const tokens = calls.map((c) => asset(c.value, c.opts));
  // Make a page that references every token, so they all get processed.
  const pageHtml = tokens.join('');
  await plainAssetRegistry.processAll([
    { outPath: '/out/index.html', html: pageHtml },
  ]);
  return { plainAssetRegistry, tokens, pageHtml };
}

test('plain-asset cssForPage returns CSS for stylesheet-kind tokens', async () => {
  const { plainAssetRegistry, tokens } = await setupPlainAsset({
    files: { '/in/a.css': '.a { color: red; }' },
    calls: [{ value: './a.css', opts: { kind: 'stylesheet' } }],
  });
  assert.deepEqual(plainAssetRegistry.cssForPage(tokens[0]), [
    '.a { color: red; }',
  ]);
});

test('plain-asset cssForPage excludes non-stylesheet tokens (e.g. img)', async () => {
  const { plainAssetRegistry, tokens } = await setupPlainAsset({
    files: { '/in/pic.png': 'PNGBYTES' },
    calls: [{ value: './pic.png', opts: {} }],
  });
  assert.deepEqual(plainAssetRegistry.cssForPage(tokens[0]), []);
});

test('plain-asset cssForPage excludes .css refs with non-stylesheet kind', async () => {
  // A <link rel="preload" as="style" href="x.css"> doesn't get kind:'stylesheet'
  // from recma-assets — it's a preload, not a stylesheet at parse time.
  const { plainAssetRegistry, tokens } = await setupPlainAsset({
    files: { '/in/a.css': '.a {}' },
    calls: [{ value: './a.css', opts: {} }],
  });
  assert.deepEqual(plainAssetRegistry.cssForPage(tokens[0]), []);
});

test('plain-asset cssForPage dedupes by source', async () => {
  const { plainAssetRegistry, tokens } = await setupPlainAsset({
    files: { '/in/a.css': '.a {}' },
    calls: [
      { value: './a.css', opts: { kind: 'stylesheet' } },
      { value: './a.css', opts: { kind: 'stylesheet' } },
    ],
  });
  const result = plainAssetRegistry.cssForPage(tokens.join(''));
  assert.equal(result.length, 1);
  assert.equal(result[0], '.a {}');
});

test('plain-asset cssForPage returns [] when no asset tokens appear in html', async () => {
  const { plainAssetRegistry } = await setupPlainAsset({
    files: { '/in/a.css': '.a {}' },
    calls: [{ value: './a.css', opts: { kind: 'stylesheet' } }],
  });
  assert.deepEqual(plainAssetRegistry.cssForPage('<p>no tokens here</p>'), []);
});

test('plain-asset cssForPage reflects rewritten url() refs in the CSS', async () => {
  // The CSS contains url('./pic.png') which css-urls rewrites to an emit
  // placeholder (resolved to a relative URL only at write time); cssForPage
  // exposes that placeholder form, which is all the font cascade needs.
  const { plainAssetRegistry, tokens } = await setupPlainAsset({
    files: {
      '/in/a.css': ".a { background: url('./pic.png'); }",
      '/in/pic.png': 'PNGBYTES',
    },
    calls: [{ value: './a.css', opts: { kind: 'stylesheet' } }],
  });
  const [css] = plainAssetRegistry.cssForPage(tokens[0]);
  assert.match(css, /url\("__XTATIC_EMIT_[a-f0-9]+\.png__"\)/);
});
