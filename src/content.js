// content.js - the content scripts which is run in the context of web pages, and has access
// to the DOM and other web APIs. Handles the floating TTS player and text extraction.

// Floating player state
let floatingPlayer = null;
let isPlayerVisible = false;

// Global audio element for current playback
let currentAudio = null;
// Streaming TTS state
let audioQueue = [];
let isStreaming = false;
let streamChunksReceived = 0;
let totalStreamChunks = 0;

// Context menu TTS state
let contextMenuAudio = null;
let isContextMenuPlaying = false;

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case 'GET_SELECTION':
            sendResponse({ text: getSelectedText() });
            break;

        case 'GET_PAGE_TEXT':
            sendResponse({ text: getPageText() });
            break;

        case 'TOGGLE_PLAYER':
            toggleFloatingPlayer();
            sendResponse({ success: true });
            break;

        default:
            sendResponse({ success: false, error: 'Unknown message type' });
    }
    return true; // Keep channel open for async response
});

// Handle context menu TTS messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[VoxLocal] Received context menu message:', message);
    switch (message.action) {
        case 'context_menu_chunk':
            handleContextMenuChunk(message);
            break;

        case 'context_menu_complete':
            handleContextMenuComplete();
            break;

        case 'context_menu_error':
            handleContextMenuError(message.error);
            break;
    }
    return true;
});


// Handle messages from background for streaming TTS
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
        case 'stream_chunk':
            // Immediately discard chunks if not streaming
            if (!isStreaming) {
                console.log(`[VoxLocal] Discarding late streaming chunk ${message.chunkIndex + 1}/${message.totalChunks} - streaming stopped`);
                return;
            }

            console.log(`[VoxLocal] Received streaming chunk ${message.chunkIndex + 1}/${message.totalChunks}`);
            streamChunksReceived = message.chunkIndex + 1;
            totalStreamChunks = message.totalChunks;

            // Add chunk to queue
            audioQueue.push(message);
            console.log(`[VoxLocal] Added chunk to queue. Queue now has ${audioQueue.length} chunks`);

            // Update status
            updateStatus(`Processing chunks: ${streamChunksReceived}/${totalStreamChunks} received`, 'loading');

            // If this is the first chunk OR no audio is currently playing, start playing
            if (streamChunksReceived === 1 || !currentAudio) {
                console.log(`[VoxLocal] Starting playback - first chunk or no current audio playing`);
                playNextAudioChunk();
            }

            break;

        case 'stream_complete':
            console.log('[VoxLocal] Streaming complete');
            isStreaming = false;

            // If no chunks are currently playing, update status
            if (!currentAudio) {
                updateStatus('Ready', 'ready');
                updateButtonStates();
            }

            break;

        case 'stream_error':
            console.error('[VoxLocal] Streaming error:', message.error);
            updateStatus('Streaming error: ' + message.error, 'error');
            resetStreamingState();
            break;
    }
});

// Handle context menu chunk playback
function handleContextMenuChunk(chunkResult) {
    console.log(`[VoxLocal] Received context menu chunk ${chunkResult.chunkIndex + 1}/${chunkResult.totalChunks}`);

    if (isPlayerVisible) {
        // If floating player is visible, integrate with existing streaming state
        if (!isStreaming && !isContextMenuPlaying) {
            // Start context menu streaming session
            isContextMenuPlaying = true;
            updateStatus(`Context menu: Playing chunk 1/${chunkResult.totalChunks}`, 'speaking');
            updateButtonStates();
        }

        // Add to queue and play if nothing is currently playing
        audioQueue.push(chunkResult);
        if (!currentAudio) {
            playNextContextMenuChunk();
        }
    } else {
        // Floating player not visible, play directly
        playContextMenuChunkDirectly(chunkResult);
    }
}

// Handle context menu completion
function handleContextMenuComplete() {
    console.log('[VoxLocal] Context menu streaming complete');
    isContextMenuPlaying = false;

    if (isPlayerVisible && !currentAudio) {
        updateStatus('Ready', 'ready');
        updateButtonStates();
    }
}

// Handle context menu error
function handleContextMenuError(error) {
    console.error('[VoxLocal] Context menu error:', error);
    isContextMenuPlaying = false;

    if (isPlayerVisible) {
        updateStatus('Context menu error: ' + error, 'error');
        updateButtonStates();
    }
}

