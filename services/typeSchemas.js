/**
 * Per-document-type Datalab extraction schemas.
 *
 * Pipeline plan: Datalab segments the case file → each segment gets a
 * TYPE LABEL → the right schema below is plugged into a second
 * /api/v1/extract call with that segment's page_range. This is more
 * accurate than one giant flat schema over 200 pages of mixed content
 * because the model focuses on the right pages with the right boxes.
 *
 * Each schema includes:
 *   - 25-45 fields specific to that document type
 *   - A universal `other_atoms` array as a Datalab-level catch-all so
 *     anything off-schema (unusual clauses, oddities) still gets
 *     captured by the Datalab pass before DeepSeek gap-fill runs.
 */

// ─── common bits ────────────────────────────────────────────────
const otherAtomsField = {
  other_atoms: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Any LEGALLY SIGNIFICANT atom found in the document that is NOT ' +
      'in any other field above — unusual clauses, special covenants, ' +
      'recitals, waivers, footnotes, particular admissions, special ' +
      'observations. Each entry as one short verbatim or near-verbatim ' +
      'sentence, preserve numbers / dates / amounts exactly.'
  }
};

// Universal identity/parties block reused across every schema so that
// no segment ever lacks these basic atoms. Datalab handles flat fields
// well — keeping these atomic is intentional.
const universalIdentity = {
  document_title_or_heading: { type: 'string', description: 'Title / heading printed at the top of the document.' },
  document_date: { type: 'string', description: 'Date the document bears or was executed, DD MMM YYYY form.' },
  document_reference_number: { type: 'string', description: 'Reference / serial / registration number.' },
  issuing_authority: { type: 'string', description: 'Who issued, executed, or authored this document.' },
  signatories: { type: 'array', items: { type: 'string' }, description: 'Each signatory in the form "Name (designation/role)".' },
  attesting_witnesses: { type: 'array', items: { type: 'string' }, description: 'Attesting / identifying witnesses, format "Name (role)".' },
  parties: { type: 'array', items: { type: 'string' }, description: 'Every named party with role suffix.' },
  one_line_summary: { type: 'string', description: 'Single short sentence — what this document is about.' },
  detailed_summary: { type: 'string', description: '3-5 sentence summary covering what, who, subject matter, key claim/direction.' }
};

// ─── 1. FIR (First Information Report) ──────────────────────────
const FIR_SCHEMA = {
  type: 'object',
  properties: {
    ...universalIdentity,
    fir_number: { type: 'string', description: 'FIR number as written.' },
    fir_date: { type: 'string', description: 'FIR registration date.' },
    fir_time: { type: 'string', description: 'Time of registration if mentioned.' },
    police_station: { type: 'string', description: 'PS where registered.' },
    district: { type: 'string', description: 'District.' },
    state_or_ut: { type: 'string', description: 'State / UT.' },
    complainant: { type: 'string', description: 'Name of the complainant / informant.' },
    complainant_address: { type: 'string', description: 'Address of the complainant.' },
    complainant_phone: { type: 'string', description: 'Phone of complainant if mentioned.' },
    place_of_incident: { type: 'string', description: 'Where the incident allegedly occurred.' },
    date_of_incident: { type: 'string', description: 'Date of the alleged incident.' },
    time_of_incident: { type: 'string', description: 'Time of the alleged incident.' },
    offences_alleged: { type: 'array', items: { type: 'string' }, description: 'Each offence with section + statute (e.g. "302 IPC — murder").' },
    accused_named: { type: 'array', items: { type: 'string' }, description: 'Accused with serial no., name, age, address.' },
    accused_unknown_count: { type: 'string', description: 'Number of unknown accused if any.' },
    weapons_or_articles_used: { type: 'array', items: { type: 'string' }, description: 'Weapons / articles used in offence.' },
    property_lost_or_stolen: { type: 'array', items: { type: 'string' }, description: 'Property lost / stolen with description + value.' },
    injuries_described: { type: 'array', items: { type: 'string' }, description: 'Injuries described to victims with body part + nature.' },
    witnesses_named: { type: 'array', items: { type: 'string' }, description: 'Eye-witnesses or other witnesses named.' },
    investigating_officer: { type: 'string', description: 'IO name + designation.' },
    fir_narrative: { type: 'string', description: 'The narrative paragraph(s) — what allegedly happened, in the complainant\'s own words.' },
    dispatched_to_magistrate_on: { type: 'string', description: 'Date the FIR was forwarded to the Magistrate u/s 157 CrPC / BNSS.' },
    copy_supplied_to_complainant: { type: 'string', description: 'Whether a copy was supplied to the complainant.' },
    medical_examination_status: { type: 'string', description: 'Whether medical examination of victim was conducted; date.' },
    ...otherAtomsField
  }
};

