# INDIALEGAL.AI — Drafting Skill (v8 Quality-Max Pipeline)

> **Single source of truth for the end-to-end legal drafting workflow.** Every AI agent, prompt rule, fallback, and quality gate is documented here so the system produces senior-counsel-grade output reliably for every user, every time.

**Status**: production, locked architecture (2026-05-15). Do NOT re-litigate model choice, agent ordering, or quality-gate rules without updating this file.

**Primary file**: `services/draftExperiment.js` (~1,900 lines)
**Court agent**: `services/courtIdentifier.js`
**Runner**: `run-v7-offline.js` (offline test) | `server.js` endpoints (production)

---

## 1. Pipeline overview — 22 steps, 3 stages

```
┌─────────────────────────────────────────────────────────────────┐
│ STAGE A — INGEST + EXTRACTION (one-time per case)               │
│  → PDF → Datalab segmentation → 50× DeepSeek per-seg extract    │
│  → DeepSeek gap-fill → DeepSeek rollup (timeline / parties /    │
│    causation / brief) → Gemini File Search indexing             │
│  Output: cases.rollup + case_segments rows + legal_issues       │
├─────────────────────────────────────────────────────────────────┤
│ STAGE B — LEGAL RESEARCH (one-time per case)                    │
│  → Legal Issue Spotter (Reasoner) → 10 issues with both-side    │
│    arguments, precedents, strategic significance                │
│  → IKAPI search per issue, returns verified Supreme Court cases │
│  Output: cases.legal_issues JSONB                               │
├─────────────────────────────────────────────────────────────────┤
│ STAGE C — DRAFTING (per pleading, 20 steps)                     │
│  Detailed in §3 below. 7 quality layers, all DeepSeek.          │
│  Output: court-ready PDF, no internal AI markers.               │
└─────────────────────────────────────────────────────────────────┘
```

## 2. Model selection — DeepSeek-only

| Pass | Model | Why |
|---|---|---|
| Per-segment extraction (×50) | `deepseek-v4-flash` | Structured extraction, well-understood task |
| Gap-fill, rollup, issue spotter | `deepseek-v4-pro` (Reasoner) | Cross-segment synthesis needs reasoning |
| **courtIdentifier** | `deepseek-v4-pro` | Disambiguation (5-judge rotation, OCR confusion) |
| **fill (N-best ×3 + judge)** | Flash ×3 + Flash judge | Diversity at base layer |
| **improvise** | Flash | Light polish — Flash suffices |
| **humanize** (rounds 1 & 2) | Reasoner | Voice critical — biggest quality lever |
| **seniorCritique** | Reasoner | Argument-gap detection |
| **seniorRedTeam** | Reasoner | Robotic-tell detection |
| **hallucinationCheck** | Reasoner | Factual cross-verification |
| **judgmentQuoteFetcher** | Flash ×N (one per case) | Mechanical para selection |
| **completenessCheck** | Reasoner | Structural reasoning |
| **readinessQA** | Reasoner | Hon'ble Mr. Justice lens |

`MODEL_FLASH` / `MODEL_REASONER` constants in `draftExperiment.js` line 21. Override via env: `DEEPSEEK_FLASH_MODEL`, `DEEPSEEK_REASONER_MODEL`.

Reasoner auto-bumps `max_tokens` to 16384 and `timeoutMs` to 480000 (8 min). See `dsRaw()` line 31.

## 3. Stage C — 20-step drafting pipeline (line refs)

