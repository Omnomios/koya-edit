/**
 * Minimal markdown → block AST (basics only).
 * Supports: headings, paragraphs, fenced code, lists, blockquotes,
 * thematic breaks, and simple inlines (strong/em/code/link/image).
 */

/**
 * @typedef {{ type: string, text?: string, raw?: string, level?: number, ordered?: boolean, items?: object[][], children?: object[] }} MdBlock
 * @typedef {{ type: 'text'|'strong'|'em'|'code'|'link'|'image'|'break', text?: string, href?: string, alt?: string, children?: object[] }} MdInline
 */

function pushParagraph(blocks, lines)
{
  const text = lines.join('\n').trim();
  if(!text) return;
  blocks.push({ type: 'paragraph', children: parseInlines(text) });
}

/**
 * @param {string} source
 * @returns {MdInline[]}
 */
export function parseInlines(source)
{
  const src = String(source || '');
  /** @type {MdInline[]} */
  const out = [];
  let i = 0;
  let buf = '';

  const flush = () => {
    if(!buf) return;
    out.push({ type: 'text', text: buf });
    buf = '';
  };

  while(i < src.length)
  {
    // image ![alt](url)
    if(src[i] === '!' && src[i + 1] === '[')
    {
      const m = src.slice(i).match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/);
      if(m)
      {
        flush();
        out.push({ type: 'image', alt: m[1], href: m[2] });
        i += m[0].length;
        continue;
      }
    }
    // link [text](url)
    if(src[i] === '[')
    {
      const m = src.slice(i).match(/^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/);
      if(m)
      {
        flush();
        out.push({ type: 'link', text: m[1], href: m[2], children: parseInlines(m[1]) });
        i += m[0].length;
        continue;
      }
    }
    // backtick code
    if(src[i] === '`')
    {
      const m = src.slice(i).match(/^`([^`]+)`/);
      if(m)
      {
        flush();
        out.push({ type: 'code', text: m[1] });
        i += m[0].length;
        continue;
      }
    }
    // strong ** or __
    if((src[i] === '*' && src[i + 1] === '*') || (src[i] === '_' && src[i + 1] === '_'))
    {
      const ch = src[i];
      const m = src.slice(i).match(ch === '*' ? /^\*\*([^*]+)\*\*/ : /^__([^_]+)__/);
      if(m)
      {
        flush();
        out.push({ type: 'strong', children: parseInlines(m[1]), text: m[1] });
        i += m[0].length;
        continue;
      }
    }
    // em * or _
    if(src[i] === '*' || src[i] === '_')
    {
      const ch = src[i];
      const re = ch === '*' ? /^\*([^*]+)\*/ : /^_([^_]+)_/;
      const m = src.slice(i).match(re);
      if(m)
      {
        flush();
        out.push({ type: 'em', children: parseInlines(m[1]), text: m[1] });
        i += m[0].length;
        continue;
      }
    }
    // soft break
    if(src[i] === '\n')
    {
      flush();
      out.push({ type: 'break' });
      i += 1;
      continue;
    }
    buf += src[i];
    i += 1;
  }
  flush();
  return out;
}

/**
 * Flatten inlines to plain display text (for single text renderables).
 * @param {MdInline[]} inlines
 */
export function inlinesToText(inlines)
{
  let s = '';
  for(const node of inlines || [])
  {
    if(node.type === 'text') s += node.text || '';
    else if(node.type === 'code') s += node.text || '';
    else if(node.type === 'strong' || node.type === 'em')
      s += node.text || inlinesToText(node.children || []);
    else if(node.type === 'link') s += node.text || inlinesToText(node.children || []);
    else if(node.type === 'image') s += node.alt ? `[image: ${node.alt}]` : '[image]';
    else if(node.type === 'break') s += ' ';
  }
  return s;
}

/**
 * @param {string} source
 * @returns {MdBlock[]}
 */
export function parseMarkdown(source)
{
  const lines = String(source || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  /** @type {MdBlock[]} */
  const blocks = [];
  let i = 0;
  /** @type {string[]} */
  let para = [];

  const flushPara = () => {
    if(para.length) pushParagraph(blocks, para);
    para = [];
  };

  while(i < lines.length)
  {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^(`{3,}|~{3,})(.*)$/);
    if(fence)
    {
      flushPara();
      const mark = fence[1][0];
      const fenceLen = fence[1].length;
      const lang = String(fence[2] || '').trim();
      i += 1;
      const body = [];
      while(i < lines.length)
      {
        const close = lines[i].match(/^(`{3,}|~{3,})\s*$/);
        if(close && close[1][0] === mark && close[1].length >= fenceLen) break;
        body.push(lines[i]);
        i += 1;
      }
      if(i < lines.length) i += 1;
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }

    // thematic break
    if(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line))
    {
      flushPara();
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    // heading
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if(heading)
    {
      flushPara();
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        children: parseInlines(heading[2])
      });
      i += 1;
      continue;
    }

    // blockquote (simple: consecutive > lines → one quote)
    if(/^ {0,3}>/.test(line))
    {
      flushPara();
      const qLines = [];
      while(i < lines.length && /^ {0,3}>/.test(lines[i]))
      {
        qLines.push(lines[i].replace(/^ {0,3}>\s?/, ''));
        i += 1;
      }
      blocks.push({
        type: 'blockquote',
        children: parseInlines(qLines.join('\n').trim())
      });
      continue;
    }

    // list
    const listItem = line.match(/^ {0,3}([*+-]|\d+[.)])\s+(.*)$/);
    if(listItem)
    {
      flushPara();
      const ordered = /^\d/.test(listItem[1]);
      const items = [];
      while(i < lines.length)
      {
        const m = lines[i].match(/^ {0,3}([*+-]|\d+[.)])\s+(.*)$/);
        if(!m) break;
        if(/^\d/.test(m[1]) !== ordered) break;
        items.push(parseInlines(m[2]));
        i += 1;
        // continuation lines (simple indented)
        while(i < lines.length && /^ {2,}\S/.test(lines[i]) && !/^ {0,3}([*+-]|\d+[.)])\s+/.test(lines[i]))
        {
          const cont = lines[i].replace(/^ {2,}/, '');
          const last = items[items.length - 1];
          last.push({ type: 'break' }, ...parseInlines(cont));
          i += 1;
        }
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // blank line
    if(/^\s*$/.test(line))
    {
      flushPara();
      i += 1;
      continue;
    }

    para.push(line);
    i += 1;
  }
  flushPara();
  return blocks;
}
