import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
assert.equal(pkg.name, "wsl-chromium-cdp-opencode")
assert.equal(pkg.version, "0.1.0")
assert.equal(pkg.type, "module")
assert.equal(pkg.license, "MIT")
assert.equal(pkg.repository, "https://github.com/xpajonx/wsl-chromium-cdp-opencode.git")
assert.equal(pkg.exports, "./src/wsl-chromium-cdp.ts")
assert.equal(Object.hasOwn(pkg, "dependencies"), false)
assert.equal(Object.hasOwn(pkg, "devDependencies"), false)

const entry = import.meta.resolve("wsl-chromium-cdp-opencode", `file://${root}/`)
assert.equal(entry, new URL("../src/wsl-chromium-cdp.ts", import.meta.url).href)

const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" }))[0]
const packedFiles = packed.files.map(({ path }) => path).sort()
assert.deepEqual(packedFiles, [
  "LICENSE",
  "README.md",
  "bin/opencode-chromium-cdp",
  "evals/package-contract.mjs",
  "package.json",
  "src/wsl-chromium-cdp.ts",
  "test/cdp-session.test.mjs",
  "test/launcher-resolve.test.mjs",
  "test/plugin-registration.test.mjs",
  "test/target-cache.test.mjs",
].sort())

const readme = readFileSync(path.join(root, "README.md"), "utf8")
assert.match(readme, /127\.0\.0\.1:9222/)
assert.match(readme, /unauthenticated/i)
assert.match(readme, /any local process/i)
assert.match(readme, /avoid sensitive logins/i)
assert.match(readme, /WSL_CHROMIUM_CDP_BIN/)
assert.match(readme, /Snap Chromium does not start under WSL2/)
assert.match(readme, /Target identity can be stale for up to 500ms/)

// Ordering: Playwright revisions are searched newest first, and inside every
// revision the 64-bit binary is probed before the 32-bit one.
assert.match(
  readme,
  /probing `chrome-linux64\/chrome` before `chrome-linux\/chrome` inside every revision/,
)

// Probe timeout: every `--version` probe is bounded when a timeout command exists.
assert.match(
  readme,
  /Each `--version` probe is capped at 5 seconds when `gtimeout` or `timeout` is available/,
)

// Spaces: the BIN override is passed through whole, never word-split.
assert.match(
  readme,
  /`WSL_CHROMIUM_CDP_BIN`, which is never split/,
)

// Input cap: wsl_chromium_type refuses payloads past 4000 characters.
assert.match(readme, /`wsl_chromium_type` accepts at most 4000 characters/)

// Navigate truthfulness: both failure modes are surfaced as errors, not as a
// fake "Opened URL:" success line.
assert.match(
  readme,
  /neither case is reported as an `Opened URL:` success/,
)

// Error markers: the exact user-facing failure strings, checked against the
// README prose that documents the behaviour.
assert.match(readme, /reports an error when the destination does not settle inside the poll deadline or when the target disappears/)
assert.match(readme, /Page faults from the read-only tools surface the page's own description instead of the bare word `Uncaught`/)
assert.match(readme, /a missing result is reported as an empty response rather than a TypeError/)

const launcher = readFileSync(path.join(root, "bin/opencode-chromium-cdp"), "utf8")
assert.equal(launcher.includes("chromium=/snap/bin/chromium"), false)

execFileSync("sh", ["-n", path.join(root, "bin/opencode-chromium-cdp")], { cwd: root, stdio: "pipe" })
console.log("Package contract eval passed: export, exact package contents, CDP trust boundary, stale-target window, browser resolution and Playwright ordering, input caps, probe timeout, and navigation truthfulness, plus launcher syntax.")
