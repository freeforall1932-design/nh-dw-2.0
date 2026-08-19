const assert = require('assert');
const fetch = require('node-fetch')

describe('Is API alive', () => {
    it('Get doujinshi pretty text', async () => {
        const response = await fetch('https://nhentai.net/api/gallery/161194');
        assert.equal(response.status, 200);
        const json = await response.json();
        assert.equal(json.title.pretty, "Tsuna-kan. | Tuna Can");
    });
});