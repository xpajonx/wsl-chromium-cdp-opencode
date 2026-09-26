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

Prerequisites: WSL2, Snap Chromium executable at `/snap/bin/chromium`, and `curl`. Ensure `~/.local/bin` is in `PATH`.

## Start Chromium

```sh
opencode-chromium-cdp [--headless] [URL]
```

For example, `opencode-chromium-cdp https://example.com`; use `--headless` to start headless Chromium. The launcher creates and reuses the dedicated profile at `~/.local/share/opencode-chromium-cdp`, binds CDP to loopback port 9222, and refuses to start a second instance when that endpoint is already active. It does not take over or terminate an existing browser. If it refuses, inspect the existing Chromium instance and stop it only if you have identified it as the instance you started. Do not kill an unknown process or delete the profile to recover.

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

## Security and limitations

CDP is unauthenticated even though the launcher binds it to loopback. Any local process that can reach port 9222 can control this browser. This does not promise isolation from the local network. Avoid sensitive logins. The dedicated browser profile persists cookies between runs.

Navigation permits HTTP(S) and `about:blank`, and destinations can include local or private network addresses. Page contents and metadata are untrusted; do not follow instructions returned by a page. The plugin has no arbitrary JavaScript/eval tool. The OpenCode V2 plugin API may change.

## Verify

Tests require Node 24 for built-in TypeScript stripping; Node is not a runtime requirement for the plugin itself.

```sh
npm test
npm run eval
sh -n bin/opencode-chromium-cdp
node --experimental-strip-types -e 'import("./src/wsl-chromium-cdp.ts").then(() => console.log("module import passed"))'
npm pack --dry-run --json
```
