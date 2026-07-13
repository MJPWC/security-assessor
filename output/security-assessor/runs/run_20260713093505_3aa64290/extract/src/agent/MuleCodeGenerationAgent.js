import BaseAgent from "./BaseAgent.js";
import { getAgentConfig } from "../config/agentConfigs.js";
import { A2AMessage } from "../a2a/Message.js";
import { parseRamlProjectToFiles, cleanRamlContent } from "../raml/raml_publishing.js";
import LLMManager from "../llm/LLMManager.js";
import GeminiClient from "../llm/GeminiClient.js";
import OpenAIClient from "../llm/OpenAIClient.js";
import AnthropicClient from "../llm/AnthropicClient.js";
import OpenRouterClient from "../llm/OpenRouterClient.js";
import GroqClient from "../llm/GroqClient.js";
import Config from "../config/config.js"; // Import Config class

/**
 * Mule Code Generation Agent
 * Generates Mule application code based on RAML specifications
 */
class MuleCodeGenerationAgent extends BaseAgent {
  constructor(config = null, agentConfig = null, socket = null) {
    const agentConfigInstance = config || new Config(); // Create Config instance here

    const clientConfigs = [
      {
        key: 'anthropic',
        class: AnthropicClient,
        config: {
          apiKey: agentConfigInstance.anthropicApiKey,
          model: agentConfigInstance.anthropicModel
        },
        priority: 1
      },
      {
        key: 'groq',
        class: GroqClient,
        config: {
          apiKey: agentConfigInstance.groqApiKey,
          model: agentConfigInstance.groqModel
        },
        priority: 2
      },
      {
        key: 'openai',
        class: OpenAIClient,
        config: {
          apiKey: agentConfigInstance.openaiApiKey,
          model: agentConfigInstance.openaiModel
        },
        priority: 3
      },
      {
        key: 'gemini',
        class: GeminiClient,
        config: {
          apiKey: agentConfigInstance.geminiApiKey || (agentConfigInstance.geminiApiKeys && agentConfigInstance.geminiApiKeys[0]),
          apiKeys: agentConfigInstance.geminiApiKeys,
          model: agentConfigInstance.geminiModel
        },
        priority: 4
      },
      {
        key: 'openrouter',
        class: OpenRouterClient,
        config: {
          apiKey: agentConfigInstance.openrouterApiKey,
          model: agentConfigInstance.openrouterModel,
          baseUrl: agentConfigInstance.openrouterBaseUrl,
          site: agentConfigInstance.openrouterSite,
          appName: agentConfigInstance.openrouterAppName
        },
        priority: 5
      }
    ];

    const preferredIndex = clientConfigs.findIndex(({ key }) => key === agentConfigInstance.provider);
    if (preferredIndex > 0) {
      const [preferredConfig] = clientConfigs.splice(preferredIndex, 1);
      clientConfigs.unshift(preferredConfig);
    }

    const llmManager = new LLMManager(clientConfigs);
    super(agentConfigInstance, 'mule-code-agent', llmManager); // A2A Protocol: Set agent ID
    this.socket = socket;

    // Use provided agentConfig or load from config file
    const defaultConfig = agentConfig || getAgentConfig("muleCode");

    // Set agent metadata
    this.name = defaultConfig?.name || "Mule Code Generation Agent";
    this.description = defaultConfig?.description || "Generates complete Mule application code based on RAML specifications";
    this.conversationStarters = defaultConfig?.conversationStarters || [];
    this.knowledge = defaultConfig?.knowledge || [];

    // Set system prompt (instructions)
    this.systemPrompt = defaultConfig?.instructions || `You are an expert MuleSoft developer specializing in generating complete Mule 4 application code.

You specialize in:
- Mule 4 DataWeave transformations
- Mule flows and subflows
- Connectors (HTTP, Database, File, Salesforce, SAP, etc.)
- Error handling and logging
- Maven project structure (pom.xml)
- Mule application configuration files
- Best practices for MuleSoft development

Generate complete, production-ready Mule applications that include:
- pom.xml (Maven project file)
- mule-artifact.json (Mule application metadata)
- src/main/mule/ (Mule flows and configurations)
- src/main/resources/ (Properties, schemas, etc.)
- .muleignore (Files to exclude from deployment)

Always output valid Mule 4 code following MuleSoft best practices.`;

    // A2A Protocol: Register this agent
    this.register({
      name: this.name,
      description: this.description,
      capabilities: ['generate-mule-code', 'generate-mule-application', 'generate-mule-project']
    });
  }

