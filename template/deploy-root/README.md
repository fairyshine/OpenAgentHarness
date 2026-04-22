# Deploy Root Template

This directory is the starter `OAH_DEPLOY_ROOT` for local development and first deployments.

Suggested flow:

```bash
mkdir -p /absolute/path/to/oah-deploy-root
cp -R ./template/deploy-root/. /absolute/path/to/oah-deploy-root
export OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root
```

Before starting OAH, add at least one model YAML under `source/models/` that matches `llm.default_model` in `server.docker.yaml`.

For the bundled starter runtime, the expected platform model name is:

- `openai-default`

Then run:

```bash
python3 ./scripts/sync_to_minio.py --delete
pnpm local:up
pnpm dev:web
```

If this deploy root is copied outside the repository, `./scripts/sync_to_minio.py` still works on its own as long as Docker can run `amazon/aws-cli` and reach your object-storage endpoint.
