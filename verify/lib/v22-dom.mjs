/**
 * v2.2 page probes (CONTRACT.md §7.3/§7.4): the "publish review to GitHub"
 * confirmation dialog and the auto-publish switch inside the review-settings
 * dialog.
 *
 * The v2.2 client exposes stable hooks; probes prefer them and keep a role/text
 * fallback so a partially deployed UI still yields actionable diagnostics.
 *
 * Hooks (plugin/client.js v2.2):
 *   workbench root:  [data-cr-publish-supported="true|false"],
 *                    [data-cr-publish-dialog="open|closed"],
 *                    [data-cr-publish-published="true|false"]
 *   review card:     [data-action="review-publish"], [data-publish-published="true"]
 *   publish dialog:  [data-cr-publish-dialog="ready"] (backdrop), [role="dialog"],
 *                    [data-publish-phase="idle|submitting"], [data-publish-mode],
 *                    [data-publish-mode-value="inline|summary|both"],
 *                    [data-publish-min-value="P0|P1|P2"], [data-publish-repo],
 *                    [data-publish-expected], [data-publish-error],
 *                    [data-action="publish-cancel"|"publish-confirm"]
 *   auto publish:    [data-auto-publish-section="ready"], [data-auto-publish="toggle"],
 *                    [data-auto-publish-confirm="ready"],
 *                    [data-action="auto-publish-confirm"|"auto-publish-cancel"],
 *                    [data-auto-publish-mode], [data-auto-publish-min],
 *                    [data-auto-publish-max], [data-auto-publish-status="true|false"]
 *
 * Probes are read-only: nothing here clicks "确认发布" / "确认开启". The two
 * explicit click targets ([publish mode], [auto-publish toggle]) only change
 * local React state.
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
  const closestVisible = (selector) => Array.from(document.querySelectorAll(selector)).filter(visible)[0] || null;
`

/**
 * Workbench-level v2.2 surface: publish capability flag, dialog state, the
 * review-card trigger and the published link.
 * @returns {string} page expression
 */
export function v22Surface() {
  return `(() => {
    ${HELPERS}
    const root = document.querySelector('[data-cr-root]');
    const button = closestVisible('[data-action="review-publish"]');
    const published = closestVisible('[data-publish-published="true"]');
    return {
      rootReady: Boolean(root),
      supported: root ? attr(root, 'data-cr-publish-supported') : null,
      dialog: root ? attr(root, 'data-cr-publish-dialog') : null,
      publishedFlag: root ? attr(root, 'data-cr-publish-published') : null,
      reviewState: root ? attr(root, 'data-cr-review-state') : null,
      publishButton: button ? { ...describe(button), disabled: button.disabled === true } : null,
      publishedLink: published ? { ...describe(published), href: attr(published, 'href') } : null,
      bodyTextSample: textOf(document.body).slice(0, 800),
    };
  })()`
}

/**
 * Locate the review-card 「发布到 GitHub」 button for a click (scrolls it into
 * the viewport first; CDP clicks only land inside the viewport).
 * @returns {string} page expression
 */
export function publishTriggerTarget() {
  return `(() => {
    ${HELPERS}
    const button = closestVisible('[data-action="review-publish"]');
    if (!button) return { found: false };
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    return { found: true, disabled: button.disabled === true, text: textOf(button).slice(0, 80), rect: rectOf(button) };
  })()`
}

/**
 * Publish confirmation dialog (CONTRACT §7.3): repo#number, reviewed head,
 * estimated comment count, mode/minSeverity triples, write warning, actions.
 * @returns {string} page expression
 */
