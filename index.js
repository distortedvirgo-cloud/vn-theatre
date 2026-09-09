// VN Theatre — SillyTavern extension porting the visual-novel presentation and
// the systemic engines of https://github.com/pnotisdev/rp:
// scene tags (expression/background/mood/outfit), a relationship judge
// (7 dimensions, stages, flags, character mind, plans/beliefs/facts),
// an intimacy state machine ([SCENE STATE] injection), intent chips,
// AI-suggested next moves, and per-message auto-translation.
import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types, messageFormatting, extension_prompt_types } from '../../../../script.js';

// ===================================================================
// 1. SETTINGS
// ===================================================================

const DEFAULT_SETTINGS = {
    enabled: false,          // overlay visible
    instruct: true,          // inject scene-tag instruction into prompts
    typewriter: true,
    petals: true,
    sfx: true,               // comic-burst styling for ALL-CAPS onomatopoeia
    autoTranslate: false,
    provider: 'google',      // google | libre
    libreUrl: 'https://libretranslate.com/translate',
    libreKey: '',
    targetLang: 'ru',
    customBgs: '',           // "name=url" per line
    cache: {},               // chatKey -> { mesId -> { t, tl, ts } }
    // --- ported systems ---
    judge: true,             // per-reply relationship judge (secondary LLM call)
    difficulty: 'normal',    // gentle | normal | harsh  (delta scaling)
    autoChoices: true,       // suggest 3 next-move options after each reply
    intentArm: '',           // armed intent chip id (''|flirt|tease|open_up|reassure|apologize)
    judgeFailed: false,
};

function getSettings() {
    if (extension_settings.vnt === undefined) extension_settings.vnt = {};
    const s = extension_settings.vnt;
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = v;
    }
    return s;
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
    flirt: { label: 'Flirt', judge: 'flirtatious' },
    tease: { label: 'Tease', judge: 'teasing' },
    open_up: { label: 'Open up', judge: 'an attempt to open up emotionally' },
    reassure: { label: 'Reassure', judge: 'an attempt to reassure them' },
    apologize: { label: 'Apologize', judge: 'an apology' },
};

// rp clothing.ts CLOTHING_LAYERS
const CLOTHING_LAYERS = ['outerwear', 'top', 'bottoms', 'underwear', 'shoes'];
// rp arousal.ts BODY_REGIONS (trimmed)
const BODY_REGIONS = ['lips', 'neck', 'ears', 'chest', 'breasts', 'waist', 'hips', 'thighs', 'between_legs', 'back', 'hands'];

const SCENE_TAG_RE = /<<\s*scene\s*:\s*([^>]*?)>>/gi;

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
    for (const m of matches[matches.length - 1][1].matchAll(/(\w+)\s*=\s*([^\s,;|]+)/g)) {
        out[m[1].toLowerCase()] = m[2].toLowerCase();
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
        '<<scene: expression=ID, background=ID, mood=ID, outfit=ID>>',
        `expression IDs: ${EXPRS.join(', ')}.`,
        `background IDs: ${BG_KEYS.join(', ')}.`,
        `mood IDs: ${MOOD_IDS.join(', ')}.`,
    ];
    if (st.outfit.char) {
        lines.push(`The character is currently wearing "${st.outfit.char}". Only use a different outfit ID when the story has actually changed what they are wearing; never change an outfit just because the mood shifted.`);
    } else {
        lines.push('outfit: a 1-2 word description of what the character is wearing (lowercase, hyphens for spaces). Keep it consistent between replies unless the story changes their clothes.');
    }
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
    const armed = s.intentArm && INTENTS[s.intentArm]
        ? `The player tagged their latest line as ${INTENTS[s.intentArm].judge}. Weigh ${charName}'s honest reaction to that; do not just reward the attempt.`
        : 'No intent tag on the latest line.';

    judgeBusy = true;
    setAssistStatus('Reading the relationship...');
    try {
        const raw = await ctx.generateQuietPrompt({ quietPrompt: buildJudgePrompt(st, transcript, charName, userName, armed) });
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
    const armed = s.intentArm && INTENTS[s.intentArm]
        ? `\nThe player tagged their latest line as ${INTENTS[s.intentArm].judge}. Weigh it honestly; do not just reward the attempt.` : '';
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
let petalsRAF = null;

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
            <button class="vnt-btn vnt-act-petals" title="Petals"><i class="fa-solid fa-seedling"></i></button>
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
    ui.querySelector('.vnt-act-petals').addEventListener('click', () => {
        const s = getSettings();
        s.petals = !s.petals;
        saveSettingsDebounced();
        s.petals ? startPetals() : stopPetals();
    });
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
        await translateMessage(mes.id);
        showTranslationUnderMessageById(mes.id);
        refresh();
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
        refresh();
        if (s.petals) startPetals();
    } else {
        stopPetals();
        stopTypewriter();
    }
}

