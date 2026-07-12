// NHentai Downloader - Popup Script (Manifest V3)

document.addEventListener('DOMContentLoaded', () => {
  const contentDiv = document.getElementById('content');
  
  // Get current tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) {
      showError('No active tab found');
      return;
    }
    
    const currentTab = tabs[0];
    const url = currentTab.url;
    
    console.log('[NH-DW Popup] Current URL:', url);
    
    // Check if we're on nhentai.net
    if (!url || !url.includes('nhentai.net')) {
      showNotOnSite();
      return;
    }
    
    // Extract gallery ID from URL
    const galleryMatch = url.match(/\/g\/(\d+)/);
    
    if (galleryMatch) {
      const galleryId = galleryMatch[1];
      showGalleryUI(galleryId, currentTab.id);
    } else {
      showSearchPageUI();
    }
  });
  
  function showGalleryUI(galleryId, tabId) {
    contentDiv.innerHTML = `
      <div class="status">
        <div class="status-title">Gallery Detected</div>
        <div class="status-value">ID: ${galleryId}</div>
      </div>
      
      <div class="actions">
        <button id="download-btn" class="btn btn-primary">
          📥 Download Full Archive
        </button>
        <a href="https://nhentai.net/g/${galleryId}/" target="_blank" class="btn btn-secondary">
          🔗 Open Gallery
        </a>
      </div>
      
      <div class="info-box">
        💡 Tip: You can also use the "Download Full Archive" button injected directly on the gallery page.
      </div>
    `;
    
    const downloadBtn = document.getElementById('download-btn');
    downloadBtn.addEventListener('click', () => {
      startDownload(galleryId, tabId);
    });
  }
  
  function showSearchPageUI() {
    contentDiv.innerHTML = `
      <div class="status">
        <div class="status-title">Browse Mode</div>
        <div class="status-value">You are on a search or category page.</div>
      </div>
      
      <div class="info-box">
        📌 To download a gallery:<br>
        1. Click on any gallery to open it<br>
        2. Use the "Download Full Archive" button on the gallery page<br>
        3. Or look for the ⬇️ icon on thumbnails
      </div>
      
      <div class="actions">
        <a href="https://nhentai.net/" target="_blank" class="btn btn-primary">
          🏠 Go to Homepage
        </a>
      </div>
    `;
  }
  
  function showNotOnSite() {
    contentDiv.innerHTML = `
      <div class="error-box">
        ❌ Not on nhentai.net<br><br>
        This extension only works on nhentai.net galleries.
      </div>
      
      <div class="actions">
        <a href="https://nhentai.net/" target="_blank" class="btn btn-primary">
          🌐 Visit nhentai.net
        </a>
      </div>
    `;
  }
  
  function showError(message) {
    contentDiv.innerHTML = `
      <div class="error-box">
        ❌ Error: ${message}
      </div>
    `;
  }
  
  function startDownload(galleryId, tabId) {
    const downloadBtn = document.getElementById('download-btn');
    if (downloadBtn) {
      downloadBtn.disabled = true;
      downloadBtn.textContent = '⏳ Preparing...';
    }
    
    // Send message to content script to scrape images
    chrome.tabs.sendMessage(tabId, { action: 'scrapeAndDownload', galleryId: galleryId }, (response) => {
      if (chrome.runtime.lastError) {
        // Content script might not be loaded, try direct approach
        console.log('[NH-DW Popup] Content script not available, using fallback');
        
        // For now, instruct user to use the injected button
        if (downloadBtn) {
          downloadBtn.disabled = false;
          downloadBtn.textContent = '📥 Download Full Archive';
        }
        
        contentDiv.innerHTML += `
          <div class="info-box" style="margin-top: 15px;">
            ⚠️ Please refresh the page and use the green "Download Full Archive" button 
            that appears below the gallery title.
          </div>
        `;
        return;
      }
      
      if (response && response.success) {
        if (downloadBtn) {
          downloadBtn.textContent = '✅ Download Started!';
        }
      } else {
        const errorMsg = response ? response.error : 'Unknown error';
        alert('Download failed: ' + errorMsg);
        if (downloadBtn) {
          downloadBtn.disabled = false;
          downloadBtn.textContent = '📥 Download Full Archive';
        }
      }
    });
  }
});
