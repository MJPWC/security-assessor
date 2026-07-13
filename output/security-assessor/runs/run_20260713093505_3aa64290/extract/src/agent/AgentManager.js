import BaseAgent from "./BaseAgent.js";
import GeneralQnAAgent from "./GeneralQnAAgent.js";
import AgentOrchestrator from "./AgentOrchestrator.js";
import { getAgentConfig, getAllAgentConfigs } from "../config/agentConfigs.js";
import CorrelationIDManager from "../llm/CorrelationIDManager.js";

/**
 * Manager Agent (formerly AgentManager)
 * Routes user input to the appropriate agent(s) based on content analysis
 * Uses agent configurations (conversation starters, descriptions) to improve routing
 * 
 * Extends BaseAgent to have direct LLM access for classification
 */
class ManagerAgent extends BaseAgent {
  constructor(config = null, agentConfig = null, socket = null) {
    super(config, 'manager-agent'); // A2A Protocol: Set agent ID
    this.socket = socket; // A2A Protocol: Set agent ID

    // Load manager agent configuration
    const defaultConfig = agentConfig || getAgentConfig("manager");

    // Set agent metadata
    this.name = defaultConfig?.name || "Manager Agent";
    this.description = defaultConfig?.description || "Intelligent router that classifies and routes requests";
    this.conversationStarters = defaultConfig?.conversationStarters || [];
    this.knowledge = defaultConfig?.knowledge || [];

    // Set system prompt for classification (instructions)
    // Will be set after getClassificationPrompt() is available
    this.classificationSystemPrompt = defaultConfig?.instructions;

    // Initialize managed agents (they auto-register via A2A Protocol)
    this.generalQnAAgent = new GeneralQnAAgent(config, null, this.socket); 
    //this.orchestrator = new AgentOrchestrator(config);

    // Load agent configurations for routing intelligence
    this.agentConfigs = getAllAgentConfigs();
    this.generalConfig = getAgentConfig("generalQnA");
    this.architectureConfig = getAgentConfig("architecture");
    this.orchestrator = new AgentOrchestrator(config, this.socket);

    // A2A Protocol: Register this agent
    this.register({
      name: this.name,
      description: this.description,
      capabilities: ['route-request', 'classify-input', 'coordinate-agents']
    });
  }

  /**
   * Get agent configuration/metadata
   * @returns {object} Agent configuration
   */
  getConfig() {
    return {
      name: this.name,
      description: this.description,
      instructions: this.classificationSystemPrompt,
      conversationStarters: this.conversationStarters,
      knowledge: this.knowledge
    };
  }

  /**
   * System prompt for classifying user input
   * Uses agent configurations to provide better context
   */
  getClassificationPrompt() {
    const generalStarters = this.generalConfig?.conversationStarters?.slice(0, 3).join(", ") || "";
    const archStarters = this.architectureConfig?.conversationStarters?.slice(0, 3).join(", ") || "";

    return `You are an intelligent router that classifies user input into one of two categories:

1. GENERAL_QUESTION: 
   - Greetings, casual conversation, or small talk (e.g., "Hello", "Hi", "How are you?")
   - Questions asking ABOUT solutions, concepts, or explanations (NOT requesting to create them)
   - Questions starting with: "can you", "are you able", "do you", "what is", "how does", "explain", "tell me about"
   - Examples of general questions:
     * "Hello", "Hi", "Hey", "Good morning"
     * "What is MuleSoft?"
     * "Can you give me a solution?" (asking if capable, not requesting creation)
     * "Are you able to provide solutions?" (asking about capability)
     * "Explain API-led connectivity"
     * "How does DataWeave work?"
     * "What are the best practices for error handling?"
     * "Tell me about MuleSoft connectors"
     * "Thanks", "Thank you"
   - Typical conversation starters: ${generalStarters}

2. ARCHITECTURE_REQUIREMENT: Direct requests/commands to CREATE, BUILD, DESIGN, or GENERATE architecture solutions
   - Must contain ACTION verbs: "create", "build", "design", "generate", "develop", "make", "need", "want"
   - Must specify WHAT to build (e.g., "integration between X and Y", "API for Z", "system to do X")
   - Examples of architecture requests:
     * "Create an integration between Salesforce and SAP"
     * "Build a customer onboarding API"
     * "Design architecture for order processing"
     * "I need to integrate payment gateway with CRM"
     * "Generate solution for data synchronization"
     * "I have a problem: I need to sync data between systems"
     * "Develop an API for user management"
   - Typical architecture requests: ${archStarters}

CRITICAL DISTINCTION:
- "Can you give me a solution?" = GENERAL_QUESTION (asking if capable)
- "I need a solution for X" = ARCHITECTURE_REQUIREMENT (requesting creation)
- "What is a solution?" = GENERAL_QUESTION (asking for explanation)
- "Create a solution for X" = ARCHITECTURE_REQUIREMENT (command to create)

Respond with ONLY one word: "GENERAL_QUESTION" or "ARCHITECTURE_REQUIREMENT"`;
  }

