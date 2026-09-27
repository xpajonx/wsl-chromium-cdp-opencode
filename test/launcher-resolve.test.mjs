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
    // Unset the list override so an ambient value in the developer's shell
    // cannot decide which candidate wins instead of the discovered one.
    env: { ...process.env, HOME: home, WSL_CHROMIUM_CDP_CANDIDATES: undefined, WSL_CHROMIUM_CDP_BIN: undefined },
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

function hasTimeout() {
  return ["gtimeout", "timeout"].some((tool) => {
    try {
      execFileSync("command", ["-v", tool])
      return true
    } catch {
      return false
    }
  })
}

function stub(file, body) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

// Both layouts of one revision must stay adjacent, newest revision first:
// chrome-linux64 before chrome-linux, and chromium-1140 before chromium-999.
test("default discovery keeps both layouts of each Playwright revision adjacent, newest first", () => {
  setup()
  const home = tempDir
  const expected = [
    ".cache/ms-playwright/chromium-1140/chrome-linux64/chrome",
    ".cache/ms-playwright/chromium-1140/chrome-linux/chrome",
    ".cache/ms-playwright/chromium-999/chrome-linux64/chrome",
    ".cache/ms-playwright/chromium-999/chrome-linux/chrome",
  ]
  const candidates = expected.map((relative) =>
    stub(path.join(home, relative), "exit 0")
  )
  // Unset both overrides so the default discovery list is the only source of
  // candidates, and WSL_CHROMIUM_CDP_BIN is not the one that answers.
  const discovered = {
    ...process.env,
    HOME: home,
    WSL_CHROMIUM_CDP_CANDIDATES: undefined,
    WSL_CHROMIUM_CDP_BIN: undefined,
  }
  // The launcher stops at the first working candidate, so observe the full
  // order it would have tried in one pass: make every discovered candidate
  // fail, which forces the whole list to be reported as rejected candidates.
  for (const browser of candidates) stub(browser, "exit 1")
  const result = spawnSync(launcher, ["--resolve"], { encoding: "utf8", env: discovered })
  assert.equal(result.status, 1)
  const rejected = result.stderr
    .split("\n")
    .map((line) => line.match(/^\s+- (.*): (?:not executable|--version probe failed|probe timed out)$/)?.[1])
    .filter((candidate) => candidate !== undefined && candidate.startsWith(home))
    .map((candidate) => candidate.slice(home.length + 1))
  assert.deepEqual(rejected, expected)
  // With the whole list working, the first entry of the observed order is the
  // one the launcher resolves, so an ordering regression fails here too.
  for (const browser of candidates) stub(browser, "exit 0")
  const resolved = spawnSync(launcher, ["--resolve"], { encoding: "utf8", env: discovered })
  assert.equal(resolved.status, 0)
  assert.equal(resolved.stdout.trim(), candidates[0])
})

test("a candidate whose probe outlives the timeout is skipped with a timed-out reason", (t) => {
  if (!hasTimeout()) {
    t.skip("neither gtimeout nor timeout is available")
    return
  }
  setup()
  const slow = path.join(tempDir, "slow")
  writeFileSync(slow, "#!/bin/sh\nsleep 30\n")
  chmodSync(slow, 0o755)
  const working = executable("working", 0)
  const result = resolve([slow, working])
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), working)
  assert.doesNotMatch(result.stderr, new RegExp(`${tempDir}/slow: --version probe failed`))
  assert.match(result.stderr, new RegExp(`${tempDir}/slow: probe timed out`))
})

test("an empty candidate override is reported instead of silently falling through", () => {
  setup()
  const working = executable("working", 0)
  const result = spawnSync(launcher, ["--resolve"], {
    encoding: "utf8",
    env: { ...process.env, WSL_CHROMIUM_CDP_CANDIDATES: "  \t " },
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /WSL_CHROMIUM_CDP_CANDIDATES is set but empty/)
  assert.match(result.stderr, /suppressed the default candidate list/)
  assert.match(result.stderr, /No working Chromium or Chrome was found/)
  assert.equal(existsSync(working), true, "sanity: the stub on disk is a working candidate that was never consulted")
})

// WSL_CHROMIUM_CDP_CANDIDATES is a whitespace separated list, so a path with a
// space in it is split before probing. WSL_CHROMIUM_CDP_BIN carries a single
// path and is never split, so that is where a spaced path has to be exercised.
test("a candidate path containing a space is probed as one path", () => {
  setup()
  const spacedDir = path.join(tempDir, "dir with space")
  const working = stub(path.join(spacedDir, "working"), "exit 0")
  const result = spawnSync(launcher, ["--resolve"], {
    encoding: "utf8",
    env: {
      ...process.env,
      WSL_CHROMIUM_CDP_CANDIDATES: undefined,
      WSL_CHROMIUM_CDP_BIN: working,
    },
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), working)
  // Probed whole: no fragment of the path was split off and reported instead.
  assert.equal(result.stderr, "")
})

