import Tag from "./tag"

export module utils
{
    // Clean a word, if replaceSpaces is true, all spaces are replaced by an underscore
    export function cleanName(name: string, replaceSpaces: boolean): string {
        let newName = name.split('').filter(e => !invalidCharacter.includes(e)).join('');
        if (replaceSpaces) {
            newName = newName.trim().replace(/ +/g, '_');
        } else {
            newName = newName.trim();
        }
        // Windows reserves a handful of device names regardless of extension
        // (CON.zip, PRN.jpg, COM1.png, ...). Prefix them so Chrome can still
        // save the file instead of failing silently.
        if (reservedWindowsNames.has(newName.toUpperCase())) {
            newName = "_" + newName;
        }
        // A title made entirely of invalid characters (or spaces) would
        // produce an empty filename, which Chrome rejects. Fall back to a
        // safe placeholder so the download still starts.
        if (newName === "") {
            newName = "untitled";
        }
        return newName;
    }

    export function getDownloadName(exampleString: string, prettyName: string, englishName: string, japaneseName: string, id: string, tags: Array<Tag>): string {
        exampleString = exampleString.replace(/{pretty}/g, prettyName);
        exampleString = exampleString.replace(/{english}/g, englishName);
        exampleString = exampleString.replace(/{japanese}/g, japaneseName);
        exampleString = exampleString.replace(/{id}/g, id);
        let language = "";
        let artists : Array<string> = [];
        let groups : Array<string> = [];
        let characters : Array<string> = [];
        tags.forEach(function(e) {
            if (e.type === "group") groups.push(e.name);
            else if (e.type === "character") characters.push(e.name);
            else if (e.type === "artist") artists.push(e.name);
            else if (e.type === "language" && e.name !== "translated") language = e.name;
        });
        exampleString = exampleString.replace(/{group}/g, groups.join(", "));
        exampleString = exampleString.replace(/{character}/g, characters.join(", "));
        exampleString = exampleString.replace(/{artist}/g, artists.join(", "));
        exampleString = exampleString.replace(/{language}/g, language);
        return exampleString;
    }

    let invalidCharacter: Array<string> = [
        '/', '\\', '?', '%', '*', ':', '|', '"', '<', '>', '.'
    ]

    // Windows device names that cannot be used as file/folder names even with
    // an extension. Kept uppercase for case-insensitive matching.
    let reservedWindowsNames: Set<string> = new Set([
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
    ])
}