// Fixture: writes 64 KiB of seeded pseudo-random bytes to stdout, exit 0.
// Used to prove nigh's stdout passthrough is byte-for-byte, including bytes
// that are not valid UTF-8.
const SIZE = 64 * 1024;
const buf = Buffer.alloc(SIZE);
let seed = 0x2a2a2a2a;
function nextByte() {
  // xorshift32, deterministic across runs.
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed & 0xff;
}
for (let i = 0; i < SIZE; i++) buf[i] = nextByte();
process.stdout.write(buf);
