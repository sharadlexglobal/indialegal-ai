/**
 * 14-step extraction orchestrator for an uploaded legal case file.
 *
 * Pipeline:
 *
 *   ── Layer A — Foundation ──
 *   1. Datalab marker OCR              → markdown + JSON tree (caller does this; we receive flat md)
 *   2. Datalab segmentation            → identify sub-documents
 *   3. Confidence guard / DS-segment   → reconcile if low confidence or single mega-segment
 *
 *   ── Layer B — Per-segment (parallel for N segments) ──
 *   4. Type → schema routing
 *   5. Datalab type-specific extract   → structured facts per segment
 *   6. DeepSeek gap-fill               → other_atoms per segment
 *   7. Verify + de-dup atoms           → drop hallucinated, merge duplicates
 *
 *   ── Layer C — Cross-segment intelligence ──
 *   8. Party graph normalization
 *   9. Unified timeline
 *   10. Evidence index roll-up         (server-side merge, no LLM)
 *   11. Statute roll-up                (server-side merge)
 *   12. Causation map
 *   13. Consistency auditor
 *   14. Final case brief
 *
 * Emits SSE events on `extract:<caseId>` so the frontend can show
 * step-by-step progress while the pipeline runs.
 */

const datalab = require('./datalab');
const ds = require('./deepseekExtract');
const bus = require('./eventBus');
const { SEGMENT_TYPES_FOR_DATALAB, schemaForType } = require('./typeSchemas');

const MIN_SEG_PAGES_FOR_DS_FALLBACK = 30;
// If any segment is below this confidence, run DeepSeek classification:
const LOW_CONFIDENCE = new Set(['low', 'medium-low']);
// Bound how many segments we extract in parallel. Datalab queues
// over-parallel /extract calls; >4-6 in parallel can lead to a hung
// state without errors. 4 is a sane default.
const PER_SEGMENT_CONCURRENCY = 4;
// Hard ceiling on a single segment's wall-clock time. If a segment
// goes past this, we abandon it with a logged error so other segments
// still finish.
const SEGMENT_TIMEOUT_MS = 5 * 60 * 1000;

