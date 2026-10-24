/**
 * Page-level DOM helpers shared by `page-check.mjs` and `click-panel.mjs`.
 *
 * Each helper returns a self-contained JavaScript *expression string* that the
 * CDP driver evaluates inside the page with `Runtime.evaluate`. Keeping them as
 * strings (instead of functions) makes them trivially serializable over CDP and
 * avoids depending on transpiled helpers inside the page.
 */

/** Normalized visibility test injected into every expression. */
const VISIBILITY_HELPERS = `
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01;
  };
  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  const labelOf = (el) => [
    el.getAttribute('aria-label'),
    el.getAttribute('title'),
    el.getAttribute('data-testid'),
    textOf(el),
  ].filter(Boolean).join(' | ');
  const rectOf = (el) => {
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  };
  const describe = (el, index) => ({
    index,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    ariaLabel: el.getAttribute('aria-label'),
    title: el.getAttribute('title'),
    text: textOf(el).slice(0, 120),
    label: labelOf(el).slice(0, 200),
    rect: rectOf(el),
    visible: visible(el),
  });
`

/**
 * Snapshot every interactive element (plus anything carrying an aria-label or
 * title) in reading order, with geometry — used for diagnostics when a click
 * target cannot be found and for the baseline sidebar record.
 * @param {{maxX?: number, limit?: number}} [options] only elements whose left edge is above `maxX`
 * @returns {string} page expression string
 */
export function interactiveSnapshot({ maxX = 420, limit = 150 } = {}) {
  return `(() => {
    ${VISIBILITY_HELPERS}
    const selector = 'button, [role="button"], a, [role="link"], [role="tab"], [aria-label], [title]';
    const nodes = Array.from(document.querySelectorAll(selector))
      .filter((el) => visible(el) && el.getBoundingClientRect().x < ${maxX})
      .map((el, index) => describe(el, index))
      .filter((entry) => entry.rect.width >= 8 && entry.rect.height >= 8)
      .slice(0, ${limit});
    return nodes;
  })()`
}

/**
 * Find elements whose aria-label / title / text matches any keyword.
 * Case-insensitive substring match; exact matches sort first.
 * @param {string[]} keywords
 * @param {{maxX?: number, limit?: number}} [options]
 * @returns {string} page expression string
 */
export function findTargets(keywords, { maxX = 2000, limit = 20, excludeSelector } = {}) {
  const needles = JSON.stringify(keywords.map((keyword) => keyword.toLowerCase()))
  return `(() => {
    ${VISIBILITY_HELPERS}
    const needles = ${needles};
    const excludeSelector = ${JSON.stringify(excludeSelector ?? '')};
    const selector = 'button, [role="button"], a, [role="link"], [role="tab"], [aria-label], [title], [data-testid]';
    const matches = [];
    for (const el of document.querySelectorAll(selector)) {
      if (!visible(el)) continue;
      if (el.getBoundingClientRect().x >= ${maxX}) continue;
      if (excludeSelector && el.closest(excludeSelector)) continue;
      const text = textOf(el).toLowerCase();
      const labels = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid')]
        .filter(Boolean).map((value) => value.toLowerCase());
      const haystack = [text, ...labels].join('  ');
      const hit = needles.find((needle) => haystack.includes(needle));
      if (hit === undefined) continue;
      const exact = labels.includes(hit) || text === hit;
      matches.push({ ...describe(el, 0), matched: hit, exact });
    }
    matches.sort((a, b) => Number(b.exact) - Number(a.exact) || a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    matches.forEach((match, index) => { match.index = index; });
    return matches.slice(0, ${limit});
  })()`
}

/**
 * Fallback for a sidebar row that is not inside a nav-like container: scan
 * clickable elements in the left column, excluding the session tree (recent
 * session titles may legitimately contain the same words and must never be
 * mistaken for the plugin entry).
 * @param {string[]} keywords
 * @param {{maxX?: number, excludeSelector?: string}} [options]
 * @returns {string} page expression string
 */
export function findClickableInSidebar(keywords, {
  maxX = 340,
  excludeSelector = '[role="tree"], [aria-label*="会话"], [data-testid*="session"]',
} = {}) {
  const needles = JSON.stringify(keywords.map((keyword) => keyword.toLowerCase()))
  return `(() => {
    ${VISIBILITY_HELPERS}
    const needles = ${needles};
    const excludeSelector = ${JSON.stringify(excludeSelector)};
    const results = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('button, [role="button"], a, [role="link"], [role="tab"]')) {
      if (!visible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.x >= ${maxX} || rect.width < 8 || rect.height < 8) continue;
      if (el.closest(excludeSelector)) continue;
      const label = [el.getAttribute('aria-label'), el.getAttribute('title'), textOf(el)].filter(Boolean).join(' | ');
      const needle = needles.find((candidate) => label.toLowerCase().includes(candidate));
      if (needle === undefined || seen.has(el)) continue;
      seen.add(el);
      results.push({ ...describe(el, results.length), matched: needle, matchedText: label.slice(0, 120) });
    }
    results.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    results.forEach((entry, index) => { entry.index = index; });
    return results;
  })()`
}

