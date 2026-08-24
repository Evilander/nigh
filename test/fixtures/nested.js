// Fixture: an outer/inner nested progress loop. Per outer step, prints
// "file i/OUTER" then INNER percent lines rewritten with \r, then a newline
// to end the rewritten line. Usage: nested.js OUTER INNER MS
const outer = Number(process.argv[2] ?? 5);
const inner = Number(process.argv[3] ?? 4);
const ms = Number(process.argv[4] ?? 10);

function sleep(t) {
  return new Promise((resolve) => setTimeout(resolve, t));
}

async function main() {
  for (let o = 1; o <= outer; o++) {
    console.log(`file ${o}/${outer}`);
    for (let i = 1; i <= inner; i++) {
      const pct = Math.round((i / inner) * 100);
      process.stdout.write(`\r${pct}%`);
      await sleep(ms);
    }
    process.stdout.write('\n');
  }
}

main();
