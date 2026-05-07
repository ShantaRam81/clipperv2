# Reference Clipper Architecture

Reference Clipper is now a web-only local service:

- Start it with `node server.js` or `npm run dev`.
- Open `http://localhost:3000` in a browser.
- Saved clips stay in the service library under `storage/clips` and are available through `/clips/...`.

## Folders

```text
.
|-- server.js                 # Thin Node entrypoint
|-- src/
|   `-- server/
|       `-- app.js            # HTTP API, probing, clipping, storage logic
|-- public/                   # Browser UI
|   |-- index.html
|   |-- app.js
|   `-- styles.css
|-- storage/                  # Runtime data
|   |-- clips/
|   |-- tmp/
|   `-- library.json
`-- docs/
    `-- ARCHITECTURE.md
```

## Runtime Model

- The browser talks to the local HTTP API.
- The server probes sources with `yt-dlp`, cuts clips with `ffmpeg`, and stores metadata in `storage/library.json`.
- There is no Electron shell, native folder picker, bundled desktop binary layout, or platform-specific packaging path.

## VPS And Cloud Processing

For production on a small VPS, prefer remote processing:

- Set `CLIPPER_PROCESSOR_URL` to an HTTPS worker endpoint that accepts clip jobs.
- Optionally set `CLIPPER_PROCESSOR_TOKEN` for bearer-token auth.
- The VPS will forward clip creation to that worker and save only returned metadata plus the public clip URL.

Local processing is still available for development. To keep local storage bounded:

- `MAX_LOCAL_CLIPS=100` keeps only the newest 100 library entries by default.
- `CLIP_TTL_HOURS=0` disables age cleanup; set it to a positive number to expire old clips.
- Temporary downloads are removed after each job even when clipping fails.

## Scaling Rules

- Keep browser code in `public/`.
- Keep HTTP and media logic in `src/server/`.
- Split `src/server/app.js` by responsibility as it grows:
  - `routes/` for HTTP handlers.
  - `services/` for probing, Behance discovery, clipping, and library storage.
  - `lib/` for command execution, URL parsing, filenames, and response helpers.
- Treat `storage/tmp` as disposable.
- Treat `storage/clips` and `storage/library.json` as the local web library.
