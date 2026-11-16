import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createGithubFetch } from './transport.js';
import { deferredOutputValidation, validateOutput } from './output-validator.js';
const runFile = promisify(execFile);
const MAX_DISCOVERY_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 100;
const MAX_TOOLS = 1000;
export function publicToolName(server, tool) {
    const raw = `mcp__${server}__${tool}`;
    const clean = raw.replace(/[^A-Za-z0-9_-]/g, '_');
    if (raw === clean && clean.length <= 64)
        return clean;
    const suffix = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 12);
    return `${clean.slice(0, 51)}_${suffix}`;
}
function display(content) {
    if (!Array.isArray(content))
        return '';
    return content.map((part) => {
        if (!part || typeof part !== 'object')
            return '';
        const block = part;
        return block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : `[${String(block['type'] ?? 'unknown')} content]`;
    }).filter(Boolean).join('\n\n');
}
function validateToken(token) {
    const value = token.trim();
    if (!value || value.length > 4096 || !/^[A-Za-z0-9._~+/=-]+$/.test(value))
        throw new Error('github: invalid GitHub token');
    return value;
}
export class GithubBridge {
    #host;
    #options;
    #client;
    #tools = new Map();
    #status = 'idle';
    #source;
    #error;
    #token;
    #generation = 0;
    #controller = new AbortController();
    #tail = Promise.resolve();
    #disposed = false;
    constructor(host, options) {
        this.#host = host;
        this.#options = options;
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.serverName))
            throw new Error('github: invalid serverName');
        // Validate the origin and toolset before accepting any credential.
        createGithubFetch(new URL(options.url), 'validation-token', options.toolsets, options.readOnly);
    }
    snapshot() {
        return { status: this.#status, toolCount: this.#tools.size, source: this.#source, error: this.#error, readOnly: this.#options.readOnly };
    }
    requiresApproval(name) { return this.#tools.get(name)?.approval === true; }
    async start() {
        const generation = this.#generation;
        await this.#enqueue(async () => {
            if (!this.#active(generation))
                return;
            try {
                await this.#options.store.load();
                if (!this.#active(generation))
                    return;
                const stored = this.#options.store.current;
                const source = this.#options.credentialSource === 'saved' ? stored.source : this.#options.credentialSource;
                if (!source) {
                    this.#status = 'idle';
                    return;
                }
                await this.#establish(source, stored.token, false, generation);
            }
            catch (error) {
                this.#fail(generation, error);
            }
        });
    }
    async connect(input) {
        const generation = this.#invalidate();
        await this.#enqueue(async () => {
            if (!this.#active(generation))
                return;
            try {
                await this.#shutdownClient();
                if (!this.#active(generation))
                    return;
                await this.#establish(input.source, input.source === 'token' ? input.token : undefined, true, generation);
            }
            catch (error) {
                this.#fail(generation, error);
            }
        });
        return this.snapshot();
    }
    async disconnect() {
        const generation = this.#invalidate();
        await this.#enqueue(async () => {
            await this.#shutdownClient();
            if (!this.#active(generation))
                return;
            try {
                await this.#options.store.destroy();
            }
            catch (error) {
                this.#fail(generation, error);
                return;
            }
            if (!this.#active(generation))
                return;
            this.#status = 'idle';
            this.#source = undefined;
            this.#error = undefined;
            this.#token = undefined;
        });
        return this.snapshot();
    }
    async dispose() {
        if (this.#disposed)
            return;
        this.#disposed = true;
        this.#invalidate();
        await this.#enqueue(async () => { await this.#shutdownClient(); this.#token = undefined; });
    }
    #active(generation) { return !this.#disposed && generation === this.#generation; }
    #invalidate() {
        this.#generation++;
        this.#controller.abort();
        this.#controller = new AbortController();
        return this.#generation;
    }
    async #enqueue(work) {
        const run = this.#tail.then(work, work);
        this.#tail = run.catch(() => undefined);
        return run;
    }
    #redact(message) {
        return this.#token ? message.split(this.#token).join('[REDACTED]') : message;
    }
    #fail(generation, error) {
        if (!this.#active(generation))
            return;
        this.#status = 'error';
        this.#error = this.#redact(error instanceof Error ? error.message : 'GitHub connection failed');
        this.#host.logger.error(`github: ${this.#error}`);
    }
    async #credential(source, token) {
        if (source === 'token')
            return validateToken(token ?? '');
        if (source === 'env')
            return validateToken(process.env['GITHUB_TOKEN'] ?? '');
        try {
            const result = await runFile('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8', timeout: 10000, maxBuffer: 8192, windowsHide: true });
            return validateToken(result.stdout);
        }
        catch {
            throw new Error('github: GitHub CLI is unavailable or not authenticated; run gh auth login');
        }
    }
    async #establish(source, supplied, save, generation) {
        const signal = this.#controller.signal;
        this.#status = 'connecting';
        this.#source = source;
        this.#error = undefined;
        const token = await this.#credential(source, supplied);
        if (!this.#active(generation))
            return;
        this.#token = token;
        const client = new Client({ name: 'dsh-github', version: '0.1.0' }, { jsonSchemaValidator: deferredOutputValidation });
        let events = 0;
        let since = Date.now();
        const serverUrl = new URL(this.#options.url);
        const safeFetch = createGithubFetch(serverUrl, token, this.#options.toolsets, this.#options.readOnly, {
            onEvent: () => {
                const now = Date.now();
                if (now - since >= 10000) {
                    since = now;
                    events = 0;
                }
                if (++events > 1000)
                    throw new Error('MCP server sent too many events');
            },
        });
        const fetch = (value, init) => {
            const isEventStream = (init?.method?.toUpperCase() ?? 'GET') === 'GET' && (new Headers(init?.headers).get('accept') ?? '').includes('text/event-stream');
            const signals = [signal];
            if (!isEventStream)
                signals.push(AbortSignal.timeout(this.#options.toolCallTimeoutMs));
            if (init?.signal)
                signals.push(init.signal);
            return safeFetch(value, { ...init, signal: AbortSignal.any(signals) });
        };
        const transport = new StreamableHTTPClientTransport(serverUrl, { fetch });
        client.onclose = () => {
            if (this.#client === client && this.#active(generation)) {
                this.#client = undefined;
                this.#clearTools();
                this.#status = 'error';
                this.#error = 'GitHub MCP connection closed; reconnect to continue';
            }
        };
        try {
            await client.connect(transport, { signal, timeout: this.#options.toolCallTimeoutMs });
            if (!this.#active(generation))
                throw new Error('connection cancelled');
            const tools = await this.#discover(client, signal);
            if (!this.#active(generation))
                throw new Error('connection cancelled');
            if (save && source !== 'env') {
                await this.#options.store.patch({ source, token: source === 'token' ? token : undefined }, () => this.#active(generation));
            }
            if (!this.#active(generation))
                throw new Error('connection cancelled');
            this.#client = client;
            this.#register(client, tools, signal, token);
            if (!this.#active(generation))
                throw new Error('connection cancelled');
            this.#status = 'ready';
            this.#error = undefined;
        }
        catch (error) {
            if (this.#client === client) {
                this.#client = undefined;
                this.#clearTools();
            }
            await client.close().catch(() => undefined);
            throw error;
        }
    }
    async #discover(client, signal) {
        const tools = [];
        const cursors = new Set();
        let cursor;
        let bytes = 0;
        do {
            if (cursors.size >= MAX_PAGES)
                throw new Error('MCP server returned too many tool pages');
            const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: this.#options.toolCallTimeoutMs });
            bytes += Buffer.byteLength(JSON.stringify(page), 'utf8');
            if (bytes > MAX_DISCOVERY_BYTES || tools.length + page.tools.length > MAX_TOOLS)
                throw new Error('MCP tool discovery exceeds its limit');
            tools.push(...page.tools);
            cursor = page.nextCursor;
            if (cursor && cursors.has(cursor))
                throw new Error('MCP server repeated a continuation cursor');
            if (cursor)
                cursors.add(cursor);
        } while (cursor);
        const names = new Set();
        for (const tool of tools) {
            const name = publicToolName(this.#options.serverName, tool.name);
            if (names.has(name))
                throw new Error('MCP server returned duplicate tool names');
            names.add(name);
        }
        return tools;
    }
    #register(client, tools, connectionSignal, token) {
        this.#clearTools();
        try {
            for (const tool of tools) {
                const name = publicToolName(this.#options.serverName, tool.name);
                const definition = {
                    name, description: tool.description ?? '', parameters: tool.inputSchema,
                    output: {
                        schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'], additionalProperties: false },
                        render: (_args, result) => [{ type: 'text', text: display(result?.content) }],
                    },
                    execute: async (args, context) => {
                        const signal = context.signal ? AbortSignal.any([connectionSignal, context.signal]) : connectionSignal;
                        try {
                            const result = await client.callTool({ name: tool.name, arguments: (typeof args === 'object' && args !== null ? args : {}) }, undefined, { timeout: this.#options.toolCallTimeoutMs, signal });
                            if (result.isError)
                                throw new Error(display(result.content) || 'GitHub MCP tool failed');
                            if (tool.outputSchema) {
                                if (result.structuredContent === undefined)
                                    throw new Error(`github: tool ${tool.name} did not return structured output`);
                                await validateOutput(tool.outputSchema, result.structuredContent, this.#options.toolCallTimeoutMs, signal);
                            }
                            const content = Array.isArray(result.content) && result.content.length ? result.content : result.structuredContent === undefined ? [] : [{ type: 'text', text: JSON.stringify(result.structuredContent) }];
                            return { content: JSON.parse(JSON.stringify(content).split(token).join('[REDACTED]')) };
                        }
                        catch (error) {
                            throw new Error((error instanceof Error ? error.message : 'GitHub MCP tool failed').split(token).join('[REDACTED]'));
                        }
                    },
                };
                this.#tools.set(name, { dispose: this.#host.register(definition), approval: tool.annotations?.readOnlyHint !== true });
            }
        }
        catch (error) {
            this.#clearTools();
            throw error;
        }
    }
    async #shutdownClient() {
        const client = this.#client;
        this.#client = undefined;
        this.#clearTools();
        await client?.close().catch(() => undefined);
    }
    #clearTools() {
        for (const tool of this.#tools.values())
            tool.dispose();
        this.#tools.clear();
    }
}
