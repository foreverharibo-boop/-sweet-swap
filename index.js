const MODULE_ID = 'sweet_swap';
const DATA_KEY = 'sweet_swap_data_v1';
const PROMPT_KEY = 'sweet_swap_once';
const LOG_PREFIX = '[sweet swap]';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    ageConfirmed: false,
    defaultMode: 'blind',
    autoBurnAfterStart: false,
    keepSaved: 50,
    connectionProfileId: '',
});

// 모드별 장면 진행 턴 수 기본값 (설정에서 1~3턴으로 바꿀 수 있음)
const DEFAULT_SCENE_TURNS = Object.freeze({
    random: 1,
    draw: 3,
    blend: 3,
    blind: 3,
    simultaneous: 3,
    partial: 3,
});

const MODE_LABELS = Object.freeze({
    random: '🎲 완전 랜덤 봉투',
    draw: '한 장 뽑기',
    blend: '두 장 섞기',
    blind: '블라인드 시작',
    simultaneous: '동시 공개',
    partial: '부분 공개',
});

const state = {
    initialized: false,
    busy: false,
    tab: 'swap',
    mode: 'blind',
    userCard: null,
    characterCard: null,
    exchange: null,
    randomExclude: '',
    selectedSavedId: null,
    scopeKey: null,
    promptArmed: false,
    promptConsumed: false,
    promptScopeKey: null,
    promptExchange: null,
    promptTurn: 0,
    promptTurnsTotal: 0,
    lastConsumed: null,
    consumingChatLength: 0,
};

let dataCache = null;
let coreModulePromise = null;
let sharedModulePromise = null;
let cachedConnectionProfiles = [];
let modalViewportGuardInstalled = false;
let draftSaveTimer = null;
let activeAbortController = null;
let modalPinFrame = null;
let modalPinTimer = null;

const DRAFT_FIELD_IDS = ['ss-title', 'ss-situation', 'ss-location', 'ss-mood', 'ss-role', 'ss-must', 'ss-exclude', 'ss-note', 'ss-random-exclude'];

function context() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

function settingsRoot() {
    const ctx = context();
    return ctx?.extensionSettings ?? ctx?.extension_settings ?? null;
}

function settings() {
    const root = settingsRoot();
    if (!root) return structuredClone(DEFAULT_SETTINGS);
    if (!root[MODULE_ID]) root[MODULE_ID] = {};
    root[MODULE_ID] = Object.assign({}, DEFAULT_SETTINGS, root[MODULE_ID]);
    return root[MODULE_ID];
}

function saveSettings() {
    const ctx = context();
    const save = ctx?.saveSettingsDebounced ?? globalThis.saveSettingsDebounced;
    if (typeof save === 'function') save();
}

function toast(type, message) {
    const target = globalThis.toastr?.[type];
    if (typeof target === 'function') target(message, '💝sweet swap');
    else console[type === 'error' ? 'error' : 'log'](`${LOG_PREFIX} ${message}`);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function uid(prefix = 'ss') {
    if (globalThis.crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso() {
    return new Date().toISOString();
}

function formatDate(value) {
    try {
        return new Intl.DateTimeFormat('ko-KR', {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        }).format(new Date(value));
    } catch {
        return '';
    }
}

function currentScope() {
    const ctx = context();
    if (!ctx) return { key: 'none', name: '채팅 없음', kind: 'none' };

    if (ctx.groupId) {
        const group = (ctx.groups ?? []).find(item => String(item.id) === String(ctx.groupId));
        return {
            key: `group:${ctx.groupId}`,
            name: group?.name || '그룹 채팅',
            kind: 'group',
        };
    }

    const character = ctx.characters?.[ctx.characterId];
    if (!character) return { key: 'none', name: '채팅 없음', kind: 'none' };
    const stableId = character.avatar || character.data?.extensions?.chub?.full_path || character.name || ctx.characterId;
    return {
        key: `character:${stableId}`,
        name: character.name || '캐릭터',
        kind: 'character',
    };
}

function emptyData() {
    return { version: 3, drafts: {}, saved: {}, recentCharacterCards: {}, recentRandomEnvelopes: {} };
}

async function loadData() {
    if (dataCache) return dataCache;
    const store = globalThis.SillyTavern?.libs?.localforage;
    if (!store) {
        try {
            dataCache = JSON.parse(localStorage.getItem(DATA_KEY) || 'null') || emptyData();
        } catch {
            dataCache = emptyData();
        }
    } else {
        dataCache = await store.getItem(DATA_KEY) || emptyData();
    }
    dataCache.version = Math.max(3, Number(dataCache.version) || 1);
    dataCache.drafts ??= {};
    dataCache.saved ??= {};
    dataCache.recentCharacterCards ??= {};
    // 예전 버전은 랜덤 봉투 기록을 모든 캐릭터가 공용으로 썼다. 캐릭터별 구조로 바꾸며 옛 공용 기록은 비운다.
    if (!dataCache.recentRandomEnvelopes || Array.isArray(dataCache.recentRandomEnvelopes)) dataCache.recentRandomEnvelopes = {};
    return dataCache;
}

async function saveData() {
    const store = globalThis.SillyTavern?.libs?.localforage;
    if (store) await store.setItem(DATA_KEY, dataCache || emptyData());
    else localStorage.setItem(DATA_KEY, JSON.stringify(dataCache || emptyData()));
}

async function loadScopeState() {
    const scope = currentScope();
    const data = await loadData();
    const draft = data.drafts[scope.key];
    state.userCard = draft?.userCard || null;
    state.characterCard = draft?.characterCard || null;
    state.exchange = draft?.exchange || null;
    state.randomExclude = draft?.randomExclude || '';
    state.mode = draft?.mode || settings().defaultMode;
    state.selectedSavedId = null;
    state.scopeKey = scope.key;
}

async function persistDraft() {
    const scopeKey = state.scopeKey || currentScope().key;
    const data = await loadData();
    data.drafts[scopeKey] = {
        userCard: state.userCard,
        characterCard: state.characterCard,
        exchange: state.exchange,
        randomExclude: state.randomExclude,
        mode: state.mode,
        updatedAt: nowIso(),
    };
    await saveData();
}

function captureUserFormIfVisible() {
    if (state.tab !== 'swap') return;
    if (state.mode === 'random') {
        state.randomExclude = document.getElementById('ss-random-exclude')?.value?.trim() || '';
        return;
    }
    if (!document.getElementById('ss-title')) return;
    const candidate = readUserForm();
    state.userCard = cardHasContent(candidate) ? candidate : null;
}

function invalidateExchangeAfterUserEdit() {
    if (!state.exchange) return;
    state.exchange = null;
    const overlay = document.getElementById('sweet-swap-overlay');
    const result = overlay?.querySelector('.ss-exchange-panel .ss-result');
    if (result) result.innerHTML = exchangeResultHtml(null);
    overlay?.querySelector('.ss-exchange-panel .ss-result-actions')?.remove();
    toast('info', '카드 내용을 바꿨으니 다시 교환해줘.');
}

function scheduleDraftSave() {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => {
        captureUserFormIfVisible();
        persistDraft();
    }, 600);
}

function flushDraftSave() {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
    captureUserFormIfVisible();
    persistDraft();
}

function normalizeFields(raw = {}) {
    const text = value => typeof value === 'string' ? value.trim() : '';
    return {
        title: text(raw.title) || '봉인된 카드',
        situation: text(raw.situation),
        location: text(raw.location),
        mood: text(raw.mood),
        desiredRole: text(raw.desiredRole ?? raw.desired_role),
        mustInclude: text(raw.mustInclude ?? raw.must_include),
        exclude: text(raw.exclude),
        note: text(raw.note),
    };
}

function makeCard(owner, fields) {
    return {
        id: uid('card'),
        owner,
        fields: normalizeFields(fields),
        createdAt: nowIso(),
    };
}

function cardHasContent(card) {
    if (!card?.fields) return false;
    return Object.entries(card.fields).some(([key, value]) => key !== 'title' && String(value || '').trim());
}

function readUserForm() {
    const get = id => document.getElementById(id)?.value?.trim() || '';
    return makeCard('user', {
        title: get('ss-title') || '나의 봉인 카드',
        situation: get('ss-situation'),
        location: get('ss-location'),
        mood: get('ss-mood'),
        desiredRole: get('ss-role'),
        mustInclude: get('ss-must'),
        exclude: get('ss-exclude'),
        note: get('ss-note'),
    });
}

function cardToPrompt(card) {
    const f = card?.fields || {};
    return [
        `Title: ${f.title || ''}`,
        `Situation: ${f.situation || ''}`,
        `Location: ${f.location || ''}`,
        `Mood: ${f.mood || ''}`,
        `Desired dynamic or role: ${f.desiredRole || ''}`,
        `Must include: ${f.mustInclude || ''}`,
        `Exclude / boundaries: ${f.exclude || ''}`,
        `Private note: ${f.note || ''}`,
    ].join('\n');
}

function safeJson(text) {
    const source = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    try {
        return JSON.parse(source);
    } catch {
        const start = source.indexOf('{');
        const end = source.lastIndexOf('}');
        if (start < 0 || end <= start) {
            console.warn(`${LOG_PREFIX} AI 응답에 JSON 괄호가 없음 (원문):`, source);
            throw new Error('JSON 형식의 카드가 반환되지 않았어요. (콘솔에서 원문 확인 가능)');
        }
        const sliced = source.slice(start, end + 1);
        try {
            return JSON.parse(sliced);
        } catch (innerError) {
            // 흔한 사소한 오류(트레일링 콤마)는 한 번 더 복구 시도
            const repaired = sliced.replace(/,\s*([}\]])/g, '$1');
            try {
                return JSON.parse(repaired);
            } catch {
                console.warn(`${LOG_PREFIX} JSON 파싱 실패 (원문):`, sliced);
                throw innerError;
            }
        }
    }
}

