// End-to-end smoke test against the real built extension: background service worker, real
// Kitten model (downloaded from Hugging Face on first run) and the content script on a page.
// Opt-in because it needs the network and takes minutes: npm run test:e2e:real
import { fileURLToPath } from 'url';
import { test, expect, chromium } from '@playwright/test';

const EXTENSION_PATH = fileURLToPath(new URL('../build', import.meta.url));
const PAGE_URL = 'http://vox.test/';
const PAGE_HTML = `<!doctype html><html><body>
<p id="selection">Hello there. This is a quick test of the Kitten voice.</p>
</body></html>`;

test.skip(!process.env.E2E_REAL, 'Set E2E_REAL=1 (npm run test:e2e:real) to run against the real extension');

test('a Kitten voice speaks a selection through the real extension', async () => {
    test.setTimeout(300_000);

    const context = await chromium.launchPersistentContext('', {
        channel: 'chromium', // Extensions need full Chromium, not the headless shell
        args: [
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
            '--autoplay-policy=no-user-gesture-required',
        ],
    });

    try {
        const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
        const page = await context.newPage();
        await page.route(PAGE_URL, route => route.fulfill({ contentType: 'text/html', body: PAGE_HTML }));
        await page.goto(PAGE_URL);

        // Send a message the way the action button and context menu do
        const sendToPage = action => worker.evaluate(async action => {
            const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            await chrome.tabs.sendMessage(tab.id, { action });
        }, action);

        await sendToPage('SHOW_PLAYER');
        await page.locator('#voxlocal-voice-display').click();
        await page.locator('#voxlocal-voice-select').selectOption('kitten:Bella');

        await page.evaluate(() => {
            const range = document.createRange();
            range.selectNodeContents(document.getElementById('selection'));
            getSelection().removeAllRanges();
            getSelection().addRange(range);
        });
        await sendToPage('PLAY_SELECTION');

        const status = page.locator('#voxlocal-status');
        await expect(status).toHaveText(/^Playing chunk/, { timeout: 240_000 });
        await expect(status).toHaveText('Ready', { timeout: 60_000 });
    } finally {
        await context.close();
    }
});
