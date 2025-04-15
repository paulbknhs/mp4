document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const fileInput = document.getElementById('fileInput');
    const fileNameDisplay = document.getElementById('fileName');
    const controlsSection = document.getElementById('controls');
    const normalizeBtn = document.getElementById('normalizeBtn');
    const volumeSlider = document.getElementById('volumeSlider');
    const volumeValueDisplay = document.getElementById('volumeValue');
    const volumeBtn = document.getElementById('volumeBtn');
    const previewSection = document.getElementById('previewSection');
    const videoPlayer = document.getElementById('videoPlayer');
    const downloadArea = document.querySelector('.download-area');
    const downloadLink = document.getElementById('downloadLink');
    const statusDisplay = document.getElementById('status');
    const loadingIndicator = document.getElementById('loadingIndicator');
    const themeToggle = document.getElementById('checkbox');

    // Waveform Elements
    const waveformContainer = document.getElementById('waveform');
    const waveformLoading = document.getElementById('waveformLoading');

    // History Elements
    const historySection = document.getElementById('historySection');
    const historyList = document.getElementById('historyList');
    const clearHistoryBtn = document.getElementById('clearHistoryBtn');
    const historyEmptyMsg = document.querySelector('.history-empty');

    let currentFile = null;
    let wavesurfer = null; // Variable to hold the WaveSurfer instance
    const MAX_HISTORY_ITEMS = 15; // Max number of history items to store
    const MAX_FILE_SIZE_MB = 100; // Match backend limit
    const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

    // --- Event Listeners ---

    fileInput.addEventListener('change', handleFileSelect);
    volumeSlider.addEventListener('input', updateVolumeDisplay);
    normalizeBtn.addEventListener('click', () => processFile('normalize'));
    volumeBtn.addEventListener('click', () => processFile('volume', { volume: volumeSlider.value }));
    themeToggle.addEventListener('change', handleThemeToggle);
    clearHistoryBtn.addEventListener('click', handleClearHistory);

    // --- Initialization ---
    applySavedTheme();
    renderHistory(getHistory());
    updateVolumeDisplay(); // Set initial volume display & slider background


    // --- Core Functions ---

    function handleFileSelect(event) {
        const file = event.target.files[0];
        resetUI(false); // Reset UI but keep history visible

        if (!file) {
            fileNameDisplay.textContent = 'No file selected';
            controlsSection.classList.add('hidden');
            return;
        }

        // Frontend validation
        if (file.size > MAX_FILE_SIZE_BYTES) {
            showStatus(`File is too large (max ${MAX_FILE_SIZE_MB}MB).`, 'error');
            fileInput.value = ''; // Clear the invalid selection
            return;
        }
        if (!file.type.startsWith('video/mp4')) {
            showStatus('Invalid file type. Please select an MP4 file.', 'error');
            fileInput.value = ''; // Clear the invalid selection
            return;
        }

        currentFile = file;
        fileNameDisplay.textContent = currentFile.name;
        controlsSection.classList.remove('hidden');
        showStatus(''); // Clear any previous status
        enableButtons();
    }

    function processFile(operation, params = {}) {
        if (!currentFile) {
            showStatus('Please select a file first.', 'error');
            return;
        }

        showLoading(true);
        disableButtons();
        destroyWaveSurfer(); // Destroy any previous waveform
        previewSection.classList.add('hidden'); // Hide preview area during processing
        showStatus('Processing your video, please wait...', 'info');

        const formData = new FormData();
        formData.append('file', currentFile);
        formData.append('operation', operation);

        if (operation === 'volume' && params.volume !== undefined) {
            formData.append('volume', params.volume);
        }

        fetch('/process', {
            method: 'POST',
            body: formData,
        })
        .then(async response => { // Use async to await response.json() easily
            const responseData = await response.json().catch(() => ({})); // Get JSON or empty object

            if (!response.ok) {
                // Prefer error message from JSON, fallback to status text
                const errorMessage = responseData.error || `Server error: ${response.statusText} (Status: ${response.status})`;
                 console.error("Server error response:", responseData);
                throw new Error(errorMessage);
            }
            return responseData; // Contains success data
        })
        .then(data => {
            // Check for application-level error even with 2xx status (shouldn't happen with current backend logic but good practice)
            if (data.error) {
                throw new Error(data.error);
            }

            showStatus(`Processing successful: ${operation}. Preview ready.`, 'success');
            previewSection.classList.remove('hidden');
            videoPlayer.src = data.processed_url; // Use relative URL from backend
            videoPlayer.load();

            // Initialize WaveSurfer only after video src is set
            initWaveSurfer(data.processed_url);

            // Set download link (using specific download route)
            downloadLink.href = `/download/${data.processed_filename}`;
            // Suggest a useful download filename
            downloadLink.download = `processed_${data.original_filename || data.processed_filename}`;
            downloadArea.classList.remove('hidden');

            // Add to history
            addHistoryItem({
                id: data.processed_filename.split('_')[0], // Use UUID part as ID
                originalName: data.original_filename,
                processedFilename: data.processed_filename,
                timestamp: Date.now(),
                operation: operation,
                volume: operation === 'volume' ? parseFloat(volumeSlider.value) : null
            });
        })
        .catch(error => {
            console.error('Processing Error:', error);
            showStatus(`Error: ${error.message}`, 'error');
            previewSection.classList.add('hidden');
            downloadArea.classList.add('hidden');
            destroyWaveSurfer();
        })
        .finally(() => {
            showLoading(false);
            // Re-enable buttons unless file input was cleared due to error during selection
            if (fileInput.value) {
                 enableButtons();
            } else {
                 // Keep controls disabled if file input is empty
                 normalizeBtn.disabled = true;
                 volumeBtn.disabled = true;
            }
        });
    }

    // --- WaveSurfer Functions ---

    function initWaveSurfer(url) {
        destroyWaveSurfer();
        waveformLoading.classList.remove('hidden');
        waveformContainer.classList.add('hidden');

        try {
            const computedStyle = getComputedStyle(document.body);
            const isDarkMode = document.body.classList.contains('dark-mode');
            const waveColor = computedStyle.getPropertyValue('--primary-color').trim();
            // Use a slightly muted/desaturated version of primary for progress? or accent?
            const progressColor = computedStyle.getPropertyValue('--accent-color').trim();
            const cursorColor = computedStyle.getPropertyValue('--text-color').trim();
            // Use a less prominent color for the background bars
            const barColor = isDarkMode ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)';

            wavesurfer = WaveSurfer.create({
                container: waveformContainer,
                waveColor: barColor,
                progressColor: waveColor, // Primary color for played part
                cursorColor: cursorColor,
                cursorWidth: 2,
                barWidth: 3,
                barGap: 2,
                barRadius: 2,
                height: 120, // Match CSS height
                media: videoPlayer, // Link wavesurfer to the video element
                url: url,
                // Optional: Use MediaElement backend if WebAudio fails often with video
                // backend: 'MediaElement',
                normalize: true, // Normalize waveform height visually
                interact: true, // Allow clicking on waveform to seek
            });

            wavesurfer.on('ready', () => {
                console.log('WaveSurfer is ready');
                waveformLoading.classList.add('hidden');
                waveformContainer.classList.remove('hidden');
            });

            wavesurfer.on('loading', (percent) => {
                // Optional: Update loading indicator with percentage
                // waveformLoading.textContent = `Generating waveform: ${percent}%...`;
                console.log(`Waveform loading: ${percent}%`);
            });

            wavesurfer.on('error', (err) => {
                console.error('WaveSurfer error:', err);
                waveformLoading.classList.add('hidden');
                // Don't necessarily show a big error, maybe just log it
                // showStatus('Error generating waveform.', 'error');
                waveformContainer.innerHTML = '<p class="waveform-error">Could not load waveform.</p>'; // Show error in container
                waveformContainer.classList.remove('hidden'); // Show the container with the error
            });

            // Optional: If using media backend, might need 'decode' event instead of 'ready'
             wavesurfer.on('decode', () => {
                 console.log('WaveSurfer decoded (MediaElement backend)');
                 waveformLoading.classList.add('hidden');
                 waveformContainer.classList.remove('hidden');
             });

        } catch (error) {
            console.error("Failed to initialize WaveSurfer:", error);
            waveformLoading.classList.add('hidden');
            showStatus('Could not initialize waveform display.', 'error');
        }
    }

    function destroyWaveSurfer() {
        if (wavesurfer) {
            wavesurfer.destroy();
            wavesurfer = null;
            waveformContainer.innerHTML = ''; // Clear the container
            waveformContainer.classList.add('hidden');
            waveformLoading.classList.add('hidden'); // Hide loading indicator too
        }
    }

    // --- History Functions ---

    function getHistory() {
        const historyJson = localStorage.getItem('mp4AudioToolHistory');
        try {
            const history = historyJson ? JSON.parse(historyJson) : [];
            // Ensure it's an array
            return Array.isArray(history) ? history : [];
        } catch (e) {
            console.error("Error parsing history from localStorage:", e);
            localStorage.removeItem('mp4AudioToolHistory'); // Clear corrupted data
            return [];
        }
    }

    function saveHistory(history) {
        // Ensure history is an array before slicing
        const validHistory = Array.isArray(history) ? history : [];
        const limitedHistory = validHistory.slice(0, MAX_HISTORY_ITEMS);
        try {
            localStorage.setItem('mp4AudioToolHistory', JSON.stringify(limitedHistory));
            renderHistory(limitedHistory);
        } catch (e) {
            console.error("Error saving history to localStorage:", e);
            showStatus('Could not save history. Storage might be full.', 'error');
        }
    }

    function addHistoryItem(item) {
        const history = getHistory();
        // Avoid duplicates based on processedFilename (optional, consider if needed)
        // if (history.some(h => h.processedFilename === item.processedFilename)) {
        //     console.log("Duplicate history item skipped:", item.processedFilename);
        //     return;
        // }
        history.unshift(item); // Add to the start
        saveHistory(history);
    }

    function renderHistory(history) {
        historyList.innerHTML = ''; // Clear existing list

        if (!Array.isArray(history) || history.length === 0) {
            historyEmptyMsg.classList.remove('hidden');
            return;
        }

        historyEmptyMsg.classList.add('hidden');

        const fragment = document.createDocumentFragment(); // Efficient DOM updates
        history.forEach(item => {
            const li = document.createElement('li');
            li.className = 'history-item';

            const infoDiv = document.createElement('div');
            infoDiv.className = 'history-item-info';

            const nameStrong = document.createElement('strong');
            nameStrong.textContent = item.originalName || 'Unknown File';

            const detailsSpan = document.createElement('span');
            const date = new Date(item.timestamp);
            let detailsText = `${item.operation.charAt(0).toUpperCase() + item.operation.slice(1)}`;
            if (item.operation === 'volume' && typeof item.volume === 'number') {
                detailsText += ` (${Math.round(item.volume * 100)}%)`;
            }
            detailsText += ` - ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`; // More readable date/time
            detailsSpan.textContent = detailsText;

            infoDiv.appendChild(nameStrong);
            infoDiv.appendChild(detailsSpan);

            const downloadBtn = document.createElement('a');
            // Use the download route
            downloadBtn.href = `/download/${item.processedFilename}`;
            downloadBtn.className = 'btn btn-download-hist';
            // Suggest a download filename (use original name if available)
            downloadBtn.setAttribute('download', `processed_${item.originalName || item.processedFilename}`);
            downloadBtn.innerHTML = '<i class="fas fa-download" aria-hidden="true"></i> Download';
            downloadBtn.setAttribute('aria-label', `Download processed file for ${item.originalName || 'Unknown File'}`);


            li.appendChild(infoDiv);
            li.appendChild(downloadBtn);
            fragment.appendChild(li);
        });
        historyList.appendChild(fragment); // Append all items at once
    }

    function handleClearHistory() {
        if (confirm('Are you sure you want to clear the processing history? Processed files will remain on the server until manually cleaned up.')) {
            localStorage.removeItem('mp4AudioToolHistory');
            renderHistory([]); // Re-render empty list
            showStatus('History cleared.', 'info');
        }
    }


    // --- UI Helper Functions ---

    function updateVolumeDisplay() {
        const value = parseFloat(volumeSlider.value);
        const percentage = Math.round(value * 100);
        volumeValueDisplay.textContent = `${percentage}%`;
        // Update slider background gradient fill
        const sliderProgressPercent = ((value - volumeSlider.min) / (volumeSlider.max - volumeSlider.min)) * 100;
        volumeSlider.style.setProperty('--value-percent', `${sliderProgressPercent}%`);
    }

    function showStatus(message, type = 'info') {
        statusDisplay.textContent = message;
        statusDisplay.className = 'status-section'; // Reset classes first
        if (message) { // Only add type class if there is a message
            statusDisplay.classList.add(type); // 'error', 'success', 'info'
            statusDisplay.classList.remove('hidden');
        } else {
            statusDisplay.classList.add('hidden');
        }
    }

    function showLoading(isLoading) {
        loadingIndicator.classList.toggle('hidden', !isLoading);
    }

    function disableButtons() {
        normalizeBtn.disabled = true;
        volumeBtn.disabled = true;
        fileInput.disabled = true; // Prevent changing file during processing
        clearHistoryBtn.disabled = true; // Disable history clear during processing
    }

    function enableButtons() {
        normalizeBtn.disabled = false;
        volumeBtn.disabled = false;
        fileInput.disabled = false;
        clearHistoryBtn.disabled = false;
    }

    function resetUI(fullReset = true) {
        fileNameDisplay.textContent = 'No file selected';
        controlsSection.classList.add('hidden');
        previewSection.classList.add('hidden');
        downloadArea.classList.add('hidden');
        videoPlayer.src = '';
        showStatus(''); // Clear status
        destroyWaveSurfer();

        if (fullReset) { // Option to keep file input value if just hiding sections
             currentFile = null;
             fileInput.value = '';
             // Reset volume slider to default
             volumeSlider.value = 1.0;
             updateVolumeDisplay();
        }

         // Always ensure buttons reflect the state (disabled if no file)
        if (!currentFile) {
             normalizeBtn.disabled = true;
             volumeBtn.disabled = true;
             clearHistoryBtn.disabled = false; // History can always be cleared
        } else {
            enableButtons();
        }
    }

    function applySavedTheme() {
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme === 'dark') {
            document.body.classList.add('dark-mode');
            themeToggle.checked = true;
        } else {
            document.body.classList.remove('dark-mode');
            themeToggle.checked = false;
        }
    }

    function handleThemeToggle() {
        const isDark = themeToggle.checked;
        document.body.classList.toggle('dark-mode', isDark);
        localStorage.setItem('theme', isDark ? 'dark' : 'light');

        // Re-render wavesurfer with new theme colors if it exists
        if (wavesurfer && wavesurfer.isReady) { // Check if wavesurfer exists and is ready
             const currentUrl = wavesurfer.options.url; // Get current URL before destroying
             if (currentUrl) {
                // Small delay might help ensure styles are applied before re-init
                setTimeout(() => initWaveSurfer(currentUrl), 50);
             }
        } else if (wavesurfer) {
             // If it exists but wasn't ready, destroy it cleanly
             destroyWaveSurfer();
        }
    }

}); // End DOMContentLoaded