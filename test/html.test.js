import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Volume, createFsFromVolume } from 'memfs';
import { build } from '../src/index.js';
import { processHtml } from '../src/html.js';

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

function bytes(n, fill = 0xab) {
  return Buffer.alloc(n, fill);
}

test('a .html input file becomes a page at dir/index.html', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/legacy.html':
      '<!doctype html>\n<html><head><title>Legacy</title></head>\n<body><p>hand-written</p></body></html>\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/legacy/index.html', 'utf8');
  assert.match(html, /<p>hand-written<\/p>/);
  assert.match(html, /<!doctype html>/);
});

test('output preserves the source bytes outside rewritten attributes', async () => {
  const source =
    '<!doctype html>\n<!-- a comment -->\n<html>\n  <body>\n    <p class=unquoted>text &amp; entities</p>\n  </body>\n</html>\n';
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/page.html': source,
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/page/index.html', 'utf8');
  assert.equal(html, source);
});

test('<img src> in .html goes through the plain-asset pipeline', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/page.html': '<html><body><img src="./tiny.png" alt="t"></body></html>\n',
  });
  await fs.promises.writeFile('/in/tiny.png', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/page/index.html', 'utf8');
  assert.match(html, /<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="t">/);
});

test('large assets referenced from .html are emitted with page-relative URLs', async () => {
  const fs = makeFs({
    '/in/index.md': '<img src="/big.png" alt="s" />\n',
    '/in/page.html': '<html><body><img src="/big.png" alt="s"></body></html>\n',
  });
  await fs.promises.writeFile('/in/big.png', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/page/index.html', 'utf8');
  assert.match(html, /<img src="\.\.\/_assets\/[a-f0-9]+\.png" alt="s">/);
});

test('relative refs resolve against the .html file, single-quoted and unquoted attrs work', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/sub/page.html':
      "<html><body><img src='./tiny.png'><img src=other.png></body></html>\n",
    '/in/sub/index.md': '# sub\n',
  });
  await fs.promises.writeFile('/in/sub/tiny.png', bytes(10));
  await fs.promises.writeFile('/in/sub/other.png', bytes(12, 0xcd));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/sub/page/index.html', 'utf8');
  const matches = html.match(/src="data:image\/png;base64,[A-Za-z0-9+/=]+"/g);
  assert.equal(matches?.length, 2);
});

test('<link rel="stylesheet"> below threshold is inlined as <style>', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/page.html':
      '<html><head><link rel=stylesheet href="./s.css" media="screen"></head><body></body></html>\n',
    '/in/s.css': 'body { color: red; }\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/page/index.html', 'utf8');
  assert.match(html, /<style media="screen">body \{ color: red; \}\n<\/style>/);
  assert.doesNotMatch(html, /<link/);
});

test('non-asset link rels are left untouched', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/page.html':
      '<html><head><link rel="canonical" href="./page.html"></head><body></body></html>\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/page/index.html', 'utf8');
  assert.match(html, /<link rel="canonical" href="\.\/page\.html">/);
});

test('passthrough URLs in .html are not processed', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/page.html':
      '<html><body>' +
      '<img src="https://example.com/x.png">' +
      '<a href="#top">top</a>' +
      '<a href="mailto:x@y.z">mail</a>' +
      '</body></html>\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/page/index.html', 'utf8');
  assert.match(html, /src="https:\/\/example\.com\/x\.png"/);
  assert.match(html, /href="#top"/);
  assert.match(html, /href="mailto:x@y\.z"/);
});

test('<a href> to a page source rewrites to the rendered page URL', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/about.md': '# about\n',
    '/in/page.html':
      '<html><body><a href="./about.md#team">about</a><a href="/index.md">home</a></body></html>\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/page/index.html', 'utf8');
  assert.match(html, /<a href="\.\.\/about\/#team">about<\/a>/);
  assert.match(html, /<a href="\.\.\/">home<\/a>/);
});