// ─── 2. CHARGE SHEET (Final Police Report u/s 173 / 193 BNSS) ───
const CHARGE_SHEET_SCHEMA = {
  type: 'object',
  properties: {
    ...universalIdentity,
    cnr_or_fir_reference: { type: 'string', description: 'CNR / case ID / FIR no. referenced.' },
    police_station: { type: 'string', description: 'PS that filed the charge sheet.' },
    court_to_which_filed: { type: 'string', description: 'Court before which charge sheet is filed.' },
    investigating_officer: { type: 'string', description: 'IO name + designation + posting.' },
    superintendent_of_police_signing: { type: 'string', description: 'SP / DSP / ACP who signed the report, if any.' },
    accused_list: { type: 'array', items: { type: 'string' }, description: 'Each accused: serial no., name, parentage, age, address.' },
    accused_arrested: { type: 'array', items: { type: 'string' }, description: 'Accused who were arrested, with date of arrest.' },
    accused_on_bail: { type: 'array', items: { type: 'string' }, description: 'Accused who are on bail at time of filing.' },
    accused_absconding: { type: 'array', items: { type: 'string' }, description: 'Accused absconding / pending arrest.' },
    sections_chargesheeted: { type: 'array', items: { type: 'string' }, description: 'Sections under which charge is laid — section + statute.' },
    sections_dropped: { type: 'array', items: { type: 'string' }, description: 'Sections initially in the FIR but dropped at charge-sheet stage.' },
    witnesses_list: { type: 'array', items: { type: 'string' }, description: 'Witnesses cited by the prosecution — name, address, role (PW-1, etc.) if shown.' },
    documents_list: { type: 'array', items: { type: 'string' }, description: 'Documents relied upon — exhibit tag (Doc-1) + description.' },
    articles_seized: { type: 'array', items: { type: 'string' }, description: 'Articles seized during investigation — description + from whom + when.' },
    medical_or_forensic_reports: { type: 'array', items: { type: 'string' }, description: 'PM report, MLC, FSL, ballistic, DNA etc., with reference number.' },
    test_identification_parade: { type: 'string', description: 'TIP conducted? When, by whom, outcome.' },
    confessions_recorded: { type: 'array', items: { type: 'string' }, description: 'Confessions u/s 164 CrPC / 183 BNSS — by whom, when, before whom.' },
    sanctions_obtained: { type: 'array', items: { type: 'string' }, description: 'Sanctions u/s 197 CrPC, s.19 PC Act, etc. — authority + date.' },
    io_opinion: { type: 'string', description: 'IO\'s conclusion / opinion on the case.' },
    section_173_compliance_notes: { type: 'string', description: 'Statement on s.173 / s.193 BNSS compliance.' },
    case_property_status: { type: 'string', description: 'Status / disposition of case property.' },
    ...otherAtomsField
  }
};

