import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { invalidateTargetCache, selectTargetCached, targets, withSession } from "../src/wsl-chromium-cdp.ts"
import plugin from "../src/wsl-chromium-cdp.ts"

const originalFetch = globalThis.fetch
const originalNow = Date.now
const originalWebSocket = globalThis.WebSocket

// A CDP socket for the default stub target. Every command is answered with the frame the given factory builds
// from the outgoing request id, so an evaluate, an enable, and an insertText can each be scripted independently.
class FakeCdpSocket {
  constructor(url) {
    assert.equal(url, "ws://127.0.0.1:9222/devtools/page/page-1")
    this.listeners = new Map()
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
    if (type === "open") queueMicrotask(() => listener())
  }

  send(frame) {
    const request = JSON.parse(frame)
    queueMicrotask(() => {
      const message = this.reply(request)
      for (const listener of this.listeners.get("message") ?? []) listener({ data: JSON.stringify(message) })
    })
  }

  close() {}
}

// Answers every method with a bare success envelope, which is the shortest path to a Runtime.evaluate reply.
function evaluatingSocket(runtimeResult) {
  return class extends FakeCdpSocket {
    reply(request) { return { id: request.id, result: request.method === "Runtime.evaluate" ? runtimeResult : {} } }
  }
}

// Records every tool by name so one setup call can drive any subset of the seven tools.
async function registerTools() {
  const tools = new Map()
  await plugin.setup({ tool: { transform: async (register) => register({ add: (tool) => { tools.set(tool.name, tool) } }) } })
  return tools
}

let calls
let payload
let fetchError
let now

