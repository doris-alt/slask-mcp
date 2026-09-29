//! Demo MCP server binary.
//!
//! `slask-mcp`            -> serve over stdio
//! `slask-mcp --http`     -> serve over Streamable HTTP at 127.0.0.1:$SLASK_MCP_PORT/mcp
//!
//! All server logic (tools, auth, router construction) lives in the library
//! crate so that the integration tests in `tests/` can exercise it.

use anyhow::Result;
use slask_mcp::{serve_stdio, AuthConfig, new_http_stack};

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
        serve_stdio().await?;
    }
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

    let addr = format!("{}:{}", bind, port);
    if auth.token.is_some() {
        tracing::info!(addr, "serving MCP over streamable HTTP at {addr}/mcp (Bearer auth enabled)");
    } else {
        tracing::info!(addr, "serving MCP over streamable HTTP at {addr}/mcp (no auth)");
    }

    let (router, ct) = new_http_stack(auth);
    let tcp = tokio::net::TcpListener::bind(&addr).await?;
    let _ = axum::serve(tcp, router)
        .with_graceful_shutdown(async move {
            tokio::signal::ctrl_c().await.ok();
            ct.cancel();
        })
        .await;
    Ok(())
}
