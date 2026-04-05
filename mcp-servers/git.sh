#!/bin/sh
# Built-in git MCP server for smolvm sandboxes.
# Runs inside a VM — JSON-RPC 2.0 over newline-delimited stdio.
# Requires: sh, jq, git

WORKSPACE="${WORKSPACE:-/workspace}"

TOOLS='[{"name":"git_status","description":"Get repository status: current branch, changed files, clean state","inputSchema":{"type":"object","properties":{"path":{"type":"string","description":"Repository path (default: /workspace)"}}}},{"name":"git_diff","description":"Show diff of working tree or staged changes","inputSchema":{"type":"object","properties":{"path":{"type":"string","description":"Repository path"},"staged":{"type":"boolean","description":"Show staged changes (--cached)"},"file":{"type":"string","description":"Diff a specific file"}}}},{"name":"git_log","description":"Show commit history","inputSchema":{"type":"object","properties":{"path":{"type":"string","description":"Repository path"},"limit":{"type":"number","description":"Max entries (default: 20)"},"file":{"type":"string","description":"Log for a specific file"}}}},{"name":"git_commit","description":"Stage files and create a commit","inputSchema":{"type":"object","properties":{"message":{"type":"string","description":"Commit message"},"files":{"type":"array","items":{"type":"string"},"description":"Files to stage"},"all":{"type":"boolean","description":"Stage all changes"},"path":{"type":"string","description":"Repository path"}},"required":["message"]}},{"name":"git_branch","description":"List, create, or switch branches","inputSchema":{"type":"object","properties":{"action":{"type":"string","enum":["list","create","switch"],"description":"Branch action"},"name":{"type":"string","description":"Branch name"},"path":{"type":"string","description":"Repository path"}},"required":["action"]}},{"name":"git_stash","description":"Stash, pop, or list stashed changes","inputSchema":{"type":"object","properties":{"action":{"type":"string","enum":["push","pop","list"],"description":"Stash action"},"message":{"type":"string","description":"Stash message"},"path":{"type":"string","description":"Repository path"}},"required":["action"]}},{"name":"git_blame","description":"Show per-line blame annotation","inputSchema":{"type":"object","properties":{"file":{"type":"string","description":"File to blame"},"path":{"type":"string","description":"Repository path"}},"required":["file"]}}]'

# --- tool implementations ---

tool_git_status() {
  local cwd
  cwd=$(echo "$1" | jq -r '.path // empty')
  [ -z "$cwd" ] && cwd="$WORKSPACE"

  local branch changes
  branch=$(git -C "$cwd" branch --show-current 2>/dev/null)
  changes=$(git -C "$cwd" status --porcelain 2>/dev/null)

  local clean=true
  [ -n "$changes" ] && clean=false

  local changes_json
  changes_json=$(printf '%s' "$changes" | awk -F'' '{
    if($0=="") next;
    status=substr($0,1,2); gsub(/^ +| +$/,"",status);
    file=substr($0,4);
    printf "{\"status\":\"%s\",\"file\":\"%s\"}\n", status, file
  }' | jq -s '.')

  printf '{"branch":"%s","changes":%s,"clean":%s}' "$branch" "$changes_json" "$clean"
}

tool_git_diff() {
  local cwd staged file
  cwd=$(echo "$1" | jq -r '.path // empty')
  staged=$(echo "$1" | jq -r '.staged // false')
  file=$(echo "$1" | jq -r '.file // empty')
  [ -z "$cwd" ] && cwd="$WORKSPACE"

  local args="diff"
  [ "$staged" = "true" ] && args="$args --cached"
  [ -n "$file" ] && args="$args -- $file"

  local result
  result=$(git -C "$cwd" $args 2>&1)
  printf '%s' "$result" | jq -Rs '{diff: .}'
}

tool_git_log() {
  local cwd limit file
  cwd=$(echo "$1" | jq -r '.path // empty')
  limit=$(echo "$1" | jq -r '.limit // 20')
  file=$(echo "$1" | jq -r '.file // empty')
  [ -z "$cwd" ] && cwd="$WORKSPACE"

  local cmd="git -C $cwd log --max-count=$limit --format=%H%x00%an%x00%aI%x00%s"
  [ -n "$file" ] && cmd="$cmd -- $file"

  eval "$cmd" 2>/dev/null | awk -F'\0' '{printf "{\"hash\":\"%s\",\"author\":\"%s\",\"date\":\"%s\",\"subject\":\"%s\"}\n",$1,$2,$3,$4}' | jq -s '{entries: ., count: length}'
}

tool_git_commit() {
  local cwd msg files_json do_all
  cwd=$(echo "$1" | jq -r '.path // empty')
  msg=$(echo "$1" | jq -r '.message')
  files_json=$(echo "$1" | jq -r '.files // [] | .[]' 2>/dev/null)
  do_all=$(echo "$1" | jq -r '.all // false')
  [ -z "$cwd" ] && cwd="$WORKSPACE"

  if [ -n "$files_json" ]; then
    echo "$files_json" | while read -r f; do
      git -C "$cwd" add "$f" 2>/dev/null
    done
  elif [ "$do_all" = "true" ]; then
    git -C "$cwd" add -A 2>/dev/null
  fi

  local result
  result=$(git -C "$cwd" commit -m "$msg" 2>&1)
  local code=$?
  if [ $code -eq 0 ]; then
    printf '{"success":true,"output":%s}' "$(printf '%s' "$result" | jq -Rs '.')"
  else
    printf '{"success":false,"error":%s}' "$(printf '%s' "$result" | jq -Rs '.')"
  fi
}

