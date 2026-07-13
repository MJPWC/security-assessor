import BaseAgent from "./BaseAgent.js";
import { getAgentConfig } from "../config/agentConfigs.js";
import { A2AMessage } from "../a2a/Message.js";

/**
 * RAML Generation Agent
 * Generates RAML (RESTful API Modeling Language) specifications
 */
class RAMLGenerationAgent extends BaseAgent {
  constructor(config = null, agentConfig = null, socket = null) {
    super(config, 'raml-agent'); // A2A Protocol: Set agent ID
    this.socket = socket; // A2A Protocol: Set agent ID

    // Use provided agentConfig or load from config file
    const defaultConfig = agentConfig || getAgentConfig("raml");

    // Set agent metadata
    this.name = defaultConfig?.name || "RAML Generation Agent";
    this.description = defaultConfig?.description || "Generates complete RAML 1.0 API specifications";
    this.conversationStarters = defaultConfig?.conversationStarters || [];
    this.knowledge = defaultConfig?.knowledge || [];

    // Set system prompt (instructions)
    this.systemPrompt = defaultConfig?.instructions || `You are an expert in RAML (RESTful API Modeling Language) and MuleSoft API design.
You specialize in:
- RAML 1.0 syntax
- RESTful API design best practices
- MuleSoft API specifications
- Data types and schemas
- Security schemes (OAuth, Basic Auth)
- Examples and documentation
- Resource modeling
- Query parameters and headers

Generate complete, valid RAML 1.0 specifications that include:
- API title, version, baseUri
- Security schemes
- Resource definitions with HTTP methods
- Request/response schemas
- Data types
- Examples
- Documentation

Always output valid RAML 1.0 syntax. Focus on MuleSoft-compatible specifications.`;

    // A2A Protocol: Register this agent
    this.register({
      name: this.name,
      description: this.description,
      capabilities: ['generate-raml', 'generate-api-spec', 'generate-raml-specification']
    });
  }

  getTokenCategory() {
    return 'RAML';
  }

  /**
   * A2A Protocol: Handle incoming messages from other agents
   * @param {A2AMessage} message - Incoming A2A message
   * @returns {Promise<A2AMessage>} Response message
   */
  // In RAMLGenerationAgent.js
  async handleMessage(message) {
    console.log(`📨 RAML Agent received message from ${message.from}: ${message.payload.type}`);

    try {
      let result;
      const context = message.context || {};

      switch (message.payload.type) {
        case 'generate-raml':
        case 'generate-api-spec':
          // Get architecture from payload or context
          const architecture = message.payload.architecture || context.architecture;
          if (!architecture) {
            throw new Error("Architecture solution is required.");
          }

          // Include estimation from payload in context
          if (message.payload.estimation) {
            context.estimation = message.payload.estimation;
          }

          result = await this.generateRAML(
            architecture,
            message.payload.apiName || 'MuleSoftAPI',
            message.payload.options || {},
            context
          );
          break;

        default:
          throw new Error(`Unknown message type: ${message.payload.type}`);
      }

      return A2AMessage.createResponse(
        this.agentId,
        message.from,
        { raml: result, result },
        message.requestId,
        { ...context, raml: result }
      );
    } catch (error) {
      console.error(`❌ RAML Agent error:`, error);
      return A2AMessage.createError(
        this.agentId,
        message.from,
        error.message,
        message.requestId
      );
    }
  }

  /**
   * Get agent configuration/metadata
   * @returns {object} Agent configuration
   */
  getConfig() {
    return {
      name: this.name,
      description: this.description,
      instructions: this.systemPrompt,
      conversationStarters: this.conversationStarters,
      knowledge: this.knowledge
    };
  }

  /**
   * Generate RAML from architecture solution
   * @param {string} architectureSolution - Architecture solution (REQUIRED from Architecture Agent)
   * @param {string} apiName - Name of the API
   * @param {object} options - Additional options
   * @param {object} context - Additional context from previous agents (diagram, estimation, etc.)
   * @returns {Promise<string>} RAML specification
   */
  async generateRAML(architectureSolution, apiName = "API", options = {}, context = {}) {
    if (!architectureSolution) {
      throw new Error("Architecture solution is required. Please generate architecture first using MuleSoftArchitectureAgent.");
    }

    let apiTasks = Array.isArray(context.apiTasks) ? context.apiTasks : [];
    if (apiTasks.length > 0) {
      // Use tasks supplied by the orchestrator/server so socket events and
      // persisted session state stay in sync.
    } else if (context.estimation) {
      apiTasks = await this.extractApiTasksFromEstimation(context.estimation);
    } else {
      apiTasks = this.extractApiTasksFromArchitectureContext(architectureSolution, context);
    }

    const sessionId = context.sessionId || options.sessionId || null;
    context.sessionId = sessionId;

    if (this.socket) {
      this.socket.emit('raml-agent-started', {
        apiName,
        timestamp: new Date().toISOString(),
        tasks: apiTasks,
        sessionId
      });

      // In interactive (socket) mode, only extract and expose API tasks for the UI
      // and let documentation proceed without waiting for full RAML generation.
      // Actual RAML generation for specific APIs is handled separately via
      // the generate-api-raml socket event.
      return "";
    }

    return this._generateRAMLInternal(architectureSolution, apiName, options, {
      ...context,
      apiTasks
    });
  }

