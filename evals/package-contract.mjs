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
  "test/plugin-registration.test.mjs",
].sort())

const readme = readFileSync(path.join(root, "README.md"), "utf8")
assert.match(readme, /127\.0\.0\.1:9222/)
assert.match(readme, /unauthenticated/i)
assert.match(readme, /any local process/i)
assert.match(readme, /avoid sensitive logins/i)

execFileSync("sh", ["-n", path.join(root, "bin/opencode-chromium-cdp")], { cwd: root, stdio: "pipe" })
console.log("Package contract eval passed: export, exact package contents, CDP trust boundary, and launcher syntax.")
