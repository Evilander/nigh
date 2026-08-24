// Fixture: prints "progress i/N\r" (carriage-return-only rewritten line)
// N times, then a final newline. Usage: crlf.js N MS
const n = Number(process.argv[2] ?? 10);
const ms = Number(process.argv[3] ?? 20);

function sleep(t) {
  return new Promise((resolve) => setTimeout(resolve, t));
}

async function main() {
  for (let i = 1; i <= n; i++) {
    process.stdout.write(`progress ${i}/${n}\r`);
    await sleep(ms);
  }
  process.stdout.write('\n');
}

main();
