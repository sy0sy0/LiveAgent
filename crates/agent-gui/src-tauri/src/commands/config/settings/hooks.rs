#[derive(Debug)]
pub(crate) struct ValidatedCronTask {
    pub(crate) task_id: Option<String>,
    pub(crate) payload: Map<String, Value>,
}

#[derive(Debug)]
struct ValidatedHook {
    hook_id: String,
    payload: Map<String, Value>,
}

#[derive(Debug, Clone, Copy)]
struct CronTaskValidationOptions {
    require_id: bool,
    default_enabled: bool,
}

fn validate_hook_lifecycle_event(value: Option<&Value>, label: &str) -> Result<String, String> {
    let event = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("agent_start");
    match event {
        "agent_start"
        | "turn_start"
        | "message_start"
        | "message_update"
        | "message_end"
        | "tool_execution_start"
        | "tool_execution_update"
        | "tool_execution_end"
        | "turn_end"
        | "agent_end" => Ok(event.to_string()),
        other => Err(format!("{label}.event 不支持：{other}")),
    }
}

fn validate_hook_type(hook: &Map<String, Value>, label: &str) -> Result<String, String> {
    let hook_type = hook
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("command");
    match hook_type {
        "command" | "http" => Ok(hook_type.to_string()),
        other => Err(format!("{label}.type 不支持：{other}")),
    }
}

fn validate_and_normalize_hook(
    hook: Map<String, Value>,
    label: &str,
) -> Result<ValidatedHook, String> {
    if hook.contains_key("commands") {
        return Err(format!("{label}.commands 已不再支持，请使用 script"));
    }

    let hook_id = extract_non_empty_string(&hook, "id", label)?;
    let event = validate_hook_lifecycle_event(hook.get("event"), label)?;
    let name = extract_non_empty_string(&hook, "name", label)?;
    let description = extract_optional_string(&hook, "description");
    let enabled = extract_bool_with_default(&hook, "enabled", label, false)?;
    let hook_type = validate_hook_type(&hook, label)?;

    let mut payload = Map::new();
    payload.insert("event".to_string(), Value::String(event));
    payload.insert("name".to_string(), Value::String(name));
    payload.insert("description".to_string(), Value::String(description));
    payload.insert("enabled".to_string(), Value::Bool(enabled));
    payload.insert("type".to_string(), Value::String(hook_type.clone()));

    match hook_type.as_str() {
        "command" => {
            let script = extract_non_empty_string(&hook, "script", label)?;
            payload.insert("script".to_string(), Value::String(script));
        }
        "http" => {
            let requests = validate_http_requests(&hook, label)?;
            payload.insert("requests".to_string(), Value::Array(requests));
        }
        _ => unreachable!(),
    }

    Ok(ValidatedHook { hook_id, payload })
}

fn load_hooks(conn: &Connection) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(HOOK_SETTINGS_SELECT_SQL)
        .map_err(|e| format!("准备读取 {HOOK_SETTINGS_TABLE} 失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("读取 {HOOK_SETTINGS_TABLE} 失败：{e}"))?;

    let mut hooks = Vec::new();
    for row in rows {
        let (hook_id, payload_json) =
            row.map_err(|e| format!("读取 {HOOK_SETTINGS_TABLE} 行失败：{e}"))?;
        let mut hook = expect_object(
            parse_json(&payload_json, HOOK_SETTINGS_TABLE)?,
            HOOK_SETTINGS_TABLE,
        )?;
        inject_string_field(&mut hook, "id", hook_id);
        hooks.push(Value::Object(hook));
    }

    if hooks.is_empty() {
        Ok(None)
    } else {
        Ok(Some(Value::Array(hooks)))
    }
}
fn save_hooks(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let hooks = expect_array(payload, "settings_save_hooks payload")?;
    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {HOOK_SETTINGS_TABLE} 事务失败：{e}"))?;
    tx.execute(HOOK_SETTINGS_DELETE_SQL, [])
        .map_err(|e| format!("清空 {HOOK_SETTINGS_TABLE} 失败：{e}"))?;

    let mut seen = HashSet::new();
    for (sort_index, hook) in hooks.into_iter().enumerate() {
        let hook = expect_object(hook, "settings_save_hooks payload[]")?;
        let validated = validate_and_normalize_hook(hook, "settings_save_hooks payload[]")?;
        let hook_id = validated.hook_id;
        if !seen.insert(hook_id.clone()) {
            return Err(format!("{HOOK_SETTINGS_TABLE}.hook_id 重复：{hook_id}"));
        }

        tx.execute(
            HOOK_SETTINGS_INSERT_SQL,
            params![
                hook_id,
                serialize_json(&Value::Object(validated.payload), HOOK_SETTINGS_TABLE)?,
                sort_index as i64,
                updated_at
            ],
        )
        .map_err(|e| format!("写入 {HOOK_SETTINGS_TABLE} 失败：{e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("提交 {HOOK_SETTINGS_TABLE} 事务失败：{e}"))?;
    Ok(())
}
