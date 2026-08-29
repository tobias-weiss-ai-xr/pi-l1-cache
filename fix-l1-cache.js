// fix-l1-cache.js
// Hotfix: L1 response-cache support for pi (@earendil-works/pi-coding-agent).
//
// Adds two capabilities the stock extension API lacks:
//   1. REPLAY  — an extension may serve a cached response by returning params
//                containing `__piL1Replay: [chunks]` from before_provider_request;
//                pi-ai then feeds the cached chunks through the normal consume
//                path and never contacts the provider.
//   2. CAPTURE — after a successful completion, pi-ai calls options.onStreamComplete
//                (allChunks, requestParams); sdk.js forwards them to extensions as a
//                `provider_stream_complete` event so l1-cache can store the response.
//
// Touches (idempotent, marker-guarded):
//   - node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js  (5 sites)
//   - node_modules/@earendil-works/pi-ai/dist/api/simple-options.js      (1 site)
//   - dist/core/sdk.js                                                   (1 site)
//
// Usage: node fix-l1-cache.js
// Idempotent: exits 0 ("already patched") when all sites are patched;
// exits 1 only if the expected code layout changed.
//
// NOTE: Must run AFTER fix-reasoning-content.js in the postinstall chain.
// Its site-2 oldText assumes the reasoning_content hotfix try/catch exists.

const fs = require("fs")
const path = require("path")

const PACKAGE_ROOT =
  process.env.PI_PACKAGE_ROOT ||
  path.join(__dirname, "node_modules/@earendil-works/pi-coding-agent")

const OPENAI_COMPLETIONS = path.join(
  PACKAGE_ROOT,
  "node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js"
)
const SIMPLE_OPTIONS = path.join(
  PACKAGE_ROOT,
  "node_modules/@earendil-works/pi-ai/dist/api/simple-options.js"
)
const SDK = path.join(PACKAGE_ROOT, "dist/core/sdk.js")

function fail(file, why) {
  console.error(`fix-l1-cache.js: ${file}: ${why}`)
  process.exit(1)
}

function patch(file, sites) {
  if (!fs.existsSync(file)) fail(file, "file not found")
  let src = fs.readFileSync(file, "utf8")
  let applied = 0
  let already = 0
  for (const { name, marker, oldText, newText } of sites) {
    if (src.includes(marker)) {
      already++
      continue
    }
    if (!src.includes(oldText))
      fail(file, `site "${name}" not found (layout changed upstream?)`)
    src = src.replace(oldText, newText)
    applied++
  }
  fs.writeFileSync(file, src)
  console.log(
    `fix-l1-cache.js: ${path.relative(PACKAGE_ROOT, file)}: ${applied} applied, ${already} already patched`
  )
}