  /**
   * A2A Protocol: Handle incoming messages from other agents
   * @param {A2AMessage} message - Incoming A2A message
   * @returns {Promise<A2AMessage>} Response message
   */
  async handleMessage(message) {
    console.log(`📨 Mule Code Agent received message from ${message.from}: ${message.payload.type}`);

    try {
      let result;
      const context = message.context || {};

      switch (message.payload.type) {
        case 'generate-mule-code':
        case 'generate-mule-application':
        case 'generate-mule-project':
          // Get RAML from payload or context
          const raml = message.payload.raml || context.raml;
          if (!raml) {
            throw new Error("RAML specification is required.");
          }

          // Include architecture and other context
          if (message.payload.architecture) {
            context.architecture = message.payload.architecture;
          }

          result = await this.generateMuleCode(
            raml,
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
        { muleCode: result, result },
        message.requestId,
        { ...context, muleCode: result }
      );
    } catch (error) {
      console.error(`❌ Mule Code Agent error:`, error);
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
   * Generate Mule code from RAML specification
   * @param {string} ramlContent - RAML specification (REQUIRED)
   * @param {string} apiName - Name of the API
   * @param {object} options - Additional options
   * @param {object} context - Additional context from previous agents
   * @returns {Promise<object>} Mule project structure with files
   */
  async generateMuleCode(ramlContent, apiName = "MuleSoftAPI", options = {}, context = {}) {
    if (!ramlContent) {
      throw new Error("RAML specification is required. Please generate RAML first using RAMLGenerationAgent.");
    }

    const sessionId = context.sessionId || options.sessionId || null;
    context.sessionId = sessionId;

    if (this.socket) {
      this.socket.emit('mule-code-agent-started', {
        apiName,
        timestamp: new Date().toISOString(),
        sessionId
      });
    }

    return await this._generateMuleCodeInternal(ramlContent, apiName, options, context);
  }

  async _generateMuleCodeInternal(ramlContent, apiName, options, context) {
    // Build context information
    let contextInfo = "";
    if (context.architecture) {
      contextInfo += `\nArchitecture Solution (for reference):\n${context.architecture.substring(0, 2000)}...\n`;
    }
    if (context.diagram) {
      contextInfo += `\nArchitecture Diagram (for reference on data flow):\n${context.diagram}\n`;
    }

    // Generate ALL files in ONE LLM call for better consistency and quality
    const muleProject = {
      files: []
    };

    // Single comprehensive prompt to generate all files at once
    const allFilesPrompt = `Based on this RAML specification, generate a complete Mule 4 application project with ALL required files.

RAML Specification:
${ramlContent}

${contextInfo}

CRITICAL: You MUST follow ALL rules defined in the system prompt. This includes all 42+ rule sections covering:
- Strict folder & file structure enforcement
- File naming conventions (kebab-case)
- Component and variable naming (kebab-case for flows, PascalCase for configs, camelCase for variables)
- Mule runtime version requirements (4.9.0+)
- Connector version rules (explicit versions, no ranges, compatible with 4.9+)
- POM.XML configuration rules (mule-application packaging, UTF-8 encoding, repositories, etc.)
- Mule-Artifact.JSON rules (minMuleVersion, javaSpecificationVersions)
- Mule configuration rules (namespaces, schema locations, doc:id/doc:name attributes)
- HTTP listener configuration rules
- Logging configuration rules (log4j2.xml locations, structured logging)
- Error handling enforcement (unified global-error-handler.xml, canonical error models)
   - DataWeave transformation rules (2.0 syntax, ALL scripts MUST be externalized to *.dwl files in src/main/resources/dwl/ - NO inline scripts allowed in XML files)
- Configuration properties rules (environment segregation, TODO placeholders)
- RAML API definition rules (RAML project in src/main/resources/api folder)
- RAML scaffolding & flow generation rules
- Connector configuration rules (Salesforce, Database, SAP, Workday, HTTP, etc.)
- Flow structure rules (entry/exit logs, correlation ID, validation, transformation)
- Flow logic and execution sequence rules (MANDATORY - scheduler flows, query patterns, conditional logic, iteration, transformation flow, error handling flow, transaction management, logging patterns, rate limiting, flow exit patterns)
- API-led connectivity rules (Experience → Process → System)
- Common logic structure rules
- Variable management rules
- Scheduler configuration rules
- Health check rules
- Code quality rules
- Test requirements
- Security & secrets rules
- Performance rules
- Mule 4 coding standards
- Versioning rules
- Packaging & deployability
- Quality gates & validation
- Prohibited elements
- Documentation & metadata rules
- Module & dependency management

ADDITIONAL CRITICAL RULES FOR THIS GENERATION - MUST FOLLOW EXACTLY:

1. TRANSFORM MESSAGE STRUCTURE:
   - <ee:transform> MUST follow this exact structure:
     <ee:transform doc:name="Transform Name">
       <ee:message>
         <ee:set-payload resource="dwl/transform-payload.dwl"/>
       </ee:message>
       <ee:variables>
         <ee:set-variable variableName="varName" resource="dwl/transform-variable.dwl"/>
       </ee:variables>
     </ee:transform>
   - ALL DataWeave scripts MUST be in external .dwl files - NO inline CDATA sections with DataWeave code
   - MUST use resource attribute to reference external .dwl files (NOT file attribute, NOT CDATA)
   - NEVER place <ee:set-variable> directly inside <ee:message>
   - ALL variables MUST be inside <ee:variables> tag
   - NEVER use <set-property> - it does not exist in Mule 4
   - Alternative structure for simple payload transforms:
     <ee:set-payload doc:name="Transform Payload" resource="dwl/transform-payload.dwl"/>

2. NAMING CONVENTIONS (MANDATORY):
   - For RESTful API flows (HTTP-triggered flows), MUST follow RESTful naming pattern: {http-method}:\{path}:{content-type}:{operation-name}
     Examples:
     * get:\accounts:application\json:get-accounts
     * post:\accounts:application\json:create-account
     * get:\accounts\(accountId):application\json:get-account-by-id
     * put:\accounts\(accountId):application\json:update-account
     * delete:\accounts\(accountId):application\json:delete-account
   - For non-RESTful flows (scheduler flows, VM flows, etc.), use descriptive naming: {api-name}-{purpose}-flow
     Examples:
     * customer-api-sync-data-flow
     * salesforce-api-scheduled-query-flow
   - Special Characters in Flow Names:
     * Flow names MUST NOT contain special characters: /, [, ], {, }, #
     * Forward slashes (/) are NOT acceptable and must be replaced with hyphens (-) in flow names
     * Backslashes (\) are ONLY allowed in RESTful flow names (as part of the RESTful naming pattern)
     * Non-RESTful flow names MUST NOT contain backslashes - use hyphens instead
     * When URI parameters are present in RESTful path, use parentheses in flow name:
       Correct: get:\accounts\(accountId):application\json:get-account-by-id
       Incorrect: get:\accounts\{accountId}:application\json:get-account-by-id
     * For non-RESTful flows, replace any special characters (including backslashes) with hyphens or remove them
     * Examples:
       RESTful flow (backslashes allowed): get:\accounts:application\json:get-accounts
       Non-RESTful flow (no backslashes): customer-api-sync-data-flow (NOT customer\api\sync\data\flow)
   - All subflows: <apiName>-shared-<purpose>-subflow
     Example: customer-api-shared-validate-request-subflow
   - All config files: <apiName>-config.xml
     Example: customer-api-config.xml
   - Global config file: global-config.xml (must be generated)
   - Property placeholders must always be wrapped: \${http.port:8081} or \${secure::db.password}

3. GLOBAL-CONFIG.XML RULES (MANDATORY):
   - global-config.xml MUST be generated for ALL connector configurations (HTTP listeners, HTTP request configs, Salesforce configs, Database configs, etc.)
   - MUST contain ONLY connector configurations (HTTP listener, database, external systems)
   - MUST NOT contain any <flow> or <subflow> elements
   - MUST NOT contain error handlers (those go in global-error-handler.xml)
   - Configuration properties MUST reference .properties files, NOT .yaml files
   - Use: <configuration-properties file="application-\${env}.properties" />
   - NOT: <configuration-properties file="config/\${env}.yaml" />
   - File must be named global-config.xml (required file name)
   - {api-name}-common.xml (or global.xml) MAY be generated for reusable flows, connectors, and shared code (optional - only if reusable code exists)
   - Clarification: global-config.xml is for CONFIGURATIONS, while {api-name}-common.xml/global.xml is for REUSABLE CODE. They serve different purposes and can coexist.

4. ENVIRONMENT PROPERTY FILES (CRITICAL):
   - application-dev.properties: ONLY development environment properties
     * Dev URLs, dev ports, DEBUG logging
     * Dev connector connection details (database connection strings, Salesforce URLs, external API endpoints, etc.)
     * Dev credentials placeholders using \${secure::keyName} format
     * Properties requiring actual connection details MUST use TODO placeholders:
       Example: salesforce.username=your_salesforce_username
       Example: database.url=your_database_url
       Example: api.clientId=your_client_id
       Example: api.clientSecret=your_client_secret
   - application-qa.properties: ONLY QA environment properties
     * QA URLs, qa ports, INFO logging
     * QA connector connection details (database connection strings, Salesforce URLs, external API endpoints, etc.)
     * QA credentials placeholders using \${secure::keyName} format
     * Properties requiring actual connection details MUST use TODO placeholders (same format as dev)
   - application-prod.properties: ONLY production environment properties
     * Prod URLs, prod ports, WARN logging
     * Prod connector connection details (database connection strings, Salesforce URLs, external API endpoints, etc.)
     * Prod credentials placeholders using \${secure::keyName} format
     * Properties requiring actual connection details MUST use TODO placeholders (same format as dev)
   - Each file must contain ONLY properties for that specific environment
   - Environment-specific property files MUST contain connection details for ALL connectors defined in global-config.xml
   - If global-config.xml has Salesforce connector → each env file must have:
     salesforce.url=your_salesforce_url, salesforce.username=your_salesforce_username, salesforce.password=your_salesforce_password, salesforce.securityToken=your_salesforce_security_token
   - If global-config.xml has Database connector → each env file must have:
     database.url=your_database_url, database.username=your_database_username, database.password=your_database_password
   - If global-config.xml has HTTP requester config → each env file must have the base URLs for that environment
   - Connection details are the PRIMARY reason for environment-specific files
   - TODO placeholders make it clear which values need to be replaced with actual connection details
   - Do NOT mix properties from different environments in the same file
   - Do NOT include file markers (>>> filename <<<) in the file content

5. EXPERIENCE API RULES:
   - Must NOT call databases or external systems directly
   - Must only perform: request validation, transformation, routing, response preparation
   - Every Experience flow must include in order:
     1. Entry log: "Entered #[flow.name] - CorrelationId: #[correlationId()]"
     2. Request validation
     3. Request transformation
     4. Call to Process API via HTTP requester
     5. Response transformation
     6. Exit log: "Exited #[flow.name] - CorrelationId: #[correlationId()]"
   - Must NOT contain complex business logic
   - Errors must be handled by global-error-handler.xml
   - HTTP listener must include OAuth security policy placeholders

6. PROCESS API RULES:
   - Must contain business logic and orchestration
   - Must call System APIs (never call external systems directly)
   - Must use canonical request and response models
   - All transformations must be in DataWeave scripts in src/main/resources/dwl/ (ALL scripts must be externalized - NO inline scripts)
   - If RAML indicates async operations, use VM queues for async publish/consume
   - Must NOT access external databases or systems directly

7. SYSTEM API RULES:
   - Must only communicate with backend systems
   - Must NOT contain business logic
   - Each operation must include:
     1. Entry log with correlation ID
     2. Input validation
     3. Transformation (to system format)
     4. Connector invocation
     5. Response transformation (to canonical format)
     6. Exit log with correlation ID
   - Must generate correct connector config based on backend type
   - Must implement standardized error handling
   - Must generate CRUD flows with correct payload transformations
   - Must NOT expose public HTTP listeners (internal only)

8. SALESFORCE SYSTEM API RULES (if Salesforce detected in RAML):
   - If RAML mentions Salesforce, SF, CRM, Account, Contact, Lead, Opportunity → create Salesforce flows
   - Salesforce config must include:
     username: \${secure::salesforce.username}
     password: \${secure::salesforce.password}
     securityToken: \${secure::salesforce.securityToken}
     authType: BASIC
   - GET operations: input validation → SOQL transformation (dynamic) → Query → response transformation
   - CREATE operations: input validation → transform to SF object → create → response transformation
   - UPDATE operations: input validation → transform to SF object → update → response transformation
   - DELETE operations: input validation → delete → response transformation
   - SOQL queries must be dynamically generated (NOT hardcoded)
   - Map Salesforce errors: SF:BAD_REQUEST (400), SF:NOT_FOUND (404), SF:UNAUTHORIZED (401), SF:SERVER_ERROR (500)

9. COMMON LOGIC STRUCTURE:
   - Every flow must begin with entry log: "Entered #[flow.name] - CorrelationId: #[correlationId()]"
   - Every flow must propagate correlation ID to downstream systems
   - ALL DataWeave scripts MUST be externalized to *.dwl files in src/main/resources/dwl/ (NO inline scripts allowed in XML files)
   - Reusable transforms in src/main/resources/dwl/
   - Repeated logic → shared subflow in <apiName>-common.xml
   - All responses must be transformed to canonical models
   - Every flow must end with exit log: "Exited #[flow.name] - CorrelationId: #[correlationId()]"

10. SECURITY RULES:
   - Experience API HTTP listener must include OAuth security policy placeholders
   - No hardcoded credentials → use \${secure::keyName} in properties
   - All sensitive data must use secure:: prefix

11. LOGGING RULES:
   - Every flow must log entry and exit with correlation ID
   - Must NOT expose sensitive information in logs
   - Logger messages must always include correlation ID
   - Use structured logging format

12. ERROR HANDLING RULES:
   - Generate global-error-handler.xml (unified error handler)
   - All API tiers must use same error structure and canonical error model
   - Backend errors must be transformed to canonical error payloads (never return raw)
   - Map HTTP codes: 400→VALIDATION:INVALID_INPUT, 401→AUTH:UNAUTHORIZED, 404→API:NOT_FOUND, 500→API:INTERNAL_ERROR
   - Error responses must include correlation ID

4. MANDATORY FILES (ALL must be generated):
   - pom.xml (project root)
   - mule-artifact.json (project root)
   - .gitignore (project root)
   - .muleignore (project root)
   - src/main/mule/global-config.xml (ONLY connector configs - REQUIRED file name)
   - src/main/mule/global-error-handler.xml (common error handlers - unified error handler)
   - src/main/mule/api-flows.xml (main API flows with APIKit router and implementation flows from RAML)
   - src/main/mule/<apiName>-common.xml (OPTIONAL - shared subflows if logic is repeated, only generate if reusable code exists)
   - src/main/resources/application.properties (base/common properties)
   - src/main/resources/application-dev.properties (dev environment ONLY)
   - src/main/resources/application-qa.properties (qa environment ONLY)
   - src/main/resources/application-prod.properties (prod environment ONLY)
   - src/main/resources/log4j2.xml (MUST be in src/main/resources)
   - src/test/resources/log4j2-test.xml (MUST be in src/test/resources)
   - src/main/java/.gitkeep (empty directory marker)
   - src/test/mule/.gitkeep (empty directory marker)
   - src/main/resources/dwl/ (folder for ALL DataWeave scripts - NO inline scripts allowed)
   - src/main/resources/dwl/*.dwl (ALL DataWeave transformation files - MUST generate .dwl file for EVERY transformation referenced in XML flows)

OUTPUT FORMAT - Generate ALL files using this exact format:
>>> pom.xml <<<
<complete pom.xml content>

>>> mule-artifact.json <<<
<complete mule-artifact.json content>

>>> .gitignore <<<
<complete .gitignore content>

>>> .muleignore <<<
<complete .muleignore content>

>>> src/main/mule/global-config.xml <<<
<complete global-config.xml content with ONLY connector configs and .properties file references>
CRITICAL: global-config.xml MUST be generated for ALL connector configurations (HTTP listeners, HTTP request configs, Salesforce configs, Database configs, etc.)
This file is MANDATORY and must contain ONLY connector configurations - NO flows or subflows.
File must be named global-config.xml (not global.xml)

>>> src/main/mule/<apiName>-common.xml <<<
<OPTIONAL - Only generate if reusable flows, connectors, or shared code exists>
<complete {api-name}-common.xml content with reusable subflows, shared connectors, and common logic>
Note: This file is OPTIONAL - only generate if there is reusable code that needs to be shared across flows.
Clarification: global-config.xml is for CONFIGURATIONS, while {api-name}-common.xml is for REUSABLE CODE. They serve different purposes and can coexist.

>>> src/main/mule/global-error-handler.xml <<<
<complete global-error-handler.xml content with unified error handling for all API tiers>

>>> src/main/mule/api-flows.xml <<<
<complete api-flows.xml content with:
- APIKit router flows generated from RAML (one router flow per RAML resource)
- Implementation flows (NOT empty, must contain: entry log, validation, transformation, connector/HTTP calls, response transformation, exit log, error handling)
- For RESTful API flows (HTTP-triggered), MUST follow RESTful naming pattern: {http-method}:\{path}:{content-type}:{operation-name}
  Examples: get:\accounts:application\json:get-accounts, post:\accounts:application\json:create-account
- For non-RESTful flows (scheduler, VM, etc.), use descriptive naming: {api-name}-{purpose}-flow
  Examples: customer-api-sync-data-flow, salesforce-api-scheduled-query-flow
- Flow names MUST NOT contain special characters: /, [, ], {, }, #
- Forward slashes (/) are NOT acceptable and must be replaced with hyphens (-) in flow names
- Backslashes (\) are ONLY allowed in RESTful flow names (as part of RESTful naming pattern)
- Non-RESTful flow names MUST NOT contain backslashes - use hyphens instead
- When URI parameters are present in RESTful path, use parentheses: get:\accounts\(accountId):application\json:get-account-by-id
- For non-RESTful flows, replace any special characters (including backslashes) with hyphens
- All subflows follow naming: <apiName>-shared-<purpose>-subflow
- Correct transform message structure with <ee:variables> tag
- EVERY DataWeave transformation MUST use external .dwl files - NO inline DataWeave scripts allowed in XML
- Use <ee:transform> with resource attribute: <ee:set-payload resource="dwl/transform-name.dwl"/>
- Every flow starts with entry logger and ends with exit logger
- Correlation ID propagation to downstream systems>

>>> src/main/resources/application.properties <<<
<base/common properties only>

>>> src/main/resources/application-dev.properties <<<
<ONLY development environment properties - no qa or prod properties>

>>> src/main/resources/application-qa.properties <<<
<ONLY QA environment properties - no dev or prod properties>

>>> src/main/resources/application-prod.properties <<<
<ONLY production environment properties - no dev or qa properties>

>>> src/main/resources/log4j2.xml <<<
<complete log4j2.xml content>

>>> src/test/resources/log4j2-test.xml <<<
<complete log4j2-test.xml content>

>>> src/main/java/.gitkeep <<<
# This file ensures the directory is included in version control

>>> src/test/mule/.gitkeep <<<
# This file ensures the directory is included in version control

>>> src/main/resources/dwl/transform-request-payload.dwl <<<
%dw 2.0
output application/json
---
[DataWeave transformation logic for request payload - replace with actual transformation]

>>> src/main/resources/dwl/transform-response-payload.dwl <<<
%dw 2.0
output application/json
---
[DataWeave transformation logic for response payload - replace with actual transformation]

CRITICAL: Generate ALL required .dwl files for EVERY DataWeave transformation used in the flows. Each transformation referenced in XML files (via resource="dwl/...") MUST have a corresponding .dwl file. Use descriptive names like:
- transform-request-payload.dwl
- transform-response-payload.dwl
- transform-to-canonical.dwl
- transform-to-salesforce-format.dwl
- transform-to-database-format.dwl
- transform-success-response.dwl
- transform-error-response.dwl
- transform-validate-headers.dwl
- etc.
Each .dwl file must start with: %dw 2.0\noutput application/json\n---\n[actual transformation logic]

13. APIKIT AND IMPLEMENTATION FLOWS:
   - APIKit router flows must be generated from RAML resources and methods
   - Implementation flows must NOT be empty - must contain meaningful logic:
     * Entry log with correlation ID
     * Request validation
     * Transformation logic
     * Connector calls (System APIs) or HTTP requester calls (Experience/Process APIs)
     * Response transformation
     * Exit log with correlation ID
     * Error handling
   - Every RAML endpoint must have a corresponding implementation flow

14. DATAWEAVE EXTERNALIZATION (MANDATORY):
   - ALL DataWeave scripts MUST be externalized to *.dwl files in src/main/resources/dwl/
   - NO inline DataWeave scripts are allowed in XML files - ALL scripts must be in external .dwl files
   - Reference external DWL files using resource attribute:
     * <ee:transform doc:name="Transform to JSON">
     *     <ee:message>
     *         <ee:set-payload resource="dwl/transform-to-json.dwl"/>
     *     </ee:message>
     * </ee:transform>
     * OR: <ee:set-payload doc:name="Transform Payload" resource="dwl/transform-payload.dwl"/>
   - Each .dwl file must start with: %dw 2.0\noutput application/json\n---\n[transformation logic]
   - Reusable transforms must be in src/main/resources/dwl/ folder

15. FLOW STRUCTURE REQUIREMENTS:
   - Every flow must start with entry logger: <logger level="INFO" message="Entered #[flow.name] - CorrelationId: #[correlationId()]" />
   - Every flow must end with exit logger: <logger level="INFO" message="Exited #[flow.name] - CorrelationId: #[correlationId()]" />
   - Correlation ID must be propagated to downstream systems via headers
   - All flows must have error handling (flow-specific or global)

16. MULE RUNTIME VERSION (MANDATORY):
   - Minimum Mule runtime version: 4.9.0 (4.9.x and above) - Latest version preferred
   - All code MUST be compatible with Mule 4.9+
   - Use latest stable connector versions compatible with Mule 4.9+ (verify against Anypoint Exchange)
   - pom.xml must specify app.runtime 4.9.0 or higher in mule-maven-plugin configuration
   - mule-artifact.json must specify minMuleVersion "4.9.0"
   - Do NOT use Mule 4.8.x or lower versions
   - Do NOT use SNAPSHOT or BETA runtimes

17. POM.XML REQUIREMENTS (MANDATORY):
   - Packaging type: mule-application
   - Encoding: UTF-8 (project.build.sourceEncoding and project.reporting.outputEncoding)
   - GroupId: com.mulesoft.app
   - ArtifactId: kebab-case matching project name
   - Version: semantic versioning (e.g., 1.0.0)
   - MUST include Anypoint Exchange repository (anypoint-exchange-v3)
   - MUST include MuleSoft Releases repository (mulesoft-releases)
   - MUST use mule-plugin classifier for MuleSoft connectors
   - MUST specify exact versions for all dependencies (NO version ranges, NO LATEST, NO RELEASE)
   - MUST organize dependencies by category (connectors, modules, etc.)
   - MUST NOT include unused or redundant dependencies
   - Maven Enforcer plugin SHOULD be used for version consistency

18. MULE-ARTIFACT.JSON REQUIREMENTS (MANDATORY):
   - MUST specify minMuleVersion: "4.9.0" (or higher)
   - MUST specify javaSpecificationVersions: ["17"]
   - MUST include name field matching artifactId
   - MUST add generated-by metadata header (timestamp + generator version)

19. CONNECTOR CONFIGURATION REQUIREMENTS:
   - All connector configs MUST be in global-config.xml
   - Config names MUST use PascalCase with underscores: {SystemName}_Config
   - Examples: HTTP_Listener_config, Salesforce_Config, Database_Config, SAP_Config, Workday_Config
   - MUST use externalized properties for ALL connection details (no hardcoded values)
   - Database connector: MUST use parameterized queries with input-parameters, MUST use SSL for production
   - Salesforce connector: MUST use basic-connection with username, password, securityToken, url (HTTPS)
   - HTTP requester: MUST externalize baseUrl, timeout, connectionTimeout
   - All connectors MUST have corresponding properties in environment-specific property files

20. FLOW LOGIC AND EXECUTION SEQUENCE RULES (MANDATORY):
   - Flow Entry and Initialization:
     * Scheduler flows MUST start with scheduler component as first message source
     * Flow Pattern: scheduler → logger(INFO, 'Starting [operation]') → [operations]
     * Variables MUST be initialized before use, preferably after initial logging
     * External system queries SHOULD occur early, after initialization but before processing
   - External System Interaction Flow:
     * MUST query external systems BEFORE processing data - never process before fetching
     * Flow Pattern: query(external) → log(result) → validate → process
     * After external query, MUST immediately log result count before proceeding
     * MUST validate query results exist before processing - use choice router to check collection size
     * Flow Pattern: query → log → choice(when sizeOf(payload) > 0) → process : otherwise → log(no records)
     * Database insert MUST occur before external system update in same record processing context
   - Conditional Flow Logic:
     * MUST use choice router immediately after query to check if data exists
     * Flow Pattern: query → log → choice(when has data) → process : otherwise → handle empty
     * The 'when' branch SHOULD contain all processing logic, 'otherwise' SHOULD handle empty/null cases
     * Flow-level variables SHOULD be set inside 'when' branch before needed in processing
     * MUST log completion in 'when' branch after processing, log 'no records' in 'otherwise'
   - Iteration and Batch Processing Flow:
     * Foreach MUST be placed inside 'when' branch after validation, not before choice router
     * Flow Pattern: choice(when has data) → set-variable → foreach(collection) → [process each]
     * Each iteration MUST be wrapped in try-catch to prevent one failure from stopping entire batch
     * Process records MUST follow sequence: transform → insert → update → log → rate-limit (in that order)
     * Rate limiting delay SHOULD occur after successful operations, before next iteration
     * SHOULD log success for each record immediately after successful processing, before rate limit
   - Data Transformation Flow:
     * Transform data MUST occur immediately before database operations, not after query
     * Flow Pattern: query → log → choice → foreach → transform → insert
     * Transform SHOULD map source fields to target structure and set default values for optional fields
     * SHOULD use variables set earlier in flow (like currentTime) in transformation expressions
   - Error Handling Flow Logic:
     * Error handlers MUST be inside try blocks, which wrap operations that can fail
     * MUST use on-error-continue inside foreach loops to allow processing to continue with next record
     * Error logging SHOULD occur immediately in error handler, before flow continues
     * Error handlers SHOULD be placed at end of try block, after all operations that might fail
   - Transaction and State Management:
     * Flow-level variables MUST be set before iteration loops that need them
     * Each record processing SHOULD be independent - database insert and external update for same record in same try block
     * SHOULD use now() function consistently - set once as variable, reuse across batch
     * Rate limiting SHOULD occur after transaction completion, before starting next transaction
   - Logging Flow Patterns:
     * MUST log flow start immediately after scheduler, before any operations
     * SHOULD log query results immediately after query, before conditional check
     * SHOULD log success for each record immediately after successful processing
     * SHOULD log completion after all records processed, before flow ends
     * SHOULD log 'no records' in otherwise branch when query returns empty
     * MUST log errors in error handlers with context (record ID, operation, error description)
   - Rate Limiting Flow Logic:
     * Rate limiting MUST occur after successful operations, before next iteration
     * Rate limiting SHOULD be implemented as transform with wait() function, preserving payload
     * Rate limit delay SHOULD be configurable and placed consistently after each record operation
     * Rate limiting SHOULD NOT occur in error paths - only after successful operations
   - Flow Exit and Completion:
     * Flow SHOULD log completion status before natural termination
     * Both conditional branches (when/otherwise) SHOULD log their outcome before flow ends
     * Foreach completion SHOULD be followed by completion logging in the when branch
   - Complete Flow Pattern Structure:
     * Complete scheduler flow: Scheduler → Log Start → Query → Log Result → Choice → Process → Log Complete
     * Operations MUST follow sequence: Validate → Prepare → Persist → Synchronize → Log → Rate Limit
     * Operation Sequence: validate(data exists) → prepare(transform) → persist(insert db) → synchronize(update external) → log(success) → rate-limit → [next]

21. DATAWEAVE TRANSFORMATION REQUIREMENTS (MANDATORY):
   - MUST use DataWeave 2.0 only (%dw 2.0)
   - MUST specify output format: output application/json or output application/java
   - ALL DataWeave scripts MUST be externalized into *.dwl files under src/main/resources/dwl/
   - NO inline DataWeave scripts are allowed in XML files - ALL scripts must be in external .dwl files
   - MUST use <ee:transform> with resource attribute to reference external .dwl files:
     * <ee:transform doc:name="Transform to JSON">
     *     <ee:message>
     *         <ee:set-payload resource="dwl/transform-to-json.dwl"/>
     *     </ee:message>
     * </ee:transform>
   - Alternative: Use <ee:set-payload> with resource attribute:
     * <ee:set-payload doc:name="Transform Payload" resource="dwl/transform-payload.dwl"/>
   - Each .dwl file must start with: %dw 2.0\noutput application/json\n---\n[transformation logic]
   - DW files must be modular using import where appropriate
   - Use match for pattern validation and robust transformations
   - MUST use descriptive doc:name attributes
   - MUST include comments explaining transformation purpose
   - When accessing field named "type", MUST use single quotes: payload.identification.'type'
   - MUST use default values for optional fields to prevent null pointer exceptions
   - When using wait() function, MUST import dw::Runtime module explicitly
   - MUST use sizeOf() function for collection size checks

22. ERROR HANDLING REQUIREMENTS:
   - MUST generate global-error-handler.xml with unified error handling
   - MUST handle connector-specific errors: {CONNECTOR}:CONNECTIVITY → HTTP 502
   - MUST handle authentication errors: {CONNECTOR}:AUTHENTICATION → HTTP 401
   - MUST handle validation errors: VALIDATION:INVALID_INPUT → HTTP 400
   - MUST handle not found errors: {CONNECTOR}:NOT_FOUND → HTTP 404
   - MUST handle timeout errors: {CONNECTOR}:TIMEOUT → HTTP 504
   - MUST handle ANY (catch-all) → HTTP 500
   - Error payload MUST follow canonical format with error code, message, details, timestamp, correlationId, path
   - Backend errors MUST be transformed to canonical error payloads (never return raw)
   - MUST set httpStatus variable in error handlers
   - MUST log all errors with ERROR level

22. FLOW STRUCTURE REQUIREMENTS (MANDATORY ORDER):
   - 1. HTTP Listener (if applicable)
   - 2. Entry Logger with correlation ID
   - 3. Request Validation (use <validation:is-not-blank-string/>)
   - 4. Input Transformation (if needed)
   - 5. Business Logic (connector operations, validations)
   - 6. Output Transformation
   - 7. Response Logger with correlation ID
   - 8. Exit Logger with correlation ID
   - MUST use <choice> router for conditional logic
   - MUST check for empty results: #[sizeOf(payload) > 0]
   - MUST use try-catch blocks (try/error-handler) for operations that can fail
   - MUST use foreach for processing collections
   - MUST set httpStatus variable for non-200 responses

23. DOCUMENTATION REQUIREMENTS:
   - Every flow MUST have XML comment describing purpose: <!-- GET /accounts - Retrieve all accounts -->
   - Every DataWeave transformation MUST include comment explaining purpose
   - Global configuration MUST include annotations explaining usage
   - README.md MUST include: API Purpose, Layer type (EXP/PRC/SYS), Endpoints, Dependencies, Mule runtime version, How to run tests

24. CODE QUALITY REQUIREMENTS:
   - Every component MUST have doc:id attribute (kebab-case pattern)
   - Every component SHOULD have doc:name attribute (Title Case)
   - MUST use consistent indentation (4 spaces or tabs)
   - MUST use UTF-8 encoding in all XML files
   - MUST declare all required namespaces at root element
   - MUST include proper xsi:schemaLocation with Mule 4.9+ schema versions

IMPORTANT: 
- Do NOT include the file markers (>>> filename <<<) in the actual file content
- Each file content should start immediately after the marker
- Generate complete, production-ready code for all files
- Ensure consistency across all files
- Follow ALL naming conventions strictly (flows, subflows, config files)
- Ensure implementation flows are NOT empty and contain meaningful logic
- Generate global-config.xml (not global.xml) as the global configuration file
- All rules from the system prompt MUST be followed in addition to these generation-specific rules`;

    try {
      console.log('🔄 Generating all Mule project files in one LLM call...');
      const allFilesContent = await this.askWithSystemPrompt(
        this.systemPrompt,
        allFilesPrompt,
        {
          temperature: 0.3,
          maxTokens: 16000  // Increased for all files
        }
      );

      // Parse all files from the response
      const files = this.parseAllFilesFromResponse(allFilesContent);
      
      // Add all parsed files to project
      files.forEach(file => {
        muleProject.files.push(file);
      });

      console.log(`✅ Generated ${files.length} files in one call`);

    } catch (error) {
      console.error('❌ Error generating Mule code in one call, falling back to defaults:', error);
      // Fallback to default files if generation fails
      this.addDefaultFiles(muleProject, apiName);
    }

    // Add RAML project files to src/main/resources/api/ folder
    try {
      console.log('📦 Adding RAML project files to src/main/resources/api/...');
      const ramlFiles = this.addRamlProjectFiles(ramlContent);
      ramlFiles.forEach(file => {
        muleProject.files.push(file);
      });
      console.log(`✅ Added ${ramlFiles.length} RAML files to the project`);
    } catch (error) {
      console.error('⚠️ Warning: Failed to add RAML project files:', error.message);
      // Don't fail the entire generation if RAML files can't be added
    }

    return muleProject;
  }

  /**
   * Add RAML project files to the Mule project structure
   * @param {string} ramlContent - RAML project content as string
   * @returns {Array} Array of {path, content} objects with paths prefixed with src/main/resources/api/
   */
  addRamlProjectFiles(ramlContent) {
    if (!ramlContent || typeof ramlContent !== 'string' || !ramlContent.trim()) {
      console.warn('⚠️ No RAML content provided, skipping RAML file addition');
      return [];
    }

    try {
      // Clean and parse RAML content into files
      const cleanedRamlContent = cleanRamlContent(ramlContent);
      const ramlFiles = parseRamlProjectToFiles(cleanedRamlContent);

      if (!ramlFiles || ramlFiles.length === 0) {
        console.warn('⚠️ No RAML files parsed from content');
        return [];
      }

      // Map RAML files to Mule project structure under src/main/resources/api/
      const muleRamlFiles = ramlFiles.map(ramlFile => {
        // Get the relative path from api-project/ or use the path as-is
        let relativePath = ramlFile.path || '';
        
        // Remove api-project/ prefix if present
        relativePath = relativePath.replace(/^api-project\//i, '');
        
        // If path is empty or just 'api.raml', use it as-is
        if (!relativePath || relativePath === 'api.raml') {
          relativePath = 'api.raml';
        }
        
        // Construct the full path in Mule project structure
        const mulePath = `src/main/resources/api/${relativePath}`;
        
        return {
          path: mulePath,
          content: ramlFile.content || ''
        };
      });

      return muleRamlFiles;
    } catch (error) {
      console.error('❌ Error parsing RAML project files:', error);
      throw error;
    }
  }

  /**
   * Parse all files from a single LLM response
   * @param {string} response - LLM response containing all files
   * @returns {Array} Array of {path, content} objects
   */
  parseAllFilesFromResponse(response) {
    const files = [];
    let content = response.trim();

    // Remove markdown code blocks if present
    content = content.replace(/```xml\n?/g, "");
    content = content.replace(/```json\n?/g, "");
    content = content.replace(/```properties\n?/g, "");
    content = content.replace(/```yaml\n?/g, "");
    content = content.replace(/```\n?/g, "");

    // Pattern to match file markers: >>> path <<< or >>> path
    // Improved regex to handle multi-line content better
    const filePattern = />>>\s*([^\n<]+?)\s*(?:<<<)?\s*\n([\s\S]*?)(?=\n>>>\s*[^\n<]+?\s*(?:<<<)?\s*\n|$)/g;
    let match;
    const matches = [];

    // Collect all matches first
    while ((match = filePattern.exec(content)) !== null) {
      matches.push({
        path: match[1].trim(),
        content: match[2]
      });
    }

    // Process each match
    matches.forEach((match, index) => {
      const filePath = match.path;
      let fileContent = match.content.trim();

      // Remove any file markers that might be in the content
      fileContent = fileContent.replace(/>>>\s*[^\n<]+?\s*(?:<<<)?\s*\n?/g, '').trim();
      
      // Remove trailing file markers
      fileContent = fileContent.replace(/>>>\s*[^\n<]+?\s*(?:<<<)?\s*$/gm, '').trim();

      // For environment property files, ensure they only contain properties for that environment
      if (filePath.includes('application-dev.properties')) {
        // Remove any qa or prod properties that might have been included
        fileContent = this.cleanEnvironmentProperties(fileContent, 'dev');
      } else if (filePath.includes('application-qa.properties')) {
        fileContent = this.cleanEnvironmentProperties(fileContent, 'qa');
      } else if (filePath.includes('application-prod.properties')) {
        fileContent = this.cleanEnvironmentProperties(fileContent, 'prod');
      }

      if (filePath && fileContent) {
        files.push({ path: filePath, content: fileContent });
      }
    });

    return files;
  }

  /**
   * Clean environment properties to ensure only relevant environment properties are included
   */
  cleanEnvironmentProperties(content, env) {
    const lines = content.split('\n');
    const cleaned = [];
    
    lines.forEach(line => {
      // Skip lines that reference other environments
      if (env === 'dev' && (line.includes('qa') || line.includes('prod')) && !line.startsWith('#')) {
        // Skip if it's a property value referencing qa/prod (but allow comments)
        if (line.includes('qa-server') || line.includes('prod') || line.includes('production')) {
          return;
        }
      }
      if (env === 'qa' && (line.includes('dev') || line.includes('prod')) && !line.startsWith('#')) {
        if (line.includes('localhost') || line.includes('dev') || line.includes('production')) {
          return;
        }
      }
      if (env === 'prod' && (line.includes('dev') || line.includes('qa')) && !line.startsWith('#')) {
        if (line.includes('localhost') || line.includes('dev') || line.includes('qa-server')) {
          return;
        }
      }
      cleaned.push(line);
    });
    
    return cleaned.join('\n');
  }

  /**
   * Extract file content from LLM response (for backward compatibility)
   * @param {string} response - LLM response
   * @param {string} filename - Expected filename
   * @returns {string} Clean file content
   */
  extractFileContent(response, filename) {
    let content = response.trim();

    // Remove markdown code blocks if present
    content = content.replace(/```xml\n?/g, "");
    content = content.replace(/```json\n?/g, "");
    content = content.replace(/```properties\n?/g, "");
    content = content.replace(/```\n?/g, "");

    // Try to extract content after filename marker
    const marker = `>>> ${filename} <<<`;
    if (content.includes(marker)) {
      const parts = content.split(marker);
      if (parts.length > 1) {
        content = parts.slice(1).join(marker).trim();
        // Remove any subsequent file markers
        content = content.split(/>>>\s*[^\n<]+?\s*(?:<<<)?/)[0].trim();
      }
    }

    // Also try without <<<
    const marker2 = `>>> ${filename}`;
    if (content.includes(marker2) && !content.includes('<<<')) {
      const parts = content.split(marker2);
      if (parts.length > 1) {
        content = parts.slice(1).join(marker2).trim();
        // Remove any subsequent file markers
        content = content.split(/>>>\s*[^\n<]+?\s*(?:<<<)?/)[0].trim();
      }
    }

    // Remove file marker if it appears in the content itself
    content = content.replace(new RegExp(`>>>\\s*${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:<<<)?`, 'g'), '').trim();

    return content.trim();
  }

  /**
   * Add default files as fallback
   */
  addDefaultFiles(muleProject, apiName) {
    muleProject.files.push({ path: 'pom.xml', content: this.getDefaultPomXml(apiName) });
    muleProject.files.push({ path: 'mule-artifact.json', content: this.getDefaultMuleArtifact(apiName) });
    muleProject.files.push({ path: '.gitignore', content: this.getDefaultGitIgnore() });
    muleProject.files.push({ path: '.muleignore', content: this.getDefaultMuleIgnore() });
    muleProject.files.push({ path: 'src/main/resources/application.properties', content: this.getDefaultApplicationProperties() });
    muleProject.files.push({ path: 'src/main/resources/application-dev.properties', content: this.getDefaultDevProperties() });
    muleProject.files.push({ path: 'src/main/resources/application-qa.properties', content: this.getDefaultQaProperties() });
    muleProject.files.push({ path: 'src/main/resources/application-prod.properties', content: this.getDefaultProdProperties() });
    muleProject.files.push({ path: 'src/main/resources/log4j2.xml', content: this.getDefaultLog4j2() });
    muleProject.files.push({ path: 'src/test/resources/log4j2-test.xml', content: this.getDefaultLog4j2Test() });
    muleProject.files.push({ path: 'src/main/java/.gitkeep', content: '# This file ensures the directory is included in version control\n' });
    muleProject.files.push({ path: 'src/test/mule/.gitkeep', content: '# This file ensures the directory is included in version control\n' });
  }

  /**
   * Get default pom.xml content
   */
  getDefaultPomXml(apiName) {
    const sanitizedName = apiName.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
    return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.mulesoft</groupId>
    <artifactId>${sanitizedName}</artifactId>
    <version>1.0.0-SNAPSHOT</version>
    <packaging>mule-application</packaging>
    <name>${apiName}</name>

    <properties>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
        <project.reporting.outputEncoding>UTF-8</project.reporting.outputEncoding>
        <app.runtime>4.9.0</app.runtime>
        <mule.maven.plugin.version>4.0.0</mule.maven.plugin.version>
    </properties>

    <build>
        <plugins>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-clean-plugin</artifactId>
                <version>3.1.0</version>
            </plugin>
            <plugin>
                <groupId>org.mule.tools.maven</groupId>
                <artifactId>mule-maven-plugin</artifactId>
                <version>\${mule.maven.plugin.version}</version>
                <extensions>true</extensions>
            </plugin>
        </plugins>
    </build>

    <dependencies>
        <dependency>
            <groupId>org.mule.connectors</groupId>
            <artifactId>mule-http-connector</artifactId>
            <version>1.7.4</version>
            <classifier>mule-plugin</classifier>
        </dependency>
        <dependency>
            <groupId>org.mule.modules</groupId>
            <artifactId>mule-validation-module</artifactId>
            <version>2.0.0</version>
            <classifier>mule-plugin</classifier>
        </dependency>
        <dependency>
            <groupId>org.mule.modules</groupId>
            <artifactId>mule-apikit-module</artifactId>
            <version>2.2.0</version>
            <classifier>mule-plugin</classifier>
        </dependency>
    </dependencies>

</project>`;
  }

  /**
   * Get default mule-artifact.json content
   */
  getDefaultMuleArtifact(apiName) {
    return JSON.stringify({
      "minMuleVersion": "4.9.0",
      "requiredProduct": "MULE",
      "classifier": "mule-application",
      "groupId": "com.mulesoft",
      "assetId": apiName.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase(),
      "version": "1.0.0-SNAPSHOT",
      "name": apiName,
      "dependencies": []
    }, null, 2);
  }

  /**
   * Get default application.properties content
   */
  getDefaultApplicationProperties() {
    return `# HTTP Listener Configuration
http.port=\${http.port:8081}
http.host=\${http.host:0.0.0.0}

# API Configuration
api.baseUri=\${api.baseUri:http://localhost:8081/api}

# Logging
logging.level=\${logging.level:INFO}

# Environment-specific properties should be in:
# - application-dev.properties
# - application-qa.properties
# - application-prod.properties
`;
  }

  /**
   * Get default dev properties content
   */
  getDefaultDevProperties() {
    return `# Development Environment Properties
# HTTP Listener Configuration
http.port=8081
http.host=0.0.0.0
api.baseUri=http://localhost:8081/api

# Logging
logging.level=DEBUG

# Connector Connection Details (Dev Environment)
# TODO: Update the following properties with actual connection details for your dev environment

# Database Connection (if Database connector is used in global-config.xml)
# database.url=your_database_url
# database.driver=com.mysql.cj.jdbc.Driver
# database.username=your_database_username
# database.password=your_database_password

# Salesforce Connection (if Salesforce connector is used in global-config.xml)
# salesforce.url=your_salesforce_url
# salesforce.username=your_salesforce_username
# salesforce.password=your_salesforce_password
# salesforce.securityToken=your_salesforce_security_token

# External API Endpoints (if HTTP requester is used in global-config.xml)
# external.api.baseUrl=your_external_api_base_url
# external.api.timeout=30000
# external.api.clientId=your_client_id
# external.api.clientSecret=your_client_secret

# OAuth Configuration (if OAuth is used)
# oauth.tokenUrl=your_oauth_token_url
# oauth.clientId=your_oauth_client_id
# oauth.clientSecret=your_oauth_client_secret
`;
  }

  /**
   * Get default QA properties content
   */
  getDefaultQaProperties() {
    return `# QA Environment Properties
# HTTP Listener Configuration
http.port=8081
http.host=0.0.0.0
api.baseUri=http://qa-server:8081/api

# Logging
logging.level=INFO

# Connector Connection Details (QA Environment)
# TODO: Update the following properties with actual connection details for your QA environment

# Database Connection (if Database connector is used in global-config.xml)
# database.url=your_database_url
# database.driver=com.mysql.cj.jdbc.Driver
# database.username=your_database_username
# database.password=your_database_password

# Salesforce Connection (if Salesforce connector is used in global-config.xml)
# salesforce.url=your_salesforce_url
# salesforce.username=your_salesforce_username
# salesforce.password=your_salesforce_password
# salesforce.securityToken=your_salesforce_security_token

# External API Endpoints (if HTTP requester is used in global-config.xml)
# external.api.baseUrl=your_external_api_base_url
# external.api.timeout=30000
# external.api.clientId=your_client_id
# external.api.clientSecret=your_client_secret

# OAuth Configuration (if OAuth is used)
# oauth.tokenUrl=your_oauth_token_url
# oauth.clientId=your_oauth_client_id
# oauth.clientSecret=your_oauth_client_secret
`;
  }

  /**
   * Get default prod properties content
   */
  getDefaultProdProperties() {
    return `# Production Environment Properties
# HTTP Listener Configuration
http.port=8081
http.host=0.0.0.0
api.baseUri=https://api.production.com/api

# Logging
logging.level=WARN

# Connector Connection Details (Production Environment)
# TODO: Update the following properties with actual connection details for your production environment

# Database Connection (if Database connector is used in global-config.xml)
# database.url=your_database_url
# database.driver=com.mysql.cj.jdbc.Driver
# database.username=your_database_username
# database.password=your_database_password

# Salesforce Connection (if Salesforce connector is used in global-config.xml)
# salesforce.url=your_salesforce_url
# salesforce.username=your_salesforce_username
# salesforce.password=your_salesforce_password
# salesforce.securityToken=your_salesforce_security_token

# External API Endpoints (if HTTP requester is used in global-config.xml)
# external.api.baseUrl=your_external_api_base_url
# external.api.timeout=60000
# external.api.clientId=your_client_id
# external.api.clientSecret=your_client_secret

# OAuth Configuration (if OAuth is used)
# oauth.tokenUrl=your_oauth_token_url
# oauth.clientId=your_oauth_client_id
# oauth.clientSecret=your_oauth_client_secret
`;
  }

  /**
   * Get default log4j2.xml content
   */
  getDefaultLog4j2() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Configuration>
    <Appenders>
        <Console name="Console" target="SYSTEM_OUT">
            <PatternLayout pattern="%-5p %d [%t] %c: %m%n"/>
        </Console>
    </Appenders>
    <Loggers>
        <Logger level="INFO" name="org.mule.runtime"/>
        <Logger level="INFO" name="com.mulesoft"/>
        <Root level="INFO">
            <AppenderRef ref="Console"/>
        </Root>
    </Loggers>
</Configuration>`;
  }

  /**
   * Get default .muleignore content
   */
  getDefaultMuleIgnore() {
    return `.classpath
.project
.settings/
target/
*.iml
.idea/
*.log
.DS_Store
`;
  }

  /**
   * Get default .gitignore content
   */
  getDefaultGitIgnore() {
    return `# Maven
target/
pom.xml.tag
pom.xml.releaseBackup
pom.xml.versionsBackup
pom.xml.next
release.properties
dependency-reduced-pom.xml
buildNumber.properties
.mvn/timing.properties
.mvn/wrapper/maven-wrapper.jar

# IDE
.idea/
*.iml
*.iws
*.ipr
.classpath
.project
.settings/
.vscode/

# OS
.DS_Store
Thumbs.db

# Logs
*.log

# Mule
.mule/
`;
  }

  /**
   * Get default log4j2-test.xml content
   */
  getDefaultLog4j2Test() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Configuration>
    <Appenders>
        <Console name="Console" target="SYSTEM_OUT">
            <PatternLayout pattern="%-5p %d [%t] %c: %m%n"/>
        </Console>
    </Appenders>
    <Loggers>
        <Logger level="DEBUG" name="org.mule.runtime"/>
        <Logger level="DEBUG" name="com.mulesoft"/>
        <Root level="DEBUG">
            <AppenderRef ref="Console"/>
        </Root>
    </Loggers>
</Configuration>`;
  }
}

export default MuleCodeGenerationAgent;