test('markdown pages can link to a .html page and get a clean URL', async () => {
  const fs = makeFs({
    '/in/index.md': '<a href="./legacy.html">legacy</a>\n',
    '/in/legacy.html': '<html><body>old</body></html>\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<a href="legacy\/">legacy<\/a>/);
});

test('data-xtatic-placement forces placement and is removed from output', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/page.html':
      '<html><body><img src="./tiny.png" data-xtatic-placement="shared" alt="t"></body></html>\n',
  });
  await fs.promises.writeFile('/in/tiny.png', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/page/index.html', 'utf8');
  assert.match(html, /<img src="\.\.\/_assets\/[a-f0-9]+\.png" alt="t">/);
  assert.doesNotMatch(html, /data-xtatic-placement/);
});

test('<title> defaults the page title; filename default applies without one', async () => {
  const fs = makeFs({
    '/in/index.md': '{childPages.map((p) => <li>{p.title}</li>)}\n',
    '/in/with-title.html':
      '<html><head><title>Fancy Title</title></head><body></body></html>\n',
    '/in/no-title.html': '<html><body></body></html>\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<li>Fancy Title<\/li>/);
  assert.match(html, /<li>No Title<\/li>/);
});

test('.html pages never get a layout, even with a defaultLayout in scope', async () => {
  const fs = makeFs({
    '/in/index.md': '---\ndefaultLayout: base\n---\n# root\n',
    '/in/page.html': '<html><body>plain</body></html>\n',
    '/top/_layouts/base.md': '<div class="wrapped">{children}</div>\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', topDir: '/top', fs });
  const root = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(root, /class="wrapped"/);
  const page = await fs.promises.readFile('/out/page/index.html', 'utf8');
  assert.doesNotMatch(page, /class="wrapped"/);
  assert.match(page, /plain/);
});

test('an mdx page can import a .html page and read its url and title', async () => {
  const fs = makeFs({
    '/in/index.md':
      "import legacy from './legacy.html'\n\n<a href={legacy.url}>{legacy.title}</a>\n",
    '/in/legacy.html':
      '<html><head><title>Old Site</title></head><body></body></html>\n',
  });
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<a href="legacy\/">Old Site<\/a>/);
});

test('a .md and a .html mapping to the same logical path collide', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/about.md': '# about\n',
    '/in/about.html': '<html><body></body></html>\n',
  });
  await assert.rejects(
    build({ inputDir: '/in', outputDir: '/out', fs }),
    /Multiple input files map to the same output path "about"/,
  );
});

test('a missing asset referenced from .html reports the html call site', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/page.html': '<html><body>\n<img src="./nope.png">\n</body></html>\n',
  });
  await assert.rejects(
    build({ inputDir: '/in', outputDir: '/out', fs }),
    (e) => {
      assert.match(e.message, /Asset not found at \/in\/nope\.png/);
      assert.match(e.message, /in <img> at page\.html:2:1/);
      return true;
    },
  );
});

test('a {placeholder} .html filename is rejected as a generator', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/tag-{tag}.html': '<html><body></body></html>\n',
  });
  await assert.rejects(
    build({ inputDir: '/in', outputDir: '/out', fs }),
    /Page generator "tag-\{tag\}\.html" must be a \.md or \.mdx file/,
  );
});

test('processHtml leaves a document with no references unchanged', () => {
  const source = '<html><body><p>nothing here</p></body></html>';
  const { html, title } = processHtml(source, {
    asset: (v) => v,
    importerDisplay: 'x.html',
  });
  assert.equal(html, source);
  assert.equal(title, undefined);
});

test('processHtml decodes entities before calling asset()', () => {
  const seen = [];
  const source = '<html><body><a href="./a&amp;b.pdf">x</a></body></html>';
  processHtml(source, {
    asset: (v) => {
      seen.push(v);
      return v;
    },
    importerDisplay: 'x.html',
  });
  assert.deepEqual(seen, ['./a&b.pdf']);
});

