// Text splitting utility to break long text into sentences for streaming TTS

/**
 * Common titles and abbreviations that shouldn't end sentences
 */
const NON_SENTENCE_ENDING_ABBREVIATIONS = [
    'Dr', 'Mr', 'Mrs', 'Ms', 'Prof', 'Sr', 'Jr', 'PhD', 'MD', 'DDS', 'DVM',
    'vs', 'etc', 'i.e', 'e.g', 'cf', 'et', 'al', 'ca', 'Inc', 'Ltd', 'Corp',
    'Co', 'LLC', 'LTD', 'GmbH', 'AG', 'SA', 'SAS', 'BV', 'NV', 'Pty', 'Ltd'
];

/**
 * Abbreviations with multiple periods that shouldn't end sentences
 */
const MULTI_PERIOD_ABBREVIATIONS = [
    'Ph.D.', 'i.e.', 'e.g.', 'etc.', 'vs.', 'cf.', 'et al.'
];

/**
 * Check if a period is part of a decimal number
 * @param {string} text - The full text
 * @param {number} periodIndex - Index of the period in the text
 * @returns {boolean} True if the period is part of a decimal number
 */
const isDecimalNumber = (text, periodIndex) => {
    // Look for digits before and after the period
    const before = text.slice(Math.max(0, periodIndex - 10), periodIndex);
    const after = text.slice(periodIndex + 1, periodIndex + 11);

    // Check if there's a digit before the period (within reasonable distance)
    const hasDigitBefore = /\d$/.test(before);
    // Check if there's a digit after the period
    const hasDigitAfter = /^\d/.test(after);

    return hasDigitBefore && hasDigitAfter;
};

/**
 * Check if a period is part of a common abbreviation that shouldn't end a sentence
 * @param {string} text - The full text
 * @param {number} periodIndex - Index of the period in the text
 * @returns {boolean} True if the period is part of an abbreviation
 */
const isAbbreviation = (text, periodIndex) => {
    // Check if this period is part of any multi-period abbreviation
    // Look at various window sizes to see if this period is covered by a multi-period abbreviation
    for (const abbrev of MULTI_PERIOD_ABBREVIATIONS) {
        // Check if this period is within a multi-period abbreviation
        // For each possible start position of the abbreviation that could cover this period
        for (let offset = 0; offset < abbrev.length; offset++) {
            const abbrevStart = periodIndex - offset;
            const abbrevEnd = abbrevStart + abbrev.length;
            if (abbrevStart >= 0 && abbrevEnd <= text.length &&
                text.slice(abbrevStart, abbrevEnd) === abbrev &&
                periodIndex >= abbrevStart && periodIndex < abbrevEnd) {
                return true;
            }
        }
    }

    // Then check for single abbreviations
    const beforePeriod = text.slice(Math.max(0, periodIndex - 20), periodIndex + 1);
    const singleAbbrevMatch = beforePeriod.match(/([A-Za-z]+)\.$/);
    if (!singleAbbrevMatch) return false;

    const potentialAbbrev = singleAbbrevMatch[1];
    return NON_SENTENCE_ENDING_ABBREVIATIONS.some(abbrev =>
        abbrev.toLowerCase() === potentialAbbrev.toLowerCase()
    );
};

/**
 * Find actual sentence boundaries, avoiding abbreviations and decimal numbers
 * @param {string} text - Text to analyze
 * @returns {number[]} Array of indices where sentences actually end
 */
const findSentenceBoundaries = (text) => {
    const boundaries = [];
    const regex = /[.!?]/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
        const index = match.index;
        const punctuation = match[0];

        // Skip if this is a decimal number
        if (punctuation === '.' && isDecimalNumber(text, index)) {
            continue;
        }

        // Skip if this is an abbreviation
        if (punctuation === '.' && isAbbreviation(text, index)) {
            continue;
        }

        // For periods, check if this appears to be a sentence boundary
        // For ! and ?, they're more reliably sentence endings
        if (punctuation === '.') {
            // Look for the next non-space character after the period
            let nextNonSpaceIndex = index + 1;
            while (nextNonSpaceIndex < text.length && text[nextNonSpaceIndex] === ' ') {
                nextNonSpaceIndex++;
            }

            // If at end of text, this is definitely a sentence end
            if (nextNonSpaceIndex >= text.length) {
                // Valid sentence boundary (end of text)
            }
            // If next non-space character matches our relaxed criteria, consider it a boundary
            else if (/^[A-Z0-9\(\["'\[]/.test(text[nextNonSpaceIndex])) {
                // Valid sentence boundary (uppercase, digit, or opening punctuation)
            }
            // Otherwise, skip this period (likely not a sentence boundary)
            else {
                continue;
            }
        }

        boundaries.push(index + 1); // Position after the punctuation
    }

    return boundaries;
};

/**
 * Split a long sentence at commas and periods, avoiding abbreviations and decimal numbers
 * @param {string} text - The sentence text to split
 * @returns {string[]} Array of sentence fragments
 */
const splitLongSentence = (text) => {
    // For long sentences, split at commas first, then fall back to word splitting
    const segments = [];
    let remainingText = text;
    let searchStart = 0;

    // Split at commas (but not if they're part of numbers or followed by no space)
    while ((searchStart = remainingText.indexOf(',', searchStart)) !== -1) {
        // Check if comma is followed by space (indicating it's a separator)
        if (searchStart < remainingText.length - 1 && remainingText[searchStart + 1] === ' ') {
            const beforeComma = remainingText.slice(0, searchStart + 1);
            segments.push(beforeComma);
            remainingText = remainingText.slice(searchStart + 1);
            searchStart = 0; // Reset search position for the new remainingText
        } else {
            // Comma not followed by space, skip this comma and continue searching
            searchStart += 1; // Advance past this comma
        }
    }

    // Add any remaining text
    if (remainingText) {
        segments.push(remainingText);
    }

    return segments;
};

/**
 * Split text into chunks with proper punctuation handling and maxLength enforcement
 * @param {string} text - The text to split
 * @param {number} maxLength - Maximum length for each chunk
 * @returns {string[]} Array of text chunks
 */
export const splitTextIntoSentences = (text, maxLength = 300) => {
    // Find actual sentence boundaries
    const boundaries = findSentenceBoundaries(text);

    let sentences = [];
    if (boundaries.length === 0) {
        // No sentence boundaries found, treat whole text as one sentence
        sentences = [text];
    } else {
        // Split text at sentence boundaries
        let start = 0;

        for (const boundary of boundaries) {
            sentences.push(text.slice(start, boundary));
            start = boundary;
        }

        // Add any remaining text
        if (start < text.length) {
            sentences.push(text.slice(start));
        }
    }

    const chunks = [];

    for (const sentence of sentences) {
        // Skip empty sentences but preserve whitespace-only ones that might contain spaces
        if (!sentence) continue;

        // Handle very long sentences that exceed maxLength by splitting them
        if (sentence.length > maxLength) {
            // Try to split at commas and periods first for better breaking points
            const subSentences = splitLongSentence(sentence);
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