export function publishDialogProbe() {
  return `(() => {
    ${HELPERS}
    const root = document.querySelector('[data-cr-root]');
    const rootState = root ? attr(root, 'data-cr-publish-dialog') : null;
    const backdrop = closestVisible('[data-cr-publish-dialog="ready"]');
    const dialog = backdrop ? (backdrop.querySelector('[role="dialog"]') || backdrop) : null;
    if (!dialog) {
      return {
        open: false, rootState, phase: null, mode: null, dialogText: '',
        modes: [], mins: [], modeValues: [], minValues: [],
        expected: null, expectedText: '', hasExpectedLabel: false,
        repo: '', headSha: null, cancel: null, confirm: null, error: null,
        hasRiskWarning: false, hasRepoNumber: false,
      };
    }
    const text = textOf(dialog);
    const modes = Array.from(dialog.querySelectorAll('[data-publish-mode-value]')).map((el) => {
      const host = el.closest('label') || el;
      return {
        value: attr(el, 'data-publish-mode-value'),
        checked: el.checked === true || attr(el, 'aria-checked') === 'true',
        disabled: el.disabled === true,
        text: textOf(host).slice(0, 160),
        rect: rectOf(host),
        inputRect: rectOf(el),
      };
    });
    const mins = Array.from(dialog.querySelectorAll('[data-publish-min-value]')).map((el) => {
      const host = el.closest('label') || el;
      return {
        value: attr(el, 'data-publish-min-value'),
        checked: el.checked === true || attr(el, 'aria-checked') === 'true',
        disabled: el.disabled === true,
        text: textOf(host).slice(0, 120),
        rect: rectOf(host),
        inputRect: rectOf(el),
      };
    });
    const expectedNode = dialog.querySelector('[data-publish-expected]');
    const expectedValue = expectedNode === null ? null : Number(attr(expectedNode, 'data-publish-expected'));
    const repoNode = dialog.querySelector('[data-publish-repo]');
    const shaNode = Array.from(dialog.querySelectorAll('[title]'))
      .filter((el) => /^[0-9a-f]{7,40}$/i.test(attr(el, 'title') || ''))[0] || null;
    const cancel = dialog.querySelector('[data-action="publish-cancel"]');
    const confirm = dialog.querySelector('[data-action="publish-confirm"]');
    const errorNode = dialog.querySelector('[data-publish-error]');
    return {
      open: true,
      rootState,
      phase: attr(dialog, 'data-publish-phase'),
      mode: attr(dialog, 'data-publish-mode'),
      dialogText: text.slice(0, 900),
      modes,
      mins,
      modeValues: modes.map((entry) => entry.value),
      minValues: mins.map((entry) => entry.value),
      expected: Number.isFinite(expectedValue) ? expectedValue : null,
      expectedText: expectedNode ? textOf(expectedNode) : '',
      hasExpectedLabel: /预计评论数|Estimated comments/i.test(text),
      repo: repoNode ? textOf(repoNode) : '',
      headSha: shaNode ? attr(shaNode, 'title') : null,
      cancel: cancel && visible(cancel) ? { ...describe(cancel), disabled: cancel.disabled === true } : null,
      confirm: confirm && visible(confirm) ? { ...describe(confirm), disabled: confirm.disabled === true } : null,
      error: errorNode ? { code: attr(errorNode, 'data-publish-error'), text: textOf(errorNode).slice(0, 300) } : null,
      hasRiskWarning: /写操作|真的|review 评论|write operation/i.test(text),
      hasRepoNumber: /#[0-9]+/.test(text),
    };
  })()`
}

/**
 * Locate one publish-mode radio (by `data-publish-mode-value`) for a click.
 * @param {'inline'|'summary'|'both'} value
 * @returns {string} page expression
 */
export function publishModeTarget(value) {
  return `(() => {
    ${HELPERS}
    const needle = ${JSON.stringify(String(value))};
    const input = Array.from(document.querySelectorAll('[data-publish-mode-value]'))
      .find((el) => attr(el, 'data-publish-mode-value') === needle) || null;
    if (!input) return { found: false };
    const host = input.closest('label') || input;
    if (!visible(host)) return { found: false };
    host.scrollIntoView({ block: 'center', inline: 'nearest' });
    return { found: true, value: needle, checked: input.checked === true, rect: rectOf(host), inputRect: rectOf(input) };
  })()`
}

/**
 * Locate one minimum-severity radio (by `data-publish-min-value`) for a click.
 * @param {'P0'|'P1'|'P2'} value
 * @returns {string} page expression
 */
export function publishMinTarget(value) {
  return `(() => {
    ${HELPERS}
    const needle = ${JSON.stringify(String(value))};
    const input = Array.from(document.querySelectorAll('[data-publish-min-value]'))
      .find((el) => attr(el, 'data-publish-min-value') === needle) || null;
    if (!input) return { found: false };
    const host = input.closest('label') || input;
    if (!visible(host)) return { found: false };
    host.scrollIntoView({ block: 'center', inline: 'nearest' });
    return { found: true, value: needle, checked: input.checked === true, rect: rectOf(host), inputRect: rectOf(input) };
  })()`
}

/**
 * Locate the dialog's 「取消」 button (the only action the harness ever clicks).
 * @returns {string} page expression
 */
export function publishCancelTarget() {
  return `(() => {
    ${HELPERS}
    const backdrop = closestVisible('[data-cr-publish-dialog="ready"]');
    const button = backdrop ? backdrop.querySelector('[data-action="publish-cancel"]') : null;
    if (!button || !visible(button)) return { found: false };
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    return { found: true, ...describe(button), disabled: button.disabled === true };
  })()`
}

