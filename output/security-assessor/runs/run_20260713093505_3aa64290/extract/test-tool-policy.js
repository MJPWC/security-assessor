import { validateToolCall } from './mcp/tool_policy.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

process.env.MCP_RAML_SERVER_URL = 'https://trusted-mcp.example.com/sse';

const validPublish = validateToolCall({
  toolName: 'publish-raml',
  serverUrl: 'https://trusted-mcp.example.com/sse',
  args: {
    project: 'customer-orders-api',
    files: [{ path: 'api.raml', content: '#%RAML 1.0\ntitle: Orders' }]
  }
});
assert(validPublish.allowed, 'Valid publish-raml call should be allowed');

const unknownTool = validateToolCall({
  toolName: 'shell-exec',
  serverUrl: 'https://trusted-mcp.example.com/sse',
  args: {}
});
assert(!unknownTool.allowed, 'Unknown MCP tool should be blocked');

const untrustedServer = validateToolCall({
  toolName: 'publish-raml',
  serverUrl: 'https://evil.example.com/sse',
  args: {
    project: 'customer-orders-api',
    files: [{ path: 'api.raml', content: '#%RAML 1.0\ntitle: Orders' }]
  }
});
assert(!untrustedServer.allowed, 'Untrusted MCP server URL should be blocked');

const metadataServiceTarget = validateToolCall({
  toolName: 'publish-raml',
  serverUrl: 'http://169.254.169.254/latest/meta-data',
  args: {
    project: 'customer-orders-api',
    files: [{ path: 'api.raml', content: '#%RAML 1.0\ntitle: Orders' }]
  }
});
assert(!metadataServiceTarget.allowed, 'Cloud metadata service URL should be blocked unless explicitly allowlisted');

const localNetworkTarget = validateToolCall({
  toolName: 'publish-raml',
  serverUrl: 'http://127.0.0.1:8080/admin',
  args: {
    project: 'customer-orders-api',
    files: [{ path: 'api.raml', content: '#%RAML 1.0\ntitle: Orders' }]
  }
});
assert(!localNetworkTarget.allowed, 'Local/private network URL should be blocked unless explicitly allowlisted');

const nonHttpTarget = validateToolCall({
  toolName: 'publish-raml',
  serverUrl: 'file:///etc/passwd',
  args: {
    project: 'customer-orders-api',
    files: [{ path: 'api.raml', content: '#%RAML 1.0\ntitle: Orders' }]
  }
});
assert(!nonHttpTarget.allowed, 'Non-HTTP tool destination should be blocked');

const unsafePath = validateToolCall({
  toolName: 'publish-raml',
  serverUrl: 'https://trusted-mcp.example.com/sse',
  args: {
    project: 'customer-orders-api',
    files: [{ path: '../server/index.js', content: 'malicious' }]
  }
});
assert(!unsafePath.allowed, 'Unsafe publish file path should be blocked');

const unsupportedFileType = validateToolCall({
  toolName: 'publish-raml',
  serverUrl: 'https://trusted-mcp.example.com/sse',
  args: {
    project: 'customer-orders-api',
    files: [{ path: 'postinstall.sh', content: 'echo unsafe' }]
  }
});
assert(!unsupportedFileType.allowed, 'Unsupported publish file type should be blocked');

console.log('Tool policy tests passed');
