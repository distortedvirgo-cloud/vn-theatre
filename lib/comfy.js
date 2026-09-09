// ComfyUI HTTP client for the POV Immersion extension.
// Plain fetch + AbortController only: the pipeline also runs on mobile browsers,
// so no jQuery-based core helpers are used here.

import { log, warn, error } from './logger.js';

const HISTORY_POLL_INTERVAL_MS = 400;
const DEFAULT_TIMEOUT_MS = 240000;
const CHECK_TIMEOUT_MS = 5000;

const WORKFLOW_TOKENS = {
    '%prompt%': 'prompt',
    '%negative%': 'negative',
    '%width%': 'width',
    '%width2%': 'width2',
    '%height%': 'height',
    '%seed%': 'seed',
    '%steps%': 'steps',
    '%cfg%': 'cfg',
    '%model%': 'model',
    '%denoise%': 'denoise',
    '%init_image%': 'initImage',
    '%canvas_w%': 'canvasW',
    '%canvas_h%': 'canvasH',
    '%crop_x%': 'cropX',
    '%crop_w%': 'cropW',
    '%crop_h%': 'cropH',
    '%lora%': 'lora',
    '%lora_strength%': 'loraStrength',
};

function normalizeBaseUrl(url) {
    return String(url ?? '').trim().replace(/\/+$/, '');
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text, limit) {
    const s = String(text ?? '');
    return s.length > limit ? s.slice(0, limit) : s;
}

/**
 * Pings a ComfyUI instance at the given base URL.
 * @param {string} url
 * @returns {Promise<{ok: true, info: any} | {ok: false, error: string}>}
 */
