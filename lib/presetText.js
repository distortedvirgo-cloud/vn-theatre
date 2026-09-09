// Pure text utilities for the GLM-FF5-Hybrid preset integration: tracker line
// parsing, HTML/markup protection for translation and context sanitizing.
// This module intentionally has ZERO imports — it is unit-tested directly in Node.

// A tracker line is a line that consists only of "[ 🕐 ... | ... | ... ]".
const TRACKER_LINE_RE = /^\s*\[\s*🕐([^\]]*)\]\s*$/gm;
// Inside protectHtml the tracker segment may sit in the middle of a single line
// (right after a protected HTML tag), so a wider bracket pattern is used there.
const TRACKER_SEGMENT_RE = /\[[^\]]*🕐[^\]]*\]/g;
const VTK_BLOCK_RE = /<!--\s*VTK_START\s*-->[\s\S]*?<!--\s*VTK_END\s*-->/gi;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const HTML_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g;
const ANY_TAG_RE = /<\/?[a-zA-Z][^<>]*>/g;
// Leading emoji markers before tracker fields (📍, 🌤, any pictographic + optional FE0F).
const FIELD_MARKER_RE = /^(?:[\p{Extended_Pictographic}]\uFE0F?|\s)+/u;
const CLOCK_MARKER_RE = /^\s*🕐\s*/u;
const PLACEHOLDER_RE = /⟦(\d+)⟧/g;
const UNKNOWN_PLACEHOLDER_RE = /⟦[^⟧]*⟧/g;

/**
 * Removes leading emoji markers and whitespace from one tracker field.
 * @param {string} part
 * @returns {string}
 */
function cleanField(part) {
    return String(part ?? '')
        .replace(CLOCK_MARKER_RE, '')
        .replace(FIELD_MARKER_RE, '')
        .trim();
}

/**
 * Splits the tracker line body "🕐 time | location | weather" into fields.
 * @param {string} body inner text between the square brackets (without 🕐 handling)
 * @returns {{time: string, location: string, weather: string, mesidless: null}}
 */
function parseTrackerBody(body) {
    const parts = String(body).split('|');
    const time = cleanField(parts[0]);
    const location = cleanField(parts[1]);
    const weather = cleanField(parts.slice(2).join(' | '));
    return { time, location, weather, mesidless: null };
}

/**
 * Parses the LAST tracker line of the text ("[ 🕐 time | 📍 location | 🌤 weather ]").
 * @param {string} text
 * @returns {{time: string, location: string, weather: string, mesidless: null} | null}
 */
export function parseTrackerLine(text) {
    if (typeof text !== 'string' || !text) {
        return null;
    }
    const re = /^\s*\[\s*🕐([^\]]*)\]\s*$/gm;
    let match = null;
    let last = null;
    while ((match = re.exec(text)) !== null) {
        last = match;
    }
    if (!last) {
        return null;
    }
    return parseTrackerBody(last[1]);
}

/**
 * Alias of parseTrackerLine — the tracker extraction entry point used by the bridge.
 * @param {string} text
 * @returns {{time: string, location: string, weather: string, mesidless: null} | null}
 */
export function extractTracker(text) {
    return parseTrackerLine(text);
}

/**
 * Removes all tracker lines from the text.
 * @param {string} text
 * @returns {string}
 */
export function stripTrackerLines(text) {
    return String(text ?? '').replace(TRACKER_LINE_RE, '');
}

/**
 * Sanitizes chat text for quiet prompts: drops VTK blocks, HTML comments,
 * tracker lines and all HTML tags, then collapses whitespace.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeForAux(text) {
    let s = String(text ?? '');
    s = s.replace(VTK_BLOCK_RE, ' ');
    s = s.replace(HTML_COMMENT_RE, ' ');
    s = stripTrackerLines(s);
    s = s.replace(ANY_TAG_RE, ' ');
    return s.replace(/\s+/g, ' ').trim();
}

/**
 * Replaces markup that must survive translation with ⟦N⟧ placeholders:
 * HTML comments (incl. VTK_START/VTK_END markers), tracker lines and every
 * HTML tag individually. The visible text between tags — including the text
 * of VTK item cards — stays in the stream and gets translated; the tags
 * themselves are restored verbatim afterwards.
 * @param {string} text
 * @returns {{text: string, tokens: string[]}}
 */
export function protectHtml(text) {
    const tokens = [];
    const stash = (segment) => {
        tokens.push(segment);
        return `⟦${tokens.length - 1}⟧`;
    };
    let out = String(text ?? '');
    out = out.replace(HTML_COMMENT_RE, stash);
    out = out.replace(TRACKER_SEGMENT_RE, stash);
    out = out.replace(HTML_TAG_RE, stash);
    return { text: out, tokens };
}

/**
 * Returns ⟦N⟧ placeholders back to their original tokens;
 * unknown leftover placeholders are cut out.
 * @param {string} translated
 * @param {string[]} tokens
 * @returns {string}
 */
export function restoreHtml(translated, tokens) {
    const list = Array.isArray(tokens) ? tokens : [];
    const s = String(translated ?? '');
    const restored = s.replace(PLACEHOLDER_RE, (match, num) => {
        const index = Number(num);
        return (index >= 0 && index < list.length && typeof list[index] === 'string') ? list[index] : '';
    });
    return restored.replace(UNKNOWN_PLACEHOLDER_RE, '');
}
