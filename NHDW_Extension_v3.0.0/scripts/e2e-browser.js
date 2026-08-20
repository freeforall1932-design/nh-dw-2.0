#!/usr/bin/env node
// Real-browser end-to-end test for NHentai Downloader (MV3).
//
// Launches a real Chromium-based browser with the built extension loaded and
// drives it over the Chrome DevTools Protocol with zero npm dependencies
// (Node 18+ fetch + WebSocket). This is the automated stand-in for the manual
// Chrome/Brave end-to-end download test from the backlog: everything except
// nhentai.net's own network (Cloudflare-gated / unreachable from CI sandboxes)
// runs for real — service worker startup, extension pages, the offscreen
// document, JSZip, URL.createObjectURL, chrome.downloads, and the ZIP on disk.
//
// nhentai.net is simulated locally: the browser maps nhentai.net / i*.nhentai.net
// to 127.0.0.1 (--host-resolver-rules) and a local HTTPS fixture server on port
// 443 answers with certificate errors ignored. The extension's real fetch()
// calls therefore hit this server — no code is monkey-patched on the happy
// path (a patched-fetch fallback exists for environments where the certificate
// bypass does not apply to extension pages).
//
// Binding port 443 normally needs privileges: run this script with
// sudo / elevated rights to include the content-script and real-fetch tests;
// without it those sections are skipped with a hint.
//
// Usage:
//   node scripts/e2e-browser.js --extension ../NHDW_Release_v3.0.0 [--browser /path/to/chromium] [--nss-libs /dir]
//
// Environment:
//   BROWSER_BIN     browser binary (Chrome, Chromium, or Brave)
//   NSS_LIBS        directory containing libnss3.so etc. (needed only for
//                   serverless Chromium builds such as @sparticuz/chromium;
//                   its bin/al2023.tar.br is extracted automatically)
//   EXTENSION_DIR   unpacked extension folder
//
// Exit code 0 = all tests passed (or skipped with a clear reason).

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { spawn, spawnSync } = require("child_process");

// ---------------------------------------------------------------------------
// arguments / environment
// ---------------------------------------------------------------------------
function argValue(name) {
    const i = process.argv.indexOf(name);
    if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
    return undefined;
}
const EXTENSION_DIR = argValue("--extension") || process.env.EXTENSION_DIR || path.join(__dirname, "..", "..", "NHDW_Release_v3.0.0");
const BROWSER_ARG = argValue("--browser") || process.env.BROWSER_BIN;
const NSS_LIBS_ARG = argValue("--nss-libs") || process.env.NSS_LIBS;

// ---------------------------------------------------------------------------
// minimal CDP client
// ---------------------------------------------------------------------------
class CDP {
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this.nextId = 1;
        this.pending = new Map();
        this.handlers = [];
        this.ready = new Promise((resolve, reject) => {
            this.ws.onopen = () => resolve();
            this.ws.onerror = (e) => reject(new Error("WebSocket error: " + (e.message || e)));
        });
        this.ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.id !== undefined && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(msg.error.message + " (" + (msg.error.code || "?") + ")"));
                else resolve(msg.result);
            } else if (msg.method) {
                for (const h of this.handlers) {
                    try { h(msg); } catch (_) { /* keep going */ }
                }
            }
        };
    }
    async send(method, params = {}, sessionId) {
        await this.ready;
        const id = this.nextId++;
        const msg = { id, method, params };
        if (sessionId) msg.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify(msg));
        });
    }
    on(fn) { this.handlers.push(fn); }
    close() { try { this.ws.close(); } catch (_) { /* noop */ } }
}

