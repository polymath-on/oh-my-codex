use std::fs::{create_dir_all, read_to_string, remove_file, write, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::thread;
use std::time::Duration;

use crate::tmux;

const DEFAULT_POLL_INTERVAL_MS: u64 = 3_000;

#[derive(Debug, Clone, PartialEq, Eq)]
struct NativeReplyListenerState {
    is_running: bool,
    pid: Option<u32>,
    started_at: String,
    last_poll_at: String,
    telegram_last_update_id: Option<u64>,
    discord_last_message_id: Option<String>,
    messages_injected: u64,
    errors: u64,
    last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NativeReplyListenerConfig {
    discord_enabled: bool,
    discord_bot_token: Option<String>,
    discord_channel_id: Option<String>,
    telegram_enabled: bool,
    telegram_bot_token: Option<String>,
    telegram_chat_id: Option<String>,
    poll_interval_ms: u64,
    rate_limit_per_minute: u32,
    max_message_length: u32,
    include_prefix: bool,
    authorized_discord_user_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NativeDiscordMessage {
    id: String,
    content: String,
    reply_to_message_id: Option<String>,
}

pub fn run_reply_listener(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        None => start_reply_listener(false),
        Some("--once") => start_reply_listener(true),
        Some("status") => status_reply_listener(),
        Some("stop") => stop_reply_listener(),
        Some("discord-fetch") => discord_fetch_command(),
        Some("lookup-message") => lookup_message_command(&args[1..]),
        Some("inject-reply") => inject_reply_command(&args[1..]),
        Some(other) => Err(format!("unknown reply-listener argument `{other}`")),
    }
}

fn default_state_dir() -> Result<String, String> {
    let home = std::env::var("HOME")
        .map_err(|_| "HOME is required for reply-listener state".to_string())?;
    Ok(format!("{home}/.omx/state"))
}

fn pid_file_path(state_dir: &str) -> std::path::PathBuf {
    Path::new(state_dir).join("reply-listener.pid")
}

fn state_file_path(state_dir: &str) -> std::path::PathBuf {
    Path::new(state_dir).join("reply-listener-state.json")
}

fn log_file_path(state_dir: &str) -> std::path::PathBuf {
    Path::new(state_dir).join("reply-listener.log")
}

fn registry_path(state_dir: &str) -> std::path::PathBuf {
    Path::new(state_dir).join("reply-session-registry.jsonl")
}

fn config_path(state_dir: &str) -> std::path::PathBuf {
    Path::new(state_dir).join("reply-listener-config.json")
}

fn current_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn parse_reply_listener_config(raw: &str) -> NativeReplyListenerConfig {
    NativeReplyListenerConfig {
        discord_enabled: extract_bool(raw, "discordEnabled").unwrap_or(false),
        discord_bot_token: extract_string(raw, "discordBotToken"),
        discord_channel_id: extract_string(raw, "discordChannelId"),
        telegram_enabled: extract_bool(raw, "telegramEnabled").unwrap_or(false),
        telegram_bot_token: extract_string(raw, "telegramBotToken"),
        telegram_chat_id: extract_string(raw, "telegramChatId"),
        poll_interval_ms: clamp_u64(extract_u64(raw, "pollIntervalMs"), DEFAULT_POLL_INTERVAL_MS, 500, 60_000),
        rate_limit_per_minute: clamp_u32(extract_u32(raw, "rateLimitPerMinute"), 10, 1, None),
        max_message_length: clamp_u32(extract_u32(raw, "maxMessageLength"), 500, 1, Some(4_000)),
        include_prefix: extract_bool(raw, "includePrefix").unwrap_or(true),
        authorized_discord_user_ids: extract_string_array(raw, "authorizedDiscordUserIds"),
    }
}

fn clamp_u64(value: Option<u64>, fallback: u64, min: u64, max: u64) -> u64 {
    match value {
        Some(value) if value < min => min,
        Some(value) if value > max => max,
        Some(value) => value,
        None => fallback,
    }
}

fn clamp_u32(value: Option<u32>, fallback: u32, min: u32, max: Option<u32>) -> u32 {
    match value {
        Some(value) if value < min => min,
        Some(value) if max.is_some_and(|max| value > max) => max.unwrap_or(value),
        Some(value) => value,
        None => fallback,
    }
}

fn read_reply_listener_config() -> Result<Option<NativeReplyListenerConfig>, String> {
    let state_dir = default_state_dir()?;
    let path = config_path(&state_dir);
    if !path.exists() {
        return Ok(None);
    }
    let content = read_to_string(path)
        .map_err(|err| format!("failed reading reply-listener config: {err}"))?;
    Ok(Some(parse_reply_listener_config(&content)))
}

fn build_discord_fetch_command(
    config: &NativeReplyListenerConfig,
    after_message_id: Option<&str>,
) -> Result<(String, Vec<String>), String> {
    if !config.discord_enabled {
        return Err("discord polling disabled".to_string());
    }
    let token = config
        .discord_bot_token
        .as_ref()
        .ok_or_else(|| "discord bot token missing".to_string())?;
    let channel_id = config
        .discord_channel_id
        .as_ref()
        .ok_or_else(|| "discord channel id missing".to_string())?;

    let after = after_message_id
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!("?after={value}&limit=10"))
        .unwrap_or_else(|| "?limit=10".to_string());
    let url = format!("https://discord.com/api/v10/channels/{channel_id}/messages{after}");

    Ok((
        "curl".to_string(),
        vec![
            "-fsSL".to_string(),
            "-H".to_string(),
            format!("Authorization: Bot {token}"),
            url,
        ],
    ))
}

fn perform_discord_fetch(
    config: &NativeReplyListenerConfig,
    after_message_id: Option<&str>,
) -> Result<String, String> {
    let (program, args) = build_discord_fetch_command(config, after_message_id)?;
    let output = std::process::Command::new(&program)
        .args(&args)
        .output()
        .map_err(|err| format!("failed launching {program}: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let message = stderr.trim();
        let fallback = stdout.trim();
        return Err(if !message.is_empty() {
            message.to_string()
        } else if !fallback.is_empty() {
            fallback.to_string()
        } else {
            format!("{program} exited with {}", output.status)
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn parse_first_discord_message(raw: &str) -> Option<NativeDiscordMessage> {
    let id = extract_string(raw, "id")?;
    let content = extract_string(raw, "content").unwrap_or_default();
    let reply_to_message_id = extract_nested_string(raw, "message_reference", "message_id");
    Some(NativeDiscordMessage {
        id,
        content,
        reply_to_message_id,
    })
}

fn discord_fetch_command() -> Result<(), String> {
    let config =
        read_reply_listener_config()?.ok_or_else(|| "reply-listener config missing".to_string())?;
    let state_dir = default_state_dir()?;
    let after_message_id = read_discord_last_message_id(&state_dir);
    let response = perform_discord_fetch(&config, after_message_id.as_deref())?;
    process_first_discord_reply(&state_dir, &response)?;
    print!("{response}");
    Ok(())
}

fn extract_string(raw: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let idx = raw.find(&needle)?;
    let rest = &raw[idx + needle.len()..];
    let colon = rest.find(':')?;
    let value = rest[colon + 1..].trim_start();
    if !value.starts_with('"') {
        return None;
    }
    parse_json_string(value)
}

fn extract_nested_string(raw: &str, parent_key: &str, key: &str) -> Option<String> {
    let nested = extract_object(raw, parent_key)?;
    extract_string(nested, key)
}

fn extract_bool(raw: &str, key: &str) -> Option<bool> {
    let needle = format!("\"{key}\"");
    let idx = raw.find(&needle)?;
    let rest = &raw[idx + needle.len()..];
    let colon = rest.find(':')?;
    let value = rest[colon + 1..].trim_start();
    if value.starts_with("true") {
        Some(true)
    } else if value.starts_with("false") {
        Some(false)
    } else {
        None
    }
}

fn extract_u32(raw: &str, key: &str) -> Option<u32> {
    let needle = format!("\"{key}\"");
    let idx = raw.find(&needle)?;
    let rest = &raw[idx + needle.len()..];
    let colon = rest.find(':')?;
    let value = rest[colon + 1..].trim_start();
    let digits: String = value.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u32>().ok()
}

fn extract_u64(raw: &str, key: &str) -> Option<u64> {
    let needle = format!("\"{key}\"");
    let idx = raw.find(&needle)?;
    let rest = &raw[idx + needle.len()..];
    let colon = rest.find(':')?;
    let value = rest[colon + 1..].trim_start();
    let digits: String = value.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u64>().ok()
}

fn extract_string_array(raw: &str, key: &str) -> Vec<String> {
    let needle = format!("\"{key}\"");
    let Some(idx) = raw.find(&needle) else {
        return Vec::new();
    };
    let rest = &raw[idx + needle.len()..];
    let Some(colon) = rest.find(':') else {
        return Vec::new();
    };
    let value = rest[colon + 1..].trim_start();
    if !value.starts_with('[') {
        return Vec::new();
    }

    let mut items = Vec::new();
    let mut current = &value[1..];
    loop {
        let trimmed = current.trim_start();
        if trimmed.starts_with(']') {
            break;
        }
        let Some(parsed) = parse_json_string(trimmed) else {
            break;
        };
        if !parsed.trim().is_empty() {
            items.push(parsed);
        }
        let Some(closing_quote) = find_closing_quote(trimmed) else {
            break;
        };
        current = &trimmed[closing_quote + 1..];
        let trimmed = current.trim_start();
        if let Some(next) = trimmed.strip_prefix(',') {
            current = next;
            continue;
        }
        break;
    }
    items
}

fn find_closing_quote(raw: &str) -> Option<usize> {
    let mut chars = raw.char_indices();
    if chars.next()?.1 != '"' {
        return None;
    }
    let mut escaped = false;
    for (idx, ch) in chars {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '"' => return Some(idx),
            _ => {}
        }
    }
    None
}

fn read_discord_last_message_id(state_dir: &str) -> Option<String> {
    let state_path = state_file_path(state_dir);
    let existing = read_to_string(state_path).ok()?;
    extract_string(&existing, "discordLastMessageId")
}

fn lookup_message_mapping(
    state_dir: &str,
    platform: &str,
    message_id: &str,
) -> Result<Option<String>, String> {
    let path = registry_path(state_dir);
    if !path.exists() {
        return Ok(None);
    }
    let content = read_to_string(path)
        .map_err(|err| format!("failed reading reply-session-registry: {err}"))?;
    for line in content.lines() {
        if line.contains(&format!(r#""platform":"{}""#, platform))
            && line.contains(&format!(r#""messageId":"{}""#, message_id))
        {
            return Ok(Some(line.trim().to_string()));
        }
    }
    Ok(None)
}

fn inject_reply(state_dir: &str, pane_id: &str, text: &str, source: &str) -> Result<(), String> {
    let sanitized = sanitize_reply_input(text);
    if std::env::var_os("OMX_RUNTIME_REPLY_LISTENER_LIVE_SEND").is_some() {
        tmux::send_to_pane(pane_id, &sanitized, true)?;
    }
    append_injection_log(state_dir, pane_id, source, &sanitized)?;
    bump_injection_count(state_dir)?;
    Ok(())
}

fn process_first_discord_reply(state_dir: &str, response: &str) -> Result<(), String> {
    let Some(message) = parse_first_discord_message(response) else {
        return Ok(());
    };
    update_discord_last_message_id(state_dir, &message.id)?;
    let Some(reply_to_message_id) = message.reply_to_message_id.as_deref() else {
        return Ok(());
    };
    let Some(mapping) = lookup_message_mapping(state_dir, "discord-bot", reply_to_message_id)?
    else {
        return Ok(());
    };
    let Some(pane_id) = extract_string(&mapping, "tmuxPaneId") else {
        return Ok(());
    };
    inject_reply(state_dir, &pane_id, &message.content, "discord")
}

fn parse_json_string(raw: &str) -> Option<String> {
    let mut chars = raw.chars();
    if chars.next()? != '"' {
        return None;
    }

    let mut out = String::new();
    let mut escaped = false;
    let mut unicode = String::new();
    let mut unicode_remaining = 0usize;

    for ch in chars {
        if unicode_remaining > 0 {
            unicode.push(ch);
            unicode_remaining -= 1;
            if unicode_remaining == 0 {
                let value = u32::from_str_radix(&unicode, 16).ok()?;
                out.push(char::from_u32(value)?);
                unicode.clear();
            }
            continue;
        }

        if escaped {
            match ch {
                '"' => out.push('"'),
                '\\' => out.push('\\'),
                '/' => out.push('/'),
                'b' => out.push('\u{0008}'),
                'f' => out.push('\u{000C}'),
                'n' => out.push('\n'),
                'r' => out.push('\r'),
                't' => out.push('\t'),
                'u' => unicode_remaining = 4,
                _ => return None,
            }
            escaped = false;
            continue;
        }

        match ch {
            '\\' => escaped = true,
            '"' => return Some(out),
            _ => out.push(ch),
        }
    }

    None
}

fn extract_object<'a>(raw: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\"");
    let idx = raw.find(&needle)?;
    let rest = &raw[idx + needle.len()..];
    let colon = rest.find(':')?;
    let value = rest[colon + 1..].trim_start();
    let start = value.find('{')?;
    let value = &value[start..];
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (i, ch) in value.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(&value[..=i]);
                }
            }
            _ => {}
        }
    }

    None
}

fn append_log_line(state_dir: &str, message: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file_path(state_dir))
        .map_err(|err| format!("failed opening reply-listener log file: {err}"))?;
    file.write_all(message.as_bytes())
        .map_err(|err| format!("failed writing reply-listener log file: {err}"))
}

fn render_state_json(state: &NativeReplyListenerState) -> String {
    let pid = state
        .pid
        .map(|value| value.to_string())
        .unwrap_or_else(|| "null".to_string());
    let telegram = state
        .telegram_last_update_id
        .map(|value| value.to_string())
        .unwrap_or_else(|| "null".to_string());
    let discord = state
        .discord_last_message_id
        .as_ref()
        .map(|value| format!("\"{}\"", escape_json(value)))
        .unwrap_or_else(|| "null".to_string());

    format!(
        "{{\"isRunning\":{},\"pid\":{},\"startedAt\":\"{}\",\"lastPollAt\":\"{}\",\"telegramLastUpdateId\":{},\"discordLastMessageId\":{},\"messagesInjected\":{},\"errors\":{}}}\n",
        if state.is_running { "true" } else { "false" },
        pid,
        escape_json(&state.started_at),
        escape_json(&state.last_poll_at),
        telegram,
        discord,
        state.messages_injected,
        state.errors
    )
}

fn write_state(state_dir: &str, state: &NativeReplyListenerState) -> Result<(), String> {
    write(state_file_path(state_dir), render_state_json(state))
        .map_err(|err| format!("failed writing reply-listener state file: {err}"))
}

fn read_native_state(state_dir: &str) -> Option<NativeReplyListenerState> {
    let raw = read_to_string(state_file_path(state_dir)).ok()?;
    Some(NativeReplyListenerState {
        is_running: extract_bool(&raw, "isRunning").unwrap_or(false),
        pid: extract_u32(&raw, "pid"),
        started_at: extract_string(&raw, "startedAt").unwrap_or_else(current_timestamp),
        last_poll_at: extract_string(&raw, "lastPollAt").unwrap_or_else(current_timestamp),
        telegram_last_update_id: extract_u64(&raw, "telegramLastUpdateId"),
        discord_last_message_id: extract_string(&raw, "discordLastMessageId"),
        messages_injected: extract_u64(&raw, "messagesInjected").unwrap_or(0),
        errors: extract_u64(&raw, "errors").unwrap_or(0),
        last_error: extract_string(&raw, "lastError"),
    })
}

fn daemon_should_continue(state_dir: &str, current_pid: u32) -> bool {
    let pid_path = pid_file_path(state_dir);
    if !pid_path.exists() {
        return false;
    }

    let Ok(pid_raw) = read_to_string(&pid_path) else {
        return false;
    };
    if extract_pid(&pid_raw) != Some(current_pid) {
        return false;
    }

    read_native_state(state_dir)
        .map(|state| state.is_running)
        .unwrap_or(false)
}

fn run_poll_iteration(
    state_dir: &str,
    config: &NativeReplyListenerConfig,
    state: &mut NativeReplyListenerState,
) -> Result<(), String> {
    state.last_poll_at = current_timestamp();
    if config.discord_enabled {
        match perform_discord_fetch(config, state.discord_last_message_id.as_deref()) {
            Ok(response) => {
                process_first_discord_reply(state_dir, &response)?;
            }
            Err(error) => {
                state.errors += 1;
                state.last_error = Some(error.clone());
                append_log_line(
                    state_dir,
                    &format!("[native-runtime] discord poll error: {error}\n"),
                )?;
            }
        }
    } else if config.telegram_enabled {
        state.errors += 1;
        state.last_error = Some("telegram polling not yet implemented in native runtime".to_string());
        append_log_line(
            state_dir,
            "[native-runtime] telegram polling not yet implemented in native runtime\n",
        )?;
    }

    if let Some(next_state) = read_native_state(state_dir) {
        state.discord_last_message_id = next_state.discord_last_message_id;
        state.messages_injected = next_state.messages_injected;
        state.errors = state.errors.max(next_state.errors);
        state.last_error = next_state.last_error;
    }

    write_state(state_dir, state)
}

fn start_reply_listener(run_once: bool) -> Result<(), String> {
    let state_dir = default_state_dir()?;
    create_dir_all(&state_dir)
        .map_err(|err| format!("failed creating reply-listener state dir: {err}"))?;
    let config =
        read_reply_listener_config()?.ok_or_else(|| "reply-listener config missing".to_string())?;
    let pid = std::process::id();
    let now = current_timestamp();
    let mut state = read_native_state(&state_dir).unwrap_or(NativeReplyListenerState {
        is_running: true,
        pid: Some(pid),
        started_at: now.clone(),
        last_poll_at: now.clone(),
        telegram_last_update_id: None,
        discord_last_message_id: None,
        messages_injected: 0,
        errors: 0,
        last_error: None,
    });
    state.is_running = true;
    state.pid = Some(pid);
    state.last_poll_at = now.clone();

    write(
        pid_file_path(&state_dir),
        format!("{{\"pid\":{},\"started_at\":\"native-runtime\"}}\n", pid),
    )
    .map_err(|err| format!("failed writing reply-listener pid file: {err}"))?;
    write_state(&state_dir, &state)?;
    append_log_line(&state_dir, "[native-runtime] reply-listener initialized\n")?;

    if run_once {
        run_poll_iteration(&state_dir, &config, &mut state)?;
        return Ok(());
    }

    loop {
        if !daemon_should_continue(&state_dir, pid) {
            break;
        }
        run_poll_iteration(&state_dir, &config, &mut state)?;
        thread::sleep(Duration::from_millis(config.poll_interval_ms.max(100)));
    }

    state.is_running = false;
    state.pid = None;
    state.last_poll_at = current_timestamp();
    write_state(&state_dir, &state)?;
    append_log_line(&state_dir, "[native-runtime] reply-listener stopped\n")?;
    Ok(())
}

fn status_reply_listener() -> Result<(), String> {
    let state_dir = default_state_dir()?;
    let state_path = state_file_path(&state_dir);
    if !state_path.exists() {
        println!(r#"{{"success":true,"message":"Reply listener daemon has never been started"}}"#);
        return Ok(());
    }
    let mut state = read_native_state(&state_dir)
        .ok_or_else(|| "failed reading reply-listener state file".to_string())?;
    if let Some(pid) = state.pid {
        if pid == std::process::id() || !process_exists(pid) || !is_reply_listener_process(pid) {
            state.is_running = false;
            state.pid = None;
            let _ = remove_file(pid_file_path(&state_dir));
            write_state(&state_dir, &state)?;
        }
    } else {
        state.is_running = false;
    }
    println!(
        r#"{{"success":true,"message":"Reply listener daemon status","state":{}}}"#,
        render_state_json(&state).trim()
    );
    Ok(())
}

fn stop_reply_listener() -> Result<(), String> {
    let state_dir = default_state_dir()?;
    let pid_path = pid_file_path(&state_dir);

    let pid_raw = if pid_path.exists() {
        Some(
            read_to_string(&pid_path)
                .map_err(|err| format!("failed reading reply-listener pid file: {err}"))?,
        )
    } else {
        None
    };

    if let Some(raw) = pid_raw {
        let pid = extract_pid(&raw).unwrap_or_default();
        let _ = remove_file(&pid_path);

        if pid == 0 || !process_exists(pid) {
            println!(
                r#"{{"success":true,"message":"Reply listener daemon was not running (cleaned up stale PID file)"}}"#
            );
            return Ok(());
        }

        if !is_reply_listener_process(pid) {
            if pid == std::process::id() {
                println!(
                    r#"{{"success":true,"message":"Reply listener daemon was not running (cleaned up stale PID file)"}}"#
                );
                return Ok(());
            }
            println!(
                r#"{{"success":false,"message":"Refusing to kill PID {}: process identity does not match the reply listener daemon (stale or reused PID - removed PID file)"}}"#,
                pid
            );
            return Ok(());
        }

        let mut state = read_native_state(&state_dir).unwrap_or(NativeReplyListenerState {
            is_running: false,
            pid: None,
            started_at: current_timestamp(),
            last_poll_at: current_timestamp(),
            telegram_last_update_id: None,
            discord_last_message_id: None,
            messages_injected: 0,
            errors: 0,
            last_error: None,
        });
        state.is_running = false;
        state.pid = None;
        state.last_poll_at = current_timestamp();
        write_state(&state_dir, &state)?;
        if pid != std::process::id() {
            let _ = terminate_process(pid);
        }
        println!(
            r#"{{"success":true,"message":"Reply listener daemon stopped (PID {})"}}"#,
            pid
        );
        return Ok(());
    }

    println!(r#"{{"success":true,"message":"Reply listener daemon is not running"}}"#);
    Ok(())
}

fn process_exists(pid: u32) -> bool {
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
}

fn is_reply_listener_process(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        let path = format!("/proc/{pid}/cmdline");
        read_to_string(path)
            .map(|cmdline| cmdline.contains("reply-listener"))
            .unwrap_or(false)
    }

    #[cfg(all(unix, not(target_os = "linux")))]
    {
        return std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "args="])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).contains("reply-listener"))
            .unwrap_or(false);
    }

    #[cfg(windows)]
    {
        false
    }
}