// ─── 3. SALE DEED ───────────────────────────────────────────────
const SALE_DEED_SCHEMA = {
  type: 'object',
  properties: {
    ...universalIdentity,
    vendor: { type: 'string', description: 'Vendor / seller — name, parentage, age, occupation, address.' },
    vendee: { type: 'string', description: 'Vendee / purchaser — name, parentage, age, occupation, address.' },
    sale_consideration_amount: { type: 'string', description: 'Total consideration amount in figures and words.' },
    consideration_paid_breakdown: { type: 'array', items: { type: 'string' }, description: 'How payment was made — earnest, advance, balance; each instalment\'s date, amount, mode (cheque/RTGS/cash), instrument number, bank.' },
    consideration_payment_acknowledged: { type: 'string', description: 'Whether receipt of consideration is acknowledged in the deed (and where).' },
    property_full_description: { type: 'string', description: 'Full property description — address, area / extent, type (residential/commercial/agricultural), structure.' },
    property_boundaries: { type: 'array', items: { type: 'string' }, description: 'Boundaries — North/South/East/West with what abuts each.' },
    survey_or_khasra_or_khatauni: { type: 'string', description: 'Survey / khasra / khatauni / municipal / property tax / society plot numbers.' },
    property_built_up_area: { type: 'string', description: 'Built-up area in sq.ft / sq.m / square yards.' },
    property_land_area: { type: 'string', description: 'Plot / land area.' },
    vendor_title_chain: { type: 'array', items: { type: 'string' }, description: 'Chain of vendor\'s title — prior owners with deed reference / date / registration if recited.' },
    encumbrances_disclosed: { type: 'string', description: 'Whether any encumbrances / loans / liens / litigation disclosed — and what.' },
    encumbrance_certificate_referenced: { type: 'string', description: 'EC obtained? from when to when, number, date.' },
    possession_delivered_on: { type: 'string', description: 'Date possession is / was delivered.' },
    possession_mode: { type: 'string', description: 'Mode of delivery (physical / symbolic) and any conditions.' },
    indemnity_clause: { type: 'string', description: 'Indemnity given by vendor.' },
    covenants_for_quiet_enjoyment: { type: 'string', description: 'Covenant for quiet enjoyment.' },
    stamp_duty_paid: { type: 'string', description: 'Stamp duty paid — amount + mode (e-stamp, franking, paper, vendor name, GRN no.).' },
    registration_fee_paid: { type: 'string', description: 'Registration fee.' },
    sub_registrar_office: { type: 'string', description: 'Sub-Registrar / Joint Sub-Registrar office of registration.' },
    registration_book_volume_page: { type: 'string', description: 'Book no., volume, page, document number assigned by SRO if reflected.' },
    mutation_undertaking: { type: 'string', description: 'Mutation in revenue records — to be done by whom, by when.' },
    tax_dues_clearance: { type: 'string', description: 'Property tax / society dues / utility clearance.' },
    common_areas_facilities: { type: 'array', items: { type: 'string' }, description: 'If apartment/society — common areas, undivided share, parking, terrace rights.' },
    pan_aadhaar_disclosed: { type: 'array', items: { type: 'string' }, description: 'PAN / Aadhaar numbers disclosed in the deed (masked if any).' },
    ...otherAtomsField
  }
};

// ─── 4. LEASE DEED ──────────────────────────────────────────────
const LEASE_DEED_SCHEMA = {
  type: 'object',
  properties: {
    ...universalIdentity,
    lessor: { type: 'string', description: 'Lessor — name + address.' },
    lessee: { type: 'string', description: 'Lessee — name + address.' },
    property_description: { type: 'string', description: 'Leased property — address, area, type.' },
    rent_amount: { type: 'string', description: 'Monthly / periodic rent.' },
    rent_payment_due_date: { type: 'string', description: 'Day of month rent falls due.' },
    rent_escalation_clause: { type: 'string', description: 'Rent escalation — % per year / period.' },
    security_deposit_amount: { type: 'string', description: 'Security deposit amount and refund terms.' },
    lock_in_period: { type: 'string', description: 'Lock-in period during which lease cannot be terminated.' },
    lease_term: { type: 'string', description: 'Total lease term / duration.' },
    commencement_date: { type: 'string', description: 'Commencement date of the lease.' },
    expiry_date: { type: 'string', description: 'Expiry date.' },
    renewal_clause: { type: 'string', description: 'Renewal terms — options, notice, new rent.' },
    permitted_use: { type: 'string', description: 'Permitted use of the premises.' },
    sub_letting_clause: { type: 'string', description: 'Whether sub-letting / assignment is permitted.' },
    maintenance_responsibility: { type: 'string', description: 'Who pays for maintenance / society charges / repairs.' },
    utilities_responsibility: { type: 'string', description: 'Who pays utilities (electricity, water, etc.).' },
    interior_fit_out_clause: { type: 'string', description: 'Fit-out / alteration clause.' },
    termination_notice_period: { type: 'string', description: 'Notice period for termination by either side.' },
    forfeiture_clause: { type: 'string', description: 'Grounds for forfeiture of security or eviction.' },
    force_majeure_clause: { type: 'string', description: 'Force majeure clause text.' },
    arbitration_clause: { type: 'string', description: 'Arbitration / dispute resolution clause.' },
    jurisdiction_clause: { type: 'string', description: 'Exclusive jurisdiction.' },
    stamp_duty_paid: { type: 'string', description: 'Stamp duty paid + mode.' },
    registration_details: { type: 'string', description: 'Registration details if registered.' },
    ...otherAtomsField
  }
};

