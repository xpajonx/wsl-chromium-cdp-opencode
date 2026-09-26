import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../src/wsl-chromium-cdp.ts"

test("registers the stable plugin and exactly seven safe, callable tools", async () => {
  assert.equal(plugin.id, "user.wsl-chromium-cdp")
  const tools = []
  let transformCalls = 0
  await plugin.setup({
    tool: {
      async transform(callback) {
        transformCalls += 1
        callback({ add(tool) { tools.push(tool) } })
      },
    },
  })

  assert.equal(transformCalls, 1)
  assert.deepEqual(tools.map(({ name }) => name), [
    "wsl_chromium_status",
    "wsl_chromium_list",
    "wsl_chromium_navigate",
    "wsl_chromium_snapshot",
    "wsl_chromium_controls",
    "wsl_chromium_type",
    "wsl_chromium_click",
  ])
  for (const tool of tools) {
    assert.equal(typeof tool.execute, "function", `${tool.name} execute`)
    assert.equal(tool.input.type, "object", `${tool.name} schema type`)
    assert.equal(tool.input.additionalProperties, false, `${tool.name} schema is closed`)
    assert.equal(typeof tool.description, "string")
    assert.ok(tool.description.length > 0)
    assert.ok(Array.isArray(tool.input.required ?? []))
    for (const property of Object.values(tool.input.properties)) {
      assert.equal(typeof property.type, "string")
      assert.equal(typeof property.description, "string")
    }
  }
})
