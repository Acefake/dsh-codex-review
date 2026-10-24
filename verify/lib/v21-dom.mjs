/**
 * v2.1 page probes (CONTRACT.md §6.4/§6.5): auto-review settings section,
 * status card, immediate-check button, toast and PR-row badge.
 *
 * The v2.1 client exposes stable hooks; probes prefer them with a text fallback.
 *
 * Hooks (plugin/client.js v2.1):
 *   workbench root: [data-cr-auto-supported], [data-cr-auto-enabled], [data-cr-auto-running],
 *                   [data-cr-auto-recent], [data-cr-auto-open]
 *   settings:       [data-auto-settings="ready"|"degraded"], [data-auto-enabled="toggle"],
 *                   [data-auto-interval-preset], [data-auto-interval-input], [data-auto-depth],
 *                   [data-auto-threshold], [data-auto-drafts="toggle"], [data-auto-max], [data-auto-query]
 *   card:           [data-cr-autoreview="ready"] (+ data-auto-supported/enabled/running/recent),
 *                   [data-action="auto-review-run"|"auto-review-refresh"|"auto-review-toggle"|"auto-review-open-settings"]
 *   badge:          [data-auto-badge="<kind>"] inside a [data-pr-number] row
 *   toast:          .cr-toast
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
    text: textOf(el).slice(0, 260),
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
 * One-shot inventory of auto-review UI surfaces.
 * @returns {string} page expression
 */
export function v21Surface() {
  return `(() => {
    ${HELPERS}
    const settingsSection = closestVisible('[data-auto-settings]');
    const card = closestVisible('[data-cr-autoreview]');
    const settingsToggle = closestVisible('[data-auto-enabled="toggle"]');
    const cardToggle = closestVisible('[data-action="auto-review-toggle"]');
    const immediate = closestVisible('[data-action="auto-review-run"]');
    const root = document.querySelector('[data-cr-root]');
    return {
      settingsSection: settingsSection ? { ...describe(settingsSection), state: attr(settingsSection, 'data-auto-settings') } : null,
      card: card ? {
        ...describe(card),
        supported: attr(card, 'data-auto-supported'),
        enabled: attr(card, 'data-auto-enabled'),
        running: attr(card, 'data-auto-running'),
        recent: attr(card, 'data-auto-recent'),
      } : null,
      settingsToggle: settingsToggle ? { ...describe(settingsToggle), checked: settingsToggle.checked === true || attr(settingsToggle, 'aria-checked') === 'true', rect: rectOf(settingsToggle) } : null,
      cardToggle: cardToggle ? { ...describe(cardToggle), checked: attr(cardToggle, 'aria-checked') === 'true' || attr(cardToggle, 'data-auto-enabled') === 'true' } : null,
      immediate: immediate && visible(immediate) ? describe(immediate) : null,
      root: root ? {
        supported: attr(root, 'data-cr-auto-supported'),
        enabled: attr(root, 'data-cr-auto-enabled'),
        running: attr(root, 'data-cr-auto-running'),
        recent: attr(root, 'data-cr-auto-recent'),
        open: attr(root, 'data-cr-auto-open'),
      } : null,
      bodyTextSample: textOf(document.body).slice(0, 800),
    };
  })()`
}

/**
 * Auto-review settings section detail (CONTRACT §6.4): toggle, interval, depth,
 * threshold, drafts, maxPerCycle, query.
 * @returns {string} page expression
 */
export function autoSettingsProbe() {
  return `(() => {
    ${HELPERS}
    const section = closestVisible('[data-auto-settings]');
    if (!section) return { open: false, text: '', toggle: null, controls: [] };
    const text = textOf(section);
    const toggle = section.querySelector('[data-auto-enabled="toggle"]');
    const controls = Array.from(section.querySelectorAll('input, select, button, [role="radio"], [role="switch"], [data-action]')).filter(visible).map((el) => ({
      ...describe(el),
      checked: el.checked === true || attr(el, 'aria-checked') === 'true',
      value: attr(el, 'value') ?? (typeof el.value === 'string' ? el.value : null),
      rect: rectOf(el),
    }));
    const presets = Array.from(section.querySelectorAll('[data-auto-interval-preset]')).filter(visible).map((el) => ({ value: attr(el, 'data-auto-interval-preset'), checked: el.checked === true || attr(el, 'aria-checked') === 'true' }));
    return {
      open: true,
      state: attr(section, 'data-auto-settings'),
      text: text.slice(0, 900),
      toggle: toggle ? { ...describe(toggle), checked: toggle.checked === true || attr(toggle, 'aria-checked') === 'true', rect: rectOf(toggle) } : null,
      controls: controls.slice(0, 40),
      intervalPresets: presets,
      hasInterval: Boolean(section.querySelector('[data-auto-interval-preset], [data-auto-interval-input]')),
      hasDepth: Boolean(section.querySelector('[data-auto-depth]')),
      hasThreshold: Boolean(section.querySelector('[data-auto-threshold]')),
      hasDrafts: Boolean(section.querySelector('[data-auto-drafts]')),
      hasMaxPerCycle: Boolean(section.querySelector('[data-auto-max]')),
      hasQuery: Boolean(section.querySelector('[data-auto-query]')),
    };
  })()`
}

