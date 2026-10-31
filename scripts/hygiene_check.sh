#!/usr/bin/env bash
set -euo pipefail

# hygiene_check.sh — Repo hygiene scan for tracked-eligible files.
#
# Enforces the project git-hygiene rules (documented in the project AGENTS.md contract):
#   - no local paths, cloud-account mount labels, real tailnet names, or device aliases in tracked-eligible files
#   - no denylisted private identifiers in staged files or commit messages
#   - no references to ../data.md or sibling data inventory paths in src/, tests/, configs/
#   - git diff --check passes
#   - every file and directory name is storable on Windows (no < > : " | ? * \\, trailing dot/space, reserved names)
#
# Warns (does not fail) on:
#   - AI tool name mentions in tracked-eligible files (deferred pre-public scrub)
#
# Usage:
#   scripts/hygiene_check.sh              # scan the whole repo
#   scripts/hygiene_check.sh --staged     # scan only staged paths (pre-commit)
#   scripts/hygiene_check.sh --message FILE  # scan a commit-msg file (commit-msg hook)
#   scripts/hygiene_check.sh --controls   # control-file integrity only (private do/ surface)
#
# Exit codes:
#   0 = pass (possibly with warnings)
#   1 = hygiene violation found
#   2 = invocation error
#
# Project-specific tuning (optional):
#   Set HYGIENE_SCAN_ROOTS to override the default tracked-eligible source roots.
#   Set HYGIENE_SIBLING_PROJECTS to scan additional repo roots for cache leaks.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="repo"
MSG_FILE=""
if [[ "${1:-}" == "--staged" ]]; then
  MODE="staged"
elif [[ "${1:-}" == "--message" ]]; then
  MODE="message"
  MSG_FILE="${2:-}"
  [[ -n "$MSG_FILE" && -f "$MSG_FILE" ]] || { echo "hygiene_check: --message requires a commit-msg file" >&2; exit 2; }
elif [[ "${1:-}" == "--controls" ]]; then
  # Control-file integrity. These files are gitignored, so the staged scan below
  # can never see them — this is the only path that checks them.
  if [[ -f scripts/control_check.py ]]; then
    exec python3 scripts/control_check.py "$ROOT"
  fi
  echo "hygiene_check: scripts/control_check.py missing; control gate cannot run." >&2
  exit 1
elif [[ -n "${1:-}" ]]; then
  echo "hygiene_check: unknown argument: $1" >&2
  exit 2
fi

# Gitignored denylist of identifiers that must never be committed. New projects
# receive it from INIT.md; existing projects may add it before public release.
# When present it must contain terms and a match is a FAIL.
DENYLIST=""
if [[ -f .private-denylist ]]; then
  DENYLIST=".private-denylist"
else
  for f in .*-private-denylist; do
    [[ -f "$f" ]] || continue
    DENYLIST="$f"
    break
  done
fi

# Keep this generic: personal values live only in the ignored denylist. The
# static checks catch common machine-specific path and network shapes even when
# code builds them from path fragments rather than one literal absolute path.
PRIVATE_PATTERN='(/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+|[A-Za-z]:[\\/]Users|CloudStorage/(OneDrive|GoogleDrive)(-[^/[:space:]]+)?|(OneDrive|GoogleDrive)-[^/[:space:]]*@|[A-Za-z0-9._-]+[.]ts[.]net)'

denylist_scan() {
  # $1 = label (path or "commit-message"); stdin = bytes to scan.
  # The program goes in -c so stdin stays the payload; a heredoc would replace
  # it, and the scan would read nothing and always pass.
  [[ -n "$DENYLIST" ]] || return 0
  python3 -c '
import sys
label = sys.argv[2]
terms = [
    line.strip().lower().encode()
    for line in open(sys.argv[1], encoding="utf-8")
    if line.strip() and not line.startswith("#")
]
if not terms:
    sys.exit("hygiene_check: FAIL — denylist exists but has no terms")
data = sys.stdin.buffer.read().lower()
if any(term in data for term in terms):
    sys.exit(f"hygiene_check: FAIL — denylisted identifier in {label}")
' "$DENYLIST" "$1"
}

