# Changelog

## 0.1.2

- Speed up credential redaction with a cached single-pass pattern instead of per-string secret scans, and reuse pooled validation workers instead of spawning one per structured tool call.
- Harden structured-output validation: a stuck validator can no longer hold a worker slot past its timeout, and abandoned workers are capped.
- Enforce a 5-second deadline on connection-route request bodies and skip responses on destroyed sockets.
- Drop malformed fields when loading an encrypted credential session, and forward only plain-object tool arguments.
- Scan SSE chunks without line breaks in bulk while keeping per-event byte accounting identical.
- Pause settings-page status polling while the browser tab is hidden, and report the package version in the MCP client identity.

## 0.1.1

- Add GitHub browser authorization using the bundled OAuth app, with cancellation, encrypted token storage, refresh and additional-permission prompts.

## 0.1.0

- Connect a DSH profile to GitHub's hosted MCP server using a personal access token, GitHub CLI, or an environment token.
- Register discovered repository, issue, pull request, and Actions tools, with DSH approval for calls not marked read-only.
- Add a GitHub settings page, encrypted profile credentials, request limits, and mock and real-DSH integration checks.
