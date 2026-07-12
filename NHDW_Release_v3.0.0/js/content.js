// NHentai Downloader - Content Script (Manifest V3)
// Injects download buttons and scrapes gallery images

(function() {
  'use strict';
  
  console.log('[NH-DW] Content script loaded');
  
  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
  function init() {
    const url = window.location.href;
    
    // Check if we're on a gallery page (/g/XXXX/)
    const galleryMatch = url.match(/\/g\/(\d+)/);
    if (galleryMatch) {
      const galleryId = galleryMatch[1];
      console.log('[NH-DW] Gallery page detected:', galleryId);
      injectGalleryButton(galleryId);
    }
    
    // Check if we're on search/category/home page - add quick download buttons
    if (url.match(/\/\?|\/popular|\/g\/$/)) {
      injectSearchPageButtons();
    }
  }
  
  // Inject download button on gallery page
  function injectGalleryButton(galleryId) {
    // Find the gallery title and image container
    const titleElement = document.querySelector('#info h1.title, #info h2.title');
    if (!titleElement) {
      console.log('[NH-DW] Title element not found, retrying...');
      setTimeout(() => injectGalleryButton(galleryId), 500);
      return;
    }
    
    // Check if button already exists
    if (document.getElementById('nhdw-download-btn')) {
      return;
    }
    
    // Create download button
    const btn = document.createElement('button');
    btn.id = 'nhdw-download-btn';
    btn.className = 'nhdw-btn';
    btn.innerHTML = '📥 Download Full Archive';
    btn.title = 'Download all pages as a ZIP file';
    
    // Add click handler
    btn.addEventListener('click', () => {
      handleGalleryDownload(galleryId);
    });
    
    // Insert button after title
    titleElement.parentNode.insertBefore(btn, titleElement.nextSibling);
    
    console.log('[NH-DW] Download button injected');
  }
  
  // Handle gallery download - scrape all images
  async function handleGalleryDownload(galleryId) {
    const btn = document.getElementById('nhdw-download-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Preparing...';
    }
    
    try {
      // Scrape all image URLs from the current page
      // nhentai.net loads all pages in a single scrollable view or via AJAX
      const imageUrls = scrapeAllImages();
      
      if (imageUrls.length === 0) {
        throw new Error('No images found on this page');
      }
      
      console.log(`[NH-DW] Found ${imageUrls.length} images`);
      
      // Get gallery title
      const titleElement = document.querySelector('#info h1.title, #info h2.title');
      const title = titleElement ? titleElement.textContent.trim() : `nhentai_${galleryId}`;
      
      // Send to background script
      chrome.runtime.sendMessage({
        action: 'downloadGallery',
        galleryId: galleryId,
        title: title,
        images: imageUrls
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[NH-DW] Message sending error:', chrome.runtime.lastError);
          alert('Download failed: ' + chrome.runtime.lastError.message);
        } else if (response && response.success) {
          if (btn) {
            btn.textContent = '✅ Download Started!';
            setTimeout(() => {
              btn.disabled = false;
              btn.innerHTML = '📥 Download Full Archive';
            }, 2000);
          }
        } else {
          const errorMsg = response ? response.error : 'Unknown error';
          alert('Download failed: ' + errorMsg);
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = '📥 Download Full Archive';
          }
        }
      });
      
    } catch (error) {
      console.error('[NH-DW] Download error:', error);
      alert('Download failed: ' + error.message);
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '📥 Download Full Archive';
      }
    }
  }
  
  // Scrape all images from the gallery page
  function scrapeAllImages() {
    const imageUrls = [];
    const seen = new Set();
    
    // Method 1: Find all img tags with nhentai domains
    const imgs = document.querySelectorAll('img[src*="nhentai.net"]');
    imgs.forEach(img => {
      let src = img.src || img.dataset.src || '';
      if (src && !seen.has(src) && isValidImageUrl(src)) {
        // Convert thumbnail URL to full size URL
        src = convertToFullSize(src);
        if (!seen.has(src)) {
          seen.add(src);
          imageUrls.push(src);
        }
      }
    });
    
    // Method 2: Check for data-src attributes in gallery containers
    const galleryImgs = document.querySelectorAll('.gallery-thumb img, .thumb-container img, [data-src]');
    galleryImgs.forEach(el => {
      let src = el.dataset.src || el.getAttribute('data-src') || el.src || '';
      if (src && !seen.has(src) && isValidImageUrl(src)) {
        src = convertToFullSize(src);
        if (!seen.has(src)) {
          seen.add(src);
          imageUrls.push(src);
        }
      }
    });
    
    // Sort URLs to ensure correct page order
    imageUrls.sort((a, b) => {
      const numA = extractPageNumber(a);
      const numB = extractPageNumber(b);
      return numA - numB;
    });
    
    return imageUrls;
  }
  
  // Convert thumbnail URL to full-size image URL
  function convertToFullSize(url) {
    // nhentai uses patterns like:
    // https://i.nhentai.net/galleries/XXXXX-YYYYY/thumb.jpg -> replace thumb with 1, 2, etc
    // https://t.nhentai.net/galleries/XXXXX/YYYYYt.jpg -> replace t with nothing and server
    
    // Replace thumbnail server with main image server
    url = url.replace('://t.', '://i.');
    
    // Remove 't' suffix before extension (e.g., 001t.jpg -> 001.jpg)
    url = url.replace(/(\d+)t\./, '$1.');
    
    // Replace /thumbs/ with /galleries/ if present
    url = url.replace('/thumbs/', '/galleries/');
    
    return url;
  }
  
  // Extract page number from URL for sorting
  function extractPageNumber(url) {
    const match = url.match(/(\d+)\.(jpg|png|gif|webp)/i);
    return match ? parseInt(match[1]) : 0;
  }
  
  // Validate if URL is an image
  function isValidImageUrl(url) {
    return url.match(/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i) !== null;
  }
  
  // Inject quick download buttons on search results
  function injectSearchPageButtons() {
    const galleries = document.querySelectorAll('.gallery, .thumb-container');
    
    galleries.forEach((gallery, index) => {
      if (gallery.querySelector('.nhdw-quick-dl')) return;
      
      const link = gallery.querySelector('a[href*="/g/"]');
      if (!link) return;
      
      const galleryId = link.href.match(/\/g\/(\d+)/)?.[1];
      if (!galleryId) return;
      
      const btn = document.createElement('a');
      btn.className = 'nhdw-quick-dl';
      btn.innerHTML = '⬇️';
      btn.title = 'Quick download this gallery';
      btn.href = '#';
      
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        initiateQuickDownload(galleryId, gallery);
      });
      
      // Position button on gallery thumbnail
      const thumbContainer = gallery.querySelector('.thumb-container') || gallery;
      thumbContainer.appendChild(btn);
    });
  }
  
  // Quick download from search page
  async function initiateQuickDownload(galleryId, galleryElement) {
    console.log('[NH-DW] Quick download for:', galleryId);
    
    // For search pages, we need to fetch the gallery page first
    // This is a simplified version - in production you'd fetch via API
    alert('For batch downloads, please open the gallery page and use the Download button there.\n\nGallery ID: ' + galleryId);
  }
  
})();