function isAbortError(error) {
    let current = error;
    for (let depth = 0; current && depth < 5; depth++) {
        if (current.name === 'AbortError') return true;
        current = current.cause;
    }
    return false;
}

async function loadConnectionService() {
    const fromContext = context()?.ConnectionManagerRequestService;
    if (fromContext) return fromContext;

    sharedModulePromise ??= import('/scripts/extensions/shared.js').catch(error => {
        console.warn(`${LOG_PREFIX} shared module import failed`, error);
        return {};
    });
    const shared = await sharedModulePromise;
    return shared?.ConnectionManagerRequestService ?? null;
}

function profileLabel(profile) {
    const detail = [profile?.api, profile?.model].filter(Boolean).join(' · ');
    return profile?.name || detail || '이름 없는 연결 프로필';
}

async function getSupportedConnectionProfiles() {
    const service = await loadConnectionService();
    if (!service || typeof service.getSupportedProfiles !== 'function') return [];
    try {
        cachedConnectionProfiles = service.getSupportedProfiles() || [];
    } catch (error) {
        console.warn(`${LOG_PREFIX} connection profiles unavailable`, error);
        cachedConnectionProfiles = [];
    }
    return cachedConnectionProfiles;
}

async function selectedConnection() {
    const profileId = settings().connectionProfileId;
    if (!profileId) throw new Error('확장 설정에서 sweet swap 전용 연결 프로필을 먼저 선택해줘.');

    const service = await loadConnectionService();
    if (!service || typeof service.sendRequest !== 'function') {
        throw new Error('SillyTavern 연결 프로필 요청 기능을 찾지 못했어요.');
    }

    const profiles = await getSupportedConnectionProfiles();
    const profile = profiles.find(item => String(item.id) === String(profileId));
    if (!profile) throw new Error('선택한 연결 프로필을 사용할 수 없어요. 확장 설정에서 다시 골라줘.');
    return { service, profile };
}

function clipText(value, maxLength) {
    const text = String(value ?? '').trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}\n[truncated]`;
}

function plainMessageText(value) {
    const source = String(value ?? '')
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/<\/p\s*>/gi, '\n');
    if (!source.includes('<') || typeof globalThis.document?.createElement !== 'function') return source;
    const holder = globalThis.document.createElement('div');
    holder.innerHTML = source;
    return holder.textContent || holder.innerText || '';
}

function recentSceneContext(limit = 8, anonymizeSpeakers = false) {
    const ctx = context();
    if (!ctx) return 'No recent roleplay scene is available.';

    const character = ctx.characters?.[ctx.characterId];
    const recentChat = (ctx.chat || [])
        .filter(message => !message?.is_system && !message?.is_hidden && !message?.extra?.hidden && !message?.extra?.isSmallSys)
        .slice(-limit)
        .map(message => {
            const content = clipText(plainMessageText(message?.mes ?? message?.text ?? message?.content), 1200);
            if (!content) return '';
            const speaker = anonymizeSpeakers
                ? (message?.is_user ? 'USER' : 'OTHER PARTICIPANT')
                : (message?.is_user
                    ? (ctx.name1 || 'User')
                    : (message?.name || character?.name || ctx.name2 || 'Character'));
            return `${speaker}: ${content}`;
        }).filter(Boolean).join('\n\n');

    return recentChat || 'No messages yet.';
}

function currentRoleplayContext() {
    const ctx = context();
    if (!ctx) return 'No roleplay context is available.';

    const character = ctx.characters?.[ctx.characterId];
    const characterData = character?.data || character || {};
    const profile = [
        character?.name && `Name: ${character.name}`,
        characterData.description && `Description: ${clipText(characterData.description, 3000)}`,
        characterData.personality && `Personality: ${clipText(characterData.personality, 2200)}`,
        characterData.scenario && `Scenario: ${clipText(characterData.scenario, 2200)}`,
    ].filter(Boolean);

    if (ctx.groupId) {
        const group = (ctx.groups ?? []).find(item => String(item.id) === String(ctx.groupId));
        const memberKeys = group?.members || [];
        const members = memberKeys.map(key => {
            const match = (ctx.characters ?? []).find(item => item.avatar === key || String(item.id) === String(key));
            return match?.name || key;
        }).filter(Boolean);
        profile.unshift(`Group: ${group?.name || currentScope().name}${members.length ? `\nMembers: ${members.join(', ')}` : ''}`);
    }

    const recentChat = recentSceneContext(8);

    return [
        profile.length ? `CHARACTER / GROUP\n${profile.join('\n\n')}` : '',
        `RECENT CHAT (oldest to newest)\n${recentChat}`,
    ].filter(Boolean).join('\n\n');
}

function cancelBackgroundGenerate() {
    if (!activeAbortController) return;
    activeAbortController.abort();
    activeAbortController = null;
}

async function backgroundGenerate(prompt, options = {}) {
    const { service, profile } = await selectedConnection();
    const messages = [
        {
            role: 'system',
            content: 'You create a compact, unmistakably NSFW roleplay scenario card involving only consenting fictional adults. A merely romantic, suggestive, or non-sexual card is invalid: the core premise must be explicitly adult and sexual while respecting every supplied boundary. Return only valid JSON with the requested English keys. Write every human-readable field value in natural Korean; proper names may remain in their original spelling.',
        },
        { role: 'user', content: prompt },
    ];
    const controller = new AbortController();
    activeAbortController = controller;

    const requestOnce = async (stream) => {
        const output = await service.sendRequest(profile.id, messages, 3000, {
            stream,
            signal: controller.signal,
            extractData: true,
            includePreset: options.includePreset ?? true,
            includeInstruct: options.includeInstruct ?? true,
        });
        if (stream && typeof output === 'function') {
            let text = '';
            for await (const chunk of output()) text = chunk?.text ?? text;
            return text;
        }
        return typeof output === 'string' ? output : output?.content ?? output?.text;
    };

    try {
        let content;
        try {
            // 스트리밍으로 받아 연결이 오래 조용해서 끊기는 문제를 줄인다.
            content = await requestOnce(true);
        } catch (error) {
            if (controller.signal.aborted) throw error; // 사용자가 직접 취소한 경우
            console.warn(`${LOG_PREFIX} 스트리밍 요청 실패, 일반 요청으로 1회 재시도`, error);
            try {
                content = await requestOnce(false);
            } catch (retryError) {
                if (controller.signal.aborted) throw retryError;
                if (isAbortError(retryError)) {
                    throw new Error('연결이 중간에 끊겼어요. 화면을 켜 둔 채 잠시 뒤 다시 시도해줘.');
                }
                throw retryError;
            }
        }
        if (!content) throw new Error('전용 연결 프로필에서 빈 응답이 돌아왔어요.');
        return typeof content === 'string' ? content : JSON.stringify(content);
    } finally {
        if (activeAbortController === controller) activeAbortController = null;
    }
}

function comparableCardText(card) {
    const fields = card?.fields || {};
    return [fields.situation, fields.location, fields.mood, fields.desiredRole, fields.mustInclude]
        .filter(Boolean)
        .join(' ')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

function cardTextBigrams(text) {
    const compact = text.replace(/\s+/g, '');
    const result = new Set();
    for (let index = 0; index < compact.length - 1; index++) result.add(compact.slice(index, index + 2));
    return result;
}

function cardSimilarity(left, right) {
    const a = comparableCardText(left);
    const b = comparableCardText(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const aSet = cardTextBigrams(a);
    const bSet = cardTextBigrams(b);
    if (!aSet.size || !bSet.size) return 0;
    let shared = 0;
    for (const item of aSet) if (bSet.has(item)) shared++;
    return (2 * shared) / (aSet.size + bSet.size);
}

function recentCharacterCards(limit = 3) {
    const scopeKey = state.scopeKey || currentScope().key;
    return (dataCache?.recentCharacterCards?.[scopeKey] || []).slice(0, limit);
}

function recentCharacterCardsBlock() {
    const cards = recentCharacterCards(3);
    if (!cards.length) return '';
    return `RECENT CHARACTER CARDS — DO NOT REPEAT OR CLOSELY PARAPHRASE THESE CONCEPTS
