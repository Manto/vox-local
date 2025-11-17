# Chrome Web Store Submission Guide for VoxLocal v1.0.0

## Release Package Ready

The extension has been prepared and packaged for submission to the Chrome Web Store.

**Release Package:** `voxlocal-v1.0.0.zip` (5.9MB)

## Submission Steps

### 1. Create a Chrome Web Store Developer Account

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/)
2. Sign in with your Google account
3. Pay the one-time $5 developer registration fee (if not already registered)

### 2. Upload Your Extension

1. Click **"New Item"** in the Developer Dashboard
2. Upload `voxlocal-v1.0.0.zip`
3. Wait for the upload to complete and automatic validation

### 3. Complete Store Listing

#### Required Information:

**Product Details:**
- **Name:** VoxLocal
- **Summary:** High-quality text-to-speech built upon Kokoro.js - Speak any text from your browser!
- **Description:**
  ```
  VoxLocal brings high-quality, privacy-focused text-to-speech to your browser using the Kokoro-82M model.

  ✨ KEY FEATURES:
  • High-Quality Speech: Uses Kokoro-82M model for natural-sounding text-to-speech
  • Browser-Native: Runs entirely in your browser with WebAssembly - no external APIs or cloud services
  • Multiple Voices: Choose from various American and British English voices
  • Speed Control: Adjust speaking speed from 0.5x to 2.0x
  • Context Menu Integration: Right-click any selected text to hear it spoken
  • Privacy-Focused: All processing happens locally on your device
  • CSP Compliant: Follows Chrome extension security policies

  🎙️ AVAILABLE VOICES:
  American English: af_heart, af_bella, am_michael, am_fenrir
  British English: bf_emma, bm_george

  🔒 PRIVACY & SECURITY:
  • No Data Transmission: All processing happens locally
  • No External APIs: No calls to cloud services
  • No Data Collection: No telemetry or usage tracking
  • Open Source: Full source code available for review

  📋 REQUIREMENTS:
  • Chrome 92 or later
  • ~100MB storage for model files (downloaded on first use)

  Built upon Kokoro.js by Hexgrad - an 82M parameter TTS model running entirely in your browser!
  ```

- **Category:** Productivity
- **Language:** English (United States)

#### Icons (Already Included):
- 128x128: ✓ (icons/icon.png)
- 48x48: ✓ (icons/icon.png)
- 16x16: ✓ (icons/icon.png)

**Note:** Currently using the same 320x320 icon scaled to different sizes. Consider creating dedicated sizes for optimal display.

#### Screenshots (Required - You Need to Provide):
Upload 1-5 screenshots showing:
1. Extension popup with voice selection
2. Context menu in action on a webpage
3. Text being spoken with playback controls
4. Different voice options

**Recommended sizes:** 1280x800 or 640x400

#### Additional Assets (Optional but Recommended):
- **Promotional tile:** 440x280 pixels
- **Marquee promo tile:** 1400x560 pixels
- **Small promotional tile:** 220x140 pixels

### 4. Privacy & Compliance

**Privacy Policy:**
- Link to your hosted privacy policy (required for extensions with certain permissions)
- You can host the `PRIVACY_POLICY.md` file on GitHub:
  - Go to your repository settings → Pages
  - Enable GitHub Pages
  - Link: `https://manto.github.io/vox-local/PRIVACY_POLICY`
  - Or include it in README and link to: `https://github.com/Manto/vox-local#privacy-policy`

**Permissions Justification:**
You may need to justify these permissions:
- `activeTab`: Access text on current webpage when user selects it
- `scripting`: Inject context menu functionality
- `contextMenus`: Add "Speak" option to right-click menu
- `storage`: Save user preferences and TTS model files locally
- `unlimitedStorage`: Store ~100MB TTS model files for offline functionality

### 5. Pricing & Distribution

- **Pricing:** Free
- **Distribution:** Public (or unlisted for testing)
- **Regions:** All regions (or select specific countries)

### 6. Additional Declarations

You'll need to certify:
- ✓ The extension does not contain malware, spyware, or viruses
- ✓ The extension complies with Chrome Web Store policies
- ✓ You own or have rights to all content in the extension
- ✓ Single Purpose: Text-to-speech functionality

### 7. Review Process

After submission:
- Initial automated review: Minutes to hours
- Manual review: Can take several days to weeks
- You'll be notified via email of approval or required changes

## Testing Before Submission

1. Load `build/` folder as unpacked extension in Chrome
2. Test all features:
   - ✓ Extension popup opens and UI works
   - ✓ Voice selection works
   - ✓ Speed control works
   - ✓ Context menu appears on text selection
   - ✓ Audio playback works
   - ✓ Stop button functions correctly
3. Test on multiple websites
4. Check console for errors

## Post-Submission Checklist

- [ ] Monitor Developer Dashboard for review status
- [ ] Respond promptly to any review feedback
- [ ] Test published extension after approval
- [ ] Monitor user reviews and feedback
- [ ] Plan for future updates

## Support & Updates

**GitHub Repository:** https://github.com/Manto/vox-local
**Issues:** https://github.com/Manto/vox-local/issues

For future updates:
1. Update version in `manifest.json` and `package.json`
2. Run `npm run build`
3. Create new zip: `zip -r voxlocal-vX.Y.Z.zip build/`
4. Upload to Chrome Web Store Developer Dashboard
5. Submit for review

## Important Notes

- **First review** typically takes longer (few days to 2 weeks)
- **Updates** are usually reviewed faster
- Keep your extension's **permissions minimal** to speed up review
- Respond to review feedback within **60 days** or submission may be canceled
- Extensions using AI/ML models may receive additional scrutiny

Good luck with your submission! 🚀
