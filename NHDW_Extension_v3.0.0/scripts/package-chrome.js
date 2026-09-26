#!/usr/bin/env node
// One Chrome runtime tree: this source directory is directly loadable as an
// unpacked extension. For distribution, make a SMALL zip from its runtime
// files, not a second checked-in copy and not a zip of src/test/node_modules.
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

// Icon-crow-*.png are project-master candidates (ASSET_PLAN.md family 1):
// they ride beside Icon.png so the owner can compare marks by renaming
// files in the shipped/unpacked extension without any rebuild.
const CORE = ['Icon-crow-mist-arrow-grey.png', 'Icon-crow-mist-arrow.png',
    'Icon-crow-mist-grey.png', 'Icon-crow-mist-redeye-grey.png',
    'Icon-crow-mist-redeye.png', 'Icon-crow-mist.png',
    'Icon-grey.png', 'Icon.png', 'LICENSE', 'index.html',
    'manifest.json', 'offscreen.html', 'options.html'];
const RUNTIME_EXT = {
    css: /\.(?:css|png|svg|webp|jpe?g|woff2?)$/i,
    js: /\.(?:js|LICENSE\.txt)$/i,
    assets: /\.(?:png|svg|webp|jpe?g|gif|woff2?)$/i
};

function collectRuntimeFiles(root) {
    const files = CORE.slice();
    for (const [dir, allowed] of Object.entries(RUNTIME_EXT)) {
        const base = path.join(root, dir);
        if (!fs.existsSync(base)) {
            if (dir === 'assets') continue; // no custom assets have been approved yet
            throw new Error('Missing runtime directory: ' + dir);
        }
        function walk(folder, prefix) {
            for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
                const relative = prefix + entry.name;
                if (entry.isSymbolicLink()) throw new Error('Runtime symlink is not allowed: ' + relative);
                if (entry.isDirectory()) walk(path.join(folder, entry.name), relative + '/');
                else if (entry.isFile()) {
                    if (!allowed.test(entry.name)) throw new Error('Unexpected runtime file: ' + relative);
                    files.push(relative);
                }
            }
        }
        walk(base, dir + '/');
    }
    files.sort();
    for (const file of files) {
        const stat = fs.lstatSync(path.join(root, file));
        if (!stat.isFile()) throw new Error('Missing runtime file: ' + file);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const referenced = [manifest.background && manifest.background.service_worker,
        manifest.action && manifest.action.default_popup,
        manifest.side_panel && manifest.side_panel.default_path,
        manifest.options_ui && manifest.options_ui.page,
        ...Object.values((manifest.action && manifest.action.default_icon) || {}),
        ...Object.values(manifest.icons || {})];
    for (const entry of manifest.content_scripts || []) {
        referenced.push(...(entry.js || []), ...(entry.css || []));
    }
    for (const entry of manifest.web_accessible_resources || []) {
        referenced.push(...(entry.resources || []));
    }
    for (const file of referenced.filter(Boolean)) {
        if (file.includes('*')) continue; // manifest wildcard: covered by the asset folder scan
        if (!files.includes(file.replace(/^\//, ''))) {
            throw new Error('Manifest runtime reference missing from package: ' + file);
        }
    }
    return files;
}

async function createArchive(root) {
    const zip = new JSZip();
    const date = new Date('1980-01-01T00:00:00Z');
    for (const file of collectRuntimeFiles(root)) {
        zip.file(file, fs.readFileSync(path.join(root, file)), {
            createFolders: false, date, unixPermissions: 0o644
        });
    }
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE',
        compressionOptions: { level: 6 } });
}

if (require.main === module) {
    (async () => {
        const root = path.resolve(__dirname, '..');
        const version = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
        const output = path.join(root, 'dist', 'nhdw-chrome-' + version + '.zip');
        const bytes = await createArchive(root);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, bytes);
        console.log('Chrome runtime ZIP: ' + output + ' (' + bytes.length + ' bytes)');
    })().catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { collectRuntimeFiles, createArchive };
