#!/bin/bash
# gaozhong.online — Scanner test harness
# Usage: bash test-scanner.sh <session_id>
# Runs scanner on a paper session and outputs results

SESSION_ID=${1:-""}
if [ -z "$SESSION_ID" ]; then
  echo "Usage: bash test-scanner.sh <session_id>"
  echo "Available sessions:"
  ls /app/data/papers/ | head -20
  exit 1
fi

SESSION_DIR="/app/data/papers/$SESSION_ID"
if [ ! -d "$SESSION_DIR" ]; then
  echo "❌ Session not found: $SESSION_ID"
  exit 1
fi

PAGES=$(ls "$SESSION_DIR"/page_*.jpg "$SESSION_DIR"/page_*.png 2>/dev/null | sort)
PAGE_COUNT=$(echo "$PAGES" | wc -l)

echo "═══════════════════════════════════════"
echo "📋 Test: $SESSION_ID ($PAGE_COUNT pages)"
echo "═══════════════════════════════════════"
echo ""

# Call the scanner API
RESULT=$(curl -s --max-time 300 http://localhost:3001/paper/test-scan \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\": \"$SESSION_ID\"}" 2>/dev/null)

if [ -z "$RESULT" ]; then
  echo "❌ No response from API"
  exit 1
fi

echo "$RESULT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(f'Engine: {d.get(\"engine\", \"?\")}')
    print(f'Pages: {d.get(\"pages\", \"?\")}')
    print(f'Total questions: {d.get(\"totalQuestions\", \"?\")}')
    print(f'Total errors: {d.get(\"totalErrors\", \"?\")}')
    print(f'Time: {d.get(\"totalTime\", \"?\")}s')
    print()
    questions = d.get('questions', [])
    if questions:
        print('Questions:')
        for q in questions:
            qn = q.get('questionNumber', '?')
            qt = q.get('questionType', '?')
            text = (q.get('questionText') or '')[:60]
            err = '❌' if q.get('isError') else '✅'
            page = q.get('pageIndex', '?')
            print(f'  Q{qn} (P{page}) [{qt}] {err} {text}')
    else:
        print('No questions found')
    
    # Per-page stats
    pageResults = d.get('pageResults', [])
    if pageResults:
        print()
        print('Per-page:')
        for pr in pageResults:
            print(f'  Page {pr.get(\"pageIndex\")}: {pr.get(\"totalQuestions\",0)}q, {pr.get(\"totalErrors\",0)}err, engine={pr.get(\"engine\",\"?\")}')
except Exception as e:
    print(f'Parse error: {e}')
    print(sys.stdin.read()[:500])
" 2>/dev/null

echo ""
echo "═══════════════════════════════════════"
