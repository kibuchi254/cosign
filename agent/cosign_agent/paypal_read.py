"""Read-only PayPal access through PayPal's own MCP server.

The server runs as `npx -y @paypal/mcp --tools=<allowlist>`; only read tools are allowed,
and this module refuses anything else before the server is even started. The server needs
an access token, which the Rust core mints (the client secret never leaves the core).

Optional: needs the `mcp` Python package and Node.js. Tool names follow the blueprint's
reading of PayPal's ADK page; confirm them against the server's tool list on day 1."""

from __future__ import annotations

import asyncio
import os

import httpx

DEFAULT_TOOLS = "invoices.list,invoices.get,transactions.list,orders.get,disputes.list,disputes.get"
WRITE_WORDS = ("create", "send", "cancel", "refund", "capture", "authorize", "payout", "update", "delete", "void", "accept", "pay")


class ReadError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def allowlist() -> list[str]:
    tools = [t.strip() for t in os.environ.get("PAYPAL_MCP_TOOLS", DEFAULT_TOOLS).split(",") if t.strip()]
    # A misconfigured allowlist must not smuggle in a money-moving tool.
    return [t for t in tools if not any(w in t.lower() for w in WRITE_WORDS)]


def check_tool(tool: str) -> None:
    if tool not in allowlist():
        raise ReadError(403, f"tool {tool!r} is not on the read-only allowlist")


def fetch_token(core_url: str, agent_token: str) -> tuple[str, str]:
    from .core_client import normalize_url

    r = httpx.get(f"{normalize_url(core_url)}/v1/agent/paypal-token", headers={"authorization": f"Bearer {agent_token}"}, timeout=15)
    if r.status_code != 200:
        raise ReadError(503, f"core would not issue a PayPal token: {r.status_code} {r.text[:200]}")
    body = r.json()
    return body["access_token"], body.get("environment", "SANDBOX")


async def _call(tool: str, arguments: dict, token: str, environment: str) -> dict:
    try:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
    except ImportError as e:
        raise ReadError(503, "the mcp package is not installed (pip install 'cosign-agent[mcp]')") from e
    params = StdioServerParameters(
        command=os.environ.get("PAYPAL_MCP_COMMAND", "npx"),
        args=["-y", "@paypal/mcp", f"--tools={','.join(allowlist())}"],
        env={**os.environ, "PAYPAL_ACCESS_TOKEN": token, "PAYPAL_ENVIRONMENT": environment},
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(tool, arguments)
            texts = [getattr(c, "text", "") for c in result.content]
            return {"tool": tool, "is_error": bool(getattr(result, "isError", False)), "content": texts}


def read(tool: str, arguments: dict) -> dict:
    check_tool(tool)
    token, env = fetch_token(os.environ.get("CORE_URL", "http://localhost:8080"), os.environ.get("CORE_AGENT_TOKEN", ""))
    try:
        return asyncio.run(asyncio.wait_for(_call(tool, arguments, token, env), timeout=60))
    except ReadError:
        raise
    except Exception as e:  # server failed to start, timed out, tool errored
        raise ReadError(502, f"PayPal MCP call failed: {e}") from e