test('processHtml processes assets inside <template> content', () => {
  const seen = [];
  processHtml('<html><body><template><img src="./t.png"></template></body></html>', {
    asset: (v) => {
      seen.push(v);
      return v;
    },
    importerDisplay: 'x.html',
  });
  assert.deepEqual(seen, ['./t.png']);
});

test('url() inside an inline <style> block in .html goes through the asset pipeline', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/page.html':
      '<!doctype html>\r\n<html><head>\r\n<style>\r\nbody { background: url(bg.gif) no-repeat; }\r\n.big { background-image: url("./big.png"); }\r\n.ext { background: url(https://x.example/a.png), url(data:image/gif;base64,R0lG) }\r\n</style></head><body></body></html>\r\n',
  });
  await fs.promises.writeFile('/in/bg.gif', bytes(10));
  await fs.promises.writeFile('/in/big.png', bytes(8192));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/page/index.html', 'utf8');
  // Small → data: URL, always double-quoted; large → page-relative shared asset.
  assert.match(
    html,
    /body \{ background: url\("data:image\/gif;base64,[A-Za-z0-9+/=]+"\) no-repeat; \}/,
  );
  assert.match(html, /\.big \{ background-image: url\("\.\.\/_assets\/[a-f0-9]+\.png"\); \}/);
  // Passthrough URLs and the surrounding bytes (CRLF included) are untouched.
  assert.match(
    html,
    /\.ext \{ background: url\(https:\/\/x\.example\/a\.png\), url\(data:image\/gif;base64,R0lG\) \}\r\n<\/style>/,
  );
  assert.match(html, /^<!doctype html>\r\n<html><head>\r\n<style>\r\nbody/);
});

test('url() inside a style="" attribute in .html is rewritten and re-escaped', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/page.html':
      "<html><body><div style='background:url(bg.gif) &amp; color:red' data-xtatic-placement=\"shared\">x</div><p style=\"color:blue\">y</p></body></html>\n",
  });
  await fs.promises.writeFile('/in/bg.gif', bytes(10));
  await build({ inputDir: '/in', outputDir: '/out', fs });
  const html = await fs.promises.readFile('/out/page/index.html', 'utf8');
  // Forced shared despite being under the inline threshold; the attribute is
  // re-emitted double-quoted with entities re-escaped and the placement attr
  // removed. A style attr with no url() is left byte-for-byte.
  assert.match(
    html,
    /<div style="background:url\(&quot;\.\.\/_assets\/[a-f0-9]+\.gif&quot;\) &amp; color:red">x<\/div><p style="color:blue">y<\/p>/,
  );
  assert.equal(await fs.promises.readdir('/out/_assets').then((l) => l.length), 1);
});

test('a missing url() target in an inline <style> reports the CSS line', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/page.html':
      '<html><head><style>\nbody {}\n  .x { background: url(./nope.gif) }\n</style></head></html>\n',
  });
  await assert.rejects(
    build({ inputDir: '/in', outputDir: '/out', fs }),
    (e) => {
      assert.match(e.message, /Asset not found at \/in\/nope\.gif/);
      assert.match(e.message, /in <style> at page\.html:3:20/);
      return true;
    },
  );
});

test('an inline <style> url() can point at a verbatim file', async () => {
  const fs = makeFs({
    '/in/index.md': '# root\n',
    '/in/page.html':
      '<html><head><style>body{background:url(/in/static/bg.gif)}</style></head></html>\n',
    '/in/static/_xtatic_verbatim': '',
    '/in/static/bg.gif': 'gif',
  });
  await build({ inputDir: '/in', outputDir: '/out', topDir: '/', fs });
  const html = await fs.promises.readFile('/out/page/index.html', 'utf8');
  assert.match(html, /body\{background:url\("\.\.\/static\/bg\.gif"\)\}/);
});
