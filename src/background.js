// background.js - Handles requests from the UI, runs the TTS model, then sends back audio

import { KokoroTTS } from 'kokoro-js';
import { splitTextIntoSentences } from './utils/textSplitter.js';

// Configure ONNX Runtime to suppress verbose warnings
// This prevents the "Some nodes were not assigned to the preferred execution providers" warning
if (typeof globalThis !== 'undefined') {
    // Configure ONNX Runtime environment before any models are loaded
    if (globalThis.ort) {
        globalThis.ort.env.logLevel = 'error'; // Only show errors, suppress warnings
        globalThis.ort.env.wasm.wasmPaths = ''; // Prevent additional WASM loading messages
    }

    // Set environment variables to suppress ONNX warnings
    if (typeof process !== 'undefined' && process.env) {
        process.env.ONNX_RUNTIME_LOG_LEVEL = '2'; // 0=verbose, 1=info, 2=warning, 3=error, 4=fatal
        process.env.ONNX_RUNTIME_DISABLE_TELEMETRY = '1';
    }
}

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
        await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PLAYER' });
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

            // Configure ONNX Runtime options to suppress warnings and optimize execution
            const ortOptions = {
                dtype: dtype,
                device: device,
                progress_callback: progress_callback
            };

            // Add execution provider configuration for WebGPU to reduce warnings
            if (device === 'webgpu') {
                ortOptions.executionProviders = [
                    {
                        name: 'webgpu',
                        deviceType: 'gpu'
                    }
                ];
                // Explicitly disable CPU fallback to reduce node assignment warnings
                ortOptions.disableCpuFallback = true;
                // Configure session options to suppress warnings
                ortOptions.sessionOptions = {
                    logLevel: 'error',
                    logId: 'VoxLocal-Kokoro',
                    enableProfiling: false,
                    enableMemPattern: true,
                    executionMode: 'sequential'
                };
            }

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
        // Check if streaming was cancelled
        if (activeStreamingRequest?.cancelled) {
            console.log('[VoxLocal] Streaming cancelled by user');
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

    try {
        // Check if text needs chunking by splitting it first
        const { splitTextIntoSentences } = await import('./utils/textSplitter.js');
        const textChunks = splitTextIntoSentences(info.selectionText);
        console.log(`[VoxLocal] Text split into ${textChunks.length} chunks for context menu TTS`);

        // If only one chunk, use regular TTS (more efficient for short text)
        if (textChunks.length === 1) {
            console.log('[VoxLocal] Single chunk detected, using regular TTS for efficiency');
            const result = await generateSpeech(
                info.selectionText,
                'af_heart', // Default voice for context menu
                1.0, // Default speed
                'fp32', // Default dtype
                'webgpu' // Default device
            );

            // Send single audio result to content script
            chrome.tabs.sendMessage(tab.id, {
                action: 'context_menu_single',
                audio: result.audio,
                sampleRate: result.sampleRate,
                voice: result.voice,
                speed: result.speed,
                text: info.selectionText
            }).catch(error => {
                console.log('[VoxLocal] Content script not ready for single audio playback, injecting direct playback');
                // Fallback to direct injection if content script isn't ready
                chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    args: [result],
                    function: (result) => {
                        try {
                            console.log('[VoxLocal] Playing context menu single audio');
                            const audioData = atob(result.audio);
                            const arrayBuffer = new ArrayBuffer(audioData.length);
                            const uint8Array = new Uint8Array(arrayBuffer);
                            for (let i = 0; i < audioData.length; i++) {
                                uint8Array[i] = audioData.charCodeAt(i);
                            }

                            const blob = new Blob([uint8Array], { type: 'audio/wav' });
                            const audioUrl = URL.createObjectURL(blob);
                            const audio = new Audio(audioUrl);
                            audio.playbackRate = result.speed || 1;

                            audio.onended = () => {
                                console.log('[VoxLocal] Context menu single audio playback completed');
                                URL.revokeObjectURL(audioUrl);
                            };

                            audio.play().catch(console.error);
                        } catch (error) {
                            console.error('[VoxLocal] Error playing context menu single audio:', error);
                        }
                    }
                });
            });
        } else {
            // Multiple chunks - use streaming TTS
            console.log(`[VoxLocal] Multiple chunks (${textChunks.length}) detected, using streaming TTS`);
            await generateStreamingSpeech(
                info.selectionText,
                'af_heart', // Default voice for context menu
                1.0, // Default speed
                'fp32', // Default dtype
                'webgpu', // Default device
                (chunkResult) => {
                    // Send chunk to content script for playback and state management
                    chrome.tabs.sendMessage(tab.id, {
                        action: 'context_menu_chunk',
                        ...chunkResult
                    }).catch(error => {
                        console.log('[VoxLocal] Content script not ready for chunk playback, injecting direct playback');
                        // Fallback to direct injection if content script isn't ready
                        chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            args: [chunkResult],
                            function: (chunkResult) => {
                                try {
                                    console.log(`[VoxLocal] Playing context menu chunk ${chunkResult.chunkIndex + 1}/${chunkResult.totalChunks}`);
                                    const audioData = atob(chunkResult.audio);
                                    const arrayBuffer = new ArrayBuffer(audioData.length);
                                    const uint8Array = new Uint8Array(arrayBuffer);
                                    for (let i = 0; i < audioData.length; i++) {
                                        uint8Array[i] = audioData.charCodeAt(i);
                                    }

                                    const blob = new Blob([uint8Array], { type: 'audio/wav' });
                                    const audioUrl = URL.createObjectURL(blob);
                                    const audio = new Audio(audioUrl);
                                    audio.playbackRate = chunkResult.speed || 1;

                                    audio.onended = () => {
                                        console.log(`[VoxLocal] Context menu chunk ${chunkResult.chunkIndex + 1} playback completed`);
                                        URL.revokeObjectURL(audioUrl);
                                    };

                                    audio.play().catch(console.error);
                                } catch (error) {
                                    console.error('[VoxLocal] Error playing context menu chunk:', error);
                                }
                            }
                        });
                    });
                });
        }

        // Send completion message (only for streaming, single audio handles its own completion)
        if (textChunks.length > 1) {
            chrome.tabs.sendMessage(tab.id, {
                action: 'context_menu_complete'
            }).catch(() => {
                // Ignore if content script isn't ready
            });
        }

    } catch (error) {
        console.error('[VoxLocal] Context menu TTS error:', error);
        chrome.tabs.sendMessage(tab.id, {
            action: 'context_menu_error',
            error: error.message
        }).catch(() => {
            // Ignore if content script isn't ready
        });
    }

    console.log('[VoxLocal] Context menu TTS processing completed');
});
//////////////////////////////////////////////////////////////

