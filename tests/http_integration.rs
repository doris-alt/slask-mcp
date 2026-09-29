//! Integration tests for the HTTP (streamable) transport, including the
//! optional Bearer-token auth.
//!
//! These drive the real router built by `new_http_stack` — auth middleware
//! plus the rmcp `StreamableHttpService` — via `Router::call`, with no
//! sockets involved.

use axum::http::{header, Method, Request, StatusCode};
use axum::{body::Body, response::Response};
use serde_json::Value;
use slask_mcp::{AuthConfig, new_http_stack};
use tower::Service;

const TEST_TOKEN: &str = "super-secret-test-token";

/// A POST of a JSON-RPC message to `/mcp`. `auth` is `None` (no header) or
/// a preformatted `Authorization` header value.
fn rpc_request(body: &str, auth: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder()
        .uri("/mcp")
        .method(Method::POST)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json, text/event-stream")
        // rmcp validates the Host header (DNS rebinding protection); set it
        // explicitly since there is no TCP connection supplying it.
        .header(header::HOST, "127.0.0.1");
    if let Some(auth) = auth {
        builder = builder.header(header::AUTHORIZATION, auth);
    }
    builder
        .body(Body::from(body.to_string()))
        .expect("valid request")
}

/// Drive a JSON-RPC message through the full router and return the response.
async fn send(
    app: &mut axum::Router,
    body: &str,
    auth: Option<&str>,
) -> Response {
    app
        .call(rpc_request(body, auth))
        .await
        // The Router's Service impl never errors out of band; HTTP errors
        // come back as responses.
        .expect("router returned an error")
}

/// Read a response body to completion and parse it as JSON.
async fn json_body(res: Response) -> anyhow::Result<Value> {
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .expect("failed to read response body");
    Ok(serde_json::from_slice(&bytes)?)
}

/// Tool names in the `matched` list of a `search_tools` `tools/call` reply.
/// The search tool returns its result as structured output, so the names live
/// under `result.structuredContent.matched` (not in `content` like the text
/// tools `echo` / `current_time_utc`).
fn search_matched_names(body: &Value) -> Vec<&str> {
    body["result"]["structuredContent"]["matched"]
        .as_array()
        .expect("search_tools result must have a matched array")
        .iter()
        .map(|m| m["name"].as_str().expect("matched tool must have a name"))
        .collect()
}

// ---------------------------------------------------------------------------
// Auth disabled (SLASK_MCP_TOKEN unset / empty)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn initialize_returns_server_info_when_auth_disabled() -> anyhow::Result<()> {
    let (mut app, _ct) = new_http_stack(AuthConfig { token: None });
    let res = send(
        &mut app,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"raw-test","version":"0.0.0"}}}"#,
        None,
    )
    .await;

    assert!(res.status().is_success());
    let body = json_body(res).await?;
    assert_eq!(body["result"]["serverInfo"]["name"].as_str(), Some("slask-mcp"));
    Ok(())
}

#[tokio::test]
async fn tools_list_works_without_auth() -> anyhow::Result<()> {
    let (mut app, _ct) = new_http_stack(AuthConfig { token: None });
    let res = send(
        &mut app,
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
        None,
    )
    .await;

    assert!(res.status().is_success());
    let body = json_body(res).await?;
    let names: Vec<&str> = body["result"]["tools"]
        .as_array()
        .expect("tools array")
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"echo"));
    assert!(names.contains(&"current_time_utc"));
    Ok(())
}

#[tokio::test]
async fn echo_returns_message_when_auth_disabled() -> anyhow::Result<()> {
    let (mut app, _ct) = new_http_stack(AuthConfig { token: None });
    let res = send(
        &mut app,
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hello auth"}}}"#,
        None,
    )
    .await;

    assert!(res.status().is_success());
    let body = json_body(res).await?;
    assert_eq!(body["result"]["content"][0]["text"].as_str(), Some("hello auth"));
    assert_eq!(body["result"]["isError"].as_bool(), Some(false));
    Ok(())
}