function setupFetch() {
  calls = 0
  payload = [{ id: "page-1", title: "First", url: "https://example.com", type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/page-1" }]
  fetchError = undefined
  now = 1000
  Date.now = () => now
  globalThis.fetch = async (url) => {
    calls += 1
    assert.equal(url, "http://127.0.0.1:9222/json/list")
    if (fetchError) throw fetchError
    return { ok: true, status: 200, json: async () => payload }
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  Date.now = originalNow
  globalThis.WebSocket = originalWebSocket
  invalidateTargetCache()
})

test("consecutive targets calls share the default TTL cache", async () => {
  setupFetch()
  await targets()
  await targets()
  assert.equal(calls, 1)
})

test("targets fetches again after the default TTL", async () => {
  setupFetch()
  await targets()
  now += 501
  await targets()
  assert.equal(calls, 2)
})

test("bypass fetches and does not replace an existing cache entry", async () => {
  setupFetch()
  await targets()
  payload = [{ id: "page-2", title: "Second", url: "https://example.org", type: "page" }]
  const bypassed = await targets({ bypass: true })
  const cached = await targets()
  assert.equal(calls, 2)
  assert.equal(bypassed[0].id, "page-2")
  assert.equal(cached[0].id, "page-1")
})

test("a bypassed fetch does not seed the cache", async () => {
  setupFetch()
  await targets({ bypass: true })
  await targets()
  assert.equal(calls, 2)
})

test("invalidating the target cache forces a fetch", async () => {
  setupFetch()
  await targets()
  invalidateTargetCache()
  await targets()
  assert.equal(calls, 2)
})

test("failed fetches are not cached and preserve the HTTP error", async () => {
  setupFetch()
  globalThis.fetch = async () => {
    calls += 1
    return { ok: false, status: 500 }
  }
  await assert.rejects(targets(), { message: "CDP target query failed: HTTP 500" })
  await assert.rejects(targets(), { message: "CDP target query failed: HTTP 500" })
  assert.equal(calls, 2)
})

test("wsl_chromium_list uses a 2000ms target TTL", async () => {
  setupFetch()
  let listTool
  await plugin.setup({ tool: { transform: async (register) => register({ add: (tool) => { if (tool.name === "wsl_chromium_list") listTool = tool } }) } })
  await listTool.execute()
  now += 1999
  await listTool.execute()
  assert.equal(calls, 1)
  now += 2
  await listTool.execute()
  assert.equal(calls, 2)
})

test("a cached target miss invalidates and retries once with a fresh fetch", async () => {
  setupFetch()
  await targets()
  await assert.rejects(selectTargetCached("missing-id"), { message: "No page target with id missing-id" })
  assert.equal(calls, 2)
})

test("a fresh target miss does not perform a wasted retry", async () => {
  setupFetch()
  await assert.rejects(selectTargetCached("missing-id"), { message: "No page target with id missing-id" })
  assert.equal(calls, 1)
})

test("selectTargetCached selects the first page target", async () => {
  setupFetch()
  const page = await selectTargetCached()
  assert.equal(page.id, "page-1")
  assert.equal(calls, 1)
})

test("navigate invalidates the target cache when a CDP command fails", async () => {
  setupFetch()
  await targets()
  assert.equal(calls, 1)
  let navigateTool
  await plugin.setup({ tool: { transform: async (register) => register({ add: (tool) => { if (tool.name === "wsl_chromium_navigate") navigateTool = tool } }) } })

  globalThis.WebSocket = class {
    listeners = new Map()

    constructor(url) {
      assert.equal(url, "ws://127.0.0.1:9222/devtools/page/page-1")
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? []
      listeners.push(listener)
      this.listeners.set(type, listeners)
      if (type === "open") queueMicrotask(() => listener())
    }

    send(frame) {
      const request = JSON.parse(frame)
      queueMicrotask(() => {
        for (const listener of this.listeners.get("message") ?? []) {
          listener({ data: JSON.stringify({ id: request.id, error: { message: "boom" } }) })
        }
      })
    }

    close() {}
  }

  const outcome = await navigateTool.execute({ url: "https://example.com/next" })
  assert.equal(outcome.content, "Browser operation failed: boom")
  assert.equal(calls, 2)

  await targets()
  assert.equal(calls, 3)
})

test("a target read and a list read do not inherit each other's TTL entry", async () => {
  setupFetch()
  await selectTargetCached(undefined)
  assert.equal(calls, 1)
  now += 600
  await targets({ maxAgeMs: 2000 })
  assert.equal(calls, 2)
  await targets({ maxAgeMs: 2000 })
  assert.equal(calls, 2)
  now += 600
  await selectTargetCached(undefined)
  assert.equal(calls, 3)
})

test("an empty target list is cached for the short target TTL, not the requested TTL", async () => {
  setupFetch()
  payload = []
  await targets({ maxAgeMs: 2000 })
  now += 499
  await targets({ maxAgeMs: 2000 })
  assert.equal(calls, 1)
  now += 2
  await targets({ maxAgeMs: 2000 })
  assert.equal(calls, 2)
})

test("non-string and missing page titles are normalized instead of reaching tool output", async () => {
  setupFetch()
  payload = [
    { id: "page-1", title: 42, url: "https://example.com/numeric", type: "page" },
    { id: "page-2", url: "https://example.com/missing", type: "page" },
  ]
  let listTool
  await plugin.setup({ tool: { transform: async (register) => register({ add: (tool) => { if (tool.name === "wsl_chromium_list") listTool = tool } }) } })
  const outcome = await listTool.execute()
  assert.equal(outcome.content.includes("undefined"), false)
  assert.equal(outcome.content.includes("TypeError"), false)
  assert.equal(outcome.content.includes("[page-1] \nhttps://example.com/numeric"), true)
  assert.equal(outcome.content.includes("[page-1] 42"), false)
  assert.equal(outcome.content.includes("[page-2] \nhttps://example.com/missing"), true)
})

// Answers every CDP command with an empty result, so Page.enable and Page.navigate succeed and the only
// failure the test can observe is the poll loop itself.
class NavigatingWebSocket {
  constructor(url) {
    assert.equal(url, "ws://127.0.0.1:9222/devtools/page/page-1")
    this.listeners = new Map()
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
    if (type === "open") queueMicrotask(() => listener())
  }

  send(frame) {
    const request = JSON.parse(frame)
    queueMicrotask(() => {
      for (const listener of this.listeners.get("message") ?? []) {
        listener({ data: JSON.stringify({ id: request.id, result: {} }) })
      }
    })
  }

  close() {}
}

test("navigate does not report Opened URL when the poll deadline expires", async () => {
  setupFetch()
  // The page never reaches the destination, so the poll can never settle and must end in an error.
  payload = [{ id: "page-1", title: "First", url: "https://example.com", type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/page-1" }]
  let navigateTool
  await plugin.setup({ tool: { transform: async (register) => register({ add: (tool) => { if (tool.name === "wsl_chromium_navigate") navigateTool = tool } }) } })
  globalThis.WebSocket = NavigatingWebSocket
  // Date.now advances 2000ms per call so the deadline check fails on the next iteration. The loop still awaits
  // the real global setTimeout(200) once, so the loop exits after two real iterations instead of twenty-five.
  Date.now = (() => { let value = now; return () => (value += 2000) })()

  const started = process.hrtime.bigint()
  const outcome = await navigateTool.execute({ url: "https://example.com/destination" })
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

  assert.equal(outcome.content.includes("Opened URL:"), false)
  assert.equal(outcome.content.includes("https://example.com/destination"), true)
  assert.equal(outcome.content.startsWith("Browser operation failed:"), true)
  assert.ok(elapsedMs < 2000, `navigate poll should be fast, took ${elapsedMs.toFixed(1)}ms`)
})

test("a rejected navigate URL leaves the shared target cache intact", async () => {
  setupFetch()
  await targets()
  assert.equal(calls, 1)
  let navigateTool
  await plugin.setup({ tool: { transform: async (register) => register({ add: (tool) => { if (tool.name === "wsl_chromium_navigate") navigateTool = tool } }) } })

  const outcome = await navigateTool.execute({ url: "file:///etc/passwd" })

  assert.equal(outcome.content, "Browser operation failed: Only http, https, and about:blank URLs are allowed")
  assert.equal(calls, 1)
  await targets()
  assert.equal(calls, 1)
})

test("all seven tools register an own execute function", async () => {
  setupFetch()
  const registered = []
  await plugin.setup({ tool: { transform: async (register) => register({ add: (tool) => { registered.push(tool) } }) } })
  assert.equal(registered.length, 7)
  for (const tool of registered) {
    assert.equal(Object.hasOwn(tool, "execute"), true, `${tool.name} must own execute`)
    assert.equal(typeof tool.execute, "function", `${tool.name} execute must be a function`)
  }
})

// A frame that carries no result field at all is what a real CDP endpoint sends when a command produced no
// envelope. openSession resolves the missing field to {}, so every caller that reads response.result sees
// undefined and must treat that as a CDP-level fault rather than dereferencing a missing object.
class ResultlessFrameSocket extends FakeCdpSocket {
  reply(request) { return { id: request.id } }
}

test("a Runtime.evaluate reply with no result field rejects as an empty response", async () => {
  setupFetch()
  globalThis.WebSocket = ResultlessFrameSocket

  // First prove the reachability claim directly: the session layer swallows the missing result into {}.
  const page = await selectTargetCached()
  const resolved = await withSession(page, (session) => session.send("Runtime.evaluate", { expression: "1", returnByValue: true }))
  assert.deepEqual(resolved, {})

  // Then observe the real failure surface. evaluate() is module-private, so the only reachable proof of the
  // thrown message is the tool that wraps it, and wsl_chromium_controls evaluates exactly once.
  const tools = await registerTools()
  const outcome = await tools.get("wsl_chromium_controls").execute({})

  assert.equal(outcome.content.startsWith("Browser operation failed: "), true)
  assert.equal(outcome.content.replace("Browser operation failed: ", ""), "Page query failed: empty response")
})

test("an Uncaught exception surfaces the description instead of the bare word", async () => {
  setupFetch()
  const tools = await registerTools()
  const controls = tools.get("wsl_chromium_controls")

  // Chromium reports a page-thrown exception as text "Uncaught" plus a stack-bearing description. Falling back to
  // the verbatim text would report both cases as the bare word "Uncaught" and hide the actual cause.
  globalThis.WebSocket = evaluatingSocket({
    exceptionDetails: { text: "Uncaught", exception: { description: "SyntaxError: Unexpected identifier 'x'" } },
  })
  const surfaced = await controls.execute({})
  assert.equal(surfaced.content.replace("Browser operation failed: ", ""), "Page query failed: SyntaxError: Unexpected identifier 'x'")

  // A long description is bounded, so a huge page stack cannot flood the tool result.
  const longDescription = `SyntaxError: ${"z".repeat(500)}`
  invalidateTargetCache()
  globalThis.WebSocket = evaluatingSocket({
    exceptionDetails: { text: "Uncaught", exception: { description: longDescription } },
  })
  const bounded = (await controls.execute({})).content.replace("Browser operation failed: ", "")
  const prefix = "Page query failed: "
  assert.equal(bounded.startsWith(prefix), true)
  assert.equal(bounded.slice(prefix.length), longDescription.slice(0, 300))
  assert.equal(bounded.slice(prefix.length).length, 300)
})

test("a 200 status with a null /json/version body reports unexpected data, not a TypeError", async () => {
  setupFetch()
  globalThis.fetch = async (url) => {
    assert.equal(url, "http://127.0.0.1:9222/json/version")
    return { ok: true, status: 200, json: async () => null }
  }

  const tools = await registerTools()
  const outcome = await tools.get("wsl_chromium_status").execute()

  assert.equal(outcome.content.includes("unexpected data"), true)
  assert.equal(outcome.content.includes("TypeError"), false)
})

test("the three real navigate and evaluate failure messages stay distinguishable", async () => {
  const collected = []

  // 1. An empty evaluate response, surfaced through the controls tool.
  setupFetch()
  globalThis.WebSocket = ResultlessFrameSocket
  const tools = await registerTools()
  collected.push({
    label: "empty response",
    marker: "Page query failed:",
    message: (await tools.get("wsl_chromium_controls").execute({})).content,
  })

  // 2. A target that vanished from the list: two consecutive misses against a non-empty fresh list prove it.
  invalidateTargetCache()
  setupFetch()
  globalThis.WebSocket = NavigatingWebSocket
  let served = 0
  globalThis.fetch = async (url) => {
    assert.equal(url, "http://127.0.0.1:9222/json/list")
    served += 1
    const survivor = { id: "page-2", title: "Second", url: "https://example.org", type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/page-2" }
    const list = served === 1
      ? [{ id: "page-1", title: "First", url: "https://example.com", type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/page-1" }, survivor]
      : [survivor]
    return { ok: true, status: 200, json: async () => list }
  }
  collected.push({
    label: "vanished target",
    marker: "is no longer present in the CDP target list",
    message: (await tools.get("wsl_chromium_navigate").execute({ url: "https://example.com/destination" })).content,
  })

  // 3. A target that never settles, so the poll loop reaches its deadline instead of matching the destination.
  invalidateTargetCache()
  setupFetch()
  globalThis.WebSocket = NavigatingWebSocket
  Date.now = (() => { let value = now; return () => (value += 2000) })()
  collected.push({
    label: "poll deadline",
    marker: "did not settle before",
    message: (await tools.get("wsl_chromium_navigate").execute({ url: "https://example.com/destination" })).content,
  })

  for (const entry of collected) {
    assert.ok(entry.message.includes(entry.marker), `${entry.label} message must contain ${entry.marker}, got: ${entry.message}`)
  }
  assert.equal(new Set(collected.map((entry) => entry.marker)).size, 3)
  assert.equal(new Set(collected.map((entry) => entry.message)).size, 3)
  // The empty-response prefix is unique to the evaluate path; neither navigate failure may borrow it.
  assert.equal(collected[0].message.startsWith("Browser operation failed: Page query failed:"), true)
  assert.equal(collected[1].message.includes("Page query failed:"), false)
  assert.equal(collected[2].message.includes("Page query failed:"), false)
})

// The three input bounds below are enforced twice: once by the declared input schema at the runtime validator, and
// once by a guard at the top of execute. Only the guard is reachable offline, because these tests call execute
// directly with the same stubs the other tests use. Each case therefore asserts two things: the message names the
// bound that was violated, and the fetch counter stayed at zero, which proves no CDP target lookup ever happened.

test("wsl_chromium_type rejects an empty selector before any CDP work", async () => {
  setupFetch()
  const tools = await registerTools()
  const outcome = await tools.get("wsl_chromium_type").execute({ selector: "", text: "hello" })
  const body = JSON.parse(outcome.content)
  assert.equal(body.ok, false)
  assert.equal(body.error, "wsl_chromium_type requires a non-empty selector.")
  assert.equal(calls, 0)
})

test("wsl_chromium_type rejects text past the 4000 character cap before any CDP work", async () => {
  setupFetch()
  const tools = await registerTools()
  const outcome = await tools.get("wsl_chromium_type").execute({ selector: "#name", text: "a".repeat(4001) })
  const body = JSON.parse(outcome.content)
  assert.equal(body.ok, false)
  assert.equal(body.error, "wsl_chromium_type text exceeds the 4000 character cap.")
  assert.equal(calls, 0)
})

test("wsl_chromium_click rejects a whitespace-only selector before any CDP work", async () => {
  setupFetch()
  const tools = await registerTools()
  const outcome = await tools.get("wsl_chromium_click").execute({ selector: "   " })
  const body = JSON.parse(outcome.content)
  assert.equal(body.ok, false)
  assert.equal(body.error, "wsl_chromium_click requires a non-empty selector.")
  assert.equal(calls, 0)
})

// The declared schema is the first line of defense and the only one a direct execute call bypasses, so its bounds are
// asserted from the registered tools alone. No browser, fetch, or WebSocket is needed to read a schema.
test("the type and click schemas declare the same non-empty selector and text bounds", async () => {
  setupFetch()
  const tools = await registerTools()
  const typeSchema = tools.get("wsl_chromium_type").input
  const clickSchema = tools.get("wsl_chromium_click").input
  assert.equal(typeSchema.properties.selector.minLength, 1)
  assert.equal(typeSchema.properties.text.maxLength, 4000)
  assert.equal(clickSchema.properties.selector.minLength, 1)
  assert.equal(clickSchema.properties.selector.type, "string")
  assert.equal(typeSchema.additionalProperties, false)
  assert.equal(clickSchema.additionalProperties, false)
  assert.equal(calls, 0)
})
