// background.js - Handles requests from the UI, runs the TTS model, then sends back audio

import { KokoroTTS } from 'kokoro-js';

class TTSSingleton {
    static model_id = 'onnx-community/Kokoro-82M-v1.0-ONNX';
    static instances = new Map(); // Store instances by dtype-device combination

    static async getInstance(dtype = 'fp32', device = 'webgpu', progress_callback = null) {
        const key = `${dtype}-${device}`;

        if (!this.instances.has(key)) {
            console.log(`[VoxLocal] Creating new TTS instance for ${key} (dtype: ${dtype}, device: ${device})`);
            this.instances.set(key, await KokoroTTS.from_pretrained(this.model_id, {
                dtype: dtype,
                device: device,
                progress_callback: progress_callback
            }));
        } else {
            console.log(`[VoxLocal] Reusing existing TTS instance for ${key} (dtype: ${dtype}, device: ${device})`);
        }

        return this.instances.get(key);
    }
}

// Text splitting utility to break long text into sentences for streaming TTS
const splitTextIntoSentences = (text, maxLength = 100) => {
    // Split text into sentences using common sentence-ending patterns
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);

    const chunks = [];
    let currentChunk = '';

    for (const sentence of sentences) {
        const trimmedSentence = sentence.trim();
        if (!trimmedSentence) continue;

        // Add period back if not present (since we split on them)
        const sentenceWithPeriod = trimmedSentence + '.';

        // If adding this sentence would exceed max length, start a new chunk
        if (currentChunk && (currentChunk + ' ' + sentenceWithPeriod).length > maxLength) {
            chunks.push(currentChunk.trim());
            currentChunk = sentenceWithPeriod;
        } else {
            currentChunk += (currentChunk ? ' ' : '') + sentenceWithPeriod;
        }
    }

    // Add the last chunk if it exists
    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }

    // If no sentences were found or text is very short, return the original text as one chunk
    return chunks.length > 0 ? chunks : [text];
};

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

    // Convert Uint8Array to binary string efficiently
    // Use a more robust approach that avoids call stack limits entirely
    console.log(`[VoxLocal] Converting ${uint8Array.length} bytes to base64...`);
    let binaryString = '';
    for (let i = 0; i < uint8Array.length; i++) {
        binaryString += String.fromCharCode(uint8Array[i]);
    }
    const base64Audio = btoa(binaryString);
    console.log(`[VoxLocal] Audio processing complete (${(base64Audio.length / 1024).toFixed(2)} KB base64 data)`);

    return {
        audio: base64Audio,
        sampleRate: audio.sample_rate,
        voice: voice,
        speed: speed
    };
};

// Streaming TTS function that processes text in chunks and sends audio segments
const generateStreamingSpeech = async (text, voice = 'af_heart', speed = 1, dtype = 'fp32', device = 'webgpu', onChunkComplete) => {
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

            let binaryString = '';
            for (let j = 0; j < uint8Array.length; j++) {
                binaryString += String.fromCharCode(uint8Array[j]);
            }
            const base64Audio = btoa(binaryString);

            const chunkResult = {
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

////////////////////// 1. Context Menus //////////////////////
//
// Add a listener to create the initial context menu items,
// context menu items only need to be created at runtime.onInstalled
chrome.runtime.onInstalled.addListener(function () {
    // Register a context menu item that will only show up for selection text.
    chrome.contextMenus.create({
        id: 'speak-selection',
        title: 'Speak "%s"',
        contexts: ['selection'],
    });
});

// Perform TTS when the user clicks a context menu
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    // Ignore context menu clicks that are not for speech (or when there is no input)
    if (info.menuItemId !== 'speak-selection' || !info.selectionText) return;

    console.log(`[VoxLocal] Context menu activated for selected text (${info.selectionText.length} characters)`);

    // Generate speech for the selected text
    let result = await generateSpeech(info.selectionText);

    // Inject a script to play the audio
    console.log(`[VoxLocal] Injecting audio playback script into tab ${tab.id}`);
    chrome.scripting.executeScript({
        target: { tabId: tab.id },    // Run in the tab that the user clicked in
        args: [result],               // The arguments to pass to the function
        function: (result) => {       // The function to run
            // NOTE: This function is run in the context of the web page, meaning that `document` is available.
            try {
                console.log('[VoxLocal] Starting audio playback from context menu...');
                // Convert base64 back to audio and play it
                const audioData = atob(result.audio);
                const arrayBuffer = new ArrayBuffer(audioData.length);
                const uint8Array = new Uint8Array(arrayBuffer);
                for (let i = 0; i < audioData.length; i++) {
                    uint8Array[i] = audioData.charCodeAt(i);
                }

                const blob = new Blob([uint8Array], { type: 'audio/wav' });
                const audioUrl = URL.createObjectURL(blob);
                const audio = new Audio(audioUrl);
                audio.play().catch(console.error);

                // Clean up the URL after playing
                audio.onended = () => {
                    console.log('[VoxLocal] Context menu audio playback completed');
                    URL.revokeObjectURL(audioUrl);
                };
            } catch (error) {
                console.error('[VoxLocal] Error playing context menu audio:', error);
            }
        },
    });
    console.log('[VoxLocal] Context menu speech generation completed');
});
//////////////////////////////////////////////////////////////

