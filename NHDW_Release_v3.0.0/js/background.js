// NHentai Downloader - Background Service Worker (Manifest V3)
// Handles image fetching, ZIP creation, and downloads

// Load JSZip library dynamically since we're in a service worker
importScripts('js/jszip/dist/jszip.min.js');

console.log('[NH-DW] Background service worker initialized');

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'downloadGallery') {
    handleDownloadGallery(request.galleryId, request.title, request.images)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true; // Keep message channel open for async response
  }
  
  if (request.action === 'getGalleryInfo') {
    sendResponse({ success: true });
    return false;
  }
});

async function handleDownloadGallery(galleryId, title, imageUrls) {
  try {
    console.log('[NH-DW] Starting download for gallery:', galleryId);
    
    // Sanitize title for filename
    const safeTitle = sanitizeFilename(title || `nhentai_${galleryId}`);
    const zipFilename = `${safeTitle}.zip`;
    
    // Create JSZip instance
    const zip = new JSZip();
    
    // Fetch all images and add to zip
    const imagePromises = imageUrls.map(async (url, index) => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch image ${index + 1}`);
        
        const blob = await response.blob();
        const extension = getImageExtension(url);
        const paddedIndex = String(index + 1).padStart(3, '0');
        const filename = `${paddedIndex}${extension}`;
        
        zip.file(filename, blob);
        console.log(`[NH-DW] Added image ${index + 1}/${imageUrls.length}: ${filename}`);
      } catch (err) {
        console.error(`[NH-DW] Error fetching image ${index + 1}:`, err);
        throw err;
      }
    });
    
    // Wait for all images to be fetched
    await Promise.all(imagePromises);
    
    console.log('[NH-DW] All images fetched, generating ZIP...');
    
    // Generate ZIP blob
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    
    console.log('[NH-DW] ZIP generated, triggering download...');
    
    // Trigger download using Chrome Downloads API
    const downloadUrl = URL.createObjectURL(zipBlob);
    
    chrome.downloads.download({
      url: downloadUrl,
      filename: zipFilename,
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('[NH-DW] Download error:', chrome.runtime.lastError);
        URL.revokeObjectURL(downloadUrl);
        throw new Error(chrome.runtime.lastError.message);
      }
      console.log('[NH-DW] Download started with ID:', downloadId);
      
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    });
    
    console.log('[NH-DW] Download process completed successfully');
    
  } catch (error) {
    console.error('[NH-DW] Download failed:', error);
    throw error;
  }
}

// Helper: Sanitize filename
function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 200);
}

// Helper: Get image extension from URL
function getImageExtension(url) {
  const ext = url.split('.').pop().split('?')[0].toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
    return '.' + ext;
  }
  return '.jpg';
}
