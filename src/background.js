// background.js - Handles requests from the UI, runs the TTS model, then sends back audio

import { KokoroTTS } from 'kokoro-js';
import { splitTextIntoSentences } from './utils/textSplitter.js';

// Configuration: Maximum number of chunks to process ahead of playback
const MAX_CHUNKS_AHEAD = 5;

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

// Helper function to wait until we're not too far ahead of playback
function shouldWaitForPlayback(currentChunkIndex) {
    const chunksAhead = currentChunkIndex - lastPlayedBackChunkIndex;
    return chunksAhead > MAX_CHUNKS_AHEAD;
}

// Promise that resolves when we can continue processing
function waitForPlaybackToCatchUp(currentChunkIndex) {
    return new Promise((resolve) => {
        if (!shouldWaitForPlayback(currentChunkIndex)) {
            resolve();
            return;
        }
        console.log(`[VoxLocal] ⏸️ Pausing processing - ${currentChunkIndex - lastPlayedBackChunkIndex} chunks ahead of playback (max: ${MAX_CHUNKS_AHEAD})`);
        processingResumeCallback = resolve;
    });
}

// Called when a chunk finishes playback to potentially resume processing
function onChunkPlayedBack(chunkIndex) {
    lastPlayedBackChunkIndex = Math.max(lastPlayedBackChunkIndex, chunkIndex);
    console.log(`[VoxLocal] 🎵 Chunk ${chunkIndex + 1} playback completed, lastPlayedBackChunkIndex: ${lastPlayedBackChunkIndex}`);
    
    // Check if we should resume processing
    if (processingResumeCallback) {
        const callback = processingResumeCallback;
        processingResumeCallback = null;
        console.log(`[VoxLocal] ▶️ Resuming processing - playback caught up`);
        callback();
    }
}

