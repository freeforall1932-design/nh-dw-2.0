import { looksLikeGallery } from "../parsing/GalleryEmbed";
import { fetchGalleryViaTab } from "./activeTabGallery";

// Resolve selected galleries exclusively through the tab the user is already
// viewing. Opening a gallery tab per selection both disrupts the browser and
// creates a different Cloudflare session from the page the user cleared.
//
// A missing result is intentionally left out of the returned map. The batch
// downloader makes the same tab-scoped attempt immediately before processing
// that item and reports a metadata failure if the page session cannot supply
// it. It never opens or navigates a tab on the user's behalf.
export async function resolveSelectedGalleries(ids: string[], sourceTabId?: number): Promise<Record<string, any>> {
    const resolved: Record<string, any> = {};
    if (typeof sourceTabId !== "number") {
        return resolved;
    }

    // Sequential requests keep the existing page responsive and avoid a burst
    // of API requests from a single cleared tab.
    for (const id of ids) {
        try {
            const gallery = await fetchGalleryViaTab(sourceTabId, id);
            if (looksLikeGallery(gallery)) {
                resolved[id] = gallery;
            }
        } catch (_) {
            // Keep resolving the remaining selections in the same tab.
        }
    }
    return resolved;
}
