// kittenTTS.js - Kitten TTS Mini (StyleTTS 2 based) engine, exposing the same
// generate(text, { voice, speed }) -> RawAudio shape as KokoroTTS.
//
// Ported from the reference Python implementation:
// https://github.com/KittenML/KittenTTS/blob/main/kittenml/kittentts_legacy/onnx_model.py

import * as ort from 'onnxruntime-web';
import { phonemize } from 'phonemizer';
import { RawAudio } from '@huggingface/transformers';

const MODEL_ID = 'KittenML/kitten-tts-mini-0.8';
const BASE_URL = `https://huggingface.co/${MODEL_ID}/resolve/main`;
const MODEL_FILE = 'kitten_tts_mini_v0_8.onnx';
const VOICES_FILE = 'voices.npz';
const CACHE_NAME = 'kitten-tts';
const SAMPLE_RATE = 24000;
const TRIM_SAMPLES = 5000; // The reference implementation drops this many trailing samples
const STYLE_DIM = 256;

// Display name -> voice id inside voices.npz (from the model's config.json)
export const KITTEN_VOICES = Object.freeze({
    Bella: 'expr-voice-2-f',
    Jasper: 'expr-voice-2-m',
    Luna: 'expr-voice-3-f',
    Bruno: 'expr-voice-3-m',
    Rosie: 'expr-voice-4-f',
    Hugo: 'expr-voice-4-m',
    Kiki: 'expr-voice-5-f',
    Leo: 'expr-voice-5-m',
});

// Symbol table from the reference TextCleaner. Duplicate symbols map to their
// last index, matching the Python dict construction.
const SYMBOLS = [
    '$',
    ';:,.!?¡¿—…"«»"" ',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    "ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘'̩'ᵻ",
].flatMap(group => Array.from(group));

const SYMBOL_TO_ID = new Map();
SYMBOLS.forEach((symbol, index) => SYMBOL_TO_ID.set(symbol, index));

const PAD_ID = 0;
const END_ID = 10;

// Punctuation is kept as-is and only the text between it is phonemized
// (equivalent to espeak's preserve_punctuation=True)
const PUNCTUATION_PATTERN = /(\s*[;:,.!?¡¿—…"«»“”(){}[\]]+\s*)+/g;

async function phonemizeText(text) {
    const parts = [];
    let lastIndex = 0;
    for (const match of text.matchAll(PUNCTUATION_PATTERN)) {
        if (match.index > lastIndex) {
            parts.push({ punctuation: false, text: text.slice(lastIndex, match.index) });
        }
        parts.push({ punctuation: true, text: match[0] });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
        parts.push({ punctuation: false, text: text.slice(lastIndex) });
    }

    const phonemized = await Promise.all(parts.map(async (part) =>
        part.punctuation ? part.text : (await phonemize(part.text, 'en-us')).join(' ')
    ));
    return phonemized.join('').trim();
}

// Mirrors basic_english_tokenize() + ' '.join() + TextCleaner from the reference implementation
function tokenize(phonemes) {
    const words = phonemes.match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu) ?? [];
    const ids = [PAD_ID];
    for (const char of words.join(' ')) {
        const id = SYMBOL_TO_ID.get(char);
        if (id !== undefined) ids.push(id);
    }
    ids.push(END_ID, PAD_ID);
    return ids;
}

// The model expects each chunk to end with prosodic punctuation (reference ensure_punctuation)
function ensurePunctuation(text) {
    text = text.trim();
    if (text && !'.!?,;:'.includes(text.at(-1))) {
        text += ',';
    }
    return text;
}

// Fetch a model file, serving it from the Cache API when available
async function fetchCached(url, progress_callback) {
    let cache;
    try {
        cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(url);
        if (cached) return await cached.arrayBuffer();
    } catch (error) {
        console.warn('[VoxLocal] Unable to open Kitten TTS cache', error);
    }

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    }

    const total = Number(response.headers.get('content-length')) || 0;
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (total && progress_callback) {
            progress_callback({ status: 'progress', file: url, loaded, total, progress: (loaded / total) * 100 });
        }
    }

    const data = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
    }

    if (cache) {
        try {
            await cache.put(url, new Response(data, { headers: response.headers }));
        } catch (error) {
            console.warn('[VoxLocal] Unable to cache Kitten TTS file', error);
        }
    }
    return data.buffer;
}

