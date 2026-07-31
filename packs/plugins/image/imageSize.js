/**
 * Probe raster image dimensions from file bytes (no full decode).
 * Supports PNG, JPEG, GIF, BMP, WebP, ICO.
 */

function asBytes(data)
{
  if(!data) return null;
  if(data instanceof Uint8Array) return data;
  if(ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if(data instanceof ArrayBuffer) return new Uint8Array(data);
  if(Array.isArray(data)) return Uint8Array.from(data);
  return null;
}

function u16be(b, i)
{
  return (b[i] << 8) | b[i + 1];
}

function u16le(b, i)
{
  return b[i] | (b[i + 1] << 8);
}

function u32be(b, i)
{
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

function u32le(b, i)
{
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}

function parsePng(b)
{
  if(b.length < 24) return null;
  if(b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
  // IHDR is the first chunk at offset 8; width/height at 16/20.
  return { w: u32be(b, 16), h: u32be(b, 20) };
}

function parseGif(b)
{
  if(b.length < 10) return null;
  if(b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null;
  return { w: u16le(b, 6), h: u16le(b, 8) };
}

function parseBmp(b)
{
  if(b.length < 26) return null;
  if(b[0] !== 0x42 || b[1] !== 0x4d) return null;
  const w = u32le(b, 18);
  // Height may be negative (top-down DIB).
  const hRaw = b[22] | (b[23] << 8) | (b[24] << 16) | (b[25] << 24);
  const h = hRaw < 0 ? -hRaw : hRaw;
  return { w, h };
}

function parseIco(b)
{
  if(b.length < 8) return null;
  if(u16le(b, 0) !== 0 || (u16le(b, 2) !== 1 && u16le(b, 2) !== 2)) return null;
  const count = u16le(b, 4);
  if(count < 1 || b.length < 22) return null;
  let w = b[6];
  let h = b[7];
  if(w === 0) w = 256;
  if(h === 0) h = 256;
  return { w, h };
}

function parseWebp(b)
{
  if(b.length < 30) return null;
  if(b[0] !== 0x52 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x46) return null;
  if(b[8] !== 0x57 || b[9] !== 0x45 || b[10] !== 0x42 || b[11] !== 0x50) return null;
  const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if(tag === 'VP8X' && b.length >= 30)
  {
    const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return { w, h };
  }
  if(tag === 'VP8 ' && b.length >= 30)
  {
    // Lossy bitstream: width/height in frame header after 3-byte frame tag + start code.
    const w = u16le(b, 26) & 0x3fff;
    const h = u16le(b, 28) & 0x3fff;
    return { w, h };
  }
  if(tag === 'VP8L' && b.length >= 25)
  {
    const bits = u32le(b, 21);
    const w = (bits & 0x3fff) + 1;
    const h = ((bits >> 14) & 0x3fff) + 1;
    return { w, h };
  }
  return null;
}

function parseJpeg(b)
{
  if(b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while(i + 9 < b.length)
  {
    if(b[i] !== 0xff)
    {
      i += 1;
      continue;
    }
    while(i < b.length && b[i] === 0xff) i += 1;
    if(i >= b.length) break;
    const marker = b[i++];
    // Standalone markers without length.
    if(marker === 0xd9 || marker === 0xda) break;
    if(marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if(i + 1 >= b.length) break;
    const segLen = u16be(b, i);
    if(segLen < 2 || i + segLen > b.length) break;
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
    const isSof = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if(isSof && segLen >= 7)
    {
      const h = u16be(b, i + 3);
      const w = u16be(b, i + 5);
      return { w, h };
    }
    i += segLen;
  }
  return null;
}

/**
 * @param {Uint8Array|number[]|ArrayBuffer} data
 * @returns {{ w: number, h: number }|null}
 */
export function parseImageSize(data)
{
  const b = asBytes(data);
  if(!b || b.length < 10) return null;
  const parsers = [parsePng, parseJpeg, parseGif, parseBmp, parseWebp, parseIco];
  for(const parse of parsers)
  {
    try
    {
      const dim = parse(b);
      if(dim && dim.w > 0 && dim.h > 0 && dim.w < 100000 && dim.h < 100000)
        return dim;
    }
    catch(e) { void e; }
  }
  return null;
}
