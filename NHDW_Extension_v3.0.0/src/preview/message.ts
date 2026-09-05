import { API_KEY_SETTINGS_URL } from "../utils/apiAuth";
import { DOWNLOAD_FORMATS, formatExtension, formatLabel, effectiveOutputMode } from "../utils/downloadFormats";
import { ListModeSettings } from "../utils/listSettings";
import { FailedGallery } from "../utils/downloadHistory";
import { classifyError, escapeHtml, errorMessage } from "../utils/utils";

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
            '<br/><small>To paste: click the box, then press Ctrl+V.</small>' +
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
    
    export function downloadProgress(status: string, doujinshiName: string, progress: number, retry?: string, queued: number = 0, paused: boolean = false): string {
        const retryHtml = retry ? '<br/><small>Retrying (' + retry + ')...</small>' : '';
        const queueHtml = queued > 0
            ? '<br/><small>' + queued + ' download' + (queued === 1 ? '' : 's') + ' queued.</small><br/><input type="button" id="buttonClearQueue" value="Clear queue"/>'
            : '';
        const pauseHtml = paused
            ? '<br/><b>Paused.</b> Completed pages are kept for this browser session.<br/><input type="button" id="buttonResume" value="Resume current"/>'
            : '<br/><input type="button" id="buttonPause" value="Pause current"/>';
        return `${status} ${doujinshiName}, please wait...${retryHtml}${queueHtml}${pauseHtml}<br/><progress max="100" id="progressBar" value="${progress}"></progress><br/><br/><input type="button" id="buttonBack" value="Cancel current"/>`;
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

    // nhentai's CDN config reported image hosts this extension has no host
    // permission for. Downloads keep using the permitted hosts; the button
    // requests the optional https://*.nhentai.net grant (user gesture required,
    // which is why this lives in the popup).
    export function cdnNotice(origins: string[]): string {
        const list = origins.map((origin) => {
            const host = /^https:\/\/([^/]+)\//.exec(origin);
            return host ? host[1] : origin;
        }).join(", ");
        return '<b>New nhentai image hosts</b><br/>' +
            '<small>nhentai now serves images from ' + list + '. Downloads keep working on the current hosts.</small><br/>' +
            '<input type="button" id="buttonGrantCdn" value="Grant image host access"/>';
    }
    
    export function downloadInfo(title: string, nbOfPages: number, extension: string, selectedFormat: string, alreadyNote?: string): string {
        const selected = (value: string) => value === selectedFormat ? ' selected' : '';
        const historyNote = alreadyNote
            ? '<small id="singleHistoryInfo" class="nhdwAlready">&#10003; Already downloaded: ' + alreadyNote + '</small><br/>'
            : '<small id="singleHistoryInfo" class="nhdwAlready"></small>';
        // A single-title click is always explicit, so already-downloaded titles
        // are NOT auto-skipped here; the button label makes the override clear.
        const buttonLabel = alreadyNote ? 'Download again' : 'Download';
        return '<div class="popupColumns">' +
            '<div class="popupColumn">' +
            '<h3>' + title + '</h3>' +
            '<div>(' + nbOfPages + ' pages)</div><br/>' +
            'Format: <select id="downloadFormat">' +
            '<option value="zip"' + selected('zip') + '>ZIP</option>' +
            '<option value="cbz"' + selected('cbz') + '>CBZ</option>' +
            '<option value="pdf"' + selected('pdf') + '>PDF</option>' +
            '<option value="raw"' + selected('raw') + '>Raw images</option>' +
            '</select><br/>' +
            historyNote +
            'Downloads/<input type="text" id="path"/>' + extension + '<br/><br/>' +
            '<input type="button" id="button" value="' + buttonLabel + '" autofocus/>' +
            '</div>' +
            '<div class="popupColumn">' +
            '<b>Similar galleries</b>' +
            '<div id="similarPanel">' + similarIntro() + '</div>' +
            '</div>' +
            '</div>';
    }

    // ---- list mode (homepage / search / artist / tag / genre windows) ----
    // Same four formats as a single title, plus the explicit output mode that
    // makes "one file per title" possible at all. Separate files is the
    // default; the merged single-file behaviour is the opt-in.
    export function listDownloadOptions(settings: ListModeSettings): string {
        const selected = (value: string) => value === settings.format ? ' selected' : '';
        const modeSelected = (value: string) => value === settings.outputMode ? ' selected' : '';
        const effective = effectiveOutputMode(settings.format, settings.outputMode);
        let html = '<div class="listOptions">';
        html += '<div class="listOptionRow"><label for="listFormat">Format</label>' +
            '<select id="listFormat">';
        for (const format of DOWNLOAD_FORMATS) {
            html += '<option value="' + format + '"' + selected(format) + '>' + formatLabel(format) + '</option>';
        }
        html += '</select></div>';
        html += '<div class="listOptionRow"><label for="listOutputMode">Output</label>' +
            '<select id="listOutputMode">' +
            '<option value="separate"' + modeSelected('separate') + '>Separate files (one per title)</option>' +
            '<option value="batch"' + modeSelected('batch') + '>Single merged file (all titles)</option>' +
            '</select></div>';
        html += '<div class="listOptionRow"><label class="listInline" for="listMasterFolder">' +
            '<input type="checkbox" id="listMasterFolder"' + (settings.masterFolder ? ' checked' : '') + '/> ' +
            'Put everything in the ' +
            (settings.masterFolderName === "" ? 'master folder' : 'Downloads/' + settings.masterFolderName + '/ folder') +
            '</label></div>';
        html += '<small id="listRawNote" class="listNote"' + (settings.format === "raw" ? '' : ' hidden') + '>' +
            'Raw is still under test: it writes loose images into one folder per title and always behaves as separate files.' +
            '</small>';
        html += '<div id="batchNameRow" class="listOptionRow"' + (effective === "batch" ? '' : ' hidden') + '>' +
            'Downloads/<input type="text" id="path"/><span id="batchExtension">' + formatExtension(settings.format) + '</span></div>';
        html += '<div id="listNamePreview" class="listPreview"></div>';
        html += '</div>';
        return html;
    }

    // Right column: intro state of the similar-galleries panel. The related    // list is only fetched on request (it costs one API call, and the panel
    // exists so the user can PICK which related titles to download).
    export function similarIntro(): string {
        return '<small>Pick from nhentai\'s related recommendations - each selected gallery downloads as its own file.</small><br/>' +
            '<input type="button" id="buttonLoadSimilar" value="Show similar galleries"/>';
    }

    export function similarLoading(): string {
        return '<small>Finding similar galleries...</small>';
    }

    export function similarError(message: string): string {
        return '<small>' + message + '</small><br/>' + similarIntro();
    }

    // Checkbox list of related galleries. Entries carry pre-escaped titles;
    // data-id links each checkbox back to its gallery id.
    export function similarList(entries: Array<{ id: string; title: string; pages: number }>): string {
        let html = '<div class="similarList">';
        for (const entry of entries) {
            html += '<label><input type="checkbox" class="similarItem" data-id="' + entry.id + '" checked> ' +
                entry.title +
                (entry.pages > 0 ? ' <small>(' + entry.pages + 'p)</small>' : '') +
                '</label>';
        }
        html += '</div>';
        html += '<input type="button" id="buttonSimilarAll" value="All"/> ';
        html += '<input type="button" id="buttonSimilarNone" value="None"/><br/>';
        html += '<input type="button" id="buttonSimilar" value="Download selected"/>';
        return html;
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

    // Batch download summary shown after the batch finishes. Failed galleries
    // are listed BY NAME (with the reason) and, when the caller can re-add
    // them, a "Retry failed" button is offered — a bare failure count left
    // the user with no way to know which titles were missing.
    export function batchSummary(succeeded: number, failed: number, total: number, failedKinds?: Record<string, number>, skipped: number = 0, failedGalleries?: FailedGallery[], canRetry: boolean = false): string {
        let html = '<h3>Download complete</h3>';
        html += '<p>' + succeeded + ' of ' + total + ' galleries downloaded successfully.</p>';
        if (skipped > 0) {
            html += '<p>' + skipped + ' already downloaded gallery' + (skipped === 1 ? '' : 's') + ' skipped.</p>';
        }
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
            html += failedGalleryList(failedGalleries);
            if (canRetry && failedGalleries && failedGalleries.length > 0) {
                html += '<input type="button" id="buttonRetryFailed" value="Retry failed (' + failedGalleries.length + ')"/> ';
            }
        }
        html += '<br/><input type="button" id="buttonBack" value="Go Back"/>';
        return html;
    }

    // Named list of the galleries that did not complete. Not recorded in the
    // download history, so they show as not downloaded on the next visit.
    export function failedGalleryList(failedGalleries?: FailedGallery[]): string {
        if (!failedGalleries || failedGalleries.length === 0) {
            return '';
        }
        let html = '<ul class="nhdwFailedList">';
        for (const entry of failedGalleries) {
            const reason = classifyError(entry.error).label;
            html += '<li><b>' + escapeHtml(entry.name) + '</b> <small>(#' + escapeHtml(entry.id) + ')</small>' +
                '<br/><small class="nhdwFailedReason">' + escapeHtml(reason) + ': ' + escapeHtml(entry.error) + '</small></li>';
        }
        html += '</ul>';
        html += '<small>Failed galleries are not marked as downloaded; nothing partial is recorded.</small><br/>';
        return html;
    }

    // Notice shown above the preview while the worker remembers failed
    // galleries from this session (the popup may have been closed when the
    // job ended). Retry re-adds them; Dismiss forgets them.
    export function failedNotice(failed: FailedGallery[]): string {
        const count = failed.length;
        return '<b>' + count + ' gallery' + (count === 1 ? '' : 'ies') + ' failed to download</b>' +
            failedGalleryList(failed) +
            '<input type="button" id="buttonRetryPending" value="Retry failed (' + count + ')"/> ' +
            '<input type="button" id="buttonDismissFailed" value="Dismiss"/>';
    }

    // Single-gallery failure. Names the gallery when known and offers a
    // retry of the same job when the caller can re-send it.
    export function downloadError(error: string, galleryName?: string, canRetry: boolean = false): string {
        const { label } = classifyError(error);
        let html = 'An error occured: <b>' + escapeHtml(label) + '.</b> ';
        if (galleryName) {
            html += '<br/><b>' + escapeHtml(galleryName) + '</b> was not downloaded: ';
        }
        // Message-first at the last boundary too: an Error instance crossing
        // a message channel must not render as "Error: ..." (or "[object
        // Object]" for a structured-cloned one).
        html += escapeHtml(errorMessage(error));
        // Always leave an action: batch-level errors (no galleryId, so not
        // retryable) used to render with zero buttons and leave the popup
        // stuck until it was reopened (item 29). Retry stays only when the
        // pipeline named a gallery that can be re-added.
        html += '<br/><br/>';
        if (canRetry) {
            html += '<input type="button" id="buttonRetryFailed" value="Retry"/> ';
        }
        html += '<input type="button" id="buttonBack" value="Go Back"/>';
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

    // Batch gallery progress - shown while processing a batch
    export function batchProgress(current: number, total: number, galleryName: string, stage: string, queued: number = 0): string {
        const queueHtml = queued > 0
            ? '<br/><small>' + queued + ' download' + (queued === 1 ? '' : 's') + ' queued.</small><br/><input type="button" id="buttonClearQueue" value="Clear queue"/>'
            : '';
        return 'Gallery ' + current + ' of ' + total + ': ' + stage + ' ' + galleryName +
            '...<br/><progress max="100" id="progressBar" value="' + Math.round(current / total * 100) + '"></progress>' +
            queueHtml + '<br/><br/><input type="button" id="buttonBack" value="Cancel current"/>';
    }
}