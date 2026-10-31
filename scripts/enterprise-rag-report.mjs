// Per-category report for an EnterpriseRAG-Bench run made with bench-embedding.mjs --cases (see enterprise-rag-cases.mjs).
//   node scripts/enterprise-rag-report.mjs --results results.json --cases cases.json [--out report.md]
// Rows are joined to cases by query text, so results produced before categories were tracked can still be broken down.
import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(name); return index < 0 ? undefined : args.splice(index, 2)[1]; };
const resultsFile = flag('--results'), casesFile = flag('--cases'), out = flag('--out');
if (!resultsFile || !casesFile) {
  console.error('Usage: node scripts/enterprise-rag-report.mjs --results results.json --cases cases.json [--out report.md]');
  process.exit(2);
}

const results = JSON.parse(await readFile(resultsFile, 'utf8'));
const cases = JSON.parse(await readFile(casesFile, 'utf8'));
const categoryOf = new Map(cases.map(item => [item.query, item.category ?? 'unknown']));
const categories = [...new Set(cases.map(item => item.category ?? 'unknown'))];
const count = new Map(categories.map(category => [category, cases.filter(item => (item.category ?? 'unknown') === category).length]));

const pct = (value, total) => total ? `${(100 * value / total).toFixed(0)} %` : 'n/a';
const lines = ['# EnterpriseRAG-Bench — détail par catégorie', '',
  `${cases.length} questions · limite ${results.limit} · politique(s) ${results.results.map(item => item.policy).join(', ')}`, ''];

for (const result of results.results) {
  if (result.error) { lines.push(`## ${result.policy}`, '', `Échec : ${result.error.slice(0, 200)}`, ''); continue; }
  lines.push(`## ${result.policy}`, '');
  const header = ['Catégorie', 'N', ...Object.keys(result.modes).flatMap(mode => [`${mode} hit@1`, `${mode} hit@10`, `${mode} MRR`])];
  lines.push(`| ${header.join(' | ')} |`, `|${header.map((_, i) => i < 1 ? '---' : '---:').join('|')}|`);
  const groups = [...categories, 'TOTAL'];
  for (const category of groups) {
    const cells = [category, String(category === 'TOTAL' ? cases.length : count.get(category))];
    for (const mode of Object.keys(result.modes)) {
      const rows = result.modes[mode].rows.filter(row => category === 'TOTAL' || categoryOf.get(row.query) === category);
      const ok = rows.filter(row => row.ok);
      const at1 = ok.filter(row => row.firstRelevantRank === 1).length;
      const at10 = ok.filter(row => row.firstRelevantRank).length;
      const mrr = ok.length ? ok.reduce((sum, row) => sum + (row.firstRelevantRank ? 1 / row.firstRelevantRank : 0), 0) / ok.length : null;
      cells.push(pct(at1, rows.length), pct(at10, rows.length), mrr === null ? 'n/a' : mrr.toFixed(3));
    }
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push('');
}
lines.push('Hit@k = au moins un document attendu parmi les k premiers fichiers. Plusieurs documents peuvent être attendus pour une question (completeness, project_related) : un seul suffit ici, ce qui est plus indulgent que le rappel complet.', '');

const text = lines.join('\n');
if (out) await writeFile(out, text); else console.log(text);
