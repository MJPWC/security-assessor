// lib/raml_publishing.js
// RAML Publishing Module - Handles publishing RAML to Anypoint Design Center

import { callToolAtUrl } from '../../mcp/mcp_tools.js';
import logger from './logger.js';

/**
 * Clean RAML content by removing AI descriptions and markdown code blocks
 */
export function cleanRamlContent(ramlContent) {
  if (!ramlContent) return ramlContent;
  
  // Log original content to check for code blocks
  if (ramlContent.includes('```')) {
    logger.debug('[raml_publishing] Found code blocks in RAML content, removing them...');
  }
  
  // Remove markdown code blocks (```raml and ```)
  let cleanedContent = ramlContent
    .replace(/```raml\s*/g, '')
    .replace(/```\s*/g, '');
  
  // Look for the last occurrence of >>> filename <<< pattern
  const lastFileMarker = cleanedContent.lastIndexOf('>>>');
  if (lastFileMarker === -1) {
    // No file markers found, return cleaned content
    return cleanedContent;
  }
  
  // Find the end of the last file content
  const lastFileEnd = cleanedContent.indexOf('<<<', lastFileMarker);
  if (lastFileEnd === -1) {
    // No closing marker found, return cleaned content
    return cleanedContent;
  }
  
  // Extract content up to the end of the last file
  cleanedContent = cleanedContent.substring(0, lastFileEnd + 3);
  
  // Only trim trailing whitespace and newlines at the very end, preserve RAML indentation
  return cleanedContent.replace(/\s+$/, '');
}

/**
 * Parse RAML project content into individual files
 * Expected format: >>> filename <<< followed by content
 */