// ─── 5. WILL / CODICIL ──────────────────────────────────────────
const WILL_SCHEMA = {
  type: 'object',
  properties: {
    ...universalIdentity,
    testator_name: { type: 'string', description: 'Testator name.' },
    testator_age: { type: 'string', description: 'Testator age at execution.' },
    testator_address: { type: 'string', description: 'Testator address.' },
    testator_mental_capacity_clause: { type: 'string', description: 'Recital affirming sound mind and free will.' },
    revocation_of_prior_wills: { type: 'string', description: 'Clause revoking earlier wills / codicils.' },
    beneficiaries: { type: 'array', items: { type: 'string' }, description: 'Beneficiaries — name, relationship, share.' },
    specific_bequests: { type: 'array', items: { type: 'string' }, description: 'Specific bequests — "to X, item / amount / property".' },
    residuary_clause: { type: 'string', description: 'Residuary clause — who takes the remainder.' },
    executor: { type: 'string', description: 'Executor(s) appointed.' },
    guardian_for_minors: { type: 'string', description: 'Guardian named for minor beneficiaries, if any.' },
    funeral_or_religious_instructions: { type: 'string', description: 'Funeral / religious / cremation instructions.' },
    attestation_clause_text: { type: 'string', description: 'Attestation clause text per s.63 Indian Succession Act.' },
    attesting_witnesses_details: { type: 'array', items: { type: 'string' }, description: 'Attesting witnesses with full address.' },
    place_of_execution: { type: 'string', description: 'Place where will is executed.' },
    schedule_of_assets: { type: 'array', items: { type: 'string' }, description: 'Schedule / list of testator\'s assets if appended.' },
    debts_or_liabilities_recited: { type: 'array', items: { type: 'string' }, description: 'Debts / liabilities recited.' },
    ...otherAtomsField
  }
};

// ─── 6. MOU / AGREEMENT (generic contract) ──────────────────────
const AGREEMENT_SCHEMA = {
  type: 'object',
  properties: {
    ...universalIdentity,
    party_a: { type: 'string', description: 'Party A / First Party — full description.' },
    party_b: { type: 'string', description: 'Party B / Second Party — full description.' },
    additional_parties: { type: 'array', items: { type: 'string' }, description: 'Additional parties if any.' },
    recitals: { type: 'array', items: { type: 'string' }, description: 'Recital paragraphs setting out background.' },
    subject_matter: { type: 'string', description: 'Subject matter / scope of the agreement.' },
    consideration_amount: { type: 'string', description: 'Consideration amount.' },
    consideration_payment_terms: { type: 'string', description: 'Payment schedule and mode.' },
    effective_date: { type: 'string', description: 'Effective date.' },
    term_duration: { type: 'string', description: 'Term / duration.' },
    expiry_or_termination_date: { type: 'string', description: 'Expiry or termination date.' },
    obligations_party_a: { type: 'array', items: { type: 'string' }, description: 'Key obligations of Party A.' },
    obligations_party_b: { type: 'array', items: { type: 'string' }, description: 'Key obligations of Party B.' },
    representations_and_warranties: { type: 'array', items: { type: 'string' }, description: 'Reps & warranties.' },
    indemnity_clauses: { type: 'array', items: { type: 'string' }, description: 'Indemnity clauses.' },
    limitation_of_liability: { type: 'string', description: 'Limitation of liability clause.' },
    confidentiality_clause: { type: 'string', description: 'Confidentiality / NDA terms.' },
    non_compete_clause: { type: 'string', description: 'Non-compete clause.' },
    non_solicitation_clause: { type: 'string', description: 'Non-solicitation clause.' },
    intellectual_property_clause: { type: 'string', description: 'IP ownership / licensing.' },
    termination_clause: { type: 'string', description: 'Termination — grounds, notice, consequences.' },
    breach_consequences: { type: 'string', description: 'Consequences of breach.' },
    force_majeure_clause: { type: 'string', description: 'Force majeure.' },
    governing_law: { type: 'string', description: 'Governing law.' },
    jurisdiction_clause: { type: 'string', description: 'Jurisdiction.' },
    arbitration_clause: { type: 'string', description: 'Arbitration clause + seat / venue.' },
    assignment_clause: { type: 'string', description: 'Assignment clause.' },
    notice_clause: { type: 'string', description: 'Notice clause — addresses, mode.' },
    severability_entire_agreement: { type: 'string', description: 'Severability and entire agreement clauses.' },
    stamp_duty_paid: { type: 'string', description: 'Stamp duty.' },
    ...otherAtomsField
  }
};

