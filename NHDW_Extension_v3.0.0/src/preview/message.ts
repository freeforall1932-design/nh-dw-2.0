import { API_KEY_SETTINGS_URL } from "../utils/apiAuth";

export module message
{
    // API key gate, shown on the first popup open when no key is stored and
    // the user has not declined one yet. Two explicit exits keep the mode
    // boundary visible: "Submit key" (API key mode) or "Continue without API
    // key" (open-tab mode, the previous behaviour).
    export function apiKeyGate(): string {
        return '<h3>nhentai API access</h3>' +
            '<p>Choose how the extension resolves gallery metadata:</p>' +
            '<input type="password" id="apiKeyInput" placeholder="Paste your nhentai API key" style="width:60%"/> ' +
            '<input type="button" id="apiKeySubmit" value="Submit key"/>' +
            '<br/><small>With a key: the official nhentai API is used (higher rate limits; batch downloads do not depend on reading the open tab). ' +
            'Generate one in your <a href="' + API_KEY_SETTINGS_URL + '" target="_blank">nhentai account settings</a>.</small>' +
            '<br/><br/><input type="button" id="apiKeySkip" value="Continue without API key"/>' +
            '<br/><small>Without a key: metadata is read from your open NHentai tab (previous behaviour).</small>' +
            '<div id="apiKeyGateError" style="color:red"></div>';
    }

    export function apiKeyGateEmptyError(): string {
        return "Enter a key, or choose \"Continue without API key\".";
    }

    // One-line indicator of the active mode, so real-browser checks always
    // know which metadata route the popup expects to use.
    export function apiModeBadge(keyed: boolean): string {
        return keyed
            ? '<small>Mode: API key (official API)</small><br/>'
            : '<small>Mode: open tab (no API key)</small><br/>';
    }

    export function downloadDone(): string {
        return 'Your file was downloaded, thanks for using NHentai Downloader.<br/><br/><input type="button" id="buttonBack" value="Go Back"/>'
    }

    // Shown when the popup finds a job marker from a previous session but no
    // active download (the service worker / offscreen document was restarted
    // before the download finished).
    export function downloadInterrupted(): string {
        return '<h3>Download interrupted</h3><p>A previous download was interrupted before it finished ' +
            '(the browser restarted or the download document was closed). ' +
            'Please start the download again.</p><br/><input type="button" id="buttonDismiss" value="Got it"/>';
    }
    
    export function downloadProgress(status: string, doujinshiName: string, progress: number, retry?: string): string {
        const retryHtml = retry ? '<br/><small>Retrying (' + retry + ')...</small>' : '';
        return `${status} ${doujinshiName}, please wait...${retryHtml}<br/><progress max="100" id="progressBar" value="${progress}"></progress><br/><br/><input type="button" id="buttonBack" value="Cancel"/>`;
    }
    
    export function invalidPage(): string {
        return "This extension must be used on a page containing doujinshi(s) in nhentai.net.";
    }
    
    export function errorDownload(error: string): string {
        return 'An error occured while downloading the doujinshi: <b>' + error + '</b>';
    }
    
    export function errorOther(status: number, statusText: string): string {
        return `An unexpected error occured (Code ${status}: ${statusText}).`;
    }

    // Shown when the open tab does not yet contain gallery JSON and the
    // extension-origin API request was blocked. The user must finish the
    // challenge on the *gallery page itself* (not just have the URL in the
    // address bar) before reopening the popup.
    export function cloudflareMetadata(): string {
        return "This tab does not contain gallery metadata yet. Finish any Cloudflare challenge, wait until the gallery page itself has loaded, then open the popup again.";
    }
    
    export function downloadInfo(title: string, nbOfPages: number, extension: string): string {
        return '<h3>' + title + '</h3><div>(' + nbOfPages + ' pages)' +
            '</div><br/><input type="button" id="button" value="Download" autofocus/><br/><br/>Downloads/<input type="text" id="path"/>' + extension;
    }
    
    export function invalidSyntax(): string {
        return "Invalid page syntax, each number must be separated by a comma ',' or a dash '-'";
    }
    
    export function invalidPageNumber(maxPage: number): string {
        return "Page number must be between 0 and " + maxPage;
    }
    
    export function invalidBounds(): string {
        return "Upper limit must be strictly bigger than lower limit";
    }

    // Batch download summary shown after the batch finishes
    export function batchSummary(succeeded: number, failed: number, total: number, failedKinds?: Record<string, number>): string {
        let html = '<h3>Download complete</h3>';
        html += '<p>' + succeeded + ' of ' + total + ' galleries downloaded successfully.</p>';
        if (failed > 0) {
            html += '<p style="color:red">' + failed + ' gallery' + (failed > 1 ? 's' : '') + ' failed';
            if (failedKinds) {
                const breakdown = Object.keys(failedKinds)
                    .map(k => KIND_LABELS[k] + ': ' + failedKinds[k])
                    .join(', ');
                if (breakdown !== "") {
                    html += ' (' + breakdown + ')';
                }
            }
            html += '.</p>';
        }
        html += '<br/><input type="button" id="buttonBack" value="Go Back"/>';
        return html;
    }

    const KIND_LABELS: Record<string, string> = {
        cancelled: "cancelled",
        cloudflare: "Cloudflare",
        image: "image",
        metadata: "metadata",
        zip: "archive",
        unknown: "other"
    };

    // Batch gallery progress — shown while processing a batch
    export function batchProgress(current: number, total: number, galleryName: string, stage: string): string {
        return 'Gallery ' + current + ' of ' + total + ': ' + stage + ' ' + galleryName +
            '...<br/><progress max="100" id="progressBar" value="' + Math.round(current / total * 100) + '"></progress>' +
            '<br/><br/><input type="button" id="buttonBack" value="Cancel"/>';
    }
}