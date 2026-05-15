/* ───────────────────────────────────────────────────────────────
   indialegal.ai — wizard state machine
   One question per screen. Background processing where possible.
   ─────────────────────────────────────────────────────────────── */

(() => {
  'use strict';

  // ── Global error boundary ────────────────────────────────────
  // Wraps fetch() so every API call has graceful failure handling.
  // Shows a slide-in toast at the bottom-right; auto-dismisses.
  function showToast(message, kind = 'error') {
    let host = document.getElementById('toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast-host';
      host.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:8px;max-width:380px;';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.style.cssText = `
      background:${kind === 'error' ? '#6B1B1B' : '#1F3A5F'};
      color:#FBF7EE;
      padding:14px 18px;
      border-radius:4px;
      box-shadow:0 8px 24px rgba(0,0,0,0.15);
      font-family:Inter,sans-serif;
      font-size:0.92rem;
      line-height:1.5;
      animation:slideIn 220ms cubic-bezier(.2,.7,.2,1);
    `;
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 240ms';
      setTimeout(() => el.remove(), 260);
    }, 6000);
  }

  // Add the slideIn keyframe once.
  if (!document.getElementById('toast-styles')) {
    const st = document.createElement('style');
    st.id = 'toast-styles';
    st.textContent = '@keyframes slideIn{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}';
    document.head.appendChild(st);
  }

  // Wrap window.fetch — every API call now has automatic error UI.
  const realFetch = window.fetch.bind(window);
  window.fetch = async function(input, init) {
    try {
      const r = await realFetch(input, init);
      if (r.status === 429) {
        let msg = 'You are sending requests too quickly. Please wait a moment and try again.';
        try { const j = await r.clone().json(); if (j.error) msg = j.error; } catch {}
        showToast(msg);
      } else if (r.status === 415) {
        let msg = 'Only PDF files are accepted.';
        try { const j = await r.clone().json(); if (j.error) msg = j.error; } catch {}
        showToast(msg);
      } else if (r.status >= 500) {
        showToast('Something went wrong on our side. Please try again in a moment.');
      }
      return r;
    } catch (err) {
      showToast('Could not reach the server. Please check your connection.');
      throw err;
    }
  };

  // Catch any unhandled JS errors / promise rejections — never let the
  // user see a blank screen.
  window.addEventListener('error', (e) => {
    console.error('caught error:', e.message);
    showToast('Something went wrong. Please reload and try again.');
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('unhandled promise rejection:', e.reason);
  });

  // ── State ────────────────────────────────────────────────────
  const S = {
    path:           null,       // 'existing' | 'new'
    cnr:            '',
    caseFetched:    null,       // { title, court, judge, orders, ... }
    caseId:         null,       // indialegal-ai case row id
    uploads:        [],         // [{file, name, caseId, stage, error}]
    researchMode:   null,       // 'system' | 'user'
    userQuestions:  '',
    intent:         null,       // 'research' | 'draft'
    draftType:      '',
    draftParty:     '',
    pipelineSteps:  [],         // for final screen, live updates
  };

  const TOTAL = 8;
  let currentScreen = null;
  let currentStep = 1;

  const $stage    = document.getElementById('stage');
  const $progress = document.getElementById('progress');

  function setProgress(n) {
    currentStep = n;
    $progress.textContent = n ? `Step ${n} of ${TOTAL}` : '';
  }

  function render(screenFn, step) {
    setProgress(step);
    $stage.innerHTML = '';
    const node = screenFn();
    $stage.appendChild(node);
    currentScreen = screenFn;
  }

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function')
        el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v !== false && v !== null && v !== undefined)
        el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  // ── Screen 1: welcome / choose path ───────────────────────────
  // Ultra-minimal: a single soft question + two first-person answers.
  // On desktop, the next-step hint slides up on hover. On mobile (no
  // hover), the hint is always visible at a slightly smaller size.
  function screen1_welcome() {
    return h('section', { class: 'screen' },
      h('h1', { class: 'headline center' }, 'Where to ', h('em', {}, 'begin'), '?'),
      h('div', { class: 'choices choices-minimal' },
        h('button', {
          class: 'choice choice-min',
          onclick: () => { S.path = 'existing'; render(screen2_cnr, 2); }
        },
          h('div', { class: 'choice-min-title' }, 'I have a ', h('em', {}, 'CNR'), '.'),
          h('div', { class: 'choice-hint' },
            'Next, enter the 16-character CNR — keep it handy.')
        ),
        h('button', {
          class: 'choice choice-min',
          onclick: () => { S.path = 'new'; render(screen2b_newcase, 2); }
        },
          h('div', { class: 'choice-min-title' }, 'I ', h('em', {}, 'don\'t'), ' yet.'),
          h('div', { class: 'choice-hint' },
            'Next, upload your case file — one or several PDFs.')
        )
      )
    );
  }

  // ── Screen 2: CNR input ──────────────────────────────────────
  function screen2_cnr() {
    let val = S.cnr || '';
    const input = h('input', {
      class: 'input', type: 'text', placeholder: 'DLNW020008322018',
      maxlength: 16, autofocus: true, spellcheck: 'false', autocapitalize: 'characters'
    });
    input.value = val;

    const btn = h('button', { class: 'btn btn-primary', disabled: val.length !== 16 },
                  'Fetch case', h('span', {}, '→'));
    btn.addEventListener('click', () => {
      S.cnr = input.value.trim().toUpperCase();
      if (S.cnr.length !== 16) return;
      render(screen2_cnrFetching, 2);
    });

    input.addEventListener('input', () => {
      const v = input.value.toUpperCase().replace(/\s/g, '').slice(0, 16);
      input.value = v;
      btn.disabled = v.length !== 16;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.length === 16) btn.click();
    });

    return h('section', { class: 'screen' },
      h('div', { class: 'eyebrow' }, 'Your CNR, please'),
      h('h1', { class: 'headline' }, 'A 16-character ', h('em', {}, 'court code'), '.'),
      h('p', { class: 'subhead tight' },
        'Issued by the eCourts portal at the time of filing. You will find it on your filing ' +
        'receipt or stamped on any earlier order in the matter.'
      ),
      h('div', { class: 'field-block' },
        h('div', { class: 'label' }, 'CNR Number'),
        input
      ),
      h('div', { class: 'actions' },
        btn,
        h('button', { class: 'btn-text', onclick: () => render(screen1_welcome, 1) },
          '← Back')
      ),
      h('div', { class: 'helper' },
        'Tip — the CNR begins with two letters for the State (e.g. DL for Delhi), ' +
        'followed by district and case-type codes.'
      )
    );
  }

  // ── Screen 2-fetching: live progress ─────────────────────────
  function screen2_cnrFetching() {
    const lines = {
      lookup:  h('div', { class: 'status-line active' },
                 h('span', { class: 'glyph' }, '◐'),
                 h('span', {}, 'Looking up CNR on eCourts')),
      meta:    h('div', { class: 'status-line pending' },
                 h('span', { class: 'glyph' }, '○'),
                 h('span', {}, 'Fetching parties, judge and case metadata')),
      orders:  h('div', { class: 'status-line pending' },
                 h('span', { class: 'glyph' }, '○'),
                 h('span', {}, 'Pulling order PDFs')),
      save:    h('div', { class: 'status-line pending' },
                 h('span', { class: 'glyph' }, '○'),
                 h('span', {}, 'Saving to your case file')),
    };

    function markDone(key)    { lines[key].className = 'status-line done';   lines[key].firstChild.textContent = '✓'; }
    function markActive(key)  { lines[key].className = 'status-line active'; lines[key].firstChild.textContent = '◐'; }
    function markFailed(key)  { lines[key].className = 'status-line failed'; lines[key].firstChild.textContent = '×'; }

    // Kick off real fetch in background
    (async () => {
      try {
        markActive('lookup');
        const r = await fetch('/api/cnr-fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cnr: S.cnr })
        });
        markDone('lookup');

        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${r.status}`);
        }
        markActive('meta');
        const data = await r.json();
        markDone('meta');

        markActive('orders');
        // Server returns orders count directly
        markDone('orders');

        markActive('save');
        S.caseFetched = data;
        S.caseId = data.caseId || null;
        markDone('save');

        setTimeout(() => render(screen2_cnrConfirm, 2), 500);
      } catch (err) {
        markFailed('lookup');
        const errLine = h('div', { class: 'status-line failed' },
          h('span', { class: 'glyph' }, '!'),
          h('span', {}, 'Could not fetch this CNR: ' + (err.message || 'unknown error'))
        );
        document.getElementById('status-block').appendChild(errLine);
        document.getElementById('retry-actions').classList.remove('hidden');
      }
    })();

    return h('section', { class: 'screen' },
      h('div', { class: 'eyebrow' }, 'Working'),
      h('h1', { class: 'headline' }, 'Pulling your case ', h('em', {}, 'from eCourts'), '.'),
      h('p', { class: 'subhead tight' },
        'This usually takes 30 to 90 seconds. eCourts can be slow at peak hours — ' +
        'we will keep retrying captchas until we get through.'
      ),
      h('div', { class: 'status-block', id: 'status-block' },
        lines.lookup, lines.meta, lines.orders, lines.save
      ),
      h('div', { class: 'actions hidden', id: 'retry-actions' },
        h('button', { class: 'btn btn-ghost', onclick: () => render(screen2_cnr, 2) },
          '← Try a different CNR')
      )
    );
  }

  // ── Screen 2-confirm: fetched case summary ───────────────────
  // Renders the FULL case payload from bail-watch — parties, orders
  // with PDF links, hearing history, case status, registration dates,
  // IA list, etc. — not just the 6-field summary we used to show.
  function screen2_cnrConfirm() {
    const c = S.caseFetched || {};
    const raw = c.raw || {};

    // Normalise where things live in bail-watch's shape (it varies)
    const petitioner   = raw.petitioner || raw.parties?.petitioner || raw.partyDetails?.petitioner || '';
    const respondent   = raw.respondent || raw.parties?.respondent || raw.partyDetails?.respondent || '';
    const orders       = Array.isArray(raw.orders) ? raw.orders : [];
    const hearings     = Array.isArray(raw.hearings) ? raw.hearings
                       : Array.isArray(raw.history) ? raw.history : [];
    const ias          = Array.isArray(raw.ias) ? raw.ias
                       : Array.isArray(raw.interlocutoryApplications) ? raw.interlocutoryApplications : [];
    const status       = raw.case_status || raw.status || raw.disposition || '';
    const filingDate   = raw.filing_date || raw.filingDate || '';
    const registration = raw.registration_date || raw.registrationDate || '';
    const nextHearing  = raw.next_hearing_date || raw.nextHearingDate || raw.nextHearing || '';
    const caseType     = raw.case_type || raw.caseType || raw.type || '';
    const stageHistory = Array.isArray(raw.stages) ? raw.stages : [];

    function row(label, value) {
      if (!value && value !== 0) return null;
      const v = typeof value === 'string' ? value : String(value);
      return [
        h('dt', {}, label),
        h('dd', {}, v)
      ];
    }

    // Parties block — petitioner + respondent with full text if available.
    const partiesBlock = (petitioner || respondent)
      ? h('section', { class: 'case-section' },
          h('h3', { class: 'case-section-title' }, 'Parties'),
          h('div', { class: 'party-grid' },
            petitioner ? h('div', { class: 'party-cell' },
              h('div', { class: 'party-role' }, 'Petitioner / Plaintiff'),
              h('div', { class: 'party-name' }, String(petitioner).replace(/\n+/g, ' / '))
            ) : null,
            respondent ? h('div', { class: 'party-cell' },
              h('div', { class: 'party-role' }, 'Respondent / Defendant'),
              h('div', { class: 'party-name' }, String(respondent).replace(/\n+/g, ' / '))
            ) : null
          )
        )
      : null;

    // Orders list — sortable, each clickable to open the PDF
    function orderRow(o, i) {
      const date  = o.date || o.orderDate || o.dated || '';
      const desc  = o.description || o.purpose || o.type || o.title || `Order ${i + 1}`;
      const url   = o.url || o.pdf || o.pdfUrl || o.file || '';
      const judge = o.judge || o.signedBy || '';
      const inner = [
        h('div', { class: 'order-date' }, date),
        h('div', { class: 'order-body' },
          h('div', { class: 'order-desc' }, desc),
          judge ? h('div', { class: 'order-judge' }, judge) : null
        )
      ];
      return url
        ? h('a', { class: 'order-row', href: url, target: '_blank', rel: 'noopener' }, ...inner,
            h('span', { class: 'order-arrow' }, '↗'))
        : h('div', { class: 'order-row order-row-static' }, ...inner);
    }

    const ordersBlock = orders.length ? h('section', { class: 'case-section' },
      h('h3', { class: 'case-section-title' }, `Orders on record (${orders.length})`),
      h('div', { class: 'order-list' },
        ...orders.slice(0, 20).map(orderRow),
        orders.length > 20
          ? h('div', { class: 'order-more muted' }, `+ ${orders.length - 20} more — visible in the case dossier after extraction`)
          : null
      )
    ) : null;

    // Hearings — last 8
    const hearingsBlock = hearings.length ? h('section', { class: 'case-section' },
      h('h3', { class: 'case-section-title' }, `Hearing history (${hearings.length})`),
      h('div', { class: 'order-list' },
        ...hearings.slice(0, 8).map((hg, i) => {
          const date    = hg.date || hg.hearingDate || hg.listed_on || '';
          const purpose = hg.purpose || hg.next_purpose || hg.stage || hg.business || '';
          const judge   = hg.judge || hg.coram || '';
          return h('div', { class: 'order-row order-row-static' },
            h('div', { class: 'order-date' }, date),
            h('div', { class: 'order-body' },
              h('div', { class: 'order-desc' }, purpose || '—'),
              judge ? h('div', { class: 'order-judge' }, judge) : null
            )
          );
        }),
        hearings.length > 8
          ? h('div', { class: 'order-more muted' }, `+ ${hearings.length - 8} earlier hearings`)
          : null
      )
    ) : null;

    // IA list (if any)
    const iaBlock = ias.length ? h('section', { class: 'case-section' },
      h('h3', { class: 'case-section-title' }, `Interlocutory applications (${ias.length})`),
      h('ul', { class: 'simple-list' },
        ...ias.slice(0, 12).map(ia => h('li', {},
          (ia.number || ia.no || '') + (ia.subject ? ' — ' + ia.subject : (ia.purpose ? ' — ' + ia.purpose : ''))
        ))
      )
    ) : null;

    return h('section', { class: 'screen wide' },
      h('div', { class: 'eyebrow' }, 'Found it'),
      h('h1', { class: 'headline' }, 'Does this look ', h('em', {}, 'right'), '?'),
      h('p', { class: 'subhead tight' },
        'Cross-check the details below. If anything looks off, go back and try the CNR again.'),

      h('div', { class: 'case-card' },
        h('div', { class: 'case-title' }, c.title || 'Untitled matter'),

        // Top-level metadata grid — always shown
        h('dl', { class: 'case-meta' },
          ...[
            row('CNR',            S.cnr),
            row('Case No.',       c.caseNumber),
            row('Case type',      caseType),
            row('Court',          c.court),
            row('Judge',          c.judge),
            row('Filed on',       filingDate),
            row('Registered',     registration),
            row('Status',         status),
            row('Last hearing',   c.lastHearing),
            row('Next hearing',   nextHearing),
          ].filter(Boolean).flat()
        ),

        partiesBlock,
        ordersBlock,
        hearingsBlock,
        iaBlock
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary',
                      onclick: () => render(screen2c_processing, 3) },
          'Continue', h('span', {}, '→')),
        h('button', { class: 'btn-text', onclick: () => render(screen2_cnr, 2) },
          'Try a different CNR')
      )
    );
  }

  // ── Screen 2.5: process orders from CNR ──────────────────────
  // Kicks off /api/case/from-cnr/:cnr/process, then opens an SSE
  // stream and renders progress + live timeline. When done, user
  // continues to screen 3 (upload additional PDFs).
  function screen2c_processing() {
    const cnr = S.cnr;
    const c = S.caseFetched || {};
    const slug = 'generic';

    // UI scaffold
    const statusLine = h('div', { class: 'status-line active' },
      h('span', { class: 'glyph' }, '◐'),
      h('span', { id: 'ocr-status-text' }, 'Starting…')
    );
    const counter = h('div', { class: 'process-counter muted' },
      h('span', { id: 'orders-counter' }, '0 of 0'),
      ' orders processed'
    );
    const timelineEl = h('div', { class: 'timeline', id: 'timeline-list' });
    const continueBtn = h('button', {
      class: 'btn btn-primary', disabled: true, id: 'continue-after-process',
      onclick: () => render(screen3_upload, 4)
    }, 'Continue', h('span', {}, '→'));

    // Local state for live updates
    const state = { orders: [], events: [], total: 0, ocrDone: 0 };

    function renderTimeline() {
      timelineEl.innerHTML = '';
      if (!state.events.length) {
        timelineEl.appendChild(h('div', { class: 'timeline-empty' },
          h('em', {}, 'Building timeline as we read each order…')));
        return;
      }
      for (const ev of state.events) {
        const row = h('div', { class: 'timeline-row' },
          h('div', { class: 'timeline-date' }, ev.date || '—'),
          h('div', { class: 'timeline-body' },
            h('div', { class: 'timeline-what' }, ev.what),
            ev.source ? h('div', { class: 'timeline-source' }, ev.source)
                      : ev.order_index ? h('div', { class: 'timeline-source' },
                          'Order ' + ev.order_index) : null
          )
        );
        timelineEl.appendChild(row);
      }
    }
    renderTimeline();

    // Kick off the backend processing
    let caseId = null;
    let eventSource = null;

    async function start() {
      try {
        const r = await fetch(`/api/case/from-cnr/${encodeURIComponent(cnr)}/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, title: c.title || '' })
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        caseId = j.caseId;
        S.caseId = caseId;
        openStream(caseId);
      } catch (e) {
        const t = document.getElementById('ocr-status-text');
        if (t) t.textContent = 'Failed to start: ' + e.message;
        statusLine.className = 'status-line failed';
        statusLine.firstChild.textContent = '×';
      }
    }

    function setStatus(text, kind = 'active') {
      const t = document.getElementById('ocr-status-text');
      if (t) t.textContent = text;
      statusLine.className = 'status-line ' + kind;
      const g = statusLine.firstChild;
      if (g) g.textContent = kind === 'done' ? '✓' : kind === 'failed' ? '×' : '◐';
    }

    function setCounter(done, total) {
      const el = document.getElementById('orders-counter');
      if (el) el.textContent = `${done} of ${total}`;
    }

    function openStream(id) {
      eventSource = new EventSource(`/api/case/${id}/cnr-process/stream`);

      eventSource.addEventListener('started',         () => setStatus('Pulling your case from storage…'));
      eventSource.addEventListener('fetch_case_json', () => setStatus('Reading the case file…'));
      eventSource.addEventListener('fetch_manifest',  () => setStatus('Listing every order on record…'));
      eventSource.addEventListener('orders_listed',   (e) => {
        const d = JSON.parse(e.data);
        state.total = d.count;
        state.orders = d.orders;
        setStatus(`Found ${d.count} order${d.count === 1 ? '' : 's'} — reading them now`);
        setCounter(0, d.count);
        if (!d.count) {
          setStatus('No orders to read', 'done');
        }
      });
      eventSource.addEventListener('fetching_pdfs',   (e) => {
        const d = JSON.parse(e.data);
        setStatus(`Downloading ${d.count} order PDFs…`);
      });
      eventSource.addEventListener('fetch_progress',  (e) => {
        const d = JSON.parse(e.data);
        setStatus(`Downloading PDFs… ${d.done} of ${d.total}`);
      });
      eventSource.addEventListener('ocr_starting',    (e) => {
        const d = JSON.parse(e.data);
        setStatus(`Reading ${d.count} orders with OCR…`);
      });
      eventSource.addEventListener('ocr_progress',    (e) => {
        const d = JSON.parse(e.data);
        state.ocrDone = d.completed;
        setStatus(`Reading orders… ${d.completed} of ${d.total}`);
        setCounter(d.completed, d.total);
      });
      eventSource.addEventListener('ocr_done',        (e) => {
        const d = JSON.parse(e.data);
        // single-order completion — no immediate UI change beyond counter
      });
      eventSource.addEventListener('ocr_failed',      (e) => {
        const d = JSON.parse(e.data);
        console.warn('OCR failed for order', d.order_index, d.error);
      });
      eventSource.addEventListener('timeline_progress', (e) => {
        const d = JSON.parse(e.data);
        // intermediate per-order progress — wait for timeline_complete
      });
      eventSource.addEventListener('timeline_complete', (e) => {
        const d = JSON.parse(e.data);
        state.events = d.events || [];
        renderTimeline();
        setStatus(`Timeline ready · ${state.events.length} event${state.events.length === 1 ? '' : 's'}`, 'done');
        const btn = document.getElementById('continue-after-process');
        if (btn) btn.disabled = false;
      });
      eventSource.addEventListener('done',            () => {
        eventSource.close();
        const btn = document.getElementById('continue-after-process');
        if (btn) btn.disabled = false;
      });
      eventSource.addEventListener('error',           (e) => {
        try {
          const d = JSON.parse(e.data || '{}');
          if (d.error) setStatus('Error: ' + d.error, 'failed');
        } catch {}
      });
      eventSource.onerror = () => {
        // EventSource auto-reconnects; we just log
        console.warn('SSE error');
      };
    }

    // Begin
    setTimeout(start, 50);

    return h('section', { class: 'screen wide' },
      h('div', { class: 'eyebrow' }, 'Reading the file'),
      h('h1', { class: 'headline' }, 'Reading every ', h('em', {}, 'order'), '.'),
      h('p', { class: 'subhead tight' },
        'We are reading each order on record and stitching together a date-by-date account ' +
        'of what has happened in this matter. You can keep watching, or simply continue — ' +
        'the rest runs in the background.'),

      h('div', { class: 'status-block' },
        statusLine,
        counter
      ),

      h('h3', { class: 'case-section-title', style: 'margin-top: 28pt;' }, 'Case timeline so far'),
      timelineEl,

      h('div', { class: 'actions' },
        continueBtn,
        h('button', { class: 'btn-text', onclick: () => render(screen2_cnrConfirm, 2) },
          '← Back to case details')
      )
    );
  }

  // ── Screen 2b: new case confirm ──────────────────────────────
  function screen2b_newcase() {
    return h('section', { class: 'screen' },
      h('div', { class: 'eyebrow' }, 'A fresh matter'),
      h('h1', { class: 'headline' }, 'No CNR ', h('em', {}, 'needed'), '.'),
      h('p', { class: 'subhead' },
        'We will build the entire case file from the documents you upload in the next step. ' +
        'You can always add a CNR later if and when one is generated.'
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary',
                      onclick: () => render(screen3_upload, 3) },
          'Continue', h('span', {}, '→')),
        h('button', { class: 'btn-text', onclick: () => render(screen1_welcome, 1) },
          '← Back')
      )
    );
  }

  // ── Screen 3: upload PDFs (background processing) ────────────
  // Single-file ceiling: 199 MB (downstream document-processor cap).
  // Users with bigger PDFs are asked to split into 199 MB sets and
  // upload multiple — the wizard merges everything into one case.
  const PER_FILE_LIMIT = 199 * 1024 * 1024;
  const PER_FILE_LIMIT_TEXT = '199 MB';

  function screen3_upload() {
    const fileInput = h('input', { type: 'file', accept: 'application/pdf', multiple: 'multiple' });
    const listEl = h('div', { class: 'upload-list', id: 'upload-list' });

    function renderList() {
      listEl.innerHTML = '';
      for (const u of S.uploads) {
        const cls = u.stage === 'done'      ? 'done'
                  : u.stage === 'failed'    ? 'failed'
                  : u.stage === 'too_large' ? 'failed'
                  : 'active';
        const label = u.stage === 'queued'      ? 'Queued'
                    : u.stage === 'uploading'   ? 'Uploading'
                    : u.stage === 'extracting'  ? 'Extracting'
                    : u.stage === 'done'        ? 'Ready'
                    : u.stage === 'too_large'   ? 'Too large'
                    : u.stage === 'failed'      ? 'Failed'
                    : '—';
        const item = h('div', { class: 'upload-item ' + cls },
          h('span', { class: 'name' }, u.name),
          h('span', { class: 'stage-label' }, label)
        );
        if (u.error) {
          item.appendChild(h('div', { class: 'upload-error' }, u.error));
        }
        listEl.appendChild(item);
      }
      const continueBtn = document.getElementById('continue-btn');
      // Continue only if at least one accepted (non-too_large, non-failed) file.
      const okFiles = S.uploads.filter(u => u.stage !== 'too_large' && u.stage !== 'failed').length;
      if (continueBtn) continueBtn.disabled = okFiles === 0;
    }

    function handleFiles(fileList) {
      for (const file of fileList) {
        if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) continue;
        if (file.size > PER_FILE_LIMIT) {
          // Client-side reject — keep the entry on screen with a clear,
          // actionable error so the user knows to split.
          S.uploads.push({
            file: null, name: file.name,
            stage: 'too_large', caseId: null,
            error: `Too large (${(file.size / 1024 / 1024).toFixed(0)} MB). Split into ${PER_FILE_LIMIT_TEXT} sets and upload again.`
          });
          renderList();
          continue;
        }
        const u = { file, name: file.name, stage: 'queued', caseId: null, error: null };
        S.uploads.push(u);
        renderList();
        uploadInBackground(u);
      }
    }

    async function uploadInBackground(u) {
      try {
        u.stage = 'uploading'; renderList();
        const fd = new FormData();
        fd.append('pdf', u.file, u.name);
        fd.append('title', u.name.replace(/\.pdf$/i, ''));
        const r = await fetch('/api/cases', { method: 'POST', body: fd });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        u.caseId = j.id || j.caseId;
        u.stage = 'extracting'; renderList();
        // Server kicks off extraction async; we just mark "done" once it's started
        setTimeout(() => { u.stage = 'done'; renderList(); }, 1500);
      } catch (err) {
        u.stage = 'failed';
        u.error = err.message;
        renderList();
      }
    }

    const dropzone = h('label', { class: 'dropzone' },
      h('div', { class: 'dropzone-icon' }, '↑'),
      h('div', { class: 'dropzone-title' }, 'Drop PDFs here, or click to choose'),
      h('div', { class: 'dropzone-sub' },
        'PDFs only · multiple files supported · up to ' + PER_FILE_LIMIT_TEXT + ' per file'),
      fileInput
    );
    fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      handleFiles(e.dataTransfer.files);
    });

    return h('section', { class: 'screen' },
      h('div', { class: 'eyebrow' }, 'Your documents'),
      h('h1', { class: 'headline' }, 'Now, the ', h('em', {}, 'case file'), '.'),
      h('p', { class: 'subhead tight' },
        'Upload one or several PDFs — pleadings, orders, agreements, anything relevant. ' +
        'Processing starts the moment you drop a file. You can carry on with the next step ' +
        'while extraction runs in the background.'
      ),
      dropzone,
      h('p', { class: 'helper' },
        'Each PDF should be ', h('strong', {}, PER_FILE_LIMIT_TEXT + ' or smaller'), '. ' +
        'You may upload as many separate PDFs as you like. ' +
        'If your file is larger, please split it into ' + PER_FILE_LIMIT_TEXT + ' sets ' +
        'and upload each set as a separate PDF — the system will treat them as one matter.'
      ),
      listEl,
      h('div', { class: 'actions' },
        h('button', { id: 'continue-btn', class: 'btn btn-primary',
                      disabled: true,
                      onclick: () => render(screen4_research, 4) },
          'Continue', h('span', {}, '→'))
      )
    );
  }

  // ── Screen 4: research approach ──────────────────────────────
  function screen4_research() {
    return h('section', { class: 'screen' },
      h('div', { class: 'eyebrow' }, 'Research'),
      h('h1', { class: 'headline' }, 'How should we ', h('em', {}, 'approach'), ' this?'),
      h('p', { class: 'subhead' },
        'You can either let us find the relevant legal questions on our own, or hand us your ' +
        'own list. Whichever you pick, our agents will still cover the ground we think is ' +
        'important — so nothing slips through.'
      ),
      h('div', { class: 'choices' },
        h('button', {
          class: 'choice',
          onclick: () => { S.researchMode = 'system'; render(screen5_intent, 5); }
        },
          h('div', { class: 'choice-numeral' }, '01'),
          h('div', { class: 'choice-title' }, 'Let us pick the questions'),
          h('div', { class: 'choice-body' },
            'Our system reads the documents end-to-end and generates the legal issues ' +
            'most worth researching, weighted by strategic significance.'),
          h('span', { class: 'choice-arrow' }, '→')
        ),
        h('button', {
          class: 'choice',
          onclick: () => { S.researchMode = 'user'; render(screen4b_userQs, 4); }
        },
          h('div', { class: 'choice-numeral' }, '02'),
          h('div', { class: 'choice-title' }, 'I will give my own questions'),
          h('div', { class: 'choice-body' },
            'You hand us the questions you want answered. Our own questions also run in ' +
            'parallel — both sets feed into one research report.'),
          h('span', { class: 'choice-arrow' }, '→')
        )
      )
    );
  }

  // ── Screen 4b: user's own questions ──────────────────────────
  function screen4b_userQs() {
    const ta = h('textarea', {
      class: 'input textinput',
      placeholder:
        '1. Whether a consent decree can be set aside on the ground of fraud?\n' +
        '2. Limitation under Section 17 of the Limitation Act when fraud is later discovered.\n' +
        '3. ...'
    });
    ta.value = S.userQuestions || '';

    return h('section', { class: 'screen' },
      h('div', { class: 'eyebrow' }, 'Your questions'),
      h('h1', { class: 'headline' }, 'Type them, ', h('em', {}, 'one per line'), '.'),
      h('p', { class: 'subhead tight' },
        'Frame each question the way you would brief a junior. Plain English is fine — we ' +
        'will translate it into the right legal search terms.'
      ),
      h('div', { class: 'field-block' },
        h('div', { class: 'label' }, 'Your research questions'),
        ta
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary',
                      onclick: () => { S.userQuestions = ta.value.trim(); render(screen5_intent, 5); } },
          'Continue', h('span', {}, '→')),
        h('button', { class: 'btn-text', onclick: () => render(screen4_research, 4) },
          '← Back')
      )
    );
  }

  // ── Screen 5: research only vs research + draft ──────────────
  function screen5_intent() {
    return h('section', { class: 'screen' },
      h('div', { class: 'eyebrow' }, 'What you need'),
      h('h1', { class: 'headline' }, 'Research, ', h('em', {}, 'or'), ' research plus a draft?'),
      h('p', { class: 'subhead' },
        'A research report stands on its own — useful for a quick view of the law. A draft ' +
        'goes further, putting that research into a court-ready document on your behalf.'
      ),
      h('div', { class: 'choices' },
        h('button', {
          class: 'choice',
          onclick: () => { S.intent = 'research'; render(screen7_running, 7); kickoff(); }
        },
          h('div', { class: 'choice-numeral' }, '01'),
          h('div', { class: 'choice-title' }, 'Just the research'),
          h('div', { class: 'choice-body' },
            'A detailed research report with verified precedents, applicability ' +
            'analysis and strategic notes. No draft.'),
          h('span', { class: 'choice-arrow' }, '→')
        ),
        h('button', {
          class: 'choice',
          onclick: () => { S.intent = 'draft'; render(screen6_draft, 6); }
        },
          h('div', { class: 'choice-numeral' }, '02'),
          h('div', { class: 'choice-title' }, 'Research and drafting'),
          h('div', { class: 'choice-body' },
            'Full research report plus a court-ready draft — citations woven into prose, ' +
            'verbatim Supreme Court paragraphs included, sanitised for filing.'),
          h('span', { class: 'choice-arrow' }, '→')
        )
      )
    );
  }

  // ── Screen 6: drafting basics ────────────────────────────────
  function screen6_draft() {
    const typeInput = h('input', {
      class: 'input textinput',
      placeholder: 'Written Arguments under Order VI Rule 17 CPC'
    });
    typeInput.value = S.draftType || '';

    const partyInput = h('input', {
      class: 'input textinput',
      placeholder: 'Counter-Claimant / Defendant'
    });
    partyInput.value = S.draftParty || '';

    function go() {
      S.draftType = typeInput.value.trim();
      S.draftParty = partyInput.value.trim();
      if (!S.draftType || !S.draftParty) return;
      render(screen7_running, 7);
      kickoff();
    }

    return h('section', { class: 'screen' },
      h('div', { class: 'eyebrow' }, 'The draft'),
      h('h1', { class: 'headline' }, 'Two ', h('em', {}, 'small'), ' details.'),
      h('p', { class: 'subhead tight' },
        'These are the only inputs we need. Everything else — court, parties, facts, ' +
        'authorities — we already have from the documents you uploaded.'
      ),
      h('div', { class: 'field-block' },
        h('div', { class: 'label' }, 'What do you want to draft?'),
        typeInput,
        h('div', { class: 'helper' },
          'e.g. Plaint, Written Statement, Bail Application under Section 439 CrPC, ' +
          'Petition under Section 482 CrPC for quashing, Written Arguments, Legal Notice.')
      ),
      h('div', { class: 'spacer' }),
      h('div', { class: 'field-block' },
        h('div', { class: 'label' }, 'On behalf of whom?'),
        partyInput,
        h('div', { class: 'helper' },
          'e.g. Plaintiff, Petitioner, Counter-Claimant, Accused, Respondent No. 2.')
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', onclick: go },
          'Start drafting', h('span', {}, '→')),
        h('button', { class: 'btn-text', onclick: () => render(screen5_intent, 5) },
          '← Back')
      )
    );
  }

  // ── Screen 7: running / live progress ────────────────────────
  function screen7_running() {
    const steps = [
      { key: 'extract',    label: 'Extracting case data from documents' },
      { key: 'research',   label: 'Generating legal issues and research questions' },
      { key: 'precedents', label: 'Verifying every cited precedent' },
      ...(S.intent === 'draft' ? [
        { key: 'court',      label: 'Identifying court and forum' },
        { key: 'fill',       label: 'Drafting first cut (three candidates)' },
        { key: 'quote',      label: 'Fetching verbatim paragraphs from cited judgments' },
        { key: 'humanize',   label: 'Senior-counsel rewrite' },
        { key: 'critique',   label: 'Critique round and second pass' },
        { key: 'readiness',  label: 'Court-readiness review' },
        { key: 'render',     label: 'Rendering final PDF' }
      ] : [
        { key: 'compose',    label: 'Composing research report' }
      ])
    ];

    const lineMap = {};
    const linesEl = steps.map(s => {
      const ln = h('div', { class: 'status-line pending' },
        h('span', { class: 'glyph' }, '○'),
        h('span', {}, s.label)
      );
      lineMap[s.key] = ln;
      return ln;
    });

    // Mock progressive activation; real wiring will use SSE
    let idx = 0;
    function advance() {
      if (idx >= steps.length) {
        const noteEl = document.getElementById('final-note');
        if (noteEl) {
          noteEl.innerHTML = 'All steps complete. We will email you the final PDF and a ' +
                             'download link as soon as it is signed off.';
        }
        return;
      }
      const prev = idx > 0 ? lineMap[steps[idx - 1].key] : null;
      if (prev) { prev.className = 'status-line done'; prev.firstChild.textContent = '✓'; }
      const cur = lineMap[steps[idx].key];
      cur.className = 'status-line active';
      cur.firstChild.textContent = '◐';
      idx++;
      setTimeout(advance, 5000 + Math.random() * 8000);
    }
    setTimeout(advance, 800);

    return h('section', { class: 'screen wide' },
      h('div', { class: 'eyebrow' }, 'All set'),
      h('h1', { class: 'headline' }, 'We are ', h('em', {}, 'starting'), ' now.'),
      h('p', { class: 'subhead tight' },
        S.intent === 'draft'
          ? 'A full research and drafting pass takes about 20 to 25 minutes. You can keep this tab open and watch, or close it — we will email you the PDF when ready.'
          : 'A full research pass takes about 6 to 10 minutes. Stay here or close the tab — we will send you the report when ready.'
      ),
      h('div', { class: 'final-card' },
        h('div', { class: 'final-eyebrow' }, 'Pipeline'),
        ...linesEl,
        h('div', { class: 'final-note', id: 'final-note' },
          'Average time: ' +
          (S.intent === 'draft' ? '20 to 25 minutes.' : '6 to 10 minutes.') +
          ' We will notify you when this is complete.'
        )
      )
    );
  }

  // ── Real pipeline kickoff ────────────────────────────────────
  // Fires the spot-issues + draft-experiment endpoints. When the draft
  // returns, swaps screen 7 to a completion view with Download PDF.
  async function kickoff() {
    const primaryCaseId = S.caseId || (S.uploads.find(u => u.caseId) || {}).caseId;
    if (!primaryCaseId) {
      const finalNote = document.getElementById('final-note');
      if (finalNote) finalNote.textContent =
        'No documents were uploaded — please go back and upload at least one PDF.';
      return;
    }

    // Spot legal issues (fire-and-forget; result surfaces in research output)
    fetch(`/api/cases/${primaryCaseId}/spot-issues`, { method: 'POST' }).catch(() => {});

    if (S.intent !== 'draft') {
      // Research-only path — no draft request, just mark complete eventually
      return;
    }

    try {
      const r = await fetch(`/api/cases/${primaryCaseId}/draft-experiment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_name: 'written_arguments_o6r17',
          draftType:     S.draftType,
          onBehalfOf:    S.draftParty
        })
      });
      if (!r.ok) {
        const errJ = await r.json().catch(() => ({}));
        throw new Error(errJ.error || `HTTP ${r.status}`);
      }
      const result = await r.json();
      S.draftResult = result;
      showCompletionUI(result);
    } catch (e) {
      const finalNote = document.getElementById('final-note');
      if (finalNote) {
        finalNote.style.color = '#6B1B1B';
        finalNote.textContent = 'The drafting pipeline failed: ' + (e.message || 'unknown error') +
                                '. Please reload and try again.';
      }
    }
  }

  // Replace the "Pipeline" card with a completion card once draft done.
  function showCompletionUI(result) {
    const card = document.querySelector('.final-card');
    if (!card) return;

    const verdict = result.readiness_report?.verdict || 'ready';
    const grade   = result.readiness_report?.grade   || '—';
    const cites   = result.citation_audit
      ? `${result.citation_audit.verified}/${result.citation_audit.total} verified`
      : '';
    const elapsed = result.elapsed_seconds
      ? `${Math.round(result.elapsed_seconds / 60)} min`
      : '';

    card.innerHTML = '';
    card.appendChild(h('div', { class: 'final-eyebrow', style: 'color: #2F5D3A;' }, 'Draft ready'));
    card.appendChild(h('h2', {
      style: 'font-family: var(--serif); font-weight: 500; font-size: 1.6rem; margin: 8pt 0 14pt; line-height:1.25;'
    }, 'Your court-ready draft is prepared.'));

    // Quality metrics row
    const meta = h('dl', {
      style: 'display: grid; grid-template-columns: max-content 1fr; gap: 6pt 18pt; font-size: 0.92rem; margin-bottom: 18pt;'
    });
    const addRow = (k, v) => {
      meta.appendChild(h('dt', { style: 'font-family: var(--mono); font-size: 10px; letter-spacing: 1.2px; color: #7A6E5C; text-transform: uppercase; padding-top: 4px;' }, k));
      meta.appendChild(h('dd', { style: 'font-family: var(--sans); color: #14110D;' }, v));
    };
    if (cites)   addRow('Citations',        cites);
    if (grade)   addRow('Readiness grade',  grade);
    if (verdict) addRow('Verdict',          verdict.replace(/_/g, ' '));
    if (elapsed) addRow('Time taken',       elapsed);
    card.appendChild(meta);

    // PDF + view-source buttons
    const btnRow = h('div', { style: 'display: flex; gap: 12px; flex-wrap: wrap;' });
    if (result.pdf?.url) {
      btnRow.appendChild(h('a', {
        class: 'btn btn-primary',
        href: result.pdf.url,
        target: '_blank',
        download: result.pdf.fileName || 'draft.pdf',
        style: 'text-decoration: none;'
      }, 'Download PDF', h('span', {}, '↓')));
    } else if (result.pdf?.error) {
      btnRow.appendChild(h('div', {
        style: 'font-family: var(--serif); font-style: italic; color: #6B1B1B;'
      }, 'PDF render failed: ' + result.pdf.error + ' — use "View draft text" instead.'));
    }
    btnRow.appendChild(h('button', {
      class: 'btn btn-ghost',
      onclick: () => showDraftMarkdown(result.draftMarkdown)
    }, 'View draft text'));
    card.appendChild(btnRow);

    // Optional: bench questions that the readiness QA flagged
    const benchQs = result.readiness_report?.bench_questions_unanswered || [];
    if (benchQs.length) {
      const note = h('div', {
        style: 'margin-top: 22pt; padding-top: 18pt; border-top: 1px solid #E0D6BD; font-family: var(--serif); font-style: italic; color: #3D352B; font-size: 0.95rem; line-height: 1.55;'
      });
      note.appendChild(document.createTextNode(
        'Bench questions to anticipate before filing — please address these with your counsel:'
      ));
      const ul = h('ul', { style: 'margin: 10pt 0 0 18pt; padding: 0;' });
      benchQs.forEach(q => ul.appendChild(h('li', { style: 'margin-bottom: 6pt;' }, q)));
      note.appendChild(ul);
      card.appendChild(note);
    }
  }

  // Plain-text modal-ish view of the draft markdown.
  function showDraftMarkdown(md) {
    const overlay = h('div', {
      style: 'position: fixed; inset: 0; background: rgba(20, 17, 13, 0.55); z-index: 999; display: flex; align-items: center; justify-content: center; padding: 5vh 5vw;',
      onclick: (e) => { if (e.target === overlay) overlay.remove(); }
    });
    const inner = h('div', {
      style: 'background: #F7F1E5; max-width: 800px; max-height: 90vh; overflow-y: auto; padding: 36px 40px; border-radius: 4px; box-shadow: 0 24px 64px rgba(0,0,0,0.25); font-family: var(--serif); font-size: 0.98rem; line-height: 1.7; white-space: pre-wrap; color: #14110D;'
    });
    inner.textContent = md || '(no content)';
    overlay.appendChild(inner);
    document.body.appendChild(overlay);
  }

  // ── Boot ─────────────────────────────────────────────────────
  render(screen1_welcome, 1);
})();
