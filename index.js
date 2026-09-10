// VN Theatre — SillyTavern extension porting the visual-novel presentation and
// the systemic engines of https://github.com/pnotisdev/rp:
// scene tags (expression/background/mood/outfit), a relationship judge
// (7 dimensions, stages, flags, character mind, plans/beliefs/facts),
// an intimacy state machine ([SCENE STATE] injection), intent chips,
// AI-suggested next moves, and per-message auto-translation.
import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types, messageFormatting, extension_prompt_types, appendMediaToMessage, getRequestHeaders } from '../../../../script.js';
import { saveBase64AsFile } from '../../../utils.js';
import { MEDIA_TYPE, MEDIA_DISPLAY, SCROLL_BEHAVIOR } from '../../../constants.js';
// pov-immersion port: ComfyUI client, FX pill, translation-safe markup
import { checkComfy, substituteWorkflow, loadBundledWorkflow, generateImage, blobToBase64, downscaleImageBlob } from './lib/comfy.js';
import { showFxPill, updateFxPill, hideFxPill } from './lib/fx.js';
import { protectHtml, restoreHtml } from './lib/presetText.js';

// ===================================================================
// 1. SETTINGS
// ===================================================================

const DEFAULT_SETTINGS = {
    enabled: false,          // overlay visible
    instruct: true,          // inject scene-tag instruction into prompts
    typewriter: true,
    petals: true,            // legacy (kept for migration -> effect)
    sfx: true,               // comic-burst styling for ALL-CAPS onomatopoeia
    autoTranslate: true,
    provider: 'llm',         // llm (user's chat API) | st-proxy | google | libre
    libreUrl: 'https://libretranslate.com/translate',
    libreKey: '',
    targetLang: 'ru',
    customBgs: '',           // "name=url" per line
    cache: {},               // chatKey -> { mesId -> { t, tl, ts } }
    // --- ported systems ---
    judge: true,             // per-reply relationship judge (secondary LLM call)
    difficulty: 'normal',    // gentle | normal | harsh  (delta scaling)
    autoChoices: true,       // suggest next-move chips after each reply
    intentArm: '',           // legacy armed intent chip id (''|flirt|tease|...)
    intentJudgeDesc: '',     // one-shot intent set by a used chip (for judge/injection)
    chipOptions: [],         // [{label,guide,judge}] — the dynamic chip row
    judgeFailed: false,
    // --- ambient effects (sakura, snow, rain, ...) ---
    effect: 'sakura',
    // --- image generation (pov-immersion port: ComfyUI) ---
    image: {
        enabled: true,
        comfyUrl: 'http://127.0.0.1:8188',
        preset: 'anima',        // anima (Qwen-Image) | sdxl
        attachToMessage: true,  // attach the result to the last message
        setAsBackground: true,  // use the result as the VN background
        autoFromTag: true,      // AI may auto-generate backgrounds via bggen= tags
        qualityTags: 'masterpiece, best quality, highly detailed',
        negativePrompt: 'lowres, bad anatomy, bad hands, watermark, signature, text',
        checkpoint: '',        // anima default: anima-base-v1.0.safetensors; sdxl: set your checkpoint
        lora: '',
        loraStrength: 1.0,
        steps: 30,
        cfg: 4,
        seed: -1,
        maxDim: 1280,           // longest side after downscale
        bgMap: {},              // chatKey -> { url } generated VN background
    },
};

function getSettings() {
    if (extension_settings.vnt === undefined) extension_settings.vnt = {};
    const s = extension_settings.vnt;
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = v;
    }
    // migration: old petals on/off -> effect preset
    if (!('vnt_effect_migrated' in s) && typeof s.effect === 'string') {
        if (s.effect === 'sakura' && s.petals === false) s.effect = 'off';
        s.vnt_effect_migrated = true;
    }
    // migration v1.3: auto-translate ON via the user's chat API
    if (!s.vnt_v13_migrated) {
        if (s.provider === 'st-proxy' || s.provider === 'google') s.provider = 'llm';
        if (s.autoTranslate === false) s.autoTranslate = true;
        s.judgeFailed = false; // stale failure flag would hide new error toasts
        s.vnt_v13_migrated = true;
    }
    return s;
}

function imgSettings() {
    const s = getSettings();
    if (!s.image || typeof s.image !== 'object') s.image = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.image));
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS.image)) {
        if (s.image[k] === undefined) s.image[k] = v;
    }
    return s.image;
}

// ===================================================================
// 2. VOCABULARIES & CONSTANTS  (ported from rp: moods.ts, stage.ts, arousal.ts)
// ===================================================================

const EXPRS = ['neutral', 'happy', 'sad', 'angry', 'shy', 'love', 'surprise', 'sleepy'];
const BG_KEYS = ['cafe', 'classroom', 'park', 'bedroom', 'city', 'beach', 'temple', 'living_room', 'street', 'school'];
const MOOD_IDS = ['tender', 'romantic', 'cheerful', 'playful', 'lively', 'calm', 'dreamy', 'tense', 'somber'];

// rp mindGuidance.ts MOOD_VOCAB (20 values)
const MOOD_VOCAB = [
    'happy', 'content', 'excited', 'affectionate', 'flirty', 'playful', 'curious', 'hopeful',
    'grateful', 'peaceful', 'neutral', 'awkward', 'annoyed', 'hurt', 'sad', 'lonely',
    'anxious', 'jealous', 'angry', 'afraid',
];
// rp mindGuidance.ts NEED_VOCAB (8 values)
const NEED_VOCAB = ['connection', 'reassurance', 'space', 'attention', 'comfort', 'challenge', 'control', 'care'];

const DELTA_KEYS = ['affection', 'trust', 'chemistry', 'comfort', 'respect', 'curiosity', 'tension'];

// rp stage.ts RELATIONSHIP_MILESTONES
const STAGES = [
    { id: 'near_strangers', min: 0 },
    { id: 'acquaintances', min: 15 },
    { id: 'warming_up', min: 35 },
    { id: 'getting_close', min: 55 },
    { id: 'close', min: 75 },
    { id: 'sweethearts', min: 90 },
];

const ALLOWED_FLAGS = [
    'first_date', 'confession', 'jealousy', 'promise', 'first_kiss',
    'first_intimate', 'moving_in', 'proposal', 'married', 'breakup_risk',
];

const INTENTS = {
    flirt: { label: 'Flirt', judge: 'flirtatious', guide: 'Flirt with them' },
    tease: { label: 'Tease', judge: 'teasing', guide: 'Tease them playfully' },
    open_up: { label: 'Open up', judge: 'an attempt to open up emotionally', guide: 'Open up about your feelings' },
    reassure: { label: 'Reassure', judge: 'an attempt to reassure them', guide: 'Reassure them' },
    apologize: { label: 'Apologize', judge: 'an apology', guide: 'Apologize' },
};

// the intent the judge/injection should consider for the latest user line:
// either set by a used chip (free text) or the legacy armed static chip
function armedIntentDesc() {
    const s = getSettings();
    if (s.intentJudgeDesc) return s.intentJudgeDesc;
    return s.intentArm && INTENTS[s.intentArm] ? INTENTS[s.intentArm].judge : '';
}

// rp clothing.ts CLOTHING_LAYERS
const CLOTHING_LAYERS = ['outerwear', 'top', 'bottoms', 'underwear', 'shoes'];
// rp arousal.ts BODY_REGIONS (trimmed)
const BODY_REGIONS = ['lips', 'neck', 'ears', 'chest', 'breasts', 'waist', 'hips', 'thighs', 'between_legs', 'back', 'hands'];

const SCENE_TAG_RE = /<<\s*scene\s*:\s*([^>]*?)>>/gi;
// attr values may contain spaces: bggen=a misty glade at dawn, pale sun
const SCENE_ATTR_RE = /([\w-]+)\s*=\s*((?:(?!,\s*[\w-]+\s*=)[\s\S])*)/gi;

const DIFFICULTY_SCALE = { gentle: 0.5, normal: 1, harsh: 1.5 };

// ===================================================================
// 3. STATE MODEL (per chat; mirrors rp RelationshipTrack / IntimacyScene)
// ===================================================================

function freshState() {
    const clothing = () => Object.fromEntries(CLOTHING_LAYERS.map(l => [l, true]));
    return {
        v: 1,
        dims: Object.fromEntries(DELTA_KEYS.map(k => [k, 0])),
        flags: [],
        mood: '', need: '', intent: '', desire: '', fear: '',
        plans: [],        // { text, formedTurn }
        beliefs: [],
        expectations: [],
        facts: [],        // { text, importance, valence, unresolved }
        clothing: { char: clothing(), user: clothing() },
        arousal: { value: 0, phase: 'building', lastTurn: 0 },
        contact: [],      // body regions currently in contact
        outfit: { char: '', user: '' },
        scene: { background: '', mood: '', location: '' },
        judgedMesId: -1,
        updatedAt: 0,
    };
}

function chatKey() {
    const ctx = getContext();
    return ctx.groupId ? `g:${ctx.groupId}` : `c:${ctx.chatId ?? 'none'}`;
}

function getState() {
    const ctx = getContext();
    // preferred: per-chat metadata (saved with the chat file)
    if (ctx.chatMetadata) {
        if (!ctx.chatMetadata.vnt_state) ctx.chatMetadata.vnt_state = freshState();
        return ctx.chatMetadata.vnt_state;
    }
    // fallback: extension settings keyed by chat
    const s = getSettings();
    s.states = s.states ?? {};
    if (!s.states[chatKey()]) s.states[chatKey()] = freshState();
    return s.states[chatKey()];
}

function persistState() {
    const st = getState();
    st.updatedAt = Date.now();
    getContext().saveMetadataDebounced?.();
    saveSettingsDebounced();
    updatePromptInjections();
}

function computeWarmth(dims) {
    const sum = dims.affection + dims.trust + dims.chemistry + dims.comfort + dims.respect;
    return Math.round(sum / 5);
}

function stageForWarmth(w) {
    let cur = STAGES[0];
    for (const s of STAGES) if (w >= s.min) cur = s;
    return cur;
}

function commitmentFromFlags(flags) {
    if (flags.includes('married')) return 'married';
    if (flags.includes('moving_in')) return 'living_together';
    if (flags.includes('promise')) return 'exclusive';
    if (flags.includes('confession')) return 'dating';
    if (flags.includes('first_kiss')) return 'dating';
    return 'none';
}

function arousalBand(v) {
    if (v < 15) return 'baseline';
    if (v < 40) return 'warming';
    if (v < 70) return 'engaged';
    if (v < 90) return 'edge';
    return 'over';
}

function clampState(st) {
    for (const k of DELTA_KEYS) st.dims[k] = Math.max(0, Math.min(100, st.dims[k] | 0));
    st.flags = [...new Set(st.flags.filter(f => ALLOWED_FLAGS.includes(f)))].slice(0, 12);
    st.plans = st.plans.slice(0, 3);
    st.beliefs = st.beliefs.slice(0, 5);
    st.expectations = st.expectations.slice(0, 5);
    st.facts = st.facts.slice(0, 30);
    st.contact = st.contact.filter(r => BODY_REGIONS.includes(r)).slice(0, 8);
    st.arousal.value = Math.max(0, Math.min(100, st.arousal.value | 0));
    st.arousal.phase = ['building', 'peak'].includes(st.arousal.phase) ? st.arousal.phase : 'building';
}

// ===================================================================
// 4. SCENE TAG (v2: expression/background/mood/outfit — rp sceneTag.ts)
// ===================================================================

export function parseSceneTag(raw) {
    const out = {};
    if (!raw) return out;
    const matches = [...raw.matchAll(SCENE_TAG_RE)];
    if (!matches.length) return out;
    const body = matches[matches.length - 1][1];
    for (const m of body.matchAll(SCENE_ATTR_RE)) {
        out[m[1].toLowerCase()] = m[2].trim().toLowerCase();
    }
    return out;
}

export function stripSceneTags(text) {
    return String(text ?? '').replace(SCENE_TAG_RE, '').trim();
}

