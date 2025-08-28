// background.js

// This function will be injected to perform the upload.
async function performUpload(fileData) {
    const { name, dataUrl } = fileData;
    const episodeTitle = name.replace(/\.mp3$/, '').replace(/[-_]/g, ' ');
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    console.log(`[Uploader] Processing: ${name}`);
    try {
        console.log('[Uploader] Page is ready. Looking for file input...');
        // A more robust wait to ensure the page is interactive
        await new Promise(resolve => {
            if (document.readyState === 'complete') {
                resolve();
            } else {
                window.addEventListener('load', resolve);
            }
        });
        await sleep(2000); // Extra wait for any post-load scripts

        const fileInput = await (async () => {
            for (let i = 0; i < 20; i++) { // Wait up to 20 seconds
                const el = document.querySelector('input[type=file]');
                if (el) return el;
                await sleep(1000);
            }
            throw new Error('Timed out waiting for file input.');
        })();
        
        const response = await fetch(dataUrl);
        const blob = await response.blob();
        const file = new File([blob], name, { type: blob.type });

        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fileInput.files = dataTransfer.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        console.log(`[Uploader] Attached ${name}. Waiting for upload to complete...`);

        const titleInput = await (async () => {
            for (let i = 0; i < 45; i++) { // Wait up to 4.5 minutes for slow uploads
                const el = document.querySelector('textarea[id="title-input"]');
                if (el) return el;
                await sleep(6000);
            }
            throw new Error('Timed out waiting for title input to appear after upload.');
        })();

        console.log(`[Uploader] Setting title and description to: "${episodeTitle}"`);
        titleInput.focus();
        document.execCommand('insertText', false, episodeTitle);
        titleInput.dispatchEvent(new Event('input', { bubbles: true }));

        const descriptionBox = document.querySelector('div[role="textbox"]');
        if (descriptionBox) {
            descriptionBox.focus();
            descriptionBox.innerHTML = `<p>${episodeTitle}</p>`;
            descriptionBox.dispatchEvent(new Event('input', { bubbles: true }));
        }

        await sleep(2000); // Wait for UI to update

        console.log('[Uploader] Clicking "Next"...');
        const nextButton = document.evaluate("//button[contains(., 'Next')]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (nextButton) nextButton.click();
        else throw new Error('Could not find the "Next" button.');

        await sleep(7000); // Wait for the final review page to load

        console.log('[Uploader] Clicking "Publish"...');
        const publishButton = document.evaluate("//button[contains(., 'Publish')]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (publishButton) publishButton.click();
        else throw new Error('Could not find the "Publish" button.');

        console.log(`[Uploader] Successfully published ${name}.`);
        await sleep(8000); // Wait for publishing to finalize
        return { success: true };

    } catch (error) {
        console.error(`[Uploader] Automation failed for ${name}:`, error);
        alert(`Automation failed for ${name}. Check the console. See the "Inspect views" link on the chrome://extensions page for background logs.`);
        return { success: false, error: error.message };
    }
}

// Listen for messages from the popup script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startUpload') {
        console.log('[Background] Received upload request for', message.files.length, 'files.');
        // Start the upload process, but don't rely on sender.tab
        processFiles(message.files);
        return true; // Indicates we will send a response asynchronously
    }
});

// A more robust way to wait for a tab to be ready
function waitForTabLoad(tabId) {
    return new Promise((resolve) => {
        const listener = (updatedTabId, changeInfo) => {
            // Wait for the tab we created to be fully loaded
            if (updatedTabId === tabId && changeInfo.status === 'complete') {
                // Remove the listener to avoid memory leaks
                chrome.tabs.onUpdated.removeListener(listener);
                resolve(true);
            }
        };
        chrome.tabs.onUpdated.addListener(listener);
    });
}


// REVISED: processFiles function to handle tabs sequentially
async function processFiles(files) {
    const uploadUrl = 'https://creators.spotify.com/pod/dashboard/episode/new';
    
    // Get the currently active tab to start the process.
    const [originalTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!originalTab) {
        console.error("[Background] Could not find an active tab to start the upload process.");
        alert("Could not find an active tab. Please make sure you are on a Spotify page and try again.");
        return;
    }

    let currentTabId = originalTab.id;

    for (const fileData of files) {
        console.log(`[Background] Preparing to upload ${fileData.name}`);
        
        // For the first file, use the original tab. For subsequent files, create a new one.
        if (files.indexOf(fileData) === 0) {
            console.log(`[Background] Using original tab for the first file.`);
            await chrome.tabs.update(currentTabId, { url: uploadUrl, active: true });
        } else {
            console.log(`[Background] Creating new tab for ${fileData.name}`);
            const newTab = await chrome.tabs.create({ url: uploadUrl, active: true });
            currentTabId = newTab.id;
        }
        
        // Wait for the tab to be fully loaded
        await waitForTabLoad(currentTabId);
        console.log(`[Background] Tab for ${fileData.name} is ready. Injecting script.`);

        // Inject and execute the upload script in the new tab
        const results = await chrome.scripting.executeScript({
            target: { tabId: currentTabId },
            func: performUpload,
            args: [fileData]
        });

        const result = results[0]?.result;
        if (!result || !result.success) {
            console.error(`[Background] Upload failed for ${fileData.name}. Stopping bulk process.`);
            // Leave the failed tab open for debugging.
            break; // Stop the loop if one file fails
        } else {
             console.log(`[Background] Finished processing ${fileData.name}. Closing tab if it's not the original one.`);
             // Close the tab after a successful upload, but only if it's a new tab we created
             if (currentTabId !== originalTab.id) {
                 await new Promise(r => setTimeout(r, 2000)); // Brief pause before closing
                 chrome.tabs.remove(currentTabId);
             }
        }
    }
    console.log('[Background] Bulk upload process finished.');
}
