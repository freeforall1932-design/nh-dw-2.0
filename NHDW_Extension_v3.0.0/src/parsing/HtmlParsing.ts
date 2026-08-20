import AParsing from "./AParsing";
import { GallerySource, clearnetSource } from "../sources/GallerySource";
import { extractGalleryFromHtml } from "./GalleryEmbed";

export default class HtmlParsing implements AParsing
{
    private readonly source: GallerySource;

    constructor(source: GallerySource = clearnetSource) {
        this.source = source;
    }

    GetUrl(id: string): string {
        return this.source.getGalleryUrl(id);
    }

    GetJsonAsync(response: Response): Promise<any> {
        return response.text().then((value: string) =>
        {
            const json = extractGalleryFromHtml(value);
            if (json === null) {
                throw new Error("Unknown page format: window._gallery was not found.");
            }
            return json;
        });
    }
}