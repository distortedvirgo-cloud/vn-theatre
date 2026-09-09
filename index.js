// VN Theatre — a SillyTavern extension porting the visual-novel presentation of
// https://github.com/pnotisdev/rp (backgrounds, character sprite stage, scene tags)
// plus per-message auto-translation via a public translation API.
import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types, messageFormatting } from '../../../../script.js';

const EXPRS = ['neutral', 'happy', 'sad', 'angry', 'shy', 'love', 'surprise', 'sleepy'];
const BG_KEYS = ['cafe', 'classroom', 'park', 'bedroom', 'city', 'beach', 'temple', 'living_room', 'street', 'school'];

const DEFAULT_SETTINGS = {
    enabled: false,          // overlay visible
    instruct: true,          // inject scene-tag instruction into prompts
    typewriter: true,
    petals: true,
    autoTranslate: false,
    provider: 'google',      // google | libre
    libreUrl: 'https://libretranslate.com/translate',
    libreKey: '',
    targetLang: 'ru',
    customBgs: '',           // "name=url" per line
    cache: {},               // chatKey -> { mesId -> { t, tl } }
};

const SCENE_TAG_RE = /<<\s*scene\s*:\s*([^>]*?)>>/gi;

// ---------------------------------------------------------------- settings

function getSettings() {
    if (extension_settings.vnt === undefined) extension_settings.vnt = {};
    const s = extension_settings.vnt;
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = v;
    }
    return s;
}

// ---------------------------------------------------------------- scene tag

export function parseSceneTag(raw) {
    const out = {};
    if (!raw) return out;
    const matches = [...raw.matchAll(SCENE_TAG_RE)];
    if (!matches.length) return out;
    const body = matches[matches.length - 1][1];
    for (const m of body.matchAll(/(\w+)\s*=\s*([^\s,;|]+)/g)) {
        out[m[1].toLowerCase()] = m[2].toLowerCase();
    }
    return out;
}

export function stripSceneTags(text) {
    return String(text ?? '').replace(SCENE_TAG_RE, '').trim();
}

function sceneInstruction() {
    return [
        '[Scene direction: End every response with a single tag <<scene: expression=NAME, background=NAME>>.',
        `expression: one of ${EXPRS.join(', ')}.`,
        `background: one of ${allBgKeys().join(', ')}.`,
        'The tag must be the last line of the reply, no markdown around it. Do not mention the tag in prose.]',
    ].join(' ');
}

// ---------------------------------------------------------------- backgrounds

function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h;
}

function placeholderGradient(key) {
    const H = hash(key || 'night') % 360;
    return `linear-gradient(160deg, hsl(${H} 45% 22%), hsl(${(H + 40) % 360} 35% 10%))`;
}

function allBgKeys() {
    return ['cafe', 'classroom', 'park', 'bedroom', 'city', 'beach', 'temple', 'living_room', 'street', 'school'];
}

function bgUrl(key) {
    const s = getSettings();
    for (const line of (s.customBgs || '').split('\n')) {
        const [name, url] = line.split('=').map(x => x?.trim());
        if (name && url && name.trim().toLowerCase() === key) return url;
    }
    return '';
}

// ---------------------------------------------------------------- dom helpers

function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- overlay

let ui = null;          // overlay root
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
            <button class="vnt-btn vnt-act-petals" title="Petals"><i class="fa-solid fa-seedling"></i></button>
            <button class="vnt-btn vnt-act-translate" title="Translate last reply"><i class="fa-solid fa-language"></i></button>
            <button class="vnt-btn vnt-act-close" title="Exit VN mode"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="vnt-backlog vnt-hidden"><div class="vnt-backlog-list"></div></div>
        <div class="vnt-dialog">
            <div class="vnt-namerow"><img class="vnt-chip" alt=""><div class="vnt-name"></div></div>
            <div class="vnt-text"></div>
            <div class="vnt-translation"></div>
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
    ui.querySelector('.vnt-act-translate').addEventListener('click', async () => {
        const ctx = getContext();
        const mes = lastAiMessage();
        if (!mes) return;
        await translateMessage(mes.id);
        showTranslationUnderMessageById(mes.id);
        refresh();
    });
}

function setEnabled(on) {
    const s = getSettings();
    s.enabled = on;
    saveSettingsDebounced();
    if (!ui) buildOverlay();
    ui.classList.toggle('vnt-hidden', !on);
    if (on) {
        updateInstruction();
        refresh();
        if (s.petals) startPetals();
    } else {
        stopPetals();
        clearInstruction();
        stopTypewriter();
    }
}

