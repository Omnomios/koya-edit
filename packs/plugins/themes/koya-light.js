import {hex, sharedLayout} from '/rom/theme.js';

/** Light surfaces with the same warm accent family. */
export const id = 'koya-light';
export const label = 'Koya Light';

export const colours = {
    bg: hex('#f7f5f2'),
    shell: hex('#ebe7e1'),
    panel: hex('#ebe7e1'),
    panelAlt: hex('#e2ddd6'),
    panelHigh: hex('#d5cfc6'),
    panelHighest: hex('#c8c1b6'),
    border: hex('#cfc8be'),
    borderStrong: hex('#b8b0a4'),

    text: hex('#2a2826'),
    textDim: hex('#5c5854'),
    textMuted: hex('#7a756e'),

    primary: hex('#c45a28'),
    primaryContainer: hex('#e96b34'),
    onPrimaryContainer: hex('#fff6f0'),
    tertiary: hex('#5a5248'),
    tertiaryContainer: hex('#8a8074'),
    secondary: hex('#4a463f'),

    accent: hex('#c45a28'),
    tabActive: hex('#ffffff'),
    tabInactive: hex('#e8e3dc'),
    selection: hex('#e96b34', 0.22),
    caret: hex('#c45a28'),
    activeLine: hex('#efeae3'),
    treeHover: hex('#ddd6cc'),
    treeActive: hex('#d2cabf'),
    dirty: hex('#c45a28'),
    statusBg: hex('#e96b34'),
    statusFg: hex('#4f1700'),
    statusChip: hex('#ffb599'),

    diffAdded: hex('#2e7d32'),
    diffModified: hex('#c45a28'),
    diffDeleted: hex('#c62828'),

    code: hex('#2a2826'),

    syntax: {
        keyword: hex('#af3029'),
        string: hex('#ad6e2a'),
        comment: hex('#5a7a3a'),
        function: hex('#7a4fb0'),
        type: hex('#1e7a6a'),
        number: hex('#4a7a3a'),
        constant: hex('#2a6aa8'),
        boolean: hex('#2a6aa8'),
        operator: hex('#4a463f'),
        punctuation: hex('#4a463f'),
        variable: hex('#2a6a9a'),
        support: hex('#1e6a9a'),
        parameter: hex('#b05a1a'),
        member: hex('#3a3834'),
        property: hex('#2a6a9a'),
        attribute: hex('#2a6a9a'),
        label: hex('#af3029'),
        module: hex('#4a463f'),
        constructor: hex('#1e7a6a'),
        embedded: hex('#4a463f'),
        heading: hex('#2a6aa8'),
        strong: hex('#2a6aa8'),
        emphasis: hex('#3a3834'),
        link: hex('#1e6a9a'),
        tag: hex('#2a6aa8')
    },

    scrollbarThumb: hex('#8a847a', 0.45),
    scrollbarThumbHover: hex('#8a847a', 0.65),
    scrollbarThumbActive: hex('#8a847a', 0.8),

    ...sharedLayout
};
