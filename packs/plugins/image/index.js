/**
 * Image custom-editor pack — opens raster images in the center pane.
 */
import { createImageViewer } from '/rom/plugins/image/viewer.js';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico)$/i;

export async function init(host)
{
  const reg = host.editors.register({
    id: 'image',
    match(path)
    {
      return IMAGE_EXT.test(String(path || ''));
    },
    create(doc, ctx)
    {
      return createImageViewer(doc, {
        win: ctx.win != null ? ctx.win : host.win,
        workspaceRoot: host.workspaceRoot
      });
    }
  });

  return {
    async dispose()
    {
      if(reg && typeof reg.unregister === 'function') reg.unregister();
    }
  };
}
