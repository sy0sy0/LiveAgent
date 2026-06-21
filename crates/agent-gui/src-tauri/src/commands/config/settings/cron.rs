fn validate_cron_task_type(task: &Map<String, Value>, label: &str) -> Result<String, String> {
    let task_type = task
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("bash");
    match task_type {
        "bash" | "http" | "prompt" => Ok(task_type.to_string()),
        other => Err(format!("{label}.type 不支持：{other}")),
    }
}

fn validate_cron_script(task: &Map<String, Value>, label: &str) -> Result<String, String> {
    let script = extract_non_empty_string(task, "script", label)?;
    Ok(script)
}

fn validate_cron_remaining_executions(
    task: &Map<String, Value>,
    label: &str,
) -> Result<Option<u64>, String> {
    let Some(value) = task.get("remainingExecutions") else {
        return Ok(None);
    };

    match value {
        Value::Null => Ok(None),
        Value::Number(number) => number
            .as_u64()
            .ok_or_else(|| format!("{label}.remainingExecutions 必须是非负整数"))
            .map(Some),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                trimmed
                    .parse::<u64>()
                    .map(Some)
                    .map_err(|_| format!("{label}.remainingExecutions 必须是非负整数"))
            }
        }
        _ => Err(format!("{label}.remainingExecutions 必须是非负整数")),
    }
}

fn validate_http_method(value: Option<&Value>, label: &str) -> Result<String, String> {
    let method = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("POST")
        .to_ascii_uppercase();
    match method.as_str() {
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" => Ok(method),
        _ => Err(format!("{label}.method 不支持：{method}")),
    }
}

fn can_http_method_have_body(method: &str) -> bool {
    matches!(method, "POST" | "PUT" | "PATCH" | "DELETE")
}

fn validate_http_headers(
    value: Option<&Value>,
    label: &str,
) -> Result<Option<Map<String, Value>>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let headers = value
        .as_object()
        .ok_or_else(|| format!("{label}.headers 必须是对象"))?;
    let mut normalized = Map::new();
    for (raw_key, raw_value) in headers {
        let key = raw_key.trim();
        let header_value = match raw_value {
            Value::String(text) => text.trim().to_string(),
            Value::Null => String::new(),
            other => other.to_string().trim().to_string(),
        };
        if key.is_empty() || header_value.is_empty() {
            continue;
        }
        normalized.insert(key.to_string(), Value::String(header_value));
    }
    if normalized.is_empty() {
        Ok(None)
    } else {
        Ok(Some(normalized))
    }
}

fn validate_http_requests(task: &Map<String, Value>, label: &str) -> Result<Vec<Value>, String> {
    let Some(requests_value) = task.get("requests") else {
        return Err(format!("{label}.requests 至少需要一个请求"));
    };
    let requests = requests_value
        .as_array()
        .ok_or_else(|| format!("{label}.requests 必须是对象数组"))?;
    if requests.is_empty() {
        return Err(format!("{label}.requests 至少需要一个请求"));
    }

    let mut normalized = Vec::with_capacity(requests.len());
    for (index, request_value) in requests.iter().enumerate() {
        let item_label = format!("{label}.requests[{index}]");
        let request = request_value
            .as_object()
            .ok_or_else(|| format!("{item_label} 必须是对象"))?;
        let id = extract_non_empty_string(request, "id", &item_label)?;
        let url = extract_non_empty_string(request, "url", &item_label)?;
        reqwest::Url::parse(&url).map_err(|_| format!("{item_label}.url 必须是绝对 URL"))?;
        let method = validate_http_method(request.get("method"), &item_label)?;
        let headers = validate_http_headers(request.get("headers"), &item_label)?;
        let body = if can_http_method_have_body(&method) {
            request
                .get("body")
                .filter(|value| !value.is_null())
                .cloned()
        } else {
            None
        };

        let mut normalized_request = Map::new();
        normalized_request.insert("id".to_string(), Value::String(id));
        normalized_request.insert("url".to_string(), Value::String(url));
        normalized_request.insert("method".to_string(), Value::String(method));
        if let Some(headers) = headers {
            normalized_request.insert("headers".to_string(), Value::Object(headers));
        }
        if let Some(body) = body {
            normalized_request.insert("body".to_string(), body);
        }
        normalized.push(Value::Object(normalized_request));
    }

    Ok(normalized)
}

