// SPDX-License-Identifier: GPL-3.0-or-later
// providers/useai.js - Use.AI (use.ai / app.use.ai) provider - UNIVERSAL FIX
// مبني على deepseek.js لكن selectors عامة + دعم contenteditable + barMount قوي
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {};

  const S = {
    // عام - يغطي كل اشكال الشات الحديثة
    chatItem: '[data-message-id], [data-message-author-role], [data-testid*="message"], [data-message], .group.w-full, [class*="message"], article',
    userMod: '',
    userBubble: '[data-message-author-role="user"]',
    box: '.markdown, .prose, [class*="markdown"], [data-message-author-role="assistant"]',
    // اهم شي - يدور على كل انواع مربع الكتابة
    editor: 'textarea, div[contenteditable="true"], [contenteditable="true"], [role="textbox"], #prompt-textarea, [data-testid*="composer"] textarea, [data-testid*="input"]',
    msgEditBox: '[data-editing="true"], .ds-textarea',
    thinking: '[class*="think"], [class*="reasoning"], [data-thinking="true"]',
    markdown: '.markdown, .prose, [class*="markdown"], [class*="content"], [data-message-author-role="assistant"]',
    generating: '[class*="loading"], [class*="generating"], [aria-label*="Stop"], [data-testid="stop-button"]',
    sendBtn: 'button[type="submit"], button[data-testid="send-button"], button[aria-label*="Send"], button:has(svg), form button',
    stopBtn: 'button[data-testid="stop-button"], button[aria-label*="Stop"], button:has([class*="stop"])',
    errorSurfaces: '[class*="toast"],[class*="error"],[class*="alert"],[role="alert"]',
    attachArea: "[class*='file-preview'], [class*='upload'], input[type='file']",
    imageThumb: "[class*='thumbnail'], [class*='file-item']",
    modeRadioGroup: '[role="radiogroup"]',
    modeRadio: '[role="radio"]',
    deepThinkToggle: ".ds-toggle-button",
  };

  const RE = {
    contextLimit: new RegExp(["conversation.{0,20}(too long)","context.{0,20}(limit|exceeded)","session.{0,20}expired","token.{0,10}limit"].join("|"),"i"),
    tooLong: /too long/i,
    busy: /server is busy|please try again|system is currently busy/i,
    continueBtn: /^(continue|continuer|继续|fortfahren|continuar)$/i,
    stopped: /stopped|已停止/i,
  };

  const timings = {
    GEN_IDLE_MS: 800,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // --- helpers ---
  function visible(el){
    if(!el) return false;
    const r = el.getBoundingClientRect();
    return r.width>0 && r.height>0 && el.offsetParent!==null;
  }

  // اقوى getEditor - يدور على كل الصفحة ويختار اللي تحت
  const getEditor = () => {
    const all = [...document.querySelectorAll(S.editor)].filter(e => !e.closest("#zs-root") && !e.closest("#zs-bar"));
    if(!all.length) return null;
    // فلتر المرئي فقط
    let vis = all.filter(visible);
    if(!vis.length) vis = all;
    // فضل textarea او contenteditable اللي قريب من الاسفل
    vis.sort((a,b)=>{
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.bottom - ra.bottom; // اللي تحت اكثر اول
    });
    // فضل اللي عنده placeholder او id معروف
    const preferred = vis.find(e=> e.id==="prompt-textarea" || e.getAttribute("placeholder") || e.getAttribute("data-testid"));
    return preferred || vis[0] || null;
  };

  const editorText = () => {
    const e = getEditor();
    if(!e) return "";
    if(e.tagName==="TEXTAREA" || e.tagName==="INPUT") return e.value||"";
    // contenteditable
    return e.textContent || e.innerText || "";
  };

  function setTextareaValue(el, text){
    if(!el) return;
    el.focus();
    if(el.tagName==="TEXTAREA" || el.tagName==="INPUT"){
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),"value")?.set;
      const protoSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")?.set;
      const s = setter || protoSetter;
      if(s) s.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event("input",{bubbles:true}));
      el.dispatchEvent(new Event("change",{bubbles:true}));
    } else {
      // contenteditable - ProseMirror / generic
      // طريقة 1: execCommand
      try{
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("selectAll",false,null);
        document.execCommand("insertText",false,text);
      }catch{}
      // fallback
      if((el.textContent||"").trim() !== text.trim()){
        el.textContent = text;
      }
      el.dispatchEvent(new InputEvent("input",{bubbles:true, data:text}));
      el.dispatchEvent(new Event("input",{bubbles:true}));
    }
  }

  // --- turns ---
  const allItems = () => {
    const nodes = [...document.querySelectorAll(S.chatItem)];
    // فلتر - شيل اللي فاضي او داخل الشريط
    return nodes.filter(n=> !n.closest("#zs-root") && !n.closest("#zs-bar") && (n.textContent||"").trim().length>0);
  };
  const isUserItem = (item) => {
    if(!item) return false;
    const role = item.getAttribute("data-message-author-role") || item.getAttribute("data-role") || item.getAttribute("data-author");
    if(role==="user") return true;
    if(item.querySelector('[data-message-author-role="user"]')) return true;
    // heuristic: if class contains user
    const cls = (item.className||"").toLowerCase();
    if(cls.includes("user") && !cls.includes("assistant")) return true;
    return false;
  };
  const isAssistantItem = (item) => !!item && !isUserItem(item);
  function itemText(item){
    if(!item) return "";
    const mds = [...item.querySelectorAll(S.markdown)].filter(m=> !m.closest(S.thinking));
    if(mds.length) return mds.map(m=> m.textContent).join("\n");
    return item.textContent||"";
  }
  function classifyText(item, excludeSel){
    if(isAssistantItem(item)){
      return [...item.querySelectorAll(S.markdown)]
        .filter(m=> !m.closest(S.thinking) && !(excludeSel && m.closest(excludeSel)))
        .map(m=> m.textContent).join("\n");
    }
    return item.textContent||"";
  }
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length-1] : null;
  };
  function itemKey(item){
    if(!item) return null;
    return item.getAttribute("data-message-id") || item.getAttribute("data-message-author-role") || null;
  }
  function lastAssistantId(){
    const last = lastAssistant();
    return itemKey(last);
  }
  function readAssistant(item){
    return itemText(item);
  }
  function streamLen(item){
    return (itemText(item)||"").length;
  }
  function snapshot(){
    return { url: location.href, items: allItems().length };
  }
  const chatIsEmpty = () => allItems().length===0;
  const isFreshChat = () => chatIsEmpty() && !!getEditor();

  // --- composer frame & bar mount - FIX الرئيسي ---
  function composerFrame(){
    const ed = getEditor();
    if(!ed) return null;
    // اطلع لفوق لحد ما تلاقي form او div كبير يحتوي الزر
    let n = ed;
    for(let i=0;i<10 && n && n.parentElement; i++){
      if(n.tagName==="FORM") return n;
      if(n.querySelector && n.querySelector(S.sendBtn)) return n;
      n = n.parentElement;
    }
    return ed.parentElement?.parentElement || ed.parentElement || null;
  }

  function barMount(){
    const ed = getEditor();
    if(!ed) return null;
    let frame = composerFrame();
    if(!frame) frame = ed.closest('form') || ed.parentElement;
    if(!frame) return null;
    // نرفع الشريط فوق الفريم كامل - ما نغطي مكان الكتابة
    let parent = frame.parentElement;
    if(!parent) parent = frame;
    // نحط الشريط قبل الفريم مباشرة
    let before = frame;
    // لو الـ parent هو نفسه اللي فيه الشريط القديم، تأكد ما نحط الشريط قبل نفسه
    if(before && before.id==="zs-bar") before = before.nextElementSibling || null;
    // inside:false = يطلع كرت فوق، ما يدخل داخل مربع الكتابة ولا يخربه
    return { parent, before, inside: false };
  }

  function setInputLock(on){
    const ed = getEditor();
    if(!ed) return;
    if(on){
      if(!ed.dataset.zsPlaceholder) ed.dataset.zsPlaceholder = ed.getAttribute("placeholder")||"";
      ed.setAttribute("readonly","");
      ed.setAttribute("placeholder","⏳ Agent working… please wait");
    }else{
      ed.removeAttribute("readonly");
      if(ed.dataset.zsPlaceholder!=null) ed.setAttribute("placeholder", ed.dataset.zsPlaceholder);
    }
  }

  async function typeAndSend(text, images){
    const editor = getEditor();
    if(!editor) throw new Error("Use.AI input box not found - جرب تحدث الصفحة");
    // لا نعدل ولا نخرب الـ DOM حق الموقع
    try { editor.focus(); } catch {}
    // كتابة نظيفة
    if(editor.tagName==="TEXTAREA" || editor.tagName==="INPUT"){
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor),"value")?.set;
      const protoSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")?.set;
      const s = setter || protoSetter;
      if(s) s.call(editor, text);
      else editor.value = text;
      editor.dispatchEvent(new Event("input",{bubbles:true}));
      editor.dispatchEvent(new Event("change",{bubbles:true}));
    } else {
      // contenteditable - بدون ما نخرب الـ ProseMirror
      try{
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, text);
      }catch{
        editor.textContent = text;
        editor.dispatchEvent(new InputEvent("input",{bubbles:true, data:text}));
      }
    }
    await sleep(250);
    // دور زر الارسال - ندور فقط داخل الفريم عشان ما نضغط زر ثاني بالغلط
    const frame = composerFrame();
    let btn = null;
    if(frame){
      btn = [...frame.querySelectorAll('button[type="submit"], button[data-testid="send-button"]')].find(b=> b.offsetParent!==null) || null;
    }
    if(!btn) btn = document.querySelector(S.sendBtn);
    if(btn && btn.offsetParent!==null){
      btn.click();
      return true;
    }
    // fallback: Enter (بدون Shift)
    editor.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",keyCode:13,bubbles:true}));
    editor.dispatchEvent(new KeyboardEvent("keypress",{key:"Enter",code:"Enter",keyCode:13,bubbles:true}));
    editor.dispatchEvent(new KeyboardEvent("keyup",{key:"Enter",code:"Enter",keyCode:13,bubbles:true}));
    return true;
  }

  function isGenerating(){
    const stop = document.querySelector(S.stopBtn);
    if(stop && visible(stop)) return true;
    const gen = document.querySelector(S.generating);
    if(gen && visible(gen)) return true;
    return false;
  }
  function isBusyNow(){ return false; }
  function isHardGenerating(){ return isGenerating(); }
  function genDebug(){ return { gen: isGenerating() }; }
  function enforceComposer(){ return { ready: true, expertOn: true, visionOn: true, searchOff: true }; }
  async function ensureComposerReady(reason){ 
    for(let i=0;i<20;i++){
      if(getEditor()) return { ready: true, expertOn: true, visionOn: true, searchOff: true };
      await sleep(200);
    }
    return { ready: !!getEditor(), expertOn: true, visionOn: true, searchOff: true };
  }
  function turnHalted(item){ return false; }
  function findContinueBtn(){ 
    return [...document.querySelectorAll("button")].find(b=> RE.continueBtn.test((b.innerText||"").trim())) || null;
  }
  function clickContinueBtn(btn){ if(btn) btn.click(); }
  function scanError(){ 
    const el = document.querySelector(S.errorSurfaces);
    return el ? el.textContent : null;
  }
  function isTooLongMsg(text){ return RE.tooLong.test(text); }
  function isBusyMsg(text){ return RE.busy.test(text); }
  function stopGeneration(){
    const btn = document.querySelector(S.stopBtn);
    if(btn) btn.click();
  }
  function conversationKey(){ return location.pathname; }
  function attachImages(){ return false; }
  function clearAttachments(){ return true; }
  function installSendHooks(handlers){
    document.addEventListener("keydown",(e)=>{
      if(e.key!=="Enter" || e.shiftKey || e.isComposing) return;
      const editor = getEditor();
      if(!editor || !editor.contains(e.target)) return;
      if(editorText().trim()==="") return;
      if(handlers.isBlocked()) return;
      if(!handlers.isStarted()){
        if(!chatIsEmpty()) return;
        handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    },true);
    document.addEventListener("click",(e)=>{
      if(!getEditor()) return;
      const t = e.target;
      const cont = t && t.closest && t.closest("button");
      if(cont && RE.continueBtn.test((cont.innerText||"").trim())){
        handlers.onNativeContinue();
        return;
      }
      const btn = t && t.closest && t.closest(S.sendBtn);
      if(!btn) return;
      if(handlers.isBlocked()) return;
      if(!handlers.isStarted()){
        if(!chatIsEmpty()) return;
        handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    },true);
  }
  function findToolBlockSpot(item, chip){
    const hasStart = (t) => t.includes("###lua###") || t.includes("###mcp_tool###") || /\{\s*"(?:command|tool)"\s*:/.test(t);
    const hasEnd = (t) => t.includes("###end_lua###") || t.includes("###end_mcp_tool###");
    const containers = [...item.querySelectorAll(S.markdown)];
    if(!containers.length) return null;
    let parent=null, ref=null;
    for(const container of containers){
      const kids = [...container.children].filter(k=> k!==chip && !(chip && k.contains(chip)));
      for(let i=0;i<kids.length;i++){
        const txt = (kids[i].textContent||"").toLowerCase();
        if(hasStart(txt)){
          kids[i].classList.add("zs-tool-hide");
          if(!ref && kids[i].parentElement){ parent=kids[i].parentElement; ref=kids[i]; }
        }
      }
    }
    return ref ? {parent, ref} : null;
  }

  return {
    id: "useai",
    displayName: "Use.AI",
    get supportsVision(){ return true; },
    timings,
    thinkingSel: S.thinking,
    init({diag:d}={}){ if(d) diag=d; try{document.documentElement.setAttribute("data-zs-useai-ver","2026-08_useai_fix_v4_lifted");}catch{} },
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