  async _generateRAMLInternal(architectureSolution, apiName, options, context) {
    // Move the actual RAML generation logic here
    // ... existing generateRAML code ...
    let contextInfo = "";
    if (context.diagram) {
      contextInfo += `\nArchitecture Diagram (for reference on data flow):\n${context.diagram}\n`;
    }
    if (context.estimation) {
      contextInfo += `\nProject Estimation (for understanding complexity):\n${context.estimation.substring(0, 500)}...\n`;
    }
    if (context.requirements) {
      contextInfo += `\nOriginal Requirements:\n${context.requirements}\n`;
    }
    if (context.selectedApi) {
      contextInfo += `\nFocus API Component Selected by User:\n- Name: ${context.selectedApi.name}\n- Description: ${context.selectedApi.description || 'Not provided'}\n`;
    }
    if (context.includeFields) {
      if (context.fieldDefinitions && context.fieldDefinitions.length > 0) {
        const preview = context.fieldDefinitions.slice(0, 50).map(field => {
          const desc = field.description ? ` - ${field.description}` : '';
          const required = field.required ? ` (Required: ${field.required})` : '';
          return `• ${field.name} (${field.type || 'string'})${desc}${required}`;
        }).join('\n');
        contextInfo += `\nUser provided field definitions from Excel. Use these exact fields within the RAML data types and example payloads:\n${preview}\n\nIf more fields exist beyond this preview, ensure they are also represented in the RAML.`;
      } else {
        contextInfo += `\nUser requested RAML with detailed fields. Derive appropriate field-level schemas even though no Excel data was available.\n`;
      }
    } else {
      contextInfo += `\nUser chose to generate RAML without explicit field schemas. Keep request/response bodies high level (use minimal placeholder structures instead of enumerating every field).\n`;
    }

    const prompt = `Based on this MuleSoft architecture solution (generated by Architecture Agent), and strictly following your RAML Generation Agent system instructions (project structure, file naming, ">>> filename <<<" markers, !include syntax, TODO comment policy, and output contract), generate the complete RAML 1.0 API project for the following API:${contextInfo}

Architecture Solution:
${architectureSolution}

API Name: ${apiName}

Generate a RAML project that:
1. Accurately reflects the architecture, API layers (System/Process/Experience), and integration patterns described.
2. Includes API metadata (title, version, baseUri), security schemes, all resources/endpoints, request/response schemas, data types, examples, and documentation.
3. Uses the exact project structure, ">>> filename <<<" file markers, and key-value !include syntax defined in your system instructions.
4. Applies the placeholder TODO comment policy for any placeholder values (e.g., baseUri, URLs, client_id, client_secret, example values, version).

Output ONLY the RAML project files (RAML + JSON examples) in the exact format required by your system instructions. Do not include any markdown code fences or English explanations.`;

    const raml = await this.askWithSystemPrompt(
      this.systemPrompt,
      prompt,
      {
        temperature: 0.3, // Lower temperature for consistent syntax
        maxTokens: 4000,
        ...options
      }
    );
    return this.extractRAMLCode(raml);
  }

  /**
   * Generate RAML for specific API layer
   * @param {string} architectureSolution - Architecture solution
   * @param {string} layer - API layer (System, Process, or Experience)
   * @returns {Promise<string>} RAML specification
   */
  async generateRAMLForLayer(architectureSolution, layer) {
    const prompt = `Based on this MuleSoft architecture, and strictly following your RAML Generation Agent system instructions (project structure, ">>> filename <<<" markers, !include syntax, TODO comment policy, and output contract), generate the RAML 1.0 project focused on the ${layer} API layer:

${architectureSolution}

Focus specifically on the ${layer} API layer requirements while still using the exact project structure, file markers, and syntax rules from your system instructions. Output ONLY the RAML project files (RAML + JSON examples) with no markdown code fences or English explanations.`;

    const raml = await this.askWithSystemPrompt(
      this.systemPrompt,
      prompt,
      {
        temperature: 0.3,
        maxTokens: 4000
      }
    );

    return this.extractRAMLCode(raml);
  }