// ─── 7. AFFIDAVIT / EVIDENCE AFFIDAVIT ──────────────────────────
const AFFIDAVIT_SCHEMA = {
  type: 'object',
  properties: {
    ...universalIdentity,
    deponent_name: { type: 'string', description: 'Deponent — name, age, parentage, address, occupation.' },
    case_reference: { type: 'string', description: 'Case title and number to which affidavit is filed.' },
    court: { type: 'string', description: 'Court before which the affidavit is filed.' },
    affidavit_purpose: { type: 'string', description: 'Purpose — "in support of bail application", "in reply", "evidence affidavit", etc.' },
    paragraphs: { type: 'array', items: { type: 'string' }, description: 'Each numbered paragraph of the affidavit, as concise summary with paragraph number prefix ("¶ 5: ...").' },
    exhibits_referred: { type: 'array', items: { type: 'string' }, description: 'Exhibits annexed / referenced — tag (Annexure A / Ex. P-1) + description.' },
    verification_clause: { type: 'string', description: 'Verification clause — what is true to knowledge vs information.' },
    sworn_before: { type: 'string', description: 'Oath Commissioner / Notary / Magistrate before whom sworn — name + date.' },
    notarisation_details: { type: 'string', description: 'Notary regn number, stamp etc.' },
    specific_admissions: { type: 'array', items: { type: 'string' }, description: 'Specific admissions made.' },
    specific_denials: { type: 'array', items: { type: 'string' }, description: 'Specific denials made.' },
    ...otherAtomsField
  }
};

// ─── 8. LEGAL NOTICE / REPLY TO LEGAL NOTICE ────────────────────
const LEGAL_NOTICE_SCHEMA = {
  type: 'object',
  properties: {
    ...universalIdentity,
    sender_or_notifier: { type: 'string', description: 'Sender — name + address; through whom (advocate name + enrolment).' },
    recipient: { type: 'string', description: 'Recipient — name + address.' },
    notice_date: { type: 'string', description: 'Notice date.' },
    notice_reference_number: { type: 'string', description: 'Notice reference / advocate file number.' },
    facts_recited: { type: 'array', items: { type: 'string' }, description: 'Facts recited in the notice.' },
    specific_demand: { type: 'string', description: 'Specific demand / direction made on the recipient.' },
    monetary_demand: { type: 'string', description: 'Monetary demand if any — amount + breakdown.' },
    compliance_period: { type: 'string', description: 'Time given for compliance (e.g. "15 days from receipt").' },
    consequences_threatened: { type: 'string', description: 'Action threatened on non-compliance — suit, complaint, criminal prosecution, etc.' },
    statutory_provision_invoked: { type: 'string', description: 'Statutory provision under which notice is issued (e.g. s.138 NI Act, s.80 CPC).' },
    mode_of_service: { type: 'string', description: 'Mode of service.' },
    postal_or_tracking_number: { type: 'string', description: 'Postal / courier tracking number if mentioned.' },
    reply_received: { type: 'string', description: 'If notice is a reply: which earlier notice it replies to — date + reference.' },
    points_in_reply: { type: 'array', items: { type: 'string' }, description: 'For a reply notice — each point made paragraph-wise.' },
    ...otherAtomsField
  }
};

