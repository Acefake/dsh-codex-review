/**
 * v2.3 page probes (CONTRACT.md §8): comment write operations — reply to an
 * inline review comment, resolve a review thread, and post a PR issue comment.
 *
 * The v2.3 client exposes stable hooks; probes prefer them and keep a text
 * fallback so a partially deployed UI still yields actionable diagnostics.
 *
 * Hooks (plugin/client.js v2.3):
 *   inline comment card: [data-inline-comment] (one card per GitHub inline
 *                        comment), [data-action="inline-reply"],
 *                        [data-action="inline-resolve"] (only when the comment
 *                        carries a threadId and is not resolved)
 *   reply composer:      [data-inline-reply-composer="ready"],
 *                        textarea, [data-action="inline-reply-send"],
 *                        [data-action="inline-reply-cancel"]
 *   resolve confirm:     [data-inline-resolve-confirm="ready"],
 *                        [data-action="inline-resolve-confirm"],
 *                        [data-action="inline-resolve-cancel"]
 *   PR comment dialog:   [data-cr-comment-dialog="open|closed"],
 *                        [data-comment-phase="idle|submitting|error"],
 *                        textarea, [data-action="comment-send"],
 *                        [data-action="comment-cancel"]
 *
 * SAFETY: every probe is read-only. The only click targets exported here are
 * the cancel buttons, the inline reply/resolve triggers (they open a local
 * composer/confirmation) and the PR-comment trigger (opens a local dialog).
 * Nothing in this module ever clicks send/confirm.
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
  const visibleAll = (selector) => Array.from(document.querySelectorAll(selector)).filter(visible);
  const closestVisible = (selector) => visibleAll(selector)[0] || null;
  const cards = () => Array.from(document.querySelectorAll('[data-inline-comment]'));
  const cardFor = (el) => (el && el.closest ? el.closest('[data-inline-comment]') : null);
  const describeButton = (el) => (el && visible(el) ? { ...describe(el), disabled: el.disabled === true } : null);
`

/**
 * Workbench-level v2.3 surface: how many inline-comment cards exist, whether
 * the reply/resolve triggers rendered, and the PR comment trigger + dialog
 * state.
 * @returns {string} page expression
 */
export function v23Surface() {
  return `(() => {
    ${HELPERS}
    const root = document.querySelector('[data-cr-root]');
    const allCards = cards();
    const replyButtons = visibleAll('[data-action="inline-reply"]');
    const resolveButtons = visibleAll('[data-action="inline-resolve"]');
    const commentButton = closestVisible('[data-action="pr-comment"]');
    const dialogNode = document.querySelector('[data-cr-comment-dialog]');
    return {
      rootReady: Boolean(root),
      detailReady: Boolean(document.querySelector('[data-cr-detail="ready"]')),
      reviewState: root ? attr(root, 'data-cr-review-state') : null,
      commentDialog: root ? attr(root, 'data-cr-comment-dialog') : null,
      inlineCommentCards: allCards.length,
      visibleInlineCards: allCards.filter(visible).length,
      replyButtons: replyButtons.length,
      resolveButtons: resolveButtons.length,
      replyButton: replyButtons[0] ? describe(replyButtons[0]) : null,
      resolveButton: resolveButtons[0] ? describe(resolveButtons[0]) : null,
      commentButton: describeButton(commentButton),
      dialogPresent: Boolean(dialogNode),
      bodyTextSample: textOf(document.body).slice(0, 800),
    };
  })()`
}

/**
 * Locate the first visible inline-comment 「回复」 button for a click.
 * @returns {string} page expression
 */
export function inlineReplyTarget() {
  return `(() => {
    ${HELPERS}
    const button = closestVisible('[data-action="inline-reply"]');
    if (!button) return { found: false, reason: cards().length === 0 ? 'no-inline-comments' : 'reply-button-missing' };
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    const card = cardFor(button);
    return {
      found: true,
      disabled: button.disabled === true,
      text: textOf(button).slice(0, 80),
      rect: rectOf(button),
      cardCount: cards().length,
      cardText: card ? textOf(card).slice(0, 160) : '',
    };
  })()`
}

/**
 * The inline reply composer (opened by 「回复」): presence, the textarea, the
 * send/cancel buttons and its text.
 * @returns {string} page expression
 */
export function inlineReplyComposerProbe() {
  return `(() => {
    ${HELPERS}
    const node = document.querySelector('[data-inline-reply-composer="ready"]');
    if (!node) return { open: false, textarea: null, send: null, cancel: null, text: '', cardText: '' };
    const card = cardFor(node);
    const textarea = node.querySelector('textarea');
    const send = node.querySelector('[data-action="inline-reply-send"]');
    const cancel = node.querySelector('[data-action="inline-reply-cancel"]');
    return {
      open: visible(node),
      textarea: textarea && visible(textarea) ? { ...describe(textarea), disabled: textarea.disabled === true } : null,
      send: describeButton(send),
      cancel: describeButton(cancel),
      text: textOf(node).slice(0, 400),
      cardText: card ? textOf(card).slice(0, 200) : '',
    };
  })()`
}

