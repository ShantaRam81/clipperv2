# Reference Clipper Architecture

Reference Clipper is organized as a local-first app that can run in two modes:

- Web dev mode: `node server.js`, then open `http://localhost:3000`.
- Desktop mode: Electron shell starts the same server and opens an app window.

## Folders

```text
.
├─ server.js                 # Thin Node entrypoint for local/dev launch
├─ src/
│  └─ server/
│     └─ app.js              # HTTP API, probing, clipping, storage logic
├─ public/                   # Browser UI
│  ├─ index.html
│  ├─ app.js
│  └─ styles.css
├─ desktop/
│  └─ electron/
│     └─ main.js             # Future desktop shell entrypoint
├─ bin/
│  ├─ win/                   # Packaged Windows ffmpeg/ffprobe/yt-dlp later
│  └─ mac/                   # Packaged macOS ffmpeg/ffprobe/yt-dlp later
├─ storage/                  # Runtime data, ignored in distributable builds
│  ├─ clips/
│  ├─ tmp/
│  └─ library.json
└─ docs/
   └─ ARCHITECTURE.md
```

## Scaling Rules

- Keep domain logic out of Electron. Electron should own only native windows, dialogs, app menus, and packaged binary paths.
- Keep the HTTP API stable. The UI and future desktop shell should call the same API.
- Move server code out of `src/server/app.js` gradually by responsibility:
  - `src/server/routes/` for HTTP route handlers.
  - `src/server/services/` for Behance discovery, metadata probing, clipping, folder picking, and library storage.
  - `src/server/lib/` for command execution, URL parsing, file naming, and response helpers.
- Keep `storage/` disposable. User exports go to a chosen folder; internal cache can be cleaned safely.
- Keep `bin/` platform-specific. Windows binaries and macOS binaries should never share paths.

## Packaging Direction

Use Electron for a first production desktop build:

- Windows: package `.exe` or portable build with `bin/win`.
- macOS: package `.dmg` or `.app` with `bin/mac`.
- Build macOS releases on macOS when signing/notarization matters.
