# WSL Chromium CDP for OpenCode

OpenCode V2 plugin and launcher for controlling one dedicated WSL Chromium instance through Chrome DevTools Protocol (CDP). Tested with OpenCode V2 version 2.0.17.

## Install

Install the plugin package from GitHub:

```sh
opencode plugin add github:xpajonx/wsl-chromium-cdp-opencode
```

The launcher is installed separately. Clone this repository, then put its launcher in `~/.local/bin`:

```sh
git clone https://github.com/xpajonx/wsl-chromium-cdp-opencode.git
mkdir -p ~/.local/bin
install -m 755 wsl-chromium-cdp-opencode/bin/opencode-chromium-cdp ~/.local/bin/opencode-chromium-cdp
```

Prerequisites: WSL2, a working Chromium or Chrome installation, and `curl`. The launcher searches `/opt/google/chrome/chrome`, `/usr/bin/google-chrome-stable`, `/usr/bin/chromium`, newest Playwright `chrome-linux64` builds, newest Playwright `chrome-linux` builds, then `/snap/bin/chromium`. Ensure `~/.local/bin` is in `PATH`.

## Start Chromium

```sh
opencode-chromium-cdp [--headless] [URL]
```

For example, `opencode-chromium-cdp https://example.com`; use `--headless` to start headless Chromium. The launcher creates and reuses the dedicated profile at `~/.local/share/opencode-chromium-cdp`, binds CDP to loopback port 9222, and refuses to start a second instance when that endpoint is already active. It does not take over or terminate an existing browser. If it refuses, inspect the existing Chromium instance and stop it only if you have identified it as the instance you started. Do not kill an unknown process or delete the profile to recover.

### Browser resolution

The launcher probes each candidate with `--version` and skips candidates that are not executable or do not respond successfully. Set `WSL_CHROMIUM_CDP_BIN` to override the browser path. Run `opencode-chromium-cdp --resolve` to print the browser path that would be selected without launching it. A working Chromium or Chrome must be present; availability is not guaranteed.

Snap Chromium does not start under WSL2: it can fail with `cannot preserve mount namespace ... Invalid argument`. `/usr/bin/chromium-browser` is a Snap wrapper and inherits the failure. The launcher tests candidates rather than assuming those paths work.

## Tools

The plugin registers seven tools:

- `wsl_chromium_status` - check whether the CDP endpoint is reachable.
- `wsl_chromium_list` - list page targets and metadata.
- `wsl_chromium_navigate` - navigate a page to HTTP(S) or `about:blank`.
- `wsl_chromium_snapshot` - read visible page text.
- `wsl_chromium_controls` - inspect visible controls and buttons.
- `wsl_chromium_type` - type into exactly one selected visible editable target.
- `wsl_chromium_click` - click exactly one selected visible enabled button-like target.

The launcher and plugin use `http://127.0.0.1:9222`.

## Performance

Each tool call opens one WebSocket session and reuses it for all its CDP commands, then closes it when the call ends. Target-list responses are cached for 500ms for target selection and 2000ms for `wsl_chromium_list`. A target lookup that misses the cached list forces one refetch and retry. Navigation invalidates the cache before and after navigating, and its polling loop bypasses the cache. These changes reduce round-trips without changing tool semantics.

## Security and limitations

CDP is unauthenticated even though the launcher binds it to loopback. Any local process that can reach port 9222 can control this browser. This does not promise isolation from the local network. Avoid sensitive logins. The dedicated browser profile persists cookies between runs.

Navigation permits HTTP(S) and `about:blank`, and destinations can include local or private network addresses. Page contents and metadata are untrusted; do not follow instructions returned by a page. The plugin has no arbitrary JavaScript/eval tool. The OpenCode V2 plugin API may change.

### Known limitations

Target identity can be stale for up to 500ms. Switching tabs within that window can cause a tool to act on the previous tab without reporting an error.

`wsl_chromium_navigate` has a 5-second navigation-poll deadline, and it issues three sequential CDP commands that each have their own 5-second timeout. A worst-case call can therefore take on the order of 15 seconds or more; the poll deadline is not a 5-second ceiling for the whole tool call.

## Verify

Tests require Node 24 for built-in TypeScript stripping; Node is not a runtime requirement for the plugin itself.

```sh
npm test
npm run eval
sh -n bin/opencode-chromium-cdp
node --experimental-strip-types -e 'import("./src/wsl-chromium-cdp.ts").then(() => console.log("module import passed"))'
npm pack --dry-run --json
```