export function parseRamlProjectToFiles(ramlContent) {
  logger.debug('[raml_publishing] Parsing RAML project to files');
  const files = [];
  
  // Support both styles: with and without closing <<<
  const lines = String(ramlContent || '').split(/\r?\n/);
  let currentFilename = null;
  let currentLines = [];

  const flushCurrent = () => {
    if (!currentFilename) return;
    let content = currentLines.join('\n');
    const rawName = currentFilename || '';
    const normalizedPath = rawName.startsWith('/') ? rawName.slice(1) : rawName;

    if (normalizedPath.toLowerCase().includes('examples/') || normalizedPath.toLowerCase().endsWith('.json')) {
      content = String(content).replace(/^\n+/, '').replace(/\n+$/, '');
    } else {
      content = String(content).replace(/^\n+/, '').replace(/\n+$/, '');
    }

    const fullPath = normalizedPath.startsWith('api-project/') ? normalizedPath : `api-project/${normalizedPath}`;
    files.push({ path: fullPath, content });
    logger.debug(`[raml_publishing] Parsed file: ${fullPath} (${content.length} chars)`);
    currentFilename = null;
    currentLines = [];
  };

  for (const line of lines) {
    const match = line.match(/^>>>\s*([^<]+?)(?:\s*<<<)?\s*$/);
    if (match) {
      flushCurrent();
      currentFilename = (match[1] || '').trim();
      continue;
    }
    if (currentFilename) currentLines.push(line);
  }
  flushCurrent();

  // Fallback: If no files were parsed (no delimiters found), treat entire content as api.raml
  if (files.length === 0 && ramlContent && ramlContent.trim().length > 0) {
    logger.warn('[raml_publishing] No delimited files found. Using entire content as api.raml');
    
    // Robust header search: find the first occurrence of a RAML header anywhere
    const idx = ramlContent.indexOf('#%RAML');
    if (idx >= 0) {
      const sliced = ramlContent.slice(idx).trim();
      if (sliced.length > 0) {
        files.push({ path: 'api-project/api.raml', content: sliced });
        logger.info('[raml_publishing] Created fallback api.raml from in-content RAML header');
      }
    }

    // Secondary fallback: try to extract RAML from markdown code blocks (in case fences are present)
    if (files.length === 0) {
      const cleanContent = ramlContent.trim();
      const ramlMatch = cleanContent.match(/```(?:raml)?\s*\n([\s\S]*?)\n```/);
      if (ramlMatch && ramlMatch[1]) {
        files.push({ path: 'api-project/api.raml', content: ramlMatch[1].trim() });
        logger.info('[raml_publishing] Extracted RAML from markdown code block');
      } else {
        logger.error('[raml_publishing] Could not parse RAML content - no valid format found');
      }
    }
  }

  // If we only have a single api.raml, try to split into fragments based on known sections
  try {
    const main = files.find(f => (f.path || '').replace(/^api-project\//i, '').toLowerCase() === 'api.raml');
    if (main && files.length === 1) {
      const { apiContent, fragments } = attemptSplitMonolith(main.content || '');
      if (fragments.length > 0) {
        // Replace api.raml content with rewritten one and append fragments
        main.content = apiContent;
        for (const frag of fragments) {
          const fullPath = frag.path.startsWith('api-project/') ? frag.path : `api-project/${frag.path}`;
          files.push({ path: fullPath, content: frag.content });
          logger.info(`[raml_publishing] Fragment created: ${fullPath} (${frag.content.length} chars)`);
        }
      }
    }
  } catch (e) {
    logger.warn(`[raml_publishing] Fragment split skipped due to error: ${e.message}`);
  }

  logger.info(`[raml_publishing] Parsed ${files.length} files from RAML content`);
  return files;
}

/**
 * Heuristic splitter for monolithic api.raml into fragments.
 * Extracts children under sections: types, traits, securitySchemes, resourceTypes
 * and rewrites them as !include references. Returns rewritten api content and created fragments.
 */
function attemptSplitMonolith(apiContent) {
  const sectionNames = [
    { name: 'types', dir: 'types', includeExt: 'raml' },
    { name: 'traits', dir: 'traits', includeExt: 'raml' },
    { name: 'securitySchemes', dir: 'securitySchemes', includeExt: 'raml' },
    { name: 'resourceTypes', dir: 'resourceTypes', includeExt: 'raml' },
    { name: 'examples', dir: 'examples', includeExt: 'auto' },
    { name: 'responses', dir: 'responses', includeExt: 'raml' }
  ];

  const lines = String(apiContent || '').split(/\r?\n/);
  const out = [];
  const fragments = [];
  let i = 0;
  const isTopLevelSection = (line, sec) => new RegExp(`^${sec.name}:\s*$`).test(line);
  const isTopLevelKey = (line) => /^(\w|#%RAML|\/)/.test(line) && !/^\s/.test(line);
  const indentOf = (l) => {
    const m = l.match(/^(\s*)/);
    return m ? m[1].length : 0;
  };

  while (i < lines.length) {
    const line = lines[i];
    // If this line starts any known section at top-level, process it specially
    const sec = sectionNames.find(s => isTopLevelSection(line, s));
    if (!sec) {
      out.push(line);
      i++;
      continue;
    }

    // Collect the entire section block until next top-level key
    const start = i;
    i++;
    const sectionBody = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') { sectionBody.push(l); i++; continue; }
      if (isTopLevelKey(l)) break;
      sectionBody.push(l);
      i++;
    }

    // Determine the child indentation level (first non-empty line's indent)
    const body = sectionBody;
    let childIndent = null;
    for (let idx = 0; idx < body.length; idx++) {
      const l = body[idx];
      if (l.trim() === '') continue;
      const ind = indentOf(l);
      if (ind > 0) { childIndent = ind; break; }
    }
    // If no child indent found, keep original
    if (childIndent === null) {
      out.push(...lines.slice(start, i));
      continue;
    }

    // Parse child headers at the computed indent: "<spaces>ChildName:" blocks
    const childIndices = [];
    const childHeaderRe = new RegExp(`^\\s{${childIndent}}([A-Za-z0-9_\-]+):\\s*$`);
    for (let idx = 0; idx < body.length; idx++) {
      const l = body[idx];
      const m = l.match(childHeaderRe);
      if (m) childIndices.push({ name: m[1], index: idx });
    }

    if (childIndices.length === 0) {
      // Try to handle YAML flow-mapping: e.g., "types: { User: {...}, Order: {...} }"
      const joined = body.join('\n');
      const firstBrace = joined.indexOf('{');
      const lastBrace = joined.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const inner = joined.slice(firstBrace + 1, lastBrace);
        const entries = splitFlowMapEntries(inner);
        if (entries.length > 0) {
          out.push(`${sec.name}:`);
          for (const ent of entries) {
            const fileName = `${sec.dir}/${ent.name}.${sec.includeExt === 'auto' ? 'raml' : sec.includeExt}`;
            const fragText = String(ent.value || '').trim();
            if (fragText.length > 0) {
              fragments.push({ path: fileName, content: fragText });
              out.push(`  ${ent.name}: !include ${fileName}`);
            }
          }
          continue;
        }
      }
      // No children detected; keep original section as-is
      out.push(...lines.slice(start, i));
      continue;
    }

    // Build rewritten section header
    out.push(`${sec.name}:`);
    for (let c = 0; c < childIndices.length; c++) {
      const cur = childIndices[c];
      const next = childIndices[c + 1];
      const childStart = cur.index;
      const childEnd = next ? next.index : body.length;
      const childBlock = body.slice(childStart + 1, childEnd); // lines under the child header
      // Determine file extension; examples may be JSON fragments
      let ext = sec.includeExt;
      if (ext === 'auto') {
        const t = childBlock.join('\n').trim();
        const looksJson = t.startsWith('{') || t.startsWith('[');
        if (looksJson) {
          try { JSON.parse(t); ext = 'json'; } catch { ext = 'raml'; }
        } else {
          ext = 'raml';
        }
      }
      const fileName = `${sec.dir}/${cur.name}.${ext}`;

      // Trim leading empty lines from block
      while (childBlock.length && childBlock[0].trim() === '') childBlock.shift();
      // Compute minimal indent among block lines > childIndent and deindent by that amount
      let minIndent = Infinity;
      for (const bl of childBlock) {
        if (bl.trim() === '') continue;
        const ind = indentOf(bl);
        if (ind > childIndent) minIndent = Math.min(minIndent, ind);
      }
      if (!isFinite(minIndent)) minIndent = childIndent + 2; // default step
      const deindentBy = Math.max(minIndent, childIndent + 2);
      const fragmentContent = childBlock
        .map(l => {
          if (l.length >= deindentBy) return l.slice(deindentBy);
          return l.trim() === '' ? '' : l.replace(/^\s+/, '');
        })
        .join('\n')
        .replace(/\n+$/, '');

      // Only create fragment if there is meaningful content
      const fragText = fragmentContent.trim();
      if (fragText.length > 0) {
        fragments.push({ path: fileName, content: fragmentContent });
        out.push(`  ${cur.name}: !include ${fileName}`);
      } else {
        // If empty, keep the original inline entry
        out.push(body[childStart]);
      }
    }
  }

  return { apiContent: out.join('\n'), fragments };
}

// Split a YAML flow-mapping content into top-level entries respecting nested braces
// Returns array of { name, value }
function splitFlowMapEntries(inner) {
  const res = [];
  let i = 0;
  let depth = 0;
  let tokenStart = 0;
  const pushEntry = (s) => {
    const m = s.match(/^\s*([A-Za-z0-9_\-]+)\s*:\s*([\s\S]*)$/);
    if (m) {
      res.push({ name: m[1], value: m[2].trim() });
    }
  };
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      const slice = inner.slice(tokenStart, i);
      pushEntry(slice);
      tokenStart = i + 1;
    }
    i++;
  }
  const last = inner.slice(tokenStart);
  if (last.trim().length) pushEntry(last);
  return res;
}