  /**
   * Classify user input to determine which agent to use
   * @param {string} input - User input
   * @param {Array} conversationHistory - Optional conversation history for context
   * @returns {Promise<string>} Classification result
   */
  async classifyInput(input, conversationHistory = []) {
    if (!input || !input.trim()) {
      throw new Error("Input is required");
    }

    const trimmedInput = input.trim().toLowerCase();

    // Greetings and casual conversation keywords (always general)
    const greetingKeywords = [
      "hello", "hi", "hey", "good morning", "good afternoon", "good evening",
      "how are you", "how's it going", "what's up", "thanks", "thank you",
      "bye", "goodbye", "see you", "nice to meet you"
    ];

    // Check for greetings first (always general)
    const isGreeting = greetingKeywords.some(keyword =>
      trimmedInput.startsWith(keyword) ||
      trimmedInput === keyword ||
      trimmedInput.includes(` ${keyword} `)
    );

    if (isGreeting) {
      return "GENERAL_QUESTION";
    }

    // Check if input matches any conversation starters from agent configs
    // This helps route based on agent capabilities
    const generalStarters = this.generalConfig?.conversationStarters || [];
    const archStarters = this.architectureConfig?.conversationStarters || [];

    // Check if input is similar to general conversation starters
    const matchesGeneralStarter = generalStarters.some(starter => {
      const starterLower = starter.toLowerCase();
      return trimmedInput.includes(starterLower.substring(0, 20)) || // Check first 20 chars
        starterLower.includes(trimmedInput.substring(0, 20)) ||
        this.calculateSimilarity(trimmedInput, starterLower) > 0.6;
    });

    // Check if input is similar to architecture conversation starters
    const matchesArchStarter = archStarters.some(starter => {
      const starterLower = starter.toLowerCase();
      return trimmedInput.includes(starterLower.substring(0, 20)) ||
        starterLower.includes(trimmedInput.substring(0, 20)) ||
        this.calculateSimilarity(trimmedInput, starterLower) > 0.6;
    });

    // If it matches architecture starter more closely, route there
    if (matchesArchStarter && !matchesGeneralStarter) {
      return "ARCHITECTURE_REQUIREMENT";
    }

    // If it matches general starter and not architecture, route to general
    if (matchesGeneralStarter && !matchesArchStarter) {
      return "GENERAL_QUESTION";
    }


    // Question patterns (asking about something, not requesting creation)
    const questionPatterns = [
      "can you", "are you able", "do you", "will you", "would you",
      "what is", "what are", "how does", "how do", "how can",
      "explain", "tell me", "describe", "define", "help me understand",
      "why", "when", "where", "who"
    ];

    // Action verbs that indicate a request to CREATE/BUILD (architecture requirement)
    const actionVerbs = [
      "create", "build", "design", "generate", "develop", "make",
      "i need", "i want", "i require", "i'm looking for"
    ];

    // Check if it's a question pattern (asking about capability or explanation)
    const isQuestionPattern = questionPatterns.some(pattern =>
      trimmedInput.startsWith(pattern) ||
      trimmedInput.includes(` ${pattern} `) ||
      trimmedInput.includes(` ${pattern}?`)
    );

    // Check if it contains action verbs (requesting creation)
    const hasActionVerb = actionVerbs.some(verb =>
      trimmedInput.includes(verb)
    );

    // If it's a question pattern asking about capability/explanation, it's general
    // UNLESS it also has action verbs (e.g., "Can you create...")
    if (isQuestionPattern && !hasActionVerb) {
      // Additional check: if it's asking "can you give me solution" without specifics, it's general
      if (trimmedInput.includes("solution") && !trimmedInput.includes("for ") && !trimmedInput.includes("between ")) {
        return "GENERAL_QUESTION";
      }
      // If it's a question pattern without action verbs, it's likely general
      if (!trimmedInput.includes("create") && !trimmedInput.includes("build") &&
        !trimmedInput.includes("design") && !trimmedInput.includes("generate")) {
        return "GENERAL_QUESTION";
      }
    }

    // If it has action verbs requesting creation, it's architecture requirement
    if (hasActionVerb) {
      return "ARCHITECTURE_REQUIREMENT";
    }

    // Check for specific architecture request patterns
    const architecturePatterns = [
      "integration between", "api for", "system to", "architecture for",
      "connector for", "flow for", "process for", "workflow for"
    ];

    const hasArchitecturePattern = architecturePatterns.some(pattern =>
      trimmedInput.includes(pattern)
    );

    if (hasArchitecturePattern) {
      return "ARCHITECTURE_REQUIREMENT";
    }

    // If it's a very short casual message without action verbs (likely general Q&A)
    if (trimmedInput.length < 50 && !hasActionVerb && !hasArchitecturePattern) {
      return "GENERAL_QUESTION";
    }

    // Use LLM to classify (more accurate, especially for edge cases)
    try {
      // Build context from conversation history if available
      let contextPrompt = "";
      if (conversationHistory && conversationHistory.length > 0) {
        const recentHistory = conversationHistory.slice(-3); // Last 3 exchanges
        contextPrompt = "\n\nConversation Context:\n";
        recentHistory.forEach(entry => {
          contextPrompt += `User: ${entry.prompt}\nAssistant: ${entry.answer}\n`;
        });
      }

      // Use Manager Agent's own askWithSystemPrompt() method for classification (direct LLM access)
      // Use classification system prompt from config, or fallback to getClassificationPrompt()
      const systemPrompt = this.classificationSystemPrompt || this.getClassificationPrompt();
      const classification = await this.askWithSystemPrompt(
        systemPrompt,
        `${contextPrompt}\n\nCurrent User Input: "${input}"\n\nClassification:`,
        { temperature: 0.1, maxTokens: 10 }
      );

      const result = classification.trim().toUpperCase();
      if (result.includes("GENERAL_QUESTION")) {
        return "GENERAL_QUESTION";
      } else if (result.includes("ARCHITECTURE_REQUIREMENT")) {
        return "ARCHITECTURE_REQUIREMENT";
      }
    } catch (error) {
      console.warn("Classification failed, defaulting to architecture requirement:", error);
    }

    // Default to architecture requirement if uncertain
    return "ARCHITECTURE_REQUIREMENT";
  }