  /**
   * Generate RAML for all API layers
   * @param {string} architectureSolution - Architecture solution
   * @returns {Promise<object>} RAML for all layers
   */
  async generateRAMLForAllLayers(architectureSolution) {
    const layers = ["System", "Process", "Experience"];
    const ramlSpecs = {};

    for (const layer of layers) {
      try {
        ramlSpecs[layer] = await this.generateRAMLForLayer(architectureSolution, layer);
      } catch (error) {
        console.error(`Error generating RAML for ${layer} layer:`, error.message);
        ramlSpecs[layer] = null;
      }
    }

    return ramlSpecs;
  }

  extractApiTasksFromArchitectureContext(architectureSolution, context = {}) {
    const tasks = [];
    const addTask = (name, description = '') => {
      const cleanName = String(name || '').trim();
      if (!cleanName) return;
      const key = cleanName.toLowerCase();
      if (tasks.some(task => task.name.toLowerCase() === key)) return;
      tasks.push({
        id: `api-${Math.random().toString(36).substr(2, 9)}`,
        name: cleanName.slice(0, 120),
        description: String(description || 'Derived from architecture context').slice(0, 240)
      });
    };

    const useCases = Array.isArray(context.useCases) ? context.useCases : [];
    for (const useCase of useCases.slice(0, 6)) {
      addTask(
        `${useCase.name || 'Use Case'} API`,
        useCase.description || 'API component derived from extracted use case'
      );
    }

    const text = `${architectureSolution || ''}\n${context.requirements || ''}`;
    if (/experience\s+api/i.test(text)) addTask('Experience API', 'External-facing API for clients or inbound events');
    if (/process\s+api/i.test(text)) addTask('Process API', 'Orchestrates business process, transformation, and routing');
    if (/system\s+api/i.test(text)) addTask('System API', 'Encapsulates backend system integration and data access');

    if (tasks.length === 0) {
      addTask('Experience API', 'Expose endpoints for inbound requests or status queries');
      addTask('Process API', 'Transform and orchestrate integration flow');
      addTask('System API', 'Integrate with backend systems using connectors');
    }

    return tasks.slice(0, 6);
  }

