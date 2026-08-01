import {hex, sharedLayout} from '/rom/theme.js';

/** Cooler blue-grey dark with cyan accent. */
export const id = 'koya-slate';
export const label = 'Koya Slate';

export const colours = {
    bg: hex('#0f1419'),
    shell: hex('#151b22'),
    panel: hex('#151b22'),
    panelAlt: hex('#1c2430'),
    panelHigh: hex('#273140'),
    panelHighest: hex('#334155'),
    border: hex('#243044'),
    borderStrong: hex('#334155'),

    text: hex('#c8d1dc'),
    textDim: hex('#8b98a8'),
    textMuted: hex('#6b7a8c'),

    primary: hex('#5ec8e8'),
    primaryContainer: hex('#2a9bb8'),
    onPrimaryContainer: hex('#041820'),
    tertiary: hex('#a8b4c4'),
    tertiaryContainer: hex('#6b7a8c'),
    secondary: hex('#b0bcc8'),

    accent: hex('#5ec8e8'),
    tabActive: hex('#0b1016'),
    tabInactive: hex('#182028'),
    selection: hex('#2a9bb8', 0.32),
    caret: hex('#5ec8e8'),
    activeLine: hex('#182230'),
    treeHover: hex('#243040'),
    treeActive: hex('#1e2a38'),
    dirty: hex('#5ec8e8'),
    statusBg: hex('#2a9bb8'),
    statusFg: hex('#041820'),
    statusChip: hex('#5ec8e8'),

    diffAdded: hex('#3dd68c'),
    diffModified: hex('#5ec8e8'),
    diffDeleted: hex('#f07178'),

    code: hex('#c8d1dc'),

    syntax: {
        keyword: hex('#f07178'),
        string: hex('#c3e88d'),
        comment: hex('#5c6773'),
        function: hex('#d4bfff'),
        type: hex('#7fd9c5'),
        number: hex('#ffcc66'),
        constant: hex('#5ec8e8'),
        boolean: hex('#5ec8e8'),
        operator: hex('#c8d1dc'),
        punctuation: hex('#c8d1dc'),
        variable: hex('#9cdcfe'),
        support: hex('#73d0ff'),
        parameter: hex('#ffb454'),
        member: hex('#b8c5d4'),
        property: hex('#9cdcfe'),
        attribute: hex('#9cdcfe'),
        label: hex('#f07178'),
        module: hex('#c8d1dc'),
        constructor: hex('#7fd9c5'),
        embedded: hex('#c8d1dc'),
        heading: hex('#5ec8e8'),
        strong: hex('#5ec8e8'),
        emphasis: hex('#b8c5d4'),
        link: hex('#73d0ff'),
        tag: hex('#5ec8e8')
    },

    scrollbarThumb: hex('#7a8a9c', 0.5),
    scrollbarThumbHover: hex('#7a8a9c', 0.7),
    scrollbarThumbActive: hex('#7a8a9c', 0.85),

    ...sharedLayout
};
