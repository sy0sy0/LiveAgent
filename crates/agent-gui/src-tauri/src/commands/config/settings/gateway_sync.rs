pub(crate) fn load_gateway_settings_sync_snapshot(conn: &Connection) -> Result<Value, String> {
    let default_workdir = default_project_workdir()?;
    let mut snapshot = Map::new();
    snapshot.insert(
        "system".to_string(),
        load_system_with_defaults(conn, &default_workdir)?,
    );
    snapshot.insert(
        "customProviders".to_string(),
        redact_provider_credentials(load_providers(conn)?.unwrap_or(Value::Array(Vec::new())))?,
    );
    snapshot.insert(
        "mcp".to_string(),
        load_mcp(conn)?.unwrap_or(Value::Object(Map::new())),
    );
    snapshot.insert(
        "agents".to_string(),
        load_agents(conn)?.unwrap_or(Value::Array(Vec::new())),
    );
    snapshot.insert(
        "ssh".to_string(),
        redact_ssh_settings(load_ssh(conn)?.unwrap_or(Value::Object(Map::from_iter([(
            "hosts".to_string(),
            Value::Array(Vec::new()),
        )]))))?,
    );
    snapshot.insert(
        "hooks".to_string(),
        load_hooks(conn)?.unwrap_or(Value::Array(Vec::new())),
    );
    snapshot.insert(
        "cron".to_string(),
        load_cron(conn)?.unwrap_or(Value::Array(Vec::new())),
    );
    snapshot.insert(
        "memory".to_string(),
        load_memory(conn)?.unwrap_or(Value::Object(Map::new())),
    );
    let remote = load_remote_settings(conn)?;
    snapshot.insert(
        "remote".to_string(),
        json!({
            "enableWebTerminal": remote.enable_web_terminal,
            "enableWebSshTerminal": remote.enable_web_ssh_terminal,
            "enableWebGit": remote.enable_web_git,
            "enableWebTunnels": remote.enable_web_tunnels,
        }),
    );
    snapshot.insert("customSettings".to_string(), Value::Object(Map::new()));
    snapshot.insert("skills".to_string(), Value::Object(Map::new()));
    snapshot.insert(
        "chatRuntimeControls".to_string(),
        json!({
            "thinkingEnabled": true,
            "nativeWebSearchEnabled": true,
            "reasoning": "high",
            "reasoningByProvider": {
                "claude_code": "high",
                "codex_openai_responses": "high",
                "codex_openai_completions": "high",
                "gemini": "high",
            },
        }),
    );
    snapshot.insert("selectedModel".to_string(), Value::Null);
    snapshot.insert("theme".to_string(), Value::String("light".to_string()));
    snapshot.insert("locale".to_string(), Value::String("zh-CN".to_string()));
    Ok(Value::Object(snapshot))
}

pub(crate) fn redact_gateway_settings_sync_payload(payload: Value) -> Result<Value, String> {
    let mut snapshot = expect_object(payload, "gateway settings sync payload")?;
    snapshot.remove(PROVIDER_API_KEY_UPDATES_FIELD);
    snapshot.remove(SSH_SECRET_UPDATES_FIELD);
    if let Some(providers) = snapshot.remove("customProviders") {
        snapshot.insert(
            "customProviders".to_string(),
            redact_provider_credentials(providers)?,
        );
    }
    if let Some(ssh) = snapshot.remove("ssh") {
        snapshot.insert("ssh".to_string(), redact_ssh_settings(ssh)?);
    }
    if let Some(remote) = snapshot.remove("remote") {
        snapshot.insert("remote".to_string(), redact_remote_settings(remote)?);
    }
    Ok(Value::Object(snapshot))
}

fn redact_ssh_settings(ssh: Value) -> Result<Value, String> {
    let mut ssh = expect_object(ssh, "ssh settings payload")?;
    let hosts = expect_array(
        ssh.remove("hosts").unwrap_or(Value::Array(Vec::new())),
        "ssh settings hosts",
    )?;
    let project_host_associations = ssh
        .remove("projectHostAssociations")
        .unwrap_or(Value::Object(Map::new()));
    let redacted = hosts
        .into_iter()
        .map(redact_ssh_host_secret)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Value::Object(Map::from_iter([
        ("hosts".to_string(), Value::Array(redacted)),
        (
            "projectHostAssociations".to_string(),
            Value::Object(normalize_ssh_project_host_associations_value(
                project_host_associations,
                None,
            )?),
        ),
    ])))
}

fn redact_ssh_host_secret(host: Value) -> Result<Value, String> {
    let mut payload = expect_object(host, "ssh settings host")?;
    let auth_type = payload
        .get("authType")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("password");
    let is_agent_auth = auth_type == "agent";
    let password_configured =
        match payload.remove("password") {
            Some(Value::String(value)) => !value.trim().is_empty(),
            Some(Value::Null) | None => false,
            Some(_) => return Err("ssh settings password must be a string".to_string()),
        } || matches!(payload.get("passwordConfigured"), Some(Value::Bool(true)));
    let private_key_configured = match payload.remove("privateKey") {
        Some(Value::String(value)) => !value.trim().is_empty(),
        Some(Value::Null) | None => false,
        Some(_) => return Err("ssh settings privateKey must be a string".to_string()),
    } || payload
        .get("privateKeyPath")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
        || matches!(payload.get("privateKeyConfigured"), Some(Value::Bool(true)));
    let private_key_passphrase_configured = match payload.remove("privateKeyPassphrase") {
        Some(Value::String(value)) => !value.trim().is_empty(),
        Some(Value::Null) | None => false,
        Some(_) => return Err("ssh settings privateKeyPassphrase must be a string".to_string()),
    } || matches!(
        payload.get("privateKeyPassphraseConfigured"),
        Some(Value::Bool(true))
    );
    payload.insert(
        "passwordConfigured".to_string(),
        Value::Bool(!is_agent_auth && password_configured),
    );
    payload.insert(
        "privateKeyConfigured".to_string(),
        Value::Bool(!is_agent_auth && private_key_configured),
    );
    payload.insert(
        "privateKeyPassphraseConfigured".to_string(),
        Value::Bool(!is_agent_auth && private_key_passphrase_configured),
    );
    if let Some(proxy) = payload.remove("proxy") {
        if !matches!(proxy, Value::Null) {
            payload.insert("proxy".to_string(), redact_ssh_proxy_secret(proxy)?);
        }
    }
    Ok(Value::Object(payload))
}

fn redact_ssh_proxy_secret(proxy: Value) -> Result<Value, String> {
    let mut payload = expect_object(proxy, "ssh settings proxy")?;
    let password_configured =
        match payload.remove("password") {
            Some(Value::String(value)) => !value.trim().is_empty(),
            Some(Value::Null) | None => false,
            Some(_) => return Err("ssh settings proxy.password must be a string".to_string()),
        } || matches!(payload.get("passwordConfigured"), Some(Value::Bool(true)));
    payload.insert(
        "passwordConfigured".to_string(),
        Value::Bool(password_configured),
    );
    Ok(Value::Object(payload))
}