function sceneInstruction() {
    const st = getState();
    const lines = [
        '[Scene direction: End every response with a single tag in this exact format. The tag is metadata only: never mention or explain it in the dialogue.]',
        '<<scene: expression=ID, background=ID, mood=ID, outfit=ID, effect=ID>>',
        `expression IDs: ${EXPRS.join(', ')}.`,
        `background IDs: ${BG_KEYS.join(', ')}.`,
        `mood IDs: ${MOOD_IDS.join(', ')}.`,
        `effect IDs: ${[...EFFECT_PRESETS, 'off'].join(', ')} — ambient atmosphere overlay. Pick the one matching weather and place: rain in a storm, snow in winter, fireflies on a summer night in nature, embers near a fire, leaves in an autumn wind, bubbles near water, hearts during romance, sakura under blooming trees, off indoors or in neutral moments. Change effect only when the scene or weather actually changes.`,
    ];
    if (st.outfit.char) {
        lines.push(`The character is currently wearing "${st.outfit.char}". Only use a different outfit ID when the story has actually changed what they are wearing; never change an outfit just because the mood shifted.`);
    } else {
        lines.push('outfit: a 1-2 word description of what the character is wearing (lowercase, hyphens for spaces). Keep it consistent between replies unless the story changes their clothes.');
    }
    lines.push('Optional bggen: when the location changes to something visually striking, you may add bggen=a short English image prompt describing ONLY the environment, no characters (example: bggen=misty forest glade at dawn, pale sun rays through ancient trees). Use bggen sparingly — only when the place genuinely changes; otherwise just use background=ID.');
    lines.push('Pick whichever IDs best match the character\'s emotion and the current setting. The tag must be the last line of the reply.]');
    return lines.join(' ');
}

// ===================================================================
// 5. RELATIONSHIP JUDGE  (port of rp relationshipAssist.assessRelationshipMoment)
// ===================================================================

const clamp2 = v => ([-2, -1, 0, 1, 2].includes(v) ? v : 0);

function buildJudgePrompt(st, transcript, charName, userName, intentLine) {
    const flags = st.flags.length ? st.flags.join(', ') : 'none yet';
    const plans = st.plans.length ? st.plans.map(p => p.text).join(' | ') : 'none';
    const beliefs = st.beliefs.length ? st.beliefs.map(b => b.text).join(' | ') : 'none';
    const expectations = st.expectations.length ? st.expectations.map(e => e.text).join(' | ') : 'none';
    const facts = st.facts.length ? st.facts.map((f, i) => `[${i}] ${f.text}${f.unresolved ? ' (unresolved)' : ''}`).join('\n') : 'none';
    const clothes = who => {
        const worn = CLOTHING_LAYERS.filter(l => st.clothing[who][l]);
        return worn.length === CLOTHING_LAYERS.length ? 'fully dressed' : (worn.length ? worn.join(', ') + ' still worn' : 'undressed');
    };
    const intimacy = st.arousal.value >= 15 || Object.values(st.clothing.char).some(x => !x)
        ? `\nCurrent physical state — ${charName}: ${clothes('char')}; ${userName}: ${clothes('user')}. Arousal: ${st.arousal.value}/100 (${arousalBand(st.arousal.value)}). In contact: ${st.contact.length ? st.contact.join(', ') : 'nothing yet'}.`
        : '';
    return [
        'You are a relationship engine scoring one turn of a roleplay between ' + userName + ' (the user\'s character) and ' + charName + '.',
        'Read past the surface: weigh what ' + charName + ' actually felt about this exchange, not what politeness would reward.',
        'Return ONLY a minified JSON object, no markdown fences, no commentary:',
        '{"deltas":{"affection":0,"trust":0,"chemistry":0,"comfort":0,"respect":0,"curiosity":0,"tension":0},"newFlags":[],"reason":"<short>","newFacts":[{"text":"...","importance":0.5,"valence":0.2,"unresolved":false}],"resolvedFactIndices":[],"mood":"one of ' + MOOD_VOCAB.join('/') + '","currentNeed":"one of ' + NEEDS.join('/') + '","characterIntent":"<short>","currentDesire":"<short>","currentFear":"<short>","planUpdates":[{"action":"add|drop|resolve","index":0,"text":"for add only"}],"beliefUpdates":[],"expectationUpdates":[]' +
        ',"intimacyObservation":{"engagement":"engaged|stalled|drifted","intensityDelta":-1|0|1|2,"clothingRemoved":[{"who":"char|user","layer":"outerwear|top|bottoms|underwear|shoes"}],"regionsTouched":["' + BODY_REGIONS.join('","') + '"],"stageCompleteSignalled":false}}',
        'Rules: every delta is one integer from -2 to 2. Most turns move only one or two dimensions by 1 and add no flags. newFlags may only use: ' + ALLOWED_FLAGS.join(', ') + '. ' + intentLine,
        'Current state — warmth dimensions: ' + DELTA_KEYS.map(k => `${k}=${st.dims[k]}`).join(', ') + '. Flags: ' + flags + '.',
        `${charName}'s plans: ${plans}. ${charName}'s beliefs about ${userName}: ${beliefs}. ${userName}'s expectations: ${expectations}.`,
        'Known facts:\n' + facts + intimacy,
        'Transcript (oldest first):\n' + transcript,
        'JSON:',
    ].filter(Boolean).join('\n');
}

const NEEDS = NEED_VOCAB;

function parseLenientJson(raw) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    let s = raw.slice(start, end + 1)
        .replace(/[\u201c\u201d]/g, '"')
        .replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(s); } catch { return null; }
}

const API_CONNECT_BUTTONS = {
    openai: '#api_button_openai',
    novel: '#api_button_novel',
    textgenerationwebui: '#api_button_textgenerationwebui',
};

/**
 * generateQuietPrompt silently resolves empty when online_status is
 * 'no_connection' (core Generate returns Promise.resolve() without even a
 * fetch), so every aux call must pre-check and try to reconnect via the
 * panel's own Connect button first.
 */
async function ensureApiConnected() {
    const ctx = getContext();
    if (ctx.onlineStatus && ctx.onlineStatus !== 'no_connection') return true;
    const mainApi = document.querySelector('#main_api')?.value;
    const btnSel = API_CONNECT_BUTTONS[mainApi] ?? '#api_button_openai';
    const btn = document.querySelector(btnSel);
    if (!btn) return false;
    console.info('VN Theatre: API is not connected — pressing', btnSel);
    btn.click();
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1000));
        const st = getContext().onlineStatus;
        if (st && st !== 'no_connection') {
            toastr.success(`API connected (${st})`, 'VN Theatre');
            return true;
        }
    }
    return false;
}

async function requireApi() {
    if (await ensureApiConnected()) return;
    throw new Error('chat API is not connected — open the API panel and press Connect');
}

/**
 * generateQuietPrompt runs the full Generate pipeline — character card,
 * persona, world info and the user's system preset — so a JSON-only
 * instruction drowns in roleplay directives and the model answers in
 * character instead. generateRaw sends only our own messages.
 */
const JSON_ONLY_SYSTEM =
    'You are a JSON data pipeline for a roleplay companion app. Ignore any roleplay, style or formatting instructions: reply with exactly one JSON value (object or array, as requested) and absolutely nothing else — no prose, no markdown fences, no commentary.';
// used by composeUserReply: the aux LLM writes the player's reply as plain prose
const PLAYER_REPLY_SYSTEM =
    'You write roleplay replies for the human player, in first person. Reply with ONLY the reply text itself — no quotes around it, no name prefix, no narration or dialogue for other characters, no markdown, no commentary.';

let judgeBusy = false;

async function runJudge(mesId) {
    const s = getSettings();
    if (!s.judge || judgeBusy) return;
    const ctx = getContext();
    const chat = ctx.chat ?? [];
    // need at least one user + one ai message
    let lastUser = -1, lastAi = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (lastAi === -1 && !chat[i].is_user && !chat[i].is_system) lastAi = i;
        else if (lastUser === -1 && chat[i].is_user) lastUser = i;
        if (lastUser !== -1 && lastAi !== -1) break;
    }
    if (lastUser === -1 || lastAi === -1 || lastAi !== mesId) return;

    const st = getState();
    if (st.judgedMesId === lastAi) return; // regen guard, like rp relationshipJudged

    const charName = ctx.name2 || 'the character';
    const userName = ctx.name1 || 'the user';
    const from = Math.max(0, chat.length - 8);
    const transcript = chat.slice(from).map(m =>
        `${m.is_user ? userName : (m.name || charName)}: ${stripSceneTags(m.mes).slice(0, 600)}`).join('\n');
    const armedDesc = armedIntentDesc();
    const armed = armedDesc
        ? `The player tagged their latest line as ${armedDesc}. Weigh ${charName}'s honest reaction to that; do not just reward the attempt.`
        : 'No intent tag on the latest line.';

    judgeBusy = true;
    setAssistStatus('Reading the relationship...');
    try {
        await requireApi();
        const raw = await ctx.generateRaw({
            prompt: buildJudgePrompt(st, transcript, charName, userName, armed),
            systemPrompt: JSON_ONLY_SYSTEM,
        });
        if (!String(raw ?? '').trim()) throw new Error('empty reply — connect the chat API first');
        const parsed = parseLenientJson(String(raw ?? ''));
        if (!parsed) throw new Error('judge returned no JSON');
        applyJudgePayload(parsed, { mesId: lastAi, scale: DIFFICULTY_SCALE[s.difficulty] ?? 1 });
        s.judgeFailed = false;
    } catch (e) {
        if (!s.judgeFailed) {
            s.judgeFailed = true;
            toastr.warning(`Relationship judge failed (${String(e).slice(0, 120)}) — will retry on next reply`, 'VN Theatre');
        }
    } finally {
        judgeBusy = false;
        setAssistStatus('');
        persistState();
        renderDrawer();
        refresh();
    }
}

// exposed for tests / manual correction
function applyJudgePayload(parsed, { mesId = -1, scale = 1 } = {}) {
    const st = getState();
    const d = (parsed.deltas && typeof parsed.deltas === 'object') ? parsed.deltas : {};
    for (const k of DELTA_KEYS) {
        st.dims[k] = Math.max(0, Math.min(100, st.dims[k] + Math.round(clamp2(Number(d[k]) | 0) * scale)));
    }
    if (Array.isArray(parsed.newFlags)) {
        for (const f of parsed.newFlags) {
            if (typeof f === 'string' && ALLOWED_FLAGS.includes(f) && !st.flags.includes(f)) st.flags.push(f);
        }
    }
    if (typeof parsed.mood === 'string' && MOOD_VOCAB.includes(parsed.mood)) st.mood = parsed.mood;
    if (typeof parsed.currentNeed === 'string' && NEED_VOCAB.includes(parsed.currentNeed)) st.need = parsed.currentNeed;
    const clampText = t => String(t ?? '').slice(0, 120);
    if (typeof parsed.characterIntent === 'string') st.intent = clampText(parsed.characterIntent);
    if (typeof parsed.currentDesire === 'string') st.desire = clampText(parsed.currentDesire);
    if (typeof parsed.currentFear === 'string') st.fear = clampText(parsed.currentFear);

    // facts
    if (Array.isArray(parsed.newFacts)) {
        for (const f of parsed.newFacts.slice(0, 4)) {
            if (f && typeof f.text === 'string' && f.text.trim()) {
                st.facts.push({ text: clampText(f.text), importance: Math.max(0, Math.min(1, Number(f.importance) || 0.5)), valence: Math.max(-1, Math.min(1, Number(f.valence) || 0)), unresolved: !!f.unresolved });
            }
        }
    }
    if (Array.isArray(parsed.resolvedFactIndices)) {
        for (const i of parsed.resolvedFactIndices) {
            const f = st.facts[Number(i)];
            if (f) f.unresolved = false;
        }
    }
    if (st.facts.length > 30) st.facts = st.facts.filter(f => f.unresolved).concat(st.facts.filter(f => !f.unresolved)).slice(-30);

    // plans / beliefs / expectations: {action, index, text}
    const applyUpdates = (updates, list, cap) => {
        if (!Array.isArray(updates)) return list;
        for (const u of updates) {
            if (!u || typeof u !== 'object') continue;
            const idx = Number(u.index);
            if (u.action === 'add' && typeof u.text === 'string' && u.text.trim()) {
                if (!list.some(x => x.text === u.text.trim())) list.push({ text: clampText(u.text), formedTurn: chatLengthSafe() });
            } else if ((u.action === 'drop' || u.action === 'resolve') && Number.isInteger(idx) && list[idx]) {
                list.splice(idx, 1);
            }
        }
        return list.slice(-cap);
    };
    st.plans = applyUpdates(parsed.planUpdates, st.plans, 3);
    st.beliefs = applyUpdates(parsed.beliefUpdates, st.beliefs, 5);
    st.expectations = applyUpdates(parsed.expectationUpdates, st.expectations, 5);

    // intimacy observation
    const io = parsed.intimacyObservation;
    if (io && typeof io === 'object') {
        const bump = { 0: 4, 1: 9, 2: 18, '-1': -8 }[Number(io.intensityDelta) | 0] ?? 0;
        const engagement = io.engagement;
        if (engagement === 'drifted') st.arousal.value = Math.max(0, st.arousal.value - 10);
        else st.arousal.value = Math.max(0, Math.min(100, st.arousal.value + bump));
        st.arousal.phase = st.arousal.value >= 70 ? 'peak' : 'building';
        st.arousal.lastTurn = Date.now();
        if (Array.isArray(io.clothingRemoved)) {
            for (const c of io.clothingRemoved) {
                const who = c?.who === 'user' ? 'user' : 'char';
                const layer = String(c?.layer ?? '');
                if (CLOTHING_LAYERS.includes(layer)) st.clothing[who][layer] = false;
            }
        }
        if (Array.isArray(io.regionsTouched)) {
            for (const r of io.regionsTouched) {
                if (BODY_REGIONS.includes(r) && !st.contact.includes(r)) st.contact.push(r);
            }
        }
    } else if (st.arousal.value > 0) {
        // no intimate content this turn: slow decay
        st.arousal.value = Math.max(0, st.arousal.value - 10);
        if (st.arousal.value === 0) { st.contact = []; }
    }
    st.judgedMesId = mesId;
    persistState();
}