${cards.map((card, index) => `${index + 1}. ${clipText(cardToPrompt(card), 900)}`).join('\n\n')}`;
}

async function rememberCharacterCard(card) {
    const data = await loadData();
    const scopeKey = state.scopeKey || currentScope().key;
    data.recentCharacterCards[scopeKey] ??= [];
    data.recentCharacterCards[scopeKey].unshift(structuredClone(card));
    data.recentCharacterCards[scopeKey] = data.recentCharacterCards[scopeKey].slice(0, 3);
}

function recentRandomEnvelopes(limit = 3) {
    const scopeKey = state.scopeKey || currentScope().key;
    return (dataCache?.recentRandomEnvelopes?.[scopeKey] || []).slice(0, limit);
}

function recentRandomEnvelopesBlock() {
    const cards = recentRandomEnvelopes(3);
    if (!cards.length) return '';
    return `RECENT RANDOM ENVELOPES — DO NOT REPEAT OR CLOSELY PARAPHRASE THESE CONCEPTS
${cards.map((card, index) => `${index + 1}. ${clipText(cardToPrompt(card), 900)}`).join('\n\n')}`;
}

async function rememberRandomEnvelope(card) {
    const data = await loadData();
    const scopeKey = state.scopeKey || currentScope().key;
    data.recentRandomEnvelopes[scopeKey] ??= [];
    data.recentRandomEnvelopes[scopeKey].unshift(structuredClone(card));
    data.recentRandomEnvelopes[scopeKey] = data.recentRandomEnvelopes[scopeKey].slice(0, 3);
}

async function generateValidatedCard(prompt, owner, avoidCards = [], requestOptions = {}) {
    let retryPrompt = prompt;
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt++) {
        const response = await backgroundGenerate(retryPrompt, requestOptions);
        let card = null;
        try {
            const parsed = safeJson(response);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('올바른 카드 내용이 아니에요.');
            card = makeCard(owner, parsed);
            if (!cardHasContent(card)) throw new Error('AI가 내용이 비어 있는 카드를 보냈어요.');
            if (avoidCards.some(previous => cardSimilarity(card, previous) >= 0.82)) {
                throw new Error('최근 캐릭터 카드와 너무 비슷한 카드가 나왔어요.');
            }
            return card;
        } catch (error) {
            console.warn(`${LOG_PREFIX} 카드 생성 ${attempt + 1}번째 시도 실패: ${error?.message}`, response);
            lastError = error;
            if (attempt === 0) {
                retryPrompt = `${prompt}\n\nRETRY REQUIRED: The previous response was empty, invalid, too similar, insufficiently NSFW, or not written in Korean. Return a valid JSON card with a clearly different adult sexual situation, location, and dynamic. All human-readable field values must be in natural Korean.\n\nPREVIOUS INVALID RESULT\n${clipText(card ? cardToPrompt(card) : response, 900)}`;
            }
        }
    }

    throw lastError || new Error('카드를 제대로 만들지 못했어요.');
}

function recentSavedExchanges(limit = 2) {
    const list = dataCache?.saved?.[currentScope().key] || [];
    return list.slice(0, limit);
}

function exchangeRecapLine(exchange) {
    const pick = card => clipText(card?.fields?.situation || card?.fields?.title || '', 160);
    if (exchange.mode === 'random') return pick(exchange.randomCard);
    if (exchange.mode === 'blend') return pick(exchange.combinedCard);
    if (exchange.mode === 'draw') return pick(exchange.chosen === 'character' ? exchange.characterCard : exchange.userCard);
    const a = pick(exchange.userCard);
    const b = pick(exchange.characterCard);
    return [a, b].filter(Boolean).join(' / ');
}

function pastExchangesBlock() {
    const lines = recentSavedExchanges(2).map(exchangeRecapLine).filter(Boolean);
    if (!lines.length) return '';
    return `PAST SAVED EXCHANGES WITH THIS CHARACTER (most recent first — private history only the two of you know about; let it inform continuity where it naturally fits, don't just restate it)
${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}`;
}

function characterCardPrompt(userCard) {
    const scope = currentScope();
    const pastBlock = pastExchangesBlock();
    const recentCardsBlock = recentCharacterCardsBlock();
    return `You are creating one private, sealed fantasy-exchange card for ${scope.name} in the current fictional roleplay.

All participants in this feature must be fictional adults. Respect mutual consent and the known user boundaries below. Infer the character's private NSFW wish from their established personality, relationship, and recent chat history. Keep the character recognizably in-character; do not flatten them into a generic voice. The central premise MUST be explicitly adult and sexual. Do not downgrade it to flirting, dating, cuddling, kissing, vague tension, or a merely romantic scenario. Keep it as a compact scenario card rather than a completed scene.

CURRENT-SCENE CONTINUITY IS MANDATORY
Treat the most recent chat as the authoritative present moment. Static character-sheet Description and Scenario are background information only and MUST NOT replace, reset, or relocate the current scene. Build a wish that can emerge naturally from the characters' ongoing action, current relationship, mood, physical state, and established location.

The card's location must remain the current established location or an immediately adjacent part of it that requires no meaningful travel. Do not import a home, apartment, workplace, city, country, or other named setting from the character sheet unless the recent chat explicitly establishes that the characters are there now. Do not use a distant relocation, trip, major time skip, fantasy transport, or abrupt scene reset. If the exact location is unclear, write a neutral continuation such as "현재 머무는 방" rather than inventing a specific place. If an intimate scene is already underway, create a related next desire or variation that continues that scene instead of proposing an unrelated new encounter elsewhere.

LANGUAGE REQUIREMENT
Write every JSON field value in natural Korean, including the title and the character's note. Preserve proper names in their original spelling when appropriate. The JSON keys must remain exactly as specified in English.

This is an anonymous exchange. You must create the character's card independently: you are not shown the user's situation, location, mood, desired role, must-include items, or private note. Do not guess or claim to know them.

KNOWN USER BOUNDARIES ONLY
${userCard?.fields?.exclude || 'No additional boundary was entered.'}

CURRENT ROLEPLAY CONTEXT
${currentRoleplayContext()}
${pastBlock ? `\n${pastBlock}\n` : ''}
${recentCardsBlock ? `\n${recentCardsBlock}\n` : ''}
Return JSON only, with exactly these string fields:
{
  "title": "short evocative title",
  "situation": "the character's secretly desired situation",
  "location": "preferred location",
  "mood": "desired atmosphere",
  "desiredRole": "what dynamic or role the character wants",
  "mustInclude": "one or more important elements",
  "exclude": "boundaries; include the user's exclusions",
  "note": "a brief handwritten note in the character's own voice"
}`;
}

function blendPrompt(userCard, characterCard) {
    const pastBlock = pastExchangesBlock();
    return `Combine two sealed fantasy cards into one coherent, unmistakably NSFW private scenario card for the current fictional adult roleplay.

Preserve the most distinctive wish from each card. The combined core premise MUST be explicitly adult and sexual; do not reduce it to flirting, kissing, cuddling, vague tension, or ordinary romance. Mutual consent and all exclusions are mandatory; if the cards conflict, choose the safer compatible NSFW interpretation. Do not write the scene itself. Do not mention cards, prompts, rules, or an AI.

Write every JSON field value in natural Korean. Translate supplied content naturally without changing its meaning or boundaries. Proper names may remain in their original spelling. Keep the JSON keys exactly as specified in English.

USER CARD
${cardToPrompt(userCard)}

CHARACTER CARD
${cardToPrompt(characterCard)}
${pastBlock ? `\n${pastBlock}\n` : ''}
Return JSON only, with exactly these string fields:
{
  "title": "short combined title",
  "situation": "combined scenario",
  "location": "combined location",
  "mood": "combined atmosphere",
  "desiredRole": "combined dynamic",
  "mustInclude": "compatible important elements",
  "exclude": "all boundaries from both cards",
  "note": "a short atmospheric cue"
}`;
}

function randomEnvelopePrompt(exclude = '') {
    const recentBlock = recentRandomEnvelopesBlock();
    const sceneBlock = recentSceneContext(8, true);
    return `Create one context-light but scene-continuous, unmistakably NSFW sealed scenario envelope for a fictional roleplay involving consenting adults.

You are deliberately given NO character sheet, NO persona, and NO static relationship profile. You receive only an anonymized excerpt of the current scene so the envelope can remain physically and narratively plausible. Do not use or invent identifying character details, backstory, personality traits, addresses, or named locations that are not established in the excerpt.

Randomize the adult situation, dynamic, atmosphere, role reversal, or memorable twist — NOT the broad setting. The envelope must continue in the current established location or an immediately adjacent part of it that requires no meaningful travel. Do not relocate the scene to a different home, city, country, vehicle, remote facility, underwater setting, outer space, fantasy realm, historical era, or similarly unrelated place unless that setting is already established in the excerpt. Do not use a major time skip or abrupt scene reset. If the exact location is unclear, use a neutral phrase such as "현재 장소" or "현재 머무는 방" instead of inventing a specific place.

Be surprising while remaining realistic within the current scene. The central premise MUST be explicitly adult and sexual. Do not produce flirting, dating, cuddling, kissing, vague tension, or a merely romantic scenario. Keep it as a compact scenario card, not a completed scene. Do not mention an AI, prompt, Sweet Swap, or the limited context.

Write every JSON field value in natural Korean. Proper names, if unavoidable, may remain in their original spelling. Keep the JSON keys exactly as specified in English.

MANDATORY USER BOUNDARIES
${exclude || 'No additional boundary was entered.'}

ANONYMIZED CURRENT SCENE (oldest to newest; authoritative for continuity and location)
${sceneBlock}
${recentBlock ? `\n${recentBlock}\n` : ''}
Return JSON only, with exactly these string fields:
{
  "title": "short mysterious title",
  "situation": "a surprising adult continuation that fits the current scene",
  "location": "the current established location or an immediately adjacent part of it",
  "mood": "the atmosphere",
  "desiredRole": "a flexible dynamic that does not assume character identity",
  "mustInclude": "one memorable random twist",
  "exclude": "repeat all mandatory user boundaries; do not invent new ones",
  "note": "a cryptic one-line note from the unknown sender"
}`;
}

async function generateRandomEnvelope() {
    if (!settings().ageConfirmed) {
        toast('warning', '등장인물이 모두 성인임을 먼저 확인해줘.');
        state.tab = 'settings';
        renderModal();
        return;
    }

    state.randomExclude = document.getElementById('ss-random-exclude')?.value?.trim() ?? state.randomExclude;
    const recentCards = recentRandomEnvelopes(3);
    setBusy(true, '아무것도 모르는 미지의 봉투를 만드는 중…');
    try {
        const randomCard = await generateValidatedCard(
            randomEnvelopePrompt(state.randomExclude),
            'random',
            recentCards,
            { includePreset: false, includeInstruct: true },
        );
        state.exchange = {
            id: uid('swap'),
            mode: 'random',
            randomCard,
            randomExclude: state.randomExclude,
            revealed: false,
            createdAt: nowIso(),
        };
        await rememberRandomEnvelope(randomCard);
        await persistDraft();
        toast('success', '미지의 랜덤 봉투가 도착했어.');
    } catch (error) {
        if (isAbortError(error)) {
            toast('info', '랜덤 봉투 받기를 취소했어.');
        } else {
            console.error(LOG_PREFIX, error);
            toast('error', error?.message || '랜덤 봉투를 만들지 못했어요.');
        }
    } finally {
        setBusy(false);
        renderModal();
    }
}

async function generateCharacterCard() {
    const candidate = readUserForm();
    if (!cardHasContent(candidate)) {
        toast('warning', '먼저 내 카드에 한 가지 이상 적어줘.');
        return;
    }
    if (!settings().ageConfirmed) {
        toast('warning', '설정에서 등장인물이 모두 성인임을 먼저 확인해줘.');
        state.tab = 'settings';
        renderModal();
        return;
    }

    state.userCard = candidate;
    setBusy(true, '상대의 봉인 카드를 작성하는 중…');
    try {
        const recentCards = recentCharacterCards(3);
        state.characterCard = await generateValidatedCard(characterCardPrompt(candidate), 'character', recentCards);
        state.exchange = null;
        await rememberCharacterCard(state.characterCard);
        await persistDraft();
        toast('success', `${currentScope().name}의 카드가 도착했어.`);
    } catch (error) {
        if (isAbortError(error)) {
            toast('info', '카드 생성을 취소했어.');
        } else {
            console.error(LOG_PREFIX, error);
            toast('error', error?.message || '캐릭터 카드를 만들지 못했어요.');
        }
    } finally {
        setBusy(false);
        renderModal();
    }
}

async function exchangeCards() {
    if (state.mode === 'random') return generateRandomEnvelope();

    const candidate = readUserForm();
    state.userCard = cardHasContent(candidate) ? candidate : null;
    if (!cardHasContent(state.userCard)) {
        toast('warning', '내 카드를 먼저 봉인해줘.');
        return;
    }
    if (!cardHasContent(state.characterCard)) {
        toast('warning', '캐릭터 카드를 먼저 받아야 해.');
        return;
    }

    setBusy(true, state.mode === 'blend' ? '두 장의 카드를 섞는 중…' : '봉인된 카드를 교환하는 중…');
    try {
        let combinedCard = null;
        let chosen = null;
        if (state.mode === 'blend') {
            combinedCard = await generateValidatedCard(blendPrompt(state.userCard, state.characterCard), 'result');
        } else if (state.mode === 'draw') {
            chosen = Math.random() < 0.5 ? 'user' : 'character';
        }

        state.exchange = {
            id: uid('swap'),
            mode: state.mode,
            userCard: structuredClone(state.userCard),
            characterCard: structuredClone(state.characterCard),
            combinedCard,
            chosen,
            createdAt: nowIso(),
        };
        await persistDraft();
        toast('success', `${MODE_LABELS[state.mode]} 교환이 끝났어.`);
    } catch (error) {
        if (isAbortError(error)) {
            toast('info', '교환을 취소했어.');
        } else {
            console.error(LOG_PREFIX, error);
            toast('error', error?.message || '카드를 교환하지 못했어요.');
        }
    } finally {
        setBusy(false);
        renderModal();
    }
}

function sceneTurnCount(mode) {
    const fallback = DEFAULT_SCENE_TURNS[mode] ?? 1;
    const value = Math.round(Number(settings().sceneTurns?.[mode]));
    return Math.min(3, Math.max(1, Number.isFinite(value) ? value : fallback));
}

function stagedSceneDirection(turn, total) {
    if (total <= 1) {
        return 'Apply the sealed exchange in this response and establish its situation clearly enough for later chat messages to continue it.';
    }
    if (turn >= total) {
        return `PHASE ${turn} OF ${total} — FULL CONTINUATION
Continue directly from the existing scene without restarting or summarizing it. Now carry the card's adult premise forward naturally and fully while preserving the established pacing. Do not force an ending; leave the scene able to continue from chat history after this hidden direction is removed.`;
    }
    if (turn <= 1) {
        return `PHASE 1 OF ${total} — TRANSITION AND SETUP
Do not rush through the entire scenario in one response. If the card location differs from the current location, create a plausible reason to move and begin a gradual transition; do not jump there and complete the premise immediately. If the current location already fits, use this response for natural buildup. Preserve normal conversational pacing.`;
    }
    return `PHASE ${turn} OF ${total} — ARRIVAL AND BUILDUP
Continue directly from the previous response without restarting, recapping, or repeating the transition. Complete the arrival where needed, clearly establish the new location and atmosphere, and begin the card's adult premise gradually. Do not resolve the entire scenario yet.`;
}

