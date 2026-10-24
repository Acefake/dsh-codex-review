/**
 * v1.1 page probes (CONTRACT.md §4).
 *
 * The v1.1 client exposes stable `data-*` hooks; these expressions prefer them
 * and keep a generic text/role fallback so a partially deployed UI still yields
 * actionable diagnostics instead of silent zeros. Expressions are strings for
 * `Runtime.evaluate`.
 *
 * Known hooks (plugin/client.js v1.1):
 *   [data-cr-root]                     workbench root (data-cr-tab, data-cr-review-state, ...)
 *   [data-tab="summary"|"changes"]     detail tabs
 *   [data-cr-pr-head]                  PR header (repo #number)
 *   [data-pr-number]                   PR list rows
 *   [data-action="review"|"review-settings"]
 *   [data-cr-settings]                 review settings dialog (role=dialog, aria-modal)
 *   input[data-depth] / input[data-threshold] / input[data-guidelines="toggle"]
 *   button[data-inline-marker]         diff gutter finding dot
 *   [data-inline-open] [data-inline-finding]  expanded finding card in diff
 *   [data-inline-comment="path:line"]  existing GitHub inline comment card
 *   [data-verdict] / [data-review-options] / [data-review-reused]
 *   [data-review-guidelines="loaded"|"missing"] / [data-review-partial]
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
    text: textOf(el).slice(0, 200),
    aria: attr(el, 'aria-label'),
    title: attr(el, 'title'),
    role: attr(el, 'role'),
    className: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
    dataAction: attr(el, 'data-action'),
    dataTab: attr(el, 'data-tab'),
    dataFindingId: attr(el, 'data-finding-id'),
    rect: rectOf(el),
  });
  const clickable = (el) => {
    let current = el;
    for (let depth = 0; depth < 8 && current; depth += 1) {
      if (current.matches && current.matches('button, [role="button"], a, [role="tab"], [role="option"], [role="switch"], [tabindex]')) return current;
      if (window.getComputedStyle(current).cursor === 'pointer') return current;
      current = current.parentElement;
    }
    return null;
  };
  const pressable = (pattern) => {
    const results = [];
    for (const el of document.querySelectorAll('button, [role="button"], [role="tab"], [role="option"], [role="switch"], a, [tabindex]')) {
      if (!visible(el)) continue;
      const text = textOf(el);
      const label = [attr(el, 'aria-label'), attr(el, 'title'), text].filter(Boolean).join(' | ');
      if (pattern.test(label)) results.push({ ...describe(el), label: label.slice(0, 200) });
    }
    return results;
  };
  const closestLabelRect = (input) => {
    const label = input.closest('label');
    const host = label || input;
    return rectOf(host);
  };
`

/**
 * Surface inventory for the v1.1 workbench.
 * @returns {string} page expression
 */
export function v11Surface() {
  return `(() => {
    ${HELPERS}
    const root = document.querySelector('[data-cr-root]');
    const settings = Array.from(document.querySelectorAll('[data-action="review-settings"]')).filter(visible).map(describe)
      .concat(pressable(/审查设置|Review settings|Settings/i).slice(0, 4));
    const reviewTriggers = Array.from(document.querySelectorAll('[data-action="review"]')).filter(visible).map(describe)
      .concat(pressable(/用 ?AI ?审查|Review with AI|Review with Codex/i).slice(0, 4));
    const tabs = Array.from(document.querySelectorAll('[data-tab]')).filter(visible).map(describe);
    const diffRoot = document.querySelector('[data-cr-changes], [aria-label="diff"], .cr-diff');
    const inline = Array.from(document.querySelectorAll('[data-inline-comment]')).filter(visible);
    let settingsStorage = null;
    try { settingsStorage = window.localStorage.getItem('codex-review:settings'); } catch {}
    return {
      rootReady: Boolean(root),
      rootTab: root ? attr(root, 'data-cr-tab') : null,
      rootReviewState: root ? attr(root, 'data-cr-review-state') : null,
      settingsButtons: settings.slice(0, 6),
      reviewTriggers: reviewTriggers.slice(0, 6),
      tabs: tabs.slice(0, 8),
      hasDiff: Boolean(diffRoot && visible(diffRoot)),
      inlineCommentCount: inline.length,
      settingsStorage,
      bodyTextSample: textOf(document.body).slice(0, 600),
    };
  })()`
}

/**
 * Diff-region finding markers and expanded inline cards.
 * @returns {string} page expression
 */
