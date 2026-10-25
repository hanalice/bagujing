#!/usr/bin/env bash
set -euo pipefail
cd /home/alice/workspace/bagujing
{
  echo '===== 1. git status --short ====='
  git status --short
  echo '===== 2. git diff main --stat ====='
  git diff main --stat
  echo '===== 3. git diff main -- docs/security-ai-guard.md ====='
  git diff main -- docs/security-ai-guard.md
  echo '===== 4. git diff main -- docs/test_cases.md ====='
  git diff main -- docs/test_cases.md
  echo '===== 5. git diff main --name-only ====='
  git diff main --name-only
  echo '===== 6. cat untracked test ====='
  cat backend/src/tests/security-ai-guard-doc.test.js
  echo '===== 7. git log main..HEAD --oneline ====='
  git log main..HEAD --oneline || true
  echo '===== runtime code check ====='
  git diff main --name-only | grep -E 'ai-guard\.js|ai-auth\.ts|\.env' || echo 'NO_RUNTIME_MATCHES_IN_DIFF'
} > /tmp/s8-reviewer-git-out.txt 2>&1
echo DONE