| Step | Agent | Purpose | Critical rules |
|---|---|---|---|
| 1 | `courtIdentifier.identifyCourt` | Resolve forum (HC/DC/Tribunal), judge (or null if ≥3 distinct judges rotated), cause-title block | **Throw fatal if no cause_title_block** (line 1488). Never hard-code forum. |
| 2 | `buildCaseDump` | Compact case-data dump (~80K tok): brief, timeline, parties, issues, per-seg facts | Truncate to 280K chars max |
| 3 | `nBestFill` (Layer 4) | 3 candidates @ temp 0, 0.3, 0.5; Flash | Each candidate generates ALL placeholders |
| 3b | `pickBestFill` | Flash judge picks best of 3 with explicit reason | Returns idx + reason — log both |
| 4 | `applyFill` | Deterministic substitution of `{{placeholders}}` | Always inject identifier's `cause_title_block` verbatim, never trust LLM |
| 5 | `verifyCitations` | IKAPI search per cited case (multi-variant: full→tokens→top-2) | ±2 year fuzzing; match if 2 longest distinctive tokens both in title |
| 6 | `timelineGuardSnapshot` (Layer 6) | Regex-extract every date / Rs amount / case-no / statutory section from v6 | Deterministic, no LLM |
| 7 | `judgmentQuoteFetcher` (Layer 3) | For each verified citation: IKAPI `get_case_document` → Flash picks 1-2 most-relevant paragraphs verbatim | **Concurrency 2**; skip if no `matched_tid` |
| 8 | `improviseDraft` | Flash polish: typos, holdings | Preserve every citation (S13), every [VERIFY] (S14) |
| 9 | `humanizeDraft` round-1 (Reasoner) | De-skeletonize, strip [seg] tags, expand authorities into prose blocks with verbatim quotes | (S1-S17) — see §4 below |
| 10 | `seniorCritique` round-1 (Reasoner) | Sr. Counsel agent reads draft; outputs critique_points + must_address_in_round_2 + grade A-D | Grade C/D OR non-empty must_address → trigger round-2 |
| 11 | `humanizeDraft` round-2 (Reasoner) | Re-humanize incorporating critique feedback | Same rules + critique block at top of prompt |
| 12 | `seniorRedTeam` (Reasoner) | Style spot-fixes — robotic tells | Each find ≤250 chars, unique substring required |
| 13 | `timelineGuardDiff` (Layer 6) | Compare timeline snapshot before/after humanize; log dropped facts | TODO v9: auto-restore via spot-fix |
| 14 | `hallucinationCheck` (Reasoner) | Factual cross-verify against source dump; spot-fixes only | (H1-H12) — never touch citations, never inject [UNVERIFIED] |
| 15 | `applySpotFixes` (hallu) | Deterministic find/replace; skip if find absent or appears >1× | Returns applied[] + skipped[] |
| 16 | `readinessQA` (Reasoner) — Layer 7 | Hon'ble Mr. Justice lens; verdict + grade + bench-questions-unanswered + spot_fixes | TODO v9: loop back to humanize if verdict=needs_revision |
| 17 | `applySpotFixes` (readiness) | Apply readiness-QA fixes deterministically | — |
| 18 | `completenessCheck` (Reasoner) | Structural scan + LLM verdict | Up to 2 `repairCompleteness` hops if needs_continuation |
| 19 | `verifyCitations` (re-run on final) | Final citation audit (audit only — never re-inject [VERIFY]) | — |
| 20 | `sanitizeForCourt` | Regex strip: `[VERIFY...]`, `[UNVERIFIED]`, `[seg N pp X-Y]`, `[Page N]` | **Last line of defence — must run before PDF render** |
| → | `renderPdf` | Markdown → HTML → Chrome headless → A4 PDF | See §5 for CSS layout rules |

## 4. Humanizer prompt — the 17 commandments (S1-S17)

The humanizer is the single most quality-critical agent. Rules in `buildHumanizePrompt()` line 964:

- **S1** STRIP every `[seg N pp X-Y]` tag from body.
- **S2** NO Roman-numeral allcaps section headings. Use `### *Brief facts*` (italic h3) sub-heads OR continuous flow.
- **S3** Continuous paragraph numbering 1-N. No restart per section.
- **S4** Case-law treatment: name+cite → **VERBATIM blockquote from judgmentQuoteFetcher** → ratio paraphrase → application to facts. 4-7 sentences each.
- **S5** Sprinkle rhetoric organically: "It is most respectfully submitted", "Reliance is placed on", "Their Lordships", "It is trite law".
- **S6** Vary sentence rhythm — short punchy + long advocacy. No paragraph starts with "The".
- **S7** Preserve every fact (dates / amounts / parties / case-nos).
- **S8** Preserve verbatim Order VI Rule 17 quote inside blockquote.
- **S9** DROP any case with `[VERIFY...]` tag entirely. Court-facing draft must contain only verified citations.
- **S9a** Use ONLY citations from the VERIFIED list. Omit others.
- **S10** Preserve cause-title block (before first `---`) and signature block (after last `---`) CHARACTER-FOR-CHARACTER.
- **S11** DROP textbook "principles emerging are: (i)...(v)..." synthesis paragraphs.
- **S12** Prayer: 3 clauses max. "with costs" not "Award costs in favour of...".
- **S13** DROP inline bracketed citations at sentence-end.
- **S14** DROP inline statute footers like `[Order VI Rule 17 CPC]`.
- **S15** Keep "**MOST RESPECTFULLY SHOWETH:**" on own bold line.
- **S16** Length envelope: 95-140% of input.
- **S17** Reply-to-objections: flowing 2-paragraph response per objection, weave at least one citation per response.

