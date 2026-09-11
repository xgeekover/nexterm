# NexTerm

A multi-AI terminal IDE: a native Tauri 2 shell around a React 18 editor,
terminal panes, and a command palette, built for AI agents to work the
terminal alongside you.

## Develop
    npm install && npm run tauri dev

## Build
    npm run tauri build

## Windows notes
- WebView2 installs via the bootstrapper (`bundle.windows.webviewInstallMode`
  in `src-tauri/tauri.conf.json`) — first run needs internet access.
- Default shell is `pwsh.exe` (falls back to `powershell.exe`); OSC 133 shell
  integration is injected via a generated PowerShell profile script.
- CI builds `.msi`/`.exe` installers on every push/PR, attached to releases
  on `v*` tags.

## Test
    cd src-tauri && cargo test   # Rust unit + shell-integration tests
    node tests/e2e/runner.js
    node tests/adversarial/runner.js
