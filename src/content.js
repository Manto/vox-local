// content.js - the content scripts which is run in the context of web pages, and has access
// to the DOM and other web APIs. Handles text extraction for TTS functionality.

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case 'GET_SELECTION':
            sendResponse({ text: getSelectedText() });
            break;

        case 'GET_PAGE_TEXT':
            sendResponse({ text: getPageText() });
            break;

        default:
            sendResponse({ success: false, error: 'Unknown message type' });
    }
    return true; // Keep channel open for async response
});

// Get selected text from the page
function getSelectedText() {
    const selection = window.getSelection();
    return selection ? selection.toString().trim() : '';
}

// Get readable text from the entire page
function getPageText() {
    // Clone the body to avoid modifying the original
    const clone = document.body.cloneNode(true);

    // Remove unwanted elements
    const selectorsToRemove = [
        'script', 'style', 'noscript', 'iframe', 'nav', 'header', 'footer', 'aside',
        '[role="navigation"]', '[role="banner"]', '[role="complementary"]'
    ];

    selectorsToRemove.forEach(selector => {
        clone.querySelectorAll(selector).forEach(el => el.remove());
    });

    // Get text content and clean it up
    let text = clone.textContent || '';
    text = text
        .replace(/\n\s*\n/g, '\n\n')  // Remove excessive newlines
        .replace(/[ \t]+/g, ' ')       // Normalize whitespace
        .trim();

    return text;
}