## 5. PDF layout rules (`mdToHtml` + `wrapHtml`)

Court-doc CSS conventions encoded in `wrapHtml()` line 1797:

- **A4** page, **25/30 mm** margins, **Times New Roman 12.5pt**, **line-height 1.55**.
- **Cause-title block** (before first `---`): centred, first line bold + underline + uppercase + 0.4pt letter-spacing.
- **Party rows** (lines containing `....Plaintiff` etc.): flex-row with name left + capacity (italic) right-aligned.
- **Banner lines** (`VERSUS`, `AND`, etc. — fully uppercase short lines): centred, bold, 0.6pt letter-spacing.
- **h1** (main heading): centred, underlined, uppercase, bold.
- **h2** (rare; used only for `PRAYER`): centred uppercase bold.
- **h3** (sentence-case italic sub-heads — the new standard): italic, weight 600, NO underline, NO uppercase.
- **Blockquote** (statute + judgment quotes): light-grey background, left grey-bar, italic.
- **Signature block** (after last `---`): right-aligned, bold, line-height 1.5.

## 6. The 7 quality layers — what each guarantees

| Layer | Guarantee | Failure mode if disabled |
|---|---|---|
| **L1 Reasoner where critical** | Court ID + factual / structural reasoning passes use chain-of-thought model | Flash hallucinates court / misses subtle gaps |
| **L2 Reasoner for humanize** | Voice indistinguishable from senior counsel | Wooden, uniform-rhythm prose |
| **L3 Judgment-quote fetcher** | Verbatim SC paragraphs as blockquotes | Paraphrased holdings — junior-counsel feel |
| **L4 N-best fill** | Diverse base drafts, judge picks best | Locked-in by single Flash temperature-0 first cut |
| **L5 Multi-round critique** | Senior counsel feedback drives round-2 rewrite, adds missing sections | Misses argument gaps (e.g. Order 8 Rule 6A, court fee) |
| **L6 Timeline guard** | Deterministic check that no v6 fact disappears during humanize | Silent fact-drift |
| **L7 Readiness QA** | Hon'ble Mr. Justice lens; bench-Qs surfaced; res-judicata-style fatal flaws caught | Drafts that look polished but get rejected at first hearing |

## 7. Quality gates that prevent disasters

| Gate | Where | Catches |
|---|---|---|
| **Court ID fail-fast** | `runExperiment` line 1488 | Hardcoded "IN THE HIGH COURT" when actually DC |
| **Citation verifier** | Step 5 + 19 | Fake / misquoted SC citations |
| **`[VERIFY]` dropper** | Humanizer (S9) | Unverified cases leaking to court PDF |
| **Sanitizer (regex)** | Step 20, last gate | Any residual internal AI markers no matter what LLM did |
| **Senior critique** | Step 10 | Argument gaps (procedural defects, missed angles) |
| **Timeline guard** | Steps 6 + 13 | Silent fact-drift during humanize |
| **Readiness QA** | Step 16 | Fatal legal flaws + unanswered bench questions |
| **Completeness check** | Step 18 | Truncated output, missing sections |

## 8. How to run

### Production endpoint
```
POST /api/cases/:id/draft-experiment
Body: { templateName: 'written_arguments_o6r17' }
```
Wired in `server.js`. Streams progress via SSE.

### Offline / dev
```bash
cd indialegal-ai
DEEPSEEK_API_KEY=sk-... node run-v7-offline.js 68 /Users/sharadbansal/Downloads
```
Uses `/tmp/seg-68.json` + `/tmp/issues-68.json` instead of DB. Outputs:
- `/tmp/draft-exp-v7.json` — full result payload
- `/tmp/v6-draft.md` — raw fill output (with [seg] tags, internal)
- `/tmp/v7-polished.md` — after improvise
- `/tmp/v7-final.md` — court-ready, sanitized
- PDF at the provided path

