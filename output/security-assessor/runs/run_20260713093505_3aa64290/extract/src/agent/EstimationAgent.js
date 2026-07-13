import BaseAgent from "./BaseAgent.js";
import pdfParse from "pdf-parse";
import fsExtra from "fs-extra";
import { getAgentConfig } from "../config/agentConfigs.js";
import { A2AMessage } from "../a2a/Message.js";

function tokenBudget(envName, fallback) {
  const value = Number.parseInt(process.env[envName] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/*3. Resource requirements (developers, architects, testers)
4. Timeline estimates

- Testing and deployment effort
*/

/**
 * Estimation Generation Agent
 * Generates project estimations based on architecture solution PDF
 */
class EstimationAgent extends BaseAgent {
  constructor(config = null, agentConfig = null) {
    super(config, 'estimation-agent'); // A2A Protocol: Set agent ID

    // Use provided agentConfig or load from config file
    const defaultConfig = agentConfig || getAgentConfig("estimation");

    // Set agent metadata
    this.name = defaultConfig?.name || "Project Estimation Agent";
    this.description = defaultConfig?.description || "Generates detailed project estimations";
    this.conversationStarters = defaultConfig?.conversationStarters || [];
    this.knowledge = defaultConfig?.knowledge || [];

    // Set system prompt (instructions)
    this.systemPrompt = defaultConfig?.instructions || `You are an expert MuleSoft project estimator with knowledge of:
- MuleSoft development effort estimation with unit testing
- API development complexity (Simple, Medium, Complex)
- Integration pattern complexity
- Data transformation effort
- Error handling requirements and complexity
- Security configuration
- Standard MuleSoft project phases

Provide detailed estimations that include:
1. Effort breakdown by component/API
2. Development phases (Design, Development, Testing, Deployment)
3. Complexity assessment
4. Risk factors
5. Assumptions

Use standard MuleSoft estimation practices and provide realistic timelines.`;

    // Add t-shirt size guideline to systemPrompt after the existing categories
    this.systemPrompt += `

Complexity Assessment Guidelines:
- Simple: 1-2 integrations, basic transformations, standard security
  - Example: Single API with basic CRUD operations
  - T-shirt size: S (1-3 days)
  
- Medium: 3-5 integrations, moderate transformations, custom security
  - Example: API with multiple integrations and business logic
  - T-shirt size: M (3-7 days)
  
- Complex: 5+ integrations, complex transformations, advanced security
  - Example: End-to-end business process with multiple systems
  - T-shirt size: L (1-2 weeks)
  
- Enterprise: Multiple complex integrations, custom components
  - Example: Multi-region deployment with HA/DR
  - T-shirt size: XL (2+ weeks)`;

    // Add Risk Assessment to systemPrompt
    this.systemPrompt += `

Risk Assessment:
For each risk, specify:
- Impact: Low/Medium/High
- Probability: Low/Medium/High
- Mitigation: Brief mitigation strategy

Example Risks:
1. Integration Complexity (High Impact, Medium Probability)
   - Mitigation: Conduct detailed interface analysis
2. Security Requirements (High Impact, High Probability)
   - Mitigation: Early security review and testing
3. Third-party Dependencies (Medium Impact, Medium Probability)
   - Mitigation: Identify early and establish SLAs`;

    // Add confidence level and factore to systemPrompt
    this.systemPrompt += `

Confidence Levels:
- High: Requirements are clear, similar past projects exist
- Medium: Some ambiguity, but overall approach is clear
- Low: Significant unknowns or complex dependencies

Factors affecting confidence:
- Requirements clarity
- Team experience with similar projects
- Integration complexity
- Availability of test environments
- Third-party dependencies`;


    //  Add Additional Guidelines to systemPrompt
    this.systemPrompt += `

Additional Guidelines:
1. Buffer Time:
   - Add 10% buffer for tasks > 20 hours
   - Add 20% buffer for high-complexity integrations

2. Dependencies:
   - Clearly identify task dependencies
   - Highlight critical path items

3. Resource Allocation:
   - Account for team availability
   - Consider parallel workstreams

4. Review Cycles:
   - Include time for code reviews
   - Plan for UAT feedback cycles

5. Documentation:
   - API documentation time is not included.
   - Knowledge transfer time is not included.`;

    // A2A Protocol: Register this agent
    this.register({
      name: this.name,
      description: this.description,
      capabilities: ['generate-estimation', 'estimate-project', 'estimate-effort']
    });
  }

  getTokenCategory() {
    return 'Estimation';
  }

  /**
   * A2A Protocol: Handle incoming messages from other agents
   * @param {A2AMessage} message - Incoming A2A message
   * @returns {Promise<A2AMessage>} Response message
   */
  async handleMessage(message) {
    console.log(`📨 Estimation Agent received message from ${message.from}: ${message.payload.type}`);

    try {
      let result;

      switch (message.payload.type) {
        case 'generate-estimation':
        case 'estimate-project':
          // Get architecture from payload or context (A2A protocol: context from other agents)
          const architecture = message.payload.architecture || message.context.architecture;
          if (!architecture) {
            throw new Error("Architecture solution is required. Please provide architecture in message payload or context.");
          }

          // Use context from other agents (diagram, requirements, etc.)
          result = await this.generateEstimation(
            architecture,
            message.context // Full context includes architecture, diagram, requirements
          );
          break;

        default:
          throw new Error(`Unknown message type: ${message.payload.type}`);
      }

      // Send response with result and updated context
      return A2AMessage.createResponse(
        this.agentId,
        message.from,
        { estimation: result, result },
        message.requestId,
        { ...message.context, estimation: result } // Include estimation in context for next agents
      );
    } catch (error) {
      console.error(`❌ Estimation Agent error:`, error);
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
   * Extract text from PDF file
   * @param {string} pdfPath - Path to PDF file
   * @returns {Promise<string>} Extracted text
   */
  async extractTextFromPDF(pdfPath) {
    try {
      const dataBuffer = await fsExtra.readFile(pdfPath);
      const data = await pdfParse(dataBuffer);
      return data.text;
    } catch (error) {
      throw new Error(`Failed to read PDF: ${error.message}`);
    }
  }

  /**
   * Generate estimation from architecture solution text
   * @param {string} architectureSolution - Architecture solution text (REQUIRED from Architecture Agent)
   * @param {object} context - Additional context from previous agents (diagram, requirements, etc.)
   * @returns {Promise<string>} Estimation document
   */
  async generateEstimation(architectureSolution, context = {}) {
    if (!architectureSolution) {
      throw new Error("Architecture solution is required. Please generate architecture first using MuleSoftArchitectureAgent.");
    }

    let contextInfo = "";
    if (context.diagram) {
      const diagramText = String(context.diagram);
      const diagramSummary = diagramText.length > 1000
        ? `Diagram content is available but omitted from the estimation prompt (${diagramText.length} characters). Use the architecture and extracted use cases as the estimation source of truth.`
        : diagramText;
      contextInfo += `\nArchitecture Diagram Reference:\n${diagramSummary}\n`;
    }
    if (context.requirements) {
      contextInfo += `\nOriginal Requirements:\n${context.requirements}\n`;
    }
    if (context.journeyPoints && Array.isArray(context.journeyPoints) && context.journeyPoints.length > 0) {
      contextInfo += `\nUser Journey Points for Estimation:\n${context.journeyPoints.map((point, index) => `${index + 1}. ${point}`).join('\n')}\n`;
    }
    if (context.useCases && Array.isArray(context.useCases) && context.useCases.length > 0) {
      contextInfo += `\nExtracted Diagram Use Cases:\n${context.useCases.map((useCase, index) => {
        const sequenceStatus = useCase.sequenceDiagram ? 'sequence diagram generated' : 'sequence diagram not generated';
        return `${index + 1}. ${useCase.name || `Use Case ${index + 1}`}: ${useCase.description || 'No description provided'} (${sequenceStatus})`;
      }).join('\n')}\n`;
    }
    if (context.diagramData) {
      const availableDiagrams = Object.entries(context.diagramData)
        .filter(([, value]) => Boolean(value))
        .map(([key]) => key)
        .join(', ');
      if (availableDiagrams) {
        contextInfo += `\nGenerated Diagram Artifacts Available: ${availableDiagrams}\n`;
      }
    }

    const prompt = `Based on the MuleSoft architecture solution and any additional context provided, generate a detailed project estimation. Present the estimation in a simple, human-readable list format. Do NOT use JSON or any other structured data format.
    
    INPUTS:
    - contextInfo:
      ${contextInfo}
    
    - architectureSolution:
      ${architectureSolution}
    
    Provide ONLY the following sections in your list:
    - **Project Breakdown**: List all development tasks, categorized by API layer (Experience, Process, System) if applicable. For each task, include:
      - Task Name
      - Owner (Architect, Developer, QA, DevOps, Security)
      - Key Dependencies
      - T-shirt Size (S, M, L, XL)
      - Complexity (Low, Medium, High)
      - Confidence (High, Medium, Low)
      - Justification for the estimate
    - **Assumptions**: List all assumptions made during the estimation process.
    - **Risk Assessment**: For each key risk, describe the risk, its impact (Low, Medium, High), probability (Low, Medium, High), and mitigation strategy.
    - **Estimation Notes**: Any additional notes or considerations for the estimation.

    CRITICAL: Do NOT include any summary sections like Effort Estimation, Timeline, Resource Requirements, or any other aggregate summaries. Only provide the four sections listed above.

    Use realistic MuleSoft development timeframes. Be detailed and justify all estimates. Do NOT include any JSON syntax or formatting, just plain text in a list. Include unit and integration testing as Developer tasks; exclude formal QA/UAT, CI/CD, KT, and documentation.
    If Extracted Diagram Use Cases or User Journey Points are provided, every listed item must be represented in the Project Breakdown. Do not merge away or skip later use cases; create separate tasks when effort, system ownership, connector work, transformation, or error handling differs.
    Do not invent real or sample credentials. If a task needs a credential, API key, token, password, or client secret, write it only as a placeholder such as \${secure::system.password}, your_client_secret, or <CLIENT_SECRET>.
    
    
    ${context.journeyPoints && Array.isArray(context.journeyPoints) && context.journeyPoints.length > 0 
      ? `IMPORTANT: The user has provided specific journey points that should be considered in the estimation. Make sure to incorporate these journey points into your estimation, breaking down tasks and effort based on the journey points provided. Each journey point should be reflected in the project breakdown and estimation.`
      : ''}
    `;

    //- **Summary**: Total estimated hours, total estimated days, team composition (number of architects, developers, testers, devops), and overall timeline in weeks. Include a justification for the summary.
    /*- Estimated Hours
    - Do not include UAT/QA in the estimation.
      - Do not include CI/CD pipeline in the estimation.
      - Do not include KT sessions in the estimation.
      - Do not include documentation creation in the estimation.*/

    // ESTIMATION_MAX_TOKENS is configurable for teams that prefer longer or
    // shorter estimates. The default is lower than the old 32000-token budget
    // but high enough for detailed breakdowns.
    // maxTokens: 10000 keeps estimation responsive. If a provider reaches this
    // cap, BaseAgent's continuation loop stitches the remaining content.
    // ESTIMATION_TIMEOUT_MS keeps the provider from hanging indefinitely.
    const response = await this.askWithSystemPrompt(
      this.systemPrompt,
      prompt,
      {
        temperature: 0.5,
        maxTokens: tokenBudget('ESTIMATION_MAX_TOKENS', 10000),
        timeoutMs: tokenBudget('ESTIMATION_TIMEOUT_MS', 420000),
        onChunk: context.onChunk,
        onStreamReset: context.onStreamReset,
        signal: context.signal
      }
    );

    return response; // Return the raw string response
  }

  /**
   * Generate estimation from PDF file
   * @param {string} pdfPath - Path to architecture solution PDF
   * @returns {Promise<string>} Estimation document
   */
  async generateEstimationFromPDF(pdfPath) {
    console.log(`Reading PDF: ${pdfPath}`);
    const pdfText = await this.extractTextFromPDF(pdfPath);

    console.log(`Extracted ${pdfText.length} characters from PDF`);

    return await this.generateEstimation(pdfText);
  }

  /**
   * Generate estimation from architecture solution text
   * @param {string} architectureSolution - Architecture solution
   * @param {object} options - Additional options
   * @returns {Promise<string>} Estimation
   */
  async generateEstimationFromText(architectureSolution, options = {}) {
    return await this.generateEstimation(architectureSolution);
  }

  /**
   * Save estimation to file
   * @param {string} estimation - Estimation text
   * @param {string} outputPath - Output file path
   * @returns {Promise<void>}
   */
  async saveEstimation(estimation, outputPath) {
    // Ensure that estimation is a string before writing to file
    await fsExtra.writeFile(outputPath, estimation, "utf-8");
  }

  /**
   * Validate estimation structure
   * @param {object} estimation - Estimation object to validate
   * @throws {Error} If validation fails
   * @returns {boolean} True if validation passes
   */
  async validateEstimation(estimation) {
    // This function is no longer relevant as the estimation is not JSON
    return true;
  }
}

export default EstimationAgent;
