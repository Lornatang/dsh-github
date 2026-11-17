import { parentPort } from 'node:worker_threads'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'

type Schema = Parameters<AjvJsonSchemaValidator['getValidator']>[0]
type Validator = ReturnType<AjvJsonSchemaValidator['getValidator']>

// Reuse one AJV instance and a bounded cache of compiled validators so repeated
// tool calls do not recompile schemas. The host recycles each worker after a
// fixed number of tasks, which also bounds cache and heap growth.
const MAX_CACHED_SCHEMAS = 16
const MAX_TASKS = 64
const provider = new AjvJsonSchemaValidator()
const cache = new Map<string, Validator>()
let tasks = 0

parentPort?.on('message', (task: { id: number; schema: Schema; value: unknown }) => {
  const { id, schema, value } = task
  let result: { valid: boolean; error?: string }
  try {
    // The SDK's validator contract is synchronous; AJV returns a Promise for
    // asynchronous schemas, which that contract would incorrectly treat as true.
    if (schema && typeof schema === 'object' && '$async' in schema && schema.$async) {
      throw new Error('asynchronous output schemas are not supported')
    }
    const key = JSON.stringify(schema)
    let validator = cache.get(key)
    if (!validator) {
      validator = provider.getValidator(schema)
      if (cache.size >= MAX_CACHED_SCHEMAS) cache.clear()
      cache.set(key, validator)
    }
    const checked = validator(value)
    result = checked.valid ? { valid: true } : { valid: false, error: String(checked.errorMessage ?? 'invalid output').slice(0, 1000) }
  } catch (error) {
    result = { valid: false, error: error instanceof Error ? error.message.slice(0, 1000) : 'invalid output schema' }
  }
  tasks += 1
  parentPort?.postMessage({ id, ...result, retire: tasks >= MAX_TASKS })
})