### Runtime knobs (`runExperiment` opts)
```js
runExperiment({
  pool, caseId,
  improvise:           true,  // Layer-light Flash polish (L8 step)
  halluCheck:          true,  // factual audit (L_hallu)
  nBest:               true,  // L4: 3-best + judge
  fetchJudgmentQuotes: true,  // L3: IKAPI verbatim quotes
  multiRound:          true,  // L5: critique + round-2 humanize
  timelineGuard:       true,  // L6
  readinessGate:       true   // L7
});
```
Defaults are ALL ON. Disable only for debugging.

## 9. Wall-clock & cost expectations

| Scenario | Wall-clock | Cost (₹) |
|---|---|---|
| One-time extraction + issues per case | ~5 min | ₹35-78 |
| One pleading (all 7 layers on) | ~20-25 min | ₹60-150 |
| One pleading (L4+L5 off, L3 on) | ~10 min | ₹40-80 |

Reasoner CoT consumes the bulk of wall-clock. Acceptable for premium quality.

## 10. Known v8 gaps → v9 roadmap

1. **Readiness QA doesn't loop back to humanize** when verdict=needs_revision. Currently only spot-fixes get applied. **Fix**: wrap steps 9-16 in a loop, max 2 iterations, exit when grade ≥ B or no must_address items.
2. **Timeline guard auto-restore missing** — flags drops but doesn't put them back. **Fix**: deterministic spot-fix builder that re-inserts dropped facts in the most likely paragraph.
3. **Structural scan false-positive on signature** — counsel-name endings without period trigger `truncated_tail`. **Fix**: whitelist endings matching `/Advocate$|Counsel for/`.
4. **Wall-clock 24 min** — parallelize independent passes: red-team + hallu + timeline-diff can run concurrently (Promise.all).
5. **Prayer over-edit** — round-2 humanizer occasionally drops the "any other order" clause. **Fix**: deterministic post-process that ensures 3 standard clauses + AND/OR boilerplate present.

## 11. Adding a new draft type (template)

Pattern: a new template is just a new constant + a new `templateName` value in `runExperiment`.

Steps:
1. Define `<TYPE>_TEMPLATE` constant with `{{placeholders}}` (e.g. `PLAINT_TEMPLATE`).
2. Update `buildFillPrompt` rules with type-specific instructions.
3. Update humanizer `(S2)` sub-head list for that doc type.
4. Update `readinessQA` prompt to know what's expected for that doc type (e.g. for bail app: triple test, parity, antecedents).
5. Add a routing layer in `runExperiment` that picks template + prompt rules by `templateName`.

**Templates to build next** (priority order, per project plan):
- Plaint
- Written Statement
- Rejoinder
- Bail Application (S.439 / S.438)
- 482 Cr.P.C. Quash
- Writ Petition (W.P.(C) / W.P.(Crl))
- Legal Notice
- Reply to Legal Notice
- Affidavit of Evidence
- Synopsis

## 12. Files modified for v8

```
services/draftExperiment.js   — 7 new layers, dsLong, sanitizer (~1900 lines)
services/courtIdentifier.js   — Reasoner model + 8-min timeout
services/legalIssueSpotter.js — Reasoner candidate (still on Flash, upgrade in v9)
run-v7-offline.js             — Offline runner using cached seg-68.json
SKILL.md                      — this file
```

## 13. Invariants (NEVER BREAK)

- 🚫 **Never** put `[VERIFY: ...]` / `[UNVERIFIED]` / `[seg N pp X-Y]` in a court-facing PDF. The sanitizer is the safety net; the humanizer prompt is the primary defence.
- 🚫 **Never** hard-code a forum / court / judge name. Always go through courtIdentifier.
- 🚫 **Never** cite an unverified case. If IKAPI can't find it, drop it from prose; do not annotate.
- 🚫 **Never** trust an LLM with the cause-title block. Use `courtInfo.cause_title_block` verbatim.
- 🚫 **Never** trust an LLM with the verbatim statute quote. Template-locked inside blockquote.
- ✅ **Always** run sanitizer last, no matter what.
- ✅ **Always** verify citations both pre-humanize and post-final.
- ✅ **Always** preserve the cause-title and signature blocks character-for-character.
- ✅ **Always** require ≥1 verified citation in final output; fail loud if zero.

---

**Locked architecture, 2026-05-15.** Edits to pipeline ordering or model selection require updating this file in the same commit.
