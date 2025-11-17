// popup.js - handles interaction with the extension's popup, sends requests to the
// service worker (background.js), and updates the popup's UI (popup.html) on completion.

const textElement = document.getElementById('text');
const voiceSelect = document.getElementById('voice-select');
const speedSlider = document.getElementById('speed-slider');
const speedValue = document.getElementById('speed-value');
const dtypeSelect = document.getElementById('dtype');
const deviceSelect = document.getElementById('device');
const autoHighlightCheckbox = document.getElementById('auto-highlight');
const speakBtn = document.getElementById('speak-btn');
const stopBtn = document.getElementById('stop-btn');
const speakSelectionBtn = document.getElementById('speak-selection');
const speakPageBtn = document.getElementById('speak-page');
const statusElement = document.getElementById('status');
const modelStatusElement = document.getElementById('model-status');

// Global audio element for current playback
let currentAudio = null;
// Streaming TTS state
let audioQueue = [];
let isStreaming = false;
let streamChunksReceived = 0;
let totalStreamChunks = 0;

// Update speed value display
speedSlider.addEventListener('input', (event) => {
    speedValue.textContent = `${event.target.value}x`;
});

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

// Function to send text to streaming TTS for speech generation
function sendStreamingTTS(text, voice, speed) {
    // Reset streaming state
    audioQueue = [];
    isStreaming = true;
    streamChunksReceived = 0;
    totalStreamChunks = 0;

    // Update button states for streaming
    updateButtonStates();

    updateStatus('Starting streaming speech...', 'loading');

    // Send message to background script for streaming
    const message = {
        action: 'speak_stream',
        text: text,
        voice: voice,
        speed: speed,
        dtype: dtypeSelect.value,
        device: deviceSelect.value
    };

    console.log(`[VoxLocal] Sending streaming speak message to background script - text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}", voice: ${voice}, speed: ${speed}x, dtype: ${dtypeSelect.value}, device: ${deviceSelect.value}`);

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
    speakBtn.disabled = true;
    stopBtn.disabled = false;
    speakSelectionBtn.disabled = true;
    speakPageBtn.disabled = true;

    updateStatus(loadingMessage, 'loading');

    // Send message to background script
    const message = {
        action: 'speak',
        text: text,
        voice: voice,
        speed: speed,
        dtype: dtypeSelect.value,
        device: deviceSelect.value
    };

    console.log(`[VoxLocal] Sending speak message to background script - text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}", voice: ${voice}, speed: ${speed}x, dtype: ${dtypeSelect.value}, device: ${deviceSelect.value}`);

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
    const voice = voiceSelect.value;
    const speed = parseFloat(speedSlider.value);

    updateStatus(type === 'selection' ? 'Getting selected text...' : 'Getting page text...', 'loading');

    try {
        // Get the active tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
            throw new Error('No active tab found');
        }

        // Send message to content script to get text
        const messageType = type === 'selection' ? 'GET_SELECTION' : 'GET_PAGE_TEXT';
        chrome.tabs.sendMessage(tab.id, { type: messageType }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('[VoxLocal] Runtime error:', chrome.runtime.lastError);
                updateStatus('Error: ' + chrome.runtime.lastError.message, 'error');
                resetButtons();
                return;
            }

            if (!response || !response.text || response.text.trim() === '') {
                const errorMsg = type === 'selection' ? 'No text selected' : 'No text found on page';
                updateStatus(errorMsg, 'error');
                setTimeout(() => updateStatus('Ready', 'ready'), 2000);
                resetButtons();
                return;
            }

            // Use the text and speak it using streaming logic
            const text = response.text.trim();
            console.log(`[VoxLocal] Got ${type} text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

            // Send to streaming TTS with page-specific loading message
            sendStreamingTTS(text, voice, speed);
        });
    } catch (error) {
        console.error('[VoxLocal] Error:', error);
        updateStatus('Error: ' + error.message, 'error');
        resetButtons();
    }
}

// Speak Selection button click handler
speakSelectionBtn.addEventListener('click', async () => {
    console.log('[VoxLocal] Speak Selection button clicked');
    await speakFromPage('selection');
});

// Speak Page button click handler
speakPageBtn.addEventListener('click', async () => {
    console.log('[VoxLocal] Speak Page button clicked');
    await speakFromPage('page');
});

// Speak button click handler
speakBtn.addEventListener('click', async () => {
    const text = textElement.value.trim();
    if (!text) {
        console.log('[VoxLocal] Speak button clicked but no text entered');
        updateStatus('Please enter some text to speak', 'error');
        return;
    }

    const voice = voiceSelect.value;
    const speed = parseFloat(speedSlider.value);

    console.log(`[VoxLocal] Speak button clicked - text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}", voice: ${voice}, speed: ${speed}x`);

    // Send to streaming TTS
    sendStreamingTTS(text, voice, speed);
});

