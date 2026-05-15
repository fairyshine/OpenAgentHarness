# Deploy Root Template

This directory is the starter `OAH_DEPLOY_ROOT` for local development and first deployments.

It can also seed a local `OAH_HOME` directory. For local single-user daemon usage, the recommended default is:

```bash
export OAH_HOME="${OAH_HOME:-$HOME/.openagentharness}"
```

`OAH_DEPLOY_ROOT` is optional for local workflows; when it is unset, local scripts use `OAH_HOME`, then `~/.openagentharness`.

Suggested flow:

```bash
mkdir -p /absolute/path/to/oah-deploy-root
cp -R ./template/deploy-root/. /absolute/path/to/oah-deploy-root
export OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root
```

Before starting OAH, add at least one model YAML under `models/` that matches `llm.default_model` in `config/server.docker.yaml`.

For the bundled starter runtime, the expected platform model name is:

- `openai-default`

Then run:

```bash
python3 ./scripts/sync_to_minio.py --delete
pnpm local:up
pnpm dev:web
```

If this deploy root is copied outside the repository, `./scripts/sync_to_minio.py` still works on its own as long as Docker can run `amazon/aws-cli` and reach your object-storage endpoint.

## Layout

```text
.
  models/                  # Platform model config YAML files
  runtimes/                # Workspace initialization templates
  tools/                   # Tool config and tool server definitions
  skills/                  # Reusable skill packages
  workspaces/              # Optional managed workspace source
  config/
    daemon.yaml            # Local daemon profile: SQLite + embedded worker + local disk
    server.docker.yaml     # Docker Compose profile, using OAH_HOME by default or OAH_DEPLOY_ROOT when set
    kubernetes.server.yaml # K8S/Helm server.yaml profile source
```

Runtime state such as SQLite data, daemon logs, PID/token files, and generated compose configs should live beside this layout in `state/`, `logs/`, `run/`, and `.oah-local/`; those directories are not publishable source. When local API auth is enabled with `OAH_LOCAL_API_AUTH=1`, `run/token` is the bearer token used to protect non-public API routes.

Legacy deploy roots with assets under `source/` and `server.docker.yaml` at the root are still accepted by the local scripts.
