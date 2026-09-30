// TAGEX — searchable pickers.
//
// One operation's job card list runs past 150 entries. Finding one by scrolling a native
// dropdown is the slowest thing in the capture forms, so every job card and client picker in
// the app is a type-to-search box instead.
//
// THE NATIVE <select> STAYS. attach() hides it and drives it; it still holds the options,
// their datasets and the value. Everything that already reads sel.value, reads
// sel.options[sel.selectedIndex].dataset, listens for 'change', or refills the options keeps
// working untouched — this file is a way of choosing, not a new source of truth.
//
// MATCHING IS NORMALISED. An earlier search box compared raw substrings, so a client filed as
// "Easy Green" could not be found by typing "easygreen" — you had to guess the spacing and
// punctuation somebody else chose. Here both sides are stripped to letters and digits, and
// each typed word is matched on its own, so "easygreen", "easy green", "EASY-GREEN" and
// "green 0157" all find the same job card.
//
// IT IS STILL A LIST. An empty box shows everything, so nobody is forced to type, and nobody
// has to know what to type before they can see what exists.

(function (global) {
  'use strict';

  const TX = global.TX || (global.TX = {});
  if (TX.pick) return;

  // ── matching ─────────────────────────────────────────────────────────────

  /** Down to letters and digits: the spacing and punctuation of a name never hide it. */
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');

  /** The typed query as independent words, each normalised. */
  const terms = (q) => String(q == null ? '' : q).split(/\s+/).map(norm).filter(Boolean);

  /** Every word must appear somewhere, which makes the order the user types irrelevant. */
  function hit(hay, ts) {
    for (let i = 0; i < ts.length; i++) if (hay.indexOf(ts[i]) < 0) return false;
    return true;
  }

  // ── styling ──────────────────────────────────────────────────────────────
  //
  // Literal colours, not var(--card) and friends. The scheduler scopes its custom properties
  // to .mod-scheduler, and the popup is a child of <body> so it can escape a modal's overflow
  // — inside that body it would resolve every variable to nothing. Both apps run the same
  // palette, so the values are simply written out.

  const CSS = `
.tx-pick{position:relative;display:block;}
.tx-pick > select.tx-pick-native{display:none !important;}
.tx-pick-in{
  width:100%;background:#16181c;border:1px solid #2a2e38;border-radius:8px;color:#e8eaf0;
  font:inherit;font-size:13px;padding:10px 30px;appearance:none;-webkit-appearance:none;
}
.tx-pick-in::placeholder{color:#6a7079;}
.tx-pick-in:focus{outline:none;border-color:#f0a500;box-shadow:0 0 0 2px rgba(240,165,0,.15);}
.tx-pick-in:disabled{opacity:.55;cursor:not-allowed;}
.tx-pick-mag,.tx-pick-x{
  position:absolute;top:50%;transform:translateY(-50%);color:#8b919c;font-size:12px;line-height:1;
  pointer-events:none;
}
.tx-pick-mag{left:10px;}
.tx-pick-x{
  right:6px;pointer-events:auto;background:none;border:0;color:#8b919c;cursor:pointer;
  padding:4px 6px;font-size:15px;border-radius:5px;
}
.tx-pick-x:hover{color:#e8eaf0;background:#2a2e38;}
.tx-pick-pop{
  position:fixed;z-index:99999;background:#1c1f25;border:1px solid #3d4354;border-radius:10px;
  box-shadow:0 10px 34px rgba(0,0,0,.55);overflow:hidden;display:flex;flex-direction:column;
  font-family:inherit;
}
/* display:flex above is an AUTHOR rule and the browser's [hidden]{display:none} is a
   user-agent one, so without this the list stayed on screen after a job card was chosen --
   covering the form, with the choice already made behind it. */
.tx-pick-pop[hidden]{display:none;}
.tx-pick-scroll{overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;}
.tx-pick-opt{
  padding:9px 12px;font-size:13px;color:#e8eaf0;cursor:pointer;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;
}
.tx-pick-opt.is-on{background:#2a2e38;}
.tx-pick-opt.is-sel{color:#f0a500;}
.tx-pick-opt.is-off{color:#6a7079;cursor:default;}
.tx-pick-grp{
  padding:8px 12px 4px;font-size:10px;letter-spacing:.9px;text-transform:uppercase;
  color:#8b919c;background:#16181c;position:sticky;top:0;
}
.tx-pick-none{padding:14px 12px;font-size:12px;color:#8b919c;}
.tx-pick-foot{
  padding:6px 12px;font-size:10px;color:#6a7079;border-top:1px solid #2a2e38;background:#16181c;
}
`;

  let styled = false;
  function injectStyle() {
    if (styled || !document.head) return;
    styled = true;
    const el = document.createElement('style');
    el.id = 'tx-pick-css';
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  // ── the picker ───────────────────────────────────────────────────────────

  let seq = 0;

  // Every live picker. A picker in a modal dies when the modal's markup is thrown away, but
  // its popup is parented to <body> so it can escape the modal's overflow — which means the
  // popup would outlive it. Each new attach() clears out whatever was orphaned since the last
  // one, so opening the same modal a hundred times leaves a hundred nothings behind.
  const LIVE = new Set();
  function sweep() {
    LIVE.forEach((p) => { if (!document.contains(p.el)) p.destroy(); });
  }

  /**
   * Turn one <select> into a search box. Returns the picker, or the existing one if this
   * select was already upgraded, so calling it twice is harmless.
   */
  function attach(sel, opts) {
    if (!sel || sel.tagName !== 'SELECT') return null;
    if (sel.__txPick) return sel.__txPick;
    injectStyle();
    sweep();

    const cfg = opts || {};
    const id = 'txpick' + (++seq);
    const noun = cfg.noun || 'entries';

    // The select keeps its place in the DOM; the wrapper goes around it, so any layout rule
    // written against the surrounding form still applies.
    const wrap = document.createElement('div');
    wrap.className = 'tx-pick';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('tx-pick-native');

    const mag = document.createElement('span');
    mag.className = 'tx-pick-mag';
    mag.textContent = '\u2315';
    mag.setAttribute('aria-hidden', 'true');

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tx-pick-in';
    input.id = id + 'in';
    input.autocomplete = 'off';
    // The side padding is structural, not decoration: the magnifier and the clear button sit
    // in those gutters. Both apps style their own form fields with selectors more specific
    // than a single class, and this is meant to inherit their look -- background, border,
    // height -- but not at the price of text running underneath an icon. Inline wins.
    input.style.paddingLeft = '30px';
    input.style.paddingRight = '30px';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', id + 'pop');
    // The <select> carries the label; point the new control at the same one.
    if (sel.id) {
      const lbl = document.querySelector('label[for="' + cssEscape(sel.id) + '"]');
      if (lbl) input.setAttribute('aria-labelledby', lbl.id || (lbl.id = id + 'lbl'));
    }
    if (sel.getAttribute('aria-label')) input.setAttribute('aria-label', sel.getAttribute('aria-label'));

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'tx-pick-x';
    clear.textContent = '\u00d7';
    clear.hidden = true;
    clear.setAttribute('aria-label', 'Clear the choice');

    wrap.appendChild(mag);
    wrap.appendChild(input);
    wrap.appendChild(clear);

    const pop = document.createElement('div');
    pop.className = 'tx-pick-pop';
    pop.id = id + 'pop';
    pop.hidden = true;
    const scroll = document.createElement('div');
    scroll.className = 'tx-pick-scroll';
    scroll.setAttribute('role', 'listbox');
    const foot = document.createElement('div');
    foot.className = 'tx-pick-foot';
    pop.appendChild(scroll);
    pop.appendChild(foot);
    document.body.appendChild(pop);

    let open = false;
    let shown = [];     // the options currently listed, in list order
    let active = -1;    // index into `shown`

    // ── reading the select ─────────────────────────────────────────────────

    /** Every option, with the optgroup it sits under folded into what we search. */
    function read() {
      const out = [];
      const list = sel.options || [];
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        const p = o.parentNode;
        const group = (p && p.tagName === 'OPTGROUP') ? (p.label || '') : '';
        const text = (o.textContent || '').trim();
        out.push({
          value: o.value,
          text,
          group,
          disabled: o.disabled,
          // The group is searchable too, so typing "om" narrows to the O&M side.
          hay: norm(group + ' ' + text),
        });
      }
      return out;
    }

    /** The placeholder option's own words — "— Select Job Card (O&M) —" and the like. */
    function hint() {
      const all = read();
      const blank = all.find((o) => !o.value);
      if (blank && blank.text) return blank.text;
      return cfg.placeholder || 'Search\u2026';
    }

    /** What the select currently holds, or null when nothing real is chosen. */
    function chosen() {
      if (!sel.value) return null;
      return read().find((o) => o.value === sel.value) || null;
    }

    // ── painting ───────────────────────────────────────────────────────────

    function paint() {
      if (open) return;                     // mid-search: never overwrite what is being typed
      const cur = chosen();
      input.value = cur ? cur.text : '';
      input.placeholder = hint();
      input.disabled = !!sel.disabled;
      clear.hidden = !cur || !!sel.disabled;
    }

    function render() {
      // Opening the box shows the chosen label, selected, ready to be typed over. That label
      // is not a query — reading it as one would narrow the list to the single row you are
      // already on, and hide every alternative at the moment you went looking for one.
      const cur = chosen();
      const typed = (cur && input.value === cur.text) ? '' : input.value;
      const ts = terms(typed);
      const all = read();
      shown = ts.length ? all.filter((o) => hit(o.hay, ts)) : all;

      scroll.innerHTML = '';
      if (!shown.length) {
        const none = document.createElement('div');
        none.className = 'tx-pick-none';
        none.textContent = 'Nothing matches \u201c' + input.value.trim() + '\u201d.';
        scroll.appendChild(none);
        foot.textContent = 'No ' + noun + ' match. Clear the box to see them all.';
        active = -1;
        return;
      }

      let lastGroup = null;
      shown.forEach((o, i) => {
        if (o.group !== lastGroup) {
          lastGroup = o.group;
          if (o.group) {
            const g = document.createElement('div');
            g.className = 'tx-pick-grp';
            g.textContent = o.group;
            scroll.appendChild(g);
          }
        }
        const row = document.createElement('div');
        row.className = 'tx-pick-opt'
          + (o.disabled ? ' is-off' : '')
          + (o.value && o.value === sel.value ? ' is-sel' : '');
        row.id = id + 'o' + i;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', o.value === sel.value ? 'true' : 'false');
        row.dataset.i = String(i);
        row.textContent = o.text;
        row.title = o.text;
        scroll.appendChild(row);
      });

      const total = all.filter((o) => o.value).length;
      const found = shown.filter((o) => o.value).length;
      foot.textContent = ts.length
        ? found + ' of ' + total + ' ' + plural(total)
        : total + ' ' + plural(total) + ' \u00b7 type to search';

      // Start on whatever is already chosen, so opening and pressing Enter changes nothing.
      const at = shown.findIndex((o) => o.value && o.value === sel.value);
      setActive(at >= 0 ? at : firstUsable());
    }

    /** "1 job cards" reads like a fault in the app. */
    function plural(n) { return n === 1 ? noun.replace(/s$/, '') : noun; }

    function firstUsable() {
      for (let i = 0; i < shown.length; i++) if (!shown[i].disabled) return i;
      return -1;
    }

    function setActive(i) {
      active = i;
      const rows = scroll.querySelectorAll('.tx-pick-opt');
      rows.forEach((r) => r.classList.remove('is-on'));
      if (i < 0) { input.removeAttribute('aria-activedescendant'); return; }
      const row = scroll.querySelector('[data-i="' + i + '"]');
      if (!row) return;
      row.classList.add('is-on');
      input.setAttribute('aria-activedescendant', row.id);
      const rb = row.getBoundingClientRect();
      const sb = scroll.getBoundingClientRect();
      if (rb.top < sb.top) scroll.scrollTop -= (sb.top - rb.top) + 24;
      else if (rb.bottom > sb.bottom) scroll.scrollTop += (rb.bottom - sb.bottom);
    }

    function move(step) {
      if (!shown.length) return;
      let i = active;
      for (let n = 0; n < shown.length; n++) {
        i = (i + step + shown.length) % shown.length;
        if (!shown[i].disabled) { setActive(i); return; }
      }
    }

    // ── position ───────────────────────────────────────────────────────────
    //
    // Fixed to the viewport and parented to <body>: a picker inside a modal, a scrolling
    // panel or anything with overflow:hidden still shows its whole list.

    function place() {
      const r = input.getBoundingClientRect();
      const below = global.innerHeight - r.bottom - 8;
      const above = r.top - 8;
      const want = 320;
      const up = below < 180 && above > below;
      const h = Math.max(120, Math.min(want, up ? above : below));
      pop.style.left = Math.max(8, Math.min(r.left, global.innerWidth - r.width - 8)) + 'px';
      pop.style.width = Math.max(220, r.width) + 'px';
      pop.style.maxHeight = h + 'px';
      scroll.style.maxHeight = (h - 26) + 'px';
      if (up) { pop.style.top = ''; pop.style.bottom = (global.innerHeight - r.top + 4) + 'px'; }
      else { pop.style.bottom = ''; pop.style.top = (r.bottom + 4) + 'px'; }
    }

    // ── open / close ───────────────────────────────────────────────────────

    function show() {
      if (open || sel.disabled) return;
      open = true;
      pop.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      render();
      place();
      document.addEventListener('pointerdown', outside, true);
      global.addEventListener('scroll', place, true);
      global.addEventListener('resize', place);
    }

    function close() {
      if (!open) return;
      open = false;
      pop.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      document.removeEventListener('pointerdown', outside, true);
      global.removeEventListener('scroll', place, true);
      global.removeEventListener('resize', place);
      paint();                              // half-typed text is discarded, not submitted
    }

    function outside(e) {
      if (wrap.contains(e.target) || pop.contains(e.target)) return;
      close();
    }

    /** Commit one option: the select is set first, then told about it, exactly as before. */
    function choose(o) {
      if (!o || o.disabled) return;
      const before = sel.value;
      sel.value = o.value;
      close();
      // Matching the native control: re-picking what was already chosen is not a change.
      if (sel.value !== before) sel.dispatchEvent(new Event('change', { bubbles: true }));
      paint();
    }

    // ── events ─────────────────────────────────────────────────────────────

    input.addEventListener('focus', () => { show(); input.select(); });
    input.addEventListener('mousedown', () => { if (!open) setTimeout(show, 0); });

    input.addEventListener('input', (e) => {
      e.stopPropagation();                  // the select is the widget's only public event
      if (!open) show(); else { render(); place(); }
    });
    // A text box that fires 'change' where a select used to would reach handlers listening for
    // the select's own change and hand them the typed text.
    input.addEventListener('change', (e) => { e.stopPropagation(); });

    input.addEventListener('keydown', (e) => {
      const k = e.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        e.preventDefault();
        if (!open) { show(); return; }
        move(k === 'ArrowDown' ? 1 : -1);
      } else if (k === 'Enter') {
        if (open) { e.preventDefault(); choose(shown[active]); }
      } else if (k === 'Escape') {
        if (open) { e.preventDefault(); e.stopPropagation(); close(); }
      } else if (k === 'Tab') {
        close();
      } else if (k === 'Home' && open) {
        e.preventDefault(); setActive(firstUsable());
      } else if (k === 'End' && open) {
        e.preventDefault();
        for (let i = shown.length - 1; i >= 0; i--) if (!shown[i].disabled) { setActive(i); break; }
      }
    });

    // mousedown, not click: preventDefault keeps focus in the box, so the list does not close
    // underneath the finger before the tap lands.
    pop.addEventListener('mousedown', (e) => { e.preventDefault(); });
    pop.addEventListener('click', (e) => {
      const row = e.target.closest('.tx-pick-opt');
      if (!row) return;
      choose(shown[+row.dataset.i]);
    });

    clear.addEventListener('mousedown', (e) => e.preventDefault());
    clear.addEventListener('click', () => {
      const blank = read().find((o) => !o.value);
      choose(blank || { value: '', disabled: false });
      input.focus();
    });

    // ── keeping the box honest ─────────────────────────────────────────────

    // Options get refilled (job cards finish loading, a base filter changes) by code that has
    // no idea this exists.
    const obs = new MutationObserver(() => { paint(); if (open) { render(); place(); } });
    obs.observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });

    // Code all over both apps assigns sel.value directly — restoring a choice after a refill,
    // clearing a form. That fires no event and mutates no node, so without this the box would
    // go on showing a job card the select no longer holds: it would still SUBMIT the right
    // one, which is worse, because nothing on screen would say so.
    const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (nativeValue && nativeValue.get && nativeValue.set) {
      Object.defineProperty(sel, 'value', {
        configurable: true,
        enumerable: false,
        get() { return nativeValue.get.call(this); },
        set(v) { nativeValue.set.call(this, v); paint(); },
      });
    }

    sel.addEventListener('change', paint);

    const api = {
      el: sel,
      input,
      refresh: () => { paint(); if (open) render(); },
      focus: () => input.focus(),
      destroy: () => {
        obs.disconnect();
        close();
        LIVE.delete(api);
        if (pop.parentNode) pop.parentNode.removeChild(pop);
        if (wrap.parentNode) { wrap.parentNode.insertBefore(sel, wrap); wrap.parentNode.removeChild(wrap); }
        sel.classList.remove('tx-pick-native');
        delete sel.__txPick;
      },
    };
    sel.__txPick = api;
    LIVE.add(api);
    paint();
    return api;
  }

  /** Upgrade every match under `root` that has not been upgraded already. */
  function attachAll(selector, root, opts) {
    const host = root || document;
    const out = [];
    host.querySelectorAll(selector).forEach((el) => {
      const p = attach(el, opts);
      if (p) out.push(p);
    });
    return out;
  }

  /**
   * Upgrade everything that asked to be searchable.
   *
   * A list declares itself in the markup -- <select data-search="job cards"> -- rather than
   * relying on some module remembering to call attach(). That is one place to look to answer
   * "is this list searchable?", and one place for a test to check that no job card or client
   * picker has been added without it.
   */
  function scan(root) {
    const host = root || document;
    const out = [];
    host.querySelectorAll('select[data-search]').forEach((el) => {
      const p = attach(el, { noun: el.getAttribute('data-search') || 'entries' });
      if (p) out.push(p);
    });
    return out;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scan());
  else scan();

  function refresh(sel) {
    if (sel && sel.__txPick) sel.__txPick.refresh();
  }

  /** CSS.escape is not everywhere; an id here is only ever a plain identifier. */
  function cssEscape(s) {
    return (global.CSS && global.CSS.escape) ? global.CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
  }

  TX.pick = attach;
  TX.pick.attach = attach;
  TX.pick.all = attachAll;
  TX.pick.scan = scan;
  TX.pick.refresh = refresh;
  // Exported so the tests exercise the real matcher rather than a copy of it.
  TX.pick.match = { norm, terms, hit };
})(window);
