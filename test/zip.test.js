const test = require('node:test');
const assert = require('node:assert/strict');
const { buildZip, crc32 } = require('../scripts/zip');

// Reads a stored-only ZIP back through its central directory, the way an unzip tool does.
function readZip(zip) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let pos = zip.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i += 1) {
    assert.equal(zip.readUInt32LE(pos), 0x02014b50, 'central directory signature');
    const crc = zip.readUInt32LE(pos + 16);
    const size = zip.readUInt32LE(pos + 20);
    const nameLength = zip.readUInt16LE(pos + 28);
    const localOffset = zip.readUInt32LE(pos + 42);
    const name = zip.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
    assert.equal(zip.readUInt32LE(localOffset), 0x04034b50, 'local header signature');
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26);
    const data = zip.subarray(dataStart, dataStart + size);
    assert.equal(crc32(data), crc, `crc of ${name}`);
    files[name] = data.toString('utf8');
    pos += 46 + nameLength;
  }
  return files;
}

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('a built zip reads back with every file intact', () => {
  const entries = [
    { name: 'package.xml', data: Buffer.from('<Package/>') },
    { name: 'classes/A.cls', data: Buffer.from('public class A {}') },
    { name: 'lwc/x/x.js', data: Buffer.from('export default class X {} // ü') },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ];
  const files = readZip(buildZip(entries));
  assert.deepEqual(files, Object.fromEntries(entries.map((e) => [e.name, e.data.toString('utf8')])));
});
