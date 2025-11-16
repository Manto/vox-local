// popup.js - handles interaction with the extension's popup, sends requests to the
// service worker (background.js), and updates the popup's UI (popup.html) on completion.

const textElement = document.getElementById('text');
const voiceSelect = document.getElementById('voice-select');
const speedSlider = document.getElementById('speed-slider');
const speedValue = document.getElementById('speed-value');
const speakBtn = document.getElementById('speak-btn');
const stopBtn = document.getElementById('stop-btn');
const speakSelectionBtn = document.getElementById('speak-selection');
const speakPageBtn = document.getElementById('speak-page');
const statusElement = document.getElementById('status');
const progressElement = document.getElementById('progress');
const progressFill = document.getElementById('progress-fill');

// Global audio element for current playback
let currentAudio = null;

// Update speed value display
speedSlider.addEventListener('input', (event) => {
    speedValue.textContent = `${event.target.value}x`;
});

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
        speed: speed
    };

    console.log(`[VoxLocal] Sending speak message to background script - text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}", voice: ${voice}, speed: ${speed}x`);

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
                setTimeout(() => updateStatus('Ready to speak...', 'info'), 2000);
                resetButtons();
                return;
            }

            // Use the text and speak it using existing logic
            const text = response.text.trim();
            console.log(`[VoxLocal] Got ${type} text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

            // Send to TTS with page-specific loading message
            sendToTTS(text, voice, speed, 'Converting page text to speech...');
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

    // Send to TTS
    sendToTTS(text, voice, speed);
});

// Stop button click handler
stopBtn.addEventListener('click', () => {
    console.log('[VoxLocal] Stop button clicked');
    if (currentAudio) {
        console.log('[VoxLocal] Stopping current audio playback');
        currentAudio.pause();
        currentAudio = null;
    }
    resetButtons();
    updateStatus('Playback stopped', 'info');
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
            updateStatus('Playing audio...', 'success');
            speakBtn.disabled = true;
            stopBtn.disabled = false;
        };

        currentAudio.onended = () => {
            console.log('[VoxLocal] Audio playback completed successfully');
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            resetButtons();
            updateStatus('Playback finished', 'success');
        };

        currentAudio.onerror = (error) => {
            console.error('[VoxLocal] Audio playback error:', currentAudio?.error?.message || 'Unknown error');
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            resetButtons();
            updateStatus('Error playing audio', 'error');
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
function updateStatus(message, type = 'info') {
    statusElement.textContent = message;
    statusElement.className = `status-${type}`;

    // Hide progress for now (could be used for model loading progress later)
    progressElement.style.display = 'none';
}

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    console.log('[VoxLocal] Popup initialized and ready');
    updateStatus('Ready to speak...');
});
