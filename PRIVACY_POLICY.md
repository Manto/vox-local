# Privacy Policy for VoxLocal

**Last Updated:** November 17, 2025

## Overview

VoxLocal is a privacy-focused Chrome extension that provides text-to-speech functionality entirely within your browser. We are committed to protecting your privacy and being transparent about our practices.

## Data Collection

**VoxLocal does not collect, store, or transmit any personal data.**

Specifically:
- No user information is collected
- No browsing history is tracked
- No analytics or telemetry data is gathered
- No cookies are used
- No data is sent to external servers or third parties

## Data Processing

All text-to-speech processing happens **entirely locally** in your browser using WebAssembly and the Kokoro.js model. When you use VoxLocal:

1. Selected text is processed locally in your browser
2. Audio is generated using the locally-stored TTS model
3. No data leaves your device

## Local Storage

VoxLocal uses Chrome's local storage API (`chrome.storage.local`) to store:
- User preferences (selected voice, speech speed)
- Downloaded TTS model files (approximately 100MB)

This data:
- Never leaves your device
- Is only accessible by the VoxLocal extension
- Can be cleared by removing the extension

## Permissions Explained

VoxLocal requests the following permissions:

- **activeTab**: To access text on the current webpage when you explicitly select it
- **scripting**: To inject the context menu functionality
- **contextMenus**: To add the "Speak" option when you right-click selected text
- **storage**: To save your preferences and the TTS model files locally
- **unlimitedStorage**: To store the ~100MB TTS model files (required for offline functionality)

## Third-Party Services

VoxLocal does **not** use any third-party services, analytics, or tracking tools.

## Model Downloads

On first use, VoxLocal downloads the Kokoro TTS model files from HuggingFace's CDN. After the initial download:
- Model files are cached locally in your browser
- No further network requests are made for the models
- All subsequent processing is completely offline

## Children's Privacy

VoxLocal does not collect any data from anyone, including children under 13.

## Changes to This Policy

We may update this privacy policy from time to time. Any changes will be posted in this document with an updated "Last Updated" date.

## Contact

If you have questions about this privacy policy, please open an issue at:
https://github.com/Manto/vox-local/issues

## Open Source

VoxLocal is open source software. You can review the complete source code at:
https://github.com/Manto/vox-local

This transparency allows you to verify our privacy claims.