/**
 * Inspect the current page: title, readyState, visible text sample, open modal
 * buttons, and whether a likely workbench main region exists.
 * @param {{maxTextLength?: number}} [options]
 * @returns {string} page expression string
 */
export function pageState({ maxTextLength = 1200 } = {}) {
  return `(() => {
    ${VISIBILITY_HELPERS}
    const dialog = Array.from(document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]')).find(visible) || null;
    const dialogButtons = dialog
      ? Array.from(dialog.querySelectorAll('button, [role="button"]')).filter(visible).map((el, index) => describe(el, index))
      : [];
    const bodyText = textOf(document.body);
    return {
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      rootChildren: document.querySelector('#root') ? document.querySelector('#root').children.length : 0,
      hasDialog: Boolean(dialog),
      dialogButtons,
      bodyTextLength: bodyText.length,
      bodyTextSample: bodyText.slice(0, ${maxTextLength}),
      headings: Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]')).filter(visible)
        .slice(0, 20).map((el) => textOf(el).slice(0, 80)),
    };
  })()`
}

/**
 * Detect whether the page looks like the temporary "预览版说明" first-run notice
 * (or another modal) that must be dismissed before sidebar clicks land.
 * @returns {string} page expression string
 */
export function dialogDismissTargets() {
  return findTargets(['继续', '知道了', '我知道了', '开始使用', '关闭', '确定', 'Continue', 'Got it', 'Dismiss', 'Close'], { maxX: 2200, limit: 20 })
}

/**
 * Current modal/dialog state: whether one is open, its text, and its buttons.
 * @returns {string} page expression string
 */
export function dialogState() {
  return `(() => {
    ${VISIBILITY_HELPERS}
    const dialog = Array.from(document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]')).find(visible) || null;
    if (!dialog) return { hasDialog: false, dialogText: '', buttons: [], rect: null };
    const buttons = Array.from(dialog.querySelectorAll('button, [role="button"], a')).filter(visible).map((el, index) => describe(el, index));
    return { hasDialog: true, dialogText: textOf(dialog).slice(0, 500), buttons, rect: rectOf(dialog) };
  })()`
}

/**
 * Find a sidebar entry by visible text without guessing its aria-label.
 *
 * The DSH sidebar renders panellist entries as rows inside
 * `<nav aria-label="全局面板">` (siblings of 插件 / 自动化任务). This searches
 * every left-column navigation container for the deepest element whose text
 * matches a keyword, then climbs to the nearest clickable ancestor (the row
 * button itself), returning its viewport rectangle for a real mouse click.
 * @param {string[]} keywords
 * @param {{sidebarMaxX?: number, clickableSelector?: string}} [options]
 * @returns {string} page expression string
 */
export function findSidebarTargets(keywords, { sidebarMaxX = 360, clickableSelector = 'button, [role="button"], a, [role="link"], [role="tab"]' } = {}) {
  const needles = JSON.stringify(keywords.map((keyword) => keyword.toLowerCase()))
  return `(() => {
    ${VISIBILITY_HELPERS}
    const needles = ${needles};
    const maxX = ${sidebarMaxX};
    const clickableSelector = ${JSON.stringify(clickableSelector)};
    const inSidebar = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.x < maxX && rect.right > 0;
    };
    const clickableAncestor = (el) => {
      let current = el;
      for (let depth = 0; depth < 10 && current; depth += 1) {
        if (current.matches && current.matches(clickableSelector)) return current;
        current = current.parentElement;
      }
      return null;
    };
    const containers = [
      ...document.querySelectorAll('nav, aside, [role="navigation"], [data-sidebar], [class*="sidebar" i]'),
    ].filter((el) => visible(el) && inSidebar(el));
    const results = [];
    const seen = new Set();
    for (const container of containers) {
      for (const el of container.querySelectorAll('*')) {
        if (!visible(el) || !inSidebar(el)) continue;
        const text = textOf(el).toLowerCase();
        const needle = needles.find((candidate) => text === candidate || text.includes(candidate));
        if (needle === undefined || text.length === 0) continue;
        // Keep the deepest matching node so the click lands on the row, not a wrapper.
        const deeperMatch = Array.from(el.children).some((child) => visible(child) && textOf(child).toLowerCase().includes(needle));
        if (deeperMatch) continue;
        const target = clickableAncestor(el);
        if (!target || seen.has(target)) continue;
        seen.add(target);
        try { target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
        results.push({
          ...describe(target, results.length),
          matched: needle,
          matchedText: text.slice(0, 120),
          sourceTag: el.tagName.toLowerCase(),
        });
      }
    }
    results.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    results.forEach((entry, index) => { entry.index = index; });
    return { found: results.length > 0, targets: results };
  })()`
}

