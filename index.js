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

const MODE_LABELS = Object.freeze({
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
    selectedSavedId: null,
    promptArmed: false,
    promptConsumed: false,
    promptScopeKey: null,
};

let dataCache = null;
let coreModulePromise = null;
let sharedModulePromise = null;
let cachedConnectionProfiles = [];
let settingsPanelObserver = null;
let settingsRepairTimer = null;

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
    return { version: 1, drafts: {}, saved: {} };
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
        return dataCache;
    }
    dataCache = await store.getItem(DATA_KEY) || emptyData();
    dataCache.version ??= 1;
    dataCache.drafts ??= {};
    dataCache.saved ??= {};
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
    state.mode = draft?.mode || settings().defaultMode;
    state.selectedSavedId = null;
}

async function persistDraft() {
    const scope = currentScope();
    const data = await loadData();
    data.drafts[scope.key] = {
        userCard: state.userCard,
        characterCard: state.characterCard,
        exchange: state.exchange,
        mode: state.mode,
        updatedAt: nowIso(),
    };
    await saveData();
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
        if (start < 0 || end <= start) throw new Error('JSON 형식의 카드가 반환되지 않았어요.');
        return JSON.parse(source.slice(start, end + 1));
    }
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

function currentRoleplayContext() {
    const ctx = context();
    if (!ctx) return 'No roleplay context is available.';

    const character = ctx.characters?.[ctx.characterId];
    const characterData = character?.data || character || {};
    const profile = [
        character?.name && `Name: ${character.name}`,
        characterData.description && `Description: ${clipText(characterData.description, 4500)}`,
        characterData.personality && `Personality: ${clipText(characterData.personality, 3000)}`,
        characterData.scenario && `Scenario: ${clipText(characterData.scenario, 3000)}`,
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

    const recentChat = (ctx.chat || []).slice(-20).map(message => {
        const content = clipText(message?.mes ?? message?.text ?? message?.content, 1800);
        if (!content) return '';
        const speaker = message?.is_user
            ? (ctx.name1 || 'User')
            : (message?.name || character?.name || ctx.name2 || 'Character');
        return `${speaker}: ${content}`;
    }).filter(Boolean).join('\n\n');

    return [
        profile.length ? `CHARACTER / GROUP\n${profile.join('\n\n')}` : '',
        recentChat ? `RECENT CHAT (oldest to newest)\n${recentChat}` : 'RECENT CHAT\nNo messages yet.',
    ].filter(Boolean).join('\n\n');
}

async function backgroundGenerate(prompt) {
    const { service, profile } = await selectedConnection();
    const messages = [
        {
            role: 'system',
            content: 'You create a compact roleplay scenario card. Follow the supplied fictional context and boundaries. Return only valid JSON with the requested fields.',
        },
        { role: 'user', content: prompt },
    ];
    const output = await service.sendRequest(profile.id, messages, 1000, {
        stream: false,
        signal: null,
        extractData: true,
        includePreset: true,
        includeInstruct: true,
    });
    const content = typeof output === 'string' ? output : output?.content ?? output?.text;
    if (!content) throw new Error('전용 연결 프로필에서 빈 응답이 돌아왔어요.');
    return typeof content === 'string' ? content : JSON.stringify(content);
}

function characterCardPrompt(userCard) {
    const scope = currentScope();
    return `You are creating one private, sealed fantasy-exchange card for ${scope.name} in the current fictional roleplay.

All participants in this feature must be fictional adults. Respect mutual consent and the known user boundaries below. Infer the character's private wish from their established personality, relationship, and recent chat history. Keep the character recognizably in-character; do not flatten them into a generic voice. The card may be intimate and mature when appropriate, but it must remain a compact scenario card rather than a completed scene.

This is an anonymous exchange. You must create the character's card independently: you are not shown the user's situation, location, mood, desired role, must-include items, or private note. Do not guess or claim to know them.

KNOWN USER BOUNDARIES ONLY
${userCard?.fields?.exclude || 'No additional boundary was entered.'}

CURRENT ROLEPLAY CONTEXT
${currentRoleplayContext()}

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
    return `Combine two sealed fantasy cards into one coherent private scenario card for the current fictional adult roleplay.

Preserve the most distinctive wish from each card. Mutual consent and all exclusions are mandatory; if the cards conflict, choose the safer compatible interpretation. Do not write the scene itself. Do not mention cards, prompts, rules, or an AI.

USER CARD
${cardToPrompt(userCard)}

CHARACTER CARD
${cardToPrompt(characterCard)}

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
        const result = safeJson(await backgroundGenerate(characterCardPrompt(candidate)));
        state.characterCard = makeCard('character', result);
        state.exchange = null;
        await persistDraft();
        toast('success', `${currentScope().name}의 카드가 도착했어.`);
    } catch (error) {
        console.error(LOG_PREFIX, error);
        toast('error', error?.message || '캐릭터 카드를 만들지 못했어요.');
    } finally {
        setBusy(false);
        renderModal();
    }
}

