# Sourced in an owned terminal startup or after an explicit manual action. It
# wraps this shell's hooks/default submit keys, never rc files/history settings.
if [ -z "${BASH_VERSION-}" ]; then
  printf '\033]7777;AWB;@AWB_NONCE@;X\007'
  return 1
fi
if [[ $- != *i* || ${BASH_VERSINFO[0]} -lt 4 || ( ${BASH_VERSINFO[0]} -eq 4 && ${BASH_VERSINFO[1]} -lt 4 ) || -n ${__awb_shell_nonce-} ]]; then
  builtin printf '\033]7777;AWB;@AWB_NONCE@;X\007'
  return 1
fi
for __awb_shell_var in PS0 PS1 PROMPT_COMMAND; do
  if [[ $(builtin declare -p "$__awb_shell_var" 2>/dev/null) =~ ^declare\ -[^\ ]*r ]]; then
    builtin printf '\033]7777;AWB;@AWB_NONCE@;X\007'
    return 1
  fi
done
# Wrap only known accept-line bindings. Never execute or replace an unknown
# user macro, and never change the remote shell's history/privacy settings.
if [[ ! -o emacs && ! -o vi ]]; then
  builtin printf '\033]7777;AWB;@AWB_NONCE@;X\007'
  return 1
fi
for __awb_shell_map in emacs-standard vi-insert vi-command; do
  __awb_shell_bindings=$'\n'$(builtin bind -m "$__awb_shell_map" -p 2>/dev/null)$'\n'
  __awb_shell_other_bindings=$(builtin bind -m "$__awb_shell_map" -s 2>/dev/null; builtin bind -m "$__awb_shell_map" -X 2>/dev/null)
  if [[ $__awb_shell_bindings != *$'\n"\\C-m": accept-line\n'* || $__awb_shell_bindings != *$'\n"\\C-j": accept-line\n'* || "$__awb_shell_bindings$__awb_shell_other_bindings" == *'"\e[999;'* ]]; then
    builtin printf '\033]7777;AWB;@AWB_NONCE@;X\007'
    return 1
  fi
  while IFS= builtin read -r __awb_shell_binding; do
    [[ $__awb_shell_binding == '"'*'": '* ]] || continue
    __awb_shell_key=${__awb_shell_binding%%\":*}; __awb_shell_key=${__awb_shell_key#\"}
    [[ -n $__awb_shell_key ]] || continue
    # Readline keeps vi's native lone-Escape fallback when a CSI sequence is
    # added; this known default is not an unknown user prefix binding.
    [[ $__awb_shell_map != vi-insert || $__awb_shell_binding != '"\e": vi-movement-mode' ]] || continue
    if [[ '\e[999;1~' == "$__awb_shell_key"* || '\e[999;2~' == "$__awb_shell_key"* || $__awb_shell_key == '\e[999;1~'* || $__awb_shell_key == '\e[999;2~'* ]]; then
      builtin printf '\033]7777;AWB;@AWB_NONCE@;X\007'
      return 1
    fi
  done <<< "$__awb_shell_bindings$__awb_shell_other_bindings"
done
__awb_shell_nonce='@AWB_NONCE@'
__awb_shell_original_ps0=${PS0-}
__awb_shell_original_ps1=${PS1-}
__awb_shell_wrapped_ps1=''
__awb_shell_prompt_serial=0
__awb_shell_capture_open=0
__awb_shell_captured=0
__awb_shell_text=''
if [[ $(builtin declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then
  __awb_shell_original_pc=("${PROMPT_COMMAND[@]}")
else
  __awb_shell_original_pc=("${PROMPT_COMMAND-}")
fi
__awb_shell_emit() { builtin printf '\033]7777;AWB;%s;%s\007' "$__awb_shell_nonce" "$1"; }
__awb_shell_ignored() {
  builtin local __awb_pattern __awb_row __awb_previous='' __awb_patterns
  # Ambiguous escaping/compound history substitutions fail closed. Ordinary
  # anchored glob patterns and the explicit previous-line '&' rule are kept.
  [[ ${HISTIGNORE-} != *'\:'* && ${HISTIGNORE-} != *$'\n'* ]] || return 0
  IFS=: builtin read -r -a __awb_patterns <<< "${HISTIGNORE-}"
  for __awb_pattern in "${__awb_patterns[@]}"; do
    [[ -n $__awb_pattern ]] || continue
    if [[ $__awb_pattern == '&' ]]; then
      __awb_row=$(HISTTIMEFORMAT= builtin history 1)
      if [[ $__awb_row =~ ^[[:space:]]*([0-9]+)[\ ][\ ](.*)$ ]]; then __awb_previous=${BASH_REMATCH[2]}; fi
      [[ $1 != "$__awb_previous" ]] || return 0
    elif [[ $__awb_pattern == *'&'* ]]; then
      return 0
    elif [[ $1 == $__awb_pattern ]]; then
      return 0
    fi
  done
  return 1
}
__awb_shell_capture() {
  builtin local __awb_status=$? __awb_line __awb_event __awb_substitution LC_ALL=C
  __awb_shell_captured=0
  __awb_shell_text=''
  # Close the prompt's gate before accept-line. PS2/read -e callbacks then only
  # invalidate a pending fragment; they never read or retain their input.
  [[ $__awb_shell_capture_open -eq 1 ]] || return "$__awb_status"
  __awb_shell_capture_open=0
  [[ -o history ]] || return "$__awb_status"
  __awb_line=${READLINE_LINE-}
  [[ ${#__awb_line} -gt 0 && ${#__awb_line} -le 4096 && $__awb_line != ' '* && $__awb_line != $'\t'* && $__awb_line != *$'\n'* && $__awb_line != *$'\r'* ]] || return "$__awb_status"
  # Readline runs before history expansion. Do not mislabel !!/^ substitutions
  # as an executed command or expand/eval user input ourselves.
  __awb_event=${histchars-'!^#'}; __awb_substitution=${__awb_event:1:1}; __awb_event=${__awb_event:0:1}
  if [[ -o histexpand ]]; then
    [[ -z $__awb_event || $__awb_line != *"$__awb_event"* ]] || return "$__awb_status"
    [[ -z $__awb_substitution || $__awb_line != "$__awb_substitution"* ]] || return "$__awb_status"
  fi
  __awb_shell_ignored "$__awb_line" && return "$__awb_status"
  __awb_shell_text=$__awb_line
  __awb_shell_captured=1
  return "$__awb_status"
}
__awb_shell_before() {
  __awb_shell_emit C
  # PS0 runs once only after Bash accepts a complete submitted command. Its
  # source is the exact Readline submission, never a stale history item.
  [[ $__awb_shell_captured -eq 1 ]] || return 0
  builtin local __awb_text="$__awb_shell_text" __awb_hex='' __awb_byte __awb_i LC_ALL=C
  for ((__awb_i=0; __awb_i<${#__awb_text}; __awb_i++)); do
    builtin printf -v __awb_byte '%02x' "'${__awb_text:__awb_i:1}"
    __awb_hex+=$__awb_byte
  done
  __awb_shell_emit "E;$__awb_hex"
}
__awb_shell_restore_status() { return "$1"; }
__awb_shell_prompt() {
  builtin local __awb_status=$? __awb_pc __awb_pc_status
  __awb_shell_emit D
  __awb_pc_status=$__awb_status
  for __awb_pc in "${__awb_shell_original_pc[@]}"; do
    __awb_shell_restore_status "$__awb_pc_status"
    builtin eval -- "$__awb_pc"
    __awb_pc_status=$?
  done
  if [[ $PS1 != "$__awb_shell_wrapped_ps1" ]]; then __awb_shell_original_ps1=$PS1; fi
  # Only PROMPT_COMMAND starts a new prompt. Readline may redraw this exact PS1
  # during bind -x, resize or history search without completing any command.
  __awb_shell_prompt_serial=$((__awb_shell_prompt_serial + 1))
  __awb_shell_wrapped_ps1="\[\e]7777;AWB;$__awb_shell_nonce;A;$__awb_shell_prompt_serial\a\]$__awb_shell_original_ps1\[\e]7777;AWB;$__awb_shell_nonce;B;$__awb_shell_prompt_serial\a\]"
  PS1=$__awb_shell_wrapped_ps1
  __awb_shell_captured=0
  __awb_shell_text=''
  __awb_shell_capture_open=1
  return "$__awb_status"
}
__awb_shell_install_bindings() {
  builtin local __awb_map
  for __awb_map in emacs-standard vi-insert vi-command; do
    builtin bind -m "$__awb_map" -x '"\e[999;1~":__awb_shell_capture' &&
      builtin bind -m "$__awb_map" '"\e[999;2~":accept-line' &&
      builtin bind -m "$__awb_map" '"\C-m":"\e[999;1~\e[999;2~"' &&
      builtin bind -m "$__awb_map" '"\C-j":"\e[999;1~\e[999;2~"' || return 1
  done
}
if ! __awb_shell_install_bindings; then
  for __awb_shell_map in emacs-standard vi-insert vi-command; do
    builtin bind -m "$__awb_shell_map" '"\C-m":accept-line'
    builtin bind -m "$__awb_shell_map" '"\C-j":accept-line'
    builtin bind -m "$__awb_shell_map" -r '\e[999;1~'
    builtin bind -m "$__awb_shell_map" -r '\e[999;2~'
  done
  __awb_shell_emit X
  return 1
fi
PS0='$(__awb_shell_before)'"$__awb_shell_original_ps0"
builtin unset PROMPT_COMMAND
PROMPT_COMMAND=__awb_shell_prompt
__awb_shell_emit R