#[tokio::test]
async fn current_time_utc_is_rfc3339_utc_when_auth_disabled() -> anyhow::Result<()> {
    let (mut app, _ct) = new_http_stack(AuthConfig { token: None });
    let res = send(
        &mut app,
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"current_time_utc","arguments":{}}}"#,
        None,
    )
    .await;

    assert!(res.status().is_success());
    let body = json_body(res).await?;
    let ts = body["result"]["content"][0]["text"].as_str().unwrap();
    // `parse_from_rfc3339` yields a `DateTime<FixedOffset>`; a UTC instant
    // has equal naive-UTC and naive-local representations.
    let dt: chrono::DateTime<chrono::FixedOffset> =
        chrono::DateTime::parse_from_rfc3339(ts).expect("must be RFC 3339");
    assert_eq!(dt.naive_utc(), dt.naive_local());
    // Must be close to "now".
    assert!(dt.signed_duration_since(chrono::Utc::now()).abs() < chrono::TimeDelta::weeks(1));
    Ok(())
}

// ---------------------------------------------------------------------------
// search_tools
// ---------------------------------------------------------------------------

#[tokio::test]
async fn search_tools_returns_all_tools_sorted_for_empty_query() -> anyhow::Result<()> {
    let (mut app, _ct) = new_http_stack(AuthConfig { token: None });
    let res = send(
        &mut app,
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_tools","arguments":{"query":""}}}"#,
        None,
    )
    .await;

    assert!(res.status().is_success());
    let body = json_body(res).await?;
    assert_eq!(body["result"]["isError"].as_bool(), Some(false));
    assert_eq!(body["result"]["structuredContent"]["query"], "");
    assert_eq!(body["result"]["structuredContent"]["total"], 3);
    // The registry is a HashMap, so the tool sorts results by name to be
    // deterministic.
    assert_eq!(
        search_matched_names(&body),
        vec!["current_time_utc", "echo", "search_tools"]
    );
    // Every match mirrors the shape of a `tools/list` tool entry: name,
    // description and inputSchema.
    for m in body["result"]["structuredContent"]["matched"].as_array().unwrap() {
        assert!(m["name"].is_string());
        assert!(m["description"].is_string());
        assert!(m["inputSchema"].is_object());
    }
    Ok(())
}

#[tokio::test]
async fn search_tools_matches_name_case_insensitive() -> anyhow::Result<()> {
    // Uppercase "ECHO" must match tool `echo` (name match, case-insensitive).
    let (mut app, _ct) = new_http_stack(AuthConfig { token: None });
    let res = send(
        &mut app,
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_tools","arguments":{"query":"ECHO"}}}"#,
        None,
    )
    .await;

    assert!(res.status().is_success());
    let body = json_body(res).await?;
    assert_eq!(search_matched_names(&body), vec!["echo"]);
    Ok(())
}

#[tokio::test]
async fn search_tools_matches_description_substring() -> anyhow::Result<()> {
    // "client" appears in no tool name but in `echo`'s description — proves
    // descriptions are searchable, not just names.
    let (mut app, _ct) = new_http_stack(AuthConfig { token: None });
    let res = send(
        &mut app,
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_tools","arguments":{"query":"client"}}}"#,
        None,
    )
    .await;

    assert!(res.status().is_success());
    let body = json_body(res).await?;
    assert_eq!(search_matched_names(&body), vec!["echo"]);
    Ok(())
}

// ---------------------------------------------------------------------------
// Auth enabled (SLASK_MCP_TOKEN set)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn missing_authorization_header_is_401() -> anyhow::Result<()> {
    let (mut app, _ct) = new_http_stack(AuthConfig { token: Some(TEST_TOKEN.into()) });
    let res = send(
        &mut app,
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
        None,
    )
    .await;

    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        res.headers().get(header::WWW_AUTHENTICATE).unwrap().to_str().unwrap(),
        r#"Bearer realm="mcp""#,
    );
    assert_eq!(
        res.headers().get(header::CONTENT_TYPE).unwrap().to_str().unwrap(),
        "application/json",
    );
    let body = json_body(res).await?;
    assert_eq!(body["error"].as_str(), Some("Unauthorized"));
    assert_eq!(
        body["detail"].as_str(),
        Some("Missing or invalid Authorization: Bearer header.")
    );
    Ok(())
}