////////////////////// 2. Message Events /////////////////////
//
let activeStreamingRequest = null; // Track active streaming request
let requestIdCounter = 0;
let pendingChunks = new Map(); // Queue chunks for each request ID when content script is unavailable

// Function to send queued chunks/messages to content script
function sendQueuedChunks(requestId, tabId) {
    if (!pendingChunks.has(requestId)) {
        return;
    }

    const messages = pendingChunks.get(requestId);
    if (messages.length === 0) {
        return;
    }

    console.log(`[VoxLocal] Attempting to send ${messages.length} queued messages for request ${requestId} to tab ${tabId}`);

    // Send all pending messages
    for (const message of messages) {
        try {
            chrome.tabs.sendMessage(tabId, message).catch(error => {
                console.log(`[VoxLocal] Content script unavailable for message ${message.action}, will retry later`);
                // Don't remove from queue if sending failed
                return;
            });
            console.log(`[VoxLocal] Successfully sent queued message ${message.action}`);
        } catch (sendError) {
            console.log(`[VoxLocal] Content script unavailable for message ${message.action}, will retry later`);
            // Don't remove from queue if sending failed
            return;
        }
    }

    // If we got here, all messages were sent successfully
    pendingChunks.delete(requestId);
    console.log(`[VoxLocal] All queued messages sent for request ${requestId}`);
}