function chatLengthSafe() {
    try { return getContext().chat?.length ?? 0; } catch { return 0; }
}

// ===================================================================
// 6. PROMPT INJECTIONS ([SCENE STATE] block + scene instruction)
// ===================================================================

function clothingLine(who, label) {
    const st = getState();
    const worn = CLOTHING_LAYERS.filter(l => st.clothing[who][l]);
    const desc = worn.length === CLOTHING_LAYERS.length ? 'fully dressed'
        : worn.length ? worn.join(', ') + ' still worn' : 'undressed';
    return `${label}: ${desc}`;
}

function sceneStateBlock() {
    const st = getState();
    const ctx = getContext();
    const charName = ctx.name2 || 'the character';
    const userName = ctx.name1 || 'the user';
    const lines = [];
    if (st.scene.background || st.scene.mood) {
        lines.push(`Location: ${st.scene.background || 'unspecified'}${st.scene.mood ? `, mood: ${st.scene.mood}` : ''}`);
    }
    if (st.outfit.char || st.outfit.user) {
        lines.push(`Outfit — ${st.outfit.char ? `${charName} is wearing ${st.outfit.char}` : ''}${st.outfit.char && st.outfit.user ? '; ' : ''}${st.outfit.user ? `${userName} is wearing ${st.outfit.user}` : ''}`);
    }
    const charClothes = clothingLine('char', charName);
    const intimate = st.arousal.value >= 15 || !CLOTHING_LAYERS.every(l => st.clothing.char[l]);
    if (intimate) {
        lines.push(`Physically — ${charClothes}; ${clothingLine('user', userName)}`);
        if (st.arousal.value >= 15) lines.push(`${charName}'s arousal: ${st.arousal.value}/100 (${arousalBand(st.arousal.value)})`);
        if (st.contact.length) lines.push(`In contact: ${st.contact.join(', ')}`);
    }
    if (st.mood) lines.push(`${charName}'s mood right now: ${st.mood}${st.need ? `; underlying need: ${st.need}` : ''}`);
    if (st.plans.length) lines.push(`${charName}'s current plans: ${st.plans.map(p => p.text).join('; ')}`);
    const threads = st.facts.filter(f => f.unresolved).slice(-3);
    if (threads.length) lines.push(`Open threads: ${threads.map(f => f.text).join('; ')}`);
    if (!lines.length) return '';
    lines.push('These are the current facts of the scene. Do not contradict them, and do not re-describe something they mark as already done.');
    return `[Scene facts]\n${lines.join('\n')}`;
}

function updatePromptInjections() {
    const ctx = getContext();
    if (typeof ctx.setExtensionPrompt !== 'function') return;
    const s = getSettings();
    const role = 0, depth = 4;
    if (s.enabled && s.instruct) {
        ctx.setExtensionPrompt('vnt_scene', sceneInstruction(), extension_prompt_types.IN_PROMPT, depth, false, role);
    } else {
        ctx.setExtensionPrompt('vnt_scene', '', extension_prompt_types.IN_PROMPT, depth, false, role);
    }
    // scene facts sit closer to the reply than the tag instruction
    const armedDesc = armedIntentDesc();
    const armed = armedDesc
        ? `\nThe player tagged their latest line as ${armedDesc}. Weigh it honestly; do not just reward the attempt.` : '';
    const block = sceneStateBlock();
    const stateText = (block || armed)
        ? `${block ? block + '\n' : ''}${armed}`.trim()
        : '';
    ctx.setExtensionPrompt('vnt_state', s.enabled ? stateText : '', extension_prompt_types.IN_PROMPT, 2, false, role);
}

// ===================================================================
// 7. DOM HELPERS
// ===================================================================

function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h;
}

function placeholderGradient(key) {
    const H = hash(key || 'night') % 360;
    return `linear-gradient(160deg, hsl(${H} 45% 22%), hsl(${(H + 40) % 360} 35% 10%))`;
}

function bgUrl(key) {
    const s = getSettings();
    for (const line of (s.customBgs || '').split('\n')) {
        const [name, url] = line.split('=').map(x => x?.trim());
        if (name && url && name.trim().toLowerCase() === key) return url;
    }
    return '';
}

// ===================================================================
// 8. VN OVERLAY (stage, sprite, dialog, petals)
// ===================================================================

let ui = null;
let bgFlip = false;
let spriteFlip = false;
let typeTimer = null;
let effectRAF = null;

function buildOverlay() {
    ui = el('div');
    ui.id = 'vn-theatre';
    ui.classList.add('vnt-hidden');
    ui.innerHTML = `
        <div class="vnt-bg">
            <div class="vnt-bg-a"></div><div class="vnt-bg-b"></div>
            <div class="vnt-shade"></div>
            <canvas class="vnt-petals"></canvas>
        </div>
        <div class="vnt-sprite"><img class="vnt-sprite-a" alt=""><img class="vnt-sprite-b" alt=""></div>
        <div class="vnt-topbar">
            <button class="vnt-btn vnt-act-backlog" title="Backlog"><i class="fa-solid fa-clock-rotate-left"></i></button>
            <button class="vnt-btn vnt-act-state" title="Relationship & scene state"><i class="fa-solid fa-heart-circle-check"></i></button>
            <button class="vnt-btn vnt-act-image" title="Generate scene image (ComfyUI)"><i class="fa-solid fa-image"></i></button>
            <button class="vnt-btn vnt-act-effect" title="Effects"><i class="fa-solid fa-seedling"></i></button>
            <button class="vnt-btn vnt-act-translate" title="Translate last reply"><i class="fa-solid fa-language"></i></button>
            <button class="vnt-btn vnt-act-close" title="Exit VN mode"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="vnt-backlog vnt-hidden">
            <div class="vnt-backlog-head">
                <button class="vnt-btn vnt-bl-close" title="Close backlog"><i class="fa-solid fa-xmark"></i></button>
                <span>Backlog</span>
            </div>
            <div class="vnt-backlog-list"></div>
        </div>
        <div class="vnt-dialog">
            <div class="vnt-namerow"><img class="vnt-chip" alt=""><div class="vnt-nametext"><div class="vnt-name"></div><div class="vnt-subname"></div></div></div>
            <div class="vnt-text"></div>
            <div class="vnt-translation"></div>
            <div class="vnt-composer">
                <div class="vnt-chips"></div>
                <div class="vnt-inputrow">
                    <textarea class="vnt-input" rows="1" placeholder="Type your reply..."></textarea>
                    <button class="vnt-btn vnt-send" title="Send"><i class="fa-solid fa-paper-plane"></i></button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(ui);

    ui.querySelector('.vnt-act-close').addEventListener('click', () => setEnabled(false));
    ui.querySelector('.vnt-act-effect').addEventListener('click', () => cycleEffect());
    ui.querySelector('.vnt-act-image').addEventListener('click', () => generateSceneImage());
    ui.querySelector('.vnt-act-backlog').addEventListener('click', () => {
        ui.querySelector('.vnt-backlog').classList.toggle('vnt-hidden');
        renderBacklog();
    });
    ui.querySelector('.vnt-bl-close').addEventListener('click', () => {
        ui.querySelector('.vnt-backlog').classList.add('vnt-hidden');
    });
    ui.querySelector('.vnt-act-state').addEventListener('click', () => toggleDrawer());
    ui.querySelector('.vnt-act-translate').addEventListener('click', async () => {
        const mes = lastAiMessage();
        if (!mes) return;
        // already translated: the button switches original / translation
        if (cachedTranslation(mes.id)) { vntToggleOriginal = !vntToggleOriginal; refresh(); return; }
        showFxPill('VN Theatre: translating…');
        try {
            await translateMessage(mes.id);
            vntToggleOriginal = false;
        } catch (e) {
            toastr.error(String(e).slice(0, 120), 'VN Theatre');
        } finally {
            hideFxPill();
            refresh();
        }
    });
    // composer
    const input = ui.querySelector('.vnt-input');
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFromOverlay(); }
    });
    ui.querySelector('.vnt-send').addEventListener('click', () => sendFromOverlay());
    renderChips(ui.querySelector('.vnt-chips'));
}

function sendFromOverlay() {
    const input = ui.querySelector('.vnt-input');
    const text = (input.value ?? '').trim();
    if (!text) return;
    input.value = '';
    const ta = document.querySelector('#send_textarea');
    if (!ta) return;
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#send_but')?.click();
}

function setEnabled(on) {
    const s = getSettings();
    s.enabled = on;
    saveSettingsDebounced();
    if (!ui) buildOverlay();
    ui.classList.toggle('vnt-hidden', !on);
    updatePromptInjections();
    if (on) {
        syncViewportHeight();
        refresh();
        if (s.effect !== 'off') startEffect();
        updateEffectButton();
    } else {
        stopEffect();
        stopTypewriter();
    }
}

function overlayVisible() {
    return ui && !ui.classList.contains('vnt-hidden');
}

// Real browsers lie about vh/dvh when the URL bar / keyboard resize the page:
// the visible viewport can be smaller than 100dvh, pushing bottom-anchored UI
// off-screen. Pin the overlay and drawer to the actual visual viewport in px.
function syncViewportHeight() {
    const vv = window.visualViewport;
    const h = Math.round(vv ? vv.height : window.innerHeight);
    const top = Math.round(vv ? vv.offsetTop : 0);
    for (const node of [ui, drawer]) {
        if (!node) continue;
        node.style.height = `${h}px`;
        node.style.top = `${top}px`;
    }
}

function bindViewportSync() {
    window.addEventListener('resize', syncViewportHeight);
    window.addEventListener('orientationchange', syncViewportHeight);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', syncViewportHeight);
        window.visualViewport.addEventListener('scroll', syncViewportHeight);
    }
}

function lastAiMessage() {
    const chat = getContext().chat ?? [];
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user && !chat[i].is_system) return { mes: chat[i], id: i };
    }
    return null;
}

// quote hygiene for everything the VN dialog paints: straight double quotes
// everywhere — collapse doubled/tripled runs, drop escape backslashes and
// unify guillemets/curly quotes (« » “ ” „) so dialogue quotes look uniform
function fixQuoteRuns(s) {
    return String(s ?? '')
        .replace(/\\+(?=["'])/g, '')
        .replace(/[«»“”„]/g, '"')
        .replace(/"{2,}/g, '"');
}

function cachedTranslation(id) {
    const s = getSettings();
    return fixQuoteRuns(s.cache[chatKey()]?.[String(id)]?.t ?? '');
}

function setSprite(url) {
    const a = ui.querySelector('.vnt-sprite-a');
    const b = ui.querySelector('.vnt-sprite-b');
    const chip = ui.querySelector('.vnt-chip');
    if (!url) {
        a.removeAttribute('src'); b.removeAttribute('src');
        chip.removeAttribute('src');
        return;
    }
    const probe = new Image();
    probe.onload = () => {
        if (probe.naturalWidth >= 256 && probe.naturalHeight >= 256) {
            const front = spriteFlip ? a : b;
            const back = spriteFlip ? b : a;
            if (front.getAttribute('src') === url) { chip.src = url; return; }
            back.onload = () => {
                back.classList.add('vnt-in');
                front.classList.remove('vnt-in');
                spriteFlip = !spriteFlip;
            };
            back.src = url;
            ui.querySelector('.vnt-sprite').classList.remove('vnt-chip-mode');
        } else {
            a.classList.remove('vnt-in');
            b.classList.remove('vnt-in');
            ui.querySelector('.vnt-sprite').classList.add('vnt-chip-mode');
        }
        chip.src = url;
    };
    probe.src = url;
}

function exprFilter(expr) {
    switch (expr) {
        case 'happy': case 'love': return 'brightness(1.08) saturate(1.1)';
        case 'angry': return 'brightness(0.92) saturate(1.35) hue-rotate(-12deg)';
        case 'shy': return 'brightness(1.02) sepia(0.14) hue-rotate(-18deg)';
        case 'sad': return 'brightness(0.85) saturate(0.8)';
        case 'sleepy': return 'brightness(0.9) saturate(0.85) blur(0.4px)';
        default: return '';
    }
}

function setBackground(key) {
    const a = ui.querySelector('.vnt-bg-a');
    const b = ui.querySelector('.vnt-bg-b');
    const front = bgFlip ? a : b;
    const back = bgFlip ? b : a;
    // a ComfyUI-generated background pins over the gradient/custom map
    const pinned = imgSettings().bgMap?.[chatKey()]?.url ?? '';
    const url = pinned || bgUrl(key || '');
    const style = url
        ? `background-image:url('${url}')`
        : `background-image:${placeholderGradient(key || 'night')}`;
    if (front.getAttribute('style') === style) return;
    back.setAttribute('style', style);
    back.classList.add('vnt-in');
    front.classList.remove('vnt-in');
    bgFlip = !bgFlip;
}

function typewrite(target, text) {
    stopTypewriter();
    if (!getSettings().typewriter) {
        target.textContent = text;
        return;
    }
    let i = 0;
    typeTimer = setInterval(() => {
        i += 2;
        target.textContent = text.slice(0, i);
        if (i >= text.length) stopTypewriter();
    }, 18);
}

function stopTypewriter() {
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
}

function styleSfx(container) {
    if (!getSettings().sfx) return;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const hits = [];
    while (walker.nextNode()) {
        const n = walker.currentNode;
        if (n.nodeValue && /\b[A-Z]{3,9}\b/.test(n.nodeValue) && n.parentElement?.tagName !== 'SPAN') hits.push(n);
    }
    for (const n of hits) {
        const frag = document.createDocumentFragment();
        let last = 0;
        const s = n.nodeValue;
        for (const m of s.matchAll(/\b[A-Z]{3,9}\b/g)) {
            if (m.index > last) frag.append(s.slice(last, m.index));
            const span = el('span', 'vnt-sfx', esc(m[0]));
            frag.append(span);
            last = m.index + m[0].length;
        }
        if (last < s.length) frag.append(s.slice(last));
        n.replaceWith(frag);
    }
}

// translation replaces the original in the VN dialog; false = original shown
let vntToggleOriginal = false;
let vntPaintedMesId = -1;

function refresh() {
    if (!ui) return;
    const ctx = getContext();
    const s = getSettings();
    const img = imgSettings();
    const last = lastAiMessage();
    const char = ctx.characters?.[ctx.characterId];
    const chName = ctx.groupId ? (last?.mes?.name ?? ctx.name2) : (char?.name ?? ctx.name2);

    let avatarUrl = '';
    if (ctx.groupId && last?.mes?.force_avatar) {
        avatarUrl = last.mes.force_avatar;
    } else if (char?.avatar) {
        avatarUrl = `/thumbnail?type=avatar&file=${encodeURIComponent(char.avatar)}`;
    }
    // generated media attached to the message wins: character shots become the
    // stage sprite, background shots pin the VN background via bgMap
    const mediaList = Array.isArray(last?.mes?.extra?.media) ? last.mes.extra.media : [];
    const mediaImage = mediaList.find(m => String(m?.type ?? '').toLowerCase() === 'image' && m?.url);
    let spriteUrl = avatarUrl;
    if (mediaImage && /character/i.test(String(mediaImage.title ?? ''))) spriteUrl = mediaImage.url;
    setSprite(spriteUrl);

    const st = getState();
    if (last) {
        const scene = parseSceneTag(last.mes.mes);
        const expr = scene.expression || 'neutral';
        const text = stripSceneTags(last.mes.mes);
        const filter = exprFilter(expr);
        const stageImg = ui.querySelector('.vnt-sprite img.vnt-in') ?? ui.querySelector('.vnt-sprite img');
        stageImg.style.filter = filter;
        ui.querySelector('.vnt-chip').style.filter = filter;
        ui.querySelector('.vnt-name').textContent = last.mes.name || chName || '...';
        const sub = ui.querySelector('.vnt-subname');
        const outfit = scene.outfit || st.outfit.char;
        const mood = scene.mood || st.scene.mood;
        sub.textContent = [outfit ? `wearing ${outfit}` : '', mood ? `mood: ${mood}` : ''].filter(Boolean).join(' · ');
        sub.style.display = sub.textContent ? '' : 'none';

        const tEl = ui.querySelector('.vnt-text');
        const tr = cachedTranslation(last.id);
        // VN mode: the translation replaces the original inside the dialog
        // box; the language button toggles back to the original
        if (vntPaintedMesId !== last.id) { vntToggleOriginal = false; vntPaintedMesId = last.id; }
        const showOriginal = vntToggleOriginal || !tr;
        const body = fixQuoteRuns(showOriginal ? text : tr);
        // markdown (bold/italic) and HTML must be rendered, not shown raw:
        // typewriter only for pure prose without any markup markers
        const hasMarkup = /[<>]|[*_`~]/.test(body);
        if (hasMarkup || !s.typewriter) {
            stopTypewriter();
            tEl.innerHTML = messageFormatting(body, last.mes.name || chName || '', false, false, false);
            tEl.scrollTop = tEl.scrollHeight;
        } else {
            typewrite(tEl, body);
        }
        styleSfx(tEl);
        // the separate translation strip under the text is retired — the
        // translation now lives in the dialog box itself
        const trEl = ui.querySelector('.vnt-translation');
        trEl.style.display = 'none';
        const trBtn = ui.querySelector('.vnt-act-translate');
        if (trBtn) trBtn.title = tr ? 'Switch original / translation' : 'Translate last reply';
        if (scene.background) setBackground(scene.background);
        else if (!st.scene.background) setBackground('night');
        else setBackground(st.scene.background);
        // remember scene in state
        let sceneChanged = false;
        if (scene.background && scene.background !== st.scene.background) { st.scene.background = scene.background; sceneChanged = true; }
        if (scene.mood && scene.mood !== st.scene.mood) { st.scene.mood = scene.mood; sceneChanged = true; }
        if (scene.outfit && scene.outfit !== st.outfit.char) { st.outfit.char = scene.outfit; sceneChanged = true; }
        if (sceneChanged) { persistState(); }
        // AI-driven ambience: the model's tag switches the particle effect...
        if (scene.effect && EFFECT_PRESETS.includes(scene.effect) && scene.effect !== s.effect) {
            s.effect = scene.effect;
            saveSettingsDebounced();
            if (overlayVisible() && s.effect !== 'off') startEffect(); else stopEffect();
            updateEffectButton();
            const sel = document.querySelector('#vnt-set-effect');
            if (sel) sel.value = s.effect;
        }
        // ...and can request a generated background via bggen= (cooldown-guarded)
        if (scene.bggen && img.enabled && img.autoFromTag) maybeAutoBackground(scene.bggen);
    }
}

