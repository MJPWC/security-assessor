/**
 * Agent Registry (A2A Protocol Concept)
 * Manages agent discovery and registration
 * Allows agents to discover and connect to other agents
 */

class AgentRegistry {
  constructor() {
    this.agents = new Map(); // agentId -> agent instance
    this.agentMetadata = new Map(); // agentId -> metadata
  }

  /**
   * Register an agent in the registry
   * @param {string} agentId - Unique agent identifier
   * @param {object} agent - Agent instance
   * @param {object} metadata - Agent metadata (name, description, capabilities)
   */
  register(agentId, agent, metadata = {}) {
    const isUpdate = this.agents.has(agentId);

    this.agents.set(agentId, agent);
    this.agentMetadata.set(agentId, {
      agentId,
      name: metadata.name || agentId,
      description: metadata.description || '',
      capabilities: metadata.capabilities || [],
      address: `agent://${agentId}`,
      registeredAt: Date.now(),
      ...metadata
    });

    if (!isUpdate) {
      console.log(`✅ Agent registered: ${agentId} (${metadata.name || agentId})`);
    }
  }

  /**
   * Unregister an agent
   * @param {string} agentId - Agent identifier
   */
  unregister(agentId) {
    this.agents.delete(agentId);
    this.agentMetadata.delete(agentId);
    console.log(`❌ Agent unregistered: ${agentId}`);
  }

  /**
   * Discover an agent by ID
   * @param {string} agentId - Agent identifier
   * @returns {object|null} Agent instance or null if not found
   */
  discover(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      console.warn(`⚠️ Agent not found: ${agentId}`);
      return null;
    }
    return agent;
  }

  /**
   * Get agent metadata
   * @param {string} agentId - Agent identifier
   * @returns {object|null} Agent metadata or null
   */
  getMetadata(agentId) {
    return this.agentMetadata.get(agentId) || null;
  }

  /**
   * List all registered agents
   * @returns {Array} Array of agent metadata
   */
  listAgents() {
    return Array.from(this.agentMetadata.values());
  }

  /**
   * Find agents by capability
   * @param {string} capability - Capability to search for
   * @returns {Array} Array of agent metadata matching the capability
   */
  findAgentsByCapability(capability) {
    return this.listAgents().filter(agent => 
      agent.capabilities && agent.capabilities.includes(capability)
    );
  }

  /**
   * Check if agent is registered
   * @param {string} agentId - Agent identifier
   * @returns {boolean}
   */
  isRegistered(agentId) {
    return this.agents.has(agentId);
  }

  /**
   * Get agent address (A2A protocol format)
   * @param {string} agentId - Agent identifier
   * @returns {string|null} Agent address or null
   */
  getAgentAddress(agentId) {
    const metadata = this.agentMetadata.get(agentId);
    return metadata ? metadata.address : null;
  }
}

// Singleton instance
let registryInstance = null;

/**
 * Get the global agent registry instance
 * @returns {AgentRegistry} Singleton registry instance
 */
export function getAgentRegistry() {
  if (!registryInstance) {
    registryInstance = new AgentRegistry();
  }
  return registryInstance;
}

export default AgentRegistry;
