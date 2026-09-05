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
});