export function diffFindingProbe() {
  return `(() => {
    ${HELPERS}
    const diffRoot = document.querySelector('[data-cr-changes], [aria-label="diff"], .cr-diff');
    const markers = Array.from(document.querySelectorAll('[data-inline-marker]')).filter(visible).map((el) => ({
      ...describe(el),
      line: attr(el, 'data-inline-marker'),
      expanded: attr(el, 'aria-expanded'),
    }));
    const fallback = markers.length === 0
      ? Array.from(document.querySelectorAll('[class*="finding" i], [class*="dot" i]')).filter((el) => visible(el) && diffRoot && diffRoot.contains(el)).map(describe)
      : [];
    const cards = Array.from(document.querySelectorAll('[data-inline-open] [data-inline-finding], [data-inline-finding]')).filter(visible);
    const cardText = cards.map((el) => textOf(el)).join('\\n').slice(0, 4000);
    const diffText = diffRoot ? textOf(diffRoot).slice(0, 2000) : '';
    return {
      hasDiff: Boolean(diffRoot && visible(diffRoot)),
      markerCount: markers.length,
      markers: markers.slice(0, 12),
      fallback,
      cardCount: cards.length,
      hasWhyFix: /为什么|怎么改|Why|Fix/i.test(cardText),
      hasConfidence: /confidence|置信/i.test(cardText),
      hasEvidence: /evidence|证据/i.test(cardText),
      cardTextSample: cardText.slice(0, 1200),
      diffTextSample: diffText.slice(0, 600),
    };
  })()`
}

/**
 * After clicking a finding marker: probe the expanded inline card.
 * @returns {string} page expression
 */
export function expandedFindingProbe() {
  return `(() => {
    ${HELPERS}
    const inlineRow = document.querySelector('[data-inline-open]');
    const cards = Array.from(document.querySelectorAll('[data-inline-open] [data-inline-finding], [data-inline-finding], [data-finding-id]')).filter(visible);
    const texts = cards.map((el) => ({ ...describe(el), text: textOf(el).slice(0, 800) }));
    const merged = texts.map((entry) => entry.text).join('\\n');
    return {
      openLine: inlineRow ? attr(inlineRow, 'data-inline-open') : null,
      cardCount: texts.length,
      hasWhy: /为什么|Why/i.test(merged),
      hasFix: /怎么改|Fix/i.test(merged),
      hasConfidence: /confidence|置信/i.test(merged),
      hasEvidence: /evidence|证据/i.test(merged),
      hasSeverity: /P0|P1|P2/.test(merged),
      cards: texts.slice(0, 6),
      mergedSample: merged.slice(0, 1200),
    };
  })()`
}

/**
 * Review settings dialog (v1.1 §4.5.3): exact hooks + fallbacks.
 * @returns {string} page expression
 */
export function settingsPopoverProbe() {
  return `(() => {
    ${HELPERS}
    // NOTE: the workbench root also carries data-cr-settings="open|closed";
    // the dialog itself is data-cr-settings="ready" (plus role=dialog).
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"], [data-cr-settings="ready"]');
    const open = Boolean(dialog && visible(dialog));
    const depthInputs = dialog ? Array.from(dialog.querySelectorAll('input[data-depth]')).map((input) => ({
      depth: attr(input, 'data-depth'),
      checked: Boolean(input.checked),
      rect: closestLabelRect(input),
    })) : [];
    const thresholdInputs = dialog ? Array.from(dialog.querySelectorAll('input[data-threshold]')).map((input) => ({
      threshold: attr(input, 'data-threshold'),
      checked: Boolean(input.checked),
      rect: closestLabelRect(input),
    })) : [];
    const guidelinesInput = dialog ? dialog.querySelector('input[data-guidelines="toggle"]') : null;
    const closeButton = dialog ? dialog.querySelector('[data-action="settings-close"], .cr-modal-close') : null;
    let storage = null;
    try { storage = window.localStorage.getItem('codex-review:settings'); } catch {}
    return {
      open,
      dialogText: dialog ? textOf(dialog).slice(0, 600) : '',
      depthInputs,
      thresholdInputs,
      guidelineToggle: guidelinesInput ? { checked: Boolean(guidelinesInput.checked), rect: closestLabelRect(guidelinesInput) } : null,
      closeButton: closeButton && visible(closeButton) ? describe(closeButton) : null,
      storage,
      hasDeepHint: /多一轮|复核|耗时|longer|verification pass/i.test(dialog ? textOf(dialog) : ''),
    };
  })()`
}

/**
 * Keyboard/selection state used by the `j/k/r//` and Esc assertions.
 * @returns {string} page expression
 */
