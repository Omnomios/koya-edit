/**
 * Markdown preview pack — source stays the default editor for .md files.
 * Command opens a virtual markdown-preview: path in the center pane.
 */
import { basename } from '/rom/editor/buffer.js';
import { createMarkdownPreview } from '/rom/plugins/markdown/viewer.js';
import {
  isMarkdownPreviewPath,
  isMarkdownSourcePath,
  previewPathFor,
  sourcePathFromPreview
} from '/rom/plugins/markdown/paths.js';

export async function init(host)
{
  const editorReg = host.editors.register({
    id: 'markdown',
    match(path)
    {
      return isMarkdownPreviewPath(path);
    },
    create(doc, ctx)
    {
      return createMarkdownPreview(doc, {
        win: ctx.win != null ? ctx.win : host.win,
        workspaceRoot: host.workspaceRoot
      });
    }
  });

  const cmd = host.commands.register({
    id: 'markdown.openPreview',
    title: 'Markdown: Open Preview',
    category: 'Markdown',
    run: async () => {
      const doc = host.getActiveDoc && host.getActiveDoc();
      let source = null;
      if(doc)
      {
        if(doc.sourcePath && isMarkdownPreviewPath(doc.path))
          source = doc.sourcePath;
        else if(isMarkdownSourcePath(doc.path))
          source = doc.path;
        else if(doc.language === 'markdown' && doc.path && !doc.untitled)
          source = doc.path;
      }
      if(!source)
      {
        try
        {
          const Log = await import('Helix/Log');
          await Log.warn('Markdown preview: open a .md file first');
        }
        catch(e) { void e; }
        return;
      }
      const previewPath = previewPathFor(source);
      const title = 'Preview: ' + basename(source);
      await host.openFile(previewPath, {
        preview: false,
        title,
        sourcePath: source,
        language: 'markdown-preview'
      });
    }
  });

  // Ensure openCustom receives title/sourcePath from openFile opts — core already forwards opts.
  void sourcePathFromPreview;

  return {
    async dispose()
    {
      if(cmd && typeof cmd.unregister === 'function') cmd.unregister();
      if(editorReg && typeof editorReg.unregister === 'function') editorReg.unregister();
    }
  };
}