// Play next context menu chunk when floating player is visible
function playNextContextMenuChunk() {
    if (audioQueue.length === 0) {
        if (isContextMenuPlaying) {
            updateStatus('Context menu: waiting for next chunk...', 'speaking');
        } else {
            updateStatus('Ready', 'ready');
            updateButtonStates();
        }
        return;
    }

    const chunk = audioQueue.shift();
    console.log(`[VoxLocal] Playing context menu chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks}`);

    updateStatus(`Context menu: Playing chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks}`, 'speaking');

    try {
        const audioData = atob(chunk.audio);
        const arrayBuffer = new ArrayBuffer(audioData.length);
        const uint8Array = new Uint8Array(arrayBuffer);
        for (let i = 0; i < audioData.length; i++) {
            uint8Array[i] = audioData.charCodeAt(i);
        }

        const blob = new Blob([uint8Array], { type: 'audio/wav' });
        const audioUrl = URL.createObjectURL(blob);

        currentAudio = new Audio(audioUrl);
        currentAudio.playbackRate = chunk.speed || 1;

        currentAudio.onended = () => {
            console.log(`[VoxLocal] Context menu chunk ${chunk.chunkIndex + 1} playback completed`);
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            playNextContextMenuChunk();
        };

        currentAudio.onerror = (error) => {
            console.error('[VoxLocal] Context menu chunk playback error:', error);
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            updateStatus('Error playing context menu chunk', 'error');
        };

        console.log('[VoxLocal] Starting context menu chunk audio playback...');
        currentAudio.play().catch((error) => {
            console.error('[VoxLocal] Context menu chunk play failed:', error.message);
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            updateStatus('Error: ' + error.message, 'error');
        });

    } catch (error) {
        console.error('[VoxLocal] Error creating context menu chunk audio:', error);
        updateStatus('Error: ' + error.message, 'error');
    }
}