/**
 * Describe the main content layout right of the sidebar: the visible top-level
 * column panels, used to assert that the three-column workbench rendered.
 * @param {{sidebarWidth?: number, minPanelWidth?: number, minPanelHeight?: number}} [options]
 * @returns {string} page expression string
 */
export function layoutProbe({ sidebarWidth = 320, minPanelWidth = 220, minPanelHeight = 280 } = {}) {
  return `(() => {
    ${VISIBILITY_HELPERS}
    const qualifies = (el) => {
      if (!visible(el)) return false;
      const rect = el.getBoundingClientRect();
      return rect.x >= ${sidebarWidth} - 40 && rect.width >= ${minPanelWidth} && rect.height >= ${minPanelHeight};
    };
    const candidates = Array.from(document.querySelectorAll('#root *')).filter(qualifies);
    // Cluster qualifying panels by horizontal band: a three-column workbench has
    // at least three distinct left edges right of the sidebar.
    const sorted = candidates.slice().sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
    const groups = [];
    for (const el of sorted) {
      const rect = el.getBoundingClientRect();
      const last = groups[groups.length - 1];
      if (last === undefined || rect.x - last.x > 40) groups.push({ x: rect.x, elements: [el] });
      else last.elements.push(el);
    }
    const area = (el) => { const rect = el.getBoundingClientRect(); return rect.width * rect.height; };
    const columns = groups.map((group) => {
      const largest = group.elements.slice().sort((a, b) => area(b) - area(a))[0];
      const rect = largest.getBoundingClientRect();
      return {
        x: Math.round(group.x),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        tag: largest.tagName.toLowerCase(),
        count: group.elements.length,
        text: textOf(largest).slice(0, 200),
      };
    });
    const mainText = groups
      .map((group) => group.elements.slice().sort((a, b) => area(b) - area(a))[0])
      .map((el) => textOf(el))
      .join(' ')
      .slice(0, 4000);
    return { columns, columnBands: groups.map((group) => Math.round(group.x)), qualifyingCount: candidates.length, mainText };
  })()`
}

/**
 * Assess whether a workbench looks rendered after the sidebar click.
 * Detection is intentionally redundant (text markers + column geometry) because
 * the plugin's exact DOM is not part of this harness; the raw text is reported
 * either way so a human can judge.
 * @returns {string} page expression string
 */
export function workbenchProbe() {
  return `(() => {
    ${VISIBILITY_HELPERS}
    const bodyText = textOf(document.body);
    const mainRoot = document.querySelector('main, [role="main"]') || document.querySelector('#root');
    const mainText = mainRoot ? textOf(mainRoot) : bodyText;
    const enumText = (labels) => Object.fromEntries(labels.map((label) => [label, mainText.includes(label)]));
    const textSignals = {
      aiReview: /AI ?审查|AI ?review/i.test(mainText),
      tabs: /Summary|Changes|概要|变更/i.test(mainText),
      prList: /pull request|PR|拉取|待审查|作者/i.test(mainText),
      files: /文件|files/i.test(mainText),
      summary: enumText(['Summary', 'Changes', '用 AI 审查', '代码审查', '概要', '变更', '文件']),
    };
    const mainRect = mainRoot ? rectOf(mainRoot) : null;
    return {
      title: document.title,
      url: location.href,
      hasSidebar: Boolean(document.querySelector('nav')) || document.querySelectorAll('button').length > 4,
      sidebarTextLength: Array.from(document.querySelectorAll('nav, aside')).map((el) => textOf(el).length).reduce((sum, value) => sum + value, 0),
      mainRect,
      mainTextLength: mainText.length,
      mainTextSample: mainText.slice(0, 1500),
      bodyTextSample: bodyText.slice(0, 1500),
      signals: textSignals,
      slotCrashed: /slot entry crashed|slot.*crashed/i.test(bodyText),
    };
  })()`
}