// ─── 9. PLAINT / WRIT PETITION / PETITION / BAIL APPLICATION ────
const PETITION_SCHEMA = {
  type: 'object',
  properties: {
    ...universalIdentity,
    case_title: { type: 'string', description: 'Case title.' },
    case_number: { type: 'string', description: 'Case / suit / petition / application number.' },
    court: { type: 'string', description: 'Court.' },
    judge_or_bench: { type: 'string', description: 'Judge / bench named for listing if any.' },
    filing_date: { type: 'string', description: 'Filing / institution date.' },
    petitioner: { type: 'array', items: { type: 'string' }, description: 'Petitioner / plaintiff / applicant — name, parentage, age, address.' },
    respondent: { type: 'array', items: { type: 'string' }, description: 'Respondent / defendant / non-applicant.' },
    advocate_for_petitioner: { type: 'string', description: 'Counsel for petitioner.' },
    advocate_for_respondent: { type: 'string', description: 'Counsel for respondent.' },
    jurisdictional_clause: { type: 'string', description: 'Jurisdictional clause — why this court has jurisdiction.' },
    cause_of_action_paragraph: { type: 'string', description: 'Cause-of-action paragraph — date(s) and what gave rise to the right to sue.' },
    facts_paragraphs: { type: 'array', items: { type: 'string' }, description: 'Each numbered fact paragraph as a short sentence with ¶ no.' },
    statutory_invocation: { type: 'array', items: { type: 'string' }, description: 'Statutes / sections / rules invoked.' },
    grounds: { type: 'array', items: { type: 'string' }, description: 'Grounds / legal grounds urged.' },
    precedents_cited: { type: 'array', items: { type: 'string' }, description: 'Authorities cited.' },
    main_prayers: { type: 'array', items: { type: 'string' }, description: 'Main prayers as numbered list.' },
    interim_prayers: { type: 'array', items: { type: 'string' }, description: 'Interim prayers.' },
    alternative_prayers: { type: 'array', items: { type: 'string' }, description: 'Alternative prayers.' },
    valuation_for_court_fees: { type: 'string', description: 'Valuation for court fees and jurisdiction.' },
    list_of_documents: { type: 'array', items: { type: 'string' }, description: 'Annexures / documents annexed.' },
    verification_clause: { type: 'string', description: 'Verification clause / affidavit accompanying.' },
    ...otherAtomsField
  }
};

// ─── 10. WRITTEN STATEMENT / REPLY ──────────────────────────────
const WRITTEN_STATEMENT_SCHEMA = {
  type: 'object',
  properties: {
    ...universalIdentity,
    case_title: { type: 'string', description: 'Case title.' },
    case_number: { type: 'string', description: 'Case / suit number.' },
    court: { type: 'string', description: 'Court.' },
    filing_date: { type: 'string', description: 'Date of filing the WS / reply.' },
    party_filing: { type: 'string', description: 'Defendant / respondent filing this reply.' },
    preliminary_objections: { type: 'array', items: { type: 'string' }, description: 'Preliminary objections raised — limitation, jurisdiction, mis-joinder, cause-of-action, non-maintainability, etc.' },
    paragraph_wise_response: { type: 'array', items: { type: 'string' }, description: 'Para-wise admissions / denials / responses to plaint paras: "¶ 5 of plaint: denied, with specific reasons".' },
    additional_facts: { type: 'array', items: { type: 'string' }, description: 'Additional facts / counter-narrative pleaded.' },
    set_off_or_counter_claim: { type: 'string', description: 'Set-off / counter-claim if any.' },
    prayers: { type: 'array', items: { type: 'string' }, description: 'Prayers of the defendant — usually for dismissal + costs.' },
    documents_annexed: { type: 'array', items: { type: 'string' }, description: 'Documents annexed.' },
    ...otherAtomsField
  }
};

// ─── 11. JUDGMENT / ORDER / DECREE ──────────────────────────────
const ORDER_JUDGMENT_SCHEMA = {
  type: 'object',
  properties: {
    ...universalIdentity,
    case_title: { type: 'string', description: 'Case title.' },
    case_number: { type: 'string', description: 'Case number.' },
    court: { type: 'string', description: 'Court name.' },
    judge_or_bench: { type: 'string', description: 'Judge / bench with prefix.' },
    date_of_order: { type: 'string', description: 'Date of the order / judgment.' },
    appearances: { type: 'array', items: { type: 'string' }, description: 'Counsel appearing — for petitioner / respondent / amicus.' },
    facts_recited: { type: 'string', description: 'Facts as recited by the court (the "what happened" summary).' },
    issues_framed: { type: 'array', items: { type: 'string' }, description: 'Issues framed by the court.' },
    submissions_petitioner: { type: 'array', items: { type: 'string' }, description: 'Submissions of the petitioner side.' },
    submissions_respondent: { type: 'array', items: { type: 'string' }, description: 'Submissions of the respondent side.' },
    statutes_considered: { type: 'array', items: { type: 'string' }, description: 'Statutes / sections considered.' },
    precedents_considered: { type: 'array', items: { type: 'string' }, description: 'Precedents considered — case name, citation.' },
    reasoning_summary: { type: 'array', items: { type: 'string' }, description: 'Court\'s reasoning paragraph-by-paragraph (¶ no + gist).' },
    ratio_decidendi: { type: 'array', items: { type: 'string' }, description: 'Operative ratio / holdings.' },
    operative_directions: { type: 'array', items: { type: 'string' }, description: 'Operative directions in the order portion.' },
    order_outcome: { type: 'string', description: 'Outcome — allowed / dismissed / disposed / reserved / partly allowed / remanded.' },
    costs_awarded: { type: 'string', description: 'Costs awarded.' },
    interim_protection_granted: { type: 'string', description: 'Interim protection granted, if any.' },
    next_listing_date: { type: 'string', description: 'Next listing date if continuing.' },
    ...otherAtomsField
  }
};

