// Stands in for the extension APIs so the built content script can run in a plain page.
// Tests play the background's part by dispatching messages through window.__vox.dispatch().
// Passed to page.addInitScript(), so it must not reference anything outside the function.
export function installFakeChrome() {
    const listeners = [];
    const storage = {};

    // Mono 16-bit WAV of a quiet 440Hz tone, base64 encoded like the background's chunks
    function wav(seconds) {
        const sampleRate = 24000;
        const samples = Math.round(sampleRate * seconds);
        const buffer = new ArrayBuffer(44 + samples * 2);
        const view = new DataView(buffer);
        const writeString = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + samples * 2, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeString(36, 'data');
        view.setUint32(40, samples * 2, true);
        for (let i = 0; i < samples; i++) {
            view.setInt16(44 + i * 2, Math.sin((i * 2 * Math.PI * 440) / sampleRate) * 3000, true);
        }

        let binary = '';
        new Uint8Array(buffer).forEach(byte => { binary += String.fromCharCode(byte); });
        return btoa(binary);
    }

    window.__vox = {
        sent: [],
        storage,
        wav,
        dispatch(message) {
            for (const listener of listeners) listener(message, {}, () => {});
        },
    };

    window.chrome = {
        runtime: {
            lastError: undefined,
            onMessage: { addListener: listener => listeners.push(listener) },
            sendMessage(message, callback) {
                window.__vox.sent.push(message);
                if (callback) setTimeout(() => callback({ success: true }), 0);
            },
            getURL: path => path,
        },
        storage: {
            sync: {
                get: async key => (key in storage ? { [key]: storage[key] } : {}),
                set: async items => { Object.assign(storage, items); },
            },
        },
    };
}
