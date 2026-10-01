#!/usr/bin/env node
// Rico eval runner (no dependencies, Node >= 18).
//   Generate + score:  node eval/run_eval.mjs --endpoint http://127.0.0.1:8080/v1/chat/completions
//   Score answers:     node eval/run_eval.mjs --answers answers.jsonl   (lines: {"id","response"})
//   Self-test seeds:   node eval/run_eval.mjs --selftest
// Vision items (needs_image) are skipped unless --include-vision; attach images in your own harness and score with --answers.
// Options: --setting libyan|msa|auto (default per prompt, else libyan) --temperature 0.7 --max-tokens 768 --out eval/results
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PERSONA = path.join(ROOT, 'app/resources/persona');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));

const readJsonl = (p) => fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const rules = JSON.parse(fs.readFileSync(path.join(HERE, 'score_rules.json'), 'utf8'));

// ---------- normalization & matching ----------
const AR = '\\u0621-\\u063A\\u0641-\\u064A\\u066E-\\u06D3'; // Arabic letters only (excludes ، ؟ ؛ and tatweel)
const norm = (s) => s.normalize('NFC')
  .replace(/[ً-ْٰـ]/g, '')
  .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const arWord = (w, prefix) => new RegExp(`(?<![${AR}])(?:${prefix})?${esc(norm(w)).replace(/\s+/g, '\\s*')}(?![${AR}])`, 'u');
const latinWord = (w) => new RegExp(`(?<![A-Za-z0-9])${esc(w.toLowerCase())}(?![A-Za-z0-9])`, 'u');
const compile = (list, prefix) => list.map((w) => [w, /[A-Za-z]/.test(w) ? latinWord(w) : arWord(w, prefix)]);

const POS = 'وال|ال|و|ف|ب|ل';
const NEG = 'و';
const M = {
  strong: compile(rules.libyan_markers.strong, POS),
  weak: compile(rules.libyan_markers.weak, POS),
  strongPat: rules.libyan_markers.strong_patterns.map((p) => [p.name, new RegExp(p.regex, 'u')]),
  weakPat: rules.libyan_markers.weak_patterns.map((p) => [p.name, new RegExp(p.regex, 'u')]),
  foreign: Object.entries(rules.foreign_dialect_markers)
    .filter(([k]) => !['weak', 'chars'].includes(k))
    .flatMap(([k, list]) => compile(list, NEG).map(([w, re]) => [`${k}:${w}`, re])),
  foreignWeak: compile(rules.foreign_dialect_markers.weak, NEG),
  foreignChars: rules.foreign_dialect_markers.chars,
  forbidden: [...compile(rules.forbidden_identity.latin, ''), ...compile(rules.forbidden_identity.arabic, NEG)],
  claims: rules.forbidden_identity_claims.regex.map((r) => new RegExp(r, 'iu')),
};
const hits = (t, list) => list.filter(([, re]) => re.test(t)).map(([w]) => w);
const ratio = (s) => {
  const ar = (s.match(/[؀-ۿ]/g) || []).length;
  const la = (s.match(/[A-Za-z]/g) || []).length;
  return { ar: ar / Math.max(1, ar + la), la: la / Math.max(1, ar + la) };
};
const T = rules.thresholds;

function score(item, response) {
  const t = norm(response || '');
  const checks = [];
  const add = (name, pass, info) => checks.push({ name, pass, info });
  const strong = [...new Set([...hits(t, M.strong), ...M.strongPat.filter(([, re]) => re.test(t)).map(([n]) => n)])];
  const weak = [...hits(t, M.weak), ...M.weakPat.filter(([, re]) => re.test(t)).map(([n]) => n)];
  const foreign = [...hits(t, M.foreign), ...M.foreignChars.filter((c) => t.includes(c))];
  const foreignWeak = hits(t, M.foreignWeak);
  const arWords = (t.match(new RegExp(`[${AR}]+`, 'gu')) || []).length;
  const r = ratio(t);
  const lang = item.expect_lang || 'ly';

  if (!response || !response.trim()) add('non_empty', false, 'empty response');
  if (lang === 'en') add('english_mirroring', r.la >= rules.language.en_min_latin_ratio, `latin=${r.la.toFixed(2)}`);
  else add('arabic_script', r.ar >= rules.language.ar_min_arabic_ratio, `arabic=${r.ar.toFixed(2)}`);
  if (lang === 'ly') {
    const min = arWords <= T.tiny_answer_max_arabic_words ? T.dialect_min_score_tiny : arWords <= T.short_answer_max_arabic_words ? T.dialect_min_score_short : T.dialect_min_score_long;
    const ds = strong.length + 0.5 * weak.length;
    add('libyan_markers', ds >= min, `score=${ds}/${min} strong=[${strong.slice(0, 8).join('، ')}] weak=${weak.length}`);
  }
  if (lang === 'msa') add('msa_no_libyan', strong.length <= T.msa_max_strong_libyan, `strong=[${strong.join('، ')}]`);
  if (lang !== 'en') add('no_foreign_dialect', foreign.length <= T.foreign_max, `[${foreign.join('، ')}]${foreignWeak.length ? ` weak=[${foreignWeak.join('، ')}]` : ''}`);

  const claims = M.claims.filter((re) => re.test(t)).map((re) => re.source.slice(0, 40));
  add('no_identity_claims', claims.length === 0, claims.join(' | '));
  if (rules.forbidden_identity.applies_to_categories.includes(item.category)) {
    const f = hits(t, M.forbidden);
    add('no_forbidden_names', f.length === 0, f.join(', '));
  }
  for (const re of item.must_include_all || []) add(`include:${re.slice(0, 24)}`, new RegExp(re, 'iu').test(t), '');
  if (item.must_include_any?.length) add('include_any', item.must_include_any.some((re) => new RegExp(re, 'iu').test(t)), item.must_include_any.join(' || ').slice(0, 60));
  for (const re of item.must_not_include || []) add(`exclude:${re.slice(0, 24)}`, !new RegExp(re, 'iu').test(t), '');
  if (item.category === 'offline') add('offline_awareness', new RegExp(rules.offline_awareness.regex, 'iu').test(t), '');
  if (item.category === 'honesty' && item.must_include_any === undefined) add('honesty_signal', new RegExp(rules.honesty.regex, 'iu').test(t), '');

  return { pass: checks.every((c) => c.pass), checks, stats: { strong: strong.length, weak: weak.length, foreign: foreign.length, arWords } };
}