// Play context menu chunk directly when floating player is not visible
function playContextMenuChunkDirectly(chunkResult) {
    console.log(`[VoxLocal] Playing context menu chunk ${chunkResult.chunkIndex + 1}/${chunkResult.totalChunks} directly`);

    try {
        const audioData = atob(chunkResult.audio);
        const arrayBuffer = new ArrayBuffer(audioData.length);
        const uint8Array = new Uint8Array(arrayBuffer);
        for (let i = 0; i < audioData.length; i++) {
            uint8Array[i] = audioData.charCodeAt(i);
        }

        const blob = new Blob([uint8Array], { type: 'audio/wav' });
        const audioUrl = URL.createObjectURL(blob);

        if (contextMenuAudio) {
            contextMenuAudio.pause();
            contextMenuAudio = null;
        }

        contextMenuAudio = new Audio(audioUrl);
        contextMenuAudio.playbackRate = chunkResult.speed || 1;

        contextMenuAudio.onended = () => {
            console.log(`[VoxLocal] Direct context menu chunk ${chunkResult.chunkIndex + 1} playback completed`);
            URL.revokeObjectURL(audioUrl);
            contextMenuAudio = null;
        };

        contextMenuAudio.onerror = (error) => {
            console.error('[VoxLocal] Direct context menu chunk playback error:', error);
            URL.revokeObjectURL(audioUrl);
            contextMenuAudio = null;
        };

        contextMenuAudio.play().catch((error) => {
            console.error('[VoxLocal] Direct context menu chunk play failed:', error.message);
            URL.revokeObjectURL(audioUrl);
            contextMenuAudio = null;
        });

    } catch (error) {
        console.error('[VoxLocal] Error creating direct context menu chunk audio:', error);
    }
}

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
            <h1>🎙️ VoxLocal</h1>
            <button class="voxlocal-close-btn" title="Close">&times;</button>
        </div>
        <div class="voxlocal-status-section">
            <div id="voxlocal-status" class="status-badge ready">Ready</div>
            <div id="voxlocal-model-status" class="model-status">Model not loaded</div>
        </div>
        <div class="voxlocal-controls">
            <button id="voxlocal-speak-selection" class="btn btn-primary" title="Speak selected text">
                <span class="icon">📖</span> Speak Selection
            </button>
            <button id="voxlocal-speak-page" class="btn btn-primary" title="Speak entire page">
                <span class="icon">📄</span> Speak Page
            </button>
            <button id="voxlocal-speak-btn" class="btn btn-primary" title="Speak entered text">
                <span class="icon">🔊</span> Speak Text
            </button>
            <button id="voxlocal-stop-btn" class="btn btn-danger" disabled title="Stop speaking">
                <span class="icon">⏹️</span> Stop
            </button>
        </div>
        <div class="voxlocal-input-section">
            <textarea id="voxlocal-text" placeholder="Enter text to speak..." rows="3"></textarea>
        </div>
        <div class="voxlocal-settings">
            <h3>Voice Settings</h3>
            <div class="setting-group">
                <label for="voxlocal-voice-select">Voice:</label>
                <select id="voxlocal-voice-select">
                    <option value="af_heart">Heart (Female)</option>
                    <option value="af_bella">Bella (Female)</option>
                    <option value="am_michael">Michael (Male)</option>
                    <option value="am_fenrir">Fenrir (Male)</option>
                    <option value="bf_emma">Emma (British Female)</option>
                    <option value="bm_george">George (British Male)</option>
                </select>
            </div>
            <div class="setting-group">
                <label for="voxlocal-speed-slider">Speed: <span id="voxlocal-speed-value">1.0</span>x</label>
                <input type="range" id="voxlocal-speed-slider" min="0.5" max="2.0" step="0.1" value="1.0">
            </div>
            <div class="setting-group">
                <label for="voxlocal-dtype">Model Quality:</label>
                <select id="voxlocal-dtype">
                    <option value="fp32">FP32 (Highest Quality)</option>
                    <option value="fp16">FP16 (High Quality)</option>
                    <option value="q8">Q8 (Balanced)</option>
                    <option value="q4">Q4 (Fast)</option>
                    <option value="q4f16">Q4F16 (Balanced)</option>
                </select>
            </div>
            <div class="setting-group">
                <label for="voxlocal-device">Device:</label>
                <select id="voxlocal-device">
                    <option value="webgpu">WebGPU (GPU)</option>
                    <option value="wasm">WASM (CPU)</option>
                </select>
                <small id="voxlocal-device-note" class="setting-note">WebGPU requires FP32 precision</small>
            </div>
            <div class="setting-group">
                <label>
                    <input type="checkbox" id="voxlocal-auto-highlight">
                    Highlight text while speaking
                </label>
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
    queryModelStatus();
}

