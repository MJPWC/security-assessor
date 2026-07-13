import MuleSoftArchitectureAgent from "./MuleSoftArchitectureAgent.js";
import DiagramGenerationAgent from "./DiagramGenerationAgent.js";
import EstimationAgent from "./EstimationAgent.js";
import RAMLGenerationAgent from "./RAMLGenerationAgent.js";
import DocumentationAgent from "./DocumentationAgent.js";
import MuleCodeGenerationAgent from "./MuleCodeGenerationAgent.js";
import { getAgentRegistry } from "../a2a/AgentRegistry.js";

/**
 * Agent Orchestrator
 * Coordinates multiple agents using A2A Protocol
 * Agents communicate via messages, not direct calls
 */
class AgentOrchestrator {
  constructor(config = null, socket = null) {
    this.socket = socket;
    // Initialize agents (they auto-register via A2A Protocol)
    this.architectureAgent = new MuleSoftArchitectureAgent(config, null, socket);
    this.diagramAgent = new DiagramGenerationAgent(config, null, socket);
    this.estimationAgent = new EstimationAgent(config, null, socket);
    this.ramlAgent = new RAMLGenerationAgent(config, null, socket);
    this.documentationAgent = new DocumentationAgent(config, null, socket);
    this.muleCodeAgent = new MuleCodeGenerationAgent(config, null, socket);

    //this.architectureAgent = new MuleSoftArchitectureAgent(config, null, this.socket);

    // A2A Protocol: All agents are now registered and can communicate
    this.registry = getAgentRegistry();
    console.log(`✅ A2A Protocol: ${this.registry.listAgents().length} agents registered`);
  }

