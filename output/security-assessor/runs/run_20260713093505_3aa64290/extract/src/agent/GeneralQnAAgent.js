import BaseAgent from "./BaseAgent.js";
import { getAgentConfig } from "../config/agentConfigs.js";
import { A2AMessage } from "../a2a/Message.js";

/**
 * General QnA Agent
 * Answers general questions without running the full architecture workflow
 */
class GeneralQnAAgent extends BaseAgent {
  constructor(config = null, agentConfig = null) {
    super(config, 'general-qna-agent'); // A2A Protocol: Set agent ID
    
    // Use provided agentConfig or load from config file
    const defaultConfig = agentConfig || getAgentConfig("generalQnA");
    
    // Set agent metadata
    this.name = defaultConfig?.name || "General Q&A Assistant";
    this.description = defaultConfig?.description || "A friendly conversational assistant";
    this.conversationStarters = defaultConfig?.conversationStarters || [];
    this.knowledge = defaultConfig?.knowledge || [];
    
    // Set system prompt (instructions)
    this.systemPrompt = defaultConfig?.instructions || `You are a friendly, conversational AI assistant specializing in MuleSoft and integration technologies. 

You engage in natural, friendly conversations. When users greet you (like "Hello", "Hi"), respond warmly and ask how you can help them. 

You can:
- Answer questions about MuleSoft, APIs, integration patterns, and related technologies
- Explain concepts clearly and provide examples when helpful
- Have casual conversations and be personable
- Ask clarifying questions if something is unclear

Keep your responses conversational, helpful, and concise. If the user asks about architecture solutions or integration requirements, you'll let the system route those to the specialized agents.`;

    // A2A Protocol: Register this agent
    this.register({
      name: this.name,
      description: this.description,
      capabilities: ['answer-question', 'general-qa', 'conversation']
    });
  }

  getTokenCategory() {
    return 'General';
  }

  /**
   * A2A Protocol: Handle incoming messages from other agents
   * @param {A2AMessage} message - Incoming A2A message
   * @returns {Promise<A2AMessage>} Response message
   */
  async handleMessage(message) {
    console.log(`📨 General Q&A Agent received message from ${message.from}: ${message.payload.type}`);
    
    try {
      let result;
      
      switch (message.payload.type) {
        case 'answer-question':
        case 'general-qa':
          const question = message.payload.question || message.payload.text || '';
          if (!question) {
            throw new Error("Question is required");
          }
          
          result = await this.answer(question, {
            conversationHistory: message.context.conversationHistory || [],
            ...message.payload.options
          });
          break;
          
        default:
          throw new Error(`Unknown message type: ${message.payload.type}`);
      }
      
      // Send response with result
      return A2AMessage.createResponse(
        this.agentId,
        message.from,
        { answer: result, result },
        message.requestId,
        { ...message.context, answer: result }
      );
    } catch (error) {
      console.error(`❌ General Q&A Agent error:`, error);
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
   * Answer a general question (conversational)
   * @param {string} question - User question or message
   * @param {object} options - Options (model, temperature, maxTokens, conversationHistory)
   * @returns {Promise<string>} Answer
   */
  async answer(question, options = {}) {
    if (!question || question.trim().length === 0) {
      throw new Error("Question is required");
    }

    // If conversation history is provided, use it instead of the agent's own history
    const messages = [{ role: "system", content: this.systemPrompt }];
    
    if (options.conversationHistory && Array.isArray(options.conversationHistory)) {
      // Use provided conversation history
      options.conversationHistory.forEach(entry => {
        messages.push({ role: "user", content: entry.prompt });
        messages.push({ role: "assistant", content: entry.answer });
      });
    } else {
      // Use agent's own conversation history (from BaseAgent)
      this.conversationHistory.forEach(entry => {
        messages.push({ role: "user", content: entry.prompt });
        messages.push({ role: "assistant", content: entry.answer });
      });
    }
    
    messages.push({ role: "user", content: question.trim() });

    const params = {
      model: options.model || this.defaultModel,
      messages,
      temperature: options.temperature ?? this.config.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? this.config.maxTokens ?? 800
    };

    const response = await this.requestWithRetry(params);
    const answer = response.choices[0].message.content;
    
    // Add to history (both agent's history and return for session storage)
    this.addToHistory(question.trim(), answer);
    
    return answer;
  }
}

export default GeneralQnAAgent;