// Helper for per-target sessions.
class Target {
    constructor(browser, targetId, info) {
        this.browser = browser;
        this.targetId = targetId;
        this.info = info;
        this.sessionId = null;
        this.exceptions = [];
        this.console = [];
    }
    async attach() {
        const { sessionId } = await this.browser.send("Target.attachToTarget", { targetId: this.targetId, flatten: true });
        this.sessionId = sessionId;
        await this.send("Runtime.enable");
        await this.send("Log.enable");
        return this;
    }
    async send(method, params = {}) {
        return this.browser.send(method, params, this.sessionId);
    }
    async eval(expression, awaitPromise = true) {
        const res = await this.send("Runtime.evaluate", {
            expression,
            awaitPromise,
            returnByValue: true,
            userGesture: true
        });
        if (res.exceptionDetails) {
            throw new Error("eval threw: " + (res.exceptionDetails.exception && res.exceptionDetails.exception.description || res.exceptionDetails.text));
        }
        return res.result ? res.result.value : undefined;
    }
    async waitFor(expression, timeoutMs, label) {
        const deadline = Date.now() + timeoutMs;
        let lastError = null;
        while (Date.now() < deadline) {
            try {
                const value = await this.eval(expression);
                if (value) return value;
            } catch (e) { lastError = e; }
            await sleep(200);
        }
        throw new Error("timed out waiting for " + label + (lastError ? " (last error: " + lastError.message + ")" : ""));
    }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// fixture content
// ---------------------------------------------------------------------------
const FIXTURE_GALLERY = {
    id: 123456,
    media_id: 987654,
    title: { english: "Fixture Gallery", japanese: "", pretty: "Fixture Gallery" },
    images: { pages: [{ t: "j" }, { t: "p" }, { t: "j" }] },
    tags: []
};
const FIXTURE_PAGE_BYTES = [
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03, 0x04]),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x05, 0x06]),
    Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x07, 0x08, 0x09, 0x0a, 0x0b])
];
const PATCHED_FETCH_SRC = `
window.__nhdwFixture = true;
window.fetch = function(input, init) {
    const url = String(input);
    if (url.includes("nhentai.net/api/gallery/123456")) {
        return Promise.resolve(new Response(${JSON.stringify(JSON.stringify(FIXTURE_GALLERY))}, { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    const m = /galleries\\/987654\\/([0-9]+)\\.(jpg|png)$/.exec(url);
    if (m) {
        const bytes = ${JSON.stringify(FIXTURE_PAGE_BYTES.map((b) => Array.from(b)))};
        const idx = parseInt(m[1], 10) - 1;
        const u8 = new Uint8Array(bytes[idx] || bytes[0]);
        return Promise.resolve(new Response(u8, { status: 200, headers: { "Content-Type": "image/jpeg" } }));
    }
    return Promise.reject(new Error("fixture fetch: unhandled URL " + url));
};
`;

// Local nhentai.net fixtures served over HTTPS with a test certificate.
const LISTING_HTML = `<!DOCTYPE html>
<html><head><title>nhentai listing fixture</title></head>
<body>
<div class="container index-container">
  <div class="gallery"><a href="/g/111111/"><div class="caption">Gallery One</div></a></div>
  <div class="gallery"><a href="/g/222222/"><div class="caption">Gallery Two</div></a></div>
  <div class="gallery"><a href="/g/333333/"><div class="caption">Gallery Three</div></a></div>
</div>
</body></html>`;

const GALLERY_HTML = `<!DOCTYPE html>
<html><head><title>Gallery 123456</title></head>
<body><div id="info"><h1>Fixture Gallery</h1></div>
<div id="thumbnail-container"><a href="https://i.nhentai.net/galleries/987654/1.jpg"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a></div>
</body></html>`;

function fixtureServerHandler(req, res) {
    const url = String(req.url).replace(/\?.*$/, "");
    if (url === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(LISTING_HTML);
    } else if (/^\/g\/\d+\/?$/.test(url)) {
        const id = url.match(/g\/(\d+)/)[1];
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(GALLERY_HTML.replace("123456", id));
    } else if (/^\/api\/gallery\/\d+/.test(url)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(FIXTURE_GALLERY));
    } else if (/^\/galleries\/987654\/[1-3]\.(jpg|png)$/.test(url)) {
        const m = url.match(/([1-3])\.(jpg|png)$/);
        res.writeHead(200, { "Content-Type": "image/jpeg" });
        res.end(FIXTURE_PAGE_BYTES[parseInt(m[1], 10) - 1]);
    } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("fixture 404: " + url);
    }
}

