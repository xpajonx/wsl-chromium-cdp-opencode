import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, test } from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const launcher = path.join(root, "bin/opencode-chromium-cdp")
let tempDir

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

function setup() {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "launcher-resolve-"))
  return tempDir
}

function executable(name, exitCode) {
  const file = path.join(tempDir, name)
  writeFileSync(file, `#!/bin/sh\nexit ${exitCode}\n`)
  chmodSync(file, 0o755)
  return file
}

function resolve(candidates) {
  return spawnSync(launcher, ["--resolve"], {
    encoding: "utf8",
    env: { ...process.env, WSL_CHROMIUM_CDP_CANDIDATES: candidates.join(" ") },
  })
}

test("selects last working candidate when earlier probes fail", () => {
  setup()
  const first = executable("first", 1)
  const second = executable("second", 1)
  const last = executable("last", 0)
  const result = resolve([first, second, last])
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), last)
})

test("skips a non-zero version probe", () => {
  setup()
  const broken = executable("broken", 1)
  const working = executable("working", 0)
  const result = resolve([broken, working])
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), working)
})

test("reports every rejected candidate when none work", () => {
  setup()
  const first = executable("first", 1)
  const second = executable("second", 1)
  const result = resolve([first, second])
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp(first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.match(result.stderr, new RegExp(second.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.match(result.stderr, /working Chromium or Chrome is required/)
  assert.match(result.stderr, /WSL_CHROMIUM_CDP_BIN/)
})

test("skips a non-executable candidate", () => {
  setup()
  const notExecutable = path.join(tempDir, "not-executable")
  writeFileSync(notExecutable, "not a browser\n")
  const working = executable("working", 0)
  const result = resolve([notExecutable, working])
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), working)
})

test("resolve exits without leaving a browser process", () => {
  setup()
  const stub = executable("stub", 0)
  const result = resolve([stub])
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), stub)
  assert.equal(result.error, undefined)
  const processes = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
  assert.equal(processes.split("\n").filter((line) => line.includes(`${tempDir}/stub --version`)).length, 0)
})

test("rejects --resolve with a URL using usage exit code", () => {
  setup()
  const stub = executable("stub", 0)
  const result = spawnSync(launcher, ["--resolve", "https://example.com"], {
    encoding: "utf8",
    env: { ...process.env, WSL_CHROMIUM_CDP_CANDIDATES: stub },
  })
  assert.equal(result.status, 2)
})

test("default discovery resolves an installed browser or reports none available", () => {
  const result = spawnSync(launcher, ["--resolve"], { encoding: "utf8" })
  if (result.status === 0) {
    const browser = result.stdout.trim()
    assert.ok(existsSync(browser))
    assert.ok(requireExecutable(browser))
    assert.notEqual(browser, "/usr/bin/chromium-browser")
    assert.notEqual(browser, "/snap/bin/chromium")
    // Branch taken: a working browser was discovered.
  } else {
    assert.equal(result.status, 1)
    // Branch taken: no working browser is installed.
  }
})

// Guards that the sort key is the numeric revision, not a lexicographic comparison of full paths.
test("default discovery orders Playwright revisions numerically", () => {
  setup()
  const home = tempDir
  const lower = path.join(home, ".cache/ms-playwright/chromium-999/chrome-linux64/chrome")
  const higher = path.join(home, ".cache/ms-playwright/chromium-1140/chrome-linux64/chrome")
  for (const browser of [lower, higher]) {
    mkdirSync(path.dirname(browser), { recursive: true })
    writeFileSync(browser, "#!/bin/sh\nexit 0\n")
    chmodSync(browser, 0o755)
  }
  const result = spawnSync(launcher, ["--resolve"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /chromium-1140\/chrome-linux64\/chrome/)
  assert.doesNotMatch(result.stdout, /chromium-999\/chrome-linux64\/chrome/)
})

function requireExecutable(file) {
  try {
    execFileSync("test", ["-x", file])
    return true
  } catch {
    return false
  }
}
