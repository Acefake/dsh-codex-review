/**
 * v2 page probes (CONTRACT.md §5.3/§5.4): merge confirmation dialog and the PR
 * chat panel.
 *
 * The v2 client exposes stable hooks; probes prefer them and keep a text/role
 * fallback so a partially deployed UI still yields actionable diagnostics.
 *
 * Hooks (plugin/client.js v2):
 *   workbench root: [data-cr-merge-open], [data-cr-chat-open], [data-cr-chat-streaming], [data-cr-chat-messages]
 *   merge trigger:  [data-action="merge"]
 *   merge dialog:   [data-merge-phase] (modal), [data-merge-method], [data-merge-repo],
 *                   [data-merge-sha], [data-merge-method-value], [data-merge-delete="toggle"],
 *                   [data-merge-error], [data-action="merge-cancel"], [data-action="merge-confirm"]
 *   chat input:     [data-chat-input="ready"] (placeholder 就此 Pull Request 提问)
 *   chat panel:     [data-cr-chat="ready"], [data-chat-body], [data-chat-role],
 *                   [data-chat-caret], [data-chat-error], [data-action="chat-stop"|"chat-send"|"chat-clear"|"chat-close"|"chat-quick"]
 */

const HELPERS = `
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01;
  };
  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; };
  const attr = (el, name) => (el.getAttribute ? el.getAttribute(name) : null);
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    text: textOf(el).slice(0, 240),
    aria: attr(el, 'aria-label'),
    title: attr(el, 'title'),
    role: attr(el, 'role'),
    className: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
    dataAction: attr(el, 'data-action'),
    rect: rectOf(el),
  });
  const pressable = (pattern, scope) => {
    const root = scope || document;
    const results = [];
    for (const el of root.querySelectorAll('button, [role="button"], [role="radio"], [role="option"], a, [tabindex]')) {
      if (!visible(el)) continue;
      const text = textOf(el);
      const label = [attr(el, 'aria-label'), attr(el, 'title'), attr(el, 'value'), text].filter(Boolean).join(' | ');
      if (pattern.test(label)) results.push({ ...describe(el), label: label.slice(0, 200), disabled: el.disabled === true || attr(el, 'aria-disabled') === 'true' });
    }
    return results;
  };
`

/**
 * Workbench v2 surface inventory: merge trigger + chat entry points.
 * @returns {string} page expression
 */
export function v2Surface() {
  return `(() => {
    ${HELPERS}
    const root = document.querySelector('[data-cr-root]');
    const mergeButton = document.querySelector('[data-action="merge"]');
    const chatInput = document.querySelector('[data-chat-input="ready"]');
    const chatPanel = document.querySelector('[data-cr-chat="ready"]');
    const chatOpenButton = document.querySelector('[data-action="chat-open"]');
    return {
      rootReady: Boolean(root),
      mergeButton: mergeButton && visible(mergeButton) ? { ...describe(mergeButton), disabled: mergeButton.disabled === true || attr(mergeButton, 'aria-disabled') === 'true' } : null,
      mergeOpen: root ? attr(root, 'data-cr-merge-open') : null,
      chatInput: chatInput && visible(chatInput) ? { ...describe(chatInput), placeholder: attr(chatInput, 'placeholder') } : null,
      chatPanel: chatPanel && visible(chatPanel) ? describe(chatPanel) : null,
      chatOpen: root ? attr(root, 'data-cr-chat-open') : null,
      chatStreaming: root ? attr(root, 'data-cr-chat-streaming') : null,
      chatMessages: root ? attr(root, 'data-cr-chat-messages') : null,
      chatOpenButton: chatOpenButton && visible(chatOpenButton) ? describe(chatOpenButton) : null,
      quickPrompts: Array.from(document.querySelectorAll('[data-action="chat-quick"], [data-action="chat-quick-risks"]')).filter(visible).map(describe).slice(0, 8),
      bodyTextSample: textOf(document.body).slice(0, 600),
    };
  })()`
}

/**
 * Merge confirmation dialog (CONTRACT §5.3): fields, risk copy, cancel/confirm.
 * @returns {string} page expression
 */