// ---------------------------------------------------------------------------
// report helpers
// ---------------------------------------------------------------------------
const results = [];
function report(name, status, detail) {
    results.push({ name, status, detail: detail || "" });
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
}
function ok(name, detail) { report(name, "PASS", detail); }
function skip(name, detail) { report(name, "SKIP", detail); }
function fail(name, detail) { report(name, "FAIL", detail); }

// Recursive .zip search (chrome.downloads creates subdirectories).
function findZips(dir) {
    const out = [];
    const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, entry.name);
            if (entry.isDirectory()) walk(p);
            else if (entry.isFile() && p.endsWith(".zip") && !p.endsWith(".crdownload")) out.push(p);
        }
    };
    try { walk(dir); } catch (_) { /* dir may not exist yet */ }
    return out;
}

// ---------------------------------------------------------------------------
// browser resolution (incl. @sparticuz/chromium with its bundled NSS libs)
// ---------------------------------------------------------------------------
async function resolveBrowser() {
    if (BROWSER_ARG) return { bin: BROWSER_ARG, nss: NSS_LIBS_ARG || null };
    let bin = null;
    let nss = NSS_LIBS_ARG || null;
    const which = (name) => {
        const r = spawnSync("which", [name], { encoding: "utf8" });
        return r.status === 0 ? r.stdout.trim() : null;
    };
    bin = which("chromium") || which("google-chrome") || which("brave-browser") || which("chromium-browser");
    if (!bin) {
        // Try @sparticuz/chromium (a Chromium binary shipped on npm).
        for (const base of [__dirname, path.join(__dirname, "..", "..")]) {
            try {
                const pkg = path.join(base, "node_modules", "@sparticuz", "chromium");
                if (fs.existsSync(pkg)) {
                    const mod = await import(path.join("file://", pkg, "build", "index.js"));
                    const chromium = mod.default;
                    bin = await chromium.executablePath();
                    nss = nss || path.join(os.tmpdir(), "nhdw-nss-libs");
                    if (!fs.existsSync(path.join(nss, "lib", "libnss3.so"))) {
                        // Serverless Chromium needs NSS; the package ships the
                        // libs inside bin/al2023.tar.br.
                        const br = fs.readFileSync(path.join(pkg, "bin", "al2023.tar.br"));
                        const zlib = require("zlib");
                        const tar = zlib.brotliDecompressSync(br);
                        const tmpTar = path.join(os.tmpdir(), "nhdw-al2023.tar");
                        fs.writeFileSync(tmpTar, tar);
                        fs.mkdirSync(nss, { recursive: true });
                        spawnSync("tar", ["-xf", tmpTar, "-C", nss], { stdio: "ignore" });
                    }
                    break;
                }
            } catch (_) { /* try next */ }
        }
    }
    if (!bin) {
        throw new Error("No browser found. Install one and pass --browser (or BROWSER_BIN). " +
            "Serverless option: npm install @sparticuz/chromium in the extension package and rerun.");
    }
    return { bin, nss };
}

