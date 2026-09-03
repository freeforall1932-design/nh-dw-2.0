import { extractFirstLine } from "../parsing/CardParsing";

// Content script: extract gallery cards from the active listing page using the
// DOM instead of serializing the whole page and regex-parsing it in the popup.
// Each card is identified by the gallery ID from its own cover link (stable),
// and the title comes from the caption inside the same link, so quotes, markup
// changes, duplicate titles, or additional card markup cannot mispair ids with
// titles.
//
// Replaces the old getHtml.js flow (serialize whole DOM -> regex in the popup).

interface GalleryCard { id: string; title: string; }

function extractCardTitle(link: Element): string {
    const caption = link.querySelector(".caption");
    if (caption === null) return "";
    // innerHTML keeps the same markup the network path sees, so the shared
    // extractFirstLine handles <br> separation, injected checkboxes, and
    // entity decoding in one place.
    return extractFirstLine(caption.innerHTML);
}

function extractGalleries(): GalleryCard[] {
    const links = document.querySelectorAll('a[href*="/g/"]');
    const seen = new Set<string>();
    const galleries: GalleryCard[] = [];
    links.forEach((link) => {
        const match = /\/g\/([0-9]+)\//.exec(link.getAttribute("href") || "");
        if (match === null) return;
        const id = match[1];
        if (seen.has(id)) return; // Same gallery can appear on several cards
        seen.add(id);
        galleries.push({ id, title: extractCardTitle(link) });
    });
    return galleries;
}

// Pagination info so the popup can offer "Download all (N pages)".
// nhentai renders the current page as <span class="current">N</span> and the
// highest page as <a href="?page=N" class="last">Last</a>.
function extractPagination(): { currentPage: number; maxPage: number } {
    let currentPage = 0;
    let maxPage = 0;
    const pagination = document.querySelector(".pagination");
    if (pagination !== null) {
        pagination.querySelectorAll('a[href*="page="]').forEach((link) => {
            const match = /page=([0-9]+)/.exec(link.getAttribute("href") || "");
            if (match === null) return;
            const n = parseInt(match[1], 10);
            if (n > maxPage) maxPage = n;
        });
        const currentEl = pagination.querySelector(".current");
        if (currentEl !== null) {
            const n = parseInt((currentEl.textContent || "").trim(), 10);
            if (Number.isFinite(n) && n > 0) currentPage = n;
        }
    }
    return { currentPage, maxPage };
}

const galleries = extractGalleries();
const { currentPage, maxPage } = extractPagination();
chrome.runtime.sendMessage({ action: "getGalleries", galleries: galleries, currentPage: currentPage, maxPage: maxPage });
