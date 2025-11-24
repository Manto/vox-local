export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    // content.js - the content scripts which is run in the context of web pages, and has access
    // to the DOM and other web APIs. Handles the floating TTS player and text extraction.

    // Floating player state
    let floatingPlayer = null;
    let isPlayerVisible = false;

    // Drag state
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let playerStartX = 0;
    let playerStartY = 0;

    // Global audio element for current playback
    let currentAudio = null;
    // Streaming TTS state
    let audioChunks = {}; // Object to store chunks by index for proper ordering
    let isStreaming = false;
    let currentStreamingRequestId = null; // Track the current streaming request ID
    let streamChunksReceived = 0;
    let totalStreamChunks = 0;
    let nextExpectedChunkIndex = 0; // Track the next chunk index we should play

    // Helper function to create Audio from base64 data
    function createAudioFromBase64(base64, { speed = 1 } = {}) {
      try {
        // Convert base64 back to binary data
        const audioData = atob(base64);
        const arrayBuffer = new ArrayBuffer(audioData.length);
        const uint8Array = new Uint8Array(arrayBuffer);
        for (let i = 0; i < audioData.length; i++) {
          uint8Array[i] = audioData.charCodeAt(i);
        }

        // Create blob and object URL
        const blob = new Blob([uint8Array], { type: 'audio/wav' });
        const audioUrl = URL.createObjectURL(blob);

        // Create and configure audio element
        const audio = new Audio(audioUrl);
        audio.playbackRate = speed;

        return { audio, audioUrl };
      } catch (error) {
        console.error('[VoxLocal] Error creating audio from base64:', error);
        throw error;
      }
    }

    // Listen for messages from background script - consolidated single listener
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // Handle messages based on their action
      if (message.action || message.type) { // Support both action and legacy type for backward compatibility
        const action = message.action || message.type;
        console.log('[VoxLocal] Received message:', message);

        switch (action) {
          // Data retrieval (synchronous responses)
          case 'GET_SELECTION':
            sendResponse({ text: getSelectedText() });
            return true;

          case 'GET_PAGE_TEXT':
            sendResponse({ text: getPageText() });
            return true;

          case 'TOGGLE_PLAYER':
            toggleFloatingPlayer();
            sendResponse({ success: true });
            return true;

          // UI actions (fire-and-forget)
          case 'SHOW_PLAYER':
            showFloatingPlayer();
            break;

          case 'PLAY_SELECTION':
            showFloatingPlayer();
            // Stop any current playback before starting new selection
            if (isStreaming || currentAudio) {
              stopPlayback();
            }
            speakFromPage('selection');
            break;

          // Streaming TTS messages (used for both panel and context menu)
          case 'stream_chunk':
            // Immediately discard chunks if not streaming
            if (!isStreaming) {
              return;
            }

            // Discard chunks that don't match the current streaming request
            if (message.requestId !== currentStreamingRequestId) {
              return;
            }

            console.log(`[VoxLocal] 📦 Processing streaming chunk ${message.chunkIndex + 1}/${message.totalChunks}`);
            streamChunksReceived = Math.max(streamChunksReceived, message.chunkIndex + 1);
            totalStreamChunks = message.totalChunks;

            // Store chunk by index for proper ordering
            audioChunks[message.chunkIndex] = message;
            console.log(`[VoxLocal] ➕ Stored chunk ${message.chunkIndex + 1}. Total chunks stored: ${Object.keys(audioChunks).length}/${totalStreamChunks}`);

            // Update status
            updateStatus(`Processing chunks: ${streamChunksReceived}/${totalStreamChunks} received`, 'loading');

            // Start or resume playback when no audio is currently playing
            if (!currentAudio && audioChunks[nextExpectedChunkIndex]) {
              console.log(`[VoxLocal] ▶️ ${nextExpectedChunkIndex === 0 ? 'Starting' : 'Resuming'} playback - chunk ${nextExpectedChunkIndex + 1} available`);
              playNextAudioChunk();
            }

            break;

          case 'stream_complete':
            console.log(`[VoxLocal] Streaming complete (requestId: ${message.requestId})`);

            // Only process completion if it matches the current streaming request
            if (message.requestId === currentStreamingRequestId) {
              isStreaming = false;
              currentStreamingRequestId = null;

              // If no chunks are currently playing, update status
              if (!currentAudio) {
                updateStatus('Ready', 'ready');
                updateButtonStates();
              }
            } else {
              console.log(`[VoxLocal] 🚫 Ignoring stream_complete - wrong request ID (expected: ${currentStreamingRequestId}, got: ${message.requestId})`);
            }

            break;

          case 'stream_error':
            console.error(`[VoxLocal] Streaming error (requestId: ${message.requestId}):`, message.error);

            // Only process error if it matches the current streaming request
            if (message.requestId === currentStreamingRequestId) {
              updateStatus('Streaming error: ' + message.error, 'error');
              resetStreamingState();
            } else {
              console.log(`[VoxLocal] 🚫 Ignoring stream_error - wrong request ID (expected: ${currentStreamingRequestId}, got: ${message.requestId})`);
            }
            break;

          default:
            console.log('[VoxLocal] Unknown action:', message.action);
        }
        // Action messages are handled asynchronously but don't need a response
        return false;
      }

      // If we get here, it's an unknown message format
      console.log('[VoxLocal] Received unknown message format:', message);
      return true;
    });

    // Toggle floating player visibility
    function toggleFloatingPlayer() {
      if (isPlayerVisible) {
        hideFloatingPlayer();
      } else {
        showFloatingPlayer();
      }
    }

    // Show floating player
    function showFloatingPlayer() {
      if (floatingPlayer) {
        floatingPlayer.style.display = 'block';
        isPlayerVisible = true;
        return;
      }

      createFloatingPlayer();
      isPlayerVisible = true;
    }

    // Hide floating player
    function hideFloatingPlayer() {
      if (floatingPlayer) {
        floatingPlayer.style.display = 'none';
        isPlayerVisible = false;
      }
    }

    // Create the floating player UI
    function createFloatingPlayer() {
      // Create the main container
      floatingPlayer = document.createElement('div');
      floatingPlayer.id = 'voxlocal-floating-player';
      floatingPlayer.innerHTML = `
        <div class="voxlocal-header">
          <span class="voxlocal-title">🎙️ VoxLocal</span>
          <button class="voxlocal-close-btn" title="Close">&times;</button>
        </div>
        <div class="voxlocal-status-section">
          <div id="voxlocal-status" class="status-badge ready">Ready</div>
        </div>
        <div class="voxlocal-controls">
          <button id="voxlocal-play-stop-btn" class="voxlocal-btn voxlocal-btn-primary" title="Play selection or page">
            <img src="" class="icon" alt="Play"> Play
          </button>
        </div>
        <div class="voxlocal-settings">
          <div class="voxlocal-setting-item">
            <div class="voxlocal-setting-display" id="voxlocal-voice-display">
              <div class="setting-value">Heart</div>
              <div class="setting-label">voice</div>
            </div>
            <select id="voxlocal-voice-select" class="voxlocal-setting-control hidden">
              <option value="af_heart">Heart (Female)</option>
              <option value="af_bella">Bella (Female)</option>
              <option value="am_michael">Michael (Male)</option>
              <option value="am_fenrir">Fenrir (Male)</option>
              <option value="bf_emma">Emma (British Female)</option>
              <option value="bm_george">George (British Male)</option>
            </select>
          </div>
          <div class="voxlocal-setting-item">
            <div class="voxlocal-setting-display" id="voxlocal-speed-display">
              <div class="setting-value">1.0x</div>
              <div class="setting-label">speed</div>
            </div>
            <input type="range" id="voxlocal-speed-slider" class="voxlocal-setting-control hidden" min="0.75" max="1.25" step="0.05" value="1.0">
          </div>
        </div>
      `;

      // Inject CSS
      injectPlayerStyles();

      // Add to page
      document.body.appendChild(floatingPlayer);

      // Set up event listeners
      setupEventListeners();

      // Load settings and initialize
      loadSettings();
      updateStatus('Ready');
      updateButtonText(); // Set initial button text based on current selection
      queryModelStatus();
    }

    // Inject CSS styles for the floating player
    function injectPlayerStyles() {
      const style = document.createElement('style');
      style.textContent = `
        #voxlocal-floating-player {
          position: fixed;
          top: 20px;
          left: auto;
          right: 20px;
          width: 240px;
          background: white;
          border: 1px solid #dee2e6;
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
          z-index: 10000;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 14px;
          line-height: 1.4;
          color: #212529;
        }

        .voxlocal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 12px 8px 12px;
          border-bottom: 1px solid #dee2e6;
        }

        .voxlocal-header .voxlocal-title {
          margin: 0;
          font-size: 16px;
          font-weight: 600;
        }

        .voxlocal-close-btn {
          background: none;
          border: none;
          font-size: 24px;
          cursor: pointer;
          color: #6c757d;
          padding: 0;
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .voxlocal-close-btn:hover {
          color: #dc3545;
        }

        .voxlocal-status-section {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin: 12px;
        }

        .status-badge {
          padding: 4px 10px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 500;
          text-align: center;
        }

        .status-badge.ready { background-color: #28a745; color: white; }
        .status-badge.loading { background-color: #ffc107; color: black; }
        .status-badge.speaking { background-color: #007bff; color: white; }
        .status-badge.error { background-color: #dc3545; color: white; }

        .voxlocal-controls {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin: 0 12px 16px 12px;
        }

        .voxlocal-btn {
          padding: 4px 12px;
          border: none;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s ease;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }

        .voxlocal-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .voxlocal-btn-primary { background-color: #007bff; color: white; }
        .voxlocal-btn-primary:hover:not(:disabled) { background-color: #0056b3; }
        .voxlocal-btn-danger { background-color: #dc3545; color: white; }
        .voxlocal-btn-danger:hover:not(:disabled) { background-color: #c82333; }

        .icon {
          font-size: 48px;
          width: 48px;
          height: 48px;
          vertical-align: middle;
          margin-right: 4px;
        }

        .icon img {
          width: 100%;
          height: 100%;
          object-fit: contain;
        }

        .voxlocal-input-section { margin: 0 16px 20px 16px; }

        #voxlocal-text {
          width: 100%;
          padding: 8px 12px;
          border: 1px solid #dee2e6;
          border-radius: 4px;
          font-size: 13px;
          line-height: 1.4;
          resize: vertical;
          min-height: 60px;
          background: white;
          box-sizing: border-box;
        }

        .voxlocal-settings {
          margin: 0 12px 12px 12px;
          padding-top: 12px;
          border-top: 1px solid #dee2e6;
          display: flex;
          gap: 16px;
        }

        .voxlocal-setting-item {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          position: relative;
        }

        .voxlocal-setting-display {
          display: flex;
          flex-direction: column;
          align-items: center;
          cursor: pointer;
          padding: 8px;
          border-radius: 6px;
          transition: background-color 0.2s ease;
          min-height: 50px;
          justify-content: center;
        }

        .voxlocal-setting-display:hover {
          background-color: #f8f9fa;
        }

        .setting-value {
          font-size: 16px;
          font-weight: 600;
          color: #212529;
          text-align: center;
        }

        .setting-label {
          font-size: 11px;
          color: #6c757d;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-top: 2px;
          text-align: center;
        }

        .voxlocal-setting-control {
          position: absolute;
          top: 100%;
          left: 50%;
          transform: translateX(-50%);
          width: 140px;
          padding: 12px;
          border: 1px solid #dee2e6;
          border-radius: 6px;
          font-size: 13px;
          background: white;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
          z-index: 10001;
          box-sizing: border-box;
          margin-top: 4px;
        }

        .voxlocal-setting-control.hidden {
          display: none;
        }

        .setting-note {
          display: block;
          margin-top: 2px;
          font-size: 11px;
          color: #6c757d;
          font-style: italic;
        }
      `;
      document.head.appendChild(style);
    }

    // Set up event listeners for the floating player
    function setupEventListeners() {
      // Close button
      floatingPlayer.querySelector('.voxlocal-close-btn').addEventListener('click', hideFloatingPlayer);

      // Drag functionality for the header
      const header = floatingPlayer.querySelector('.voxlocal-header');
      header.style.cursor = 'move';

      header.addEventListener('pointerdown', startDrag);
      document.addEventListener('pointermove', drag);
      document.addEventListener('pointerup', endDrag);

      // Voice display click - toggle dropdown
      const voiceDisplay = document.getElementById('voxlocal-voice-display');
      const voiceSelect = document.getElementById('voxlocal-voice-select');
      voiceDisplay.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleSettingControl(voiceSelect);
      });

      // Speed display click - toggle slider
      const speedDisplay = document.getElementById('voxlocal-speed-display');
      const speedSlider = document.getElementById('voxlocal-speed-slider');
      speedDisplay.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleSettingControl(speedSlider);
      });

      // Speed slider input - update display
      speedSlider.addEventListener('input', (event) => {
        updateSpeedDisplay(event.target.value);
      });

      // Speed slider pointerup - hide slider after interaction (works for mouse and touch)
      speedSlider.addEventListener('pointerup', () => {
        hideAllSettingControls();
      });

      // Click on floating player to close controls when clicking outside setting displays
      floatingPlayer.addEventListener('click', (event) => {
        // Only hide controls if clicking on the player itself or its direct children,
        // not on the setting displays (which have their own click handlers)
        const target = event.target;
        if (!target.closest('.voxlocal-setting-display')) {
          hideAllSettingControls();
        }
      });

      // Prevent clicks inside controls from closing them
      document.querySelectorAll('.voxlocal-setting-control').forEach(control => {
        control.addEventListener('click', event => event.stopPropagation());
      });

      // Play/Stop button
      document.getElementById('voxlocal-play-stop-btn').addEventListener('click', togglePlayStop);

      // Settings change listeners
      voiceSelect.addEventListener('change', () => {
        updateVoiceDisplay();
        saveSettings();
        hideAllSettingControls();
      });
      speedSlider.addEventListener('change', saveSettings);

      // Listen for text selection changes to update button text
      document.addEventListener('selectionchange', updateButtonText);
    }

    // Drag functionality
    function startDrag(event) {
      if (event.target.closest('.voxlocal-close-btn')) return; // Don't drag if clicking close button

      isDragging = true;
      dragStartX = event.clientX;
      dragStartY = event.clientY;

      const rect = floatingPlayer.getBoundingClientRect();
      playerStartX = rect.left;
      playerStartY = rect.top;

      // Prevent text selection during drag
      event.preventDefault();
      document.body.style.userSelect = 'none';
    }

    function drag(event) {
      if (!isDragging) return;

      const deltaX = event.clientX - dragStartX;
      const deltaY = event.clientY - dragStartY;

      const newX = playerStartX + deltaX;
      const newY = playerStartY + deltaY;

      // Keep player within viewport bounds
      const maxX = window.innerWidth - floatingPlayer.offsetWidth;
      const maxY = window.innerHeight - floatingPlayer.offsetHeight;

      floatingPlayer.style.left = Math.max(0, Math.min(newX, maxX)) + 'px';
      floatingPlayer.style.top = Math.max(0, Math.min(newY, maxY)) + 'px';
      floatingPlayer.style.right = 'auto'; // Clear any right positioning
    }

    function endDrag() {
      if (!isDragging) return;

      isDragging = false;
      document.body.style.userSelect = ''; // Restore text selection
    }

    // Toggle visibility of setting control (dropdown or slider)
    function toggleSettingControl(controlElement) {
      const isHidden = controlElement.classList.contains('hidden');
      // Hide all controls first
      hideAllSettingControls();
      // Show the clicked control if it was hidden
      if (isHidden) {
        controlElement.classList.remove('hidden');
      }
    }

    // Hide all setting controls
    function hideAllSettingControls() {
      document.querySelectorAll('.voxlocal-setting-control').forEach(el => {
        el.classList.add('hidden');
      });
    }

    // Update voice display with current selected voice name
    function updateVoiceDisplay() {
      const voiceSelect = document.getElementById('voxlocal-voice-select');
      const voiceDisplay = document.getElementById('voxlocal-voice-display').querySelector('.setting-value');
      const selectedOption = voiceSelect.options[voiceSelect.selectedIndex];
      const voiceName = selectedOption.text.split(' (')[0]; // Get name before parentheses
      voiceDisplay.textContent = voiceName;
    }

    // Update speed display
    function updateSpeedDisplay(value) {
      const speedDisplay = document.getElementById('voxlocal-speed-display').querySelector('.setting-value');
      speedDisplay.textContent = `${value}x`;
    }

    // Get selected text from the page
    function getSelectedText() {
      const selection = window.getSelection();
      return selection ? selection.toString().trim() : '';
    }

    // TTS functionality functions

    // Function to cancel streaming TTS
    function cancelStreamingTTS() {
      console.log('[VoxLocal] Cancelling streaming TTS request');

      // Send cancel message to background
      const message = {
        action: 'cancel_stream'
      };

      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[VoxLocal] Error sending cancel message:', chrome.runtime.lastError);
        }
      });
    }

    // Function to query model status from background
    function queryModelStatus() {
      console.log('[VoxLocal] Querying model status from background');

      const message = {
        action: 'query_model_status'
      };

      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[VoxLocal] Error querying model status:', chrome.runtime.lastError);
          return;
        }

        if (response && response.loaded) {
          const modelName = response.modelName ? ` (${response.modelName})` : '';
        }
      });
    }

    // Function to send text to streaming TTS for speech generation
    function sendStreamingTTS(text, voice, speed) {
      // Generate a unique request ID for this streaming session
      const requestId = Date.now() + Math.random();

      // Reset streaming state
      audioChunks = {};
      nextExpectedChunkIndex = 0;
      currentStreamingRequestId = requestId; // Track the current request ID
      isStreaming = true;
      streamChunksReceived = 0;
      totalStreamChunks = 0;

      // Update button states for streaming
      updateButtonStates();

      updateStatus('Starting streaming speech (processing in chunks)...', 'loading');

      // Send message to background script for streaming
      const message = {
        action: 'speak_stream',
        requestId: requestId,
        text: text,
        voice: voice,
        speed: speed
      };

      console.log(`[VoxLocal] Sending streaming speak message to background script - text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}", voice: ${voice}, speed: ${speed}x`);

      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[VoxLocal] Runtime error:', chrome.runtime.lastError);
          updateStatus('Error: ' + chrome.runtime.lastError.message, 'error');
          resetStreamingState();
          return;
        }

        if (!response || !response.success) {
          console.error('[VoxLocal] Streaming TTS failed:', response?.error);
          updateStatus('Error: ' + (response?.error || 'Streaming failed'), 'error');
          resetStreamingState();
        }
      });
    }

    // Function to speak text from page (selection or full page)
    async function speakFromPage(type) {
      const voice = document.getElementById('voxlocal-voice-select').value;
      const speed = parseFloat(document.getElementById('voxlocal-speed-slider').value);

      updateStatus(type === 'selection' ? 'Getting selected text...' : 'Getting page text...', 'loading');

      try {
        let text;
        if (type === 'selection') {
          text = getSelectedText();
        } else {
          text = getPageText();
        }

        if (!text || text.trim() === '') {
          const errorMsg = type === 'selection' ? 'No text selected' : 'No text found on page';
          updateStatus(errorMsg, 'error');
          setTimeout(() => updateStatus('Ready', 'ready'), 2000);
          resetButtons();
          return;
        }

        // Use the text and speak it using streaming logic
        const trimmedText = text.trim();
        console.log(`[VoxLocal] Got ${type} text: "${trimmedText.substring(0, 50)}${trimmedText.length > 50 ? '...' : ''}"`);

        // Send to streaming TTS with page-specific loading message
        sendStreamingTTS(trimmedText, voice, speed);
      } catch (error) {
        console.error('[VoxLocal] Error:', error);
        updateStatus('Error: ' + error.message, 'error');
        resetButtons();
      }
    }

    // Toggle between play and stop functionality
    function togglePlayStop() {
      // If currently playing (streaming), stop
      if (isStreaming || currentAudio) {
        console.log('[VoxLocal] Play/Stop button clicked - stopping playback');
        stopPlayback();
        return;
      }

      // If not playing, check for selection or play page
      const selectedText = getSelectedText();
      if (selectedText && selectedText.trim() !== '') {
        console.log('[VoxLocal] Play/Stop button clicked - playing selection');
        speakFromPage('selection');
      } else {
        console.log('[VoxLocal] Play/Stop button clicked - playing page');
        speakFromPage('page');
      }
    }

    // Stop playback
    function stopPlayback() {
      console.log('[VoxLocal] Stop button clicked');
      if (currentAudio) {
        console.log('[VoxLocal] Stopping current audio playback');
        currentAudio.pause();
        currentAudio = null;
      }

      // Cancel streaming if active
      if (isStreaming) {
        console.log('[VoxLocal] Cancelling active streaming request');
        cancelStreamingTTS();
        resetStreamingState();
      } else {
        resetButtons();
      }

      updateStatus('Stopped', 'ready');
    }

    // Play audio from base64 data
    function playAudio(response) {
      try {
        console.log('[VoxLocal] Converting base64 audio to playable format...');
        const { audio, audioUrl } = createAudioFromBase64(response.audio, { speed: response.speed || 1 });
        currentAudio = audio;
        console.log(`[VoxLocal] Audio element created with playback rate: ${currentAudio.playbackRate}x`);

        currentAudio.onloadedmetadata = () => {
          console.log(`[VoxLocal] Audio loaded - duration: ${currentAudio.duration.toFixed(2)}s`);
          updateStatus('Speaking', 'speaking');
          updateButtonStates();
        };

        currentAudio.onended = () => {
          console.log('[VoxLocal] Audio playback completed successfully');
          URL.revokeObjectURL(audioUrl);
          currentAudio = null;
          resetButtons();
          updateStatus('Ready', 'ready');
        };

        currentAudio.onerror = (error) => {
          console.error('[VoxLocal] Audio playback error:', currentAudio?.error?.message || 'Unknown error');
          URL.revokeObjectURL(audioUrl);
          currentAudio = null;
          resetButtons();
          updateStatus('Error', 'error');
        };

        console.log('[VoxLocal] Starting audio playback...');
        currentAudio.play().catch((error) => {
          console.error('[VoxLocal] Audio play failed:', error.message);
          URL.revokeObjectURL(audioUrl);
          currentAudio = null;
          resetButtons();
          updateStatus('Error: ' + error.message, 'error');
        });

      } catch (error) {
        console.error('[VoxLocal] Error creating audio:', error);
        updateStatus('Error: ' + error.message, 'error');
        resetButtons();
      }
    }

    // Update button text based on current selection
    function updateButtonText() {
      const playStopBtn = document.getElementById('voxlocal-play-stop-btn');
      if (!playStopBtn || isStreaming) return; // Don't update if streaming

      const selectedText = getSelectedText();
      const buttonText = selectedText && selectedText.trim() !== '' ? 'Play Selection' : 'Play Page';
      const iconPath = chrome.runtime.getURL('icons/icon_128x128_2.png');

      playStopBtn.innerHTML = `<img src="${iconPath}" class="icon" alt="Play"> ${buttonText}`;
    }

    // Reset button states
    function resetButtons() {
      const playStopBtn = document.getElementById('voxlocal-play-stop-btn');
      playStopBtn.disabled = false;

      updateButtonText();
      playStopBtn.title = 'Play selection or page';
      playStopBtn.className = 'voxlocal-btn voxlocal-btn-primary';
    }

    // Update status display
    function updateStatus(message, type = 'ready') {
      const statusElement = document.getElementById('voxlocal-status');
      if (!statusElement) return;

      statusElement.textContent = message;

      // Remove all status classes
      statusElement.className = 'status-badge';

      // Add the appropriate status class
      statusElement.classList.add(type);
    }

    // Reset streaming state
    function resetStreamingState() {
      audioChunks = {};
      nextExpectedChunkIndex = 0;
      currentStreamingRequestId = null;
      isStreaming = false;
      streamChunksReceived = 0;
      totalStreamChunks = 0;
      updateButtonStates();
    }

    // Update button states based on streaming status
    function updateButtonStates() {
      const playStopBtn = document.getElementById('voxlocal-play-stop-btn');
      if (isStreaming) {
        // During streaming, change to stop mode
        playStopBtn.disabled = false;
        const iconPath = chrome.runtime.getURL('icons/voxlocal-stop.png');
        playStopBtn.innerHTML = `<img src="${iconPath}" class="icon" alt="Stop"> Stop`;
        playStopBtn.title = 'Stop speaking';
        playStopBtn.className = 'voxlocal-btn voxlocal-btn-danger';
      } else {
        // Normal state - play mode
        resetButtons();
      }
    }

    // Play next audio chunk from stored chunks
    function playNextAudioChunk() {
      // Check if we have the next expected chunk
      if (!audioChunks[nextExpectedChunkIndex]) {
        if (isStreaming) {
          updateStatus('Streaming: waiting for next chunk...', 'loading');
        } else {
          // Streaming complete, check if we have all chunks
          if (nextExpectedChunkIndex >= totalStreamChunks) {
            updateStatus('Ready', 'ready');
            resetButtons();
          }
        }
        return;
      }

      const chunk = audioChunks[nextExpectedChunkIndex];
      delete audioChunks[nextExpectedChunkIndex]; // Remove from storage
      nextExpectedChunkIndex++;
      console.log(`[VoxLocal] 📝 Chunk text: "${chunk.text ? chunk.text.substring(0, 100) + (chunk.text.length > 100 ? '...' : '') : 'N/A'}"`);

      updateStatus(`Playing chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks} (streaming)`, 'speaking');

      try {
        const { audio, audioUrl } = createAudioFromBase64(chunk.audio, { speed: chunk.speed || 1 });
        currentAudio = audio;

        currentAudio.onended = () => {
          console.log(`[VoxLocal] ✅ Chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks} playback COMPLETED`);
          URL.revokeObjectURL(audioUrl);
          currentAudio = null;
          // Play next chunk
          console.log(`[VoxLocal] 🔄 Calling playNextAudioChunk after chunk ${chunk.chunkIndex + 1} completion`);
          playNextAudioChunk();
        };

        currentAudio.onerror = (error) => {
          console.error('[VoxLocal] Audio chunk playback error:', error);
          URL.revokeObjectURL(audioUrl);
          currentAudio = null;
          resetStreamingState();
          updateStatus('Error playing audio chunk', 'error');
        };

        console.log(`[VoxLocal] ▶️ Starting chunk ${chunk.chunkIndex + 1} audio playback...`);
        currentAudio.play().then(() => {
          console.log(`[VoxLocal] 🎧 Chunk ${chunk.chunkIndex + 1} STARTED playing successfully`);
        }).catch((error) => {
          console.error(`[VoxLocal] ❌ Audio chunk ${chunk.chunkIndex + 1} play FAILED:`, error.message);
          URL.revokeObjectURL(audioUrl);
          currentAudio = null;
          resetStreamingState();
          updateStatus('Error: ' + error.message, 'error');
        });

      } catch (error) {
        console.error('[VoxLocal] Error creating audio chunk:', error);
        resetStreamingState();
        updateStatus('Error: ' + error.message, 'error');
      }
    }

    // Settings storage functions
    async function saveSettings() {
      const settings = {
        voice: document.getElementById('voxlocal-voice-select').value,
        speed: parseFloat(document.getElementById('voxlocal-speed-slider').value)
      };

      try {
        await chrome.storage.sync.set({ voxLocalSettings: settings });
        console.log('[VoxLocal] Settings saved:', settings);
      } catch (error) {
        console.error('[VoxLocal] Error saving settings:', error);
      }
    }

    async function loadSettings() {
      try {
        const result = await chrome.storage.sync.get('voxLocalSettings');
        const settings = result.voxLocalSettings || {};

        // Apply saved settings with defaults
        document.getElementById('voxlocal-voice-select').value = settings.voice || 'af_heart';
        document.getElementById('voxlocal-speed-slider').value = settings.speed || 1.0;

        // Update displays
        updateVoiceDisplay();
        updateSpeedDisplay(document.getElementById('voxlocal-speed-slider').value);

        console.log('[VoxLocal] Settings loaded:', settings);
      } catch (error) {
        console.error('[VoxLocal] Error loading settings:', error);
        // Set defaults if loading fails
        document.getElementById('voxlocal-voice-select').value = 'af_heart';
        document.getElementById('voxlocal-speed-slider').value = 1.0;
        updateVoiceDisplay();
        updateSpeedDisplay(1.0);
      }
    }

    // Get readable text from the entire page
    function getPageText() {
      // Clone the body to avoid modifying the original
      const clone = document.body.cloneNode(true);

      // Remove unwanted elements
      const selectorsToRemove = [
        'script', 'style', 'noscript', 'iframe', 'nav', 'header', 'footer', 'aside',
        '[role="navigation"]', '[role="banner"]', '[role="complementary"]'
      ];

      selectorsToRemove.forEach(selector => {
        clone.querySelectorAll(selector).forEach(el => el.remove());
      });

      // Get text content and clean it up
      let text = clone.textContent || '';
      text = text
        .replace(/\n\s*\n/g, '\n\n')  // Remove excessive newlines
        .replace(/[ \t]+/g, ' ')       // Normalize whitespace
        .trim();

      return text;
    }
  }
});
