import AParsing from "./AParsing";
import { GallerySource, clearnetSource } from "../sources/GallerySource";

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
            return JSON.parse(
                value.split("window._gallery = JSON.parse(\"")[1].split("\");")[0].replace(/\\u[\dA-F]{4}/gi,
                    function (match) {
                         return String.fromCharCode(parseInt(match.replace(/\\u/g, ''), 16));
                    }
                )
            );
        });
    }
}