fn validate_cron_selected_model(
    value: Option<&Value>,
    label: &str,
) -> Result<Map<String, Value>, String> {
    let selected_model = expect_object(
        value
            .cloned()
            .ok_or_else(|| format!("{label}.selectedModel 不能为空"))?,
        &format!("{label}.selectedModel"),
    )?;
    let custom_provider_id = extract_non_empty_string(
        &selected_model,
        "customProviderId",
        &format!("{label}.selectedModel"),
    )?;
    let model =
        extract_non_empty_string(&selected_model, "model", &format!("{label}.selectedModel"))?;

    Ok(Map::from_iter([
        (
            "customProviderId".to_string(),
            Value::String(custom_provider_id),
        ),
        ("model".to_string(), Value::String(model)),
    ]))
}

fn validate_and_normalize_cron_task(
    task: Map<String, Value>,
    label: &str,
    options: CronTaskValidationOptions,
) -> Result<ValidatedCronTask, String> {
    let task_id = if options.require_id {
        Some(extract_non_empty_string(&task, "id", label)?)
    } else {
        None
    };
    if task.contains_key("commands") {
        return Err(format!("{label}.commands 已不再支持，请使用 script"));
    }
    let name = extract_non_empty_string(&task, "name", label)?;
    let description = extract_optional_string(&task, "description");
    let cron_expression = extract_non_empty_string(&task, "cron", label)?;
    validate_cron_expression(&cron_expression)?;
    let remaining_executions = validate_cron_remaining_executions(&task, label)?;
    let enabled = extract_bool_with_default(&task, "enabled", label, options.default_enabled)?
        && remaining_executions != Some(0);
    let task_type = validate_cron_task_type(&task, label)?;

    let mut payload = Map::new();
    payload.insert("name".to_string(), Value::String(name));
    payload.insert("description".to_string(), Value::String(description));
    payload.insert("cron".to_string(), Value::String(cron_expression));
    payload.insert("enabled".to_string(), Value::Bool(enabled));
    payload.insert("type".to_string(), Value::String(task_type.clone()));
    if let Some(remaining_executions) = remaining_executions {
        payload.insert(
            "remainingExecutions".to_string(),
            Value::Number(Number::from(remaining_executions)),
        );
    }

    match task_type.as_str() {
        "bash" => {
            let script = validate_cron_script(&task, label)?;
            payload.insert("script".to_string(), Value::String(script));
        }
        "http" => {
            let requests = validate_http_requests(&task, label)?;
            payload.insert("requests".to_string(), Value::Array(requests));
        }
        "prompt" => {
            let prompt = extract_non_empty_string(&task, "prompt", label)?;
            let selected_model = validate_cron_selected_model(task.get("selectedModel"), label)?;
            payload.insert("prompt".to_string(), Value::String(prompt));
            payload.insert("selectedModel".to_string(), Value::Object(selected_model));
        }
        _ => unreachable!(),
    }

    Ok(ValidatedCronTask { task_id, payload })
}

pub(crate) fn append_cron_task(
    conn: &mut Connection,
    payload: Value,
) -> Result<ValidatedCronTask, String> {
    let task = expect_object(payload, "system_add_cron_task payload")?;
    let mut validated = validate_and_normalize_cron_task(
        task,
        "system_add_cron_task payload",
        CronTaskValidationOptions {
            require_id: false,
            default_enabled: true,
        },
    )?;
    let task_id = Uuid::new_v4().to_string();
    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {CRON_SETTINGS_TABLE} 事务失败：{e}"))?;
    let sort_index: i64 = tx
        .query_row(
            &format!("SELECT COALESCE(MAX(sort_index), -1) + 1 FROM {CRON_SETTINGS_TABLE}"),
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("读取 {CRON_SETTINGS_TABLE} 排序索引失败：{e}"))?;

    tx.execute(
        CRON_SETTINGS_INSERT_SQL,
        params![
            task_id,
            serialize_json(
                &Value::Object(validated.payload.clone()),
                CRON_SETTINGS_TABLE
            )?,
            sort_index,
            updated_at
        ],
    )
    .map_err(|e| format!("写入 {CRON_SETTINGS_TABLE} 失败：{e}"))?;

    tx.commit()
        .map_err(|e| format!("提交 {CRON_SETTINGS_TABLE} 事务失败：{e}"))?;
    validated.task_id = Some(task_id);
    Ok(validated)
}