fn terminate_process(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        let status = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .map_err(|err| format!("failed to launch kill: {err}"))?;
        if status.success() {
            return Ok(());
        }
        Err(format!("kill exited with {status}"))
    }
    #[cfg(windows)]
    {
        let status = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .map_err(|err| format!("failed to launch taskkill: {err}"))?;
        if status.success() {
            return Ok(());
        }
        return Err(format!("taskkill exited with {status}"));
    }
}

fn lookup_message_command(args: &[String]) -> Result<(), String> {
    let mut platform: Option<String> = None;
    let mut message_id: Option<String> = None;
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--platform" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("lookup-message requires a value after --platform".to_string());
                };
                platform = Some(value.clone());
                index += 2;
            }
            "--message-id" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("lookup-message requires a value after --message-id".to_string());
                };
                message_id = Some(value.clone());
                index += 2;
            }
            flag if flag.starts_with("--platform=") => {
                platform = Some(flag.trim_start_matches("--platform=").to_string());
                index += 1;
            }
            flag if flag.starts_with("--message-id=") => {
                message_id = Some(flag.trim_start_matches("--message-id=").to_string());
                index += 1;
            }
            unknown => return Err(format!("unknown lookup-message argument `{unknown}`")),
        }
    }

    let platform = platform.ok_or_else(|| "lookup-message requires --platform".to_string())?;
    let message_id =
        message_id.ok_or_else(|| "lookup-message requires --message-id".to_string())?;
    let state_dir = default_state_dir()?;
    if let Some(mapping) = lookup_message_mapping(&state_dir, &platform, &message_id)? {
        println!(
            r#"{{"success":true,"message":"mapping found","mapping":{}}}"#,
            mapping
        );
        return Ok(());
    }
    println!(r#"{{"success":true,"message":"mapping not found","mapping":null}}"#);
    Ok(())
}

