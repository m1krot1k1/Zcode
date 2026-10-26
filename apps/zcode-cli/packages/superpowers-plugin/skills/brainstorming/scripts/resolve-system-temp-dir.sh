#!/usr/bin/env bash
# Печатает системный temp-каталог в формате пути, который понимает текущий Bash.
# Windows Node возвращает native drive path, поэтому в Git Bash нужен cygpath.
resolve_system_temp_dir() {
  local temp_dir
  temp_dir="$(node -e 'process.stdout.write(require("node:os").tmpdir())')" || return 1

  # Native Node on Windows returns a drive-letter path; Git Bash needs its POSIX form.
  if [[ "$temp_dir" =~ ^[A-Za-z]:\\ ]]; then
    command -v cygpath >/dev/null 2>&1 || return 1
    temp_dir="$(cygpath -u "$temp_dir")" || return 1
  fi

  [[ -n "$temp_dir" && -d "$temp_dir" ]] || return 1
  (cd "$temp_dir" && pwd -P)
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  resolve_system_temp_dir
fi