// auto-generate a VN background from the model's bggen= tag; guarded by a
// cooldown + same-prompt check so a burst of replies can't queue generations
const AUTO_BG_COOLDOWN_MS = 90000;

function maybeAutoBackground(prompt) {
    const img = imgSettings();
    const now = Date.now();
    if (imageBusy) return;
    if (now - (img.lastAutoBgAt ?? 0) < AUTO_BG_COOLDOWN_MS) return;
    if (prompt === img.lastAutoBgPrompt && img.bgMap?.[chatKey()]?.url) return;
    img.lastAutoBgAt = now;
    img.lastAutoBgPrompt = prompt;
    saveSettingsDebounced();
    generateSceneImage({ type: 'background', ratio: getScreenRatio(), prompt, negative: img.negativePrompt });
}

function renderBacklog() {
    const list = ui.querySelector('.vnt-backlog-list');
    list.innerHTML = '';
    const chat = getContext().chat ?? [];
    const ctx = getContext();
    const from = Math.max(0, chat.length - 30);
    for (let i = from; i < chat.length; i++) {
        const m = chat[i];
        if (m.is_system) continue;
        const row = el('div', 'vnt-backlog-row' + (m.is_user ? ' vnt-user' : ''));
        const name = m.is_user ? (m.name || ctx.name1) : (m.name || ctx.name2);
        row.appendChild(el('div', 'vnt-backlog-name', esc(name)));
        const textEl = el('div', 'vnt-backlog-text');
        textEl.innerHTML = messageFormatting(stripSceneTags(m.mes), name, false, false, m.is_user);
        row.appendChild(textEl);
        const tr = cachedTranslation(i);
        if (tr) row.appendChild(el('div', 'vnt-backlog-tr', esc(tr)));
        list.appendChild(row);
    }
    list.scrollTop = list.scrollHeight;
}

// ------------------------------------------------- ambient effects (10 presets)

const EFFECT_PRESETS = ['sakura', 'snow', 'rain', 'fireflies', 'stars', 'embers', 'leaves', 'bubbles', 'hearts'];
const EFFECT_ICONS = {
    sakura: 'fa-seedling', snow: 'fa-snowflake', rain: 'fa-cloud-rain',
    fireflies: 'fa-moon', stars: 'fa-star', embers: 'fa-fire',
    leaves: 'fa-leaf', bubbles: 'fa-droplet', hearts: 'fa-heart', off: 'fa-ban',
};
const EFFECT_COUNTS = { sakura: 34, snow: 60, rain: 110, fireflies: 24, stars: 80, embers: 44, leaves: 22, bubbles: 26, hearts: 18 };

function spawnParticle(kind, W, H) {
    const rnd = (a, b) => a + Math.random() * (b - a);
    const p = { x: Math.random() * W, y: Math.random() * H, phase: Math.random() * Math.PI * 2, size: 4 };
    switch (kind) {
        case 'sakura':
            p.size = rnd(4, 11); p.vy = rnd(0.4, 1.3); p.spin = rnd(0.01, 0.04);
            p.color = `rgba(255,${Math.round(rnd(160, 200))},${Math.round(rnd(185, 220))},${rnd(0.4, 0.7).toFixed(2)})`;
            break;
        case 'snow':
            p.size = rnd(1, 3.4); p.vy = rnd(0.25, 1.0); p.spin = rnd(0.01, 0.04); p.drift = rnd(0.2, 0.7);
            p.color = `rgba(255,255,255,${rnd(0.35, 0.85).toFixed(2)})`;
            break;
        case 'rain':
            p.size = rnd(9, 18); p.vy = rnd(7, 13); p.vx = -1.4;
            p.color = `rgba(174,203,255,${rnd(0.2, 0.4).toFixed(2)})`;
            break;
        case 'fireflies':
            p.size = rnd(1.2, 2.6); p.vx = rnd(-0.4, 0.4); p.vy = rnd(-0.25, 0.25); p.spin = rnd(0.01, 0.05);
            break;
        case 'stars':
            p.size = rnd(0.6, 1.8); p.speed = rnd(0.4, 1.6); p.spin = rnd(0.01, 0.05);
            break;
        case 'embers':
            p.size = rnd(1, 2.8); p.vy = -rnd(0.5, 1.9); p.spin = rnd(0.03, 0.1);
            p.color = `rgba(255,${Math.round(rnd(90, 160))},40,${rnd(0.4, 0.9).toFixed(2)})`;
            break;
        case 'leaves':
            p.size = rnd(5, 10); p.vy = rnd(0.5, 1.6); p.spin = rnd(0.02, 0.06);
            p.color = Math.random() < 0.5
                ? `rgba(214,140,50,${rnd(0.4, 0.75).toFixed(2)})`
                : `rgba(176,122,40,${rnd(0.4, 0.75).toFixed(2)})`;
            break;
        case 'bubbles':
            p.size = rnd(3, 10); p.vy = -rnd(0.25, 0.8); p.spin = rnd(0.01, 0.05); p.drift = rnd(0.2, 0.6);
            p.color = `rgba(190,230,255,${rnd(0.2, 0.45).toFixed(2)})`;
            break;
        case 'hearts':
            p.size = rnd(4, 9); p.vy = rnd(0.35, 1.1); p.spin = rnd(0.01, 0.035);
            p.color = `rgba(255,${Math.round(rnd(90, 140))},${Math.round(rnd(130, 170))},${rnd(0.4, 0.7).toFixed(2)})`;
            break;
        default:
            p.size = 4; p.vy = 0.6; p.spin = 0.02; p.color = 'rgba(255,255,255,0.5)';
    }
    return p;
}

function heartPath(c, s) {
    c.beginPath();
    c.moveTo(0, s * 0.3);
    c.bezierCurveTo(s * 0.9, -s * 0.5, s * 2.1, s * 0.5, 0, s * 1.5);
    c.bezierCurveTo(-s * 2.1, s * 0.5, -s * 0.9, -s * 0.5, 0, s * 0.3);
    c.closePath();
}

