const assert = require('assert');
const {
    clearnetSource
} = require('../build/test/sources/GallerySource.js');
const {
    getSourceForUrl,
    getAdapterForUrl,
    getSourceForSite,
    getAdapterForSite,
    getConfiguredSources,
    getAllAllowedImageHosts,
    registerSource
} = require('../build/test/sources/index.js');
const {
    isAllowedImageUrl,
    registerImageSourceRules,
    resetImageServers
} = require('../build/test/sources/cdnConfig.js');

afterEach(() => {
    resetImageServers();
});

describe('SiteAdapter contract & clearnetSource', () => {
    it('implements the SiteAdapter interface with nhentai metadata', () => {
        assert.strictEqual(clearnetSource.site, 'nhentai');
        assert.strictEqual(clearnetSource.defaultFormat, 'zip');
        assert.strictEqual(typeof clearnetSource.matchesUrl, 'function');
        assert.strictEqual(typeof clearnetSource.getGalleryId, 'function');
        assert.strictEqual(typeof clearnetSource.getGalleryUrl, 'function');
        assert.strictEqual(typeof clearnetSource.getReaderPageUrl, 'function');
        assert.strictEqual(typeof clearnetSource.getApiUrl, 'function');
        assert.strictEqual(typeof clearnetSource.getImageUrls, 'function');
        assert.strictEqual(typeof clearnetSource.getImageHosts, 'function');
        assert.strictEqual(typeof clearnetSource.getAllowedPathRegex, 'function');
        assert.strictEqual(typeof clearnetSource.needsTabFetch, 'function');

        assert.strictEqual(clearnetSource.needsTabFetch(), true);
        assert.deepStrictEqual(clearnetSource.getImageHosts(), [
            'i.nhentai.net',
            'i1.nhentai.net',
            'i2.nhentai.net',
            'i3.nhentai.net',
            'i4.nhentai.net'
        ]);
        assert.ok(clearnetSource.getAllowedPathRegex() instanceof RegExp);
    });

    it('builds proper reader URLs and gallery URLs', () => {
        assert.strictEqual(clearnetSource.getGalleryUrl('123456'), 'https://nhentai.net/g/123456/');
        assert.strictEqual(clearnetSource.getReaderPageUrl('123456', 3), 'https://nhentai.net/g/123456/3/');
    });
});

describe('Site Registry (src/sources/index.ts)', () => {
    it('provides clearnetSource as the default registered source', () => {
        const sources = getConfiguredSources();
        assert.ok(sources.length >= 1);
        assert.strictEqual(sources[0].site, 'nhentai');
    });

    it('resolves sources by URL using getSourceForUrl / getAdapterForUrl', () => {
        const url = 'https://nhentai.net/g/366224/';
        const adapter1 = getSourceForUrl(url);
        const adapter2 = getAdapterForUrl(url);
        assert.strictEqual(adapter1, clearnetSource);
        assert.strictEqual(adapter2, clearnetSource);

        assert.strictEqual(getAdapterForUrl('https://example.com/other'), null);
    });

    it('resolves sources by site string using getSourceForSite / getAdapterForSite', () => {
        const adapter1 = getSourceForSite('nhentai');
        const adapter2 = getAdapterForSite('nhentai');
        assert.strictEqual(adapter1, clearnetSource);
        assert.strictEqual(adapter2, clearnetSource);

        assert.strictEqual(getAdapterForSite('nonexistent_site'), null);
    });

    it('aggregates image hosts from all registered sources', () => {
        const hosts = getAllAllowedImageHosts();
        assert.ok(hosts.includes('i.nhentai.net'));
        assert.ok(hosts.includes('i1.nhentai.net'));
        assert.ok(hosts.includes('i4.nhentai.net'));
    });

    it('supports registering dynamic mock adapters', () => {
        const mockAdapter = {
            site: 'mocksite',
            defaultFormat: 'zip',
            matchesUrl: (u) => /^https:\/\/mocksite\.test(?:\/|$)/i.test(u),
            getGalleryId: (u) => '111',
            getGalleryUrl: (id) => `https://mocksite.test/g/${id}`,
            getImageUrls: (m, f) => [`https://img.mocksite.test/g/${m}/${f}`],
            getImageHosts: () => ['img.mocksite.test'],
            getAllowedPathRegex: () => /^\/g\/[0-9]+\/[0-9]+\.jpg$/i,
            needsTabFetch: () => false
        };

        registerSource(mockAdapter);
        assert.strictEqual(getAdapterForSite('mocksite'), mockAdapter);
        assert.strictEqual(getAdapterForUrl('https://mocksite.test/g/111'), mockAdapter);
        assert.ok(getAllAllowedImageHosts().includes('img.mocksite.test'));
    });
});

describe('Multi-site cdnConfig URL validation', () => {
    it('validates against specific adapter rules when passed', () => {
        const mockAdapter = {
            getImageHosts: () => ['m11.imhentai.xxx'],
            getAllowedPathRegex: () => /^\/033\/[a-z0-9]+\/[0-9]+\.webp$/i
        };

        assert.strictEqual(
            isAllowedImageUrl('https://m11.imhentai.xxx/033/w62za5o4v3/1.webp', mockAdapter),
            true
        );
        // Wrong host
        assert.strictEqual(
            isAllowedImageUrl('https://evil.example/033/w62za5o4v3/1.webp', mockAdapter),
            false
        );
        // Wrong path
        assert.strictEqual(
            isAllowedImageUrl('https://m11.imhentai.xxx/other/1.webp', mockAdapter),
            false
        );
    });

    it('validates against registered multi-site rules', () => {
        registerImageSourceRules({
            hosts: ['hentaiera.site'],
            pathRegex: /^\/galleries\/[0-9]+\/[0-9]+\.(jpg|webp)$/i
        });

        assert.strictEqual(
            isAllowedImageUrl('https://hentaiera.site/galleries/4182258/1.webp'),
            true
        );
        assert.strictEqual(
            isAllowedImageUrl('https://hentaiera.site/other/1.webp'),
            false
        );
    });
});