// Streaming TTS function that processes text in chunks and sends audio segments
// startChunkIndex allows continuing a stream (e.g. after the service worker restarted during a pause)
// isCurrent() returns false once this request has been cancelled or replaced.
const generateStreamingSpeech = async (text, voice = 'af_heart', speed = 1, dtype = 'fp32', device = 'webgpu', requestId, onChunkComplete, startChunkIndex = 0, isCurrent = () => true) => {
    console.log(`[VoxLocal] Starting streaming speech generation for text (${text.length} characters) with voice: ${voice}, speed: ${speed}x, dtype: ${dtype}, device: ${device}, startChunkIndex: ${startChunkIndex}`);

    // Split text into manageable chunks
    const textChunks = splitTextIntoSentences(text);
    console.log(`[VoxLocal] Split text into ${textChunks.length} chunks for streaming`);

    // Nothing left to generate (e.g. continuing a stream whose chunks were all delivered) - skip model load
    if (startChunkIndex >= textChunks.length) {
        return [];
    }

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
    for (let i = startChunkIndex; i < textChunks.length; i++) {
        // Check if streaming was cancelled or replaced by another request
        if (!isCurrent()) {
            console.log('[VoxLocal] Streaming cancelled by user');
            break;
        }

        // Wait if we're too far ahead of playback (check before processing each chunk)
        await waitForPlaybackToCatchUp(i);

        // Check again after waiting in case streaming was cancelled while waiting
        if (!isCurrent()) {
            console.log('[VoxLocal] Streaming cancelled by user while waiting for playback');
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
            // Await so sends stay ordered and don't overlap (overlap caused duplicate deliveries)
            if (onChunkComplete) {
                await onChunkComplete(chunkResult);
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

    console.log(`[VoxLocal] Context menu activated ${info.menuItemId} for selected text (${info.selectionText.length} characters)`);

    // Ignore context menu clicks that are not for speech (or when there is no input)
    if (info.menuItemId !== 'speak-selection' || !info.selectionText) return;

    try {
        // Send message to content script to show player and play the selected text
        await chrome.tabs.sendMessage(tab.id, { action: 'PLAY_SELECTION' });
        console.log('[VoxLocal] Sent PLAY_SELECTION message to content script');
    } catch (error) {
        console.error('[VoxLocal] Context menu error:', error);
    }

    console.log('[VoxLocal] Context menu processing completed');
});
//////////////////////////////////////////////////////////////

////////////////////// 2. Message Events /////////////////////
//
let activeStreamingRequest = null; // Track active streaming request
let requestIdCounter = 0;
let pendingChunks = new Map(); // Queue chunks for each request ID when content script is unavailable
let lastPlayedBackChunkIndex = -1; // Track the last chunk that finished playback (for pacing processing)
let processingResumeCallback = null; // Callback to resume processing when playback catches up

// Function to send queued chunks/messages to content script
async function sendQueuedChunks(requestId, tabId) {
    if (!pendingChunks.has(requestId)) {
        return;
    }

    console.log(`sendQueuedChunks,pending chunks:`);
    console.log(pendingChunks);

    const messages = pendingChunks.get(requestId);
    if (messages.length === 0) {
        return;
    }

    console.log(`[VoxLocal] Attempting to send ${messages.length} queued messages for request ${requestId} to tab ${tabId}`);

    // Send pending messages one by one, removing successfully sent ones
    while (messages.length > 0) {
        const message = messages[0]; // Peek at the first message
        try {
            await chrome.tabs.sendMessage(tabId, message);
            console.log(`[VoxLocal] Successfully sent queued message ${message.action}`);
            messages.shift(); // Remove the successfully sent message
        } catch (sendError) {
            console.log(`[VoxLocal] Content script unavailable for message ${message.action}, will retry later`);
            console.log(sendError);
            // Stop processing if sending failed - keep remaining messages for later retry
            return;
        }
    }

    // If we got here, all messages were sent successfully
    pendingChunks.delete(requestId);
    console.log(`[VoxLocal] All queued messages sent for request ${requestId}`);
}

// Actions handled by this message listener
const HANDLED_ACTIONS = new Set([
    'speak',
    'speak_stream',
    'cancel_stream',
    'query_model_status',
    'request_pending_chunks',
    'chunk_played_back',
    'resume_stream'
]);

// Queue a message for the content script and try to deliver it
async function queueAndSend(requestId, tabId, msg) {
    if (!pendingChunks.has(requestId)) {
        pendingChunks.set(requestId, []);
    }
    pendingChunks.get(requestId).push(msg);
    await sendQueuedChunks(requestId, tabId);
}

// Start (or continue, from startChunkIndex) a streaming TTS request. Results and errors
// are delivered to the content script via stream_chunk / stream_complete / stream_error messages.
function startStreamingRequest({ requestId, tabId, text, voice, speed, dtype, device, startChunkIndex = 0, lastPlayedIndex = -1 }) {
    const previous = activeStreamingRequest;
    if (previous) {
        console.log('[VoxLocal] Cancelling previous streaming request');
        previous.cancelled = true;
        // Tell the superseded player (e.g. a paused tab) so it doesn't wait forever for more chunks
        if (previous.id !== requestId) {
            pendingChunks.delete(previous.id);
            chrome.tabs.sendMessage(previous.tabId, {
                action: 'stream_error',
                requestId: previous.id,
                error: 'Playback started in another tab'
            }).catch(() => {});
        }
    }
    // Wake a previous loop waiting on playback so it can see the cancel flag and exit
    if (processingResumeCallback) {
        const callback = processingResumeCallback;
        processingResumeCallback = null;
        callback();
    }

    const request = { cancelled: false, id: requestId, tabId };
    activeStreamingRequest = request;
    // Set synchronously so chunk_played_back messages arriving right away aren't overwritten
    lastPlayedBackChunkIndex = lastPlayedIndex;
    const isCurrent = () => activeStreamingRequest === request && !request.cancelled;

    (async function () {
        try {
            // Show player immediately when streaming starts
            try {
                await chrome.tabs.sendMessage(tabId, { action: 'SHOW_PLAYER' });
            } catch (error) {
                console.log('[VoxLocal] Could not show player immediately, will show when first chunk arrives');
            }
            await generateStreamingSpeech(
                text,
                voice,
                speed,
                dtype,
                device,
                requestId,
                async (chunkResult) => {
                    // Queue chunk for sending to content script only if streaming hasn't been cancelled
                    if (isCurrent()) {
                        console.log(`[VoxLocal] Queueing chunk ${chunkResult.chunkIndex + 1}/${chunkResult.totalChunks} for content script`);
                        await queueAndSend(requestId, tabId, chunkResult);
                    } else {
                        console.log(`[VoxLocal] Skipping chunk ${chunkResult.chunkIndex + 1}/${chunkResult.totalChunks} - streaming cancelled`);
                    }
                },
                startChunkIndex,
                isCurrent
            );

            if (isCurrent()) {
                console.log('[VoxLocal] Streaming complete, queuing completion message');
                await queueAndSend(requestId, tabId, { action: 'stream_complete', requestId });
            }
        } catch (error) {
            console.error('[VoxLocal] Streaming TTS error:', error);
            if (isCurrent()) {
                console.log('[VoxLocal] Streaming error, queuing error message');
                await queueAndSend(requestId, tabId, { action: 'stream_error', requestId, error: error.message });
            }
        } finally {
            // Only clear if a newer request hasn't replaced this one
            if (activeStreamingRequest === request) {
                activeStreamingRequest = null;
            }
        }
    })();
}

// Listen for messages from the UI, process it, and send the result back.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!HANDLED_ACTIONS.has(message.action)) return; // Ignore messages that are not meant for speech generation or status queries.

    console.log(`[VoxLocal] Received ${message.action} request from ${sender.url || 'popup'}`);

    if (message.action === 'query_model_status') {
        // Check if any TTS instances are loaded
        const loaded = TTSSingleton.instances.size > 0;
        let modelName = null;

        if (loaded) {
            // Get the first loaded model key (dtype-device combination)
            const firstKey = TTSSingleton.instances.keys().next().value;
            modelName = firstKey ? firstKey.replace('-', '/') : null; // Convert fp32-webgpu to fp32/webgpu
        }

        console.log(`[VoxLocal] Model status query - loaded: ${loaded}, modelName: ${modelName}`);
        sendResponse({ loaded, modelName });
        return true; // Keep the message channel open for async response
    }

    if (message.action === 'request_pending_chunks') {
        // Send any pending chunks for the specified request ID
        const requestId = message.requestId;
        const tabId = sender.tab?.id;
        console.log(`[VoxLocal] Content script requested pending chunks for request ${requestId}`);

        if (!tabId) {
            console.error('[VoxLocal] No valid tab ID found for pending chunks request');
            sendResponse({ success: false, error: 'No valid tab ID' });
            return true;
        }

        (async () => {
            await sendQueuedChunks(requestId, tabId);
            sendResponse({ success: true });
        })();
        return true;
    }

    if (message.action === 'chunk_played_back') {
        // Content script notifies us when a chunk finishes playback
        const chunkIndex = message.chunkIndex;
        const requestId = message.requestId;
        
        // Only process if it's for the current streaming request
        if (activeStreamingRequest && activeStreamingRequest.id === requestId) {
            onChunkPlayedBack(chunkIndex);
        }
        sendResponse({ success: true });
        return true;
    }

    if (message.action === 'speak_stream' || message.action === 'resume_stream') {
        console.log(`[VoxLocal] Received ${message.action} request - requestId: ${message.requestId}, dtype: ${message.dtype}, device: ${message.device}, voice: ${message.voice}, speed: ${message.speed}x`);

        const requestId = message.requestId || ++requestIdCounter;
        const tabId = sender.tab?.id;

        if (!tabId) {
            console.error('[VoxLocal] No valid tab ID found for streaming request');
            sendResponse({ success: false, error: 'No valid tab ID' });
            return true;
        }

        // Resuming after a pause: if this request is still being generated, nothing to do.
        // Otherwise (e.g. the service worker was restarted while paused) continue from where the content script left off.
        if (message.action === 'resume_stream' && activeStreamingRequest?.id === requestId && !activeStreamingRequest.cancelled) {
            sendResponse({ success: true, restarted: false });
            return true;
        }

        startStreamingRequest({
            requestId,
            tabId,
            text: message.text,
            voice: message.voice,
            speed: message.speed,
            dtype: message.dtype,
            device: message.device,
            startChunkIndex: message.startChunkIndex || 0,
            lastPlayedIndex: message.lastPlayedBackChunkIndex ?? -1
        });

        // Respond right away; progress/errors arrive as stream_* messages. Holding the response open
        // would fail with an error in the content script if the service worker is shut down while paused.
        sendResponse({ success: true, restarted: message.action === 'resume_stream' });

    } else if (message.action === 'cancel_stream') {
        // Handle streaming cancellation (only for the sender's own request, so Stop in one tab can't kill another)
        if (activeStreamingRequest && (message.requestId === undefined || message.requestId === activeStreamingRequest.id)) {
            console.log('[VoxLocal] Cancelling active streaming request');
            const requestId = activeStreamingRequest.id;
            activeStreamingRequest.cancelled = true;
            activeStreamingRequest = null;

            // Clear any pending chunks for this cancelled request
            if (pendingChunks.has(requestId)) {
                console.log(`[VoxLocal] Clearing ${pendingChunks.get(requestId).length} pending chunks for cancelled request ${requestId}`);
                pendingChunks.delete(requestId);
            }

            // Reset playback tracking and resume any waiting processing (so it can exit cleanly)
            lastPlayedBackChunkIndex = -1;
            if (processingResumeCallback) {
                const callback = processingResumeCallback;
                processingResumeCallback = null;
                callback(); // Resume to allow loop to check cancelled flag and exit
            }
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

// Clean up resources when extension is unloaded
chrome.runtime.onSuspend.addListener(() => {
    console.log('[VoxLocal] Extension suspending, cleaning up resources...');

    // Clear any pending chunks to prevent memory leaks
    pendingChunks.clear();

    // Cancel any active streaming request
    if (activeStreamingRequest) {
        activeStreamingRequest.cancelled = true;
        activeStreamingRequest = null;
    }

    // Reset playback tracking and resume any waiting processing (so it can exit cleanly)
    lastPlayedBackChunkIndex = -1;
    if (processingResumeCallback) {
        const callback = processingResumeCallback;
        processingResumeCallback = null;
        callback();
    }
});
//////////////////////////////////////////////////////////////