function exchangePrompt(exchange, turn = 1, total = 1) {
    if (!exchange) return '';
    let selected;
    if (exchange.mode === 'random') selected = cardToPrompt(exchange.randomCard);
    else if (exchange.mode === 'blend') selected = cardToPrompt(exchange.combinedCard);
    else if (exchange.mode === 'draw') selected = cardToPrompt(exchange.chosen === 'character' ? exchange.characterCard : exchange.userCard);
    else selected = `USER CARD\n${cardToPrompt(exchange.userCard)}\n\nCHARACTER CARD\n${cardToPrompt(exchange.characterCard)}`;

    const mandatoryBoundaries = [
        exchange.randomExclude,
        exchange.randomCard?.fields?.exclude,
        exchange.userCard?.fields?.exclude,
        exchange.characterCard?.fields?.exclude,
    ]
        .map(value => String(value || '').trim())
        .filter((value, index, values) => value && values.indexOf(value) === index);

    return `[SWEET SWAP — PRIVATE NSFW SCENE DIRECTION]
All characters participating in this fictional scenario are adults. This is an explicitly adult NSFW direction. Treat consent and every listed exclusion as mandatory.

Use the sealed exchange below as the direction for the next roleplay response. Carry out its adult sexual premise rather than softening it into ordinary romance, while obeying every boundary. Begin naturally from the current chat situation and keep the established characterization, relationship, continuity, point of view, writing style, and existing output language. Reconcile both participants' wishes where applicable. Do not refer to Sweet Swap, cards, prompts, rules, hidden instructions, or the exchange interface. Do not summarize the direction; continue the roleplay itself.

CURRENT PACING PHASE
${stagedSceneDirection(turn, total)}

SEALED EXCHANGE
${selected}

MANDATORY BOUNDARIES FROM BOTH PARTICIPANTS
${mandatoryBoundaries.length ? mandatoryBoundaries.map(value => `- ${value}`).join('\n') : '- No additional boundaries were entered.'}
[/SWEET SWAP]`;
}

