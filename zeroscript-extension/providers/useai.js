// SPDX-License-Identifier: GPL-3.0-or-later
// providers/useai.js - Use.AI fixed v2 - خفيف وما يعلق
// تم حل مشكلة التعليق ومشكلة اختفاء شريط الكتابة

const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let diag = () => {};

  // selectors دقيقة لـ use.ai - ما نستخدم [class*="message"] العام لأنه يعلق الموقع
  const S = {
    // الحاوية الرئيسية للشات - ندور داخلها فقط عشان ما نعلق الصفحة
    chatRoot: 'main, [role="main"], #__next, [class*="conversation"]',
    chatItem: '[data-testid="conversation-turn"], [data-message-author-role], [data-testid="message"], [data-message-id]',
    userMod: '',
    userBubble: '[data-message-author-role="user"]',
    box: '.markdown, .prose, [data-message-author-role="assistant"]',
    editor: 'textarea[placeholder], textarea[data-id="root"], form textarea, #prompt-textarea, div[contenteditable="true"]',
    thinking: '[class*="think"], [class*="reasoning"]',
    markdown: '.markdown, .prose, [class*="markdown"]',
    generating: '[class*="loading"], [aria-label*="Stop"], button[data-testid="stop-button"]',
    sendBtn: 'button[data-testid="send-button"], button[type="submit"], form button:has(svg)',
    stopBtn: 'button[data-testid="stop-button"], button[aria-label*="Stop"]',
    errorSurfaces: '[class*="toast"], [role="alert"]',
    attachArea: '[class*="file"]',
    imageThumb: 'img',
    modeRadioGroup: '[role="radiogroup"]',
    modeRadio: '[role="radio"]',
    deepThinkToggle: '[class*="think"]',
  };

  const RE = {
    contextLimit: /too long|context limit|token limit/i,
    tooLong: /too long/i,
    busy: /busy|try again/i,
    continueBtn: /^(continue|continuer)$/i,
    stopped: /stopped|stopping/i,
    expertMode: /expert/i,
    visionMode: /vision/i,
    deepThink: /deep ?think|r1/i,
    searchMode: /search/i,
  };

  const timings = {
    GEN_IDLE_MS: 800,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // cache عشان ما نعلق الموقع كل 50ms
  let _cacheItems = [];
  let _cacheTime = 0;
  function qAll(sel) { try { return [...document.querySelectorAll(sel)]; } catch { return []; } }
  function getChatRoot() {
    return document.querySelector(S.chatRoot) || document.body;
  }
  function allItems() {
    const now = Date.now();
    if (now - _cacheTime < 400 && _cacheItems.length) return _cacheItems;
    const root = getChatRoot();
    let items = [];
    for (const sel of S.chatItem.split(',').map(s=>s.trim()).filter(Boolean)) {
      try {
        const found = [...root.querySelectorAll(sel)];
        if (found.length > 2) { items = found; break; }
      } catch {}
    }
    // fallback: لو ما لقينا شي، ندور بطريقة ثانية بس محدودة
    if (!items.length) {
      const maybe = [...root.querySelectorAll('div[data-message-author-role]')];
      if (maybe.length) items = maybe;
    }
    _cacheItems = items;
    _cacheTime = now;
    return items;
  }

  function isUserItem(item) {
    if (!item) return false;
    const role = item.getAttribute && item.getAttribute('data-message-author-role');
    if (role === 'user') return true;
    if (item.querySelector && item.querySelector('[data-message-author-role="user"]')) return true;
    // fallback: اذا فيه كلاس user
    if (item.matches && item.matches('[data-message-author-role="user"]')) return true;
    return false;
  }
  const isAssistantItem = (item) => !!item && !isUserItem(item);

  function itemText(item) {
    if (!item) return "";
    if (isAssistantItem(item)) {
      const mds = [...item.querySelectorAll(S.markdown)].filter(m => !m.closest(S.thinking));
      if (mds.length) return mds.map(m => m.textContent).join("\n");
    }
    return item.textContent || "";
  }
  function classifyText(item, excludeSel) {
    return itemText(item);
  }

  function assistantCount() { return allItems().filter(isAssistantItem).length; }
  function userCount() { return allItems().filter(isUserItem).length; }
  function lastAssistant() { const a = allItems().filter(isAssistantItem); return a[a.length-1] || null; }
  function lastAssistantId() { const la = lastAssistant(); return la ? (la.getAttribute('data-message-id') || '') : ''; }
  function itemKey(item) { return item.getAttribute && (item.getAttribute('data-message-id') || '') || (item.textContent||'').slice(0,80); }
  function readAssistant(item) { return itemText(item); }
  function streamLen(item) { return (itemText(item)||'').length; }
  function snapshot(item) { return itemText(item); }

  // editor - ندور اخر textarea ظاهر في الصفحة (مهم عشان ما نعلق)
  let _editorCache = null;
  let _editorCacheTime = 0;
  function getEditor() {
    const now = Date.now();
    if (_editorCache && (now - _editorCacheTime < 1000) && document.contains(_editorCache)) return _editorCache;
    const all = qAll(S.editor);
    // اخر واحد ظاهر ومو مخفي
    for (let i = all.length-1; i >=0; i--) {
      const el = all[i];
      if (!el) continue;
      if (el.offsetParent === null) continue; // مخفي
      if (el.disabled) continue;
      // نتأكد انه قريب من اسفل الصفحة (الكومبوزر)
      const rect = el.getBoundingClientRect();
      if (rect.top < 100) continue; // فوق مره = مو هو
      _editorCache = el;
      _editorCacheTime = now;
      return el;
    }
    return all[all.length-1] || null;
  }
  function editorText() { const ed = getEditor(); if (!ed) return ''; return ed.value !== undefined ? ed.value : ed.textContent||''; }
  function chatIsEmpty() { return allItems().length === 0; }
  function isFreshChat() { return chatIsEmpty(); }
  function composerFrame() { const ed = getEditor(); return ed ? (ed.closest('form') || ed.parentElement) : null; }
  function barMount() {
    const ed = getEditor();
    if (!ed) return null;
    // اهم شي: نرجع الحاوية اللي فوق الفورم مباشرة، مو نفس الفورم عشان ما نغطي الكتابة
    const form = ed.closest('form');
    if (form && form.parentElement) return form.parentElement;
    // fallback: parent مباشر
    return ed.parentElement ? ed.parentElement.parentElement || ed.parentElement : null;
  }
  function setInputLock(locked) { const ed = getEditor(); if (ed) ed.disabled = !!locked; }

  async function typeAndSend(text) {
    const ed = getEditor();
    if (!ed) return false;
    ed.focus();
    try {
      if (ed.value !== undefined) {
        const proto = Object.getPrototypeOf(ed);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(ed, text);
        else ed.value = text;
        ed.dispatchEvent(new Event('input', {bubbles:true}));
        ed.dispatchEvent(new Event('change', {bubbles:true}));
      } else {
        ed.textContent = text;
        ed.dispatchEvent(new Event('input', {bubbles:true}));
      }
    } catch(e) {
      try { document.execCommand('insertText', false, text); } catch {}
    }
    await sleep(150);
    const btn = document.querySelector(S.sendBtn);
    if (btn && btn.offsetParent !== null) { btn.click(); return true; }
    // fallback Enter
    ed.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', keyCode:13, bubbles:true}));
    return true;
  }

  function stopGeneration() {
    const btn = document.querySelector(S.stopBtn);
    if (btn) btn.click();
  }
  function isGenerating() {
    const stop = document.querySelector(S.stopBtn);
    if (stop && stop.offsetParent !== null) return true;
    if (document.querySelector(S.generating)) return true;
    return false;
  }
  const isBusyNow = () => false;
  const isHardGenerating = () => isGenerating();
  const genDebug = () => ({gen:isGenerating()});

  const enforceComposer = () => {};
  const ensureComposerReady = async () => true;
  const turnHalted = () => false;
  function findContinueBtn() { return [...document.querySelectorAll('button')].find(b => RE.continueBtn.test((b.textContent||'').trim())) || null; }
  function clickContinueBtn() { const b = findContinueBtn(); if (b) b.click(); }

  function scanError() {
    const el = document.querySelector(S.errorSurfaces);
    return el ? el.textContent : '';
  }
  const isTooLongMsg = (t) => RE.tooLong.test(t) || RE.contextLimit.test(t);
  const isBusyMsg = (t) => RE.busy.test(t);

  const attachImages = async () => false;
  const clearAttachments = () => {};
  const conversationKey = () => location.href;

  function installSendHooks(handlers) {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      const editor = getEditor();
      if (!editor || !e.target.closest('form')) return;
      if (handlers.isBlocked && handlers.isBlocked()) return;
      if (!handlers.isStarted || !handlers.isStarted()) return;
      handlers.onUserMessage && handlers.onUserMessage(assistantCount());
    }, true);

    document.addEventListener("click", (e) => {
      const t = e.target;
      const btn = t && t.closest && t.closest(S.sendBtn);
      if (!btn) return;
      if (handlers.isBlocked && handlers.isBlocked()) return;
      if (!handlers.isStarted || !handlers.isStarted()) return;
      handlers.onUserMessage && handlers.onUserMessage(assistantCount());
    }, true);
  }

  function findToolBlockSpot(item, chip) {
    // نبسطها: ندور ###LUA### ونخفيه فقط داخل الرد، مو كل الصفحة
    if (!item) return null;
    const containers = [...item.querySelectorAll(S.markdown)];
    if (!containers.length) return null;
    let parent = null, ref = null;
    for (const container of containers) {
      const kids = [...container.children];
      for (const k of kids) {
        if (k === chip) continue;
        const txt = (k.textContent||'').toLowerCase();
        if (txt.includes('###lua') || txt.includes('###mcp_tool')) {
          k.classList.add('zs-tool-hide');
          if (!ref) { parent = k.parentElement; ref = k; }
        }
      }
    }
    return ref ? {parent, ref} : null;
  }

  return {
    id: "useai",
    displayName: "Use.AI",
    get supportsVision() { return true; },
    timings,
    thinkingSel: S.thinking,
    init({ diag: d } = {}) { if (d) diag = d; try { document.documentElement.setAttribute("data-zs-useai-ver", "2026-08_v2_fixed"); } catch {} },
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, itemKey, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barMount,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating, genDebug,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
  };
})();