  /**
   * Extract RAML code from LLM response
   * @param {string} response - LLM response
   * @returns {string} Clean RAML code
   */
  extractRAMLCode(response) {
    let code = response.trim();

    // Remove markdown code blocks if present
    code = code.replace(/```raml\n?/g, "");
    code = code.replace(/```yaml\n?/g, "");
    code = code.replace(/```\n?/g, "");

    // Remove any leading/trailing whitespace
    code = code.trim();

    // Normalize file header markers: allow '>>> filename' and convert to '>>> filename <<<'
    // Match lines that start with >>> and do not already contain '<<<'
    code = code.replace(/^>>>\s*([^<\n]+?)\s*$/gm, '>>> $1 <<<');

    return code;
  }

  /**
   * Save RAML to file
   * @param {string} ramlCode - RAML specification
   * @param {string} filePath - Path to save file
   * @returns {Promise<void>}
   */
  async saveRAML(ramlCode, filePath) {
    const fsExtra = (await import("fs-extra")).default;
    await fsExtra.writeFile(filePath, ramlCode, "utf-8");
  }

  /**
   * Generate and save RAML
   * @param {string} architectureSolution - Architecture solution
   * @param {string} outputPath - Output file path
   * @param {string} apiName - API name
   * @returns {Promise<string>} Path to saved file
   */
  async generateAndSave(architectureSolution, outputPath, apiName = "API") {
    const raml = await this.generateRAML(architectureSolution, apiName);
    await this.saveRAML(raml, outputPath);
    return outputPath;
  }

  /**
   * Validate RAML syntax (basic check)
   * @param {string} ramlCode - RAML code to validate
   * @returns {boolean} True if appears valid
   */
  validateRAML(ramlCode) {
    // Basic validation - check for RAML header
    return ramlCode.includes("#%RAML 1.0") || ramlCode.includes("title:");
  }


  // In RAMLGenerationAgent.js

  /**
   * Extract API tasks from estimation using LLM
   * @param {string} estimation - The estimation text/object
   * @returns {Promise<Array>} Array of API tasks
   */
  async extractApiTasksFromEstimation(estimation) {
    const prompt = `Analyze the following project estimation and identify the main API components.
  
Estimation:
${JSON.stringify(estimation, null, 2)}

Extract ONLY the API names and their brief descriptions in this format:
[
  {
    "name": "API Name (e.g., Payment System API)",
    "description": "Brief one-line description of what this API does"
  }
]

Return ONLY the JSON array, nothing else. No markdown formatting.`;


    try {
      // Add a timeout guard so we don't block the UI waiting for LLM
      const askPromise = this.askWithSystemPrompt(
        "You are an expert at identifying API components from project estimations. " +
        "Extract just the API names and their one-line descriptions. " +
        "Return ONLY a valid JSON array with no additional text or formatting.",
        prompt,
        {
          temperature: 0.3,
          maxTokens: 600
        }
      );

      const response = await Promise.race([
        askPromise,
        new Promise((resolve) => setTimeout(() => resolve("[]"), 15000)) // 15s fallback to empty array
      ]);

      // Helper: aggressively extract a JSON array of objects with name/description
      const tryExtractArray = (text) => {
        if (!text || typeof text !== 'string') return null;
        // 1) direct parse
        try {
          const direct = JSON.parse(text.trim());
          if (Array.isArray(direct)) return direct;
          if (direct && typeof direct === 'object' && Array.isArray(direct.items)) return direct.items;
        } catch {}
        // 2) fenced block
        const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
        if (fence && fence[1]) {
          try {
            const fromFence = JSON.parse(fence[1].trim());
            if (Array.isArray(fromFence)) return fromFence;
          } catch {}
        }
        // 3) first JSON array substring (greedy)
        const arrayMatch = text.match(/\[\s*{[\s\S]*?}\s*\]/m);
        if (arrayMatch) {
          try {
            const arr = JSON.parse(arrayMatch[0]);
            if (Array.isArray(arr)) return arr;
          } catch {}
        }
        // 4) Build from lines starting with - name/description patterns
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const items = [];
        for (let i = 0; i < lines.length; i++) {
          const ln = lines[i];
          const nameMatch = ln.match(/^[-*]\s*name\s*:\s*(.+)$/i) || ln.match(/^[-*]\s*(.+?)\s*:\s*.+$/);
          if (nameMatch) {
            const name = (nameMatch[1] || '').trim();
            // lookahead for description on next lines
            let description = '';
            for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
              const d = lines[j].match(/^[-*]\s*description\s*:\s*(.+)$/i);
              if (d) { description = d[1].trim(); break; }
            }
            if (name) items.push({ name, description });
          }
        }
        if (items.length) return items;
        return null;
      };

      let parsed = tryExtractArray(String(response || ''));
      // Heuristic fallback if LLM responded but not parsable
      if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
        // Try to heuristically infer API tasks from estimation text
        const estText = typeof estimation === 'string' ? estimation : JSON.stringify(estimation || {});
        const hasExperience = /experience\s+api/i.test(estText);
        const hasProcess = /process\s+api/i.test(estText);
        const hasSystem = /system\s+api/i.test(estText);
        const heuristics = [];
        if (hasExperience) heuristics.push({ name: 'Experience API', description: 'External-facing API for webhook or client access' });
        if (hasProcess) heuristics.push({ name: 'Process API', description: 'Orchestrates flows and business logic' });
        if (hasSystem) heuristics.push({ name: 'System API', description: 'Encapsulates SAP integration and data access' });
        // If none detected, still propose the canonical API-led trio for typical projects
        if (heuristics.length === 0) {
          heuristics.push(
            { name: 'Experience API', description: 'Expose endpoints for inbound requests or status queries' },
            { name: 'Process API', description: 'Consume MQ/stream, transform and orchestrate to backend' },
            { name: 'System API', description: 'Integrate with SAP using connectors and handle errors' }
          );
        }
        parsed = heuristics;
      }

      const apiList = Array.isArray(parsed) ? parsed : [parsed];
      return apiList.slice(0, 6).map(api => ({
        id: `api-${Math.random().toString(36).substr(2, 9)}`,
        name: (api && api.name ? String(api.name) : 'Unnamed API').slice(0, 120),
        description: (api && api.description ? String(api.description) : 'No description available').slice(0, 240)
      }));

    } catch (error) {
      console.error('Error extracting API tasks:', error);
      // Heuristic last resort: return API-led trio so UI can proceed
      return [
        { id: `api-${Math.random().toString(36).substr(2, 9)}`, name: 'Experience API', description: 'External-facing API' },
        { id: `api-${Math.random().toString(36).substr(2, 9)}`, name: 'Process API', description: 'Orchestrates business logic' },
        { id: `api-${Math.random().toString(36).substr(2, 9)}`, name: 'System API', description: 'Backend integration (e.g., SAP)' }
      ];
    }
  }
}

export default RAMLGenerationAgent;