// Listen for messages from the UI, process it, and send the result back.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action !== 'speak' && message.action !== 'speak_stream' && message.action !== 'cancel_stream' && message.action !== 'query_model_status' && message.action !== 'request_pending_chunks') return; // Ignore messages that are not meant for speech generation or status queries.

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

        sendQueuedChunks(requestId, tabId);
        sendResponse({ success: true });
        return true;
    }

    if (message.action === 'speak_stream') {
        console.log(`[VoxLocal] Received streaming request - requestId: ${message.requestId}, dtype: ${message.dtype}, device: ${message.device}, voice: ${message.voice}, speed: ${message.speed}x`);

        // Handle streaming TTS
        if (activeStreamingRequest) {
            console.log('[VoxLocal] Cancelling previous streaming request');
            activeStreamingRequest.cancelled = true;
        }

        const requestId = message.requestId || ++requestIdCounter;
        const tabId = sender.tab?.id;

        if (!tabId) {
            console.error('[VoxLocal] No valid tab ID found for streaming request');
            sendResponse({ success: false, error: 'No valid tab ID' });
            return true;
        }

        activeStreamingRequest = { cancelled: false, id: requestId };

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
                        // Queue chunk for sending to content script only if streaming hasn't been cancelled
                        if (activeStreamingRequest?.id === requestId && !activeStreamingRequest.cancelled) {
                            console.log(`[VoxLocal] Queueing chunk ${chunkResult.chunkIndex + 1}/${chunkResult.totalChunks} for content script`);
                            if (!pendingChunks.has(requestId)) {
                                pendingChunks.set(requestId, []);
                            }
                            pendingChunks.get(requestId).push(chunkResult);

                            // Try to send immediately, but don't fail if content script is unavailable
                            if (tabId) {
                                sendQueuedChunks(requestId, tabId);
                            }
                        } else {
                            console.log(`[VoxLocal] Skipping chunk ${chunkResult.chunkIndex + 1}/${chunkResult.totalChunks} - streaming cancelled`);
                        }
                    }
                );

                // Send completion message
                if (activeStreamingRequest?.id === requestId && !activeStreamingRequest.cancelled) {
                    console.log('[VoxLocal] Streaming complete, queuing completion message');

                    // Add completion message to queue
                    if (!pendingChunks.has(requestId)) {
                        pendingChunks.set(requestId, []);
                    }
                    pendingChunks.get(requestId).push({ action: 'stream_complete' });

                    // Try to send immediately
                    if (tabId) {
                        sendQueuedChunks(requestId, tabId);
                    }
                }

                activeStreamingRequest = null;
                sendResponse({ success: true });

            } catch (error) {
                console.error('[VoxLocal] Streaming TTS error:', error);
                if (activeStreamingRequest?.id === requestId && !activeStreamingRequest.cancelled) {
                    console.log('[VoxLocal] Streaming error, queuing error message');

                    // Add error message to queue
                    if (!pendingChunks.has(requestId)) {
                        pendingChunks.set(requestId, []);
                    }
                    pendingChunks.get(requestId).push({
                        action: 'stream_error',
                        error: error.message
                    });

                    // Try to send immediately
                    if (tabId) {
                        sendQueuedChunks(requestId, tabId);
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
            const requestId = activeStreamingRequest.id;
            activeStreamingRequest.cancelled = true;
            activeStreamingRequest = null;

            // Clear any pending chunks for this cancelled request
            if (pendingChunks.has(requestId)) {
                console.log(`[VoxLocal] Clearing ${pendingChunks.get(requestId).length} pending chunks for cancelled request ${requestId}`);
                pendingChunks.delete(requestId);
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
});
//////////////////////////////////////////////////////////////

