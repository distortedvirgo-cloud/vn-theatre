// Ring-buffer logger for the POV Immersion extension.
// All module logs go through here: console + in-memory ring + (optional) debug bridge sink.

import { LOG_PREFIX } from './constants.js';

const MAX_LOGS = 300;

/** @type {Array<{ts: string, level: string, tag: string, message: string, data: any}>} */
const logs = [];

let bridgeSink = null;

function push(level, tag, message, data) {
    const entry = { ts: new Date().toISOString(), level, tag, message: String(message), data: data ?? null };
    logs.push(entry);
    if (logs.length > MAX_LOGS) {
        logs.shift();
    }
    const line = `${LOG_PREFIX}[${tag}] ${entry.message}`;
    if (level === 'error') {
        console.error(line, data ?? '');
    } else if (level === 'warn') {
        console.warn(line, data ?? '');
    } else {
        console.log(line, data ?? '');
    }
    if (bridgeSink) {
        try {
            bridgeSink(entry);
        } catch {
            // The debug bridge must never break the app through logging.
        }
    }
}

export const log = (tag, message, data) => push('info', tag, message, data);
export const warn = (tag, message, data) => push('warn', tag, message, data);
export const error = (tag, message, data) => push('error', tag, message, data);

/**
 * Returns the last n log entries.
 * @param {number} [n]
 */
export function getRecentLogs(n = 100) {
    return logs.slice(-n);
}

/**
 * Installs the sink used by the debug bridge to forward logs to the PC.
 * @param {((entry: object) => void) | null} fn
 */
export function setBridgeSink(fn) {
    bridgeSink = typeof fn === 'function' ? fn : null;
}
