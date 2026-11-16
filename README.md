---
description: "GitHub's official MCP server inside a dsh profile: encrypted token or GitHub CLI credentials, agent tools, write approval, and a connection settings page."
kind: "package-bundle"
---

# @lornatang/dsh-github

English | [中文](README.zh.md)

## Summary

`dsh-github` connects a DeepSeek Harness profile to GitHub's hosted MCP server. It registers the server's tools for repository files, issues, pull requests and Actions, and adds a GitHub connection page to the Web client. Connect with an already authenticated GitHub CLI or a personal access token; the bridge asks DSH for approval before calls that are not marked read-only by the server. The boundary: the available tools and account permissions are defined by GitHub, and this package does not implement the Codex GitHub app or its OAuth flow.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The bridge owns the connection and registration; GitHub supplies the tool definitions and enforces the account's repository permissions. DSH's existing tool policies also apply. Install into the profile whose sessions should use GitHub:

```text
dsh plugin --profile <name> add @lornatang/dsh-github
dsh plugin --profile <name> remove @lornatang/dsh-github
```

For the GitHub Release tarball, use `dsh plugin --profile <name> add https://github.com/Lornatang/dsh-github/releases/download/v0.1.0/lornatang-dsh-github-0.1.0.tgz`. Restart DSH after adding or removing the bundle, then open Settings → GitHub in a Web profile.

### Connect GitHub

Choose **Connect with GitHub CLI** after installing `gh` and running `gh auth login` on the DSH host. The bridge reads the active `github.com` token through `gh auth token`; the token is not written to the profile. A saved connection remembers only that it should use `gh` again. This is GitHub CLI authentication, not an OAuth flow implemented by this plugin.

Alternatively, paste a GitHub personal access token into the password field and choose **Connect with token**. The bridge tests the connection before replacing the saved credential. It stores the token in an encrypted profile file; the settings page never returns it. Give the token the repository access and permissions needed for the requested work. If the connection fails, the previous saved credential is retained.

For a headless host, configure `credentialSource: env` and provide `GITHUB_TOKEN` to the DSH process, or set `credentialSource: gh` to use an already authenticated `gh`. The configured source takes precedence over the saved connection at startup.

### What you get

| Surface | Provided by |
|---|---|
| `mcp__github__<tool>` for each tool GitHub advertises in the selected toolsets | host entry, `src/bridge.ts` |
| Approval request for a tool without `readOnlyHint: true` | host entry, `src/index.ts` |
| Settings → GitHub page with connection status and credential controls | client entry, `src/client/index.tsx` |
| `GET /plugins/github/status`, `POST /plugins/github/connect` and `POST /plugins/github/disconnect` | host entry, `src/routes.ts` |
| `<profile>/data/dsh-github-<serverName>-<hash>.json` | host entry, `src/store.ts` |

The default toolsets are `repos,issues,pull_requests,actions`. Their actual tools can change on GitHub's side and are also affected by account permissions and GitHub policies. With suitable permissions, an agent can read files, create or update files, push a group of files, create a pull request, or inspect an issue and its checks. For large local repositories, normal Git operations may be a better fit than passing file contents through MCP tools.

Tools are named `mcp__github__<name>`. Characters outside letters, digits, hyphen and underscore become underscores; a changed or overlong name is shortened and receives a twelve-character SHA-256 suffix. The bridge uses the server's descriptions and input schemas. It validates declared structured output, renders text blocks as text, and represents other content blocks by type. A server error fails the call. The GitHub token is redacted from tool output and error messages when its exact value appears.

The bridge delegates to DSH's approval service for a tool unless the server marks it `readOnlyHint: true`; a missing hint is treated as requiring approval. Existing DSH policy decisions still apply. Read-only hints are provided by the configured MCP server, so use a trusted endpoint. The plugin does not grant GitHub permissions or approve calls on the user's behalf.

### Credentials

The saved source and, when applicable, the personal access token are stored in an AES-256-GCM envelope under `<profile>/data/`. The file path is authenticated data. The 32-byte key comes from the operating-system credential store through `@napi-rs/keyring`, or from `DSH_GITHUB_ENCRYPTION_KEY` as standard Base64 for exactly 32 bytes. There is no plaintext fallback. On POSIX the file is restricted to `0600`, the data directory to `0700`, and symlinks, unsafe ownership and hard links are checked. On Windows, restrict the profile directory with ACLs.

For a headless host without an available credential store, set a persistent `DSH_GITHUB_ENCRYPTION_KEY` before saving a connection; keep the key and profile path across restarts. Disconnect removes the local encrypted file and keyring entry and unregisters tools; it does not revoke a GitHub token or sign out of `gh`. Use one DSH process per profile because this package does not coordinate concurrent writers.

### Configuration

The bundled row sets the defaults below. A profile can override them in its patch:

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: github
  config:
    serverName: github
    url: 'https://api.githubcopilot.com/mcp/'
    toolsets: 'repos,issues,pull_requests,actions'
    readOnly: false
    credentialSource: saved
