// Playback state tests for the floating player. The built content script runs in Chromium with
// real Web Audio; the background is faked so chunk timing is under the test's control.
import { fileURLToPath } from 'url';
import { test, expect } from '@playwright/test';
import { installFakeChrome } from './fakeChrome.js';

const CONTENT_SCRIPT = fileURLToPath(new URL('../build/content.js', import.meta.url));
const PAGE_URL = 'http://vox.test/';
const SELECTION_TEXT = 'The quick brown fox jumps over the lazy dog.';
const PAGE_HTML = `<!doctype html><html><body>
<p id="selection">${SELECTION_TEXT}</p>
<p>Second paragraph of page text.</p>
</body></html>`;

test.beforeEach(async ({ page }) => {
    await page.route(PAGE_URL, route => route.fulfill({ contentType: 'text/html', body: PAGE_HTML }));
    await page.addInitScript(installFakeChrome);
    await page.goto(PAGE_URL);
    await page.addScriptTag({ path: CONTENT_SCRIPT });
});

const status = page => page.locator('#voxlocal-status');
const playStopButton = page => page.locator('#voxlocal-play-stop-btn');

function sentMessages(page, action) {
    return page.evaluate(action => window.__vox.sent.filter(message => message.action === action), action);
}

async function playedBack(page) {
    return (await sentMessages(page, 'chunk_played_back')).map(({ requestId, chunkIndex }) => ({ requestId, chunkIndex }));
}

async function selectText(page) {
    await page.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById('selection'));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
    });
}

// Same path as the context menu: background sends PLAY_SELECTION, content script asks for a stream
async function playSelection(page) {
    await selectText(page);
    await page.evaluate(() => window.__vox.dispatch({ action: 'PLAY_SELECTION' }));
    const requests = await sentMessages(page, 'speak_stream');
    return requests.at(-1);
}

function sendChunk(page, requestId, chunkIndex, totalChunks, seconds = 0.3) {
    return page.evaluate(({ requestId, chunkIndex, totalChunks, seconds }) => window.__vox.dispatch({
        action: 'stream_chunk',
        requestId,
        chunkIndex,
        totalChunks,
        audio: window.__vox.wav(seconds),
        speed: 1,
        text: `chunk ${chunkIndex}`,
    }), { requestId, chunkIndex, totalChunks, seconds });
}

function completeStream(page, requestId) {
    return page.evaluate(requestId => window.__vox.dispatch({ action: 'stream_complete', requestId }), requestId);
}

test.describe('streaming playback', () => {
    test('requests a stream for the selection and switches the button to Stop', async ({ page }) => {
        const request = await playSelection(page);

        expect(request).toMatchObject({ text: SELECTION_TEXT, voice: 'af_heart', speed: 1 });
        await expect(playStopButton(page)).toHaveText('Stop');
        await expect(status(page)).toHaveText('Starting streaming speech (processing in chunks)...');
    });

    test('plays chunks in order even when they arrive out of order, then returns to Ready', async ({ page }) => {
        const { requestId } = await playSelection(page);

        await sendChunk(page, requestId, 1, 3);
        await sendChunk(page, requestId, 0, 3);
        await sendChunk(page, requestId, 2, 3);
        await completeStream(page, requestId);

        await expect(status(page)).toHaveText('Ready', { timeout: 5_000 });
        await expect(playStopButton(page)).toHaveText('Play Selection');
        expect(await playedBack(page)).toEqual([0, 1, 2].map(chunkIndex => ({ requestId, chunkIndex })));
    });

    test('waits for a chunk that is still generating, then resumes', async ({ page }) => {
        const { requestId } = await playSelection(page);

        await sendChunk(page, requestId, 0, 2);
        await expect(status(page)).toHaveText('Streaming: waiting for next chunk...');
        await expect(playStopButton(page)).toHaveText('Stop');

        await sendChunk(page, requestId, 1, 2);
        await expect(status(page)).toHaveText('Playing chunk 2/2 (streaming)');
        await completeStream(page, requestId);

        await expect(status(page)).toHaveText('Ready');
        expect(await playedBack(page)).toHaveLength(2);
    });

    test('reports a stream error and resets the button', async ({ page }) => {
        const { requestId } = await playSelection(page);

        await page.evaluate(requestId => window.__vox.dispatch({ action: 'stream_error', requestId, error: 'model failed' }), requestId);

        await expect(status(page)).toHaveText('Streaming error: model failed');
        await expect(playStopButton(page)).toHaveText('Play Selection');
    });
});

