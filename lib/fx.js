// Pure-DOM FX helpers for POV Immersion: the floating status pill (lazy, one
// instance at the bottom center of the screen) and the media entrance marker.
// Deliberately has ZERO imports — plain browser DOM only, no ST/jQuery
// dependencies, so the module stays trivially testable and side-effect free.

const PILL_CLASS = 'pov-fx-pill';
const PILL_HIDDEN_CLASS = 'pov-fx-pill--hidden';
const MEDIA_ENTER_CLASS = 'pov-media-enter';
// A bit longer than the CSS 200ms transition so the fade-out never flashes.
const PILL_HIDE_DELAY_MS = 220;
// Fallback cleanup for markMediaEnter: under prefers-reduced-motion the
// animation is disabled and animationend never fires.
const MEDIA_ENTER_FALLBACK_MS = 700;

let pillEl = null;
let pillTextEl = null;
let pillHideTimer = null;

/**
 * Lazily creates the pill (spinner + text) once and appends it to <body>.
 * @returns {{pill: HTMLDivElement, text: HTMLSpanElement}|null} null outside a browser DOM
 */
function ensurePill() {
    if (pillEl && pillEl.isConnected) {
        return { pill: pillEl, text: pillTextEl };
    }
    if (typeof document === 'undefined' || !document.body) {
        return null;
    }
    pillEl = document.createElement('div');
    pillEl.className = PILL_CLASS + ' ' + PILL_HIDDEN_CLASS;
    pillEl.setAttribute('role', 'status');
    pillEl.style.display = 'none';

    const spinner = document.createElement('span');
    spinner.className = 'pov-fx-pill__spinner';
    pillTextEl = document.createElement('span');
    pillTextEl.className = 'pov-fx-pill__text';

    pillEl.appendChild(spinner);
    pillEl.appendChild(pillTextEl);
    document.body.appendChild(pillEl);
    return { pill: pillEl, text: pillTextEl };
}

/**
 * Shows the pill with an entrance animation; if it is already visible, only
 * updates the text. Safe to call repeatedly.
 * @param {string} text
 */
export function showFxPill(text) {
    const parts = ensurePill();
    if (!parts) return;
    if (pillHideTimer !== null) {
        clearTimeout(pillHideTimer);
        pillHideTimer = null;
    }
    parts.text.textContent = String(text ?? '');
    if (parts.pill.style.display === 'none') {
        // Coming back from display:none: restore layout first, then drop the
        // hidden class on the next frame, otherwise the transition is skipped.
        parts.pill.classList.add(PILL_HIDDEN_CLASS);
        parts.pill.style.display = '';
        void parts.pill.offsetWidth; // forced reflow
    }
    parts.pill.classList.remove(PILL_HIDDEN_CLASS);
}

/**
 * Updates the pill text without any animation. Creates the (hidden) pill if
 * it does not exist yet, so the call order never matters.
 * @param {string} text
 */
export function updateFxPill(text) {
    const parts = ensurePill();
    if (!parts) return;
    parts.text.textContent = String(text ?? '');
}

/**
 * Hides the pill with an exit animation, then sets display:none. Idempotent:
 * double calls (or calls when the pill was never shown) are harmless.
 */
export function hideFxPill() {
    if (!pillEl || !pillEl.isConnected) {
        return;
    }
    if (pillHideTimer !== null) {
        clearTimeout(pillHideTimer);
        pillHideTimer = null;
    }
    pillEl.classList.add(PILL_HIDDEN_CLASS);
    pillHideTimer = setTimeout(() => {
        pillHideTimer = null;
        if (pillEl) {
            pillEl.style.display = 'none';
        }
    }, PILL_HIDE_DELAY_MS);
}

/**
 * Marks a freshly inserted media element to play the entrance animation; the
 * class is removed on animationend (or by a timeout fallback for
 * prefers-reduced-motion, where the animation never runs).
 * @param {Element} el
 */
export function markMediaEnter(el) {
    if (!el || typeof el.classList?.add !== 'function') {
        return;
    }
    el.classList.add(MEDIA_ENTER_CLASS);
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        el.classList.remove(MEDIA_ENTER_CLASS);
        el.removeEventListener('animationend', finish);
    };
    el.addEventListener('animationend', finish);
    setTimeout(finish, MEDIA_ENTER_FALLBACK_MS);
}
