import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Volume, createFsFromVolume } from 'memfs';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const cli = path.join(repoRoot, 'src', 'cli.js');
const testTmp = path.join(repoRoot, 'test-tmp', 'remark-plugins');

before(() => {
  nodeFs.rmSync(testTmp, { recursive: true, force: true });
});

function makeFs(files) {
  return createFsFromVolume(Volume.fromJSON(files));
}

function replaceTextPlugin(opts = {}) {
  const find = opts.find ?? 'TEMPLATE';
  const replace = opts.replace ?? 'REPLACED';
  return function transformer(tree) {
    function walk(node) {
      if (node.type === 'text' && typeof node.value === 'string') {
        node.value = node.value.split(find).join(replace);
      }
      if (node.children) for (const c of node.children) walk(c);
    }
    walk(tree);
  };
}

test('build() applies a remark plugin passed as a bare function', async () => {
  const fs = makeFs({ '/in/index.md': '# TEMPLATE rocks\n' });
  await build({
    inputDir: '/in',
    outputDir: '/out',
    fs,
    remarkPlugins: [replaceTextPlugin],
  });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<h1>REPLACED rocks<\/h1>/);
});

test('build() applies a [plugin, options] tuple', async () => {
  const fs = makeFs({ '/in/index.md': '# hello world\n' });
  await build({
    inputDir: '/in',
    outputDir: '/out',
    fs,
    remarkPlugins: [[replaceTextPlugin, { find: 'world', replace: 'mars' }]],
  });
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<h1>hello mars<\/h1>/);
});

test('frontmatter still parses when user remark plugins are configured', async () => {
  const fs = makeFs({
    '/in/index.md':
      '---\ntitle: Kept\n---\n\n# TEMPLATE\n',
  });
  await build({
    inputDir: '/in',
    outputDir: '/out',
    fs,
    remarkPlugins: [replaceTextPlugin],
  });
  // The plugin runs after frontmatter so the YAML block is gone by then —
  // the page title from frontmatter survives, and the body got transformed.
  const html = await fs.promises.readFile('/out/index.html', 'utf8');
  assert.match(html, /<h1>REPLACED<\/h1>/);
  assert.doesNotMatch(html, /title: Kept/);
});

function setupTopDir(slug, { pkg, files }) {
  const top = path.join(testTmp, slug);
  nodeFs.mkdirSync(top, { recursive: true });
  if (pkg !== undefined) {
    nodeFs.writeFileSync(path.join(top, 'package.json'), JSON.stringify(pkg));
  }
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(top, rel);
    nodeFs.mkdirSync(path.dirname(full), { recursive: true });
    nodeFs.writeFileSync(full, content);
  }
  return top;
}

const stubPluginSrc = `export default function plugin(opts = {}) {
  const find = opts.find ?? 'TEMPLATE';
  const replace = opts.replace ?? 'REPLACED';
  return function (tree) {
    function walk(node) {
      if (node.type === 'text' && typeof node.value === 'string') {
        node.value = node.value.split(find).join(replace);
      }
      if (node.children) for (const c of node.children) walk(c);
    }
    walk(tree);
  };
}
`;

test('CLI loads a remark plugin named in package.json from topDir node_modules', () => {
  const top = setupTopDir('cli-string-spec', {
    pkg: {
      type: 'module',
      xtatic: { remarkPlugins: ['fake-remark'] },
    },
    files: {
      'pages/index.md': '# TEMPLATE here\n',
      'node_modules/fake-remark/package.json': JSON.stringify({
        name: 'fake-remark',
        type: 'module',
        main: 'index.js',
      }),
      'node_modules/fake-remark/index.js': stubPluginSrc,
    },
  });
  const r = spawnSync(process.execPath, [cli, 'build', top], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const html = nodeFs.readFileSync(
    path.join(top, '_site', 'index.html'),
    'utf8',
  );
  assert.match(html, /<h1>REPLACED here<\/h1>/);
});

test('CLI honors plugin options via the [name, options] tuple form', () => {
  const top = setupTopDir('cli-tuple-opts', {
    pkg: {
      type: 'module',
      xtatic: {
        remarkPlugins: [['fake-remark', { find: 'world', replace: 'mars' }]],
      },
    },
    files: {
      'pages/index.md': '# hello world\n',
      'node_modules/fake-remark/package.json': JSON.stringify({
        name: 'fake-remark',
        type: 'module',
        main: 'index.js',
      }),
      'node_modules/fake-remark/index.js': stubPluginSrc,
    },
  });
  const r = spawnSync(process.execPath, [cli, 'build', top], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const html = nodeFs.readFileSync(
    path.join(top, '_site', 'index.html'),
    'utf8',
  );
  assert.match(html, /<h1>hello mars<\/h1>/);
});

test('CLI errors clearly when a configured remark plugin is not installed', () => {
  const top = setupTopDir('cli-missing-plugin', {
    pkg: { xtatic: { remarkPlugins: ['nope-not-installed'] } },
    files: { 'pages/index.md': '# x\n' },
  });
  const r = spawnSync(process.execPath, [cli, 'build', top], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /Cannot resolve remark plugin "nope-not-installed" from /,
  );
});

test('CLI applies remark-smartypants by default', () => {
  const top = setupTopDir('cli-smartypants-default', {
    pkg: { type: 'module' },
    files: { 'pages/index.md': "# It's a \"test\" -- really\n" },
  });
  const r = spawnSync(process.execPath, [cli, 'build', top], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const html = nodeFs.readFileSync(
    path.join(top, '_site', 'index.html'),
    'utf8',
  );
  // smartypants converts straight quotes to curly and -- to em-dash.
  assert.match(html, /’/); // ’
  assert.match(html, /“/); // “
  assert.match(html, /”/); // ”
  assert.match(html, /—/); // —
});

test('CLI honors xtatic.smartypants=false to disable smartypants', () => {
  const top = setupTopDir('cli-smartypants-off', {
    pkg: { type: 'module', xtatic: { smartypants: false } },
    files: { 'pages/index.md': "# It's a \"test\" -- really\n" },
  });
  const r = spawnSync(process.execPath, [cli, 'build', top], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const html = nodeFs.readFileSync(
    path.join(top, '_site', 'index.html'),
    'utf8',
  );
  assert.doesNotMatch(html, /’|“|”|—/);
  assert.match(html, /&#x27;|'/); // straight apostrophe (escaped or raw)
});

test('CLI passes xtatic.smartypants object as plugin options', () => {
  const top = setupTopDir('cli-smartypants-opts', {
    pkg: {
      type: 'module',
      xtatic: { smartypants: { dashes: false } },
    },
    files: { 'pages/index.md': "# It's a -- test\n" },
  });
  const r = spawnSync(process.execPath, [cli, 'build', top], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const html = nodeFs.readFileSync(
    path.join(top, '_site', 'index.html'),
    'utf8',
  );
  // quotes still transformed, but dashes left alone.
  assert.match(html, /’/);
  assert.doesNotMatch(html, /—/);
  assert.match(html, /--/);
});

test('CLI rejects an invalid xtatic.smartypants value', () => {
  const top = setupTopDir('cli-smartypants-bad', {
    pkg: { xtatic: { smartypants: 'yes' } },
    files: { 'pages/index.md': '# x\n' },
  });
  const r = spawnSync(process.execPath, [cli, 'build', top], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /xtatic\.smartypants must be true, false, or an options object/);
});
