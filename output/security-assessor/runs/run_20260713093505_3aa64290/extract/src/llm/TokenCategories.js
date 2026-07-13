/**
 * Maps agent types to token categories
 * Used for bifurcating token usage by agent type
 */
class TokenCategories {
  // Category mappings
  static GENERAL = 'General';
  static ARCHITECTURE = 'Architecture';
  static DIAGRAM = 'Diagram';
  static ESTIMATION = 'Estimation';
  static RAML = 'RAML';
  static DOCUMENTATION = 'Documentation';

  /**
   * Get token category from agent type
   * @param {string} agentType - The agent type (e.g., 'architecture', 'diagram-generation')
   * @returns {string} The token category
   */
  static getCategoryFromAgentType(agentType) {
    if (!agentType) return this.GENERAL;

    const type = agentType.toLowerCase().trim();
    const categoryMap = {
      'general': this.GENERAL,
      'general-qna': this.GENERAL,
      'general-qna-agent': this.GENERAL,
      'architecture': this.ARCHITECTURE,
      'architecture-agent': this.ARCHITECTURE,
      'diagram': this.DIAGRAM,
      'diagram-generation': this.DIAGRAM,
      'diagram-generation-agent': this.DIAGRAM,
      'estimation': this.ESTIMATION,
      'estimation-agent': this.ESTIMATION,
      'project-estimation': this.ESTIMATION,
      'project-estimation-agent': this.ESTIMATION,
      'raml': this.RAML,
      'raml-generation': this.RAML,
      'raml-agent': this.RAML,
      'raml-generation-agent': this.RAML,
      'documentation': this.DOCUMENTATION,
      'documentation-agent': this.DOCUMENTATION,
      'mule-code': this.GENERAL,
      'mule-code-agent': this.GENERAL,
      'mule-code-generation': this.GENERAL,
      'manager': this.GENERAL,
      'manager-agent': this.GENERAL,
    };

    return categoryMap[type] || this.GENERAL;
  }

  /**
   * Get all available categories
   * @returns {string[]} Array of all categories
   */
  static getAllCategories() {
    return [
      this.GENERAL,
      this.ARCHITECTURE,
      this.DIAGRAM,
      this.ESTIMATION,
      this.RAML,
      this.DOCUMENTATION,
    ];
  }

  /**
   * Get category color for UI display
   * @param {string} category - The category name
   * @returns {string} Hex color code
   */
  static getCategoryColor(category) {
    const colorMap = {
      [this.GENERAL]: '#6366F1',       // Indigo
      [this.ARCHITECTURE]: '#3B82F6',   // Blue
      [this.DIAGRAM]: '#8B5CF6',        // Purple
      [this.ESTIMATION]: '#EC4899',     // Pink
      [this.RAML]: '#F59E0B',           // Amber
      [this.DOCUMENTATION]: '#10B981',  // Emerald
    };

    return colorMap[category] || '#6366F1';
  }

  /**
   * Get category icon for UI display
   * @param {string} category - The category name
   * @returns {string} Unicode character or emoji
   */
  static getCategoryIcon(category) {
    const iconMap = {
      [this.GENERAL]: '💬',
      [this.ARCHITECTURE]: '🏗️',
      [this.DIAGRAM]: '🎨',
      [this.ESTIMATION]: '📊',
      [this.RAML]: '📋',
      [this.DOCUMENTATION]: '📚',
    };

    return iconMap[category] || '❓';
  }

  /**
   * Validate if category is valid
   * @param {string} category - The category to validate
   * @returns {boolean} True if valid
   */
  static isValidCategory(category) {
    return this.getAllCategories().includes(category);
  }

  /**
   * Get short abbreviation for category
   * @param {string} category - The category name
   * @returns {string} 3-4 character abbreviation
   */
  static getCategoryAbbreviation(category) {
    const abbrevMap = {
      [this.GENERAL]: 'GEN',
      [this.ARCHITECTURE]: 'ARC',
      [this.DIAGRAM]: 'DIA',
      [this.ESTIMATION]: 'EST',
      [this.RAML]: 'RML',
      [this.DOCUMENTATION]: 'DOC',
    };

    return abbrevMap[category] || 'UNK';
  }
}

export default TokenCategories;