  /**
   * Calculate simple similarity between two strings (0-1)
   * Used to match user input with conversation starters
   * @param {string} str1 - First string
   * @param {string} str2 - Second string
   * @returns {number} Similarity score (0-1)
   */
  calculateSimilarity(str1, str2) {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;

    if (longer.length === 0) return 1.0;

    // Simple word overlap similarity
    const words1 = longer.toLowerCase().split(/\s+/);
    const words2 = shorter.toLowerCase().split(/\s+/);

    const commonWords = words1.filter(word => words2.includes(word));
    return commonWords.length / Math.max(words1.length, words2.length);
  }

  /**
   * Process user input and route to appropriate agent(s)
   * @param {string} input - User input
   * @param {object} options - Options for generation (can include conversationHistory)
   * @param {function} onProgress - Progress callback
   * @returns {Promise<object>} Result from the appropriate agent
   */
  async processInput(input, options = {}, onProgress = null) {
    if (!input || !input.trim()) {
      throw new Error("Input is required");
    }

    // Generate unique correlation ID for this request (entry point)
    const correlationID = CorrelationIDManager.generateCorrelationID('manager');
    console.log(`📌 Generated Correlation ID: ${correlationID}`);
    this.setCorrelationID(correlationID);

    const conversationHistory = options.conversationHistory || [];

    // Emit start event
    if (onProgress) {
      onProgress({
        type: "start",
        message: "Analyzing input...",
        agent: "Manager",
        correlationID: correlationID
      });
    }

    // Classify the input (pass conversation history for context)
    const classification = await this.classifyInput(input, conversationHistory);

    if (onProgress) {
      onProgress({
        type: "classified",
        classification,
        message: classification === "GENERAL_QUESTION"
          ? "Detected: General Question → Routing to Q&A Agent"
          : "Detected: Architecture Requirement → Routing to Architecture Workflow",
        agent: "Manager"
      });
    }

    // Route based on classification
    if (classification === "GENERAL_QUESTION") {
      // Route to General Q&A Agent (conversational)
      if (onProgress) {
        onProgress({
          type: "step",
          step: 1,
          agent: "General",
          status: "working",
          message: "Chatting..."
        });
      }

      // Set correlation ID for child agent
      this.generalQnAAgent.setCorrelationID(correlationID);
      console.log(`🔗 Agent GeneralQnA using correlation ID: ${correlationID}`);

      const answer = await this.generalQnAAgent.answer(input, {
        temperature: options.temperature || 0.7,
        maxTokens: options.maxTokens || 800,
        conversationHistory: conversationHistory // Pass conversation history for context
      });

      // Get updated conversation history from the agent
      const updatedHistory = this.generalQnAAgent.getHistory();

      if (onProgress) {
        onProgress({
          type: "step",
          step: 1,
          agent: "General",
          status: "completed",
          message: "Answer ready",
          data: answer
        });
        onProgress({
          type: "complete",
          agent: "General",
          message: "Q&A complete",
          data: { general: answer, conversationHistory: updatedHistory }
        });
      }

      return {
        type: "general",
        answer,
        conversationHistory: updatedHistory // Return updated history for session storage
      };
    } else {
      // Route to Architecture Workflow
      // Check workflow state: Questions → Approaches → Solution

      // Set correlation ID on orchestrator (manages all architecture agents)
      this.orchestrator.setCorrelationID(correlationID);
      console.log(`🔗 Agent Orchestrator using correlation ID: ${correlationID}`);

      const useFastArchitecturePath =
        !options.questionAnswers &&
        !options.selectedApproach &&
        !options.skipQuestions &&
        !options.skipApproachGeneration &&
        this.shouldUseFastArchitecturePath(input, options);

      if (useFastArchitecturePath) {
        if (onProgress) {
          onProgress({
            type: "info",
            agent: "Architecture",
            message: "Fast path: requirement is sufficiently detailed, skipping clarification and approach selection."
          });
        }

        const solution = await this.orchestrator.generateCompleteSolution(
          input,
          {
            ...options,
            fastMode: true,
            selectedApproach: 1,
            approaches: [this.buildFastArchitectureApproach(input, options)]
          },
          onProgress
        );
        return { type: "architecture", ...solution };
      }

      // Step 1: Generate clarifying questions (if not answered yet)
      if (!options.questionAnswers && !options.skipQuestions) {
        if (onProgress) {
          onProgress({
            type: "step",
            step: 0,
            agent: "Architecture",
            status: "working",
            message: "Generating clarifying questions..."
          });
        }

        const questionsResult = await this.orchestrator.generateClarifyingQuestions(
          input,
          options,
          onProgress
        );

        // Return questions for user to answer
        return {
          type: "questions",
          questions: questionsResult.questions,
          fullResponse: questionsResult.fullResponse,
          requirements: input
        };
      }

      // Step 2: Generate approaches (if questions answered but approach not selected)
      if (!options.selectedApproach && !options.skipApproachGeneration) {
        // Generate approaches first (with question answers if available)
        if (onProgress) {
          onProgress({
            type: "step",
            step: 0,
            agent: "Architecture",
            status: "working",
            message: "Generating architecture approaches..."
          });
        }

        const approachesResult = await this.orchestrator.generateApproaches(
          input,
          options, // Includes questionAnswers
          onProgress
        );

        // Return approaches for user selection
        return {
          type: "approaches",
          approaches: approachesResult.approaches,
          fullResponse: approachesResult.fullResponse,
          requirements: input
        };
      } else {
        // Step 3: Continue with selected approach
        const solution = await this.orchestrator.generateCompleteSolution(
          input,
          options,
          onProgress
        );
        return { type: "architecture", ...solution };
      }
    }
  }