// Parse a float32 .npy file into { shape, data }
function parseNpy(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const major = bytes[6];
    const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
    const headerStart = major === 1 ? 10 : 12;
    const header = new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLength));

    if (!header.includes("'<f4'")) {
        throw new Error(`Unsupported voice data type in header: ${header}`);
    }
    const shape = header.match(/'shape':\s*\(([^)]*)\)/)[1]
        .split(',').map(s => s.trim()).filter(Boolean).map(Number);

    // Copy so the Float32Array is 4-byte aligned
    const dataStart = headerStart + headerLength;
    const data = new Float32Array(bytes.slice(dataStart).buffer);
    return { shape, data };
}

// Parse an uncompressed .npz (zip of .npy files) into a Map of name -> { shape, data }
function parseNpz(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const arrays = new Map();
    let offset = 0;

    while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
        const method = view.getUint16(offset + 8, true);
        let size = view.getUint32(offset + 18, true);
        const nameLength = view.getUint16(offset + 26, true);
        const extraLength = view.getUint16(offset + 28, true);
        const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));

        // numpy writes zip64 entries; the real size then lives in the zip64 extra field
        if (size === 0xffffffff) {
            let extra = offset + 30 + nameLength;
            const extraEnd = extra + extraLength;
            while (extra + 4 <= extraEnd) {
                const id = view.getUint16(extra, true);
                const length = view.getUint16(extra + 2, true);
                if (id === 0x0001) {
                    size = Number(view.getBigUint64(extra + 12, true)); // [uncompressed, compressed]
                    break;
                }
                extra += 4 + length;
            }
        }

        if (method !== 0) {
            throw new Error(`Compressed npz entries are not supported (${name})`);
        }

        const dataStart = offset + 30 + nameLength + extraLength;
        arrays.set(name.replace(/\.npy$/, ''), parseNpy(bytes.subarray(dataStart, dataStart + size)));
        offset = dataStart + size;
    }

    return arrays;
}

export class KittenTTS {
    constructor(session, voices) {
        this.session = session;
        this.voices = voices;
    }

    static async from_pretrained({ progress_callback = null } = {}) {
        const [modelBuffer, voicesBuffer] = await Promise.all([
            fetchCached(`${BASE_URL}/${MODEL_FILE}`, progress_callback),
            fetchCached(`${BASE_URL}/${VOICES_FILE}`),
        ]);

        // Always wasm: the WebGPU session loads without error but returns an all-NaN waveform
        const session = await ort.InferenceSession.create(new Uint8Array(modelBuffer), { executionProviders: ['wasm'] });
        console.log('[VoxLocal] Kitten TTS session created with wasm');

        return new KittenTTS(session, parseNpz(voicesBuffer));
    }

    async generate(text, { voice = 'Bella', speed = 1 } = {}) {
        const voiceId = KITTEN_VOICES[voice];
        const voiceData = voiceId && this.voices.get(voiceId);
        if (!voiceData) {
            throw new Error(`Voice "${voice}" not found. Should be one of: ${Object.keys(KITTEN_VOICES).join(', ')}.`);
        }

        text = ensurePunctuation(text);
        const ids = tokenize(await phonemizeText(text));

        // The style vector is chosen by input text length in code points, as in the reference implementation
        const styleRow = Math.min(Array.from(text).length, voiceData.shape[0] - 1);
        const style = voiceData.data.slice(styleRow * STYLE_DIM, (styleRow + 1) * STYLE_DIM);

        const { waveform } = await this.session.run({
            input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
            style: new ort.Tensor('float32', style, [1, STYLE_DIM]),
            speed: new ort.Tensor('float32', new Float32Array([speed]), [1]),
        });

        const samples = waveform.data;
        const trimmed = samples.length > TRIM_SAMPLES ? samples.slice(0, samples.length - TRIM_SAMPLES) : samples;
        return new RawAudio(trimmed, SAMPLE_RATE);
    }
}
