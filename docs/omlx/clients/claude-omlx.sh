# Claude Code against the oMLX server on the Mac Studio, over the tailnet.
#
# On a tailnet device, in ~/.zshrc (or ~/.bashrc):
#
#   export OMLX_KEY='<a sub key made for this device>'
#   source ~/dev/eretzutz/dev/docs/omlx/clients/claude-omlx.sh
#
# then:
#
#   claude-omlx                                    # interactive
#   claude-omlx -p 'say hi'                        # one shot
#   OMLX_MODEL=gemma-4-31B-it-oQ4e-mtp claude-omlx  # another model
#   OMLX_HOST=steves-mac-studio claude-omlx        # by name, where MagicDNS resolves
#
# The variables are the ones `omlx launch claude` sets (oMLX 0.8.0,
# integrations/claude.py), with the host pointed at the tailnet instead of
# loopback. Notes on the less obvious ones:
#
#   ANTHROPIC_BASE_URL       no /v1 on the end; Claude Code adds /v1/messages itself
#   ANTHROPIC_AUTH_TOKEN     sent as "Authorization: Bearer"; ANTHROPIC_API_KEY is
#                            emptied so a real Anthropic key in the environment is
#                            never sent to oMLX
#   ANTHROPIC_DEFAULT_*      every tier and the subagents map to the one local model
#   CLAUDE_CODE_MAX_CONTEXT_TOKENS / CLAUDE_CODE_AUTO_COMPACT_WINDOW
#                            the model's real window (262,144 for all three models
#                            served today); compaction is measured against it
#   API_TIMEOUT_MS           50 minutes: a cold model has to load before it answers
#   --disallowedTools LSP    its schema arriving mid-session would invalidate the
#                            server's prompt cache and re-read the whole conversation

claude-omlx() {
  if [ -z "${OMLX_KEY:-}" ]; then
    echo "claude-omlx: export OMLX_KEY first (a sub key from the oMLX dashboard)" >&2
    return 1
  fi
  local host="${OMLX_HOST:-100.72.79.31}"
  local port="${OMLX_PORT:-8000}"
  local model="${OMLX_MODEL:-Qwen3.8-27B-oQ4e-mtp}"
  local window="${OMLX_CONTEXT:-262144}"

  ANTHROPIC_BASE_URL="http://$host:$port" \
  ANTHROPIC_AUTH_TOKEN="$OMLX_KEY" \
  ANTHROPIC_API_KEY= \
  ANTHROPIC_MODEL="$model" \
  ANTHROPIC_DEFAULT_OPUS_MODEL="$model" \
  ANTHROPIC_DEFAULT_SONNET_MODEL="$model" \
  ANTHROPIC_DEFAULT_HAIKU_MODEL="$model" \
  CLAUDE_CODE_SUBAGENT_MODEL="$model" \
  CLAUDE_CODE_MAX_CONTEXT_TOKENS="$window" \
  CLAUDE_CODE_AUTO_COMPACT_WINDOW="$window" \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  CLAUDE_CODE_ATTRIBUTION_HEADER=0 \
  API_TIMEOUT_MS=3000000 \
  claude --settings '{"useAutoModeDuringPlan":false}' --disallowedTools LSP "$@"
}
