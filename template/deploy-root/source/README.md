# source

This directory is the local source of truth for data published from your deploy root into object storage.

After editing anything here, run:

```bash
cd /absolute/path/to/oah-deploy-root
python3 ./scripts/sync_to_minio.py --delete
```

## Mapping

| Local directory | Bucket prefix | Purpose |
| --- | --- | --- |
| `workspaces/` | `workspace/` | Workspace runtime data |
| `runtimes/` | `runtime/` | Workspace initialization templates |
| `models/` | `model/` | Platform model config YAML files |
| `tools/` | `tool/` | Tool config and tool server definitions |
| `skills/` | `skill/` | Reusable skill packages |

## Notes

- This deploy root ships with its own sync script at `scripts/sync_to_minio.py`, so it can be used outside the repository.
- If you are still working from the main OAH repository, `OAH_DEPLOY_ROOT=/absolute/path/to/oah-deploy-root pnpm storage:sync` remains equivalent for readonly prefixes.
- `pnpm storage:sync` syncs readonly prefixes by default and skips `source/workspaces` unless you pass `--include-workspaces`.
- The bundled runtime template expects a platform model named `openai-default`.
- Empty directories are fine. Add only the models, tools, skills, and workspaces you actually need.
