import test from "node:test"
import assert from "node:assert/strict"
import { openSession, withSession } from "../src/wsl-chromium-cdp.ts"

const target = { id: "page-1", title: "test", url: "about:blank", type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/page-1" }

class FakeWebSocket {
  static instances = []
  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.sent = []
    this.closed = false
    FakeWebSocket.instances.push(this)
  }
  addEventListener(name, callback) {
    const listeners = this.listeners.get(name) ?? []
    listeners.push(callback)
    this.listeners.set(name, listeners)
  }
  fire(name, event = {}) {
    for (const callback of this.listeners.get(name) ?? []) callback(event)
  }
  send(payload) { this.sent.push(payload) }
  close() { this.closed = true; this.fire("close") }
  open() { this.fire("open") }
  reply(message) { this.fire("message", { data: JSON.stringify(message) }) }
  static reset() { FakeWebSocket.instances = []; globalThis.WebSocket = FakeWebSocket }
}

function replyNext(socket, result = {}) {
  const frame = JSON.parse(socket.sent.at(-1))
  socket.reply({ id: frame.id, result })
}

test("one session sends three commands on one websocket", async () => {
  FakeWebSocket.reset()
  const session = openSession(target)
  const socket = FakeWebSocket.instances[0]
  socket.open()
  for (let i = 0; i < 3; i++) {
    const pending = session.send("Runtime.evaluate")
    replyNext(socket)
    await pending
  }
  assert.equal(FakeWebSocket.instances.length, 1)
  assert.equal(socket.sent.length, 3)
  session.close()
})

test("request ids increase monotonically", async () => {
  FakeWebSocket.reset()
  const session = openSession(target), socket = FakeWebSocket.instances[0]
  socket.open()
  for (let i = 0; i < 3; i++) { const pending = session.send("Runtime.evaluate"); replyNext(socket); await pending }
  assert.deepEqual(socket.sent.map((payload) => JSON.parse(payload).id), [1, 2, 3])
  session.close()
})

test("withSession closes on success", async () => {
  FakeWebSocket.reset()
  await withSession(target, async (session) => {
    const socket = FakeWebSocket.instances[0]
    socket.open()
    const pending = session.send("Runtime.evaluate")
    replyNext(socket)
    await pending
  })
  assert.equal(FakeWebSocket.instances[0].closed, true)
})

test("withSession closes when callback throws", async () => {
  FakeWebSocket.reset()
  await assert.rejects(withSession(target, async () => { throw new Error("callback failed") }), /callback failed/)
  assert.equal(FakeWebSocket.instances[0].closed, true)
})

test("timeout rejects exactly and closes the session socket", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  FakeWebSocket.reset()
  let pending
  let rejection
  let socket
  await withSession(target, async (session) => {
    socket = FakeWebSocket.instances[0]
    socket.open()
    pending = session.send("Runtime.evaluate")
    rejection = assert.rejects(pending, { message: "CDP request timed out: Runtime.evaluate" })
    t.mock.timers.tick(5001)
    await rejection
  })
  assert.equal(socket.closed, true)
})

test("send after close rejects without hanging", async () => {
  FakeWebSocket.reset()
  const session = openSession(target)
  session.close()
  const result = await Promise.race([session.send("Runtime.evaluate").then(() => "resolved", (error) => error.message), new Promise((resolve) => setTimeout(() => resolve("hung"), 50))])
  assert.notEqual(result, "hung")
  assert.equal(result, "CDP websocket closed before replying")
})

test("non-matching response id is ignored", async () => {
  FakeWebSocket.reset()
  const session = openSession(target), socket = FakeWebSocket.instances[0]
  socket.open()
  const pending = session.send("Runtime.evaluate")
  socket.reply({ id: 99, result: { wrong: true } })
  const state = await Promise.race([pending.then(() => "settled"), new Promise((resolve) => setTimeout(() => resolve("pending"), 20))])
  assert.equal(state, "pending")
  replyNext(socket, { ok: true })
  assert.deepEqual(await pending, { ok: true })
  session.close()
})

test("CDP error message is preserved", async () => {
  FakeWebSocket.reset()
  const session = openSession(target), socket = FakeWebSocket.instances[0]
  socket.open()
  const pending = session.send("Runtime.evaluate")
  const frame = JSON.parse(socket.sent.at(-1))
  socket.reply({ id: frame.id, error: { message: "provided failure" } })
  await assert.rejects(pending, { message: "provided failure" })
  session.close()
})

test("missing CDP error message includes the method", async () => {
  FakeWebSocket.reset()
  const session = openSession(target), socket = FakeWebSocket.instances[0]
  socket.open()
  const pending = session.send("Page.enable")
  const frame = JSON.parse(socket.sent.at(-1))
  socket.reply({ id: frame.id, error: {} })
  await assert.rejects(pending, { message: "CDP command failed: Page.enable" })
  session.close()
})

test("socket error rejects with exact connection failure", async () => {
  FakeWebSocket.reset()
  const session = openSession(target), socket = FakeWebSocket.instances[0]
  socket.open()
  const pending = session.send("Runtime.evaluate")
  socket.fire("error")
  await assert.rejects(pending, { message: "CDP websocket connection failed" })
  session.close()
})

test("socket close before reply rejects with exact message", async () => {
  FakeWebSocket.reset()
  const session = openSession(target), socket = FakeWebSocket.instances[0]
  socket.open()
  const pending = session.send("Runtime.evaluate")
  socket.fire("close")
  await assert.rejects(pending, { message: "CDP websocket closed before replying" })
  session.close()
})
