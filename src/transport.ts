import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { limitResponse, MAX_RESPONSE_BYTES } from './response-limit.js'

function isLoopback(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

/** Keep credentials on the configured origin and never follow redirects implicitly. */
export function createGithubFetch(server: URL, token: string, toolsets: string, readOnly: boolean,
  options: { onLimit?: () => void; onEvent?: () => void; onStreamEnd?: () => void } = {}): FetchLike {
  const allowed = (url: URL): boolean => !url.username && !url.password &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(server) && isLoopback(url))) &&
    url.origin === server.origin
  if (!allowed(server)) throw new Error('github: MCP endpoint must use HTTPS or loopback HTTP without embedded credentials')
  if (!token || /[\r\n]/.test(token) || token.length > 4096) throw new Error('github: invalid token')
  if (!/^[a-z0-9_, -]*$/i.test(toolsets)) throw new Error('github: invalid toolset list')
  return async (value, init) => {
    const target = new URL(value)
    if (!allowed(target)) throw new Error('github: request must remain on the configured MCP origin')
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${token}`)
    if (toolsets) headers.set('X-MCP-Toolsets', toolsets)
    if (readOnly) headers.set('X-MCP-Readonly', 'true')
    const response = await globalThis.fetch(target, { ...init, headers, redirect: 'manual' })
    return limitResponse(response, MAX_RESPONSE_BYTES, options.onLimit ?? (() => undefined), options.onStreamEnd, options.onEvent)
  }
}
