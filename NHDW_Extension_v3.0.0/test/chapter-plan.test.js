// Offline planning only: the sanitized snapshot is converted-page metadata,
// not a real DOM fixture, verified batch, or authorization to download.
const assert = require('assert');
const { URL: NodeURL } = require('node:url');
const observation = require('./fixtures/sasangeyou/semantic-observation.json');
const { planChapterSelection, planReaderPages } = require('../build/test/utils/chapterPlan.js');

function observedSeries() {
    return {
        source: 'sasangeyou',
        id: observation.series.url,
        order: 'newest-first',
        chapters: observation.series.chaptersInDisplayedOrder.map((chapter) => ({
            id: chapter.url,
            label: chapter.label,
            readerUrl: chapter.url
        }))
    };
}

function availableFor(series, chapterIds = series.chapters.map((chapter) => chapter.id)) {
    // Fictional evidence supplied to exercise the planner; the observation does
    // not prove any batch is offered or available for the actual series.
    return {
        status: 'available', source: series.source, seriesId: series.id,
        candidateId: 'synthetic-batch', chapterIds
    };
}

function expiredFor(series) {
    return { status: 'expired', source: series.source, seriesId: series.id };
}

function labels(plan) {
    return plan.chapters.map((chapter) => chapter.label);
}

describe('sanitized Sasangeyou semantic observation', () => {
    it('preserves observed chapter/count discrepancies without media or original URLs', () => {
        const series = observation.series;
        const reader = observation.chapterOneReader;
        assert.strictEqual(series.advertisedChapterCount, series.chaptersInDisplayedOrder.length);
        assert.deepStrictEqual(series.chaptersInDisplayedOrder.map((c) => c.label), ['Chapter 3', 'Chapter 2', 'Chapter 1']);
        assert.strictEqual(series.chaptersInDisplayedOrder.reduce((sum, c) => sum + c.advertisedPages, 0), series.advertisedTotalPages);
        assert.strictEqual(reader.imageReferences, 33);
        assert.strictEqual(reader.advertisedPages, 30);
        assert.strictEqual(reader.contentCdnReferences + reader.siteHostedInsertReferences, reader.imageReferences);
        assert.strictEqual(reader.orderedReferences.length, reader.imageReferences);
        assert.deepStrictEqual(reader.orderedReferences.map((ref) => ref.observedIndex),
            Array.from({ length: 33 }, (_, index) => index));
        assert.strictEqual(reader.orderedReferences.filter((ref) => ref.originClass === 'content-host-reference').length, 30);
        assert.strictEqual(reader.orderedReferences.filter((ref) => ref.originClass === 'site-hosted-reference').length, 3);
        for (const key of ['chapterTwoReader', 'chapterThreeReader']) {
            const item = observation[key];
            assert.strictEqual(item.orderedReferences.length, item.imageReferences);
            assert.strictEqual(item.contentCdnReferences + item.siteHostedInsertReferences, item.imageReferences);
            assert.deepStrictEqual(item.orderedReferences.map((ref) => ref.observedIndex),
                Array.from({ length: item.imageReferences }, (_, index) => index));
        }
        assert.strictEqual(series.ownBatchLink, 'not observed in converted title page');
        assert.strictEqual(series.relatedSeries.length, 1);
        assert.strictEqual(observation.limits.rawDomOrSelectorsVerified, false);
        assert.strictEqual(observation.limits.imageBytesDownloaded, false);
        assert.strictEqual(observation.limits.batchAvailabilityVerified, false);

        const text = JSON.stringify(observation);
        assert.ok(!/mesu|kachou|jogeza|wp-content|sasangeyouku|data:image/i.test(text),
            'original title, media paths and image bytes must not be in the fixture');
        const urls = text.match(/https?:\/\/[^"\s]+/g) || [];
        assert.ok(urls.length > 0);
        for (const url of urls) {
            const parsed = new NodeURL(url);
            assert.strictEqual(parsed.hostname, 'example.test');
            assert.strictEqual(parsed.search, '');
            assert.strictEqual(parsed.hash, '');
        }
    });
});

function observedReaderList(key = 'chapterOneReader') {
    // The converted text does not establish which named server produced this
    // list. 'captured-render' is a synthetic identity for this one observation.
    const serverId = 'captured-render';
    const reader = observation[key];
    return {
        source: 'sasangeyou',
        seriesId: observation.series.url,
        chapterId: reader.url,
        serverId,
        advertisedPageCount: reader.advertisedPages,
        pages: reader.orderedReferences.map((ref) => ({
            id: 'reference-' + ref.observedIndex,
            url: ref.url,
            serverId,
            annotation: ref.originClass
        }))
    };
}

describe('ordered reader reference planning (offline)', () => {
    it('keeps all 33 references in observed order and surfaces the 30-page metadata discrepancy', () => {
        const list = observedReaderList();
        list.pages[0].unrelatedField = 'not copied';
        const original = JSON.stringify(list);
        const result = planReaderPages(list);
        assert.strictEqual(result.pages[0].unrelatedField, undefined);
        assert.strictEqual(result.referenceCount, 33);
        assert.strictEqual(result.advertisedPageCount, 30);
        assert.strictEqual(result.advertisedCountMatchesReferences, false);
        assert.deepStrictEqual(result.pages.map((p) => p.id), list.pages.map((p) => p.id));
        assert.deepStrictEqual(result.pages.slice(0, 4).map((p) => p.annotation), [
            'content-host-reference', 'site-hosted-reference', 'site-hosted-reference', 'content-host-reference'
        ]);
        assert.strictEqual(result.pages[32].annotation, 'site-hosted-reference');
        assert.strictEqual(JSON.stringify(list), original, 'must not mutate the observed list');
    });

    it('accounts for all three readers, including a third chapter with more content-host references than advertised', () => {
        const keys = ['chapterOneReader', 'chapterTwoReader', 'chapterThreeReader'];
        const plans = keys.map((key) => planReaderPages(observedReaderList(key)));
        assert.deepStrictEqual(plans.map((plan) => plan.referenceCount), [33, 72, 61]);
        assert.deepStrictEqual(plans.map((plan) => plan.advertisedPageCount), [30, 69, 57]);
        assert.ok(plans.every((plan) => plan.advertisedCountMatchesReferences === false));
        assert.deepStrictEqual(plans.map((plan) => plan.pages.filter((p) => p.annotation === 'content-host-reference').length), [30, 69, 58]);
        assert.deepStrictEqual(plans.map((plan) => plan.pages.filter((p) => p.annotation === 'site-hosted-reference').length), [3, 3, 3]);
        assert.ok(plans[2].pages.some((p) => p.annotation === 'content-host-reference' && p.url.endsWith('.jpg')));
        assert.ok(plans[2].pages.some((p) => p.annotation === 'content-host-reference' && p.url.endsWith('.jpg.webp')));
    });

    it('preserves an unknown count and accepts repeated URLs with distinct page identities', () => {
        const list = observedReaderList();
        list.advertisedPageCount = null;
        list.pages = [list.pages[0], { ...list.pages[1], url: list.pages[0].url }];
        const result = planReaderPages(list);
        assert.strictEqual(result.advertisedCountMatchesReferences, null);
        assert.strictEqual(result.referenceCount, 2);
        assert.strictEqual(result.pages[0].url, result.pages[1].url);
        assert.notStrictEqual(result.pages[0].id, result.pages[1].id);
        list.advertisedPageCount = 2;
        assert.strictEqual(planReaderPages(list).advertisedCountMatchesReferences, true);
    });

    it('rejects mixed servers, duplicate identities, empty lists and invalid counts', () => {
        const list = observedReaderList();
        assert.throws(() => planReaderPages({ ...list, pages: [] }), /non-empty reader page/);
        assert.throws(() => planReaderPages({ ...list, pages: [list.pages[0], { ...list.pages[1], serverId: 'another-server' }] }), /mixes servers/);
        assert.throws(() => planReaderPages({ ...list, pages: [list.pages[0], list.pages[0]] }), /Duplicate reader page/);
        assert.throws(() => planReaderPages({ ...list, pages: [{ ...list.pages[0], url: '' }] }), /identity and locator/);
        assert.throws(() => planReaderPages({ ...list, serverId: '' }), /server identities/);
        assert.throws(() => planReaderPages({ ...list, source: ' sasangeyou ' }), /source, series/);
        assert.throws(() => planReaderPages({ ...list, pages: [{ ...list.pages[0], annotation: 3 }] }), /annotation/);
        for (const advertisedPageCount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '30']) {
            assert.throws(() => planReaderPages({ ...list, advertisedPageCount }), /Invalid advertised page count/);
        }
    });
});

describe('chapter selection and batch planning (offline)', () => {
    it('selects all chapters in reading order, without mistaking the related batch for this title', () => {
        const series = observedSeries();
        series.chapters[0].unrelatedField = 'not copied';
        const before = JSON.stringify(series);
        const result = planChapterSelection(series, { kind: 'all' }, { status: 'not-observed' });
        assert.deepStrictEqual(labels(result), ['Chapter 1', 'Chapter 2', 'Chapter 3']);
        assert.strictEqual(result.chapters[2].unrelatedField, undefined);
        assert.strictEqual(result.source, 'sasangeyou');
        assert.strictEqual(result.seriesId, series.id);
        assert.strictEqual(result.kind, 'review');
        assert.strictEqual(result.reason, 'batch-not-observed');
        assert.strictEqual(JSON.stringify(series), before, 'must not mutate the source list');
    });

    it('uses the title chapter list even when reader navigation points outside the series', () => {
        assert.strictEqual(observation.chapterTwoReader.nextLinkMatchesListedChapter, false);
        assert.strictEqual(observation.chapterThreeReader.previousLinkMatchesListedChapter, false);
        assert.strictEqual(observation.chapterThreeReader.nextLinkMatchesListedChapter, false);
        const series = observedSeries();
        const result = planChapterSelection(series, { kind: 'all' }, expiredFor(series));
        assert.deepStrictEqual(result.chapters.map((chapter) => chapter.readerUrl),
            [series.chapters[2].readerUrl, series.chapters[1].readerUrl, series.chapters[0].readerUrl]);
    });

    it('orders an arbitrary selection by the supplied series order', () => {
        const series = observedSeries();
        const ids = [series.chapters[0].id, series.chapters[2].id];
        const plan = planChapterSelection(series, { kind: 'selected', chapterIds: ids }, expiredFor(series));
        assert.strictEqual(plan.kind, 'separate-chapter-archives');
        assert.deepStrictEqual(labels(plan), ['Chapter 1', 'Chapter 3']);
        assert.deepStrictEqual(ids, [series.chapters[0].id, series.chapters[2].id]);
    });

    it('prefers one available combined batch when it covers exactly the selection', () => {
        const series = observedSeries();
        const plan = planChapterSelection(series, { kind: 'all' }, availableFor(series));
        assert.strictEqual(plan.kind, 'use-batch');
        assert.strictEqual(plan.candidateId, 'synthetic-batch');
        assert.deepStrictEqual(labels(plan), ['Chapter 1', 'Chapter 2', 'Chapter 3']);
    });

    it('requires an explicit choice among changing batch options, then uses only the selected one', () => {
        const series = observedSeries();
        const first = { ...availableFor(series), candidateId: 'option-a' };
        const second = { ...availableFor(series), candidateId: 'option-b' };
        const choices = { status: 'choices', options: [
            { candidateId: 'option-a', evidence: first },
            { candidateId: 'option-b', evidence: second }
        ] };
        const before = JSON.stringify(choices);
        const review = planChapterSelection(series, { kind: 'all' }, choices);
        assert.strictEqual(review.reason, 'batch-choice-required');
        assert.deepStrictEqual(review.batchOptionIds, ['option-a', 'option-b']);
        assert.strictEqual(JSON.stringify(choices), before);
        const selected = planChapterSelection(series, { kind: 'all' }, { ...choices, selectedCandidateId: 'option-b' });
        assert.strictEqual(selected.kind, 'use-batch');
        assert.strictEqual(selected.candidateId, 'option-b');
        assert.deepStrictEqual(labels(selected), ['Chapter 1', 'Chapter 2', 'Chapter 3']);
        const rotated = planChapterSelection(series, { kind: 'all' }, { ...choices, selectedCandidateId: 'option-gone' });
        assert.strictEqual(rotated.kind, 'review');
        assert.strictEqual(rotated.reason, 'batch-choice-not-found');
    });

    it('does not treat one expired option as proof that other options are expired', () => {
        const series = observedSeries();
        const all = { kind: 'all' };
        const options = [
            { candidateId: 'expired-a', evidence: expiredFor(series) },
            { candidateId: 'option-b', evidence: { ...availableFor(series), candidateId: 'option-b' } }
        ];
        for (const evidence of [options[1].evidence, { status: 'blocked' }, { status: 'unverified' }, { status: 'not-observed' }, { status: 'not-offered' }]) {
            const plan = planChapterSelection(series, all, { status: 'choices', options: [options[0], { candidateId: 'option-b', evidence }], selectedCandidateId: 'expired-a' });
            assert.strictEqual(plan.kind, 'review');
            assert.strictEqual(plan.reason, 'batch-alternatives-unresolved');
        }
        const expired = planChapterSelection(series, all, {
            status: 'choices', options: [options[0], { candidateId: 'expired-b', evidence: expiredFor(series) }], selectedCandidateId: 'expired-a'
        });
        assert.strictEqual(expired.kind, 'separate-chapter-archives');
        assert.deepStrictEqual(labels(expired), ['Chapter 1', 'Chapter 2', 'Chapter 3']);
        assert.strictEqual(planChapterSelection(series, all, {
            status: 'choices', options: [options[0]], selectedCandidateId: 'expired-a'
        }).kind, 'separate-chapter-archives');
    });

    it('rejects ambiguous option IDs and unrelated-title batch choices', () => {
        const series = observedSeries();
        const all = { kind: 'all' };
        const first = { candidateId: 'option-a', evidence: { ...availableFor(series), candidateId: 'option-a' } };
        const badSeries = { candidateId: 'other', evidence: { ...expiredFor(series), seriesId: 'related-series' } };
        assert.strictEqual(planChapterSelection(series, all, {
            status: 'choices', options: [first, badSeries], selectedCandidateId: 'option-a'
        }).reason, 'different-series');
        assert.throws(() => planChapterSelection(series, all, { status: 'choices', options: [] }), /non-empty list/);
        assert.throws(() => planChapterSelection(series, all, { status: 'choices', options: [first, first] }), /unique local/);
        assert.throws(() => planChapterSelection(series, all, {
            status: 'choices', options: [{ candidateId: 'https://example.test/?token=secret', evidence: expiredFor(series) }]
        }), /non-URL identities/);
        assert.throws(() => planChapterSelection(series, all, {
            status: 'choices', options: [{ candidateId: 'different', evidence: first.evidence }]
        }), /conflicts/);
        assert.throws(() => planChapterSelection(series, all, {
            status: 'choices', options: [{ candidateId: 'other', evidence: { status: 'unknown' } }]
        }), /Invalid batch option evidence/);
        const single = planChapterSelection(series, all, { status: 'choices', options: [first] });
        assert.strictEqual(single.reason, 'batch-choice-required', 'a choices list always requires the user to choose');
    });

    it('requires review rather than silently including unselected chapters', () => {
        const series = observedSeries();
        const one = { kind: 'selected', chapterIds: [series.chapters[2].id] };
        const result = planChapterSelection(series, one, availableFor(series));
        assert.strictEqual(result.kind, 'review');
        assert.strictEqual(result.reason, 'includes-unselected-chapters');
        assert.deepStrictEqual(labels(result), ['Chapter 1']);
    });

    it('requires review for unknown, incomplete, foreign, or inconsistent batch coverage', () => {
        const series = observedSeries();
        const all = { kind: 'all' };
        const cases = [
            [availableFor(series, null), 'coverage-unknown'],
            [availableFor(series, [series.chapters[2].id]), 'missing-selected-chapters'],
            [availableFor(series, ['another-series-chapter']), 'coverage-has-unknown-chapters'],
            [Object.assign(availableFor(series), { seriesId: 'related-series' }), 'different-series'],
            [Object.assign(availableFor(series), { source: 'another-site' }), 'different-series']
        ];
        for (const [batch, reason] of cases) {
            const result = planChapterSelection(series, all, batch);
            assert.strictEqual(result.kind, 'review');
            assert.strictEqual(result.reason, reason);
        }
    });

    it('uses separate chapter archives only for a same-series expired batch', () => {
        const series = observedSeries();
        const all = { kind: 'all' };
        const expired = planChapterSelection(series, all, expiredFor(series));
        assert.strictEqual(expired.kind, 'separate-chapter-archives');
        assert.deepStrictEqual(labels(expired), ['Chapter 1', 'Chapter 2', 'Chapter 3']);
        const other = planChapterSelection(series, all, Object.assign(expiredFor(series), { seriesId: 'related-series' }));
        assert.strictEqual(other.kind, 'review');
        assert.strictEqual(other.reason, 'different-series');
        for (const status of ['not-observed', 'unverified', 'blocked', 'not-offered']) {
            const result = planChapterSelection(series, all, { status });
            assert.strictEqual(result.kind, 'review', status);
            assert.strictEqual(result.reason, 'batch-' + status);
        }
    });

    it('does not guess numeric or special-chapter order from labels', () => {
        const series = observedSeries();
        series.chapters = [
            { id: 'two', label: 'Chapter 2', readerUrl: '/2' },
            { id: 'special', label: 'Special', readerUrl: '/special' },
            { id: 'one-half', label: 'Chapter 1.5', readerUrl: '/1-5' },
            { id: 'one', label: 'Chapter 1', readerUrl: '/1' }
        ];
        const plan = planChapterSelection(series, { kind: 'all' }, expiredFor(series));
        assert.deepStrictEqual(labels(plan), ['Chapter 1', 'Chapter 1.5', 'Special', 'Chapter 2']);
        series.order = 'oldest-first';
        assert.deepStrictEqual(labels(planChapterSelection(series, { kind: 'all' }, expiredFor(series))),
            ['Chapter 2', 'Special', 'Chapter 1.5', 'Chapter 1']);
    });

    it('rejects missing, duplicate, ambiguous or unknown chapter inputs instead of dropping them', () => {
        const series = observedSeries();
        const batch = expiredFor(series);
        assert.throws(() => planChapterSelection(series, { kind: 'selected', chapterIds: [] }, batch), /No chapters selected/);
        assert.throws(() => planChapterSelection(series, { kind: 'selected', chapterIds: ['unknown'] }, batch), /not in this series/);
        assert.throws(() => planChapterSelection(series, { kind: 'selected', chapterIds: [series.chapters[0].id, series.chapters[0].id] }, batch), /Duplicate selected/);
        assert.throws(() => planChapterSelection(Object.assign({}, series, { chapters: [] }), { kind: 'all' }, batch), /non-empty chapter list/);
        assert.throws(() => planChapterSelection(Object.assign({}, series, { chapters: [series.chapters[0], series.chapters[0]] }), { kind: 'all' }, batch), /Duplicate chapter identity/);
        assert.throws(() => planChapterSelection(Object.assign({}, series, { order: 'unknown' }), { kind: 'all' }, batch), /ordering/);
        assert.throws(() => planChapterSelection(Object.assign({}, series, { source: ' sasangeyou ' }), { kind: 'all' }, batch), /source and series identity/);
        assert.throws(() => planChapterSelection(series, { kind: 'all' }, { status: 'unknown' }), /Invalid batch evidence/);
        assert.throws(() => planChapterSelection(series, { kind: 'all' }, { ...availableFor(series), candidateId: 'https://example.test/file?token=secret' }), /non-URL candidate identity/);
        assert.throws(() => planChapterSelection(series, { kind: 'all' }, availableFor(series, [])), /non-empty list/);
        assert.throws(() => planChapterSelection(series, { kind: 'all' }, availableFor(series, [series.chapters[0].id, series.chapters[0].id])), /coverage/);
    });
});
