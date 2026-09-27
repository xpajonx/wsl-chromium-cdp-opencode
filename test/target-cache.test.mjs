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