/**
 * Auto-publish block inside the review-settings dialog (CONTRACT §7.3): toggle
 * state, the second-confirmation block and its buttons, mode/severity/max.
 * @returns {string} page expression
 */
export function autoPublishProbe() {
  return `(() => {
    ${HELPERS}
    const dialog = closestVisible('[role="dialog"][aria-modal="true"]');
    const section = (dialog ? dialog.querySelector('[data-auto-publish-section="ready"]') : null)
      || closestVisible('[data-auto-publish-section="ready"]');
    if (!section) {
      return {
        open: false, dialogOpen: Boolean(dialog), text: '', toggle: null,
        confirmOpen: false, confirm: null,
        modes: [], minSeverities: [], hasMaxComments: false, hasHint: false,
      };
    }
    const text = textOf(section);
    const toggle = section.querySelector('[data-auto-publish="toggle"]');
    const toggleHost = toggle ? (toggle.closest('label') || toggle) : null;
    const confirmBlock = section.querySelector('[data-auto-publish-confirm="ready"]');
    const confirmVisible = confirmBlock ? visible(confirmBlock) : false;
    const confirmButton = confirmVisible ? confirmBlock.querySelector('[data-action="auto-publish-confirm"]') : null;
    const cancelButton = confirmVisible ? confirmBlock.querySelector('[data-action="auto-publish-cancel"]') : null;
    const modes = Array.from(section.querySelectorAll('[data-auto-publish-mode]')).map((el) => ({
      value: attr(el, 'data-auto-publish-mode'),
      checked: el.checked === true,
      text: textOf(el.closest('label') || el).slice(0, 120),
      rect: rectOf(el.closest('label') || el),
    }));
    const minSeverities = Array.from(section.querySelectorAll('[data-auto-publish-min]')).map((el) => ({
      value: attr(el, 'data-auto-publish-min'),
      checked: el.checked === true,
      text: textOf(el.closest('label') || el).slice(0, 120),
      rect: rectOf(el.closest('label') || el),
    }));
    return {
      open: true,
      dialogOpen: Boolean(dialog),
      text: text.slice(0, 900),
      toggle: toggle ? {
        checked: toggle.checked === true,
        disabled: toggle.disabled === true,
        rect: toggleHost ? rectOf(toggleHost) : rectOf(toggle),
        inputRect: rectOf(toggle),
      } : null,
      confirmOpen: confirmVisible,
      confirm: confirmVisible ? {
        text: textOf(confirmBlock).slice(0, 400),
        confirmButton: confirmButton && visible(confirmButton) ? describe(confirmButton) : null,
        cancelButton: cancelButton && visible(cancelButton) ? describe(cancelButton) : null,
      } : null,
      modes,
      minSeverities,
      hasMaxComments: Boolean(section.querySelector('[data-auto-publish-max]')),
      hasHint: /写操作|GitHub|write operation/i.test(text),
    };
  })()`
}

/**
 * Locate the auto-publish checkbox for a click (the label is the click host so
 * a visually styled input still toggles).
 * @returns {string} page expression
 */
export function autoPublishToggleTarget() {
  return `(() => {
    ${HELPERS}
    const input = document.querySelector('[data-auto-publish="toggle"]');
    if (!input) return { found: false, reason: 'toggle-missing' };
    const host = input.closest('label') || input.parentElement || input;
    if (!visible(host)) return { found: false, reason: 'toggle-hidden' };
    host.scrollIntoView({ block: 'center', inline: 'nearest' });
    return {
      found: true,
      checked: input.checked === true,
      disabled: input.disabled === true,
      rect: rectOf(host),
      inputRect: rectOf(input),
    };
  })()`
}

/**
 * Auto-publish status line in the auto-review card (`data-auto-publish-status`).
 * The client renders the boolean as "true"/"false"; "on"/"off" is tolerated.
 * @returns {string} page expression
 */
export function autoPublishStatusProbe() {
  return `(() => {
    ${HELPERS}
    const node = Array.from(document.querySelectorAll('[data-auto-publish-status]')).filter(visible)[0]
      || document.querySelector('[data-auto-publish-status]');
    if (!node) return { present: false, value: null, enabled: null, text: '', inCard: false };
    const value = attr(node, 'data-auto-publish-status');
    return {
      present: true,
      value,
      enabled: value === 'true' || value === 'on',
      text: textOf(node).slice(0, 160),
      inCard: Boolean(node.closest('[data-cr-autoreview]')),
    };
  })()`
}
