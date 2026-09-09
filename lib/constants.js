// Shared constants and settings schema for the POV Immersion extension.
// This extension lives at: SillyTavern/public/scripts/extensions/third-party/pov-immersion/

export const MODULE_NAME = 'pov-immersion';
export const SETTINGS_KEY = 'pov_immersion';
export const LOG_PREFIX = '[POV Immersion]';

export const DEFAULT_SETTINGS = {
    enabled: true,
    image: {
        enabled: true,
        comfyUrl: 'http://127.0.0.1:8188',
        // null → lazily loaded from workflows/sdxl_default.json on first init
        workflowJson: null,
        // 'sdxl' = user workflow (editable) + init-image graph surgery;
        // 'anima' = bundled core-node Anima (Qwen-Image) workflows with the
        // in-context reference editing (IC-method), no adapters/ControlNet needed
        workflowPreset: 'sdxl',
        // Checkpoint filename inside ComfyUI; empty = leave %model% untouched in the workflow
        checkpoint: '',
        seed: -1,
        steps: 30,
        cfg: 7,
        qualityTags: 'masterpiece, best quality, highly detailed, cinematic lighting, sharp focus, detailed',
        povTags: 'POV, first-person view, first-person perspective, immersive',
        negativePrompt: 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, jpeg artifacts, signature, watermark, username, blurry, out of frame, extra limbs, disfigured, deformed, mutated hands',
        baseSize: 1024,
        allowedRatios: ['16:9', '3:2', '4:3', '1:1', '4:5', '3:4', '9:16'],
        defaultRatio: '16:9',
        // 'always' | 'probability' | 'manual'
        trigger: 'always',
        probability: 100,
        skipFirstMessage: true,
        attachToMessage: true,
        setAsBackground: true,
        // 0 = keep original resolution, otherwise longest side is scaled to this (JPEG re-encode)
        downscaleMax: 1024,
        // How many last chat messages the Scene Director sees
        contextMessages: 8,
        // KSampler denoise; 1.0 for plain t2i scenes, referenceStrength when a portrait reference is used
        denoise: 1.0,
        // When a scene focuses a character with a saved portrait, use it as an img2img init image
        useAsReference: true,
        // KSampler denoise for reference-based scene generation (lower = closer to the portrait)
        referenceStrength: 0.55,
        // Стилевая LoRA: имя файла в ComfyUI models/loras (пусто = без LoRA),
        // сила воздействия и слово-триггер, дописываемое в начало промпта.
        styleLora: '',
        styleLoraStrength: 1.0,
        styleTrigger: '',
    },
    director: {
        // Прямой OpenAI-совместимый вызов в обход пресет-пайплайна
        // (reasoning_effort=low): ~5с вместо ~20-25с. Пустые поля = тихий
        // вызов через текущий бэкенд ST (медленнее).
        lean: true,
        baseUrl: '',
        apiKey: '',
        model: '',
    },
    portrait: {
        enabled: true,
        autoOffer: true,        // предлагать генерацию для значимых новых NPC
        offerEvery: 6,          // проверять ростер каждые N ответов ИИ
        checkpoint: '',         // имя чекпоинта портретов (Anima Turbo); пусто = главный
        workflowJson: null,     // лениво грузится из workflows/sdxl_portrait.json
    },
    intimacy: {
        enabled: true,
        // 'auto' — открывать оверлей по маркеру модели; 'manual' — только /povintimacy
        mode: 'auto',
        // 'gentle' | 'normal' | 'hard' — ширина ритм-зоны и скорость маркера
        difficulty: 'normal',
        // писать итог мини-игры как /sys заметку — канон для модели
        sysNote: true,
    },
    translation: {
        enabled: true,
        translateAI: true,
        translateUser: true,
        // 'google' (ST server proxy) | 'libre' (direct URL) | 'llm' (quiet prompt)
        provider: 'google',
        libreUrl: '',
        fallbackToLLM: true,
        showOriginalToggle: true,
    },
    debug: {
        enabled: false,
        serverUrl: 'http://127.0.0.1:8766',
        token: '',
    },
    preset: {
        // Интеграция с пресетом GLM-FF5-Hybrid: трекер времени/локации/погоды,
        // HTML-безопасный перевод, санитайз контекста для тихих промптов
        enabled: true,
        // Одноразовый автовыбор пресета, если активен другой
        autoApply: true,
        autoApplied: false,
        name: 'GLM-FF5-Hybrid',
    },
};

// SDXL resolution buckets: ratio → [width, height] at base size 1024.
export const RATIO_BINS = {
    '21:9': [1536, 640],
    '16:9': [1344, 768],
    '3:2': [1216, 832],
    '4:3': [1152, 896],
    '1:1': [1024, 1024],
    '4:5': [896, 1152],
    '3:4': [832, 1216],
    '9:16': [768, 1344],
};

export const ALL_RATIOS = Object.keys(RATIO_BINS);

/**
 * Resolves a ratio string to pixel dimensions, scaled from the SDXL bucket table.
 * @param {string} ratio
 * @param {number} baseSize
 * @returns {{width: number, height: number}}
 */
export function getResolutionForRatio(ratio, baseSize = 1024) {
    const bin = RATIO_BINS[ratio] || RATIO_BINS['16:9'];
    if (!baseSize || baseSize === 1024) {
        return { width: bin[0], height: bin[1] };
    }
    const scale = baseSize / 1024;
    const round64 = (v) => Math.max(320, Math.round((v * scale) / 64) * 64);
    return { width: round64(bin[0]), height: round64(bin[1]) };
}

/**
 * Recursively fills missing keys of `target` from `defaults`. Mutates and returns target.
 * Arrays are taken from target as-is when present.
 * @param {object} target
 * @param {object} defaults
 */
export function mergeDefaults(target, defaults) {
    const result = (target && typeof target === 'object' && !Array.isArray(target)) ? target : {};
    for (const key of Object.keys(defaults)) {
        const dv = defaults[key];
        if (dv && typeof dv === 'object' && !Array.isArray(dv)) {
            result[key] = mergeDefaults(result[key], dv);
        } else if (!(key in result) || result[key] === undefined) {
            result[key] = dv;
        }
    }
    return result;
}