// ─── 12. CROSS-EXAMINATION / EXAMINATION-IN-CHIEF ───────────────
const TESTIMONY_SCHEMA = {
  type: 'object',
  properties: {
    ...universalIdentity,
    case_title: { type: 'string', description: 'Case title.' },
    case_number: { type: 'string', description: 'Case number.' },
    court: { type: 'string', description: 'Court.' },
    date_of_recording: { type: 'string', description: 'Date the deposition was recorded.' },
    witness_name: { type: 'string', description: 'Witness — name, age, occupation, address; PW-/DW- tag.' },
    oath_administered: { type: 'string', description: 'Whether oath / affirmation administered and by whom.' },
    examination_in_chief_questions_and_answers: { type: 'array', items: { type: 'string' }, description: 'Examination-in-chief — each Q-A pair as "Q: ... A: ..." or chronological narrative.' },
    cross_examination_questions_and_answers: { type: 'array', items: { type: 'string' }, description: 'Cross-examination — each Q-A pair.' },
    re_examination_questions_and_answers: { type: 'array', items: { type: 'string' }, description: 'Re-examination Q-A.' },
    specific_admissions_in_cross: { type: 'array', items: { type: 'string' }, description: 'Significant admissions made during cross.' },
    contradictions_with_section_161_statement: { type: 'array', items: { type: 'string' }, description: 'Contradictions with the witness\'s earlier s.161 CrPC / s.180 BNSS statement, if confronted.' },
    exhibits_marked_through_witness: { type: 'array', items: { type: 'string' }, description: 'Exhibits marked through this witness.' },
    objections_raised: { type: 'array', items: { type: 'string' }, description: 'Objections raised by opposing counsel.' },
    ...otherAtomsField
  }
};

// ─── 13. VAKALATNAMA ────────────────────────────────────────────
const VAKALATNAMA_SCHEMA = {
  type: 'object',
  properties: {
    ...universalIdentity,
    case_title: { type: 'string', description: 'Case title.' },
    case_number: { type: 'string', description: 'Case number.' },
    court: { type: 'string', description: 'Court.' },
    client_name: { type: 'string', description: 'Client (executor of the vakalatnama).' },
    advocate_engaged: { type: 'array', items: { type: 'string' }, description: 'Advocates engaged — name + enrolment number + chamber.' },
    powers_granted: { type: 'array', items: { type: 'string' }, description: 'Specific powers granted (appear, plead, compromise, withdraw, etc.).' },
    date_of_execution: { type: 'string', description: 'Date executed.' },
    identification_witness: { type: 'string', description: 'Identification of the client.' },
    fee_clause: { type: 'string', description: 'Fee clause if any.' },
    ...otherAtomsField
  }
};

// ─── 14. POLICE NOTICE / SUMMONS / WARRANT / 41A CrPC ───────────
const POLICE_NOTICE_SCHEMA = {
  type: 'object',
  properties: {
    ...universalIdentity,
    issuing_authority: { type: 'string', description: 'Issuing officer + designation + PS.' },
    addressed_to: { type: 'string', description: 'Addressee — name + status (witness / accused / suspect).' },
    statutory_provision: { type: 'string', description: 'Provision under which notice issued (s.41A CrPC / s.35(3) BNSS / s.160 / s.91 / etc.).' },
    case_reference: { type: 'string', description: 'FIR no. / case number referenced.' },
    direction: { type: 'string', description: 'What the notice directs — appear / produce documents / cooperate.' },
    appearance_date_time_place: { type: 'string', description: 'Where + when to appear.' },
    consequence_of_non_compliance: { type: 'string', description: 'Consequences threatened on non-compliance.' },
    served_on: { type: 'string', description: 'Date and mode of service.' },
    acknowledgment: { type: 'string', description: 'Whether acknowledged by addressee.' },
    ...otherAtomsField
  }
};

