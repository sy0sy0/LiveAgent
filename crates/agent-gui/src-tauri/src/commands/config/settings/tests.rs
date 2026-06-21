#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn open_memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        initialize_schema(&conn).expect("initialize schema");
        conn
    }

    fn table_columns(conn: &Connection, table: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("prepare table info");
        stmt.query_map([], |row| row.get::<_, String>(1))
            .expect("query table info")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect table columns")
    }

    #[test]
    fn initialize_schema_creates_all_tables() {
        let conn = open_memory_db();

        for table in [
            PROVIDER_SETTINGS_TABLE,
            SYSTEM_SETTINGS_TABLE,
            MCP_SETTINGS_TABLE,
            AGENT_PROMPT_TEMPLATES_TABLE,
            SSH_SETTINGS_TABLE,
            HOOK_SETTINGS_TABLE,
            CRON_SETTINGS_TABLE,
            CRON_EXECUTION_LOGS_TABLE,
            REMOTE_SETTINGS_TABLE,
            MEMORY_SETTINGS_TABLE,
            SSH_PROJECT_HOST_ASSOCIATIONS_TABLE,
            SSH_KNOWN_HOSTS_TABLE,
        ] {
            let exists = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![table],
                    |row| row.get::<_, i64>(0),
                )
                .expect("query sqlite_master");
            assert_eq!(exists, 1, "table {table} should exist");
        }
    }

    #[test]
    fn initialize_schema_creates_columnar_ssh_settings_table() {
        let conn = open_memory_db();
        let columns = table_columns(&conn, SSH_SETTINGS_TABLE);

        for column in [
            "host_id",
            "name",
            "description",
            "host",
            "port",
            "username",
            "auth_type",
            "password",
            "password_configured",
            "private_key",
            "private_key_path",
            "private_key_configured",
            "private_key_passphrase",
            "private_key_passphrase_configured",
            "proxy_json",
            "sort_index",
            "updated_at",
        ] {
            assert!(
                columns.iter().any(|item| item == column),
                "{SSH_SETTINGS_TABLE}.{column} should exist"
            );
        }
        assert!(
            !columns.iter().any(|item| item == "payload_json"),
            "{SSH_SETTINGS_TABLE}.payload_json should not exist"
        );
    }

    #[test]
    fn save_memory_persists_default_payload_and_sync_snapshot() {
        let mut conn = open_memory_db();
        let payload = json!({
            "organizerModel": {
                "customProviderId": "provider-a",
                "model": "gpt-5"
            },
            "summaryModel": {
                "customProviderId": "provider-a",
                "model": "gpt-5.4"
            }
        });

        save_memory(&mut conn, payload.clone()).expect("save memory settings");

        assert_eq!(
            load_memory(&conn).expect("load memory settings"),
            Some(payload.clone())
        );
        let snapshot =
            load_gateway_settings_sync_snapshot(&conn).expect("load gateway settings snapshot");
        assert_eq!(snapshot["memory"], payload);
    }

    #[test]
    fn normalize_remote_settings_repairs_single_slash_gateway_url() {
        let normalized = normalize_remote_settings_payload(RemoteSettingsPayload {
            enabled: true,
            gateway_url: " https:/agent.cnweb.org/ ".to_string(),
            grpc_port: 443,
            grpc_endpoint: " tcp.proxy.rlwy.net:12345/ ".to_string(),
            token: " agent-token-dev ".to_string(),
            agent_id: " mac-mini ".to_string(),
            auto_reconnect: true,
            heartbeat_interval: 30,
            enable_web_terminal: false,
            enable_web_ssh_terminal: false,
            enable_web_git: false,
            enable_web_tunnels: false,
        });

        assert_eq!(normalized.gateway_url, "https://agent.cnweb.org");
        assert_eq!(normalized.grpc_endpoint, "tcp.proxy.rlwy.net:12345");
        assert_eq!(normalized.token, "agent-token-dev");
        assert_eq!(normalized.agent_id, "mac-mini");
    }

    #[test]
    fn save_providers_persists_one_row_per_provider_and_preserves_order() {
        let mut conn = open_memory_db();
        save_providers(
            &mut conn,
            json!([
                { "id": "provider-b", "name": "B" },
                { "id": "provider-a", "name": "A" }
            ]),
        )
        .expect("save providers");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM provider_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count provider rows");
        let loaded = load_providers(&conn).expect("load providers");

        assert_eq!(row_count, 2);
        assert_eq!(
            loaded,
            Some(json!([
                { "id": "provider-b", "name": "B" },
                { "id": "provider-a", "name": "A" }
            ]))
        );
    }

    #[test]
    fn gateway_settings_snapshot_redacts_provider_api_keys() {
        let mut conn = open_memory_db();
        save_providers(
            &mut conn,
            json!([
                {
                    "id": "provider-a",
                    "name": "A",
                    "apiKey": "secret-key",
                    "apiKeyConfigured": false
                },
                {
                    "id": "provider-b",
                    "name": "B",
                    "apiKey": "",
                    "apiKeyConfigured": true
                }
            ]),
        )
        .expect("save providers");

        let snapshot =
            load_gateway_settings_sync_snapshot(&conn).expect("load gateway settings snapshot");
        assert_eq!(snapshot["customProviders"][0]["apiKey"], Value::Null);
        assert_eq!(snapshot["customProviders"][0]["apiKeyConfigured"], true);
        assert_eq!(snapshot["customProviders"][1]["apiKey"], Value::Null);
        assert_eq!(snapshot["customProviders"][1]["apiKeyConfigured"], true);
    }

    #[test]
    fn save_ssh_persists_hosts_and_redacts_sync_snapshot() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [
                    {
                        "id": "prod",
                        "name": "Production",
                        "description": "Primary production host",
                        "host": "prod.example.com",
                        "port": "2222",
                        "username": "deploy",
                        "authType": "privateKey",
                        "password": "ssh-password",
                        "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----",
                        "privateKeyPath": "~/.ssh/id_ed25519",
                        "privateKeyPassphrase": "key-passphrase",
                        "proxy": {
                            "type": "http",
                            "url": "http://127.0.0.1",
                            "port": "1080",
                            "username": "proxy-user",
                            "password": "proxy-password"
                        }
                    },
                    {
                        "id": "staging",
                        "name": "Staging",
                        "description": "",
                        "host": "staging.example.com",
                        "username": "ubuntu",
                        "authType": "password",
                        "passwordConfigured": true
                    }
                ],
                "projectHostAssociations": {
                    " /repo/project ": ["prod", "missing", "prod", "staging"],
                    "empty": ["missing"],
                    "  ": ["prod"]
                }
            }),
        )
        .expect("save ssh settings");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM ssh_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count ssh rows");
        let loaded = load_ssh(&conn).expect("load ssh settings");

        assert_eq!(row_count, 2);
        let stored = conn
            .query_row(
                "
                SELECT name, host, port, auth_type, private_key, private_key_passphrase, proxy_json
                FROM ssh_settings
                WHERE host_id = 'prod'
                ",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .expect("load stored ssh columns");
        assert_eq!(stored.0, "Production");
        assert_eq!(stored.1, "prod.example.com");
        assert_eq!(stored.2, 2222);
        assert_eq!(stored.3, "privateKey");
        assert_eq!(
            stored.4,
            "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----"
        );
        assert_eq!(stored.5, "key-passphrase");
        assert_eq!(
            parse_json(&stored.6, SSH_SETTINGS_TABLE).expect("parse proxy json"),
            json!({
                "type": "http",
                "url": "http://127.0.0.1",
                "port": 1080,
                "username": "proxy-user",
                "password": "proxy-password",
                "passwordConfigured": true
            })
        );
        assert_eq!(
            loaded,
            Some(json!({
                "hosts": [
                    {
                        "id": "prod",
                        "name": "Production",
                        "description": "Primary production host",
                        "host": "prod.example.com",
                        "port": 2222,
                        "username": "deploy",
                        "authType": "privateKey",
                        "password": "ssh-password",
                        "passwordConfigured": true,
                        "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----",
                        "privateKeyPath": "~/.ssh/id_ed25519",
                        "privateKeyConfigured": true,
                        "privateKeyPassphrase": "key-passphrase",
                        "privateKeyPassphraseConfigured": true,
                        "proxy": {
                            "type": "http",
                            "url": "http://127.0.0.1",
                            "port": 1080,
                            "username": "proxy-user",
                            "password": "proxy-password",
                            "passwordConfigured": true
                        }
                    },
                    {
                        "id": "staging",
                        "name": "Staging",
                        "description": "",
                        "host": "staging.example.com",
                        "port": 22,
                        "username": "ubuntu",
                        "authType": "password",
                        "password": "",
                        "passwordConfigured": true,
                        "privateKey": "",
                        "privateKeyPath": "",
                        "privateKeyConfigured": false,
                        "privateKeyPassphrase": "",
                        "privateKeyPassphraseConfigured": false,
                        "proxy": {
                            "type": "socks5",
                            "url": "",
                            "port": 0,
                            "username": "",
                            "password": "",
                            "passwordConfigured": false
                        }
                    }
                ],
                "projectHostAssociations": {
                    "/repo/project": ["prod", "staging"]
                }
            }))
        );

        let snapshot =
            load_gateway_settings_sync_snapshot(&conn).expect("load gateway settings snapshot");
        assert_eq!(snapshot["ssh"]["hosts"][0]["password"], Value::Null);
        assert_eq!(snapshot["ssh"]["hosts"][0]["privateKey"], Value::Null);
        assert_eq!(
            snapshot["ssh"]["hosts"][0]["privateKeyPassphrase"],
            Value::Null
        );
        assert_eq!(snapshot["ssh"]["hosts"][0]["passwordConfigured"], true);
        assert_eq!(snapshot["ssh"]["hosts"][0]["privateKeyConfigured"], true);
        assert_eq!(
            snapshot["ssh"]["hosts"][0]["privateKeyPassphraseConfigured"],
            true
        );
        assert_eq!(
            snapshot["ssh"]["hosts"][0]["proxy"]["password"],
            Value::Null
        );
        assert_eq!(
            snapshot["ssh"]["hosts"][0]["proxy"]["passwordConfigured"],
            true
        );
        assert_eq!(snapshot["ssh"]["hosts"][1]["password"], Value::Null);
        assert_eq!(snapshot["ssh"]["hosts"][1]["privateKey"], Value::Null);
        assert_eq!(
            snapshot["ssh"]["hosts"][1]["privateKeyPassphrase"],
            Value::Null
        );
        assert_eq!(snapshot["ssh"]["hosts"][1]["passwordConfigured"], true);
        assert_eq!(
            snapshot["ssh"]["hosts"][1]["privateKeyPassphraseConfigured"],
            false
        );
        assert_eq!(
            snapshot["ssh"]["hosts"][1]["proxy"]["password"],
            Value::Null
        );
        assert_eq!(
            snapshot["ssh"]["hosts"][1]["proxy"]["passwordConfigured"],
            false
        );
        assert_eq!(
            snapshot["ssh"]["projectHostAssociations"],
            json!({
                "/repo/project": ["prod", "staging"]
            })
        );
    }

    #[test]
    fn save_ssh_agent_host_clears_credential_secret_state() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [
                    {
                        "id": "agent-prod",
                        "name": "Agent Production",
                        "host": "prod.example.com",
                        "username": "deploy",
                        "authType": "agent",
                        "password": "old-password",
                        "passwordConfigured": true,
                        "privateKey": "old-key",
                        "privateKeyPath": "~/.ssh/id_rsa",
                        "privateKeyConfigured": true,
                        "privateKeyPassphrase": "old-passphrase",
                        "privateKeyPassphraseConfigured": true,
                        "proxy": {
                            "type": "http",
                            "url": "http://127.0.0.1",
                            "port": 8080,
                            "username": "proxy-user",
                            "password": "proxy-password"
                        }
                    }
                ]
            }),
        )
        .expect("save agent ssh settings");

        let loaded = load_ssh(&conn)
            .expect("load ssh settings")
            .expect("ssh settings should exist");
        let host = &loaded["hosts"][0];
        assert_eq!(host["authType"], "agent");
        assert_eq!(host["password"], "");
        assert_eq!(host["passwordConfigured"], false);
        assert_eq!(host["privateKey"], "");
        assert_eq!(host["privateKeyPath"], "");
        assert_eq!(host["privateKeyConfigured"], false);
        assert_eq!(host["privateKeyPassphrase"], "");
        assert_eq!(host["privateKeyPassphraseConfigured"], false);
        assert_eq!(host["proxy"]["passwordConfigured"], true);

        let snapshot =
            load_gateway_settings_sync_snapshot(&conn).expect("load gateway settings snapshot");
        assert_eq!(snapshot["ssh"]["hosts"][0]["password"], Value::Null);
        assert_eq!(snapshot["ssh"]["hosts"][0]["passwordConfigured"], false);
        assert_eq!(snapshot["ssh"]["hosts"][0]["privateKeyConfigured"], false);
        assert_eq!(
            snapshot["ssh"]["hosts"][0]["privateKeyPassphraseConfigured"],
            false
        );
    }

    #[test]
    fn ssh_patch_delete_preserves_concurrent_hosts_and_associations() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [
                    {
                        "id": "prod",
                        "name": "Prod",
                        "host": "prod.example.com",
                        "username": "deploy",
                        "authType": "password"
                    },
                    {
                        "id": "staging",
                        "name": "Staging",
                        "host": "staging.example.com",
                        "username": "deploy",
                        "authType": "agent"
                    }
                ],
                "projectHostAssociations": {
                    "/repo": ["prod", "staging"]
                }
            }),
        )
        .expect("save ssh");

        let response = apply_ssh_patch_with_conn(
            &mut conn,
            json!({
                "sshPatch": {
                    "hostChanges": [{
                        "id": "prod",
                        "before": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password"
                        },
                        "after": null
                    }],
                    "projectAssociationChanges": [{
                        "pathKey": "/repo",
                        "before": ["prod"],
                        "after": []
                    }]
                }
            }),
        )
        .expect("apply patch");

        assert_eq!(response.conflict, None);
        assert_eq!(response.ssh["hosts"][0]["id"], "staging");
        assert_eq!(
            response.ssh["projectHostAssociations"],
            json!({
                "/repo": ["staging"]
            })
        );
    }

    #[test]
    fn ssh_patch_rejects_same_field_conflict() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [{
                    "id": "prod",
                    "name": "Prod New",
                    "host": "prod.example.com",
                    "username": "deploy",
                    "authType": "password"
                }]
            }),
        )
        .expect("save ssh");

        let response = apply_ssh_patch_with_conn(
            &mut conn,
            json!({
                "sshPatch": {
                    "hostChanges": [{
                        "id": "prod",
                        "before": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password"
                        },
                        "after": {
                            "id": "prod",
                            "name": "Prod Web",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password"
                        }
                    }]
                }
            }),
        )
        .expect("apply patch");

        assert_eq!(
            response.conflict.as_deref(),
            Some(SSH_SYNC_CONFLICT_MESSAGE)
        );
        assert_eq!(response.ssh["hosts"][0]["name"], "Prod New");
    }

    #[test]
    fn ssh_patch_merges_different_host_fields() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [{
                    "id": "prod",
                    "name": "Prod Desktop",
                    "host": "prod.example.com",
                    "username": "deploy",
                    "authType": "password"
                }]
            }),
        )
        .expect("save ssh");

        let response = apply_ssh_patch_with_conn(
            &mut conn,
            json!({
                "sshPatch": {
                    "hostChanges": [{
                        "id": "prod",
                        "before": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password"
                        },
                        "after": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.internal",
                            "username": "deploy",
                            "authType": "password"
                        }
                    }]
                }
            }),
        )
        .expect("apply patch");

        assert_eq!(response.conflict, None);
        assert_eq!(response.ssh["hosts"][0]["name"], "Prod Desktop");
        assert_eq!(response.ssh["hosts"][0]["host"], "prod.internal");
    }

    #[test]
    fn ssh_patch_rejects_auth_type_secret_conflict() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [{
                    "id": "prod",
                    "name": "Prod",
                    "host": "prod.example.com",
                    "username": "deploy",
                    "authType": "agent"
                }]
            }),
        )
        .expect("save ssh");

        let response = apply_ssh_patch_with_conn(
            &mut conn,
            json!({
                "sshPatch": {},
                "sshSecretUpdates": {
                    "prod": {
                        "password": "secret"
                    }
                }
            }),
        )
        .expect("apply patch");

        assert_eq!(
            response.conflict.as_deref(),
            Some(SSH_SYNC_CONFLICT_MESSAGE)
        );
    }

    #[test]
    fn ssh_patch_clears_empty_secret_updates() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [{
                    "id": "prod",
                    "name": "Prod",
                    "host": "prod.example.com",
                    "username": "deploy",
                    "authType": "password",
                    "password": "old-password"
                }]
            }),
        )
        .expect("save ssh");

        let response = apply_ssh_patch_with_conn(
            &mut conn,
            json!({
                "sshPatch": {
                    "hostChanges": [{
                        "id": "prod",
                        "before": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password",
                            "passwordConfigured": true
                        },
                        "after": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password",
                            "passwordConfigured": false
                        }
                    }]
                },
                "sshSecretUpdates": {
                    "prod": {
                        "password": ""
                    }
                }
            }),
        )
        .expect("apply patch");

        assert_eq!(response.conflict, None);
        assert_eq!(response.ssh["hosts"][0]["password"], "");
        assert_eq!(response.ssh["hosts"][0]["passwordConfigured"], false);
    }

    #[test]
    fn ssh_known_hosts_tracks_unknown_known_and_changed_keys() {
        let conn = open_memory_db();
        let key = RuntimeSshKnownHostKey {
            host: "example.com".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            key_base64: "known-key".to_string(),
            fingerprint_sha256: "SHA256:known".to_string(),
        };

        assert_eq!(
            check_runtime_ssh_known_host_with_conn(&conn, &key).expect("check unknown host key"),
            RuntimeSshKnownHostStatus::Unknown
        );

        trust_runtime_ssh_known_host_with_conn(&conn, &key).expect("trust host key");
        assert_eq!(
            check_runtime_ssh_known_host_with_conn(&conn, &key).expect("check trusted host key"),
            RuntimeSshKnownHostStatus::Known
        );

        let changed = RuntimeSshKnownHostKey {
            key_base64: "changed-key".to_string(),
            fingerprint_sha256: "SHA256:changed".to_string(),
            ..key.clone()
        };
        assert_eq!(
            check_runtime_ssh_known_host_with_conn(&conn, &changed)
                .expect("check changed host key"),
            RuntimeSshKnownHostStatus::Changed {
                stored_fingerprint: "SHA256:known".to_string()
            }
        );

        assert_eq!(
            reset_runtime_ssh_known_host_with_conn(&conn, "example.com", 22)
                .expect("reset host key"),
            1
        );
        assert_eq!(
            check_runtime_ssh_known_host_with_conn(&conn, &key).expect("check reset host key"),
            RuntimeSshKnownHostStatus::Unknown
        );
        assert_eq!(
            reset_runtime_ssh_known_host_with_conn(&conn, "example.com", 22)
                .expect("reset missing host key"),
            0
        );
    }

    #[test]
    fn save_mcp_persists_one_row_per_server_and_restores_selection() {
        let mut conn = open_memory_db();
        save_mcp(
            &mut conn,
            json!({
                "servers": [
                    { "id": "alpha", "enabled": true, "transport": "stdio" },
                    { "id": "beta", "enabled": false, "transport": "http" }
                ],
                "selected": ["beta"]
            }),
        )
        .expect("save mcp");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM mcp_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count mcp rows");
        let selected_flag = conn
            .query_row(
                "SELECT payload_json FROM mcp_settings WHERE server_id = 'beta'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("query beta payload");
        let loaded = load_mcp(&conn).expect("load mcp");

        assert_eq!(row_count, 2);
        assert!(
            selected_flag.contains("\"selected\":true"),
            "selected flag should be stored inline"
        );
        assert_eq!(
            loaded,
            Some(json!({
                "servers": [
                    { "id": "alpha", "enabled": true, "transport": "stdio" },
                    { "id": "beta", "enabled": false, "transport": "http" }
                ],
                "selected": ["beta"]
            }))
        );
    }

    #[test]
    fn save_agents_persists_one_row_per_template_and_restores_columns() {
        let mut conn = open_memory_db();
        save_agents(
            &mut conn,
            json!([
                {
                    "id": "reviewer",
                    "name": "代码审查",
                    "description": "用于审查 PR 和补测试缺口",
                    "tags": ["review", "qa"],
                    "prompt": "你是一个严格的代码审查助手。",
                    "enabled": true
                },
                {
                    "id": "planner",
                    "name": "任务规划",
                    "description": "",
                    "tags": [],
                    "prompt": "先拆任务，再执行。",
                    "enabled": false
                }
            ]),
        )
        .expect("save agents");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM agent_prompt_templates", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count agent rows");
        let stored_tags = conn
            .query_row(
                "SELECT tags_json FROM agent_prompt_templates WHERE template_id = 'reviewer'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("query reviewer tags");
        let stored_enabled = conn
            .query_row(
                "SELECT enabled FROM agent_prompt_templates WHERE template_id = 'reviewer'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("query reviewer enabled");
        let loaded = load_agents(&conn).expect("load agents");

        assert_eq!(row_count, 2);
        assert_eq!(stored_tags, "[\"review\",\"qa\"]");
        assert_eq!(stored_enabled, 1);
        assert_eq!(
            loaded,
            Some(json!([
                {
                    "id": "reviewer",
                    "name": "代码审查",
                    "description": "用于审查 PR 和补测试缺口",
                    "tags": ["review", "qa"],
                    "prompt": "你是一个严格的代码审查助手。",
                    "enabled": true
                },
                {
                    "id": "planner",
                    "name": "任务规划",
                    "description": "",
                    "tags": [],
                    "prompt": "先拆任务，再执行。",
                    "enabled": false
                }
            ]))
        );
    }

    #[test]
    fn save_system_persists_project_setting_rows() {
        let mut conn = open_memory_db();
        let default_workdir = default_project_workdir().expect("default workdir");
        save_system(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "E:/Code/test_directory/003",
                "selectedSystemTools": ["http_get_test"]
            }),
        )
        .expect("save system");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM system_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count system rows");
        let keys = {
            let mut stmt = conn
                .prepare("SELECT setting_key FROM system_settings ORDER BY setting_key ASC")
                .expect("prepare key query");
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .expect("query keys");
            rows.into_iter()
                .map(|row| row.expect("key row"))
                .collect::<Vec<_>>()
        };
        let loaded = load_system(&conn).expect("load system");

        assert_eq!(row_count, 7);
        assert_eq!(
            keys,
            vec![
                SYSTEM_ACTIVE_WORKSPACE_PROJECT_ID_KEY.to_string(),
                SYSTEM_EXECUTION_MODE_KEY.to_string(),
                SYSTEM_HIDDEN_WORKSPACE_PROJECT_PATHS_KEY.to_string(),
                SYSTEM_MISSING_WORKSPACE_PROJECT_PATHS_KEY.to_string(),
                SYSTEM_SELECTED_TOOLS_KEY.to_string(),
                SYSTEM_WORKDIR_KEY.to_string(),
                SYSTEM_WORKSPACE_PROJECTS_KEY.to_string(),
            ]
        );
        assert_eq!(
            loaded,
            Some(json!({
                "activeWorkspaceProjectId": DEFAULT_WORKSPACE_PROJECT_ID,
                "executionMode": "tools",
                "hiddenWorkspaceProjectPaths": [],
                "missingWorkspaceProjectPaths": [],
                "workdir": default_workdir.clone(),
                "selectedSystemTools": ["http_get_test"],
                "workspaceProjects": [
                    {
                        "id": DEFAULT_WORKSPACE_PROJECT_ID,
                        "name": DEFAULT_WORKSPACE_PROJECT_NAME,
                        "path": default_workdir.clone(),
                        "kind": "managed",
                        "createdAt": 1,
                        "updatedAt": 1
                    }
                ]
            }))
        );
    }

    #[test]
    fn save_system_backfills_empty_workdir_with_default_project() {
        let mut conn = open_memory_db();
        save_system_with_default_workdir(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "",
                "selectedSystemTools": []
            }),
            "/tmp/liveagent-default-project",
        )
        .expect("save system");

        let loaded = load_system(&conn).expect("load system");
        assert_eq!(
            loaded,
            Some(json!({
                "activeWorkspaceProjectId": DEFAULT_WORKSPACE_PROJECT_ID,
                "executionMode": "tools",
                "hiddenWorkspaceProjectPaths": [],
                "missingWorkspaceProjectPaths": [],
                "workdir": "/tmp/liveagent-default-project",
                "selectedSystemTools": [],
                "workspaceProjects": [
                    {
                        "id": DEFAULT_WORKSPACE_PROJECT_ID,
                        "name": DEFAULT_WORKSPACE_PROJECT_NAME,
                        "path": "/tmp/liveagent-default-project",
                        "kind": "managed",
                        "createdAt": 1,
                        "updatedAt": 1
                    }
                ]
            }))
        );
    }

    #[test]
    fn save_system_preserves_default_project_pin_metadata() {
        let mut conn = open_memory_db();
        save_system_with_default_workdir(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "/tmp/liveagent-default-project",
                "selectedSystemTools": [],
                "workspaceProjects": [
                    {
                        "id": DEFAULT_WORKSPACE_PROJECT_ID,
                        "name": DEFAULT_WORKSPACE_PROJECT_NAME,
                        "path": "/tmp/liveagent-default-project",
                        "kind": "managed",
                        "createdAt": 10,
                        "updatedAt": 20,
                        "isPinned": true,
                        "pinnedAt": 30
                    }
                ]
            }),
            "/tmp/liveagent-default-project",
        )
        .expect("save system");

        let loaded = load_system(&conn).expect("load system");
        assert_eq!(
            loaded,
            Some(json!({
                "activeWorkspaceProjectId": DEFAULT_WORKSPACE_PROJECT_ID,
                "executionMode": "tools",
                "hiddenWorkspaceProjectPaths": [],
                "missingWorkspaceProjectPaths": [],
                "workdir": "/tmp/liveagent-default-project",
                "selectedSystemTools": [],
                "workspaceProjects": [
                    {
                        "id": DEFAULT_WORKSPACE_PROJECT_ID,
                        "name": DEFAULT_WORKSPACE_PROJECT_NAME,
                        "path": "/tmp/liveagent-default-project",
                        "kind": "managed",
                        "createdAt": 1,
                        "updatedAt": 1,
                        "isPinned": true,
                        "pinnedAt": 30
                    }
                ]
            }))
        );
    }

    #[test]
    fn load_system_with_defaults_returns_agent_mode_and_default_project() {
        let conn = open_memory_db();
        let loaded = load_system_with_defaults(&conn, "/tmp/liveagent-default-project")
            .expect("load system");

        assert_eq!(
            loaded,
            json!({
                "activeWorkspaceProjectId": DEFAULT_WORKSPACE_PROJECT_ID,
                "executionMode": "tools",
                "hiddenWorkspaceProjectPaths": [],
                "missingWorkspaceProjectPaths": [],
                "workdir": "/tmp/liveagent-default-project",
                "selectedSystemTools": [],
                "workspaceProjects": [
                    {
                        "id": DEFAULT_WORKSPACE_PROJECT_ID,
                        "name": DEFAULT_WORKSPACE_PROJECT_NAME,
                        "path": "/tmp/liveagent-default-project",
                        "kind": "managed",
                        "createdAt": 1,
                        "updatedAt": 1
                    }
                ]
            })
        );
    }

    #[test]
    fn save_hooks_persists_one_row_per_hook_and_preserves_order() {
        let mut conn = open_memory_db();
        save_hooks(
            &mut conn,
            json!([
                {
                    "id": "hook-a",
                    "event": "agent_start",
                    "name": "Command Hook",
                    "description": "",
                    "type": "command",
                    "enabled": true,
                    "script": "echo hook-a"
                },
                {
                    "id": "hook-b",
                    "event": "agent_end",
                    "name": "HTTP Hook",
                    "description": "",
                    "type": "http",
                    "enabled": false,
                    "requests": [
                        {
                            "id": "request-1",
                            "url": "https://example.com/hook",
                            "method": "POST",
                            "headers": { "x-test": "1" }
                        }
                    ]
                }
            ]),
        )
        .expect("save hooks");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM hook_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count hook rows");
        let loaded = load_hooks(&conn).expect("load hooks");

        assert_eq!(row_count, 2);
        assert_eq!(
            loaded,
            Some(json!([
                {
                    "id": "hook-a",
                    "event": "agent_start",
                    "name": "Command Hook",
                    "description": "",
                    "type": "command",
                    "enabled": true,
                    "script": "echo hook-a"
                },
                {
                    "id": "hook-b",
                    "event": "agent_end",
                    "name": "HTTP Hook",
                    "description": "",
                    "type": "http",
                    "enabled": false,
                    "requests": [
                        {
                            "id": "request-1",
                            "url": "https://example.com/hook",
                            "method": "POST",
                            "headers": { "x-test": "1" }
                        }
                    ]
                }
            ]))
        );
    }

    #[test]
    fn save_hooks_rejects_unsupported_commands_field() {
        let mut conn = open_memory_db();
        let error = save_hooks(
            &mut conn,
            json!([
                {
                    "id": "hook-a",
                    "event": "agent_start",
                    "name": "Command Hook",
                    "description": "",
                    "type": "command",
                    "enabled": true,
                    "commands": [["cmd", "/C", "echo", "a"]]
                }
            ]),
        )
        .expect_err("reject unsupported hook commands field");

        assert!(error.contains("commands"));
        let count = conn
            .query_row("SELECT COUNT(*) FROM hook_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count hook rows");
        assert_eq!(count, 0);
    }

    #[test]
    fn save_cron_persists_one_row_per_task_and_restores_order() {
        let mut conn = open_memory_db();
        save_cron(
            &mut conn,
            json!([
                {
                    "id": "cron-a",
                    "name": "Build",
                    "description": "Run build",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "type": "bash",
                    "script": "npm run build"
                },
                {
                    "id": "cron-b",
                    "name": "Daily Summary",
                    "description": "",
                    "cron": "0 0 * * * *",
                    "enabled": false,
                    "type": "prompt",
                    "prompt": "Summarize yesterday's important changes.",
                    "selectedModel": {
                        "customProviderId": "builtin-codex",
                        "model": "gpt-5"
                    }
                }
            ]),
        )
        .expect("save cron");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM cron_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count cron rows");
        let loaded = load_cron(&conn).expect("load cron");

        assert_eq!(row_count, 2);
        assert_eq!(
            loaded,
            Some(json!([
                {
                    "id": "cron-a",
                    "name": "Build",
                    "description": "Run build",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "type": "bash",
                    "script": "npm run build"
                },
                {
                    "id": "cron-b",
                    "name": "Daily Summary",
                    "description": "",
                    "cron": "0 0 * * * *",
                    "enabled": false,
                    "type": "prompt",
                    "prompt": "Summarize yesterday's important changes.",
                    "selectedModel": {
                        "customProviderId": "builtin-codex",
                        "model": "gpt-5"
                    }
                }
            ]))
        );
    }

    #[test]
    fn save_cron_normalizes_remaining_executions_and_disables_exhausted_tasks() {
        let mut conn = open_memory_db();
        save_cron(
            &mut conn,
            json!([
                {
                    "id": "cron-finite",
                    "name": "Finite",
                    "description": "",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "remainingExecutions": "2",
                    "type": "bash",
                    "script": "echo finite"
                },
                {
                    "id": "cron-exhausted",
                    "name": "Exhausted",
                    "description": "",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "remainingExecutions": 0,
                    "type": "bash",
                    "script": "echo exhausted"
                },
                {
                    "id": "cron-unlimited",
                    "name": "Unlimited",
                    "description": "",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "remainingExecutions": null,
                    "type": "bash",
                    "script": "echo unlimited"
                }
            ]),
        )
        .expect("save cron");

        let loaded = load_cron(&conn).expect("load cron").expect("cron payload");
        assert_eq!(
            loaded,
            json!([
                {
                    "id": "cron-finite",
                    "name": "Finite",
                    "description": "",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "remainingExecutions": 2,
                    "type": "bash",
                    "script": "echo finite"
                },
                {
                    "id": "cron-exhausted",
                    "name": "Exhausted",
                    "description": "",
                    "cron": "0 * * * * *",
                    "enabled": false,
                    "remainingExecutions": 0,
                    "type": "bash",
                    "script": "echo exhausted"
                },
                {
                    "id": "cron-unlimited",
                    "name": "Unlimited",
                    "description": "",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "type": "bash",
                    "script": "echo unlimited"
                }
            ])
        );
    }

    #[test]
    fn save_cron_rejects_empty_bash_script() {
        let mut conn = open_memory_db();
        let error = save_cron(
            &mut conn,
            json!([
                {
                    "id": "cron-a",
                    "name": "Build",
                    "description": "",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "type": "bash",
                    "script": ""
                }
            ]),
        )
        .expect_err("reject empty bash script");

        assert!(error.contains("script"));
        let count = conn
            .query_row("SELECT COUNT(*) FROM cron_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count cron rows");
        assert_eq!(count, 0);
    }

    #[test]
    fn save_cron_rejects_unsupported_bash_commands_field() {
        let mut conn = open_memory_db();
        let error = save_cron(
            &mut conn,
            json!([
                {
                    "id": "cron-a",
                    "name": "Build",
                    "description": "",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "type": "bash",
                    "commands": [["npm", "run", "build"]]
                }
            ]),
        )
        .expect_err("reject unsupported bash commands field");

        assert!(error.contains("commands"));
        let count = conn
            .query_row("SELECT COUNT(*) FROM cron_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count cron rows");
        assert_eq!(count, 0);
    }

    #[test]
    fn save_cron_rejects_commands_field_for_non_bash_tasks() {
        let mut conn = open_memory_db();
        let error = save_cron(
            &mut conn,
            json!([
                {
                    "id": "cron-a",
                    "name": "Webhook",
                    "description": "",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "type": "http",
                    "commands": [["npm", "run", "build"]],
                    "requests": [
                        {
                            "id": "request-1",
                            "url": "https://example.com/hook",
                            "method": "POST"
                        }
                    ]
                }
            ]),
        )
        .expect_err("reject commands field on non-bash task");

        assert!(error.contains("commands"));
        let count = conn
            .query_row("SELECT COUNT(*) FROM cron_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count cron rows");
        assert_eq!(count, 0);
    }

    #[test]
    fn save_cron_rejects_http_request_with_relative_url() {
        let mut conn = open_memory_db();
        let error = save_cron(
            &mut conn,
            json!([
                {
                    "id": "cron-a",
                    "name": "Webhook",
                    "description": "",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "type": "http",
                    "requests": [
                        {
                            "id": "request-1",
                            "url": "/relative",
                            "method": "POST"
                        }
                    ]
                }
            ]),
        )
        .expect_err("reject relative url");

        assert!(error.contains("绝对 URL"));
        let count = conn
            .query_row("SELECT COUNT(*) FROM cron_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count cron rows");
        assert_eq!(count, 0);
    }
}
