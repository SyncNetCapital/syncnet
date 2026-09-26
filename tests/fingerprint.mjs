// Prints the fingerprint of the deployable SyncNet site: SHA-256 over the sorted list of "<sha256>  <path>" lines
// for every file that is served or runs on Netlify. Excluded: tests/, docs/, contracts/ (never served: 404), *.md, .git/, .gitignore.
// Documentation and test results can change without changing the fingerprint; any change to a page, script,
// style, asset, function or config changes it. Run: node tests/fingerprint.mjs   (--list prints every line)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = (rel) => rel === '.gitignore' || rel.startsWith('.git/') || rel.startsWith('tests/') || rel.startsWith('docs/') || rel.startsWith('contracts/') || rel.endsWith('.md') || rel.split('/').includes('node_modules') || rel.endsWith('.DS_Store');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (e.isDirectory()) { if (!skip(rel + '/')) walk(abs); } else if (e.isFile() && !skip(rel)) files.push(rel);
  }
})(ROOT);
files.sort();
const lines = files.map((rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex') + '  ' + rel);
const digest = crypto.createHash('sha256').update(lines.join('\n') + '\n').digest('hex');
if (process.argv.includes('--list')) console.log(lines.join('\n'));
console.log(`SyncNet v2.5-rc site fingerprint: sha256:${digest} (${files.length} deployable files)`);
