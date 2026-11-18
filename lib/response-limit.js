/** Limit decoded response bytes before the MCP SDK buffers or parses them. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
function limitStream(body, maxBytes, events, onLimit, onEvent) {
    let size = 0;
    let lineSize = 0;
    let lineStartSize = 0;
    let comment = false;
    let previousCR = false;
    let discardFollowingLF = false;
    return body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            if (events) {
                // Fast path for chunks without line separators: account in bulk instead
                // of scanning every byte. Equivalent to the loop below for such chunks.
                if (chunk.length > 0 && !chunk.includes(13) && !chunk.includes(10)) {
                    if (lineSize === 0)
                        comment = chunk[0] === 58;
                    lineSize += chunk.length;
                    size += chunk.length;
                    previousCR = false;
                    if (size > maxBytes) {
                        onLimit();
                        throw new Error('github: MCP response exceeds the byte limit');
                    }
                    controller.enqueue(chunk);
                    return;
                }
                // SSE events end at a blank line. Handle CR, LF and CRLF, including
                // separators split across network chunks, without buffering an event.
                for (const byte of chunk) {
                    if (byte === 10 && previousCR) {
                        previousCR = false;
                        if (!discardFollowingLF && ++size > maxBytes) {
                            onLimit();
                            throw new Error('github: MCP response exceeds the byte limit');
                        }
                        lineStartSize = size;
                        continue;
                    }
                    if (++size > maxBytes) {
                        onLimit();
                        throw new Error('github: MCP response exceeds the byte limit');
                    }
                    if (byte === 13) {
                        discardFollowingLF = lineSize === 0 || comment;
                        if (lineSize === 0) {
                            onEvent?.();
                            size = 0;
                        }
                        else if (comment)
                            size = lineStartSize;
                        lineSize = 0;
                        comment = false;
                        lineStartSize = size;
                        previousCR = true;
                    }
                    else if (byte === 10) {
                        if (lineSize === 0) {
                            onEvent?.();
                            size = 0;
                        }
                        else if (comment)
                            size = lineStartSize;
                        lineSize = 0;
                        comment = false;
                        lineStartSize = size;
                        previousCR = false;
                    }
                    else {
                        if (lineSize === 0)
                            comment = byte === 58;
                        lineSize++;
                        previousCR = false;
                    }
                }
            }
            else {
                size += chunk.byteLength;
                if (size > maxBytes) {
                    onLimit();
                    throw new Error('github: MCP response exceeds the byte limit');
                }
            }
            controller.enqueue(chunk);
        },
    }));
}
function copyResponse(source, body) {
    const response = new Response(body, { status: source.status, statusText: source.statusText, headers: source.headers });
    // OAuth discovery uses response.url to resolve relative redirect locations.
    Object.defineProperties(response, {
        url: { value: source.url },
        redirected: { value: source.redirected },
        type: { value: source.type },
    });
    return response;
}
export async function limitResponse(source, maxBytes, onLimit, onEvent) {
    if (!source.body)
        return source;
    // The SDK catches errors from response.text() on some authorization paths.
    // Read error responses here so an oversized body cannot be swallowed there.
    const redirect = source.status >= 300 && source.status < 400 && source.headers.has('location');
    if (!source.ok && !redirect) {
        const response = copyResponse(source, limitStream(source.body, maxBytes, false, onLimit));
        const bytes = await response.arrayBuffer();
        return copyResponse(source, bytes.byteLength ? bytes : null);
    }
    const events = source.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
    const response = copyResponse(source, limitStream(source.body, maxBytes, events, onLimit, onEvent));
    if (events) {
        // OAuth endpoints are parsed as a whole even if they claim to be SSE.
        // Whole-body consumers need a total limit in addition to the event limit.
        const wholeBody = () => {
            if (!response.body || response.bodyUsed)
                throw new TypeError('Response body is already used');
            return copyResponse(source, limitStream(response.body, maxBytes, false, onLimit));
        };
        Object.defineProperties(response, {
            json: { value: () => wholeBody().json() },
            text: { value: () => wholeBody().text() },
            arrayBuffer: { value: () => wholeBody().arrayBuffer() },
            bytes: { value: async () => new Uint8Array(await wholeBody().arrayBuffer()) },
            blob: { value: () => wholeBody().blob() },
            formData: { value: () => wholeBody().formData() },
        });
    }
    return response;
}