fn inject_reply_command(args: &[String]) -> Result<(), String> {
    let mut pane_id: Option<String> = None;
    let mut text: Option<String> = None;
    let mut source: Option<String> = None;
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--pane-id" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("inject-reply requires a value after --pane-id".to_string());
                };
                pane_id = Some(value.clone());
                index += 2;
            }
            "--text" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("inject-reply requires a value after --text".to_string());
                };
                text = Some(value.clone());
                index += 2;
            }
            "--source" => {
                let Some(value) = args.get(index + 1) else {
                    return Err("inject-reply requires a value after --source".to_string());
                };
                source = Some(value.clone());
                index += 2;
            }
            flag if flag.starts_with("--pane-id=") => {
                pane_id = Some(flag.trim_start_matches("--pane-id=").to_string());
                index += 1;
            }
            flag if flag.starts_with("--text=") => {
                text = Some(flag.trim_start_matches("--text=").to_string());
                index += 1;
            }
            flag if flag.starts_with("--source=") => {
                source = Some(flag.trim_start_matches("--source=").to_string());
                index += 1;
            }
            unknown => return Err(format!("unknown inject-reply argument `{unknown}`")),
        }
    }

    let pane_id = pane_id.ok_or_else(|| "inject-reply requires --pane-id".to_string())?;
    let text = text.ok_or_else(|| "inject-reply requires --text".to_string())?;
    let source = source.unwrap_or_else(|| "native".to_string());

    let state_dir = default_state_dir()?;
    create_dir_all(&state_dir)
        .map_err(|err| format!("failed creating reply-listener state dir: {err}"))?;
    inject_reply(&state_dir, &pane_id, &text, &source)?;
    println!(
        r#"{{"success":true,"message":"Reply injected","paneId":"{}","source":"{}"}}"#,
        escape_json(&pane_id),
        escape_json(&source)
    );
    Ok(())
}

