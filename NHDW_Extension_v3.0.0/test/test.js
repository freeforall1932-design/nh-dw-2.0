// Live network check against the real nhentai API.
// Opt-in only: run with RUN_LIVE_TESTS=1 (npm run test:live).
// The default `npm test` suite never touches the network.

const assert = require('assert');
const fetch = require('node-fetch');

// Fixture tests intentionally exercise retryable image failures. Keep those
// expected warnings out of a passing test run; production bundles do not set it.
global.__NHDW_SILENT_RETRY_LOGS__ = true;

const live = process.env.RUN_LIVE_TESTS === '1' ? describe : describe.skip;

live('Live nhentai API (opt-in)', () => {
    it('Get doujinshi pretty text', async () => {
        const response = await fetch('https://nhentai.net/api/v2/galleries/161194');
        assert.equal(response.status, 200);
        const json = await response.json();
        assert.equal(json.title.pretty, "Tsuna-kan. | Tuna Can");
    });
});
