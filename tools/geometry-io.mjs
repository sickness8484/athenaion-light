// Binary-compatible, streaming writer for src/core/cache.js's GEO1 format.
// Avoids allocating a second full terrain-sized buffer while baking.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function writeGeometry(file, geometry) {
  const header = { attrs: [], index: null };
  const chunks = [];
  let offset = 0;
  const append = (array) => {
    const padding = (4 - offset % 4) % 4;
    if (padding) { chunks.push(Buffer.alloc(padding)); offset += padding; }
    const start = offset;
    chunks.push(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
    offset += array.byteLength;
    return start;
  };
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    header.attrs.push({
      name, itemSize: attribute.itemSize, normalized: attribute.normalized,
      type: attribute.array.constructor.name, count: attribute.array.length,
      offset: append(attribute.array),
    });
  }
  if (geometry.index) {
    const array = geometry.index.array;
    header.index = { type: array.constructor.name, count: array.length, offset: append(array) };
  }
  const json = Buffer.from(JSON.stringify(header));
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(0x47454f31, 0);
  prefix.writeUInt32BE(json.length, 4);
  const leadingPadding = Buffer.alloc((4 - (8 + json.length) % 4) % 4);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(temporary, 'w');
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for (const chunk of [prefix, json, leadingPadding, ...chunks]) {
      let written = 0;
      while (written < chunk.length) written += fs.writeSync(fd, chunk, written, chunk.length - written);
      hash.update(chunk);
      bytes += chunk.length;
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  return { bytes, sha256: hash.digest('hex') };
}

export async function fileDigest(file) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

export function readGeometryHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const prefix = Buffer.alloc(8);
    if (fs.readSync(fd, prefix, 0, 8, 0) !== 8 || prefix.readUInt32BE(0) !== 0x47454f31) throw new Error(`Invalid geometry: ${file}`);
    const length = prefix.readUInt32BE(4);
    if (length < 2 || length > 1024 * 1024) throw new Error(`Invalid geometry header length: ${file}`);
    const json = Buffer.alloc(length);
    if (fs.readSync(fd, json, 0, length, 8) !== length) throw new Error(`Truncated geometry header: ${file}`);
    const header = JSON.parse(json.toString('utf8'));
    let base = 8 + length; base += (4 - base % 4) % 4;
    const typeBytes = { Float32Array: 4, Uint32Array: 4, Uint16Array: 2, Int16Array: 2, Int8Array: 1, Uint8Array: 1, Int32Array: 4 };
    const size = fs.fstatSync(fd).size;
    for (const attribute of [...header.attrs, ...(header.index ? [header.index] : [])]) {
      const width = typeBytes[attribute.type];
      if (!width || !Number.isSafeInteger(attribute.count) || attribute.count < 0 || !Number.isSafeInteger(attribute.offset) || attribute.offset < 0 || attribute.offset % width || base + attribute.offset + attribute.count * width > size) throw new Error(`Invalid geometry attribute bounds: ${file}`);
    }
    return header;
  } finally { fs.closeSync(fd); }
}
