var content = (function() {
  "use strict";
  function defineContentScript(definition2) {
    return definition2;
  }
  const definition = defineContentScript({
    matches: ["<all_urls>"],
    main: () => {
      console.log("[VoxLocal] Content script loaded on", window.location.href);
      let floatingPlayer = null;
      let isPlayerVisible = false;
      let isDragging = false;
      let dragStartX = 0;
      let dragStartY = 0;
      let playerStartX = 0;
      let playerStartY = 0;
      let currentAudio = null;
      let audioChunks = {};
      let isStreaming = false;
      let currentStreamingRequestId = null;
      let streamChunksReceived = 0;
      let totalStreamChunks = 0;
      let nextExpectedChunkIndex = 0;
      function createAudioFromBase64(base64, { speed = 1 } = {}) {
        try {
          const audioData = atob(base64);
          const arrayBuffer = new ArrayBuffer(audioData.length);
          const uint8Array = new Uint8Array(arrayBuffer);
          for (let i = 0; i < audioData.length; i++) {
            uint8Array[i] = audioData.charCodeAt(i);
          }
          const blob = new Blob([uint8Array], { type: "audio/wav" });
          const audioUrl = URL.createObjectURL(blob);
          const audio = new Audio(audioUrl);
          audio.playbackRate = speed;
          return { audio, audioUrl };
        } catch (error) {
          console.error("[VoxLocal] Error creating audio from base64:", error);
          throw error;
        }
      }
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action || message.type) {
          const action = message.action || message.type;
          console.log("[VoxLocal] Received message:", message);
          switch (action) {
            // Data retrieval (synchronous responses)
            case "GET_SELECTION":
              sendResponse({ text: getSelectedText() });
              return true;
            case "GET_PAGE_TEXT":
              sendResponse({ text: getPageText() });
              return true;
            case "TOGGLE_PLAYER":
              toggleFloatingPlayer();
              sendResponse({ success: true });
              return true;
            // UI actions (fire-and-forget)
            case "SHOW_PLAYER":
              showFloatingPlayer();
              break;
            case "PLAY_SELECTION":
              showFloatingPlayer();
              if (isStreaming || currentAudio) {
                stopPlayback();
              }
              speakFromPage("selection");
              break;
            // Streaming TTS messages (used for both panel and context menu)
            case "stream_chunk":
              if (!isStreaming) {
                return;
              }
              if (message.requestId !== currentStreamingRequestId) {
                return;
              }
              console.log(`[VoxLocal] 📦 Processing streaming chunk ${message.chunkIndex + 1}/${message.totalChunks}`);
              streamChunksReceived = Math.max(streamChunksReceived, message.chunkIndex + 1);
              totalStreamChunks = message.totalChunks;
              audioChunks[message.chunkIndex] = message;
              console.log(`[VoxLocal] ➕ Stored chunk ${message.chunkIndex + 1}. Total chunks stored: ${Object.keys(audioChunks).length}/${totalStreamChunks}`);
              updateStatus(`Processing chunks: ${streamChunksReceived}/${totalStreamChunks} received`, "loading");
              if (!currentAudio && audioChunks[nextExpectedChunkIndex]) {
                console.log(`[VoxLocal] ▶️ ${nextExpectedChunkIndex === 0 ? "Starting" : "Resuming"} playback - chunk ${nextExpectedChunkIndex + 1} available`);
                playNextAudioChunk();
              }
              break;
            case "stream_complete":
              console.log(`[VoxLocal] Streaming complete (requestId: ${message.requestId})`);
              if (message.requestId === currentStreamingRequestId) {
                isStreaming = false;
                currentStreamingRequestId = null;
                if (!currentAudio) {
                  updateStatus("Ready", "ready");
                  updateButtonStates();
                }
              } else {
                console.log(`[VoxLocal] 🚫 Ignoring stream_complete - wrong request ID (expected: ${currentStreamingRequestId}, got: ${message.requestId})`);
              }
              break;
            case "stream_error":
              console.error(`[VoxLocal] Streaming error (requestId: ${message.requestId}):`, message.error);
              if (message.requestId === currentStreamingRequestId) {
                updateStatus("Streaming error: " + message.error, "error");
                resetStreamingState();
              } else {
                console.log(`[VoxLocal] 🚫 Ignoring stream_error - wrong request ID (expected: ${currentStreamingRequestId}, got: ${message.requestId})`);
              }
              break;
            default:
              console.log("[VoxLocal] Unknown action:", message.action);
          }
          return false;
        }
        console.log("[VoxLocal] Received unknown message format:", message);
        return true;
      });
      function toggleFloatingPlayer() {
        if (isPlayerVisible) {
          hideFloatingPlayer();
        } else {
          showFloatingPlayer();
        }
      }
      function showFloatingPlayer() {
        if (floatingPlayer) {
          floatingPlayer.style.display = "block";
          isPlayerVisible = true;
          return;
        }
        createFloatingPlayer();
        isPlayerVisible = true;
      }
      function hideFloatingPlayer() {
        if (floatingPlayer) {
          floatingPlayer.style.display = "none";
          isPlayerVisible = false;
        }
      }
      function createFloatingPlayer() {
        floatingPlayer = document.createElement("div");
        floatingPlayer.id = "voxlocal-floating-player";
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
        injectPlayerStyles();
        document.body.appendChild(floatingPlayer);
        setupEventListeners();
        loadSettings();
        updateStatus("Ready");
        updateButtonText();
        queryModelStatus();
      }
      function injectPlayerStyles() {
        const style = document.createElement("style");
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
      function setupEventListeners() {
        floatingPlayer.querySelector(".voxlocal-close-btn").addEventListener("click", hideFloatingPlayer);
        const header = floatingPlayer.querySelector(".voxlocal-header");
        header.style.cursor = "move";
        header.addEventListener("pointerdown", startDrag);
        document.addEventListener("pointermove", drag);
        document.addEventListener("pointerup", endDrag);
        const voiceDisplay = document.getElementById("voxlocal-voice-display");
        const voiceSelect = document.getElementById("voxlocal-voice-select");
        voiceDisplay.addEventListener("click", (event) => {
          event.stopPropagation();
          toggleSettingControl(voiceSelect);
        });
        const speedDisplay = document.getElementById("voxlocal-speed-display");
        const speedSlider = document.getElementById("voxlocal-speed-slider");
        speedDisplay.addEventListener("click", (event) => {
          event.stopPropagation();
          toggleSettingControl(speedSlider);
        });
        speedSlider.addEventListener("input", (event) => {
          updateSpeedDisplay(event.target.value);
        });
        speedSlider.addEventListener("pointerup", () => {
          hideAllSettingControls();
        });
        floatingPlayer.addEventListener("click", (event) => {
          const target = event.target;
          if (!target.closest(".voxlocal-setting-display")) {
            hideAllSettingControls();
          }
        });
        document.querySelectorAll(".voxlocal-setting-control").forEach((control) => {
          control.addEventListener("click", (event) => event.stopPropagation());
        });
        document.getElementById("voxlocal-play-stop-btn").addEventListener("click", togglePlayStop);
        voiceSelect.addEventListener("change", () => {
          updateVoiceDisplay();
          saveSettings();
          hideAllSettingControls();
        });
        speedSlider.addEventListener("change", saveSettings);
        document.addEventListener("selectionchange", updateButtonText);
      }
      function startDrag(event) {
        if (event.target.closest(".voxlocal-close-btn")) return;
        isDragging = true;
        dragStartX = event.clientX;
        dragStartY = event.clientY;
        const rect = floatingPlayer.getBoundingClientRect();
        playerStartX = rect.left;
        playerStartY = rect.top;
        event.preventDefault();
        document.body.style.userSelect = "none";
      }
      function drag(event) {
        if (!isDragging) return;
        const deltaX = event.clientX - dragStartX;
        const deltaY = event.clientY - dragStartY;
        const newX = playerStartX + deltaX;
        const newY = playerStartY + deltaY;
        const maxX = window.innerWidth - floatingPlayer.offsetWidth;
        const maxY = window.innerHeight - floatingPlayer.offsetHeight;
        floatingPlayer.style.left = Math.max(0, Math.min(newX, maxX)) + "px";
        floatingPlayer.style.top = Math.max(0, Math.min(newY, maxY)) + "px";
        floatingPlayer.style.right = "auto";
      }
      function endDrag() {
        if (!isDragging) return;
        isDragging = false;
        document.body.style.userSelect = "";
      }
      function toggleSettingControl(controlElement) {
        const isHidden = controlElement.classList.contains("hidden");
        hideAllSettingControls();
        if (isHidden) {
          controlElement.classList.remove("hidden");
        }
      }
      function hideAllSettingControls() {
        document.querySelectorAll(".voxlocal-setting-control").forEach((el) => {
          el.classList.add("hidden");
        });
      }
      function updateVoiceDisplay() {
        const voiceSelect = document.getElementById("voxlocal-voice-select");
        const voiceDisplay = document.getElementById("voxlocal-voice-display").querySelector(".setting-value");
        const selectedOption = voiceSelect.options[voiceSelect.selectedIndex];
        const voiceName = selectedOption.text.split(" (")[0];
        voiceDisplay.textContent = voiceName;
      }
      function updateSpeedDisplay(value) {
        const speedDisplay = document.getElementById("voxlocal-speed-display").querySelector(".setting-value");
        speedDisplay.textContent = `${value}x`;
      }
      function getSelectedText() {
        const selection = window.getSelection();
        return selection ? selection.toString().trim() : "";
      }
      function cancelStreamingTTS() {
        console.log("[VoxLocal] Cancelling streaming TTS request");
        const message = {
          action: "cancel_stream"
        };
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            console.error("[VoxLocal] Error sending cancel message:", chrome.runtime.lastError);
          }
        });
      }
      function queryModelStatus() {
        console.log("[VoxLocal] Querying model status from background");
        const message = {
          action: "query_model_status"
        };
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            console.error("[VoxLocal] Error querying model status:", chrome.runtime.lastError);
            return;
          }
          if (response && response.loaded) {
            response.modelName ? ` (${response.modelName})` : "";
          }
        });
      }
      function sendStreamingTTS(text, voice, speed) {
        const requestId = Date.now() + Math.random();
        audioChunks = {};
        nextExpectedChunkIndex = 0;
        currentStreamingRequestId = requestId;
        isStreaming = true;
        streamChunksReceived = 0;
        totalStreamChunks = 0;
        updateButtonStates();
        updateStatus("Starting streaming speech (processing in chunks)...", "loading");
        const message = {
          action: "speak_stream",
          requestId,
          text,
          voice,
          speed
        };
        console.log(`[VoxLocal] Sending streaming speak message to background script - text: "${text.substring(0, 50)}${text.length > 50 ? "..." : ""}", voice: ${voice}, speed: ${speed}x`);
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            console.error("[VoxLocal] Runtime error:", chrome.runtime.lastError);
            updateStatus("Error: " + chrome.runtime.lastError.message, "error");
            resetStreamingState();
            return;
          }
          if (!response || !response.success) {
            console.error("[VoxLocal] Streaming TTS failed:", response?.error);
            updateStatus("Error: " + (response?.error || "Streaming failed"), "error");
            resetStreamingState();
          }
        });
      }
      async function speakFromPage(type) {
        const voice = document.getElementById("voxlocal-voice-select").value;
        const speed = parseFloat(document.getElementById("voxlocal-speed-slider").value);
        updateStatus(type === "selection" ? "Getting selected text..." : "Getting page text...", "loading");
        try {
          let text;
          if (type === "selection") {
            text = getSelectedText();
          } else {
            text = getPageText();
          }
          if (!text || text.trim() === "") {
            const errorMsg = type === "selection" ? "No text selected" : "No text found on page";
            updateStatus(errorMsg, "error");
            setTimeout(() => updateStatus("Ready", "ready"), 2e3);
            resetButtons();
            return;
          }
          const trimmedText = text.trim();
          console.log(`[VoxLocal] Got ${type} text: "${trimmedText.substring(0, 50)}${trimmedText.length > 50 ? "..." : ""}"`);
          sendStreamingTTS(trimmedText, voice, speed);
        } catch (error) {
          console.error("[VoxLocal] Error:", error);
          updateStatus("Error: " + error.message, "error");
          resetButtons();
        }
      }
      function togglePlayStop() {
        if (isStreaming || currentAudio) {
          console.log("[VoxLocal] Play/Stop button clicked - stopping playback");
          stopPlayback();
          return;
        }
        const selectedText = getSelectedText();
        if (selectedText && selectedText.trim() !== "") {
          console.log("[VoxLocal] Play/Stop button clicked - playing selection");
          speakFromPage("selection");
        } else {
          console.log("[VoxLocal] Play/Stop button clicked - playing page");
          speakFromPage("page");
        }
      }
      function stopPlayback() {
        console.log("[VoxLocal] Stop button clicked");
        if (currentAudio) {
          console.log("[VoxLocal] Stopping current audio playback");
          currentAudio.pause();
          currentAudio = null;
        }
        if (isStreaming) {
          console.log("[VoxLocal] Cancelling active streaming request");
          cancelStreamingTTS();
          resetStreamingState();
        } else {
          resetButtons();
        }
        updateStatus("Stopped", "ready");
      }
      function updateButtonText() {
        const playStopBtn = document.getElementById("voxlocal-play-stop-btn");
        if (!playStopBtn || isStreaming) return;
        const selectedText = getSelectedText();
        const buttonText = selectedText && selectedText.trim() !== "" ? "Play Selection" : "Play Page";
        const iconPath = chrome.runtime.getURL("icons/icon_128x128_2.png");
        playStopBtn.innerHTML = `<img src="${iconPath}" class="icon" alt="Play"> ${buttonText}`;
      }
      function resetButtons() {
        const playStopBtn = document.getElementById("voxlocal-play-stop-btn");
        playStopBtn.disabled = false;
        updateButtonText();
        playStopBtn.title = "Play selection or page";
        playStopBtn.className = "voxlocal-btn voxlocal-btn-primary";
      }
      function updateStatus(message, type = "ready") {
        const statusElement = document.getElementById("voxlocal-status");
        if (!statusElement) return;
        statusElement.textContent = message;
        statusElement.className = "status-badge";
        statusElement.classList.add(type);
      }
      function resetStreamingState() {
        audioChunks = {};
        nextExpectedChunkIndex = 0;
        currentStreamingRequestId = null;
        isStreaming = false;
        streamChunksReceived = 0;
        totalStreamChunks = 0;
        updateButtonStates();
      }
      function updateButtonStates() {
        const playStopBtn = document.getElementById("voxlocal-play-stop-btn");
        if (isStreaming) {
          playStopBtn.disabled = false;
          const iconPath = chrome.runtime.getURL("icons/voxlocal-stop.png");
          playStopBtn.innerHTML = `<img src="${iconPath}" class="icon" alt="Stop"> Stop`;
          playStopBtn.title = "Stop speaking";
          playStopBtn.className = "voxlocal-btn voxlocal-btn-danger";
        } else {
          resetButtons();
        }
      }
      function playNextAudioChunk() {
        if (!audioChunks[nextExpectedChunkIndex]) {
          if (isStreaming) {
            updateStatus("Streaming: waiting for next chunk...", "loading");
          } else {
            if (nextExpectedChunkIndex >= totalStreamChunks) {
              updateStatus("Ready", "ready");
              resetButtons();
            }
          }
          return;
        }
        const chunk = audioChunks[nextExpectedChunkIndex];
        delete audioChunks[nextExpectedChunkIndex];
        nextExpectedChunkIndex++;
        console.log(`[VoxLocal] 📝 Chunk text: "${chunk.text ? chunk.text.substring(0, 100) + (chunk.text.length > 100 ? "..." : "") : "N/A"}"`);
        updateStatus(`Playing chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks} (streaming)`, "speaking");
        try {
          const { audio, audioUrl } = createAudioFromBase64(chunk.audio, { speed: chunk.speed || 1 });
          currentAudio = audio;
          currentAudio.onended = () => {
            console.log(`[VoxLocal] ✅ Chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks} playback COMPLETED`);
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            console.log(`[VoxLocal] 🔄 Calling playNextAudioChunk after chunk ${chunk.chunkIndex + 1} completion`);
            playNextAudioChunk();
          };
          currentAudio.onerror = (error) => {
            console.error("[VoxLocal] Audio chunk playback error:", error);
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            resetStreamingState();
            updateStatus("Error playing audio chunk", "error");
          };
          console.log(`[VoxLocal] ▶️ Starting chunk ${chunk.chunkIndex + 1} audio playback...`);
          currentAudio.play().then(() => {
            console.log(`[VoxLocal] 🎧 Chunk ${chunk.chunkIndex + 1} STARTED playing successfully`);
          }).catch((error) => {
            console.error(`[VoxLocal] ❌ Audio chunk ${chunk.chunkIndex + 1} play FAILED:`, error.message);
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            resetStreamingState();
            updateStatus("Error: " + error.message, "error");
          });
        } catch (error) {
          console.error("[VoxLocal] Error creating audio chunk:", error);
          resetStreamingState();
          updateStatus("Error: " + error.message, "error");
        }
      }
      async function saveSettings() {
        const settings = {
          voice: document.getElementById("voxlocal-voice-select").value,
          speed: parseFloat(document.getElementById("voxlocal-speed-slider").value)
        };
        try {
          await chrome.storage.sync.set({ voxLocalSettings: settings });
          console.log("[VoxLocal] Settings saved:", settings);
        } catch (error) {
          console.error("[VoxLocal] Error saving settings:", error);
        }
      }
      async function loadSettings() {
        try {
          const result2 = await chrome.storage.sync.get("voxLocalSettings");
          const settings = result2.voxLocalSettings || {};
          document.getElementById("voxlocal-voice-select").value = settings.voice || "af_heart";
          document.getElementById("voxlocal-speed-slider").value = settings.speed || 1;
          updateVoiceDisplay();
          updateSpeedDisplay(document.getElementById("voxlocal-speed-slider").value);
          console.log("[VoxLocal] Settings loaded:", settings);
        } catch (error) {
          console.error("[VoxLocal] Error loading settings:", error);
          document.getElementById("voxlocal-voice-select").value = "af_heart";
          document.getElementById("voxlocal-speed-slider").value = 1;
          updateVoiceDisplay();
          updateSpeedDisplay(1);
        }
      }
      function getPageText() {
        const clone = document.body.cloneNode(true);
        const selectorsToRemove = [
          "script",
          "style",
          "noscript",
          "iframe",
          "nav",
          "header",
          "footer",
          "aside",
          '[role="navigation"]',
          '[role="banner"]',
          '[role="complementary"]'
        ];
        selectorsToRemove.forEach((selector) => {
          clone.querySelectorAll(selector).forEach((el) => el.remove());
        });
        let text = clone.textContent || "";
        text = text.replace(/\n\s*\n/g, "\n\n").replace(/[ \t]+/g, " ").trim();
        return text;
      }
    }
  });
  const browser$1 = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
  const browser = browser$1;
  function print$1(method, ...args) {
    if (typeof args[0] === "string") {
      const message = args.shift();
      method(`[wxt] ${message}`, ...args);
    } else {
      method("[wxt]", ...args);
    }
  }
  const logger$1 = {
    debug: (...args) => print$1(console.debug, ...args),
    log: (...args) => print$1(console.log, ...args),
    warn: (...args) => print$1(console.warn, ...args),
    error: (...args) => print$1(console.error, ...args)
  };
  class WxtLocationChangeEvent extends Event {
    constructor(newUrl, oldUrl) {
      super(WxtLocationChangeEvent.EVENT_NAME, {});
      this.newUrl = newUrl;
      this.oldUrl = oldUrl;
    }
    static EVENT_NAME = getUniqueEventName("wxt:locationchange");
  }
  function getUniqueEventName(eventName) {
    return `${browser?.runtime?.id}:${"content"}:${eventName}`;
  }
  function createLocationWatcher(ctx) {
    let interval;
    let oldUrl;
    return {
      /**
       * Ensure the location watcher is actively looking for URL changes. If it's already watching,
       * this is a noop.
       */
      run() {
        if (interval != null) return;
        oldUrl = new URL(location.href);
        interval = ctx.setInterval(() => {
          let newUrl = new URL(location.href);
          if (newUrl.href !== oldUrl.href) {
            window.dispatchEvent(new WxtLocationChangeEvent(newUrl, oldUrl));
            oldUrl = newUrl;
          }
        }, 1e3);
      }
    };
  }
  class ContentScriptContext {
    constructor(contentScriptName, options) {
      this.contentScriptName = contentScriptName;
      this.options = options;
      this.abortController = new AbortController();
      if (this.isTopFrame) {
        this.listenForNewerScripts({ ignoreFirstEvent: true });
        this.stopOldScripts();
      } else {
        this.listenForNewerScripts();
      }
    }
    static SCRIPT_STARTED_MESSAGE_TYPE = getUniqueEventName(
      "wxt:content-script-started"
    );
    isTopFrame = window.self === window.top;
    abortController;
    locationWatcher = createLocationWatcher(this);
    receivedMessageIds = /* @__PURE__ */ new Set();
    get signal() {
      return this.abortController.signal;
    }
    abort(reason) {
      return this.abortController.abort(reason);
    }
    get isInvalid() {
      if (browser.runtime.id == null) {
        this.notifyInvalidated();
      }
      return this.signal.aborted;
    }
    get isValid() {
      return !this.isInvalid;
    }
    /**
     * Add a listener that is called when the content script's context is invalidated.
     *
     * @returns A function to remove the listener.
     *
     * @example
     * browser.runtime.onMessage.addListener(cb);
     * const removeInvalidatedListener = ctx.onInvalidated(() => {
     *   browser.runtime.onMessage.removeListener(cb);
     * })
     * // ...
     * removeInvalidatedListener();
     */
    onInvalidated(cb) {
      this.signal.addEventListener("abort", cb);
      return () => this.signal.removeEventListener("abort", cb);
    }
    /**
     * Return a promise that never resolves. Useful if you have an async function that shouldn't run
     * after the context is expired.
     *
     * @example
     * const getValueFromStorage = async () => {
     *   if (ctx.isInvalid) return ctx.block();
     *
     *   // ...
     * }
     */
    block() {
      return new Promise(() => {
      });
    }
    /**
     * Wrapper around `window.setInterval` that automatically clears the interval when invalidated.
     *
     * Intervals can be cleared by calling the normal `clearInterval` function.
     */
    setInterval(handler, timeout) {
      const id = setInterval(() => {
        if (this.isValid) handler();
      }, timeout);
      this.onInvalidated(() => clearInterval(id));
      return id;
    }
    /**
     * Wrapper around `window.setTimeout` that automatically clears the interval when invalidated.
     *
     * Timeouts can be cleared by calling the normal `setTimeout` function.
     */
    setTimeout(handler, timeout) {
      const id = setTimeout(() => {
        if (this.isValid) handler();
      }, timeout);
      this.onInvalidated(() => clearTimeout(id));
      return id;
    }
    /**
     * Wrapper around `window.requestAnimationFrame` that automatically cancels the request when
     * invalidated.
     *
     * Callbacks can be canceled by calling the normal `cancelAnimationFrame` function.
     */
    requestAnimationFrame(callback) {
      const id = requestAnimationFrame((...args) => {
        if (this.isValid) callback(...args);
      });
      this.onInvalidated(() => cancelAnimationFrame(id));
      return id;
    }
    /**
     * Wrapper around `window.requestIdleCallback` that automatically cancels the request when
     * invalidated.
     *
     * Callbacks can be canceled by calling the normal `cancelIdleCallback` function.
     */
    requestIdleCallback(callback, options) {
      const id = requestIdleCallback((...args) => {
        if (!this.signal.aborted) callback(...args);
      }, options);
      this.onInvalidated(() => cancelIdleCallback(id));
      return id;
    }
    addEventListener(target, type, handler, options) {
      if (type === "wxt:locationchange") {
        if (this.isValid) this.locationWatcher.run();
      }
      target.addEventListener?.(
        type.startsWith("wxt:") ? getUniqueEventName(type) : type,
        handler,
        {
          ...options,
          signal: this.signal
        }
      );
    }
    /**
     * @internal
     * Abort the abort controller and execute all `onInvalidated` listeners.
     */
    notifyInvalidated() {
      this.abort("Content script context invalidated");
      logger$1.debug(
        `Content script "${this.contentScriptName}" context invalidated`
      );
    }
    stopOldScripts() {
      window.postMessage(
        {
          type: ContentScriptContext.SCRIPT_STARTED_MESSAGE_TYPE,
          contentScriptName: this.contentScriptName,
          messageId: Math.random().toString(36).slice(2)
        },
        "*"
      );
    }
    verifyScriptStartedEvent(event) {
      const isScriptStartedEvent = event.data?.type === ContentScriptContext.SCRIPT_STARTED_MESSAGE_TYPE;
      const isSameContentScript = event.data?.contentScriptName === this.contentScriptName;
      const isNotDuplicate = !this.receivedMessageIds.has(event.data?.messageId);
      return isScriptStartedEvent && isSameContentScript && isNotDuplicate;
    }
    listenForNewerScripts(options) {
      let isFirst = true;
      const cb = (event) => {
        if (this.verifyScriptStartedEvent(event)) {
          this.receivedMessageIds.add(event.data.messageId);
          const wasFirst = isFirst;
          isFirst = false;
          if (wasFirst && options?.ignoreFirstEvent) return;
          this.notifyInvalidated();
        }
      };
      addEventListener("message", cb);
      this.onInvalidated(() => removeEventListener("message", cb));
    }
  }
  function initPlugins() {
  }
  function print(method, ...args) {
    if (typeof args[0] === "string") {
      const message = args.shift();
      method(`[wxt] ${message}`, ...args);
    } else {
      method("[wxt]", ...args);
    }
  }
  const logger = {
    debug: (...args) => print(console.debug, ...args),
    log: (...args) => print(console.log, ...args),
    warn: (...args) => print(console.warn, ...args),
    error: (...args) => print(console.error, ...args)
  };
  const result = (async () => {
    try {
      initPlugins();
      const { main, ...options } = definition;
      const ctx = new ContentScriptContext("content", options);
      return await main(ctx);
    } catch (err) {
      logger.error(
        `The content script "${"content"}" crashed on startup!`,
        err
      );
      throw err;
    }
  })();
  return result;
})();
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29udGVudC5qcyIsInNvdXJjZXMiOlsiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2RlZmluZS1jb250ZW50LXNjcmlwdC5tanMiLCIuLi8uLi8uLi9lbnRyeXBvaW50cy9jb250ZW50LmpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL0B3eHQtZGV2L2Jyb3dzZXIvc3JjL2luZGV4Lm1qcyIsIi4uLy4uLy4uL25vZGVfbW9kdWxlcy93eHQvZGlzdC9icm93c2VyLm1qcyIsIi4uLy4uLy4uL25vZGVfbW9kdWxlcy93eHQvZGlzdC91dGlscy9pbnRlcm5hbC9sb2dnZXIubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2ludGVybmFsL2N1c3RvbS1ldmVudHMubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2ludGVybmFsL2xvY2F0aW9uLXdhdGNoZXIubWpzIiwiLi4vLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2NvbnRlbnQtc2NyaXB0LWNvbnRleHQubWpzIl0sInNvdXJjZXNDb250ZW50IjpbImV4cG9ydCBmdW5jdGlvbiBkZWZpbmVDb250ZW50U2NyaXB0KGRlZmluaXRpb24pIHtcbiAgcmV0dXJuIGRlZmluaXRpb247XG59XG4iLCIvLyBjb250ZW50LmpzIC0gdGhlIGNvbnRlbnQgc2NyaXB0cyB3aGljaCBpcyBydW4gaW4gdGhlIGNvbnRleHQgb2Ygd2ViIHBhZ2VzLCBhbmQgaGFzIGFjY2Vzc1xuLy8gdG8gdGhlIERPTSBhbmQgb3RoZXIgd2ViIEFQSXMuIEhhbmRsZXMgdGhlIGZsb2F0aW5nIFRUUyBwbGF5ZXIgYW5kIHRleHQgZXh0cmFjdGlvbi5cblxuaW1wb3J0IHsgZGVmaW5lQ29udGVudFNjcmlwdCB9IGZyb20gJ3d4dC91dGlscy9kZWZpbmUtY29udGVudC1zY3JpcHQnO1xuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb250ZW50U2NyaXB0KHtcbiAgbWF0Y2hlczogWyc8YWxsX3VybHM+J10sXG4gIG1haW46ICgpID0+IHtcbiAgICBjb25zb2xlLmxvZygnW1ZveExvY2FsXSBDb250ZW50IHNjcmlwdCBsb2FkZWQgb24nLCB3aW5kb3cubG9jYXRpb24uaHJlZik7XG4gICAgLy8gRmxvYXRpbmcgcGxheWVyIHN0YXRlXG5sZXQgZmxvYXRpbmdQbGF5ZXIgPSBudWxsO1xubGV0IGlzUGxheWVyVmlzaWJsZSA9IGZhbHNlO1xuXG4vLyBEcmFnIHN0YXRlXG5sZXQgaXNEcmFnZ2luZyA9IGZhbHNlO1xubGV0IGRyYWdTdGFydFggPSAwO1xubGV0IGRyYWdTdGFydFkgPSAwO1xubGV0IHBsYXllclN0YXJ0WCA9IDA7XG5sZXQgcGxheWVyU3RhcnRZID0gMDtcblxuLy8gR2xvYmFsIGF1ZGlvIGVsZW1lbnQgZm9yIGN1cnJlbnQgcGxheWJhY2tcbmxldCBjdXJyZW50QXVkaW8gPSBudWxsO1xuLy8gU3RyZWFtaW5nIFRUUyBzdGF0ZVxubGV0IGF1ZGlvQ2h1bmtzID0ge307IC8vIE9iamVjdCB0byBzdG9yZSBjaHVua3MgYnkgaW5kZXggZm9yIHByb3BlciBvcmRlcmluZ1xubGV0IGlzU3RyZWFtaW5nID0gZmFsc2U7XG5sZXQgY3VycmVudFN0cmVhbWluZ1JlcXVlc3RJZCA9IG51bGw7IC8vIFRyYWNrIHRoZSBjdXJyZW50IHN0cmVhbWluZyByZXF1ZXN0IElEXG5sZXQgc3RyZWFtQ2h1bmtzUmVjZWl2ZWQgPSAwO1xubGV0IHRvdGFsU3RyZWFtQ2h1bmtzID0gMDtcbmxldCBuZXh0RXhwZWN0ZWRDaHVua0luZGV4ID0gMDsgLy8gVHJhY2sgdGhlIG5leHQgY2h1bmsgaW5kZXggd2Ugc2hvdWxkIHBsYXlcblxuLy8gSGVscGVyIGZ1bmN0aW9uIHRvIGNyZWF0ZSBBdWRpbyBmcm9tIGJhc2U2NCBkYXRhXG5mdW5jdGlvbiBjcmVhdGVBdWRpb0Zyb21CYXNlNjQoYmFzZTY0LCB7IHNwZWVkID0gMSB9ID0ge30pIHtcbiAgICB0cnkge1xuICAgICAgICAvLyBDb252ZXJ0IGJhc2U2NCBiYWNrIHRvIGJpbmFyeSBkYXRhXG4gICAgICAgIGNvbnN0IGF1ZGlvRGF0YSA9IGF0b2IoYmFzZTY0KTtcbiAgICAgICAgY29uc3QgYXJyYXlCdWZmZXIgPSBuZXcgQXJyYXlCdWZmZXIoYXVkaW9EYXRhLmxlbmd0aCk7XG4gICAgICAgIGNvbnN0IHVpbnQ4QXJyYXkgPSBuZXcgVWludDhBcnJheShhcnJheUJ1ZmZlcik7XG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYXVkaW9EYXRhLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICB1aW50OEFycmF5W2ldID0gYXVkaW9EYXRhLmNoYXJDb2RlQXQoaSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDcmVhdGUgYmxvYiBhbmQgb2JqZWN0IFVSTFxuICAgICAgICBjb25zdCBibG9iID0gbmV3IEJsb2IoW3VpbnQ4QXJyYXldLCB7IHR5cGU6ICdhdWRpby93YXYnIH0pO1xuICAgICAgICBjb25zdCBhdWRpb1VybCA9IFVSTC5jcmVhdGVPYmplY3RVUkwoYmxvYik7XG5cbiAgICAgICAgLy8gQ3JlYXRlIGFuZCBjb25maWd1cmUgYXVkaW8gZWxlbWVudFxuICAgICAgICBjb25zdCBhdWRpbyA9IG5ldyBBdWRpbyhhdWRpb1VybCk7XG4gICAgICAgIGF1ZGlvLnBsYXliYWNrUmF0ZSA9IHNwZWVkO1xuXG4gICAgICAgIHJldHVybiB7IGF1ZGlvLCBhdWRpb1VybCB9O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoJ1tWb3hMb2NhbF0gRXJyb3IgY3JlYXRpbmcgYXVkaW8gZnJvbSBiYXNlNjQ6JywgZXJyb3IpO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG59XG5cblxuLy8gTGlzdGVuIGZvciBtZXNzYWdlcyBmcm9tIGJhY2tncm91bmQgc2NyaXB0IC0gY29uc29saWRhdGVkIHNpbmdsZSBsaXN0ZW5lclxuY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKChtZXNzYWdlLCBzZW5kZXIsIHNlbmRSZXNwb25zZSkgPT4ge1xuICAgIC8vIEhhbmRsZSBtZXNzYWdlcyBiYXNlZCBvbiB0aGVpciBhY3Rpb25cbiAgICBpZiAobWVzc2FnZS5hY3Rpb24gfHwgbWVzc2FnZS50eXBlKSB7IC8vIFN1cHBvcnQgYm90aCBhY3Rpb24gYW5kIGxlZ2FjeSB0eXBlIGZvciBiYWNrd2FyZCBjb21wYXRpYmlsaXR5XG4gICAgICAgIGNvbnN0IGFjdGlvbiA9IG1lc3NhZ2UuYWN0aW9uIHx8IG1lc3NhZ2UudHlwZTtcbiAgICAgICAgY29uc29sZS5sb2coJ1tWb3hMb2NhbF0gUmVjZWl2ZWQgbWVzc2FnZTonLCBtZXNzYWdlKTtcblxuICAgICAgICBzd2l0Y2ggKGFjdGlvbikge1xuICAgICAgICAgICAgLy8gRGF0YSByZXRyaWV2YWwgKHN5bmNocm9ub3VzIHJlc3BvbnNlcylcbiAgICAgICAgICAgIGNhc2UgJ0dFVF9TRUxFQ1RJT04nOlxuICAgICAgICAgICAgICAgIHNlbmRSZXNwb25zZSh7IHRleHQ6IGdldFNlbGVjdGVkVGV4dCgpIH0pO1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuXG4gICAgICAgICAgICBjYXNlICdHRVRfUEFHRV9URVhUJzpcbiAgICAgICAgICAgICAgICBzZW5kUmVzcG9uc2UoeyB0ZXh0OiBnZXRQYWdlVGV4dCgpIH0pO1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuXG4gICAgICAgICAgICBjYXNlICdUT0dHTEVfUExBWUVSJzpcbiAgICAgICAgICAgICAgICB0b2dnbGVGbG9hdGluZ1BsYXllcigpO1xuICAgICAgICAgICAgICAgIHNlbmRSZXNwb25zZSh7IHN1Y2Nlc3M6IHRydWUgfSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG5cbiAgICAgICAgICAgIC8vIFVJIGFjdGlvbnMgKGZpcmUtYW5kLWZvcmdldClcbiAgICAgICAgICAgIGNhc2UgJ1NIT1dfUExBWUVSJzpcbiAgICAgICAgICAgICAgICBzaG93RmxvYXRpbmdQbGF5ZXIoKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnUExBWV9TRUxFQ1RJT04nOlxuICAgICAgICAgICAgICAgIHNob3dGbG9hdGluZ1BsYXllcigpO1xuICAgICAgICAgICAgICAgIC8vIFN0b3AgYW55IGN1cnJlbnQgcGxheWJhY2sgYmVmb3JlIHN0YXJ0aW5nIG5ldyBzZWxlY3Rpb25cbiAgICAgICAgICAgICAgICBpZiAoaXNTdHJlYW1pbmcgfHwgY3VycmVudEF1ZGlvKSB7XG4gICAgICAgICAgICAgICAgICAgIHN0b3BQbGF5YmFjaygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzcGVha0Zyb21QYWdlKCdzZWxlY3Rpb24nKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgLy8gU3RyZWFtaW5nIFRUUyBtZXNzYWdlcyAodXNlZCBmb3IgYm90aCBwYW5lbCBhbmQgY29udGV4dCBtZW51KVxuICAgICAgICAgICAgY2FzZSAnc3RyZWFtX2NodW5rJzpcbiAgICAgICAgICAgICAgICAvLyBJbW1lZGlhdGVseSBkaXNjYXJkIGNodW5rcyBpZiBub3Qgc3RyZWFtaW5nXG4gICAgICAgICAgICAgICAgaWYgKCFpc1N0cmVhbWluZykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy8gRGlzY2FyZCBjaHVua3MgdGhhdCBkb24ndCBtYXRjaCB0aGUgY3VycmVudCBzdHJlYW1pbmcgcmVxdWVzdFxuICAgICAgICAgICAgICAgIGlmIChtZXNzYWdlLnJlcXVlc3RJZCAhPT0gY3VycmVudFN0cmVhbWluZ1JlcXVlc3RJZCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFtWb3hMb2NhbF0g8J+TpiBQcm9jZXNzaW5nIHN0cmVhbWluZyBjaHVuayAke21lc3NhZ2UuY2h1bmtJbmRleCArIDF9LyR7bWVzc2FnZS50b3RhbENodW5rc31gKTtcbiAgICAgICAgICAgICAgICBzdHJlYW1DaHVua3NSZWNlaXZlZCA9IE1hdGgubWF4KHN0cmVhbUNodW5rc1JlY2VpdmVkLCBtZXNzYWdlLmNodW5rSW5kZXggKyAxKTtcbiAgICAgICAgICAgICAgICB0b3RhbFN0cmVhbUNodW5rcyA9IG1lc3NhZ2UudG90YWxDaHVua3M7XG5cbiAgICAgICAgICAgICAgICAvLyBTdG9yZSBjaHVuayBieSBpbmRleCBmb3IgcHJvcGVyIG9yZGVyaW5nXG4gICAgICAgICAgICAgICAgYXVkaW9DaHVua3NbbWVzc2FnZS5jaHVua0luZGV4XSA9IG1lc3NhZ2U7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFtWb3hMb2NhbF0g4p6VIFN0b3JlZCBjaHVuayAke21lc3NhZ2UuY2h1bmtJbmRleCArIDF9LiBUb3RhbCBjaHVua3Mgc3RvcmVkOiAke09iamVjdC5rZXlzKGF1ZGlvQ2h1bmtzKS5sZW5ndGh9LyR7dG90YWxTdHJlYW1DaHVua3N9YCk7XG5cbiAgICAgICAgICAgICAgICAvLyBVcGRhdGUgc3RhdHVzXG4gICAgICAgICAgICAgICAgdXBkYXRlU3RhdHVzKGBQcm9jZXNzaW5nIGNodW5rczogJHtzdHJlYW1DaHVua3NSZWNlaXZlZH0vJHt0b3RhbFN0cmVhbUNodW5rc30gcmVjZWl2ZWRgLCAnbG9hZGluZycpO1xuXG4gICAgICAgICAgICAgICAgLy8gU3RhcnQgb3IgcmVzdW1lIHBsYXliYWNrIHdoZW4gbm8gYXVkaW8gaXMgY3VycmVudGx5IHBsYXlpbmdcbiAgICAgICAgICAgICAgICBpZiAoIWN1cnJlbnRBdWRpbyAmJiBhdWRpb0NodW5rc1tuZXh0RXhwZWN0ZWRDaHVua0luZGV4XSkge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgW1ZveExvY2FsXSDilrbvuI8gJHtuZXh0RXhwZWN0ZWRDaHVua0luZGV4ID09PSAwID8gJ1N0YXJ0aW5nJyA6ICdSZXN1bWluZyd9IHBsYXliYWNrIC0gY2h1bmsgJHtuZXh0RXhwZWN0ZWRDaHVua0luZGV4ICsgMX0gYXZhaWxhYmxlYCk7XG4gICAgICAgICAgICAgICAgICAgIHBsYXlOZXh0QXVkaW9DaHVuaygpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdzdHJlYW1fY29tcGxldGUnOlxuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbVm94TG9jYWxdIFN0cmVhbWluZyBjb21wbGV0ZSAocmVxdWVzdElkOiAke21lc3NhZ2UucmVxdWVzdElkfSlgKTtcblxuICAgICAgICAgICAgICAgIC8vIE9ubHkgcHJvY2VzcyBjb21wbGV0aW9uIGlmIGl0IG1hdGNoZXMgdGhlIGN1cnJlbnQgc3RyZWFtaW5nIHJlcXVlc3RcbiAgICAgICAgICAgICAgICBpZiAobWVzc2FnZS5yZXF1ZXN0SWQgPT09IGN1cnJlbnRTdHJlYW1pbmdSZXF1ZXN0SWQpIHtcbiAgICAgICAgICAgICAgICAgICAgaXNTdHJlYW1pbmcgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICAgICAgY3VycmVudFN0cmVhbWluZ1JlcXVlc3RJZCA9IG51bGw7XG5cbiAgICAgICAgICAgICAgICAgICAgLy8gSWYgbm8gY2h1bmtzIGFyZSBjdXJyZW50bHkgcGxheWluZywgdXBkYXRlIHN0YXR1c1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWN1cnJlbnRBdWRpbykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdXBkYXRlU3RhdHVzKCdSZWFkeScsICdyZWFkeScpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdXBkYXRlQnV0dG9uU3RhdGVzKCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgW1ZveExvY2FsXSDwn5qrIElnbm9yaW5nIHN0cmVhbV9jb21wbGV0ZSAtIHdyb25nIHJlcXVlc3QgSUQgKGV4cGVjdGVkOiAke2N1cnJlbnRTdHJlYW1pbmdSZXF1ZXN0SWR9LCBnb3Q6ICR7bWVzc2FnZS5yZXF1ZXN0SWR9KWApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdzdHJlYW1fZXJyb3InOlxuICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtWb3hMb2NhbF0gU3RyZWFtaW5nIGVycm9yIChyZXF1ZXN0SWQ6ICR7bWVzc2FnZS5yZXF1ZXN0SWR9KTpgLCBtZXNzYWdlLmVycm9yKTtcblxuICAgICAgICAgICAgICAgIC8vIE9ubHkgcHJvY2VzcyBlcnJvciBpZiBpdCBtYXRjaGVzIHRoZSBjdXJyZW50IHN0cmVhbWluZyByZXF1ZXN0XG4gICAgICAgICAgICAgICAgaWYgKG1lc3NhZ2UucmVxdWVzdElkID09PSBjdXJyZW50U3RyZWFtaW5nUmVxdWVzdElkKSB7XG4gICAgICAgICAgICAgICAgICAgIHVwZGF0ZVN0YXR1cygnU3RyZWFtaW5nIGVycm9yOiAnICsgbWVzc2FnZS5lcnJvciwgJ2Vycm9yJyk7XG4gICAgICAgICAgICAgICAgICAgIHJlc2V0U3RyZWFtaW5nU3RhdGUoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgW1ZveExvY2FsXSDwn5qrIElnbm9yaW5nIHN0cmVhbV9lcnJvciAtIHdyb25nIHJlcXVlc3QgSUQgKGV4cGVjdGVkOiAke2N1cnJlbnRTdHJlYW1pbmdSZXF1ZXN0SWR9LCBnb3Q6ICR7bWVzc2FnZS5yZXF1ZXN0SWR9KWApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZygnW1ZveExvY2FsXSBVbmtub3duIGFjdGlvbjonLCBtZXNzYWdlLmFjdGlvbik7XG4gICAgICAgIH1cbiAgICAgICAgLy8gQWN0aW9uIG1lc3NhZ2VzIGFyZSBoYW5kbGVkIGFzeW5jaHJvbm91c2x5IGJ1dCBkb24ndCBuZWVkIGEgcmVzcG9uc2VcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIC8vIElmIHdlIGdldCBoZXJlLCBpdCdzIGFuIHVua25vd24gbWVzc2FnZSBmb3JtYXRcbiAgICBjb25zb2xlLmxvZygnW1ZveExvY2FsXSBSZWNlaXZlZCB1bmtub3duIG1lc3NhZ2UgZm9ybWF0OicsIG1lc3NhZ2UpO1xuICAgIHJldHVybiB0cnVlO1xufSk7XG5cblxuXG5cbi8vIFRvZ2dsZSBmbG9hdGluZyBwbGF5ZXIgdmlzaWJpbGl0eVxuZnVuY3Rpb24gdG9nZ2xlRmxvYXRpbmdQbGF5ZXIoKSB7XG4gICAgaWYgKGlzUGxheWVyVmlzaWJsZSkge1xuICAgICAgICBoaWRlRmxvYXRpbmdQbGF5ZXIoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBzaG93RmxvYXRpbmdQbGF5ZXIoKTtcbiAgICB9XG59XG5cbi8vIFNob3cgZmxvYXRpbmcgcGxheWVyXG5mdW5jdGlvbiBzaG93RmxvYXRpbmdQbGF5ZXIoKSB7XG4gICAgaWYgKGZsb2F0aW5nUGxheWVyKSB7XG4gICAgICAgIGZsb2F0aW5nUGxheWVyLnN0eWxlLmRpc3BsYXkgPSAnYmxvY2snO1xuICAgICAgICBpc1BsYXllclZpc2libGUgPSB0cnVlO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY3JlYXRlRmxvYXRpbmdQbGF5ZXIoKTtcbiAgICBpc1BsYXllclZpc2libGUgPSB0cnVlO1xufVxuXG4vLyBIaWRlIGZsb2F0aW5nIHBsYXllclxuZnVuY3Rpb24gaGlkZUZsb2F0aW5nUGxheWVyKCkge1xuICAgIGlmIChmbG9hdGluZ1BsYXllcikge1xuICAgICAgICBmbG9hdGluZ1BsYXllci5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnO1xuICAgICAgICBpc1BsYXllclZpc2libGUgPSBmYWxzZTtcbiAgICB9XG59XG5cbi8vIENyZWF0ZSB0aGUgZmxvYXRpbmcgcGxheWVyIFVJXG5mdW5jdGlvbiBjcmVhdGVGbG9hdGluZ1BsYXllcigpIHtcbiAgICAvLyBDcmVhdGUgdGhlIG1haW4gY29udGFpbmVyXG4gICAgZmxvYXRpbmdQbGF5ZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBmbG9hdGluZ1BsYXllci5pZCA9ICd2b3hsb2NhbC1mbG9hdGluZy1wbGF5ZXInO1xuICAgIGZsb2F0aW5nUGxheWVyLmlubmVySFRNTCA9IGBcbiAgICAgICAgPGRpdiBjbGFzcz1cInZveGxvY2FsLWhlYWRlclwiPlxuICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJ2b3hsb2NhbC10aXRsZVwiPvCfjpnvuI8gVm94TG9jYWw8L3NwYW4+XG4gICAgICAgICAgICA8YnV0dG9uIGNsYXNzPVwidm94bG9jYWwtY2xvc2UtYnRuXCIgdGl0bGU9XCJDbG9zZVwiPiZ0aW1lczs8L2J1dHRvbj5cbiAgICAgICAgPC9kaXY+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJ2b3hsb2NhbC1zdGF0dXMtc2VjdGlvblwiPlxuICAgICAgICAgICAgPGRpdiBpZD1cInZveGxvY2FsLXN0YXR1c1wiIGNsYXNzPVwic3RhdHVzLWJhZGdlIHJlYWR5XCI+UmVhZHk8L2Rpdj5cbiAgICAgICAgPC9kaXY+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJ2b3hsb2NhbC1jb250cm9sc1wiPlxuICAgICAgICAgICAgPGJ1dHRvbiBpZD1cInZveGxvY2FsLXBsYXktc3RvcC1idG5cIiBjbGFzcz1cInZveGxvY2FsLWJ0biB2b3hsb2NhbC1idG4tcHJpbWFyeVwiIHRpdGxlPVwiUGxheSBzZWxlY3Rpb24gb3IgcGFnZVwiPlxuICAgICAgICAgICAgICAgIDxpbWcgc3JjPVwiXCIgY2xhc3M9XCJpY29uXCIgYWx0PVwiUGxheVwiPiBQbGF5XG4gICAgICAgICAgICA8L2J1dHRvbj5cbiAgICAgICAgPC9kaXY+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJ2b3hsb2NhbC1zZXR0aW5nc1wiPlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInZveGxvY2FsLXNldHRpbmctaXRlbVwiPlxuICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJ2b3hsb2NhbC1zZXR0aW5nLWRpc3BsYXlcIiBpZD1cInZveGxvY2FsLXZvaWNlLWRpc3BsYXlcIj5cbiAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNldHRpbmctdmFsdWVcIj5IZWFydDwvZGl2PlxuICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2V0dGluZy1sYWJlbFwiPnZvaWNlPC9kaXY+XG4gICAgICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICAgICAgPHNlbGVjdCBpZD1cInZveGxvY2FsLXZvaWNlLXNlbGVjdFwiIGNsYXNzPVwidm94bG9jYWwtc2V0dGluZy1jb250cm9sIGhpZGRlblwiPlxuICAgICAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiYWZfaGVhcnRcIj5IZWFydCAoRmVtYWxlKTwvb3B0aW9uPlxuICAgICAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiYWZfYmVsbGFcIj5CZWxsYSAoRmVtYWxlKTwvb3B0aW9uPlxuICAgICAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiYW1fbWljaGFlbFwiPk1pY2hhZWwgKE1hbGUpPC9vcHRpb24+XG4gICAgICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCJhbV9mZW5yaXJcIj5GZW5yaXIgKE1hbGUpPC9vcHRpb24+XG4gICAgICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCJiZl9lbW1hXCI+RW1tYSAoQnJpdGlzaCBGZW1hbGUpPC9vcHRpb24+XG4gICAgICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCJibV9nZW9yZ2VcIj5HZW9yZ2UgKEJyaXRpc2ggTWFsZSk8L29wdGlvbj5cbiAgICAgICAgICAgICAgICA8L3NlbGVjdD5cbiAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInZveGxvY2FsLXNldHRpbmctaXRlbVwiPlxuICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJ2b3hsb2NhbC1zZXR0aW5nLWRpc3BsYXlcIiBpZD1cInZveGxvY2FsLXNwZWVkLWRpc3BsYXlcIj5cbiAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNldHRpbmctdmFsdWVcIj4xLjB4PC9kaXY+XG4gICAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzZXR0aW5nLWxhYmVsXCI+c3BlZWQ8L2Rpdj5cbiAgICAgICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgICAgICA8aW5wdXQgdHlwZT1cInJhbmdlXCIgaWQ9XCJ2b3hsb2NhbC1zcGVlZC1zbGlkZXJcIiBjbGFzcz1cInZveGxvY2FsLXNldHRpbmctY29udHJvbCBoaWRkZW5cIiBtaW49XCIwLjc1XCIgbWF4PVwiMS4yNVwiIHN0ZXA9XCIwLjA1XCIgdmFsdWU9XCIxLjBcIj5cbiAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICA8L2Rpdj5cbiAgICBgO1xuXG4gICAgLy8gSW5qZWN0IENTU1xuICAgIGluamVjdFBsYXllclN0eWxlcygpO1xuXG4gICAgLy8gQWRkIHRvIHBhZ2VcbiAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGZsb2F0aW5nUGxheWVyKTtcblxuICAgIC8vIFNldCB1cCBldmVudCBsaXN0ZW5lcnNcbiAgICBzZXR1cEV2ZW50TGlzdGVuZXJzKCk7XG5cbiAgICAvLyBMb2FkIHNldHRpbmdzIGFuZCBpbml0aWFsaXplXG4gICAgbG9hZFNldHRpbmdzKCk7XG4gICAgdXBkYXRlU3RhdHVzKCdSZWFkeScpO1xuICAgIHVwZGF0ZUJ1dHRvblRleHQoKTsgLy8gU2V0IGluaXRpYWwgYnV0dG9uIHRleHQgYmFzZWQgb24gY3VycmVudCBzZWxlY3Rpb25cbiAgICBxdWVyeU1vZGVsU3RhdHVzKCk7XG59XG5cbi8vIEluamVjdCBDU1Mgc3R5bGVzIGZvciB0aGUgZmxvYXRpbmcgcGxheWVyXG5mdW5jdGlvbiBpbmplY3RQbGF5ZXJTdHlsZXMoKSB7XG4gICAgY29uc3Qgc3R5bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzdHlsZScpO1xuICAgIHN0eWxlLnRleHRDb250ZW50ID0gYFxuICAgICAgICAjdm94bG9jYWwtZmxvYXRpbmctcGxheWVyIHtcbiAgICAgICAgICAgIHBvc2l0aW9uOiBmaXhlZDtcbiAgICAgICAgICAgIHRvcDogMjBweDtcbiAgICAgICAgICAgIGxlZnQ6IGF1dG87XG4gICAgICAgICAgICByaWdodDogMjBweDtcbiAgICAgICAgICAgIHdpZHRoOiAyNDBweDtcbiAgICAgICAgICAgIGJhY2tncm91bmQ6IHdoaXRlO1xuICAgICAgICAgICAgYm9yZGVyOiAxcHggc29saWQgI2RlZTJlNjtcbiAgICAgICAgICAgIGJvcmRlci1yYWRpdXM6IDhweDtcbiAgICAgICAgICAgIGJveC1zaGFkb3c6IDAgNHB4IDEycHggcmdiYSgwLCAwLCAwLCAwLjE1KTtcbiAgICAgICAgICAgIHotaW5kZXg6IDEwMDAwO1xuICAgICAgICAgICAgZm9udC1mYW1pbHk6IC1hcHBsZS1zeXN0ZW0sIEJsaW5rTWFjU3lzdGVtRm9udCwgJ1NlZ29lIFVJJywgUm9ib3RvLCBzYW5zLXNlcmlmO1xuICAgICAgICAgICAgZm9udC1zaXplOiAxNHB4O1xuICAgICAgICAgICAgbGluZS1oZWlnaHQ6IDEuNDtcbiAgICAgICAgICAgIGNvbG9yOiAjMjEyNTI5O1xuICAgICAgICB9XG5cbiAgICAgICAgLnZveGxvY2FsLWhlYWRlciB7XG4gICAgICAgICAgICBkaXNwbGF5OiBmbGV4O1xuICAgICAgICAgICAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuO1xuICAgICAgICAgICAgYWxpZ24taXRlbXM6IGNlbnRlcjtcbiAgICAgICAgICAgIHBhZGRpbmc6IDEycHggMTJweCA4cHggMTJweDtcbiAgICAgICAgICAgIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCAjZGVlMmU2O1xuICAgICAgICB9XG5cbiAgICAgICAgLnZveGxvY2FsLWhlYWRlciAudm94bG9jYWwtdGl0bGUge1xuICAgICAgICAgICAgbWFyZ2luOiAwO1xuICAgICAgICAgICAgZm9udC1zaXplOiAxNnB4O1xuICAgICAgICAgICAgZm9udC13ZWlnaHQ6IDYwMDtcbiAgICAgICAgfVxuXG4gICAgICAgIC52b3hsb2NhbC1jbG9zZS1idG4ge1xuICAgICAgICAgICAgYmFja2dyb3VuZDogbm9uZTtcbiAgICAgICAgICAgIGJvcmRlcjogbm9uZTtcbiAgICAgICAgICAgIGZvbnQtc2l6ZTogMjRweDtcbiAgICAgICAgICAgIGN1cnNvcjogcG9pbnRlcjtcbiAgICAgICAgICAgIGNvbG9yOiAjNmM3NTdkO1xuICAgICAgICAgICAgcGFkZGluZzogMDtcbiAgICAgICAgICAgIHdpZHRoOiAyNHB4O1xuICAgICAgICAgICAgaGVpZ2h0OiAyNHB4O1xuICAgICAgICAgICAgZGlzcGxheTogZmxleDtcbiAgICAgICAgICAgIGFsaWduLWl0ZW1zOiBjZW50ZXI7XG4gICAgICAgICAgICBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjtcbiAgICAgICAgfVxuXG4gICAgICAgIC52b3hsb2NhbC1jbG9zZS1idG46aG92ZXIge1xuICAgICAgICAgICAgY29sb3I6ICNkYzM1NDU7XG4gICAgICAgIH1cblxuICAgICAgICAudm94bG9jYWwtc3RhdHVzLXNlY3Rpb24ge1xuICAgICAgICAgICAgZGlzcGxheTogZmxleDtcbiAgICAgICAgICAgIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47XG4gICAgICAgICAgICBnYXA6IDZweDtcbiAgICAgICAgICAgIG1hcmdpbjogMTJweDtcbiAgICAgICAgfVxuXG4gICAgICAgIC5zdGF0dXMtYmFkZ2Uge1xuICAgICAgICAgICAgcGFkZGluZzogNHB4IDEwcHg7XG4gICAgICAgICAgICBib3JkZXItcmFkaXVzOiA0cHg7XG4gICAgICAgICAgICBmb250LXNpemU6IDEycHg7XG4gICAgICAgICAgICBmb250LXdlaWdodDogNTAwO1xuICAgICAgICAgICAgdGV4dC1hbGlnbjogY2VudGVyO1xuICAgICAgICB9XG5cbiAgICAgICAgLnN0YXR1cy1iYWRnZS5yZWFkeSB7IGJhY2tncm91bmQtY29sb3I6ICMyOGE3NDU7IGNvbG9yOiB3aGl0ZTsgfVxuICAgICAgICAuc3RhdHVzLWJhZGdlLmxvYWRpbmcgeyBiYWNrZ3JvdW5kLWNvbG9yOiAjZmZjMTA3OyBjb2xvcjogYmxhY2s7IH1cbiAgICAgICAgLnN0YXR1cy1iYWRnZS5zcGVha2luZyB7IGJhY2tncm91bmQtY29sb3I6ICMwMDdiZmY7IGNvbG9yOiB3aGl0ZTsgfVxuICAgICAgICAuc3RhdHVzLWJhZGdlLmVycm9yIHsgYmFja2dyb3VuZC1jb2xvcjogI2RjMzU0NTsgY29sb3I6IHdoaXRlOyB9XG5cbiAgICAgICAgLnZveGxvY2FsLWNvbnRyb2xzIHtcbiAgICAgICAgICAgIGRpc3BsYXk6IGZsZXg7XG4gICAgICAgICAgICBmbGV4LWRpcmVjdGlvbjogY29sdW1uO1xuICAgICAgICAgICAgZ2FwOiA2cHg7XG4gICAgICAgICAgICBtYXJnaW46IDAgMTJweCAxNnB4IDEycHg7XG4gICAgICAgIH1cblxuICAgICAgICAudm94bG9jYWwtYnRuIHtcbiAgICAgICAgICAgIHBhZGRpbmc6IDRweCAxMnB4O1xuICAgICAgICAgICAgYm9yZGVyOiBub25lO1xuICAgICAgICAgICAgYm9yZGVyLXJhZGl1czogNnB4O1xuICAgICAgICAgICAgZm9udC1zaXplOiAxNHB4O1xuICAgICAgICAgICAgZm9udC13ZWlnaHQ6IDUwMDtcbiAgICAgICAgICAgIGN1cnNvcjogcG9pbnRlcjtcbiAgICAgICAgICAgIHRyYW5zaXRpb246IGFsbCAwLjJzIGVhc2U7XG4gICAgICAgICAgICBkaXNwbGF5OiBmbGV4O1xuICAgICAgICAgICAgYWxpZ24taXRlbXM6IGNlbnRlcjtcbiAgICAgICAgICAgIGp1c3RpZnktY29udGVudDogY2VudGVyO1xuICAgICAgICAgICAgZ2FwOiA2cHg7XG4gICAgICAgICAgICBmb250LWZhbWlseTogLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCAnU2Vnb2UgVUknLCBSb2JvdG8sIHNhbnMtc2VyaWY7XG4gICAgICAgIH1cblxuICAgICAgICAudm94bG9jYWwtYnRuOmRpc2FibGVkIHsgb3BhY2l0eTogMC42OyBjdXJzb3I6IG5vdC1hbGxvd2VkOyB9XG4gICAgICAgIC52b3hsb2NhbC1idG4tcHJpbWFyeSB7IGJhY2tncm91bmQtY29sb3I6ICMwMDdiZmY7IGNvbG9yOiB3aGl0ZTsgfVxuICAgICAgICAudm94bG9jYWwtYnRuLXByaW1hcnk6aG92ZXI6bm90KDpkaXNhYmxlZCkgeyBiYWNrZ3JvdW5kLWNvbG9yOiAjMDA1NmIzOyB9XG4gICAgICAgIC52b3hsb2NhbC1idG4tZGFuZ2VyIHsgYmFja2dyb3VuZC1jb2xvcjogI2RjMzU0NTsgY29sb3I6IHdoaXRlOyB9XG4gICAgICAgIC52b3hsb2NhbC1idG4tZGFuZ2VyOmhvdmVyOm5vdCg6ZGlzYWJsZWQpIHsgYmFja2dyb3VuZC1jb2xvcjogI2M4MjMzMzsgfVxuXG4gICAgICAgIC5pY29uIHtcbiAgICAgICAgICAgIGZvbnQtc2l6ZTogNDhweDtcbiAgICAgICAgICAgIHdpZHRoOiA0OHB4O1xuICAgICAgICAgICAgaGVpZ2h0OiA0OHB4O1xuICAgICAgICAgICAgdmVydGljYWwtYWxpZ246IG1pZGRsZTtcbiAgICAgICAgICAgIG1hcmdpbi1yaWdodDogNHB4O1xuICAgICAgICB9XG5cbiAgICAgICAgLmljb24gaW1nIHtcbiAgICAgICAgICAgIHdpZHRoOiAxMDAlO1xuICAgICAgICAgICAgaGVpZ2h0OiAxMDAlO1xuICAgICAgICAgICAgb2JqZWN0LWZpdDogY29udGFpbjtcbiAgICAgICAgfVxuXG4gICAgICAgIC52b3hsb2NhbC1pbnB1dC1zZWN0aW9uIHsgbWFyZ2luOiAwIDE2cHggMjBweCAxNnB4OyB9XG5cbiAgICAgICAgI3ZveGxvY2FsLXRleHQge1xuICAgICAgICAgICAgd2lkdGg6IDEwMCU7XG4gICAgICAgICAgICBwYWRkaW5nOiA4cHggMTJweDtcbiAgICAgICAgICAgIGJvcmRlcjogMXB4IHNvbGlkICNkZWUyZTY7XG4gICAgICAgICAgICBib3JkZXItcmFkaXVzOiA0cHg7XG4gICAgICAgICAgICBmb250LXNpemU6IDEzcHg7XG4gICAgICAgICAgICBsaW5lLWhlaWdodDogMS40O1xuICAgICAgICAgICAgcmVzaXplOiB2ZXJ0aWNhbDtcbiAgICAgICAgICAgIG1pbi1oZWlnaHQ6IDYwcHg7XG4gICAgICAgICAgICBiYWNrZ3JvdW5kOiB3aGl0ZTtcbiAgICAgICAgICAgIGJveC1zaXppbmc6IGJvcmRlci1ib3g7XG4gICAgICAgIH1cblxuICAgICAgICAudm94bG9jYWwtc2V0dGluZ3Mge1xuICAgICAgICAgICAgbWFyZ2luOiAwIDEycHggMTJweCAxMnB4O1xuICAgICAgICAgICAgcGFkZGluZy10b3A6IDEycHg7XG4gICAgICAgICAgICBib3JkZXItdG9wOiAxcHggc29saWQgI2RlZTJlNjtcbiAgICAgICAgICAgIGRpc3BsYXk6IGZsZXg7XG4gICAgICAgICAgICBnYXA6IDE2cHg7XG4gICAgICAgIH1cblxuICAgICAgICAudm94bG9jYWwtc2V0dGluZy1pdGVtIHtcbiAgICAgICAgICAgIGZsZXg6IDE7XG4gICAgICAgICAgICBkaXNwbGF5OiBmbGV4O1xuICAgICAgICAgICAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjtcbiAgICAgICAgICAgIGFsaWduLWl0ZW1zOiBjZW50ZXI7XG4gICAgICAgICAgICBwb3NpdGlvbjogcmVsYXRpdmU7XG4gICAgICAgIH1cblxuICAgICAgICAudm94bG9jYWwtc2V0dGluZy1kaXNwbGF5IHtcbiAgICAgICAgICAgIGRpc3BsYXk6IGZsZXg7XG4gICAgICAgICAgICBmbGV4LWRpcmVjdGlvbjogY29sdW1uO1xuICAgICAgICAgICAgYWxpZ24taXRlbXM6IGNlbnRlcjtcbiAgICAgICAgICAgIGN1cnNvcjogcG9pbnRlcjtcbiAgICAgICAgICAgIHBhZGRpbmc6IDhweDtcbiAgICAgICAgICAgIGJvcmRlci1yYWRpdXM6IDZweDtcbiAgICAgICAgICAgIHRyYW5zaXRpb246IGJhY2tncm91bmQtY29sb3IgMC4ycyBlYXNlO1xuICAgICAgICAgICAgbWluLWhlaWdodDogNTBweDtcbiAgICAgICAgICAgIGp1c3RpZnktY29udGVudDogY2VudGVyO1xuICAgICAgICB9XG5cbiAgICAgICAgLnZveGxvY2FsLXNldHRpbmctZGlzcGxheTpob3ZlciB7XG4gICAgICAgICAgICBiYWNrZ3JvdW5kLWNvbG9yOiAjZjhmOWZhO1xuICAgICAgICB9XG5cbiAgICAgICAgLnNldHRpbmctdmFsdWUge1xuICAgICAgICAgICAgZm9udC1zaXplOiAxNnB4O1xuICAgICAgICAgICAgZm9udC13ZWlnaHQ6IDYwMDtcbiAgICAgICAgICAgIGNvbG9yOiAjMjEyNTI5O1xuICAgICAgICAgICAgdGV4dC1hbGlnbjogY2VudGVyO1xuICAgICAgICB9XG5cbiAgICAgICAgLnNldHRpbmctbGFiZWwge1xuICAgICAgICAgICAgZm9udC1zaXplOiAxMXB4O1xuICAgICAgICAgICAgY29sb3I6ICM2Yzc1N2Q7XG4gICAgICAgICAgICB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlO1xuICAgICAgICAgICAgbGV0dGVyLXNwYWNpbmc6IDAuNXB4O1xuICAgICAgICAgICAgbWFyZ2luLXRvcDogMnB4O1xuICAgICAgICAgICAgdGV4dC1hbGlnbjogY2VudGVyO1xuICAgICAgICB9XG5cbiAgICAgICAgLnZveGxvY2FsLXNldHRpbmctY29udHJvbCB7XG4gICAgICAgICAgICBwb3NpdGlvbjogYWJzb2x1dGU7XG4gICAgICAgICAgICB0b3A6IDEwMCU7XG4gICAgICAgICAgICBsZWZ0OiA1MCU7XG4gICAgICAgICAgICB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoLTUwJSk7XG4gICAgICAgICAgICB3aWR0aDogMTQwcHg7XG4gICAgICAgICAgICBwYWRkaW5nOiAxMnB4O1xuICAgICAgICAgICAgYm9yZGVyOiAxcHggc29saWQgI2RlZTJlNjtcbiAgICAgICAgICAgIGJvcmRlci1yYWRpdXM6IDZweDtcbiAgICAgICAgICAgIGZvbnQtc2l6ZTogMTNweDtcbiAgICAgICAgICAgIGJhY2tncm91bmQ6IHdoaXRlO1xuICAgICAgICAgICAgYm94LXNoYWRvdzogMCA0cHggMTJweCByZ2JhKDAsIDAsIDAsIDAuMTUpO1xuICAgICAgICAgICAgei1pbmRleDogMTAwMDE7XG4gICAgICAgICAgICBib3gtc2l6aW5nOiBib3JkZXItYm94O1xuICAgICAgICAgICAgbWFyZ2luLXRvcDogNHB4O1xuICAgICAgICB9XG5cbiAgICAgICAgLnZveGxvY2FsLXNldHRpbmctY29udHJvbC5oaWRkZW4ge1xuICAgICAgICAgICAgZGlzcGxheTogbm9uZTtcbiAgICAgICAgfVxuXG4gICAgICAgIC5zZXR0aW5nLW5vdGUge1xuICAgICAgICAgICAgZGlzcGxheTogYmxvY2s7XG4gICAgICAgICAgICBtYXJnaW4tdG9wOiAycHg7XG4gICAgICAgICAgICBmb250LXNpemU6IDExcHg7XG4gICAgICAgICAgICBjb2xvcjogIzZjNzU3ZDtcbiAgICAgICAgICAgIGZvbnQtc3R5bGU6IGl0YWxpYztcbiAgICAgICAgfVxuICAgIGA7XG4gICAgZG9jdW1lbnQuaGVhZC5hcHBlbmRDaGlsZChzdHlsZSk7XG59XG5cbi8vIFNldCB1cCBldmVudCBsaXN0ZW5lcnMgZm9yIHRoZSBmbG9hdGluZyBwbGF5ZXJcbmZ1bmN0aW9uIHNldHVwRXZlbnRMaXN0ZW5lcnMoKSB7XG4gICAgLy8gQ2xvc2UgYnV0dG9uXG4gICAgZmxvYXRpbmdQbGF5ZXIucXVlcnlTZWxlY3RvcignLnZveGxvY2FsLWNsb3NlLWJ0bicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgaGlkZUZsb2F0aW5nUGxheWVyKTtcblxuICAgIC8vIERyYWcgZnVuY3Rpb25hbGl0eSBmb3IgdGhlIGhlYWRlclxuICAgIGNvbnN0IGhlYWRlciA9IGZsb2F0aW5nUGxheWVyLnF1ZXJ5U2VsZWN0b3IoJy52b3hsb2NhbC1oZWFkZXInKTtcbiAgICBoZWFkZXIuc3R5bGUuY3Vyc29yID0gJ21vdmUnO1xuXG4gICAgaGVhZGVyLmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJkb3duJywgc3RhcnREcmFnKTtcbiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVybW92ZScsIGRyYWcpO1xuICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJ1cCcsIGVuZERyYWcpO1xuXG4gICAgLy8gVm9pY2UgZGlzcGxheSBjbGljayAtIHRvZ2dsZSBkcm9wZG93blxuICAgIGNvbnN0IHZvaWNlRGlzcGxheSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd2b3hsb2NhbC12b2ljZS1kaXNwbGF5Jyk7XG4gICAgY29uc3Qgdm9pY2VTZWxlY3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndm94bG9jYWwtdm9pY2Utc2VsZWN0Jyk7XG4gICAgdm9pY2VEaXNwbGF5LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKGV2ZW50KSA9PiB7XG4gICAgICAgIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgICB0b2dnbGVTZXR0aW5nQ29udHJvbCh2b2ljZVNlbGVjdCk7XG4gICAgfSk7XG5cbiAgICAvLyBTcGVlZCBkaXNwbGF5IGNsaWNrIC0gdG9nZ2xlIHNsaWRlclxuICAgIGNvbnN0IHNwZWVkRGlzcGxheSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd2b3hsb2NhbC1zcGVlZC1kaXNwbGF5Jyk7XG4gICAgY29uc3Qgc3BlZWRTbGlkZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndm94bG9jYWwtc3BlZWQtc2xpZGVyJyk7XG4gICAgc3BlZWREaXNwbGF5LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKGV2ZW50KSA9PiB7XG4gICAgICAgIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgICB0b2dnbGVTZXR0aW5nQ29udHJvbChzcGVlZFNsaWRlcik7XG4gICAgfSk7XG5cbiAgICAvLyBTcGVlZCBzbGlkZXIgaW5wdXQgLSB1cGRhdGUgZGlzcGxheVxuICAgIHNwZWVkU2xpZGVyLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JywgKGV2ZW50KSA9PiB7XG4gICAgICAgIHVwZGF0ZVNwZWVkRGlzcGxheShldmVudC50YXJnZXQudmFsdWUpO1xuICAgIH0pO1xuXG4gICAgLy8gU3BlZWQgc2xpZGVyIHBvaW50ZXJ1cCAtIGhpZGUgc2xpZGVyIGFmdGVyIGludGVyYWN0aW9uICh3b3JrcyBmb3IgbW91c2UgYW5kIHRvdWNoKVxuICAgIHNwZWVkU2xpZGVyLmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJ1cCcsICgpID0+IHtcbiAgICAgICAgaGlkZUFsbFNldHRpbmdDb250cm9scygpO1xuICAgIH0pO1xuXG4gICAgLy8gQ2xpY2sgb24gZmxvYXRpbmcgcGxheWVyIHRvIGNsb3NlIGNvbnRyb2xzIHdoZW4gY2xpY2tpbmcgb3V0c2lkZSBzZXR0aW5nIGRpc3BsYXlzXG4gICAgZmxvYXRpbmdQbGF5ZXIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoZXZlbnQpID0+IHtcbiAgICAgICAgLy8gT25seSBoaWRlIGNvbnRyb2xzIGlmIGNsaWNraW5nIG9uIHRoZSBwbGF5ZXIgaXRzZWxmIG9yIGl0cyBkaXJlY3QgY2hpbGRyZW4sXG4gICAgICAgIC8vIG5vdCBvbiB0aGUgc2V0dGluZyBkaXNwbGF5cyAod2hpY2ggaGF2ZSB0aGVpciBvd24gY2xpY2sgaGFuZGxlcnMpXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGV2ZW50LnRhcmdldDtcbiAgICAgICAgaWYgKCF0YXJnZXQuY2xvc2VzdCgnLnZveGxvY2FsLXNldHRpbmctZGlzcGxheScpKSB7XG4gICAgICAgICAgICBoaWRlQWxsU2V0dGluZ0NvbnRyb2xzKCk7XG4gICAgICAgIH1cbiAgICB9KTtcblxuICAgIC8vIFByZXZlbnQgY2xpY2tzIGluc2lkZSBjb250cm9scyBmcm9tIGNsb3NpbmcgdGhlbVxuICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy52b3hsb2NhbC1zZXR0aW5nLWNvbnRyb2wnKS5mb3JFYWNoKGNvbnRyb2wgPT4ge1xuICAgICAgICBjb250cm9sLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgZXZlbnQgPT4gZXZlbnQuc3RvcFByb3BhZ2F0aW9uKCkpO1xuICAgIH0pO1xuXG4gICAgLy8gUGxheS9TdG9wIGJ1dHRvblxuICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd2b3hsb2NhbC1wbGF5LXN0b3AtYnRuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCB0b2dnbGVQbGF5U3RvcCk7XG5cbiAgICAvLyBTZXR0aW5ncyBjaGFuZ2UgbGlzdGVuZXJzXG4gICAgdm9pY2VTZWxlY3QuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgKCkgPT4ge1xuICAgICAgICB1cGRhdGVWb2ljZURpc3BsYXkoKTtcbiAgICAgICAgc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgIGhpZGVBbGxTZXR0aW5nQ29udHJvbHMoKTtcbiAgICB9KTtcbiAgICBzcGVlZFNsaWRlci5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLCBzYXZlU2V0dGluZ3MpO1xuXG4gICAgLy8gTGlzdGVuIGZvciB0ZXh0IHNlbGVjdGlvbiBjaGFuZ2VzIHRvIHVwZGF0ZSBidXR0b24gdGV4dFxuICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ3NlbGVjdGlvbmNoYW5nZScsIHVwZGF0ZUJ1dHRvblRleHQpO1xufVxuXG4vLyBEcmFnIGZ1bmN0aW9uYWxpdHlcbmZ1bmN0aW9uIHN0YXJ0RHJhZyhldmVudCkge1xuICAgIGlmIChldmVudC50YXJnZXQuY2xvc2VzdCgnLnZveGxvY2FsLWNsb3NlLWJ0bicpKSByZXR1cm47IC8vIERvbid0IGRyYWcgaWYgY2xpY2tpbmcgY2xvc2UgYnV0dG9uXG5cbiAgICBpc0RyYWdnaW5nID0gdHJ1ZTtcbiAgICBkcmFnU3RhcnRYID0gZXZlbnQuY2xpZW50WDtcbiAgICBkcmFnU3RhcnRZID0gZXZlbnQuY2xpZW50WTtcblxuICAgIGNvbnN0IHJlY3QgPSBmbG9hdGluZ1BsYXllci5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICBwbGF5ZXJTdGFydFggPSByZWN0LmxlZnQ7XG4gICAgcGxheWVyU3RhcnRZID0gcmVjdC50b3A7XG5cbiAgICAvLyBQcmV2ZW50IHRleHQgc2VsZWN0aW9uIGR1cmluZyBkcmFnXG4gICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgICBkb2N1bWVudC5ib2R5LnN0eWxlLnVzZXJTZWxlY3QgPSAnbm9uZSc7XG59XG5cbmZ1bmN0aW9uIGRyYWcoZXZlbnQpIHtcbiAgICBpZiAoIWlzRHJhZ2dpbmcpIHJldHVybjtcblxuICAgIGNvbnN0IGRlbHRhWCA9IGV2ZW50LmNsaWVudFggLSBkcmFnU3RhcnRYO1xuICAgIGNvbnN0IGRlbHRhWSA9IGV2ZW50LmNsaWVudFkgLSBkcmFnU3RhcnRZO1xuXG4gICAgY29uc3QgbmV3WCA9IHBsYXllclN0YXJ0WCArIGRlbHRhWDtcbiAgICBjb25zdCBuZXdZID0gcGxheWVyU3RhcnRZICsgZGVsdGFZO1xuXG4gICAgLy8gS2VlcCBwbGF5ZXIgd2l0aGluIHZpZXdwb3J0IGJvdW5kc1xuICAgIGNvbnN0IG1heFggPSB3aW5kb3cuaW5uZXJXaWR0aCAtIGZsb2F0aW5nUGxheWVyLm9mZnNldFdpZHRoO1xuICAgIGNvbnN0IG1heFkgPSB3aW5kb3cuaW5uZXJIZWlnaHQgLSBmbG9hdGluZ1BsYXllci5vZmZzZXRIZWlnaHQ7XG5cbiAgICBmbG9hdGluZ1BsYXllci5zdHlsZS5sZWZ0ID0gTWF0aC5tYXgoMCwgTWF0aC5taW4obmV3WCwgbWF4WCkpICsgJ3B4JztcbiAgICBmbG9hdGluZ1BsYXllci5zdHlsZS50b3AgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihuZXdZLCBtYXhZKSkgKyAncHgnO1xuICAgIGZsb2F0aW5nUGxheWVyLnN0eWxlLnJpZ2h0ID0gJ2F1dG8nOyAvLyBDbGVhciBhbnkgcmlnaHQgcG9zaXRpb25pbmdcbn1cblxuZnVuY3Rpb24gZW5kRHJhZygpIHtcbiAgICBpZiAoIWlzRHJhZ2dpbmcpIHJldHVybjtcblxuICAgIGlzRHJhZ2dpbmcgPSBmYWxzZTtcbiAgICBkb2N1bWVudC5ib2R5LnN0eWxlLnVzZXJTZWxlY3QgPSAnJzsgLy8gUmVzdG9yZSB0ZXh0IHNlbGVjdGlvblxufVxuXG4vLyBUb2dnbGUgdmlzaWJpbGl0eSBvZiBzZXR0aW5nIGNvbnRyb2wgKGRyb3Bkb3duIG9yIHNsaWRlcilcbmZ1bmN0aW9uIHRvZ2dsZVNldHRpbmdDb250cm9sKGNvbnRyb2xFbGVtZW50KSB7XG4gICAgY29uc3QgaXNIaWRkZW4gPSBjb250cm9sRWxlbWVudC5jbGFzc0xpc3QuY29udGFpbnMoJ2hpZGRlbicpO1xuICAgIC8vIEhpZGUgYWxsIGNvbnRyb2xzIGZpcnN0XG4gICAgaGlkZUFsbFNldHRpbmdDb250cm9scygpO1xuICAgIC8vIFNob3cgdGhlIGNsaWNrZWQgY29udHJvbCBpZiBpdCB3YXMgaGlkZGVuXG4gICAgaWYgKGlzSGlkZGVuKSB7XG4gICAgICAgIGNvbnRyb2xFbGVtZW50LmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpO1xuICAgIH1cbn1cblxuLy8gSGlkZSBhbGwgc2V0dGluZyBjb250cm9sc1xuZnVuY3Rpb24gaGlkZUFsbFNldHRpbmdDb250cm9scygpIHtcbiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudm94bG9jYWwtc2V0dGluZy1jb250cm9sJykuZm9yRWFjaChlbCA9PiB7XG4gICAgICAgIGVsLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpO1xuICAgIH0pO1xufVxuXG4vLyBVcGRhdGUgdm9pY2UgZGlzcGxheSB3aXRoIGN1cnJlbnQgc2VsZWN0ZWQgdm9pY2UgbmFtZVxuZnVuY3Rpb24gdXBkYXRlVm9pY2VEaXNwbGF5KCkge1xuICAgIGNvbnN0IHZvaWNlU2VsZWN0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3ZveGxvY2FsLXZvaWNlLXNlbGVjdCcpO1xuICAgIGNvbnN0IHZvaWNlRGlzcGxheSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd2b3hsb2NhbC12b2ljZS1kaXNwbGF5JykucXVlcnlTZWxlY3RvcignLnNldHRpbmctdmFsdWUnKTtcbiAgICBjb25zdCBzZWxlY3RlZE9wdGlvbiA9IHZvaWNlU2VsZWN0Lm9wdGlvbnNbdm9pY2VTZWxlY3Quc2VsZWN0ZWRJbmRleF07XG4gICAgY29uc3Qgdm9pY2VOYW1lID0gc2VsZWN0ZWRPcHRpb24udGV4dC5zcGxpdCgnICgnKVswXTsgLy8gR2V0IG5hbWUgYmVmb3JlIHBhcmVudGhlc2VzXG4gICAgdm9pY2VEaXNwbGF5LnRleHRDb250ZW50ID0gdm9pY2VOYW1lO1xufVxuXG4vLyBVcGRhdGUgc3BlZWQgZGlzcGxheVxuZnVuY3Rpb24gdXBkYXRlU3BlZWREaXNwbGF5KHZhbHVlKSB7XG4gICAgY29uc3Qgc3BlZWREaXNwbGF5ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3ZveGxvY2FsLXNwZWVkLWRpc3BsYXknKS5xdWVyeVNlbGVjdG9yKCcuc2V0dGluZy12YWx1ZScpO1xuICAgIHNwZWVkRGlzcGxheS50ZXh0Q29udGVudCA9IGAke3ZhbHVlfXhgO1xufVxuXG4vLyBHZXQgc2VsZWN0ZWQgdGV4dCBmcm9tIHRoZSBwYWdlXG5mdW5jdGlvbiBnZXRTZWxlY3RlZFRleHQoKSB7XG4gICAgY29uc3Qgc2VsZWN0aW9uID0gd2luZG93LmdldFNlbGVjdGlvbigpO1xuICAgIHJldHVybiBzZWxlY3Rpb24gPyBzZWxlY3Rpb24udG9TdHJpbmcoKS50cmltKCkgOiAnJztcbn1cblxuLy8gVFRTIGZ1bmN0aW9uYWxpdHkgZnVuY3Rpb25zXG5cbi8vIEZ1bmN0aW9uIHRvIGNhbmNlbCBzdHJlYW1pbmcgVFRTXG5mdW5jdGlvbiBjYW5jZWxTdHJlYW1pbmdUVFMoKSB7XG4gICAgY29uc29sZS5sb2coJ1tWb3hMb2NhbF0gQ2FuY2VsbGluZyBzdHJlYW1pbmcgVFRTIHJlcXVlc3QnKTtcblxuICAgIC8vIFNlbmQgY2FuY2VsIG1lc3NhZ2UgdG8gYmFja2dyb3VuZFxuICAgIGNvbnN0IG1lc3NhZ2UgPSB7XG4gICAgICAgIGFjdGlvbjogJ2NhbmNlbF9zdHJlYW0nXG4gICAgfTtcblxuICAgIGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKG1lc3NhZ2UsIChyZXNwb25zZSkgPT4ge1xuICAgICAgICBpZiAoY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yKSB7XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKCdbVm94TG9jYWxdIEVycm9yIHNlbmRpbmcgY2FuY2VsIG1lc3NhZ2U6JywgY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yKTtcbiAgICAgICAgfVxuICAgIH0pO1xufVxuXG4vLyBGdW5jdGlvbiB0byBxdWVyeSBtb2RlbCBzdGF0dXMgZnJvbSBiYWNrZ3JvdW5kXG5mdW5jdGlvbiBxdWVyeU1vZGVsU3RhdHVzKCkge1xuICAgIGNvbnNvbGUubG9nKCdbVm94TG9jYWxdIFF1ZXJ5aW5nIG1vZGVsIHN0YXR1cyBmcm9tIGJhY2tncm91bmQnKTtcblxuICAgIGNvbnN0IG1lc3NhZ2UgPSB7XG4gICAgICAgIGFjdGlvbjogJ3F1ZXJ5X21vZGVsX3N0YXR1cydcbiAgICB9O1xuXG4gICAgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UobWVzc2FnZSwgKHJlc3BvbnNlKSA9PiB7XG4gICAgICAgIGlmIChjaHJvbWUucnVudGltZS5sYXN0RXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ1tWb3hMb2NhbF0gRXJyb3IgcXVlcnlpbmcgbW9kZWwgc3RhdHVzOicsIGNocm9tZS5ydW50aW1lLmxhc3RFcnJvcik7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocmVzcG9uc2UgJiYgcmVzcG9uc2UubG9hZGVkKSB7XG4gICAgICAgICAgICBjb25zdCBtb2RlbE5hbWUgPSByZXNwb25zZS5tb2RlbE5hbWUgPyBgICgke3Jlc3BvbnNlLm1vZGVsTmFtZX0pYCA6ICcnO1xuICAgICAgICB9XG4gICAgfSk7XG59XG5cbi8vIEZ1bmN0aW9uIHRvIHNlbmQgdGV4dCB0byBzdHJlYW1pbmcgVFRTIGZvciBzcGVlY2ggZ2VuZXJhdGlvblxuZnVuY3Rpb24gc2VuZFN0cmVhbWluZ1RUUyh0ZXh0LCB2b2ljZSwgc3BlZWQpIHtcbiAgICAvLyBHZW5lcmF0ZSBhIHVuaXF1ZSByZXF1ZXN0IElEIGZvciB0aGlzIHN0cmVhbWluZyBzZXNzaW9uXG4gICAgY29uc3QgcmVxdWVzdElkID0gRGF0ZS5ub3coKSArIE1hdGgucmFuZG9tKCk7XG5cbiAgICAvLyBSZXNldCBzdHJlYW1pbmcgc3RhdGVcbiAgICBhdWRpb0NodW5rcyA9IHt9O1xuICAgIG5leHRFeHBlY3RlZENodW5rSW5kZXggPSAwO1xuICAgIGN1cnJlbnRTdHJlYW1pbmdSZXF1ZXN0SWQgPSByZXF1ZXN0SWQ7IC8vIFRyYWNrIHRoZSBjdXJyZW50IHJlcXVlc3QgSURcbiAgICBpc1N0cmVhbWluZyA9IHRydWU7XG4gICAgc3RyZWFtQ2h1bmtzUmVjZWl2ZWQgPSAwO1xuICAgIHRvdGFsU3RyZWFtQ2h1bmtzID0gMDtcblxuICAgIC8vIFVwZGF0ZSBidXR0b24gc3RhdGVzIGZvciBzdHJlYW1pbmdcbiAgICB1cGRhdGVCdXR0b25TdGF0ZXMoKTtcblxuICAgIHVwZGF0ZVN0YXR1cygnU3RhcnRpbmcgc3RyZWFtaW5nIHNwZWVjaCAocHJvY2Vzc2luZyBpbiBjaHVua3MpLi4uJywgJ2xvYWRpbmcnKTtcblxuICAgIC8vIFNlbmQgbWVzc2FnZSB0byBiYWNrZ3JvdW5kIHNjcmlwdCBmb3Igc3RyZWFtaW5nXG4gICAgY29uc3QgbWVzc2FnZSA9IHtcbiAgICAgICAgYWN0aW9uOiAnc3BlYWtfc3RyZWFtJyxcbiAgICAgICAgcmVxdWVzdElkOiByZXF1ZXN0SWQsXG4gICAgICAgIHRleHQ6IHRleHQsXG4gICAgICAgIHZvaWNlOiB2b2ljZSxcbiAgICAgICAgc3BlZWQ6IHNwZWVkXG4gICAgfTtcblxuICAgIGNvbnNvbGUubG9nKGBbVm94TG9jYWxdIFNlbmRpbmcgc3RyZWFtaW5nIHNwZWFrIG1lc3NhZ2UgdG8gYmFja2dyb3VuZCBzY3JpcHQgLSB0ZXh0OiBcIiR7dGV4dC5zdWJzdHJpbmcoMCwgNTApfSR7dGV4dC5sZW5ndGggPiA1MCA/ICcuLi4nIDogJyd9XCIsIHZvaWNlOiAke3ZvaWNlfSwgc3BlZWQ6ICR7c3BlZWR9eGApO1xuXG4gICAgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UobWVzc2FnZSwgKHJlc3BvbnNlKSA9PiB7XG4gICAgICAgIGlmIChjaHJvbWUucnVudGltZS5sYXN0RXJyb3IpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ1tWb3hMb2NhbF0gUnVudGltZSBlcnJvcjonLCBjaHJvbWUucnVudGltZS5sYXN0RXJyb3IpO1xuICAgICAgICAgICAgdXBkYXRlU3RhdHVzKCdFcnJvcjogJyArIGNocm9tZS5ydW50aW1lLmxhc3RFcnJvci5tZXNzYWdlLCAnZXJyb3InKTtcbiAgICAgICAgICAgIHJlc2V0U3RyZWFtaW5nU3RhdGUoKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghcmVzcG9uc2UgfHwgIXJlc3BvbnNlLnN1Y2Nlc3MpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ1tWb3hMb2NhbF0gU3RyZWFtaW5nIFRUUyBmYWlsZWQ6JywgcmVzcG9uc2U/LmVycm9yKTtcbiAgICAgICAgICAgIHVwZGF0ZVN0YXR1cygnRXJyb3I6ICcgKyAocmVzcG9uc2U/LmVycm9yIHx8ICdTdHJlYW1pbmcgZmFpbGVkJyksICdlcnJvcicpO1xuICAgICAgICAgICAgcmVzZXRTdHJlYW1pbmdTdGF0ZSgpO1xuICAgICAgICB9XG4gICAgfSk7XG59XG5cbi8vIEZ1bmN0aW9uIHRvIHNwZWFrIHRleHQgZnJvbSBwYWdlIChzZWxlY3Rpb24gb3IgZnVsbCBwYWdlKVxuYXN5bmMgZnVuY3Rpb24gc3BlYWtGcm9tUGFnZSh0eXBlKSB7XG4gICAgY29uc3Qgdm9pY2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndm94bG9jYWwtdm9pY2Utc2VsZWN0JykudmFsdWU7XG4gICAgY29uc3Qgc3BlZWQgPSBwYXJzZUZsb2F0KGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd2b3hsb2NhbC1zcGVlZC1zbGlkZXInKS52YWx1ZSk7XG5cbiAgICB1cGRhdGVTdGF0dXModHlwZSA9PT0gJ3NlbGVjdGlvbicgPyAnR2V0dGluZyBzZWxlY3RlZCB0ZXh0Li4uJyA6ICdHZXR0aW5nIHBhZ2UgdGV4dC4uLicsICdsb2FkaW5nJyk7XG5cbiAgICB0cnkge1xuICAgICAgICBsZXQgdGV4dDtcbiAgICAgICAgaWYgKHR5cGUgPT09ICdzZWxlY3Rpb24nKSB7XG4gICAgICAgICAgICB0ZXh0ID0gZ2V0U2VsZWN0ZWRUZXh0KCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0ZXh0ID0gZ2V0UGFnZVRleHQoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghdGV4dCB8fCB0ZXh0LnRyaW0oKSA9PT0gJycpIHtcbiAgICAgICAgICAgIGNvbnN0IGVycm9yTXNnID0gdHlwZSA9PT0gJ3NlbGVjdGlvbicgPyAnTm8gdGV4dCBzZWxlY3RlZCcgOiAnTm8gdGV4dCBmb3VuZCBvbiBwYWdlJztcbiAgICAgICAgICAgIHVwZGF0ZVN0YXR1cyhlcnJvck1zZywgJ2Vycm9yJyk7XG4gICAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHVwZGF0ZVN0YXR1cygnUmVhZHknLCAncmVhZHknKSwgMjAwMCk7XG4gICAgICAgICAgICByZXNldEJ1dHRvbnMoKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFVzZSB0aGUgdGV4dCBhbmQgc3BlYWsgaXQgdXNpbmcgc3RyZWFtaW5nIGxvZ2ljXG4gICAgICAgIGNvbnN0IHRyaW1tZWRUZXh0ID0gdGV4dC50cmltKCk7XG4gICAgICAgIGNvbnNvbGUubG9nKGBbVm94TG9jYWxdIEdvdCAke3R5cGV9IHRleHQ6IFwiJHt0cmltbWVkVGV4dC5zdWJzdHJpbmcoMCwgNTApfSR7dHJpbW1lZFRleHQubGVuZ3RoID4gNTAgPyAnLi4uJyA6ICcnfVwiYCk7XG5cbiAgICAgICAgLy8gU2VuZCB0byBzdHJlYW1pbmcgVFRTIHdpdGggcGFnZS1zcGVjaWZpYyBsb2FkaW5nIG1lc3NhZ2VcbiAgICAgICAgc2VuZFN0cmVhbWluZ1RUUyh0cmltbWVkVGV4dCwgdm9pY2UsIHNwZWVkKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBjb25zb2xlLmVycm9yKCdbVm94TG9jYWxdIEVycm9yOicsIGVycm9yKTtcbiAgICAgICAgdXBkYXRlU3RhdHVzKCdFcnJvcjogJyArIGVycm9yLm1lc3NhZ2UsICdlcnJvcicpO1xuICAgICAgICByZXNldEJ1dHRvbnMoKTtcbiAgICB9XG59XG5cbi8vIFRvZ2dsZSBiZXR3ZWVuIHBsYXkgYW5kIHN0b3AgZnVuY3Rpb25hbGl0eVxuZnVuY3Rpb24gdG9nZ2xlUGxheVN0b3AoKSB7XG4gICAgLy8gSWYgY3VycmVudGx5IHBsYXlpbmcgKHN0cmVhbWluZyksIHN0b3BcbiAgICBpZiAoaXNTdHJlYW1pbmcgfHwgY3VycmVudEF1ZGlvKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKCdbVm94TG9jYWxdIFBsYXkvU3RvcCBidXR0b24gY2xpY2tlZCAtIHN0b3BwaW5nIHBsYXliYWNrJyk7XG4gICAgICAgIHN0b3BQbGF5YmFjaygpO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gSWYgbm90IHBsYXlpbmcsIGNoZWNrIGZvciBzZWxlY3Rpb24gb3IgcGxheSBwYWdlXG4gICAgY29uc3Qgc2VsZWN0ZWRUZXh0ID0gZ2V0U2VsZWN0ZWRUZXh0KCk7XG4gICAgaWYgKHNlbGVjdGVkVGV4dCAmJiBzZWxlY3RlZFRleHQudHJpbSgpICE9PSAnJykge1xuICAgICAgICBjb25zb2xlLmxvZygnW1ZveExvY2FsXSBQbGF5L1N0b3AgYnV0dG9uIGNsaWNrZWQgLSBwbGF5aW5nIHNlbGVjdGlvbicpO1xuICAgICAgICBzcGVha0Zyb21QYWdlKCdzZWxlY3Rpb24nKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBjb25zb2xlLmxvZygnW1ZveExvY2FsXSBQbGF5L1N0b3AgYnV0dG9uIGNsaWNrZWQgLSBwbGF5aW5nIHBhZ2UnKTtcbiAgICAgICAgc3BlYWtGcm9tUGFnZSgncGFnZScpO1xuICAgIH1cbn1cblxuLy8gU3RvcCBwbGF5YmFja1xuZnVuY3Rpb24gc3RvcFBsYXliYWNrKCkge1xuICAgIGNvbnNvbGUubG9nKCdbVm94TG9jYWxdIFN0b3AgYnV0dG9uIGNsaWNrZWQnKTtcbiAgICBpZiAoY3VycmVudEF1ZGlvKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKCdbVm94TG9jYWxdIFN0b3BwaW5nIGN1cnJlbnQgYXVkaW8gcGxheWJhY2snKTtcbiAgICAgICAgY3VycmVudEF1ZGlvLnBhdXNlKCk7XG4gICAgICAgIGN1cnJlbnRBdWRpbyA9IG51bGw7XG4gICAgfVxuXG4gICAgLy8gQ2FuY2VsIHN0cmVhbWluZyBpZiBhY3RpdmVcbiAgICBpZiAoaXNTdHJlYW1pbmcpIHtcbiAgICAgICAgY29uc29sZS5sb2coJ1tWb3hMb2NhbF0gQ2FuY2VsbGluZyBhY3RpdmUgc3RyZWFtaW5nIHJlcXVlc3QnKTtcbiAgICAgICAgY2FuY2VsU3RyZWFtaW5nVFRTKCk7XG4gICAgICAgIHJlc2V0U3RyZWFtaW5nU3RhdGUoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICByZXNldEJ1dHRvbnMoKTtcbiAgICB9XG5cbiAgICB1cGRhdGVTdGF0dXMoJ1N0b3BwZWQnLCAncmVhZHknKTtcbn1cblxuLy8gUGxheSBhdWRpbyBmcm9tIGJhc2U2NCBkYXRhXG5mdW5jdGlvbiBwbGF5QXVkaW8ocmVzcG9uc2UpIHtcbiAgICB0cnkge1xuICAgICAgICBjb25zb2xlLmxvZygnW1ZveExvY2FsXSBDb252ZXJ0aW5nIGJhc2U2NCBhdWRpbyB0byBwbGF5YWJsZSBmb3JtYXQuLi4nKTtcbiAgICAgICAgY29uc3QgeyBhdWRpbywgYXVkaW9VcmwgfSA9IGNyZWF0ZUF1ZGlvRnJvbUJhc2U2NChyZXNwb25zZS5hdWRpbywgeyBzcGVlZDogcmVzcG9uc2Uuc3BlZWQgfHwgMSB9KTtcbiAgICAgICAgY3VycmVudEF1ZGlvID0gYXVkaW87XG4gICAgICAgIGNvbnNvbGUubG9nKGBbVm94TG9jYWxdIEF1ZGlvIGVsZW1lbnQgY3JlYXRlZCB3aXRoIHBsYXliYWNrIHJhdGU6ICR7Y3VycmVudEF1ZGlvLnBsYXliYWNrUmF0ZX14YCk7XG5cbiAgICAgICAgY3VycmVudEF1ZGlvLm9ubG9hZGVkbWV0YWRhdGEgPSAoKSA9PiB7XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhgW1ZveExvY2FsXSBBdWRpbyBsb2FkZWQgLSBkdXJhdGlvbjogJHtjdXJyZW50QXVkaW8uZHVyYXRpb24udG9GaXhlZCgyKX1zYCk7XG4gICAgICAgICAgICB1cGRhdGVTdGF0dXMoJ1NwZWFraW5nJywgJ3NwZWFraW5nJyk7XG4gICAgICAgICAgICB1cGRhdGVCdXR0b25TdGF0ZXMoKTtcbiAgICAgICAgfTtcblxuICAgICAgICBjdXJyZW50QXVkaW8ub25lbmRlZCA9ICgpID0+IHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKCdbVm94TG9jYWxdIEF1ZGlvIHBsYXliYWNrIGNvbXBsZXRlZCBzdWNjZXNzZnVsbHknKTtcbiAgICAgICAgICAgIFVSTC5yZXZva2VPYmplY3RVUkwoYXVkaW9VcmwpO1xuICAgICAgICAgICAgY3VycmVudEF1ZGlvID0gbnVsbDtcbiAgICAgICAgICAgIHJlc2V0QnV0dG9ucygpO1xuICAgICAgICAgICAgdXBkYXRlU3RhdHVzKCdSZWFkeScsICdyZWFkeScpO1xuICAgICAgICB9O1xuXG4gICAgICAgIGN1cnJlbnRBdWRpby5vbmVycm9yID0gKGVycm9yKSA9PiB7XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKCdbVm94TG9jYWxdIEF1ZGlvIHBsYXliYWNrIGVycm9yOicsIGN1cnJlbnRBdWRpbz8uZXJyb3I/Lm1lc3NhZ2UgfHwgJ1Vua25vd24gZXJyb3InKTtcbiAgICAgICAgICAgIFVSTC5yZXZva2VPYmplY3RVUkwoYXVkaW9VcmwpO1xuICAgICAgICAgICAgY3VycmVudEF1ZGlvID0gbnVsbDtcbiAgICAgICAgICAgIHJlc2V0QnV0dG9ucygpO1xuICAgICAgICAgICAgdXBkYXRlU3RhdHVzKCdFcnJvcicsICdlcnJvcicpO1xuICAgICAgICB9O1xuXG4gICAgICAgIGNvbnNvbGUubG9nKCdbVm94TG9jYWxdIFN0YXJ0aW5nIGF1ZGlvIHBsYXliYWNrLi4uJyk7XG4gICAgICAgIGN1cnJlbnRBdWRpby5wbGF5KCkuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKCdbVm94TG9jYWxdIEF1ZGlvIHBsYXkgZmFpbGVkOicsIGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICAgICAgVVJMLnJldm9rZU9iamVjdFVSTChhdWRpb1VybCk7XG4gICAgICAgICAgICBjdXJyZW50QXVkaW8gPSBudWxsO1xuICAgICAgICAgICAgcmVzZXRCdXR0b25zKCk7XG4gICAgICAgICAgICB1cGRhdGVTdGF0dXMoJ0Vycm9yOiAnICsgZXJyb3IubWVzc2FnZSwgJ2Vycm9yJyk7XG4gICAgICAgIH0pO1xuXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcignW1ZveExvY2FsXSBFcnJvciBjcmVhdGluZyBhdWRpbzonLCBlcnJvcik7XG4gICAgICAgIHVwZGF0ZVN0YXR1cygnRXJyb3I6ICcgKyBlcnJvci5tZXNzYWdlLCAnZXJyb3InKTtcbiAgICAgICAgcmVzZXRCdXR0b25zKCk7XG4gICAgfVxufVxuXG4vLyBVcGRhdGUgYnV0dG9uIHRleHQgYmFzZWQgb24gY3VycmVudCBzZWxlY3Rpb25cbmZ1bmN0aW9uIHVwZGF0ZUJ1dHRvblRleHQoKSB7XG4gICAgY29uc3QgcGxheVN0b3BCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndm94bG9jYWwtcGxheS1zdG9wLWJ0bicpO1xuICAgIGlmICghcGxheVN0b3BCdG4gfHwgaXNTdHJlYW1pbmcpIHJldHVybjsgLy8gRG9uJ3QgdXBkYXRlIGlmIHN0cmVhbWluZ1xuXG4gICAgY29uc3Qgc2VsZWN0ZWRUZXh0ID0gZ2V0U2VsZWN0ZWRUZXh0KCk7XG4gICAgY29uc3QgYnV0dG9uVGV4dCA9IHNlbGVjdGVkVGV4dCAmJiBzZWxlY3RlZFRleHQudHJpbSgpICE9PSAnJyA/ICdQbGF5IFNlbGVjdGlvbicgOiAnUGxheSBQYWdlJztcbiAgICBjb25zdCBpY29uUGF0aCA9IGNocm9tZS5ydW50aW1lLmdldFVSTCgnaWNvbnMvaWNvbl8xMjh4MTI4XzIucG5nJyk7XG5cbiAgICBwbGF5U3RvcEJ0bi5pbm5lckhUTUwgPSBgPGltZyBzcmM9XCIke2ljb25QYXRofVwiIGNsYXNzPVwiaWNvblwiIGFsdD1cIlBsYXlcIj4gJHtidXR0b25UZXh0fWA7XG59XG5cbi8vIFJlc2V0IGJ1dHRvbiBzdGF0ZXNcbmZ1bmN0aW9uIHJlc2V0QnV0dG9ucygpIHtcbiAgICBjb25zdCBwbGF5U3RvcEJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd2b3hsb2NhbC1wbGF5LXN0b3AtYnRuJyk7XG4gICAgcGxheVN0b3BCdG4uZGlzYWJsZWQgPSBmYWxzZTtcblxuICAgIHVwZGF0ZUJ1dHRvblRleHQoKTtcbiAgICBwbGF5U3RvcEJ0bi50aXRsZSA9ICdQbGF5IHNlbGVjdGlvbiBvciBwYWdlJztcbiAgICBwbGF5U3RvcEJ0bi5jbGFzc05hbWUgPSAndm94bG9jYWwtYnRuIHZveGxvY2FsLWJ0bi1wcmltYXJ5Jztcbn1cblxuLy8gVXBkYXRlIHN0YXR1cyBkaXNwbGF5XG5mdW5jdGlvbiB1cGRhdGVTdGF0dXMobWVzc2FnZSwgdHlwZSA9ICdyZWFkeScpIHtcbiAgICBjb25zdCBzdGF0dXNFbGVtZW50ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3ZveGxvY2FsLXN0YXR1cycpO1xuICAgIGlmICghc3RhdHVzRWxlbWVudCkgcmV0dXJuO1xuXG4gICAgc3RhdHVzRWxlbWVudC50ZXh0Q29udGVudCA9IG1lc3NhZ2U7XG5cbiAgICAvLyBSZW1vdmUgYWxsIHN0YXR1cyBjbGFzc2VzXG4gICAgc3RhdHVzRWxlbWVudC5jbGFzc05hbWUgPSAnc3RhdHVzLWJhZGdlJztcblxuICAgIC8vIEFkZCB0aGUgYXBwcm9wcmlhdGUgc3RhdHVzIGNsYXNzXG4gICAgc3RhdHVzRWxlbWVudC5jbGFzc0xpc3QuYWRkKHR5cGUpO1xufVxuXG5cbi8vIFJlc2V0IHN0cmVhbWluZyBzdGF0ZVxuZnVuY3Rpb24gcmVzZXRTdHJlYW1pbmdTdGF0ZSgpIHtcbiAgICBhdWRpb0NodW5rcyA9IHt9O1xuICAgIG5leHRFeHBlY3RlZENodW5rSW5kZXggPSAwO1xuICAgIGN1cnJlbnRTdHJlYW1pbmdSZXF1ZXN0SWQgPSBudWxsO1xuICAgIGlzU3RyZWFtaW5nID0gZmFsc2U7XG4gICAgc3RyZWFtQ2h1bmtzUmVjZWl2ZWQgPSAwO1xuICAgIHRvdGFsU3RyZWFtQ2h1bmtzID0gMDtcbiAgICB1cGRhdGVCdXR0b25TdGF0ZXMoKTtcbn1cblxuLy8gVXBkYXRlIGJ1dHRvbiBzdGF0ZXMgYmFzZWQgb24gc3RyZWFtaW5nIHN0YXR1c1xuZnVuY3Rpb24gdXBkYXRlQnV0dG9uU3RhdGVzKCkge1xuICAgIGNvbnN0IHBsYXlTdG9wQnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3ZveGxvY2FsLXBsYXktc3RvcC1idG4nKTtcbiAgICBpZiAoaXNTdHJlYW1pbmcpIHtcbiAgICAgICAgLy8gRHVyaW5nIHN0cmVhbWluZywgY2hhbmdlIHRvIHN0b3AgbW9kZVxuICAgICAgICBwbGF5U3RvcEJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICBjb25zdCBpY29uUGF0aCA9IGNocm9tZS5ydW50aW1lLmdldFVSTCgnaWNvbnMvdm94bG9jYWwtc3RvcC5wbmcnKTtcbiAgICAgICAgcGxheVN0b3BCdG4uaW5uZXJIVE1MID0gYDxpbWcgc3JjPVwiJHtpY29uUGF0aH1cIiBjbGFzcz1cImljb25cIiBhbHQ9XCJTdG9wXCI+IFN0b3BgO1xuICAgICAgICBwbGF5U3RvcEJ0bi50aXRsZSA9ICdTdG9wIHNwZWFraW5nJztcbiAgICAgICAgcGxheVN0b3BCdG4uY2xhc3NOYW1lID0gJ3ZveGxvY2FsLWJ0biB2b3hsb2NhbC1idG4tZGFuZ2VyJztcbiAgICB9IGVsc2Uge1xuICAgICAgICAvLyBOb3JtYWwgc3RhdGUgLSBwbGF5IG1vZGVcbiAgICAgICAgcmVzZXRCdXR0b25zKCk7XG4gICAgfVxufVxuXG4vLyBQbGF5IG5leHQgYXVkaW8gY2h1bmsgZnJvbSBzdG9yZWQgY2h1bmtzXG5mdW5jdGlvbiBwbGF5TmV4dEF1ZGlvQ2h1bmsoKSB7XG4gICAgLy8gQ2hlY2sgaWYgd2UgaGF2ZSB0aGUgbmV4dCBleHBlY3RlZCBjaHVua1xuICAgIGlmICghYXVkaW9DaHVua3NbbmV4dEV4cGVjdGVkQ2h1bmtJbmRleF0pIHtcbiAgICAgICAgaWYgKGlzU3RyZWFtaW5nKSB7XG4gICAgICAgICAgICB1cGRhdGVTdGF0dXMoJ1N0cmVhbWluZzogd2FpdGluZyBmb3IgbmV4dCBjaHVuay4uLicsICdsb2FkaW5nJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBTdHJlYW1pbmcgY29tcGxldGUsIGNoZWNrIGlmIHdlIGhhdmUgYWxsIGNodW5rc1xuICAgICAgICAgICAgaWYgKG5leHRFeHBlY3RlZENodW5rSW5kZXggPj0gdG90YWxTdHJlYW1DaHVua3MpIHtcbiAgICAgICAgICAgICAgICB1cGRhdGVTdGF0dXMoJ1JlYWR5JywgJ3JlYWR5Jyk7XG4gICAgICAgICAgICAgICAgcmVzZXRCdXR0b25zKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgIH1cblxuXG4gICAgY29uc3QgY2h1bmsgPSBhdWRpb0NodW5rc1tuZXh0RXhwZWN0ZWRDaHVua0luZGV4XTtcbiAgICBkZWxldGUgYXVkaW9DaHVua3NbbmV4dEV4cGVjdGVkQ2h1bmtJbmRleF07IC8vIFJlbW92ZSBmcm9tIHN0b3JhZ2VcbiAgICBuZXh0RXhwZWN0ZWRDaHVua0luZGV4Kys7XG4gICAgY29uc29sZS5sb2coYFtWb3hMb2NhbF0g8J+TnSBDaHVuayB0ZXh0OiBcIiR7Y2h1bmsudGV4dCA/IGNodW5rLnRleHQuc3Vic3RyaW5nKDAsIDEwMCkgKyAoY2h1bmsudGV4dC5sZW5ndGggPiAxMDAgPyAnLi4uJyA6ICcnKSA6ICdOL0EnfVwiYCk7XG5cbiAgICB1cGRhdGVTdGF0dXMoYFBsYXlpbmcgY2h1bmsgJHtjaHVuay5jaHVua0luZGV4ICsgMX0vJHtjaHVuay50b3RhbENodW5rc30gKHN0cmVhbWluZylgLCAnc3BlYWtpbmcnKTtcblxuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHsgYXVkaW8sIGF1ZGlvVXJsIH0gPSBjcmVhdGVBdWRpb0Zyb21CYXNlNjQoY2h1bmsuYXVkaW8sIHsgc3BlZWQ6IGNodW5rLnNwZWVkIHx8IDEgfSk7XG4gICAgICAgIGN1cnJlbnRBdWRpbyA9IGF1ZGlvO1xuXG4gICAgICAgIGN1cnJlbnRBdWRpby5vbmVuZGVkID0gKCkgPT4ge1xuICAgICAgICAgICAgY29uc29sZS5sb2coYFtWb3hMb2NhbF0g4pyFIENodW5rICR7Y2h1bmsuY2h1bmtJbmRleCArIDF9LyR7Y2h1bmsudG90YWxDaHVua3N9IHBsYXliYWNrIENPTVBMRVRFRGApO1xuICAgICAgICAgICAgVVJMLnJldm9rZU9iamVjdFVSTChhdWRpb1VybCk7XG4gICAgICAgICAgICBjdXJyZW50QXVkaW8gPSBudWxsO1xuICAgICAgICAgICAgLy8gUGxheSBuZXh0IGNodW5rXG4gICAgICAgICAgICBjb25zb2xlLmxvZyhgW1ZveExvY2FsXSDwn5SEIENhbGxpbmcgcGxheU5leHRBdWRpb0NodW5rIGFmdGVyIGNodW5rICR7Y2h1bmsuY2h1bmtJbmRleCArIDF9IGNvbXBsZXRpb25gKTtcbiAgICAgICAgICAgIHBsYXlOZXh0QXVkaW9DaHVuaygpO1xuICAgICAgICB9O1xuXG4gICAgICAgIGN1cnJlbnRBdWRpby5vbmVycm9yID0gKGVycm9yKSA9PiB7XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKCdbVm94TG9jYWxdIEF1ZGlvIGNodW5rIHBsYXliYWNrIGVycm9yOicsIGVycm9yKTtcbiAgICAgICAgICAgIFVSTC5yZXZva2VPYmplY3RVUkwoYXVkaW9VcmwpO1xuICAgICAgICAgICAgY3VycmVudEF1ZGlvID0gbnVsbDtcbiAgICAgICAgICAgIHJlc2V0U3RyZWFtaW5nU3RhdGUoKTtcbiAgICAgICAgICAgIHVwZGF0ZVN0YXR1cygnRXJyb3IgcGxheWluZyBhdWRpbyBjaHVuaycsICdlcnJvcicpO1xuICAgICAgICB9O1xuXG4gICAgICAgIGNvbnNvbGUubG9nKGBbVm94TG9jYWxdIOKWtu+4jyBTdGFydGluZyBjaHVuayAke2NodW5rLmNodW5rSW5kZXggKyAxfSBhdWRpbyBwbGF5YmFjay4uLmApO1xuICAgICAgICBjdXJyZW50QXVkaW8ucGxheSgpLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgY29uc29sZS5sb2coYFtWb3hMb2NhbF0g8J+OpyBDaHVuayAke2NodW5rLmNodW5rSW5kZXggKyAxfSBTVEFSVEVEIHBsYXlpbmcgc3VjY2Vzc2Z1bGx5YCk7XG4gICAgICAgIH0pLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcihgW1ZveExvY2FsXSDinYwgQXVkaW8gY2h1bmsgJHtjaHVuay5jaHVua0luZGV4ICsgMX0gcGxheSBGQUlMRUQ6YCwgZXJyb3IubWVzc2FnZSk7XG4gICAgICAgICAgICBVUkwucmV2b2tlT2JqZWN0VVJMKGF1ZGlvVXJsKTtcbiAgICAgICAgICAgIGN1cnJlbnRBdWRpbyA9IG51bGw7XG4gICAgICAgICAgICByZXNldFN0cmVhbWluZ1N0YXRlKCk7XG4gICAgICAgICAgICB1cGRhdGVTdGF0dXMoJ0Vycm9yOiAnICsgZXJyb3IubWVzc2FnZSwgJ2Vycm9yJyk7XG4gICAgICAgIH0pO1xuXG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcignW1ZveExvY2FsXSBFcnJvciBjcmVhdGluZyBhdWRpbyBjaHVuazonLCBlcnJvcik7XG4gICAgICAgIHJlc2V0U3RyZWFtaW5nU3RhdGUoKTtcbiAgICAgICAgdXBkYXRlU3RhdHVzKCdFcnJvcjogJyArIGVycm9yLm1lc3NhZ2UsICdlcnJvcicpO1xuICAgIH1cbn1cblxuLy8gU2V0dGluZ3Mgc3RvcmFnZSBmdW5jdGlvbnNcbmFzeW5jIGZ1bmN0aW9uIHNhdmVTZXR0aW5ncygpIHtcbiAgICBjb25zdCBzZXR0aW5ncyA9IHtcbiAgICAgICAgdm9pY2U6IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd2b3hsb2NhbC12b2ljZS1zZWxlY3QnKS52YWx1ZSxcbiAgICAgICAgc3BlZWQ6IHBhcnNlRmxvYXQoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3ZveGxvY2FsLXNwZWVkLXNsaWRlcicpLnZhbHVlKVxuICAgIH07XG5cbiAgICB0cnkge1xuICAgICAgICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5zeW5jLnNldCh7IHZveExvY2FsU2V0dGluZ3M6IHNldHRpbmdzIH0pO1xuICAgICAgICBjb25zb2xlLmxvZygnW1ZveExvY2FsXSBTZXR0aW5ncyBzYXZlZDonLCBzZXR0aW5ncyk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcignW1ZveExvY2FsXSBFcnJvciBzYXZpbmcgc2V0dGluZ3M6JywgZXJyb3IpO1xuICAgIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gbG9hZFNldHRpbmdzKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLnN5bmMuZ2V0KCd2b3hMb2NhbFNldHRpbmdzJyk7XG4gICAgICAgIGNvbnN0IHNldHRpbmdzID0gcmVzdWx0LnZveExvY2FsU2V0dGluZ3MgfHwge307XG5cbiAgICAgICAgLy8gQXBwbHkgc2F2ZWQgc2V0dGluZ3Mgd2l0aCBkZWZhdWx0c1xuICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndm94bG9jYWwtdm9pY2Utc2VsZWN0JykudmFsdWUgPSBzZXR0aW5ncy52b2ljZSB8fCAnYWZfaGVhcnQnO1xuICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndm94bG9jYWwtc3BlZWQtc2xpZGVyJykudmFsdWUgPSBzZXR0aW5ncy5zcGVlZCB8fCAxLjA7XG5cbiAgICAgICAgLy8gVXBkYXRlIGRpc3BsYXlzXG4gICAgICAgIHVwZGF0ZVZvaWNlRGlzcGxheSgpO1xuICAgICAgICB1cGRhdGVTcGVlZERpc3BsYXkoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3ZveGxvY2FsLXNwZWVkLXNsaWRlcicpLnZhbHVlKTtcblxuICAgICAgICBjb25zb2xlLmxvZygnW1ZveExvY2FsXSBTZXR0aW5ncyBsb2FkZWQ6Jywgc2V0dGluZ3MpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoJ1tWb3hMb2NhbF0gRXJyb3IgbG9hZGluZyBzZXR0aW5nczonLCBlcnJvcik7XG4gICAgICAgIC8vIFNldCBkZWZhdWx0cyBpZiBsb2FkaW5nIGZhaWxzXG4gICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd2b3hsb2NhbC12b2ljZS1zZWxlY3QnKS52YWx1ZSA9ICdhZl9oZWFydCc7XG4gICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd2b3hsb2NhbC1zcGVlZC1zbGlkZXInKS52YWx1ZSA9IDEuMDtcbiAgICAgICAgdXBkYXRlVm9pY2VEaXNwbGF5KCk7XG4gICAgICAgIHVwZGF0ZVNwZWVkRGlzcGxheSgxLjApO1xuICAgIH1cbn1cblxuXG4vLyBHZXQgcmVhZGFibGUgdGV4dCBmcm9tIHRoZSBlbnRpcmUgcGFnZVxuZnVuY3Rpb24gZ2V0UGFnZVRleHQoKSB7XG4gICAgLy8gQ2xvbmUgdGhlIGJvZHkgdG8gYXZvaWQgbW9kaWZ5aW5nIHRoZSBvcmlnaW5hbFxuICAgIGNvbnN0IGNsb25lID0gZG9jdW1lbnQuYm9keS5jbG9uZU5vZGUodHJ1ZSk7XG5cbiAgICAvLyBSZW1vdmUgdW53YW50ZWQgZWxlbWVudHNcbiAgICBjb25zdCBzZWxlY3RvcnNUb1JlbW92ZSA9IFtcbiAgICAgICAgJ3NjcmlwdCcsICdzdHlsZScsICdub3NjcmlwdCcsICdpZnJhbWUnLCAnbmF2JywgJ2hlYWRlcicsICdmb290ZXInLCAnYXNpZGUnLFxuICAgICAgICAnW3JvbGU9XCJuYXZpZ2F0aW9uXCJdJywgJ1tyb2xlPVwiYmFubmVyXCJdJywgJ1tyb2xlPVwiY29tcGxlbWVudGFyeVwiXSdcbiAgICBdO1xuXG4gICAgc2VsZWN0b3JzVG9SZW1vdmUuZm9yRWFjaChzZWxlY3RvciA9PiB7XG4gICAgICAgIGNsb25lLnF1ZXJ5U2VsZWN0b3JBbGwoc2VsZWN0b3IpLmZvckVhY2goZWwgPT4gZWwucmVtb3ZlKCkpO1xuICAgIH0pO1xuXG4gICAgLy8gR2V0IHRleHQgY29udGVudCBhbmQgY2xlYW4gaXQgdXBcbiAgICBsZXQgdGV4dCA9IGNsb25lLnRleHRDb250ZW50IHx8ICcnO1xuICAgIHRleHQgPSB0ZXh0XG4gICAgICAgIC5yZXBsYWNlKC9cXG5cXHMqXFxuL2csICdcXG5cXG4nKSAgLy8gUmVtb3ZlIGV4Y2Vzc2l2ZSBuZXdsaW5lc1xuICAgICAgICAucmVwbGFjZSgvWyBcXHRdKy9nLCAnICcpICAgICAgIC8vIE5vcm1hbGl6ZSB3aGl0ZXNwYWNlXG4gICAgICAgIC50cmltKCk7XG5cbiAgICByZXR1cm4gdGV4dDtcbn1cbiAgfVxufSk7XG4iLCIvLyAjcmVnaW9uIHNuaXBwZXRcbmV4cG9ydCBjb25zdCBicm93c2VyID0gZ2xvYmFsVGhpcy5icm93c2VyPy5ydW50aW1lPy5pZFxuICA/IGdsb2JhbFRoaXMuYnJvd3NlclxuICA6IGdsb2JhbFRoaXMuY2hyb21lO1xuLy8gI2VuZHJlZ2lvbiBzbmlwcGV0XG4iLCJpbXBvcnQgeyBicm93c2VyIGFzIF9icm93c2VyIH0gZnJvbSBcIkB3eHQtZGV2L2Jyb3dzZXJcIjtcbmV4cG9ydCBjb25zdCBicm93c2VyID0gX2Jyb3dzZXI7XG5leHBvcnQge307XG4iLCJmdW5jdGlvbiBwcmludChtZXRob2QsIC4uLmFyZ3MpIHtcbiAgaWYgKGltcG9ydC5tZXRhLmVudi5NT0RFID09PSBcInByb2R1Y3Rpb25cIikgcmV0dXJuO1xuICBpZiAodHlwZW9mIGFyZ3NbMF0gPT09IFwic3RyaW5nXCIpIHtcbiAgICBjb25zdCBtZXNzYWdlID0gYXJncy5zaGlmdCgpO1xuICAgIG1ldGhvZChgW3d4dF0gJHttZXNzYWdlfWAsIC4uLmFyZ3MpO1xuICB9IGVsc2Uge1xuICAgIG1ldGhvZChcIlt3eHRdXCIsIC4uLmFyZ3MpO1xuICB9XG59XG5leHBvcnQgY29uc3QgbG9nZ2VyID0ge1xuICBkZWJ1ZzogKC4uLmFyZ3MpID0+IHByaW50KGNvbnNvbGUuZGVidWcsIC4uLmFyZ3MpLFxuICBsb2c6ICguLi5hcmdzKSA9PiBwcmludChjb25zb2xlLmxvZywgLi4uYXJncyksXG4gIHdhcm46ICguLi5hcmdzKSA9PiBwcmludChjb25zb2xlLndhcm4sIC4uLmFyZ3MpLFxuICBlcnJvcjogKC4uLmFyZ3MpID0+IHByaW50KGNvbnNvbGUuZXJyb3IsIC4uLmFyZ3MpXG59O1xuIiwiaW1wb3J0IHsgYnJvd3NlciB9IGZyb20gXCJ3eHQvYnJvd3NlclwiO1xuZXhwb3J0IGNsYXNzIFd4dExvY2F0aW9uQ2hhbmdlRXZlbnQgZXh0ZW5kcyBFdmVudCB7XG4gIGNvbnN0cnVjdG9yKG5ld1VybCwgb2xkVXJsKSB7XG4gICAgc3VwZXIoV3h0TG9jYXRpb25DaGFuZ2VFdmVudC5FVkVOVF9OQU1FLCB7fSk7XG4gICAgdGhpcy5uZXdVcmwgPSBuZXdVcmw7XG4gICAgdGhpcy5vbGRVcmwgPSBvbGRVcmw7XG4gIH1cbiAgc3RhdGljIEVWRU5UX05BTUUgPSBnZXRVbmlxdWVFdmVudE5hbWUoXCJ3eHQ6bG9jYXRpb25jaGFuZ2VcIik7XG59XG5leHBvcnQgZnVuY3Rpb24gZ2V0VW5pcXVlRXZlbnROYW1lKGV2ZW50TmFtZSkge1xuICByZXR1cm4gYCR7YnJvd3Nlcj8ucnVudGltZT8uaWR9OiR7aW1wb3J0Lm1ldGEuZW52LkVOVFJZUE9JTlR9OiR7ZXZlbnROYW1lfWA7XG59XG4iLCJpbXBvcnQgeyBXeHRMb2NhdGlvbkNoYW5nZUV2ZW50IH0gZnJvbSBcIi4vY3VzdG9tLWV2ZW50cy5tanNcIjtcbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVMb2NhdGlvbldhdGNoZXIoY3R4KSB7XG4gIGxldCBpbnRlcnZhbDtcbiAgbGV0IG9sZFVybDtcbiAgcmV0dXJuIHtcbiAgICAvKipcbiAgICAgKiBFbnN1cmUgdGhlIGxvY2F0aW9uIHdhdGNoZXIgaXMgYWN0aXZlbHkgbG9va2luZyBmb3IgVVJMIGNoYW5nZXMuIElmIGl0J3MgYWxyZWFkeSB3YXRjaGluZyxcbiAgICAgKiB0aGlzIGlzIGEgbm9vcC5cbiAgICAgKi9cbiAgICBydW4oKSB7XG4gICAgICBpZiAoaW50ZXJ2YWwgIT0gbnVsbCkgcmV0dXJuO1xuICAgICAgb2xkVXJsID0gbmV3IFVSTChsb2NhdGlvbi5ocmVmKTtcbiAgICAgIGludGVydmFsID0gY3R4LnNldEludGVydmFsKCgpID0+IHtcbiAgICAgICAgbGV0IG5ld1VybCA9IG5ldyBVUkwobG9jYXRpb24uaHJlZik7XG4gICAgICAgIGlmIChuZXdVcmwuaHJlZiAhPT0gb2xkVXJsLmhyZWYpIHtcbiAgICAgICAgICB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgV3h0TG9jYXRpb25DaGFuZ2VFdmVudChuZXdVcmwsIG9sZFVybCkpO1xuICAgICAgICAgIG9sZFVybCA9IG5ld1VybDtcbiAgICAgICAgfVxuICAgICAgfSwgMWUzKTtcbiAgICB9XG4gIH07XG59XG4iLCJpbXBvcnQgeyBicm93c2VyIH0gZnJvbSBcInd4dC9icm93c2VyXCI7XG5pbXBvcnQgeyBsb2dnZXIgfSBmcm9tIFwiLi4vdXRpbHMvaW50ZXJuYWwvbG9nZ2VyLm1qc1wiO1xuaW1wb3J0IHtcbiAgZ2V0VW5pcXVlRXZlbnROYW1lXG59IGZyb20gXCIuL2ludGVybmFsL2N1c3RvbS1ldmVudHMubWpzXCI7XG5pbXBvcnQgeyBjcmVhdGVMb2NhdGlvbldhdGNoZXIgfSBmcm9tIFwiLi9pbnRlcm5hbC9sb2NhdGlvbi13YXRjaGVyLm1qc1wiO1xuZXhwb3J0IGNsYXNzIENvbnRlbnRTY3JpcHRDb250ZXh0IHtcbiAgY29uc3RydWN0b3IoY29udGVudFNjcmlwdE5hbWUsIG9wdGlvbnMpIHtcbiAgICB0aGlzLmNvbnRlbnRTY3JpcHROYW1lID0gY29udGVudFNjcmlwdE5hbWU7XG4gICAgdGhpcy5vcHRpb25zID0gb3B0aW9ucztcbiAgICB0aGlzLmFib3J0Q29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICBpZiAodGhpcy5pc1RvcEZyYW1lKSB7XG4gICAgICB0aGlzLmxpc3RlbkZvck5ld2VyU2NyaXB0cyh7IGlnbm9yZUZpcnN0RXZlbnQ6IHRydWUgfSk7XG4gICAgICB0aGlzLnN0b3BPbGRTY3JpcHRzKCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMubGlzdGVuRm9yTmV3ZXJTY3JpcHRzKCk7XG4gICAgfVxuICB9XG4gIHN0YXRpYyBTQ1JJUFRfU1RBUlRFRF9NRVNTQUdFX1RZUEUgPSBnZXRVbmlxdWVFdmVudE5hbWUoXG4gICAgXCJ3eHQ6Y29udGVudC1zY3JpcHQtc3RhcnRlZFwiXG4gICk7XG4gIGlzVG9wRnJhbWUgPSB3aW5kb3cuc2VsZiA9PT0gd2luZG93LnRvcDtcbiAgYWJvcnRDb250cm9sbGVyO1xuICBsb2NhdGlvbldhdGNoZXIgPSBjcmVhdGVMb2NhdGlvbldhdGNoZXIodGhpcyk7XG4gIHJlY2VpdmVkTWVzc2FnZUlkcyA9IC8qIEBfX1BVUkVfXyAqLyBuZXcgU2V0KCk7XG4gIGdldCBzaWduYWwoKSB7XG4gICAgcmV0dXJuIHRoaXMuYWJvcnRDb250cm9sbGVyLnNpZ25hbDtcbiAgfVxuICBhYm9ydChyZWFzb24pIHtcbiAgICByZXR1cm4gdGhpcy5hYm9ydENvbnRyb2xsZXIuYWJvcnQocmVhc29uKTtcbiAgfVxuICBnZXQgaXNJbnZhbGlkKCkge1xuICAgIGlmIChicm93c2VyLnJ1bnRpbWUuaWQgPT0gbnVsbCkge1xuICAgICAgdGhpcy5ub3RpZnlJbnZhbGlkYXRlZCgpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5zaWduYWwuYWJvcnRlZDtcbiAgfVxuICBnZXQgaXNWYWxpZCgpIHtcbiAgICByZXR1cm4gIXRoaXMuaXNJbnZhbGlkO1xuICB9XG4gIC8qKlxuICAgKiBBZGQgYSBsaXN0ZW5lciB0aGF0IGlzIGNhbGxlZCB3aGVuIHRoZSBjb250ZW50IHNjcmlwdCdzIGNvbnRleHQgaXMgaW52YWxpZGF0ZWQuXG4gICAqXG4gICAqIEByZXR1cm5zIEEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogYnJvd3Nlci5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcihjYik7XG4gICAqIGNvbnN0IHJlbW92ZUludmFsaWRhdGVkTGlzdGVuZXIgPSBjdHgub25JbnZhbGlkYXRlZCgoKSA9PiB7XG4gICAqICAgYnJvd3Nlci5ydW50aW1lLm9uTWVzc2FnZS5yZW1vdmVMaXN0ZW5lcihjYik7XG4gICAqIH0pXG4gICAqIC8vIC4uLlxuICAgKiByZW1vdmVJbnZhbGlkYXRlZExpc3RlbmVyKCk7XG4gICAqL1xuICBvbkludmFsaWRhdGVkKGNiKSB7XG4gICAgdGhpcy5zaWduYWwuYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIGNiKTtcbiAgICByZXR1cm4gKCkgPT4gdGhpcy5zaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIGNiKTtcbiAgfVxuICAvKipcbiAgICogUmV0dXJuIGEgcHJvbWlzZSB0aGF0IG5ldmVyIHJlc29sdmVzLiBVc2VmdWwgaWYgeW91IGhhdmUgYW4gYXN5bmMgZnVuY3Rpb24gdGhhdCBzaG91bGRuJ3QgcnVuXG4gICAqIGFmdGVyIHRoZSBjb250ZXh0IGlzIGV4cGlyZWQuXG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGNvbnN0IGdldFZhbHVlRnJvbVN0b3JhZ2UgPSBhc3luYyAoKSA9PiB7XG4gICAqICAgaWYgKGN0eC5pc0ludmFsaWQpIHJldHVybiBjdHguYmxvY2soKTtcbiAgICpcbiAgICogICAvLyAuLi5cbiAgICogfVxuICAgKi9cbiAgYmxvY2soKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKCgpID0+IHtcbiAgICB9KTtcbiAgfVxuICAvKipcbiAgICogV3JhcHBlciBhcm91bmQgYHdpbmRvdy5zZXRJbnRlcnZhbGAgdGhhdCBhdXRvbWF0aWNhbGx5IGNsZWFycyB0aGUgaW50ZXJ2YWwgd2hlbiBpbnZhbGlkYXRlZC5cbiAgICpcbiAgICogSW50ZXJ2YWxzIGNhbiBiZSBjbGVhcmVkIGJ5IGNhbGxpbmcgdGhlIG5vcm1hbCBgY2xlYXJJbnRlcnZhbGAgZnVuY3Rpb24uXG4gICAqL1xuICBzZXRJbnRlcnZhbChoYW5kbGVyLCB0aW1lb3V0KSB7XG4gICAgY29uc3QgaWQgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICBpZiAodGhpcy5pc1ZhbGlkKSBoYW5kbGVyKCk7XG4gICAgfSwgdGltZW91dCk7XG4gICAgdGhpcy5vbkludmFsaWRhdGVkKCgpID0+IGNsZWFySW50ZXJ2YWwoaWQpKTtcbiAgICByZXR1cm4gaWQ7XG4gIH1cbiAgLyoqXG4gICAqIFdyYXBwZXIgYXJvdW5kIGB3aW5kb3cuc2V0VGltZW91dGAgdGhhdCBhdXRvbWF0aWNhbGx5IGNsZWFycyB0aGUgaW50ZXJ2YWwgd2hlbiBpbnZhbGlkYXRlZC5cbiAgICpcbiAgICogVGltZW91dHMgY2FuIGJlIGNsZWFyZWQgYnkgY2FsbGluZyB0aGUgbm9ybWFsIGBzZXRUaW1lb3V0YCBmdW5jdGlvbi5cbiAgICovXG4gIHNldFRpbWVvdXQoaGFuZGxlciwgdGltZW91dCkge1xuICAgIGNvbnN0IGlkID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICBpZiAodGhpcy5pc1ZhbGlkKSBoYW5kbGVyKCk7XG4gICAgfSwgdGltZW91dCk7XG4gICAgdGhpcy5vbkludmFsaWRhdGVkKCgpID0+IGNsZWFyVGltZW91dChpZCkpO1xuICAgIHJldHVybiBpZDtcbiAgfVxuICAvKipcbiAgICogV3JhcHBlciBhcm91bmQgYHdpbmRvdy5yZXF1ZXN0QW5pbWF0aW9uRnJhbWVgIHRoYXQgYXV0b21hdGljYWxseSBjYW5jZWxzIHRoZSByZXF1ZXN0IHdoZW5cbiAgICogaW52YWxpZGF0ZWQuXG4gICAqXG4gICAqIENhbGxiYWNrcyBjYW4gYmUgY2FuY2VsZWQgYnkgY2FsbGluZyB0aGUgbm9ybWFsIGBjYW5jZWxBbmltYXRpb25GcmFtZWAgZnVuY3Rpb24uXG4gICAqL1xuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoY2FsbGJhY2spIHtcbiAgICBjb25zdCBpZCA9IHJlcXVlc3RBbmltYXRpb25GcmFtZSgoLi4uYXJncykgPT4ge1xuICAgICAgaWYgKHRoaXMuaXNWYWxpZCkgY2FsbGJhY2soLi4uYXJncyk7XG4gICAgfSk7XG4gICAgdGhpcy5vbkludmFsaWRhdGVkKCgpID0+IGNhbmNlbEFuaW1hdGlvbkZyYW1lKGlkKSk7XG4gICAgcmV0dXJuIGlkO1xuICB9XG4gIC8qKlxuICAgKiBXcmFwcGVyIGFyb3VuZCBgd2luZG93LnJlcXVlc3RJZGxlQ2FsbGJhY2tgIHRoYXQgYXV0b21hdGljYWxseSBjYW5jZWxzIHRoZSByZXF1ZXN0IHdoZW5cbiAgICogaW52YWxpZGF0ZWQuXG4gICAqXG4gICAqIENhbGxiYWNrcyBjYW4gYmUgY2FuY2VsZWQgYnkgY2FsbGluZyB0aGUgbm9ybWFsIGBjYW5jZWxJZGxlQ2FsbGJhY2tgIGZ1bmN0aW9uLlxuICAgKi9cbiAgcmVxdWVzdElkbGVDYWxsYmFjayhjYWxsYmFjaywgb3B0aW9ucykge1xuICAgIGNvbnN0IGlkID0gcmVxdWVzdElkbGVDYWxsYmFjaygoLi4uYXJncykgPT4ge1xuICAgICAgaWYgKCF0aGlzLnNpZ25hbC5hYm9ydGVkKSBjYWxsYmFjayguLi5hcmdzKTtcbiAgICB9LCBvcHRpb25zKTtcbiAgICB0aGlzLm9uSW52YWxpZGF0ZWQoKCkgPT4gY2FuY2VsSWRsZUNhbGxiYWNrKGlkKSk7XG4gICAgcmV0dXJuIGlkO1xuICB9XG4gIGFkZEV2ZW50TGlzdGVuZXIodGFyZ2V0LCB0eXBlLCBoYW5kbGVyLCBvcHRpb25zKSB7XG4gICAgaWYgKHR5cGUgPT09IFwid3h0OmxvY2F0aW9uY2hhbmdlXCIpIHtcbiAgICAgIGlmICh0aGlzLmlzVmFsaWQpIHRoaXMubG9jYXRpb25XYXRjaGVyLnJ1bigpO1xuICAgIH1cbiAgICB0YXJnZXQuYWRkRXZlbnRMaXN0ZW5lcj8uKFxuICAgICAgdHlwZS5zdGFydHNXaXRoKFwid3h0OlwiKSA/IGdldFVuaXF1ZUV2ZW50TmFtZSh0eXBlKSA6IHR5cGUsXG4gICAgICBoYW5kbGVyLFxuICAgICAge1xuICAgICAgICAuLi5vcHRpb25zLFxuICAgICAgICBzaWduYWw6IHRoaXMuc2lnbmFsXG4gICAgICB9XG4gICAgKTtcbiAgfVxuICAvKipcbiAgICogQGludGVybmFsXG4gICAqIEFib3J0IHRoZSBhYm9ydCBjb250cm9sbGVyIGFuZCBleGVjdXRlIGFsbCBgb25JbnZhbGlkYXRlZGAgbGlzdGVuZXJzLlxuICAgKi9cbiAgbm90aWZ5SW52YWxpZGF0ZWQoKSB7XG4gICAgdGhpcy5hYm9ydChcIkNvbnRlbnQgc2NyaXB0IGNvbnRleHQgaW52YWxpZGF0ZWRcIik7XG4gICAgbG9nZ2VyLmRlYnVnKFxuICAgICAgYENvbnRlbnQgc2NyaXB0IFwiJHt0aGlzLmNvbnRlbnRTY3JpcHROYW1lfVwiIGNvbnRleHQgaW52YWxpZGF0ZWRgXG4gICAgKTtcbiAgfVxuICBzdG9wT2xkU2NyaXB0cygpIHtcbiAgICB3aW5kb3cucG9zdE1lc3NhZ2UoXG4gICAgICB7XG4gICAgICAgIHR5cGU6IENvbnRlbnRTY3JpcHRDb250ZXh0LlNDUklQVF9TVEFSVEVEX01FU1NBR0VfVFlQRSxcbiAgICAgICAgY29udGVudFNjcmlwdE5hbWU6IHRoaXMuY29udGVudFNjcmlwdE5hbWUsXG4gICAgICAgIG1lc3NhZ2VJZDogTWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMilcbiAgICAgIH0sXG4gICAgICBcIipcIlxuICAgICk7XG4gIH1cbiAgdmVyaWZ5U2NyaXB0U3RhcnRlZEV2ZW50KGV2ZW50KSB7XG4gICAgY29uc3QgaXNTY3JpcHRTdGFydGVkRXZlbnQgPSBldmVudC5kYXRhPy50eXBlID09PSBDb250ZW50U2NyaXB0Q29udGV4dC5TQ1JJUFRfU1RBUlRFRF9NRVNTQUdFX1RZUEU7XG4gICAgY29uc3QgaXNTYW1lQ29udGVudFNjcmlwdCA9IGV2ZW50LmRhdGE/LmNvbnRlbnRTY3JpcHROYW1lID09PSB0aGlzLmNvbnRlbnRTY3JpcHROYW1lO1xuICAgIGNvbnN0IGlzTm90RHVwbGljYXRlID0gIXRoaXMucmVjZWl2ZWRNZXNzYWdlSWRzLmhhcyhldmVudC5kYXRhPy5tZXNzYWdlSWQpO1xuICAgIHJldHVybiBpc1NjcmlwdFN0YXJ0ZWRFdmVudCAmJiBpc1NhbWVDb250ZW50U2NyaXB0ICYmIGlzTm90RHVwbGljYXRlO1xuICB9XG4gIGxpc3RlbkZvck5ld2VyU2NyaXB0cyhvcHRpb25zKSB7XG4gICAgbGV0IGlzRmlyc3QgPSB0cnVlO1xuICAgIGNvbnN0IGNiID0gKGV2ZW50KSA9PiB7XG4gICAgICBpZiAodGhpcy52ZXJpZnlTY3JpcHRTdGFydGVkRXZlbnQoZXZlbnQpKSB7XG4gICAgICAgIHRoaXMucmVjZWl2ZWRNZXNzYWdlSWRzLmFkZChldmVudC5kYXRhLm1lc3NhZ2VJZCk7XG4gICAgICAgIGNvbnN0IHdhc0ZpcnN0ID0gaXNGaXJzdDtcbiAgICAgICAgaXNGaXJzdCA9IGZhbHNlO1xuICAgICAgICBpZiAod2FzRmlyc3QgJiYgb3B0aW9ucz8uaWdub3JlRmlyc3RFdmVudCkgcmV0dXJuO1xuICAgICAgICB0aGlzLm5vdGlmeUludmFsaWRhdGVkKCk7XG4gICAgICB9XG4gICAgfTtcbiAgICBhZGRFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCBjYik7XG4gICAgdGhpcy5vbkludmFsaWRhdGVkKCgpID0+IHJlbW92ZUV2ZW50TGlzdGVuZXIoXCJtZXNzYWdlXCIsIGNiKSk7XG4gIH1cbn1cbiJdLCJuYW1lcyI6WyJkZWZpbml0aW9uIiwicmVzdWx0IiwiYnJvd3NlciIsIl9icm93c2VyIiwicHJpbnQiLCJsb2dnZXIiXSwibWFwcGluZ3MiOiI7O0FBQU8sV0FBUyxvQkFBb0JBLGFBQVk7QUFDOUMsV0FBT0E7QUFBQSxFQUNUO0FDR0EsUUFBQSxhQUFlLG9CQUFvQjtBQUFBLElBQ2pDLFNBQVMsQ0FBQyxZQUFZO0FBQUEsSUFDdEIsTUFBTSxNQUFNO0FBQ1YsY0FBUSxJQUFJLHVDQUF1QyxPQUFPLFNBQVMsSUFBSTtBQUUzRSxVQUFJLGlCQUFpQjtBQUNyQixVQUFJLGtCQUFrQjtBQUd0QixVQUFJLGFBQWE7QUFDakIsVUFBSSxhQUFhO0FBQ2pCLFVBQUksYUFBYTtBQUNqQixVQUFJLGVBQWU7QUFDbkIsVUFBSSxlQUFlO0FBR25CLFVBQUksZUFBZTtBQUVuQixVQUFJLGNBQWMsQ0FBQTtBQUNsQixVQUFJLGNBQWM7QUFDbEIsVUFBSSw0QkFBNEI7QUFDaEMsVUFBSSx1QkFBdUI7QUFDM0IsVUFBSSxvQkFBb0I7QUFDeEIsVUFBSSx5QkFBeUI7QUFHN0IsZUFBUyxzQkFBc0IsUUFBUSxFQUFFLFFBQVEsRUFBQyxJQUFLLENBQUEsR0FBSTtBQUN2RCxZQUFJO0FBRUEsZ0JBQU0sWUFBWSxLQUFLLE1BQU07QUFDN0IsZ0JBQU0sY0FBYyxJQUFJLFlBQVksVUFBVSxNQUFNO0FBQ3BELGdCQUFNLGFBQWEsSUFBSSxXQUFXLFdBQVc7QUFDN0MsbUJBQVMsSUFBSSxHQUFHLElBQUksVUFBVSxRQUFRLEtBQUs7QUFDdkMsdUJBQVcsQ0FBQyxJQUFJLFVBQVUsV0FBVyxDQUFDO0FBQUEsVUFD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QUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtB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VUFBVSxTQUFTO0FBQ3JDLFlBQU0sS0FBSyxvQkFBb0IsSUFBSSxTQUFTO0FBQzFDLFlBQUksQ0FBQyxLQUFLLE9BQU8sUUFBUyxVQUFTLEdBQUcsSUFBSTtBQUFBLE1BQzVDLEdBQUcsT0FBTztBQUNWLFdBQUssY0FBYyxNQUFNLG1CQUFtQixFQUFFLENBQUM7QUFDL0MsYUFBTztBQUFBLElBQ1Q7QUFBQSxJQUNBLGlCQUFpQixRQUFRLE1BQU0sU0FBUyxTQUFTO0FBQy9DLFVBQUksU0FBUyxzQkFBc0I7QUFDakMsWUFBSSxLQUFLLFFBQVMsTUFBSyxnQkFBZ0IsSUFBRztBQUFBLE1BQzVDO0FBQ0EsYUFBTztBQUFBLFFBQ0wsS0FBSyxXQUFXLE1BQU0sSUFBSSxtQkFBbUIsSUFBSSxJQUFJO0FBQUEsUUFDckQ7QUFBQSxRQUNBO0FBQUEsVUFDRSxHQUFHO0FBQUEsVUFDSCxRQUFRLEtBQUs7QUFBQSxRQUNyQjtBQUFBLE1BQ0E7QUFBQSxJQUNFO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxJQUtBLG9CQUFvQjtBQUNsQixXQUFLLE1BQU0sb0NBQW9DO0FBQy9DQyxlQUFPO0FBQUEsUUFDTCxtQkFBbUIsS0FBSyxpQkFBaUI7QUFBQSxNQUMvQztBQUFBLElBQ0U7QUFBQSxJQUNBLGlCQUFpQjtBQUNmLGFBQU87QUFBQSxRQUNMO0FBQUEsVUFDRSxNQUFNLHFCQUFxQjtBQUFBLFVBQzNCLG1CQUFtQixLQUFLO0FBQUEsVUFDeEIsV0FBVyxLQUFLLE9BQU0sRUFBRyxTQUFTLEVBQUUsRUFBRSxNQUFNLENBQUM7QUFBQSxRQUNyRDtBQUFBLFFBQ007QUFBQSxNQUNOO0FBQUEsSUFDRTtBQUFBLElBQ0EseUJBQXlCLE9BQU87QUFDOUIsWUFBTSx1QkFBdUIsTUFBTSxNQUFNLFNBQVMscUJBQXFCO0FBQ3ZFLFlBQU0sc0JBQXNCLE1BQU0sTUFBTSxzQkFBc0IsS0FBSztBQUNuRSxZQUFNLGlCQUFpQixDQUFDLEtBQUssbUJBQW1CLElBQUksTUFBTSxNQUFNLFNBQVM7QUFDekUsYUFBTyx3QkFBd0IsdUJBQXVCO0FBQUEsSUFDeEQ7QUFBQSxJQUNBLHNCQUFzQixTQUFTO0FBQzdCLFVBQUksVUFBVTtBQUNkLFlBQU0sS0FBSyxDQUFDLFVBQVU7QUFDcEIsWUFBSSxLQUFLLHlCQUF5QixLQUFLLEdBQUc7QUFDeEMsZUFBSyxtQkFBbUIsSUFBSSxNQUFNLEtBQUssU0FBUztBQUNoRCxnQkFBTSxXQUFXO0FBQ2pCLG9CQUFVO0FBQ1YsY0FBSSxZQUFZLFNBQVMsaUJBQWtCO0FBQzNDLGVBQUssa0JBQWlCO0FBQUEsUUFDeEI7QUFBQSxNQUNGO0FBQ0EsdUJBQWlCLFdBQVcsRUFBRTtBQUM5QixXQUFLLGNBQWMsTUFBTSxvQkFBb0IsV0FBVyxFQUFFLENBQUM7QUFBQSxJQUM3RDtBQUFBLEVBQ0Y7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OzsiLCJ4X2dvb2dsZV9pZ25vcmVMaXN0IjpbMCwyLDMsNCw1LDYsN119
content;