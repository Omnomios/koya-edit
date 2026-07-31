import * as Editor from 'Module/editor';

export async function readText(path)
{
    return Editor.readText(path);
}

export async function writeText(path, text)
{
    return Editor.writeText(path, text);
}

export async function readDir(path)
{
    return Editor.readDir(path);
}

export async function exists(path)
{
    return Editor.exists(path);
}

export function isIgnoredName(name)
{
    return name === '.' || name === '..' || name === '.git' || name === 'node_modules' || name === '__pycache__' || name === '.cursor' || name === 'build' ||
        name === 'bin' || name === '.cache' || name === 'target' || name === 'dist' || name === 'runtime' || name.endsWith('.so');
}

export function isIgnoredPath(path)
{
    if(typeof path !== 'string' || !path) return true;
    const parts = path.split('/');
    return parts.some((part) => part && isIgnoredName(part));
}

/**
 * Non-recursive watch only. Recursive inotify on large trees (e.g. deepfield)
 * floods events and previously correlated with compositor/GPU faults.
 */
export async function watchWorkspace(root, onChange)
{
    const handle = await Editor.watch(root, {recursive: false});
    let timer    = null;
    let pending  = null;
    handle.on('change', (evt) => {
        try
        {
            if(evt && evt.path && isIgnoredPath(evt.path)) return;
            pending = evt;
            if(timer) return;
            timer = setTimeout(() => {
                timer   = null;
                const e = pending;
                pending = null;
                try
                {
                    onChange(e);
                } catch(error)
                {
                    void error;
                }
            }, 400);
        } catch(error)
        {
            void error;
        }
    });
    return handle;
}

export function joinPath(root, name)
{
    if(!root) return name;
    if(root.endsWith('/')) return root + name;
    return root + '/' + name;
}
