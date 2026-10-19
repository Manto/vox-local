# 🎵 VoxLocal - Chrome Extension

High-quality text-to-speech for the web built upon [Kokoro.js](https://github.com/hexgrad/kokoro) - a 82M parameter TTS model - and [Kitten TTS](https://github.com/KittenML/KittenTTS), both running entirely in your browser!

## ✨ Features

- **High-Quality Speech**: Uses the Kokoro-82M and Kitten TTS Mini models for natural-sounding text-to-speech
- **Browser-Native**: Runs entirely in your browser with WebAssembly - no external APIs or cloud services
- **Multiple Voices**: Choose from American and British English Kokoro voices or eight Kitten voices
- **Speed Control**: Adjust speaking speed from 0.5x to 2.0x
- **Context Menu**: Right-click any selected text on web pages to hear it spoken
- **Privacy-Focused**: All processing happens locally on your device
- **CSP Compliant**: Follows Chrome extension security policies

## 🚀 Quick Start

### Installation

1. **Clone and install:**
   ```bash
   git clone https://github.com/Manto/vox-local.git
   cd vox-local
   npm install
   ```

2. **Run tests (optional):**
   ```bash
   npm test
   ```

3. **Build the extension:**
   ```bash
   npm run build
   ```

4. **Load in Chrome:**
   - Open `chrome://extensions/`
   - Enable "Developer mode" (top right toggle)
   - Click "Load unpacked"
   - Select the `build/` folder
   - The extension icon should appear in your toolbar!

### Usage

#### From the Extension Popup:
1. Click the extension icon in your toolbar
2. Type or paste text in the input field
3. Select your preferred voice and adjust speed
4. Click "🔊 Speak" to hear the audio
5. Use "⏹️ Stop" to halt playback

#### From Any Webpage:
1. Select any text on any website
2. Right-click the selection
3. Choose "Speak '[selected text]'" from the context menu
4. Audio will play immediately!

## 🛠️ Development

### Project Structure

```text
src/
├── background.js    # Service worker - handles TTS model loading and audio generation
├── content.js       # Content script for webpage integration and UI
└── engines/
    └── kittenTTS.js # Kitten TTS engine (ONNX Runtime Web, always runs on wasm)

public/
├── manifest.json    # Extension manifest
└── icons/           # Extension icons

build/               # Compiled extension (generated)
```

### Development Workflow

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Start development server:**
   ```bash
   npm run dev
   ```
   This watches for changes and rebuilds automatically.

3. **Manual build:**
   ```bash
   npm run build
   ```

4. **Reload extension:**
   After making changes to `background.js` or `content.js`, reload the extension in `chrome://extensions/`

### Key Files

- **`background.js`**: Loads the Kokoro or Kitten TTS model and handles audio generation requests
- **`engines/kittenTTS.js`**: Runs the Kitten TTS model with the same `generate()` interface as Kokoro
- **`content.js`**: Manages the floating player UI and streaming audio playback
- **`manifest.json`**: Defines extension permissions and structure

## 🎙️ Available Voices

Pick a voice from the **voice** setting in the floating player. The voice decides which engine runs.

### Kokoro

#### American English
- **af_heart** (Female)
- **af_bella** (Female)
- **am_michael** (Male)
- **am_fenrir** (Male)

#### British English
- **bf_emma** (Female)
- **bm_george** (Male)

### Kitten Mini
- **Bella**, **Luna**, **Rosie**, **Kiki** (Female)
- **Jasper**, **Bruno**, **Hugo**, **Leo** (Male)

## 📋 Requirements

- **Chrome**: Version 92 or later
- **WebAssembly**: Enabled (default in modern Chrome)
- **Storage**: ~100MB for model files, plus ~80MB if you use Kitten voices (downloaded on first use)

## 🔒 Privacy & Security

- **No Data Transmission**: All processing happens locally in your browser
- **No External APIs**: No calls to cloud services or third-party APIs
- **No Data Collection**: No telemetry or usage tracking

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes and test thoroughly
4. Submit a pull request

## 🧪 Testing

This project includes comprehensive unit tests for the text chunking logic.

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode (for development)
npm run test:watch

# Run the Playwright end-to-end tests (first time: npx playwright install chromium)
npm run test:e2e

# Run the smoke test against the real extension (downloads the Kitten model)
npm run test:e2e:real
```

`npm run test:e2e` loads the built content script in Chromium with a fake background, so it covers the floating player's playback states (chunk ordering, waiting for chunks, stop, restart, errors, voice selection) without downloading a model. `npm run test:e2e:real` loads the whole `build/` extension and speaks a selection with a Kitten voice.

### Test Coverage

The test suite covers:
- **Basic sentence splitting**: Proper handling of periods, exclamation marks, and question marks
- **Sub-sentence splitting**: Breaking long sentences at commas and periods for better streaming
- **Word-level splitting**: Handling very long words by splitting at character boundaries
- **maxLength enforcement**: Ensuring no chunk exceeds the specified maximum length
- **Edge cases**: Empty strings, whitespace, consecutive punctuation, etc.
- **Text integrity**: Verifying that joined chunks reconstruct the original text perfectly

### Text Chunking Algorithm

The chunking algorithm intelligently splits text for streaming TTS:

1. **Sentence boundaries**: Splits at `.`, `!`, `?` while preserving trailing text
2. **Sub-sentence boundaries**: For long sentences, splits at `,` and `.` to create natural break points
3. **Word boundaries**: Falls back to word splitting when needed
4. **Character boundaries**: Ultimate fallback for extremely long words

This ensures smooth, natural-sounding speech synthesis with proper pacing and intonation.

## 📄 License

This project uses the Apache 2.0 License. See [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- [Hexgrad](https://github.com/hexgrad) for the Kokoro.js framework and the TTS model
- [KittenML](https://github.com/KittenML/KittenTTS) for the Kitten TTS model
- [HuggingFace](https://huggingface.co) for Transformers.js
