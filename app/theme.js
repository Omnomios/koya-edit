/** Shared visual tokens — aligned to the KoiEdit HTML mockup (Material dark warm). */

const hex = (h, a = 1) => {
  const n = parseInt(String(h).replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
};

export const theme = {
  // Surfaces (from provided VS Code theme)
  bg: hex('#121314'),                 // editor.background
  shell: hex('#191a1b'),              // sideBar / activityBar
  panel: hex('#191a1b'),
  panelAlt: hex('#202122'),
  panelHigh: hex('#2c2d2e'),
  panelHighest: hex('#333536'),
  border: hex('#2a2b2c'),
  borderStrong: hex('#333536'),

  // Type
  text: hex('#bfbfbf'),
  textDim: hex('#8c8c8c'),
  textMuted: hex('#858889'),

  // Brand
  primary: hex('#ffb599'),
  primaryContainer: hex('#e96b34'),
  onPrimaryContainer: hex('#4f1700'),
  tertiary: hex('#d0c5b5'),
  tertiaryContainer: hex('#998f81'),
  secondary: hex('#ccc6b3'),

  accent: hex('#ffb599'),
  tabActive: hex('#0e0e0e'),
  tabInactive: hex('#1c1b1b'),
  selection: hex('#e96b34', 0.28),
  caret: hex('#e96b34'),
  activeLine: hex('#201f1f'),
  treeHover: hex('#353534'),
  treeActive: hex('#2a2a2a'),
  dirty: hex('#ffb599'),
  statusBg: hex('#e96b34'),
  statusFg: hex('#4f1700'),
  statusChip: hex('#ffb599'),

  /** Gutter diff marks (git plugin / line marks). */
  diffAdded: hex('#4caf50'),
  diffModified: hex('#e96b34'),
  diffDeleted: hex('#e57373'),

  /** Default editor foreground (from theme editor.foreground). */
  code: hex('#bbbebf'),

  /**
   * Colours from the provided VS Code theme tokenColors:
   *   keyword/storage          #FF7B72
   *   entity.name.function     #D2A8FF  (hypot, distance)
   *   support.class/type       #4EC9B0  (Number — the screenshot green)
   *   constant.numeric         #B5CEA8
   *   constant.language        #569CD6  (null, true, false)
   *   variable                 #9CDCFE  (previousSpeed, previous)
   *   support                  #79C0FF  (Math, JSON, …)
   *   variable (params/names)  #FFA657  (sample, clientActivation-style locals)
   *   variable.other           #C9D1D9  (.v, .replicaState)
   *   meta.object-literal.key  #9CDCFE
   *   string                   #CE9178
   *   comment                  #6A9955
   *   keyword.operator         #D4D4D4
   */
  syntax: {
    keyword: hex('#ff7b72'),
    string: hex('#ce9178'),
    comment: hex('#6a9955'),
    function: hex('#d2a8ff'),
    type: hex('#4ec9b0'),
    number: hex('#b5cea8'),
    constant: hex('#569cd6'),
    boolean: hex('#569cd6'),
    operator: hex('#d4d4d4'),
    punctuation: hex('#d4d4d4'),
    variable: hex('#9cdcfe'),
    /** Math / JSON / Reflect — support.* */
    support: hex('#79c0ff'),
    parameter: hex('#ffa657'),
    member: hex('#c9d1d9'),
    property: hex('#9cdcfe'),
    attribute: hex('#9cdcfe'),
    label: hex('#ff7b72'),
    module: hex('#d4d4d4'),
    constructor: hex('#4ec9b0'),
    embedded: hex('#d4d4d4'),
    /** Markdown */
    heading: hex('#569cd6'),
    strong: hex('#569cd6'),
    emphasis: hex('#c9d1d9'),
    link: hex('#79c0ff'),
    /** HTML tag names (entity.name.tag) */
    tag: hex('#569cd6')
  },

  fontUi: 'Inter',
  fontMono: 'Hack',
  /** Symbol/dingbat glyphs (▾ ▸ ⎇ ↻ ⌕ …) — UI fonts often lack them. */
  fontIcon: 'Symbola',
  fontSizeUi: 14,
  fontSizeUiSm: 11,
  /** Match left reference pane density (~14px, tight leading). */
  fontSizeCode: 14,
  fontSizeCodeSm: 12,
  treeWidth: 260,
  treeRowHeight: 26,
  tabHeight: 36,
  /** Title bar + sidebar activity row share this so the top chrome lines up. */
  menuHeight: 36,
  breadcrumbHeight: 24,
  gutterWidth: 48,
  statusHeight: 24,
  titleBarHeight: 36,
  searchWidth: 192,
  minimapWidth: 96,
  /** Vertical editor scrollbar track width. */
  scrollbarWidth: 10,
  scrollbarThumb: hex('#a8a9aa', 0.52),
  scrollbarThumbHover: hex('#a8a9aa', 0.72),
  scrollbarThumbActive: hex('#a8a9aa', 0.85),
  windowSize: { x: 1320, y: 1084 }
};
