// lib/mcp_client.js
import logger from './logger.js';

// Lazy-load SDK to avoid crashing server at startup if package isn't installed
async function getMcpSdk() {
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client');
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    return { Client, SSEClientTransport };
  } catch (err) {
    const msg = `Missing dependency @modelcontextprotocol/sdk. Install it with: npm i @modelcontextprotocol/sdk`;
    logger?.error?.('[mcp_client] ' + msg, err?.message || err);
    throw new Error(msg);
  }
}

// Cache clients per URL so we reuse connections
const clientCache = new Map();

const serverUrl = process.env.MCP_SERVER_URL;
//"https://mcp-server-1-aegldt.5sc6y6-1.usa-e2.cloudhub.io/sse";
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
const CONNECTION_TIMEOUT = parseInt(process.env.MCP_CONNECTION_TIMEOUT_MS || '15000', 10);
const TOOL_TIMEOUT = parseInt(process.env.MCP_TOOL_TIMEOUT_MS || '90000', 10);

export async function getClientByUrl(serverUrl, headers = {}) {
  if (!serverUrl) throw new Error('getClientByUrl: serverUrl is required');
  const key = serverUrl;
  if (clientCache.has(key)) {
    return clientCache.get(key);
  }

  const { Client, SSEClientTransport } = await getMcpSdk();
  const transport = new SSEClientTransport(new URL(serverUrl), { headers });
  const client = new Client({ name: 'mulegpt', version: '1.0.0' }, { capabilities: {} });
  const ready = client.connect(transport).then(() => client);

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Connection timeout')), CONNECTION_TIMEOUT)
  );

  // Race the connection with a timeout and cache that promise.
  // If the connection fails or times out, remove it from the cache
  // so that subsequent calls can retry cleanly.
  const clientPromise = Promise.race([ready, timeout]).catch(err => {
    clientCache.delete(key);
    throw err;
  });

  clientCache.set(key, clientPromise);
  return clientPromise;
}

export async function callMcpToolByUrl(serverUrl, toolName, args = {}, headers = {}, retry = 0) {
  try {
    const client = await getClientByUrl(serverUrl, headers);
    logger.info(`[mcp_client] Calling MCP tool: ${toolName} at ${serverUrl}`);
    logger.debug(`[mcp_client] MCP tool arguments:`, args);

    const toolPromise = client.callTool({ name: toolName, arguments: args });
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('MCP tool call timeout')), TOOL_TIMEOUT)
    );

    const result = await Promise.race([toolPromise, timeout]);

    logger.info(`[mcp_client] MCP tool call successful for ${toolName}`);
    logger.debug(`[mcp_client] MCP result parts:`, Array.isArray(result?.content) ? result.content.length : 0);
    return result; // raw MCP result with content parts
  } catch (error) {
    const message = error?.message || '';

    // If the MCP server says the session is not initialized, clear the cache
    // and retry with a fresh connection (helps when server drops SSE sessions).
    const sessionNotInit =
      message.includes("session hasn't been initialized") ||
      message.includes('session has not been initialized');

    if (sessionNotInit) {
      logger.warn(`[MCP] Session not initialized, clearing cached client for ${serverUrl} and retrying...`);
      clientCache.delete(serverUrl);
    }

    if (retry < MAX_RETRIES) {
      const nextRetry = retry + 1;
      logger.warn(`[MCP] Retry ${nextRetry}/${MAX_RETRIES} for ${toolName}: ${error.message || error}`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * nextRetry));
      return callMcpToolByUrl(serverUrl, toolName, args, headers, nextRetry);
    }
    throw error;
  }
}