// Stop button click handler
stopBtn.addEventListener('click', () => {
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
});

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
            speakBtn.disabled = true;
            stopBtn.disabled = false;
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
    speakBtn.disabled = false;
    stopBtn.disabled = true;
    speakSelectionBtn.disabled = false;
    speakPageBtn.disabled = false;
}

// Update status display
function updateStatus(message, type = 'ready') {
    statusElement.textContent = message;

    // Remove all status classes
    statusElement.className = 'status-badge';

    // Add the appropriate status class
    statusElement.classList.add(type);
}

// Update model status display
function updateModelStatus(message) {
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
    updateButtonStates();
}

// Update button states based on streaming status
function updateButtonStates() {
    if (isStreaming) {
        // During streaming, disable all speak buttons, enable stop
        speakBtn.disabled = true;
        speakSelectionBtn.disabled = true;
        speakPageBtn.disabled = true;
        stopBtn.disabled = false;
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
            updateStatus('Waiting for next chunk...', 'loading');
        } else {
            updateStatus('Ready', 'ready');
            resetButtons();
        }
        return;
    }

    const chunk = audioQueue.shift();
    console.log(`[VoxLocal] Playing audio chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks}. Remaining queue: ${audioQueue.length}`);

    updateStatus(`Speaking chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks}...`, 'speaking');

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

// Message listeners for streaming TTS
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
        case 'stream_chunk':
            console.log(`[VoxLocal] Received streaming chunk ${message.chunkIndex + 1}/${message.totalChunks}`);
            streamChunksReceived = message.chunkIndex + 1;
            totalStreamChunks = message.totalChunks;

            // Add chunk to queue
            audioQueue.push(message);
            console.log(`[VoxLocal] Added chunk to queue. Queue now has ${audioQueue.length} chunks`);

            // Update status
            updateStatus(`Received chunk ${streamChunksReceived}/${totalStreamChunks}`, 'loading');

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

// Settings storage functions
async function saveSettings() {
    const settings = {
        dtype: dtypeSelect.value,
        device: deviceSelect.value,
        voice: voiceSelect.value,
        speed: parseFloat(speedSlider.value),
        autoHighlight: autoHighlightCheckbox.checked
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
        deviceSelect.value = settings.device || 'webgpu';
        dtypeSelect.value = settings.dtype || 'fp32';
        voiceSelect.value = settings.voice || 'af_heart';
        speedSlider.value = settings.speed || 1.0;
        speedValue.textContent = `${speedSlider.value}x`;
        autoHighlightCheckbox.checked = settings.autoHighlight || false;

        // Apply WebGPU constraint - must use FP32
        handleDeviceChange();

        console.log('[VoxLocal] Settings loaded:', settings);
    } catch (error) {
        console.error('[VoxLocal] Error loading settings:', error);
        // Set defaults if loading fails
        deviceSelect.value = 'webgpu';
        dtypeSelect.value = 'fp32';
        voiceSelect.value = 'af_heart';
        speedSlider.value = 1.0;
        speedValue.textContent = '1.0x';
        autoHighlightCheckbox.checked = false;

        // Apply WebGPU constraint
        handleDeviceChange();
    }
}

// Function to handle device changes - WebGPU requires FP32
function handleDeviceChange() {
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

// Save settings when controls change
dtypeSelect.addEventListener('change', saveSettings);
deviceSelect.addEventListener('change', () => {
    handleDeviceChange();
});
voiceSelect.addEventListener('change', saveSettings);
speedSlider.addEventListener('change', saveSettings);
autoHighlightCheckbox.addEventListener('change', saveSettings);

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    console.log('[VoxLocal] Popup initialized and ready');
    loadSettings(); // Load saved settings
    updateStatus('Ready');
    updateModelStatus('Model will load on first use');
});