////////////////////// 2. Message Events /////////////////////
//
let activeStreamingRequest = null; // Track active streaming request

// Listen for messages from the UI, process it, and send the result back.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action !== 'speak' && message.action !== 'speak_stream' && message.action !== 'cancel_stream') return; // Ignore messages that are not meant for speech generation.

    console.log(`[VoxLocal] Received ${message.action} request from ${sender.url || 'popup'}`);

    if (message.action === 'speak_stream') {
        console.log(`[VoxLocal] Received streaming request - dtype: ${message.dtype}, device: ${message.device}, voice: ${message.voice}, speed: ${message.speed}x`);

        // Handle streaming TTS
        if (activeStreamingRequest) {
            console.log('[VoxLocal] Cancelling previous streaming request');
            activeStreamingRequest.cancelled = true;
        }

        activeStreamingRequest = { cancelled: false };

        // Run streaming TTS asynchronously
        (async function () {
            try {
                await generateStreamingSpeech(
                    message.text,
                    message.voice,
                    message.speed,
                    message.dtype,
                    message.device,
                    (chunkResult) => {
                        // Send each chunk back immediately
                        if (!activeStreamingRequest.cancelled) {
                            console.log(`[VoxLocal] Sending chunk ${chunkResult.chunkIndex + 1}/${chunkResult.totalChunks} to popup`);
                            try {
                                chrome.runtime.sendMessage({
                                    action: 'stream_chunk',
                                    ...chunkResult
                                });
                            } catch (sendError) {
                                console.error('[VoxLocal] Failed to send chunk message:', sendError);
                            }
                        }
                    }
                );

                // Send completion message
                if (!activeStreamingRequest.cancelled) {
                    console.log('[VoxLocal] Streaming complete, sending completion message');
                    try {
                        chrome.runtime.sendMessage({
                            action: 'stream_complete'
                        });
                    } catch (sendError) {
                        console.error('[VoxLocal] Failed to send completion message:', sendError);
                    }
                }

                activeStreamingRequest = null;
                sendResponse({ success: true });

            } catch (error) {
                console.error('[VoxLocal] Streaming TTS error:', error);
                if (!activeStreamingRequest.cancelled) {
                    try {
                        chrome.runtime.sendMessage({
                            action: 'stream_error',
                            error: error.message
                        });
                    } catch (sendError) {
                        console.error('[VoxLocal] Failed to send error message:', sendError);
                    }
                }
                activeStreamingRequest = null;
                sendResponse({ success: false, error: error.message });
            }
        })();

    } else if (message.action === 'cancel_stream') {
        // Handle streaming cancellation
        if (activeStreamingRequest) {
            console.log('[VoxLocal] Cancelling active streaming request');
            activeStreamingRequest.cancelled = true;
            activeStreamingRequest = null;
        }
        sendResponse({ success: true });

    } else {
        console.log(`[VoxLocal] Received regular speak request - dtype: ${message.dtype}, device: ${message.device}, voice: ${message.voice}, speed: ${message.speed}x`);

        // Handle regular (non-streaming) TTS
        // Run TTS asynchronously
        (async function () {
            try {
                // Generate speech
                let result = await generateSpeech(message.text, message.voice, message.speed, message.dtype, message.device);

                console.log('[VoxLocal] Sending audio response to popup');
                // Send response back to UI
                sendResponse(result);
            } catch (error) {
                console.error('[VoxLocal] TTS error:', error);
                sendResponse({ success: false, error: error.message });
            }
        })();
    }

    // return true to indicate we will send a response asynchronously
    // see https://stackoverflow.com/a/46628145 for more information
    return true;
});
//////////////////////////////////////////////////////////////

