import { splitTextIntoSentences } from '../src/utils/textSplitter.js';

describe('splitTextIntoSentences', () => {
    describe('Basic sentence splitting', () => {
        test('should split text into sentences at period, exclamation, and question marks', () => {
            const text = 'Hello world. How are you? I am fine!';
            const result = splitTextIntoSentences(text, 100);

            expect(result).toEqual([
                'Hello world.',
                ' How are you?',
                ' I am fine!'
            ]);
        });

        test('should handle single sentence', () => {
            const text = 'This is a single sentence.';
            const result = splitTextIntoSentences(text, 100);

            expect(result).toEqual(['This is a single sentence.']);
        });

        test('should handle text without punctuation', () => {
            const text = 'This is text without punctuation';
            const result = splitTextIntoSentences(text, 100);

            expect(result).toEqual([text]);
        });

        test('should preserve trailing text without punctuation', () => {
            const text = 'Hello world. This has no ending punctuation';
            const result = splitTextIntoSentences(text, 100);

            expect(result).toEqual([
                'Hello world.',
                ' This has no ending punctuation'
            ]);
        });
    });

    describe('Sub-sentence splitting', () => {
        test('should split long sentences at commas and periods', () => {
            const text = 'This is a very long sentence, with multiple parts. It should be split at commas and periods.';
            const result = splitTextIntoSentences(text, 50);

            expect(result.length).toBeGreaterThan(1);
            expect(result.every(chunk => chunk.length <= 50)).toBe(true);
        });

        test('should preserve trailing text in sub-sentences', () => {
            const text = 'Short sentence. Very long sentence with comma, and more text without ending punctuation';
            const result = splitTextIntoSentences(text, 50);

            expect(result.length).toBeGreaterThan(2);
            expect(result.some(chunk => chunk.includes('without ending punctuation'))).toBe(true);
        });
    });

    describe('Word-level splitting', () => {
        test('should split very long words at character level', () => {
            const longWord = 'A'.repeat(100);
            const text = `Short text. ${longWord} more text.`;
            const result = splitTextIntoSentences(text, 50);

            expect(result.length).toBeGreaterThan(2);
            expect(result.every(chunk => chunk.length <= 50)).toBe(true);
        });

        test('should handle multiple long words', () => {
            const text = `${'A'.repeat(80)} ${'B'.repeat(80)}`;
            const result = splitTextIntoSentences(text, 50);

            expect(result.every(chunk => chunk.length <= 50)).toBe(true);
        });
    });

    describe('maxLength enforcement', () => {
        test('should never exceed maxLength for any chunk', () => {
            const text = 'A'.repeat(1000);
            const result = splitTextIntoSentences(text, 50);

            expect(result.every(chunk => chunk.length <= 50)).toBe(true);
        });

        test('should handle edge case with exact maxLength', () => {
            const text = 'A'.repeat(50) + ' B'.repeat(49);
            const result = splitTextIntoSentences(text, 50);

            expect(result.every(chunk => chunk.length <= 50)).toBe(true);
        });

        test('should handle very small maxLength', () => {
            const text = 'Hello world this is a test';
            const result = splitTextIntoSentences(text, 5);

            expect(result.every(chunk => chunk.length <= 5)).toBe(true);
        });
    });

    describe('Edge cases', () => {
        test('should handle empty string', () => {
            const result = splitTextIntoSentences('', 100);
            expect(result).toEqual(['']);
        });

        test('should handle whitespace only', () => {
            const result = splitTextIntoSentences('   \n\t  ', 100);
            expect(result).toEqual(['   \n\t  ']);
        });

        test('should handle very short maxLength with punctuation', () => {
            const text = 'A.B.C.D.';
            const result = splitTextIntoSentences(text, 1);

            expect(result.every(chunk => chunk.length <= 1)).toBe(true);
        });

        test('should handle mixed punctuation', () => {
            const text = 'First sentence! Second sentence? Third sentence. Fourth sentence, with comma and more text';
            const result = splitTextIntoSentences(text, 30);

            expect(result.length).toBeGreaterThan(3);
            expect(result.every(chunk => chunk.length <= 30)).toBe(true);
        });

        test('should handle consecutive punctuation', () => {
            const text = 'Wow!!! Really??? No way... This is, like, amazing.';
            const result = splitTextIntoSentences(text, 100);

            expect(result.length).toBeGreaterThan(3);
        });

        test('should preserve spacing and formatting', () => {
            const text = 'First.  Second.   Third.';
            const result = splitTextIntoSentences(text, 100);

            expect(result).toEqual(['First.', '  Second.', '   Third.']);
        });

        test('should not split at titles like Dr.', () => {
            const text = 'Dr. Chung went to the store. He bought some milk.';
            const result = splitTextIntoSentences(text, 100);

            expect(result).toEqual([
                'Dr. Chung went to the store.',
                ' He bought some milk.'
            ]);
        });

        test('should not split at decimal numbers', () => {
            const text = 'The price is 12.30 dollars. That is expensive.';
            const result = splitTextIntoSentences(text, 100);

            expect(result).toEqual([
                'The price is 12.30 dollars.',
                ' That is expensive.'
            ]);
        });

        test('should not split at common abbreviations', () => {
            const text = 'Mr. Smith and Mrs. Jones went to the store. They bought groceries.';
            const result = splitTextIntoSentences(text, 100);

            expect(result).toEqual([
                'Mr. Smith and Mrs. Jones went to the store.',
                ' They bought groceries.'
            ]);
        });

        test('should handle multiple abbreviations in one sentence', () => {
            const text = 'Dr. Smith, PhD, and Prof. Johnson attended the conference. It was very interesting.';
            const result = splitTextIntoSentences(text, 100);

            expect(result).toEqual([
                'Dr. Smith, PhD, and Prof. Johnson attended the conference.',
                ' It was very interesting.'
            ]);
        });
    });

    describe('Integration tests', () => {
        test('should handle complex real-world text', () => {
            const text = `Dr. Smith went to Washington. He had an important meeting with Senator Johnson, who was known for his long speeches. The meeting lasted for hours, and by the end everyone was exhausted. However, the results were worth it - they secured funding for the new research project that could change everything.

Meanwhile, back at the lab, Dr. Chen was working on the prototype. It was a complex device with many moving parts, but she was determined to make it work. After countless iterations and late nights, she finally got it functioning properly.

The team celebrated their success, knowing that this was just the beginning of something much bigger. What challenges lay ahead? Only time would tell.`;

            const result = splitTextIntoSentences(text, 200);

            expect(result.length).toBeGreaterThan(5);
            expect(result.every(chunk => chunk.length <= 200)).toBe(true);

            // Check that no text is lost
            const joinedResult = result.join('');
            expect(joinedResult).toBe(text);
        });

        test('should maintain text integrity across all chunks', () => {
            const text = 'Sentence one. Sentence two, with comma and trailing text without punctuation';
            const result = splitTextIntoSentences(text, 20);

            // Rejoin all chunks and verify they equal the original
            const rejoined = result.join('');
            expect(rejoined).toBe(text);
        });
    });

    describe('Parameter validation', () => {
        test('should use default maxLength of 300', () => {
            const text = 'A'.repeat(400);
            const result = splitTextIntoSentences(text);

            // Should split the 400-character text with default 300 limit
            expect(result.some(chunk => chunk.length > 300)).toBe(false);
        });

        test('should handle maxLength of 1', () => {
            const text = 'ABC';
            const result = splitTextIntoSentences(text, 1);

            expect(result.every(chunk => chunk.length <= 1)).toBe(true);
        });
    });
});
