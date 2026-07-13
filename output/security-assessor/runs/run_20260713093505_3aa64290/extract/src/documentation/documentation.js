import { buildDocumentPrompt } from './doc_prompts.js';
import Config from '../config/config.js';
import GeminiClient from '../llm/GeminiClient.js';
import OpenAIClient from '../llm/OpenAIClient.js';
import AnthropicClient from '../llm/AnthropicClient.js';
import OpenRouterClient from '../llm/OpenRouterClient.js';
import GroqClient from '../llm/GroqClient.js';
import LLMManagerClass from '../llm/LLMManager.js';

function tokenOverlap(questionTokens, text) {
  const t = String(text).toLowerCase();
  let count = 0;
  for (const tok of questionTokens) {
    if (t.includes(tok)) count++;
  }
  return count;
}

function similarityOfQuestions(a, b) {
  const ta = String(a).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const tb = String(b).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const sa = new Set(ta);
  const sb = new Set(tb);
  const inter = [...sa].filter(x => sb.has(x));
  const union = new Set([...sa, ...sb]);
  return inter.length / Math.max(1, union.size);
}

async function isAnsweredInContextWithLLM(question, context, history, config) {
  try {
    const LLMManager = require('../llm/LLMManager');
    const llmManager = new LLMManager(config);

    // Build context string from available information
    let contextStr = '';
    if (context.architecture) contextStr += `Architecture: ${context.architecture}\n\n`;
    if (context.raml) contextStr += `RAML: ${context.raml}\n\n`;
    if (context.diagram) contextStr += `Diagram: ${context.diagram}\n\n`;
    if (context.estimation) contextStr += `Estimation: ${context.estimation}\n\n`;
    
    // Add history
    if (history && history.length > 0) {
      contextStr += 'Previous Q&A:\n';
      history.forEach(item => {
        if (item.prompt && item.answer) {
          contextStr += `Q: ${item.prompt}\nA: ${item.answer}\n\n`;
        }
      });
    }

    if (!contextStr.trim()) return false;

    // More aggressive filtering for common questions that are typically covered in architecture/estimation
    const commonQuestionPatterns = [
      /business objectives|success criteria|business value/i,
      /stakeholders|target audience|decision makers/i,
      /timeline|milestones|deliverables|project schedule/i,
      /non-functional requirements|performance|security|compliance|scalability/i,
      /integrations|data flows|apis|databases/i,
      /deployment|environment|infrastructure/i
    ];

    const isCommonQuestion = commonQuestionPatterns.some(pattern => pattern.test(question));

    const prompt = `Based on the following context, determine if this question is already answered or can be reasonably inferred:

Question: "${question}"

Context:
${contextStr}

${isCommonQuestion ? 'NOTE: This is a common question that is often covered in architecture or estimation documents. Be more liberal in determining if it\'s already answered.' : ''}

Instructions:
- If the context contains architecture, estimation, or RAML information that addresses this question, respond "YES"
- If the question asks about business objectives and there's project/system description, respond "YES"
- If the question asks about stakeholders and there's system context, respond "YES"
- If the question asks about timeline and there's estimation information, respond "YES"
- If the question asks about non-functional requirements and there's architecture details, respond "YES"
- Only respond "NO" if the specific information is clearly missing

Respond with only "YES" or "NO".`;

    const response = await llmManager.generateResponse(prompt, { maxTokens: 10 });
    const result = response && response.toLowerCase().includes('yes');
    
    console.log('[Context Filter] Question evaluated', {
      questionLength: typeof question === 'string' ? question.length : 0,
      result: result ? 'FILTERED OUT' : 'INCLUDED'
    });
    return result;
  } catch (error) {
    console.error('Error in LLM context check:', error);
    return false;
  }
}

