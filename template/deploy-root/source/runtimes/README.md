# Runtimes

This directory contains workspace initialization templates published to `runtime/`.

Included runtimes:

- `micro-learning/`
  - Short teaching loop runtime with `learn` / `plan` / `eval` / `research` agents
  - Template-adjusted to use `platform/openai-default` only
- `vibe-coding/`
  - OpenCode-style coding runtime with `build` / `plan` plus `general` / `explore` subagents
  - Good fit for repository-oriented coding workflows

Notes:

- Runtimes initialize new workspaces. They are not used as the active execution copy at run time.
- If you want additional runtime presets, add more subdirectories here.
