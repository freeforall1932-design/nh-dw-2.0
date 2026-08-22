# Current Session Handoff — nh-dw-2.0

**Updated:** 2026-08-22 (after CDN configuration hardening)

## Repository and branch

- Checkout: `/home/user/nh-dw-2.0`
- **Only use the current session branch** (check `git branch --show-current` in the checkout; earlier sessions used `arena/01a027b3-nh-dw-2-0`, and historic handoff text may name even older branches — do not trust them over the live checkout).
- Do not trust older branch names in historic handoff text.
- Source: `NHDW_Extension_v3.0.0/`
- Loadable unpacked build: `NHDW_Release_v3.0.0/`
- These are distinct folders. Source contains TypeScript/tests; release is the browser-loadable package. After every build: `cp js/*.js ../NHDW_Release_v3.0.0/js/` and verify `diff -rq js ../NHDW_Release_v3.0.0/js`. Also sync `index.html`, `css/*`, `manifest.json` when they change (the release README intentionally differs).

## Current implemented work

### CDN configuration hardening (newly complete)

- Hardcoded `i.nhentai.net`…`i4.nhentai.net` image hosts are gone from URL generation and validation.
- `src/sources/cdnConfig.ts` is the single shared configuration: URL generation (`GallerySource.getImageUrls`), allowed-image validation (`tabImageFetch.isAllowedImageUrl`), server validation (bare HTTPS `*.nhentai.net` origins only — no port/credentials/path/query, no foreign hosts), merge order (API order first, built-in fallback mirrors as the tail), and permission-origin computation.
- `src/background/cdnConfigService.ts` (service-worker only) resolves `GET /api/v2/cdn` once per session: source-tab session first (`fetchUrlFromTab`), extension fetch second, both bounded by a 6 s timeout; cached in memory + `chrome.storage.session` (`cdnConfig` key, 1 h TTL, stale cache survives worker restarts); every failure degrades to the stale cache or the built-in fallback list — never blocks or fails a job.
- MV3 permission model: manifest keeps static `host_permissions` (unchanged) and adds `optional_host_permissions: ["https://*.nhentai.net/*"]` plus the `permissions` API permission. The worker filters the server list to hosts that are actually granted (`chrome.permissions.contains`), so downloads never hammer CORS-blocked mirrors.
- Popup: on open it asks the worker `getCdnStatus`; when nhentai reports hosts without a grant, a bordered notice offers **Grant image host access** (`chrome.permissions.request` from the popup click — the required user gesture). Downloads keep working on permitted hosts either way. `index.html` has a dedicated `#cdnNotice` div below `#action`.
- The offscreen document applies the relayed `options.imageServers` per job (`applyCdnServers`); it never touches the permissions API and never fetches the config itself.
- Guardrails: no `<all_urls>` anywhere (manifest test), hostile relayed lists sanitize to the defaults (fixture tests), permission origins are only ever computed for validated nhentai-owned hosts.
- Tests: `test/cdn-config.test.js` (22 fixture cases) + manifest test extensions + e2e phases (`e2e-worker` phase 8: fetch-once/cache/i5 URLs; `e2e-relay`: relayed `options.imageServers` + `getCdnStatus`; `e2e-offscreen`: relayed i7 drives URL generation, invalid entries never contacted; `e2e-browser`: `/api/v2/cdn` fixture in the HTTPS server + patched-fetch path).

### Download lifecycle (unchanged this session)

- MV3 service worker relays downloads to offscreen document; offscreen owns fetch/ZIP work, worker owns storage/downloads/scripting.
- False `Download interrupted` marker bug is fixed: offscreen sends `jobFinished`, worker clears session marker immediately. Note: job start now resolves CDN config first (marker goes up synchronously when the job is accepted, before the config fetch).
- Download requests are serialized in an offscreen queue. A second request returns a queue position and runs after the active job.
- Popup exposes progress, queue count, **Clear queue**, and **Cancel current**. Batch-progress controls are also wired.
- Session-only pause/resume is implemented. Completed image bytes remain in the current in-memory archive; pause is safe at image-batch boundaries. Closing popup does not stop work. Pause state is restored when popup reopens.
- Session-only means no restart persistence: browser close, extension reload, offscreen crash/forced close lose in-memory archive state. Do not claim durable restart resume.