if [[ "$MODE" == "message" ]]; then
  if grep -nE "$PRIVATE_PATTERN" "$MSG_FILE" >/dev/null; then
    echo "hygiene_check: FAIL — private identifier in commit message" >&2
    exit 1
  fi
  if ! denylist_scan "commit-message" < "$MSG_FILE"; then
    exit 1
  fi
  echo "hygiene_check: pass"
  exit 0
fi

# Tracked-eligible source roots. Override via HYGIENE_SCAN_ROOTS env var
# if your project uses a different layout.
SCAN_ROOTS=(${HYGIENE_SCAN_ROOTS:-src scripts config configs tests})
TOP_LEVEL_FILES=(README.md CITATION.cff pyproject.toml setup.py setup.cfg)

# Sibling project roots to also scan for cache leaks (space-separated).
SIBLING_PROJECTS=(${HYGIENE_SIBLING_PROJECTS:-})

# Scan glob extensions
SCAN_GLOBS=("*.py" "*.md" "*.yml" "*.yaml" "*.toml" "*.sh" "*.ps1" "*.cfg" "*.ini")

violations=0
warnings=0

gather_files() {
  if [[ "$MODE" == "staged" ]]; then
    git diff --cached --name-only --diff-filter=ACMR 2>/dev/null \
      | while read -r f; do
          [[ -z "$f" ]] && continue
          case "$f" in
            do/*|docs/*|var/*|data/*|outputs/*|dist/*|.git/*) continue ;;
          esac
          for pat in "${SCAN_GLOBS[@]}"; do
            # shellcheck disable=SC2053
            if [[ "$f" == $pat ]]; then echo "$f"; break; fi
          done
        done
  else
    local roots=()
    for r in "${SCAN_ROOTS[@]}"; do [[ -e "$r" ]] && roots+=("$r"); done
    for f in "${TOP_LEVEL_FILES[@]}"; do [[ -f "$f" ]] && roots+=("$f"); done
    [[ ${#roots[@]} -eq 0 ]] && return 0
    # Tracked plus untracked-but-not-ignored files: gitignored device-local material is never committable.
    git ls-files --cached --others --exclude-standard -- "${roots[@]}" \
      | while read -r f; do
          for pat in "${SCAN_GLOBS[@]}"; do
            # shellcheck disable=SC2053
            if [[ "$f" == $pat ]]; then echo "$f"; break; fi
          done
        done
  fi
}

# Fail closed: repo mode lists files through git, so it must be able to run git here.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "hygiene_check: not a git work tree" >&2; exit 2; }

# Staged mode scans the staged blob (what the commit will contain), never the working file, which may differ.
has_file() { if [[ "$MODE" == "staged" ]]; then git cat-file -e ":$1" 2>/dev/null; else [[ -f "$1" ]]; fi; }
file_bytes() { if [[ "$MODE" == "staged" ]]; then git cat-file blob ":$1"; else cat -- "$1"; fi; }

# Read into array; uses while-read to stay Bash 3.2 compatible.
FILES=()
while IFS= read -r line; do FILES+=("$line"); done < <(gather_files)

# --- Check 1: private local identifiers (FAIL) ---
fail_paths=""
for f in ${FILES[@]+"${FILES[@]}"}; do
  has_file "$f" || continue
  if hits="$(file_bytes "$f" | grep -nE "$PRIVATE_PATTERN" 2>/dev/null)"; then
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      [[ "$f" == "scripts/hygiene_check.sh" && "$line" == *"PRIVATE_PATTERN="* ]] && continue
      fail_paths+="${f}:${line}"$'\n'
    done <<< "$hits"
  fi
done

if [[ -n "$fail_paths" ]]; then
  echo "hygiene_check: FAIL — private local identifier in tracked-eligible files:" >&2
  printf '%s' "$fail_paths" >&2
  echo "  Fix: use repository-relative paths and synthetic device/network examples." >&2
  violations=$((violations + 1))
fi

if [[ -n "$DENYLIST" ]]; then
  for f in ${FILES[@]+"${FILES[@]}"}; do
    has_file "$f" || continue
    if ! file_bytes "$f" | denylist_scan "$f"; then
      violations=$((violations + 1))
      break
    fi
  done
fi

# --- Check 2: ../data.md or sibling-inventory references in source code (FAIL) ---
fail_datamd=""
for f in ${FILES[@]+"${FILES[@]}"}; do
  has_file "$f" || continue
  case "$f" in
    src/*|tests/*|configs/*)
      if hits="$(file_bytes "$f" | grep -nE '(/|\.\./)data\.md\b' 2>/dev/null)"; then
        while IFS= read -r line; do
          [[ -z "$line" ]] && continue
          fail_datamd+="${f}:${line}"$'\n'
        done <<< "$hits"
      fi
      ;;
  esac
done

if [[ -n "$fail_datamd" ]]; then
  echo "hygiene_check: FAIL — sibling data inventory (data.md) referenced in source/tests/configs:" >&2
  printf '%s' "$fail_datamd" >&2
  echo "  Fix: drop the data.md reference; the inventory is a coordination doc, not a code input." >&2
  violations=$((violations + 1))
fi

# --- Check 3: AI tool name mentions in tracked-eligible files (WARN) ---
warn_ai=""
for f in ${FILES[@]+"${FILES[@]}"}; do
  has_file "$f" || continue
  if hits="$(file_bytes "$f" | grep -niE '\b(codex|claude|gpt[- ]?pro|gpt-?5|openai|anthropic|\borca\b|\bmako\b|\bdairy\b|\btandy\b)\b' 2>/dev/null)"; then
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      [[ "$f" == "scripts/hygiene_check.sh" && "$line" == *"grep -niE"* ]] && continue
      warn_ai+="${f}:${line}"$'\n'
    done <<< "$hits"
  fi
done

if [[ -n "$warn_ai" ]]; then
  ai_count="$(printf '%s' "$warn_ai" | grep -c .)"
  echo "hygiene_check: WARN — ${ai_count} AI/tool-name mention(s) in tracked-eligible files (deferred pre-public scrub):" >&2
  printf '%s' "$warn_ai" | head -20 >&2
  if [[ "$ai_count" -gt 20 ]]; then
    echo "  ... and $((ai_count - 20)) more." >&2
  fi
  warnings=$((warnings + 1))
fi

# --- Check 5: Windows-portable file names across the synced project tree (FAIL) ---
# Scans names only (never contents) and skips regenerable trees the mesh ignores.
bad_names=()
while IFS= read -r f; do bad_names+=("$f"); done < <(
  find . -mindepth 1 \( -name .git -o -name node_modules -o -name target -o -name 'target-*' -o -name build \
       -o -name dist -o -name .gradle -o -name .worktrees -o -name '*venv*' -o -name __pycache__ \
       -o -name .cache -o -name '._*' \) -prune -o \
    \( -name '*[<>:"|?*\\]*' -o -name '*.' -o -name '* ' \
       -o -iname 'CON' -o -iname 'PRN' -o -iname 'AUX' -o -iname 'NUL' \
       -o -iname 'CON.*' -o -iname 'PRN.*' -o -iname 'AUX.*' -o -iname 'NUL.*' \
       -o -iname 'COM[1-9]' -o -iname 'LPT[1-9]' -o -iname 'COM[1-9].*' -o -iname 'LPT[1-9].*' \) -print 2>/dev/null
)
if [[ ${#bad_names[@]} -gt 0 ]]; then
  echo "hygiene_check: FAIL — ${#bad_names[@]} name(s) Windows cannot store (keep IDs like D001:W001 in contents; use D001-W001 in paths):" >&2
  printf '  %s\n' "${bad_names[@]:0:20}" >&2
  violations=$((violations + 1))
fi

# --- Check 4: git diff --check (FAIL); staged mode checks the index (--cached) ---
if [[ "$MODE" == "staged" ]]; then
  if ! git diff --cached --check 2>/dev/null; then
    echo "hygiene_check: FAIL — git diff --cached --check reported whitespace/conflict markers in staged content." >&2
    violations=$((violations + 1))
  fi
else
  if ! git diff --check 2>/dev/null; then
    echo "hygiene_check: FAIL — git diff --check reported whitespace/conflict markers." >&2
    violations=$((violations + 1))
  fi
fi

# (Repo-local .venv/cache directories are no longer policed — they're ignored by
# git, Syncthing, rclone, and remrun, so they never propagate.)

if [[ "$violations" -gt 0 ]]; then
  echo "hygiene_check: FAIL ($violations violation(s), $warnings warning(s))" >&2
  exit 1
fi

if [[ "$warnings" -gt 0 ]]; then
  echo "hygiene_check: pass with $warnings warning(s)"
else
  echo "hygiene_check: pass"
fi