#[tokio::test]
async fn wrong_bearer_token_is_401() -> anyhow::Result<()> {
    let (mut app, _ct) = new_http_stack(AuthConfig { token: Some(TEST_TOKEN.into()) });
    let res = send(
        &mut app,
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
        Some("not-the-right-token"),
    )
    .await;

    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert!(res.headers().contains_key(header::WWW_AUTHENTICATE));
    Ok(())
}

#[tokio::test]
async fn initialize_is_401_without_authorization_when_token_set() -> anyhow::Result<()> {
    let (mut app, _ct) = new_http_stack(AuthConfig { token: Some(TEST_TOKEN.into()) });
    let res = send(
        &mut app,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"raw-test","version":"0.0.0"}}}"#,
        None,
    )
    .await;

    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    Ok(())
}

#[tokio::test]
async fn tools_list_allowed_with_correct_bearer() -> anyhow::Result<()> {
    let (mut app, _ct) = new_http_stack(AuthConfig { token: Some(TEST_TOKEN.into()) });
    let res = send(
        &mut app,
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#,
        Some(&format!("Bearer {}", TEST_TOKEN)),
    )
    .await;

    assert!(res.status().is_success());
    let body = json_body(res).await?;
    let names: Vec<&str> = body["result"]["tools"]
        .as_array()
        .expect("tools array")
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"echo"));
    assert!(names.contains(&"current_time_utc"));
    Ok(())
}

#[tokio::test]
async fn echo_allowed_with_correct_bearer() -> anyhow::Result<()> {
    let (mut app, _ct) = new_http_stack(AuthConfig { token: Some(TEST_TOKEN.into()) });
    let res = send(
        &mut app,
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hello auth"}}}"#,
        Some(&format!("Bearer {}", TEST_TOKEN)),
    )
    .await;

    assert!(res.status().is_success());
    let body = json_body(res).await?;
    assert_eq!(body["result"]["content"][0]["text"].as_str(), Some("hello auth"));
    assert_eq!(body["result"]["isError"].as_bool(), Some(false));
    Ok(())
}

#[tokio::test]
async fn correct_bearer_with_lowercase_scheme_is_allowed() -> anyhow::Result<()> {
    // The Bearer scheme is matched case-insensitively (`eq_ignore_ascii_case`
    // in `has_bearer`), so `authorization: bearer <token>` must also be
    // accepted.
    let (mut app, _ct) = new_http_stack(AuthConfig { token: Some(TEST_TOKEN.into()) });
    let mut req = rpc_request(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#, None);
    let value: header::HeaderValue = format!("bearer {}", TEST_TOKEN)
        .parse()
        .expect("valid header value");
    req.headers_mut().insert(header::AUTHORIZATION, value);
    let res = app.call(req).await.expect("router returned an error");

    assert!(res.status().is_success());
    let body = json_body(res).await?;
    assert!(body["result"]["tools"].is_array());
    Ok(())
}

// ---------------------------------------------------------------------------
// Request size limits
// ---------------------------------------------------------------------------

#[tokio::test]
async fn payload_too_large_is_rejected() -> anyhow::Result<()> {
    // Exceed the baseplate DefaultBodyLimit of 1 MiB in `new_http_stack`.
    // Auth header must be correct so we reach the body limit check.
    let (mut app, _ct) = new_http_stack(AuthConfig { token: Some(TEST_TOKEN.into()) });

    let big_message = "x".repeat(1_200_000);
    let body = format!(
        r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"echo","arguments":{{"message":"{}"}}}}}}"#,
        big_message
    );

    let res = send(
        &mut app,
        &body,
        Some(&format!("Bearer {}", TEST_TOKEN)),
    )
    .await;

    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
    Ok(())
}
