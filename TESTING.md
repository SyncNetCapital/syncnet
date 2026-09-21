# Testing

## Fast local checks

```bash
python3 tests/static_audit.py
node --check network-explorer.js
node --check project-services.js
node --check product-lab.js
node --check launch-engine.js
node --check launch-controller.js
```

## Browser smoke test

Serve the repository with a local HTTP server. Confirm that:

- the homepage renders without uncaught JavaScript errors;
- `/token/<valid-40-byte-address>` switches to the token-page shell instead of throwing because of missing DOM nodes;
- malformed `/token/...` paths remain on the normal application route;
- manual identity image previews still work;
- Network Sync preparation can reach the simulation/review state without silently changing launch economics;
- the public build never requests `eth_sendTransaction` and the launch action ends at simulation;
- a previously confirmed local launch record is rendered as confirmed after reload rather than reset to pending;
- a pending record created by an earlier build can be checked without requesting a new transaction;
- SYNC DUEL practice and asynchronous challenge flows remain wallet-free and non-monetized.

Live data tests depend on PAR, Robinhood Chain RPC and explorer availability.
