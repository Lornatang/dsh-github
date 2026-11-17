import { Worker } from 'node:worker_threads';
// The SDK validator API is synchronous. Defer its schema validation to our
// worker pool, which is invoked for every tool page before a result reaches DSH.
export const deferredOutputValidation = {
    getValidator(_schema) {
        return (data) => ({ valid: true, data: data, errorMessage: undefined });
    },
};
const MAX_WORKERS = 4;
const MAX_WAITERS = 32;
// A validator stuck in pathological schema work (for example catastrophic regex
// backtracking) may ignore terminate() for a long time. Never let cleanup hold a
// validation slot, and cap abandoned workers so they cannot accumulate unbounded.
const TERMINATE_GRACE_MS = 1000;
const MAX_ABANDONED = 8;
let slots = 0;
const waiting = [];
async function acquire(signal) {
    if (signal.aborted)
        throw new Error('github: output validation timed out or was cancelled');
    if (slots < MAX_WORKERS) {
        slots++;
        return;
    }
    if (waiting.length >= MAX_WAITERS)
        throw new Error('github: too many pending output validations');
    await new Promise((resolve, reject) => {
        const waiter = { signal, resolve, reject, abort: () => {
                const index = waiting.indexOf(waiter);
                if (index !== -1)
                    waiting.splice(index, 1);
                reject(new Error('github: output validation timed out or was cancelled'));
            } };
        waiting.push(waiter);
        signal.addEventListener('abort', waiter.abort, { once: true });
        if (signal.aborted)
            waiter.abort();
    });
}
function release() {
    const next = waiting.shift();
    if (!next) {
        slots--;
        return;
    }
    next.signal.removeEventListener('abort', next.abort);
    next.resolve();
}
const idle = [];
let spawned = 0;
let nextTaskId = 1;
const abandoned = new Set();
function spawnWorker() {
    const worker = new Worker(new URL('./output-validator-worker.js', import.meta.url), {
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    // Idle or stuck workers must never keep the host process alive.
    worker.unref();
    spawned += 1;
    return { worker, retire: false };
}
async function retireWorker(entry) {
    spawned -= 1;
    const { worker } = entry;
    worker.removeAllListeners();
    abandoned.add(worker);
    const termination = worker.terminate().then(() => { abandoned.delete(worker); }, () => { abandoned.delete(worker); });
    let grace;
    const expired = new Promise((resolve) => { grace = setTimeout(resolve, TERMINATE_GRACE_MS); grace.unref(); });
    await Promise.race([termination, expired]);
    if (grace)
        clearTimeout(grace);
    // A worker that outlived the grace period stays unref'd and resource-limited;
    // it is removed from the abandoned set whenever terminate() finally settles.
}
class InvalidOutput extends Error {
}
function runTask(entry, schema, value, signal) {
    return new Promise((resolve, reject) => {
        const id = nextTaskId++;
        const { worker } = entry;
        const cleanup = () => {
            worker.off('message', onMessage);
            worker.off('error', onError);
            worker.off('exit', onExit);
            signal.removeEventListener('abort', onAbort);
        };
        const onMessage = (message) => {
            if (message.id !== id)
                return;
            entry.retire = message.retire === true;
            cleanup();
            if (message.valid)
                resolve();
            else
                reject(new InvalidOutput(message.error ?? 'invalid output'));
        };
        const onError = (error) => { cleanup(); reject(new Error('github: output validation worker failed', { cause: error })); };
        const onExit = () => { cleanup(); reject(new Error('github: output validation worker exited unexpectedly')); };
        const onAbort = () => { cleanup(); reject(new Error('github: output validation timed out or was cancelled')); };
        worker.on('message', onMessage);
        worker.on('error', onError);
        worker.on('exit', onExit);
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            worker.postMessage({ id, schema, value });
        }
        catch (error) {
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}
export async function validateOutput(schema, value, timeoutMs, signal) {
    if (abandoned.size >= MAX_ABANDONED)
        throw new Error('github: output validation is unavailable; previous validators did not stop');
    const timeout = AbortSignal.timeout(Math.min(timeoutMs, 5000));
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    await acquire(combined);
    let entry;
    let healthy = false;
    try {
        if (combined.aborted)
            throw new Error('github: output validation timed out or was cancelled');
        entry = idle.pop() ?? spawnWorker();
        try {
            await runTask(entry, schema, value, combined);
            healthy = true;
        }
        catch (error) {
            if (error instanceof InvalidOutput) {
                // The worker is healthy; only the data failed validation. Keep it pooled.
                healthy = true;
                throw new Error(`github: structured output does not match its schema: ${error.message}`);
            }
            throw error;
        }
    }
    finally {
        if (entry) {
            if (healthy && !entry.retire)
                idle.push(entry);
            else
                await retireWorker(entry);
        }
        release();
    }
}
