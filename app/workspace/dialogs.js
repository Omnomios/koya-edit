/**
 * Desktop file dialogs via zenity / kdialog (no native Helix picker yet).
 */
import {joinPath} from '/rom/workspace/fs.js';
import * as Editor from 'Module/editor';

async function tryPicker(cmd, args, cwd)
{
    try
    {
        const result = await Editor.runCommand({cmd, args, cwd: cwd || undefined});
        if((result.code | 0) !== 0) return null;
        const line = String(result.stdout || '').trim().split('\n')[0];
        return line || null;
    } catch(e)
    {
        void e;
        return null;
    }
}

/**
 * @param {{ cwd?: string, suggestedName?: string, title?: string }} [opts]
 * @returns {Promise<string|null>} absolute path, or null if cancelled / unavailable
 */
export async function pickSavePath(opts = {})
{
    const cwd   = typeof opts.cwd === 'string' ? opts.cwd : '';
    const name  = typeof opts.suggestedName === 'string' && opts.suggestedName ? opts.suggestedName : 'Untitled';
    const title = typeof opts.title === 'string' && opts.title ? opts.title : 'Save As';
    const start = cwd ? joinPath(cwd, name) : name;

    const zenity = await tryPicker('zenity', ['--file-selection', '--save', '--confirm-overwrite', `--title=${title}`, `--filename=${start}`], cwd || undefined);
    if(zenity) return zenity;

    const kdialog = await tryPicker('kdialog', ['--title', title, '--getsavefilename', start], cwd || undefined);
    if(kdialog) return kdialog;

    return null;
}