### Source-tab requirement

- User has whitelisted `nhentai.net` in their tab-freezing/suspender settings.
- The source nhentai gallery tab may be backgrounded while the user watches YouTube or browses elsewhere, but must remain open and on nhentai until its job completes. Do not navigate/close it during download; tab-context image fetch relies on its Cloudflare-cleared session (and the CDN config fetch prefers it too).

### API key

- Options page has optional user-pasted API key field with Save & verify / Remove key.
- Uses third-party-safe `GET /api/v2/user` and `Authorization: Key <key>` only. Never use `/api/v2/auth/*` or ask for passwords.
- Key is in `chrome.storage.local`, not sync, and never rendered back into the input.

### Popup features

- Per-job format picker: ZIP, CBZ, folder, raw; does not change saved default.
- Download similar uses `GET /api/v2/galleries/{id}/related`, anonymously or with optional API key.

## Validation

```bash
cd NHDW_Extension_v3.0.0
npm ci
npm run build
npm test              # 109 passing, 1 pending live test
npm run test:smoke
npm run test:e2e      # worker (8 phases), offscreen, relay, content suites
cp js/*.js ../NHDW_Release_v3.0.0/js/
diff -rq js ../NHDW_Release_v3.0.0/js
# also diff index.html / css / manifest.json when they change
```

`npm run test:browser` needs a full Chrome/Brave build (serverless `@sparticuz/chromium` has extensions compiled out; headless=new there registers no extension service worker). New escape hatch: `NHDW_CHROME_EXTRA_ARGS="--ozone-platform=headless"` appends switches for constrained environments. The GitHub workflow `.github/workflows/e2e-browser.yml` runs the real-Chrome suite. Retry fixture logs are intentionally quiet in tests; production retry warnings remain enabled (CDN config warnings follow the same `__NHDW_SILENT_RETRY_LOGS__` convention).

## Required real-browser verification before PR

Reload unpacked `NHDW_Release_v3.0.0` through `chrome://extensions` or `brave://extensions`.

1. Single ZIP/CBZ/folder/raw downloads; reopen popup after completion: no false interruption.
2. Queue two or more jobs; verify serial order, queue count, Clear queue, and Cancel current.
3. Pause after some pages, close popup, reopen it, verify Resume and final archive contents.
4. Download similar anonymously and with a verified API key.
5. API key: valid key, invalid key, remove key; ensure saved key never appears in input.
6. Keep source gallery tab backgrounded while browsing another site; confirm it completes. Do not navigate the source tab away.
7. **CDN hardening**: confirm in the worker console that `/api/v2/cdn` is fetched once per session (not per job) and that downloads still start promptly; DevTools → service worker → `chrome.storage.session.get("cdnConfig")` shows the merged list. Optionally test the grant notice: temporarily revoke optional host permissions (`chrome.permissions.remove({origins:["https://i.nhentai.net/*"]})` in the worker console), reload the popup, and confirm the notice + Grant button appear and that a download still completes on a permitted mirror.

## Next backlog

Other unimplemented items:

- Server-side ZIP/CBZ endpoint with API key; fall back on 429/503.
- PDF output format.
- Persistent restart-safe resume (separate feature; requires checkpoint/rebuild strategy).
- Search/favorites/blacklist/comments API UI features.

## Do not

- Do not switch branches or push to a branch other than the current session branch.
- Do not put `chrome.storage`, `chrome.downloads`, `chrome.scripting`, or `chrome.permissions` in the offscreen document.
- Do not use `/api/v2/auth/*` or `/api/v2/user/keys`.
- Do not remove tab-first fetching or claim Cloudflare bypass.
- Do not run `npm audit fix --force`.
- Do not expand web-accessible resources.
- Do not add `<all_urls>` (or any non-nhentai host) to host/optional-host permissions; all image hosts must validate as HTTPS `*.nhentai.net` origins.
