/**
 * Editor preferences. Status bar “Spaces: N” mirrors tabSize when insertSpaces
 * is true; both will be user-configurable later.
 */
export const editorSettings = {
    /** Columns per indent / soft-tab. */
    tabSize: 2,
    /** When true, Tab and pasted \\t become spaces (not a hard tab). */
    insertSpaces: true,
    /** Soft-wrap long lines to the viewport width (menu toggle later). */
    wordWrap: true
};

export function indentString()
{
    const n = Math.max(1, editorSettings.tabSize | 0);
    if(editorSettings.insertSpaces) return ' '.repeat(n);
    return '\t';
}

export function expandTabs(text)
{
    const unit = indentString();
    return String(text || '').replace(/\t/g, unit);
}

export function indentStatusLabel()
{
    const n = Math.max(1, editorSettings.tabSize | 0);
    return editorSettings.insertSpaces ? `Spaces: ${n}` : `Tab Size: ${n}`;
}
