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

    let ct = tokio_util::sync::CancellationToken::new();
    let service = StreamableHttpService::new(
        || Ok(SlaskTools {}),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false) // stateless (no per-client state)
            .with_json_response(true)         // plain JSON replies (easy to test with curl)
            .with_cancellation_token(ct.child_token()),
    );
    let router = axum::Router::new().nest_service("/mcp", service);
    let addr = format!("{}:{}", bind, port);
    tracing::info!(addr, "serving MCP over streamable HTTP at {addr}/mcp");
    let tcp = tokio::net::TcpListener::bind(&addr).await?;
    let _ = axum::serve(tcp, router)
        .with_graceful_shutdown(async move {
            tokio::signal::ctrl_c().await.ok();
            ct.cancel();
        })
        .await;
    Ok(())
}