function summarize(results) {
  const cats = {};
  for (const r of results) {
    const c = (cats[r.category] ||= { n: 0, pass: 0 });
    c.n++; if (r.pass) c.pass++;
  }
  const total = results.filter((r) => r.pass).length;
  console.log('\ncategory        pass/total');
  for (const [k, v] of Object.entries(cats)) console.log(`${k.padEnd(16)}${v.pass}/${v.n}`);
  console.log(`OVERALL         ${total}/${results.length} (${((100 * total) / results.length).toFixed(1)}%)`);
  for (const r of results.filter((x) => !x.pass).slice(0, 40)) {
    console.log(`\n✗ ${r.id} [${r.category}] ${r.prompt.slice(0, 60)}`);
    for (const c of r.checks.filter((c) => !c.pass)) console.log(`   - ${c.name} ${c.info || ''}`);
  }
  return { total, n: results.length, cats };
}

// ---------- persona composition (mirror of what the app's main process should send) ----------
function buildMessages(prompt, setting) {
  let system = fs.readFileSync(path.join(PERSONA, 'system-prompt.md'), 'utf8').trim();
  const overrides = JSON.parse(fs.readFileSync(path.join(PERSONA, 'dialect-overrides.json'), 'utf8'));
  if (setting && setting !== 'libyan' && overrides[setting]) system += `\n\n${overrides[setting]}`;
  const shots = JSON.parse(fs.readFileSync(path.join(PERSONA, 'fewshots.json'), 'utf8'));
  return [{ role: 'system', content: system }, ...shots.flatMap((s) => [{ role: 'user', content: s.user }, { role: 'assistant', content: s.assistant }]), { role: 'user', content: prompt }];
}

async function generate(endpoint, item) {
  const body = { model: args.model || 'rico', messages: buildMessages(item.prompt, args.setting || item.dialect_setting || 'libyan'), temperature: Number(args.temperature ?? 0.7), max_tokens: Number(args['max-tokens'] ?? 768), stream: false };
  const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const j = await res.json();
  return (j.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// ---------- modes ----------
const outDir = path.resolve(ROOT, args.out || 'eval/results');

if (args.selftest) {
  // Gold seed data must pass its own heuristics.
  const items = [];
  const seed = (f, category) => readJsonl(path.join(ROOT, 'ml/data/seed', f)).forEach((ex, i) => {
    const msgs = ex.messages;
    for (let k = 1; k < msgs.length; k += 2) {
      const u = msgs[k - 1].content;
      const lang = !/[\u0600-\u06FF]/.test(u) ? (/\b(shn|mnu|enta|tkhdem|shkoun|ismk|sna3k)\b/i.test(u) ? 'ly' : 'en') : /^(بالفصحى|أجبني|اجبني)|عرّف نفسك باللغة العربية الفصحى/.test(u) ? 'msa' : 'ly';
      items.push({ id: `${f.split('.')[0]}#${i + 1}.${(k + 1) / 2}`, prompt: u, category, expect_lang: lang, response: msgs[k].content });
    }
  });
  seed('style_examples.jsonl', 'style');
  seed('identity.jsonl', 'identity');
  const results = items.map((it) => ({ ...it, ...score(it, it.response) }));
  const s = summarize(results);
  process.exit(s.total === s.n ? 0 : 1);
}

const allPrompts = readJsonl(path.join(HERE, 'eval_prompts.jsonl'));
let prompts = allPrompts.filter((p) => !p.needs_image || args['include-vision']);
let answers = {};
if (args.answers) {
  for (const a of readJsonl(path.resolve(args.answers))) answers[a.id ?? a.prompt] = a.response;
  prompts = allPrompts.filter((p) => !p.needs_image || answers[p.id] !== undefined || answers[p.prompt] !== undefined);
} else if (args.endpoint) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [i, p] of prompts.entries()) {
    process.stdout.write(`\r generating ${i + 1}/${prompts.length}`);
    try { answers[p.id] = await generate(args.endpoint, p); } catch (e) { answers[p.id] = ''; console.error(`\n${p.id}: ${e.message}`); }
  }
  const f = path.join(outDir, `answers-${Date.now()}.jsonl`);
  fs.writeFileSync(f, prompts.map((p) => JSON.stringify({ id: p.id, prompt: p.prompt, response: answers[p.id] })).join('\n') + '\n');
  console.log(`\nanswers saved: ${path.relative(ROOT, f)}`);
} else {
  console.log('Usage: --endpoint <openai-compatible /v1/chat/completions URL> | --answers <file.jsonl> | --selftest');
  process.exit(2);
}
const results = prompts.map((p) => ({ ...p, response: answers[p.id] ?? answers[p.prompt] ?? '', ...score(p, answers[p.id] ?? answers[p.prompt] ?? '') }));
const s = summarize(results);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `report-${Date.now()}.json`), JSON.stringify({ summary: s, results }, null, 1));