// ─── 15. UNIVERSAL FALLBACK (for any unclassified segment) ──────
const UNIVERSAL_FALLBACK_SCHEMA = {
  type: 'object',
  properties: {
    ...universalIdentity,
    dates_mentioned: { type: 'array', items: { type: 'string' }, description: 'Every date mentioned in the document with the event it relates to.' },
    amounts_mentioned: { type: 'array', items: { type: 'string' }, description: 'Every monetary amount with context.' },
    persons_named: { type: 'array', items: { type: 'string' }, description: 'Every named person with role / context.' },
    places_named: { type: 'array', items: { type: 'string' }, description: 'Every place named with context.' },
    statutes_mentioned: { type: 'array', items: { type: 'string' }, description: 'Statutes / sections / rules cited.' },
    case_law_mentioned: { type: 'array', items: { type: 'string' }, description: 'Case citations referenced.' },
    document_references: { type: 'array', items: { type: 'string' }, description: 'References to other documents (annexures, exhibits).' },
    obligations_or_directions: { type: 'array', items: { type: 'string' }, description: 'Obligations / directions in the text.' },
    contested_facts: { type: 'array', items: { type: 'string' }, description: 'Facts that are asserted, denied, admitted.' },
    ...otherAtomsField
  }
};

// ─── Registry ───────────────────────────────────────────────────
const SCHEMA_REGISTRY = {
  FIR:                   FIR_SCHEMA,
  charge_sheet:          CHARGE_SHEET_SCHEMA,
  sale_deed:             SALE_DEED_SCHEMA,
  lease_deed:            LEASE_DEED_SCHEMA,
  will:                  WILL_SCHEMA,
  agreement:             AGREEMENT_SCHEMA,
  mou:                   AGREEMENT_SCHEMA,
  settlement_deed:       AGREEMENT_SCHEMA,
  trust_deed:            AGREEMENT_SCHEMA,
  affidavit:             AFFIDAVIT_SCHEMA,
  evidence_affidavit:    AFFIDAVIT_SCHEMA,
  legal_notice:          LEGAL_NOTICE_SCHEMA,
  reply_to_legal_notice: LEGAL_NOTICE_SCHEMA,
  plaint:                PETITION_SCHEMA,
  writ_petition:         PETITION_SCHEMA,
  bail_application:      PETITION_SCHEMA,
  criminal_petition:     PETITION_SCHEMA,
  application_482:       PETITION_SCHEMA,
  written_statement:     WRITTEN_STATEMENT_SCHEMA,
  rejoinder:             WRITTEN_STATEMENT_SCHEMA,
  judgment:              ORDER_JUDGMENT_SCHEMA,
  court_order:           ORDER_JUDGMENT_SCHEMA,
  interim_order:         ORDER_JUDGMENT_SCHEMA,
  decree:                ORDER_JUDGMENT_SCHEMA,
  examination_in_chief:  TESTIMONY_SCHEMA,
  cross_examination:     TESTIMONY_SCHEMA,
  testimony:             TESTIMONY_SCHEMA,
  vakalatnama:           VAKALATNAMA_SCHEMA,
  police_notice:         POLICE_NOTICE_SCHEMA,
  summons:               POLICE_NOTICE_SCHEMA,
  warrant:               POLICE_NOTICE_SCHEMA,
  notice_41a:            POLICE_NOTICE_SCHEMA,
  unknown:               UNIVERSAL_FALLBACK_SCHEMA,
  other:                 UNIVERSAL_FALLBACK_SCHEMA
};

// The list of expected segment types we'll hand to Datalab's
// /api/v1/segment endpoint so it knows what to classify into.
const SEGMENT_TYPES_FOR_DATALAB = Object.keys(SCHEMA_REGISTRY)
  .filter(k => k !== 'unknown' && k !== 'other');

function schemaForType(type) {
  if (!type) return UNIVERSAL_FALLBACK_SCHEMA;
  const norm = String(type).toLowerCase().replace(/\s+/g, '_');
  return SCHEMA_REGISTRY[norm] || UNIVERSAL_FALLBACK_SCHEMA;
}

module.exports = {
  SCHEMA_REGISTRY,
  SEGMENT_TYPES_FOR_DATALAB,
  UNIVERSAL_FALLBACK_SCHEMA,
  schemaForType
};