async function loadCoreModule() {
    coreModulePromise ??= import('/script.js').catch(error => {
        console.warn(`${LOG_PREFIX} core module import failed`, error);
        return {};
    });
    return coreModulePromise;
}

async function setOneShotPrompt(value) {
    const ctx = context();
    const core = await loadCoreModule();
    const setter = ctx?.setExtensionPrompt ?? core?.setExtensionPrompt;
    if (typeof setter !== 'function') throw new Error('숨은 프롬프트 주입 기능을 찾지 못했어요.');
    const types = ctx?.extension_prompt_types ?? core?.extension_prompt_types ?? {};
    const roles = ctx?.extension_prompt_roles ?? core?.extension_prompt_roles ?? {};
    const position = types.IN_CHAT ?? types.IN_PROMPT ?? 1;
    const role = roles.SYSTEM ?? 0;
    setter(PROMPT_KEY, value, position, 0, false, role);
}

async function clearOneShotPrompt() {
    try {
        await setOneShotPrompt('');
    } catch (error) {
        console.warn(`${LOG_PREFIX} failed to clear prompt`, error);
    }
    state.promptArmed = false;
    state.promptConsumed = false;
    state.promptScopeKey = null;
    state.promptExchange = null;
    state.promptTurn = 0;
    state.promptTurnsTotal = 0;
}

async function advanceScenePrompt() {
    if (!state.promptArmed || !state.promptConsumed) return;
    if (!state.promptExchange || state.promptTurn >= state.promptTurnsTotal) {
        await clearOneShotPrompt();
        return;
    }

    state.promptTurn += 1;
    state.promptConsumed = false;
    try {
        await setOneShotPrompt(exchangePrompt(state.promptExchange, state.promptTurn, state.promptTurnsTotal));
    } catch (error) {
        console.warn(`${LOG_PREFIX} failed to advance scene prompt`, error);
        await clearOneShotPrompt();
    }
}

// 스와이프·재생성: 마지막으로 적용한 단계의 지시를 다시 걸어 같은 단계로 답변을 새로 받는다.
async function rearmForRedo() {
    const last = state.lastConsumed;
    if (!last?.exchange || last.scopeKey !== currentScope().key) return;
    const length = context()?.chat?.length ?? 0;
    // 마지막 메시지가 그 단계에서 생성된 답변일 때만 다시 건다.
    if (length < last.chatLength || length > last.chatLength + 1) return;
    try {
        await setOneShotPrompt(exchangePrompt(last.exchange, last.turn, last.total));
    } catch (error) {
        console.warn(`${LOG_PREFIX} failed to re-arm scene prompt`, error);
        return;
    }
    state.promptArmed = true;
    state.promptConsumed = true;
    state.promptScopeKey = last.scopeKey;
    state.promptExchange = last.exchange;
    state.promptTurn = last.turn;
    state.promptTurnsTotal = last.total;
    state.consumingChatLength = last.chatLength;
}

async function triggerMainGeneration() {
    const ctx = context();
    const core = await loadCoreModule();
    const generate = ctx?.Generate ?? ctx?.generate ?? core?.Generate;
    if (typeof generate !== 'function') return false;
    await generate('normal');
    return true;
}

async function startScene() {
    if (!state.exchange) {
        toast('warning', '먼저 카드를 교환해줘.');
        return;
    }
    if (!settings().ageConfirmed) {
        toast('warning', '등장인물이 모두 성인임을 먼저 확인해줘.');
        return;
    }

    setBusy(true, '봉인을 열고 장면을 준비하는 중…');
    try {
        const promptExchange = structuredClone(state.exchange);
        const promptTurnsTotal = sceneTurnCount(promptExchange.mode);
        await setOneShotPrompt(exchangePrompt(promptExchange, 1, promptTurnsTotal));
        state.promptArmed = true;
        state.promptConsumed = false;
        state.lastConsumed = null;
        state.promptScopeKey = currentScope().key;
        state.promptExchange = promptExchange;
        state.promptTurn = 1;
        state.promptTurnsTotal = promptTurnsTotal;
        closeModal();

        const started = await triggerMainGeneration();
        if (started) toast('success', promptTurnsTotal > 1 ? `교환 결과를 ${promptTurnsTotal}턴에 걸쳐 천천히 시작했어.` : '교환 결과로 장면을 시작했어.');
        else toast('info', promptTurnsTotal > 1 ? `다음 메시지부터 교환 결과가 ${promptTurnsTotal}턴 동안 단계적으로 적용돼.` : '다음 메시지를 보내면 교환 결과가 한 번 적용돼.');

        if (settings().autoBurnAfterStart) {
            if (state.exchange?.mode === 'random') await burnRandomEnvelope(false);
            else await burnCurrent(false);
        }
    } catch (error) {
        await clearOneShotPrompt();
        console.error(LOG_PREFIX, error);
        toast('error', error?.message || '장면을 시작하지 못했어요.');
    } finally {
        setBusy(false);
    }
}

async function saveExchange() {
    if (!state.exchange) {
        toast('warning', '보관할 교환 결과가 없어.');
        return;
    }
    const scope = currentScope();
    const data = await loadData();
    data.saved[scope.key] ??= [];
    const existingIndex = data.saved[scope.key].findIndex(item => item.id === state.exchange.id);
    if (existingIndex >= 0) data.saved[scope.key][existingIndex] = structuredClone(state.exchange);
    else data.saved[scope.key].unshift(structuredClone(state.exchange));
    data.saved[scope.key] = data.saved[scope.key].slice(0, Math.max(1, Number(settings().keepSaved) || 50));
    await saveData();
    toast('success', '비밀 서랍에 보관했어.');
    renderModal();
}

async function burnCurrent(showToast = true) {
    const scope = currentScope();
    const data = await loadData();
    delete data.drafts[scope.key];
    state.userCard = null;
    state.characterCard = null;
    state.exchange = null;
    await saveData();
    if (showToast) toast('info', '현재 카드를 태웠어.');
    renderModal();
}

async function revealRandomEnvelope() {
    if (state.exchange?.mode !== 'random') return;
    state.exchange.revealed = true;
    await persistDraft();
    renderModal();
}

async function burnRandomEnvelope(showToast = true) {
    if (state.exchange?.mode !== 'random') return;
    state.exchange = null;
    await persistDraft();
    if (showToast) toast('info', '랜덤 봉투를 태웠어.');
    renderModal();
}

async function deleteSaved(id) {
    const scope = currentScope();
    const data = await loadData();
    data.saved[scope.key] = (data.saved[scope.key] || []).filter(item => item.id !== id);
    if (state.selectedSavedId === id) state.selectedSavedId = null;
    await saveData();
    toast('info', '보관된 교환 기록을 삭제했어.');
    renderModal();
}

async function revealSavedRandom(id) {
    const scope = currentScope();
    const data = await loadData();
    const item = (data.saved[scope.key] || []).find(entry => entry.id === id);
    if (!item || item.mode !== 'random') return;
    item.revealed = true;
    await saveData();
    renderModal();
}

function setBusy(value, label = '') {
    state.busy = value;
    const overlay = document.getElementById('sweet-swap-overlay');
    if (!overlay) return;
    overlay.classList.toggle('ss-is-busy', value);
    const labelElement = overlay.querySelector('.ss-busy-label');
    if (labelElement) labelElement.textContent = label;
    overlay.querySelectorAll('button, input, textarea, select').forEach(element => {
        if (element.dataset.action === 'cancel-busy' || element.dataset.action === 'close') return;
        element.disabled = value;
    });
}

function fieldRow(label, value) {
    if (!value) return '';
    return `<div class="ss-card-row"><span>${escapeHtml(label)}</span><p>${escapeHtml(value)}</p></div>`;
}

function cardHtml(card, options = {}) {
    if (options.hidden) {
        return `<article class="ss-card ss-card-hidden"><div class="ss-seal">💝</div><strong>봉인된 카드</strong><small>장면을 시작할 때 조용히 열려요.</small></article>`;
    }
    if (!card) return '<div class="ss-empty">아직 봉인된 카드가 없어요.</div>';
    const f = card.fields || {};
    const partial = options.partial;
    return `<article class="ss-card">
        <div class="ss-card-kicker">${escapeHtml(options.kicker || '')}</div>
        <h3>${escapeHtml(f.title || '봉인된 카드')}</h3>
        ${fieldRow('상황', f.situation)}
        ${fieldRow('장소', f.location)}
        ${fieldRow('분위기', f.mood)}
        ${partial ? '<div class="ss-partial-cover">나머지는 봉인되어 있어요.</div>' : `
            ${fieldRow('원하는 역할', f.desiredRole)}
            ${fieldRow('꼭 포함', f.mustInclude)}
            ${fieldRow('제외', f.exclude)}
            ${fieldRow('비밀 메모', f.note)}
        `}
    </article>`;
}