function stepParticle(p, kind, W, H) {
    p.phase += p.spin;
    switch (kind) {
        case 'stars':
            break; // fixed position, twinkle only
        case 'fireflies':
            p.x += p.vx + Math.sin(p.phase) * 0.35;
            p.y += p.vy + Math.cos(p.phase * 0.8) * 0.3;
            if (p.x < -8) p.x = W + 8; else if (p.x > W + 8) p.x = -8;
            if (p.y < -8) p.y = H + 8; else if (p.y > H + 8) p.y = -8;
            return;
        case 'embers':
            p.x += Math.sin(p.phase) * 0.5;
            p.y += p.vy;
            if (p.y < -10) { p.y = H + 10; p.x = Math.random() * W; }
            return;
        case 'bubbles':
            p.x += Math.sin(p.phase) * p.drift;
            p.y += p.vy;
            if (p.y < -p.size * 2) { p.y = H + p.size * 2; p.x = Math.random() * W; }
            return;
        case 'rain':
            p.y += p.vy; p.x += p.vx;
            if (p.y > H + p.size) { p.y = -p.size; p.x = Math.random() * W; }
            if (p.x < -10) p.x = W + 10;
            return;
        default:
            p.x += Math.sin(p.phase) * (kind === 'snow' ? p.drift : 0.6);
            p.y += p.vy;
            if (p.y > H + 14) { p.y = -14; p.x = Math.random() * W; }
    }
}

function drawParticle(c, p, kind) {
    switch (kind) {
        case 'sakura':
        case 'leaves':
            c.save(); c.translate(p.x, p.y); c.rotate(p.phase);
            c.fillStyle = p.color;
            c.beginPath();
            c.ellipse(0, 0, p.size, p.size * (kind === 'sakura' ? 0.55 : 0.42), 0, 0, Math.PI * 2);
            c.fill();
            c.restore();
            return;
        case 'hearts':
            c.save(); c.translate(p.x, p.y); c.rotate(Math.sin(p.phase) * 0.4);
            c.fillStyle = p.color; heartPath(c, p.size); c.fill();
            c.restore();
            return;
        case 'rain':
            c.strokeStyle = p.color; c.lineWidth = 1.1;
            c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x + p.vx * 1.6, p.y + p.size); c.stroke();
            return;
        case 'fireflies': {
            const a = 0.35 + 0.65 * Math.abs(Math.sin(p.phase * 0.7));
            const g = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 5);
            g.addColorStop(0, `rgba(224,255,160,${a.toFixed(2)})`);
            g.addColorStop(1, 'rgba(224,255,160,0)');
            c.fillStyle = g;
            c.beginPath(); c.arc(p.x, p.y, p.size * 5, 0, Math.PI * 2); c.fill();
            c.fillStyle = `rgba(240,255,200,${a.toFixed(2)})`;
            c.beginPath(); c.arc(p.x, p.y, p.size, 0, Math.PI * 2); c.fill();
            return;
        }
        case 'stars': {
            const a = 0.15 + 0.85 * Math.abs(Math.sin(p.phase * p.speed));
            c.fillStyle = `rgba(255,255,255,${a.toFixed(2)})`;
            c.beginPath(); c.arc(p.x, p.y, p.size, 0, Math.PI * 2); c.fill();
            return;
        }
        case 'bubbles':
            c.strokeStyle = p.color; c.lineWidth = 1;
            c.beginPath(); c.arc(p.x, p.y, p.size, 0, Math.PI * 2); c.stroke();
            c.fillStyle = 'rgba(255,255,255,0.25)';
            c.beginPath(); c.arc(p.x - p.size * 0.35, p.y - p.size * 0.35, p.size * 0.28, 0, Math.PI * 2); c.fill();
            return;
        case 'embers': {
            const a = 0.3 + 0.7 * Math.abs(Math.sin(p.phase * 1.4));
            c.fillStyle = p.color.replace(/[\d.]+\)$/, `${a.toFixed(2)})`);
            c.beginPath(); c.arc(p.x, p.y, p.size, 0, Math.PI * 2); c.fill();
            return;
        }
        default: // snow
            c.fillStyle = p.color;
            c.beginPath(); c.arc(p.x, p.y, p.size, 0, Math.PI * 2); c.fill();
    }
}

function startEffect() {
    if (!ui) return;
    const s = getSettings();
    if (s.effect === 'off' || !EFFECT_PRESETS.includes(s.effect)) { stopEffect(); return; }
    const canvas = ui.querySelector('.vnt-petals');
    const ctx2d = canvas.getContext('2d');
    let W = canvas.width = window.innerWidth;
    let H = canvas.height = window.innerHeight;
    const kind = s.effect;
    const parts = Array.from({ length: EFFECT_COUNTS[kind] ?? 30 }, () => spawnParticle(kind, W, H));
    function frame() {
        ctx2d.clearRect(0, 0, W, H);
        for (const p of parts) {
            stepParticle(p, kind, W, H);
            drawParticle(ctx2d, p, kind);
        }
        effectRAF = requestAnimationFrame(frame);
    }
    cancelAnimationFrame(effectRAF);
    effectRAF = requestAnimationFrame(frame);
    window.addEventListener('resize', () => { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }, { once: true });
}

function stopEffect() {
    if (effectRAF) cancelAnimationFrame(effectRAF);
    effectRAF = null;
    if (ui) {
        const c = ui.querySelector('.vnt-petals');
        c.getContext('2d').clearRect(0, 0, c.width, c.height);
    }
}

function updateEffectButton() {
    if (!ui) return;
    const btn = ui.querySelector('.vnt-act-effect');
    if (!btn) return;
    const s = getSettings();
    btn.innerHTML = `<i class="fa-solid ${EFFECT_ICONS[s.effect] ?? 'fa-seedling'}"></i>`;
    btn.title = `Effects: ${s.effect} — click to cycle`;
}

function cycleEffect() {
    const s = getSettings();
    const list = [...EFFECT_PRESETS, 'off'];
    const i = list.indexOf(s.effect);
    s.effect = list[(i + 1) % list.length] ?? 'sakura';
    saveSettingsDebounced();
    if (overlayVisible() && s.effect !== 'off') startEffect(); else stopEffect();
    updateEffectButton();
    const sel = document.querySelector('#vnt-set-effect');
    if (sel) sel.value = s.effect;
}

// ===================================================================
// 9. INTENT CHIPS + ASSIST STATUS  (rp IntentChips / AssistActivityBar)
// ===================================================================

function renderChips(host) {
    if (!host) return;
    host.innerHTML = '';
    const s = getSettings();
    // dynamic options for the current scene; static intents are the fallback
    const options = (s.chipOptions || []).length
        ? s.chipOptions
        : Object.values(INTENTS).map(spec => ({ label: spec.label, guide: spec.guide, judge: spec.judge }));
    for (const o of options) {
        const chip = el('button', 'vnt-chip-btn', esc(o.label));
        chip.title = o.guide || o.label;
        chip.addEventListener('click', () => {
            const st = getSettings();
            st.intentArm = '';
            st.intentJudgeDesc = o.judge || o.label;
            saveSettingsDebounced();
            updatePromptInjections();
            composeUserReply(o);
        });
        host.appendChild(chip);
    }
    const refresh = el('button', 'vnt-chip-btn vnt-chip-refresh', '<i class="fa-solid fa-rotate"></i>');
    refresh.title = 'New options for this scene';
    refresh.addEventListener('click', () => generateChoices());
    host.appendChild(refresh);
}

function setAssistStatus(text) {
    let bar = document.querySelector('.vnt-assist-status');
    if (!text) { bar?.remove(); return; }
    if (!bar) {
        bar = el('div', 'vnt-assist-status');
        document.body.appendChild(bar);
    }
    bar.textContent = text;
}

// ===================================================================
// 10. DYNAMIC CHIPS  (situational next-move options + player-reply composer)
// ===================================================================

async function generateChoices() {
    const s = getSettings();
    const ctx = getContext();
    const chat = ctx.chat ?? [];
    if (chat.length < 2) return;
    const charName = ctx.name2 || 'the character';
    const userName = ctx.name1 || 'the user';
    const from = Math.max(0, chat.length - 8);
    const transcript = chat.slice(from).map(m =>
        `${m.is_user ? userName : (m.name || charName)}: ${stripSceneTags(m.mes).slice(0, 500)}`).join('\n');
    const prompt = [
        'You are suggesting what a roleplay player could do next, as button options.',
        'Recent scene:', transcript,
        `Propose 4 short, distinct options for what ${userName} could say or do next. Labels stay button-sized: 1-3 words.`,
        'Output ONLY a minified JSON array of 4 objects: {"label":"1-3 words","guide":"one short sentence telling the player what this reply should say or do","judge":"intent in 2-5 words for a relationship judge"}.',
        'No markdown fences, no commentary. JSON:',
    ].join('\n');
    setAssistStatus('Thinking of options...');
    try {
        await requireApi();
        const raw = await ctx.generateRaw({
            prompt,
            systemPrompt: JSON_ONLY_SYSTEM,
        });
        if (!String(raw ?? '').trim()) throw new Error('empty reply — connect the chat API first');
        const start = String(raw).indexOf('[');
        const end = String(raw).lastIndexOf(']');
        if (start === -1 || end <= start) throw new Error('no JSON array');
        const arr = JSON.parse(String(raw).slice(start, end + 1).replace(/[\u201c\u201d]/g, '"'));
        const options = arr
            .filter(o => o && typeof o.label === 'string' && typeof o.guide === 'string')
            .slice(0, 4)
            .map(o => ({
                label: o.label.trim().slice(0, 24),
                guide: o.guide.trim(),
                judge: typeof o.judge === 'string' && o.judge.trim() ? o.judge.trim() : o.label.trim(),
            }));
        if (!options.length) throw new Error('no valid options');
        s.chipOptions = options;
        saveSettingsDebounced();
        renderChips(document.querySelector('.vnt-chips'));
    } catch (e) {
        if (!s.judgeFailed) toastr.info(`Could not generate options (${String(e).slice(0, 90)})`, 'VN Theatre');
        // keep whatever options were there before; the row stays usable
    } finally {
        setAssistStatus('');
    }
}

// a used chip: the aux LLM writes the player's full reply for that direction
// and it is sent as a normal user message
async function composeUserReply(option) {
    const ctx = getContext();
    const chat = ctx.chat ?? [];
    if (chat.length < 2) return;
    const charName = ctx.name2 || 'the character';
    const userName = ctx.name1 || 'the player';
    const from = Math.max(0, chat.length - 8);
    const transcript = chat.slice(from).map(m =>
        `${m.is_user ? userName : (m.name || charName)}: ${stripSceneTags(m.mes).slice(0, 500)}`).join('\n');
    setAssistStatus('Composing your reply...');
    try {
        await requireApi();
        const raw = await ctx.generateRaw({
            prompt: [
                `You write the next reply for the human player "${userName}" in an ongoing roleplay.`,
                'Recent scene:', transcript,
                `Direction for this reply: ${option.guide}.`,
                `Write it exactly as this player would: first person, in the same language the player has used so far (check their earlier lines), 1-3 sentences. The reply must never narrate or speak for ${charName}.`,
            ].join('\n'),
            systemPrompt: PLAYER_REPLY_SYSTEM,
        });
        let text = String(raw ?? '').trim();
        if (!text) throw new Error('empty reply — connect the chat API first');
        text = stripSceneTags(text);
        text = fixQuoteRuns(text);
        // the model may wrap the reply in quotes or prefix the player's name
        text = text.replace(/^"(.*)"$/s, '$1').trim();
        const nameRe = userName ? new RegExp('^' + userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:—-]\\s*', 'i') : null;
        if (nameRe && nameRe.test(text)) text = text.replace(nameRe, '');
        text = text.trim();
        if (!text) throw new Error('empty reply');
        sendUserText(text);
    } catch (e) {
        toastr.info(`Could not compose a reply (${String(e).slice(0, 90)})`, 'VN Theatre');
    } finally {
        setAssistStatus('');
    }
}

function sendUserText(text) {
    const ta = document.querySelector('#send_textarea');
    if (!ta) return;
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#send_but')?.click();
}

// ===================================================================
// 11. STATE DRAWER  (port of RelationshipPanel + ScenePanel + Director)
// ===================================================================

let drawer = null;

function toggleDrawer() {
    if (!drawer) buildDrawer();
    drawer.classList.toggle('vnt-hidden');
    if (!drawer.classList.contains('vnt-hidden')) {
        syncViewportHeight();
        renderDrawer();
    }
}