// Simple fallback for non-async calls
function isAnsweredInHistory(question, history) {
  if (!history || !Array.isArray(history)) return false;
  const questionLower = question.toLowerCase();
  return history.some(entry => {
    const prompt = (entry.prompt || '').toLowerCase();
    const answer = (entry.answer || '').toLowerCase();
    return prompt.includes(questionLower.split(' ')[0]) || answer.includes(questionLower.split(' ')[0]);
  });
}

// Inlined from core.js
export function chooseModel(strategy = 'auto') {
  if (strategy === 'auto') return 'gemini';
  return strategy;
}

export async function runWithModelFallback(selected, _useCase, cb) {
  const first = Array.isArray(selected) ? selected : [selected];
  for (const provider of first) {
    try {
      return await cb(provider);
    } catch (e) {
      // try next
    }
  }
  throw new Error('All providers failed');
}

function getAvailableProviderForConfig() {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_1) return 'gemini';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  return process.env.LLM_PROVIDER || 'anthropic';
}

function createDocumentLLMManager() {
  const config = new Config({ provider: getAvailableProviderForConfig() });
  const clientConfigs = [
    {
      key: 'anthropic',
      class: AnthropicClient,
      config: {
        apiKey: config.anthropicApiKey,
        model: config.anthropicModel
      },
      priority: 1
    },
    {
      key: 'groq',
      class: GroqClient,
      config: {
        apiKey: config.groqApiKey,
        model: config.groqModel
      },
      priority: 2
    },
    {
      key: 'openai',
      class: OpenAIClient,
      config: {
        apiKey: config.openaiApiKey,
        model: config.openaiModel
      },
      priority: 3
    },
    {
      key: 'gemini',
      class: GeminiClient,
      config: {
        apiKey: config.geminiApiKey || (config.geminiApiKeys && config.geminiApiKeys[0]),
        apiKeys: config.geminiApiKeys,
        model: config.geminiModel
      },
      priority: 4
    },
    {
      key: 'openrouter',
      class: OpenRouterClient,
      config: {
        apiKey: config.openrouterApiKey,
        model: config.openrouterModel,
        baseUrl: config.openrouterBaseUrl,
        site: config.openrouterSite,
        appName: config.openrouterAppName
      },
      priority: 5
    }
  ];

  return new LLMManagerClass(clientConfigs, config);
}

export async function generateLLMResponse(messages, temperature = 0.3, maxTokens = 32000) {
  // Route through LLMManager so token usage is logged to the CSV dashboard.
  const llmManager = createDocumentLLMManager();
  const res = await llmManager.chatCompletionsCreate(
    { messages, temperature, max_tokens: maxTokens },
    '', // correlationID — not available at this call site
    'Documentation'
  );
  return res.choices[0].message.content;
}

export async function generateGeminiResponse(messages, _model = null, temperature = 0.3, maxTokens = 32000) {
  return generateLLMResponse(messages, temperature, maxTokens);
}

export async function generateOpenAIResponse() { throw new Error('OpenAI fallback not enabled'); }
export async function generateAnthropicResponse() { throw new Error('Anthropic fallback not enabled'); }
export async function generateGroqResponse() { throw new Error('Groq fallback not enabled'); }
export async function generateOpenRouterAIResponse() { throw new Error('OpenRouter fallback not enabled'); }

export function detectDocumentType(text) {
  const lower = (text || '').toLowerCase();
  if (/\bbrd\b|business\s+requirements?\s+document/i.test(lower)) return 'BRD';
  if (/\bwbs\b|work\s+breakdown\s+structure/i.test(lower)) return 'WBS';
  if (/\bhld\b|high[-\s]*level\s+integration\s+design|high[-\s]*level\s+design/i.test(lower)) return 'HLD';
  if (/\btdd\b|technical\s+design\s+document|tech\s+design/i.test(lower)) return 'TDD';
  if (/test\s*(plan|strategy)|\bqa\b|testing\s+plan/i.test(lower)) return 'TEST_PLAN';
  if (/generat.*document|creat.*document|help.*document|document.*project|project.*document/i.test(lower)) return 'DOCUMENT_REQUEST';
  return null;
}