export function mergeDialogProbe() {
  return `(() => {
    ${HELPERS}
    const modal = Array.from(document.querySelectorAll('[data-merge-phase]')).filter(visible)[0]
      || Array.from(document.querySelectorAll('[role="dialog"], [class*="modal" i]')).filter(visible).find((el) => /合并|merge/i.test(textOf(el)))
      || null;
    if (!modal) return { open: false, dialogText: '', methods: [], cancel: null, confirm: null, deleteBranch: [], hasRiskWarning: false, hasRepoNumber: false, hasBranches: false, hasHeadSha: false };
    const methodValues = Array.from(modal.querySelectorAll('[data-merge-method-value]')).map((el) => ({
      value: attr(el, 'data-merge-method-value'),
      text: textOf(el),
      checked: attr(el, 'aria-checked') === 'true' || (el.querySelector && Boolean(el.querySelector('input:checked'))),
      rect: rectOf(el),
    }));
    const deleteInput = modal.querySelector('[data-merge-delete="toggle"]');
    const cancel = modal.querySelector('[data-action="merge-cancel"]');
    const confirm = modal.querySelector('[data-action="merge-confirm"]');
    const text = textOf(modal);
    return {
      open: true,
      phase: attr(modal, 'data-merge-phase'),
      method: attr(modal, 'data-merge-method'),
      dialogText: text.slice(0, 800),
      methodValues,
      methods: methodValues,
      deleteBranch: deleteInput ? [{ checked: Boolean(deleteInput.checked), rect: rectOf(deleteInput) }] : [],
      cancel: cancel && visible(cancel) ? { ...describe(cancel), disabled: cancel.disabled === true } : null,
      confirm: confirm && visible(confirm) ? { ...describe(confirm), disabled: confirm.disabled === true } : null,
      error: modal.querySelector('[data-merge-error]') ? textOf(modal.querySelector('[data-merge-error]')) : null,
      repo: modal.querySelector('[data-merge-repo]') ? textOf(modal.querySelector('[data-merge-repo]')) : null,
      sha: modal.querySelector('[data-merge-sha]') ? textOf(modal.querySelector('[data-merge-sha]')) : null,
      hasRiskWarning: /写操作|真实|不可撤销|风险|write operation|cannot be undone|for real/i.test(text),
      hasHeadSha: /[0-9a-f]{7,12}/i.test(text),
      hasRepoNumber: /#\\d+/.test(text),
      hasBranches: /→|->/.test(text),
    };
  })()`
}

/**
 * PR chat panel (CONTRACT §5.2/§5.3): bubbles, streaming state, controls.
 * @returns {string} page expression
 */
export function chatPanelProbe() {
  return `(() => {
    ${HELPERS}
    const root = document.querySelector('[data-cr-root]');
    const panel = document.querySelector('[data-cr-chat="ready"]');
    const body = document.querySelector('[data-chat-body="ready"]') || panel;
    const bubbles = body ? Array.from(body.querySelectorAll('[data-chat-role]')).filter(visible) : [];
    const mapped = bubbles.map((el) => ({ role: attr(el, 'data-chat-role'), text: textOf(el).slice(0, 800), rect: rectOf(el) }));
    const users = mapped.filter((bubble) => bubble.role === 'user');
    const assistants = mapped.filter((bubble) => bubble.role === 'assistant');
    const stop = document.querySelector('[data-action="chat-stop"]');
    const send = document.querySelector('[data-action="chat-send"]');
    const clear = document.querySelector('[data-action="chat-clear"]');
    const close = document.querySelector('[data-action="chat-close"]');
    const input = document.querySelector('[data-chat-input="ready"]');
    const error = document.querySelector('[data-chat-error]');
    const streaming = (root ? attr(root, 'data-cr-chat-streaming') === 'true' : false) || Boolean(document.querySelector('[data-chat-caret]')) || Boolean(stop && visible(stop));
    return {
      open: Boolean(panel && visible(panel)) || (root ? attr(root, 'data-cr-chat-open') === 'open' : false),
      panelText: panel ? textOf(panel).slice(0, 1200) : '',
      bubbleCount: mapped.length,
      userBubbleCount: users.length,
      assistantBubbleCount: assistants.length,
      bubbles: mapped.slice(-8),
      streaming,
      stop: stop && visible(stop) ? { text: textOf(stop), rect: rectOf(stop) } : null,
      send: send && visible(send) ? { text: textOf(send), rect: rectOf(send), disabled: send.disabled === true } : null,
      clear: clear && visible(clear) ? { text: textOf(clear), rect: rectOf(clear) } : null,
      close: close && visible(close) ? { text: textOf(close), rect: rectOf(close) } : null,
      error: error ? { code: attr(error, 'data-chat-error'), text: textOf(error).slice(0, 300) } : null,
      input: input && visible(input) ? { ...describe(input), placeholder: attr(input, 'placeholder') } : null,
      assistantText: assistants.map((bubble) => bubble.text).join('\\n').slice(0, 3000),
      userText: users.map((bubble) => bubble.text).join('\\n').slice(0, 1200),
      messagesAttr: root ? attr(root, 'data-cr-chat-messages') : null,
    };
  })()`
}

/**
 * Locate the chat input and return a click point.
 * @returns {string} page expression
 */
export function chatInputTarget() {
  return `(() => {
    ${HELPERS}
    const input = document.querySelector('[data-chat-input="ready"]');
    if (!input || !visible(input)) return { found: false };
    input.scrollIntoView({ block: 'center', inline: 'nearest' });
    return { found: true, ...describe(input), placeholder: attr(input, 'placeholder') };
  })()`
}

/**
 * Locate the chat send button (falls back to Enter when absent).
 * @returns {string} page expression
 */
export function chatSendTarget() {
  return `(() => {
    ${HELPERS}
    const send = document.querySelector('[data-action="chat-send"]');
    if (!send || !visible(send)) return { found: false };
    return { found: true, ...describe(send), disabled: send.disabled === true };
  })()`
}

/**
 * Chat history persisted per PR in localStorage (CONTRACT §5.2).
 * @returns {string} page expression
 */
export function chatStorageProbe() {
  return `(() => {
    const keys = [];
    try {
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key && key.startsWith('codex-review:chat:')) keys.push(key);
      }
    } catch {}
    const values = {};
    for (const key of keys.slice(0, 8)) {
      try { values[key] = String(window.localStorage.getItem(key) ?? '').slice(0, 400); } catch {}
    }
    return { keys, values };
  })()`
}
