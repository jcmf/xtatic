import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripAnsi } from '../src/serve-error.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const cli = path.join(repoRoot, 'src', 'cli.js');
const testTmp = path.join(repoRoot, 'test-tmp', 'cli');

before(() => {
  nodeFs.rmSync(testTmp, { recursive: true, force: true });
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

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    ...opts,
  });
}

test('CLI defaults to pages/ → _site/ under topDir when no package.json exists', () => {
  const top = setupTopDir('defaults', {
    files: { 'pages/index.md': '# Default layout\n' },
  });
  const r = runCli(['build', top]);
  assert.equal(r.status, 0, r.stderr);
  const html = nodeFs.readFileSync(
    path.join(top, '_site', 'index.html'),
    'utf8',
  );
  assert.match(html, /<h1>Default layout<\/h1>/);
});

test('CLI with no args defaults to "build" in CWD', () => {
  const top = setupTopDir('cwd', {
    files: { 'pages/index.md': '# From CWD\n' },
  });
  const r = runCli([], { cwd: top });
  assert.equal(r.status, 0, r.stderr);
  const html = nodeFs.readFileSync(
    path.join(top, '_site', 'index.html'),
    'utf8',
  );
  assert.match(html, /<h1>From CWD<\/h1>/);
});

test('CLI with bare "build" command uses CWD as topDir', () => {
  const top = setupTopDir('cwd-build', {
    files: { 'pages/index.md': '# Bare build\n' },
  });
  const r = runCli(['build'], { cwd: top });
  assert.equal(r.status, 0, r.stderr);
  const html = nodeFs.readFileSync(
    path.join(top, '_site', 'index.html'),
    'utf8',
  );
  assert.match(html, /<h1>Bare build<\/h1>/);
});

test('CLI reads inputDir/outputDir from package.json xtatic section', () => {
  const top = setupTopDir('config-override', {
    pkg: { xtatic: { inputDir: 'src/pages', outputDir: 'dist' } },
    files: { 'src/pages/index.md': '# Custom\n' },
  });
  const r = runCli(['build', top]);
  assert.equal(r.status, 0, r.stderr);
  const html = nodeFs.readFileSync(
    path.join(top, 'dist', 'index.html'),
    'utf8',
  );
  assert.match(html, /<h1>Custom<\/h1>/);
  assert.equal(nodeFs.existsSync(path.join(top, '_site')), false);
});

test('CLI resolves relative config paths against topDir, not the working directory', () => {
  const top = setupTopDir('relative-resolution', {
    pkg: { xtatic: { inputDir: 'src/pages', outputDir: 'dist' } },
    files: { 'src/pages/index.md': '# Relative\n' },
  });
  const r = runCli(['build', top], { cwd: repoRoot });
  assert.equal(r.status, 0, r.stderr);
  const html = nodeFs.readFileSync(
    path.join(top, 'dist', 'index.html'),
    'utf8',
  );
  assert.match(html, /<h1>Relative<\/h1>/);
  assert.equal(nodeFs.existsSync(path.join(repoRoot, 'src', 'pages')), false);
  assert.equal(nodeFs.existsSync(path.join(repoRoot, 'dist')), false);
});

test('CLI ignores package.json when it has no xtatic section', () => {
  const top = setupTopDir('no-xtatic-section', {
    pkg: { name: 'unrelated' },
    files: { 'pages/index.md': '# Plain\n' },
  });
  const r = runCli(['build', top]);
  assert.equal(r.status, 0, r.stderr);
  const html = nodeFs.readFileSync(
    path.join(top, '_site', 'index.html'),
    'utf8',
  );
  assert.match(html, /<h1>Plain<\/h1>/);
});

test('CLI rejects unknown commands', () => {
  const r = runCli(['bogus']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown command "bogus"/);
  assert.match(r.stderr, /xtatic help/);
});

test('CLI rejects extra positional args after build', () => {
  const r = runCli(['build', 'a', 'b']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage: xtatic build \[top_dir\]/);
});

