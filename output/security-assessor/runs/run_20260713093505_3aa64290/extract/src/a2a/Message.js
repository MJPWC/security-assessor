/**
 * A2A Message Format (A2A Protocol Standard)
 * Standardized message format for agent-to-agent communication
 */

export class A2AMessage {
  /**
   * Create an A2A message
   * @param {object} params - Message parameters
   * @param {string} params.from - Sender agent ID
   * @param {string} params.to - Recipient agent ID
   * @param {string} params.type - Message type (request, response, notification, error)
   * @param {object} params.payload - Message payload/data
   * @param {object} params.context - Additional context (from previous agents)
   * @param {string} params.requestId - Optional request ID for tracking
   * @param {number} params.timestamp - Message timestamp
   */
  constructor({
    from,
    to,
    type = 'request',
    payload = {},
    context = {},
    requestId = null,
    timestamp = Date.now()
  }) {
    this.from = from;
    this.to = to;
    this.type = type; // 'request' | 'response' | 'notification' | 'error'
    this.payload = payload;
    this.context = context; // Context from other agents
    this.requestId = requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.timestamp = timestamp;
  }

  /**
   * Create a request message
   * @param {string} from - Sender agent ID
   * @param {string} to - Recipient agent ID
   * @param {object} payload - Request payload
   * @param {object} context - Context from other agents
   * @returns {A2AMessage} Request message
   */
  static createRequest(from, to, payload, context = {}) {
    return new A2AMessage({
      from,
      to,
      type: 'request',
      payload,
      context
    });
  }

  /**
   * Create a response message
   * @param {string} from - Responder agent ID
   * @param {string} to - Original requester agent ID
   * @param {object} payload - Response payload
   * @param {string} requestId - Original request ID
   * @param {object} context - Additional context
   * @returns {A2AMessage} Response message
   */
  static createResponse(from, to, payload, requestId, context = {}) {
    return new A2AMessage({
      from,
      to,
      type: 'response',
      payload,
      requestId,
      context
    });
  }

  /**
   * Create an error message
   * @param {string} from - Sender agent ID
   * @param {string} to - Recipient agent ID
   * @param {string} error - Error message
   * @param {string} requestId - Original request ID (if applicable)
   * @returns {A2AMessage} Error message
   */
  static createError(from, to, error, requestId = null) {
    return new A2AMessage({
      from,
      to,
      type: 'error',
      payload: { error },
      requestId
    });
  }

  /**
   * Create a notification message
   * @param {string} from - Sender agent ID
   * @param {string} to - Recipient agent ID
   * @param {object} payload - Notification payload
   * @returns {A2AMessage} Notification message
   */
  static createNotification(from, to, payload) {
    return new A2AMessage({
      from,
      to,
      type: 'notification',
      payload
    });
  }

  /**
   * Validate message format
   * @returns {boolean} True if valid
   */
  validate() {
    if (!this.from || !this.to) {
      return false;
    }
    if (!['request', 'response', 'notification', 'error'].includes(this.type)) {
      return false;
    }
    return true;
  }

  /**
   * Convert message to JSON
   * @returns {string} JSON string
   */
  toJSON() {
    return JSON.stringify({
      from: this.from,
      to: this.to,
      type: this.type,
      payload: this.payload,
      context: this.context,
      requestId: this.requestId,
      timestamp: this.timestamp
    });
  }

  /**
   * Create message from JSON
   * @param {string} json - JSON string
   * @returns {A2AMessage} Message instance
   */
  static fromJSON(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    return new A2AMessage(data);
  }
}

export default A2AMessage;

