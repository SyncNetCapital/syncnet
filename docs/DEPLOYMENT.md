# Deployment

1. Run the static audit and JavaScript syntax checks described in `TESTING.md`.
2. Serve the repository locally and smoke-test the homepage, project route, wallet connection, quote checks and simulation path.
3. Deploy the repository root as a static site (for example on Netlify).
4. Confirm that `/token/<address>` routes through the SPA redirect correctly.
5. Confirm on the deployed build that Network Sync can reach the simulation result and that no new wallet transaction request is presented.
6. If transaction execution is enabled in a future release, treat that as a separate reviewed release rather than a silent configuration change.