fn extract_pid(raw: &str) -> Option<u32> {
    let trimmed = raw.trim();
    if let Ok(pid) = trimmed.parse::<u32>() {
        return Some(pid);
    }
    let needle = "\"pid\":";
    let idx = trimmed.find(needle)?;
    let rest = &trimmed[idx + needle.len()..];
    let digits: String = rest
        .chars()
        .skip_while(|c| c.is_whitespace())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse::<u32>().ok()
}

fn sanitize_reply_input(raw: &str) -> String {
    raw.chars()
        .filter(|ch| !matches!(ch, '\u{0000}'..='\u{0008}' | '\u{000B}' | '\u{000C}' | '\u{000E}'..='\u{001F}' | '\u{007F}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'))
        .collect::<String>()
        .replace("\r\n", " ")
        .replace(['\n', '\r'], " ")
        .replace('\\', "\\\\")
        .replace('`', "\\`")
        .replace("$(", "\\$(")
        .replace("${", "\\${")
        .trim()
        .to_string()
}

fn append_injection_log(
    state_dir: &str,
    pane_id: &str,
    source: &str,
    text: &str,
) -> Result<(), String> {
    let log_path = log_file_path(state_dir);
    let existing = if log_path.exists() {
        read_to_string(&log_path).unwrap_or_default()
    } else {
        String::new()
    };
    let next = format!(
        "{}[native-runtime] inject-reply pane={} source={} text={}\n",
        existing, pane_id, source, text
    );
    write(log_path, next).map_err(|err| format!("failed writing reply-listener log file: {err}"))
}