// Inject CSS styles for the floating player
function injectPlayerStyles() {
    const style = document.createElement('style');
    style.textContent = `
        #voxlocal-floating-player {
            position: fixed;
            top: 20px;
            right: 20px;
            width: 320px;
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
            padding: 16px 16px 12px 16px;
            border-bottom: 1px solid #dee2e6;
        }

        .voxlocal-header h1 {
            margin: 0;
            font-size: 18px;
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
            gap: 8px;
            margin: 16px;
        }

        .status-badge {
            padding: 6px 12px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 500;
            text-align: center;
        }

        .status-badge.ready { background-color: #28a745; color: white; }
        .status-badge.loading { background-color: #ffc107; color: black; }
        .status-badge.speaking { background-color: #007bff; color: white; }
        .status-badge.error { background-color: #dc3545; color: white; }

        .model-status {
            font-size: 11px;
            color: #6c757d;
            text-align: center;
        }

        .voxlocal-controls {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin: 0 16px 20px 16px;
        }

        .btn {
            padding: 10px 16px;
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
        }

        .btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .btn-primary { background-color: #007bff; color: white; }
        .btn-primary:hover:not(:disabled) { background-color: #0056b3; }
        .btn-danger { background-color: #dc3545; color: white; }
        .btn-danger:hover:not(:disabled) { background-color: #c82333; }

        .icon { font-size: 16px; }

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
            margin: 0 16px 16px 16px;
            padding-top: 16px;
            border-top: 1px solid #dee2e6;
        }

        .voxlocal-settings h3 {
            margin: 0 0 12px 0;
            font-size: 14px;
            font-weight: 600;
            color: #212529;
        }

        .setting-group {
            margin-bottom: 12px;
        }

        .setting-group label {
            display: block;
            margin-bottom: 4px;
            font-size: 13px;
            font-weight: 500;
            color: #212529;
        }

        .setting-group select,
        .setting-group input[type="range"] {
            width: 100%;
            padding: 6px 8px;
            border: 1px solid #dee2e6;
            border-radius: 4px;
            font-size: 13px;
            background: white;
            box-sizing: border-box;
        }

        .setting-group input[type="checkbox"] {
            margin-right: 6px;
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

    // Speed slider
    const speedSlider = document.getElementById('voxlocal-speed-slider');
    const speedValue = document.getElementById('voxlocal-speed-value');
    speedSlider.addEventListener('input', (event) => {
        speedValue.textContent = `${event.target.value}x`;
    });

    // Buttons
    document.getElementById('voxlocal-speak-selection').addEventListener('click', () => speakFromPage('selection'));
    document.getElementById('voxlocal-speak-page').addEventListener('click', () => speakFromPage('page'));
    document.getElementById('voxlocal-speak-btn').addEventListener('click', speakText);
    document.getElementById('voxlocal-stop-btn').addEventListener('click', stopPlayback);

    // Settings change listeners
    const deviceSelect = document.getElementById('voxlocal-device');
    const dtypeSelect = document.getElementById('voxlocal-dtype');
    const voiceSelect = document.getElementById('voxlocal-voice-select');
    const autoHighlightCheckbox = document.getElementById('voxlocal-auto-highlight');

    dtypeSelect.addEventListener('change', saveSettings);
    deviceSelect.addEventListener('change', () => {
        handleDeviceChange();
    });
    voiceSelect.addEventListener('change', saveSettings);
    speedSlider.addEventListener('change', saveSettings);
    autoHighlightCheckbox.addEventListener('change', saveSettings);
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
            updateModelStatus('Model status unknown');
            return;
        }

        if (response && response.loaded) {
            const modelName = response.modelName ? ` (${response.modelName})` : '';
            updateModelStatus(`Model loaded${modelName}`);
        } else {
            updateModelStatus('Model will load on first use');
        }
    });
}

// Function to send text to streaming TTS for speech generation
function sendStreamingTTS(text, voice, speed) {
    // Reset streaming state
    audioQueue = [];
    isStreaming = true;
    streamChunksReceived = 0;
    totalStreamChunks = 0;

    // Update button states for streaming
    updateButtonStates();

    updateStatus('Starting streaming speech (processing in chunks)...', 'loading');

    // Send message to background script for streaming
    const message = {
        action: 'speak_stream',
        text: text,
        voice: voice,
        speed: speed,
        dtype: document.getElementById('voxlocal-dtype').value,
        device: document.getElementById('voxlocal-device').value
    };

    console.log(`[VoxLocal] Sending streaming speak message to background script - text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}", voice: ${voice}, speed: ${speed}x, dtype: ${message.dtype}, device: ${message.device}`);

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

