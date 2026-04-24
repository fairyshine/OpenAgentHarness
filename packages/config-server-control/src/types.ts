export interface ServerConfig {
  server: {
    host: string;
    port: number;
  };
  storage: {
    postgres_url?: string | undefined;
    redis_url?: string | undefined;
  };
  object_storage?: {
    provider: "s3";
    bucket: string;
    region: string;
    endpoint?: string | undefined;
    access_key?: string | undefined;
    secret_key?: string | undefined;
    session_token?: string | undefined;
    force_path_style?: boolean | undefined;
    workspace_backing_store?:
      | {
          enabled?: boolean | undefined;
          key_prefix?: string | undefined;
        }
      | undefined;
    mirrors?:
      | {
          paths?: Array<"runtime" | "model" | "tool" | "skill"> | undefined;
          sync_on_boot?: boolean | undefined;
          sync_on_change?: boolean | undefined;
          poll_interval_ms?: number | undefined;
          key_prefixes?:
            | {
                runtime?: string | undefined;
                model?: string | undefined;
                tool?: string | undefined;
                skill?: string | undefined;
              }
            | undefined;
        }
      | undefined;
    sync_on_boot?: boolean | undefined;
    sync_on_change?: boolean | undefined;
    poll_interval_ms?: number | undefined;
    managed_paths?: Array<"workspace" | "runtime" | "model" | "tool" | "skill"> | undefined;
    key_prefixes?:
      | {
          workspace?: string | undefined;
          runtime?: string | undefined;
          model?: string | undefined;
          tool?: string | undefined;
          skill?: string | undefined;
        }
      | undefined;
  };
  sandbox?: {
    provider?: "embedded" | "self_hosted" | "e2b" | undefined;
    fleet?:
      | {
          min_count?: number | undefined;
          max_count?: number | undefined;
          max_workspaces_per_sandbox?: number | undefined;
          ownerless_pool?: "shared" | "dedicated" | undefined;
        }
      | undefined;
    self_hosted?:
      | {
          base_url?: string | undefined;
          headers?: Record<string, string> | undefined;
        }
      | undefined;
    e2b?:
      | {
          base_url?: string | undefined;
          api_key?: string | undefined;
          domain?: string | undefined;
          template?: string | undefined;
          timeout_ms?: number | undefined;
          request_timeout_ms?: number | undefined;
          headers?: Record<string, string> | undefined;
        }
      | undefined;
  };
  paths: {
    workspace_dir: string;
    runtime_state_dir?: string | undefined;
    runtime_dir: string;
    model_dir: string;
    tool_dir: string;
    skill_dir: string;
  };
  workspace?: {
    materialization?: {
      idle_ttl_ms?: number | undefined;
      maintenance_interval_ms?: number | undefined;
    } | undefined;
  } | undefined;
  workers?: {
    embedded?: {
      min_count?: number | undefined;
      max_count?: number | undefined;
      scale_interval_ms?: number | undefined;
      idle_ttl_ms?: number | undefined;
      scale_up_window?: number | undefined;
      scale_down_window?: number | undefined;
      cooldown_ms?: number | undefined;
      reserved_capacity_for_subagent?: number | undefined;
    } | undefined;
    standalone?: {
      min_replicas?: number | undefined;
      max_replicas?: number | undefined;
      slots_per_pod?: number | undefined;
      ready_sessions_per_capacity_unit?: number | undefined;
      reserved_capacity_for_subagent?: number | undefined;
    } | undefined;
    controller?: {
      scale_interval_ms?: number | undefined;
      scale_up_window?: number | undefined;
      scale_down_window?: number | undefined;
      cooldown_ms?: number | undefined;
      scale_up_busy_ratio_threshold?: number | undefined;
      scale_up_max_ready_age_ms?: number | undefined;
      leader_election?:
        | {
            type?: "noop" | "kubernetes" | undefined;
            kubernetes?:
              | {
                  namespace?: string | undefined;
                  lease_name?: string | undefined;
                  api_url?: string | undefined;
                  token_file?: string | undefined;
                  ca_file?: string | undefined;
                  skip_tls_verify?: boolean | undefined;
                  lease_duration_ms?: number | undefined;
                  renew_interval_ms?: number | undefined;
                  retry_interval_ms?: number | undefined;
                  identity?: string | undefined;
                }
              | undefined;
          }
        | undefined;
      scale_target?:
        | {
            type?: "noop" | "kubernetes" | "docker_compose" | undefined;
            allow_scale_down?: boolean | undefined;
            kubernetes?:
              | {
                  namespace?: string | undefined;
                  deployment?: string | undefined;
                  label_selector?: string | undefined;
                  api_url?: string | undefined;
                  token_file?: string | undefined;
                  ca_file?: string | undefined;
                  skip_tls_verify?: boolean | undefined;
                }
              | undefined;
            docker_compose?:
              | {
                  compose_file?: string | undefined;
                  project_name?: string | undefined;
                  service?: string | undefined;
                  command?: string | undefined;
                  endpoint?: string | undefined;
                  auth_token?: string | undefined;
                  timeout_ms?: number | undefined;
                }
              | undefined;
          }
        | undefined;
    } | undefined;
  } | undefined;
  llm: {
    default_model: string;
  };
}