function buildDrawer() {
    drawer = el('div', 'vnt-drawer vnt-hidden');
    drawer.innerHTML = `
        <div class="vnt-drawer-head">
            <span class="vnt-drawer-title"><i class="fa-solid fa-heart-circle-check"></i> VN State</span>
            <button class="vnt-btn vnt-drawer-close" title="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="vnt-drawer-body"></div>`;
    document.body.appendChild(drawer);
    drawer.querySelector('.vnt-drawer-close').addEventListener('click', () => drawer.classList.add('vnt-hidden'));
}

function statBar(label, value, warm) {
    const hue = warm ? 'rgb(94 224 197)' : 'rgb(240 128 128)';
    return `<div class="vnt-stat"><span class="vnt-stat-label">${esc(label)}</span>
        <div class="vnt-stat-track"><div class="vnt-stat-fill" style="width:${Math.max(0, Math.min(100, value))}%;background:${hue}"></div></div>
        <span class="vnt-stat-val">${value}</span></div>`;
}

function renderDrawer() {
    if (!drawer) return;
    const st = getState();
    const s = getSettings();
    const ctx = getContext();
    const charName = ctx.name2 || 'char';
    const warmth = computeWarmth(st.dims);
    const stage = stageForWarmth(warmth);
    const next = STAGES.find(x => x.min > warmth);
    const progress = next ? Math.round(((warmth - stage.min) / (next.min - stage.min)) * 100) : 100;
    const body = drawer.querySelector('.vnt-drawer-body');

    const listItems = (arr, key) => arr.map((it, i) =>
        `<div class="vnt-list-row"><span>${esc(it.text)}</span><button class="vnt-mini-btn" data-list="${key}" data-i="${i}" title="Remove"><i class="fa-solid fa-xmark"></i></button></div>`
    ).join('') || '<div class="vnt-empty">—</div>';

    const flagsHtml = st.flags.map(f => `<span class="vnt-flag">${esc(f.replace(/_/g, ' '))}</span>`).join('') || '<span class="vnt-empty">none</span>';

    const layers = who => CLOTHING_LAYERS.map(l =>
        `<button class="vnt-layer ${st.clothing[who][l] ? '' : 'vnt-off'}" data-who="${who}" data-layer="${l}" title="toggle">${esc(l)}</button>`
    ).join(' ');

    body.innerHTML = `
        <div class="vnt-sec">
            <div class="vnt-stage">${esc(stage.id.replace(/_/g, ' '))} · commitment: ${esc(commitmentFromFlags(st.flags))}</div>
            <div class="vnt-warm-track"><div class="vnt-warm-fill" style="width:${progress}%"></div></div>
            <div class="vnt-warm-note">warmth ${warmth}${next ? ` → next stage at ${next.min}` : ' (max stage)'}</div>
        </div>
        <div class="vnt-sec">
            ${statBar('affection', st.dims.affection, true)}${statBar('trust', st.dims.trust, true)}
            ${statBar('chemistry', st.dims.chemistry, true)}${statBar('comfort', st.dims.comfort, true)}
            ${statBar('respect', st.dims.respect, true)}${statBar('curiosity', st.dims.curiosity, true)}
            ${statBar('tension', st.dims.tension, false)}
        </div>
        <div class="vnt-sec">
            <div class="vnt-mindline"><b>mood</b> ${esc(st.mood || '—')} · <b>need</b> ${esc(st.need || '—')}</div>
            <div class="vnt-mindline"><b>intent</b> ${esc(st.intent || '—')}</div>
            <div class="vnt-mindline"><b>desire</b> ${esc(st.desire || '—')}</div>
            <div class="vnt-mindline"><b>fear</b> ${esc(st.fear || '—')}</div>
        </div>
        <div class="vnt-sec"><div class="vnt-sec-title">flags</div><div class="vnt-flagrow">${flagsHtml}</div></div>
        <div class="vnt-sec"><div class="vnt-sec-title">plans (max 3)</div>${listItems(st.plans, 'plans')}</div>
        <div class="vnt-sec"><div class="vnt-sec-title">beliefs about you</div>${listItems(st.beliefs, 'beliefs')}</div>
        <div class="vnt-sec"><div class="vnt-sec-title">your expectations</div>${listItems(st.expectations, 'expectations')}</div>
        <div class="vnt-sec"><div class="vnt-sec-title">clothing (click to toggle)</div>
            <div class="vnt-clothes-row"><b>${esc(charName)}</b> ${layers('char')}</div>
            <div class="vnt-clothes-row"><b>you</b> ${layers('user')}</div>
        </div>
        <div class="vnt-sec"><div class="vnt-sec-title">arousal · contact</div>
            <div class="vnt-warm-track"><div class="vnt-warm-fill vnt-warm-arousal" style="width:${st.arousal.value}%"></div></div>
            <div class="vnt-warm-note">${st.arousal.value}/100 · ${esc(arousalBand(st.arousal.value))} · contact: ${st.contact.length ? esc(st.contact.join(', ')) : 'none'}</div>
            <button class="vnt-mini-btn" id="vnt-reset-intimacy">reset intimacy</button>
        </div>
        <div class="vnt-sec"><div class="vnt-sec-title">engine</div>
            <div class="vnt-setrow">
                <label class="checkbox_label"><input id="vnt-judge-toggle" type="checkbox" ${s.judge ? 'checked' : ''}/> judge each reply</label>
                <select id="vnt-difficulty">
                    <option value="gentle" ${s.difficulty === 'gentle' ? 'selected' : ''}>gentle</option>
                    <option value="normal" ${s.difficulty === 'normal' ? 'selected' : ''}>normal</option>
                    <option value="harsh" ${s.difficulty === 'harsh' ? 'selected' : ''}>harsh</option>
                </select>
            </div>
            <button class="vnt-mini-btn" id="vnt-reset-state">reset all state</button>
        </div>`;

    body.querySelector('.vnt-drawer-close')?.addEventListener('click', () => drawer.classList.add('vnt-hidden'));
    body.querySelectorAll('.vnt-mini-btn[data-list]').forEach(b => b.addEventListener('click', () => {
        const st2 = getState();
        const list = { plans: st2.plans, beliefs: st2.beliefs, expectations: st2.expectations }[b.dataset.list];
        const i = Number(b.dataset.i);
        if (list && Number.isInteger(i)) { list.splice(i, 1); persistState(); renderDrawer(); }
    }));
    body.querySelectorAll('.vnt-layer').forEach(b => b.addEventListener('click', () => {
        const st2 = getState();
        st2.clothing[b.dataset.who][b.dataset.layer] = !st2.clothing[b.dataset.who][b.dataset.layer];
        persistState(); renderDrawer(); refresh();
    }));
    body.querySelector('#vnt-reset-intimacy')?.addEventListener('click', () => {
        const st2 = getState();
        st2.arousal = { value: 0, phase: 'building', lastTurn: 0 };
        st2.contact = [];
        for (const who of ['char', 'user']) for (const l of CLOTHING_LAYERS) st2.clothing[who][l] = true;
        persistState(); renderDrawer(); refresh();
    });
    body.querySelector('#vnt-judge-toggle')?.addEventListener('change', e => {
        getSettings().judge = e.target.checked;
        saveSettingsDebounced();
    });
    body.querySelector('#vnt-difficulty')?.addEventListener('change', e => {
        getSettings().difficulty = e.target.value;
        saveSettingsDebounced();
    });
    body.querySelector('#vnt-reset-state')?.addEventListener('click', () => {
        const ctx2 = getContext();
        if (ctx2.chatMetadata) ctx2.chatMetadata.vnt_state = freshState();
        else getSettings().states[chatKey()] = freshState();
        persistState(); renderDrawer(); refresh();
        toastr.success('VN state reset', 'VN Theatre');
    });
}

// ===================================================================
// 12. TRANSLATION  (pov-immersion port: ST proxy + fallback chain +
//     HTML kept intact through protectHtml/restoreHtml tokens)
// ===================================================================

async function translateViaStProxy(body, lang) {
    // ST server-side Google translation — no CORS issues, no key needed
    const res = await fetch('/api/translate/google', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ text: body, lang }),
    });
    if (!res.ok) throw new Error(`ST translate proxy HTTP ${res.status}`);
    return (await res.text()).trim();
}

async function translateViaGtx(body, lang) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(body)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Google ${res.status}`);
    const j = await res.json();
    return (j[0] ?? []).map(x => x[0]).join('');
}

async function translateViaLibre(body, lang) {
    const s = getSettings();
    const res = await fetch(s.libreUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: body, source: 'auto', target: lang, format: 'text', api_key: s.libreKey || undefined }),
    });
    if (!res.ok) throw new Error(`LibreTranslate ${res.status}`);
    const j = await res.json();
    return j.translatedText ?? '';
}

async function translateViaLlm(body, lang) {
    const ctx = getContext();
    await requireApi();
    const prompt = `Translate the following roleplay message into ${lang}. Reply with ONLY the translation — same tone, no comments, no quotes. Keep the markdown formatting (**bold**, *italic*) and line breaks intact. Reproduce the source's quotation marks exactly as they appear — never add, duplicate or escape them:\n\n${body}`;
    return String(await ctx.generateRaw({
        prompt,
        systemPrompt: 'You are a translation engine. Reply with only the translated text — nothing else. Never add or double quotation marks.',
    }) ?? '').trim();
}

const TRANSLATORS = {
    'st-proxy': translateViaStProxy,
    google: translateViaGtx,
    libre: translateViaLibre,
    llm: translateViaLlm,
};

