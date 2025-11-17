# 🎵 VoxLocal - Chrome Extension

High-quality text-to-speech for the web built upon [Kokoro.js](https://github.com/hexgrad/kokoro) - a 82M parameter TTS model running entirely in your browser!

## ✨ Features

- **High-Quality Speech**: Uses Kokoro-82M model for natural-sounding text-to-speech
- **Browser-Native**: Runs entirely in your browser with WebAssembly - no external APIs or cloud services
- **Multiple Voices**: Choose from various American and British English voices
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

2. **Build the extension:**
   ```bash
   npm run build
   ```

3. **Load in Chrome:**
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
├── popup.html       # Extension popup UI
├── popup.css        # Popup styling
├── popup.js         # Popup interaction logic
└── content.js       # Content script for webpage integration

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

- **`background.js`**: Loads the Kokoro TTS model and handles audio generation requests
- **`popup.js`**: Manages the extension popup UI and audio playback
- **`manifest.json`**: Defines extension permissions and structure

## 🎙️ Available Voices

### American English
- **af_heart** (Female)
- **af_bella** (Female)
- **am_michael** (Male)
- **am_fenrir** (Male)

### British English
- **bf_emma** (Female)
- **bm_george** (Male)

## 📋 Requirements

- **Chrome**: Version 92 or later
- **WebAssembly**: Enabled (default in modern Chrome)
- **Storage**: ~100MB for model files (downloaded on first use)

## 🔒 Privacy & Security

- **No Data Transmission**: All processing happens locally in your browser
- **No External APIs**: No calls to cloud services or third-party APIs
- **No Data Collection**: No telemetry or usage tracking

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes and test thoroughly
4. Submit a pull request

## 📄 License

This project uses the Apache 2.0 License. See [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- [Hexgrad](https://github.com/hexgrad) for the Kokoro.js framework and TTS model
- [HuggingFace](https://huggingface.co) for Transformers.js