tool_git_branch() {
  local cwd action name
  cwd=$(echo "$1" | jq -r '.path // empty')
  action=$(echo "$1" | jq -r '.action')
  name=$(echo "$1" | jq -r '.name // empty')
  [ -z "$cwd" ] && cwd="$WORKSPACE"

  case "$action" in
    list)
      local current
      current=$(git -C "$cwd" branch --show-current 2>/dev/null)
      local branches
      branches=$(git -C "$cwd" branch -a --format='%(refname:short) %(objectname:short)' 2>/dev/null | \
        awk '{printf "{\"name\":\"%s\",\"commit\":\"%s\"}\n",$1,$2}' | jq -s '.')
      printf '{"current":"%s","branches":%s}' "$current" "$branches"
      ;;
    create)
      local result
      result=$(git -C "$cwd" branch "$name" 2>&1)
      printf '{"created":"%s","output":%s}' "$name" "$(printf '%s' "$result" | jq -Rs '.')"
      ;;
    switch)
      local result
      result=$(git -C "$cwd" switch "$name" 2>&1)
      printf '{"switched":"%s","output":%s}' "$name" "$(printf '%s' "$result" | jq -Rs '.')"
      ;;
    *)
      printf '{"error":"Unknown branch action: %s"}' "$action"
      ;;
  esac
}

tool_git_stash() {
  local cwd action msg
  cwd=$(echo "$1" | jq -r '.path // empty')
  action=$(echo "$1" | jq -r '.action')
  msg=$(echo "$1" | jq -r '.message // empty')
  [ -z "$cwd" ] && cwd="$WORKSPACE"

  case "$action" in
    push)
      local cmd="git -C $cwd stash push"
      [ -n "$msg" ] && cmd="$cmd -m \"$msg\""
      local result
      result=$(eval "$cmd" 2>&1)
      printf '{"output":%s}' "$(printf '%s' "$result" | jq -Rs '.')"
      ;;
    pop)
      local result
      result=$(git -C "$cwd" stash pop 2>&1)
      printf '{"output":%s}' "$(printf '%s' "$result" | jq -Rs '.')"
      ;;
    list)
      local stashes
      stashes=$(git -C "$cwd" stash list 2>/dev/null | jq -R '.' | jq -s '.')
      printf '{"stashes":%s,"count":%s}' "$stashes" "$(echo "$stashes" | jq 'length')"
      ;;
    *)
      printf '{"error":"Unknown stash action: %s"}' "$action"
      ;;
  esac
}

tool_git_blame() {
  local cwd file
  cwd=$(echo "$1" | jq -r '.path // empty')
  file=$(echo "$1" | jq -r '.file')
  [ -z "$cwd" ] && cwd="$WORKSPACE"

  local result
  result=$(git -C "$cwd" blame --line-porcelain "$file" 2>&1)
  if [ $? -ne 0 ]; then
    printf '{"error":%s}' "$(printf '%s' "$result" | jq -Rs '.')"
    return
  fi

  # Parse porcelain blame — extract hash, author, line content
  printf '%s' "$result" | awk '
    /^[0-9a-f]{40}/ { hash=substr($1,1,8); lineno=$3 }
    /^author / { author=substr($0,8) }
    /^\t/ { content=substr($0,2); printf "{\"hash\":\"%s\",\"author\":\"%s\",\"line\":%d,\"content\":%s}\n", hash, author, lineno, content }
  ' | jq -Rs 'split("\n") | map(select(length>0)) | map(fromjson?) | {lines: ., count: length}'
}

# --- JSON-RPC dispatch ---
handle_message() {
  local msg="$1"
  local id method
  id=$(echo "$msg" | jq -r '.id // empty')
  method=$(echo "$msg" | jq -r '.method // empty')

  [ -z "$id" ] && return

  case "$method" in
    initialize)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"smolvm-git","version":"1.0.0"}}}\n' "$id"
      ;;
    tools/list)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":%s}}\n' "$id" "$TOOLS"
      ;;
    tools/call)
      local tool_name tool_args result is_error
      tool_name=$(echo "$msg" | jq -r '.params.name // empty')
      tool_args=$(echo "$msg" | jq -c '.params.arguments // {}')

      is_error=false
      case "$tool_name" in
        git_status)   result=$(tool_git_status "$tool_args") ;;
        git_diff)     result=$(tool_git_diff "$tool_args") ;;
        git_log)      result=$(tool_git_log "$tool_args") ;;
        git_commit)   result=$(tool_git_commit "$tool_args") ;;
        git_branch)   result=$(tool_git_branch "$tool_args") ;;
        git_stash)    result=$(tool_git_stash "$tool_args") ;;
        git_blame)    result=$(tool_git_blame "$tool_args") ;;
        *)            result="Unknown tool: $tool_name"; is_error=true ;;
      esac

      local escaped
      escaped=$(printf '%s' "$result" | jq -Rs '.')
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":%s}],"isError":%s}}\n' "$id" "$escaped" "$is_error"
      ;;
    *)
      printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"Method not found: %s"}}\n' "$id" "$method"
      ;;
  esac
}

while IFS= read -r line; do
  [ -z "$line" ] && continue
  handle_message "$line"
done
