import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const expected = process.env.SITE_DATE || easternDate();
const files = [
  join(ROOT, 'MLB_Probabilities', 'index.html'),
  join(ROOT, 'MLB_Probabilities', 'props.html'),
];

let failed = false;
for (const file of files) {
  const html = readFileSync(file, 'utf8');
  if (!html.includes(expected)) {
    console.error(`${file} does not contain expected date ${expected}`);
    failed = true;
  }
  if (html.includes('2026-05-14') && expected !== '2026-05-14') {
    console.error(`${file} still contains stale 2026-05-14 content`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`Fresh asset check passed for ${expected}`);

function easternDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