async function fetchTranslation(text) {
    const s = getSettings();
    // some instruct presets emit escaped quotes (\"...\"); feed the
    // translator clean prose or it mirrors the backslashes as extra quotes
    const stripped = stripSceneTags(text)
        .replace(/\\+(?=["'])/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();
    if (!stripped) return '';
    // markup (VTK cards, tags) survives translation as ⟦N⟧ placeholders
    const { text: body, tokens } = protectHtml(stripped);
    const chain = [s.provider, 'st-proxy', 'google', 'llm']
        .filter((v, i, a) => a.indexOf(v) === i && TRANSLATORS[v]);
    let out = '';
    let lastErr = null;
    for (const p of chain) {
        try {
            out = await TRANSLATORS[p](body, s.targetLang);
            if (out && out.trim()) break;
        } catch (e) { lastErr = e; }
    }
    out = String(out ?? '').trim();
    if (!out) throw lastErr ?? new Error('all translation providers failed');
    // models sometimes mirror the source's quotes as doubled/tripled runs
    // (tokens hide HTML attributes, so bare prose is safe to collapse)
    out = fixQuoteRuns(out);
    return restoreHtml(out, tokens).trim();
}

function putCache(id, t) {
    const s = getSettings();
    const key = chatKey();
    s.cache[key] = s.cache[key] ?? {};
    s.cache[key][String(id)] = { t, tl: s.targetLang, ts: Date.now() };
    const store = s.cache[key];
    if (Object.keys(store).length > 200) {
        const oldest = Object.entries(store).sort((a, b) => a[1].ts - b[1].ts)[0][0];
        delete store[oldest];
    }
    saveSettingsDebounced();
}

export async function translateMessage(id) {
    const chat = getContext().chat ?? [];
    const m = chat[id];
    if (!m) return '';
    const t = await fetchTranslation(m.mes);
    putCache(id, t);
    return t;
}

// ===================================================================
// 12b. IMAGE GENERATION  (pov-immersion port: Scene Director + ComfyUI)
// ===================================================================

// SDXL resolution buckets: ratio -> [width, height] at base size 1024
const RATIO_BINS = {
    '21:9': [1536, 640], '16:9': [1344, 768], '3:2': [1216, 832],
    '4:3': [1152, 896], '1:1': [1024, 1024], '4:5': [896, 1152],
    '3:4': [832, 1216], '9:16': [768, 1344],
};

function getResolutionForRatio(ratio, baseSize = 1024) {
    const bin = RATIO_BINS[ratio] || RATIO_BINS['16:9'];
    if (!baseSize || baseSize === 1024) return { width: bin[0], height: bin[1] };
    const scale = baseSize / 1024;
    const round64 = v => Math.max(320, Math.round((v * scale) / 64) * 64);
    return { width: round64(bin[0]), height: round64(bin[1]) };
}

/**
 * Backdrops must match the screen the user actually looks at: a desktop
 * window gets 16:9, a portrait phone 9:16. Picks the ratio bin closest to
 * the current viewport aspect (covers landscape phones/tablets too).
 */
function getScreenRatio() {
    const target = Math.max(window.innerWidth, 1) / Math.max(window.innerHeight, 1);
    let best = '16:9', bestDiff = Infinity;
    for (const bin of Object.keys(RATIO_BINS)) {
        const [w, h] = bin.split(':').map(Number);
        const diff = Math.abs(w / h - target);
        if (diff < bestDiff) { bestDiff = diff; best = bin; }
    }
    return best;
}

function joinTags(parts) {
    return parts.map(p => String(p ?? '').trim()).filter(Boolean).join(', ');
}

function makeClientId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'vnt-' + Date.now().toString(16) + '-' + Math.random().toString(16).slice(2);
}

function buildDirectorPrompt(userName, charName, transcript) {
    return [
        'Pause the roleplay. You are the Scene Director for a visual-novel experience. Analyze the recent scene and decide what single image to show right now.',
        'Rules:',
        '- type "character": a person or creature in focus. Describe what the player sees when looking at them (face, body, action, pose, expression, clothing) including their permanent appearance (hair, eyes, species traits) so the image matches the story.',
        '- type "background": the environment or location; no person in focus.',
        '- type "none": the moment has no meaningful visual content (pure dialogue, abstract thoughts).',
        '- "prompt": write in English. First 1-3 short sentences describing the exact current moment (subject, action, expression, clothing, setting, lighting), then style tags: cinematic, detailed, atmospheric. Max ~80 words. Do not use quotation marks inside.',
        '- "subject": when type is "character" — the exact name of the person in focus, as it appears in the transcript; otherwise empty string.',
        '- "ratio" must be one of: ' + Object.keys(RATIO_BINS).join(', ') + '. Prefer wide (16:9, 3:2) for locations, portrait (4:5, 3:4, 9:16) for close-ups of people, 1:1 for neutral shots.',
        '- "negative": only EXTRA negative tags beyond the defaults; keep short or empty.',
        'Respond with ONLY valid JSON (no markdown, no comments): {"type":"character|background|none","ratio":"W:H","prompt":"...","negative":"","subject":""}',
        '',
        'Recent scene:',
        transcript,
    ].join('\n');
}

function attachMediaToMessageDom(mesid, message, url, title) {
    if (!message.extra || typeof message.extra !== 'object') message.extra = {};
    message.extra.media = [{ url, title: title ?? 'VN scene', type: MEDIA_TYPE.IMAGE }];
    if (!message.extra.media_display) message.extra.media_display = MEDIA_DISPLAY.GALLERY;
    message.extra.media_index = 0;
    const messageElement = jQuery(`#chat .mes[mesid="${mesid}"]`);
    if (!messageElement?.length) return;
    appendMediaToMessage(message, messageElement, SCROLL_BEHAVIOR.KEEP);
}

let imageBusy = false;

// sceneOverride (debug/advanced): { prompt, negative?, ratio?, type? } skips the
// director LLM call — lets power users (and tests) render a fixed scene.
async function generateSceneImage(sceneOverride = null) {
    if (imageBusy) { toastr.info('Image generation is already running', 'VN Theatre'); return; }
    const img = imgSettings();
    if (!img.enabled) { toastr.info('Image generation is disabled in settings', 'VN Theatre'); return; }
    imageBusy = true;
    try {
        showFxPill('VN Theatre: checking ComfyUI…');
        const health = await checkComfy(img.comfyUrl);
        if (!health?.ok) throw new Error(`ComfyUI at ${img.comfyUrl} is not reachable (${health?.error ?? 'no answer'})`);

        // 1) director: pick the shot from the recent transcript
        const ctx = getContext();
        const charName = ctx.name2 || 'the character';
        const userName = ctx.name1 || 'the user';
        let scene = null;
        if (sceneOverride && typeof sceneOverride.prompt === 'string' && sceneOverride.prompt.trim()) {
            scene = { type: sceneOverride.type ?? 'background', ratio: sceneOverride.ratio ?? '', negative: sceneOverride.negative ?? '', prompt: sceneOverride.prompt };
        } else {
            const recent = (ctx.chat ?? []).slice(-6);
            if (!recent.length) throw new Error('the chat is empty');
            const transcript = recent.map(m =>
                `${m.is_user ? userName : (m.name || charName)}: ${stripSceneTags(m.mes).replace(/\s+/g, ' ').slice(0, 500)}`).join('\n');
            // reasoning models burn their token budget on thinking first — never
            // cap this call with responseLength, or content comes back empty
            updateFxPill('VN Theatre: directing the scene…');
            let parsed = null;
            try {
                await requireApi();
                const raw = await ctx.generateRaw({
                    prompt: buildDirectorPrompt(userName, charName, transcript),
                    systemPrompt: JSON_ONLY_SYSTEM,
                });
                parsed = parseLenientJson(String(raw ?? ''));
            } catch { parsed = null; }
            if (parsed && parsed.prompt && parsed.type !== 'none') {
                scene = parsed;
            } else {
                // fallback without a second LLM call: the chat model's own scene
                // tags, or a template from the current scene state
                const tags = parseSceneTag(lastAiMessage()?.mes?.mes ?? '');
                if (tags.bggen) {
                    scene = { type: 'background', ratio: getScreenRatio(), prompt: tags.bggen, negative: '' };
                } else {
                    const stf = getState();
                    scene = {
                        type: 'background', ratio: getScreenRatio(), negative: '',
                        prompt: `${stf.scene.background || 'night'} scenery environment, detailed background, cinematic lighting, no people`,
                    };
                }
                toastr.info('Director LLM is quiet — using the scene-tag prompt instead', 'VN Theatre');
            }
        }
        // backdrops always match the user's screen orientation; the director
        // only picks portrait framing for character shots
        if (scene && (!scene.type || scene.type === 'background')) {
            scene.ratio = getScreenRatio();
        }

        // 2) workflow: anima (Qwen-Image) or sdxl, portrait/landscape by type
        updateFxPill(scene.type === 'character' ? 'VN Theatre: painting the character…' : 'VN Theatre: painting the scene…');
        const engine = img.preset === 'sdxl' ? 'sdxl' : 'anima';
        const isCharacter = scene.type === 'character';
        const wfName = engine === 'anima' ? 'anima_t2i' : (isCharacter ? 'sdxl_portrait' : 'sdxl_default');
        const workflowText = await loadBundledWorkflow(wfName);
        const ratio = String(scene.ratio ?? '').trim() || (isCharacter ? '3:4' : getScreenRatio());
        const { width, height } = getResolutionForRatio(ratio, 1024);
        const seed = img.seed >= 0 ? img.seed : Math.floor(Math.random() * 2 ** 48);
        const prompt = joinTags([img.qualityTags, scene.prompt, isCharacter ? 'pov, first-person view, first-person perspective' : '']);
        const negative = joinTags([img.negativePrompt, scene.negative]);
        const workflow = substituteWorkflow(workflowText, {
            prompt, negative, width, height, seed,
            steps: img.steps, cfg: img.cfg,
            model: img.checkpoint || (engine === 'anima' ? 'anima-base-v1.0.safetensors' : ''),
            denoise: 1.0,
            initImage: '',
            lora: img.lora ?? '',
            loraStrength: img.loraStrength ?? 1.0,
        });

        // 3) generate + persist
        const generated = await generateImage({ url: img.comfyUrl, workflow, clientId: makeClientId() });
        const scaled = await downscaleImageBlob(generated.blob, img.maxDim);
        const b64 = await blobToBase64(scaled.blob);
        const ext = String(scaled.mime || '').includes('jpeg') ? 'jpg' : 'png';
        const baseName = 'vnt_' + (ctx.chatId ?? 'chat') + '_' + Date.now();
        const url = await saveBase64AsFile(b64, 'vnt-scenes', baseName, ext);

        // 4) deliver: attach to message + optional VN background
        const last = lastAiMessage();
        if (img.attachToMessage && last) {
            attachMediaToMessageDom(last.id, last.mes, url, isCharacter ? 'VN scene — character' : 'VN scene — background');
        }
        if (img.setAsBackground && !isCharacter) {
            img.bgMap = img.bgMap ?? {};
            img.bgMap[chatKey()] = { url };
            saveSettingsDebounced();
            refresh();
        }
        await ctx.saveChat?.();
        hideFxPill();
        toastr.success(`Scene image ready (${scene.type}, ${ratio})`, 'VN Theatre');
        return { ok: true, url, type: scene.type, ratio };
    } catch (e) {
        hideFxPill();
        toastr.error(String(e?.message ?? e).slice(0, 220), 'VN Theatre');
        return { ok: false, error: String(e?.message ?? e) };
    } finally {
        imageBusy = false;
    }
}

// ===================================================================
// 13. MESSAGE DECORATION (translate buttons, tag stripping, translations)
// ===================================================================

function showTranslationUnderMessage(mesEl, id) {
    const t = cachedTranslation(id);
    let box = mesEl.querySelector('.vn-translation');
    if (!t) { box?.remove(); return; }
    if (!box) {
        box = el('div', 'vn-translation');
        mesEl.querySelector('.mes_text')?.after(box);
    }
    if (/[<>]/.test(t)) box.innerHTML = t; else box.textContent = t;
}

function showTranslationUnderMessageById(id) {
    const mesEl = document.querySelector(`#chat .mes[mesid="${id}"]`);
    if (mesEl) showTranslationUnderMessage(mesEl, id);
}

function stripInDom(mesEl) {
    const walker = document.createTreeWalker(mesEl, NodeFilter.SHOW_TEXT);
    const hits = [];
    while (walker.nextNode()) {
        const n = walker.currentNode;
        if (n.nodeValue.includes('<<scene:')) hits.push(n);
    }
    for (const n of hits) n.nodeValue = n.nodeValue.replace(SCENE_TAG_RE, '');
}

function scrubAllMessages() {
    document.querySelectorAll('#chat .mes').forEach(m => {
        stripInDom(m);
        showTranslationUnderMessage(m, Number(m.getAttribute('mesid')));
    });
}

function decorateMessage(id) {
    const mesEl = document.querySelector(`#chat .mes[mesid="${id}"]`);
    if (!mesEl) return;
    const buttons = mesEl.querySelector('.mes_buttons');
    if (buttons && !buttons.querySelector('.vn-tbtn')) {
        const btn = el('div', 'menu_button interactable fa-solid fa-language vn-tbtn');
        btn.title = 'Translate (VN Theatre)';
        btn.addEventListener('click', async () => {
            btn.classList.add('vnt-spin');
            try { await translateMessage(id); showTranslationUnderMessage(mesEl, id); }
            catch (e) { toastr.error(String(e), 'VN Theatre'); }
            finally { btn.classList.remove('vnt-spin'); }
        });
        buttons.prepend(btn);
    }
    stripInDom(mesEl);
    showTranslationUnderMessage(mesEl, id);
}

function decorateAllMessages() {
    document.querySelectorAll('#chat .mes').forEach(m => decorateMessage(Number(m.getAttribute('mesid'))));
}

// ===================================================================
// 14. EVENTS
// ===================================================================

function bindEvents() {
    eventSource.on(event_types.MESSAGE_RECEIVED, (id) => {
        refresh();
        const last = lastAiMessage();
        decorateMessage(last?.id ?? -1);
        if (getSettings().autoTranslate && last) {
            translateMessage(last.id)
                .then(() => { refresh(); showTranslationUnderMessageById(last.id); })
                .catch(e => toastr.error(String(e), 'VN Theatre'));
        }
        // ported systems: judge + chips
        if (last) {
            runJudge(last.id);
            if (getSettings().autoChoices) generateChoices();
        }
    });
    // the used options are gone once the player speaks; the next character
    // reply generates fresh ones for the new situation
    eventSource.on(event_types.MESSAGE_SENT, () => {
        const s = getSettings();
        s.chipOptions = [];
        renderChips(document.querySelector('.vnt-chips'));
    });
    eventSource.on(event_types.MESSAGE_UPDATED, (id) => { decorateMessage(Number(id)); refresh(); });
    eventSource.on(event_types.MESSAGE_DELETED, scrubAllMessages);
    eventSource.on(event_types.GENERATION_ENDED, () => {
        if (getSettings().intentArm || getSettings().intentJudgeDesc) {
            const s = getSettings();
            s.intentArm = '';
            s.intentJudgeDesc = '';
            saveSettingsDebounced();
            updatePromptInjections();
            renderChips(document.querySelector('.vnt-chips'));
        }
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(() => {
            decorateAllMessages(); refresh(); renderDrawer(); updatePromptInjections();
            // chips must match the chat the player is walking into
            const s = getSettings();
            s.chipOptions = [];
            renderChips(document.querySelector('.vnt-chips'));
            // wait out the chat load, then read the actual scene
            setTimeout(() => {
                if (s.autoChoices && (getContext().chat ?? []).length >= 2) generateChoices();
            }, 1000);
        }, 300);
    });
}

// ===================================================================
// 15. SETTINGS UI
// ===================================================================

function buildSettings() {
    const s = getSettings();
    const img = imgSettings();
    const effectOptions = [...EFFECT_PRESETS, 'off']
        .map(k => `<option value="${k}" ${s.effect === k ? 'selected' : ''}>${k}</option>`).join('');
    const html = `
    <div id="vnt-settings" class="extension_settings">
        <div class="vnt-set-row"><label class="checkbox_label"><input id="vnt-set-judge" type="checkbox" ${s.judge ? 'checked' : ''}/> Relationship judge (extra LLM call per reply)</label></div>
        <div class="vnt-set-row"><label class="checkbox_label"><input id="vnt-set-choices" type="checkbox" ${s.autoChoices ? 'checked' : ''}/> Suggest next-move options</label></div>
        <div class="vnt-set-row"><label class="checkbox_label"><input id="vnt-set-auto" type="checkbox" ${s.autoTranslate ? 'checked' : ''}/> Auto-translate new replies</label></div>
        <div class="vnt-set-row"><label class="checkbox_label"><input id="vnt-set-sfx" type="checkbox" ${s.sfx ? 'checked' : ''}/> Comic-burst onomatopoeia</label></div>
        <div class="vnt-set-row">
            <label>Target language <input id="vnt-set-lang" type="text" value="${esc(s.targetLang)}" size="6"/></label>
            <label>Provider
                <select id="vnt-set-provider">
                    <option value="st-proxy" ${s.provider === 'st-proxy' ? 'selected' : ''}>SillyTavern proxy (Google)</option>
                    <option value="google" ${s.provider === 'google' ? 'selected' : ''}>Google (free)</option>
                    <option value="libre" ${s.provider === 'libre' ? 'selected' : ''}>LibreTranslate</option>
                    <option value="llm" ${s.provider === 'llm' ? 'selected' : ''}>LLM (current API)</option>
                </select>
            </label>
            <label>Libre URL <input id="vnt-set-libre" type="text" value="${esc(s.libreUrl)}" size="28"/></label>
            <label>API key <input id="vnt-set-key" type="password" value="${esc(s.libreKey)}" size="12"/></label>
        </div>
        <div class="vnt-set-row">
            <label>Ambient effect
                <select id="vnt-set-effect">${effectOptions}</select>
            </label>
            <span class="vnt-set-hint">also cycles from the overlay topbar button</span>
        </div>
        <div class="vnt-set-row"><b>Image generation (ComfyUI)</b></div>
        <div class="vnt-set-row">
            <label class="checkbox_label"><input id="vnt-set-img" type="checkbox" ${img.enabled ? 'checked' : ''}/> Enabled</label>
            <label>Preset
                <select id="vnt-set-img-preset">
                    <option value="anima" ${img.preset === 'anima' ? 'selected' : ''}>Anima (Qwen-Image)</option>
                    <option value="sdxl" ${img.preset === 'sdxl' ? 'selected' : ''}>SDXL</option>
                </select>
            </label>
            <label>ComfyUI URL <input id="vnt-set-img-url" type="text" value="${esc(img.comfyUrl)}" size="24"/></label>
        </div>
        <div class="vnt-set-row">
            <label class="checkbox_label"><input id="vnt-set-img-attach" type="checkbox" ${img.attachToMessage ? 'checked' : ''}/> Attach to last message</label>
            <label class="checkbox_label"><input id="vnt-set-img-bg" type="checkbox" ${img.setAsBackground ? 'checked' : ''}/> Use as VN background</label>
            <label class="checkbox_label"><input id="vnt-set-img-autotag" type="checkbox" ${img.autoFromTag ? 'checked' : ''}/> AI may auto-generate backgrounds (bggen tags)</label>
        </div>
        <div class="vnt-set-row">
            <label>Steps <input id="vnt-set-img-steps" type="number" value="${img.steps}" min="4" max="60" size="3"/></label>
            <label>CFG <input id="vnt-set-img-cfg" type="number" value="${img.cfg}" min="1" max="12" step="0.5" size="3"/></label>
            <label>Seed (-1 = random) <input id="vnt-set-img-seed" type="number" value="${img.seed}" size="10"/></label>
            <label>Downscale <input id="vnt-set-img-maxdim" type="number" value="${img.maxDim}" min="512" max="2048" step="64" size="5"/></label>
        </div>
        <div class="vnt-set-row">
            <label>Checkpoint <input id="vnt-set-img-checkpoint" type="text" value="${esc(img.checkpoint)}" placeholder="anima-base-v1.0.safetensors" size="26"/></label>
            <label>Style LoRA <input id="vnt-set-img-lora" type="text" value="${esc(img.lora)}" placeholder="none" size="16"/></label>
        </div>
        <div class="vnt-set-row"><label>Quality tags <input id="vnt-set-img-quality" type="text" value="${esc(img.qualityTags)}" style="width:100%"/></label></div>
        <div class="vnt-set-row"><label>Negative prompt <input id="vnt-set-img-negative" type="text" value="${esc(img.negativePrompt)}" style="width:100%"/></label></div>
        <div class="vnt-set-row"><button id="vnt-set-img-clearbg" class="menu_button">Clear generated VN background</button>
            <button id="vnt-set-img-test" class="menu_button">Test connection</button></div>
        <div class="vnt-set-row"><label>Custom backgrounds (name=url, one per line)</label><textarea id="vnt-set-bgs" rows="3" style="width:100%">${esc(s.customBgs)}</textarea></div>
        <div class="vnt-set-row"><button id="vnt-set-clear" class="menu_button">Clear translation cache</button></div>
    </div>`;
    const host = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    host?.insertAdjacentHTML('beforeend', html);

    const q = id => document.querySelector(id);
    q('#vnt-set-judge').addEventListener('change', e => { s.judge = e.target.checked; saveSettingsDebounced(); });
    q('#vnt-set-choices').addEventListener('change', e => {
        s.autoChoices = e.target.checked;
        saveSettingsDebounced();
        if (e.target.checked) generateChoices();
        else { s.chipOptions = []; renderChips(document.querySelector('.vnt-chips')); }
    });
    q('#vnt-set-auto').addEventListener('change', e => { s.autoTranslate = e.target.checked; saveSettingsDebounced(); });
    q('#vnt-set-sfx').addEventListener('change', e => { s.sfx = e.target.checked; saveSettingsDebounced(); });
    q('#vnt-set-lang').addEventListener('change', e => { s.targetLang = e.target.value.trim() || 'ru'; saveSettingsDebounced(); });
    q('#vnt-set-provider').addEventListener('change', e => { s.provider = e.target.value; saveSettingsDebounced(); });
    q('#vnt-set-libre').addEventListener('change', e => { s.libreUrl = e.target.value.trim(); saveSettingsDebounced(); });
    q('#vnt-set-key').addEventListener('change', e => { s.libreKey = e.target.value.trim(); saveSettingsDebounced(); });
    q('#vnt-set-bgs').addEventListener('change', e => { s.customBgs = e.target.value; saveSettingsDebounced(); refresh(); });
    q('#vnt-set-clear').addEventListener('click', () => { s.cache = {}; saveSettingsDebounced(); toastr.success('Translation cache cleared', 'VN Theatre'); });
    // effects
    q('#vnt-set-effect').addEventListener('change', e => {
        s.effect = e.target.value;
        saveSettingsDebounced();
        if (overlayVisible() && s.effect !== 'off') startEffect(); else stopEffect();
        updateEffectButton();
    });
    // image generation
    const imgSet = (id, fn) => q(id).addEventListener('change', e => { fn(e); saveSettingsDebounced(); });
    imgSet('#vnt-set-img', e => { img.enabled = e.target.checked; });
    imgSet('#vnt-set-img-preset', e => { img.preset = e.target.value; });
    imgSet('#vnt-set-img-url', e => { img.comfyUrl = e.target.value.trim() || DEFAULT_SETTINGS.image.comfyUrl; });
    imgSet('#vnt-set-img-attach', e => { img.attachToMessage = e.target.checked; });
    imgSet('#vnt-set-img-bg', e => { img.setAsBackground = e.target.checked; });
    imgSet('#vnt-set-img-autotag', e => { img.autoFromTag = e.target.checked; });
    imgSet('#vnt-set-img-steps', e => { img.steps = Math.max(4, Math.min(60, Math.round(Number(e.target.value)) || 30)); });
    imgSet('#vnt-set-img-cfg', e => { img.cfg = Math.max(1, Math.min(12, Number(e.target.value) || 4)); });
    imgSet('#vnt-set-img-seed', e => { const n = Number(e.target.value); img.seed = Number.isFinite(n) ? Math.trunc(n) : -1; });
    imgSet('#vnt-set-img-maxdim', e => { img.maxDim = Math.max(512, Math.min(2048, Math.round(Number(e.target.value)) || 1280)); });
    imgSet('#vnt-set-img-checkpoint', e => { img.checkpoint = e.target.value.trim(); });
    imgSet('#vnt-set-img-lora', e => { img.lora = e.target.value.trim(); });
    imgSet('#vnt-set-img-quality', e => { img.qualityTags = e.target.value; });
    imgSet('#vnt-set-img-negative', e => { img.negativePrompt = e.target.value; });
    q('#vnt-set-img-clearbg').addEventListener('click', () => {
        img.bgMap = {};
        saveSettingsDebounced();
        if (overlayVisible()) refresh();
        toastr.success('Generated VN background cleared', 'VN Theatre');
    });
    q('#vnt-set-img-test').addEventListener('click', async () => {
        img.comfyUrl = q('#vnt-set-img-url').value.trim() || img.comfyUrl;
        saveSettingsDebounced();
        const health = await checkComfy(img.comfyUrl);
        if (health?.ok) toastr.success(`ComfyUI is up (${health.info?.system?.comfyui_version ?? 'ok'})`, 'VN Theatre');
        else toastr.error(`ComfyUI unreachable: ${health?.error ?? 'no answer'}`, 'VN Theatre');
    });
}

// ===================================================================
// 16. INIT
// ===================================================================

function addMenuButton() {
    const host = document.querySelector('#extensionsMenu');
    if (!host) return;
    const btn = el('div', 'list-group-item flex-container flexFlowColumn flexNoGap interactable vnt-menu-btn');
    btn.innerHTML = `<div class="fa-solid fa-clapperboard"></div><span>VN Theatre</span>`;
    btn.title = 'Toggle visual-novel theatre view';
    btn.addEventListener('click', () => setEnabled(!getSettings().enabled));
    host.appendChild(btn);
    const stBtn = el('div', 'list-group-item flex-container flexFlowColumn flexNoGap interactable vnt-menu-btn2');
    stBtn.innerHTML = `<div class="fa-solid fa-heart-circle-check"></div><span>VN State</span>`;
    stBtn.title = 'Relationship & scene state panel';
    stBtn.addEventListener('click', () => toggleDrawer());
    host.appendChild(stBtn);
}

jQuery(() => {
    getSettings();
    buildOverlay();
    buildDrawer();
    buildSettings();
    addMenuButton();
    bindEvents();
    bindViewportSync();
    if (getSettings().enabled) setEnabled(true);
    updatePromptInjections();
    setTimeout(decorateAllMessages, 800);
    // CHAT_CHANGED does not fire on page load: seed the chip row for the
    // situation the player returns to (stale options from another chat go first)
    setTimeout(() => {
        const s = getSettings();
        const chat = getContext().chat ?? [];
        if (s.enabled && s.autoChoices && chat.length >= 2) {
            s.chipOptions = [];
            generateChoices();
        }
    }, 3000);
    // debug/testing hook
    window.__vnt = {
        state: getState,
        applyJudge: (payload, opts) => { applyJudgePayload(payload, opts); renderDrawer(); refresh(); },
        judgeNow: () => runJudge(lastAiMessage()?.id ?? -1),
        choicesNow: generateChoices,
        toggleDrawer,
        cycleEffect,
        screenRatio: getScreenRatio,
        genImage: generateSceneImage,
        judgeRaw: async () => {
            const ctx = getContext();
            const chat = ctx.chat ?? [];
            const charName = ctx.name2 || 'the character';
            const userName = ctx.name1 || 'the user';
            const from = Math.max(0, chat.length - 8);
            const transcript = chat.slice(from).map(m =>
                `${m.is_user ? userName : (m.name || charName)}: ${stripSceneTags(m.mes).slice(0, 600)}`).join('\n');
            const st2 = getState();
            try {
                await requireApi();
                const raw = await ctx.generateRaw({
                    prompt: buildJudgePrompt(st2, transcript, charName, userName, 'No intent tag.'),
                    systemPrompt: JSON_ONLY_SYSTEM,
                });
                return { ok: true, raw: String(raw ?? '').slice(0, 600) };
            } catch (e) {
                return { ok: false, error: String(e?.message ?? e).slice(0, 400) };
            }
        },
        translateNow: async () => {
            const mes = lastAiMessage();
            if (!mes) return '';
            const t = await translateMessage(mes.id);
            showTranslationUnderMessageById(mes.id);
            refresh();
            return t;
        },
    };
});
