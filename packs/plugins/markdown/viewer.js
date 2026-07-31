/**
 * Scrollable markdown preview surface (Helix UI text blocks).
 * Prose uses layoutMode word-wrap; heights come from measureText.
 */
import * as UI from 'Helix/UserInterface';
import * as Fs from '/rom/workspace/fs.js';
import { theme } from '/rom/theme.js';
import { parseMarkdown, inlinesToText } from '/rom/plugins/markdown/parse.js';
import { sourcePathFromPreview } from '/rom/plugins/markdown/paths.js';

const PAD_X = 28;
const PAD_Y = 20;
const GAP = 10;
const WHEEL_AXIS_STEP = 15;
const WHEEL_LINES_PER_STEP = 3;

function frameSize(frame)
{
  if(!frame) return { x: 0, y: 0 };
  if(frame.size && typeof frame.size.x === 'number')
    return { x: Math.max(0, frame.size.x || 0), y: Math.max(0, frame.size.y || 0) };
  if(frame.max && frame.min)
  {
    return {
      x: Math.max(0, (frame.max.x || 0) - (frame.min.x || 0)),
      y: Math.max(0, (frame.max.y || 0) - (frame.min.y || 0))
    };
  }
  return {
    x: Math.max(0, frame.x || frame.width || 0),
    y: Math.max(0, frame.y || frame.height || 0)
  };
}

function headingSize(level)
{
  if(level <= 1) return Math.round(theme.fontSizeUi * 1.85);
  if(level === 2) return Math.round(theme.fontSizeUi * 1.5);
  if(level === 3) return Math.round(theme.fontSizeUi * 1.25);
  return theme.fontSizeUi;
}

/**
 * @param {object} doc
 * @param {{ win: number, workspaceRoot?: string }} ctx
 */