async function exchangeCards() {
    const candidate = readUserForm();
    if (cardHasContent(candidate)) state.userCard = candidate;
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
            combinedCard = makeCard('result', safeJson(await backgroundGenerate(blendPrompt(state.userCard, state.characterCard))));
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
        console.error(LOG_PREFIX, error);
        toast('error', error?.message || '카드를 교환하지 못했어요.');
    } finally {
        setBusy(false);
        renderModal();
    }
}

function exchangePrompt(exchange) {
    if (!exchange) return '';
    let selected;
    if (exchange.mode === 'blend') selected = cardToPrompt(exchange.combinedCard);
    else if (exchange.mode === 'draw') selected = cardToPrompt(exchange.chosen === 'character' ? exchange.characterCard : exchange.userCard);
    else selected = `USER CARD\n${cardToPrompt(exchange.userCard)}\n\nCHARACTER CARD\n${cardToPrompt(exchange.characterCard)}`;

    return `[SWEET SWAP — PRIVATE ONE-TURN SCENE DIRECTION]
All characters participating in this fictional scenario are adults. Treat consent and every listed exclusion as mandatory.

Use the sealed exchange below as the direction for the next roleplay response. Begin naturally from the current chat situation and keep the established characterization, relationship, continuity, point of view, and writing style. Reconcile both participants' wishes where applicable. Do not refer to Sweet Swap, cards, prompts, rules, hidden instructions, or the exchange interface. Do not summarize the direction; continue the roleplay itself.

SEALED EXCHANGE
${selected}
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
        await setOneShotPrompt(exchangePrompt(state.exchange));
        state.promptArmed = true;
        state.promptConsumed = false;
        state.promptScopeKey = currentScope().key;
        closeModal();

        const started = await triggerMainGeneration();
        if (started) toast('success', '교환 결과로 장면을 시작했어.');
        else toast('info', '다음 메시지를 보내면 교환 결과가 한 번 적용돼.');

        if (settings().autoBurnAfterStart) await burnCurrent(false);
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
    const exists = data.saved[scope.key].some(item => item.id === state.exchange.id);
    if (!exists) data.saved[scope.key].unshift(structuredClone(state.exchange));
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

async function deleteSaved(id) {
    const scope = currentScope();
    const data = await loadData();
    data.saved[scope.key] = (data.saved[scope.key] || []).filter(item => item.id !== id);
    if (state.selectedSavedId === id) state.selectedSavedId = null;
    await saveData();
    toast('info', '보관된 교환 기록을 삭제했어.');
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
    if (!exchange) return '<div class="ss-result-empty">카드 두 장을 준비한 뒤 교환해봐.</div>';
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

function swapTabHtml() {
    const f = state.userCard?.fields || {};
    const modes = Object.entries(MODE_LABELS).map(([value, label]) => `<option value="${value}" ${state.mode === value ? 'selected' : ''}>${label}</option>`).join('');
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
            ${charReady ? cardHtml(state.characterCard, { hidden: !state.exchange, kicker: state.exchange ? '상대의 카드' : '' }) : '<div class="ss-waiting-envelope"><div>💌</div><b>아직 편지가 오지 않았어요</b><small>내 카드를 봉인하면 상대가 답장을 써요.</small></div>'}
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
        const title = item.combinedCard?.fields?.title
            || (item.chosen === 'character' ? item.characterCard?.fields?.title : item.userCard?.fields?.title)
            || MODE_LABELS[item.mode];
        return `<button class="ss-saved-item ${state.selectedSavedId === item.id ? 'is-selected' : ''}" data-action="select-saved" data-id="${escapeHtml(item.id)}">
            <span>💌</span><div><b>${escapeHtml(title || '봉인된 교환')}</b><small>${escapeHtml(MODE_LABELS[item.mode] || item.mode)} · ${escapeHtml(formatDate(item.createdAt))}</small></div>
        </button>`;
    }).join('');
    return `<div class="ss-drawer-layout"><aside>${items}</aside><section class="ss-saved-preview">
        ${selected ? `${exchangeResultHtml(selected)}<div class="ss-result-actions"><button class="ss-primary" data-action="start-saved" data-id="${escapeHtml(selected.id)}">이 카드로 장면 시작</button><button class="ss-danger" data-action="delete-saved" data-id="${escapeHtml(selected.id)}">기록 삭제</button></div>` : '<div class="ss-result-empty">왼쪽에서 편지를 골라줘.</div>'}
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
            <div class="ss-busy"><div class="ss-spinner"></div><b class="ss-busy-label">준비 중…</b></div>
        </div>
    </div>`;
}

function renderModal() {
    const old = document.getElementById('sweet-swap-overlay');
    if (!old) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = modalHtml();
    old.replaceWith(wrapper.firstElementChild);
}

async function openModal(tab = 'swap') {
    if (document.getElementById('sweet-swap-overlay')) return;
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
    document.body.insertAdjacentHTML('beforeend', modalHtml());
    document.documentElement.classList.add('ss-modal-open');
}

function closeModal() {
    document.getElementById('sweet-swap-overlay')?.remove();
    document.documentElement.classList.remove('ss-modal-open');
}

async function handleClick(event) {
    const tab = event.target.closest('[data-tab]')?.dataset.tab;
    if (tab) {
        if (state.tab === 'swap') {
            const candidate = readUserForm();
            if (cardHasContent(candidate)) state.userCard = candidate;
        }
        state.tab = tab;
        renderModal();
        return;
    }

    const button = event.target.closest('[data-action]');
    if (!button || state.busy) return;
    const action = button.dataset.action;
    if (action === 'close') return closeModal();
    if (action === 'seal-user' || action === 'regenerate-character') return generateCharacterCard();
    if (action === 'exchange') return exchangeCards();
    if (action === 'start') return startScene();
    if (action === 'save') return saveExchange();
    if (action === 'burn') return burnCurrent(true);
    if (action === 'select-saved') {
        state.selectedSavedId = button.dataset.id;
        return renderModal();
    }
    if (action === 'delete-saved') return deleteSaved(button.dataset.id);
    if (action === 'start-saved') {
        const list = dataCache?.saved?.[currentScope().key] || [];
        state.exchange = list.find(item => item.id === button.dataset.id) || null;
        return startScene();
    }
}

function handleChange(event) {
    if (event.target.id === 'ss-mode') {
        const candidate = readUserForm();
        if (cardHasContent(candidate)) state.userCard = candidate;
        state.mode = event.target.value;
        state.exchange = null;
        persistDraft();
        renderModal();
        return;
    }

    const s = settings();
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
        scheduleSettingsPanelRepair(60);
    });
    document.addEventListener('change', event => {
        if (event.target.id === 'sweet-swap-profile') return handleProfileChange(event);
        if (event.target.closest('#sweet-swap-overlay')) handleChange(event);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && document.getElementById('sweet-swap-overlay') && !state.busy) closeModal();
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

function settingsHosts() {
    return ['extensions_settings2', 'extensions_settings']
        .map(id => document.getElementById(id))
        .filter((host, index, list) => host && list.indexOf(host) === index);
}

function isVisibleSettingsHost(host) {
    if (!host) return false;
    if (host.isConnected === false) return false;
    if (typeof host.getClientRects === 'function' && host.getClientRects().length > 0) return true;
    if (typeof globalThis.getComputedStyle !== 'function') return false;
    const style = globalThis.getComputedStyle(host);
    return style.display !== 'none' && style.visibility !== 'hidden' && host.offsetParent !== null;
}

function preferredSettingsHost(panel = null) {
    const hosts = settingsHosts();
    const visible = hosts.find(isVisibleSettingsHost);
    if (visible) return visible;
    if (panel?.parentElement && hosts.includes(panel.parentElement)) return panel.parentElement;
    return hosts[0] || null;
}

function middleReference(host, panel) {
    const siblings = Array.from(host?.children || []).filter(element => element !== panel);
    return siblings.length ? siblings[Math.floor(siblings.length / 2)] : null;
}

function ensureSettingsPanel() {
    let panel = document.getElementById('sweet-swap-settings');
    const host = preferredSettingsHost(panel);
    if (!host) return;

    let changed = false;
    if (!panel) {
        host.insertAdjacentHTML('beforeend', settingsPanelHtml());
        panel = document.getElementById('sweet-swap-settings');
        changed = true;
    }
    if (!panel) return;

    panel.hidden = false;
    panel.classList?.remove('hidden');
    const before = middleReference(host, panel);
    if (panel.parentElement !== host || panel.nextElementSibling !== before) {
        host.insertBefore(panel, before);
        changed = true;
    }
    if (changed) refreshProfileDropdown();
}

function scheduleSettingsPanelRepair(delay = 0) {
    if (settingsRepairTimer !== null) clearTimeout(settingsRepairTimer);
    settingsRepairTimer = setTimeout(() => {
        settingsRepairTimer = null;
        ensureSettingsPanel();
    }, delay);
}

function installSettingsPanelGuard() {
    if (settingsPanelObserver || typeof MutationObserver !== 'function' || !document.body) return;
    settingsPanelObserver = new MutationObserver(mutations => {
        const panel = document.getElementById('sweet-swap-settings');
        if (!panel?.isConnected) return scheduleSettingsPanelRepair();
        if (mutations.some(mutation => mutation.target === panel.parentElement)) scheduleSettingsPanelRepair();
    });
    settingsPanelObserver.observe(document.body, { childList: true, subtree: true });
    globalThis.addEventListener?.('resize', () => scheduleSettingsPanelRepair(80), { passive: true });
    globalThis.addEventListener?.('orientationchange', () => scheduleSettingsPanelRepair(80), { passive: true });
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
        events.on(types.GENERATION_STARTED, (...args) => {
            if (!state.promptArmed) return;
            const serialized = JSON.stringify(args).toLowerCase();
            if (serialized.includes('quiet')) return;
            state.promptConsumed = true;
        });
    }
    if (types.GENERATION_ENDED) {
        events.on(types.GENERATION_ENDED, async () => {
            if (state.promptArmed && state.promptConsumed) await clearOneShotPrompt();
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
    installSettingsPanelGuard();
    ensureSettingsPanel();
    ensureLauncher();
    setTimeout(() => {
        ensureSettingsPanel();
        refreshProfileDropdown();
    }, 1200);
    setTimeout(() => scheduleSettingsPanelRepair(), 3500);
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