function ldEnv(nss) {
    const env = Object.assign({}, process.env);
    if (nss) {
        env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
            ? path.join(nss, "lib") + ":" + env.LD_LIBRARY_PATH
            : path.join(nss, "lib");
    }
    return env;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
(async () => {
    console.log("NHDW real-browser end-to-end test");
    console.log("  extension dir: " + path.resolve(EXTENSION_DIR));
    if (!fs.existsSync(path.join(EXTENSION_DIR, "manifest.json"))) {
        console.error("FATAL: no manifest.json in " + EXTENSION_DIR);
        process.exit(2);
    }
    const { bin, nss } = await resolveBrowser();
    const versionOut = spawnSync(bin, ["--version"], { encoding: "utf8", env: ldEnv(nss) }).stdout.trim();
    console.log("  browser: " + bin);
    console.log("  version: " + versionOut);

    const cert = path.join(__dirname, "fixtures", "nhentai.test.crt");
    const key = path.join(__dirname, "fixtures", "nhentai.test.key");
    let fixtureServer = null;
    let fixtureServerError = null;
    try {
        await new Promise((resolve, reject) => {
            const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, fixtureServerHandler);
            server.on("error", reject);
            server.listen(443, "127.0.0.1", () => { fixtureServer = server; resolve(); });
        });
        console.log("  local nhentai fixture: https://nhentai.net -> 127.0.0.1:443");
    } catch (e) {
        fixtureServerError = e;
        console.log("  local nhentai fixture: UNAVAILABLE (" + e.code + ") - real-fetch and content-script tests will be skipped (run with elevated privileges to include them)");
    }

    // --- launch ------------------------------------------------------------
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nhdw-profile-"));
    const args = [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=0",
        "--remote-allow-origins=*",
        "--user-data-dir=" + profile,
        "--disable-extensions-except=" + path.resolve(EXTENSION_DIR),
        "--load-extension=" + path.resolve(EXTENSION_DIR),
        "--host-resolver-rules=MAP nhentai.net 127.0.0.1, MAP i.nhentai.net 127.0.0.1, MAP i1.nhentai.net 127.0.0.1, MAP i2.nhentai.net 127.0.0.1, MAP i3.nhentai.net 127.0.0.1, MAP i4.nhentai.net 127.0.0.1",
        "--ignore-certificate-errors",
        "--test-type",
        "about:blank"
    ];
    const child = spawn(bin, args, { env: ldEnv(nss), stdio: ["ignore", "ignore", "pipe"] });
    let chromeLog = "";
    child.stderr.on("data", (d) => { chromeLog += d.toString(); });
    const exited = new Promise((resolve) => child.on("exit", resolve));

    // Wait for the DevTools port.
    const portFile = path.join(profile, "DevToolsActivePort");
    let port = null;
    for (let i = 0; i < 100 && !port; i++) {
        if (fs.existsSync(portFile)) {
            const [p] = fs.readFileSync(portFile, "utf8").split("\n");
            port = parseInt(p, 10);
            if (!Number.isFinite(port)) port = null;
        }
        if (!port) await sleep(100);
    }
    if (!port) {
        console.error("FATAL: browser did not open a DevTools port.\n" + chromeLog.slice(-2000));
        child.kill();
        process.exit(2);
    }

    const targetsBySession = new Map();
    let browser;
    try {
        const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        browser = new CDP(version.webSocketDebuggerUrl);
        browser.on((msg) => {
            if ((msg.method === "Runtime.exceptionThrown" || msg.method === "Runtime.consoleAPICalled") && msg.sessionId) {
                const t = targetsBySession.get(msg.sessionId);
                if (t && msg.method === "Runtime.exceptionThrown") t.exceptions.push(msg.params.exceptionDetails);
                if (t && msg.method === "Runtime.consoleAPICalled") t.console.push(msg.params);
            }
        });
    } catch (e) {
        console.error("FATAL: could not connect to the DevTools endpoint: " + e.message);
        child.kill();
        process.exit(2);
    }
    const browserProduct = (async () => {
        try { const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); return v.Browser || "Chromium"; } catch (_) { return "Chromium"; }
    })();

    const listTargets = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
    const attachTarget = async (info) => {
        const t = new Target(browser, info.id, info);
        await t.attach();
        targetsBySession.set(t.sessionId, t);
        return t;
    };
    const extensionExceptions = (t) => t.exceptions.filter((e) => {
        const url = (e.url || (e.stackTrace && e.stackTrace.callFrames[0] && e.stackTrace.callFrames[0].url)) || "";
        return url.includes("chrome-extension://") || String(e.text || "").includes("content.js");
    });


// Sections 2-6: everything that needs the extension to be loaded.
async function runExtensionTests(ctx) {
    const { browser, listTargets, attachTarget, extensionExceptions, extensionId } = ctx;

        // =====================================================================
        // 2. popup renders (proves popup -> service worker message bridge)
        // =====================================================================
        {
            const created = await browser.send("Target.createTarget", { url: `chrome-extension://${extensionId}/index.html` });
            await sleep(300);
            const targets = await listTargets();
            const info = targets.find((t) => t.id === created.targetId);
            const tab = await attachTarget(info);
            try {
                const text = await tab.waitFor(
                    `document.getElementById('action') && document.getElementById('action').innerText`,
                    15000, "popup to render"
                );
                if (String(text).includes("This extension must be used on a page containing doujinshi")) {
                    ok("popup renders and answers via the service worker", "shows the not-on-nhentai message (expected for an about:blank active tab)");
                } else {
                    fail("popup renders", "unexpected content: " + String(text).slice(0, 120));
                }
            } catch (e) {
                fail("popup renders", e.message);
            }
            await browser.send("Target.closeTarget", { targetId: tab.targetId }).catch(() => {});
        }

        // =====================================================================
        // 3. content script on real (fixture) nhentai pages over HTTPS
        // =====================================================================
        if (!fixtureServer) {
            skip("content script tests", "no privileged fixture server (port 443): " + (fixtureServerError ? fixtureServerError.code : "unknown"));
        } else {
            // Listing page: content.js must inject checkboxes per caption.
            const listingCreated = await browser.send("Target.createTarget", { url: "https://nhentai.net/" });
            await sleep(300);
            const listingInfo = (await listTargets()).find((t) => t.id === listingCreated.targetId);
            const listing = await attachTarget(listingInfo);
            try {
                const n = await listing.waitFor(
                    `document.querySelectorAll('.caption input[type="checkbox"]').length`,
                    15000, "checkboxes on the listing page"
                );
                if (n === 3) {
                    ok("content script injects checkboxes on listing pages", n + " caption checkboxes found");
                } else {
                    fail("content script injects checkboxes", "expected 3, got " + n);
                }
                if (extensionExceptions(listing).length > 0) {
                    fail("content script has no errors on listing pages", extensionExceptions(listing).map((e) => e.text).join("; "));
                } else {
                    ok("content script has no errors on listing pages");
                }
            } catch (e) {
                fail("content script on listing pages", e.message);
            }
            await browser.send("Target.closeTarget", { targetId: listing.targetId }).catch(() => {});

            // Single gallery page: no .caption elements; the old code crashed
            // with captions[0] undefined. The new code must leave it alone.
            const galleryCreated = await browser.send("Target.createTarget", { url: "https://nhentai.net/g/123456/" });
            await sleep(300);
            const galleryInfo = (await listTargets()).find((t) => t.id === galleryCreated.targetId);
            const galleryTab = await attachTarget(galleryInfo);
            try {
                await galleryTab.waitFor(`document.getElementById('info') !== null`, 15000, "gallery page to load");
                if (extensionExceptions(galleryTab).length > 0) {
                    fail("content script does not crash on single-gallery pages", extensionExceptions(galleryTab).map((e) => e.text).join("; "));
                } else {
                    ok("content script does not crash on single-gallery pages", "no extension errors on /g/123456/");
                }
            } catch (e) {
                fail("content script on single-gallery pages", e.message);
            }
            await browser.send("Target.closeTarget", { targetId: galleryTab.targetId }).catch(() => {});
        }

        // =====================================================================
        // 4. offscreen document pipeline with a real ZIP on disk
        // =====================================================================
        {
            const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "nhdw-downloads-"));
            try {
                await browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir, eventsEnabled: true });
            } catch (e) {
                // Alternate implementations may not support it; the ZIP search
                // also checks the default download directories below.
            }

            // A relay tab (an extension page) sends the command exactly like
            // the popup does; the service worker then creates the managed
            // offscreen document and runs the pipeline there.
            const relayTabCreated = await browser.send("Target.createTarget", { url: `chrome-extension://${extensionId}/offscreen.html` });
            await sleep(500);
            const offscreenTargets = (await listTargets()).filter((t) => t.url.includes("offscreen.html"));
            const offscreenInfo = offscreenTargets.find((t) => t.id === relayTabCreated.targetId) || offscreenTargets[0];
            const offscreen = await attachTarget(offscreenInfo);

            const driveDownload = () => offscreen.eval(
                `(async () => {
                    const result = await new Promise((resolve, reject) => {
                        chrome.runtime.sendMessage({ action: "downloadDoujinshi", json: ${JSON.stringify(FIXTURE_GALLERY)}, path: "NHDW_E2E/123456", name: "123456" }, (r) => {
                            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                            else resolve(r);
                        });
                    });
                    return JSON.stringify(result);
                })()`
            );

            const startAnswer = await driveDownload();
            const answer = startAnswer ? JSON.parse(startAnswer) : null;
            if (!answer || answer.result !== "started") {
                fail("offscreen download starts", "downloadDoujinshi answered " + startAnswer);
            }

            // The ZIP should arrive through the real network stack against the
            // fixture server (certificate bypass). If that bypass does not
            // apply to extension pages, patch fetch in the managed offscreen
            // document and re-drive once.
            const deadlineReal = Date.now() + 30000;
            let zipPath = findZips(downloadDir)[0] || null;
            while (!zipPath && Date.now() < deadlineReal) {
                zipPath = findZips(downloadDir)[0] || null;
                if (!zipPath) await sleep(500);
            }
            let usedFetchPatch = false;
            if (!zipPath) {
                usedFetchPatch = true;
                let managed = null;
                for (let i = 0; i < 30 && !managed; i++) {
                    const ts = await listTargets();
                    managed = ts.find((t) => t.url.includes("offscreen.html") && t.id !== offscreen.targetId);
                    if (!managed) await sleep(100);
                }
                if (managed) {
                    const managedTarget = await attachTarget(managed);
                    await managedTarget.eval(PATCHED_FETCH_SRC, false).catch(() => {});
                } else {
                    await offscreen.eval(PATCHED_FETCH_SRC, false).catch(() => {});
                }
                await driveDownload();
                const deadlinePatched = Date.now() + 30000;
                while (!zipPath && Date.now() < deadlinePatched) {
                    zipPath = findZips(downloadDir)[0] || null;
                    if (!zipPath) await sleep(500);
                }
            }

            if (!zipPath) {
                fail("ZIP download lands on disk", "no new .zip appeared within 60s");
            } else {
                const buf = fs.readFileSync(zipPath);
                let jszip = null;
                try { jszip = require("jszip"); } catch (_) { /* verify structurally */ }
                const isZip = buf.length > 4 && buf.toString("latin1", 0, 2) === "PK";
                if (!isZip) {
                    fail("ZIP download lands on disk", zipPath + " is not a ZIP (" + buf.length + " bytes)");
                } else if (jszip) {
                    const zip = await jszip.loadAsync(buf);
                    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
                    const expected = ["NHDW_E2E/123456/001.jpg", "NHDW_E2E/123456/002.png", "NHDW_E2E/123456/003.jpg"];
                    if (JSON.stringify(names) !== JSON.stringify(expected)) {
                        fail("ZIP entries match the gallery pages", "expected " + JSON.stringify(expected) + " got " + JSON.stringify(names));
                    } else {
                        let bytesOk = true;
                        for (let i = 0; i < expected.length; i++) {
                            const content = Buffer.from(await zip.file(expected[i]).async("nodebuffer"));
                            const want = FIXTURE_PAGE_BYTES[i];
                            if (content.length !== want.length || !want.every((b, j) => b === content[j])) bytesOk = false;
                        }
                        if (bytesOk) {
                            ok("ZIP download lands on disk", zipPath + " (" + buf.length + " bytes, real chrome.downloads output" + (usedFetchPatch ? ", fetch-patch fallback" : "") + ")");
                        } else {
                            fail("ZIP entries match the gallery pages", "entry bytes differ from the fetched fixtures");
                        }
                    }
                } else {
                    ok("ZIP download lands on disk", zipPath + " (" + buf.length + " bytes, PK header verified)");
                }
            }

            // Cleanup: let the downloader go idle.
            await offscreen.eval(`chrome.runtime.sendMessage({ action: "goBack" })`, false).catch(() => {});
            await browser.send("Target.closeTarget", { targetId: offscreen.targetId }).catch(() => {});
        }

        // =====================================================================
        // 5. popup UI driven download (gallery page -> popup -> ZIP on disk)
        // =====================================================================
        {
            const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "nhdw-ui-downloads-"));
            try {
                await browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir, eventsEnabled: true });
            } catch (_) { /* fall back to directory search */ }

            // Gallery tab (active), then the popup as a second tab.
            const galleryCreated = await browser.send("Target.createTarget", { url: "https://nhentai.net/g/123456/" });
            await sleep(300);
            await browser.send("Target.activateTarget", { targetId: galleryCreated.targetId });
            const popupCreated = await browser.send("Target.createTarget", { url: "about:blank" });
            await sleep(300);
            const popupInfo = (await listTargets()).find((t) => t.id === popupCreated.targetId);
            const popup = await attachTarget(popupInfo);
            await popup.send("Page.enable");
            await popup.send("Page.navigate", { url: `chrome-extension://${extensionId}/index.html` });
            await browser.send("Target.activateTarget", { targetId: galleryCreated.targetId });

            try {
                // The popup should fetch the gallery metadata through its real
                // network stack (fixture server + certificate bypass) and show
                // a Download button. Only fall back to a patched fetch when
                // the bypass does not apply to extension pages.
                let buttonAppeared = false;
                try {
                    await popup.waitFor(`document.getElementById('button') !== null`, 20000, "popup Download button");
                    buttonAppeared = true;
                } catch (_) {
                    await popup.send("Page.addScriptToEvaluateOnNewDocument", { source: PATCHED_FETCH_SRC });
                    await popup.send("Page.reload", {});
                    await popup.waitFor(`document.getElementById('button') !== null`, 20000, "popup Download button (patched fetch)");
                    buttonAppeared = true;
                }

                // Patch the managed offscreen document if one exists already
                // (it is created lazily on the first relay); with the fixture
                // server this is not needed, but keep it harmless.
                let offscreenManaged = null;
                for (let i = 0; i < 30 && !offscreenManaged; i++) {
                    const ts = await listTargets();
                    offscreenManaged = ts.find((t) => t.url.includes("offscreen.html") && t.id !== popupCreated.targetId);
                    if (!offscreenManaged) await sleep(100);
                }
                if (offscreenManaged && !buttonAppeared) {
                    const managedTarget = await attachTarget(offscreenManaged);
                    await managedTarget.eval(PATCHED_FETCH_SRC, false).catch(() => {});
                }

                const infoText = await popup.eval(`document.getElementById('action').innerText`);
                if (!String(infoText).includes("Fixture Gallery")) {
                    fail("popup shows gallery metadata", "content: " + String(infoText).slice(0, 120));
                } else {
                    ok("popup shows gallery metadata", "(3 pages) with Download button");
                }
                await popup.eval(`document.getElementById('button').click()`);
                const zipPath = await (async () => {
                    const deadline = Date.now() + 60000;
                    while (Date.now() < deadline) {
                        const zips = findZips(downloadDir);
                        if (zips.length > 0) return zips[0];
                        await sleep(500);
                    }
                    return null;
                })();
                if (!zipPath) {
                    fail("popup download completes", "no ZIP in " + downloadDir + " within 60s");
                } else {
                    const buf = fs.readFileSync(zipPath);
                    let jszip = null;
                    try { jszip = require("jszip"); } catch (_) { /* ignore */ }
                    if (jszip) {
                        const zip = await jszip.loadAsync(buf);
                        const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
                        if (names.length === 3 && names.every((n) => n.includes("Fixture_Gallery/"))) {
                            ok("popup-driven download completes", path.basename(zipPath) + " with 3 pages (UI -> SW -> offscreen -> chrome.downloads)");
                        } else {
                            fail("popup-driven download completes", "unexpected entries: " + names.join(", "));
                        }
                    } else {
                        ok("popup-driven download completes", path.basename(zipPath) + " (" + buf.length + " bytes)");
                    }
                }
            } catch (e) {
                fail("popup UI flow", e.message);
            }
            await browser.send("Target.closeTarget", { targetId: popup.targetId }).catch(() => {});
            await browser.send("Target.closeTarget", { targetId: galleryCreated.targetId }).catch(() => {});
        }

        // =====================================================================
        // 6. options page sanity
        // =====================================================================
        {
            const created = await browser.send("Target.createTarget", { url: `chrome-extension://${extensionId}/options.html` });
            await sleep(300);
            const info = (await listTargets()).find((t) => t.id === created.targetId);
            const tab = await attachTarget(info);
            try {
                await tab.waitFor(
                    `document.getElementById('useZip') !== null && document.getElementById('maxConcurrentDownloads') !== null && document.getElementById('downloadName') !== null`,
                    15000, "options controls"
                );
                ok("options page loads", "useZip / maxConcurrentDownloads / downloadName controls present");
            } catch (e) {
                fail("options page loads", e.message);
            }
            await browser.send("Target.closeTarget", { targetId: tab.targetId }).catch(() => {});
        }
}

    try {
        // =====================================================================
        // 1. service worker loads
        // =====================================================================
        let swInfo = null;
        for (let i = 0; i < 150 && !swInfo; i++) {
            const targets = await listTargets();
            swInfo = targets.find((t) => t.type === "service_worker" && t.url.includes("chrome-extension://"));
            if (!swInfo) await sleep(100);
        }
        if (!swInfo) {
            fail("service worker registration", "no chrome-extension service_worker target appeared (does this browser build support extensions?)\n" + chromeLog.slice(-1500));
        } else {
            const extensionId = new URL(swInfo.url).host;
            ok("service worker registered", "extension id " + extensionId);

            const sw = await attachTarget(swInfo);
            // Reload the worker and make sure the bundle evaluates without a
            // ReferenceError (this is the regression test for the old `window.*`
            // bug that killed listener registration).
            await sw.eval("chrome.runtime.reload()", false).catch(() => { /* reload tears down the context */ });
            await sleep(2000);
            const swExceptions = extensionExceptions(sw);
            if (swExceptions.length > 0) {
                fail("service worker evaluates cleanly", swExceptions.map((e) => e.text).join("; "));
            } else {
                ok("service worker evaluates cleanly", "no uncaught errors after reload");
            }

            await runExtensionTests({ browser, listTargets, attachTarget, extensionExceptions, extensionId });
        }

    } finally {
        if (fixtureServer) { try { fixtureServer.close(); } catch (_) { /* noop */ } }
        try { browser.close(); } catch (_) { /* noop */ }
        child.kill("SIGTERM");
        await Promise.race([exited, sleep(3000)]);
        child.kill("SIGKILL");
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* noop */ }
    }

    // ------------------------------------------------------------------
    // summary
    // ------------------------------------------------------------------
    const product = await browserProduct;
    console.log("\nResults (" + product + "):");
    let failed = 0;
    for (const r of results) {
        if (r.status === "FAIL") failed++;
    }
    if (failed > 0) {
        console.log(`  ${failed} test(s) FAILED`);
        process.exitCode = 1;
    } else {
        console.log("  all tests passed" + (results.some((r) => r.status === "SKIP") ? " (some skipped)" : ""));
    }
})().catch((e) => {
    console.error("FATAL: " + (e && e.stack ? e.stack : e));
    process.exit(2);
});
