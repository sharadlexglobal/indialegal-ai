#!/usr/bin/env bash
# White-collar crime trial run through production 3-agent pipeline
set -u

API="https://indialegal-ai.onrender.com"

# Create a fresh standalone research case for this trial
SID=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"title":"White-collar crime trial run"}' \
  "$API/api/research/new" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
echo "Standalone case created: id=$SID"
echo ""

# 4 diverse white-collar queries
declare -a QUERIES=(
  "WC1|supremecourt|PMLA Section 19 arrest mein ED ne grounds in writing nahi diye, Pankaj Bansal aur Prabir Purkayastha 2024 ke baad ka view? Arrest illegal challenge"
  "WC2|supremecourt|Mere client ke against 420 aur 406 IPC ka FIR — sirf breach of contract genuine cheating nahi, 482 CrPC mein quash chance kya hai, Inder Mohan Goswami line"
  "WC3|supremecourt|PC Act Section 19 prior sanction nahi tha trial start hone ke time public servant ke against, trial vitiated hota hai latest SC view"
  "WC4|supremecourt|GST CGST Section 69 arrest power, Customs Act Section 132 prosecution, ED PMLA ke saath overlap, latest SC interpretation"
)

declare -a JOB_IDS=()

for entry in "${QUERIES[@]}"; do
  IFS='|' read -r LABEL DOCTYPE QUERY <<< "$entry"
  echo "═══════════════════════════════════════════════════════════════"
  echo "$LABEL  ($DOCTYPE)"
  echo "Query: $QUERY"
  echo "═══════════════════════════════════════════════════════════════"
  JID=$(curl -s -X POST -H "Content-Type: application/json" \
    -d "{\"scope\":{\"keywords\":\"$QUERY\",\"doctype\":\"$DOCTYPE\",\"max_results\":5}}" \
    "$API/api/cases/$SID/start-research" | python3 -c "import sys,json;print(json.load(sys.stdin)['jobId'])")
  echo "  jobId=$JID"
  T0=$(date +%s)
  while true; do
    STATUS=$(curl -s "$API/api/cases/$SID/research/$JID" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['status'])")
    META=$(curl -s "$API/api/cases/$SID/research/$JID" | python3 -c "import sys,json;d=json.load(sys.stdin);js=d.get('judgments',[]) or [];app=sum(1 for j in js if j.get('verdict')=='APPLICABLE');tan=sum(1 for j in js if j.get('verdict')=='TANGENTIAL');inapp=sum(1 for j in js if j.get('verdict')=='INAPPLICABLE');pen=sum(1 for j in js if j.get('verdict')=='pending');print(f'{len(js)} | {app}A {tan}T {inapp}I {pen}p')")
    ELAPSED=$(( $(date +%s) - T0 ))
    echo "  t+${ELAPSED}s  $STATUS  $META"
    if [[ "$STATUS" == "done" || "$STATUS" == "failed" ]]; then break; fi
    sleep 20
  done

  # Print summary
  curl -s "$API/api/cases/$SID/research/$JID" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print()
print(f'  summary: {(d.get(\"summary\") or \"\")[:200]}')
print()
print(f'  Top APPLICABLE judgments:')
for j in d.get('judgments', []):
    if j.get('verdict') != 'APPLICABLE': continue
    ix = 'IDX' if j.get('indexed') else '-'
    print(f\"    ✅ tid={j.get('tid')} | {ix} | {j.get('court','?')[:18]} {j.get('date','?')[:10]}\")
    print(f\"       {(j.get('title','?'))[:80]}\")
    print(f\"       reason: {(j.get('verdict_reason','') or '')[:140]}\")
"
  echo ""
  JOB_IDS+=("$LABEL=$JID")
  sleep 5
done

echo "═══════════════════════════════════════════════════════════════"
echo "OVERALL"
echo "═══════════════════════════════════════════════════════════════"
echo "Case ID: $SID"
echo "Job IDs:"
for entry in "${JOB_IDS[@]}"; do
  echo "  $entry"
done
