import * as fs from 'node:fs';
import path from 'node:path';
import { combineErrors } from './errors.js';
import { build } from './index.js';
import { runLint } from './lint.js';
import { color, log, warn } from './log.js';

export async function watch({ buildOptions, debounceMs = 100 }) {
  const {
    topDir,
    outputDir,
    codeFrameWidth,
    verbatimMarker,
    keepGoing = false,
  } = buildOptions;
  const state = { error: null };

  let building = false;
  let dirty = false;
  let timer = null;
  // Pending promise while a build is in flight, null when idle. Lets serve mode
  // hold a request until the (re)build that may be wiping/rewriting outputDir
  // has finished, instead of serving 404s or a half-written tree.
  let inFlight = null;
  // Relative path of the file whose change triggered the next build (the first
  // one in a debounced burst), or null for the initial build.
  let pendingTrigger = null;

  async function runOnce() {
    building = true;
    const trigger = pendingTrigger;
    pendingTrigger = null;
    let done;
    inFlight = new Promise((r) => {
      done = r;
    });
    log(color('dim', trigger ? `${trigger} changed — building…` : 'building…'));
    const start = Date.now();
    try {
      // Under keep-going a lint failure is held back rather than thrown, the
      // build runs anyway, and the two are reported together.
      let lintError = null;
      try {
        await runLint({ topDir, outputDir, codeFrameWidth, verbatimMarker });
      } catch (e) {
        if (!keepGoing) throw e;
        lintError = e;
      }
      // reloadJs: bust Node's per-URL import() cache for .js files so edits to
      // them are picked up across rebuilds (see loadJs in registry.js).
      let buildError = null;
      try {
        await build({ ...buildOptions, fs, reloadJs: true });
      } catch (e) {
        if (!keepGoing) throw e;
        buildError = e;
      }
      const combined = combineErrors(lintError, buildError);
      if (combined) throw combined;
      state.error = null;
      log(color('green', `built in ${Date.now() - start}ms`));
    } catch (e) {
      state.error = e;
      // Color only the label, not the message: e.message carries its own ANSI
      // (the render-context trace's code frames), and wrapping the whole thing
      // in red breaks at the first embedded reset, leaving the tail uncolored.
      warn(`${color('red', 'build failed:')} ${e.message}`);
      if (process.env.XTATIC_DEBUG) console.error(e.stack);
    } finally {
      building = false;
      inFlight = null;
      done();
      if (dirty) {
        dirty = false;
        schedule();
      }
    }
  }

  async function whenIdle() {
    while (inFlight) await inFlight;
  }

  function schedule(changedRel) {
    if (changedRel && !pendingTrigger) pendingTrigger = changedRel;
    if (building) {
      dirty = true;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      runOnce();
    }, debounceMs);
  }

  log(`watching ${topDir} (Ctrl-C to stop)`);

  // Run the first build as the first iteration of watching — before wiring up
  // the file watcher, and not awaited so callers get `state`/`whenIdle` right
  // away. runOnce() sets `building`/`inFlight` synchronously, so any change
  // event that lands while it's in flight is queued, never a second build.
  runOnce();

  const ignoredDirs = [outputDir, path.join(topDir, 'node_modules')];
  function isIgnored(abs) {
    for (const p of ignoredDirs) {
      if (abs === p || abs.startsWith(p + path.sep)) return true;
    }
    return false;
  }

  const watcher = fs.watch(topDir, { recursive: true, persistent: true });
  watcher.on('change', (_eventType, filename) => {
    if (!filename) return;
    const abs = path.resolve(topDir, String(filename));
    if (isIgnored(abs)) return;
    schedule(path.relative(topDir, abs) || String(filename));
  });
  watcher.on('error', (e) => {
    warn(`watcher error: ${e.message}`);
  });

  return { watcher, state, whenIdle };
}