// ---------------------------------------------------------------- pi-ai: openai-completions.js
patch(OPENAI_COMPLETIONS, [
  {
    name: "replay-marker-read",
    marker: "__piL1Replay",
    oldText: `            const nextParams = await options?.onPayload?.(params, model);
            if (nextParams !== undefined) {
                params = nextParams;
            }
            const requestOptions = {`,
    newText: `            const nextParams = await options?.onPayload?.(params, model);
            if (nextParams !== undefined) {
                params = nextParams;
            }
            // L1 cache replay: an extension may serve a cached response by
            // returning params with a __piL1Replay array of OpenAI stream chunks.
            // The cached chunks are fed through the normal consume path below,
            // so parsing/usage/stop-reason handling stays identical.
            let __l1ReplayChunks;
            if (params && typeof params === "object" && Array.isArray(params.__piL1Replay)) {
                __l1ReplayChunks = params.__piL1Replay;
                delete params.__piL1Replay;
            }
            const requestOptions = {`,
  },
  {
    name: "replay-skip-provider-call",
    marker: "else try {",
    oldText: `            let openaiStream, response;
            try {
                ({ data: openaiStream, response } = await retryProviderRequest(() => client.chat.completions.create(params, requestOptions).withResponse(), {
                    maxRetries: options?.maxRetries,
                    maxRetryDelayMs: options?.maxRetryDelayMs,
                    signal: options?.signal,
                }));
            } catch (firstError) {`,
    newText: `            let openaiStream, response;
            if (__l1ReplayChunks !== undefined) {
                response = { status: 200, headers: new Headers() };
                openaiStream = __l1ReplayChunks;
            }
            else try {
                ({ data: openaiStream, response } = await retryProviderRequest(() => client.chat.completions.create(params, requestOptions).withResponse(), {
                    maxRetries: options?.maxRetries,
                    maxRetryDelayMs: options?.maxRetryDelayMs,
                    signal: options?.signal,
                }));
            } catch (firstError) {`,
  },
  {
    name: "allChunks-decl",
    marker: "const allChunks = [];",
    oldText: `            await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
            stream.push({ type: "start", partial: output });`,
    newText: `            await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
            stream.push({ type: "start", partial: output });
            const allChunks = [];`,
  },
  {
    name: "allChunks-push",
    marker: "allChunks.push(chunk);",
    oldText: `            for await (const chunk of openaiStream) {
                if (!chunk || typeof chunk !== "object")
                    continue;`,
    newText: `            for await (const chunk of openaiStream) {
                if (!chunk || typeof chunk !== "object")
                    continue;
                allChunks.push(chunk);`,
  },
  {
    name: "onStreamComplete-call",
    marker: "options.onStreamComplete(allChunks, params)",
    oldText: `            if ((compat.supportsFinishReason && !hasFinishReason) || output.stopReason === "pending") {
                throw new Error("Stream ended without finish_reason");
            }
            stream.push({ type: "done", reason: output.stopReason, message: output });`,
    newText: `            if ((compat.supportsFinishReason && !hasFinishReason) || output.stopReason === "pending") {
                throw new Error("Stream ended without finish_reason");
            }
            if (allChunks.length > 0 && options?.onStreamComplete) {
                try {
                    await options.onStreamComplete(allChunks, params);
                }
                catch (_l1err) { }
            }
            stream.push({ type: "done", reason: output.stopReason, message: output });`,
  },
])

// ---------------------------------------------------------------- pi-ai: simple-options.js
patch(SIMPLE_OPTIONS, [
  {
    name: "forward-onStreamComplete",
    marker: "onStreamComplete: options?.onStreamComplete",
    oldText: `        onPayload: options?.onPayload,
        onResponse: options?.onResponse,`,
    newText: `        onPayload: options?.onPayload,
        onResponse: options?.onResponse,
        onStreamComplete: options?.onStreamComplete,`,
  },
])

// ---------------------------------------------------------------- coding-agent: sdk.js
patch(SDK, [
  {
    name: "provider_stream_complete-event",
    marker: 'type: "provider_stream_complete"',
    oldText: `                transformHeaders: async (requestHeaders) => {
                    const headers = mergeProviderAttributionHeaders(model, settingsManager, options?.sessionId, requestHeaders);
                    return headerRunner?.hasHandlers("before_provider_headers")
                        ? headerRunner.emitBeforeProviderHeaders(headers ?? {})
                        : (headers ?? {});
                },
            });`,
    newText: `                transformHeaders: async (requestHeaders) => {
                    const headers = mergeProviderAttributionHeaders(model, settingsManager, options?.sessionId, requestHeaders);
                    return headerRunner?.hasHandlers("before_provider_headers")
                        ? headerRunner.emitBeforeProviderHeaders(headers ?? {})
                        : (headers ?? {});
                },
                onStreamComplete: async (chunks, requestParams) => {
                    const runner = extensionRunnerRef.current;
                    if (!runner?.hasHandlers("provider_stream_complete")) {
                        return;
                    }
                    await runner.emit({
                        type: "provider_stream_complete",
                        payload: requestParams,
                        chunks,
                    });
                },
            });`,
  },
])

console.log("fix-l1-cache.js: all sites OK")
