/**
 * Main entry point for the MuleSoft Multi-Agent System
 * Exports all agents and orchestrator
 * Now includes A2A Protocol support
 */
export { default as BaseAgent } from "./agent/BaseAgent.js";
export { default as MuleSoftArchitectureAgent } from "./agent/MuleSoftArchitectureAgent.js";
export { default as DiagramGenerationAgent } from "./agent/DiagramGenerationAgent.js";
export { default as EstimationAgent } from "./agent/EstimationAgent.js";
export { default as RAMLGenerationAgent } from "./agent/RAMLGenerationAgent.js";
export { default as AgentOrchestrator } from "./agent/AgentOrchestrator.js";
export { default as GeneralQnAAgent } from "./agent/GeneralQnAAgent.js";
export { default as ManagerAgent, ManagerAgent as AgentManager } from "./agent/AgentManager.js";
export { default as Config } from "./config/config.js";

// A2A Protocol exports
export { default as AgentRegistry, getAgentRegistry } from "./a2a/AgentRegistry.js";
export { default as MessageRouter, getMessageRouter } from "./a2a/MessageRouter.js";
export { A2AMessage } from "./a2a/Message.js";