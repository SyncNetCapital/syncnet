# Baseline test failures reproduced on `main` (29 Sep 2026)

Purpose: prove that every test failure observed while building EARLY exists on `main` (`585fd72`) independently of
the EARLY branch, with the exact command and the exact failure. Reproduced in a fresh `git worktree` of `main` on
Windows 11 / Node v24.21.0 / Python 3.14.7 (`git worktree add ../syncnet-main-baseline main`).

| # | Command (run in the `main` worktree) | Exact failure | Cause | Introduced by EARLY? |
|---|---|---|---|---|
| 1 | `python tests/static_audit.py` | `UnicodeDecodeError: 'charmap' codec can't decode byte 0x9d in position 69798` (reading `builder-v2.js`) | `Path.read_text()` without an encoding uses cp1252 on Windows | No |
| 2 | `PYTHONUTF8=1 python tests/static_audit.py` | `AssertionError: gateway concatenation outside the canonical utility: …\netlify\functions\site-img.js` | the audit's `/netlify/` filter does `f.replace('\\\\','/')` (a literal two-backslash sequence), so Windows paths never match and a Netlify function is checked as page code | No. **Portability-only fix included in the EARLY PR**, isolated to that one line: `f.replace('\\','/')` |
| 3 | `node tests/server/infra.test.mjs` | in a **fresh** worktree: `OK: 447 passed, 0 failed`. In the author's original checkout (cloned with `core.autocrlf=true`): `FAIL netlify.toml: /api/par-tokenlist rewrites to the function` and `FAIL netlify.toml: other function rewrites intact` | the two checks match `\n` literally; a CRLF checkout breaks them. Not a code failure | No (checkout line endings) |
| 4 | `node tests/unit/core.test.mjs` | `FAIL keccak256: section ran without an unexpected exception -- Error: spawnSync python3 EOF` · `328 passed, 1 failed` | the independent keccak oracle (`KECCAK_PY_DIR`/`keccak.py`) is not present on this machine; `python3` resolves to the Windows Store stub | No |
| 5 | `node tests/server/marketplace.test.mjs` | `Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: … Received protocol 'c:'` | line 87 does `import(path.join(ROOT, 'netlify/lib/chain-rpc.js'))` with a Windows absolute path instead of a `file://` URL | No |
| 6 | (EARLY branch, author's checkout only) `PYTHONUTF8=1 python tests/static_audit.py` | `AssertionError: no deployment broadcast may exist` | `contracts/project-home-sink/broadcast/**` exists locally as **git-ignored** Foundry artifacts (`git status --ignored` shows `!! contracts/project-home-sink/broadcast/`); 0 such files are committed on `main`. In a clean worktree of the EARLY branch (`fff4e4c`) the full audit prints `SyncNet Labs · EARLY static audit: PASS` | No (local artifacts) |

Playwright is not installed in the repository; the E2E/mobile suites were run with a scratchpad install
(`PLAYWRIGHT_MODULE=file:///…/playwright/index.mjs`). `redis-server` is not on the Windows PATH; the real-Redis
suites were run against a root-less Redis 8.0.5 inside WSL Ubuntu (`EARLY_TEST_REDIS=127.0.0.1:26379`).

No production code outside EARLY was changed to make any suite pass.
