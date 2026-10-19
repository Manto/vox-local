import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './e2e',
    timeout: 30_000,
    fullyParallel: true,
    reporter: 'list',
    use: {
        browserName: 'chromium',
        launchOptions: {
            // Chunks are played through Web Audio without a real click
            args: ['--autoplay-policy=no-user-gesture-required'],
        },
    },
});
