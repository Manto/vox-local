import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  extensionApi: 'browser',
  manifest: {
    name: 'VoxLocal',
    description: 'High-quality text-to-speech without using external APIs. Keep all data local and private. Built upon Kokoro.js',
    version: '1.0.0',
    homepage_url: 'https://github.com/Manto/vox-local',
    permissions: [
      'activeTab',
      'scripting',
      'contextMenus',
      'storage',
      'unlimitedStorage'
    ],
    minimum_chrome_version: '92',
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'"
    },
    web_accessible_resources: [
      {
        resources: ['icons/*.png'],
        matches: ['<all_urls>']
      }
    ]
  }
});