function overlayVisible() {
    return ui && !ui.classList.contains('vnt-hidden');
}

function lastAiMessage() {
    const chat = getContext().chat ?? [];
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user && !chat[i].is_system) return { mes: chat[i], id: i };
    }
    return null;
}

function cachedTranslation(id) {
    const s = getSettings();
    return s.cache[chatKey()]?.[String(id)]?.t ?? '';
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
    const url = bgUrl(key || '');
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

function refresh() {
    if (!ui) return;
    const ctx = getContext();
    const last = lastAiMessage();
    const char = ctx.characters?.[ctx.characterId];
    const chName = ctx.groupId ? (last?.mes?.name ?? ctx.name2) : (char?.name ?? ctx.name2);

    let avatarUrl = '';
    if (ctx.groupId && last?.mes?.force_avatar) {
        avatarUrl = last.mes.force_avatar;
    } else if (char?.avatar) {
        avatarUrl = `/thumbnail?type=avatar&file=${encodeURIComponent(char.avatar)}`;
    }
    setSprite(avatarUrl);

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
        if (/<[a-z!][^\s>]*>/i.test(text) || !getSettings().typewriter) {
            stopTypewriter();
            tEl.innerHTML = messageFormatting(text, last.mes.name || chName || '', false, false, false);
            tEl.scrollTop = tEl.scrollHeight;
        } else {
            typewrite(tEl, text);
        }
        styleSfx(tEl);
        const tr = cachedTranslation(last.id);
        const trEl = ui.querySelector('.vnt-translation');
        trEl.textContent = tr ? tr : '';
        trEl.style.display = tr ? '' : 'none';
        trEl.scrollTop = 0;
        if (scene.background) setBackground(scene.background);
        else if (!st.scene.background) setBackground('night');
        else setBackground(st.scene.background);
        // remember scene in state
        let sceneChanged = false;
        if (scene.background && scene.background !== st.scene.background) { st.scene.background = scene.background; sceneChanged = true; }
        if (scene.mood && scene.mood !== st.scene.mood) { st.scene.mood = scene.mood; sceneChanged = true; }
        if (scene.outfit && scene.outfit !== st.outfit.char) { st.outfit.char = scene.outfit; sceneChanged = true; }
        if (sceneChanged) { persistState(); }
    }
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

// ---------------------------------------------------------------- petals

function startPetals() {
    if (!ui) return;
    const canvas = ui.querySelector('.vnt-petals');
    const ctx2d = canvas.getContext('2d');
    let W = canvas.width = window.innerWidth;
    let H = canvas.height = window.innerHeight;
    const petals = Array.from({ length: 36 }, () => ({
        x: Math.random() * W, y: Math.random() * H,
        s: 4 + Math.random() * 7, vy: 0.4 + Math.random() * 0.9,
        sway: Math.random() * Math.PI * 2, spin: 0.01 + Math.random() * 0.03,
    }));
    function frame() {
        ctx2d.clearRect(0, 0, W, H);
        ctx2d.fillStyle = 'rgba(255,183,197,0.55)';
        for (const p of petals) {
            p.y += p.vy; p.sway += p.spin; p.x += Math.sin(p.sway) * 0.6;
            if (p.y > H + 12) { p.y = -12; p.x = Math.random() * W; }
            ctx2d.beginPath();
            ctx2d.ellipse(p.x, p.y, p.s, p.s * 0.55, p.sway, 0, Math.PI * 2);
            ctx2d.fill();
        }
        petalsRAF = requestAnimationFrame(frame);
    }
    cancelAnimationFrame(petalsRAF);
    petalsRAF = requestAnimationFrame(frame);
    window.addEventListener('resize', () => { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }, { once: true });
}

function stopPetals() {
    if (petalsRAF) cancelAnimationFrame(petalsRAF);
    petalsRAF = null;
    if (ui) {
        const c = ui.querySelector('.vnt-petals');
        c.getContext('2d').clearRect(0, 0, c.width, c.height);
    }
}

// ===================================================================
// 9. INTENT CHIPS + ASSIST STATUS  (rp IntentChips / AssistActivityBar)
// ===================================================================

function renderChips(host) {
    if (!host) return;
    host.innerHTML = '';
    for (const [id, spec] of Object.entries(INTENTS)) {
        const chip = el('button', 'vnt-chip-btn' + (getSettings().intentArm === id ? ' vnt-armed' : ''), esc(spec.label));
        chip.addEventListener('click', () => {
            const s = getSettings();
            s.intentArm = s.intentArm === id ? '' : id;
            saveSettingsDebounced();
            updatePromptInjections();
            renderChips(document.querySelector('.vnt-chips'));
        });
        host.appendChild(chip);
    }
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
// 10. AI CHOICES  (rp choices.ts — 3 next-move suggestions)
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
        'You are brainstorming what a roleplay participant could say or do next, to help them pick a direction.',
        'Recent scene:', transcript,
        `Propose 3 short, distinct options for what ${userName} could say or do next.`,
        'Output ONLY a minified JSON array of 3 objects: {"kind":"line|action","label":"short button text","text":"the actual message to send"}.',
        'No markdown fences, no commentary. JSON:',
    ].join('\n');
    setAssistStatus('Thinking of options...');
    try {
        const raw = await ctx.generateQuietPrompt({ quietPrompt: prompt });
        const start = String(raw).indexOf('[');
        const end = String(raw).lastIndexOf(']');
        if (start === -1 || end <= start) throw new Error('no JSON array');
        const arr = JSON.parse(String(raw).slice(start, end + 1).replace(/[\u201c\u201d]/g, '"'));
        const options = arr.filter(o => o && typeof o.label === 'string' && typeof o.text === 'string').slice(0, 3);
        renderChoices(options);
    } catch (e) {
        if (!s.judgeFailed) toastr.info(`Could not generate choices (${String(e).slice(0, 90)})`, 'VN Theatre');
    } finally {
        setAssistStatus('');
    }
}

