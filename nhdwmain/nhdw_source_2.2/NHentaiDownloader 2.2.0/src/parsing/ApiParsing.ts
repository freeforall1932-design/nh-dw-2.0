import AParsing from "./AParsing";

export default class ApiParsing implements AParsing
{
    // New API v2 endpoint - works with Cloudflare protection
    GetUrl(id: string): string {
        return 'https://nhentai.net/api/v2/galleries/' + id;
    }

    async GetJsonAsync(response: Response): Promise<any> {
        if (!response.ok) {
            throw new Error(`API request failed with status ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        // Transform v2 API response to match the old format expected by Downloader.ts
        // v2 API returns: { id, media_id, title, pages: [{number, path, width, height, thumbnail, ...}], tags: [...], num_pages, ... }
        // Old API returned: { id, media_id, title: { english, japanese, pretty }, images: { pages: [{ t: "j"|"p"|"g"|"w", h: number, w: number }] }, tags: [...] }
        
        const transformedData: any = {
            id: data.id,
            media_id: data.media_id,
            title: data.title, // Already in correct format { english, japanese, pretty }
            tags: data.tags || [],
            num_pages: data.num_pages || (data.pages ? data.pages.length : 0),
            images: {
                pages: []
            }
        };
        
        // Transform pages array to match old format
        // v2: { number, path: "galleries/9/1.jpg", width, height, thumbnail, ... }
        // Old: { t: "j"|"p"|"g"|"w", h: number, w: number }
        if (data.pages && Array.isArray(data.pages)) {
            for (const page of data.pages) {
                const pathParts = page.path.split('.');
                const extension = pathParts.length > 1 ? pathParts[pathParts.length - 1].toLowerCase() : 'jpg';
                
                // Map extension to single character format
                let typeChar = 'j'; // default to jpg
                switch (extension) {
                    case 'png':
                        typeChar = 'p';
                        break;
                    case 'gif':
                        typeChar = 'g';
                        break;
                    case 'webp':
                        typeChar = 'w';
                        break;
                    case 'jpg':
                    case 'jpeg':
                        typeChar = 'j';
                        break;
                }
                
                transformedData.images.pages.push({
                    t: typeChar,
                    w: page.width || 0,
                    h: page.height || 0
                });
            }
        }
        
        return transformedData;
    }
}