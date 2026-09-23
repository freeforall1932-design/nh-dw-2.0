// Popup error-state HTML: a downloadError without a retryable gallery must
// still leave a Go Back button so the panel is never a dead-end (item 29).

const assert = require('assert');
const { message } = require('../build/test/preview/message.js');

describe('message.downloadError', () => {
    it('always renders Go Back, and Retry only when retryable', () => {
        const deadEnd = message.downloadError('Unable to start the offscreen download document.');
        assert.ok(/id="buttonBack"/.test(deadEnd), 'non-retryable error must still offer Go Back, got ' + deadEnd);
        assert.ok(!/id="buttonRetryFailed"/.test(deadEnd), 'non-retryable error must not offer Retry');
        assert.ok(/Unable to start the offscreen download document/.test(deadEnd));

        const named = message.downloadError('Failed to download original image (x).', 'Some Title', false);
        assert.ok(/id="buttonBack"/.test(named), 'named but non-retryable error must still offer Go Back');
        assert.ok(!/id="buttonRetryFailed"/.test(named));
        assert.ok(/Some Title/.test(named));

        const retryable = message.downloadError('Failed to download original image (x).', 'Some Title', true);
        assert.ok(/id="buttonRetryFailed"/.test(retryable), 'retryable error must offer Retry');
        assert.ok(/id="buttonBack"/.test(retryable), 'retryable error must still offer Go Back');
    });

    // An Error instance (or a structured-cloned object) crossing a message
    // channel must render as its message alone: String(new Error('x')) is
    // "Error: x" and String({}) is "[object Object]" - the report shape 3.6.1
    // removed from every other user-facing path.
    it('renders object-shaped errors as their message, never [object Object]', () => {
        const fromError = message.downloadError(new Error('worker restarted'));
        assert.ok(/worker restarted/.test(fromError), 'the message must survive, got ' + fromError);
        assert.ok(!/Error:/.test(fromError), 'no "Error: " prefix, got ' + fromError);

        const fromObject = message.downloadError({ message: 'channel closed' });
        assert.ok(/channel closed/.test(fromObject), 'an object message must survive, got ' + fromObject);

        // A shapeless object has no message to extract, so it still
        // stringifies - documented behaviour, asserted so a future change to
        // errorMessage() shows up here instead of in a user's popup.
        const shapeless = message.downloadError({});
        assert.ok(/\[object Object\]/.test(shapeless),
            'a shapeless object stringifies by design, got ' + shapeless);
    });
});

// ---- item 43: the panel's bookmark toggles ---------------------------------
// The Queue preview row and every similar-gallery row carry a toggle whose
// markup is built here, as a pure string. The one structural rule that matters
// is asserted below: the button sits OUTSIDE the row's <label>, so clicking
// Bookmark cannot also toggle that gallery's download checkbox.
describe('message.bookmarkButtonHtml (item 43)', () => {
    const { bookmarkButtonHtml, similarList } = message;

    it('renders an explicit input[type=button], never a submit button', () => {
        const off = bookmarkButtonHtml('buttonBookmark', '', false);
        assert.ok(/<input type="button"/.test(off), off);
        assert.ok(/ id="buttonBookmark"/.test(off), off);
        assert.ok(/class="nhdwBookmarkToggle"/.test(off), off);
        assert.ok(!/nhdwBookmarkOn/.test(off), 'the off state must not carry the on class');
        assert.ok(/value="Bookmark"/.test(off), off);
    });

    it('paints the on state from the shared presentation', () => {
        const on = bookmarkButtonHtml('buttonBookmark', '', true);
        assert.ok(/class="nhdwBookmarkToggle nhdwBookmarkOn"/.test(on), on);
        assert.ok(/value="Bookmarked"/.test(on), on);
        // The tooltip says what the NEXT click does in both states, so the
        // button never reads as a one-way action.
        assert.ok(/title="On the bookmark queue - click to take it off again/.test(on), on);
    });

    it('omits the id and carries data-id for the re-rendered similar rows', () => {
        const row = bookmarkButtonHtml('', 'similarBookmark', false, '123456');
        assert.ok(!/ id="/.test(row), 'the similar rows are wired by class, not id: ' + row);
        assert.ok(/class="nhdwBookmarkToggle similarBookmark"/.test(row), row);
        assert.ok(/ data-id="123456"/.test(row), row);
    });

    it('keeps every similar row\'s button outside its label', () => {
        const html = similarList([
            { id: '1', title: 'One', pages: 20 },
            { id: '2', title: 'Two', pages: 0 }
        ]);
        const rows = html.split('<div class="similarRow">').slice(1);
        assert.strictEqual(rows.length, 2);
        for (const row of rows) {
            const labelEnd = row.indexOf('</label>');
            const buttonAt = row.indexOf('nhdwBookmarkToggle');
            assert.ok(labelEnd !== -1, 'each row has a label: ' + row);
            assert.ok(buttonAt > labelEnd,
                'the bookmark button must come AFTER </label> or the row click would also tick the checkbox: ' + row);
        }
        assert.ok(/class="similarItem" data-id="1" checked/.test(html), html);
        assert.ok(/<small>\(20p\)<\/small>/.test(html), 'a known page count is shown: ' + html);
        assert.ok(html.indexOf('(0p)') === -1, 'an unknown page count adds no noise: ' + html);
        assert.ok(/id="buttonSimilarAll"/.test(html) && /id="buttonSimilarNone"/.test(html) && /id="buttonSimilar"/.test(html), html);
    });

    it('is the markup downloadInfo embeds beside Download', () => {
        const info = message.downloadInfo('Some Title', 12, 'cbz', 'zip', 'already here', true);
        assert.ok(/id="buttonBookmark"/.test(info), 'a preview row carries the toggle: ' + info);
        assert.ok(/nhdwBookmarkOn/.test(info), 'the row was already bookmarked, so it opens in the on state');
        assert.ok(/value="Bookmarked"/.test(info), info);
    });
});