fn bump_injection_count(state_dir: &str) -> Result<(), String> {
    let state_path = state_file_path(state_dir);
    let existing = read_to_string(&state_path).unwrap_or_default();
    let started_at = existing
        .split("\"startedAt\":\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .map(|value| value.to_string())
        .unwrap_or_else(current_timestamp);
    let discord_last_message_id = extract_string(&existing, "discordLastMessageId");
    let next_count = existing
        .split("\"messagesInjected\":")
        .nth(1)
        .and_then(|rest| {
            let digits: String = rest
                .chars()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit())
                .collect();
            digits.parse::<u64>().ok()
        })
        .unwrap_or(0)
        + 1;
    let errors = existing
        .split("\"errors\":")
        .nth(1)
        .and_then(|rest| {
            let digits: String = rest
                .chars()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit())
                .collect();
            digits.parse::<u64>().ok()
        })
        .unwrap_or(0);
    let now = current_timestamp();
    let discord_last_message_field = discord_last_message_id
        .map(|value| format!("\"{}\"", escape_json(&value)))
        .unwrap_or_else(|| "null".to_string());
    let content = format!(
        "{{\"isRunning\":true,\"pid\":{},\"startedAt\":\"{}\",\"lastPollAt\":\"{}\",\"telegramLastUpdateId\":null,\"discordLastMessageId\":{},\"messagesInjected\":{},\"errors\":{}}}\n",
        std::process::id(),
        started_at,
        now,
        discord_last_message_field,
        next_count,
        errors
    );
    write(state_path, content)
        .map_err(|err| format!("failed updating reply-listener state file: {err}"))
}