// Concurrency-limited Promise.all replacement.
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try { out[i] = await fn(items[i], i); }
      catch (e) { out[i] = { __error: e.message || String(e) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Race a promise against a timeout. Resolves to {timedOut:true} on timeout.
function withTimeout(p, ms, label) {
  return Promise.race([
    p.then(v => ({ value: v })),
    new Promise(resolve =>
      setTimeout(() => resolve({ timedOut: true, label }), ms)
    )
  ]);
}

// ─────────────────────────────────────────────────────────────────
// Main entry: takes the buffer + already-flattened markdown + page_count
// and returns { segments: [...], rollup: {...} }.
// pool: pg pool so we can persist case_segments rows as they're built.
// ─────────────────────────────────────────────────────────────────

async function runExtraction({ pool, caseId, buffer, filename, flatMarkdown, pageCount }) {
  const topic = `extract:${caseId}`;
  const emit = (event, data = {}) => bus.emit(topic, event, data);
  const t0 = Date.now();

  emit('extraction_started', { pageCount });

  // ─── Step 2 — Datalab segmentation (AUTO-DETECT, time-boxed) ──
  // Empty schema = auto-detect per Datalab docs. But this can hang
  // on big scanned PDFs (we've seen 10+ min stuck), so we time-box
  // it to 90 sec and fall through to DeepSeek fallback if it's slow.
  emit('segmenting', {});
  let segments = [];
  const segPromise = (async () => {
    const sub = await datalab.submitSegmentation(buffer, filename, []);
    return await datalab.pollUntilDone(sub.checkUrl);
  })();
  const segRaced = await withTimeout(segPromise, 90_000, 'datalab-seg');
  if (segRaced.timedOut) {
    emit('datalab_segment_timeout', { after_s: 90 });
  } else if (segRaced.value) {
    try {
      segments = datalab.parseSegmentationResult(segRaced.value);
      emit('datalab_segments', { count: segments.length, segments });
    } catch (e) {
      emit('datalab_segment_failed', { error: String(e.message || e).slice(0, 200) });
    }
  }

  // ─── Step 3 — DeepSeek segmentation fallback ──────────────────
  // Fire if (a) datalab returned nothing, OR (b) one big segment for a
  // long PDF (likely missed the splits), OR (c) low-confidence segments.
  const needsFallback =
    !segments.length ||
    (segments.length === 1 && pageCount > MIN_SEG_PAGES_FOR_DS_FALLBACK) ||
    segments.some(s => LOW_CONFIDENCE.has((s.confidence || '').toLowerCase()));

  if (needsFallback) {
    emit('deepseek_segmentation_fallback', { reason: 'low-confidence or unsegmented' });
    try {
      const dsSegs = await ds.deepseekSegmentation({
        markdown: flatMarkdown,
        allowedTypes: SEGMENT_TYPES_FOR_DATALAB,
        pageCount
      });
      if (dsSegs.length > segments.length) {
        // Prefer the richer split; mark source so we can audit later.
        segments = dsSegs.map(s => ({ ...s, _source: 'deepseek' }));
        emit('deepseek_segments_used', { count: segments.length });
      }
    } catch (e) {
      console.warn(`[extract ${caseId}] DS segmentation failed:`, e.message);
    }
  }

  // Last-resort: if STILL no segments, treat the whole PDF as a single
  // unknown segment so the rest of the pipeline still produces something.
  if (!segments.length) {
    segments = [{
      idx: 0, name: 'Whole document', type: 'unknown',
      page_start: 1, page_end: pageCount || 1, confidence: 'low'
    }];
    emit('fallback_single_segment', {});
  }

  // Sanitize segments — clamp page ranges to [1, pageCount] and drop
  // any segment that lives entirely outside the document. DeepSeek's
  // fallback segmentation sometimes hallucinates segments past the end
  // of the file; without clamping, they produce phantom rows with
  // zero facts and noisy gap-fill atoms.
  if (pageCount) {
    const before = segments.length;
    segments = segments
      .map(s => ({
        ...s,
        page_start: Math.max(1, Math.min(s.page_start || 1, pageCount)),
        page_end:   Math.max(1, Math.min(s.page_end || pageCount, pageCount))
      }))
      .filter(s => s.page_end >= s.page_start)
      // Drop segments whose entire span is outside the document
      .filter(s => s.page_start <= pageCount);
    // Re-number after filtering
    segments = segments.map((s, i) => ({ ...s, idx: i }));
    if (segments.length !== before) {
      emit('segments_clamped', {
        before, after: segments.length, page_count: pageCount
      });
    }
  }

  // ─── Layer B — Per-segment (concurrency-limited) ──────────────
  emit('per_segment_extraction', {
    count: segments.length,
    concurrency: PER_SEGMENT_CONCURRENCY
  });

  const segmentRows = await mapLimited(segments, PER_SEGMENT_CONCURRENCY, async (seg, i) => {
    const tSeg0 = Date.now();
    const segText = datalab.markdownForPageRange(
      flatMarkdown, seg.page_start, seg.page_end, pageCount
    );

    emit('segment_started', {
      index: i, name: seg.name, type: seg.type,
      pages: [seg.page_start, seg.page_end],
      text_len: segText.length
    });

    // Wrap the whole segment body in a timeout so a single stuck
    // segment can't hold up the rest. On timeout we emit + return
    // a row with whatever we have (often nothing).
    const work = (async () => {
      // Step 4 — type → schema
      let typeForSchema = seg.type;

      // Step 4.5 — DeepSeek classify if Datalab type is missing/low
      if (!typeForSchema || LOW_CONFIDENCE.has((seg.confidence || '').toLowerCase())) {
        try {
          const cls = await ds.classifySegment({
            segmentText: segText,
            allowedTypes: SEGMENT_TYPES_FOR_DATALAB
          });
          if (cls && cls.type && cls.type !== 'unknown' && cls.confidence !== 'low') {
            typeForSchema = cls.type;
            seg.type = cls.type;
            seg.confidence = cls.confidence;
            seg._source = 'deepseek_classified';
          }
        } catch {}
      }
      const schema = schemaForType(typeForSchema);

      // Step 5 — Datalab type-specific extract for this page range
      let facts = null;
      try {
        const sub = await datalab.submitExtract(
          buffer, filename, schema,
          { page_range: `${seg.page_start}-${seg.page_end}` }
        );
        const res = await datalab.pollUntilDone(sub.checkUrl);
        facts = datalab.parseExtractResult(res);
        emit('segment_extracted', { index: i, fieldsFound: factsFilledCount(facts) });
      } catch (e) {
        console.warn(`[extract ${caseId}] seg ${i} datalab extract failed:`, e.message);
        emit('segment_extract_failed', { index: i, error: String(e.message || e).slice(0, 200) });
      }

      // Step 6 — DeepSeek gap-fill
      let gapAtoms = [];
      try {
        gapAtoms = await ds.gapFillSegment({
          segmentText: segText,
          structuredFacts: facts,
          segmentType: typeForSchema,
          segmentName: seg.name
        });
        emit('segment_gapfilled', { index: i, atomsRaw: gapAtoms.length });
      } catch (e) {
        console.warn(`[extract ${caseId}] seg ${i} gap-fill failed:`, e.message);
        emit('segment_gapfill_failed', { index: i, error: String(e.message || e).slice(0, 200) });
      }

      // Step 7 — verify + de-dup
      const verifiedAtoms = gapAtoms.filter(a => ds.verifyAtomAgainstSource(a, segText));
      const deduped = dedupAtoms(verifiedAtoms, facts);
      emit('segment_atoms_verified', {
        index: i,
        kept: deduped.length,
        dropped_unverified: gapAtoms.length - verifiedAtoms.length,
        dropped_duplicates: verifiedAtoms.length - deduped.length
      });

      return {
        segment_index: i,
        segment_name: seg.name,
        segment_type: seg.type,
        page_start: seg.page_start,
        page_end: seg.page_end,
        confidence: seg.confidence || 'medium',
        facts: facts || {},
        other_atoms: deduped,
        markdown_excerpt: segText.slice(0, 200000),
        classification_source: seg._source || 'datalab'
      };
    })();

    const raced = await withTimeout(work, SEGMENT_TIMEOUT_MS, `segment-${i}`);
    let row;
    if (raced.timedOut) {
      console.warn(`[extract ${caseId}] seg ${i} TIMEOUT after ${SEGMENT_TIMEOUT_MS / 1000}s`);
      emit('segment_timeout', { index: i, after_s: SEGMENT_TIMEOUT_MS / 1000 });
      row = {
        segment_index: i,
        segment_name: seg.name,
        segment_type: seg.type,
        page_start: seg.page_start,
        page_end: seg.page_end,
        confidence: seg.confidence || 'low',
        facts: {},
        other_atoms: [],
        markdown_excerpt: segText.slice(0, 200000),
        classification_source: 'timeout'
      };
    } else {
      row = raced.value;
    }

    // Persist (always — even on timeout/partial, so user sees something)
    try {
      await pool.query(
        `INSERT INTO case_segments
           (case_id, segment_index, segment_name, segment_type,
            page_start, page_end, confidence, facts, other_atoms,
            markdown_excerpt, classification_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)
         ON CONFLICT DO NOTHING`,
        [caseId, row.segment_index, row.segment_name, row.segment_type,
         row.page_start, row.page_end, row.confidence,
         JSON.stringify(row.facts), JSON.stringify(row.other_atoms),
         row.markdown_excerpt, row.classification_source]
      );
    } catch (e) {
      console.warn(`[extract ${caseId}] seg ${i} persist failed:`, e.message);
    }

    emit('segment_done', {
      index: i,
      type: row.segment_type,
      facts_count: factsFilledCount(row.facts),
      atoms_count: row.other_atoms.length,
      elapsed_s: ((Date.now() - tSeg0) / 1000).toFixed(1)
    });
    return row;
  });

  // ─── Layer C — Cross-segment intelligence ─────────────────────
  // Filter out any unhandled-error rows (shouldn't happen given our
  // per-segment try/catch but defensive).
  const validRows = segmentRows.filter(r => r && !r.__error);
  const failedRows = segmentRows.length - validRows.length;
  emit('cross_segment_started', {
    valid: validRows.length,
    failed: failedRows
  });

  const rollup = {};

  // Step 10/11 — server-side roll-ups (no LLM)
  rollup.evidence_index = collectEvidence(validRows);
  rollup.statutes_index = collectStatutes(validRows);
  rollup.parties_raw = collectAllParties(validRows);
  emit('rollup_local_done', {
    evidence: rollup.evidence_index.length,
    statutes: rollup.statutes_index.length
  });

  // Step 8 — party graph
  try {
    rollup.party_graph = await ds.unifyPartyGraph({ segments: validRows });
    emit('party_graph_done', { count: rollup.party_graph.length });
  } catch (e) {
    rollup.party_graph = [];
    console.warn('party graph failed:', e.message);
  }

  // Step 9 — timeline
  try {
    rollup.timeline = await ds.unifyTimeline({ segments: validRows });
    emit('timeline_done', { count: rollup.timeline.length });
  } catch (e) {
    rollup.timeline = [];
    console.warn('timeline failed:', e.message);
  }

  // Step 12 — causation
  try {
    rollup.causation_map = await ds.causationMap({ segments: validRows });
    emit('causation_done', { count: rollup.causation_map.length });
  } catch (e) {
    rollup.causation_map = [];
  }

  // Step 13 — consistency audit
  try {
    rollup.inconsistencies = await ds.consistencyAudit({ segments: validRows });
    emit('audit_done', { count: rollup.inconsistencies.length });
  } catch (e) {
    rollup.inconsistencies = [];
  }

  // Step 14 — case brief
  try {
    const cr = await pool.query(`SELECT title FROM cases WHERE id=$1`, [caseId]);
    rollup.brief = await ds.caseBrief({
      caseTitle: cr.rows[0]?.title || '',
      segments: validRows
    });
    emit('brief_done', { length: (rollup.brief || '').length });
  } catch (e) {
    rollup.brief = '';
  }

  // Persist roll-up on cases
  try {
    await pool.query(
      `UPDATE cases SET rollup=$1::jsonb, extraction_v=2, updated_at=NOW() WHERE id=$2`,
      [JSON.stringify(rollup), caseId]
    );
  } catch (e) {
    console.warn('rollup persist failed:', e.message);
  }

  emit('extraction_done', {
    segments: segmentRows.length,
    valid_segments: validRows.length,
    failed_segments: failedRows,
    elapsed_ms: Date.now() - t0
  });

  return { segments: validRows, rollup };
}

// ─── helpers ─────────────────────────────────────────────────────

function factsFilledCount(facts) {
  if (!facts) return 0;
  let n = 0;
  for (const v of Object.values(facts)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    n++;
  }
  return n;
}

// De-dup gap-fill atoms against the structured facts already extracted.
function dedupAtoms(atoms, facts) {
  if (!atoms?.length) return [];
  // Build a flat set of normalised strings from the structured facts.
  const seen = new Set();
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  function ingest(v) {
    if (!v) return;
    if (Array.isArray(v)) v.forEach(ingest);
    else if (typeof v === 'string' && v.length >= 20) seen.add(norm(v));
    else if (typeof v === 'object') Object.values(v).forEach(ingest);
  }
  ingest(facts);
  const out = [];
  for (const a of atoms) {
    const av = norm(a.atom_value);
    if (!av) continue;
    // Drop if any 50-char chunk overlaps a known fact
    let dupe = false;
    if (av.length >= 50) {
      for (let i = 0; i <= av.length - 50; i += 30) {
        for (const known of seen) {
          if (known.includes(av.slice(i, i + 50))) { dupe = true; break; }
        }
        if (dupe) break;
      }
    } else {
      for (const known of seen) {
        if (known.includes(av) || av.includes(known)) { dupe = true; break; }
      }
    }
    if (!dupe) {
      out.push(a);
      seen.add(av);   // catch dupes between atoms themselves
    }
  }
  return out;
}

function collectEvidence(segments) {
  const out = [];
  for (const s of segments) {
    const ev = s.facts?.documentary_evidence ||
               s.facts?.exhibits_referred ||
               s.facts?.exhibits_marked_through_witness ||
               s.facts?.documents_list ||
               s.facts?.documents_annexed || [];
    for (const e of (ev || [])) {
      out.push({ exhibit: e, segment_index: s.segment_index, segment_name: s.segment_name });
    }
  }
  return out;
}

// Harvest every statute / section / article / rule / clause reference
// across all type-schema variants used in the registry. Each schema
// uses slightly different field names — we union them so nothing
// statutory slips through the rollup.
const STATUTE_FIELDS = [
  // common
  'sections', 'articles_invoked', 'rules_invoked',
  // FIR / charge-sheet specific
  'offences_alleged', 'sections_chargesheeted', 'sections_dropped',
  // petition variants
  'statutory_invocation',
  // judgment / order variants
  'statutes_considered',
  // generic / universal fallback
  'statutes_mentioned',
  // notice
  'statutory_provision_invoked', 'statutory_provision'
];

function collectStatutes(segments) {
  const out = {};
  function add(arr, segIdx) {
    for (const s of (arr || [])) {
      if (!s) continue;
      const key = String(s).trim().toLowerCase().replace(/\s+/g, ' ');
      if (!key) continue;
      if (!out[key]) out[key] = { text: s, segments: [] };
      if (!out[key].segments.includes(segIdx)) out[key].segments.push(segIdx);
    }
  }
  for (const seg of segments) {
    const f = seg.facts || {};
    for (const field of STATUTE_FIELDS) {
      const v = f[field];
      if (!v) continue;
      // Some schemas mark them as strings, some as arrays of strings
      if (Array.isArray(v)) add(v, seg.segment_index);
      else if (typeof v === 'string') add([v], seg.segment_index);
    }
    // Also harvest from other_atoms entries that look like statute refs
    for (const a of (seg.other_atoms || [])) {
      const v = a && a.atom_value;
      if (typeof v !== 'string') continue;
      // Heuristic: contains "Section N" / "Article N" / "Order N Rule N"
      if (/\b(Section|Sec\.?|Article|Art\.?|Order)\s+\d/i.test(v)) {
        add([v.slice(0, 200)], seg.segment_index);
      }
    }
  }
  return Object.values(out).sort((a, b) => b.segments.length - a.segments.length);
}

function collectAllParties(segments) {
  const out = [];
  for (const s of segments) {
    for (const p of (s.facts?.parties || [])) {
      out.push({ name: p, segment_index: s.segment_index });
    }
  }
  return out;
}

module.exports = { runExtraction };
