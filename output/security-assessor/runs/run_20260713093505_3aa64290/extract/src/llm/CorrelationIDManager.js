/**
 * Manages unique Correlation IDs for tracking requests across all agent flows
 * Format: YYYY-MM-DD-HHmm-agenttype-uuid
 * Example: 2026-06-01-1200-arch-a1b2c3d4
 */
class CorrelationIDManager {
  /**
   * Generate a unique correlation ID
   * @param {string} agentType - Type of agent (general, architecture, diagram, estimation, raml, documentation)
   * @returns {string} Correlation ID
   */
  static generateCorrelationID(agentType = 'general') {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const date = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    
    // Shorten agent type to 4 chars
    const shortAgentType = this.shortenAgentType(agentType);
    
    // Generate short unique ID using timestamp and random
    const shortID = this.generateShortID();
    
    return `${year}-${month}-${date}-${hours}${minutes}-${shortAgentType}-${shortID}`;
  }

  /**
   * Generate a short unique ID (8 chars) without uuid package
   * @returns {string} 8-character unique ID
   */
  static generateShortID() {
    // Use timestamp and random number to create unique ID
    const timestamp = Date.now().toString(36); // Base36 encode timestamp
    const random = Math.random().toString(36).substring(2, 8); // 6 random chars
    return (timestamp + random).substring(0, 8).toLowerCase();
  }

  /**
   * Shorten agent type to 4 character code
   * @param {string} agentType - Full agent type name
   * @returns {string} Shortened type code
   */
  static shortenAgentType(agentType) {
    const typeMap = {
      'general': 'gnrl',
      'general-qna': 'gnrl',
      'architecture': 'arch',
      'diagram': 'diag',
      'diagram-generation': 'diag',
      'estimation': 'estm',
      'raml': 'raml',
      'raml-generation': 'raml',
      'documentation': 'docs',
      'mule-code': 'code',
    };
    
    const normalized = agentType.toLowerCase().trim();
    return typeMap[normalized] || 'unkn';
  }

  /**
   * Get the agent type from a correlation ID
   * @param {string} correlationID - The correlation ID
   * @returns {string} Agent type code (4 chars)
   */
  static getAgentTypeFromID(correlationID) {
    // Format: YYYY-MM-DD-HHmm-agenttype-uuid
    const parts = correlationID.split('-');
    return parts[4] || 'unkn';
  }

  /**
   * Get the timestamp from a correlation ID
   * @param {string} correlationID - The correlation ID
   * @returns {Date} Parsed date
   */
  static getTimestampFromID(correlationID) {
    // Format: YYYY-MM-DD-HHmm-agenttype-uuid
    const parts = correlationID.split('-');
    if (parts.length < 5) return null;
    
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]) - 1; // 0-indexed
    const date = parseInt(parts[2]);
    const hours = parseInt(parts[3].substring(0, 2));
    const minutes = parseInt(parts[3].substring(2, 4));
    
    return new Date(year, month, date, hours, minutes);
  }

  /**
   * Validate correlation ID format
   * @param {string} correlationID - The correlation ID to validate
   * @returns {boolean} True if valid format
   */
  static isValidCorrelationID(correlationID) {
    if (!correlationID || typeof correlationID !== 'string') return false;
    
    const parts = correlationID.split('-');
    if (parts.length < 5) return false;
    
    // Check date parts
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]);
    const date = parseInt(parts[2]);
    const timeStr = parts[3];
    
    if (isNaN(year) || isNaN(month) || isNaN(date)) return false;
    if (month < 1 || month > 12 || date < 1 || date > 31) return false;
    if (timeStr.length !== 4 || isNaN(parseInt(timeStr))) return false;
    
    return true;
  }
}

export default CorrelationIDManager;