/**
 * Locate the reply composer's 「取消」 button (the only reply action the
 * harness ever clicks).
 * @returns {string} page expression
 */
export function inlineReplyCancelTarget() {
  return `(() => {
    ${HELPERS}
    const node = document.querySelector('[data-inline-reply-composer="ready"]');
    const button = node ? node.querySelector('[data-action="inline-reply-cancel"]') : null;
    if (!button || !visible(button)) return { found: false };
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    return { found: true, ...describe(button), disabled: button.disabled === true };
  })()`
}

/**
 * Locate the first visible 「解决」 button (only rendered for comments that
 * carry a threadId and are not resolved yet).
 * @returns {string} page expression
 */
export function inlineResolveTarget() {
  return `(() => {
    ${HELPERS}
    const button = closestVisible('[data-action="inline-resolve"]');
    if (!button) return { found: false, reason: 'resolve-button-missing' };
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    return {
      found: true,
      disabled: button.disabled === true,
      text: textOf(button).slice(0, 80),
      rect: rectOf(button),
    };
  })()`
}

/**
 * The resolve confirmation block: presence, its text and the confirm/cancel
 * buttons. The harness only ever clicks cancel.
 * @returns {string} page expression
 */
export function inlineResolveConfirmProbe() {
  return `(() => {
    ${HELPERS}
    const node = document.querySelector('[data-inline-resolve-confirm="ready"]');
    if (!node) return { open: false, confirm: null, cancel: null, text: '' };
    const confirm = node.querySelector('[data-action="inline-resolve-confirm"]');
    const cancel = node.querySelector('[data-action="inline-resolve-cancel"]');
    return {
      open: visible(node),
      confirm: describeButton(confirm),
      cancel: describeButton(cancel),
      text: textOf(node).slice(0, 400),
    };
  })()`
}

/**
 * Locate the resolve confirmation's 「取消」 button.
 * @returns {string} page expression
 */
export function inlineResolveCancelTarget() {
  return `(() => {
    ${HELPERS}
    const node = document.querySelector('[data-inline-resolve-confirm="ready"]');
    const button = node ? node.querySelector('[data-action="inline-resolve-cancel"]') : null;
    if (!button || !visible(button)) return { found: false };
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    return { found: true, ...describe(button), disabled: button.disabled === true };
  })()`
}

/**
 * Locate the PR header 「评论」 button (opens the issue-comment dialog).
 * @returns {string} page expression
 */
export function prCommentTriggerTarget() {
  return `(() => {
    ${HELPERS}
    const button = closestVisible('[data-action="pr-comment"]');
    if (!button) return { found: false };
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    return { found: true, disabled: button.disabled === true, text: textOf(button).slice(0, 80), rect: rectOf(button) };
  })()`
}

/**
 * PR issue-comment dialog: open state, phase, textarea and action buttons.
 * @returns {string} page expression
 */
export function prCommentDialogProbe() {
  return `(() => {
    ${HELPERS}
    const dialog = closestVisible('[data-cr-comment-dialog="open"]');
    if (!dialog) {
      const root = document.querySelector('[data-cr-root]');
      return {
        open: false,
        rootState: root ? attr(root, 'data-cr-comment-dialog') : null,
        phase: null,
        hasTextarea: false,
        send: null,
        cancel: null,
        text: '',
      };
    }
    const textarea = dialog.querySelector('textarea');
    const send = dialog.querySelector('[data-action="comment-send"]');
    const cancel = dialog.querySelector('[data-action="comment-cancel"]');
    return {
      open: true,
      rootState: null,
      phase: attr(dialog, 'data-comment-phase'),
      hasTextarea: Boolean(textarea && visible(textarea)),
      textarea: textarea && visible(textarea) ? { ...describe(textarea), disabled: textarea.disabled === true } : null,
      send: describeButton(send),
      cancel: describeButton(cancel),
      text: textOf(dialog).slice(0, 600),
    };
  })()`
}

/**
 * Locate the PR comment dialog's 「取消」 button.
 * @returns {string} page expression
 */
export function prCommentCancelTarget() {
  return `(() => {
    ${HELPERS}
    const dialog = closestVisible('[data-cr-comment-dialog="open"]');
    const button = dialog ? dialog.querySelector('[data-action="comment-cancel"]') : null;
    if (!button || !visible(button)) return { found: false };
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    return { found: true, ...describe(button), disabled: button.disabled === true };
  })()`
}
