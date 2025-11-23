import { defineContentScript } from 'wxt/sandbox';

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
