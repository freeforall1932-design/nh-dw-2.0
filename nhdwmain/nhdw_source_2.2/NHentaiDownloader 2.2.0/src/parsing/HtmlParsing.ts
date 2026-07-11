import AParsing from "./AParsing";

export default class HtmlParsing implements AParsing
{
    GetUrl(id: string): string {
        return "https://nhentai.net/g/" + id + "/1/";
    }

    async GetJsonAsync(response: Response): Promise<any> {
        if (!response.ok) {
            throw new Error(`HTML request failed with status ${response.status}: ${response.statusText}`);
        }
        
        const html = await response.text();
        
        // Try multiple patterns to extract gallery data from HTML
        // Pattern 1: window._gallery = JSON.parse("...")
        let galleryData: any = null;
        
        try {
            const match1 = html.match(/window\._gallery\s*=\s*JSON\.parse\("([^"]+)"\)/);
            if (match1 && match1[1]) {
                const unescaped = match1[1].replace(/\\u([\dA-F]{4})/gi, (match: string, hex: string) => {
                    return String.fromCharCode(parseInt(hex, 16));
                });
                galleryData = JSON.parse(unescaped);
            }
        } catch (e) {
            // Try pattern 2: Check for Cloudflare challenge page
            if (html.includes('Just a moment') || html.includes('cloudflare')) {
                throw new Error("Cloudflare challenge detected. The site requires browser interaction. Please try using the API method instead or wait a moment and retry.");
            }
            
            // Try pattern 3: Look for embedded JSON in script tags
            try {
                const match2 = html.match(/<script[^>]*>\s*window\._gallery\s*=\s*({.+?})\s*<\/script>/);
                if (match2 && match2[1]) {
                    galleryData = JSON.parse(match2[1]);
                }
            } catch (e2) {
                // If all parsing attempts fail, throw error
            }
        }
        
        if (!galleryData) {
            throw new Error("Failed to parse gallery data from HTML. The page structure may have changed or Cloudflare protection is active.");
        }
        
        // Transform to match expected format if needed
        // The HTML parsing should already return data in the correct format
        return galleryData;
    }
}