/**
 * Editor group state — VS Code-style panes with per-group tab lists.
 * Documents stay in the workspace store; groups only track which paths they show.
 */

function makeGroup(seq, tabPaths = [], activePath = null)
{
    const paths = [...tabPaths];
    const active = activePath && paths.includes(activePath) ? activePath : (paths[0] || null);
    return {
        id: `g${seq}`,
        tabPaths: paths,
        activePath: active
    };
}

export function createEditorGroupStore()
{
    let seq = 1;
    /** @type {{ id: string, tabPaths: string[], activePath: string|null }[]} */
    let groups = [makeGroup(seq++)];
    let focusedGroupId = groups[0].id;
    /** Reserved for future vertical / nested splits. */
    let orientation = 'horizontal';

    const get = (id) => groups.find((g) => g.id === id) || null;

    const focused = () => get(focusedGroupId) || groups[0] || null;

    return {
        orientation() {
            return orientation;
        },
        setOrientation(next) {
            if(next === 'horizontal' || next === 'vertical') orientation = next;
            return orientation;
        },
        list() {
            return groups.map((g) => ({id: g.id, tabPaths: [...g.tabPaths], activePath: g.activePath}));
        },
        ids() {
            return groups.map((g) => g.id);
        },
        count() {
            return groups.length;
        },
        get,
        focusedId() {
            return focusedGroupId;
        },
        focused,
        focus(id) {
            if(get(id)) focusedGroupId = id;
            return focusedGroupId;
        },
        /**
         * Ensure `path` is a tab in the group and make it active.
         * Also focuses that group.
         */
        openInGroup(id, path) {
            const g = get(id);
            if(!g || !path) return null;
            if(!g.tabPaths.includes(path)) g.tabPaths.push(path);
            g.activePath = path;
            focusedGroupId = id;
            return g;
        },
        setActiveInGroup(id, path) {
            const g = get(id);
            if(!g || !path || !g.tabPaths.includes(path)) return null;
            g.activePath = path;
            focusedGroupId = id;
            return g;
        },
        removeTab(id, path) {
            const g = get(id);
            if(!g) return null;
            const i = g.tabPaths.indexOf(path);
            if(i < 0) return g;
            g.tabPaths.splice(i, 1);
            if(g.activePath === path)
                g.activePath = g.tabPaths[Math.min(i, g.tabPaths.length - 1)] || null;
            return g;
        },
        /** After Save As / preview replace — rewrite path in every group. */
        replaceTabPath(oldPath, newPath) {
            if(!oldPath || !newPath || oldPath === newPath) return;
            for(const g of groups)
            {
                const i = g.tabPaths.indexOf(oldPath);
                if(i < 0) continue;
                if(g.tabPaths.includes(newPath))
                    g.tabPaths.splice(i, 1);
                else
                    g.tabPaths[i] = newPath;
                if(g.activePath === oldPath) g.activePath = newPath;
            }
        },
        groupsReferencing(path) {
            return groups.filter((g) => g.tabPaths.includes(path)).map((g) => g.id);
        },
        /**
         * Ensure a second group (max 2 in v1).
         * @param {string} [fromId]
         * @param {{ seedActive?: boolean }} [opts] — when seedActive (default true),
         *   copy the source group's active tab into the new group (Split Editor).
         *   Pass false for "open beside" so the new group starts empty.
         * @returns {{ created: boolean, group: object }}
         */
        splitRight(fromId = focusedGroupId, opts = {})
        {
            const seedActive = opts.seedActive !== false;
            if(groups.length >= 2)
            {
                const other = groups.find((g) => g.id !== fromId) || groups[1];
                focusedGroupId = other.id;
                return {created: false, group: other};
            }
            const src = get(fromId) || groups[0];
            const seed = seedActive && src && src.activePath ? [src.activePath] : [];
            const g = makeGroup(seq++, seed, seedActive && src ? src.activePath : null);
            const idx = Math.max(0, groups.findIndex((x) => x.id === src.id));
            groups.splice(idx + 1, 0, g);
            focusedGroupId = g.id;
            return {created: true, group: g};
        },
        /**
         * Close a group; merge its tabs into the neighbor. Cannot close the last group.
         * @returns {object|null} neighbor group
         */
        closeGroup(id) {
            if(groups.length <= 1) return null;
            const idx = groups.findIndex((g) => g.id === id);
            if(idx < 0) return null;
            const closing = groups[idx];
            const neighbor = groups[idx === 0 ? 1 : idx - 1];
            for(const p of closing.tabPaths)
            {
                if(!neighbor.tabPaths.includes(p)) neighbor.tabPaths.push(p);
            }
            if(!neighbor.activePath && closing.activePath)
                neighbor.activePath = closing.activePath;
            else if(closing.activePath && neighbor.tabPaths.includes(closing.activePath))
                neighbor.activePath = closing.activePath;
            groups.splice(idx, 1);
            focusedGroupId = neighbor.id;
            return neighbor;
        },
        cycleTabsInGroup(id, delta) {
            const g = get(id);
            if(!g || g.tabPaths.length === 0) return null;
            const i = Math.max(0, g.tabPaths.indexOf(g.activePath));
            const next = g.tabPaths[(i + delta + g.tabPaths.length * 8) % g.tabPaths.length];
            g.activePath = next;
            focusedGroupId = id;
            return next;
        }
    };
}