export async function generateDocumentClarifyingQuestions(context, docType, history, config) {
  const questions = [];
  if (!context.askedQuestions) context.askedQuestions = new Set();
  const wasAskedBefore = (q) => context.askedQuestions.has(String(q).toLowerCase());

  // If we have rich context (architecture + estimation), be very aggressive about filtering
  const hasRichContext = (context.architecture && context.architecture.length > 500) || 
                         (context.estimation && context.estimation.length > 300) ||
                         (context.raml && context.raml.length > 200);
  
  //console.log(`[Question Filter] Rich context available: ${hasRichContext}, Architecture: ${context.architecture ? context.architecture.length : 0} chars, Estimation: ${context.estimation ? context.estimation.length : 0} chars`);
  
  // If we have rich context and this is a direct button click, skip most questions
  if (hasRichContext && context.currentDocType && !context.a2aDocTypeAsked) {
    console.log(`[Question Filter] Rich context + direct button click detected for ${docType} - applying aggressive filtering`);
    
    // For direct button clicks with rich context, only ask very specific questions that can't be inferred
    const criticalQuestions = [];
    
    // Only ask about specific technical details that might not be in architecture
    if (docType === 'TEST_PLAN' && !context.architecture?.includes('test')) {
      criticalQuestions.push("What specific testing scenarios or edge cases should be prioritized?");
    } else if (docType === 'WBS' && !context.estimation?.includes('phase')) {
      criticalQuestions.push("Are there any specific project phases or dependencies not covered in the estimation?");
    }
    
    console.log(`[Question Filter] Rich context filtering: ${criticalQuestions.length} critical questions for ${docType}`);
    return criticalQuestions;
  }

  // Enhanced context checking - look at architecture, raml, and other agent outputs
  const hasSystemsFromContext = context.systems?.size >= 2 || 
    (context.architecture && /(salesforce|sap|workday|servicenow|dynamics|shopify|magento|kafka|rabbitmq|database|mysql|postgres|oracle|s3|ftp|sftp|rest|soap|http)/i.test(context.architecture)) ||
    (context.raml && /\b(salesforce|sap|workday|servicenow|dynamics|shopify|magento|kafka|rabbitmq|database|mysql|postgres|oracle|s3|ftp|sftp|rest|soap|http)\b/i.test(context.raml));

  const hasDeploymentFromContext = context.deploymentModels?.size > 0 || 
    (context.architecture && /(cloudhub|runtime fabric|rtf|on-premise|hybrid|multi-cloud|aws|azure|gcp)/i.test(context.architecture)) ||
    (context.raml && /(cloudhub|runtime fabric|rtf|on-premise|hybrid|multi-cloud|aws|azure|gcp)/i.test(context.raml));

  // Infer integration types from architecture/RAML even if explicit sets are not populated
  const hasIntegrationsFromContext = (context.integrations && context.integrations.size >= 2) ||
    (context.architecture && /(rest|soap|http|mq|kafka|amqp|pub\/?sub|queue|topic|messag|file|ftp|sftp|db|database|sql|mysql|postgres|oracle)/i.test(context.architecture)) ||
    (context.raml && /(rest|soap|http|mq|kafka|amqp|queue|topic|stream|event)/i.test(context.raml));

  // Use LLM-based intelligent question filtering
  const systemsQuestion = "What are the main systems, applications, or data sources that need to be integrated?";
  if (
    !hasSystemsFromContext &&
    !wasAskedBefore(systemsQuestion) &&
    !(await isAnsweredInContextWithLLM(systemsQuestion, context, history, config))
  ) {
    questions.push(systemsQuestion);
  }

  const deploymentQuestion = "What is the target deployment environment and infrastructure? (CloudHub, Runtime Fabric, on-premise, hybrid, or multi-cloud?)";
  if (
    !hasDeploymentFromContext &&
    !wasAskedBefore(deploymentQuestion) &&
    !(await isAnsweredInContextWithLLM(deploymentQuestion, context, history, config))
  ) {
    questions.push(deploymentQuestion);
  }

  if (docType === 'BRD') {
    const businessObjectivesQuestion = "What are the primary business objectives and expected business value from this MuleSoft integration?";
    if ((!context.requirements || context.requirements.size < 2) && 
        !isAnsweredInHistory(businessObjectivesQuestion, history) &&
        !(await isAnsweredInContextWithLLM(businessObjectivesQuestion, context, history, config))) {
      questions.push(businessObjectivesQuestion);
    }
    
    const stakeholdersQuestion = "Who are the key business stakeholders and decision makers for this project?";
    if (!context.stakeholders && 
        !isAnsweredInHistory(stakeholdersQuestion, history) &&
        !(await isAnsweredInContextWithLLM(stakeholdersQuestion, context, history, config))) {
      questions.push(stakeholdersQuestion);
    }
    
    const functionalReqQuestion = "What are the functional requirements and business processes that need to be supported?";
    if ((!context.requirements || context.requirements.size < 1) && 
        !isAnsweredInHistory(functionalReqQuestion, history) &&
        !(await isAnsweredInContextWithLLM(functionalReqQuestion, context, history, config))) {
      questions.push(functionalReqQuestion);
    }
    
    const timelineQuestion = "What is the business timeline and when do you need this solution operational?";
    if (!context.timeline && 
        !isAnsweredInHistory(timelineQuestion, history) &&
        !(await isAnsweredInContextWithLLM(timelineQuestion, context, history, config))) {
      questions.push(timelineQuestion);
    }
  } else if (docType === 'WBS') {
    if (!context.timeline && !isAnsweredInHistory("What is the overall project timeline and what are the key phases or milestones?", history)) {
      questions.push("What is the overall project timeline and what are the key phases or milestones?");
    }
    if ((!context.requirements || context.requirements.size < 2) && !isAnsweredInHistory("What are the main deliverables and work packages for this MuleSoft project?", history)) {
      questions.push("What are the main deliverables and work packages for this MuleSoft project?");
    }
    if (!context.stakeholders && !isAnsweredInHistory("What team members and resources will be involved in this project?", history)) {
      questions.push("What team members and resources will be involved in this project?");
    }
    if ((!context.integrations || context.integrations.size < 2) && !isAnsweredInHistory("What are the dependencies between different integration components or phases?", history)) {
      questions.push("What are the dependencies between different integration components or phases?");
    }
  } else if (docType === 'TEST_PLAN') {
    if ((!context.requirements || context.requirements.size < 2) && !isAnsweredInHistory("What are the critical business scenarios and use cases that need to be tested?", history)) {
      questions.push("What are the critical business scenarios and use cases that need to be tested?");
    }
    if (!context.stakeholders && !isAnsweredInHistory("Who are the testing stakeholders and what are the quality acceptance criteria?", history)) {
      questions.push("Who are the testing stakeholders and what are the quality acceptance criteria?");
    }
    if ((!context.integrations || context.integrations.size < 2) && !isAnsweredInHistory("What types of integrations and data flows need to be tested? (APIs, databases, file transfers, etc.)", history)) {
      questions.push("What types of integrations and data flows need to be tested? (APIs, databases, file transfers, etc.)");
    }
    if ((!context.requirements || context.requirements.size < 1) && !isAnsweredInHistory("What are the performance, security, and compliance requirements that need testing validation?", history)) {
      questions.push("What are the performance, security, and compliance requirements that need testing validation?");
    }
  } else {
    const businessObjectivesQuestion = "What are the primary business objectives and success criteria for this MuleSoft project?";
    if ((!context.requirements || context.requirements.size < 2) && 
        !isAnsweredInHistory(businessObjectivesQuestion, history) &&
        !(await isAnsweredInContextWithLLM(businessObjectivesQuestion, context, history, config))) {
      questions.push(businessObjectivesQuestion);
    }
    
    const stakeholdersQuestion = "Who are the key stakeholders and what is the target audience for this document?";
    if (!context.stakeholders && 
        !isAnsweredInHistory(stakeholdersQuestion, history) &&
        !(await isAnsweredInContextWithLLM(stakeholdersQuestion, context, history, config))) {
      questions.push(stakeholdersQuestion);
    }
    
    const timelineQuestion = "What is the project timeline and what are the key milestones or deliverables?";
    if (!context.timeline && 
        !isAnsweredInHistory(timelineQuestion, history) &&
        !(await isAnsweredInContextWithLLM(timelineQuestion, context, history, config))) {
      questions.push(timelineQuestion);
    }
    
    const nonFunctionalReqQuestion = "What are the non-functional requirements? (performance, security, compliance, scalability, etc.)";
    if ((!context.requirements || context.requirements.size < 1) && 
        !isAnsweredInHistory(nonFunctionalReqQuestion, history) &&
        !(await isAnsweredInContextWithLLM(nonFunctionalReqQuestion, context, history, config))) {
      questions.push(nonFunctionalReqQuestion);
    }
  }

  const integrationsQuestion = "What types of integrations and data flows are required? (REST APIs, SOAP services, databases, file transfers, real-time messaging, etc.)";
  if (
    !hasIntegrationsFromContext &&
    (!context.integrations || context.integrations.size < 2) &&
    !isAnsweredInHistory(integrationsQuestion, history) &&
    !(await isAnsweredInContextWithLLM(integrationsQuestion, context, history, config))
  ) {
    questions.push(integrationsQuestion);
  }

  if ((docType === 'TDD' || docType === 'TEST_PLAN') && context.apiCount === 0 && !isAnsweredInHistory("How many APIs or services are expected to be part of this solution, and what are their expected volumes?", history) && !wasAskedBefore("How many APIs or services are expected to be part of this solution, and what are their expected volumes?")) {
    questions.push("How many APIs or services are expected to be part of this solution, and what are their expected volumes?");
  }

  return questions.slice(0, 5);
}

