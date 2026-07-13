// lib/mcp_tools.js
import { callMcpToolByUrl } from './mcp_client.js';
import { validateToolCall } from './tool_policy.js';
import logger from './logger.js';

function extractUrlsFromText(text) {
	if (!text) return [];
	const urlRegex = /(https?:\/\/[^\s)\]}]+)[)\]}]*/gi;
	const urls = [];
	let match;
	while ((match = urlRegex.exec(text)) !== null) {
		urls.push(match[1]);
	}
	return urls;
}

function normalizeMcpContentParts(parts) {
	const textParts = [];
	const jsonParts = [];
	const urls = [];
	let hasError = false;
	let errorMessage = '';

	for (const p of parts || []) {
		if (p?.type === 'text' && typeof p.text === 'string') {
			textParts.push(p.text);
			urls.push(...extractUrlsFromText(p.text));
			
			// Check for error indicators in text
			if (/error|invalid|failed|syntax error/i.test(p.text)) {
				hasError = true;
				errorMessage = p.text;
			}
		} else if (p?.type === 'json' && p.json) {
			jsonParts.push(p.json);
			
			// Check for error fields in JSON
			if (p.json.error || p.json.isError || p.json.status === 'error' || p.json.success === false) {
				hasError = true;
				errorMessage = p.json.error || p.json.message || JSON.stringify(p.json);
			}
			
			// common fields that might contain a URL
			for (const key of ['url', 'imageUrl', 'link', 'href']) {
				if (typeof p.json[key] === 'string' && /^https?:\/\//i.test(p.json[key])) {
					urls.push(p.json[key]);
				}
			}
		} else if (p?.type === 'resource' && p.resource?.uri) {
			// Some tools might return a resource URI
			urls.push(p.resource.uri);
		}
	}

	const combinedText = textParts.filter(Boolean).join('\n');
	const firstUrl = urls.find(u => /^https?:\/\//i.test(u));
	const result = { combinedText, jsonParts, urls, firstUrl, hasError, errorMessage };
	logger.debug('[normalizeMcpContentParts] Return values:', {
		hasText: !!combinedText,
		hasJson: jsonParts.length > 0,
		urls: urls,
		firstUrl: firstUrl,
		hasError: hasError,
		errorMessage: errorMessage
	});
	return result;
}

// Calls a tool using a direct server URL. Falls back to env var MCP_SERVER_URL.
export async function callToolAtUrl(toolName, args = {}, serverUrl = process.env.MCP_SERVER_URL, headers = {}) {
	if (!serverUrl) throw new Error('callToolAtUrl: serverUrl is required (set MCP_SERVER_URL or pass explicitly)');
	const policy = validateToolCall({ toolName, args, serverUrl });
	if (!policy.allowed) {
		throw new Error(`MCP tool call blocked by policy: ${policy.reason}`);
	}
	try {
		const res = await callMcpToolByUrl(serverUrl, toolName, args, headers);
		if (!res?.content) {
			logger.warn(`[mcp_tools] MCP tool ${toolName} returned no content.`);
			return { raw: res, text: '', url: '' };
		}
		//logger.info(`MCP tool response is ${res.content}`);
		const { combinedText, urls, hasError, errorMessage } = normalizeMcpContentParts(res.content);
		return { raw: res, text: combinedText, url: urls || '', hasError, errorMessage };
	} catch (error) {
		logger.error(`[mcp_tools] Error calling tool ${toolName} at ${serverUrl}:`, error);
		throw error;
	}
}
