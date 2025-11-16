// popup.js - handles interaction with the extension's popup, sends requests to the
// service worker (background.js), and updates the popup's UI (popup.html) on completion.

const textElement = document.getElementById('text');
const voiceSelect = document.getElementById('voice-select');
const speedSlider = document.getElementById('speed-slider');
const speedValue = document.getElementById('speed-value');
const speakBtn = document.getElementById('speak-btn');
const stopBtn = document.getElementById('stop-btn');
const statusElement = document.getElementById('status');
const progressElement = document.getElementById('progress');
const progressFill = document.getElementById('progress-fill');

// Global audio element for current playback
let currentAudio = null;

// Update speed value display
speedSlider.addEventListener('input', (event) => {
    speedValue.textContent = `${event.target.value}x`;
});

// Speak button click handler
speakBtn.addEventListener('click', async () => {
    const text = textElement.value.trim();
    if (!text) {
        updateStatus('Please enter some text to speak', 'error');
        return;
    }

    const voice = voiceSelect.value;
    const speed = parseFloat(speedSlider.value);

    // Disable buttons and show loading
    speakBtn.disabled = true;
    stopBtn.disabled = false;
    updateStatus('Generating speech...', 'loading');

    try {
        // Send message to background script
        const message = {
            action: 'speak',
            text: text,
            voice: voice,
            speed: speed
        };

        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                console.error('Runtime error:', chrome.runtime.lastError);
                updateStatus('Error: ' + chrome.runtime.lastError.message, 'error');
                resetButtons();
                return;
            }

            if (response && response.audio) {
                playAudio(response);
            } else {
                updateStatus('Error: No audio received', 'error');
                resetButtons();
            }
        });
    } catch (error) {
        console.error('Error sending message:', error);
        updateStatus('Error: ' + error.message, 'error');
        resetButtons();
    }
});

// Stop button click handler
stopBtn.addEventListener('click', () => {
    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
    }
    resetButtons();
    updateStatus('Playback stopped', 'info');
});

// Play audio from base64 data
function playAudio(response) {
    try {
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

        currentAudio.onloadedmetadata = () => {
            updateStatus('Playing audio...', 'success');
            speakBtn.disabled = true;
            stopBtn.disabled = false;
        };

        currentAudio.onended = () => {
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            resetButtons();
            updateStatus('Playback finished', 'success');
        };

        currentAudio.onerror = (error) => {
            console.error('Audio playback error:', currentAudio?.error?.message || 'Unknown error');
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            resetButtons();
            updateStatus('Error playing audio', 'error');
        };

        currentAudio.play().catch((error) => {
            console.error('Audio play failed:', error.message);
            URL.revokeObjectURL(audioUrl);
            currentAudio = null;
            resetButtons();
            updateStatus('Error: ' + error.message, 'error');
        });

    } catch (error) {
        console.error('Error creating audio:', error);
        updateStatus('Error: ' + error.message, 'error');
        resetButtons();
    }
}

// Reset button states
function resetButtons() {
    speakBtn.disabled = false;
    stopBtn.disabled = true;
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
    updateStatus('Ready to speak...');
});
