// Fixture: spawns a grandchild node process that just idles, writes the
// grandchild's pid to the path in argv[2], then idles too so it stays alive
// until killed from outside. Used to prove killTree() reaches the whole
// process tree, not just the direct child. Usage: spawns-grandchild.js PIDFILE
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const pidFile = process.argv[2];
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
let terminating = false;

grandchild.once('exit', () => {
  if (terminating) process.exit(0);
});

// On POSIX, let the direct child reap its grandchild before exiting. Without
// this, process.kill(pid, 0) can briefly report a dead-but-unreaped zombie as
// alive on CI runners.
process.once('SIGTERM', () => {
  terminating = true;
  if (grandchild.exitCode !== null || grandchild.signalCode !== null) process.exit(0);
  setTimeout(() => process.exit(1), 2000).unref();
});

fs.writeFileSync(pidFile, String(grandchild.pid));

setInterval(() => {}, 1000); // keep this process (the direct child) alive too
