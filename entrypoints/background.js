// background.js - Handles requests from the UI, runs the TTS model, then sends back audio

import { KokoroTTS } from 'kokoro-js';
import { splitTextIntoSentences } from '../src/utils/textSplitter.js';

export default defineBackground({
  main: async () => {
    // Make XMLHttpRequest available globally for ONNX Runtime WASM loading
    if (typeof globalThis.XMLHttpRequest === 'undefined' && typeof XMLHttpRequest !== 'undefined') {
      globalThis.XMLHttpRequest = XMLHttpRequest;
    }

    // Note: ONNX Runtime warnings cannot be suppressed from the extension.
    // Any suppression should be configured via KokoroTTS/kokoro-js initialization options
    // or by upgrading kokoro-js if those features become available.

    // Efficient Uint8Array to base64 conversion
    function uint8ArrayToBase64(uint8Array) {
      // Use chunked approach to avoid call stack limits and improve performance
      const chunkSize = 8192; // Process in 8KB chunks
      let binaryString = '';

      for (let i = 0; i < uint8Array.length; i += chunkSize) {
        const chunk = uint8Array.slice(i, i + chunkSize);
        binaryString += String.fromCharCode.apply(null, chunk);
      }

      return btoa(binaryString);
    }

    // Handle extension icon clicks - toggle floating player
    chrome.action.onClicked.addListener(async (tab) => {
      if (tab.id === chrome.tabs.TAB_ID_NONE) return;

      try {
        // Send message to content script to toggle the floating player
        await chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_PLAYER' });
      } catch (error) {
        console.log('[VoxLocal] Content script not ready, will be initialized on next page load');
      }
    });

    class TTSSingleton {
      static model_id = 'onnx-community/Kokoro-82M-v1.0-ONNX';
      static instances = new Map(); // Store instances by dtype-device combination

      static async getInstance(dtype = 'fp32', device = 'webgpu', progress_callback = null) {
        const key = `${dtype}-${device}`;

        if (!this.instances.has(key)) {
          console.log(`[VoxLocal] Creating new TTS instance for ${key} (dtype: ${dtype}, device: ${device})`);

          // Configure ONNX Runtime options with only kokoro-js supported fields
          const ortOptions = {
            dtype: dtype,
            device: device,
            progress_callback: progress_callback
          };

          this.instances.set(key, await KokoroTTS.from_pretrained(this.model_id, ortOptions));
        } else {
          console.log(`[VoxLocal] Reusing existing TTS instance for ${key} (dtype: ${dtype}, device: ${device})`);
        }

        return this.instances.get(key);
      }
    }

    // Create generic TTS function, which will be reused for the different types of events.
    const generateSpeech = async (text, voice = 'af_heart', speed = 1, dtype = 'fp32', device = 'webgpu') => {
      console.log(`[VoxLocal] Starting speech generation for text (${text.length} characters) with voice: ${voice}, speed: ${speed}x, dtype: ${dtype}, device: ${device}`);

      // Get the TTS instance. This will load and build the model when run for the first time.
      console.log('[VoxLocal] Checking TTS model availability...');

      // Track progress milestones to only log at 25%, 50%, 75%, 100%
      let lastDownloadProgress = 0;

      let tts = await TTSSingleton.getInstance(dtype, device, (data) => {
        // You can track the progress of the model loading here.
        // e.g., you can send `data` back to the UI to indicate a progress bar

        const currentProgress = Math.round(data.progress * 100)/100;
        const milestones = [25, 50, 75, 100];

        if (data.status === 'progress') {
          // Only log when crossing milestone thresholds
          for (const milestone of milestones) {
            if (lastDownloadProgress < milestone && currentProgress >= milestone) {
              console.log(`[VoxLocal] Downloading model... ${milestone}% complete`);
              break;
            }
          }
          lastDownloadProgress = currentProgress;
        }
      });

      console.log('[VoxLocal] TTS model ready, generating audio...');

      // Generate audio from the input text
      console.log(`[VoxLocal] Processing text and generating audio... "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);
      let audio = await tts.generate(text, { voice, speed });
      console.log(`[VoxLocal] Audio generated successfully (${audio.sample_rate}Hz sample rate)`);

      // Use the built-in toBlob method to properly create WAV data
      console.log('[VoxLocal] Converting audio to blob format...');
      const blob = audio.toBlob();
      const arrayBuffer = await blob.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);

      // Convert Uint8Array to base64 efficiently using chunked approach
      console.log(`[VoxLocal] Converting ${uint8Array.length} bytes to base64...`);
      const base64Audio = uint8ArrayToBase64(uint8Array);
      console.log(`[VoxLocal] Audio processing complete (${(base64Audio.length / 1024).toFixed(2)} KB base64 data)`);

      return {
        audio: base64Audio,
        sampleRate: audio.sample_rate,
        voice: voice,
        speed: speed
      };
    };

    // Streaming TTS function that processes text in chunks and sends audio segments
    const generateStreamingSpeech = async (text, voice = 'af_heart', speed = 1, dtype = 'fp32', device = 'webgpu', requestId, onChunkComplete) => {
      console.log(`[VoxLocal] Starting streaming speech generation for text (${text.length} characters) with voice: ${voice}, speed: ${speed}x, dtype: ${dtype}, device: ${device}`);

      // Split text into manageable chunks
      const textChunks = splitTextIntoSentences(text);
      console.log(`[VoxLocal] Split text into ${textChunks.length} chunks for streaming`);

      // Get the TTS instance
      console.log('[VoxLocal] Checking TTS model availability...');

      // Track progress milestones to only log at 25%, 50%, 75%, 100%
      let lastDownloadProgress = 0;

      let tts = await TTSSingleton.getInstance(dtype, device, (data) => {
        const currentProgress = Math.round(data.progress * 100)/100;
        const milestones = [25, 50, 75, 100];

        if (data.status === 'progress') {
          for (const milestone of milestones) {
            if (lastDownloadProgress < milestone && currentProgress >= milestone) {
              console.log(`[VoxLocal] Downloading model... ${milestone}% complete`);
              break;
            }
          }
          lastDownloadProgress = currentProgress;
        }
      });

      console.log('[VoxLocal] TTS model ready, starting streaming audio generation...');

      const results = [];

      // Process each chunk
      for (let i = 0; i < textChunks.length; i++) {
        // Check if streaming was cancelled - capture requestId locally to avoid race conditions
        if (!activeStreamingRequest || activeStreamingRequest.id !== requestId || activeStreamingRequest.cancelled) {
          console.log('[VoxLocal] Streaming cancelled by user');
          break;
        }

        const chunk = textChunks[i];
        console.log(`[VoxLocal] Processing chunk ${i + 1}/${textChunks.length}: "${chunk.substring(0, 50)}${chunk.length > 50 ? '...' : ''}"`);

        try {
          // Generate audio for this chunk
          let audio = await tts.generate(chunk, { voice, speed });
          console.log(`[VoxLocal] Chunk ${i + 1} audio generated successfully (${audio.sample_rate}Hz sample rate)`);

          // Convert to base64
          const blob = audio.toBlob();
          const arrayBuffer = await blob.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);

          const base64Audio = uint8ArrayToBase64(uint8Array);

          const chunkResult = {
            action: 'stream_chunk',
            requestId: requestId,
            audio: base64Audio,
            sampleRate: audio.sample_rate,
            voice: voice,
            speed: speed,
            chunkIndex: i,
            totalChunks: textChunks.length,
            text: chunk
          };

          results.push(chunkResult);

          // Call the callback with this chunk result
          if (onChunkComplete) {
            onChunkComplete(chunkResult);
          }

        } catch (error) {
          console.error(`[VoxLocal] Error processing chunk ${i + 1}:`, error);
          throw error;
        }
      }

      console.log(`[VoxLocal] Streaming speech generation completed (${results.length} chunks processed)`);
      return results;
    };

    // Context menu setup
    chrome.runtime.onInstalled.addListener(function () {
      chrome.contextMenus.create({
        id: 'speak-selection',
        title: 'Speak "%s"',
        contexts: ['selection'],
      });
    });

    chrome.contextMenus.onClicked.addListener(async (info, tab) => {
      if (info.menuItemId !== 'speak-selection' || !info.selectionText) return;
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'PLAY_SELECTION' });
      } catch (error) {
        console.error('[VoxLocal] Context menu error:', error);
      }
    });

    // Message handling
    let activeStreamingRequest = null;
    let requestIdCounter = 0;
    let pendingChunks = new Map();

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action !== 'speak' && message.action !== 'speak_stream' && message.action !== 'cancel_stream' && message.action !== 'query_model_status') return;

      console.log(`[VoxLocal] Received ${message.action} request`);

      if (message.action === 'query_model_status') {
        const loaded = TTSSingleton.instances.size > 0;
        sendResponse({ loaded });
        return true;
      }

      if (message.action === 'speak_stream') {
        const requestId = message.requestId || ++requestIdCounter;
        activeStreamingRequest = { cancelled: false, id: requestId };

        (async function () {
          try {
            await generateStreamingSpeech(
              message.text,
              message.voice,
              message.speed,
              message.dtype,
              message.device,
              requestId,
              async (chunkResult) => {
                if (activeStreamingRequest?.id === requestId && !activeStreamingRequest.cancelled) {
                  if (!pendingChunks.has(requestId)) {
                    pendingChunks.set(requestId, []);
                  }
                  pendingChunks.get(requestId).push(chunkResult);
                  // Send to content script...
                }
              }
            );
            activeStreamingRequest = null;
            sendResponse({ success: true });
          } catch (error) {
            console.error('[VoxLocal] Streaming TTS error:', error);
            activeStreamingRequest = null;
            sendResponse({ success: false, error: error.message });
          }
        })();
      } else {
        (async function () {
          try {
            let result = await generateSpeech(message.text, message.voice, message.speed, message.dtype, message.device);
            sendResponse(result);
          } catch (error) {
            console.error('[VoxLocal] TTS error:', error);
            sendResponse({ success: false, error: error.message });
          }
        })();
      }

      return true;
    });

    // Clean up resources when extension is unloaded
    chrome.runtime.onSuspend.addListener(() => {
      console.log('[VoxLocal] Extension suspending, cleaning up resources...');
      pendingChunks.clear();
      if (activeStreamingRequest) {
        activeStreamingRequest.cancelled = true;
        activeStreamingRequest = null;
      }
    });
  }
});