  /**
   * Generate clarifying questions before generating approaches
   * @param {string} requirements - Business requirements
   * @param {object} options - Options
   * @param {function} onProgress - Progress callback
   * @returns {Promise<object>} Questions array
   */
  async generateClarifyingQuestions(requirements, options = {}, onProgress = null) {
    this.#emitProgress(onProgress, { type: "start", message: "Generating clarifying questions..." });
    this.#emitProgress(onProgress, { type: "step", step: 0, agent: "Architecture", status: "working", message: "Analyzing requirements and generating questions..." });

    console.log("❓ Generating clarifying questions...\n");

    const result = await this.architectureAgent.generateClarifyingQuestions(requirements, options);

    this.#emitProgress(onProgress, {
      type: "questions-generated",
      agent: "Architecture",
      status: "completed",
      message: `Generated ${result.questions.length} clarifying questions`,
      data: result
    });

    console.log(`✅ Generated ${result.questions.length} questions\n`);

    return result;
  }

  /**
   * Validate user answers to questions
   * @param {Array<object>} questions - Questions with answers
   * @param {function} onProgress - Progress callback
   * @returns {Promise<object>} Validation results
   */
  async validateQuestionAnswers(questions, onProgress = null) {
    const validationResults = [];
    let hadSystemLLMError = false;

    for (const qa of questions) {
      if (!qa.answer || !qa.answer.trim()) {
        validationResults.push({
          questionNumber: qa.number,
          valid: false,
          reason: "Answer is required"
        });
        continue;
      }

      console.log(`[Validation] Q${qa.number} → Calling validator for: ${qa.question}`);
      try {
        const validation = await this.architectureAgent.validateAnswer(qa.question, qa.answer);
        console.log(`[Validation] Q${qa.number} → result:`, {
          valid: validation.valid,
          strength: validation.strength || (validation.valid ? 'strong' : 'invalid'),
          reason: validation.reason
        });
        validationResults.push({
          questionNumber: qa.number,
          valid: validation.valid,
          reason: validation.reason,
          strength: validation.strength || (validation.valid ? 'strong' : 'invalid')
        });
      } catch (err) {
        // Distinguish LLM system errors (retryable) from genuine validation failures
        const status = err?.status || err?.response?.status;
        const message = err?.message || '';
        const isRetryableLLMError = status === 429 || (status >= 500 && status < 600) || message.includes('All LLM providers failed');

        console.error(`Validation error for Q${qa.number}:`, message || err);

        if (isRetryableLLMError) {
          hadSystemLLMError = true;
          // Keep placeholder to preserve ordering, but do not mark as user invalid
          validationResults.push({
            questionNumber: qa.number,
            valid: false,
            reason: 'LLM temporarily unavailable'
          });
        } else {
          // Non-retryable / user-level invalid
          validationResults.push({
            questionNumber: qa.number,
            valid: false,
            reason: message || 'Validation failed due to an unexpected error'
          });
        }
      }
    }

    // If any system-level LLM error occurred, escalate so UI shows an error instead of user invalidation popup
    if (hadSystemLLMError) {
      console.warn('[Validation] System-level LLM error encountered; aborting validation and notifying client');
      throw new Error('Validation temporarily unavailable due to LLM rate limiting or server error. Please retry.');
    }

    const allValid = validationResults.every(r => r.valid);
    console.log('[Validation] Aggregate results:', { allValid, results: validationResults });

    return {
      allValid,
      results: validationResults
    };
  }

   /**
   * Evaluate Round 1 answers and determine if Round 2 follow-up is needed.
   * Maximum 2 follow-up questions. If all answers are clear → returns needsFollowUp: false
   * so the caller can proceed directly to generateApproaches.
   *
   * @param {string} requirements - Original requirement
   * @param {Array} questionsAndAnswers - Round 1 Q&A pairs { question, answer }
   * @param {function} onProgress - Progress callback
   * @returns {Promise<object>} { needsFollowUp, followUpQuestions, reason }
   */
  async evaluateAndFollowUp(requirements, questionsAndAnswers, onProgress = null, options = {}) {
    this.#emitProgress(onProgress, {
      type: 'step',
      agent: 'Architecture',
      status: 'working',
      message: 'Evaluating your answers...'
    });

    const result = await this.architectureAgent.evaluateAnswers(
      requirements,
      questionsAndAnswers,
      options
    );

    if (result.needsFollowUp) {
      // Format follow-up questions in the same shape as Round 1 questions
      const followUpQuestions = result.followUpQuestions.map((q, i) => ({
        number: i + 1,
        question: q,
        answer: null,
        validated: false,
        isFollowUp: true   // flag so UI can show "A quick follow-up..." instead of full header
      }));

      this.#emitProgress(onProgress, {
        type: 'followup-questions',
        agent: 'Architecture',
        status: 'needs-input',
        message: `One quick follow-up before we generate your architecture`,
        data: {
          round: 2,
          reason: result.reason,
          questions: followUpQuestions
        }
      });

      console.log(`🔄 Round 2 triggered: ${followUpQuestions.length} follow-up question(s)`);
      return { needsFollowUp: true, questions: followUpQuestions, reason: result.reason };
    }

    // All clear — no Round 2 needed
    this.#emitProgress(onProgress, {
      type: 'answers-sufficient',
      agent: 'Architecture',
      status: 'completed',
      message: 'Great — enough context to generate your architecture approaches'
    });

    console.log('✅ Round 1 answers sufficient — proceeding directly to approaches');
    return { needsFollowUp: false, questions: [], reason: result.reason };
  }
  
  /**
   * Generate architecture approaches (3-4 options with recommendation)
   * @param {string} requirements - Business requirements
   * @param {object} options - Options (can include questionAnswers)
   * @param {function} onProgress - Progress callback
   * @returns {Promise<object>} Approaches with recommendation
   */
  async generateApproaches(requirements, options = {}, onProgress = null) {
    this.#emitProgress(onProgress, { type: "start", message: "Generating architecture approaches..." });
    this.#emitProgress(onProgress, { type: "step", step: 0, agent: "Architecture", status: "working", message: "Analyzing requirements and generating multiple approaches..." });

    console.log("📋 Generating architecture approaches...\n");

    const result = await this.architectureAgent.generateApproaches(requirements, options);

    this.#emitProgress(onProgress, {
      type: "approaches-generated",
      agent: "Architecture",
      status: "completed",
      message: `Generated ${result.approaches.length} architecture approaches`,
      data: result
    });

    console.log(`✅ Generated ${result.approaches.length} approaches\n`);

    return result;
  }

  /**
   * Complete workflow using A2A Protocol
   * Architecture Agent coordinates with other agents via A2A messages
   * Each agent has context from previous agents through A2A messages
   * 
   * A2A Protocol Flow:
   * 1. Architecture Agent generates architecture (or uses selected approach)
   * 2. Architecture Agent sends A2A message to Diagram Agent (with architecture context)
   * 3. Architecture Agent sends A2A message to Estimation Agent (with architecture + diagram context)
   * 4. Architecture Agent sends A2A message to RAML Agent (with architecture + diagram + estimation context)
   * 5. Architecture Agent sends A2A message to Documentation Agent (with full context including RAML)
   * 
   * @param {string} requirements - Business requirements
   * @param {object} options - Options for output (can include selectedApproach and approaches)
   * @param {function} onProgress - Progress callback function
   * @returns {Promise<object>} Complete solution package
   */
  async generateCompleteSolution(requirements, options = {}, onProgress = null) {
    const outputDir = options.outputDir || "./output";
    const apiName = options.apiName || "MuleSoftAPI";

    this.#emitProgress(onProgress, { type: "start", message: "Starting A2A Protocol workflow..." });
    this.#emitProgress(onProgress, { type: "info", message: "A2A Protocol: Architecture Agent will coordinate with other agents via messages" });

    console.log("🚀 Starting A2A Protocol workflow...");
    console.log("📋 Architecture Agent will coordinate with Diagram, Estimation, RAML, and Documentation agents via A2A messages\n");

    // A2A Protocol: Architecture Agent coordinates the workflow
    // It generates architecture first (using selected approach if provided), then requests help from other agents via A2A messages
    const solution = await this.architectureAgent.generateCompleteSolution(
      requirements,
      { ...options, apiName },
      onProgress
    );

    // Documentation is now handled via A2A Protocol in the Architecture Agent
    console.log('📡 Documentation completed via A2A Protocol:', !!solution.documentation);
    console.log('📡 Deferred documentation:', !!solution.deferredDocumentation);

    if (solution.documentation) {
      this.#emitProgress(onProgress, {
        type: 'step',
        agent: 'Documentation',
        status: 'completed',
        message: `Documentation generated via A2A (${solution.documentation.length} characters)`,
        data: solution.documentation
      });
    } else if (solution.deferredDocumentation) {
      console.log('📡 Documentation questions were emitted via A2A Protocol');
      // Questions were already emitted by the Architecture Agent
    }

    // Save all outputs if outputDir is specified
    if (options.saveFiles) {
      const fsExtra = (await import("fs-extra")).default;
      await fsExtra.ensureDir(outputDir);

      if (solution.architecture) {
        await fsExtra.writeFile(`${outputDir}/architecture.md`, solution.architecture, "utf-8");
      }
      if (solution.diagram) {
        await fsExtra.writeFile(`${outputDir}/diagram.mmd`, solution.diagram, "utf-8");
      }
      if (solution.estimation) {
        await fsExtra.writeFile(`${outputDir}/estimation.md`, solution.estimation, "utf-8");
      }
      if (solution.raml) {
        await fsExtra.writeFile(`${outputDir}/api.raml`, solution.raml, "utf-8");
      }
      if (solution.documentation) {
        await fsExtra.writeFile(`${outputDir}/documentation.md`, solution.documentation, "utf-8");
      }

      if (!solution.deferredDocumentation) {
        this.#emitProgress(onProgress, { type: "saved", message: `All files saved to ${outputDir}/` });
        console.log(`📁 All files saved to ${outputDir}/\n`);
      } else {
        console.log(`📁 Files saved to ${outputDir}/ (documentation pending)\n`);
      }
    }

    if (solution.blockedEstimation) {
      this.#emitProgress(onProgress, {
        type: "info",
        message: `Workflow paused before estimation: ${solution.diagramError || 'diagram generation failed'}`
      });
      console.log("⏸️ Workflow paused before estimation because diagram generation failed.\n");
    } else if (solution.deferredDocumentation) {
      this.#emitProgress(onProgress, { type: "info", message: "Awaiting documentation answers before final completion..." });
      console.log("⏸️ Deferred final completion: awaiting documentation answers.\n");
    } else {
      this.#emitProgress(onProgress, { type: "complete", message: "Complete solution generated via A2A protocol!", data: solution });
      console.log("✅ Complete solution generated via A2A protocol!\n");
    }

    return {
      ...solution,
      outputDir: options.saveFiles ? outputDir : null
    };
  }

  /**
   * Emit progress event
   * @private
   */
  #emitProgress(callback, event) {
    if (typeof callback === "function") {
      try {
        callback(event);
      } catch (error) {
        console.error("Progress callback error:", error);
      }
    }
  }

  /**
   * Generate solution from PDF
   * @param {string} pdfPath - Path to requirements PDF
   * @param {object} options - Options
   * @returns {Promise<object>} Complete solution
   */
  async generateFromPDF(pdfPath, options = {}) {
    console.log(`📄 Reading PDF: ${pdfPath}...\n`);

    // Extract text from PDF
    const pdfParse = (await import("pdf-parse")).default;
    const fsExtra = (await import("fs-extra")).default;
    const dataBuffer = await fsExtra.readFile(pdfPath);
    const pdfData = await pdfParse(dataBuffer);
    const requirements = pdfData.text;

    console.log(`✅ Extracted ${requirements.length} characters from PDF\n`);

    // Generate complete solution
    return await this.generateCompleteSolution(requirements, options);
  }

  /**
   * Set correlation ID on all child agents for end-to-end request tracking
   * @param {string} correlationID - Correlation ID from manager
   */
  setCorrelationID(correlationID) {
    this.architectureAgent.setCorrelationID(correlationID);
    this.diagramAgent.setCorrelationID(correlationID);
    this.estimationAgent.setCorrelationID(correlationID);
    this.ramlAgent.setCorrelationID(correlationID);
    this.documentationAgent.setCorrelationID(correlationID);
    this.muleCodeAgent.setCorrelationID(correlationID);
    
    console.log(`🔗 Orchestrator set correlation ID on 6 child agents: ${correlationID}`);
  }

}

export default AgentOrchestrator;
