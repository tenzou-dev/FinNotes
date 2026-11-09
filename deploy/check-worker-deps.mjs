/**
 * Cek bahwa modul yang di-bundle Worker tidak menarik API Node yang tidak
 * tersedia di Cloudflare Workers (fs, path, node:sqlite, process, Buffer).
 *
 * Usage: node deploy/check-worker-deps.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ENTRY = path.join(HERE, 'worker.js');

// Modul yang memang sah di Workers lewat kompatibilitas node.
const ALLOWED_NODE_BUILTINS = new Set([
  'node:path', 'node:url', 'node:util', 'node:buffer',
  'node:process', 'node:events', 'node:stream', 'node:perf_hooks', 'node:tty',
]);

// Modul lokal yang TIDAK boleh ikut ter-bundle.
const BLOCKED_LOCAL = new Set([
  path.join(ROOT, 'src', 'store', 'sqlite.js'),
  path.join(ROOT, 'src', 'store', 'index.js'),
  path.join(ROOT, 'src', 'config.js'),
  path.join(ROOT, 'src', 'session.js'),
]);

const problems = [];
const seen = new Set();
const external = new Set();

function resolveLocal(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  const candidates = [base, base + '.js', path.join(base, 'index.js')];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) || null;
}

function walk(file, trail) {
  if (seen.has(file)) return;
  seen.add(file);

  if (BLOCKED_LOCAL.has(file)) {
    problems.push(`${path.relative(ROOT, file)} ikut ter-bundle (dari ${trail})`);
    return;
  }

  const src = fs.readFileSync(file, 'utf8');
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    if (spec.startsWith('node:')) {
      if (!ALLOWED_NODE_BUILTINS.has(spec)) {
        problems.push(`${path.relative(ROOT, file)} memakai ${spec} (tidak tersedia di Workers)`);
      }
      continue;
    }
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const resolved = resolveLocal(file, spec);
      if (!resolved) {
        problems.push(`${path.relative(ROOT, file)} import tidak bisa diresolve: ${spec}`);
        continue;
      }
      walk(resolved, `${trail} -> ${path.relative(ROOT, file)}`);
      continue;
    }
    external.add(spec);
  }
}

walk(ENTRY, 'entry');

console.log('modul lokal ter-bundle:');
for (const f of [...seen].sort()) console.log('  ' + path.relative(ROOT, f));

console.log('\ndependensi npm:');
for (const e of [...external].sort()) console.log('  ' + e);

if (problems.length) {
  console.error('\nMASALAH:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

console.log('\nOK: tidak ada API Node yang tidak tersedia di Workers.');
