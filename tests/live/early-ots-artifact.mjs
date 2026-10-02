// LIVE: produce one real OpenTimestamps artifact with EARLY's client (netlify/lib/early-ots.js) by submitting a random
// 32-byte root to the public calendars, and write the detached .ots file so the REFERENCE OpenTimestamps client can
// validate it (`ots info`, `ots verify -d <root>`; `ots upgrade` becomes possible once Bitcoin attests, hours later).
// Not part of run-all.mjs. Touches the real network. Nothing on-chain.
//   node tests/live/early-ots-artifact.mjs <out.ots>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const Ots = require(path.join(ROOT, 'netlify/lib/early-ots.js'));
const out = process.argv[2] || path.join(ROOT, 'tests/live/early-sample.ots');
const root = '0x' + crypto.randomBytes(32).toString('hex');
const res = await Ots.submit(root, { timeoutMs: 15000 });
console.log(JSON.stringify({ root, submittedAt: res.submittedAt, calendars: res.calendars, status: Ots.status(root, res.proof) }, null, 2));
if (!res.proof) { console.log('no calendar answered'); process.exit(1); }
fs.writeFileSync(out, Buffer.from(Ots.otsFile(root, res.proof)));
fs.writeFileSync(out.replace(/\.ots$/, '') + '.root.bin', Buffer.from(root.slice(2), 'hex')); // the "file" the proof stamps: the 32 root bytes
fs.writeFileSync(out + '.json', JSON.stringify({ root, sha256OfRoot: res.digest, submittedAt: res.submittedAt, calendars: res.calendars, proofBase64: res.proof, verify: 'ots verify -f <root.bin> <out.ots>  (or: ots verify -d ' + res.digest.slice(2) + ' <out.ots>)' }, null, 2));
console.log('wrote ' + out + ' (' + fs.statSync(out).size + ' bytes); root ' + root + '; sha256(root) ' + res.digest);
