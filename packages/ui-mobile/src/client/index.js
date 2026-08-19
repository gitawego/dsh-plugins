// @gitawego/dsh-ui-mobile — browser bundle.
//
// A glass pill anchored top-left that surfaces sidebar / details on phones.
// Everything below the pill belongs to the layout; this plugin only adds
// two reachable entry points and the safe-area inset for notched screens.
//
// Design (intentional, opinionated):
//   - Single pill surface, top: 12px, left: 12px; not a full-width bar.
//   - Soft sky accent (#6CB6FF) for focus ring, never for fill.
//   - Tooltip slides under the icon on hover/focus, never on tap (mobile
//     hover is sticky and would obscure the tap target).
//   - When a drawer is open the pill recedes (translateY + opacity 0.6)
//     so the drawer content owns the viewport.
//   - The pill is hidden entirely on desktop (>= 900px) so the layout's
//     own sidebar rail stays the single source of truth for navigation.
//
// Responsive CSS scope is unchanged from prior iterations: every rule lives
// inside @media (max-width: 900px) and is gated on the html[data-dsh-mobile]
// attribute so desktop never sees it.

window.__ModuleLoader__.load({
  id: '@gitawego/dsh-ui-mobile',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var BREAKPOINT = 900
    var CSS_TAG_ID = '@gitawego/dsh-ui-mobile/responsive.css'
    // NOTE: these IDs must be plain CSS identifiers. CSS selectors like
    // #@gitawego/ui-mobile-pill are invalid (identifiers cannot contain /
    // or @ unescaped) and the browser silently drops every rule — the pill
    // would render as an unstyled static div at the end of <body>.
    var BAR_ID = 'dsh-ui-mobile-pill'
    var SCRIM_ID = 'dsh-ui-mobile-scrim'
    var ROOT_ATTR = 'data-dsh-mobile'

    // -- pure helpers (exported for the repo's node tests) -------------------

    function drawerColumns(narrow, sidebarOpen, detailsOpen) {
      if (!narrow) return { columns: '', important: false }
      if (sidebarOpen) return { columns: 'min(300px, 88vw) 0 0', important: true }
      if (detailsOpen) return { columns: '0 0 min(300px, 88vw)', important: true }
      return { columns: '0 minmax(0, 1fr) 0', important: true }
    }

    // SVG glyphs. Drawn at 18x18 to align with the button's tap target.
    var ICON_MENU =
      '<svg class="dls-glyph" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">' +
      '  <path d="M2 4.5h14M2 9h14M2 13.5h14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
      '</svg>'
    function responsiveCss() {
      return [
        '',
        '/* @gitawego/dsh-ui-mobile: top-left pill + responsive layout for narrow viewports. */',
        '@media (max-width: ' + BREAKPOINT + 'px) {',
        '  html, body { overflow-x: hidden; }',
        '  html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }',
        '  html[' + ROOT_ATTR + '] div[data-sidebar-collapsed],',
        '  html[' + ROOT_ATTR + '] div[data-details-collapsed] {',
        '    grid-template-columns: 0 minmax(0, 1fr) 0 !important;',
        '  }',
                // The button floats over the header row's empty left region; only the
        // left-aligned tabs need clearance so Chat/Trajectory never sit
        // underneath it. No vertical reserve — the header starts at the top.
        '  .wSkVaW_header { min-height: 52px; padding: 6px 14px; }',
        '  .wSkVaW_titleCluster { min-width: 0; }',
        '  .wSkVaW_crumbs { display: none; }',
        '  .wSkVaW_tabs { gap: 16px; padding: 0 14px 0 64px; }',
        '  .wSkVaW_tab { font-size: 14px; padding: 8px 2px; }',
        '  .wSkVaW_headerActions { margin-left: auto; gap: 8px; }',
        // Composer — one compact row on phones: shrink the icons back to
        // the host's native sizes (28–34px), stop the wrap, and let the
        // mode + model selectors truncate instead of pushing to a second
        // line. Tap targets stay >= 32px (WCAG 2.5.8 minimum is 24px).
        '  .uV2eYG_card, .uV2eYG_root { padding: 8px; }',
        '  .uV2eYG_card { gap: 8px; padding-top: 8px; }',
        '  .uV2eYG_row { flex-wrap: nowrap; align-items: center; gap: 6px; padding: 0 6px 6px; }',
        '  .uV2eYG_modes { gap: 4px; min-width: 0; }',
        '  .uV2eYG_modes .uV2eYG_select { min-width: 0; max-width: 34vw; }',
        '  .uV2eYG_select { max-width: 34vw; height: 28px; padding: 0 16px 0 6px; font-size: 12px; }',
        '  .uV2eYG_add, .uV2eYG_primary { width: 32px; height: 32px; min-width: 32px; min-height: 32px; }',
        '  .uV2eYG_trailing { gap: 4px; }',
        // Model/mode select — truncate, never wrap.
        '  ._7KE1Ra_trigger { max-width: 26vw; height: 28px; padding: 0 4px 0 6px; font-size: 12px; }',
        '  ._7KE1Ra_triggerLabel { max-width: 20vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '  .lXshSW_root { padding: 12px; }',
        '  .lXshSW_item { flex-wrap: wrap; align-items: flex-start; }',
        '  .lXshSW_title, .lXshSW_content { white-space: normal; overflow-wrap: anywhere; }',
        '  .p-xYUq_actions { gap: 12px; }',
        '  .p-xYUq_action { min-width: 36px; min-height: 36px; }',
        '  #' + BAR_ID + ' {',
        '    position: fixed;',
        // Plain 12px first (progressive fallback); the calc(env()) line
        // overrides when the browser supports safe-area insets. Never use
        // env() inside max() — Android WebView rejects that declaration
        // and the whole `top`/`left` property falls back to auto, dropping
        // the chrome to its static position at the bottom of <body>.
        '    top: 12px; left: 12px;',
        '    top: calc(env(safe-area-inset-top, 0px) + 12px);',
        '    left: calc(env(safe-area-inset-left, 0px) + 12px);',
        '    z-index: 2147483000;',
        '    display: inline-flex;',
        '    box-sizing: border-box;',
        '    transition: transform 180ms cubic-bezier(.4, 0, .2, 1), opacity 180ms ease;',
        '  }',
        '  html[' + ROOT_ATTR + '][data-dsh-phone-drawer] #' + BAR_ID + ' {',
        '    opacity: 0; pointer-events: none; transform: translateY(-4px);',
        '  }',
        '  #' + BAR_ID + ' button {',
        '    position: relative;',
        '    display: inline-flex; align-items: center; justify-content: center;',
        '    width: 46px; height: 46px;',
        '    margin: 0; border: 1px solid rgba(232, 235, 243, 0.10);',
        '    border-radius: 50%;',
        '    background: rgba(14, 18, 32, 0.72);',
        '    backdrop-filter: blur(18px) saturate(140%);',
        '    -webkit-backdrop-filter: blur(18px) saturate(140%);',
        '    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.04);',
        '    color: var(--dsw-alias-label-primary, #e8ebf3);',
        '    -webkit-tap-highlight-color: transparent;',
        '    transition: background 120ms ease, color 120ms ease;',
        '  }',
        '  #' + BAR_ID + ' button::after {',
        '    content: attr(data-tip);',
        '    position: absolute; top: calc(100% + 8px); left: 50%;',
        '    transform: translateX(-50%) translateY(-2px);',
        '    padding: 4px 8px; border-radius: 6px;',
        '    background: rgba(14, 18, 32, 0.94);',
        '    color: rgba(232, 235, 243, 0.88);',
        '    font-size: 11px; font-weight: 500; line-height: 1;',
        '    letter-spacing: 0.01em;',
        '    border: 1px solid rgba(232, 235, 243, 0.08);',
        '    opacity: 0; pointer-events: none;',
        '    transition: opacity 140ms ease, transform 140ms ease;',
        '    white-space: nowrap;',
        '  }',
        '  #' + BAR_ID + ' button:hover { background: rgba(232, 235, 243, 0.08); }',
        '  #' + BAR_ID + ' button:active { background: rgba(232, 235, 243, 0.14); }',
        '  #' + BAR_ID + ' button:focus-visible {',
        '    outline: 2px solid #6CB6FF; outline-offset: 1px;',
        '  }',
        '  #' + BAR_ID + ' button:hover::after,',
        '  #' + BAR_ID + ' button:focus-visible::after {',
        '    opacity: 1; transform: translateX(-50%) translateY(0);',
        '  }',
        '  #' + BAR_ID + ' .dls-glyph { display: block; }',
        // ---- settings: full-screen sheet + chip rail on narrow -------------
        // The host settings modal is an 800px two-pane (188px nav + content).
        // On a phone that crams to ~430px and breaks words mid-character.
        // Convert it to a full-bleed sheet: nav becomes a horizontal chip
        // rail under the sheet header, content takes the rest of the width.
        // Class names are the settings-general build's hashed tokens; they
        // drift on dsh updates, so these rules degrade to the stock modal.
        '  html[' + ROOT_ATTR + '] .VOzbGW_overlay { padding: 0; align-items: stretch; }',
        '  html[' + ROOT_ATTR + '] .VOzbGW_panel {',
        '    box-sizing: border-box;',
        '    width: 100vw; max-width: 100vw;',
        // 100vh in content-box plus the safe-area padding would overflow the
        // fixed overlay by the padding height and crop the bottom. border-box
        // makes the padding part of the 100vh. dvh tracks the shrinking
        // mobile URL bar; vh first as the fallback, dvh overrides.
        '    height: 100vh; height: 100dvh;',
        '    max-height: 100vh; max-height: 100dvh;',
        '    border-radius: 0;',
        '    flex-direction: column;',
        '    padding-top: env(safe-area-inset-top, 0px);',
        '  }',
        '  html[' + ROOT_ATTR + '] .VOzbGW_nav {',
        '    width: 100%; flex: none;',
        '    flex-direction: column; gap: 6px;',
        '    padding: 10px 12px 8px;',
        '    border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(232, 235, 243, 0.08));',
        '  }',
        '  html[' + ROOT_ATTR + '] .VOzbGW_navTitle { display: none; }',
        '  html[' + ROOT_ATTR + '] .VOzbGW_navList {',
        '    flex-direction: row; gap: 6px;',
        '    overflow-x: auto; -webkit-overflow-scrolling: touch;',
        '    scrollbar-width: none;',
        '  }',
        '  html[' + ROOT_ATTR + '] .VOzbGW_navList::-webkit-scrollbar { display: none; }',
        '  html[' + ROOT_ATTR + '] .VOzbGW_navCell {',
        '    height: 34px; padding: 0 12px;',
        '    flex: 0 0 auto; white-space: nowrap;',
        '  }',
        '  html[' + ROOT_ATTR + '] .VOzbGW_content { flex: 1; min-width: 0; min-height: 0; }',
        // min-height: 0 is the missing piece: without it the content child
        // cannot shrink below its content height and the panel overflows
        // instead of letting the options area scroll.
        '  html[' + ROOT_ATTR + '] .VOzbGW_options {',
        '    flex: 1; min-height: 0;',
        '    overflow-y: auto; -webkit-overflow-scrolling: touch;',
        '    overscroll-behavior: contain;',
        '    padding: 4px 16px 24px;',
        '  }',
        // The row squeeze caused the mid-word breaks; give text room to wrap.
        '  html[' + ROOT_ATTR + '] .VOzbGW_options [data-slot*="settings."] > * {',
        '    min-width: 0; overflow-wrap: normal; word-break: normal;',
        '  }',
        '  #' + SCRIM_ID + ' { position: fixed; inset: 0; z-index: 2147482999; display: none; background: rgba(0, 0, 0, 0.45); }',
        '  html[' + ROOT_ATTR + '][data-dsh-phone-drawer] #' + SCRIM_ID + ' { display: block; }',
        '}',
        '@media (max-width: 700px) {',
        '  * { -webkit-tap-highlight-color: transparent; }',
        '  html, body { overscroll-behavior-y: none; padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right); }',
        '}',
        '@media (prefers-reduced-motion: reduce) {',
        '  #' + BAR_ID + ', #' + BAR_ID + ' button, #' + BAR_ID + ' button::after { transition: none; }',
        '}',
        ''
      ].join('\n')
    }

    var inject = []

    var bar = null
    var scrim = null

    function isNarrow() {
      return typeof matchMedia === 'function' ? matchMedia('(max-width: ' + BREAKPOINT + 'px)').matches : true
    }

    function frameEl() {
      if (typeof document === 'undefined') return null
      return document.querySelector('div[data-sidebar-collapsed], div[data-details-collapsed], [class*="sidebarCol"]')
    }

    function sidebarOpen() {
      var el = frameEl()
      return el ? el.getAttribute('data-sidebar-collapsed') === null : false
    }

    function detailsOpen() {
      var el = frameEl()
      return el ? el.getAttribute('data-details-collapsed') === null : false
    }

    function forceColumns() {
      if (typeof document === 'undefined') return
      var narrow = isNarrow()
      if (narrow) document.documentElement.setAttribute(ROOT_ATTR, '')
      else document.documentElement.removeAttribute(ROOT_ATTR)
      var override = drawerColumns(narrow, sidebarOpen(), detailsOpen())
      if (narrow && (sidebarOpen() || detailsOpen())) document.documentElement.setAttribute('data-dsh-phone-drawer', '')
      else document.documentElement.removeAttribute('data-dsh-phone-drawer')
      var els = document.querySelectorAll('[style*="grid-template-columns"]')
      for (var i = 0; i < els.length; i++) {
        els[i].style.setProperty('grid-template-columns', override.columns, override.important ? 'important' : '')
      }
    }

    function installStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]')) return
      var tag = document.createElement('style')
      tag.dataset.plugin = '@gitawego/dsh-ui-mobile'
      tag.dataset.pluginCss = CSS_TAG_ID
      tag.textContent = responsiveCss()
      document.head.appendChild(tag)
    }

    function onClickSidebar(ctx) {
      var layoutOk = false
      try {
        if (ctx && ctx.layout && typeof ctx.layout.toggleSidebar === 'function') {
          ctx.layout.toggleSidebar()
          layoutOk = true
        }
      } catch (e) { /* fall through */ }
      if (!layoutOk) {
        var btn = document.querySelector('[class*="toggle"][aria-label*="sidebar" i]')
          || document.querySelector('[class*="toggle"]')
        if (btn && typeof btn.click === 'function') btn.click()
      }
    }

    function onClickScrim(ctx) {
      if (!ctx || !ctx.layout) return
      try {
        if (sidebarOpen()) ctx.layout.toggleSidebar()
        else if (detailsOpen() && typeof ctx.layout.closeDetails === 'function') ctx.layout.closeDetails()
      } catch (e) { /* ignore */ }
    }

    function ensureChrome(ctx) {
      if (typeof document === 'undefined') return
      if (!bar) {
        bar = document.createElement('div')
        bar.id = BAR_ID
        function addBtn(ariaLabel, tip, glyph, handler) {
          var b = document.createElement('button')
          b.type = 'button'
          b.setAttribute('aria-label', ariaLabel)
          b.setAttribute('data-tip', tip)
          b.innerHTML = glyph
          b.addEventListener('click', function () { handler(ctx) })
          bar.appendChild(b)
          return b
        }
        addBtn('Open navigation', 'Workspaces', ICON_MENU, onClickSidebar)
        document.body.appendChild(bar)
      }
      if (!scrim) {
        scrim = document.createElement('div')
        scrim.id = SCRIM_ID
        scrim.setAttribute('aria-hidden', 'true')
        scrim.addEventListener('click', function () { onClickScrim(ctx) })
        document.body.appendChild(scrim)
      }
      // Hide the pill while the host settings modal is open — the sheet is
      // z-index 1000 and the pill is 2147483000, so it would float over the
      // sheet header. The MutationObserver fires on the modal's append and
      // re-runs this display computation.
      var modalOpen = !!document.querySelector('.VOzbGW_overlay')
      bar.style.display = (isNarrow() && !modalOpen) ? 'inline-flex' : 'none'
      scrim.style.display = 'none'
    }

    function apply(ctx) {
      var raf = null
      var mo = null
      var media = typeof matchMedia === 'function' ? matchMedia('(max-width: ' + BREAKPOINT + 'px)') : void 0
      var isNarrowNow = function () { return media ? media.matches : false }
      var installed = false

      function activate() {
        if (installed) return
        if (typeof document === 'undefined') return
        installStyles()
        ensureChrome(ctx)
        forceColumns()
        mo = new MutationObserver(function () {
          if (raf) return
          raf = requestAnimationFrame(function () {
            raf = null
            ensureChrome(ctx)
            forceColumns()
          })
        })
        mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-sidebar-collapsed', 'data-details-collapsed'] })
        installed = true
      }

      function deactivate() {
        if (!installed) return
        if (mo) { mo.disconnect(); mo = null }
        if (typeof document !== 'undefined') {
          var tag = document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]')
          if (tag) tag.remove()
          document.documentElement.removeAttribute(ROOT_ATTR)
          document.documentElement.removeAttribute('data-dsh-phone-drawer')
        }
        if (bar) { bar.remove(); bar = null }
        if (scrim) { scrim.remove(); scrim = null }
        installed = false
      }

      function sync() {
        if (isNarrowNow()) activate(); else deactivate()
      }

      if (media && typeof media.addEventListener === 'function') media.addEventListener('change', sync)
      if (typeof window !== 'undefined') window.addEventListener('resize', sync)
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(sync)
      else sync()

      return function dispose() {
        deactivate()
        if (media && typeof media.removeEventListener === 'function') media.removeEventListener('change', sync)
        if (typeof window !== 'undefined') window.removeEventListener('resize', sync)
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.drawerColumns = drawerColumns
    exports.responsiveCss = responsiveCss
    return module.exports
  }
})