/**
 * Auto-review status card in the right panel (CONTRACT §6.4).
 * @returns {string} page expression
 */
export function autoCardProbe() {
  return `(() => {
    ${HELPERS}
    const card = closestVisible('[data-cr-autoreview]');
    if (!card) return { open: false, text: '' };
    const text = textOf(card);
    const immediate = card.querySelector('[data-action="auto-review-run"]');
    const refresh = card.querySelector('[data-action="auto-review-refresh"]');
    const toggle = card.querySelector('[data-action="auto-review-toggle"]');
    const openSettings = card.querySelector('[data-action="auto-review-open-settings"]');
    const recentItems = Array.from(card.querySelectorAll('[data-auto-pr]')).filter(visible).map(describe);
    return {
      open: true,
      text: text.slice(0, 1200),
      supported: attr(card, 'data-auto-supported'),
      enabled: attr(card, 'data-auto-enabled'),
      running: attr(card, 'data-auto-running'),
      recent: attr(card, 'data-auto-recent'),
      immediate: immediate && visible(immediate) && immediate.disabled !== true ? describe(immediate) : null,
      immediateDisabled: immediate ? immediate.disabled === true : null,
      refresh: refresh && visible(refresh) ? describe(refresh) : null,
      toggle: toggle && visible(toggle) ? describe(toggle) : null,
      openSettings: openSettings && visible(openSettings) ? describe(openSettings) : null,
      recentItems: recentItems.slice(0, 8),
      hasLastCycle: /上次|Last check/i.test(text),
      hasNextCycle: /下次|Next check/i.test(text),
      hasRecent: /最近|Recent results/i.test(text),
      hasRunning: /检查中|Checking/i.test(text) || attr(card, 'data-auto-running') === 'true',
      hasEnabledState: /开启|关闭|On|Off/i.test(text) || attr(card, 'data-auto-enabled') !== null,
    };
  })()`
}

/**
 * Toast messages currently visible (e.g. 「自动审查完成：repo#n · X 个问题」).
 * @returns {string} page expression
 */
export function toastProbe() {
  return `(() => {
    ${HELPERS}
    const nodes = Array.from(document.querySelectorAll('.cr-toast, [role="status"], [role="alert"], [class*="toast" i]')).filter(visible);
    return { count: nodes.length, texts: nodes.map((el) => textOf(el).slice(0, 240)).slice(0, 8) };
  })()`
}

/**
 * PR list-row auto-review badge (CONTRACT §6.4: 「已自动审查」+ count).
 * @returns {string} page expression
 */
export function prBadgeProbe() {
  return `(() => {
    ${HELPERS}
    const badges = Array.from(document.querySelectorAll('[data-auto-badge]')).filter(visible).map((el) => {
      const row = el.closest('[data-pr-number]');
      return {
        kind: attr(el, 'data-auto-badge'),
        text: textOf(el).slice(0, 200),
        prNumber: row ? attr(row, 'data-pr-number') : null,
        rect: rectOf(el),
      };
    });
    const rows = Array.from(document.querySelectorAll('[data-pr-number]')).filter(visible);
    return { count: badges.length, badges: badges.slice(0, 8), rowCount: rows.length };
  })()`
}

/**
 * Locate the auto-review settings toggle for a click (settings dialog open).
 * @returns {string} page expression
 */
export function autoToggleTarget() {
  return `(() => {
    ${HELPERS}
    const input = closestVisible('[data-auto-enabled="toggle"]');
    if (!input) return { found: false };
    const label = input.closest('label') || input.parentElement || input;
    const host = visible(label) ? label : input;
    host.scrollIntoView({ block: 'center', inline: 'nearest' });
    return { found: true, ...describe(host), checked: input.checked === true || attr(input, 'aria-checked') === 'true', rect: rectOf(host) };
  })()`
}
