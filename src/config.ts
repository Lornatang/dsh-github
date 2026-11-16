import z from '@deepseek-ai/schemastery'

export const DEFAULT_GITHUB_URL = 'https://api.githubcopilot.com/mcp/'

export interface Config {
  serverName: string
  url: string
  toolCallTimeoutMs: number
  toolsets: string
  readOnly: boolean
  credentialSource: 'saved' | 'env' | 'gh'
}

export const Config = z.object({
  serverName: z.string().default('github'),
  url: z.string().default(DEFAULT_GITHUB_URL),
  toolCallTimeoutMs: z.number().step(1).min(1).default(60000),
  toolsets: z.string().default('repos,issues,pull_requests,actions'),
  readOnly: z.boolean().default(false),
  credentialSource: z.union(['saved', 'env', 'gh']).default('saved'),
})
