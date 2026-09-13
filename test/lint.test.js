import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const cli = path.join(repoRoot, 'src', 'cli.js');
const testTmp = path.join(repoRoot, 'test-tmp', 'lint');

before(() => {
  nodeFs.rmSync(testTmp, { recursive: true, force: true });
});

function setupTopDir(slug, files) {
  const top = path.join(testTmp, slug);
  nodeFs.mkdirSync(top, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(top, rel);
    nodeFs.mkdirSync(path.dirname(full), { recursive: true });
    nodeFs.writeFileSync(full, content);
  }
  return top;
}

function runCli(top, env) {
  return spawnSync(process.execPath, [cli, 'build', top], {
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
}

test('lint passes when imports are well-formed', () => {
  const top = setupTopDir('happy-path', {
    'pages/index.mdx':
      "import {Style} from 'xtatic:style';\n\n" +
      '<Style src="/style.css" />\n\n# OK\n',
    'style.css': '.a {}',
  });
  const r = runCli(top);
  assert.equal(r.status, 0, r.stderr);
});

test('default import from xtatic:style fails lint with a clear message', () => {
  const top = setupTopDir('default-import-style', {
    'pages/index.mdx':
      "import Style from 'xtatic:style';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Lint failed/);
  assert.match(r.stderr, /"xtatic:style" has no default export/);
  assert.match(r.stderr, /import \{Style\} from "xtatic:style"/);
});

test('default import from xtatic:image fails lint', () => {
  const top = setupTopDir('default-import-image', {
    'pages/index.mdx':
      "import Image from 'xtatic:image';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /"xtatic:image" has no default export/);
  assert.match(r.stderr, /import \{Image\} from "xtatic:image"/);
});

test('typo in named import from xtatic:style is flagged', () => {
  const top = setupTopDir('typo-named', {
    'pages/index.mdx':
      "import {Stlye} from 'xtatic:style';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /"xtatic:style" has no export named "Stlye"/);
  assert.match(r.stderr, /Available: "Style"/);
});

test('unknown xtatic:* spec is flagged with the available list', () => {
  const top = setupTopDir('unknown-spec', {
    'pages/index.mdx':
      "import {x} from 'xtatic:nope';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Unknown xtatic builtin module "xtatic:nope"/);
  assert.match(
    r.stderr,
    /Available: "xtatic:builtins", "xtatic:image", "xtatic:style"/,
  );
});

test('namespace import from xtatic:* is flagged', () => {
  const top = setupTopDir('namespace-import', {
    'pages/index.mdx':
      "import * as S from 'xtatic:style';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Namespace import from "xtatic:style" is unsupported/);
});

test('importing a non-existent relative path is flagged', () => {
  const top = setupTopDir('unresolved-path', {
    'pages/index.mdx':
      "import X from './missing.mdx';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Lint failed/);
  assert.match(r.stderr, /Unable to resolve path to module/);
});

test('idiomatic default import from .mdx is allowed', () => {
  const top = setupTopDir('mdx-default-allowed', {
    'pages/index.mdx':
      "import About from './about.mdx';\n\n# Index\n\n<About />\n",
    'pages/about.mdx': '# About\n',
  });
  const r = runCli(top);
  assert.equal(r.status, 0, r.stderr);
});

test('a "/"-rooted import resolves against the project root (no false no-unresolved)', () => {
  const top = setupTopDir('root-rooted-import', {
    'pages/index.mdx':
      "import Foo from '/components/Foo.md';\n\n# Index\n\n<Foo />\n",
    'components/Foo.md': '# Foo\n',
  });
  const r = runCli(top);
  assert.equal(r.status, 0, r.stderr);
});

test('a "/"-rooted import from a .jsx file resolves against the project root', () => {
  const top = setupTopDir('root-rooted-import-jsx', {
    'pages/index.mdx':
      "import Hero from './hero.jsx';\n\n# r\n\n<Hero />\n",
    'pages/hero.jsx':
      "import Foo from '/components/Foo.md';\n" +
      'export default function Hero() { return <Foo />; }\n',
    'components/Foo.md': '# Foo\n',
  });
  const r = runCli(top);
  assert.equal(r.status, 0, r.stderr);
});

test('a broken "/"-rooted import is still flagged by no-unresolved', () => {
  const top = setupTopDir('root-rooted-missing', {
    'pages/index.mdx':
      "import Foo from '/components/Nope.md';\n\n# Index\n\n<Foo />\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Lint failed/);
  assert.match(r.stderr, /Unable to resolve path to module/);
});

test('a "/"-rooted import in a .js file is NOT remapped (it is filesystem-absolute)', () => {
  // .js loads through Node's real import(), where "/foo" is a filesystem path —
  // so lint must keep flagging it even when the same name exists under topDir.
  const top = setupTopDir('root-rooted-js-not-remapped', {
    'pages/index.mdx':
      "import x from './util.js';\n\n# Index\n\n{x}\n",
    'pages/util.js': "import Foo from '/lib/Foo.js';\nexport default Foo;\n",
    'lib/Foo.js': 'export default "foo";\n',
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Lint failed/);
  assert.match(r.stderr, /Unable to resolve path to module '\/lib\/Foo\.js'/);
});

test('lint failure exits 1 before any build output is written', () => {
  const top = setupTopDir('no-build-on-lint-fail', {
    'pages/index.mdx':
      "import Style from 'xtatic:style';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.equal(nodeFs.existsSync(path.join(top, '_site')), false);
});

test('lint catches builtin misuse inside a .md layout', () => {
  const top = setupTopDir('md-layout-builtin', {
    'pages/index.md': '---\nlayout: default\n---\n\n# hi\n',
    '_layouts/default.md':
      "import Style from 'xtatic:style';\n\n" +
      '<Style src="./style.css" />\n\n{children}\n',
    '_layouts/style.css': '.a {}',
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /_layouts\/default\.md/);
  assert.match(r.stderr, /"xtatic:style" has no default export/);
});

test('lint catches a typo in a .md file (parsed as MDX)', () => {
  const top = setupTopDir('md-typo', {
    'pages/index.md':
      "import {Stlye} from 'xtatic:style';\n\n# Hi\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /pages\/index\.md/);
  assert.match(r.stderr, /"xtatic:style" has no export named "Stlye"/);
});

test('parse error includes a source code frame with a caret', () => {
  const top = setupTopDir('parse-error-frame', {
    'pages/feed.md':
      '---\ntitle: Feed\n---\n\nexport outputPath = "/feed.xml"\n\n# Feed\n',
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Parsing error: Could not parse import\/exports with acorn/);
  assert.match(r.stderr, /> 5 \| export outputPath = "\/feed\.xml"/);
  assert.match(r.stderr, /^ {4}\| {8}\^$/m);
});

test('with color on, the frame highlights the span inline and drops the caret row', () => {
  const top = setupTopDir('parse-error-frame-color', {
    'pages/feed.md':
      '---\ntitle: Feed\n---\n\nexport outputPath = "/feed.xml"\n\n# Feed\n',
  });
  const r = runCli(top, { FORCE_COLOR: '1' });
  assert.notEqual(r.status, 0);
  // The bold-bright-white-on-red highlight wraps the offending characters...
  assert.ok(r.stderr.includes('\x1b[1;97;41m'), r.stderr);
  // ...the source text still surrounds it (split around the highlight)...
  assert.match(r.stderr, /export/);
  assert.match(r.stderr, /feed\.xml/);
  // ...and there is no longer a separate caret row.
  assert.doesNotMatch(r.stderr, /\| *\^+\s*$/m);
});

const LONG_LINE = `export ${'a'.repeat(200)} = 1`;

test('a long source line is windowed to codeFrameWidth with an ellipsis', () => {
  const top = setupTopDir('window-long-line', {
    'pages/index.md': `---\ntitle: T\n---\n\n${LONG_LINE}\n\n# T\n`,
  });
  const r = runCli(top, { NO_COLOR: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Parsing error/);
  // The displayed source line is clipped to the default 120 cols (+ the … mark),
  // not the full 200-char line.
  const srcLine = r.stderr.split('\n').find((l) => l.startsWith('> 5 |'));
  assert.ok(srcLine, r.stderr);
  const body = srcLine.slice(srcLine.indexOf('| ') + 2);
  assert.ok(body.includes('…'), srcLine);
  assert.ok(body.length <= 122, `windowed body too wide: ${body.length}`);
  assert.ok(!r.stderr.includes('a'.repeat(200)), 'full line should not be shown');
  // No-color path still draws the caret row.
  assert.match(r.stderr, /\| +\^/);
});

test('codeFrameWidth: 0 disables windowing and shows the full line', () => {
  const top = setupTopDir('window-disabled', {
    'package.json': JSON.stringify({ xtatic: { codeFrameWidth: 0 } }),
    'pages/index.md': `---\ntitle: T\n---\n\n${LONG_LINE}\n\n# T\n`,
  });
  const r = runCli(top, { NO_COLOR: '1' });
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes('a'.repeat(200)), 'full line should be shown verbatim');
  assert.ok(!r.stderr.includes('…'), 'no ellipsis when windowing is off');
});

test('a non-numeric codeFrameWidth is rejected with a clear message', () => {
  const top = setupTopDir('window-bad-config', {
    'package.json': JSON.stringify({ xtatic: { codeFrameWidth: -3 } }),
    'pages/index.md': '# ok\n',
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /xtatic\.codeFrameWidth must be a non-negative integer/);
});

test('each parse-error frame sits directly under its own message', () => {
  const top = setupTopDir('frames-interleaved', {
    'pages/one.md':
      '---\ntitle: One\n---\n\nexport bad one = 1\n\n# One\n',
    'pages/two.md':
      '---\ntitle: Two\n---\n\nexport bad two = 2\n\n# Two\n',
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  // The frame for each file must appear after that file's own message and
  // before the next file's message — i.e. interleaved, not collected at the end.
  const oneMsg = r.stderr.indexOf('pages/one.md');
  const oneFrame = r.stderr.indexOf('> 5 | export bad one = 1');
  const twoMsg = r.stderr.indexOf('pages/two.md');
  const twoFrame = r.stderr.indexOf('> 5 | export bad two = 2');
  assert.ok(oneMsg >= 0 && oneFrame >= 0 && twoMsg >= 0 && twoFrame >= 0, r.stderr);
  assert.ok(oneMsg < oneFrame, 'first frame should follow first message');
  assert.ok(oneFrame < twoMsg, 'first frame should precede second message');
  assert.ok(twoMsg < twoFrame, 'second frame should follow second message');
});

test('lint catches builtin misuse in a .jsx component', () => {
  const top = setupTopDir('jsx-builtin-misuse', {
    'pages/index.mdx':
      "import Hero from './hero.jsx';\n\n# r\n\n<Hero />\n",
    'pages/hero.jsx':
      "import Image from 'xtatic:image';\n" +
      'export default function Hero() { return <Image src="./x.png" alt="x" />; }\n',
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /"xtatic:image" has no default export/);
});

test('a page generator ({placeholder} filename) lints clean and builds', () => {
  const top = setupTopDir('generator-clean', {
    'pages/index.mdx': '# Home\n',
    'pages/tag-{tag}.md':
      "export const getPages = () => [{ tag: 'rust' }, { tag: 'js' }]\n\n# Tag: {tag}\n",
  });
  const r = runCli(top);
  assert.equal(r.status, 0, r.stderr);
  // Confirm the build actually ran the expansion end-to-end on real fs.
  const html = nodeFs.readFileSync(
    path.join(top, '_site', 'tag-rust', 'index.html'),
    'utf8',
  );
  assert.match(html, /Tag: rust/);
});

test('lint inspects generator files: a broken import is caught', () => {
  // Proves the {curly}-named file isn't silently skipped by ESLint's
  // glob-pattern matching — the bad import inside it fails lint.
  const top = setupTopDir('generator-bad-import', {
    'pages/index.mdx': '# Home\n',
    'pages/tag-{tag}.md':
      "import X from './missing.mdx';\n\n" +
      "export const getPages = () => [{ tag: 'a' }]\n\n# {tag}\n",
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Lint failed/);
  assert.match(r.stderr, /missing\.mdx/);
});

test('lint skips only the files a pattern _xtatic_verbatim marker matches', () => {
  const top = setupTopDir('verbatim-pattern-skip', {
    'pages/index.mdx': '# Hi\n',
    'pages/_xtatic_verbatim': 'vendor/\n*.min.js\n',
    // Both would fail no-undef / no-unresolved if linted as sources.
    'pages/vendor/app.js': "import x from './missing.js';\nundefinedThing(x);\n",
    'pages/deep/lib.min.js': 'undefinedThing();\n',
    // Not matched by any pattern, so still a source — and broken.
    'pages/deep/real.js': 'undefinedThing();\n',
  });
  const r = runCli(top);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /deep\/real\.js/);
  assert.doesNotMatch(r.stderr, /vendor\/app\.js/);
  assert.doesNotMatch(r.stderr, /lib\.min\.js/);
});

test('lint skips directories marked _xtatic_verbatim', () => {
  const top = setupTopDir('verbatim-skip', {
    'pages/index.mdx': '# Hi\n',
    'pages/legacy/_xtatic_verbatim': '',
    // Would fail no-undef / no-unresolved if linted as a source file.
    'pages/legacy/app.js': "import x from './missing.js';\nundefinedThing(x);\n",
    'pages/legacy/old.md': "import Nope from './nope.mdx';\n\n<Nope />\n",
  });
  const r = runCli(top);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    nodeFs.readFileSync(path.join(top, '_site', 'legacy', 'app.js'), 'utf8'),
    "import x from './missing.js';\nundefinedThing(x);\n",
  );
});

test('lint honors a custom xtatic.verbatimMarker from package.json', () => {
  const top = setupTopDir('verbatim-custom-marker', {
    'package.json': JSON.stringify({ xtatic: { verbatimMarker: '.keep' } }),
    'pages/index.mdx': '# Hi\n',
    'pages/legacy/.keep': '',
    'pages/legacy/app.js': "import x from './missing.js';\nundefinedThing(x);\n",
  });
  const r = runCli(top);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    nodeFs.readFileSync(path.join(top, '_site', 'legacy', 'app.js'), 'utf8'),
    "import x from './missing.js';\nundefinedThing(x);\n",
  );
});