function exchangeResultHtml(exchange) {
    if (!exchange) {
        return state.mode === 'random'
            ? '<div class="ss-result-empty">아직 미지의 랜덤 봉투가 도착하지 않았어요.</div>'
            : '<div class="ss-result-empty">카드 두 장을 준비한 뒤 교환해봐.</div>';
    }
    if (exchange.mode === 'random') {
        if (!exchange.revealed) {
            return `<article class="ss-card ss-card-hidden"><div class="ss-seal">🎲</div><strong>미지의 랜덤 봉투</strong><small>캐릭터도, 채팅도 모르는 AI가 완전히 무작위로 만들었어요.</small></article>`;
        }
        return cardHtml(exchange.randomCard, { kicker: '열어본 미지의 랜덤 봉투' });
    }
    if (exchange.mode === 'blind') return cardHtml(null, { hidden: true });
    if (exchange.mode === 'blend') return cardHtml(exchange.combinedCard, { kicker: '두 장을 섞은 결과' });
    if (exchange.mode === 'draw') {
        const card = exchange.chosen === 'character' ? exchange.characterCard : exchange.userCard;
        const who = exchange.chosen === 'character' ? `${currentScope().name}의 카드` : '나의 카드';
        return cardHtml(card, { kicker: `뽑힌 카드 · ${who}` });
    }
    if (exchange.mode === 'partial') {
        return `<div class="ss-double-card">${cardHtml(exchange.userCard, { kicker: '나의 카드', partial: true })}${cardHtml(exchange.characterCard, { kicker: `${currentScope().name}의 카드`, partial: true })}</div>`;
    }
    return `<div class="ss-double-card">${cardHtml(exchange.userCard, { kicker: '나의 카드' })}${cardHtml(exchange.characterCard, { kicker: `${currentScope().name}의 카드` })}</div>`;
}

function randomSwapTabHtml(modes) {
    const exchange = state.exchange?.mode === 'random' ? state.exchange : null;
    return `<div class="ss-swap-grid">
        <section class="ss-paper ss-user-paper">
            <div class="ss-section-title"><span>🎲</span><div><b>완전 랜덤 봉투</b><small>캐릭터 시트 없이 최근 장면만 보고 내용은 무작위로 만들어요.</small></div></div>
            <div class="ss-info-box">AI는 캐릭터 시트·페르소나를 읽지 않고 최근 장면 8개에서 현재 상황과 장소만 참고해요. 아래 제외 요소를 지키며, 현재 장소 안에서 내용만 랜덤으로 만들고 최근 랜덤 봉투 3장과의 반복을 피합니다.</div>
            <label>랜덤 봉투에서도 제외할 요소<textarea id="ss-random-exclude" rows="4" placeholder="절대 나오면 안 되는 요소를 적어줘">${escapeHtml(state.randomExclude || '')}</textarea></label>
        </section>

        <section class="ss-paper ss-character-paper">
            <div class="ss-section-title"><span>?</span><div><b>미지의 봉투</b><small>열어보기 전까지 내용은 완전히 봉인돼요.</small></div></div>
            ${exchangeResultHtml(exchange)}
        </section>
    </div>

    <section class="ss-exchange-panel">
        <div class="ss-mode-row">
            <label>교환 방식<select id="ss-mode">${modes}</select></label>
            ${exchange ? '' : '<button class="ss-accent" data-action="exchange">랜덤 봉투 받기</button>'}
        </div>
        ${exchange ? `<div class="ss-result-actions">
            ${exchange.revealed ? '' : '<button class="ss-secondary" data-action="reveal-random">봉투 열기</button>'}
            <button class="ss-primary" data-action="start">${exchange.revealed ? '이 봉투로 장면 시작' : '봉인한 채 장면 시작'}</button>
            <button class="ss-secondary" data-action="reroll-random">다시 뽑기</button>
            <button class="ss-secondary" data-action="save">비밀 서랍에 보관</button>
            <button class="ss-danger" data-action="burn-random">봉투 태우기</button>
        </div>` : ''}
    </section>`;
}

function swapTabHtml() {
    const f = state.userCard?.fields || {};
    const modes = Object.entries(MODE_LABELS).map(([value, label]) => `<option value="${value}" ${state.mode === value ? 'selected' : ''}>${label}</option>`).join('');
    if (state.mode === 'random') return randomSwapTabHtml(modes);
    const charReady = Boolean(state.characterCard);
    return `<div class="ss-swap-grid">
        <section class="ss-paper ss-user-paper">
            <div class="ss-section-title"><span>01</span><div><b>나의 카드</b><small>작성한 내용은 봉인 전까지 자유롭게 바꿀 수 있어.</small></div></div>
            <label>카드 제목<input id="ss-title" type="text" value="${escapeHtml(f.title || '')}" placeholder="예: 비 오는 밤의 초대"></label>
            <label>원하는 상황<textarea id="ss-situation" rows="3" placeholder="어떤 상황을 원하는지 적어줘">${escapeHtml(f.situation || '')}</textarea></label>
            <div class="ss-two-col">
                <label>장소<input id="ss-location" type="text" value="${escapeHtml(f.location || '')}" placeholder="어디에서"></label>
                <label>분위기<input id="ss-mood" type="text" value="${escapeHtml(f.mood || '')}" placeholder="달달함, 긴장감…"></label>
            </div>
            <label>상대에게 바라는 역할<input id="ss-role" type="text" value="${escapeHtml(f.desiredRole || '')}" placeholder="원하는 관계나 주도권"></label>
            <div class="ss-two-col">
                <label>꼭 포함할 요소<textarea id="ss-must" rows="2">${escapeHtml(f.mustInclude || '')}</textarea></label>
                <label>제외할 요소<textarea id="ss-exclude" rows="2">${escapeHtml(f.exclude || '')}</textarea></label>
            </div>
            <label>비밀 메모<textarea id="ss-note" rows="2" placeholder="카드에만 남길 말">${escapeHtml(f.note || '')}</textarea></label>
            <button class="ss-primary" data-action="seal-user">봉인하고 상대 카드 받기</button>
        </section>

        <section class="ss-paper ss-character-paper">
            <div class="ss-section-title"><span>02</span><div><b>${escapeHtml(currentScope().name)}의 카드</b><small>현재 관계와 채팅을 바탕으로 조용히 작성돼.</small></div></div>
            ${charReady ? cardHtml(state.characterCard, { hidden: true }) : '<div class="ss-waiting-envelope"><div>💌</div><b>아직 편지가 오지 않았어요</b><small>내 카드를 봉인하면 상대가 답장을 써요.</small></div>'}
            ${charReady ? '<button class="ss-secondary" data-action="regenerate-character">상대 카드 다시 받기</button>' : ''}
        </section>
    </div>

    <section class="ss-exchange-panel">
        <div class="ss-mode-row">
            <label>교환 방식<select id="ss-mode">${modes}</select></label>
            <button class="ss-accent" data-action="exchange" ${!charReady ? 'disabled' : ''}>카드 교환하기</button>
        </div>
        <div class="ss-result">${exchangeResultHtml(state.exchange)}</div>
        ${state.exchange ? `<div class="ss-result-actions">
            <button class="ss-primary" data-action="start">장면 시작</button>
            <button class="ss-secondary" data-action="save">비밀 서랍에 보관</button>
            <button class="ss-danger" data-action="burn">카드 태우기</button>
        </div>` : ''}
    </section>`;
}

function savedTabHtml() {
    const scope = currentScope();
    const list = dataCache?.saved?.[scope.key] || [];
    const selected = list.find(item => item.id === state.selectedSavedId);
    if (!list.length) {
        return '<div class="ss-large-empty"><div>🗝️</div><b>비밀 서랍이 비어 있어요</b><p>마음에 드는 교환 결과를 보관하면 여기에 쌓여요.</p></div>';
    }
    const items = list.map(item => {
        const title = item.mode === 'random' && !item.revealed
            ? '봉인된 랜덤 봉투'
            : item.randomCard?.fields?.title
                || item.combinedCard?.fields?.title
                || (item.chosen === 'character' ? item.characterCard?.fields?.title : item.userCard?.fields?.title)
                || MODE_LABELS[item.mode];
        return `<button class="ss-saved-item ${state.selectedSavedId === item.id ? 'is-selected' : ''}" data-action="select-saved" data-id="${escapeHtml(item.id)}">
            <span>💌</span><div><b>${escapeHtml(title || '봉인된 교환')}</b><small>${escapeHtml(MODE_LABELS[item.mode] || item.mode)} · ${escapeHtml(formatDate(item.createdAt))}</small></div>
        </button>`;
    }).join('');
    return `<div class="ss-drawer-layout"><aside>${items}</aside><section class="ss-saved-preview">
        ${selected ? `${exchangeResultHtml(selected)}<div class="ss-result-actions">${selected.mode === 'random' && !selected.revealed ? `<button class="ss-secondary" data-action="reveal-saved-random" data-id="${escapeHtml(selected.id)}">봉투 열기</button>` : ''}<button class="ss-primary" data-action="start-saved" data-id="${escapeHtml(selected.id)}">이 카드로 장면 시작</button><button class="ss-danger" data-action="delete-saved" data-id="${escapeHtml(selected.id)}">기록 삭제</button></div>` : '<div class="ss-result-empty">왼쪽에서 편지를 골라줘.</div>'}
    </section></div>`;
}

