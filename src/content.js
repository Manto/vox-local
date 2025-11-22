// content.js - the content scripts which is run in the context of web pages, and has access
// to the DOM and other web APIs. Handles the floating TTS player and text extraction.

// Floating player state
let floatingPlayer = null;
let isPlayerVisible = false;

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

// Context menu TTS state
let contextMenuAudio = null;
let contextMenuDirectQueue = []; // Queue for direct playback when floating player is hidden
let isContextMenuPlaying = false;
let isContextMenuGenerationComplete = false;
let contextMenuSessionId = 0; // Increment to cancel previous sessions
let isContextMenuCancelled = false; // Flag to prevent new chunks from starting playback

// Audio queue for context menu playback
let audioQueue = [];

// Listen for messages from background script - consolidated single listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Handle type-based messages (legacy/floating player control)
    if (message.type) {
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
    }

    // Handle action-based messages (TTS and context menu)
    if (message.action) {
        console.log('[VoxLocal] Received action message:', message);

        switch (message.action) {
            // Context menu messages - unified handling
            case 'context_menu_single':
            case 'context_menu_chunk':
                handleContextMenuAudio(message);
                break;

            case 'context_menu_complete':
                handleContextMenuComplete();
                break;

            case 'context_menu_error':
                handleContextMenuError(message.error);
                break;

            // Streaming TTS messages
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

// Handle context menu audio (unified for single and chunk messages)
function handleContextMenuAudio(audioResult) {
    const isChunk = audioResult.chunkIndex !== undefined;
    console.log(`[VoxLocal] 🔄 RECEIVED context menu ${isChunk ? 'chunk' : 'single'} audio from background (session: ${audioResult.sessionId})`);
    console.log(`[VoxLocal] 📝 Context menu ${isChunk ? `chunk ${audioResult.chunkIndex + 1}/${audioResult.totalChunks}` : 'single'} text: "${audioResult.text ? audioResult.text.substring(0, 100) + (audioResult.text.length > 100 ? '...' : '') : 'N/A'}"`);

    // Check if this audio belongs to the current session and we're not cancelled
    // Only check session mismatch when an active session exists (contextMenuSessionId is truthy)
    if ((contextMenuSessionId && audioResult.sessionId !== contextMenuSessionId) || isContextMenuCancelled) {
        console.log(`[VoxLocal] 🚫 Ignoring context menu ${isChunk ? 'chunk' : 'single'} audio - session mismatch (${audioResult.sessionId} vs ${contextMenuSessionId}) or cancelled (${isContextMenuCancelled})`);
        return;
    }

    // If streaming is active or context menu is playing, stop current playback first
    if (isStreaming || isContextMenuPlaying || currentAudio) {
        console.log(`[VoxLocal] 🛑 Stopping current playback before starting context menu ${isChunk ? 'chunk' : 'single'}`);
        stopPlayback();
    }

    // Set generation complete flag - for single audio it's already complete, for chunks it will be set by complete message
    if (!isChunk) {
        isContextMenuGenerationComplete = true;
    }

    if (isPlayerVisible) {
        console.log(`[VoxLocal] 🖥️ Floating player visible, integrating ${isChunk ? 'chunk' : 'single'} audio with state`);
        // Start context menu playback session if not already started
        if (!isContextMenuPlaying) {
            console.log(`[VoxLocal] 🎯 Starting context menu ${isChunk ? 'chunk' : 'single'} audio session`);
            contextMenuSessionId = audioResult.sessionId; // Set current session ID
            isContextMenuPlaying = true;
            isContextMenuCancelled = false; // Reset cancelled flag for new session
            updateStatus(isChunk ? `Context menu: Playing chunk 1/${audioResult.totalChunks}` : 'Context menu: Speaking', 'speaking');
            updateButtonStates();
        }

        // Add to queue and play immediately (since we stopped any current playback)
        audioQueue.push(audioResult);
        console.log(`[VoxLocal] ➕ Added context menu ${isChunk ? 'chunk' : 'single'} audio to queue. Queue now has ${audioQueue.length} items`);
        console.log(`[VoxLocal] ▶️ Starting context menu ${isChunk ? 'chunk' : 'single'} playback immediately`);
        playNextContextMenuChunk();
    } else {
        console.log(`[VoxLocal] 🔇 Floating player not visible, playing ${isChunk ? 'chunk' : 'single'} audio directly`);
        // Floating player not visible, play directly
        if (isChunk) {
            contextMenuDirectQueue.push(audioResult);
            console.log(`[VoxLocal] ➕ Added context menu chunk ${audioResult.chunkIndex + 1} to direct queue. Queue now has ${contextMenuDirectQueue.length} chunks`);
            if (!contextMenuAudio) {
                console.log(`[VoxLocal] ▶️ No direct audio playing, starting direct context menu playback`);
                playNextContextMenuChunkDirectly();
            }
        } else {
            playContextMenuSingleDirectly(audioResult);
        }
    }
}


// Handle context menu completion
function handleContextMenuComplete() {
    console.log('[VoxLocal] 📋 Context menu streaming GENERATION complete - all chunks received from background');
    isContextMenuGenerationComplete = true;

    // Don't reset isContextMenuPlaying here - wait for playback to actually complete
    // The state will be reset when playNextContextMenuChunk detects empty queue + generation complete
}

// Handle context menu error
function handleContextMenuError(error) {
    console.error('[VoxLocal] Context menu error:', error);
    isContextMenuPlaying = false;
    isContextMenuGenerationComplete = false;

    if (isPlayerVisible) {
        updateStatus('Context menu error: ' + error, 'error');
        updateButtonStates();
    }
}

// Play next context menu audio (chunk or single) when floating player is visible
function playNextContextMenuChunk() {
    console.log(`[VoxLocal] 🔄 playNextContextMenuChunk called. Queue length: ${audioQueue.length}, isContextMenuPlaying: ${isContextMenuPlaying}, isContextMenuGenerationComplete: ${isContextMenuGenerationComplete}, currentAudio: ${!!currentAudio}`);

    if (audioQueue.length === 0) {
        // If generation is complete and we're in context menu mode, reset state
        if (isContextMenuPlaying && isContextMenuGenerationComplete) {
            console.log('[VoxLocal] ✅ Context menu playback and generation BOTH complete, resetting state');
            isContextMenuPlaying = false;
            isContextMenuGenerationComplete = false;
            updateStatus('Ready', 'ready');
            updateButtonStates();
        } else if (isContextMenuPlaying && !isContextMenuGenerationComplete) {
            console.log('[VoxLocal] ⏳ Context menu: waiting for next chunk from background...');
            updateStatus('Context menu: waiting for next chunk...', 'speaking');
        } else {
            console.log('[VoxLocal] ❓ Unexpected empty queue state - resetting to ready');
            updateStatus('Ready', 'ready');
            updateButtonStates();
        }
        return;
    }

    const audioItem = audioQueue.shift();

    // Check if this is a chunk (has chunkIndex) or single audio
    const isChunk = audioItem.chunkIndex !== undefined;
    const displayText = isChunk
        ? `Context menu: Playing chunk ${audioItem.chunkIndex + 1}/${audioItem.totalChunks}`
        : 'Context menu: Speaking';

    console.log(`[VoxLocal] 🎵 SPEAKING context menu ${isChunk ? 'chunk' : 'single audio'}${isChunk ? ` ${audioItem.chunkIndex + 1}/${audioItem.totalChunks}` : ''}`);
    console.log(`[VoxLocal] 📝 Audio item text: "${audioItem.text ? audioItem.text.substring(0, 100) + (audioItem.text.length > 100 ? '...' : '') : 'N/A'}"`);

    updateStatus(displayText, 'speaking');

    try {
        const { audio, audioUrl } = createAudioFromBase64(audioItem.audio, { speed: audioItem.speed || 1 });
        currentAudio = audio;

        currentAudio.onended = () => {
            console.log(`[VoxLocal] Context menu ${isChunk ? 'chunk' : 'single audio'} playback completed`);
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            playNextContextMenuChunk();
        };

        currentAudio.onerror = (error) => {
            console.error('[VoxLocal] Context menu audio playback error:', error);
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            // Reset state on error
            isContextMenuPlaying = false;
            isContextMenuGenerationComplete = false;
            updateStatus('Error playing context menu audio', 'error');
            updateButtonStates();
        };

        console.log('[VoxLocal] Starting context menu audio playback...');
        currentAudio.play().catch((error) => {
            console.error('[VoxLocal] Context menu audio play failed:', error.message);
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            // Reset state on error
            isContextMenuPlaying = false;
            isContextMenuGenerationComplete = false;
            updateStatus('Error: ' + error.message, 'error');
            updateButtonStates();
        });

    } catch (error) {
        console.error('[VoxLocal] Error creating context menu audio:', error);
        // Reset state on error
        isContextMenuPlaying = false;
        isContextMenuGenerationComplete = false;
        updateStatus('Error: ' + error.message, 'error');
        updateButtonStates();
    }
}

// Play context menu single audio directly when floating player is not visible
function playContextMenuSingleDirectly(audioResult) {
    console.log('[VoxLocal] Playing context menu single audio directly');

    try {
        if (contextMenuAudio) {
            contextMenuAudio.pause();
            contextMenuAudio = null;
        }

        const { audio, audioUrl } = createAudioFromBase64(audioResult.audio, { speed: audioResult.speed || 1 });
        contextMenuAudio = audio;

        contextMenuAudio.onended = () => {
            console.log('[VoxLocal] Direct context menu single audio playback completed');
            URL.revokeObjectURL(audioUrl);
            contextMenuAudio = null;
        };

        contextMenuAudio.onerror = (error) => {
            console.error('[VoxLocal] Direct context menu single audio playback error:', error);
            URL.revokeObjectURL(audioUrl);
            contextMenuAudio = null;
        };

        contextMenuAudio.play().catch((error) => {
            console.error('[VoxLocal] Direct context menu single audio play failed:', error.message);
            URL.revokeObjectURL(audioUrl);
            contextMenuAudio = null;
        });

    } catch (error) {
        console.error('[VoxLocal] Error creating direct context menu single audio:', error);
    }
}

// Play context menu chunk directly when floating player is not visible
// Play next chunk from direct context menu queue
function playNextContextMenuChunkDirectly() {
    console.log(`[VoxLocal] 🔄 playNextContextMenuChunkDirectly called. Queue length: ${contextMenuDirectQueue.length}, currentAudio: ${!!contextMenuAudio}`);

    if (contextMenuDirectQueue.length === 0) {
        console.log(`[VoxLocal] ✅ Direct context menu playback complete - no more chunks`);
        return;
    }

    const chunkResult = contextMenuDirectQueue.shift();
    console.log(`[VoxLocal] 🎵 SPEAKING direct context menu chunk ${chunkResult.chunkIndex + 1}/${chunkResult.totalChunks}`);
    console.log(`[VoxLocal] 📝 Direct chunk text: "${chunkResult.text ? chunkResult.text.substring(0, 100) + (chunkResult.text.length > 100 ? '...' : '') : 'N/A'}"`);

    try {
        if (contextMenuAudio) {
            contextMenuAudio.pause();
            contextMenuAudio = null;
        }

        const { audio, audioUrl } = createAudioFromBase64(chunkResult.audio, { speed: chunkResult.speed || 1 });
        contextMenuAudio = audio;

        contextMenuAudio.onended = () => {
            console.log(`[VoxLocal] ✅ Direct context menu chunk ${chunkResult.chunkIndex + 1} playback completed`);
            URL.revokeObjectURL(audioUrl);
            contextMenuAudio = null;
            // Play next chunk
            playNextContextMenuChunkDirectly();
        };

        contextMenuAudio.onerror = (error) => {
            console.error('[VoxLocal] Direct context menu chunk playback error:', error);
            URL.revokeObjectURL(audioUrl);
            contextMenuAudio = null;
            // Continue with next chunk despite error
            playNextContextMenuChunkDirectly();
        };

        console.log(`[VoxLocal] ▶️ Starting direct chunk ${chunkResult.chunkIndex + 1} audio playback...`);
        contextMenuAudio.play().catch((error) => {
            console.error(`[VoxLocal] ❌ Direct context menu chunk ${chunkResult.chunkIndex + 1} play FAILED:`, error.message);
            URL.revokeObjectURL(audioUrl);
            contextMenuAudio = null;
            // Continue with next chunk despite error
            playNextContextMenuChunkDirectly();
        });

    } catch (error) {
        console.error('[VoxLocal] Error creating direct context menu chunk audio:', error);
        // Continue with next chunk despite error
        playNextContextMenuChunkDirectly();
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
            <button id="voxlocal-play-stop-btn" class="voxlocal-btn voxlocal-btn-primary" title="Play selection or page">
                <span class="icon">▶️</span> Play
            </button>
        </div>
        <div class="voxlocal-settings">
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

        .voxlocal-btn {
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

        .voxlocal-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .voxlocal-btn-primary { background-color: #007bff; color: white; }
        .voxlocal-btn-primary:hover:not(:disabled) { background-color: #0056b3; }
        .voxlocal-btn-danger { background-color: #dc3545; color: white; }
        .voxlocal-btn-danger:hover:not(:disabled) { background-color: #c82333; }

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

    // Play/Stop button
    document.getElementById('voxlocal-play-stop-btn').addEventListener('click', togglePlayStop);

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
    // If currently playing (streaming or context menu), stop
    if (isStreaming || isContextMenuPlaying || currentAudio) {
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

    // Stop context menu audio if playing and clear queued chunks
    if (contextMenuAudio) {
        console.log('[VoxLocal] Stopping context menu audio playback');
        contextMenuAudio.pause();
        contextMenuAudio = null;
    }

    // Clear audio queue and reset context menu state
    audioQueue = [];
    isContextMenuPlaying = false;
    isContextMenuGenerationComplete = false;
    isContextMenuCancelled = true; // Prevent new chunks from starting
    contextMenuSessionId++; // Increment to invalidate any incoming chunks from previous session

    console.log(`[VoxLocal] Cleared audio queue and incremented session ID to ${contextMenuSessionId}`);

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

// Reset button states
function resetButtons() {
    const playStopBtn = document.getElementById('voxlocal-play-stop-btn');
    playStopBtn.disabled = false;
    playStopBtn.innerHTML = '<span class="icon">▶️</span> Play';
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

// Update model status display
function updateModelStatus(message) {
    const modelStatusElement = document.getElementById('voxlocal-model-status');
    if (modelStatusElement) {
        modelStatusElement.textContent = message;
    }
}

// Reset streaming state
function resetStreamingState() {
    audioChunks = {};
    nextExpectedChunkIndex = 0;
    currentStreamingRequestId = null;
    isStreaming = false;
    streamChunksReceived = 0;
    totalStreamChunks = 0;
    // Also reset context menu state
    isContextMenuPlaying = false;
    isContextMenuGenerationComplete = false;
    // Clear any queued audio to prevent stale items
    audioQueue = [];
    if (contextMenuAudio) {
        contextMenuAudio.pause();
        contextMenuAudio = null;
    }
    updateButtonStates();
}

// Update button states based on streaming and context menu status
function updateButtonStates() {
    const playStopBtn = document.getElementById('voxlocal-play-stop-btn');
    if (isStreaming || isContextMenuPlaying) {
        // During streaming or context menu playback, change to stop mode
        playStopBtn.disabled = false;
        playStopBtn.innerHTML = '<span class="icon">⏹️</span> Stop';
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
