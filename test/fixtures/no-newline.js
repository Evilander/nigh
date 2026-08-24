// Fixture: writes a counter with no trailing newline, then exits 0. Proves
// the splitter's flush-on-close path picks up a final unterminated line.
process.stdout.write('10/10');