test.describe('stopping playback', () => {
    test('stop while generating cancels the stream and stays Stopped', async ({ page }) => {
        const { requestId } = await playSelection(page);
        await sendChunk(page, requestId, 0, 3, 1);
        await expect(status(page)).toHaveText('Playing chunk 1/3 (streaming)');

        await playStopButton(page).click();
        await expect(status(page)).toHaveText('Stopped');
        expect(await sentMessages(page, 'cancel_stream')).toHaveLength(1);

        // A chunk generated before the cancel reached the background must be ignored
        await sendChunk(page, requestId, 1, 3);
        await page.waitForTimeout(1_500);

        await expect(status(page)).toHaveText('Stopped');
        await expect(playStopButton(page)).toHaveText('Play Selection');
        expect(await playedBack(page)).toEqual([]);
    });

    test('stop after generation finished does not play the queued chunks', async ({ page }) => {
        const { requestId } = await playSelection(page);
        for (const chunkIndex of [0, 1, 2]) {
            await sendChunk(page, requestId, chunkIndex, 3, 1);
        }
        await completeStream(page, requestId);
        await page.waitForTimeout(300); // Let chunk 0 decode and start

        await playStopButton(page).click();
        await page.waitForTimeout(2_500); // Longer than the queued chunks would take to play

        await expect(status(page)).toHaveText('Stopped');
        await expect(playStopButton(page)).toHaveText('Play Selection');
        expect(await playedBack(page)).toEqual([]);
    });

    test('stop while the first chunk is still decoding stays Stopped', async ({ page }) => {
        const { requestId } = await playSelection(page);

        await sendChunk(page, requestId, 0, 2);
        await playStopButton(page).click();
        await page.waitForTimeout(1_000);

        await expect(status(page)).toHaveText('Stopped');
        expect(await playedBack(page)).toEqual([]);
    });

    test('playback works again after a stop, ignoring chunks from the stopped request', async ({ page }) => {
        const first = await playSelection(page);
        await sendChunk(page, first.requestId, 0, 2, 1);
        await playStopButton(page).click();
        await expect(status(page)).toHaveText('Stopped');

        const second = await playSelection(page);
        expect(second.requestId).not.toBe(first.requestId);

        await sendChunk(page, first.requestId, 1, 2);
        await sendChunk(page, second.requestId, 0, 1);
        await completeStream(page, second.requestId);

        await expect(status(page)).toHaveText('Ready');
        expect(await playedBack(page)).toEqual([{ requestId: second.requestId, chunkIndex: 0 }]);
    });

    test('a new selection while playing replaces the current stream', async ({ page }) => {
        const first = await playSelection(page);
        await sendChunk(page, first.requestId, 0, 3, 1);
        await expect(status(page)).toHaveText('Playing chunk 1/3 (streaming)');

        const second = await playSelection(page);
        expect(await sentMessages(page, 'cancel_stream')).toHaveLength(1);
        await expect(playStopButton(page)).toHaveText('Stop');

        await sendChunk(page, second.requestId, 0, 1);
        await completeStream(page, second.requestId);

        await expect(status(page)).toHaveText('Ready');
        expect(await playedBack(page)).toEqual([{ requestId: second.requestId, chunkIndex: 0 }]);
    });
});

test.describe('player controls', () => {
    test('with no selection the button reads the page', async ({ page }) => {
        await page.evaluate(() => window.__vox.dispatch({ action: 'SHOW_PLAYER' }));
        await expect(playStopButton(page)).toHaveText('Play Page');

        await playStopButton(page).click();

        const [request] = await sentMessages(page, 'speak_stream');
        expect(request.text).toContain('Second paragraph of page text.');
    });

    test('a Kitten voice is shown with its engine, saved, and sent with the request', async ({ page }) => {
        await page.evaluate(() => window.__vox.dispatch({ action: 'SHOW_PLAYER' }));
        const voiceDisplay = page.locator('#voxlocal-voice-display');

        await expect(voiceDisplay.locator('.setting-label')).toHaveText('Kokoro voice');
        await voiceDisplay.click();
        await page.locator('#voxlocal-voice-select').selectOption('kitten:Bella');

        await expect(voiceDisplay.locator('.setting-value')).toHaveText('Bella');
        await expect(voiceDisplay.locator('.setting-label')).toHaveText('Kitten Mini voice');
        await expect.poll(() => page.evaluate(() => window.__vox.storage.voxLocalSettings?.voice)).toBe('kitten:Bella');

        const request = await playSelection(page);
        expect(request.voice).toBe('kitten:Bella');
    });
});
