/**
 * AUTO-RETRY + AUTO-CHAT (state machine)
 * Tương thích Trusted Types CSP (VS Code Webview)
 *
 * Auto-Retry : phát hiện banner lỗi → gửi tin nhắn cấu hình
 * Auto-Chat  : popup cấu hình prompt + số ok/cycle →
 *              sending_prompt → auto_ok → waiting_completion → opening_new_chat → lặp
 *
 * Khi cả 2 cùng chạy: Retry được ưu tiên kiểm tra trước.
 */
(function () {
  if (window.__agPanelLoaded) { console.log('[AG] Already loaded.'); return; }
  window.__agPanelLoaded = true;

  // ═══════════════════════════════════════════════════════════════════════════
  // CONSTANTS
  // ═══════════════════════════════════════════════════════════════════════════
  const POLL_MS                   = 2000;
  const RETRY_COOLDOWN_MS         = 3000;
  const SEND_COOLDOWN_MS          = 5000;
  const DEBOUNCE_MS               = 500;
  const NEW_CHAT_DELAY_MS         = 3000;
  const NEW_CHAT_LOAD_MS          = 4000;
  const PROMPT_TIMEOUT_MS         = 30000;
  const CHAT_BLOCK_AFTER_RETRY_MS = 8000;  // chat bị chặn 8s sau khi retry xử lý

  // ═══════════════════════════════════════════════════════════════════════════
  // SHARED STATE
  // ═══════════════════════════════════════════════════════════════════════════
  let sharedInterval       = null;
  let retryOn              = false;
  let chatOn               = false;
  let autoAcceptOn         = false;   // tự động accept file changes
  let retryBusy            = false;   // mutex: true trong lúc retry đang type/send
  let lastRetryHandledAt   = 0;       // timestamp lần cuối retry xử lý thành công
  const chatObservers = new WeakSet();

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const LOG_COLORS = { info:'#94a3b8', warn:'#fbbf24', success:'#4ade80', error:'#f87171' };

  function el(tag, styles = {}, attrs = {}) {
    const e = document.createElement(tag);
    Object.assign(e.style, styles);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }
  function setText(n, t) { n.textContent = t; return n; }

  function isVisible(e) {
    if (!e) return false;
    const s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function isEnabled(e) {
    return e && !e.disabled && e.getAttribute('aria-disabled') !== 'true';
  }

  // ── CSS ───────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('ag-styles')) return;
    const s = document.createElement('style');
    s.id = 'ag-styles';
    s.textContent = [
      '@keyframes ag-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
      '@keyframes ag-spin{to{transform:rotate(360deg)}}',
      '.ag-dot.on{animation:ag-pulse 1.5s infinite}',
      '.ag-panel{position:fixed;z-index:999999;width:252px;background:rgba(13,15,25,.97);',
        'backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);',
        'border:1px solid rgba(255,255,255,.1);border-radius:12px;',
        'box-shadow:0 8px 32px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.04);',
        "font-family:'Inter',system-ui,sans-serif;color:#e2e8f0;user-select:none;}",
      '.ag-hdr{display:flex;align-items:center;justify-content:space-between;',
        'padding:10px 12px 8px;cursor:grab;border-bottom:1px solid rgba(255,255,255,.07);}',
      '.ag-hdr:active{cursor:grabbing}',
      '.ag-title{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;',
        'color:#cbd5e1;letter-spacing:.02em}',
      '.ag-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;transition:background .3s,box-shadow .3s}',
      '.ag-x{cursor:pointer;opacity:.4;font-size:14px;padding:2px 5px;border-radius:4px;',
        'transition:opacity .2s,background .2s;line-height:1}',
      '.ag-x:hover{opacity:1;background:rgba(255,255,255,.1)}',
      '.ag-body{padding:10px 12px}',
      '.ag-stats{font-size:10px;color:#475569;margin-bottom:8px;',
        'padding:4px 6px;background:rgba(255,255,255,.03);border-radius:6px;',
        'display:flex;flex-wrap:wrap;gap:4px}',
      '.ag-stat{color:#64748b}','.ag-stat span{color:#94a3b8}',
      '.ag-phase{font-size:10px;font-weight:600;padding:2px 6px;border-radius:10px;',
        'background:rgba(99,102,241,.15);color:#818cf8;margin-bottom:8px;',
        'display:inline-block;transition:all .3s}',
      '.ag-lbl{font-size:10px;color:#475569;margin-bottom:3px;display:block}',
      '.ag-inp{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);',
        'border-radius:6px;color:#e2e8f0;font-size:11px;padding:4px 8px;outline:none;',
        'font-family:inherit;box-sizing:border-box;width:100%;transition:border-color .2s;margin-bottom:8px}',
      '.ag-inp:focus{border-color:rgba(99,102,241,.55)}',
      '.ag-btn{width:100%;padding:7px 0;border-radius:8px;border:none;cursor:pointer;',
        'font-size:12px;font-weight:600;letter-spacing:.03em;',
        'transition:all .2s;color:#fff;box-sizing:border-box}',
      '.ag-btn:hover{transform:translateY(-1px)}',
      '.ag-btn-purple{background:linear-gradient(135deg,#6366f1,#8b5cf6);box-shadow:0 2px 10px rgba(99,102,241,.3)}',
      '.ag-btn-purple:hover{box-shadow:0 4px 16px rgba(99,102,241,.45)}',
      '.ag-btn-green{background:linear-gradient(135deg,#059669,#10b981);box-shadow:0 2px 10px rgba(16,185,129,.3)}',
      '.ag-btn-green:hover{box-shadow:0 4px 16px rgba(16,185,129,.45)}',
      '.ag-btn-stop{background:linear-gradient(135deg,#1e293b,#334155);',
        'border:1px solid rgba(255,255,255,.08);box-shadow:0 2px 10px rgba(0,0,0,.3)}',
      '.ag-div{border-top:1px solid rgba(255,255,255,.06);margin-top:8px;padding-top:8px}',
      '.ag-log{max-height:64px;overflow-y:auto;font-size:10px;font-family:Consolas,monospace;color:#64748b}',
      '.ag-log::-webkit-scrollbar{width:3px}',
      '.ag-log::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:2px}',
      // Checkbox toggle
      '.ag-chk-row{display:flex;align-items:center;gap:7px;margin-bottom:8px;cursor:pointer;user-select:none}',
      '.ag-chk{appearance:none;-webkit-appearance:none;width:14px;height:14px;border-radius:3px;',
        'border:1.5px solid rgba(255,255,255,.2);background:rgba(255,255,255,.05);',
        'cursor:pointer;flex-shrink:0;transition:all .2s;position:relative;}',
      '.ag-chk:checked{background:linear-gradient(135deg,#059669,#10b981);border-color:#10b981;}',
      '.ag-chk:checked::after{content:"";position:absolute;left:2px;top:-1px;',
        'width:4px;height:8px;border:2px solid #fff;border-top:none;border-left:none;',
        'transform:rotate(45deg);}',
      '.ag-chk-lbl{font-size:10px;color:#94a3b8;}',
      '.ag-chk-row:hover .ag-chk-lbl{color:#e2e8f0;}',
      // Popup
      '.ag-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:1000000;',
        'display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px)}',
      '.ag-dialog{background:linear-gradient(135deg,#1a1f1a,#111811);border:1px solid #4ade8033;',
        'border-radius:14px;padding:24px 28px;width:380px;max-height:80vh;overflow-y:auto;',
        'box-shadow:0 20px 60px rgba(0,0,0,.6);font-family:system-ui,sans-serif;',
        'display:flex;flex-direction:column;gap:14px}',
      '.ag-dlg-title{color:#4ade80;font-size:14px;font-weight:700;letter-spacing:.5px}',
      '.ag-dlg-desc{color:#888;font-size:12px;line-height:1.5}',
      '.ag-dlg-lbl{color:#aaa;font-size:11px;display:block;margin-bottom:4px}',
      '.ag-dlg-ta{background:#0d160d;border:1px solid #4ade8044;border-radius:8px;',
        'color:#e0ffe0;font-size:13px;padding:8px 12px;outline:none;',
        'width:100%;box-sizing:border-box;min-height:100px;resize:vertical;',
        'font-family:system-ui,sans-serif;line-height:1.4}',
      '.ag-dlg-inp{background:#0d160d;border:1px solid #4ade8044;border-radius:8px;',
        'color:#e0ffe0;font-size:14px;padding:8px 12px;outline:none;',
        'width:100%;box-sizing:border-box;font-family:inherit}',
      '.ag-dlg-btns{display:flex;gap:10px;justify-content:flex-end}',
      '.ag-dlg-cancel{padding:8px 16px;border-radius:8px;border:1px solid #333;',
        'background:transparent;color:#666;font-size:12px;cursor:pointer;font-weight:600}',
      '.ag-dlg-confirm{padding:8px 16px;border-radius:8px;border:none;',
        'background:linear-gradient(135deg,#1a5c1a,#0d3d0d);color:#4ade80;',
        'font-size:12px;cursor:pointer;font-weight:700;box-shadow:0 0 10px #4ade8022}',
    ].join('');
    document.head.appendChild(s);
  }

  // ── Draggable ─────────────────────────────────────────────────────────────
  function makeDraggable(root, handle) {
    let ox, oy, sx, sy;
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      sx = e.clientX; sy = e.clientY;
      const r = root.getBoundingClientRect();
      ox = r.left; oy = r.top;
      root.style.right = 'auto'; root.style.bottom = 'auto';
      root.style.left = ox + 'px'; root.style.top = oy + 'px';
      const mv = e => { root.style.left=(ox+e.clientX-sx)+'px'; root.style.top=(oy+e.clientY-sy)+'px'; };
      const up = () => { document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up); };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  }

  function setDot(dot, on) {
    dot.style.background = on ? '#4ade80' : '#ef4444';
    dot.style.boxShadow  = on ? '0 0 8px #4ade80' : '0 0 6px #ef4444';
    dot.className = on ? 'ag-dot on' : 'ag-dot';
  }

  function appendLog(logEl, msg, type = 'info') {
    if (!logEl) return;
    const line = el('div', { color: LOG_COLORS[type], fontSize: '10px', padding: '1px 0' });
    setText(line, msg);
    logEl.appendChild(line);
    while (logEl.children.length > 6) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ── DOM finders ───────────────────────────────────────────────────────────
  function getTargetDocs() {
    const docs = [document];
    for (const f of document.querySelectorAll('iframe')) {
      try { const d = f.contentDocument || f.contentWindow.document; if (d) docs.push(d); } catch (_) {}
    }
    return docs;
  }

  function findErrorBanner() {
    for (const span of document.querySelectorAll('span.text-sm.font-medium'))
      if (span.textContent.trim() === 'Agent terminated due to error')
        return span.closest('.relative.flex.flex-col.gap-1');
    return null;
  }
  function findRetryBtnInBanner(banner) {
    if (!banner) return null;
    for (const b of banner.querySelectorAll('button'))
      if (b.textContent.trim() === 'Retry') return b;
    return null;
  }

  // Used by auto-chat (searches all docs, more permissive)
  function findAnyRetryBtn(doc) {
    for (const btn of doc.querySelectorAll("button,[role='button']")) {
      const text  = (btn.textContent || '').trim().toLowerCase();
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      const title = (btn.getAttribute('title') || '').toLowerCase();
      const cls   = (btn.className || '').toString().toLowerCase();
      if ((text === 'retry' || label.includes('retry') || title.includes('retry') || cls.includes('retry'))
          && isVisible(btn) && isEnabled(btn)) return btn;
    }
    return null;
  }

  function findTooltipBtn(doc, tooltipId, requireEnabled = false) {
    const root = doc.querySelector(`[data-tooltip-id='${tooltipId}']`);
    if (!root) return null;
    const target = root.closest("button,[role='button']") || root.querySelector("button,[role='button']") || root;
    if (!isVisible(target)) return null;
    if (requireEnabled && !isEnabled(target)) return null;
    return target;
  }

  function findInputEl(doc) {
    const prefix = '#antigravity\\.agentSidePanelInputBox';
    const panel = doc.querySelector(`${prefix} [contenteditable='true'][role='textbox'],${prefix} textarea,${prefix} input[type='text']`);
    if (panel && isVisible(panel)) return panel;
    const lex = doc.querySelector("[contenteditable='true'][role='textbox'][data-lexical-editor='true']");
    if (lex && isVisible(lex)) return lex;
    const all = Array.from(doc.querySelectorAll("textarea,input[type='text'],[contenteditable='true']")).filter(isVisible);
    return all.length ? all[all.length - 1] : null;
  }

  function findNewChatBtn(doc) {
    const sels = [
      "[data-tooltip-id*='new-chat']","[data-tooltip-id*='new_chat']","[data-tooltip-id*='newChat']",
      "[data-tooltip-id*='new-conversation']","[aria-label*='New Chat']","[aria-label*='New Conversation']",
      "[title*='New Chat']","[title*='New Conversation']",
    ];
    for (const sel of sels) {
      const e = doc.querySelector(sel);
      if (e && isVisible(e)) { const b = e.closest("button,[role='button'],a") || e; if (isVisible(b)) return b; }
    }
    for (const btn of doc.querySelectorAll("button,[role='button']")) {
      const text = (btn.textContent || '').trim().toLowerCase();
      if ((text === 'new chat' || text === 'new conversation') && isVisible(btn)) return btn;
    }
    return null;
  }

  // ── Auto-Retry: Lexical typing (for sending configured message) ───────────
  function fireKey(ed, key, code, ctrl = false) {
    const o = { key, keyCode: code, which: code, bubbles: true, cancelable: true, ctrlKey: ctrl };
    ['keydown','keypress','keyup'].forEach(t => ed.dispatchEvent(new KeyboardEvent(t, o)));
  }
  async function clearLexical(ed) {
    ed.focus(); await sleep(80);
    fireKey(ed, 'a', 65, true); await sleep(80);
    fireKey(ed, 'Backspace', 8); await sleep(80);
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null); await sleep(80);
    if (ed.textContent.trim().length > 0) {
      window.getSelection().selectAllChildren(ed);
      document.execCommand('delete', false, null); await sleep(80);
    }
  }
  async function retryTypeSend(text) {
    const ed = document.querySelector("div[data-lexical-editor='true'][contenteditable='true']");
    if (!ed) return false;
    await clearLexical(ed);
    document.execCommand('insertText', false, text);
    await sleep(500);
    for (let i = 0; i < 10; i++) {
      const btn = document.querySelector('button[data-testid="send-button"]') || document.querySelector('button[aria-label="Send message"]');
      if (btn && !btn.disabled) { btn.click(); return true; }
      await sleep(300);
    }
    return false;
  }

  // ── Auto-Chat: setInputValue (from new script, compatible with all input types) ──
  function setInputValue(input, value) {
    if (input.isContentEditable) {
      input.focus();
      const sel = input.ownerDocument.defaultView.getSelection();
      const range = input.ownerDocument.createRange();
      range.selectNodeContents(input);
      sel.removeAllRanges(); sel.addRange(range);
      const ok = input.ownerDocument.execCommand('insertText', false, value);
      if (!ok) {
        input.textContent = '';
        input.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'deleteContentBackward'}));
        for (const char of value) {
          input.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:char}));
          input.textContent += char;
          input.dispatchEvent(new InputEvent('input',{bubbles:true,data:char,inputType:'insertText'}));
        }
      }
      return;
    }
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
    const setter = desc && desc.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', {bubbles:true}));
    input.dispatchEvent(new Event('change', {bubbles:true}));
  }

  function chatTrySendText(doc, text, onSent) {
    const input = findInputEl(doc);
    if (!input) return false;
    try {
      setInputValue(input, text);
      let poll = 0;
      const t = setInterval(() => {
        poll++;
        const sendBtn = findTooltipBtn(doc, 'input-send-button-send-tooltip', true);
        if (sendBtn) {
          clearInterval(t);
          const cur = input.isContentEditable ? (input.textContent || '') : (input.value || '');
          if (!cur.trim()) { input.focus(); input.ownerDocument.execCommand('selectAll',false,null); input.ownerDocument.execCommand('insertText',false,text); }
          sendBtn.click();
          if (onSent) onSent();
        }
        if (poll >= 25) { clearInterval(t); if (onSent) onSent(); }
      }, 200);
      return true;
    } catch (e) { return false; }
  }

  // ── Auto-Accept: click "Accept all" button when visible ──────────────────
  function tryAutoAccept() {
    if (!autoAcceptOn) return;
    // Tìm nút "Accept all" trong diff toolbar (text hoặc aria-label)
    for (const el of document.querySelectorAll('span,button,[role="button"]')) {
      const text = (el.textContent || '').trim();
      const lbl  = (el.getAttribute('aria-label') || '').toLowerCase();
      if ((text === 'Accept all' || lbl.includes('accept all')) && isVisible(el)) {
        el.click();
        console.log('%c[AG] ✅ Auto-Accept: clicked "Accept all"', 'color:#4ade80');
        return;
      }
    }
  }

  // ── Interval manager ──────────────────────────────────────────────────────
  function syncInterval() {
    if ((retryOn || chatOn || autoAcceptOn) && !sharedInterval) {
      sharedInterval = setInterval(unifiedCheck, POLL_MS);
    } else if (!retryOn && !chatOn && !autoAcceptOn && sharedInterval) {
      clearInterval(sharedInterval); sharedInterval = null;
      retryBusy = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UNIFIED CHECK — Retry ưu tiên, Chat sau
  // ═══════════════════════════════════════════════════════════════════════════
  async function unifiedCheck() {
    // ── 0. AUTO-ACCEPT ───────────────────────────────────────────────────────
    tryAutoAccept();

    // ── 1. AUTO-RETRY ────────────────────────────────────────────────────────
    if (retryOn && !retryBusy) {
      const banner = findErrorBanner();
      if (banner && findRetryBtnInBanner(banner)) {
        retryBusy = true;
        R.count++;
        R.updatePanel();
        try {
          let ok = false;
          if (R.mode === 'click') {
            // Mode 1: bấm thẳng vào nút Retry
            const retryBtn = findRetryBtnInBanner(banner);
            if (retryBtn) { retryBtn.click(); ok = true; }
            R.log(`🔴 Lỗi → Click Retry (lần ${R.count})`, 'info');
          } else {
            // Mode 2: gõ tin nhắn và gửi
            R.log(`🔴 Lỗi → gửi "${R.msg}" (lần ${R.count})`, 'info');
            ok = await retryTypeSend(R.msg);
          }
          lastRetryHandledAt = Date.now();
          R.log(ok ? '✅ Thành công!' : '❌ Không thể thực hiện.', ok ? 'success' : 'error');
          R.updatePanel();
        } finally { retryBusy = false; }
        return;
      }
    }

    // ── 2. AUTO-CHAT ─────────────────────────────────────────────────────────
    if (chatOn) C.processOnce();
  }

  // ── MutationObserver for chat ─────────────────────────────────────────────
  let chatDebounceTimer = null;
  function debouncedChatProcess() {
    if (chatDebounceTimer) return;
    chatDebounceTimer = setTimeout(() => { chatDebounceTimer = null; if (chatOn) C.processOnce(); }, DEBOUNCE_MS);
  }
  function attachChatObservers() {
    for (const doc of getTargetDocs()) {
      if (!doc?.body || chatObservers.has(doc)) continue;
      try {
        new MutationObserver(() => debouncedChatProcess()).observe(doc.body, { childList:true, subtree:true, attributes:true });
        chatObservers.add(doc);
      } catch (_) {}
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTO-RETRY (R)
  // ═══════════════════════════════════════════════════════════════════════════
  const R = {
    count: 0, msg: 'tiếp tục', mode: 'click', panel: null,

    log(msg, type) {
      console.log(`%c[Retry] ${msg}`, `color:${LOG_COLORS[type||'info']}`);
      if (this.panel) appendLog(this.panel._logEl, msg, type);
    },

    start() {
      if (retryOn) return;
      retryOn = true; syncInterval();
      this.log(`▶️ Bắt đầu (poll ${POLL_MS/1000}s)`, 'success');
      this.updatePanel();
    },
    stop() {
      if (!retryOn) return;
      retryOn = false; syncInterval();
      this.log(`⏹️ Dừng. Tổng: ${this.count} retries`, 'info');
      this.updatePanel();
    },
    toggle() { retryOn ? this.stop() : this.start(); },

    updatePanel() {
      const p = this.panel; if (!p) return;
      setText(p._cntEl, String(this.count));
      setDot(p._dot, retryOn);
      setText(p._stateEl, retryOn ? 'Running...' : 'Stopped');
      p._stateEl.style.color = retryOn ? '#4ade80' : '#64748b';
      setText(p._btn, retryOn ? '⏹ Dừng' : '▶ Bắt đầu');
      p._btn.className = retryOn ? 'ag-btn ag-btn-stop' : 'ag-btn ag-btn-purple';
    },

    createPanel() {
      const root = el('div', { bottom:'80px', right:'16px' });
      root.className = 'ag-panel';

      // Header
      const hdr = el('div'); hdr.className = 'ag-hdr';
      const titleRow = el('div'); titleRow.className = 'ag-title';
      const dot = el('div'); dot.className = 'ag-dot'; setDot(dot, false);
      setText(titleRow, ''); titleRow.appendChild(dot);
      const ts = el('span'); setText(ts, 'Auto-Retry'); titleRow.appendChild(ts);
      const xBtn = el('div'); xBtn.className = 'ag-x'; setText(xBtn, '✕');
      hdr.appendChild(titleRow); hdr.appendChild(xBtn);

      const body = el('div'); body.className = 'ag-body';

      // Stats row
      const sr = el('div'); sr.className = 'ag-stats';
      const cw = el('span'); cw.className = 'ag-stat'; setText(cw, 'Retries: ');
      const cntEl = el('span'); setText(cntEl, '0'); cw.appendChild(cntEl);
      const stateEl = el('span', {color:'#64748b',transition:'color .2s',marginLeft:'auto',flexShrink:'0'});
      setText(stateEl, 'Stopped');
      sr.appendChild(cw); sr.appendChild(stateEl);

      // ── Mode toggle (2 pill buttons) ──
      const modeLbl = el('span'); modeLbl.className = 'ag-lbl'; setText(modeLbl, 'Chế độ retry');
      const modeRow = el('div', {
        display:'flex', gap:'6px', marginBottom:'8px',
      });
      function makeModeBtn(label, value) {
        const b = el('button', {
          flex:'1', padding:'4px 0', borderRadius:'6px', border:'1px solid rgba(255,255,255,.12)',
          fontSize:'11px', fontWeight:'600', cursor:'pointer', transition:'all .2s',
          background: 'rgba(255,255,255,.05)', color:'#64748b',
        });
        setText(b, label);
        return b;
      }
      const btnClick = makeModeBtn('🖱 Click Retry', 'click');
      const btnType  = makeModeBtn('✏ Nhập & Gửi', 'type');
      modeRow.appendChild(btnClick);
      modeRow.appendChild(btnType);

      // ── Message input (chỉ hiện khi mode = type) ──
      const msgWrap = el('div');
      const lbl = el('span'); lbl.className = 'ag-lbl'; setText(lbl, 'Tin nhắn gửi');
      const inp = el('input',{},{type:'text',placeholder:'tiếp tục...'});
      inp.className = 'ag-inp'; inp.style.marginBottom = '0'; inp.value = this.msg;
      inp.addEventListener('input', () => { this.msg = inp.value || 'tiếp tục'; });
      inp.addEventListener('keydown', e => e.stopPropagation());
      inp.addEventListener('mousedown', e => e.stopPropagation());
      msgWrap.appendChild(lbl); msgWrap.appendChild(inp);

      // Apply mode highlight + show/hide msgWrap
      const applyMode = (val) => {
        this.mode = val;
        const active   = 'rgba(99,102,241,.25)';
        const inactive = 'rgba(255,255,255,.05)';
        const activeC  = '#a5b4fc';
        const inactiveC= '#64748b';
        btnClick.style.background = val === 'click' ? active   : inactive;
        btnClick.style.color      = val === 'click' ? activeC  : inactiveC;
        btnClick.style.borderColor= val === 'click' ? 'rgba(99,102,241,.4)' : 'rgba(255,255,255,.12)';
        btnType.style.background  = val === 'type'  ? active   : inactive;
        btnType.style.color       = val === 'type'  ? activeC  : inactiveC;
        btnType.style.borderColor = val === 'type'  ? 'rgba(99,102,241,.4)' : 'rgba(255,255,255,.12)';
        msgWrap.style.display     = val === 'type'  ? 'block'  : 'none';
        msgWrap.style.marginBottom= val === 'type'  ? '8px'    : '0';
      };
      applyMode(this.mode);
      btnClick.addEventListener('click', () => applyMode('click'));
      btnType.addEventListener('click',  () => applyMode('type'));

      // ── Auto-Accept checkbox ──
      const rChkRow = el('div'); rChkRow.className = 'ag-chk-row';
      const rChk = el('input', {}, {type:'checkbox'}); rChk.className = 'ag-chk';
      rChk.checked = autoAcceptOn;
      const rChkLbl = el('span'); rChkLbl.className = 'ag-chk-lbl'; setText(rChkLbl, 'Tự động accept file');
      rChkRow.appendChild(rChk); rChkRow.appendChild(rChkLbl);
      rChkRow.addEventListener('click', (e) => { if (e.target !== rChk) rChk.checked = !rChk.checked; autoAcceptOn = rChk.checked; syncInterval(); if (C.panel && C.panel._chkEl) C.panel._chkEl.checked = autoAcceptOn; });
      rChk.addEventListener('change', () => { autoAcceptOn = rChk.checked; syncInterval(); if (C.panel && C.panel._chkEl) C.panel._chkEl.checked = autoAcceptOn; });

      // Start/Stop button
      const btn = el('button'); btn.className = 'ag-btn ag-btn-purple'; setText(btn, '▶ Bắt đầu');
      btn.addEventListener('click', () => this.toggle());

      const div = el('div'); div.className = 'ag-div';
      const logEl = el('div'); logEl.className = 'ag-log';
      div.appendChild(logEl);

      body.appendChild(sr);
      body.appendChild(modeLbl);
      body.appendChild(modeRow);
      body.appendChild(msgWrap);
      body.appendChild(rChkRow);
      body.appendChild(btn);
      body.appendChild(div);
      root.appendChild(hdr); root.appendChild(body);
      document.body.appendChild(root);
      makeDraggable(root, hdr);

      this.panel = { root, _dot:dot, _cntEl:cntEl, _stateEl:stateEl, _btn:btn, _logEl:logEl, _chkEl:rChk };
      xBtn.addEventListener('click', () => { this.stop(); root.remove(); this.panel = null; });
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTO-CHAT (C) — State Machine
  // ═══════════════════════════════════════════════════════════════════════════
  const C = {
    // State
    phase: 'idle',        // idle|sending_prompt|auto_ok|waiting_completion|opening_new_chat
    isProcessing: false,
    initialPrompt: '',
    okPerCycle: 10,
    okSendCount: 0,
    retryCount: 0,
    cycleCount: 0,
    lastRetryAt: 0,
    lastSendAt: 0,
    newChatOpenedAt: 0,
    promptSent: false,
    promptSentConfirmed: false,
    panel: null,

    log(msg, type) {
      console.log(`%c[Chat] ${msg}`, `color:${LOG_COLORS[type||'info']}`);
      if (this.panel) appendLog(this.panel._logEl, msg, type);
    },

    // ── Popup ────────────────────────────────────────────────────────────────
    showPopup(onConfirm) {
      const overlay = el('div'); overlay.className = 'ag-overlay';

      const dialog = el('div'); dialog.className = 'ag-dialog';

      const title = el('div'); title.className = 'ag-dlg-title'; setText(title, '▶ Auto Chat Loop');
      const desc  = el('div'); desc.className = 'ag-dlg-desc';
      setText(desc, 'Nhập prompt & số lần "ok" mỗi vòng. Hết ok → mở chat mới → gửi lại prompt → lặp.');

      const promptWrap = el('div', {display:'flex',flexDirection:'column',gap:'4px'});
      const promptLbl = el('label'); promptLbl.className = 'ag-dlg-lbl'; setText(promptLbl, 'Prompt gửi đầu mỗi vòng:');
      const promptInput = el('textarea', {}, {placeholder:'Nhập prompt ở đây...'});
      promptInput.className = 'ag-dlg-ta';
      promptInput.value = this.initialPrompt || '';
      promptInput.addEventListener('keydown', e => e.stopPropagation());
      promptWrap.appendChild(promptLbl); promptWrap.appendChild(promptInput);

      const okWrap = el('div', {display:'flex',flexDirection:'column',gap:'4px'});
      const okLbl = el('label'); okLbl.className = 'ag-dlg-lbl'; setText(okLbl, 'Số lần "ok" mỗi vòng:');
      const okInput = el('input', {}, {type:'number', min:'1', placeholder:'10'});
      okInput.className = 'ag-dlg-inp'; okInput.value = String(this.okPerCycle);
      okInput.addEventListener('keydown', e => e.stopPropagation());
      okWrap.appendChild(okLbl); okWrap.appendChild(okInput);

      const btnRow = el('div'); btnRow.className = 'ag-dlg-btns';
      const cancelBtn  = el('button'); cancelBtn.className = 'ag-dlg-cancel'; setText(cancelBtn, 'Huỷ');
      const confirmBtn = el('button'); confirmBtn.className = 'ag-dlg-confirm'; setText(confirmBtn, 'Bắt đầu ▶');
      btnRow.appendChild(cancelBtn); btnRow.appendChild(confirmBtn);

      dialog.appendChild(title); dialog.appendChild(desc);
      dialog.appendChild(promptWrap); dialog.appendChild(okWrap); dialog.appendChild(btnRow);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      setTimeout(() => promptInput.focus(), 50);

      const close = () => overlay.remove();
      cancelBtn.addEventListener('click', close);
      overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
      confirmBtn.addEventListener('click', () => {
        const prompt = promptInput.value.trim();
        if (!prompt) { promptInput.style.borderColor = '#ff4444'; promptInput.focus(); return; }
        const perCycle = parseInt(okInput.value);
        close();
        onConfirm(prompt, (!okInput.value.trim() || isNaN(perCycle) || perCycle < 1) ? 10 : perCycle);
      });
      promptInput.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
      okInput.addEventListener('keydown', e => { if (e.key === 'Enter') confirmBtn.click(); if (e.key === 'Escape') close(); });
    },

    // ── Start / Stop ──────────────────────────────────────────────────────────
    start(prompt, perCycle) {
      this.initialPrompt       = prompt;
      this.okPerCycle          = perCycle;
      this.okSendCount         = 0;
      this.retryCount          = 0;
      this.cycleCount          = 0;
      this.phase               = 'sending_prompt';
      this.promptSent          = false;
      this.promptSentConfirmed = false;
      this.newChatOpenedAt     = 0;
      this.lastSendAt          = Date.now();
      chatOn = true;
      syncInterval();
      attachChatObservers();
      this.log(`▶️ Bắt đầu | prompt: "${prompt.slice(0,30)}..." | ok/cycle: ${perCycle}`, 'success');
      this.updatePanel();
    },
    stop() {
      if (!chatOn) return;
      chatOn = false;
      this.phase = 'idle';
      this.promptSent = false;
      this.promptSentConfirmed = false;
      syncInterval();
      this.log(`⏹️ Dừng. Cycles: ${this.cycleCount} | ok: ${this.okSendCount} | retries: ${this.retryCount}`, 'info');
      this.updatePanel();
    },
    toggle() {
      if (chatOn) { this.stop(); return; }
      this.showPopup((prompt, perCycle) => this.start(prompt, perCycle));
    },

    // ── Phase labels ──────────────────────────────────────────────────────────
    phaseLabel() {
      return { idle:'⬜ Idle', sending_prompt:'📝 Sending', auto_ok:'✉️ Auto OK',
               waiting_completion:'⏳ Waiting', opening_new_chat:'🔄 New Chat' }[this.phase] || this.phase;
    },

    // ── Panel update ──────────────────────────────────────────────────────────
    updatePanel() {
      const p = this.panel; if (!p) return;
      setDot(p._dot, chatOn);
      setText(p._phaseEl, chatOn ? this.phaseLabel() : '⬜ Idle');
      p._phaseEl.style.background   = chatOn ? 'rgba(16,185,129,.15)' : 'rgba(99,102,241,.15)';
      p._phaseEl.style.color        = chatOn ? '#4ade80' : '#818cf8';
      setText(p._okEl,     `${this.okSendCount}/${this.okPerCycle}`);
      setText(p._cycleEl,  String(this.cycleCount));
      setText(p._retryEl,  String(this.retryCount));
      setText(p._btn,  chatOn ? '⏹ Dừng' : '⚙ Config & Start');
      p._btn.className = chatOn ? 'ag-btn ag-btn-stop' : 'ag-btn ag-btn-green';
    },

    // ── Core state machine ────────────────────────────────────────────────────
    processOnce() {
      if (!chatOn || this.isProcessing) return;
      // Chặn nếu: retry đang type/send, HOẶC vừa xử lý retry chưa đủ cooldown, HOẶC đang có banner lỗi
      if (retryBusy) return;
      if (retryOn && findErrorBanner()) return;  // có banner lỗi → để retry xử lý
      if (retryOn && Date.now() - lastRetryHandledAt < CHAT_BLOCK_AFTER_RETRY_MS) return; // vừa retry xong
      this.isProcessing = true;
      try {
        const now  = Date.now();
        const docs = getTargetDocs();

        // ── SENDING_PROMPT ──
        if (this.phase === 'sending_prompt') {
          if (this.newChatOpenedAt && now - this.newChatOpenedAt < NEW_CHAT_LOAD_MS) return;

          if (!this.promptSent) {
            for (const doc of docs) {
              if (chatTrySendText(doc, this.initialPrompt, () => {
                this.log(`📝 Gửi prompt (cycle ${this.cycleCount + 1})`, 'info');
              })) {
                this.promptSent = true;
                this.lastSendAt = now;
                this.updatePanel();
                return;
              }
            }
            return;
          }

          // Chờ AI bắt đầu (cancel button xuất hiện)
          for (const doc of docs) {
            if (findTooltipBtn(doc, 'input-send-button-cancel-tooltip', false)) {
              this.promptSentConfirmed = true;
              return;
            }
          }

          if (this.promptSentConfirmed) {
            // AI đã xong → có retry button thì click
            for (const doc of docs) {
              const rb = findAnyRetryBtn(doc);
              if (rb && !retryOn) { rb.click(); this.retryCount++; this.updatePanel(); return; }
            }
            this.phase = 'auto_ok';
            this.okSendCount = 0;
            this.lastSendAt  = now;
            this.promptSent  = false;
            this.promptSentConfirmed = false;
            this.updatePanel();
            this.log('✅ Prompt xong. Bắt đầu ok cycle...', 'success');
            return;
          }

          if (now - this.lastSendAt > PROMPT_TIMEOUT_MS) {
            this.promptSent = false;
            this.log('⚠️ Timeout, thử lại prompt...', 'warn');
          }
          return;
        }

        // ── AUTO_OK ──
        if (this.phase === 'auto_ok') {
          if (this.okSendCount >= this.okPerCycle) {
            this.phase = 'waiting_completion';
            this.updatePanel();
            this.log(`✉️ Đủ ${this.okPerCycle} ok. Chờ AI...`, 'info');
            return;
          }

          const sinceRetry = now - this.lastRetryAt;
          const sinceSend  = now - this.lastSendAt;
          if (sinceRetry < RETRY_COOLDOWN_MS && sinceSend < SEND_COOLDOWN_MS) return;

          for (const doc of docs) {
            const rb = findAnyRetryBtn(doc);
            if (rb && !retryOn) {
              if (sinceRetry < RETRY_COOLDOWN_MS) return;
              rb.click(); this.retryCount++; this.lastRetryAt = this.lastSendAt = now;
              this.updatePanel();
              this.log(`🔄 Retry (${this.retryCount})`, 'warn');
              return;
            }
          }

          // Không retry → tìm send button
          for (const doc of docs) {
            if (findTooltipBtn(doc, 'input-send-button-cancel-tooltip', false)) return; // AI đang chạy
            const s = findTooltipBtn(doc, 'input-send-button-send-tooltip', false);
            if (s) {
              if (sinceSend < SEND_COOLDOWN_MS) return;
              chatTrySendText(doc, 'ok', () => {
                this.okSendCount++;
                this.lastSendAt = Date.now();
                this.log(`✉️ ok (${this.okSendCount}/${this.okPerCycle}) cycle ${this.cycleCount + 1}`, 'info');
                this.updatePanel();
              });
              return;
            }
          }
          return;
        }

        // ── WAITING_COMPLETION ──
        if (this.phase === 'waiting_completion') {
          for (const doc of docs) {
            if (findTooltipBtn(doc, 'input-send-button-cancel-tooltip', false)) return; // AI đang chạy
            const rb = findAnyRetryBtn(doc);
            if (rb && !retryOn) { rb.click(); this.retryCount++; this.lastRetryAt = now; this.updatePanel(); return; }
          }
          this.cycleCount++;
          this.phase = 'opening_new_chat';
          this.lastSendAt = now;
          this.updatePanel();
          this.log(`🔄 Cycle ${this.cycleCount} xong. Mở chat mới...`, 'success');
          return;
        }

        // ── OPENING_NEW_CHAT ──
        if (this.phase === 'opening_new_chat') {
          if (now - this.lastSendAt < NEW_CHAT_DELAY_MS) return;
          for (const doc of docs) {
            const nb = findNewChatBtn(doc);
            if (nb) {
              nb.click();
              this.phase = 'sending_prompt';
              this.promptSent = false;
              this.promptSentConfirmed = false;
              this.okSendCount = 0;
              this.newChatOpenedAt = now;
              this.updatePanel();
              this.log('🆕 Đã mở chat mới. Gửi prompt...', 'info');
              return;
            }
          }
          this.log('⚠️ Không tìm thấy nút New Chat.', 'warn');
          return;
        }
      } catch (_) {
      } finally {
        this.isProcessing = false;
      }
    },

    // ── Panel creation ────────────────────────────────────────────────────────
    createPanel() {
      const root = el('div', { bottom:'80px', right:'280px' }); // bên trái Auto-Retry
      root.className = 'ag-panel';

      const hdr = el('div'); hdr.className = 'ag-hdr';
      const titleRow = el('div'); titleRow.className = 'ag-title';
      const dot = el('div'); dot.className = 'ag-dot'; setDot(dot, false);
      titleRow.appendChild(dot);
      const ts = el('span'); setText(ts, 'Auto-Chat'); titleRow.appendChild(ts);
      const xBtn = el('div'); xBtn.className = 'ag-x'; setText(xBtn, '✕');
      hdr.appendChild(titleRow); hdr.appendChild(xBtn);

      const body = el('div'); body.className = 'ag-body';

      // Phase badge
      const phaseEl = el('div'); phaseEl.className = 'ag-phase'; setText(phaseEl, '⬜ Idle');

      // Stats
      const stats = el('div'); stats.className = 'ag-stats';

      const s1 = el('span'); s1.className = 'ag-stat'; setText(s1, '✉️ ok: ');
      const okEl = el('span'); setText(okEl, '0/10'); s1.appendChild(okEl);

      const s2 = el('span'); s2.className = 'ag-stat'; setText(s2, '🔄 cycles: ');
      const cycleEl = el('span'); setText(cycleEl, '0'); s2.appendChild(cycleEl);

      const s3 = el('span'); s3.className = 'ag-stat'; setText(s3, '↺ retry: ');
      const retryEl = el('span'); setText(retryEl, '0'); s3.appendChild(retryEl);

      stats.appendChild(s1); stats.appendChild(s2); stats.appendChild(s3);

      // ── Auto-Accept checkbox ──
      const cChkRow = el('div'); cChkRow.className = 'ag-chk-row';
      const cChk = el('input', {}, {type:'checkbox'}); cChk.className = 'ag-chk';
      cChk.checked = autoAcceptOn;
      const cChkLbl = el('span'); cChkLbl.className = 'ag-chk-lbl'; setText(cChkLbl, 'Tự động accept file');
      cChkRow.appendChild(cChk); cChkRow.appendChild(cChkLbl);
      cChkRow.addEventListener('click', (e) => { if (e.target !== cChk) cChk.checked = !cChk.checked; autoAcceptOn = cChk.checked; syncInterval(); if (R.panel && R.panel._chkEl) R.panel._chkEl.checked = autoAcceptOn; });
      cChk.addEventListener('change', () => { autoAcceptOn = cChk.checked; syncInterval(); if (R.panel && R.panel._chkEl) R.panel._chkEl.checked = autoAcceptOn; });

      const btn = el('button'); btn.className = 'ag-btn ag-btn-green'; setText(btn, '⚙ Config & Start');
      btn.addEventListener('click', () => this.toggle());

      const div = el('div'); div.className = 'ag-div';
      const logEl = el('div'); logEl.className = 'ag-log';
      div.appendChild(logEl);

      body.appendChild(phaseEl); body.appendChild(stats);
      body.appendChild(cChkRow); body.appendChild(btn); body.appendChild(div);
      root.appendChild(hdr); root.appendChild(body);
      document.body.appendChild(root);
      makeDraggable(root, hdr);

      this.panel = { root, _dot:dot, _phaseEl:phaseEl, _okEl:okEl, _cycleEl:cycleEl, _retryEl:retryEl, _btn:btn, _logEl:logEl, _chkEl:cChk };
      xBtn.addEventListener('click', () => { this.stop(); root.remove(); this.panel = null; });
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════════════════
  injectStyles();
  R.createPanel(); R.log('Sẵn sàng.', 'info');
  C.createPanel(); C.log('Sẵn sàng. Nhấn "Config & Start".', 'info');
  attachChatObservers();

  window.autoRetry = R;
  window.autoChat  = C;
  console.log('%c[AG] ✅ Auto-Retry + Auto-Chat sẵn sàng!', 'color:#4ade80;font-weight:bold');
  console.log('%c  autoRetry.start() / stop()', 'color:#94a3b8');
  console.log('%c  autoChat.toggle()  → mở popup cấu hình', 'color:#94a3b8');
})();
