import { defineConfig } from 'wxt';

// https://wxt.dev/api/config.html
export default defineConfig({
  // Remove extensionApi restriction to support multiple browsers
  // Use existing files without WXT processing them
  entrypoints: {
    background: 'entrypoints/background.js',
    content: 'entrypoints/content.js'
  },
  // Disable analysis and transformations
  analysis: {
    enabled: false
  },
  manifest: ({ browser, manifestVersion }) => {
    const isFirefox = browser === 'firefox';
    const isChrome = browser === 'chrome';

    // Base manifest
    const manifest = {
      manifest_version: manifestVersion,
      name: "VoxLocal",
      description: "High-quality text-to-speech without using external APIs. Keep all data local and private. Built upon Kokoro.js",
      version: "1.0.0",
      homepage_url: "https://github.com/Manto/vox-local",
    };

    // Browser-specific permissions
    if (isFirefox) {
      manifest.permissions = [
        "activeTab",
        "menus", // Firefox uses "menus" instead of "contextMenus"
        "storage",
        "unlimitedStorage"
      ];
    } else {
      manifest.permissions = [
        "activeTab",
        "scripting",
        "contextMenus",
        "storage",
        "unlimitedStorage"
      ];
    }

    // Background script configuration
    if (manifestVersion === 3) {
      // Manifest V3 - service worker
      manifest.background = {
        service_worker: "background.js",
        type: "module"
      };
    } else {
      // Manifest V2 - background page
      manifest.background = {
        scripts: ["background.js"],
        persistent: false
      };
    }

    // Content scripts
    manifest.content_scripts = [
      {
        matches: [
          "<all_urls>"
        ],
        js: [
          "content.js"
        ]
      }
    ];

    // Browser-specific minimum versions and action configuration
    if (isFirefox) {
      manifest.browser_specific_settings = {
        gecko: {
          id: "voxlocal@mozilla.org",
          strict_min_version: "109.0"
        }
      };

      // Firefox uses browser_action in Manifest V2
      if (manifestVersion === 2) {
        manifest.browser_action = {
          default_icon: {
            "16": "icons/icon_16x16.png",
            "48": "icons/icon_48x48.png"
          },
          default_title: "VoxLocal - Text to Speech in your browser"
        };
      } else {
        // Manifest V3 uses action
        manifest.action = {
          default_icon: {
            "16": "icons/icon_16x16.png",
            "48": "icons/icon_48x48.png"
          },
          default_title: "VoxLocal - Text to Speech in your browser"
        };
      }
    } else if (isChrome) {
      manifest.minimum_chrome_version = "92";
      manifest.action = {
        default_icon: {
          "16": "icons/icon_16x16.png",
          "48": "icons/icon_48x48.png",
          "128": "icons/icon_128x128_2.png"
        },
        default_title: "VoxLocal - Text to Speech in your browser"
      };
    } else {
      // Other browsers (Safari, Edge, etc.)
      manifest.action = {
        default_icon: {
          "16": "icons/icon_16x16.png",
          "48": "icons/icon_48x48.png"
        },
        default_title: "VoxLocal - Text to Speech in your browser"
      };
    }

    // Content Security Policy
    if (manifestVersion === 3) {
      manifest.content_security_policy = {
        extension_pages: "script-src 'self' 'wasm-unsafe-eval'"
      };
    } else {
      // Manifest V2 CSP
      manifest.content_security_policy = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";
    }

    // Web accessible resources
    if (manifestVersion === 3) {
      manifest.web_accessible_resources = [
        {
          resources: ["icons/*.png"],
          matches: ["<all_urls>"]
        }
      ];
    } else {
      // Manifest V2 format
      manifest.web_accessible_resources = ["icons/*.png"];
    }

    // Icons
    manifest.icons = {
      "16": "icons/icon_16x16.png",
      "48": "icons/icon_48x48.png",
      "128": "icons/icon_128x128_2.png"
    };

    return manifest;
  }
});