pub(crate) fn update_cron_task(
    conn: &mut Connection,
    task_id: &str,
    payload: Value,
) -> Result<ValidatedCronTask, String> {
    let normalized_task_id = task_id.trim();
    if normalized_task_id.is_empty() {
        return Err("system_manage_cron_task payload.task_id 不能为空".to_string());
    }

    let existing = load_cron_task(conn, normalized_task_id)?
        .ok_or_else(|| format!("{CRON_SETTINGS_TABLE}.task_id 不存在：{normalized_task_id}"))?;
    let mut merged = expect_object(existing, "stored cron task")?;
    let patch = expect_object(payload, "system_manage_cron_task payload.task")?;
    for (key, value) in patch {
        merged.insert(key, value);
    }

    let mut validated = validate_and_normalize_cron_task(
        merged,
        "system_manage_cron_task payload.task",
        CronTaskValidationOptions {
            require_id: true,
            default_enabled: true,
        },
    )?;
    let validated_task_id = validated
        .task_id
        .clone()
        .ok_or_else(|| "system_manage_cron_task payload.task.id 不能为空".to_string())?;
    if validated_task_id != normalized_task_id {
        return Err("system_manage_cron_task 不允许修改 task_id".to_string());
    }

    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {CRON_SETTINGS_TABLE} 事务失败：{e}"))?;
    let affected_rows = tx
        .execute(
            CRON_SETTINGS_UPDATE_SQL,
            params![
                serialize_json(
                    &Value::Object(validated.payload.clone()),
                    CRON_SETTINGS_TABLE
                )?,
                updated_at,
                normalized_task_id
            ],
        )
        .map_err(|e| format!("更新 {CRON_SETTINGS_TABLE} 失败：{e}"))?;
    if affected_rows == 0 {
        return Err(format!(
            "{CRON_SETTINGS_TABLE}.task_id 不存在：{normalized_task_id}"
        ));
    }

    tx.commit()
        .map_err(|e| format!("提交 {CRON_SETTINGS_TABLE} 事务失败：{e}"))?;
    validated.task_id = Some(normalized_task_id.to_string());
    Ok(validated)
}

