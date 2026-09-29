//! Demo MCP server.
//! Tools: `echo(message)` · `current_time_utc()` · `search_tools(query)`.
//!
//! - **Stdio**: `serve_stdio()` — speak JSON-RPC over stdin/stdout.
//! - **Streamable HTTP**: `new_http_stack(auth)` — router at `/mcp`, optionally
//!   guarded by `Authorization: Bearer` (see `AuthConfig`).

use anyhow::Result;
use chrono::Utc;
use rmcp::handler::server::wrapper::{Json, Parameters};
use serde_json::Value;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager,
    StreamableHttpServerConfig,
    StreamableHttpService,
};
use rmcp::transport::stdio;
use rmcp::{ServiceExt, ServerHandler, tool, tool_handler, tool_router};

use axum::body::Body;
use axum::extract::DefaultBodyLimit;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderName, Request, Response, StatusCode};
use axum::middleware::{from_fn_with_state, Next};
use axum::Router;
use tokio_util::sync::CancellationToken;
use std::time::Duration;
use tower::timeout::TimeoutLayer;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/// Tool input for `echo`.
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct EchoParams {
    message: String,
}

/// Tool input for `search_tools`.
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SearchToolsParams {
    query: String,
}

/// One tool matched by a `search_tools` query.
#[derive(Debug, serde::Serialize, schemars::JsonSchema)]
struct SearchMatch {
    /// The tool's name, as advertised by `tools/list`.
    name: String,
    /// The tool's JSON Schema, exactly as `tools/list` reports it.
    #[serde(rename = "inputSchema")]
    input_schema: Value,
    /// The human-readable description used for matching and shown to the client.
    description: String,
}

/// The full result of a `search_tools` query, delivered as structured output.
#[derive(Debug, serde::Serialize, schemars::JsonSchema)]
struct SearchResult {
    /// The query as submitted.
    query: String,
    /// Total number of tools the server advertises (`matched` when the query
    /// is empty).
    total: usize,
    /// Tools whose name or description contains the query (case-insensitive
    /// substring), sorted by name.
    matched: Vec<SearchMatch>,
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

    /// Search the advertised tools by a case-insensitive substring of their
    /// name or description (empty query matches all). Results are returned as
    /// structured output (`structuredContent`) with each match carrying its
    /// `inputSchema`, so clients can re-read the schema for any tool without
    /// a fresh `tools/list`.
    #[tool(description = "Search slask-mcp tools by a case-insensitive substring of their name or description. Returns a structured list of matching tools with their input schemas.")]
    fn search_tools(
        &self,
        Parameters(SearchToolsParams { query }): Parameters<SearchToolsParams>,
    ) -> Json<SearchResult> {
        let query_lower = query.to_ascii_lowercase();
        // The `#[tool_router]` macro emits `Self::tool_router()` with the full
        // tool registry — the same source `tools/list` is generated from, so
        // there is nothing to duplicate.
        let router = Self::tool_router();
        let total = router.map.len();
        let mut matched = router
            .map
            .values()
            .filter(|route| {
                route
                    .attr
                    .name
                    .to_ascii_lowercase()
                    .contains(&query_lower)
                    || route
                        .attr
                        .description
                        .as_deref()
                        .is_some_and(|d| d.to_ascii_lowercase().contains(&query_lower))
            })
            .map(|route| SearchMatch {
                name: route.attr.name.to_string(),
                description: route
                    .attr
                    .description
                    .as_deref()
                    .map(|s| s.to_string())
                    .unwrap_or_default(),
                // Keep request handling robust: schema serialization is
                // expected to succeed, but we never want a tool call to
                // crash the whole server.
                input_schema: match serde_json::to_value(route.attr.input_schema.as_ref()) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::error!(
                            "failed to serialize tool input schema for `{}`: {e}",
                            route.attr.name
                        );
                        serde_json::Value::Null
                    }
                },
            })
            .collect::<Vec<_>>();
        // HashMap iteration order is arbitrary; sort for deterministic output.
        matched.sort_by(|a, b| a.name.cmp(&b.name));

        Json(SearchResult {
            query,
            total,
            matched,
        })
    }
}

/// `tool_handler` auto-generates `call_tool` / `list_tools` / `get_tool`
/// and `get_info()` (tools enabled) from `SlaskTools::tool_router()`.
/// An empty impl is therefore sufficient.
#[tool_handler(
    name = "slask-mcp",
    instructions = "Demo server. Tools: `echo({\"message\":...})` echoes a string; `current_time_utc()` returns the current UTC time in ISO 8601; `search_tools({\"query\":...})` finds tools by name or description (case-insensitive) and returns them with their input schemas.",
)]
impl ServerHandler for SlaskTools {}

// ---------------------------------------------------------------------------
// HTTP Bearer-token auth (stdio is a separate code path; unaffected)
// ---------------------------------------------------------------------------

/// HTTP auth config. `token` is `None` unless `SLASK_MCP_TOKEN` is set and
/// non-empty; then every `/mcp` request must carry `Authorization: Bearer <token>`.
#[derive(Clone)]
pub struct AuthConfig {
    pub token: Option<String>,
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
    // Keep the JSON error body stable even in improbable error paths
    // (e.g. if Response::builder() fails).
    const BODY: &str =
        r#"{"error":"Unauthorized","detail":"Missing or invalid Authorization: Bearer header."}"#;
    Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        // Lowercase: `HeaderName::from_static` (http 1.5) only accepts the
        // canonical lowercase token set, which matches the header's canonical form.
        .header(HeaderName::from_static("www-authenticate"), "Bearer realm=\"mcp\"")
        .header(HeaderName::from_static("content-type"), "application/json")
        .body(Body::from(BODY))
        .unwrap_or_else(|_| Response::new(Body::from(BODY)))
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

// ---------------------------------------------------------------------------
// Stack construction
// ---------------------------------------------------------------------------

/// Full streamable-HTTP stack: the MCP service wrapped in a router with the
/// auth middleware applied **after** `nest_service` (axum applies layers to
/// routes that already exist), plus a cancellation token for graceful
/// shutdown.
pub fn new_http_stack(auth: AuthConfig) -> (Router, CancellationToken) {
    let ct = CancellationToken::new();
    let service = StreamableHttpService::new(
        || Ok(SlaskTools {}),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false) // stateless (no per-client state)
            .with_json_response(true)         // plain JSON replies (easy to test with curl)
            .with_cancellation_token(ct.child_token()),
    );

    let router = Router::new()
        .nest_service("/mcp", service)
        // Baseplate hardening for larger MCP servers.
        // 1) put an upper bound on request bodies to avoid unbounded memory use
        // 2) cap request duration so hung downstream code doesn't tie up the server
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(TimeoutLayer::new(Duration::from_secs(10)))
        .layer(from_fn_with_state(auth, auth_middleware));

    (router, ct)
}

/// Serve over stdio. MCP speaks JSON-RPC on stdout; the caller should keep
/// stderr free of that stream.
pub async fn serve_stdio() -> Result<()> {
    tracing::info!("serving MCP over stdio (Ctrl+C to quit)");
    let service = SlaskTools {}.serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