export async function generateDocument(docType, inputs, contextSummary, conversationSummary, options = {}) {
  let scenarioTitle = '';
  try {
    const titlePrompt = [
      'Given the following project context, output a single, concise scenario title focused on the business/domain (not transports like HTTP/REST/SOAP).',
      'Prefer domain nouns such as Patient Appointment, Online Booking System, EMR/EHR, Claim, Policy, Payment, Order, Inventory, Shipment, Enrollment, Lead, Loyalty Points, etc.',
      'Prefer format: "<Subject> – <Primary Endpoint>" (single endpoint). Only use "A to B" if both endpoints are essential to convey meaning.',
      'Avoid generic platform-only titles unless necessary (e.g., avoid just Salesforce/SAP without business nouns).',
      'Examples:',
      '- Patient Appointment – EMR',
      '- Claim Status – Customer Portal',
      '- Employee Onboarding – Active Directory',
      '- Shipment Tracking – Customer Dashboard',
      '- Plan Upgrade – Billing System',
      '- Inventory Sync – SAP',
      '- Student Enrollment – SIS',
      '- Booking Confirmation – CRM',
      '- Loyalty Points – Rewards Platform',
      '- Lead Management – Salesforce CRM',
      '',
      'Context:',
      `Systems: ${inputs?.systems || ''}`,
      `APIs: ${inputs?.apis || ''}`,
      `Goal: ${inputs?.goal || ''}`,
      `Deployment: ${inputs?.deployment || ''}`,
      `Constraints: ${inputs?.constraints || ''}`,
      contextSummary || '',
      conversationSummary || '',
      '',
      'Output only the title, no extra words.'
    ].join('\n');
    const candidate = await generateGeminiResponse([{ role: 'user', content: titlePrompt }], 'gemini-1.5-flash', 0.2, 40);
    if (candidate && typeof candidate === 'string') {
      scenarioTitle = candidate.split('\n')[0].replace(/^"|"$/g, '').trim();
    }
  } catch {}

  const prompt = buildDocumentPrompt(docType, { ...inputs, scenarioTitle }, contextSummary, conversationSummary);
  console.log('[documentation] Generating document with LLM sequence...');
  console.log('[documentation] Document Type:', docType);
  console.log('[documentation] Prompt length:', prompt?.length || 0);
  const messages = [{ role: 'user', content: prompt }];
  const content = await generateLLMResponse(messages, 0.3, 32000);
  console.log('[documentation] LLM generated content length:', content?.length || 0);
  return { content, scenarioTitle };
}