export function createMarkdownPreview(doc, ctx)
{
  const win = ctx.win;
  const sourcePath = doc.sourcePath || sourcePathFromPreview(doc.path);
  let root = null;
  let clip = null;
  let content = null;
  let parent = null;
  let scrollY = 0;
  let viewH = 0;
  let viewW = 0;
  let contentH = 0;
  let blocks = [];
  /** @type {{ id: number, y: number, h: number }[]} */
  let nodes = [];
  let lastLayoutKey = '';
  let error = null;

  const settled = (p) => p.then((v) => v, () => null);

  const maxScroll = () => Math.max(0, contentH - viewH);

  const applyScroll = async () => {
    if(!content) return;
    scrollY = Math.max(0, Math.min(maxScroll(), scrollY));
    await settled(UI.setLayoutPosition(win, content, { x: 0, y: -scrollY }));
  };

  const clearNodes = async () => {
    const ops = [];
    for(const n of nodes)
      ops.push(settled(UI.destroyElement(win, n.id)));
    nodes = [];
    if(ops.length) await Promise.all(ops);
  };

  const colourFor = (block) => {
    if(block.type === 'heading') return theme.syntax.heading || theme.primary;
    if(block.type === 'code') return theme.syntax.string || theme.code;
    if(block.type === 'blockquote') return theme.textDim;
    return theme.text;
  };

  /**
   * Create a word-wrapped text element at (x,y) with fixed width; return measured height.
   */
  const addWrappedText = async ({ string, fontSize, font, colour, x, y, width }) => {
    const w = Math.max(40, width | 0);
    const id = await UI.createElement(win, {
      renderable: {
        type: 'text',
        string: string || ' ',
        size: fontSize,
        font,
        colour,
        layoutMode: 'word-wrap',
        metricsBasis: 'line'
      },
      item: {
        size: { x: w, y: Math.max(fontSize + 4, fontSize * 4) },
        position: { x, y }
      }
    });
    await UI.attach(win, content, id);

    // Drive wrap width via text AABB (contentFill is awkward in raw positioning).
    if(typeof UI.setTextAabb === 'function')
    {
      await settled(UI.setTextAabb(win, id, {
        min: { x: 0, y: 0 },
        max: { x: w, y: 100000 }
      }));
    }
    if(typeof UI.setTextLayoutMode === 'function')
      await settled(UI.setTextLayoutMode(win, id, 'word-wrap'));

    // Tall temporary box so measureText can report wrapped height.
    await settled(UI.setLayoutSize(win, id, { x: w, y: 100000 }));

    let h = fontSize + 6;
    try
    {
      const metrics = await UI.measureText(win, id);
      if(metrics?.size?.y > 0) h = Math.ceil(metrics.size.y);
      else if(metrics?.lineAdvance > 0 && metrics?.lineCount > 0)
        h = Math.ceil(metrics.lineAdvance * metrics.lineCount);
    }
    catch(e) { void e; }

    h = Math.max(fontSize + 4, h);
    await settled(UI.setLayoutSize(win, id, { x: w, y: h }));
    if(typeof UI.setTextAabb === 'function')
    {
      await settled(UI.setTextAabb(win, id, {
        min: { x: 0, y: 0 },
        max: { x: w, y: h }
      }));
    }
    nodes.push({ id, y, h });
    return h;
  };

  const buildBlocks = async () => {
    if(!content) return;
    await clearNodes();
    const innerW = Math.max(80, viewW - PAD_X * 2);
    let y = PAD_Y;

    for(const block of blocks)
    {
      if(block.type === 'hr')
      {
        const h = 16;
        const id = await UI.createElement(win, {
          renderable: { type: 'box', colour: theme.border },
          item: { size: { x: innerW, y: 2 }, position: { x: PAD_X, y: y + 6 } }
        });
        await UI.attach(win, content, id);
        nodes.push({ id, y, h });
        y += h + GAP;
        continue;
      }

      if(block.type === 'code')
      {
        const pad = 10;
        const textW = Math.max(40, innerW - pad * 2);
        const textH = await addWrappedText({
          string: block.text || '',
          fontSize: theme.fontSizeCode,
          font: theme.fontMono,
          colour: colourFor(block),
          x: PAD_X + pad,
          y: y + pad,
          width: textW
        });
        const bgH = textH + pad * 2;
        const textNode = nodes[nodes.length - 1];
        const bg = await UI.createElement(win, {
          renderable: { type: 'box', colour: theme.panelAlt },
          item: { size: { x: innerW, y: bgH }, position: { x: PAD_X, y } }
        });
        await UI.attach(win, content, bg);
        // Draw text above the background panel.
        if(textNode && typeof UI.detach === 'function')
        {
          await settled(UI.detach(win, content, textNode.id));
          await UI.attach(win, content, textNode.id);
        }
        nodes.push({ id: bg, y, h: bgH });
        y += bgH + GAP;
        continue;
      }

      if(block.type === 'list')
      {
        let ly = y;
        let idx = 1;
        for(const item of block.items || [])
        {
          const prefix = block.ordered ? `${idx}. ` : '• ';
          const label = prefix + inlinesToText(item);
          const ih = await addWrappedText({
            string: label,
            fontSize: theme.fontSizeUi,
            font: theme.fontUi,
            colour: theme.text,
            x: PAD_X,
            y: ly,
            width: innerW
          });
          ly += ih + 4;
          idx += 1;
        }
        y = ly + GAP;
        continue;
      }

      const textStr = inlinesToText(block.children || []);
      const size = block.type === 'heading' ? headingSize(block.level || 1) : theme.fontSizeUi;
      const h = await addWrappedText({
        string: textStr || ' ',
        fontSize: size,
        font: theme.fontUi,
        colour: colourFor(block),
        x: PAD_X,
        y,
        width: innerW
      });
      y += h + GAP;
    }

    contentH = y + PAD_Y;
    await settled(UI.setLayoutSize(win, content, {
      x: Math.max(1, viewW),
      y: Math.max(viewH, contentH)
    }));
    await applyScroll();
  };

  const layoutFit = async () => {
    if(!parent || !root || !clip || !content) return false;
    let hostFrame = null;
    try { hostFrame = await UI.getElementFrame(win, parent); }
    catch(e) { return false; }
    const host = frameSize(hostFrame);
    if(host.x < 8 || host.y < 8) return false;

    const key = `${host.x}x${host.y}:${blocks.length}:${error || ''}`;
    const sizeChanged = viewW !== host.x || viewH !== host.y;
    viewW = host.x;
    viewH = host.y;

    await settled(UI.setLayoutSize(win, root, { x: host.x, y: host.y }));
    await settled(UI.setLayoutPosition(win, root, { x: 0, y: 0 }));
    await settled(UI.setLayoutSize(win, clip, { x: host.x, y: host.y }));
    await settled(UI.setLayoutPosition(win, clip, { x: 0, y: 0 }));

    if(key === lastLayoutKey && !sizeChanged) return false;
    lastLayoutKey = key;
    await buildBlocks();
    return true;
  };

  const loadSource = async () => {
    error = null;
    lastLayoutKey = '';
    if(!sourcePath)
    {
      error = 'No source path';
      blocks = [{ type: 'paragraph', children: [{ type: 'text', text: error }] }];
      await layoutFit();
      return;
    }
    try
    {
      const text = await Fs.readText(sourcePath);
      blocks = parseMarkdown(text);
      if(!blocks.length)
        blocks = [{ type: 'paragraph', children: [{ type: 'text', text: '(Empty document)' }] }];
    }
    catch(e)
    {
      error = 'Failed to read ' + sourcePath;
      blocks = [{ type: 'paragraph', children: [{ type: 'text', text: error }] }];
    }
    await layoutFit();
  };

  return {
    async mount(hostParent)
    {
      parent = hostParent;
      root = await UI.createElement(win, {
        renderable: { type: 'box', colour: theme.bg },
        contentPositioning: 'raw',
        clipToBounds: true,
        item: { size: { x: 'auto', y: 'auto' }, flexGrow: 1, flexShrink: 1, minHeight: 0 }
      });
      await UI.attach(win, parent, root);

      clip = await UI.createElement(win, {
        renderable: { type: 'box', colour: theme.bg },
        contentPositioning: 'raw',
        clipToBounds: true,
        item: { size: { x: 'auto', y: 'auto' } }
      });
      await UI.attach(win, root, clip);

      content = await UI.createElement(win, {
        contentPositioning: 'raw',
        item: { size: { x: 'auto', y: 'auto' }, position: { x: 0, y: 0 } }
      });
      await UI.attach(win, clip, content);

      if(typeof UI.setOnMouseScroll === 'function')
      {
        await UI.setOnMouseScroll(win, clip, async (_wp, _lp, delta) => {
          const dy = typeof delta === 'number' ? delta : (delta?.y || 0);
          if(!dy) return;
          const lineDelta = Math.round((dy / WHEEL_AXIS_STEP) * WHEEL_LINES_PER_STEP);
          if(!lineDelta) return;
          const next = Math.max(0, Math.min(maxScroll(), scrollY + lineDelta * (theme.fontSizeUi + 4)));
          if(next === scrollY) return;
          scrollY = next;
          await applyScroll();
        });
      }

      await loadSource();
      if(!(await layoutFit()))
        setTimeout(() => { void layoutFit(); }, 50);
    },

    async unmount()
    {
      await clearNodes();
      if(root != null)
      {
        try { await UI.destroyElement(win, root); }
        catch(e) { void e; }
      }
      root = null;
      clip = null;
      content = null;
      parent = null;
      scrollY = 0;
      lastLayoutKey = '';
    },

    async activate()
    {
      lastLayoutKey = '';
      await layoutFit();
    },

    async deactivate() {},

    async layout()
    {
      return layoutFit();
    },

    async reload()
    {
      scrollY = 0;
      await loadSource();
    }
  };
}