export async function checkComfy(url) {
    const base = normalizeBaseUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
        const response = await fetch(base + '/system_stats', { signal: controller.signal });
        if (!response.ok) {
            const body = truncate(await response.text().catch(() => ''), 300);
            const message = 'HTTP ' + response.status + (body ? ': ' + body : '');
            warn('comfy', 'check failed', message);
            return { ok: false, error: message };
        }
        const info = await response.json();
        log('comfy', 'check ok', { version: info?.system?.comfyui_version ?? 'unknown' });
        return { ok: true, info };
    } catch (err) {
        const message = err?.name === 'AbortError'
            ? 'no answer within 5s'
            : String(err?.message ?? err);
        warn('comfy', 'check failed', message);
        return { ok: false, error: message };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Parses a workflow JSON and replaces placeholders with actual values.
 * Whole-string tokens ('%prompt%' as the entire value) keep their value type
 * (numbers stay numbers for INT widgets). Tokens embedded inside longer strings
 * ('The image on the right is different - %prompt%', 'POV/anima_%seed%') are
 * substituted as text with numbers stringified; unknown %...% stays untouched.
 * The source structure is never mutated.
 * @param {string} workflowJsonString
 * @param {{prompt?: string, negative?: string, width?: number, width2?: number, height?: number, seed?: number, steps?: number, cfg?: number, model?: string, denoise?: number, initImage?: string}} vars
 * @returns {object}
 */
export function substituteWorkflow(workflowJsonString, vars) {
    let parsed;
    try {
        parsed = JSON.parse(workflowJsonString);
    } catch (err) {
        throw new Error('Workflow JSON is not valid: ' + (err?.message ?? err));
    }
    const v = vars ?? {};
    const resolveToken = (token) => {
        const value = v[WORKFLOW_TOKENS[token]];
        // An empty checkpoint keeps %model% in the workflow so ComfyUI reports the
        // obvious placeholder instead of silently loading an unrelated model.
        if (token === '%model%') {
            return typeof value === 'string' && value.trim() ? value.trim() : token;
        }
        // Missing denoise must not leave the literal token in the graph (ComfyUI
        // expects a number there): fall back to plain t2i behavior.
        if (token === '%denoise%') {
            const n = Number(value);
            return Number.isFinite(n) ? n : 1.0;
        }
        // Same for the style LoRA strength; an unset %lora% name degrades to an
        // empty string only for call sites that never asked for a LoRA.
        if (token === '%lora_strength%') {
            const n = Number(value);
            return Number.isFinite(n) ? n : 1.0;
        }
        if (token === '%lora%') {
            return typeof value === 'string' ? value.trim() : '';
        }
        // %init_image% holds a file name ALREADY uploaded to ComfyUI (see uploadInitImage).
        // Our stock workflows have no LoadImage node, so the token never occurs in them
        // and nothing is touched; in custom workflows with LoadImage a missing value
        // degrades to an empty string instead of a literal token.
        if (token === '%init_image%') {
            return typeof value === 'string' ? value.trim() : '';
        }
        return value === undefined || value === null ? token : value;
    };
    const walk = (node) => {
        if (typeof node === 'string') {
            if (Object.prototype.hasOwnProperty.call(WORKFLOW_TOKENS, node)) {
                return resolveToken(node);
            }
            if (node.indexOf('%') !== -1) {
                return node.replace(/%[a-z_]+%/gi, (token) => (
                    Object.prototype.hasOwnProperty.call(WORKFLOW_TOKENS, token)
                        ? String(resolveToken(token))
                        : token
                ));
            }
            return node;
        }
        if (Array.isArray(node)) {
            return node.map(walk);
        }
        if (node && typeof node === 'object') {
            const copy = {};
            for (const key of Object.keys(node)) {
                copy[key] = walk(node[key]);
            }
            return copy;
        }
        return node;
    };
    const graph = walk(parsed);
    // Style LoRA выключен (пустое имя после подстановки) — узел вырезается,
    // а все потребители переподключаются напрямую к его model-входу, чтобы
    // стандартные графы работали и без LoRA.
    const loraNodeIds = Object.keys(graph).filter((id) => (
        graph[id]?.class_type === 'LoraLoaderModelOnly'
        && !String(graph[id]?.inputs?.lora_name ?? '').trim()
        && typeof graph[id]?.inputs?.model?.[0] === 'string'
    ));
    if (loraNodeIds.length) {
        const bypass = new Map(loraNodeIds.map((id) => [id, graph[id].inputs.model]));
        for (const id of loraNodeIds) {
            delete graph[id];
        }
        const rewire = (node) => {
            for (const [key, value] of Object.entries(node.inputs ?? {})) {
                if (Array.isArray(value) && typeof value[0] === 'string' && bypass.has(value[0])) {
                    node.inputs[key] = bypass.get(value[0]);
                }
            }
        };
        for (const node of Object.values(graph)) {
            rewire(node);
        }
    }
    return graph;
}

// Lazy cache for workflow texts bundled with the extension (workflows/*.json).
const bundledWorkflows = new Map();

/**
 * Loads a bundled workflow text from the workflows/ folder (cached per name).
 * Used by the Anima engine branch: stock Anima graphs are read-only assets and
 * are intentionally not stored in user settings (unlike the SDXL custom workflow).
 * @param {string} name File name without extension (e.g. 'anima_scene')
 * @returns {Promise<string>}
 */
export async function loadBundledWorkflow(name) {
    const key = String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!key) {
        throw new Error('Bundled workflow name is empty');
    }
    if (bundledWorkflows.has(key)) {
        return bundledWorkflows.get(key);
    }
    const response = await fetch(new URL('../workflows/' + key + '.json', import.meta.url));
    if (!response.ok) {
        throw new Error('Bundled workflow "' + key + '" not found (HTTP ' + response.status + ')');
    }
    const text = await response.text();
    bundledWorkflows.set(key, text);
    return text;
}

/**
 * Post-processing for init-image (img2img) generation: re-wires the graph so the
 * KSampler takes its latent from VAEEncode(LoadImage(name)) instead of
 * EmptyLatentImage, and applies the given denoise. Plain graph surgery on the
 * object returned by substituteWorkflow (that copy is safe to mutate).
 * @param {object} workflow Parsed workflow graph (API format)
 * @param {string} initImageName File name of an image already uploaded to ComfyUI
 * @param {number} denoise KSampler denoise for the reference pass
 * @returns {object} The same workflow object (mutated in place when rewired)
 */