export function getDocumentSystemPromptAdditions() {
  return [
    "For document generation requests (BRD, WBS, Test Plan, HLD, or general project documentation): ask 4–6 targeted questions to gather project scope, stakeholders, business objectives, technical requirements, timeline, deliverables, success criteria, and compliance needs. Prioritize understanding the document purpose, target audience, and specific MuleSoft integration context.",
    "Document-specific guidance: For BRD requests, focus on business value, stakeholder needs, and functional requirements. For WBS requests, emphasize project phases, deliverables, dependencies, and resource allocation. For Test Plan requests, concentrate on test scenarios, coverage areas, environments, and quality criteria. For HLD requests, focus on business context, systems involved, dependencies/external systems, monitoring/observability, and linkages to ILDs and STTM. Always tailor questions to the specific document type being requested."
  ].join(' ');
}

// Inlined architecture helpers (previously in architecture.js)
export function extractSystemDetails(message, context) {
  const text = String(message || '').toLowerCase();
  context.requirements = context.requirements || new Set();
  context.integrations = context.integrations || new Set();
  context.deploymentModels = context.deploymentModels || new Set();
  context.systems = context.systems || new Set();
  context.apis = context.apis || new Set();

  const systems = [];
  const sysRegex = /(salesforce|sap|oracle|workday|netsuite|servicenow|dynamics|shopify|magento|kafka|rabbitmq|db|database|mysql|postgres|mongodb|s3|ftp|sftp|http|soap|rest)/g;
  let m;
  while ((m = sysRegex.exec(text)) !== null) {
    systems.push(m[1]);
  }
  systems.forEach(s => context.systems.add(s.toUpperCase()));

  if (/(rest|http)/.test(text)) context.integrations.add('REST');
  if (/soap/.test(text)) context.integrations.add('SOAP');
  if (/(db|database|sql|mysql|postgres|oracle)/.test(text)) context.integrations.add('Database');
  if (/(file|ftp|sftp)/.test(text)) context.integrations.add('File');
  if (/(mq|kafka|amqp|pub\/?sub|queue|topic|messag)/.test(text)) context.integrations.add('Messaging');

  if (/cloudhub/.test(text)) context.deploymentModels.add('CloudHub');
  if (/runtime\s*fabric|rtf/.test(text)) context.deploymentModels.add('Runtime Fabric');
  if (/on[-\s]?prem|onprem/.test(text)) context.deploymentModels.add('On-Premise');
  if (/hybrid/.test(text)) context.deploymentModels.add('Hybrid');
  if (/multi[-\s]?cloud/.test(text)) context.deploymentModels.add('Multi-Cloud');
}

export function buildContextSummary(ctx = {}) {
  const list = (v) => Array.from(v || []).join(', ') || 'N/A';
  return [
    `Systems: ${list(ctx.systems)}`,
    `Integrations: ${list(ctx.integrations)}`,
    `Deployment: ${list(ctx.deploymentModels)}`,
    `APIs: ${list(ctx.apis)}`,
    `Constraints/Requirements: ${list(ctx.requirements)}`
  ].join('\n');
}