  shouldUseFastArchitecturePath(input, options = {}) {
    if (process.env.FAST_ARCHITECTURE_PATH === 'false' || options.fastMode === false) {
      return false;
    }

    const rawInput = String(input || '');
    const maxFastPathChars = Number.parseInt(process.env.FAST_ARCHITECTURE_MAX_CHARS || '', 10);
    const fastPathCharacterLimit = Number.isFinite(maxFastPathChars) && maxFastPathChars > 0
      ? maxFastPathChars
      : 1800;

    // Large/heavy requirements should keep the full guided workflow. The fast
    // path is meant for small, self-contained prompts that already include the
    // key architecture decisions.
    if (rawInput.length > fastPathCharacterLimit) {
      return false;
    }

    const text = rawInput.toLowerCase();
    const hasSourceTarget =
      /(salesforce|sap|workday|servicenow|database|sftp|file|api|system).*(to|->|sync|between).*(salesforce|sap|workday|servicenow|database|sftp|file|api|system)/i.test(rawInput) ||
      /(salesforce|sap|workday|servicenow|database|sftp|file|api|system)/i.test(rawInput) &&
      /(salesforce|sap|workday|servicenow|database|sftp|file|api|system)/i.test(rawInput.replace(/salesforce|sap|workday|servicenow|database|sftp|file|api|system/i, ''));

    const signals = [
      hasSourceTarget,
      /\b(one-way|two-way|bi-directional|unidirectional|source of truth|sync)\b/.test(text),
      /\b(real-time|near real-time|minutes?|hours?|sla|daily|hourly|batch|cdc|polling)\b/.test(text),
      /\b(fields?|name|address|phone|email|id|tax|payload|object|record)\b/.test(text),
      /\b(volume|events?\/day|per day|per hour|peak|throughput|records?)\b/.test(text),
      /\b(error|retry|dlq|monitoring|logging|api manager|security)\b/.test(text)
    ];

    const score = signals.filter(Boolean).length;
    return score >= 5;
  }

  buildFastArchitectureApproach(input, options = {}) {
    const apiName = options.apiName || 'MuleSoftAPI';
    return {
      number: 1,
      name: '[FAST] Recommended MuleSoft architecture',
      description: 'Use the directly stated requirement details to produce a concise MuleSoft architecture without a separate clarification and approach-selection phase.',
      fullText: `Title: [FAST] Recommended MuleSoft architecture for ${apiName}
Description: Build the simplest fit-for-purpose MuleSoft architecture using the source, target, timing, fields, volume, error handling, retry, and monitoring details already supplied by the user. Prefer certified connectors, API-led ownership boundaries, reusable System APIs/system-access services, and Anypoint MQ only where asynchronous buffering or retry/DLQ handling is useful.

Requirement snapshot:
${input}`,
      isFastGenerated: true
    };
  }
}

// Export as both ManagerAgent and AgentManager for backward compatibility
export default ManagerAgent;
export { ManagerAgent };
export { ManagerAgent as AgentManager }; // Backward compatibility alias
