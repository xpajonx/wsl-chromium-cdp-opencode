import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { invalidateTargetCache, selectTargetCached, targets } from "../src/wsl-chromium-cdp.ts"
import plugin from "../src/wsl-chromium-cdp.ts"

const originalFetch = globalThis.fetch
const originalNow = Date.now
const originalWebSocket = globalThis.WebSocket

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
