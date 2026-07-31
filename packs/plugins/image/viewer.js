/**
 * Center-pane image viewer for a single path.
 * Uses Helix sprite + Assets filesystem texture load (absolute paths).
 *
 * Critical: sprite frame.aabb must cover the full texture in pixels.
 * frame.size / layout size are the on-screen quad. getRenderableSize returns
 * frame geometry — never use it as texture dimensions.
 */
import * as UI from 'Helix/UserInterface';
import * as Assets from 'Koya/Assets';
import { theme } from '/rom/theme.js';
import { parseImageSize } from '/rom/plugins/image/imageSize.js';

const PAD = 24;
const LABEL_H = 22;

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

async function probeImageSize(path)
{
  try
  {
    const bytes = await Assets.getBinary(path);
    return parseImageSize(bytes);
  }
  catch(e)
  {
    return null;
  }
}

/**
 * @param {number} drawW on-screen width
 * @param {number} drawH on-screen height
 * @param {number} texW texture width (UV)
 * @param {number} texH texture height (UV)
 */
function spriteFrameDef(drawW, drawH, texW, texH)
{
  return {
    size: { x: drawW, y: drawH },
    origin: { x: 0, y: 0 },
    aabb: { min: { x: 0, y: 0 }, max: { x: texW, y: texH } },
    colour: [1, 1, 1, 1]
  };
}

/**
 * @param {object} doc
 * @param {{ win: number }} ctx
 */
export function createImageViewer(doc, ctx)
{
  const win = ctx.win;
  const path = doc.path;
  let root = null;
  let sprite = null;
  let label = null;
  let parent = null;
  let texW = 0;
  let texH = 0;
  let error = false;
  let lastLayoutKey = '';
  let spriteKey = '';

  const settled = (p) => p.then((v) => v, () => null);

  const updateLabel = async () => {
    if(!label) return;
    if(error)
    {
      await settled(UI.setTextString(win, label, 'Failed to load image'));
      return;
    }
    const dim = (texW > 0 && texH > 0) ? ` — ${texW}×${texH}` : '';
    await settled(UI.setTextString(win, label, `${doc.title || path}${dim}`));
  };

  const destroySprite = async () => {
    if(sprite == null) return;
    try { await UI.destroyElement(win, sprite); }
    catch(e) { void e; }
    sprite = null;
    spriteKey = '';
  };

  /**
   * Build (or rebuild) the sprite so UV covers the full texture and the
   * geometry matches the fitted on-screen size.
   */
  const ensureSprite = async (drawW, drawH) => {
    if(!root || texW < 1 || texH < 1) return false;
    const dw = Math.max(1, drawW | 0);
    const dh = Math.max(1, drawH | 0);
    const key = `${dw}x${dh}@${texW}x${texH}`;
    if(sprite && spriteKey === key) return true;

    await destroySprite();
    sprite = await UI.createElement(win, {
      renderable: {
        type: 'sprite',
        texture: path,
        frame: 0,
        frames: [spriteFrameDef(dw, dh, texW, texH)]
      },
      item: { size: { x: dw, y: dh } }
    });
    await UI.attach(win, root, sprite);
    const ok = await UI.setTexture(win, sprite, path);
    if(ok === false)
    {
      await destroySprite();
      return false;
    }
    spriteKey = key;
    return true;
  };

  const layoutFit = async () => {
    if(!parent || !root || error || texW < 1 || texH < 1) return false;

    let hostFrame = null;
    try { hostFrame = await UI.getElementFrame(win, parent); }
    catch(e) { return false; }
    const host = frameSize(hostFrame);
    if(host.x < 8 || host.y < 8) return false;

    await settled(UI.setLayoutSize(win, root, { x: host.x, y: host.y }));
    await settled(UI.setLayoutPosition(win, root, { x: 0, y: 0 }));

    const availW = Math.max(1, host.x - PAD * 2);
    const availH = Math.max(1, host.y - PAD * 2 - LABEL_H - 8);
    const scale = Math.min(availW / texW, availH / texH, 1);
    const drawW = Math.max(1, Math.floor(texW * scale));
    const drawH = Math.max(1, Math.floor(texH * scale));
    const spriteX = Math.floor((host.x - drawW) / 2);
    const spriteY = Math.floor(PAD + LABEL_H + 8 + (availH - drawH) / 2);

    const key = `${host.x}x${host.y}:${drawW}x${drawH}:${texW}x${texH}`;
    if(key === lastLayoutKey && sprite) return false;
    lastLayoutKey = key;

    if(!(await ensureSprite(drawW, drawH))) return false;

    await Promise.all([
      settled(UI.setLayoutSize(win, label, { x: Math.max(1, host.x - PAD * 2), y: LABEL_H })),
      settled(UI.setLayoutPosition(win, label, { x: PAD, y: PAD })),
      settled(UI.setLayoutSize(win, sprite, { x: drawW, y: drawH })),
      settled(UI.setLayoutPosition(win, sprite, { x: spriteX, y: spriteY }))
    ]);
    return true;
  };

  const loadTexture = async () => {
    if(!root) return;
    error = false;
    lastLayoutKey = '';
    await destroySprite();
    try
    {
      const dim = await probeImageSize(path);
      if(!dim)
      {
        error = true;
        await updateLabel();
        return;
      }
      texW = dim.w;
      texH = dim.h;
      await updateLabel();
      await layoutFit();
    }
    catch(e)
    {
      error = true;
      await updateLabel();
    }
  };

  return {
    async mount(hostParent)
    {
      parent = hostParent;
      lastLayoutKey = '';

      root = await UI.createElement(win, {
        renderable: { type: 'box', colour: theme.bg },
        contentPositioning: 'raw',
        clipToBounds: true,
        item: { size: { x: 'auto', y: 'auto' }, flexGrow: 1, flexShrink: 1, minHeight: 0 }
      });
      await UI.attach(win, parent, root);

      label = await UI.createElement(win, {
        renderable: {
          type: 'text',
          string: doc.title || path,
          size: theme.fontSizeUi,
          font: theme.fontUi,
          colour: theme.textDim
        },
        item: { size: { x: 'auto', y: LABEL_H } }
      });
      await UI.attach(win, root, label);

      await loadTexture();
      if(!(await layoutFit()))
        setTimeout(() => { void layoutFit(); }, 50);
    },

    async unmount()
    {
      await destroySprite();
      if(root != null)
      {
        try { await UI.destroyElement(win, root); }
        catch(e) { void e; }
      }
      root = null;
      label = null;
      parent = null;
      texW = 0;
      texH = 0;
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
      texW = 0;
      texH = 0;
      lastLayoutKey = '';
      await loadTexture();
    }
  };
}