fn update_discord_last_message_id(state_dir: &str, message_id: &str) -> Result<(), String> {
    let state_path = state_file_path(state_dir);
    let existing = read_to_string(&state_path).unwrap_or_default();
    let started_at = existing
        .split("\"startedAt\":\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .map(|value| value.to_string())
        .unwrap_or_else(current_timestamp);
    let messages_injected = existing
        .split("\"messagesInjected\":")
        .nth(1)
        .and_then(|rest| {
            let digits: String = rest
                .chars()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit())
                .collect();
            digits.parse::<u64>().ok()
        })
        .unwrap_or(0);
    let errors = existing
        .split("\"errors\":")
        .nth(1)
        .and_then(|rest| {
            let digits: String = rest
                .chars()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit())
                .collect();
            digits.parse::<u64>().ok()
        })
        .unwrap_or(0);
    let now = current_timestamp();
    let content = format!(
        "{{\"isRunning\":true,\"pid\":{},\"startedAt\":\"{}\",\"lastPollAt\":\"{}\",\"telegramLastUpdateId\":null,\"discordLastMessageId\":\"{}\",\"messagesInjected\":{},\"errors\":{},\"lastError\":null}}\n",
        std::process::id(),
        started_at,
        now,
        escape_json(message_id),
        messages_injected,
        errors
    );
    write(state_path, content).map_err(|err| format!("failed updating discordLastMessageId: {err}"))
}