```

| Field | Default | Meaning |
|---|---|---|
| `serverName` | `github` | Tool namespace and credential identity; 1–64 letters, numbers, hyphens or underscores. |
| `url` | `https://api.githubcopilot.com/mcp/` | GitHub MCP endpoint. HTTPS is required except for loopback HTTP. |
| `toolCallTimeoutMs` | `60000` | Connection, discovery and tool-call timeout in milliseconds. |
| `toolsets` | `repos,issues,pull_requests,actions` | Comma-separated toolsets passed in `X-MCP-Toolsets`. |
| `readOnly` | `false` | Send `X-MCP-Readonly: true` to request only read tools. |
| `credentialSource` | `saved` | `saved`, `env` (`GITHUB_TOKEN`), or `gh` (GitHub CLI). |

Every request stays on the configured origin, with redirects not followed automatically. MCP responses are limited to 16 MiB and discovery to 8 MiB, 100 pages and 1,000 tools.

### Troubleshooting

- **GitHub CLI is unavailable or not authenticated** — install `gh` on the DSH host and run `gh auth login`, or use a personal access token.
- **Connection fails or tools are missing** — check network access to GitHub's MCP endpoint, account and organization policies, token permissions, selected toolsets, and the DSH log. Select a Connect button to retry.
- **Secure key storage is unavailable** — unlock the system credential store or set `DSH_GITHUB_ENCRYPTION_KEY` to a persistent Base64-encoded 32-byte key.
- **Stored credentials cannot be decrypted** — restore the original key and profile path, or remove the saved credential and reconnect.
- **A write is denied** — check DSH's approval channel and policies as well as the GitHub account or token permissions.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The `dsh.bundle.patch` manifest inserts a host row; `dsh.client` exposes the Web settings section. `apply` creates a profile-specific store and bridge, binds the fenced routes, listens for DSH's pre-execution policy event, and starts the configured credential source. The bridge opens a Streamable HTTP MCP connection, discovers all tool pages, and registers one DSH tool per server definition. A failed or cancelled connection removes its registrations. Disconnect aborts outstanding requests before deleting saved state; unloading preserves state for the next start.

| Source | Contents |
|---|---|
| `cordis.patch.yml` | Profile row and defaults. |
| `src/index.ts` | Host entry, route binding and approval policy. |
| `src/config.ts` | Configuration schema and defaults. |
| `src/bridge.ts` | Credentials, MCP lifecycle, discovery and registered tools. |
| `src/transport.ts`, `src/response-limit.ts` | Origin restriction, headers and response limits. |
| `src/store.ts` | Encrypted credential file and host keyring. |
| `src/routes.ts` | Fenced connection routes. |
| `src/output-validator.ts`, `src/output-validator-worker.ts` | Worker-isolated validation of structured output. |
| `src/client/index.tsx` | GitHub settings page. |
| `tests/*.test.mjs` | Mock MCP, credential, lifecycle and approval tests. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [GitHub MCP Server](https://github.com/github/github-mcp-server) and [remote server configuration](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md).
- [GitHub personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).
- [DeepSeek Harness configuration catalog](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md).
- [CHANGELOG.md](CHANGELOG.md), [NOTICE](NOTICE), and [Apache-2.0 license](LICENSE).

-----

<a id="model-experience"></a>
## Model Experience

The model sees the registered GitHub tool names, descriptions and input schemas. Results are returned as tool content; the settings page and credentials are not part of the model prompt. Requests to change GitHub can trigger DSH approval.

#### KV Cache effect

Connecting adds the discovered tool definitions to the request prefix; disconnecting removes them. A changed toolset or server catalog changes that prefix and can invalidate cached tokens after the first changed definition.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **No built-in GitHub OAuth app** — authenticate with `gh` or supply a token. GitHub may impose account, organization or MCP access policies.
- **One connection per profile row** — the Web routes use a fixed prefix, so the settings page assumes one GitHub bridge per profile.
- **Server-defined capabilities** — tool names, schemas and read-only hints can change; server hints are not a security boundary for an untrusted endpoint.
- **No automatic recovery guarantee** — if the connection closes or a request fails, reconnect from Settings or restart the configured headless source.
- **Credentials are tied to profile path and key** — moving the profile or changing the key makes saved state unreadable. Disconnect does not revoke upstream credentials.
- **Plain-text rendering** — non-text MCP content is represented by a type placeholder, not displayed as native media.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`npm run build` cleans and compiles the host and client, then bundles the client into `lib/client.js`. `lib` is committed. `npm run typecheck` checks both TypeScript projects; `npm test` builds and runs the mock-backed tests. `npm run test:dsh` installs the packed bundle into a temporary real DSH profile, checks its request fence and encrypted credential file, and exercises the settings page in Chrome when available. Set `DSH_TEST_BINARY` and `CHROME_PATH` for non-default locations. Node.js 22.19 or newer is required.

</details>