// Function to send text to TTS for speech generation
function sendToTTS(text, voice, speed, loadingMessage = 'Generating speech...') {
    // Disable buttons and show loading
    document.getElementById('voxlocal-speak-btn').disabled = true;
    document.getElementById('voxlocal-stop-btn').disabled = false;
    document.getElementById('voxlocal-speak-selection').disabled = true;
    document.getElementById('voxlocal-speak-page').disabled = true;

    updateStatus(loadingMessage, 'loading');

    // Send message to background script
    const message = {
        action: 'speak',
        text: text,
        voice: voice,
        speed: speed,
        dtype: document.getElementById('voxlocal-dtype').value,
        device: document.getElementById('voxlocal-device').value
    };

    console.log(`[VoxLocal] Sending speak message to background script - text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}", voice: ${voice}, speed: ${speed}x, dtype: ${message.dtype}, device: ${message.device}`);

    chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
            console.error('[VoxLocal] Runtime error:', chrome.runtime.lastError);
            updateStatus('Error: ' + chrome.runtime.lastError.message, 'error');
            resetButtons();
            return;
        }

        if (response && response.audio) {
            console.log(`[VoxLocal] Received audio response (${(response.audio.length / 1024).toFixed(2)} KB, ${response.sampleRate}Hz, voice: ${response.voice})`);
            playAudio(response);
        } else {
            console.error('[VoxLocal] No audio received in response');
            updateStatus('Error: No audio received', 'error');
            resetButtons();
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

// Speak text from textarea
function speakText() {
    const text = document.getElementById('voxlocal-text').value.trim();
    if (!text) {
        console.log('[VoxLocal] Speak button clicked but no text entered');
        updateStatus('Please enter some text to speak', 'error');
        return;
    }

    const voice = document.getElementById('voxlocal-voice-select').value;
    const speed = parseFloat(document.getElementById('voxlocal-speed-slider').value);

    console.log(`[VoxLocal] Speak button clicked - text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}", voice: ${voice}, speed: ${speed}x`);

    // Send to streaming TTS
    sendStreamingTTS(text, voice, speed);
}

// Stop playback
function stopPlayback() {
    console.log('[VoxLocal] Stop button clicked');
    if (currentAudio) {
        console.log('[VoxLocal] Stopping current audio playback');
        currentAudio.pause();
        currentAudio = null;
    }

    // Stop context menu audio if playing
    if (contextMenuAudio) {
        console.log('[VoxLocal] Stopping context menu audio playback');
        contextMenuAudio.pause();
        contextMenuAudio = null;
        isContextMenuPlaying = false;
    }

    // Cancel streaming if active
    if (isStreaming) {
        console.log('[VoxLocal] Cancelling active streaming request');
        cancelStreamingTTS();
        resetStreamingState();
    } else if (!isContextMenuPlaying) {
        resetButtons();
    }

    updateStatus('Stopped', 'ready');
}

// Play audio from base64 data
function playAudio(response) {
    try {
        console.log('[VoxLocal] Converting base64 audio to playable format...');
        // Convert base64 back to audio
        const audioData = atob(response.audio);
        const arrayBuffer = new ArrayBuffer(audioData.length);
        const uint8Array = new Uint8Array(arrayBuffer);
        for (let i = 0; i < audioData.length; i++) {
            uint8Array[i] = audioData.charCodeAt(i);
        }

        const blob = new Blob([uint8Array], { type: 'audio/wav' });
        const audioUrl = URL.createObjectURL(blob);

        currentAudio = new Audio(audioUrl);
        currentAudio.playbackRate = response.speed || 1;
        console.log(`[VoxLocal] Audio element created with playback rate: ${currentAudio.playbackRate}x`);

        currentAudio.onloadedmetadata = () => {
            console.log(`[VoxLocal] Audio loaded - duration: ${currentAudio.duration.toFixed(2)}s`);
            updateStatus('Speaking', 'speaking');
            document.getElementById('voxlocal-speak-btn').disabled = true;
            document.getElementById('voxlocal-stop-btn').disabled = false;
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

// Reset button states
function resetButtons() {
    document.getElementById('voxlocal-speak-btn').disabled = false;
    document.getElementById('voxlocal-stop-btn').disabled = true;
    document.getElementById('voxlocal-speak-selection').disabled = false;
    document.getElementById('voxlocal-speak-page').disabled = false;
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

// Update model status display
function updateModelStatus(message) {
    const modelStatusElement = document.getElementById('voxlocal-model-status');
    if (modelStatusElement) {
        modelStatusElement.textContent = message;
    }
}

// Reset streaming state
function resetStreamingState() {
    audioQueue = [];
    isStreaming = false;
    streamChunksReceived = 0;
    totalStreamChunks = 0;
    // Also reset context menu state
    isContextMenuPlaying = false;
    if (contextMenuAudio) {
        contextMenuAudio.pause();
        contextMenuAudio = null;
    }
    updateButtonStates();
}

// Update button states based on streaming and context menu status
function updateButtonStates() {
    if (isStreaming || isContextMenuPlaying) {
        // During streaming or context menu playback, disable all speak buttons, enable stop
        document.getElementById('voxlocal-speak-btn').disabled = true;
        document.getElementById('voxlocal-speak-selection').disabled = true;
        document.getElementById('voxlocal-speak-page').disabled = true;
        document.getElementById('voxlocal-stop-btn').disabled = false;
    } else {
        // Normal state
        resetButtons();
    }
}

// Play next audio chunk from queue
function playNextAudioChunk() {
    console.log(`[VoxLocal] playNextAudioChunk called. Queue length: ${audioQueue.length}, isStreaming: ${isStreaming}, currentAudio: ${!!currentAudio}`);

    if (audioQueue.length === 0) {
        if (isStreaming) {
            updateStatus('Streaming: waiting for next chunk...', 'loading');
        } else {
            updateStatus('Ready', 'ready');
            resetButtons();
        }
        return;
    }

    const chunk = audioQueue.shift();
    console.log(`[VoxLocal] Playing audio chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks}. Remaining queue: ${audioQueue.length}`);

    updateStatus(`Playing chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks} (streaming)`, 'speaking');

    try {
        // Convert base64 back to audio
        const audioData = atob(chunk.audio);
        const arrayBuffer = new ArrayBuffer(audioData.length);
        const uint8Array = new Uint8Array(arrayBuffer);
        for (let i = 0; i < audioData.length; i++) {
            uint8Array[i] = audioData.charCodeAt(i);
        }

        const blob = new Blob([uint8Array], { type: 'audio/wav' });
        const audioUrl = URL.createObjectURL(blob);

        currentAudio = new Audio(audioUrl);
        currentAudio.playbackRate = chunk.speed || 1;

        currentAudio.onended = () => {
            console.log(`[VoxLocal] Chunk ${chunk.chunkIndex + 1} playback completed`);
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            // Play next chunk
            console.log(`[VoxLocal] Calling playNextAudioChunk after chunk completion`);
            playNextAudioChunk();
        };

        currentAudio.onerror = (error) => {
            console.error('[VoxLocal] Audio chunk playback error:', error);
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            resetStreamingState();
            updateStatus('Error playing audio chunk', 'error');
        };

        console.log('[VoxLocal] Starting chunk audio playback...');
        currentAudio.play().then(() => {
            console.log(`[VoxLocal] Chunk ${chunk.chunkIndex + 1} started playing successfully`);
        }).catch((error) => {
            console.error('[VoxLocal] Audio chunk play failed:', error.message);
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
        dtype: document.getElementById('voxlocal-dtype').value,
        device: document.getElementById('voxlocal-device').value,
        voice: document.getElementById('voxlocal-voice-select').value,
        speed: parseFloat(document.getElementById('voxlocal-speed-slider').value),
        autoHighlight: document.getElementById('voxlocal-auto-highlight').checked
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
        document.getElementById('voxlocal-device').value = settings.device || 'webgpu';
        document.getElementById('voxlocal-dtype').value = settings.dtype || 'fp32';
        document.getElementById('voxlocal-voice-select').value = settings.voice || 'af_heart';
        document.getElementById('voxlocal-speed-slider').value = settings.speed || 1.0;
        document.getElementById('voxlocal-speed-value').textContent = `${document.getElementById('voxlocal-speed-slider').value}x`;
        document.getElementById('voxlocal-auto-highlight').checked = settings.autoHighlight || false;

        // Apply WebGPU constraint - must use FP32
        handleDeviceChange();

        console.log('[VoxLocal] Settings loaded:', settings);
    } catch (error) {
        console.error('[VoxLocal] Error loading settings:', error);
        // Set defaults if loading fails
        document.getElementById('voxlocal-device').value = 'webgpu';
        document.getElementById('voxlocal-dtype').value = 'fp32';
        document.getElementById('voxlocal-voice-select').value = 'af_heart';
        document.getElementById('voxlocal-speed-slider').value = 1.0;
        document.getElementById('voxlocal-speed-value').textContent = '1.0x';
        document.getElementById('voxlocal-auto-highlight').checked = false;

        // Apply WebGPU constraint
        handleDeviceChange();
    }
}

// Function to handle device changes - WebGPU requires FP32
function handleDeviceChange() {
    const deviceSelect = document.getElementById('voxlocal-device');
    const dtypeSelect = document.getElementById('voxlocal-dtype');

    if (deviceSelect.value === 'webgpu') {
        dtypeSelect.value = 'fp32';
        dtypeSelect.disabled = true;
        console.log('[VoxLocal] WebGPU selected - forcing FP32 dtype');
    } else {
        dtypeSelect.disabled = false;
        console.log('[VoxLocal] WASM selected - dtype selection enabled');
    }
    saveSettings(); // Save the updated settings
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
