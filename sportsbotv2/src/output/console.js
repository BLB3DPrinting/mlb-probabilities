// src/output/console.js — Pretty terminal output
const CONFIDENCE_ICONS = { high: '★★★', medium: '★★☆', low: '★☆☆' };

export function printResults(results) {
  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  console.log('MATCHUP                        MODEL   LINE    EDGE    PICK    CONF');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  for (const r of results) {
    const matchup = `${r.away.abbr.padEnd(4)} @ ${r.home.abbr.padEnd(4)}`;
    const model = (r.combined || r.projected).toFixed(2).padStart(5);
    const line = r.line ? r.line.toFixed(1).padStart(5) : '  —  ';
    const edge = r.edge != null ? (r.edge > 0 ? '+' : '') + r.edge.toFixed(2) : '  —  ';
    const pick = r.pick || '—';
    const conf = CONFIDENCE_ICONS[r.confidence] || '☆☆☆';
    let pickColor = '';
    if (pick === 'OVER') pickColor = '\x1b[32m';
    else if (pick === 'UNDER') pickColor = '\x1b[34m';
    else if (pick === 'NO PLAY') pickColor = '\x1b[90m';
    const reset = pickColor ? '\x1b[0m' : '';
    console.log(`${matchup}    ${model}  ${line}  ${edge.padStart(6)}  ${pickColor}${pick.padEnd(8)}${reset}  ${conf}`);
  }
  console.log('═══════════════════════════════════════════════════════════════════════════');
  const warnings = results.flatMap(r => r.warnings || []);
  if (warnings.length > 0) {
    console.log('\n⚠️  WARNINGS:');
    for (const w of warnings) console.log(`  ${w}`);
  }
  console.log('');
}

export function printSummary(results) {
  const picks = results.filter(r => r.pick && r.pick !== 'NO PLAY');
  const overs = picks.filter(r => r.pick === 'OVER');
  const unders = picks.filter(r => r.pick === 'UNDER');
  const noPlay = results.filter(r => r.pick === 'NO PLAY');
  console.log(`\n📊 SUMMARY: ${picks.length} picks (${overs.length} OVER, ${unders.length} UNDER) | ${noPlay.length} no play`);
  console.log('');
}
