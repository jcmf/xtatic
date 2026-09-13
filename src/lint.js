import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import importPlugin from 'eslint-plugin-import';
import { flat as mdxFlat } from 'eslint-plugin-mdx';
import globals from 'globals';
import { BUILTIN_SPECS } from './builtins-registry.js';
import { renderCodeFrame } from './code-frame.js';
import {
  DEFAULT_VERBATIM_MARKER,
  isVerbatimByPatterns,
  parseVerbatimMarker,
} from './verbatim.js';
import xtaticBuiltinImports from './eslint-rules/xtatic-builtin-imports.js';

const SOURCE_EXT_RE = /\.(mdx?|jsx?)$/i;
const XTATIC_IGNORE = BUILTIN_SPECS.map((s) => `^${s}$`);

// Absolute path to the custom resolver (.cjs). eslint-module-utils looks up a
// resolver by string name/path and require()s it, so we hand it a path and let
// it thread topDir through the resolver's config (see eslint-resolver-xtatic.cjs).
const XTATIC_RESOLVER = fileURLToPath(
  new URL('./eslint-resolver-xtatic.cjs', import.meta.url),
);

const xtaticPlugin = {
  rules: { 'builtin-imports': xtaticBuiltinImports },
};

export function makeConfig(topDir) {
  const top = path.resolve(topDir ?? '.');
  const sharedRules = {
    'import/no-unresolved': ['error', { ignore: ['^xtatic:'] }],
    'import/named': 'error',
    'import/no-duplicates': 'error',
    'xtatic/builtin-imports': 'error',
  };
  return [
    {
      ignores: ['node_modules/**', '**/node_modules/**'],
    },
    {
      files: ['**/*.{js,mjs,cjs,jsx}'],
      plugins: { import: importPlugin, xtatic: xtaticPlugin },
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        globals: { ...globals.es2022, ...globals.node },
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      settings: {
        'import/resolver': {
          [XTATIC_RESOLVER]: {
            topDir: top,
            extensions: ['.js', '.jsx', '.mjs', '.cjs'],
          },
        },
        'import/ignore': XTATIC_IGNORE,
      },
      rules: {
        ...sharedRules,
        'no-undef': 'error',
        'import/default': 'error',
      },
    },
    mdxFlat,
    {
      files: ['**/*.{md,mdx}'],
      plugins: { import: importPlugin, xtatic: xtaticPlugin },
      languageOptions: {
        parserOptions: { extensions: ['.md'] },
      },
      settings: {
        'import/resolver': {
          [XTATIC_RESOLVER]: {
            topDir: top,
            extensions: ['.js', '.jsx', '.mjs', '.cjs', '.md', '.mdx'],
          },
        },
        'import/ignore': XTATIC_IGNORE,
      },
      rules: {
        ...sharedRules,
        'no-unused-expressions': 'off',
      },
    },
  ];
}

function walkLintTargets(topDir, outputDir, verbatimMarker) {
  const results = [];
  const outAbs = path.resolve(outputDir);
  const topAbs = path.resolve(topDir);
  // Verbatim files are copied as-is; a .js/.md/… among them isn't a source.
  // Same marker semantics as index.js walkPages: an empty marker skips the
  // whole directory, a pattern marker skips just what it matches (and its
  // patterns apply to the subtree). `active` paths are relative to topDir.
  function recurse(dir, active) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const markerPath = path.join(dir, verbatimMarker);
    if (fs.existsSync(markerPath)) {
      const marker = parseVerbatimMarker(fs.readFileSync(markerPath, 'utf8'));
      if (marker.all) return;
      active = [
        ...active,
        { baseRel: path.relative(topAbs, dir), rules: marker.rules },
      ];
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (abs === outAbs) continue;
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const isDir = ent.isDirectory();
      if (
        active.length > 0 &&
        isVerbatimByPatterns(active, path.relative(topAbs, abs), isDir)
      ) {
        continue;
      }
      if (isDir) {
        recurse(abs, active);
      } else if (ent.isFile() && SOURCE_EXT_RE.test(ent.name)) {
        results.push(abs);
      }
    }
  }
  recurse(topAbs, []);
  return results;
}

export async function runLint({
  topDir,
  outputDir,
  codeFrameWidth = 120,
  verbatimMarker = DEFAULT_VERBATIM_MARKER,
}) {
  const files = walkLintTargets(topDir, outputDir, verbatimMarker);
  if (files.length === 0) return;
  const eslint = new ESLint({
    cwd: path.resolve(topDir),
    overrideConfigFile: true,
    overrideConfig: makeConfig(topDir),
  });
  const results = await eslint.lintFiles(files);
  const errorCount = results.reduce((n, r) => n + r.errorCount, 0);
  if (errorCount === 0) return;
  const output = formatResults(results, codeFrameWidth);
  const err = new Error(`Lint failed with ${errorCount} error${errorCount === 1 ? '' : 's'}:\n\n${output}\n`);
  err.lintFailed = true;
  throw err;
}

// One block per file. Each message is printed on its own line and, when the
// message carries a source-code frame (parse errors do), the frame is emitted
// right under that message — not collected into a separate trailing section.
function formatResults(results, codeFrameWidth) {
  const blocks = [];
  for (const r of results) {
    if (r.messages.length === 0) continue;
    const locWidth = Math.max(
      ...r.messages.map((m) => `${m.line ?? 0}:${m.column ?? 0}`.length),
    );
    const sevWidth = Math.max(
      ...r.messages.map((m) => severityLabel(m.severity).length),
    );
    const lines = [r.filePath];
    for (const m of r.messages) {
      const loc = `${m.line ?? 0}:${m.column ?? 0}`.padEnd(locWidth);
      const sev = severityLabel(m.severity).padEnd(sevWidth);
      const rule = m.ruleId ? `  ${m.ruleId}` : '';
      lines.push(`  ${loc}  ${sev}  ${m.message}${rule}`);
      const frame = frameFor(r, m, codeFrameWidth);
      if (frame) lines.push('', frame, '');
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

function severityLabel(severity) {
  return severity === 2 ? 'error' : 'warning';
}

function frameFor(r, m, codeFrameWidth) {
  if (!m.fatal || !m.line) return '';
  const source = r.source ?? safeRead(r.filePath);
  if (!source) return '';
  return renderCodeFrame(source, m.line, m.column, m.endLine, m.endColumn, codeFrameWidth);
}

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}
