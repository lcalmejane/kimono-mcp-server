// Convert EnterpriseRAG-Bench questions into a --cases file for bench-embedding.mjs.
//   node scripts/enterprise-rag-cases.mjs --questions questions.jsonl --corpus DIR --out cases.json
//                                         [--sources github,confluence] [--limit N] [--types basic,semantic]
// Dataset: https://github.com/onyx-dot-app/EnterpriseRAG-Bench (code MIT). Release archives are extracted under --corpus;
// every document is named "dsid_<id>__<slug>.txt", and a question's expected_doc_ids are matched on that dsid prefix.
// Questions without ground-truth documents (high_level, info_not_found) and questions that touch a source that is not
// present in --corpus are skipped, so the report only counts questions the corpus can answer.
// The dataset must never be committed or published: it carries a canary GUID asking to stay out of training corpora.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(name); return index < 0 ? undefined : args.splice(index, 2)[1]; };
const questionsFile = flag('--questions'), corpus = flag('--corpus'), out = flag('--out');
const sources = new Set((flag('--sources') ?? 'github,confluence').split(',').filter(Boolean));
const types = flag('--types')?.split(',');
const limitValue = flag('--limit');
const limit = limitValue === undefined ? Infinity : Number(limitValue);
if (!questionsFile || !corpus || !out || !(limit > 0)) {
  console.error('Usage: node scripts/enterprise-rag-cases.mjs --questions FILE --corpus DIR --out FILE [--sources a,b] [--limit N] [--types a,b]');
  process.exit(2);
}

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const byId = new Map();
for await (const file of walk(corpus)) {
  const match = /^(dsid_[0-9a-f]+)__/.exec(path.basename(file));
  if (match) byId.set(match[1], path.relative(corpus, file).split(path.sep).join('/'));
}

const questions = (await readFile(questionsFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const cases = [];
let skippedSource = 0, skippedNoTruth = 0, skippedMissing = 0;
for (const item of questions) {
  if (types && !types.includes(item.question_type)) continue;
  if (!item.expected_doc_ids?.length) { skippedNoTruth++; continue; }
  if (!item.source_types?.length || !item.source_types.every(source => sources.has(source))) { skippedSource++; continue; }
  const expected = item.expected_doc_ids.map(id => byId.get(id)).filter(Boolean);
  if (expected.length !== item.expected_doc_ids.length) { skippedMissing++; continue; }
  cases.push({ id: item.question_id, category: item.question_type, query: item.question, expected });
  if (cases.length >= limit) break;
}

await writeFile(out, `${JSON.stringify(cases, null, 2)}\n`);
const perCategory = {};
for (const item of cases) perCategory[item.category] = (perCategory[item.category] ?? 0) + 1;
console.log(JSON.stringify({ written: cases.length, documentsInCorpus: byId.size, perCategory, skippedSource, skippedNoTruth, skippedMissing }));
