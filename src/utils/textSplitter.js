// Text splitting utility to break long text into sentences for streaming TTS

/**
 * Split text into chunks with proper punctuation handling and maxLength enforcement
 * @param {string} text - The text to split
 * @param {number} maxLength - Maximum length for each chunk
 * @returns {string[]} Array of text chunks
 */
export const splitTextIntoSentences = (text, maxLength = 300) => {
    // Split text into sentences while preserving punctuation and trailing text
    const sentences = splitAtPunctuation(text, /[^.!?]+[.!?]+/g);

    const chunks = [];

    for (const sentence of sentences) {
        // Skip empty sentences but preserve whitespace-only ones that might contain spaces
        if (!sentence) continue;

        // Handle very long sentences that exceed maxLength by splitting them
        if (sentence.length > maxLength) {
            // Try to split at commas and periods first for better breaking points
            const subSentences = splitAtPunctuation(sentence, /[^.,]+[.,]+/g);
            const sentenceChunks = splitTextIntoChunks(subSentences, maxLength);
            chunks.push(...sentenceChunks);
        } else {
            // Keep each sentence as a separate chunk for better streaming
            chunks.push(sentence);
        }
    }

    // If no sentences were found or text is very short, return the original text as one chunk
    return chunks.length > 0 ? chunks : [text];
};

/**
 * Split text at punctuation marks and preserve trailing text
 * @param {string} text - Text to split
 * @param {RegExp} pattern - Regex pattern to match punctuation groups
 * @returns {string[]} Array of split text segments
 */
const splitAtPunctuation = (text, pattern) => {
    const matches = text.match(pattern) || [];
    if (matches.length === 0) {
        return [text];
    }

    const consumedLength = matches.reduce((len, s) => len + s.length, 0);
    const remainder = text.slice(consumedLength);

    return remainder ? [...matches, remainder] : matches;
};

/**
 * Split an array of text segments into chunks that respect maxLength
 * @param {string[]} segments - Text segments to process
 * @param {number} maxLength - Maximum length for each chunk
 * @returns {string[]} Array of chunks
 */
const splitTextIntoChunks = (segments, maxLength) => {
    const chunks = [];
    let currentChunk = '';

    for (const segment of segments) {
        const potentialChunk = currentChunk + (currentChunk ? ' ' : '') + segment;

        if (potentialChunk.length > maxLength) {
            if (currentChunk) {
                chunks.push(currentChunk);
                currentChunk = segment;
            } else {
                // Segment itself is too long, split it further
                const subChunks = splitLargeText(segment, maxLength);
                chunks.push(...subChunks);
            }
        } else {
            currentChunk = potentialChunk;
        }
    }

    if (currentChunk) {
        chunks.push(currentChunk);
    }

    return chunks;
};

/**
 * Split large text that exceeds maxLength using word and character splitting
 * @param {string} text - Text to split
 * @param {number} maxLength - Maximum length for each chunk
 * @returns {string[]} Array of chunks
 */
const splitLargeText = (text, maxLength) => {
    const chunks = [];
    const words = text.split(' ');
    let currentChunk = '';

    for (const word of words) {
        const potentialChunk = currentChunk + (currentChunk ? ' ' : '') + word;

        if (potentialChunk.length > maxLength) {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
                currentChunk = word;
            } else {
                // Word itself is too long, split at character level
                const charChunks = splitAtCharacterLevel(word, maxLength);
                chunks.push(...charChunks);
            }
        } else {
            currentChunk = potentialChunk;
        }
    }

    // Handle any remaining text
    if (currentChunk) {
        if (currentChunk.length > maxLength) {
            const charChunks = splitAtCharacterLevel(currentChunk, maxLength);
            chunks.push(...charChunks);
        } else {
            chunks.push(currentChunk);
        }
    }

    return chunks;
};

/**
 * Split text at character level to respect maxLength
 * @param {string} text - Text to split
 * @param {number} maxLength - Maximum length for each chunk
 * @returns {string[]} Array of character-level chunks
 */
const splitAtCharacterLevel = (text, maxLength) => {
    const chunks = [];
    let currentChunk = '';

    for (const char of text) {
        if ((currentChunk + char).length > maxLength) {
            if (currentChunk) {
                chunks.push(currentChunk);
                currentChunk = char;
            } else {
                // Single character exceeds maxLength (shouldn't happen in practice)
                chunks.push(char);
            }
        } else {
            currentChunk += char;
        }
    }

    if (currentChunk) {
        chunks.push(currentChunk);
    }

    return chunks;
};