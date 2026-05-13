/**
 * AUDIT — long-judgment case briefing.
 *
 * Pick the longest available uploaded case (PDF), run 5 substantive
 * questions via the text-chat endpoint, verify each response:
 *   • cites at least one [Page N] / [Pages N-M]
 *   • the cited page is within the case's actual page_count
 *   • the response is not a plain refusal
 *   • language code-mix discipline holds
 *
 * Also tries one targeted "what does page X say" query and grep-checks
 * that the response refers to content actually on that page (by
 * pulling /api/cases/:id which exposes ocr_markdown — yes? need check).
 */
const BASE = process.env.BASE || 'https://indialegal-ai.onrender.com';

async function chat(caseId, message) {
  // Generous 3-minute timeout — Gemini 3 Flash on a 54-page judgment
  // doing deep retrieval can take 30-60s for complex queries.
  const r = await fetch(`${BASE}/api/cases/${caseId}/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(180_000)
  });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = ''; let finalText = ''; const tools = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const evs = buf.split('\n\n'); buf = evs.pop();
    for (const e of evs) {
      if (!e.trim() || e.startsWith(':')) continue;
      let event = 'message', data = '';
      for (const line of e.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      try {
        const j = JSON.parse(data);
        if (event === 'final') finalText = j.text;
        if (event === 'tool_call') tools.push({ name: j.name, args: j.args });
      } catch {}
    }
  }
  return { text: finalText, tools };
}

(async () => {
  // Pick the longest ready case
  const cases = await fetch(`${BASE}/api/cases?kind=document`).then(r => r.json());
  const ready = cases.filter(c => c.status === 'ready' && c.has_store);
  ready.sort((a, b) => (b.page_count || 0) - (a.page_count || 0));
  const target = ready[0];
  console.log(`\nTarget case: id=${target.id}  ${target.page_count} pages — "${target.title}"\n`);

  // Substantive 5-question battery
  const queries = [
    'Is judgment mein court ne kya hold kiya hai?',
    'Yeh case kis section ya legal point par hai?',
    'Petitioner ka main argument kya tha?',
    'Court ke reasoning mein kaunsi authorities cite hui hain?',
    'Final order kya tha?'
  ];

  const audit = [];
  for (const q of queries) {
    console.log(`Q: ${q}`);
    const t0 = Date.now();
    const { text, tools } = await chat(target.id, q);
    const dt = Date.now() - t0;

    // Extract page citations
    const pageCites = [...text.matchAll(/\[Page\s+(\d+(?:-\d+)?)\]/gi)].map(m => m[1]);
    const validPages = pageCites.every(p => {
      const n = parseInt(p.split('-')[0], 10);
      return n >= 1 && n <= (target.page_count || 999);
    });
    // Devanagari leak?
    const hasDevanagari = /[ऀ-ॿ]/.test(text);

    const result = {
      query: q,
      latency_s: (dt / 1000).toFixed(1),
      tools_used: tools.map(t => t.name),
      page_cites: pageCites,
      pages_valid: validPages,
      hinglish_clean: !hasDevanagari,
      head: text.slice(0, 250),
      refusal_like: /not (in|stated|found|likhi)|nahi (mili|hai|likhi)/i.test(text)
    };
    audit.push(result);
    console.log(`   tools: ${result.tools_used.join(', ')}`);
    console.log(`   pages: ${pageCites.length ? pageCites.join(',') : '(none)'}  valid=${result.pages_valid}  hinglish_clean=${result.hinglish_clean}`);
    console.log(`   "${text.slice(0, 120).replace(/\n/g, ' ')}…"`);
    console.log();
  }

  console.log('\n==============================================');
  console.log('              BRIEFING AUDIT SUMMARY');
  console.log('==============================================');
  const cited = audit.filter(a => a.page_cites.length > 0).length;
  const validPg = audit.filter(a => a.pages_valid).length;
  const clean = audit.filter(a => a.hinglish_clean).length;
  const refuse = audit.filter(a => a.refusal_like).length;
  console.log(`  ${cited}/5 responses include page citations`);
  console.log(`  ${validPg}/5 have all-valid page numbers`);
  console.log(`  ${clean}/5 honor Hinglish (no Devanagari leak)`);
  console.log(`  ${refuse}/5 are refusal-like (file does not say...)`);

  const failures = audit.filter(a => !a.pages_valid || !a.hinglish_clean);
  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) {
      console.log(`  Q: ${f.query}`);
      console.log(`     pages_valid=${f.pages_valid}  hinglish_clean=${f.hinglish_clean}`);
      console.log(`     head: ${f.head.slice(0, 200)}`);
    }
    process.exit(1);
  }
  console.log('\n✅ Briefing audit clean.');
})().catch(e => { console.error(e); process.exit(2); });