export function keyboardState() {
  return `(() => {
    ${HELPERS}
    const head = document.querySelector('[data-cr-pr-head]');
    const headerText = head ? textOf(head).slice(0, 300) : '';
    const repoMatch = headerText.match(/#(\\d+)/);
    const root = document.querySelector('[data-cr-root]');
    const active = document.activeElement;
    const settingsDialog = document.querySelector('[role="dialog"][aria-modal="true"], [data-cr-settings="ready"]');
    const activeRow = document.querySelector('[data-pr-number].cr-row--active, [data-pr-number][aria-selected="true"], [data-pr-number][data-active="true"]');
    return {
      prNumber: repoMatch ? Number(repoMatch[1]) : null,
      headerText,
      selectedRowNumber: activeRow ? Number(attr(activeRow, 'data-pr-number')) : null,
      rootTab: root ? attr(root, 'data-cr-tab') : null,
      activeTag: active ? active.tagName.toLowerCase() : null,
      activeType: active ? attr(active, 'type') : null,
      activePlaceholder: active ? attr(active, 'placeholder') : null,
      activeAria: active ? attr(active, 'aria-label') : null,
      settingsOpen: Boolean(settingsDialog && visible(settingsDialog)),
    };
  })()`
}

/**
 * Existing GitHub inline comment cards (v1.1 §4.5.2).
 * @returns {string} page expression
 */
export function inlineCommentProbe() {
  return `(() => {
    ${HELPERS}
    const nodes = Array.from(document.querySelectorAll('[data-inline-comment]')).filter(visible);
    return {
      count: nodes.length,
      cards: nodes.slice(0, 8).map(describe),
      sample: nodes.slice(0, 5).map((el) => textOf(el).slice(0, 300)),
    };
  })()`
}

/**
 * Clickable elements whose label matches a regex source (case-insensitive).
 * @param {string} patternSource regex source, e.g. `全部展开|Expand all`
 * @returns {string} page expression
 */
export function pressableByText(patternSource) {
  return `(() => {
    ${HELPERS}
    return pressable(new RegExp(${JSON.stringify(patternSource)}, 'i')).slice(0, 20);
  })()`
}

/**
 * Pick the PR row (list item) whose title contains a keyword and return a
 * click point after scrolling it into view.
 * @param {string} keyword
 * @returns {string} page expression
 */
export function findPrRow(keyword) {
  return `(() => {
    ${HELPERS}
    const needle = ${JSON.stringify(String(keyword).toLowerCase())};
    const rows = Array.from(document.querySelectorAll('[data-pr-number]')).filter(visible);
    const matches = rows.filter((row) => textOf(row).toLowerCase().includes(needle));
    const target = matches[0] || null;
    if (!target) {
      // Fallback: deepest text match anywhere in the list column.
      const any = Array.from(document.querySelectorAll('#root *')).filter((el) => visible(el) && textOf(el).toLowerCase().includes(needle));
      const deepest = any.filter((el) => !Array.from(el.children).some((child) => visible(child) && textOf(child).toLowerCase().includes(needle)));
      for (const el of deepest) {
        const hit = clickable(el);
        if (!hit) continue;
        hit.scrollIntoView({ block: 'center', inline: 'nearest' });
        return { found: true, ...describe(hit), sourceTag: el.tagName.toLowerCase() };
      }
      return { found: false };
    }
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    const hit = clickable(target) || target;
    return { found: true, ...describe(hit), sourceTag: target.tagName.toLowerCase(), prNumber: attr(target, 'data-pr-number') };
  })()`
}

/**
 * Scroll the nth visible match of a selector into view and return its fresh
 * viewport rect (CDP clicks only land inside the viewport).
 * @param {string} selector
 * @param {number} [index]
 * @returns {string} page expression
 */
export function scrollToElement(selector, index = 0) {
  return `(() => {
    ${HELPERS}
    const elements = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(visible);
    const element = elements[${Number(index)}];
    if (!element) return { found: false, count: elements.length };
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    return { found: true, count: elements.length, ...describe(element) };
  })()`
}

/**
 * v1.1 review-card metadata (verdict badge, resolved options, reuse,
 * guidelines, partial marker) rendered after a completed review.
 * @returns {string} page expression
 */
export function reviewMetaProbe() {
  return `(() => {
    ${HELPERS}
    const root = document.querySelector('[data-cr-root]');
    const verdict = document.querySelector('[data-verdict]');
    const options = document.querySelector('[data-review-options]');
    const reused = document.querySelector('[data-review-reused]');
    const guidelines = document.querySelector('[data-review-guidelines]');
    const partial = document.querySelector('[data-review-partial]');
    const card = document.querySelector('[data-review-state]');
    return {
      reviewState: root ? attr(root, 'data-cr-review-state') : (card ? attr(card, 'data-review-state') : null),
      verdict: verdict ? { value: attr(verdict, 'data-verdict'), text: textOf(verdict), rect: rectOf(verdict) } : null,
      options: options ? { text: textOf(options) } : null,
      reused: reused ? { value: attr(reused, 'data-review-reused'), text: textOf(reused) } : null,
      guidelines: guidelines ? { value: attr(guidelines, 'data-review-guidelines'), text: textOf(guidelines) } : null,
      partial: Boolean(partial),
      bodyTextSample: textOf(document.body).slice(0, 800),
    };
  })()`
}
