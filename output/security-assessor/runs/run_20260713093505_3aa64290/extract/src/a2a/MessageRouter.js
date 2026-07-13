/**
 * Message Router (A2A Protocol Concept)
 * Routes messages between agents
 * Handles message delivery and routing
 */

import { getAgentRegistry } from "./AgentRegistry.js";
import { A2AMessage } from "./Message.js";

class MessageRouter {
  constructor() {
    this.registry = getAgentRegistry();
    this.messageQueue = [];
    this.pendingRequests = new Map(); // requestId -> {resolve, reject, timeout}
    this.messageHandlers = new Map(); // agentId -> handler function
  }

  /**
   * Register a message handler for an agent
   * @param {string} agentId - Agent identifier
   * @param {function} handler - Message handler function
   */
  registerHandler(agentId, handler) {
    this.messageHandlers.set(agentId, handler);
  }

  /**
   * Send a message to an agent (A2A protocol)
   * @param {A2AMessage} message - A2A message
   * @param {object} options - Options (timeout, awaitResponse)
   * @returns {Promise<A2AMessage|null>} Response message or null
   */
  async send(message, options = {}) {
    const { timeout = 420000, awaitResponse = true } = options;

    if (!message.validate()) {
      throw new Error("Invalid message format");
    }

    // Check if recipient agent exists
    const recipient = this.registry.discover(message.to);
    if (!recipient) {
      throw new Error(`Agent not found: ${message.to}`);
    }

    console.log(`📨 A2A Message: ${message.from} → ${message.to} (${message.type})`);

    // If awaiting response, set up promise
    if (awaitResponse && message.type === 'request') {
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          this.pendingRequests.delete(message.requestId);
          reject(new Error(`Message timeout: ${message.requestId}`));
        }, timeout);

        this.pendingRequests.set(message.requestId, {
          resolve: (response) => {
            clearTimeout(timeoutId);
            resolve(response);
          },
          reject: (error) => {
            clearTimeout(timeoutId);
            reject(error);
          }
        });

        // Deliver message
        this.deliver(message);
      });
    } else {
      // Fire and forget
      await this.deliver(message);
      return null;
    }
  }

  /**
   * Deliver message to recipient agent
   * @param {A2AMessage} message - Message to deliver
   * @private
   */
  async deliver(message) {
    const recipient = this.registry.discover(message.to);
    if (!recipient) {
      throw new Error(`Cannot deliver message: Agent ${message.to} not found`);
    }

    // Check if agent has handleMessage method (A2A protocol)
    if (typeof recipient.handleMessage === 'function') {
      try {
        const response = await recipient.handleMessage(message);
        
        // If it's a request and we got a response, resolve pending request
        if (message.type === 'request' && response) {
          const pending = this.pendingRequests.get(message.requestId);
          if (pending) {
            this.pendingRequests.delete(message.requestId);
            pending.resolve(response);
          }
        }
        
        return response;
      } catch (error) {
        // Handle error response
        if (message.type === 'request') {
          const pending = this.pendingRequests.get(message.requestId);
          if (pending) {
            this.pendingRequests.delete(message.requestId);
            pending.reject(error);
          }
        }
        throw error;
      }
    } else {
      throw new Error(`Agent ${message.to} does not implement handleMessage (A2A protocol required)`);
    }
  }

  /**
   * Broadcast message to multiple agents
   * @param {A2AMessage} message - Message to broadcast
   * @param {Array<string>} agentIds - List of agent IDs
   * @returns {Promise<Array>} Array of responses
   */
  async broadcast(message, agentIds) {
    const promises = agentIds.map(agentId => {
      const broadcastMessage = new A2AMessage({
        ...message,
        to: agentId,
        requestId: `${message.requestId}_${agentId}` // Unique request ID per recipient
      });
      return this.send(broadcastMessage, { awaitResponse: true });
    });

    return Promise.allSettled(promises);
  }

  /**
   * Get message statistics
   * @returns {object} Statistics
   */
  getStats() {
    return {
      pendingRequests: this.pendingRequests.size,
      registeredHandlers: this.messageHandlers.size,
      totalAgents: this.registry.listAgents().length
    };
  }
}

// Singleton instance
let routerInstance = null;

/**
 * Get the global message router instance
 * @returns {MessageRouter} Singleton router instance
 */
export function getMessageRouter() {
  if (!routerInstance) {
    routerInstance = new MessageRouter();
  }
  return routerInstance;
}

export default MessageRouter;