function renderChoices(options) {
    let bar = document.querySelector('#vnt-choices');
    const sendForm = document.querySelector('#send_form');
    if (!options || !options.length) { bar?.remove(); return; }
    if (!bar) {
        bar = el('div');
        bar.id = 'vnt-choices';
        if (sendForm?.parentElement) sendForm.parentElement.insertBefore(bar, sendForm);
        else document.body.appendChild(bar);
    }
    bar.innerHTML = '';
    for (const o of options) {
        const pill = el('button', 'vnt-choice', esc(o.label));
        pill.title = o.text;
        pill.addEventListener('click', () => {
            bar.remove();
            const ta = document.querySelector('#send_textarea');
            if (!ta) return;
            ta.value = o.text;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('#send_but')?.click();
        });
        bar.appendChild(pill);
    }
    const refresh = el('button', 'vnt-choice vnt-choice-refresh', '<i class="fa-solid fa-rotate"></i>');
    refresh.title = 'Regenerate options';
    refresh.addEventListener('click', () => { bar.remove(); generateChoices(); });
    bar.appendChild(refresh);
}

// ===================================================================
// 11. STATE DRAWER  (port of RelationshipPanel + ScenePanel + Director)
// ===================================================================

let drawer = null;

function toggleDrawer() {
    if (!drawer) buildDrawer();
    drawer.classList.toggle('vnt-hidden');
    if (!drawer.classList.contains('vnt-hidden')) renderDrawer();
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
// 12. TRANSLATION (unchanged mechanics, HTML stripped before sending)
// ===================================================================

async function fetchTranslation(text) {
    const s = getSettings();
    const body = stripSceneTags(text)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]*>/g, '')
        .trim();
    if (!body) return '';
    if (s.provider === 'libre') {
        const res = await fetch(s.libreUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: body, s: 'auto', t: s.targetLang, format: 'text', api_key: s.libreKey || undefined }),
        });
        if (!res.ok) throw new Error(`LibreTranslate ${res.status}`);
        const j = await res.json();
        return j.translatedText ?? '';
    }
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=${encodeURIComponent(s.targetLang)}&q=${encodeURIComponent(body)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Google ${res.status}`);
    const j = await res.json();
    return (j[0] ?? []).map(x => x[0]).join('');
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
    box.textContent = t;
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
        // ported systems: judge + choices
        if (last) {
            runJudge(last.id);
            if (getSettings().autoChoices) generateChoices();
            else renderChoices(null);
        }
    });
    eventSource.on(event_types.MESSAGE_SENT, () => renderChoices(null));
    eventSource.on(event_types.MESSAGE_UPDATED, (id) => { decorateMessage(Number(id)); refresh(); });
    eventSource.on(event_types.MESSAGE_DELETED, scrubAllMessages);
    eventSource.on(event_types.GENERATION_ENDED, () => {
        if (getSettings().intentArm) {
            getSettings().intentArm = '';
            saveSettingsDebounced();
            updatePromptInjections();
            renderChips(document.querySelector('.vnt-chips'));
        }
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(() => { decorateAllMessages(); refresh(); renderDrawer(); updatePromptInjections(); }, 300);
    });
}

// ===================================================================
// 15. SETTINGS UI
// ===================================================================

function buildSettings() {
    const s = getSettings();
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
                    <option value="google" ${s.provider === 'google' ? 'selected' : ''}>Google (free)</option>
                    <option value="libre" ${s.provider === 'libre' ? 'selected' : ''}>LibreTranslate</option>
                </select>
            </label>
            <label>Libre URL <input id="vnt-set-libre" type="text" value="${esc(s.libreUrl)}" size="28"/></label>
            <label>API key <input id="vnt-set-key" type="password" value="${esc(s.libreKey)}" size="12"/></label>
        </div>
        <div class="vnt-set-row"><label>Custom backgrounds (name=url, one per line)</label><textarea id="vnt-set-bgs" rows="3" style="width:100%">${esc(s.customBgs)}</textarea></div>
        <div class="vnt-set-row"><button id="vnt-set-clear" class="menu_button">Clear translation cache</button></div>
    </div>`;
    const host = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    host?.insertAdjacentHTML('beforeend', html);

    const q = id => document.querySelector(id);
    q('#vnt-set-judge').addEventListener('change', e => { s.judge = e.target.checked; saveSettingsDebounced(); });
    q('#vnt-set-choices').addEventListener('change', e => { s.autoChoices = e.target.checked; if (!e.target.checked) renderChoices(null); saveSettingsDebounced(); });
    q('#vnt-set-auto').addEventListener('change', e => { s.autoTranslate = e.target.checked; saveSettingsDebounced(); });
    q('#vnt-set-sfx').addEventListener('change', e => { s.sfx = e.target.checked; saveSettingsDebounced(); });
    q('#vnt-set-lang').addEventListener('change', e => { s.targetLang = e.target.value.trim() || 'ru'; saveSettingsDebounced(); });
    q('#vnt-set-provider').addEventListener('change', e => { s.provider = e.target.value; saveSettingsDebounced(); });
    q('#vnt-set-libre').addEventListener('change', e => { s.libreUrl = e.target.value.trim(); saveSettingsDebounced(); });
    q('#vnt-set-key').addEventListener('change', e => { s.libreKey = e.target.value.trim(); saveSettingsDebounced(); });
    q('#vnt-set-bgs').addEventListener('change', e => { s.customBgs = e.target.value; saveSettingsDebounced(); refresh(); });
    q('#vnt-set-clear').addEventListener('click', () => { s.cache = {}; saveSettingsDebounced(); toastr.success('Translation cache cleared', 'VN Theatre'); });
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
    if (getSettings().enabled) setEnabled(true);
    updatePromptInjections();
    setTimeout(decorateAllMessages, 800);
    // debug/testing hook
    window.__vnt = {
        state: getState,
        applyJudge: (payload, opts) => { applyJudgePayload(payload, opts); renderDrawer(); refresh(); },
        judgeNow: () => runJudge(lastAiMessage()?.id ?? -1),
        choicesNow: generateChoices,
        toggleDrawer,
    };
});
