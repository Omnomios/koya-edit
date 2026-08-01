import {hex, sharedLayout} from '/rom/theme.js';

/** Current KoyaEdit palette — warm Material dark. */
export const id = 'koya-dark';
export const label = 'Koya Dark';

export const colours = {
    bg: hex('#121314'),
    shell: hex('#191a1b'),
    panel: hex('#191a1b'),
    panelAlt: hex('#202122'),
    panelHigh: hex('#2c2d2e'),
    panelHighest: hex('#333536'),
    border: hex('#2a2b2c'),
    borderStrong: hex('#333536'),

    text: hex('#bfbfbf'),
    textDim: hex('#8c8c8c'),
    textMuted: hex('#858889'),

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

    diffAdded: hex('#4caf50'),
    diffModified: hex('#e96b34'),
    diffDeleted: hex('#e57373'),

    code: hex('#bbbebf'),

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
        support: hex('#79c0ff'),
        parameter: hex('#ffa657'),
        member: hex('#c9d1d9'),
        property: hex('#9cdcfe'),
        attribute: hex('#9cdcfe'),
        label: hex('#ff7b72'),
        module: hex('#d4d4d4'),
        constructor: hex('#4ec9b0'),
        embedded: hex('#d4d4d4'),
        heading: hex('#569cd6'),
        strong: hex('#569cd6'),
        emphasis: hex('#c9d1d9'),
        link: hex('#79c0ff'),
        tag: hex('#569cd6')
    },

    scrollbarThumb: hex('#a8a9aa', 0.52),
    scrollbarThumbHover: hex('#a8a9aa', 0.72),
    scrollbarThumbActive: hex('#a8a9aa', 0.85),

    ...sharedLayout
};
