/*
 * Synthetic UI self-test for the chapter tool page.
 *
 * Why: the owner should not have to hand-click every control to find out which
 * one is broken. After a build is loaded unpacked, the benchmark presses the
 * page's own controls the way a user would — tick, untick, pick another option,
 * type a marker — and checks that the widget accepted the change and that the
 * original value came back. Everything here is bounded and reversible:
 *
 *   * only an allow-list of controls is ever touched; every button (Scan,
 *     Inspect, Save, Cancel, Load all pages, Forget, Benchmark) has a side
 *     effect and is never clicked, only its resting disabled state is read;
 *   * a checkbox is clicked twice, so the value returns to what it was;
 *   * a select/text control is set to a marker and then restored;
 *   * controls whose change would wipe a review the user has on screen are
 *     skipped when a review exists, rather than destroying their work.
 *
 * The pure parts live here so they can be tested without a DOM.
 */

export type SelfTestKind = "checkbox" | "select" | "text" | "state" | "message";

export interface SelfTestTarget {
    id: string;
    kind: SelfTestKind;
}

export interface SelfTestResult {
    id: string;
    kind: SelfTestKind;
    action: string;
    before: string;
    after: string;
    restored: boolean;
    ok: boolean;
    note?: string;
}

/** Controls with no side effect beyond their own value. */
export const SELF_TEST_CHECKBOXES = [
    "chapterFilter", "outsideLinks", "otherListPages", "salvage", "retry", "rememberHosts", "skipSaved", "confirm"
];
export const SELF_TEST_SELECTS = ["order", "imageAttribute", "pageOrder", "format"];
export const SELF_TEST_TEXTS = ["titleName", "linkSelector", "imageSelector", "fullSizeSuffix"];

/**
 * Controls whose change handler discards the inspected chapters. Driving these
 * with a review on screen would silently throw the user's inspection away, so
 * they are skipped and named in the log instead.
 */
export const REVIEW_INVALIDATING = ["order", "imageAttribute", "pageOrder", "imageSelector"];

/** Markers are distinctive so they cannot be mistaken for a real user value. */
export const SELF_TEST_MARKER = "nhdw self-test";

/** Choose an option value different from the current one, or null if none. */
export function alternateSelectValue(options: string[], current: string): string | null {
    const candidates = options.filter(option => option !== current);
    if (!candidates.length) return null;
    // Prefer a real choice over the "choose one…" placeholder, so the change
    // actually exercises the handler rather than resetting the control.
    const meaningful = candidates.filter(value => value !== "");
    return meaningful.length ? meaningful[0] : candidates[0];
}

/** A value for a text control that differs from what is there now. */
export function markerValue(original: string): string {
    return original === SELF_TEST_MARKER ? SELF_TEST_MARKER + " 2" : SELF_TEST_MARKER;
}

/**
 * The controls to drive. Buttons are deliberately absent: they cannot be
 * pressed more safely than a real click, and their resting state is checked
 * separately by the page.
 */
export function selfTestPlan(hasReview: boolean): SelfTestTarget[] {
    const plan: SelfTestTarget[] = [];
    for (const id of SELF_TEST_CHECKBOXES) plan.push({ id: id, kind: "checkbox" });
    const guarded = (id: string) => hasReview && REVIEW_INVALIDATING.indexOf(id) !== -1;
    for (const id of SELF_TEST_SELECTS) if (!guarded(id)) plan.push({ id: id, kind: "select" });
    for (const id of SELF_TEST_TEXTS) if (!guarded(id)) plan.push({ id: id, kind: "text" });
    return plan;
}

/** Names of the controls the plan left out because a review was on screen. */
export function skippedForReview(hasReview: boolean): string[] {
    if (!hasReview) return [];
    return REVIEW_INVALIDATING.slice();
}

export interface SelfTestSummary {
    checked: number;
    failed: number;
    skipped: number;
}

export function summarizeSelfTest(results: SelfTestResult[], skipped: number = 0): SelfTestSummary {
    let failed = 0;
    for (const result of results) if (!result.ok) failed++;
    return { checked: results.length, failed: failed, skipped: skipped };
}

/** Short human lines for the panel and the log. */
export function formatSelfTest(results: SelfTestResult[]): string[] {
    const lines: string[] = [];
    for (const result of results) {
        const state = result.ok ? "ok" : "FAILED";
        let line = result.id + " (" + result.kind + "): " + result.action + " — " + state;
        if (!result.ok && result.note) line += " (" + result.note + ")";
        lines.push(line);
    }
    return lines;
}