pub(crate) fn delete_cron_task(conn: &mut Connection, task_id: &str) -> Result<Value, String> {
    let normalized_task_id = task_id.trim();
    if normalized_task_id.is_empty() {
        return Err("system_manage_cron_task payload.task_id 不能为空".to_string());
    }

    let existing = load_cron_task(conn, normalized_task_id)?
        .ok_or_else(|| format!("{CRON_SETTINGS_TABLE}.task_id 不存在：{normalized_task_id}"))?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {CRON_SETTINGS_TABLE} 事务失败：{e}"))?;
    tx.execute(
        &format!("DELETE FROM {CRON_EXECUTION_LOGS_TABLE} WHERE task_id = ?1"),
        params![normalized_task_id],
    )
    .map_err(|e| format!("清理 {CRON_EXECUTION_LOGS_TABLE} 失败：{e}"))?;
    let affected_rows = tx
        .execute(
            &format!("DELETE FROM {CRON_SETTINGS_TABLE} WHERE task_id = ?1"),
            params![normalized_task_id],
        )
        .map_err(|e| format!("删除 {CRON_SETTINGS_TABLE} 失败：{e}"))?;
    if affected_rows == 0 {
        return Err(format!(
            "{CRON_SETTINGS_TABLE}.task_id 不存在：{normalized_task_id}"
        ));
    }

    tx.commit()
        .map_err(|e| format!("提交 {CRON_SETTINGS_TABLE} 事务失败：{e}"))?;
    Ok(existing)
}
pub(crate) fn load_cron(conn: &Connection) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(CRON_SETTINGS_SELECT_SQL)
        .map_err(|e| format!("准备读取 {CRON_SETTINGS_TABLE} 失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("读取 {CRON_SETTINGS_TABLE} 失败：{e}"))?;

    let mut tasks = Vec::new();
    for row in rows {
        let (task_id, payload_json) =
            row.map_err(|e| format!("读取 {CRON_SETTINGS_TABLE} 行失败：{e}"))?;
        let mut task = expect_object(
            parse_json(&payload_json, CRON_SETTINGS_TABLE)?,
            CRON_SETTINGS_TABLE,
        )?;
        inject_string_field(&mut task, "id", task_id);
        tasks.push(Value::Object(task));
    }

    if tasks.is_empty() {
        Ok(None)
    } else {
        Ok(Some(Value::Array(tasks)))
    }
}

pub(crate) fn load_cron_task(conn: &Connection, task_id: &str) -> Result<Option<Value>, String> {
    let normalized_task_id = task_id.trim();
    if normalized_task_id.is_empty() {
        return Err("cron task_id 不能为空".to_string());
    }

    let payload_json = conn
        .query_row(
            &format!(
                "
                SELECT payload_json
                FROM {CRON_SETTINGS_TABLE}
                WHERE task_id = ?1
                "
            ),
            params![normalized_task_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("读取 {CRON_SETTINGS_TABLE} 失败：{e}"))?;

    let Some(payload_json) = payload_json else {
        return Ok(None);
    };

    let mut task = expect_object(
        parse_json(&payload_json, CRON_SETTINGS_TABLE)?,
        CRON_SETTINGS_TABLE,
    )?;
    inject_string_field(&mut task, "id", normalized_task_id.to_string());
    Ok(Some(Value::Object(task)))
}
fn save_cron(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let tasks = expect_array(payload, "settings_save_cron payload")?;
    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {CRON_SETTINGS_TABLE} 事务失败：{e}"))?;
    tx.execute(CRON_SETTINGS_DELETE_SQL, [])
        .map_err(|e| format!("清空 {CRON_SETTINGS_TABLE} 失败：{e}"))?;

    let mut seen = HashSet::new();
    for (sort_index, task) in tasks.into_iter().enumerate() {
        let validated = validate_and_normalize_cron_task(
            expect_object(task, "settings_save_cron payload[]")?,
            "settings_save_cron payload[]",
            CronTaskValidationOptions {
                require_id: true,
                default_enabled: false,
            },
        )?;
        let task_id = validated
            .task_id
            .clone()
            .ok_or_else(|| "settings_save_cron payload[].id 不能为空".to_string())?;
        if !seen.insert(task_id.clone()) {
            return Err(format!("{CRON_SETTINGS_TABLE}.task_id 重复：{task_id}"));
        }

        tx.execute(
            CRON_SETTINGS_INSERT_SQL,
            params![
                task_id,
                serialize_json(&Value::Object(validated.payload), CRON_SETTINGS_TABLE)?,
                sort_index as i64,
                updated_at
            ],
        )
        .map_err(|e| format!("写入 {CRON_SETTINGS_TABLE} 失败：{e}"))?;
    }

    tx.execute(
        &format!(
            "DELETE FROM {CRON_EXECUTION_LOGS_TABLE} WHERE task_id NOT IN (SELECT task_id FROM {CRON_SETTINGS_TABLE})"
        ),
        [],
    )
    .map_err(|e| format!("清理 {CRON_EXECUTION_LOGS_TABLE} 失败：{e}"))?;

    tx.commit()
        .map_err(|e| format!("提交 {CRON_SETTINGS_TABLE} 事务失败：{e}"))?;
    Ok(())
}