fn escape_json(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::{
        build_discord_fetch_command, discord_fetch_command, extract_pid, inject_reply_command,
        is_reply_listener_process, lookup_message_command, parse_first_discord_message,
        parse_reply_listener_config, perform_discord_fetch, process_first_discord_reply,
        run_reply_listener, sanitize_reply_input, status_reply_listener, stop_reply_listener,
    };
    use crate::test_support::env_lock;
    use std::fs::read_to_string;
    use std::path::PathBuf;

    fn with_temp_home<T>(name: &str, f: impl FnOnce(PathBuf) -> T) -> T {
        let _guard = env_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = std::env::temp_dir().join(format!(
            "omx-runtime-reply-listener-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("expected temp home");
        let previous_home = std::env::var_os("HOME");
        let previous_live_send = std::env::var_os("OMX_RUNTIME_REPLY_LISTENER_LIVE_SEND");
        std::env::set_var("HOME", &root);
        let state_dir = root.join(".omx").join("state");
        std::fs::create_dir_all(&state_dir).expect("expected state dir");
        std::env::remove_var("OMX_RUNTIME_REPLY_LISTENER_LIVE_SEND");
        let result = f(state_dir);
        if let Some(home) = previous_home {
            std::env::set_var("HOME", home);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(value) = previous_live_send {
            std::env::set_var("OMX_RUNTIME_REPLY_LISTENER_LIVE_SEND", value);
        } else {
            std::env::remove_var("OMX_RUNTIME_REPLY_LISTENER_LIVE_SEND");
        }
        let _ = std::fs::remove_dir_all(&root);
        result
    }

    #[test]
    fn extract_pid_supports_raw_number_and_json_payload() {
        assert_eq!(
            extract_pid(
                "1234
"
            ),
            Some(1234)
        );
        assert_eq!(
            extract_pid(r#"{"pid":4321,"started_at":"native-runtime"}"#),
            Some(4321)
        );
    }

    #[test]
    fn reply_listener_process_detection_rejects_current_process() {
        assert!(!is_reply_listener_process(std::process::id()));
    }

    #[test]
    fn stop_reply_listener_treats_current_process_pid_as_stale() {
        with_temp_home("stop-stale-self", |state_dir| {
            std::fs::write(
                state_dir.join("reply-listener.pid"),
                std::process::id().to_string(),
            )
            .expect("expected pid file");

            assert!(stop_reply_listener().is_ok());
            assert!(!state_dir.join("reply-listener.pid").exists());
        });
    }

    #[test]
    fn status_reply_listener_cleans_up_stale_self_pid() {
        with_temp_home("status-stale-self", |state_dir| {
            std::fs::write(
                state_dir.join("reply-listener-state.json"),
                format!(
                    r#"{{"isRunning":true,"pid":{},"startedAt":"now","lastPollAt":"now","telegramLastUpdateId":null,"discordLastMessageId":null,"messagesInjected":0,"errors":0}}
"#,
                    std::process::id()
                ),
            )
            .expect("expected state file");
            std::fs::write(
                state_dir.join("reply-listener.pid"),
                std::process::id().to_string(),
            )
            .expect("expected pid file");

            assert!(status_reply_listener().is_ok());
            let state = read_to_string(state_dir.join("reply-listener-state.json"))
                .expect("expected updated state");
            assert!(state.contains(r#""isRunning":false"#));
            assert!(state.contains(r#""pid":null"#));
            assert!(!state_dir.join("reply-listener.pid").exists());
        });
    }

    #[test]
    fn sanitize_reply_input_matches_ts_guardrails() {
        let sanitized = sanitize_reply_input("$(rm -rf /)\n`hi`\0${PATH}\u{202E}ok\\end");
        assert_eq!(sanitized, "\\$(rm -rf /) \\`hi\\`\\${PATH}ok\\\\end");
    }

    #[test]
    fn reply_listener_once_runs() {
        with_temp_home("runs", |state_dir| {
            std::fs::write(
                state_dir.join("reply-listener-config.json"),
                r#"{"discordEnabled":false,"telegramEnabled":false}"#,
            )
            .expect("expected config");
            assert!(run_reply_listener(&["--once".into()]).is_ok());
        });
    }

    #[test]
    fn reply_listener_once_writes_running_state() {
        with_temp_home("state", |state_dir| {
            let state_path = state_dir.join("reply-listener-state.json");
            std::fs::write(
                state_dir.join("reply-listener-config.json"),
                r#"{"discordEnabled":false,"telegramEnabled":false}"#,
            )
            .expect("expected config");
            assert!(run_reply_listener(&["--once".into()]).is_ok());
            let content = read_to_string(state_path).expect("expected state file");
            assert!(content.contains("\"isRunning\":true"));
            assert!(content.contains("\"lastPollAt\":\""));
        });
    }

    #[test]
    fn reply_listener_status_and_stop_commands_run() {
        with_temp_home("status-stop", |state_dir| {
            std::fs::write(
                state_dir.join("reply-listener-config.json"),
                r#"{"discordEnabled":false,"telegramEnabled":false}"#,
            )
            .expect("expected config");
            assert!(run_reply_listener(&["--once".into()]).is_ok());
            assert!(status_reply_listener().is_ok());
            assert!(stop_reply_listener().is_ok());
        });
    }

    #[test]
    fn inject_reply_updates_log_and_state() {
        with_temp_home("inject", |state_dir| {
            std::fs::write(
                state_dir.join("reply-listener-config.json"),
                r#"{"discordEnabled":false,"telegramEnabled":false}"#,
            )
            .expect("expected config");
            assert!(run_reply_listener(&["--once".into()]).is_ok());
            assert!(inject_reply_command(&[
                "--pane-id".into(),
                "%1".into(),
                "--text".into(),
                "hello".into(),
                "--source".into(),
                "discord".into(),
            ])
            .is_ok());
            let content = read_to_string(state_dir.join("reply-listener-state.json"))
                .expect("expected updated state");
            assert!(content.contains("\"messagesInjected\":1"));
        });
    }

    #[test]
    fn lookup_message_returns_null_when_registry_missing() {
        with_temp_home("lookup-missing", |_| {
            assert!(lookup_message_command(&[
                "--platform".into(),
                "discord-bot".into(),
                "--message-id".into(),
                "123".into(),
            ])
            .is_ok());
        });
    }

    #[test]
    fn parses_discord_config_subset() {
        let parsed = parse_reply_listener_config(
            r#"{"discordEnabled":true,"telegramEnabled":false,"pollIntervalMs":1234,"discordBotToken":"abc","discordChannelId":"chan","rateLimitPerMinute":7,"maxMessageLength":123}"#,
        );
        assert!(parsed.discord_enabled);
        assert!(!parsed.telegram_enabled);
        assert_eq!(parsed.poll_interval_ms, 1234);
        assert_eq!(parsed.discord_bot_token.as_deref(), Some("abc"));
        assert_eq!(parsed.discord_channel_id.as_deref(), Some("chan"));
        assert_eq!(parsed.rate_limit_per_minute, 7);
        assert_eq!(parsed.max_message_length, 123);
        assert!(parsed.include_prefix);
        assert!(parsed.authorized_discord_user_ids.is_empty());
    }

    #[test]
    fn parses_and_clamps_extended_reply_listener_config() {
        let parsed = parse_reply_listener_config(
            r#"{"discordEnabled":true,"discordBotToken":"abc","discordChannelId":"chan","telegramEnabled":true,"telegramBotToken":"tg","telegramChatId":"chat","pollIntervalMs":1,"rateLimitPerMinute":0,"maxMessageLength":999999,"includePrefix":false,"authorizedDiscordUserIds":["123","","  ","456"]}"#,
        );
        assert_eq!(parsed.telegram_bot_token.as_deref(), Some("tg"));
        assert_eq!(parsed.telegram_chat_id.as_deref(), Some("chat"));
        assert_eq!(parsed.poll_interval_ms, 500);
        assert_eq!(parsed.rate_limit_per_minute, 1);
        assert_eq!(parsed.max_message_length, 4_000);
        assert!(!parsed.include_prefix);
        assert_eq!(parsed.authorized_discord_user_ids, vec!["123", "456"]);
    }

    #[test]
    fn builds_discord_fetch_command_with_after_cursor() {
        let config = parse_reply_listener_config(
            r#"{"discordEnabled":true,"discordBotToken":"abc","discordChannelId":"chan"}"#,
        );
        let (program, args) =
            build_discord_fetch_command(&config, Some("555")).expect("expected fetch command");
        assert_eq!(program, "curl");
        assert_eq!(args[0], "-fsSL");
        assert_eq!(args[2], "Authorization: Bot abc");
        assert!(args[3].contains("/channels/chan/messages?after=555&limit=10"));
    }

    #[test]
    fn discord_fetch_fails_fast_when_disabled() {
        let config = parse_reply_listener_config(r#"{"discordEnabled":false}"#);
        let error =
            perform_discord_fetch(&config, None).expect_err("expected disabled polling error");
        assert!(error.contains("disabled"));
    }

    #[test]
    fn discord_last_message_id_progression_updates_state() {
        with_temp_home("discord-last-id", |state_dir| {
            std::fs::write(
                state_dir.join("reply-listener-config.json"),
                r#"{"discordEnabled":false,"telegramEnabled":false}"#,
            )
            .expect("expected config");
            assert!(run_reply_listener(&["--once".into()]).is_ok());
            assert!(super::update_discord_last_message_id(
                state_dir.to_str().expect("state dir str"),
                "msg-123",
            )
            .is_ok());
            let content = read_to_string(state_dir.join("reply-listener-state.json"))
                .expect("expected state");
            assert!(content.contains("\"discordLastMessageId\":\"msg-123\""));
        });
    }

    #[test]
    fn parse_first_discord_message_extracts_reply_fields() {
        let raw = r#"[{"id":"msg-1","content":"hello","message_reference":{"message_id":"root-9"}},{"id":"msg-2"}]"#;
        let parsed = parse_first_discord_message(raw).expect("expected first discord message");
        assert_eq!(parsed.id, "msg-1");
        assert_eq!(parsed.content, "hello");
        assert_eq!(parsed.reply_to_message_id.as_deref(), Some("root-9"));
    }

    #[test]
    fn parse_first_discord_message_unescapes_content() {
        let raw = r#"[{"id":"msg-1","content":"hello\n\"codex\"","message_reference":{"message_id":"root-9"}}]"#;
        let parsed = parse_first_discord_message(raw).expect("expected first discord message");
        assert_eq!(parsed.content, "hello\n\"codex\"");
    }

    #[test]
    fn discord_fetch_command_updates_cursor_from_response() {
        with_temp_home("discord-fetch-command", |state_dir| {
            let config_path = state_dir.join("reply-listener-config.json");
            std::fs::write(
                &config_path,
                r#"{"discordEnabled":true,"discordBotToken":"abc","discordChannelId":"chan"}"#,
            )
            .expect("expected config file");

            let curl_path = state_dir.join("curl");
            std::fs::write(
                &curl_path,
                "#!/bin/sh\nprintf '[{\"id\":\"msg-9\",\"content\":\"hello\"}]'\n",
            )
            .expect("expected curl shim");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = std::fs::metadata(&curl_path)
                    .expect("metadata")
                    .permissions();
                perms.set_mode(0o755);
                std::fs::set_permissions(&curl_path, perms).expect("chmod");
            }

            let previous_path = std::env::var_os("PATH");
            std::env::set_var("PATH", &state_dir);
            let result = discord_fetch_command();
            if let Some(path) = previous_path {
                std::env::set_var("PATH", path);
            } else {
                std::env::remove_var("PATH");
            }

            assert!(result.is_ok());
            let content = read_to_string(state_dir.join("reply-listener-state.json"))
                .expect("expected state");
            assert!(content.contains("\"discordLastMessageId\":\"msg-9\""));
        });
    }

    #[test]
    fn process_first_discord_reply_uses_lookup_and_increments_messages() {
        with_temp_home("discord-live-correlation", |state_dir| {
            std::fs::write(
                state_dir.join("reply-listener-config.json"),
                r#"{"discordEnabled":false,"telegramEnabled":false}"#,
            )
            .expect("expected config");
            assert!(run_reply_listener(&["--once".into()]).is_ok());
            std::fs::write(
                state_dir.join("reply-session-registry.jsonl"),
                r#"{"platform":"discord-bot","messageId":"root-9","sessionId":"s","tmuxPaneId":"%7","tmuxSessionName":"t","event":"session-start","createdAt":"now"}"#,
            )
            .expect("registry");
            let response =
                r#"[{"id":"msg-9","content":"hello","message_reference":{"message_id":"root-9"}}]"#;
            assert!(
                process_first_discord_reply(state_dir.to_str().expect("state dir"), response,)
                    .is_ok()
            );
            let state = read_to_string(state_dir.join("reply-listener-state.json"))
                .expect("expected state");
            assert!(state.contains("\"discordLastMessageId\":\"msg-9\""));
            assert!(state.contains("\"messagesInjected\":1"));
            let log = read_to_string(state_dir.join("reply-listener.log")).expect("expected log");
            assert!(log.contains("inject-reply pane=%7"));
        });
    }
}
