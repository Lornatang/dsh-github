# Changelog

## 0.1.4

- Request the `read:user` and `notifications` OAuth scopes by default so profile and notification tools work after browser sign-in. Existing sessions need one reconnect to grant them.
- Add an `oauthScopes` configuration field for requesting extra device-flow scopes such as `gist` or `read:packages`; invalid scope names are rejected at startup.
- Settings page: show the credential source and granted scopes while connected, add a one-click **Reconnect now** button to the additional-permissions banner, and add a **Copy code** button for the device authorization code.

## 0.1.3

- Request the `workflow` OAuth scope by default so browser-authorized tokens can create and update files under `.github/workflows`.
- Detect GitHub's workflow-scope refusal in tool errors (which arrive as tool results, not HTTP scope challenges) and show the same reconnect-with-permissions guidance for OAuth sessions. Existing sessions need one reconnect to grant the new scope.

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
