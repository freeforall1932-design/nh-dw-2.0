const assert = require('assert');
const { verifyAndSaveApiKey, removeApiKey } = require('../build/test/options/apiKey');

function storageFixture(initial = {}) {
    const values = { ...initial };
    return {
        values,
        get(defaults, cb) { cb({ ...defaults, ...values }); },
        set(items, cb) { Object.assign(values, items); if (cb) cb(); },
        remove(key, cb) { delete values[key]; if (cb) cb(); }
    };
}

function response(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('optional API key', () => {
    it('does not call the API or store a blank key', async () => {
        const storage = storageFixture();
        let called = false;
        const result = await verifyAndSaveApiKey('   ', storage, async () => { called = true; throw new Error('unexpected'); });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(called, false);
        assert.strictEqual(storage.values.apiKey, undefined);
    });

    it('validates a pasted key and stores it locally only after a profile response', async () => {
        const storage = storageFixture();
        let request;
        const result = await verifyAndSaveApiKey('  secret-key  ', storage, async (url, init) => {
            request = { url, init };
            return response(200, { username: 'reader' });
        });
        assert.deepStrictEqual(result, { ok: true, username: 'reader' });
        assert.strictEqual(storage.values.apiKey, 'secret-key');
        assert.strictEqual(request.url, 'https://nhentai.net/api/v2/user');
        assert.strictEqual(request.init.headers.Authorization, 'Key secret-key');
    });

    it('never stores an invalid HTTP response or malformed profile', async () => {
        const storage = storageFixture();
        const denied = await verifyAndSaveApiKey('bad', storage, async () => response(401, {}));
        assert.strictEqual(denied.ok, false);
        assert.strictEqual(storage.values.apiKey, undefined);
        const malformed = await verifyAndSaveApiKey('bad', storage, async () => response(200, {}));
        assert.strictEqual(malformed.ok, false);
        assert.strictEqual(storage.values.apiKey, undefined);
    });

    it('removes a locally stored key', async () => {
        const storage = storageFixture({ apiKey: 'secret-key' });
        await removeApiKey(storage);
        assert.strictEqual(storage.values.apiKey, undefined);
    });
});