function settingsTabHtml() {
    const s = settings();
    const profile = cachedConnectionProfiles.find(item => String(item.id) === String(s.connectionProfileId));
    const profileName = profile ? profileLabel(profile) : '미선택';
    return `<section class="ss-settings-list">
        <label class="ss-switch-row"><div><b>sweet swap 사용</b><small>확장의 생성과 주입 기능을 켜요.</small></div><input id="ss-enabled" type="checkbox" ${s.enabled ? 'checked' : ''}><i></i></label>
        <label class="ss-switch-row ss-age-row"><div><b>등장인물은 모두 성인입니다</b><small>성인 캐릭터 간의 합의된 역할극에만 사용해요.</small></div><input id="ss-age" type="checkbox" ${s.ageConfirmed ? 'checked' : ''}><i></i></label>
        <label class="ss-setting-field"><div><b>기본 교환 방식</b><small>새 캐릭터에서 처음 선택되는 방식이에요.</small></div><select id="ss-default-mode">${Object.entries(MODE_LABELS).map(([value, label]) => `<option value="${value}" ${s.defaultMode === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label class="ss-switch-row"><div><b>장면 시작 후 자동으로 카드 태우기</b><small>비밀 서랍에 보관한 기록은 삭제하지 않아요.</small></div><input id="ss-auto-burn" type="checkbox" ${s.autoBurnAfterStart ? 'checked' : ''}><i></i></label>
        <label class="ss-setting-field"><div><b>캐릭터별 보관 개수</b><small>오래된 기록부터 자동 정리돼요.</small></div><input id="ss-keep" type="number" min="1" max="200" value="${escapeHtml(s.keepSaved)}"></label>
        <div class="ss-turns-box">
            <div class="ss-turns-head"><b>모드별 장면 진행 턴 수</b><small>장면 시작 후 몇 번의 답변에 걸쳐 나눠 적용할지 골라요. 1턴은 한 번에, 3턴은 장소 이동 → 도착 → 본격 진행 순서로 천천히 이어가요.</small></div>
            ${Object.entries(MODE_LABELS).map(([mode, label]) => `<label class="ss-setting-field ss-turns-row"><div><b>${label}</b></div><select data-turns-mode="${mode}">${[1, 2, 3].map(n => `<option value="${n}" ${sceneTurnCount(mode) === n ? 'selected' : ''}>${n}턴</option>`).join('')}</select></label>`).join('')}
        </div>
        <div class="ss-info-box">카드 생성·두 장 섞기: <b>${escapeHtml(profileName)}</b> 전용 연결 프로필 사용<br>장면 시작: SillyTavern 메인 연결 사용<br><br>전용 프로필은 확장 설정 패널에서 선택해요. 백그라운드 요청 중에도 메인 연결은 바뀌지 않아요.</div>
    </section>`;
}

function modalHtml() {
    const body = state.tab === 'swap' ? swapTabHtml() : state.tab === 'saved' ? savedTabHtml() : settingsTabHtml();
    return `<div id="sweet-swap-overlay" class="ss-overlay" role="dialog" aria-modal="true" aria-label="sweet swap">
        <div class="ss-modal">
            <header class="ss-header">
                <div class="ss-brand"><span>💝</span><div><h2>sweet swap</h2><p>${escapeHtml(currentScope().name)}와 나누는 비밀 교환함</p></div></div>
                <button class="ss-close" data-action="close" aria-label="닫기">×</button>
            </header>
            <nav class="ss-tabs">
                <button data-tab="swap" class="${state.tab === 'swap' ? 'is-active' : ''}">💌 교환함</button>
                <button data-tab="saved" class="${state.tab === 'saved' ? 'is-active' : ''}">🗝️ 비밀 서랍</button>
                <button data-tab="settings" class="${state.tab === 'settings' ? 'is-active' : ''}">⚙️ 설정</button>
            </nav>
            <main class="ss-content">${body}</main>
            <div class="ss-busy"><div class="ss-spinner"></div><b class="ss-busy-label">준비 중…</b><button class="ss-secondary" data-action="cancel-busy">취소</button></div>
        </div>
    </div>`;
}

function renderModal() {
    const old = document.getElementById('sweet-swap-overlay');
    if (!old) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = modalHtml();
    old.replaceWith(wrapper.firstElementChild);
    scheduleModalPin();
}

function forceImportantStyle(element, property, value) {
    element?.style?.setProperty(property, value, 'important');
}

function pinModalToViewport() {
    const overlay = document.getElementById('sweet-swap-overlay');
    const modal = overlay?.querySelector('.ss-modal');
    if (!overlay || !modal) return;

    const viewport = globalThis.visualViewport;
    const width = Math.max(1, Math.round(viewport?.width || globalThis.innerWidth || document.documentElement.clientWidth || 360));
    const height = Math.max(1, Math.round(viewport?.height || globalThis.innerHeight || document.documentElement.clientHeight || 640));
    const left = Math.round(viewport?.offsetLeft || 0);
    const top = Math.round(viewport?.offsetTop || 0);
    const gutter = width <= 700 ? 8 : 20;
    const modalWidth = Math.max(1, Math.min(1040, width - gutter * 2));
    const modalHeight = Math.max(1, height - gutter * 2);

    if (document.documentElement && overlay.parentElement !== document.documentElement) {
        document.documentElement.appendChild(overlay);
    }
    overlay.hidden = false;
    forceImportantStyle(overlay, 'position', 'fixed');
    forceImportantStyle(overlay, 'inset', 'auto');
    forceImportantStyle(overlay, 'left', `${left}px`);
    forceImportantStyle(overlay, 'top', `${top}px`);
    forceImportantStyle(overlay, 'width', `${width}px`);
    forceImportantStyle(overlay, 'height', `${height}px`);
    forceImportantStyle(overlay, 'z-index', '2147483647');
    forceImportantStyle(overlay, 'display', 'flex');
    forceImportantStyle(overlay, 'align-items', 'center');
    forceImportantStyle(overlay, 'justify-content', 'center');
    forceImportantStyle(overlay, 'padding', `${gutter}px`);
    forceImportantStyle(overlay, 'margin', '0');
    forceImportantStyle(overlay, 'transform', 'none');
    forceImportantStyle(overlay, 'visibility', 'visible');
    forceImportantStyle(overlay, 'opacity', '1');

    forceImportantStyle(modal, 'position', 'relative');
    forceImportantStyle(modal, 'inset', 'auto');
    forceImportantStyle(modal, 'width', `${modalWidth}px`);
    forceImportantStyle(modal, 'height', 'auto');
    forceImportantStyle(modal, 'max-width', `${modalWidth}px`);
    forceImportantStyle(modal, 'max-height', `${modalHeight}px`);
    forceImportantStyle(modal, 'margin', 'auto');
    forceImportantStyle(modal, 'transform', 'none');
    forceImportantStyle(modal, 'visibility', 'visible');
    forceImportantStyle(modal, 'opacity', '1');
    if (width <= 700) forceImportantStyle(modal, 'border-radius', '18px');
}

function scheduleModalPin() {
    if (typeof globalThis.requestAnimationFrame === 'function') {
        if (modalPinFrame === null) {
            modalPinFrame = globalThis.requestAnimationFrame(() => {
                modalPinFrame = null;
                pinModalToViewport();
            });
        }
    } else {
        pinModalToViewport();
    }
    clearTimeout(modalPinTimer);
    modalPinTimer = setTimeout(() => {
        modalPinTimer = null;
        pinModalToViewport();
    }, 120);
}

function installModalViewportGuard() {
    if (modalViewportGuardInstalled) return;
    modalViewportGuardInstalled = true;
    globalThis.addEventListener?.('resize', scheduleModalPin, { passive: true });
    globalThis.addEventListener?.('orientationchange', scheduleModalPin, { passive: true });
    globalThis.visualViewport?.addEventListener?.('resize', scheduleModalPin, { passive: true });
    globalThis.visualViewport?.addEventListener?.('scroll', scheduleModalPin, { passive: true });
}

async function openModal(tab = 'swap') {
    if (document.getElementById('sweet-swap-overlay')) {
        scheduleModalPin();
        return;
    }
    if (!settings().enabled) {
        toast('warning', '확장 설정에서 sweet swap을 먼저 켜줘.');
        return;
    }
    if (currentScope().key === 'none') {
        toast('warning', '먼저 캐릭터 또는 그룹 채팅을 열어줘.');
        return;
    }
    await loadScopeState();
    state.tab = settings().ageConfirmed ? tab : 'settings';
    const wrapper = document.createElement('div');
    wrapper.innerHTML = modalHtml();
    document.documentElement.appendChild(wrapper.firstElementChild);
    document.documentElement.classList.add('ss-modal-open');
    scheduleModalPin();
}

function closeModal() {
    if (state.busy) cancelBackgroundGenerate();
    flushDraftSave();
    document.getElementById('sweet-swap-overlay')?.remove();
    document.documentElement.classList.remove('ss-modal-open');
}

async function handleClick(event) {
    const tab = event.target.closest('[data-tab]')?.dataset.tab;
    if (tab) {
        clearTimeout(draftSaveTimer);
        captureUserFormIfVisible();
        await persistDraft();
        state.tab = tab;
        renderModal();
        return;
    }

    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'cancel-busy') return cancelBackgroundGenerate();
    if (action === 'close') return closeModal();
    if (state.busy) return;
    if (action === 'seal-user' || action === 'regenerate-character') return generateCharacterCard();
    if (action === 'exchange') return exchangeCards();
    if (action === 'reveal-random') return revealRandomEnvelope();
    if (action === 'reroll-random') return generateRandomEnvelope();
    if (action === 'burn-random') {
        if (!confirm('이 랜덤 봉투를 태울까?')) return;
        return burnRandomEnvelope(true);
    }
    if (action === 'start') return startScene();
    if (action === 'save') return saveExchange();
    if (action === 'burn') {
        if (!confirm('정말 카드를 태울까? 비밀 서랍에 보관하지 않은 내용은 사라져.')) return;
        return burnCurrent(true);
    }
    if (action === 'select-saved') {
        state.selectedSavedId = button.dataset.id;
        return renderModal();
    }
    if (action === 'delete-saved') {
        if (!confirm('이 보관 기록을 삭제할까? 되돌릴 수 없어.')) return;
        return deleteSaved(button.dataset.id);
    }
    if (action === 'reveal-saved-random') return revealSavedRandom(button.dataset.id);
    if (action === 'start-saved') {
        const list = dataCache?.saved?.[currentScope().key] || [];
        state.exchange = list.find(item => item.id === button.dataset.id) || null;
        return startScene();
    }
}

function handleChange(event) {
    if (event.target.id === 'ss-mode') {
        captureUserFormIfVisible();
        state.mode = event.target.value;
        state.exchange = null;
        persistDraft();
        renderModal();
        return;
    }

    const s = settings();
    const turnsMode = event.target.dataset?.turnsMode;
    if (turnsMode && MODE_LABELS[turnsMode]) {
        const turns = Math.min(3, Math.max(1, Number(event.target.value) || 1));
        s.sceneTurns = { ...DEFAULT_SCENE_TURNS, ...(s.sceneTurns || {}), [turnsMode]: turns };
        saveSettings();
        toast('success', '설정을 저장했어.');
        return;
    }
    if (event.target.id === 'ss-enabled') s.enabled = event.target.checked;
    else if (event.target.id === 'ss-age') s.ageConfirmed = event.target.checked;
    else if (event.target.id === 'ss-default-mode') s.defaultMode = event.target.value;
    else if (event.target.id === 'ss-auto-burn') s.autoBurnAfterStart = event.target.checked;
    else if (event.target.id === 'ss-keep') s.keepSaved = Math.min(200, Math.max(1, Number(event.target.value) || 50));
    else return;
    saveSettings();
    toast('success', '설정을 저장했어.');
}

async function handleProfileChange(event) {
    settings().connectionProfileId = event.target.value || '';
    saveSettings();
    await refreshProfileDropdown();
    if (settings().connectionProfileId) toast('success', 'sweet swap 전용 연결 프로필을 저장했어.');
}

function installGlobalHandlers() {
    document.addEventListener('click', event => {
        if (event.target.closest('#sweet-swap-overlay')) handleClick(event);
        if (event.target.closest('#sweet-swap-launcher')) openModal('swap');
    });
    document.addEventListener('change', event => {
        if (event.target.id === 'sweet-swap-profile') return handleProfileChange(event);
        if (event.target.closest('#sweet-swap-overlay')) handleChange(event);
    });
    document.addEventListener('input', event => {
        if (!event.target.closest('#sweet-swap-overlay')) return;
        if (DRAFT_FIELD_IDS.includes(event.target.id)) {
            invalidateExchangeAfterUserEdit();
            scheduleDraftSave();
        }
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && document.getElementById('sweet-swap-overlay')) closeModal();
    });
}

function settingsPanelHtml() {
    return `<div id="sweet-swap-settings" class="sweet-swap-settings extension_container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <div class="ss-extension-name"><span>💝</span><b>sweet swap</b></div>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="ss-profile-field"><span>전용 연결</span><select id="sweet-swap-profile" aria-label="sweet swap 전용 연결 프로필" disabled><option value="">연결 프로필 불러오는 중…</option></select></label>
                <small class="ss-profile-help">카드 생성과 두 장 섞기만 선택한 프로필로 처리해요. 메인 연결은 바뀌지 않아요.</small>
            </div>
        </div>
    </div>`;
}

async function refreshProfileDropdown() {
    const select = document.getElementById('sweet-swap-profile');
    if (!select) return;
    const selectedId = settings().connectionProfileId || '';
    const profiles = await getSupportedConnectionProfiles();
    const selectedExists = profiles.some(profile => String(profile.id) === String(selectedId));
    const firstOption = profiles.length
        ? '<option value="">연결 프로필 선택…</option>'
        : '<option value="">사용 가능한 연결 프로필 없음</option>';
    select.innerHTML = firstOption + profiles.map(profile => `<option value="${escapeHtml(profile.id)}" ${String(profile.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(profileLabel(profile))}</option>`).join('');
    select.disabled = profiles.length === 0;
    select.value = selectedExists ? selectedId : '';
}

function ensureSettingsPanel() {
    if (document.getElementById('sweet-swap-settings')) return;
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (host) {
        host.insertAdjacentHTML('beforeend', settingsPanelHtml());
        refreshProfileDropdown();
    }
}

function ensureLauncher() {
    if (document.getElementById('sweet-swap-launcher')) return;
    const host = document.getElementById('extensionsMenu');
    if (!host) return;
    host.insertAdjacentHTML('beforeend', `<div id="sweet-swap-launcher" class="list-group-item flex-container flexGap5 interactable" tabindex="0"><span>💝</span><span>sweet swap</span></div>`);
}

function installGenerationCleanup() {
    const ctx = context();
    const events = ctx?.eventSource;
    const types = ctx?.event_types;
    if (!events || !types) return;

    if (types.GENERATION_STARTED) {
        events.on(types.GENERATION_STARTED, async (type, options, dryRun) => {
            if (dryRun) return;
            let serialized = '';
            try { serialized = JSON.stringify([type, options]).toLowerCase(); } catch { serialized = String(type).toLowerCase(); }
            if (serialized.includes('quiet')) return;
            // 대필·이어쓰기는 장면 단계를 넘기지 않는다.
            if (type === 'impersonate' || type === 'continue') return;
            // 스와이프·재생성은 방금 받은 답변과 같은 단계의 지시로 다시 생성한다.
            if (type === 'swipe' || type === 'regenerate') {
                await rearmForRedo();
                return;
            }
            if (!state.promptArmed) return;
            state.promptConsumed = true;
            state.consumingChatLength = context()?.chat?.length ?? 0;
        });
    }
    if (types.GENERATION_ENDED) {
        events.on(types.GENERATION_ENDED, async () => {
            if (state.promptArmed && state.promptConsumed) {
                state.lastConsumed = {
                    exchange: state.promptExchange,
                    turn: state.promptTurn,
                    total: state.promptTurnsTotal,
                    scopeKey: state.promptScopeKey,
                    chatLength: state.consumingChatLength,
                };
                await advanceScenePrompt();
            }
        });
    }
    if (types.GENERATION_STOPPED) {
        events.on(types.GENERATION_STOPPED, async () => {
            if (state.promptArmed && state.promptConsumed) await clearOneShotPrompt();
        });
    }
    if (types.CHAT_CHANGED) {
        events.on(types.CHAT_CHANGED, async () => {
            if (state.promptArmed && state.promptScopeKey !== currentScope().key) await clearOneShotPrompt();
            state.lastConsumed = null;
            closeModal();
        });
    }
}

async function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    settings();
    saveSettings();
    await loadData();
    installGlobalHandlers();
    installGenerationCleanup();
    installModalViewportGuard();
    ensureSettingsPanel();
    ensureLauncher();
    setTimeout(() => {
        ensureSettingsPanel();
        refreshProfileDropdown();
    }, 1200);
    setTimeout(ensureLauncher, 1200);
    setTimeout(ensureLauncher, 3500);
    console.log(`${LOG_PREFIX} loaded`);
}

async function waitForSillyTavern() {
    for (let i = 0; i < 120; i++) {
        if (globalThis.SillyTavern?.getContext) return initialize();
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.error(`${LOG_PREFIX} SillyTavern context not found`);
}

waitForSillyTavern();
