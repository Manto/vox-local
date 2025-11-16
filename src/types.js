// Shared type definitions for the VoxLocal TTS extension

/**
 * @typedef {Object} TTSSettings
 * @property {string} voice - The voice to use for TTS
 * @property {number} speed - Playback speed multiplier
 * @property {string} dtype - Model data type/quality setting
 * @property {string} device - Device to run model on (webgpu/wasm)
 * @property {boolean} autoHighlight - Whether to highlight text while speaking
 */

/**
 * Message types for communication between extension components
 */
const MessageTypes = {
  // Content script messages
  GET_SELECTION: 'GET_SELECTION',
  GET_PAGE_TEXT: 'GET_PAGE_TEXT',
  LOAD_TTS: 'LOAD_TTS',
  SPEAK_TEXT: 'SPEAK_TEXT',
  STOP_SPEAKING: 'STOP_SPEAKING',
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',
  GET_TTS_STATUS: 'GET_TTS_STATUS',

  // Legacy popup messages
  SPEAK: 'speak',

  // Streaming TTS messages
  SPEAK_STREAM: 'speak_stream',
  STREAM_CHUNK: 'stream_chunk',
  STREAM_COMPLETE: 'stream_complete',
  STREAM_ERROR: 'stream_error'
};

export { MessageTypes };