export function applyInitImage(workflow, initImageName, denoise) {
    if (!workflow || typeof workflow !== 'object' || !String(initImageName ?? '').trim()) {
        return workflow;
    }
    // KSampler whose latent_image still comes from EmptyLatentImage
    let samplerId = null;
    let sampler = null;
    for (const id of Object.keys(workflow)) {
        const node = workflow[id];
        if (typeof node?.class_type !== 'string' || !node.class_type.startsWith('KSampler')) {
            continue;
        }
        const latentRef = node?.inputs?.latent_image;
        const latentId = Array.isArray(latentRef) ? String(latentRef[0]) : null;
        if (latentId && workflow[latentId]?.class_type === 'EmptyLatentImage') {
            samplerId = id;
            sampler = node;
            break;
        }
    }
    // Same VAE that VAEDecode uses (output 2 of the checkpoint loader in stock graphs)
    let vaeRef = null;
    for (const id of Object.keys(workflow)) {
        const vae = workflow[id]?.class_type === 'VAEDecode' ? workflow[id]?.inputs?.vae : null;
        if (Array.isArray(vae)) {
            vaeRef = vae;
            break;
        }
    }
    if (!sampler || !vaeRef) {
        warn('comfy', 'init image: KSampler/EmptyLatentImage/VAEDecode not found, generating without reference', {
            sampler: samplerId,
        });
        return workflow;
    }
    let maxId = 0;
    for (const id of Object.keys(workflow)) {
        const n = Number(id);
        if (Number.isInteger(n) && n > maxId) {
            maxId = n;
        }
    }
    const loadId = String(maxId + 1);
    const encodeId = String(maxId + 2);
    workflow[loadId] = { class_type: 'LoadImage', inputs: { image: String(initImageName).trim() } };
    workflow[encodeId] = { class_type: 'VAEEncode', inputs: { pixels: [loadId, 0], vae: vaeRef } };
    sampler.inputs.latent_image = [encodeId, 0];
    const d = Number(denoise);
    if (Number.isFinite(d)) {
        sampler.inputs.denoise = d;
    }
    log('comfy', 'init image wired', { sampler: samplerId, load: loadId, encode: encodeId, denoise: sampler.inputs.denoise });
    return workflow;
}

/**
 * Uploads an image into ComfyUI's input directory (POST /upload/image) so it can
 * be referenced by name from a LoadImage node.
 * @param {Blob} blob
 * @param {string} filename
 * @param {string} comfyUrl Base URL of the ComfyUI instance
 * @returns {Promise<string>} The uploaded file name as ComfyUI sees it
 */
export async function uploadInitImage(blob, filename, comfyUrl) {
    const base = normalizeBaseUrl(comfyUrl);
    const formData = new FormData();
    formData.append('image', new File([blob], String(filename ?? 'init.png'), { type: blob?.type || 'image/png' }));
    formData.append('subfolder', 'pov');
    formData.append('overwrite', 'true');
    let response;
    try {
        response = await fetch(base + '/upload/image', { method: 'POST', body: formData });
    } catch (err) {
        error('comfy', 'failed to reach ComfyUI for upload', { url: base, message: String(err?.message ?? err) });
        throw new Error('ComfyUI unreachable: ' + (err?.message ?? err));
    }
    if (!response.ok) {
        const body = truncate(await response.text().catch(() => ''), 500);
        error('comfy', 'init image upload failed', { status: response.status, body });
        throw new Error('ComfyUI /upload/image HTTP ' + response.status + ': ' + body);
    }
    const data = await response.json().catch(() => null);
    const name = data?.name;
    if (!name) {
        error('comfy', 'no image name in upload response', data);
        throw new Error('ComfyUI upload did not return a file name');
    }
    log('comfy', 'init image uploaded', { name: name, subfolder: data?.subfolder ?? 'pov' });
    // LoadImage resolves names against the input root, so a file uploaded into a
    // subfolder must be referenced as "subfolder/name.ext" (folder_paths lookup).
    const subfolder = String(data?.subfolder ?? '').trim().replace(/^\/+|\/+$/g, '');
    return subfolder ? subfolder + '/' + String(name) : String(name);
}

/**
 * Queues a workflow on ComfyUI and waits for its first output image.
 * @param {{url: string, workflow: object, clientId: string, timeoutMs?: number}} params
 * @returns {Promise<{blob: Blob, mime: string}>}
 */
export async function generateImage({ url, workflow, clientId, timeoutMs }) {
    const base = normalizeBaseUrl(url);
    const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();

    let response;
    try {
        response = await fetch(base + '/prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: workflow, client_id: clientId }),
        });
    } catch (err) {
        error('comfy', 'failed to reach ComfyUI', { url: base, message: String(err?.message ?? err) });
        throw new Error('ComfyUI unreachable: ' + (err?.message ?? err));
    }

    if (!response.ok) {
        // ComfyUI puts node_errors / error details into the response body
        const body = truncate(await response.text().catch(() => ''), 2000);
        error('comfy', 'prompt rejected', { status: response.status, body });
        throw new Error('ComfyUI HTTP ' + response.status + ': ' + body);
    }

    const queued = await response.json().catch(() => null);
    const promptId = queued?.prompt_id;
    if (!promptId) {
        error('comfy', 'no prompt_id in response', queued);
        throw new Error('ComfyUI did not return prompt_id');
    }
    log('comfy', 'queued', { promptId });

    const { filename, subfolder, type } = await pollHistory(base, promptId, limit, startedAt);
    return await fetchImage(base, filename, subfolder, type);
}

