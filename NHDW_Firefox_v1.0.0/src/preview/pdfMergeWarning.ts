// Modal confirmation shown before a batch PDF would merge SEVERAL DIFFERENT
// titles into one continuous document.
//
// Why this exists: batch PDF concatenates every selected gallery into a single
// file - effectively a tankoubon of unrelated works - and the individual
// titles cannot be separated afterwards. The safe path (one PDF per title) is
// the default/focused button, exactly like the existing "you are going to
// download N pages" confirmation, and this warning stacks after it rather than
// replacing it.
//
// Everything is built with createElement/textContent, so a gallery title can
// never inject markup into the popup.

import { setPdfMergeWarningDismissed } from "../utils/listSettings";

export type PdfMergeChoice = "separate" | "merge" | "cancel";

export interface PdfMergeResult {
    choice: PdfMergeChoice;
    /** True when the user ticked "don't warn me again" AND proceeded. */
    dismissed: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    return node;
}

/**
 * Ask the user what to do with a multi-title batch PDF.
 *
 * Resolves with the chosen path:
 *   "separate" - switch to one PDF per title (the safe default),
 *   "merge"    - merge anyway,
 *   "cancel"   - do nothing,
 * plus whether the user asked not to be warned again for this combination.
 */
export function confirmPdfMerge(titleCount: number): Promise<PdfMergeResult> {
    return new Promise<PdfMergeResult>((resolve) => {
        const host = document.getElementById("modalHost") || document.body;

        const overlay = el("div", "nhdwModalOverlay");
        const dialog = el("div", "nhdwModal");
        dialog.setAttribute("role", "alertdialog");
        dialog.setAttribute("aria-modal", "true");

        const heading = el("h3");
        heading.textContent = "Merge " + titleCount + " different titles into a single PDF?";
        dialog.appendChild(heading);

        const body = el("p");
        body.textContent = "Batch PDF combines every selected gallery into one continuous document, "
            + "like a tankoubon - the individual titles cannot be separated afterwards.";
        dialog.appendChild(body);

        const question = el("p");
        question.textContent = "Did you mean Separate files (one PDF per title)?";
        dialog.appendChild(question);

        const dismissLabel = el("label", "nhdwModalDismiss");
        const dismissBox = el("input");
        dismissBox.type = "checkbox";
        dismissBox.id = "pdfMergeDontWarn";
        dismissLabel.appendChild(dismissBox);
        dismissLabel.appendChild(document.createTextNode(
            " Don't warn me again for batch PDF with several titles"));
        dialog.appendChild(dismissLabel);

        const buttons = el("div", "nhdwModalButtons");
        const separateButton = el("button");
        separateButton.type = "button";
        separateButton.id = "pdfMergeSeparate";
        separateButton.className = "nhdwModalPrimary";
        separateButton.textContent = "Switch to separate files";
        const mergeButton = el("button");
        mergeButton.type = "button";
        mergeButton.id = "pdfMergeAnyway";
        mergeButton.textContent = "Merge anyway";
        const cancelButton = el("button");
        cancelButton.type = "button";
        cancelButton.id = "pdfMergeCancel";
        cancelButton.textContent = "Cancel";
        buttons.appendChild(separateButton);
        buttons.appendChild(mergeButton);
        buttons.appendChild(cancelButton);
        dialog.appendChild(buttons);

        overlay.appendChild(dialog);
        host.appendChild(overlay);

        let settled = false;
        const close = (choice: PdfMergeChoice) => {
            if (settled) {
                return;
            }
            settled = true;
            // "Don't warn me again" is scoped to THIS combination only
            // (pdf + batch + more than one title) and is only honoured when
            // the user actually chose to proceed - dismissing with Cancel must
            // not silence a warning the user never answered.
            const dismissed = dismissBox.checked && choice !== "cancel";
            if (dismissed) {
                setPdfMergeWarningDismissed(true);
            }
            document.removeEventListener("keydown", onKeyDown, true);
            try {
                host.removeChild(overlay);
            } catch (_) { /* already detached */ }
            resolve({ choice: choice, dismissed: dismissed });
        };

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                close("cancel");
            }
        };
        document.addEventListener("keydown", onKeyDown, true);

        separateButton.addEventListener("click", () => close("separate"));
        mergeButton.addEventListener("click", () => close("merge"));
        cancelButton.addEventListener("click", () => close("cancel"));
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) {
                close("cancel");
            }
        });

        // Safe path is focused, so Enter picks "one PDF per title".
        setTimeout(() => {
            try {
                separateButton.focus();
            } catch (_) { /* focus is a nicety */ }
        }, 0);
    });
}
