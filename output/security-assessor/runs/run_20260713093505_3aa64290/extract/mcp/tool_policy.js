const DEFAULT_ALLOWED_TOOLS = ['publish-raml'];
const DEFAULT_ALLOWED_FILE_EXTENSIONS = ['.raml', '.yaml', '.yml', '.json'];

function splitEnvList(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function allowedTools() {
  return new Set([
    ...DEFAULT_ALLOWED_TOOLS,
    ...splitEnvList(process.env.MCP_ALLOWED_TOOLS)
  ]);
}

function configuredServerUrls() {
  return splitEnvList(process.env.MCP_ALLOWED_SERVER_URLS)
    .concat([
      process.env.MCP_RAML_SERVER_URL,
      process.env.MCP_SERVER_URL
    ])
    .filter(Boolean);
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function isAllowedServerUrl(serverUrl) {
  const normalized = normalizeUrl(serverUrl);
  if (!normalized) return false;

  const allowed = configuredServerUrls()
    .map(normalizeUrl)
    .filter(Boolean);

  return allowed.includes(normalized);
}

function hasAllowedExtension(filePath) {
  const lower = String(filePath || '').toLowerCase();
  return DEFAULT_ALLOWED_FILE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function validateRamlPublishArgs(args = {}) {
  const project = String(args.project || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/.test(project)) {
    return {
      allowed: false,
      reason: 'publish-raml project name is invalid.'
    };
  }

  if (!Array.isArray(args.files) || args.files.length === 0) {
    return {
      allowed: false,
      reason: 'publish-raml requires at least one file.'
    };
  }

  if (args.files.length > 100) {
    return {
      allowed: false,
      reason: 'publish-raml file count exceeds the allowed limit.'
    };
  }

  let totalChars = 0;
  for (const file of args.files) {
    const filePath = String(file?.path || '').trim().replace(/\\/g, '/');
    const content = String(file?.content || '');
    totalChars += content.length;

    if (!filePath || filePath.startsWith('/') || filePath.includes('../') || filePath.includes('..\\')) {
      return {
        allowed: false,
        reason: `publish-raml file path is unsafe: ${filePath || '[empty]'}`
      };
    }

    if (!hasAllowedExtension(filePath)) {
      return {
        allowed: false,
        reason: `publish-raml file type is not allowed: ${filePath}`
      };
    }

    if (!content.trim()) {
      return {
        allowed: false,
        reason: `publish-raml file content is empty: ${filePath}`
      };
    }

    if (content.length > 500_000) {
      return {
        allowed: false,
        reason: `publish-raml file content exceeds the allowed size: ${filePath}`
      };
    }
  }

  if (totalChars > 2_000_000) {
    return {
      allowed: false,
      reason: 'publish-raml total payload size exceeds the allowed limit.'
    };
  }

  return { allowed: true };
}

export function validateToolCall({ toolName, args = {}, serverUrl }) {
  if (!allowedTools().has(toolName)) {
    return {
      allowed: false,
      reason: `MCP tool is not allowed: ${toolName || '[missing]'}`
    };
  }

  if (!isAllowedServerUrl(serverUrl)) {
    return {
      allowed: false,
      reason: 'MCP server URL is not in the configured allowlist.'
    };
  }

  if (toolName === 'publish-raml') {
    return validateRamlPublishArgs(args);
  }

  return { allowed: true };
}