/**
 * Polls /history/{prompt_id} until the run finishes and returns the first output image reference.
 * @param {string} base
 * @param {string} promptId
 * @param {number} limit
 * @param {number} startedAt
 * @returns {Promise<{filename: string, subfolder: string, type: string}>}
 */
async function pollHistory(base, promptId, limit, startedAt) {
    while (true) {
        if (Date.now() - startedAt > limit) {
            error('comfy', 'generation timed out', { promptId, limitMs: limit });
            throw new Error('ComfyUI timeout after ' + Math.round(limit / 1000) + 's');
        }
        await delay(HISTORY_POLL_INTERVAL_MS);

        let data;
        try {
            const response = await fetch(base + '/history/' + encodeURIComponent(promptId));
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
            data = await response.json();
        } catch (err) {
            warn('comfy', 'history poll failed, will retry', String(err?.message ?? err));
            continue;
        }

        const entry = data?.[promptId];
        if (!entry) {
            continue;
        }

        const status = entry.status;
        if (status?.status_str === 'error') {
            const detail = truncate(JSON.stringify(status.messages ?? status), 2000);
            error('comfy', 'execution error', detail);
            throw new Error('ComfyUI execution error: ' + detail);
        }

        const outputs = entry.outputs;
        if (outputs && typeof outputs === 'object') {
            for (const nodeId of Object.keys(outputs)) {
                const images = outputs[nodeId]?.images;
                if (Array.isArray(images) && images.length > 0) {
                    const { filename, subfolder, type } = images[0];
                    return { filename, subfolder, type };
                }
            }
        }
    }
}

/**
 * Downloads the generated image from the /view endpoint.
 * @param {string} base
 * @param {string} filename
 * @param {string} subfolder
 * @param {string} type
 * @returns {Promise<{blob: Blob, mime: string}>}
 */
async function fetchImage(base, filename, subfolder, type) {
    const params = new URLSearchParams();
    params.set('filename', String(filename ?? ''));
    params.set('subfolder', String(subfolder ?? ''));
    params.set('type', String(type ?? ''));
    const response = await fetch(base + '/view?' + params.toString());
    if (!response.ok) {
        const body = truncate(await response.text().catch(() => ''), 500);
        error('comfy', 'image download failed', { status: response.status, body });
        throw new Error('ComfyUI /view HTTP ' + response.status + ': ' + body);
    }
    const blob = await response.blob();
    const mime = blob.type || 'image/png';
    log('comfy', 'image fetched', { filename, mime, size: blob.size });
    return { blob, mime };
}

/**
 * Converts a Blob to a base64 string without the data: prefix.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = String(reader.result ?? '');
            const index = dataUrl.indexOf(',');
            resolve(index === -1 ? dataUrl : dataUrl.slice(index + 1));
        };
        reader.onerror = () => reject(new Error('Failed to read image blob'));
        reader.readAsDataURL(blob);
    });
}

/**
 * Downscales an image so its longest side equals maxDim, re-encoding as JPEG (quality 0.9).
 * Returns the source blob untouched when downscaling is disabled or unnecessary.
 * @param {Blob} blob
 * @param {number} maxDim
 * @returns {Promise<{blob: Blob, mime: string}>}
 */
export async function downscaleImageBlob(blob, maxDim) {
    const asIs = () => ({ blob, mime: blob.type || 'image/png' });
    if (!maxDim || maxDim <= 0) {
        return asIs();
    }
    let bitmap;
    try {
        bitmap = await createImageBitmap(blob);
    } catch (err) {
        warn('comfy', 'createImageBitmap failed, keeping original size', String(err?.message ?? err));
        return asIs();
    }
    try {
        const { width, height } = bitmap;
        if (width <= maxDim && height <= maxDim) {
            return asIs();
        }
        const scale = maxDim / Math.max(width, height);
        const targetW = Math.max(1, Math.round(width * scale));
        const targetH = Math.max(1, Math.round(height * scale));
        const newBlob = await encodeBitmap(bitmap, targetW, targetH);
        log('comfy', 'downscaled', { from: width + 'x' + height, to: targetW + 'x' + targetH });
        return { blob: newBlob, mime: newBlob.type || 'image/jpeg' };
    } finally {
        bitmap.close?.();
    }
}

/**
 * Draws the bitmap onto a canvas and encodes it as JPEG, preferring OffscreenCanvas.
 * @param {ImageBitmap} bitmap
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Blob>}
 */
async function encodeBitmap(bitmap, width, height) {
    if (typeof OffscreenCanvas === 'function') {
        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
        return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
            'image/jpeg',
            0.9,
        );
    });
}