/**
 * Produce categorized RAML project view from generated content
 */
export function parseRamlProject(ramlContent) {
  const cleaned = cleanRamlContent(ramlContent || '');
  const files = parseRamlProjectToFiles(cleaned);
  const project = {
    mainFile: null,
    traits: [],
    securitySchemes: [],
    types: [],
    examples: [],
    responses: [],
    resourceTypes: []
  };
  for (const f of files) {
    const rel = (f.path || '').replace(/^api-project\//i, '');
    if (rel.toLowerCase() === 'api.raml') project.mainFile = f;
    else if (rel.toLowerCase().startsWith('traits/')) project.traits.push(f);
    else if (rel.toLowerCase().startsWith('securityschemes/')) project.securitySchemes.push(f);
    else if (rel.toLowerCase().startsWith('types/')) project.types.push(f);
    else if (rel.toLowerCase().startsWith('examples/')) project.examples.push(f);
    else if (rel.toLowerCase().startsWith('responses/')) project.responses.push(f);
    else if (rel.toLowerCase().startsWith('resourcetypes/')) project.resourceTypes.push(f);
  }
  return project;
}

/**
 * Handle the publishing flow to Anypoint Design Center
 */
export async function handlePublishFlow(message, context, sessionId) {
  logger.debug(`[raml_publishing] handlePublishFlow - step: ${context.publishStep}`);
  const step = context.publishStep;
  
  switch (step) {
    case 'ask_project':
      context.publishDetails = context.publishDetails || {};
      context.publishDetails.project = message.trim();
      context.publishStep = 'final_confirmation';
      logger.info(`[raml_publishing] Project name set: ${context.publishDetails.project}`);
      return {
        text: `**Final Confirmation:**\n\n` +
              `I'm about to prepare your RAML project for publishing with the following structure:\n\n` +
              `📁 Project: ${context.publishDetails.project}\n` +
              `      ├── api.raml\n` +
              `      ├── traits/\n` +
              `      ├── securitySchemes/\n` +
              `      ├── types/\n` +
              `      ├── examples/\n` +
              `      ├── responses/\n` +
              `      └── resourceTypes/\n\n` +
              `**Do you want me to proceed with publishing to Design Center? (Yes/No)**`
      };
      
    case 'confirm_details':
      // Skip reconfirmation; redirect to final confirmation prompt directly
      context.publishStep = 'final_confirmation';
      return {
        text: `**Final Confirmation:**\n\n` +
              `I'm about to prepare your RAML project for publishing with the following structure:\n\n` +
              `📁 Project: ${context.publishDetails.project}\n` +
              `      ├── api.raml\n` +
              `      ├── traits/\n` +
              `      ├── securitySchemes/\n` +
              `      ├── types/\n` +
              `      ├── examples/\n` +
              `      ├── responses/\n` +
              `      └── resourceTypes/\n\n` +
              `**Do you want me to proceed with publishing to Design Center? (Yes/No)**`
      };
      
    case 'final_confirmation':
      if (/^(yes|y|ok|okay|sure|do it|go ahead|generate|please)\b/i.test(message.trim())) {
        // Invoke MCP tool to publish RAML
        const details = context.publishDetails || {};
        const ramlContent = context.latestRaml || '';
        
        if (!ramlContent) {
          context.publishFlowActive = false;
          context.publishStep = null;
          logger.warn('[raml_publishing] No RAML content found in context');
          return { 
            text: 'I could not find the latest RAML content in context. Please regenerate the RAML and try publishing again.',
            success: false
          };
        }

        // Build a ZIP with the RAML project structure and send to MCP RAML server
        const serverUrl = process.env.MCP_RAML_SERVER_URL;
        const toolName = 'publish-raml';
        const headers = {};
        
        if (process.env.MCP_AUTH_TOKEN) {
          headers['Authorization'] = `Bearer ${process.env.MCP_AUTH_TOKEN}`;
        }
        if (process.env.MCP_API_KEY) {
          headers['x-api-key'] = process.env.MCP_API_KEY;
        }

        let mcpResultText = '';
        let success = false;
        
        try {
          // 1) Clean RAML content - remove any AI descriptions at the end
          const cleanedRamlContent = cleanRamlContent(ramlContent);
          
          // 2) Parse generated RAML into files
          let files = parseRamlProjectToFiles(cleanedRamlContent);
          logger.info(`[raml_publishing] Parsed ${files.length} file(s) from cleaned content`);

          // Recovery: if no files, try parsing the raw content (pre-clean)
          if (!files || files.length === 0) {
            logger.warn('[raml_publishing] No files after cleaned parse. Retrying with raw content...');
            files = parseRamlProjectToFiles(ramlContent);
            logger.info(`[raml_publishing] Parsed ${files.length} file(s) from raw content`);
          }

          // Recovery: if still none, attempt header-based fallback here
          if (!files || files.length === 0) {
            const idx = String(ramlContent).indexOf('#%RAML');
            if (idx >= 0) {
              const sliced = String(ramlContent).slice(idx).trim();
              if (sliced.length > 0) {
                files = [{ path: 'api-project/api.raml', content: sliced }];
                logger.info('[raml_publishing] Injected header-based fallback api.raml');
              }
            }
          }

          // Filter out empty-content files to avoid sending blanks
          files = (files || []).filter(f => (f && typeof f.content === 'string' && f.content.trim().length > 0));
          logger.info(`[raml_publishing] Preparing ${files.length} non-empty file(s) for MCP upload`);

          if (!files || files.length === 0) {
            throw new Error('No valid RAML files were parsed from the generated content.');
          }
          
          // 3) Normalize file paths and format payload for MCP tool
          const projectFiles = files.map(file => {
            // Normalize path: remove leading './' or '/', remove 'api-project/' prefix, unify separators
            let normalizedPath = (file.path || '').trim()
              .replace(/^\.+\//, '')      // remove leading ./
              .replace(/^\/+/, '')         // remove leading /
              .replace(/\\/g, '/')        // backslashes to slashes
              .replace(/^api-project\//, ''); // drop api-project/ root if present
            
            if (!normalizedPath) {
              normalizedPath = 'api.raml';
            }
            
            logger.debug(`[raml_publishing] Uploading file: ${normalizedPath} (${(file.content||'').length} chars)`);
            return {
              path: normalizedPath,
              content: file.content
            };
          });

          if (projectFiles.length === 0) {
            throw new Error('No files to send to MCP after normalization.');
          }

          // 4) Use MCP tool calling mechanism for RAML publishing
          if (serverUrl) {
            const args = {
              "project": details.project || 'api-project',
              "files": projectFiles
            };

            logger.info('[raml_publishing] Calling RAML MCP tool', {
              toolName,
              serverUrl,
              project: details.project || 'api-project',
              fileCount: projectFiles.length,
              sessionId
            });

            const { text, url, hasError, errorMessage } = await callToolAtUrl(toolName, args, serverUrl, headers);

            logger.info('[raml_publishing] RAML MCP tool response received', {
              hasError,
              errorMessage,
              textLength: (text || '').length,
              url
            });

            // If the MCP tool reported an error in its structured response, treat this as a failure
            if (hasError) {
              const message = errorMessage || text || 'RAML publish MCP tool reported an error';
              logger.error(`[raml_publishing] MCP tool reported error: ${message}`);
              throw new Error(message);
            }

            mcpResultText = text || url || '';
            success = true;
            logger.info('[raml_publishing] MCP tool call successful for RAML publish');
          } else {
            throw new Error('No MCP RAML server URL configured. Please set MCP_RAML_SERVER_URL environment variable.');
          }

          context.publishFlowActive = false;
          context.publishStep = null;
          context.publishDetails = null;
          // Mark RAML workflow as complete after successful publishing
          context.ramlComplete = true;

          let responseText = success
            ? `✅ **RAML Published Successfully!**\n\n${mcpResultText}\n\nYour RAML project has been published to Anypoint Design Center.`
            : `⚠️ **Publishing Completed with Warnings**\n\n${mcpResultText}`;

          // Check if there are more APIs to generate RAML for
          const hasMoreApis = context.availableTasks && context.availableTasks.length > 1;
          if (hasMoreApis) {
            const remainingApis = context.availableTasks.filter(t => 
              !t.ramlGenerated && t.task !== context.selectedTask?.task
            );
            
            if (remainingApis.length > 0) {
              responseText += `\n\n💡 **Remaining APIs (${remainingApis.length}):**\n`;
              remainingApis.forEach((api, idx) => {
                responseText += `${idx + 1}. ${api.task}\n`;
              });
              responseText += `\nYou can generate RAML for any of these by saying "Generate RAML for [API name]".`;
              
              return {
                text: responseText,
                suggestions: ['Generate RAML for another API', ...remainingApis.slice(0, 3).map((a, i) => `${i + 1}. ${a.task}`)],
                success: success
              };
            }
          }

          return {
            text: responseText,
            //suggestions: ['Generate BRD', 'Create WBS', 'Generate Test Plan', 'Generate Diagram'],
            success: success
          };
        } catch (error) {
          logger.error(`[raml_publishing] Publishing failed: ${error.message}`);
          context.publishFlowActive = false;
          context.publishStep = null;
          
          // Check if there are more APIs even on failure
          const hasMoreApis = context.availableTasks && context.availableTasks.length > 1;
          let errorText = `❌ **Publishing Failed**\n\nError: ${error.message}\n\nPlease check your MCP server configuration and try again.`;
          
          if (hasMoreApis) {
            const remainingApis = context.availableTasks.filter(t => 
              !t.ramlGenerated && t.task !== context.selectedTask?.task
            );
            
            if (remainingApis.length > 0) {
              errorText += `\n\n💡 You still have ${remainingApis.length} more API(s) to generate RAML for.`;
              return {
                text: errorText,
                suggestions: ['Try publishing again', 'Generate RAML for another API', 'Skip publishing'],
                success: false
              };
            }
          }
          
          return {
            text: errorText,
            suggestions: ['Try publishing again', 'Generate BRD', 'Generate Diagram'],
            success: false
          };
        }
      } else if (/^(no|n|not now|later|cancel)\b/i.test(message.trim())) {
        context.publishFlowActive = false;
        context.publishStep = null;
        logger.info('[raml_publishing] Publishing cancelled by user');
        return { 
          text: 'Publishing cancelled. You can publish to Design Center anytime by saying "publish RAML".' 
        };
      } else {
        return { 
          text: 'Please respond with "Yes" to proceed with publishing or "No" to cancel.' 
        };
      }
      
    default:
      logger.warn(`[raml_publishing] Unknown publish step: ${step}`);
      context.publishFlowActive = false;
      context.publishStep = null;
      return { 
        text: 'An error occurred in the publishing flow. Please try again.',
        success: false
      };
  }
}

/**
 * Initialize publishing flow
 */
export function initializePublishFlow(context) {
  logger.info('[raml_publishing] Initializing publish flow');
  context.publishFlowActive = true;
  context.publishStep = 'ask_project';
  context.publishDetails = {};
  return {
    text: 'Great! Let\'s prepare the publish details.\n\n**What is the Design Center project name?**'
  };
}

export async function publishRamlDirect(ramlContent, projectName = 'api-project', sessionId = null) {
  const context = {
    publishFlowActive: true,
    publishStep: 'final_confirmation',
    publishDetails: { project: projectName },
    latestRaml: ramlContent,
    availableTasks: [],
    selectedTask: null
  };
  return handlePublishFlow('yes', context, sessionId);
}