test('CLI help command prints usage and exits 0', () => {
  const r = runCli(['help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /\bbuild\b/);
  assert.match(r.stdout, /\bhelp\b/);
});

test('CLI prints a clean error and exits 1, with no internal stack', () => {
  const top = setupTopDir('error-clean', {
    files: { 'pages/index.md': '# Hi {foo.}\n' },
  });
  const r = runCli(['build', top]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Lint failed with /);
  assert.match(r.stderr, /pages\/index\.md/);
  assert.match(r.stderr, /\(set XTATIC_DEBUG=1 for the full stack\)/);
  assert.doesNotMatch(r.stderr, /at \w.*lint\.js/);
  assert.doesNotMatch(r.stderr, /\[cause\]:/);
});

test('CLI with XTATIC_DEBUG=1 surfaces the full stack', () => {
  const top = setupTopDir('error-debug', {
    files: { 'pages/index.md': '# Hi {foo.}\n' },
  });
  const r = runCli(['build', top], {
    env: { ...process.env, XTATIC_DEBUG: '1' },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /at \w.*lint\.js/);
});

function spawnWatch(args, opts = {}) {
  const proc = spawn(process.execPath, [cli, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  const buffers = { stdout: '', stderr: '' };
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (c) => (buffers.stdout += c));
  proc.stderr.on('data', (c) => (buffers.stderr += c));
  const exited = new Promise((resolve) => proc.on('exit', resolve));
  async function waitUntil(check, { timeoutMs = 15000, label } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(
      `Timed out waiting for ${label ?? check}. stdout=${JSON.stringify(buffers.stdout)} stderr=${JSON.stringify(buffers.stderr)}`,
    );
  }
  function countBuilds() {
    return (stripAnsi(buffers.stdout).match(/\[xtatic\] built in /g) || [])
      .length;
  }
  return { proc, buffers, exited, waitUntil, countBuilds };
}

test('watch builds initially and rebuilds on change', async () => {
  const top = setupTopDir('watch-rebuild', {
    files: { 'pages/index.md': '# original\n' },
  });
  const w = spawnWatch(['watch', top]);
  try {
    await w.waitUntil(() => w.countBuilds() >= 1, { label: 'initial build' });
    await w.waitUntil(() => /\[xtatic\] watching /.test(w.buffers.stdout), {
      label: 'watcher start',
    });
    let html = nodeFs.readFileSync(
      path.join(top, '_site', 'index.html'),
      'utf8',
    );
    assert.match(html, /<h1>original<\/h1>/);

    const before = w.countBuilds();
    nodeFs.writeFileSync(path.join(top, 'pages', 'index.md'), '# updated\n');
    await w.waitUntil(() => w.countBuilds() > before, {
      label: 'rebuild after edit',
    });
    html = nodeFs.readFileSync(path.join(top, '_site', 'index.html'), 'utf8');
    assert.match(html, /<h1>updated<\/h1>/);
  } finally {
    w.proc.kill('SIGTERM');
    await w.exited;
  }
});

test('watch keeps running and recovers after a build error', async () => {
  const top = setupTopDir('watch-error-recovery', {
    files: { 'pages/index.md': '# Broken {foo.}\n' },
  });
  const w = spawnWatch(['watch', top]);
  try {
    await w.waitUntil(
      () => /\[xtatic\] build failed/.test(w.buffers.stderr),
      { label: 'initial build failure' },
    );
    await w.waitUntil(() => /\[xtatic\] watching /.test(w.buffers.stdout), {
      label: 'watcher start',
    });
    nodeFs.writeFileSync(path.join(top, 'pages', 'index.md'), '# Fixed\n');
    await w.waitUntil(() => w.countBuilds() >= 1, {
      label: 'successful rebuild',
    });
    const html = nodeFs.readFileSync(
      path.join(top, '_site', 'index.html'),
      'utf8',
    );
    assert.match(html, /<h1>Fixed<\/h1>/);
  } finally {
    w.proc.kill('SIGTERM');
    await w.exited;
  }
});

function extractServeUrl(stdout) {
  const m = stdout.match(/\[xtatic\] serving (http:\/\/\S+)/);
  return m && m[1];
}

test('serve responds to / and /sub/ and rebuilds on change', async () => {
  const top = setupTopDir('serve-rebuild', {
    files: {
      'pages/index.md': '# original\n',
      'pages/about.md': '# about original\n',
    },
  });
  const w = spawnWatch(['serve', top], {
    env: { ...process.env, XTATIC_PORT: '0' },
  });
  try {
    await w.waitUntil(() => extractServeUrl(w.buffers.stdout), {
      label: 'server start',
    });
    const url = extractServeUrl(w.buffers.stdout);

    const r1 = await fetch(url);
    assert.equal(r1.status, 200);
    assert.match(r1.headers.get('content-type'), /text\/html/);
    assert.match(await r1.text(), /<h1>original<\/h1>/);

    const r2 = await fetch(url + 'about/');
    assert.equal(r2.status, 200);
    assert.match(await r2.text(), /<h1>about original<\/h1>/);

    const r3 = await fetch(url + 'about', { redirect: 'manual' });
    assert.equal(r3.status, 301);
    assert.equal(r3.headers.get('location'), '/about/');

    const r4 = await fetch(url + 'nope');
    assert.equal(r4.status, 404);

    const before = w.countBuilds();
    nodeFs.writeFileSync(path.join(top, 'pages', 'index.md'), '# updated\n');
    await w.waitUntil(() => w.countBuilds() > before, { label: 'rebuild' });
    const r5 = await fetch(url);
    assert.match(await r5.text(), /<h1>updated<\/h1>/);
  } finally {
    w.proc.kill('SIGTERM');
    await w.exited;
  }
});

test('serve rejects path-traversal attempts', async () => {
  const top = setupTopDir('serve-traversal', {
    files: { 'pages/index.md': '# Hi\n' },
  });
  const w = spawnWatch(['serve', top], {
    env: { ...process.env, XTATIC_PORT: '0' },
  });
  try {
    await w.waitUntil(() => extractServeUrl(w.buffers.stdout), {
      label: 'server start',
    });
    const url = extractServeUrl(w.buffers.stdout);
    const r = await fetch(url + '../../etc/passwd', { redirect: 'manual' });
    assert.ok(r.status === 400 || r.status === 404, `got ${r.status}`);
  } finally {
    w.proc.kill('SIGTERM');
    await w.exited;
  }
});

test('browse logs the URL it would open and serves the page', async () => {
  const top = setupTopDir('browse-log', {
    files: { 'pages/index.md': '# Browse me\n' },
  });
  const w = spawnWatch(['browse', top], {
    env: { ...process.env, XTATIC_PORT: '0', XTATIC_NO_OPEN: '1' },
  });
  try {
    await w.waitUntil(
      () => /\[xtatic\] opening http:\/\/\S+/.test(w.buffers.stdout),
      { label: 'browse open log' },
    );
    const m = w.buffers.stdout.match(/\[xtatic\] opening (http:\/\/\S+)/);
    const r = await fetch(m[1]);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<h1>Browse me<\/h1>/);
  } finally {
    w.proc.kill('SIGTERM');
    await w.exited;
  }
});

test('serve prints "serving" before "watching" before the first build', async () => {
  const top = setupTopDir('serve-order', {
    files: { 'pages/index.md': '# Hi\n' },
  });
  const w = spawnWatch(['serve', top], {
    env: { ...process.env, XTATIC_PORT: '0' },
  });
  try {
    await w.waitUntil(() => w.countBuilds() >= 1, { label: 'first build' });
    const out = stripAnsi(w.buffers.stdout);
    const iServing = out.indexOf('[xtatic] serving ');
    const iWatching = out.indexOf('[xtatic] watching ');
    const iBuilding = out.indexOf('[xtatic] building…');
    const iBuilt = out.indexOf('[xtatic] built in ');
    assert.ok(
      iServing >= 0 && iWatching >= 0 && iBuilding >= 0 && iBuilt >= 0,
      out,
    );
    assert.ok(iServing < iWatching, `serving before watching\n${out}`);
    assert.ok(iWatching < iBuilding, `watching before building\n${out}`);
    assert.ok(iBuilding < iBuilt, `building before built\n${out}`);
  } finally {
    w.proc.kill('SIGTERM');
    await w.exited;
  }
});

test('serve logs each request by default', async () => {
  const top = setupTopDir('serve-reqlog', {
    files: { 'pages/index.md': '# Hi\n' },
  });
  const w = spawnWatch(['serve', top], {
    env: { ...process.env, XTATIC_PORT: '0' },
  });
  try {
    await w.waitUntil(() => extractServeUrl(w.buffers.stdout), {
      label: 'server start',
    });
    const r = await fetch(extractServeUrl(w.buffers.stdout));
    await r.text();
    await w.waitUntil(
      () => /\[xtatic\] GET \/ 200\b/.test(stripAnsi(w.buffers.stdout)),
      { label: 'request log line' },
    );
  } finally {
    w.proc.kill('SIGTERM');
    await w.exited;
  }
});

test('serve does not log requests served the build-error page', async () => {
  const top = setupTopDir('serve-errlog-quiet', {
    files: { 'pages/index.md': '# Broken {foo.}\n' },
  });
  const w = spawnWatch(['serve', top], {
    env: { ...process.env, XTATIC_PORT: '0' },
  });
  try {
    await w.waitUntil(
      () => /\[xtatic\] build failed/.test(stripAnsi(w.buffers.stderr)),
      { label: 'build failure' },
    );
    const r = await fetch(extractServeUrl(w.buffers.stdout));
    assert.equal(r.status, 503);
    await r.text();
    await new Promise((res) => setTimeout(res, 200));
    assert.doesNotMatch(stripAnsi(w.buffers.stdout), /\[xtatic\] GET \//);
  } finally {
    w.proc.kill('SIGTERM');
    await w.exited;
  }
});

test('XTATIC_REQUEST_LOG=all logs build-error-page requests', async () => {
  const top = setupTopDir('serve-errlog-all', {
    files: { 'pages/index.md': '# Broken {foo.}\n' },
  });
  const w = spawnWatch(['serve', top], {
    env: { ...process.env, XTATIC_PORT: '0', XTATIC_REQUEST_LOG: 'all' },
  });
  try {
    await w.waitUntil(
      () => /\[xtatic\] build failed/.test(stripAnsi(w.buffers.stderr)),
      { label: 'build failure' },
    );
    await fetch(extractServeUrl(w.buffers.stdout));
    await w.waitUntil(
      () => /\[xtatic\] GET \/ 503\b/.test(stripAnsi(w.buffers.stdout)),
      { label: '503 request log line' },
    );
  } finally {
    w.proc.kill('SIGTERM');
    await w.exited;
  }
});

test('XTATIC_REQUEST_LOG=off silences request logging', async () => {
  const top = setupTopDir('serve-reqlog-off', {
    files: { 'pages/index.md': '# Hi\n' },
  });
  const w = spawnWatch(['serve', top], {
    env: { ...process.env, XTATIC_PORT: '0', XTATIC_REQUEST_LOG: 'off' },
  });
  try {
    await w.waitUntil(() => extractServeUrl(w.buffers.stdout), {
      label: 'server start',
    });
    const r = await fetch(extractServeUrl(w.buffers.stdout));
    assert.equal(r.status, 200);
    await r.text();
    await new Promise((res) => setTimeout(res, 200));
    assert.doesNotMatch(stripAnsi(w.buffers.stdout), /\[xtatic\] GET \//);
  } finally {
    w.proc.kill('SIGTERM');
    await w.exited;
  }
});

test('a rebuild names the file that changed', async () => {
  const top = setupTopDir('watch-trigger-name', {
    files: { 'pages/index.md': '# original\n' },
  });
  const w = spawnWatch(['watch', top]);
  try {
    await w.waitUntil(() => w.countBuilds() >= 1, { label: 'initial build' });
    const before = w.countBuilds();
    nodeFs.writeFileSync(path.join(top, 'pages', 'index.md'), '# updated\n');
    await w.waitUntil(() => w.countBuilds() > before, { label: 'rebuild' });
    assert.match(
      stripAnsi(w.buffers.stdout),
      /\[xtatic\] (?:pages[/\\])?index\.md changed — building…/,
    );
  } finally {
    w.proc.kill('SIGTERM');
    await w.exited;
  }
});

test('serve fails with a clear message when XTATIC_PORT is invalid', () => {
  const top = setupTopDir('serve-bad-port', {
    files: { 'pages/index.md': '# x\n' },
  });
  const r = runCli(['serve', top], {
    env: { ...process.env, XTATIC_PORT: 'banana' },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /invalid XTATIC_PORT/);
});

test('build --keep-going writes the good pages, reports every error, and exits 1', () => {
  const top = setupTopDir('keep-going', {
    files: {
      'pages/index.md': '# Home\n',
      'pages/bad-a.md': "export function Boom() { throw new Error('boom a') }\n\n<Boom />\n",
      'pages/bad-b.md': "export function Boom() { throw new Error('boom b') }\n\n<Boom />\n",
    },
  });
  const r = runCli(['build', '--keep-going', top]);
  assert.equal(r.status, 1);
  const err = stripAnsi(r.stderr);
  assert.match(err, /Build finished with 2 errors:/);
  assert.match(err, /\[1\/2\] boom a[\s\S]*in <Boom> at pages\/bad-a\.md:3:1/);
  assert.match(err, /\[2\/2\] boom b[\s\S]*in <Boom> at pages\/bad-b\.md:3:1/);
  assert.match(err, /2 pages were not written because of the errors above: bad-a, bad-b/);
  assert.ok(nodeFs.existsSync(path.join(top, '_site', 'index.html')));
  assert.ok(!nodeFs.existsSync(path.join(top, '_site', 'bad-a')));
});

test('-k is accepted anywhere on the command line, including before the command', () => {
  const top = setupTopDir('keep-going-short', {
    files: { 'pages/index.md': '# Home\n', 'pages/bad.md': "export function Boom() { throw new Error('boom a') }\n\n<Boom />\n" },
  });
  const r = runCli(['-k', 'build', top]);
  assert.equal(r.status, 1);
  assert.match(stripAnsi(r.stderr), /Build finished with 1 error:/);
  assert.ok(nodeFs.existsSync(path.join(top, '_site', 'index.html')));
});

test('without --keep-going the first error stops the build and nothing is written', () => {
  const top = setupTopDir('keep-going-off', {
    files: { 'pages/index.md': '# Home\n', 'pages/bad.md': "export function Boom() { throw new Error('boom a') }\n\n<Boom />\n" },
  });
  const r = runCli(['build', top]);
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /Build finished with/);
  assert.match(stripAnsi(r.stderr), /boom a[\s\S]*in <Boom> at pages\/bad\.md:3:1/);
  assert.ok(!nodeFs.existsSync(path.join(top, '_site')));
});

test('--keep-going is rejected for commands that do not build', () => {
  const top = setupTopDir('keep-going-init', { files: {} });
  const r = runCli(['init', '--keep-going', top]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--keep-going applies to build, watch, serve, browse, not "init"/);
});

test('an unknown option is an error', () => {
  const r = runCli(['build', '--bogus']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown option "--bogus"/);
});

test('build --keep-going: a lint failure no longer stops the build; both reports are printed', () => {
  const top = setupTopDir('keep-going-lint', {
    files: {
      'pages/index.md': '# Home\n',
      'pages/unclosed.md': '<div>\n',
      'pages/throws.md': "export function Boom() { throw new Error('boom a') }\n\n<Boom />\n",
    },
  });
  const r = runCli(['build', '-k', top]);
  assert.equal(r.status, 1);
  const err = stripAnsi(r.stderr);
  assert.match(err, /Lint failed with 1 error:/);
  assert.match(err, /Build finished with 2 errors:/);
  assert.match(err, /Failed to compile "pages\/unclosed\.md"/);
  assert.match(err, /boom a/);
  assert.match(err, /2 pages were not written because of the errors above: throws, unclosed/);
  assert.ok(nodeFs.existsSync(path.join(top, '_site', 'index.html')));
});

test('a non-string xtatic.verbatimMarker is rejected before building', () => {
  const top = setupTopDir('verbatim-marker-type', {
    pkg: { xtatic: { verbatimMarker: 42 } },
    files: { 'pages/index.md': '# hi\n' },
  });
  const r = runCli(['build', top]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /xtatic\.verbatimMarker must be a string/);
  assert.equal(nodeFs.existsSync(path.join(top, '_site')), false);
});
