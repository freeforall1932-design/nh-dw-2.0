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
