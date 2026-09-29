//! Demo MCP server.
//! Tools: `echo(message)` · `current_time_utc()`.
//!
//! `slask-mcp`            -> serve over stdio
//! `slask-mcp --http`     -> serve over Streamable HTTP at 127.0.0.1:$SLASK_MCP_PORT/mcp

use anyhow::Result;
use chrono::Utc;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager,
    StreamableHttpServerConfig,
    StreamableHttpService,
};
use rmcp::transport::stdio;
use rmcp::{ServiceExt, ServerHandler, tool, tool_handler, tool_router};

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderName, Request, Response, StatusCode};
use axum::middleware::{from_fn_with_state, Next};
use axum::Router;

/// Tool input for `echo`.
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct EchoParams {
    message: String,
}

#[derive(Clone)]
struct SlaskTools;

#[tool_router]
impl SlaskTools {
    #[tool(description = "Echoes the input string back to the client.")]
    fn echo(&self, Parameters(EchoParams { message }): Parameters<EchoParams>) -> String {
        message
    }

    #[tool(description = "Current UTC date and time, ISO 8601.")]
    fn current_time_utc(&self) -> String {
        Utc::now().to_rfc3339()
    }
}

/// `tool_handler` auto-generates `call_tool` / `list_tools` / `get_tool`
/// and `get_info()` (tools enabled) from `SlaskTools::tool_router()`.
/// An empty impl is therefore sufficient.
#[tool_handler(
    name = "slask-mcp",
    instructions = "Demo server. Tools: `echo({\"message\":...})` echoes a string; `current_time_utc()` returns the current UTC time in ISO 8601.",
)]
impl ServerHandler for SlaskTools {}

// --- HTTP Bearer-token auth (stdio is a separate code path; unaffected) ---

/// HTTP auth config. `token` is `None` unless `SLASK_MCP_TOKEN` is set and
/// non-empty; then every `/mcp` request must carry `Authorization: Bearer <token>`.
#[derive(Clone)]
struct AuthConfig {
    token: Option<String>,
}

/// True if `headers` carry `Authorization: Bearer <token>` (scheme is case-insensitive).
fn has_bearer(headers: &HeaderMap, token: &str) -> bool {
    let Some(value) = headers.get("authorization").and_then(|h| h.to_str().ok()) else {
        return false;
    };
    let mut parts = value.split_whitespace();
    let scheme = match parts.next() {
        Some(s) => s,
        None => return false,
    };
    let t = match parts.next() {
        Some(t) => t,
        None => return false,
    };
    if !scheme.eq_ignore_ascii_case("bearer") {
        return false;
    }
    // Constant-time comparison (length checked first; the loop never short-circuits).
    let a = t.as_bytes();
    let b = token.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut ok = true;
    for (x, y) in a.iter().zip(b.iter()) {
        ok &= x == y;
    }
    ok
}

/// `401 Unauthorized` with the header the MCP spec expects, so a client knows to authenticate.
fn unauthorized_response() -> Response<Body> {
    Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        // Lowercase: `HeaderName::from_static` (http 1.5) only accepts the
        // canonical lowercase token set, which matches the header's canonical form.
        .header(HeaderName::from_static("www-authenticate"), "Bearer realm=\"mcp\"")
        .header(HeaderName::from_static("content-type"), "application/json")
        .body(Body::from(
            r#"{"error":"Unauthorized","detail":"Missing or invalid Authorization: Bearer header."}"#,
        ))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

/// Enforce `Authorization: Bearer` on the HTTP transport when a token is configured.
async fn auth_middleware(
    State(cfg): State<AuthConfig>,
    req: Request<Body>,
    next: Next,
) -> Response<Body> {
    if let Some(token) = cfg.token.as_deref()
        && !has_bearer(req.headers(), token)
    {
        return unauthorized_response();
    }
    next.run(req).await
}

#[tokio::main]
async fn main() -> Result<()> {
    // MCP over stdio carries JSON-RPC on stdout -> never log to stdout.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();

    if std::env::args().any(|a| a == "--http") {
        http_server().await?;
    } else {
        stdio_server().await?;
    }
    Ok(())
}

async fn stdio_server() -> Result<()> {
    tracing::info!("serving MCP over stdio (Ctrl+C to quit)");
    let service = SlaskTools {}.serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}

async fn http_server() -> Result<()> {
    let _ = dotenvy::dotenv(); // load .env if present; ignored if absent
    let bind = match std::env::var("SLASK_MCP_BIND") {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => "127.0.0.1".to_string(),
    };
    let port: u16 = std::env::var("SLASK_MCP_PORT")
        .unwrap_or_default()
        .as_str()
        .parse::<u16>()
        .unwrap_or(8000);

    // Optional Bearer token for the HTTP transport (stdio stays open).
    let token = std::env::var("SLASK_MCP_TOKEN")
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let auth = AuthConfig { token };

    let ct = tokio_util::sync::CancellationToken::new();
    let service = StreamableHttpService::new(
        || Ok(SlaskTools {}),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false) // stateless (no per-client state)
            .with_json_response(true)         // plain JSON replies (easy to test with curl)
            .with_cancellation_token(ct.child_token()),
    );
    let addr = format!("{}:{}", bind, port);
    if auth.token.is_some() {
        tracing::info!(addr, "serving MCP over streamable HTTP at {addr}/mcp (Bearer auth enabled)");
    } else {
        tracing::info!(addr, "serving MCP over streamable HTTP at {addr}/mcp (no auth)");
    }
    // The layer must wrap the nested service, so it is applied *after*
    // `nest_service` (axum applies layers to routes that already exist).
    let router = Router::new()
        .nest_service("/mcp", service)
        .layer(from_fn_with_state(auth, auth_middleware));
    let tcp = tokio::net::TcpListener::bind(&addr).await?;
    let _ = axum::serve(tcp, router)
        .with_graceful_shutdown(async move {
            tokio::signal::ctrl_c().await.ok();
            ct.cancel();
        })
        .await;
    Ok(())
}