function overlayVisible() {
    return ui && !ui.classList.contains('vnt-hidden');
}

// ---------------------------------------------------------------- chat access

function chatKey() {
    const ctx = getContext();
    return ctx.groupId ? `g:${ctx.groupId}` : `c:${ctx.chatId ?? 'none'}`;
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

// ---------------------------------------------------------------- rendering

function setSprite(url) {
    const a = ui.querySelector('.vnt-sprite-a');
    const b = ui.querySelector('.vnt-sprite-b');
    const chip = ui.querySelector('.vnt-chip');
    if (!url) {
        a.removeAttribute('src'); b.removeAttribute('src');
        chip.removeAttribute('src');
        return;
    }
    // probe natural size: tiny ST avatars become a face chip, big art stays on stage
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

function refresh() {
    if (!overlayVisible()) return;
    const ctx = getContext();
    const chat = ctx.chat ?? [];
    const last = lastAiMessage();
    const char = ctx.characters?.[ctx.characterId];
    const chName = ctx.groupId ? (last?.mes?.name ?? ctx.name2) : (char?.name ?? ctx.name2);

    // avatar sprite
    let avatarUrl = '';
    if (ctx.groupId && last?.mes?.force_avatar) {
        avatarUrl = last.mes.force_avatar;
    } else if (char?.avatar) {
        avatarUrl = `/thumbnail?type=avatar&file=${encodeURIComponent(char.avatar)}`;
    }
    setSprite(avatarUrl);

    if (last) {
        const scene = parseSceneTag(last.mes.mes);
        const expr = scene.expression || 'neutral';
        const text = stripSceneTags(last.mes.mes);
        const filter = exprFilter(expr);
        const stageImg = ui.querySelector('.vnt-sprite img.vnt-in') ?? ui.querySelector('.vnt-sprite img');
        stageImg.style.filter = filter;
        const chip = ui.querySelector('.vnt-chip');
        chip.style.filter = filter;
        ui.querySelector('.vnt-name').textContent = last.mes.name || chName || '...';
        const tEl = ui.querySelector('.vnt-text');
        if (/<[a-z!][^\s>]*>/i.test(text) || !getSettings().typewriter) {
            // formatted HTML (VTK blocks, colors, comments) — render like ST chat does
            stopTypewriter();
            tEl.innerHTML = messageFormatting(text, last.mes.name || chName || '', false, false, false);
            tEl.scrollTop = tEl.scrollHeight;
        } else {
            typewrite(tEl, text);
        }
        const tr = cachedTranslation(last.id);
        const trEl = ui.querySelector('.vnt-translation');
        trEl.textContent = tr ? tr : '';
        trEl.style.display = tr ? '' : 'none';
        trEl.scrollTop = 0;
        if (scene.background) setBackground(scene.background);
        else setBackground('night');
    }
}

function renderBacklog() {
    const list = ui.querySelector('.vnt-backlog-list');
    list.innerHTML = '';
    const chat = getContext().chat ?? [];
    const from = Math.max(0, chat.length - 30);
    for (let i = from; i < chat.length; i++) {
        const m = chat[i];
        if (m.is_system) continue;
        const row = el('div', 'vnt-backlog-row' + (m.is_user ? ' vnt-user' : ''));
        const name = m.is_user ? (m.name || getContext().name1) : (m.name || getContext().name2);
        row.appendChild(el('div', 'vnt-backlog-name', esc(name)));
        row.appendChild(el('div', 'vnt-backlog-text', esc(stripSceneTags(m.mes))));
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

// ---------------------------------------------------------------- prompt injection

function updateInstruction() {
    const ctx = getContext();
    if (typeof ctx.setExtensionPrompt !== 'function') return;
    const s = getSettings();
    const types = ctx.extension_prompt_types ?? {};
    if (s.enabled && s.instruct) {
        ctx.setExtensionPrompt('vnt_scene', sceneInstruction(), types.IN_PROMPT ?? 0, 4, false, 0);
    } else {
        ctx.setExtensionPrompt('vnt_scene', '', types.IN_PROMPT ?? 0, 4, false, 0);
    }
}

function clearInstruction() {
    const ctx = getContext();
    if (typeof ctx.setExtensionPrompt !== 'function') return;
    const types = ctx.extension_prompt_types ?? {};
    ctx.setExtensionPrompt('vnt_scene', '', types.IN_PROMPT ?? 0, 4, false, 0);
}

// ---------------------------------------------------------------- translation

async function fetchTranslation(text) {
    const s = getSettings();
    const body = stripSceneTags(text);
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
    // google gtx (default, CORS-friendly)
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
    // keep cache small: 200 entries per chat
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

function showTranslationUnderMessage(mesEl, id) {
    const t = cachedTranslation(id);
    let box = mesEl.querySelector('.vn-translation');
    if (!t) { box?.remove(); return; }
    if (!box) {
        box = el('div', 'vn-translation');
        const text = mesEl.querySelector('.mes_text');
        text?.after(box);
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

function decorateAllMessages() {
    document.querySelectorAll('#chat .mes').forEach(m => decorateMessage(Number(m.getAttribute('mesid'))));
}

function decorateMessage(id) {
    const mesEl = document.querySelector(`#chat .mes[mesid="${id}"]`);
    if (!mesEl) return;
    decorateButtons(mesEl);
    stripInDom(mesEl);
    showTranslationUnderMessage(mesEl, id);
}

function decorateButtons(mesEl) {
    const buttons = mesEl.querySelector('.mes_buttons');
    if (buttons && !buttons.querySelector('.vn-tbtn')) {
        const id = Number(mesEl.getAttribute('mesid'));
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
}

// ---------------------------------------------------------------- events

let evtBound = false;
function bindEvents() {
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        refresh();
        const last = lastAiMessage();
        decorateMessage(last?.id ?? -1);
        if (getSettings().autoTranslate && last) {
            translateMessage(last.id)
                .then(() => { refresh(); showTranslationUnderMessageById(last.id); })
                .catch(e => toastr.error(String(e), 'VN Theatre'));
        }
    });
    eventSource.on(event_types.MESSAGE_UPDATED, (id) => { decorateMessage(Number(id)); refresh(); });
    eventSource.on(event_types.MESSAGE_DELETED, scrubAllMessages);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(() => { decorateAllMessages(); refresh(); }, 300);
    });
    eventSource.on(event_types.APP_READY, () => setTimeout(decorateAllMessages, 500));
}

// ---------------------------------------------------------------- settings ui

function buildSettings() {
    const s = getSettings();
    const html = `
    <div id="vnt-settings" class="extension_settings">
        <div class="vnt-set-row"><label class="checkbox_label"><input id="vnt-set-auto" type="checkbox" ${s.autoTranslate ? 'checked' : ''}/> ${'Auto-translate new replies'}</label></div>
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
    q('#vnt-set-auto').addEventListener('change', e => { s.autoTranslate = e.target.checked; saveSettingsDebounced(); });
    q('#vnt-set-lang').addEventListener('change', e => { s.targetLang = e.target.value.trim() || 'ru'; saveSettingsDebounced(); });
    q('#vnt-set-provider').addEventListener('change', e => { s.provider = e.target.value; saveSettingsDebounced(); });
    q('#vnt-set-libre').addEventListener('change', e => { s.libreUrl = e.target.value.trim(); saveSettingsDebounced(); });
    q('#vnt-set-key').addEventListener('change', e => { s.libreKey = e.target.value.trim(); saveSettingsDebounced(); });
    q('#vnt-set-bgs').addEventListener('change', e => { s.customBgs = e.target.value; saveSettingsDebounced(); refresh(); });
    q('#vnt-set-clear').addEventListener('click', () => { s.cache = {}; saveSettingsDebounced(); toastr.success('Translation cache cleared', 'VN Theatre'); });
}

// ---------------------------------------------------------------- init

function addMenuButton() {
    const host = document.querySelector('#extensionsMenu');
    if (!host) return;
    const btn = el('div', 'list-group-item flex-container flexFlowColumn flexNoGap interactable vnt-menu-btn');
    btn.innerHTML = `<div class="fa-solid fa-clapperboard"></div><span>VN Theatre</span>`;
    btn.title = 'Toggle visual-novel theatre view';
    btn.addEventListener('click', () => setEnabled(!getSettings().enabled));
    host.appendChild(btn);
}

jQuery(() => {
    getSettings();
    buildOverlay();
    buildSettings();
    addMenuButton();
    bindEvents();
    if (getSettings().enabled) setEnabled(true);
    setTimeout(decorateAllMessages, 800);
});
