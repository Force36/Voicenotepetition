// popup.js
document.getElementById('uploadButton').addEventListener('click', () => {
    document.getElementById('fileInput').click();
});

document.getElementById('fileInput').addEventListener('change', (event) => {
    const files = event.target.files;
    if (files.length === 0) {
        console.log('No files selected.');
        return;
    }

    const filesToUpload = [];
    let filesProcessed = 0;

    Array.from(files).forEach(file => {
        const reader = new FileReader();
        reader.onload = (e) => {
            filesToUpload.push({
                name: file.name,
                dataUrl: e.target.result
            });
            
            filesProcessed++;
            if (filesProcessed === files.length) {
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    const tabId = tabs[0].id;
                    chrome.scripting.executeScript({
                        target: { tabId: tabId },
                        func: processFilesSequentially,
                        args: [filesToUpload]
                    });
                });
                window.close();
            }
        };
        reader.readAsDataURL(file);
    });
});

// This is the main function that will be injected into the Spotify page
async function processFilesSequentially(files) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    for (const fileData of files) {
        const { name, dataUrl } = fileData;
        const episodeTitle = name.replace(/\.mp3$/, '').replace(/[-_]/g, ' ');

        console.log(`[Uploader] Starting process for: ${name}`);
        
        try {
            // --- Step 1: Attach the file to the input ---
            console.log('[Uploader] Looking for file input...');
            const fileInput = document.querySelector('input[type=file]');
            if (!fileInput) throw new Error('Could not find file input on the page. Make sure you are on the "Create episode" page.');

            const response = await fetch(dataUrl);
            const blob = await response.blob();
            const file = new File([blob], name, { type: blob.type });
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            fileInput.files = dataTransfer.files;
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            console.log(`[Uploader] Attached ${name}. Waiting for upload...`);

            // --- Step 2: Wait for upload to complete and title field to appear ---
            const titleInput = await (async () => {
                for (let i = 0; i < 45; i++) {
                    const el = document.querySelector('input[id="title-input"]');
                    if (el) return el;
                    await sleep(6000);
                }
                throw new Error('Timed out waiting for title input to appear after upload.');
            })();

            // --- Step 3: Set title and description ---
            console.log(`[Uploader] Setting title to: "${episodeTitle}"`);
            titleInput.focus();
            titleInput.value = episodeTitle;
            titleInput.dispatchEvent(new Event('input', { bubbles: true }));
            titleInput.dispatchEvent(new Event('change', { bubbles: true }));
            console.log(`[Uploader] Title field value is now: "${titleInput.value}"`);
            
            // --- FINAL REVISED DESCRIPTION LOGIC ---
            console.log('[Uploader] Attempting to set description by toggling HTML mode...');
            
            const htmlToggleLabel = await (async () => {
                for (let i = 0; i < 15; i++) {
                    const el = document.querySelector('label[data-encore-id="FormToggle"]');
                    if (el) return el;
                    await sleep(1000);
                }
                throw new Error('Timed out waiting for the HTML toggle switch.');
            })();
            
            const htmlToggleInput = htmlToggleLabel.querySelector('input[type="checkbox"]');
            if (!htmlToggleInput) {
                 throw new Error('Could not find the checkbox inside the HTML toggle label.');
            }

            if (!htmlToggleInput.checked) {
                console.log('[Uploader] HTML mode is off. Performing forceful coordinate-based click to enable it.');
                const rect = htmlToggleLabel.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                
                htmlToggleLabel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
                htmlToggleLabel.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
                htmlToggleLabel.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
                
                await sleep(1000); // Wait for the DOM to update
            } else {
                console.log('[Uploader] HTML mode is already enabled.');
            }

            const descriptionTextarea = await (async () => {
                for (let i = 0; i < 10; i++) {
                    const el = document.querySelector('textarea[name="description"]');
                    if (el) return el;
                    await sleep(1000);
                }
                throw new Error('Could not find the description textarea after enabling HTML mode.');
            })();

            console.log('[Uploader] Setting value on the description textarea...');
            descriptionTextarea.focus();
            descriptionTextarea.value = episodeTitle;
            descriptionTextarea.dispatchEvent(new Event('input', { bubbles: true }));
            descriptionTextarea.dispatchEvent(new Event('change', { bubbles: true }));
            descriptionTextarea.blur();

            console.log(`[Uploader] Description textarea value set to: "${descriptionTextarea.value}"`);
            
            await sleep(2000); // Give the UI time to update

            // --- Step 4: Click "Next" ---
            console.log('[Uploader] Clicking "Next"...');
            const nextButton = document.evaluate("//button[contains(., 'Next')]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (nextButton) nextButton.click();
            else throw new Error('Could not find the "Next" button.');
            await sleep(5000);

            // --- Step 5: Click "Publish" ---
            console.log('[Uploader] Clicking "Publish"...');
            const publishButton = document.evaluate("//button[contains(., 'Publish')]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (publishButton) publishButton.click();
            else throw new Error('Could not find the "Publish" button.');
            console.log(`[Uploader] Successfully published ${name}.`);
            
            // --- Step 6: Wait and navigate to the next upload ---
            if (files.indexOf(fileData) < files.length - 1) {
                console.log('[Uploader] Preparing for next file...');
                await sleep(8000); // Wait for publishing to finalize
                window.location.href = 'https://creators.spotify.com/pod/dashboard/episode/new';
                await sleep(7000); // Wait for the new page to load
            }

        } catch (error) {
            console.error(`[Uploader] Automation failed for ${name}:`, error);
            alert(`Automation failed for ${name}. Check the developer console for details. Stopping bulk upload.`);
            return; // Stop the entire process if one file fails
        }
    }
    alert('Bulk upload process has finished!');
}
