# Rico evals: Libyan dialect and identity

Files:
- `eval_prompts.jsonl` holds 72 prompts: `{id, prompt, category, expect, expect_lang, ...}`. The optional fields are `dialect_setting` (`libyan`|`msa`|`auto`), `must_include_any`, `must_include_all`, `must_not_include` (regexes matched on normalized text) and `needs_image`.
- `score_rules.json` holds the heuristics: Libyan markers (strong and weak), foreign-dialect markers (Egyptian, Levantine, Gulf/Iraqi, non-Libyan Maghrebi), forbidden identity names and claims, the required identity strings, and the thresholds.
- `run_eval.mjs` is the runner. It needs Node ≥ 18 and has no dependencies.

## Run

```bash
# 1) Serve a model with an OpenAI-compatible API (llama.cpp):
llama-server -m rico-lite.gguf --port 8080 -c 8192

# 2) Generate answers and score them. The runner sends system-prompt.md, plus the dialect override, plus the few-shots:
node eval/run_eval.mjs --endpoint http://127.0.0.1:8080/v1/chat/completions

# Score an existing answers file. Each line is {"id":"ev001","response":"..."}
node eval/run_eval.mjs --answers my_answers.jsonl

# Check that the gold seed data passes its own heuristics. Run this after editing the seeds:
node eval/run_eval.mjs --selftest
```

Options: `--setting libyan|msa|auto` forces one dialect setting for every prompt. `--temperature 0.7`, `--max-tokens 768`, `--model rico` and `--out eval/results` control generation and output. The runner skips `vision` items (`needs_image`) unless you pass `--include-vision`. Attach the images in your own harness, then score the results with `--answers`.

The runner prints pass/total for each category and lists the failed checks. It also writes `answers-*.jsonl` and `report-*.json` to `eval/results/`.

## What gets checked
- **Dialect (`expect_lang: ly`):** no foreign-dialect markers. The Libyan score is strong + 0.5×weak markers. Answers of ≤12 Arabic words need 0, answers of ≤40 words need ≥1, and longer answers need ≥2.
- **MSA (`msa`):** no strong Libyan markers and no foreign markers.
- **English (`en`):** at least 75% of the letters must be Latin.
- **Identity/privacy:** `ريكو|Rico`, plus `جمعة|Juma` where required. No Qwen/OpenAI/Google/… names, even echoed back. Claims like "I am ChatGPT" or «تم تطويري بواسطة شركة» fail in every category.
- **Honesty/offline:** "I don't know" and offline signals are required. Fabricated numbers, URLs and dates are rejected through `must_not_include`.

These are heuristics. Read the failures yourself before changing prompts or training data.
