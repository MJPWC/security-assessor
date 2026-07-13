import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { AgentManager, Config } from "../src/index.js";
import DocumentationAgent from "../src/agent/DocumentationAgent.js";
import RAMLGenerationAgent from "../src/agent/RAMLGenerationAgent.js";
import { detectDocumentType } from "../src/documentation/documentation.js";
import { handleRamlDownload } from "../src/raml/raml_download.js";
import { publishRamlDirect } from "../src/raml/raml_publishing.js";
import { handleMuleCodeDownload } from "../src/mule/mule_code_download.js";
import { parseTokenUsageCSV } from "./tokenUsageParser.js";
import { guardGeneratedValue, guardProgressEvent, inspectUserInput } from "./guardrails.js";
import { inspectRequestBudget } from "./requestBudget.js";
import { checkRateLimit, rateLimiters } from "./rateLimiter.js";
import { securityHeaders } from "./securityHeaders.js";
import { validateMuleProjectArtifact, validateRamlArtifact } from "./artifactValidation.js";
import { createAuthentication } from "./auth.js";
import { evaluateSessionAccess } from "./sessionAccessPolicy.js";
import { redactForLog } from "../src/security/redaction.js";
import {
  assertProductionEncryption,
  getDataEncryptionKey,
  readSecureStore,
  writeSecureStore
} from "./secureStore.js";
import CSVLogger from "../src/llm/CSVLogger.js";

if (!globalThis.__muleGenieConsoleRedactionPatched) {
  for (const method of ['log', 'warn', 'error', 'debug']) {
    const original = console[method].bind(console);
    console[method] = (...args) => original(...redactForLog(args));
  }
  globalThis.__muleGenieConsoleRedactionPatched = true;
}

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CSV header creation is handled by CSVLogger.ensureHeaderExists() which uses
// the canonical TokenTracker.getCSVHeader() string.  Instantiating a CSVLogger
// here is enough to guarantee the file and header exist before any requests arrive.

// Set LOG_LEVEL for better console logging
if (!process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = 'debug';
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
const httpServer = createServer(app);
const clientBuildPath = path.resolve(__dirname, "../client/build");

function getAllowedOrigins() {
  const configured = [
    process.env.FRONTEND_URL,
    process.env.CORS_ORIGIN,
    ...(process.env.CORS_ORIGINS || '').split(',')
  ]
    .map(origin => origin && String(origin).trim())
    .filter(Boolean);

  return Array.from(new Set([
    ...configured,
    "http://localhost:3000",
    "http://127.0.0.1:3000"
  ]));
}

const allowedOrigins = getAllowedOrigins();
const corsOptions = {
  credentials: true,
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin ${origin} is not allowed by CORS`));
  },
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"]
};

const io = new Server(httpServer, {
  cors: {
    credentials: true,
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} is not allowed by Socket.IO CORS`));
    },
    methods: ["GET", "POST"]
  },
  // Increase buffer to handle large architecture/documentation/estimation payloads.
  // Default is 1MB — complex MuleSoft docs with RAML + architecture can exceed this.
  maxHttpBufferSize: 10e6,   // 10 MB
  pingTimeout: 120000,       // 2 min — long LLM generations can exceed default 20s
  pingInterval: 25000        // keep-alive ping every 25s during long generations
});

// Instantiating CSVLogger calls ensureHeaderExists() which creates the file and
// canonical header (via TokenTracker.getCSVHeader()) if not already present.
new CSVLogger();

const LLM_PROVIDER_SEQUENCE = ['anthropic', 'groq', 'openai', 'gemini', 'openrouter'];

function envValue(name) {
  const value = process.env[name];
  if (!value) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed || /^__REPLACE_ME__$/i.test(trimmed)) return undefined;
  return trimmed;
}

function hasProviderApiKey(provider) {
  if (provider === 'anthropic') return !!envValue('ANTHROPIC_API_KEY');
  if (provider === 'groq') return !!envValue('GROQ_API_KEY');
  if (provider === 'openai') return !!envValue('OPENAI_API_KEY');
  if (provider === 'gemini') return !!(envValue('GEMINI_API_KEY') || envValue('GEMINI_API_KEY_1'));
  if (provider === 'openrouter') return !!envValue('OPENROUTER_API_KEY');
  return false;
}

function getFirstConfiguredSequenceProvider() {
  return LLM_PROVIDER_SEQUENCE.find(hasProviderApiKey) || 'anthropic';
}

function normalizeProvider(provider) {
  if (provider && provider !== 'auto') {
    return provider;
  }
  return getFirstConfiguredSequenceProvider();
}

function createSequenceConfig(model = undefined, provider = 'auto') {
  return new Config({ provider: normalizeProvider(provider), model });
}

function summarizeValue(value) {
  if (typeof value === 'string') {
    return { type: 'string', length: value.length };
  }
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length };
  }
  if (value && typeof value === 'object') {
    return { type: 'object', keys: Object.keys(value) };
  }
  return { type: typeof value, present: value != null };
}

function summarizeOutputs(outputs = {}) {
  return Object.fromEntries(
    Object.entries(outputs || {}).map(([key, value]) => [key, summarizeValue(value)])
  );
}

function summarizeDocAnswers(answers = []) {
  return (Array.isArray(answers) ? answers : []).map(qa => ({
    questionLength: typeof qa?.question === 'string' ? qa.question.length : 0,
    hasAnswer: typeof qa?.answer === 'string' && qa.answer.trim().length > 0,
    answerLength: typeof qa?.answer === 'string' ? qa.answer.length : 0,
  }));
}

function summarizeOptions(options = {}) {
  const summary = {};
  for (const [key, value] of Object.entries(options || {})) {
    if (['approaches', 'questions', 'context', 'history'].includes(key)) {
      summary[key] = summarizeValue(value);
    } else {
      summary[key] = value;
    }
  }
  return summary;
}

function summarizeError(error) {
  return {
    name: error?.name,
    message: error?.message,
    code: error?.code,
    status: error?.response?.status,
    response: error?.response?.data ? summarizeValue(error.response.data) : undefined
  };
}

app.use(securityHeaders);
app.use(cors(corsOptions));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Request body is too large. Please reduce the input size and try again.',
      blockedBy: 'request-size-limit'
    });
  }
  return next(err);
});

const runtimeInstanceId = crypto.randomUUID();
const authentication = createAuthentication({ runtimeInstanceId });
assertProductionEncryption();

function safeReportedUrl(value) {
  if (!value) return undefined;
  try {
    const url = new URL(String(value));
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[unparseable URL]';
  }
}

app.post(
  '/api/security/csp-report',
  express.json({ type: ['application/csp-report', 'application/reports+json'] }),
  rateLimiters.read,
  (req, res) => {
    const report = req.body?.['csp-report'] || req.body || {};
    console.warn('CSP violation:', {
      directive: report['effective-directive'] || report.effectiveDirective,
      blocked: safeReportedUrl(report['blocked-uri'] || report.blockedURL),
      document: safeReportedUrl(report['document-uri'] || report.documentURL)
    });
    return res.status(204).end();
  }
);
app.get('/api/auth/status', rateLimiters.read, authentication.status);
app.post('/api/auth/login', rateLimiters.sessionCreate, authentication.login);
app.post('/api/auth/logout', rateLimiters.read, authentication.logout);
app.use('/api', authentication.requireAuth);
app.use('/download-word', authentication.requireAuth);
io.use(authentication.authenticateSocket);

function createSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function getRequestSessionToken(req) {
  return (
    req.get?.('x-session-token') ||
    req.body?.sessionToken ||
    req.query?.sessionToken ||
    ''
  );
}

function isSessionAuthorized(sessionId, token) {
  const meta = sessionMeta.get(sessionId);
  return evaluateSessionAccess({
    sessionMeta: meta,
    userId: meta?.ownerId,
    sessionToken: token
  }).allowed;
}

function requireSessionAccess(req, res, sessionId = req.params?.id || req.body?.sessionId) {
  const result = evaluateSessionAccess({
    sessionMeta: sessionId ? sessionMeta.get(sessionId) : null,
    userId: req.user?.id,
    sessionToken: getRequestSessionToken(req)
  });
  if (!result.allowed) {
    res.status(result.status).json({ error: result.reason });
    return false;
  }

  return true;
}

function getSocketSessionPayload(data) {
  if (typeof data === 'string') {
    return { sessionId: data, sessionToken: '' };
  }
  return {
    sessionId: data?.sessionId,
    sessionToken: data?.sessionToken
  };
}

function requireSocketSessionAccess(socket, data) {
  const { sessionId, sessionToken } = getSocketSessionPayload(data);
  const rememberedToken = socket.data?.sessionTokens?.[sessionId];
  const result = evaluateSessionAccess({
    sessionMeta: sessionId ? sessionMeta.get(sessionId) : null,
    userId: socket.data?.user?.id,
    sessionToken: sessionToken || rememberedToken
  });
  if (!result.allowed) {
    socket.emit("error", { message: result.reason });
    return null;
  }
  return sessionId;
}

// Sessions API: ensure RAML placeholders exist in ramlByApi for provided APIs
app.post('/api/sessions/:id/raml/placeholders', rateLimiters.generation, (req, res) => {
  try {
    const { id } = req.params;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!requireSessionAccess(req, res, id)) return;
    const byApi = sessionRamlByApi.get(id) || {};
    // Also merge into ramlTasks for name display
    const existingTasks = sessionRamlTasks.get(id) || [];
    const taskMap = new Map(existingTasks.map(t => [String(t.id), { id: String(t.id), name: String(t.name || t.id), description: String(t.description || '') }]));
    let changed = false;
    for (const it of items) {
      if (!it || !it.id) continue;
      const key = String(it.id);
      if (!(key in byApi)) { byApi[key] = ''; changed = true; }
      if (it.name) taskMap.set(key, { id: key, name: String(it.name), description: String(it.description || '') });
    }
    if (changed) sessionRamlByApi.set(id, byApi);
    sessionRamlTasks.set(id, Array.from(taskMap.values()));
    saveStore();
    return res.json({ success: true, ramlByApi: byApi, tasks: Array.from(taskMap.values()) });
  } catch (e) {
    console.error('❌ Error setting RAML placeholders:', e);
    return res.status(500).json({ error: 'Failed to set RAML placeholders' });
  }
});
// Sessions API: set/merge RAML task list (APIs to generate) for a session
app.post('/api/sessions/:id/raml/tasks', rateLimiters.generation, (req, res) => {
  try {
    const { id } = req.params;
    const tasks = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
    if (!requireSessionAccess(req, res, id)) return;
    const existing = sessionRamlTasks.get(id) || [];
    const byId = new Map(existing.map(t => [String(t.id), { id: t.id, name: t.name, description: t.description || '' }]));
    for (const t of tasks) {
      if (!t || !t.id || !t.name) continue;
      byId.set(String(t.id), { id: String(t.id), name: String(t.name), description: String(t.description || '') });
    }
    const merged = Array.from(byId.values());
    sessionRamlTasks.set(id, merged);
    saveStore();
    return res.json({ success: true, tasks: merged });
  } catch (e) {
    console.error('❌ Error setting RAML tasks:', e);
    return res.status(500).json({ error: 'Failed to set RAML tasks' });
  }
});

// Ensure RAML tasks are persisted once when first generated by the RAML agent
app.post('/api/sessions/:id/raml/tasks/ensure', rateLimiters.generation, (req, res) => {
  try {
    const { id } = req.params;
    const tasks = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
    if (!requireSessionAccess(req, res, id)) return;
    const current = sessionRamlTasks.get(id) || [];
    if (current.length === 0 && tasks.length > 0) {
      // Persist tasks and create placeholders for any missing api ids
      const byApi = sessionRamlByApi.get(id) || {};
      for (const t of tasks) {
        if (!t || !t.id) continue;
        const key = String(t.id);
        if (!(key in byApi)) byApi[key] = '';
      }
      sessionRamlByApi.set(id, byApi);
      sessionRamlTasks.set(id, tasks.map(t => ({ id: String(t.id), name: String(t.name || t.id), description: String(t.description || '') })));
      const meta = sessionMeta.get(id);
      if (meta) { meta.updatedAt = new Date().toISOString(); sessionMeta.set(id, meta); }
      saveStore();
      return res.json({ success: true, ensured: true, tasks: sessionRamlTasks.get(id), ramlByApi: byApi });
    }
    return res.json({ success: true, ensured: false, tasks: current });
  } catch (e) {
    console.error('❌ Error ensuring RAML tasks:', e);
    return res.status(500).json({ error: 'Failed to ensure RAML tasks' });
  }
});

// Sessions API: add documentation task types (planned docs) for a session
app.post('/api/sessions/:id/docs/tasks', rateLimiters.generation, (req, res) => {
  try {
    const { id } = req.params;
    let types = req.body?.types;
    if (!Array.isArray(types)) types = typeof types === 'string' ? [types] : [];
    if (!requireSessionAccess(req, res, id)) return;
    const existing = new Set(sessionDocTasks.get(id) || []);
    for (const t of types) {
      if (t && String(t).trim()) existing.add(String(t).trim().toUpperCase());
    }
    const merged = Array.from(existing.values());
    sessionDocTasks.set(id, merged);
    saveStore();
    return res.json({ success: true, types: merged });
  } catch (e) {
    console.error('❌ Error setting documentation tasks:', e);
    return res.status(500).json({ error: 'Failed to set documentation tasks' });
  }
});

// Store active WebSocket connections per session
const activeConnections = new Map();

// Store conversation history per session
const sessionConversations = new Map();

// Store pending approach selections per session
const pendingApproaches = new Map(); // sessionId -> { approaches, requirements, options }

// Store pending questions per session
const pendingQuestions = new Map(); // sessionId -> { questions, requirements, options }

// Store pending documentation questions (clarifying Q&A) per session
const pendingDocQuestions = new Map(); // sessionId -> { questions, context, requirements, options }

// Store pending journey points per session (waiting for user input after diagram)
const pendingJourneyPoints = new Map(); // sessionId -> { context, architecture, diagram, requirements, options, onProgress }

// Store session outputs for context retrieval
const sessionOutputs = new Map(); // sessionId -> { architecture, raml, diagram, estimation }

// Store per-API RAML content
const sessionRamlByApi = new Map(); // sessionId -> { apiId: ramlContent }

// Store per-API Mule code content
const sessionMuleCodeByApi = new Map(); // sessionId -> { apiId: muleProject }

// Store documentation by type per session
const sessionDocumentsByType = new Map(); // sessionId -> { [docType]: content }

// Store RAML task list (APIs to generate) per session
const sessionRamlTasks = new Map(); // sessionId -> [{id,name,description}]

// Store Documentation task list (doc types planned) per session
const sessionDocTasks = new Map(); // sessionId -> [docType]

// Store user input per session for persistence across tab switches
const sessionUserInput = new Map(); // sessionId -> string (user input text)

// Store session metadata (name, timestamps)
const sessionMeta = new Map(); // sessionId -> { id, name, createdAt, updatedAt }

// Prevent duplicate paid/long-running jobs for the same session.
const sessionJobLocks = new Map(); // `${sessionId}:${jobType}` -> { token, startedAt }

// Track which sessions have had approaches delivered to prevent duplicates
const deliveredApproaches = new Set();

// Buffer progress events when a session has started processing but the
// frontend hasn't yet joined via WebSocket. These buffered events will be
// delivered immediately when the client later emits `join-session`.
const pendingProgressEvents = new Map(); // sessionId -> progressEvent[]
const pendingErrorEvents = new Map(); // sessionId -> errorPayload[]

// Buffer documentation-ready payloads when there's no active socket so
// that the frontend can still receive the generated document once it joins.
const pendingDocumentationReady = new Map(); // sessionId -> { content, docType, message }

function jobLockKey(sessionId, jobType) {
  return `${sessionId}:${String(jobType || 'job').toLowerCase()}`;
}

function beginSessionJob(sessionId, jobType, notifier = {}) {
  const key = jobLockKey(sessionId, jobType);
  const existing = sessionJobLocks.get(key);
  const label = String(jobType || 'Job');
  if (existing) {
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - existing.startedAt) / 1000));
    const message = `${label} is already running for this session. Please wait for it to finish before starting it again.`;
    if (notifier.res) {
      notifier.res.status(409).json({ error: message, jobType: label, elapsedSeconds });
    }
    if (notifier.socket) {
      notifier.socket.emit("error", { message, jobType: label, elapsedSeconds });
      notifier.socket.emit("progress", {
        type: "step",
        agent: label,
        status: "blocked",
        message
      });
    }
    return null;
  }

  const token = Symbol(key);
  sessionJobLocks.set(key, { token, startedAt: Date.now(), jobType: label });
  return () => {
    const current = sessionJobLocks.get(key);
    if (current?.token === token) {
      sessionJobLocks.delete(key);
    }
  };
}

function getProcessJobType({ selectedApproach, questionAnswers, docQuestionAnswers, documentType }) {
  if (documentType || (Array.isArray(docQuestionAnswers) && docQuestionAnswers.length > 0)) {
    return 'Documentation';
  }
  if (selectedApproach || (Array.isArray(questionAnswers) && questionAnswers.length > 0)) {
    return 'Architecture';
  }
  return 'Workflow';
}

function emitSessionError(sessionId, payload = {}) {
  const errorPayload = {
    message: payload.message || 'An error occurred while processing your request.',
    agent: payload.agent,
    provider: payload.provider,
    errorDetails: payload.errorDetails
  };
  const socket = activeConnections.get(sessionId);
  if (socket) {
    socket.emit("error", errorPayload);
    return;
  }
  const buffered = pendingErrorEvents.get(sessionId) || [];
  buffered.push(errorPayload);
  pendingErrorEvents.set(sessionId, buffered);
}

function rejectUnsafeInput(res, value) {
  const result = inspectUserInput(value);
  if (result.allowed) return false;
  return res.status(400).json({
    error: result.reason,
    blockedBy: 'input-guardrail'
  });
}

function rejectOverBudgetRequest(res, value) {
  const result = inspectRequestBudget(value);
  if (result.allowed) return false;
  console.warn('🛡️ Request budget blocked input:', result.details);
  return res.status(413).json({
    error: result.reason,
    blockedBy: result.blockedBy,
    details: result.details
  });
}

function guardOutput(value, context) {
  const result = guardGeneratedValue(value, context);
  if (result.blocked) {
    console.warn(`🛡️ Guardrail blocked ${context}: ${result.reason}`);
  }
  return result;
}

function artifactValidationMessage(validation, fallback = 'Generated artifact failed validation.') {
  const issues = Array.isArray(validation?.issues) ? validation.issues.filter(Boolean) : [];
  return issues.length ? issues.join(' ') : fallback;
}

function sanitizeProgressEvent(event) {
  const result = guardProgressEvent(event);
  if (result.blocked) {
    console.warn(`🛡️ Guardrail sanitized progress event: ${result.reason}`);
    return {
      type: "error",
      agent: event?.agent,
      status: "blocked",
      message: result.reason,
      blockedBy: "output-guardrail"
    };
  }
  return result.event;
}

function safeSocketEmit(socket, eventName, payload) {
  const guarded = guardOutput(payload, `socket:${eventName}`);
  socket.emit(eventName, guarded.value);
  return guarded;
}

function safeSessionOutput(sessionId, outputs, updates, context = 'session output') {
  const guarded = guardOutput(updates, context);
  sessionOutputs.set(sessionId, { ...outputs, ...guarded.value });
  const meta = sessionMeta.get(sessionId);
  if (meta) {
    meta.updatedAt = new Date().toISOString();
    sessionMeta.set(sessionId, meta);
  }
  saveStore();
  if (guarded.blocked) {
    emitSessionError(sessionId, {
      message: guarded.reason,
      agent: 'Security'
    });
  }
  return guarded;
}

// Encrypted persistence and retention for sessions/artifacts
const STORE_DIR = './output/.sessions';
const STORE_FILE = `${STORE_DIR}/store.enc`;
const LEGACY_STORE_FILE = `${STORE_DIR}/store.json`;
const OUTPUT_DIR = './output';
const DATA_ENCRYPTION_KEY = getDataEncryptionKey();

function positiveDays(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const SESSION_RETENTION_DAYS = positiveDays(process.env.SESSION_RETENTION_DAYS, 30);
const ARTIFACT_RETENTION_DAYS = positiveDays(process.env.ARTIFACT_RETENTION_DAYS, 30);
const CLEAR_SESSIONS_ON_START = process.env.CLEAR_SESSIONS_ON_START !== 'false';

function getEffectiveSessionRaml(sessionId, outputs = {}) {
  if (outputs.raml && typeof outputs.raml === 'string' && outputs.raml.trim()) {
    return outputs.raml;
  }

  const ramlMap = sessionRamlByApi.get(sessionId) || {};
  const ramlParts = Object.entries(ramlMap)
    .filter(([, content]) => typeof content === 'string' && content.trim())
    .map(([apiId, content]) => `# RAML for ${apiId}\n${content.trim()}`);

  if (ramlParts.length) return ramlParts.join('\n\n');

  const ramlTasks = sessionRamlTasks.get(sessionId) || [];
  const taskSummary = ramlTasks
    .filter(task => task && (task.name || task.id))
    .map((task, index) => {
      const name = String(task.name || task.id || `API ${index + 1}`).trim();
      const description = task.description ? ` - ${String(task.description).trim()}` : '';
      return `${index + 1}. ${name}${description}`;
    });

  return taskSummary.length
    ? `RAML API topics identified. Full RAML files may be generated selectively by the user.\n${taskSummary.join('\n')}`
    : null;
}

function getDocumentPrerequisiteStatus(sessionId) {
  const outputs = sessionOutputs.get(sessionId) || {};
  const ramlTasks = sessionRamlTasks.get(sessionId) || [];
  if (ramlTasks.length === 0) {
    const ramlByApi = sessionRamlByApi.get(sessionId) || {};
    const derivedTasks = Object.keys(ramlByApi).map((apiId, index) => ({
      id: apiId,
      name: `API ${index + 1}`,
      description: 'RAML topic identified for selective generation'
    }));
    if (derivedTasks.length > 0) {
      sessionRamlTasks.set(sessionId, derivedTasks);
    }
  }
  const effectiveRaml = getEffectiveSessionRaml(sessionId, outputs);
  const missing = [];

  if (!outputs.architecture || !String(outputs.architecture).trim()) missing.push('architecture');
  if (!outputs.estimation || !String(outputs.estimation).trim()) missing.push('estimation');
  if (!effectiveRaml) missing.push('RAML topics');

  return {
    ok: missing.length === 0,
    missing,
    outputs,
    raml: effectiveRaml
  };
}

function emitDocumentationBlocked(sessionId, docType, missing) {
  const message = `Cannot generate ${docType || 'documentation'} yet. Required input missing: ${missing.join(', ')}. Diagram is optional, but architecture, estimation, and RAML topics are required for documents.`;
  const socket = activeConnections.get(sessionId);

  if (socket) {
    socket.emit("documentation-error", { message, docType });
    socket.emit("error", { message });
    socket.emit("progress", {
      type: "step",
      step: 5,
      agent: "Documentation",
      status: "blocked",
      message
    });
  }

  return message;
}

function loadStore() {
  try {
    const { data, source } = readSecureStore({
      encryptedFile: STORE_FILE,
      plaintextFile: LEGACY_STORE_FILE,
      key: DATA_ENCRYPTION_KEY
    });
    if (!data) return;
    // Restore maps
    if (data.sessionMeta) {
      for (const [id, meta] of Object.entries(data.sessionMeta)) sessionMeta.set(id, meta);
    }
    if (data.sessionOutputs) {
      for (const [id, out] of Object.entries(data.sessionOutputs)) sessionOutputs.set(id, out);
    }
    if (data.sessionRamlByApi) {
      for (const [id, rmap] of Object.entries(data.sessionRamlByApi)) sessionRamlByApi.set(id, rmap || {});
    }
    if (data.sessionMuleCodeByApi) {
      for (const [id, mmap] of Object.entries(data.sessionMuleCodeByApi)) sessionMuleCodeByApi.set(id, mmap || {});
    }
    if (data.sessionDocumentsByType) {
      for (const [id, dmap] of Object.entries(data.sessionDocumentsByType)) sessionDocumentsByType.set(id, dmap || {});
    }
    if (data.sessionRamlTasks) {
      for (const [id, tasks] of Object.entries(data.sessionRamlTasks)) sessionRamlTasks.set(id, tasks || []);
    }
    if (data.sessionDocTasks) {
      for (const [id, tasks] of Object.entries(data.sessionDocTasks)) sessionDocTasks.set(id, tasks || []);
    }
    if (data.sessionConversations) {
      for (const [id, conv] of Object.entries(data.sessionConversations)) sessionConversations.set(id, conv || []);
    }
    if (data.sessionUserInput) {
      for (const [id, input] of Object.entries(data.sessionUserInput)) sessionUserInput.set(id, input || '');
    }
    console.log(`📦 Loaded ${source} session store: sessions=${sessionMeta.size}`);
    if (source === 'plaintext' && DATA_ENCRYPTION_KEY) saveStore();
  } catch (e) {
    console.error('❌ Failed to load session store:', e?.message || e);
    if (process.env.NODE_ENV === 'production') throw e;
  }
}

function saveStore() {
  try {
    const data = {
      sessionMeta: Object.fromEntries(sessionMeta.entries()),
      sessionOutputs: Object.fromEntries(sessionOutputs.entries()),
      sessionRamlByApi: Object.fromEntries(sessionRamlByApi.entries()),
      sessionMuleCodeByApi: Object.fromEntries(sessionMuleCodeByApi.entries()),
      sessionDocumentsByType: Object.fromEntries(sessionDocumentsByType.entries()),
      sessionConversations: Object.fromEntries(sessionConversations.entries()),
      sessionRamlTasks: Object.fromEntries(sessionRamlTasks.entries()),
      sessionDocTasks: Object.fromEntries(sessionDocTasks.entries()),
      sessionUserInput: Object.fromEntries(sessionUserInput.entries())
    };
    writeSecureStore({
      encryptedFile: STORE_FILE,
      plaintextFile: LEGACY_STORE_FILE,
      data,
      key: DATA_ENCRYPTION_KEY
    });
  } catch (e) {
    console.warn('⚠️ Failed to save session store:', e?.message || e);
  }
}

function clearSessionState() {
  sessionMeta.clear();
  sessionConversations.clear();
  sessionOutputs.clear();
  sessionRamlByApi.clear();
  sessionMuleCodeByApi.clear();
  sessionDocumentsByType.clear();
  sessionRamlTasks.clear();
  sessionDocTasks.clear();
  sessionUserInput.clear();
  pendingApproaches.clear();
  pendingQuestions.clear();
  pendingDocQuestions.clear();
  pendingJourneyPoints.clear();
  deliveredApproaches.clear();
  pendingProgressEvents.clear();
  pendingErrorEvents.clear();
  pendingDocumentationReady.clear();
  sessionJobLocks.clear();
}

function purgeSessionData(sessionId) {
  sessionMeta.delete(sessionId);
  sessionConversations.delete(sessionId);
  sessionOutputs.delete(sessionId);
  sessionRamlByApi.delete(sessionId);
  sessionMuleCodeByApi.delete(sessionId);
  sessionDocumentsByType.delete(sessionId);
  sessionRamlTasks.delete(sessionId);
  sessionDocTasks.delete(sessionId);
  sessionUserInput.delete(sessionId);
  pendingApproaches.delete(sessionId);
  pendingQuestions.delete(sessionId);
  pendingDocQuestions.delete(sessionId);
  pendingJourneyPoints.delete(sessionId);
  deliveredApproaches.delete(sessionId);
  pendingProgressEvents.delete(sessionId);
  pendingErrorEvents.delete(sessionId);
  pendingDocumentationReady.delete(sessionId);
  for (const key of Array.from(sessionJobLocks.keys())) {
    if (key.startsWith(`${sessionId}:`)) sessionJobLocks.delete(key);
  }
}

function clearSessionWorkData(sessionId) {
  sessionConversations.delete(sessionId);
  sessionOutputs.delete(sessionId);
  sessionRamlByApi.delete(sessionId);
  sessionMuleCodeByApi.delete(sessionId);
  sessionDocumentsByType.delete(sessionId);
  sessionRamlTasks.delete(sessionId);
  sessionDocTasks.delete(sessionId);
  sessionUserInput.set(sessionId, '');
  pendingApproaches.delete(sessionId);
  pendingQuestions.delete(sessionId);
  pendingDocQuestions.delete(sessionId);
  pendingJourneyPoints.delete(sessionId);
  deliveredApproaches.delete(sessionId);
  pendingProgressEvents.delete(sessionId);
  pendingErrorEvents.delete(sessionId);
  pendingDocumentationReady.delete(sessionId);
  for (const key of Array.from(sessionJobLocks.keys())) {
    if (key.startsWith(`${sessionId}:`)) sessionJobLocks.delete(key);
  }
  const meta = sessionMeta.get(sessionId);
  if (meta) {
    meta.updatedAt = new Date().toISOString();
    sessionMeta.set(sessionId, meta);
  }
}

function removeExpiredSessions(now = Date.now()) {
  const cutoff = now - SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const expired = [];
  for (const [sessionId, meta] of sessionMeta.entries()) {
    const lastActivity = Date.parse(meta?.updatedAt || meta?.createdAt || '');
    if (!Number.isFinite(lastActivity) || lastActivity < cutoff) expired.push(sessionId);
  }
  for (const sessionId of expired) purgeSessionData(sessionId);
  if (expired.length) {
    saveStore();
    console.log(`🧹 Removed ${expired.length} expired session(s)`);
  }
  return expired.length;
}

function removeExpiredGeneratedArtifacts(now = Date.now()) {
  if (!fs.existsSync(OUTPUT_DIR)) return 0;
  const cutoff = now - ARTIFACT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const entry of fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
    if (entry.name === '.sessions' || entry.name === 'llm_token_usage.csv') continue;
    const target = path.join(OUTPUT_DIR, entry.name);
    const stats = fs.statSync(target);
    if (stats.mtimeMs < cutoff) {
      fs.rmSync(target, { recursive: entry.isDirectory(), force: true });
      removed += 1;
    }
  }
  if (removed) console.log(`🧹 Removed ${removed} expired generated artifact(s)`);
  return removed;
}

function runRetentionCleanup() {
  try {
    removeExpiredSessions();
    removeExpiredGeneratedArtifacts();
  } catch (error) {
    console.warn('⚠️ Retention cleanup failed:', error?.message || error);
  }
}

loadStore();
if (CLEAR_SESSIONS_ON_START) {
  const loadedSessionCount = sessionMeta.size;
  clearSessionState();
  saveStore();
  if (loadedSessionCount) {
    console.log(`🧹 Cleared ${loadedSessionCount} persisted session(s) on app startup`);
  } else {
    console.log('🧹 Session store is clean on app startup');
  }
}
runRetentionCleanup();
setInterval(runRetentionCleanup, 24 * 60 * 60 * 1000).unref();

// Add this to your server/index.js
app.get('/api/models/available', rateLimiters.read, async (req, res) => {
  try {
    const models = {
      gemini: !!(envValue('GEMINI_API_KEY') || envValue('GEMINI_API_KEY_1')),
      groq: !!envValue('GROQ_API_KEY'),
      anthropic: !!envValue('ANTHROPIC_API_KEY'),
      openai: !!envValue('OPENAI_API_KEY'),
      openrouter: !!envValue('OPENROUTER_API_KEY')
    };
    res.json(models);
  } catch (error) {
    console.error('Error checking model availability:', error);
    res.status(500).json({ error: 'Failed to check model availability' });
  }
});

// Sessions API: list sessions
app.get('/api/sessions', rateLimiters.read, (req, res) => {
  try {
    const sessions = Array.from(sessionMeta.values())
      .filter(s => s.ownerId === req.user.id)
      .map(s => ({
        id: s.id,
        name: s.name,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        sessionToken: s.sessionToken
      }));
    return res.json({ sessions });
  } catch (e) {
    console.error('❌ Error listing sessions:', e);
    return res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// Sessions API: create session
app.post('/api/sessions', rateLimiters.sessionCreate, (req, res) => {
  try {
    const { name } = (req.body || {});
    const id = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date().toISOString();
    const sessionToken = createSessionToken();
    const ownerSessionCount = Array.from(sessionMeta.values())
      .filter(session => session.ownerId === req.user.id).length;
    const meta = {
      id,
      name: (name && String(name).trim()) || `Tab ${ownerSessionCount + 1}`,
      createdAt: now,
      updatedAt: now,
      sessionToken,
      ownerId: req.user.id
    };
    sessionMeta.set(id, meta);
    sessionConversations.set(id, []);
    sessionOutputs.set(id, {});
    sessionRamlByApi.set(id, {});
    sessionDocumentsByType.set(id, {});
    saveStore();
    return res.json(meta);
  } catch (e) {
    console.error('❌ Error creating session:', e);
    return res.status(500).json({ error: 'Failed to create session' });
  }
});

// Sessions API: rename session
app.patch('/api/sessions/:id', rateLimiters.generation, (req, res) => {
  try {
    const { id } = req.params;
    const { name } = (req.body || {});
    if (!requireSessionAccess(req, res, id)) return;
    const meta = sessionMeta.get(id);
    if (!meta) return res.status(404).json({ error: 'Session not found' });
    if (name && String(name).trim()) {
      meta.name = String(name).trim();
      meta.updatedAt = new Date().toISOString();
      sessionMeta.set(id, meta);
    }
    saveStore();
    return res.json(meta);
  } catch (e) {
    console.error('❌ Error renaming session:', e);
    return res.status(500).json({ error: 'Failed to rename session' });
  }
});

// Sessions API: get all outputs for a session
app.get('/api/sessions/:id/outputs', rateLimiters.read, (req, res) => {
  try {
    const { id } = req.params;
    console.log(`📊 Getting outputs for session ${id}`);
    if (!requireSessionAccess(req, res, id)) return;
    let outputs = sessionOutputs.get(id) || {};
    console.log(`📊 Current sessionOutputs for ${id}:`, summarizeOutputs(outputs));
    const documentsByType = sessionDocumentsByType.get(id) || {};
    let ramlByApi = sessionRamlByApi.get(id) || {};
    let ramlTasks = sessionRamlTasks.get(id) || [];
    const docTasks = sessionDocTasks.get(id) || [];

    // If general output is not set but we have conversations, use the latest conversation answer
    if (!outputs.general) {
      const conversations = sessionConversations.get(id) || [];
      console.log(`🔍 Checking conversations for session ${id}: ${conversations.length} conversations found`);
      if (conversations.length > 0) {
        const latestConversation = conversations[conversations.length - 1];
        if (latestConversation && latestConversation.answer) {
          console.log(`🔄 Populating general output from conversation for session ${id}`, {
            answerLength: latestConversation.answer.length
          });
          outputs = { ...outputs, general: latestConversation.answer };
          // Also update sessionOutputs for future requests
          sessionOutputs.set(id, outputs);
          // Touch session meta and persist store
          const meta = sessionMeta.get(id);
          if (meta) {
            meta.updatedAt = new Date().toISOString();
            sessionMeta.set(id, meta);
          }
          saveStore();
          console.log(`✅ General output populated and persisted for session ${id}`);
        } else {
          console.log(`⚠️ Latest conversation for session ${id} has no answer`);
        }
      } else {
        console.log(`ℹ️ No conversations found for session ${id}`);
      }
    } else {
      console.log(`ℹ️ General output already exists for session ${id}`);
    }

    // Do not auto-extract API names. Only return what has been explicitly saved.
    return res.json({ outputs, documentsByType, ramlByApi, ramlTasks, docTasks });
  } catch (e) {
    console.error('❌ Error getting session outputs:', e);
    return res.status(500).json({ error: 'Failed to get session outputs' });
  }
});

// Sessions API: save user input for a session
app.post('/api/sessions/:id/input', rateLimiters.generation, (req, res) => {
  try {
    const { id } = req.params;
    const { input } = req.body;
    if (!requireSessionAccess(req, res, id)) return;
    sessionUserInput.set(id, input || '');
    // Touch session meta to update timestamp
    const meta = sessionMeta.get(id);
    if (meta) {
      meta.updatedAt = new Date().toISOString();
      sessionMeta.set(id, meta);
    }
    saveStore();
    return res.json({ success: true });
  } catch (e) {
    console.error('❌ Error saving session input:', e);
    return res.status(500).json({ error: 'Failed to save session input' });
  }
});

// Sessions API: get user input for a session
app.get('/api/sessions/:id/input', rateLimiters.read, (req, res) => {
  try {
    const { id } = req.params;
    if (!requireSessionAccess(req, res, id)) return;
    const input = sessionUserInput.get(id) || '';
    return res.json({ input });
  } catch (e) {
    console.error('❌ Error getting session input:', e);
    return res.status(500).json({ error: 'Failed to get session input' });
  }
});

// Sessions API: update session outputs
app.patch('/api/sessions/:id/outputs', rateLimiters.generation, (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    if (!requireSessionAccess(req, res, id)) return;

    console.log(`🔄 Updating session outputs for ${id}:`, summarizeOutputs(updates));
    const existingOutputs = sessionOutputs.get(id) || {};
    const updatedOutputs = { ...existingOutputs, ...updates };
    sessionOutputs.set(id, updatedOutputs);

    // Touch session meta and persist store
    const meta = sessionMeta.get(id);
    if (meta) {
      meta.updatedAt = new Date().toISOString();
      sessionMeta.set(id, meta);
    }
    saveStore();
    console.log(`✅ Session outputs updated and persisted for ${id}`);

    return res.json({ success: true, outputs: updatedOutputs });
  } catch (e) {
    console.error('❌ Error updating session outputs:', e);
    return res.status(500).json({ error: 'Failed to update session outputs' });
  }
});

// Sessions API: delete a session and all artifacts
app.delete('/api/sessions/:id', rateLimiters.generation, (req, res) => {
  try {
    const { id } = req.params;
    if (!requireSessionAccess(req, res, id)) return;

    purgeSessionData(id);

    // Disconnect socket if active
    const socket = activeConnections.get(id);
    if (socket) {
      try { socket.leave(id); } catch {}
      activeConnections.delete(id);
    }

    saveStore();
    return res.json({ success: true });
  } catch (e) {
    console.error('❌ Error deleting session:', e);
    return res.status(500).json({ error: 'Failed to delete session' });
  }
});

// API endpoint to process user input (routes to appropriate agent)
app.post("/api/process", rateLimiters.llmProcess, async (req, res) => {
  const {
    input,
    apiName,
    saveFiles,
    sessionId: providedSessionId,
    selectedApproach,
    questionAnswers,
    provider,
    model,
    documentType,
    ramlTasks,
    tools,
    approachName,
    approachDescription,
    sessionToken: providedSessionToken
  } = req.body;

  console.log("📥 Received input:");
  console.log("  Input length:", input?.length || 0);
  console.log("  API Name:", apiName || "MuleSoftAPI");
  console.log("  Save Files:", saveFiles !== false);
  console.log("  Provided Session ID:", providedSessionId || "none");
  console.log("  Selected Approach:", selectedApproach || "none");
  console.log("  Provider:", provider || "default(.env)");
  console.log("  Model:", model || "default");
  console.log("  Question Answers:", questionAnswers ? `${questionAnswers.length} answers` : "none");
  console.log("  Document Type:", documentType || "none");
  console.log("  Doc Question Answers:", req.body.docQuestionAnswers ? req.body.docQuestionAnswers.length : "none");
  console.log("  Tools:", tools ? JSON.stringify(tools) : "none");
  if (req.body.docQuestionAnswers) {
    console.log("  📄 Doc answers details:", summarizeDocAnswers(req.body.docQuestionAnswers));
  }

  // Allow empty input if selectedApproach, questionAnswers, or docQuestionAnswers is provided (continuing workflow)
  const isContinuationRequest =
    !!selectedApproach ||
    (Array.isArray(questionAnswers) && questionAnswers.length > 0) ||
    (Array.isArray(req.body.docQuestionAnswers) && req.body.docQuestionAnswers.length > 0);

  if (!isContinuationRequest && (!input || !input.trim())) {
    return res.status(400).json({ error: "Input is required" });
  }

  if (rejectOverBudgetRequest(res, req.body)) {
    return;
  }

  // Use provided sessionId or create new one
  const sessionId = providedSessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  let sessionToken = providedSessionToken || getRequestSessionToken(req);

  // Initialize conversation history if new session
  if (!sessionConversations.has(sessionId)) {
    sessionConversations.set(sessionId, []);
  }

  // Ensure session metadata and containers are initialized
  if (!sessionMeta.has(sessionId)) {
    const now = new Date().toISOString();
    sessionToken = sessionToken || createSessionToken();
    const ownerSessionCount = Array.from(sessionMeta.values())
      .filter(session => session.ownerId === req.user.id).length;
    sessionMeta.set(sessionId, {
      id: sessionId,
      name: `Tab ${ownerSessionCount + 1}`,
      createdAt: now,
      updatedAt: now,
      sessionToken,
      ownerId: req.user.id
    });
  } else if (
    sessionMeta.get(sessionId)?.ownerId !== req.user.id ||
    !isSessionAuthorized(sessionId, sessionToken)
  ) {
    return res.status(403).json({ error: 'Invalid or missing session token' });
  }
  if (!sessionOutputs.has(sessionId)) sessionOutputs.set(sessionId, {});
  if (!sessionRamlByApi.has(sessionId)) sessionRamlByApi.set(sessionId, {});
  if (!sessionDocumentsByType.has(sessionId)) sessionDocumentsByType.set(sessionId, {});
  if (!sessionRamlTasks.has(sessionId)) sessionRamlTasks.set(sessionId, []);
  if (!sessionDocTasks.has(sessionId)) sessionDocTasks.set(sessionId, []);

  console.log("  Session ID:", sessionId);
  console.log("  Conversation history length:", sessionConversations.get(sessionId).length);

  if (!isContinuationRequest) {
    console.log(`🧹 Clearing previous work data for new prompt in session ${sessionId}`);
    clearSessionWorkData(sessionId);
    saveStore();
  }

  if (rejectUnsafeInput(res, { input, questionAnswers, docQuestionAnswers: req.body.docQuestionAnswers, approachName, approachDescription })) {
    return;
  }

  const releaseProcessJob = beginSessionJob(sessionId, getProcessJobType({
    selectedApproach,
    questionAnswers,
    docQuestionAnswers: req.body.docQuestionAnswers,
    documentType
  }), { res });
  if (!releaseProcessJob) return;

  res.json({ sessionId, sessionToken: sessionMeta.get(sessionId)?.sessionToken, message: "Processing started" });

  // Wait a bit for WebSocket connection to be established
  setTimeout(async () => {
    try {
    // Get conversation history for this session
    const conversationHistory = sessionConversations.get(sessionId) || [];

    // Check if this is documentation question answers submission (new format)
    const { docQuestionAnswers } = req.body;
    if (docQuestionAnswers && Array.isArray(docQuestionAnswers)) {
      const pending = pendingDocQuestions.get(sessionId);
      if (!pending) {
        const socket = activeConnections.get(sessionId);
        if (socket) {
          socket.emit("error", { message: "No pending documentation questions found. Please start a new request." });
        }
        return;
      }
      console.log(`📄 Processing documentation answers (docQuestionAnswers format) for session: ${sessionId}`);
      const socket = activeConnections.get(sessionId);
      await processDocumentationWithAnswers(sessionId, pending, docQuestionAnswers, apiName, saveFiles, provider, model, socket);
      return;
    }

    // Check if this is question answers submission
    if (questionAnswers && Array.isArray(questionAnswers)) {
      // Check if we have pending documentation questions first
      const pendingDoc = pendingDocQuestions.get(sessionId);
      if (pendingDoc) {
        console.log(`📄 Processing documentation answers (questionAnswers format) for session: ${sessionId}`);
        const socket = activeConnections.get(sessionId);
        await processDocumentationWithAnswers(sessionId, pendingDoc, questionAnswers, apiName, saveFiles, provider, model, socket);
        return;
      }

      // Otherwise, handle as regular clarifying questions
      const pending = pendingQuestions.get(sessionId);
      if (!pending) {
        const socket = activeConnections.get(sessionId);
        if (socket) {
          socket.emit("error", { message: "No pending questions found. Please start a new request." });
        }
        return;
      }

      // Validate answers
      await validateAndProcessQuestions(sessionId, questionAnswers, pending, apiName, saveFiles, provider, model);
      return;
    }

    // Check if this is an approach selection
    if (selectedApproach) {
      const socket = activeConnections.get(sessionId);
      const pending = pendingApproaches.get(sessionId);
      if (!pending) {     
        if (socket) {
          socket.emit("error", { message: "No pending approaches found. Please start a new request." });
        }
        return;
      }

      const selectedApproachNumber = parseInt(selectedApproach);
      let approachesForSelection = Array.isArray(pending.approaches) ? [...pending.approaches] : [];

      if (approachName && approachDescription) {
        const submittedApproach = {
          number: selectedApproachNumber,
          name: String(approachName).trim(),
          description: String(approachDescription).trim(),
          fullText: `Title: ${String(approachName).trim()}\nDescription: ${String(approachDescription).trim()}`,
          isCustom: !approachesForSelection.some(a => a.number === selectedApproachNumber),
          isEdited: approachesForSelection.some(a => a.number === selectedApproachNumber)
        };

        const existingIndex = approachesForSelection.findIndex(a => a.number === selectedApproachNumber);
        if (existingIndex >= 0) {
          approachesForSelection[existingIndex] = {
            ...approachesForSelection[existingIndex],
            ...submittedApproach,
            fullText: submittedApproach.fullText
          };
        } else {
          approachesForSelection.push(submittedApproach);
        }
      }

      // Validate approach number
      const validApproach = approachesForSelection.find(a => a.number === selectedApproachNumber);
      if (!validApproach) {
        if (socket) {
          socket.emit("error", {
            message: `Invalid approach number: ${selectedApproach}. Available approaches: ${approachesForSelection.map(a => a.number).join(', ')}`
          });
        }
        return;
      }

      // Continue with selected approach
      const continuationProvider = normalizeProvider(provider || pending.options.provider);
      console.log(`🔁 Continuing selected approach with provider: ${continuationProvider}`);
      await processInput(sessionId, pending.requirements, {
        ...pending.options,
        provider: continuationProvider,
        model: model || pending.options.model,
        selectedApproach: selectedApproachNumber,
        approaches: approachesForSelection,
        apiName: apiName || pending.options.apiName || "MuleSoftAPI",
        saveFiles: saveFiles !== false,
        tools: tools || null
      }, 0, socket);

      // Clear pending approaches and delivery tracking
      pendingApproaches.delete(sessionId);
      deliveredApproaches.delete(sessionId);
    } else {
      // Check if this is a direct documentation request (has documentType)
      const socket = activeConnections.get(sessionId);
      if (documentType) {
        if (Array.isArray(ramlTasks) && ramlTasks.length > 0) {
          const existingTasks = sessionRamlTasks.get(sessionId) || [];
          const byId = new Map(existingTasks.map(task => [String(task.id || task.name), task]));
          for (const task of ramlTasks) {
            if (!task || (!task.id && !task.name)) continue;
            const id = String(task.id || task.name);
            byId.set(id, {
              id,
              name: String(task.name || id),
              description: String(task.description || '')
            });
          }
          sessionRamlTasks.set(sessionId, Array.from(byId.values()));
          saveStore();
        }
        console.log(`📄 Direct documentation request detected: ${documentType} for session ${sessionId}`);
        console.log(`📄 Request details:`, {
          inputLength: input?.length || 0,
          documentType,
          apiName,
          provider
        });
        await triggerDocumentationAgent(sessionId, input, documentType, {
          provider: provider,
          model: model,
          apiName: apiName || 'MuleSoftAPI'
        });
        return;
      } else {
        // Process input with AgentManager (routes automatically)
       //constsocket = activeConnections.get(sessionId);
        await processInput(sessionId, input.trim(), {
          apiName: apiName || "MuleSoftAPI",
          saveFiles: saveFiles !== false,
          conversationHistory: conversationHistory, // Pass conversation history
          provider: normalizeProvider(provider),
          model
        }, 0, socket);
      }
      }
    } finally {
      releaseProcessJob();
    }
  }, 500);
});

// Download endpoint for Word documents generated by DocumentationAgent
app.get('/download-word/:sessionId', rateLimiters.download, async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!requireSessionAccess(req, res, sessionId)) return;
    const store = global.wordFileStore;
    if (!store || !store.has(sessionId)) {
      return res.status(404).json({ error: 'No Word document available for this session.' });
    }
    const { data, filename, contentType } = store.get(sessionId);
    res.setHeader('Content-Type', contentType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    const fname = String(filename || 'document.docx');
    const asciiSafeDownload = fname
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/[\r\n]+/g, ' ')
      .replace(/[^\x20-\x7E]/g, '-')
      .replace(/\s{2,}/g, ' ')
      .trim();
    res.setHeader('Content-Disposition', `attachment; filename="${asciiSafeDownload}"`);
    return res.send(data);
  } catch (err) {
    console.error('Error serving Word download:', err);
    return res.status(500).json({ error: 'Failed to download file' });
  }
});

// API endpoint to convert markdown to Word document
app.post('/api/convert-to-word', rateLimiters.generation, async (req, res) => {
  try {
    const { content, sessionId, docType, architecture, raml } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'Content is required' });
    }
    if (sessionId && sessionId !== 'download-session' && !requireSessionAccess(req, res, sessionId)) return;

    console.log(`📄 Converting document to Word for session: ${sessionId || 'unknown'}`);

    // Normalize markdown for better Word organization
    const normalizeMarkdown = (md) => {
      if (!md || typeof md !== 'string') return '';
      let text = md.replace(/\r\n/g, '\n');

      // Trim excessive leading/trailing whitespace
      text = text.trim();

      // Ensure there is a title at the top
      const lines = text.split('\n');
      if (!/^\s*#\s+/.test(lines[0] || '')) {
        // Use first non-empty line as title if it looks like a header, else add a default
        const firstContent = lines.find(l => l.trim().length > 0) || 'Document';
        lines.unshift(`# ${firstContent.replace(/^#+\s*/, '')}`);
      }

      // Re-join for further normalization
      text = lines.join('\n');

      // Normalize heading spacing: ensure blank line before and after headings
      text = text
        // Ensure a blank line before headings (except at start)
        .replace(/([^\n])\n(#{1,6}\s+)/g, '$1\n\n$2')
        // Ensure a blank line after headings
        .replace(/(#{1,6}[^\n]*)(\n(?!\n))/g, '$1\n\n');

      // Normalize horizontal rules
      text = text.replace(/\n\s*-{3,}\s*\n/g, '\n\n---\n\n');

      // Normalize bullets: ensure a space after dash/asterisk and consistent indentation
      text = text
        .replace(/\n\s*[-*]\s*/g, (m) => '\n- ')
        .replace(/\n\s*\d+\.\s*/g, (m) => '\n1. ');

      // Collapse 3+ blank lines to 2
      text = text.replace(/\n{3,}/g, '\n\n');

      return text.trim() + '\n';
    };

    const normalizedContent = normalizeMarkdown(content);
    console.log('🧹 Normalized markdown length:', normalizedContent.length);

    // Import the doc service
    const { convertMarkdownToWord } = await import('../src/documentation/doc_service.js');

    // Convert markdown to Word
    const result = await convertMarkdownToWord(normalizedContent);

    if (result.success) {
      // Build human-readable filename: "{Display} for {Subject} – {Primary}.docx"
      const rawType = (docType || 'Document').toString().toUpperCase();
      const displayMap = {
        BRD: 'Business Requirements Document',
        HLD: 'High-Level Integration Design (HLD)',
        WBS: 'Work Breakdown Structure',
        TDD: 'Technical Design Document',
        TEST_PLAN: 'Test Plan'
      };
      const displayTitle = displayMap[rawType] || (rawType === 'TEST_PLAN' ? 'Test Plan' : (docType || 'Document'));

      const textPool = `${architecture || ''}\n${raml || ''}`;
      const preferredEntities = [
        // Healthcare
        { re: /(electronic\s+medical\s+records?|\bEMR\b)/i, label: 'EMR' },
        { re: /(electronic\s+health\s+records?|\bEHR\b)/i, label: 'EHR' },
        { re: /online\s+booking\s+system/i, label: 'Online Booking System' },
        { re: /patient\s+appointment(s)?/i, label: 'Patient Appointment' },
        { re: /appointment(s)?/i, label: 'Appointment' },
        { re: /patient\b/i, label: 'Patient' },
        { re: /doctor\b|physician\b/i, label: 'Doctor' },
        { re: /hipaa/i, label: 'HIPAA' },
        // Insurance
        { re: /claim\s*status/i, label: 'Claim Status' },
        { re: /claims?/i, label: 'Claim' },
        { re: /policy|underwriting/i, label: 'Policy' },
        // HR
        { re: /employee\s+onboarding/i, label: 'Employee Onboarding' },
        { re: /active\s+directory|\bAD\b/i, label: 'Active Directory' },
        // Logistics
        { re: /shipment\s+tracking/i, label: 'Shipment Tracking' },
        { re: /gps\b/i, label: 'GPS' },
        { re: /dashboard/i, label: 'Dashboard' },
        // Telecom
        { re: /plan\s+upgrade/i, label: 'Plan Upgrade' },
        { re: /billing\s+system/i, label: 'Billing System' },
        { re: /self[-\s]?service\s+portal/i, label: 'Self-Service Portal' },
        // Manufacturing
        { re: /inventory\s+sync|inventory\s+levels?|inventory/i, label: 'Inventory Sync' },
        { re: /warehouse\s+system/i, label: 'Warehouse System' },
        // Education
        { re: /student\s+enrollment/i, label: 'Student Enrollment' },
        { re: /admissions?\s+portal/i, label: 'Admissions Portal' },
        { re: /student\s+information\s+system|\bSIS\b/i, label: 'SIS' },
        // Travel
        { re: /booking\s+confirmation/i, label: 'Booking Confirmation' },
        // Retail
        { re: /loyalty\s+points?/i, label: 'Loyalty Points' },
        { re: /pos\b|point\s+of\s+sale/i, label: 'POS' },
        { re: /rewards?\s+platform/i, label: 'Rewards Platform' },
        // Real Estate
        { re: /lead\s+management/i, label: 'Lead Management' },
        // Generic portals/CRMs
        { re: /customer\s+portal/i, label: 'Customer Portal' },
        { re: /backend\s+processing/i, label: 'Backend Processing' },
        { re: /website/i, label: 'Website' },
        { re: /crm\b/i, label: 'CRM' }
      ];
      const foundPreferred = [];
      for (const ent of preferredEntities) {
        const match = textPool.match(ent.re);
        if (match && !foundPreferred.includes(ent.label)) foundPreferred.push(ent.label);
      }

      const sysRegex = /(salesforce|sap|oracle|workday|netsuite|servicenow|dynamics|shopify|magento|kafka|rabbitmq|db|database|mysql|postgres|mongodb|s3|ftp|sftp|http|soap|rest|emr|ehr)/ig;
      const prettyMap = {
        salesforce: 'Salesforce', sap: 'SAP', oracle: 'Oracle', workday: 'Workday', netsuite: 'NetSuite',
        servicenow: 'ServiceNow', dynamics: 'Dynamics', shopify: 'Shopify', magento: 'Magento', kafka: 'Kafka',
        rabbitmq: 'RabbitMQ', db: 'Database', database: 'Database', mysql: 'MySQL', postgres: 'Postgres',
        mongodb: 'MongoDB', s3: 'S3', ftp: 'FTP', sftp: 'SFTP', http: 'HTTP', soap: 'SOAP', rest: 'REST',
        emr: 'EMR', ehr: 'EHR'
      };
      const systemsOrdered = [];
      let m;
      while ((m = sysRegex.exec(textPool)) !== null) {
        const key = String(m[1] || '').toLowerCase();
        const label = prettyMap[key] || (key.charAt(0).toUpperCase() + key.slice(1));
        if (!systemsOrdered.includes(label)) systemsOrdered.push(label);
      }
      const lowValue = new Set(['HTTP','REST','SOAP']);
      const systemsFiltered = systemsOrdered.filter(l => !lowValue.has(l) || systemsOrdered.length <= 1);

      // Choose a subject and a primary endpoint
      const subjectsPriority = [
        'Patient Appointment','Appointment','Patient','Doctor','Claim Status','Claim','Policy','Employee Onboarding',
        'Shipment Tracking','Plan Upgrade','Inventory Sync','Inventory','Student Enrollment','Booking Confirmation',
        'Loyalty Points','Lead Management'
      ];
      const subject = subjectsPriority.find(s => foundPreferred.includes(s));

      const endpointPreference = [
        'Online Booking System','EMR','EHR','Active Directory','Customer Portal','Backend Processing','Billing System',
        'Warehouse System','Admissions Portal','SIS','Website','CRM','POS','Rewards Platform'
      ];
      let primary = endpointPreference.find(e => foundPreferred.includes(e));
      if (!primary) primary = systemsFiltered[0] || systemsOrdered[0] || null;

      // Compose human-friendly title
      let titleCore = subject || primary || 'Integration';
      if (subject && primary) titleCore = `${subject} – ${primary}`;
      // Final filename
      const human = `${displayTitle} for ${titleCore}`.trim();
      const sanitize = (s) => String(s).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
      const filename = `${sanitize(human)}.docx`;

      // Set response headers for file download (strict ASCII-safe filename only)
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      const asciiSafe = filename
        .replace(/[\\/:*?"<>|]+/g, ' ')
        .replace(/[\r\n]+/g, ' ')
        .replace(/[^\x20-\x7E]/g, '-')
        .replace(/\s{2,}/g, ' ')
        .trim();
      res.setHeader('Content-Disposition', `attachment; filename="${asciiSafe}"`);
      res.setHeader('Content-Length', result.data.length);

      console.log(`✅ Word document converted successfully: ${filename}`);
      return res.send(result.data);
    } else {
      console.error('❌ Word conversion failed:', result.error);
      return res.status(500).json({ error: result.error || 'Failed to convert document' });
    }
  } catch (error) {
    console.error('❌ Error in convert-to-word endpoint:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// API endpoint to download a RAML project ZIP for a specific API
app.post('/api/raml/download', rateLimiters.download, async (req, res) => {
  try {
    const { sessionId, apiId, apiName, projectName } = req.body || {};

    if (!sessionId || !apiId) {
      return res.status(400).json({ error: 'sessionId and apiId are required' });
    }
    if (!requireSessionAccess(req, res, sessionId)) return;

    const apiRamlMap = sessionRamlByApi.get(sessionId) || {};
    const ramlContent = apiRamlMap[apiId];

    if (!ramlContent || typeof ramlContent !== 'string' || !ramlContent.trim()) {
      return res.status(404).json({ error: 'No RAML content found for the specified API and session.' });
    }

    const validation = validateRamlArtifact(ramlContent, `RAML for ${apiId}`);
    if (!validation.valid) {
      return res.status(422).json({
        error: artifactValidationMessage(validation, 'RAML content failed validation.'),
        blockedBy: 'artifact-validation'
      });
    }

    const effectiveProjectName =
      projectName ||
      (apiName && String(apiName).replace(/\s+/g, '-')) ||
      'raml-project';

    const result = await handleRamlDownload(validation.value, effectiveProjectName);

    if (!result || !result.success) {
      return res.status(500).json({ error: result?.error || 'Failed to generate RAML ZIP file' });
    }

    const { zipFilePath, zipFileName, size } = result;
    const stat = fs.statSync(zipFilePath);
    const filename = zipFileName || `${effectiveProjectName}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', size || stat.size);

    const readStream = fs.createReadStream(zipFilePath);
    readStream.on('error', (err) => {
      console.error('❌ Error streaming RAML ZIP file:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream RAML ZIP file' });
      }
    });

    return readStream.pipe(res);
  } catch (error) {
    console.error('❌ Error in RAML download endpoint:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// API endpoint to publish RAML for a specific API to Anypoint Design Center
app.post('/api/raml/publish', rateLimiters.generation, async (req, res) => {
  try {
    const { sessionId, apiId, apiName, projectName } = req.body || {};

    if (!sessionId || !apiId) {
      return res.status(400).json({ error: 'sessionId and apiId are required' });
    }
    if (!requireSessionAccess(req, res, sessionId)) return;
    const releaseJob = beginSessionJob(sessionId, `RAML Publish ${apiId}`, { res });
    if (!releaseJob) return;

    try {
      const apiRamlMap = sessionRamlByApi.get(sessionId) || {};
      const ramlContent = apiRamlMap[apiId];

      if (!ramlContent || typeof ramlContent !== 'string' || !ramlContent.trim()) {
        return res.status(404).json({ error: 'No RAML content found for the specified API and session.' });
      }

      const validation = validateRamlArtifact(ramlContent, `RAML for ${apiId}`);
      if (!validation.valid) {
        return res.status(422).json({
          error: artifactValidationMessage(validation, 'RAML content failed validation.'),
          blockedBy: 'artifact-validation'
        });
      }

      const effectiveProjectName =
        projectName ||
        (apiName && String(apiName).replace(/\s+/g, '-')) ||
        'api-project';

      const publishResult = await publishRamlDirect(validation.value, effectiveProjectName, sessionId);

      const rawText = publishResult && (publishResult.text || publishResult.message || '');
      const explicitFailure = typeof rawText === 'string' && /Publishing Failed/i.test(rawText);
      const success = publishResult && typeof publishResult.success === 'boolean'
        ? publishResult.success
        : !explicitFailure;
      const message = rawText || (success
        ? 'RAML published successfully.'
        : 'Failed to publish RAML.');

      return res.json({
        ...(publishResult || {}),
        text: rawText,
        success,
        message
      });
    } finally {
      releaseJob();
    }
  } catch (error) {
    console.error(' Error in RAML publish endpoint:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ── Regenerate a single draw.io diagram (architecture | sequence | both) ──────
// ── Regenerate diagram endpoint ───────────────────────────────────────────────
// In the new use-case flow:
//   - Component (master architecture) diagram → regenerated here
//   - Sequence diagrams → regenerated per use case via /api/sessions/:id/usecases/:ucId/sequence
//
// The 'sequence' and 'both' diagramType options are removed — a generic single
// sequence diagram no longer makes sense now that sequences are per-use-case.
app.post('/api/sessions/:id/regenerate-diagram', rateLimiters.generation, async (req, res) => {
  let releaseJob;
  try {
    const { id: sessionId } = req.params;
    if (!requireSessionAccess(req, res, sessionId)) return;

    const outputs = sessionOutputs.get(sessionId) || {};
    const architecture = outputs.architecture;
    if (!architecture) {
      return res.status(400).json({ error: 'No architecture found for this session. Generate architecture first.' });
    }
    releaseJob = beginSessionJob(sessionId, 'Diagram', { res });
    if (!releaseJob) return;

    const useCases = Array.isArray(outputs.useCases) ? outputs.useCases : [];
    console.log(`🔄 Regenerating master architecture diagram for session ${sessionId} (${useCases.length} use cases)`);

    const agent = await getDiagramAgent();

    const diagramContext = outputs.diagramContext || agent.createDiagramContext(architecture, useCases);

    // Always regenerate the master architecture diagram (component) using use cases for context
    const result = useCases.length > 0
      ? await agent.generateMasterArchitectureDiagram(architecture, useCases, diagramContext)
      : await agent.generateDrawioDiagram(diagramContext, 'component').then(r => ({ diagramUrl: r.diagramUrl }));

    const componentUrl = result.diagramUrl;
    console.log(`✅ Master architecture diagram regenerated for session ${sessionId}`);

    // Preserve existing per-use-case sequence diagrams — do not overwrite them
    const updatedDiagramData = {
      ...(outputs.diagramData || {}),
      component: componentUrl,
      masterArchitecture: componentUrl,
      tool: 'drawio'
    };

    const diagramText = `=== COMPONENT DIAGRAM ===\n${componentUrl || 'N/A'}`;
    sessionOutputs.set(sessionId, { ...outputs, diagram: diagramText, diagramData: updatedDiagramData, diagramContext });
    saveStore();

    return res.json({ success: true, diagramData: updatedDiagramData });
  } catch (err) {
    console.error('❌ Error regenerating diagram:', err);
    return res.status(500).json({ error: err.message || 'Failed to regenerate diagram' });
  } finally {
    releaseJob?.();
  }
});

// ── Use-case driven diagram flow ──────────────────────────────────────────────
// Helper: lazily build a DiagramGenerationAgent for a session
async function getDiagramAgent() {
  const { default: DiagramGenerationAgent } = await import('../src/agent/DiagramGenerationAgent.js');
  const config = createSequenceConfig(undefined, 'auto');
  return new DiagramGenerationAgent(config);
}

// Step 1: Extract individual use cases from the session architecture
app.post('/api/sessions/:id/extract-usecases', rateLimiters.generation, async (req, res) => {
  let releaseJob;
  try {
    const { id: sessionId } = req.params;
    if (!requireSessionAccess(req, res, sessionId)) return;

    const outputs = sessionOutputs.get(sessionId) || {};
    const architecture = outputs.architecture;
    if (!architecture) {
      return res.status(400).json({ error: 'No architecture found for this session. Generate architecture first.' });
    }
    releaseJob = beginSessionJob(sessionId, 'Use Case Extraction', { res });
    if (!releaseJob) return;

    console.log(`🔍 Extracting use cases for session ${sessionId}`);
    const agent = await getDiagramAgent();
    const useCases = await agent.extractUseCases(architecture);
    const diagramContext = agent.createDiagramContext(architecture, useCases);

    sessionOutputs.set(sessionId, { ...outputs, useCases, diagramContext });
    const meta = sessionMeta.get(sessionId);
    if (meta) { meta.updatedAt = new Date().toISOString(); sessionMeta.set(sessionId, meta); }
    saveStore();

    return res.json({ success: true, useCases });
  } catch (err) {
    console.error('❌ Error extracting use cases:', err);
    return res.status(500).json({ error: err.message || 'Failed to extract use cases' });
  } finally {
    releaseJob?.();
  }
});

// Edit / add / delete use cases (replace the full list)
app.put('/api/sessions/:id/usecases', rateLimiters.generation, async (req, res) => {
  try {
    const { id: sessionId } = req.params;
    const { useCases } = req.body || {};
    if (!requireSessionAccess(req, res, sessionId)) return;
    if (!Array.isArray(useCases)) return res.status(400).json({ error: 'useCases array is required' });
    if (rejectUnsafeInput(res, useCases)) return;

    const outputs = sessionOutputs.get(sessionId) || {};
    const existing = Array.isArray(outputs.useCases) ? outputs.useCases : [];

    // Normalize and preserve a sequence diagram only when the use case text is
    // unchanged. If name/description changed, the old diagram no longer matches.
    let useCasesChanged = existing.length !== useCases.length;
    const normalized = useCases.map((u, i) => {
      const prev = existing.find(e => e.id === u.id);
      const name = (u.name || `Use Case ${i + 1}`).toString().trim();
      const description = (u.description || '').toString().trim();
      const prevName = (prev?.name || '').toString().trim();
      const prevDescription = (prev?.description || '').toString().trim();
      const unchanged = !!prev && prevName === name && prevDescription === description;
      if (!unchanged) useCasesChanged = true;
      return {
        id: u.id || `uc_${Date.now()}_${i}`,
        name,
        description,
        sequenceDiagram: unchanged ? ((u.sequenceDiagram ?? prev?.sequenceDiagram) || null) : null
      };
    }).filter(u => u.name);

    let nextOutputs = { ...outputs, useCases: normalized };
    if (outputs.architecture) {
      const agent = await getDiagramAgent();
      nextOutputs = {
        ...nextOutputs,
        diagramContext: agent.createDiagramContext(outputs.architecture, normalized)
      };
    }
    if (useCasesChanged && nextOutputs.diagramData) {
      nextOutputs.diagramData = {
        ...nextOutputs.diagramData,
        component: null,
        masterArchitecture: null,
        networkTopology: null
      };
      nextOutputs.diagram = `=== COMPONENT DIAGRAM ===\nN/A\n\n=== SEQUENCE DIAGRAM ===\n${nextOutputs.diagramData.sequence || 'N/A'}`;
    }

    sessionOutputs.set(sessionId, nextOutputs);
    const meta = sessionMeta.get(sessionId);
    if (meta) { meta.updatedAt = new Date().toISOString(); sessionMeta.set(sessionId, meta); }
    saveStore();

    return res.json({ success: true, useCases: normalized });
  } catch (err) {
    console.error('❌ Error saving use cases:', err);
    return res.status(500).json({ error: err.message || 'Failed to save use cases' });
  }
});

// Generate (or regenerate) the SEQUENCE diagram for a single use case
app.post('/api/sessions/:id/usecases/:ucId/sequence-diagram', rateLimiters.generation, async (req, res) => {
  let releaseJob;
  try {
    const { id: sessionId, ucId } = req.params;
    if (!requireSessionAccess(req, res, sessionId)) return;

    const outputs = sessionOutputs.get(sessionId) || {};
    const architecture = outputs.architecture;
    if (!architecture) return res.status(400).json({ error: 'No architecture found for this session.' });

    const useCases = Array.isArray(outputs.useCases) ? outputs.useCases : [];
    const useCase = useCases.find(u => u.id === ucId);
    if (!useCase) return res.status(404).json({ error: 'Use case not found' });
    releaseJob = beginSessionJob(sessionId, `Sequence Diagram ${ucId}`, { res });
    if (!releaseJob) return;

    console.log(`🔄 Generating sequence diagram for use case "${useCase.name}" (session ${sessionId})`);
    const agent = await getDiagramAgent();
    const diagramContext = outputs.diagramContext || agent.createDiagramContext(architecture, useCases);
    const r = await agent.generateUseCaseSequenceDiagram(architecture, useCase, diagramContext);

    const updatedUseCases = useCases.map(u => u.id === ucId ? { ...u, sequenceDiagram: r.diagramUrl } : u);
    sessionOutputs.set(sessionId, { ...outputs, useCases: updatedUseCases, diagramContext });
    const meta = sessionMeta.get(sessionId);
    if (meta) { meta.updatedAt = new Date().toISOString(); sessionMeta.set(sessionId, meta); }
    saveStore();

    return res.json({ success: true, useCase: updatedUseCases.find(u => u.id === ucId) });
  } catch (err) {
    console.error('❌ Error generating use-case sequence diagram:', err);
    return res.status(500).json({ error: err.message || 'Failed to generate sequence diagram' });
  } finally {
    releaseJob?.();
  }
});

// Generate (or regenerate) the master/high-level architecture diagram for ALL use cases
app.post('/api/sessions/:id/master-architecture-diagram', rateLimiters.generation, async (req, res) => {
  let releaseJob;
  try {
    const { id: sessionId } = req.params;
    if (!requireSessionAccess(req, res, sessionId)) return;

    const outputs = sessionOutputs.get(sessionId) || {};
    const architecture = outputs.architecture;
    if (!architecture) return res.status(400).json({ error: 'No architecture found for this session.' });
    releaseJob = beginSessionJob(sessionId, 'Master Architecture Diagram', { res });
    if (!releaseJob) return;

    const useCases = Array.isArray(outputs.useCases) ? outputs.useCases : [];

    console.log(`🔄 Generating master architecture diagram for session ${sessionId} (${useCases.length} use cases)`);
    const agent = await getDiagramAgent();
    const diagramContext = outputs.diagramContext || agent.createDiagramContext(architecture, useCases);
    const r = await agent.generateMasterArchitectureDiagram(architecture, useCases, diagramContext);

    // Keep diagramData.component as the master architecture URL for backward compat.
    const updatedDiagramData = { ...(outputs.diagramData || {}), component: r.diagramUrl, masterArchitecture: r.diagramUrl, tool: 'drawio' };
    const diagramText = `=== COMPONENT DIAGRAM ===\n${r.diagramUrl || 'N/A'}\n\n=== SEQUENCE DIAGRAM ===\n${outputs.diagramData?.sequence || 'N/A'}`;

    sessionOutputs.set(sessionId, { ...outputs, diagram: diagramText, diagramData: updatedDiagramData, diagramContext });
    const meta = sessionMeta.get(sessionId);
    if (meta) { meta.updatedAt = new Date().toISOString(); sessionMeta.set(sessionId, meta); }
    saveStore();

    return res.json({ success: true, diagramData: updatedDiagramData });
  } catch (err) {
    console.error('❌ Error generating master architecture diagram:', err);
    return res.status(500).json({ error: err.message || 'Failed to generate master architecture diagram' });
  } finally {
    releaseJob?.();
  }
});

// Generate (or regenerate) the network topology diagram for ALL use cases
app.post('/api/sessions/:id/network-topology-diagram', rateLimiters.generation, async (req, res) => {
  let releaseJob;
  try {
    const { id: sessionId } = req.params;
    if (!requireSessionAccess(req, res, sessionId)) return;

    const outputs = sessionOutputs.get(sessionId) || {};
    const architecture = outputs.architecture;
    if (!architecture) return res.status(400).json({ error: 'No architecture found for this session.' });
    releaseJob = beginSessionJob(sessionId, 'Network Topology Diagram', { res });
    if (!releaseJob) return;

    const useCases = Array.isArray(outputs.useCases) ? outputs.useCases : [];

    console.log(`🔄 Generating network topology diagram for session ${sessionId} (${useCases.length} use cases)`);
    const agent = await getDiagramAgent();
    const diagramContext = outputs.diagramContext || agent.createDiagramContext(architecture, useCases);
    const r = await agent.generateNetworkTopologyDiagram(architecture, useCases, diagramContext);

    const updatedDiagramData = { ...(outputs.diagramData || {}), networkTopology: r.diagramUrl, tool: 'drawio' };
    sessionOutputs.set(sessionId, { ...outputs, diagramData: updatedDiagramData, diagramContext });
    const meta = sessionMeta.get(sessionId);
    if (meta) { meta.updatedAt = new Date().toISOString(); sessionMeta.set(sessionId, meta); }
    saveStore();

    return res.json({ success: true, diagramData: updatedDiagramData });
  } catch (err) {
    console.error('❌ Error generating network topology diagram:', err);
    return res.status(500).json({ error: err.message || 'Failed to generate network topology diagram' });
  } finally {
    releaseJob?.();
  }
});


// API endpoint to generate and download Mule code for a specific API
app.post('/api/mule-code/generate', rateLimiters.generation, async (req, res) => {
  let releaseJob;
  try {
    const { sessionId, apiId, apiName, projectName } = req.body || {};

    if (!sessionId || !apiId) {
      return res.status(400).json({ error: 'sessionId and apiId are required' });
    }
    if (!requireSessionAccess(req, res, sessionId)) return;
    releaseJob = beginSessionJob(sessionId, `Mule Code ${apiId}`, { res });
    if (!releaseJob) return;

    // Get RAML content for this API
    const apiRamlMap = sessionRamlByApi.get(sessionId) || {};
    const ramlContent = apiRamlMap[apiId];

    if (!ramlContent || typeof ramlContent !== 'string' || !ramlContent.trim()) {
      return res.status(404).json({ error: 'No RAML content found for the specified API and session. Please generate RAML first.' });
    }

    const ramlValidation = validateRamlArtifact(ramlContent, `RAML for ${apiId}`);
    if (!ramlValidation.valid) {
      return res.status(422).json({
        error: artifactValidationMessage(ramlValidation, 'RAML content failed validation.'),
        blockedBy: 'artifact-validation'
      });
    }

    // Get existing session outputs for context
    const outputs = sessionOutputs.get(sessionId) || {};

    // Create a new AgentManager instance
    const config = createSequenceConfig();
    const manager = new AgentManager(config, null, null);
    
    // Create context
    const apiContext = {
      sessionId,
      architecture: outputs.architecture,
      diagram: outputs.diagram,
      estimation: outputs.estimation,
      raml: ramlValidation.value,
      selectedApi: { id: apiId, name: apiName }
    };

    // Generate Mule code
    const muleCodeAgent = manager.orchestrator.muleCodeAgent;
    const muleProject = await muleCodeAgent.generateMuleCode(
      ramlValidation.value,
      apiName,
      { selectedApi: { id: apiId, name: apiName } },
      apiContext
    );
    const guardedMuleProject = guardOutput(muleProject, `mule project ${apiId}`);
    const muleValidation = validateMuleProjectArtifact(guardedMuleProject.value, `Mule project for ${apiId}`);
    if (guardedMuleProject.blocked || !muleValidation.valid) {
      return res.status(422).json({
        error: guardedMuleProject.reason || artifactValidationMessage(muleValidation, 'Generated Mule project failed validation.'),
        blockedBy: 'artifact-validation'
      });
    }

    // Store the Mule code
    let apiMuleCodeMap = sessionMuleCodeByApi.get(sessionId) || {};
    apiMuleCodeMap[apiId] = muleValidation.value;
    sessionMuleCodeByApi.set(sessionId, apiMuleCodeMap);

    const effectiveProjectName =
      projectName ||
      (apiName && String(apiName).replace(/\s+/g, '-')) ||
      'mule-project';

    // Generate ZIP file
    const result = await handleMuleCodeDownload(muleValidation.value, effectiveProjectName);

    if (!result || !result.success) {
      return res.status(500).json({ error: result?.error || 'Failed to generate Mule code ZIP file' });
    }

    const { zipFilePath, zipFileName, size } = result;
    const stat = fs.statSync(zipFilePath);
    const filename = zipFileName || `${effectiveProjectName}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', size || stat.size);

    const readStream = fs.createReadStream(zipFilePath);
    readStream.on('error', (err) => {
      console.error('❌ Error streaming Mule code ZIP file:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream Mule code ZIP file' });
      }
    });

    return readStream.pipe(res);
  } catch (error) {
    console.error('❌ Error in Mule code generation endpoint:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  } finally {
    releaseJob?.();
  }
});

// Legacy endpoint - redirects to /api/process for backward compatibility
app.post("/api/generate", rateLimiters.llmProcess, async (req, res) => {
  const { requirements, apiName, saveFiles } = req.body;
  if (!requirements || !requirements.trim()) {
    return res.status(400).json({ error: "Requirements are required" });
  }
  if (rejectOverBudgetRequest(res, req.body)) {
    return;
  }
  // Redirect to process endpoint
  req.body.input = requirements;
  return app._router.handle({ ...req, url: "/api/process", method: "POST" }, res);
});

// Token Usage API endpoint - returns parsed CSV data with date range filtering
app.get('/api/token-usage', rateLimiters.read, (req, res) => {
  try {
    const { fromDate, toDate } = req.query;
    const data = parseTokenUsageCSV();
    let entries = data.entries || [];

    // Transform CSV entries to camelCase JSON format with all 11 columns
    const transformedEntries = entries.map(entry => ({
      timestamp: entry['Timestamp (IST)'] || entry['Timestamp'] || '',
      correlationId: entry['Correlation_ID'] || '',
      llmProvider: entry['LLM_Provider'] || '',
      modelName: entry['Model_Name'] || '',
      tokenCategory: entry['Token_Category'] || 'General',
      promptTokens: parseInt(entry['Prompt_Tokens']) || 0,
      completionTokens: parseInt(entry['Completion_Tokens']) || 0,
      totalTokens: parseInt(entry['Total_Tokens']) || 0,
      userInstructionLength: parseInt(entry['User_Instruction_Length']) || 0,
      status: entry['Status'] || '',
      errorMessage: entry['Error_Message'] || ''
    }));

    // Filter by date range if provided
    let filteredEntries = transformedEntries;
    if (fromDate || toDate) {
      filteredEntries = transformedEntries.filter(entry => {
        // Parse entry timestamp: "2026-06-01 12:00:10 IST"
        if (!entry.timestamp) return false;

        // Extract just the date part (YYYY-MM-DD)
        const entryDate = entry.timestamp.split(' ')[0];

        // Check if within range
        if (fromDate && entryDate < fromDate) return false;
        if (toDate && entryDate > toDate) return false;

        return true;
      });

      console.log(`📅 Filtering token-usage by date range: ${fromDate} to ${toDate} - Found ${filteredEntries.length} entries`);
    }

    res.json({
      entries: filteredEntries,
      count: filteredEntries.length,
      totalTokens: filteredEntries.reduce((sum, e) => sum + (e.totalTokens || 0), 0),
      providers: data.providers || [],
      dateRange: { fromDate: fromDate || null, toDate: toDate || null }
    });
  } catch (error) {
    console.error('❌ Error fetching token usage:', error);
    res.status(500).json({ 
      error: 'Failed to fetch token usage data',
      message: error.message,
      entries: [],
      count: 0,
      providers: [],
      dateRange: {}
    });
  }
});

/**
 * Validate and process question answers
 */
async function validateAndProcessQuestions(sessionId, questionAnswers, pending, apiName, saveFiles, reqProvider, reqModel) {
  // Prefer provider from current request if provided and not 'auto'
  const chosenProvider = (reqProvider && reqProvider !== 'auto')
    ? reqProvider
    : (pending?.options?.provider && pending.options.provider !== 'auto')
      ? pending.options.provider
      : undefined;

  const cfg = createSequenceConfig(reqModel || pending?.options?.model, chosenProvider || 'auto');
  const manager = new AgentManager(cfg);
  const orchestrator = manager.orchestrator;

  const onProgress = (event) => {
    const socket = activeConnections.get(sessionId);
    if (socket) {
      socket.emit("progress", event);
    }
  };

  try {
    // Validate all answers
    const questionsWithAnswers = pending.questions.map((q, index) => ({
      ...q,
      answer: questionAnswers[index]?.answer || ""
    }));

    console.log('[Server] Starting validation for submitted answers:', questionsWithAnswers.map(q => ({
      number: q.number,
      hasAnswer: !!q.answer,
      answerLength: typeof q.answer === 'string' ? q.answer.length : 0
    })));
    const validation = await orchestrator.validateQuestionAnswers(questionsWithAnswers, onProgress);
    console.log('[Server] Validation completed. Aggregate:', { allValid: validation.allValid });
    console.log('[Server] Validation results per question:', validation.results.map(r => ({
      questionNumber: r.questionNumber,
      valid: r.valid,
      strength: r.strength,
      reason: r.reason
    })));

    const socket = activeConnections.get(sessionId);

    if (!validation.allValid) {
      // Some answers are invalid, send back for re-answering
      const invalidQuestions = questionsWithAnswers.map((qa, index) => ({
        ...qa,
        validation: validation.results[index]
      }));

      console.log('[Server] Emitting questions-validation-failed with results:', invalidQuestions.map(q => ({
        number: q.number,
        valid: q.validation?.valid,
        strength: q.validation?.strength,
        reason: q.validation?.reason
      })));

      if (socket) {
        socket.emit("questions-validation-failed", {
          questions: invalidQuestions,
          validationResults: validation.results
        });
      }
      console.log(`❌ Some answers are invalid, asking again for session ${sessionId}\n`);
      return;
    }

    // All answers valid — evaluate if Round 2 follow-up is needed
    // before proceeding to approach generation
    if (socket) {
      socket.emit("questions-validated", {
        message: "Answers validated. Checking if any follow-up is needed..."
      });
    }

    // ── Round 2: smart follow-up evaluation ──────────────────────────────────
    // Evaluates all Round 1 answers for vagueness, contradictions, or new gaps.
    // If answers are clear → needsFollowUp=false → proceeds straight to approaches.
    // If a gap exists → emits 'followup-questions' event (max 2 questions) → waits.
    // isRound2 flag prevents infinite loops — Round 2 answers always go straight to approaches.
    const isRound2 = pending.options?.isRound2 || false;

    if (!isRound2) {
      const followUpResult = await orchestrator.evaluateAndFollowUp(
        pending.requirements,
        questionsWithAnswers,
        (event) => { if (socket) socket.emit('progress', event); },
        pending.options
      );

      if (followUpResult.needsFollowUp) {
        // Store Round 2 questions alongside Round 1 answers
        // so when Round 2 is submitted, all context is available
        pendingQuestions.set(sessionId, {
          ...pending,
          questions: followUpResult.questions,
          round1Answers: questionsWithAnswers,   // preserve Round 1 answers
          options: {
            ...pending.options,
            isRound2: true  // prevents triggering Round 3
          }
        });
        console.log(`🔄 Round 2 questions stored for session ${sessionId}`);
        return; // wait for Round 2 answers
      }
    }

    // Merge Round 1 + Round 2 answers if this is Round 2
    const allAnswers = isRound2 && pending.round1Answers
      ? [...pending.round1Answers, ...questionsWithAnswers]
      : questionsWithAnswers;

    if (socket) {
      socket.emit("questions-validated", {
        message: "All answers validated. Generating approaches..."
      });
    }

    // Continue with all validated answers
    processInput(sessionId, pending.requirements, {
      ...pending.options,
      questionAnswers: allAnswers,
      apiName: apiName || pending.options.apiName || "MuleSoftAPI",
      saveFiles: saveFiles !== false
    }, 0, socket);

    // Clear pending questions
    pendingQuestions.delete(sessionId);
  } catch (error) {
    console.error(`❌ Error validating questions for session ${sessionId}:`, error);
    const socket = activeConnections.get(sessionId);
    if (socket) {
      socket.emit("error", { message: error.message });
    }
  }
}

async function processDocumentationWithAnswers(sessionId, pending, docQuestionAnswers, apiName, saveFiles, reqProvider, reqModel, socket = null) {
  console.log(`📄 Processing documentation answers for session: ${sessionId}`);
  console.log(`📄 Received ${docQuestionAnswers.length} documentation answers:`, summarizeDocAnswers(docQuestionAnswers));
  console.log(`📝 Answers: ${docQuestionAnswers.length} provided`);

  const prerequisites = getDocumentPrerequisiteStatus(sessionId);
  if (!prerequisites.ok) {
    const docType = pending?.context?.currentDocType || 'documentation';
    emitDocumentationBlocked(sessionId, docType, prerequisites.missing);
    pendingDocQuestions.delete(sessionId);
    return;
  }

  // Validate that answers are provided
  const hasValidAnswers = docQuestionAnswers.some(qa => qa.answer && qa.answer.trim());
  if (!hasValidAnswers) {
    const socket = activeConnections.get(sessionId);
    if (socket) {
      socket.emit("error", { message: "At least one answer is required" });
    }
    return;
  }

  console.log(`📄 Documentation answers received:`, summarizeDocAnswers(docQuestionAnswers));

  // Try to detect the document type explicitly from the user's answer
  let docTypeFromAnswer = null;
  try {
    for (const qa of docQuestionAnswers) {
      if (!qa || !qa.answer || !qa.answer.trim()) continue;
      const qText = qa.question || '';
      const isDocTypeQuestion =
        /what\s+(type|kind)\s+of\s+(document|documentation)|what\s+type\s+of\s+documentation/i.test(qText);
      if (isDocTypeQuestion) {
        const detected = detectDocumentType(qa.answer);
        if (detected && detected !== 'DOCUMENT_REQUEST') {
          docTypeFromAnswer = detected;
          break;
        }
      }
    }
  } catch (e) {
    console.warn('⚠️ Failed to detect document type from answers:', e?.message || e);
  }
  console.log('📄 Document type inferred from answers:', docTypeFromAnswer || pending?.context?.currentDocType || 'none');

  // Prefer provider from current request if provided and not 'auto'
  const chosenProvider = (reqProvider && reqProvider !== 'auto')
    ? reqProvider
    : (pending?.options?.provider && pending.options.provider !== 'auto')
      ? pending.options.provider
      : undefined;

  const cfg = createSequenceConfig(reqModel || pending?.options?.model, chosenProvider || 'auto');

  try {
    const docAgent = new DocumentationAgent(cfg);

    // Combine all answers into a single text
    const combinedAnswers = docQuestionAnswers
      .filter(qa => qa.answer && qa.answer.trim())
      .map(qa => `Q: ${qa.question}\nA: ${qa.answer}`)
      .join('\n\n');

    console.log(`📄 Combined answers for documentation:`, {
      length: combinedAnswers.length,
      answerCount: docQuestionAnswers.filter(qa => qa.answer && qa.answer.trim()).length
    });

    // Build comprehensive context with agent outputs as history
    const baseHistory = Array.isArray(pending.context?.history) ? pending.context.history : [];
    const agentHistory = [...baseHistory];

    // Add the current documentation Q&A pairs into history so that
    // generateDocumentClarifyingQuestions can avoid repeating questions
    for (const qa of docQuestionAnswers) {
      if (!qa || !qa.question || !qa.answer || !qa.answer.trim()) continue;
      agentHistory.push({
        prompt: qa.question,
        answer: qa.answer.trim()
      });
    }

    // Check if this is just a document type answer (first step)
    const isDocTypeOnlyAnswer = docQuestionAnswers.length === 1 && 
      docQuestionAnswers[0] && 
      /what\s+(type|kind)\s+of\s+(document|documentation)|what\s+type\s+of\s+documentation/i.test(docQuestionAnswers[0].question || '');

    let docResponse;
    if (isDocTypeOnlyAnswer && docTypeFromAnswer) {
      // First step: document type answered, now get follow-up questions
      console.log(`📄 Document type answered (${docTypeFromAnswer}), requesting follow-up questions`);
      docResponse = await docAgent.handleMessage({
        from: 'server',
        payload: {
          type: 'clarify-document',
          text: docTypeFromAnswer,
          apiName: apiName || 'MuleSoftAPI'
        },
        context: {
          ...pending.context,
          sessionId: sessionId,
          architecture: prerequisites.outputs.architecture,
          estimation: prerequisites.outputs.estimation,
          raml: prerequisites.raml,
          history: agentHistory,
          currentDocType: docTypeFromAnswer,
          a2aDocTypeAsked: true // Mark that we've asked for doc type
        }
      });
    } else {
      // Second step or direct generation: generate document with all answers
      console.log(`📄 Generating document with all answers for type: ${docTypeFromAnswer || pending?.context?.currentDocType}`);
      docResponse = await docAgent.handleMessage({
        from: 'server',
        payload: {
          type: 'generate-document',
          text: combinedAnswers,
          apiName: apiName || 'MuleSoftAPI'
        },
        context: {
          ...pending.context,
          sessionId: sessionId,
          architecture: prerequisites.outputs.architecture,
          estimation: prerequisites.outputs.estimation,
          raml: prerequisites.raml,
          history: agentHistory,
          currentDocType: docTypeFromAnswer || pending?.context?.currentDocType
        }
      });
    }

    const socket = activeConnections.get(sessionId);
    if (docResponse && docResponse.type === 'response') {
      if (docResponse.payload.documentGenerated && docResponse.payload.content) {
        // Documentation was generated successfully — persist and notify client.
        const guardedDoc = guardOutput(docResponse.payload.content, 'documentation content');
        const docPayload = {
          content: guardedDoc.value,
          docType: docResponse.payload.docType,
          message: guardedDoc.blocked ? guardedDoc.reason : "Documentation generated successfully!"
        };
        if (socket) {
          safeSocketEmit(socket, "documentation-ready", docPayload);
          safeSocketEmit(socket, "progress", { type: "saved", message: "All files saved to ./output/" });
          safeSocketEmit(socket, "progress", {
            type: "complete",
            message: guardedDoc.blocked ? guardedDoc.reason : "Complete solution with documentation generated!",
            data: { documentation: guardedDoc.value }
          });
        } else {
          // Buffer so the client receives it when it reconnects
          pendingDocumentationReady.set(sessionId, docPayload);
        }
        // Persist generated documentation by type in session store
        try {
          const docTypeKey = docResponse.payload.docType || 'DOCUMENT';
          const existingDocs = sessionDocumentsByType.get(sessionId) || {};
          sessionDocumentsByType.set(sessionId, { ...existingDocs, [docTypeKey]: guardedDoc.value });
          const meta = sessionMeta.get(sessionId);
          if (meta) { meta.updatedAt = new Date().toISOString(); sessionMeta.set(sessionId, meta); }
          saveStore();
        } catch (e) {
          console.warn('⚠️ Failed to persist documentation for session', sessionId, e?.message || e);
        }
        // Done — do NOT fall through to the questions block below.
        return;
      } else if (docResponse.payload.questions && Array.isArray(docResponse.payload.questions)) {
        // Agent needs more information before generating the document.
        if (socket) {
          safeSocketEmit(socket, "progress", {
            type: "info",
            message: "Additional questions needed for comprehensive documentation"
          });
          safeSocketEmit(socket, 'doc-questions-ready', { questions: docResponse.payload.questions });
        }
        console.log(`❓ Additional documentation questions for session ${sessionId} - ${docResponse.payload.questions.length} questions sent`);
        return; // Don't clear pending questions yet
      } else if (docResponse.payload.text) {
        // Handle text responses (like error messages or intermediate responses)
        if (socket) {
          safeSocketEmit(socket, "progress", {
            type: "info",
            message: docResponse.payload.text
          });
        }
        console.log(`📝 Documentation agent response:`, {
          length: docResponse.payload.text.length
        });
      }
    } else {
      if (socket) {
        socket.emit("error", { message: "Failed to generate documentation" });
      }
    }

    // Clear pending documentation questions
    pendingDocQuestions.delete(sessionId);
  } catch (error) {
    console.error(`❌ Error processing documentation answers for session ${sessionId}:`, error);
    const socket = activeConnections.get(sessionId);
    if (socket) {
      socket.emit("error", { message: `Documentation generation failed: ${error.message}` });
    }
  }
}

async function continueEstimationWithJourneyPoints(sessionId, context, journeyPoints, options, onProgress, manager, socket) {
  console.log(`🔄 Continuing estimation with journey points for session ${sessionId}`);
  
  try {
    const { architecture, diagram, requirements } = context;
    
    // Update context with journey points
    const updatedContext = {
      ...context,
      sessionId,
      journeyPoints: journeyPoints
    };

    // Get estimation agent from manager
    const estimationAgent = manager.orchestrator.estimationAgent;
    
    if (onProgress) {
      onProgress({
        type: "step",
        step: 3,
        agent: "Estimation",
        status: "working",
        message: "Generating estimation with journey points..."
      });
    }

    // Generate estimation with journey points.
    // Overall timeout: 7 minutes, aligned with the agent/provider timeout.
    // This outer timeout is a safety net for the full continuation loop.
    const ESTIMATION_OVERALL_TIMEOUT_MS = Number.parseInt(process.env.ESTIMATION_OVERALL_TIMEOUT_MS || '', 10) || 7 * 60 * 1000;
    const estimationStreamId = `${sessionId}_estimation_${Date.now()}`;
    let estimationChunkSequence = 0;
    const estimationAbortController = new AbortController();
    const estimationContext = {
      ...updatedContext,
      signal: estimationAbortController.signal,
      onChunk: chunk => {
        if (!chunk || !onProgress) return;
        onProgress({
          type: "agent-stream-chunk",
          agent: "Estimation",
          streamId: estimationStreamId,
          sequence: estimationChunkSequence++,
          chunk
        });
      },
      onStreamReset: () => {
        estimationChunkSequence = 0;
        if (onProgress) {
          onProgress({
            type: "agent-stream-reset",
            agent: "Estimation",
            streamId: estimationStreamId,
            message: "Estimation provider changed; restarting streamed output."
          });
        }
      }
    };
    if (onProgress) {
      onProgress({
        type: "agent-stream-start",
        agent: "Estimation",
        streamId: estimationStreamId,
        message: "Estimation response is streaming..."
      });
    }

    // Heartbeat: emit a progress ping every 30s so the frontend knows
    // the server is still alive and estimation is running (not crashed).
    let heartbeatCount = 0;
    const heartbeatInterval = setInterval(() => {
      heartbeatCount++;
      const elapsed = heartbeatCount * 30;
      if (onProgress) {
        onProgress({
          type: "step",
          step: 3,
          agent: "Estimation",
          status: "working",
          message: `Estimation in progress... (${elapsed}s elapsed — this can take 2-3 minutes for complex architectures)`
        });
      }
    }, 30_000);

    let estimation = null;
    try {
      const estimationPromise = estimationAgent.generateEstimation(architecture, estimationContext);
      let overallTimeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        overallTimeoutId = setTimeout(() => {
          estimationAbortController.abort();
          reject(new Error(
            `Estimation timed out after ${ESTIMATION_OVERALL_TIMEOUT_MS / 60000} minutes. ` +
            `Try reducing the number of journey points or switching to a faster LLM provider.`
          ));
        }, ESTIMATION_OVERALL_TIMEOUT_MS);
      });

      try {
        estimation = await Promise.race([estimationPromise, timeoutPromise]);
      } finally {
        clearTimeout(overallTimeoutId);
      }
      console.log(`✅ Estimation completed (${estimation?.length || 0} chars)`);

    } catch (error) {
      console.error(`❌ Estimation failed; continuing to RAML generation:`, error);
      if (onProgress) {
        onProgress({
          type: "step",
          step: 3,
          agent: "Estimation",
          status: "error",
          message: `Estimation failed: ${error.message}. RAML generation will continue.`
        });
      }
    } finally {
      clearInterval(heartbeatInterval);
    }
    
    // Store estimation in session outputs
    const outputs = sessionOutputs.get(sessionId) || {};
    if (estimation) {
      const guardedEstimation = guardOutput(estimation, 'estimation output');
      estimation = guardedEstimation.value;
      outputs.estimation = estimation;
      sessionOutputs.set(sessionId, outputs);
    }
    
     if (onProgress && estimation) {
      onProgress({
        type: "agent-stream-complete",
        agent: "Estimation",
        streamId: estimationStreamId,
        message: "Estimation response streaming completed."
      });
      onProgress({
        type: "step",
        step: 3,
        agent: "Estimation",
        status: "completed",
        message: `Estimation generated (${estimation.length} characters)`,
        data: estimation
      });
    }

    // Continue with RAML generation
    if (onProgress) {
      onProgress({
        type: "step",
        step: 4,
        agent: "RAML",
        status: "working",
        message: "Requesting RAML from RAML Agent via A2A..."
      });
    }

    // Continue with RAML and Documentation agents
    // The architecture agent's generateCompleteSolution will handle the rest
    // But since we're continuing manually, we need to call the remaining steps
    const ramlAgent = manager.orchestrator.ramlAgent;
    let apiTasks = [];
    try {
      apiTasks = estimation
        ? await ramlAgent.extractApiTasksFromEstimation(estimation)
        : ramlAgent.extractApiTasksFromArchitectureContext(architecture, updatedContext);
    } catch (error) {
      console.warn('⚠️ Failed to extract RAML tasks before RAML start event:', error?.message || error);
      apiTasks = ramlAgent.extractApiTasksFromArchitectureContext(architecture, updatedContext);
    }

    const normalizedApiTasks = Array.isArray(apiTasks)
      ? apiTasks
          .filter(task => task && task.id)
          .map(task => ({
            id: String(task.id),
            name: String(task.name || task.id),
            description: String(task.description || '')
          }))
      : [];

    if (normalizedApiTasks.length > 0) {
      sessionRamlTasks.set(sessionId, normalizedApiTasks);
      const placeholders = sessionRamlByApi.get(sessionId) || {};
      for (const task of normalizedApiTasks) {
        if (task?.id && !(task.id in placeholders)) placeholders[task.id] = "";
      }
      sessionRamlByApi.set(sessionId, placeholders);
      const meta = sessionMeta.get(sessionId);
      if (meta) {
        meta.updatedAt = new Date().toISOString();
        sessionMeta.set(sessionId, meta);
      }
      saveStore();
    }

    if (socket) {
      safeSocketEmit(socket, 'raml-agent-started', {
        timestamp: new Date().toISOString(),
        message: normalizedApiTasks.length
          ? 'RAML API topics identified'
          : 'No RAML API topics were identified',
        status: normalizedApiTasks.length ? 'topics_ready' : 'idle',
        tasks: normalizedApiTasks,
        sessionId: sessionId
      });
    }

    const updatedContextForRaml = {
      ...updatedContext,
      sessionId,
      estimation: estimation,
      apiTasks: normalizedApiTasks
    };

    // Generate RAML (this will extract API tasks and emit raml-agent-started)
    let raml = await ramlAgent.generateRAML(
      architecture,
      options.apiName || 'MuleSoftAPI',
      { ...options, sessionId },
      updatedContextForRaml
    );
    
    if (raml) {
      const guardedRaml = guardOutput(raml, 'raml output');
      const validation = validateRamlArtifact(guardedRaml.value, 'workflow RAML output');
      if (guardedRaml.blocked || !validation.valid) {
        const message = guardedRaml.reason || artifactValidationMessage(validation, 'Generated RAML failed validation.');
        console.warn(`🛡️ RAML artifact blocked for session ${sessionId}: ${message}`);
        raml = null;
        if (onProgress) {
          onProgress({
            type: 'step',
            agent: 'RAML',
            status: 'error',
            message,
            blockedBy: 'artifact-validation'
          });
        }
      } else {
        outputs.raml = validation.value;
        raml = validation.value;
        sessionOutputs.set(sessionId, outputs);
      }
    } else if (onProgress) {
      onProgress({
        type: "step",
        step: 4,
        agent: "RAML",
        status: normalizedApiTasks.length ? "completed" : "idle",
        message: normalizedApiTasks.length
          ? `Identified ${normalizedApiTasks.length} RAML API topic(s). Generate RAML for a selected API from the RAML tab.`
          : "No RAML API topics were identified.",
        data: null
      });
    }

    // Emit completion
    if (onProgress) {
      onProgress({
        type: "complete",
        message: "Complete solution generated!",
        data: {
          architecture: architecture,
          diagram: diagram,
          estimation: estimation,
          raml: raml
        }
      });
    }

    // Update session meta
    const meta = sessionMeta.get(sessionId);
    if (meta) {
      meta.updatedAt = new Date().toISOString();
      sessionMeta.set(sessionId, meta);
    }
    saveStore();

    console.log(`✅ Estimation and workflow completed for session ${sessionId}`);
  } catch (error) {
    console.error(`❌ Error continuing estimation:`, error);
    if (onProgress) {
      onProgress({
        type: "step",
        step: 3,
        agent: "Estimation",
        status: "error",
        message: `Estimation failed: ${error.message}`
      });
    }
    throw error;
  }
}

function isProviderFallbackError(error) {
  const status = error?.status || error?.response?.status;
  const message = String(error?.message || '');

  return (
    status === 401 ||
    status === 413 ||
    status === 429 ||
    (status >= 500 && status < 600) ||
    message.includes('All LLM providers failed') ||
    message.includes('LLM request failed') ||
    message.includes('rate limit') ||
    message.includes('Rate limit') ||
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('ECONNRESET') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ENOTFOUND')
  );
}

async function processInput(sessionId, input, options, attempt = 0, socket = null) {
  console.log(`\n🚀 Processing input for session: ${sessionId}`);
  console.log(`📝 Input received`, { inputLength: typeof input === 'string' ? input.length : 0 });
  console.log(`⚙️ Options:`, summarizeOptions(options));

    // Ensure sessionId is propagated through all downstream agent options
    options = { ...options, sessionId };
    
    // In the interactive UI, pause after architecture. The user should extract
    // and edit use cases from the Diagram tab, then explicitly start estimation.
    // Non-socket callers can still run end-to-end unless they opt into the pause.
    options.waitForJourneyPoints = options.waitForJourneyPoints === true || !!socket;

  // Define provider priority for auto mode
  const providerPriority = LLM_PROVIDER_SEQUENCE;

  let config;
  let currentProvider;

  // Handle auto provider selection
  try {
    if (options.provider === 'auto' || !options.provider) {
      currentProvider = providerPriority[attempt] || providerPriority[providerPriority.length - 1];
      console.log(`🔄 Trying provider: ${currentProvider} (attempt ${attempt + 1} of ${providerPriority.length})`);
      config = createSequenceConfig(options.model, currentProvider);
    } else {
      // Use specified provider or default from config
      currentProvider = options.provider;
      config = createSequenceConfig(options.model, options.provider || 'auto');
    }

    //const manager = new AgentManager(config);
    const manager = new AgentManager(config, null, socket);  // Pass the socket as third argument

    // Progress callback
    const onProgress = (rawEvent) => {
      const event = sanitizeProgressEvent(rawEvent);
      // Intercept documentation question events to persist, regardless of
      // whether the WebSocket client has joined the session yet.
      if (event.type === 'doc-questions-ready') {
        const allQuestions = Array.isArray(event.questions) ? event.questions : [];
        const docTypeRegex = /what\s+(type|kind)\s+of\s+(document|documentation)|what\s+type\s+of\s+documentation/i;
        const hasDocTypeQuestion = allQuestions.some(
          q => q && typeof q.question === 'string' && docTypeRegex.test(q.question)
        );

        // Persist full question set for backend processing so they can be
        // retrieved even if the client joins later.
        pendingDocQuestions.set(sessionId, {
          questions: allQuestions,
          context: event.context,
          requirements: event.requirements,
          options: options
        });

        // If we receive both the document-type question and follow-up
        // questions together, only show the document-type question in the
        // first popup so that the flow is strictly sequential for the user.
        const questionsForFrontend =
          hasDocTypeQuestion && allQuestions.length > 1
            ? [allQuestions.find(q => q && typeof q.question === 'string' && docTypeRegex.test(q.question))]
            : allQuestions;

        const socketForDoc = activeConnections.get(sessionId);
        if (socketForDoc) {
          safeSocketEmit(socketForDoc, 'doc-questions-ready', { questions: questionsForFrontend });
          // Explicitly tell frontend to wait - don't show completion
          safeSocketEmit(socketForDoc, 'progress', {
            type: 'waiting',
            message: 'Waiting for documentation answers...',
            waitingFor: 'documentation'
          });
          console.log(`⏸️ Documentation questions sent, frontend set to waiting state for session ${sessionId}`);
        } else {
          // No active socket yet – questions are persisted in
          // pendingDocQuestions and will be delivered when the client joins.
          console.log(`⏸️ Documentation questions generated for session ${sessionId} before socket joined; they will be delivered on join-session`);
        }
        // Don't send any other progress events for this callback
        return;
      }

      // Update sessionOutputs for agent completions
      if (event.type === 'step' && event.status === 'completed' && event.data) {
        const agentKey = event.agent?.toLowerCase();
        const existingOutputs = sessionOutputs.get(sessionId) || {};
        
        if (agentKey === 'general') {
          console.log(`💬 Storing general response in sessionOutputs for session ${sessionId}`, {
            responseLength: typeof event.data === 'string' ? event.data.length : 0
          });
          safeSessionOutput(sessionId, existingOutputs, { general: event.data }, 'general output');
        } else if (agentKey === 'architecture') {
          console.log(`🏗️ Storing architecture in sessionOutputs for session ${sessionId}`);
          safeSessionOutput(sessionId, existingOutputs, { architecture: event.data }, 'architecture output');
        } else if (agentKey === 'diagram') {
          console.log(`📊 Storing diagram in sessionOutputs for session ${sessionId}`);
          safeSessionOutput(sessionId, existingOutputs, {
            diagram: event.data,
            diagramData: event.diagramData || null
          }, 'diagram output');
        }
        
        // Touch session meta and persist store
        try {
          const meta = sessionMeta.get(sessionId);
          if (meta) {
            meta.updatedAt = new Date().toISOString();
            sessionMeta.set(sessionId, meta);
          }
          saveStore();
        } catch (e) {
          console.warn('⚠️ Failed to persist output:', e?.message || e);
        }
      }

      const socketForProgress = activeConnections.get(sessionId);
      if (socketForProgress) {
        // Block ALL other events after doc questions are sent until user responds
        if (pendingDocQuestions.has(sessionId) && event.type !== 'error') {
          console.log(`⏸️ Blocking ${event.type} event while waiting for documentation answers for session ${sessionId}`);
          return;
        }
        // If documentation questions are already pending, defer overall completion
        if (event.type === 'complete') {
          if (pendingDocQuestions.has(sessionId)) {
            safeSocketEmit(socketForProgress, 'progress', { type: 'info', message: 'Awaiting documentation answers before final completion...' });
            console.log(`⏸️ Deferred completion for session ${sessionId}: waiting for documentation answers`);
            return;
          }
        }
        safeSocketEmit(socketForProgress, "progress", event);
        console.log(`📡 Progress event sent: ${event.type} - ${event.agent || event.message}`);
      } else {
        // No active socket yet – buffer the event so it can be sent when the
        // client later joins the session.
        const existing = pendingProgressEvents.get(sessionId) || [];
        existing.push({ channel: 'progress', payload: event });
        pendingProgressEvents.set(sessionId, existing);
        console.log(`📡 Progress event buffered for session ${sessionId}: ${event.type}`);
      }
    };


    // Process input - AgentManager will route to appropriate agent(s)
    let result;
    try {
      result = await manager.processInput(input, {
        ...options,
        // Remove provider from options to prevent infinite loop
        provider: undefined
      }, onProgress);
    } catch (error) {
      // Check if this is a wait-for-journey-points signal
      if (error.message === 'WAIT_FOR_JOURNEY_POINTS') {
        console.log(`⏸️ Workflow paused for journey points input for session ${sessionId}`);
        // Store continuation state - get latest outputs (they should be updated by onProgress)
        const outputs = sessionOutputs.get(sessionId) || {};
        console.log(`📋 Storing continuation state - Architecture: ${!!outputs.architecture}, Diagram: ${!!outputs.diagram}`);
        pendingJourneyPoints.set(sessionId, {
          context: {
            architecture: outputs.architecture,
            diagram: outputs.diagram,
            requirements: input
          },
          options: options,
          onProgress: onProgress,
          manager: manager,
          config: config
        });
        // The frontend will show the journey points modal
        return;
      }
      // Re-throw other errors
      throw error;
    }

    // If we're in auto mode and this was a successful attempt after retries, log it
    if ((options.provider === 'auto' || !options.provider) && attempt > 0) {
      console.log(`✅ Successfully processed with ${config.provider} after ${attempt} retries`);
    }

    // Handle different result types
    if (result.type === "questions") {
      // Store questions for this session, waiting for user answers
      pendingQuestions.set(sessionId, {
        questions: result.questions,
        requirements: result.requirements,
        options: options
      });

      const socket = activeConnections.get(sessionId);
      if (socket) {
        socket.emit("questions-ready", {
          questions: result.questions,
          fullResponse: result.fullResponse
        });
      }
      console.log(`❓ Questions generated for session ${sessionId}, waiting for user answers\n`);
      return;
    }

    if (result.type === "approaches") {
      // Store approaches for this session, waiting for user selection
      pendingApproaches.set(sessionId, {
        approaches: result.approaches,
        requirements: result.requirements,
        options: options
      });

      const socket = activeConnections.get(sessionId);
      if (socket) {
        socket.emit("approaches-ready", {
          approaches: result.approaches,
          fullResponse: result.fullResponse
        });
        // Mark as delivered to prevent duplicates
        deliveredApproaches.add(sessionId);
      }
      console.log(`📋 Approaches generated for session ${sessionId}, waiting for user selection\n`);
      return;
    }

    // Update conversation history for general Q&A (maintain chat context)
    if (result.type === "general") {
      console.log(`💬 Processing general result for session ${sessionId}:`, { hasConversationHistory: !!result.conversationHistory, hasAnswer: !!result.answer });

      if (result.conversationHistory) {
        sessionConversations.set(sessionId, result.conversationHistory);
        // Also store the latest general response in sessionOutputs
        const existingOutputs = sessionOutputs.get(sessionId) || {};
        safeSessionOutput(sessionId, existingOutputs, {
          general: result.conversationHistory[result.conversationHistory.length - 1]?.answer || result.answer
        }, 'general result');
        console.log(`💬 Updated conversation history for session ${sessionId} (${result.conversationHistory.length} exchanges)`);
      } else {
        // If no history returned, add current exchange manually
        const currentHistory = sessionConversations.get(sessionId) || [];
        currentHistory.push({ prompt: input, answer: result.answer });
        // Keep last 10 exchanges
        if (currentHistory.length > 10) {
          currentHistory.shift();
        }
        sessionConversations.set(sessionId, currentHistory);
        // Also store the general response in sessionOutputs
        const existingOutputs = sessionOutputs.get(sessionId) || {};
        safeSessionOutput(sessionId, existingOutputs, { general: result.answer }, 'general result');
        console.log(`💬 Added manual conversation entry for session ${sessionId}`);
      }

      // Touch session meta and persist store
      try {
        const meta = sessionMeta.get(sessionId);
        if (meta) {
          meta.updatedAt = new Date().toISOString();
          sessionMeta.set(sessionId, meta);
        }
        saveStore();
        console.log(`💬 General response stored and persisted for session ${sessionId}`);
      } catch (e) {
        console.warn('⚠️ Failed to persist after general response update:', e?.message || e);
      }
    } else if (result.type === "architecture") {
      // Clear conversation history when switching to architecture workflow
      // (architecture requests are typically standalone)
      sessionConversations.set(sessionId, []);

      // Store architecture outputs for documentation context
      // AgentManager returns { type: 'architecture', architecture, diagram, estimation, raml, documentation, context, ... }
      if (result.architecture || result.raml || result.diagram || result.estimation) {
        const existingOutputs = sessionOutputs.get(sessionId) || {};
        safeSessionOutput(sessionId, existingOutputs, {
          architecture: result.architecture || existingOutputs.architecture,
          raml: result.raml || existingOutputs.raml,
          diagram: result.diagram || existingOutputs.diagram,
          estimation: result.estimation || existingOutputs.estimation
        }, 'architecture workflow result');
        console.log(`📊 Updated session outputs for ${sessionId}`);
        // Touch session meta and persist store
        try {
          const meta = sessionMeta.get(sessionId);
          if (meta) {
            meta.updatedAt = new Date().toISOString();
            sessionMeta.set(sessionId, meta);
          }
          saveStore();
        } catch (e) {
          console.warn('⚠️ Failed to persist after outputs update:', e?.message || e);
        }

        // Derive and persist RAML API tasks from estimation once, if not already present
        try {
          const existingTasks = sessionRamlTasks.get(sessionId) || [];
          if ((!existingTasks || existingTasks.length === 0) && result.estimation) {
            const ramlAgent = new RAMLGenerationAgent(config);
            const apiTasks = await ramlAgent.extractApiTasksFromEstimation(result.estimation);
            if (Array.isArray(apiTasks) && apiTasks.length > 0) {
              const normalized = apiTasks.map(t => ({
                id: String(t.id),
                name: String(t.name || t.id),
                description: String(t.description || '')
              }));
              sessionRamlTasks.set(sessionId, normalized);

              const byApi = sessionRamlByApi.get(sessionId) || {};
              for (const t of normalized) {
                const key = String(t.id);
                if (!(key in byApi)) byApi[key] = '';
              }
              sessionRamlByApi.set(sessionId, byApi);

              try {
                const meta = sessionMeta.get(sessionId);
                if (meta) {
                  meta.updatedAt = new Date().toISOString();
                  sessionMeta.set(sessionId, meta);
                }
                saveStore();
              } catch (e) {
                console.warn('⚠️ Failed to persist RAML tasks derived from estimation:', e?.message || e);
              }

              console.log(`📦 Persisted RAML tasks for session ${sessionId}: ${normalized.length} APIs`);
            }
          }
        } catch (e) {
          console.warn('⚠️ Failed to derive RAML tasks from estimation for session', sessionId, e?.message || e);
        }
      }

      // Check if documentation is deferred OR if we have pending doc questions - if so, don't mark as completed yet
      if (result.deferredDocumentation || pendingDocQuestions.has(sessionId)) {
        console.log(`⏸️ Processing deferred for session: ${sessionId} - awaiting documentation answers (deferred: ${result.deferredDocumentation}, pending: ${pendingDocQuestions.has(sessionId)})\n`);
        return; // Don't mark as completed yet
      }
    }

    // Final check - don't mark as completed if we have pending documentation questions
    if (pendingDocQuestions.has(sessionId)) {
      console.log(`⏸️ Final check: Documentation questions pending for session: ${sessionId} - not marking as completed\n`);
      return;
    }

    console.log(`✅ Processing completed for session: ${sessionId}\n`);
  } catch (error) {
    const errorProvider = currentProvider || (config && config.provider) || 'unknown';
    const errorDetails = error.response?.data || error.message || 'Unknown error';

    // Log detailed error information
    console.error(`❌ Error with ${errorProvider}:`, summarizeValue(errorDetails));
    console.error(`📌 Error stack:`, error.stack || 'No stack trace available');

    // If in auto mode and we have more providers to try
    const isAutoMode = options.provider === 'auto' || !options.provider;
    const hasMoreProviders = attempt < providerPriority.length - 1;

    const activeSocket = socket || activeConnections.get(sessionId);

    if (isAutoMode && hasMoreProviders && isProviderFallbackError(error)) {
      const nextProvider = providerPriority[attempt + 1];
      console.log(`🔄 Attempting fallback to next provider: ${nextProvider}...`);

      // Add a small delay before retrying to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));

      return processInput(sessionId, input, options, attempt + 1, activeSocket);
    }

    // If we've tried all providers or not in auto mode, return a comprehensive error
    const allProvidersTried = providerPriority.join(', ');
    const lastProvider = currentProvider || (config && config.provider) || 'unknown';

    const errorMessage = isAutoMode
      ? `❌ All providers failed (tried: ${allProvidersTried}). Last error from ${lastProvider}: ${error.message}`
      : `❌ Error with ${lastProvider}: ${error.message}`;

    // Log the complete error chain in development
    if (process.env.NODE_ENV !== 'production') {
      console.error('Error summary:', summarizeError(error));
    }

    // Notify the client with detailed error information
    emitSessionError(sessionId, {
      message: errorMessage,
      provider: lastProvider,
      attempt: attempt + 1,
      totalProviders: providerPriority.length,
      errorDetails: process.env.NODE_ENV !== 'production' ? errorDetails : undefined
    });
  }
}

async function triggerDocumentationAgent(sessionId, input, documentType, options) {
  console.log(`📄 Triggering documentation agent for session ${sessionId} with type ${documentType}`);

  const prerequisites = getDocumentPrerequisiteStatus(sessionId);
  if (!prerequisites.ok) {
    emitDocumentationBlocked(sessionId, documentType, prerequisites.missing);
    return;
  }

  const cfg = createSequenceConfig(options.model, options.provider || 'auto');

  try {
    const docAgent = new DocumentationAgent(cfg);

    // Get existing context from session outputs if available
    const outputs = prerequisites.outputs;
    console.log(`📄 Session outputs available:`, {
      hasArchitecture: !!outputs.architecture,
      hasRaml: !!prerequisites.raml,
      hasDiagram: !!outputs.diagram,
      hasEstimation: !!outputs.estimation
    });

    const docResponse = await docAgent.handleMessage({
      from: 'server',
      payload: {
        type: 'clarify-document',
        text: documentType,
        apiName: options.apiName || 'MuleSoftAPI'
      },
      context: {
        sessionId: sessionId,
        architecture: outputs.architecture,
        raml: prerequisites.raml,
        diagram: outputs.diagram,
        estimation: outputs.estimation,
        currentDocType: documentType
      }
    });

    console.log(`📄 Documentation agent response:`, {
      type: docResponse?.type,
      hasContent: !!docResponse?.payload?.content,
      hasQuestions: !!docResponse?.payload?.questions,
      requiresUserInput: docResponse?.payload?.requiresUserInput,
      documentGenerated: docResponse?.payload?.documentGenerated
    });

    const socket = activeConnections.get(sessionId);
    if (docResponse && docResponse.type === 'response') {
      if (docResponse.payload.documentGenerated && docResponse.payload.content) {
        // Direct generation - document is ready
        const guardedDoc = guardOutput(docResponse.payload.content, 'documentation content');
        if (socket) {
          safeSocketEmit(socket, "documentation-ready", {
            content: guardedDoc.value,
            docType: docResponse.payload.docType || documentType,
            message: guardedDoc.blocked ? guardedDoc.reason : (docResponse.payload.text || `${documentType} documentation generated successfully!`)
          });
        }
        console.log(`✅ ${documentType} documentation generated directly for session ${sessionId}`);
        // Persist document by type
        try {
          const docTypeKey = docResponse.payload.docType || documentType || 'DOCUMENT';
          const existingDocs = sessionDocumentsByType.get(sessionId) || {};
          sessionDocumentsByType.set(sessionId, { ...existingDocs, [docTypeKey]: guardedDoc.value });
          const meta = sessionMeta.get(sessionId);
          if (meta) { meta.updatedAt = new Date().toISOString(); sessionMeta.set(sessionId, meta); }
          saveStore();
        } catch (e) {
          console.warn('⚠️ Failed to persist documentation for session', sessionId, e?.message || e);
        }
      } else if (docResponse.payload.questions && docResponse.payload.requiresUserInput) {
        // Store pending doc questions with current context
        pendingDocQuestions.set(sessionId, {
          questions: docResponse.payload.questions,
          context: {
            ...docResponse.context,
            architecture: outputs.architecture,
            raml: prerequisites.raml,
            diagram: outputs.diagram,
            estimation: outputs.estimation,
            currentDocType: documentType
          },
          requirements: input || '',
          options: options
        });

        if (socket) {
          safeSocketEmit(socket, 'doc-questions-ready', { questions: docResponse.payload.questions });
          console.log(`📄 Documentation questions sent for ${documentType}: ${docResponse.payload.questions.length} questions`);
        }
      } else if (docResponse.payload.content) {
        // Fallback for content without documentGenerated flag
        const guardedDoc = guardOutput(docResponse.payload.content, 'documentation content');
        if (socket) {
          safeSocketEmit(socket, "documentation-ready", {
            content: guardedDoc.value,
            docType: documentType,
            message: guardedDoc.blocked ? guardedDoc.reason : `${documentType} documentation generated successfully!`
          });
        }
        console.log(`✅ ${documentType} documentation generated directly for session ${sessionId}`);
        // Persist document by type
        try {
          const existingDocs = sessionDocumentsByType.get(sessionId) || {};
          sessionDocumentsByType.set(sessionId, { ...existingDocs, [documentType || 'DOCUMENT']: guardedDoc.value });
          const meta = sessionMeta.get(sessionId);
          if (meta) { meta.updatedAt = new Date().toISOString(); sessionMeta.set(sessionId, meta); }
          saveStore();
        } catch (e) {
          console.warn('⚠️ Failed to persist fallback documentation for session', sessionId, e?.message || e);
        }
      } else {
        // Check if this is a failure response
        if (docResponse.payload.documentGenerated === false || docResponse.payload.text?.includes('failed')) {
          console.error(`❌ Documentation generation failed for ${documentType}:`, {
            length: docResponse.payload.text?.length || 0
          });
          if (socket) {
            safeSocketEmit(socket, "documentation-error", {
              message: docResponse.payload.text || `${documentType} document generation failed`,
              docType: documentType
            });
          }
        } else {
          console.warn(`⚠️ Unexpected response format from documentation agent:`, summarizeValue(docResponse.payload));
          if (socket) {
            safeSocketEmit(socket, "error", { message: `Unexpected response from documentation agent for ${documentType}` });
          }
        }
      }
    } else {
      console.error(`❌ Invalid response from documentation agent:`, summarizeValue(docResponse));
      emitSessionError(sessionId, { agent: 'Documentation', message: `Failed to generate ${documentType} documentation` });
    }
  } catch (error) {
    console.error(`❌ Error triggering documentation agent for session ${sessionId}:`, error);
    emitSessionError(sessionId, { agent: 'Documentation', message: `Documentation generation failed: ${error.message}` });
  }
}

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  const checkSocketGenerationLimit = () => {
    const identifier = socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      socket.handshake.address ||
      socket.id;
    const result = checkRateLimit('generation', identifier, { name: 'socket-generation' });
    if (!result.allowed) {
      socket.emit("error", {
        message: `Too many generation actions from this IP. Please wait ${result.retryAfterSeconds}s before trying again.`,
        retryAfterSeconds: result.retryAfterSeconds
      });
      return false;
    }
    return true;
  };

  socket.on("join-session", (data) => {
    const sessionId = requireSocketSessionAccess(socket, data);
    if (!sessionId) return;
    const { sessionToken } = getSocketSessionPayload(data);
    socket.data.sessionTokens = {
      ...(socket.data.sessionTokens || {}),
      [sessionId]: sessionToken || socket.data?.sessionTokens?.[sessionId]
    };
    const existingActiveSocket = activeConnections.get(sessionId);
    if (existingActiveSocket && existingActiveSocket.connected && existingActiveSocket.id !== socket.id) {
      console.log(`ℹ️ Client ${socket.id} joined session ${sessionId}; keeping active socket ${existingActiveSocket.id}`);
    } else {
      activeConnections.set(sessionId, socket);
    }
    socket.join(sessionId);
    console.log(`✅ Client ${socket.id} joined session ${sessionId}`);
    console.log(`📊 Active sessions: ${activeConnections.size}`);

    // Send confirmation
    socket.emit("session-joined", { sessionId, message: "Connected to generation session" });

    // If there are any pending events for this session (emitted before the client joined),
    // immediately deliver them now to avoid race conditions.
    try {
      // Flush any buffered progress events first so the frontend sees the
      // full history of classification/steps/completion for this session.
      const bufferedEvents = pendingProgressEvents.get(sessionId);
      if (Array.isArray(bufferedEvents) && bufferedEvents.length > 0) {
        console.log(`📡 Flushing ${bufferedEvents.length} buffered progress event(s) for session ${sessionId}`);
        for (const evt of bufferedEvents) {
          if (!evt || !evt.channel) continue;
          if (evt.channel === 'progress' && evt.payload) {
            safeSocketEmit(socket, 'progress', sanitizeProgressEvent(evt.payload));
          }
        }
        pendingProgressEvents.delete(sessionId);
      }

      const bufferedErrors = pendingErrorEvents.get(sessionId);
      if (Array.isArray(bufferedErrors) && bufferedErrors.length > 0) {
        console.log(`🚨 Flushing ${bufferedErrors.length} buffered error event(s) for session ${sessionId}`);
        for (const errorPayload of bufferedErrors) {
          safeSocketEmit(socket, 'error', errorPayload);
        }
        pendingErrorEvents.delete(sessionId);
      }

      const pendingDoc = pendingDocQuestions.get(sessionId);
      if (pendingDoc && Array.isArray(pendingDoc.questions) && pendingDoc.questions.length > 0) {
        console.log(`📄 Delivering pending documentation questions to session ${sessionId}`);
        const allQuestions = pendingDoc.questions;
        const docTypeRegex = /what\s+(type|kind)\s+of\s+(document|documentation)|what\s+type\s+of\s+documentation/i;
        const hasDocTypeQuestion = allQuestions.some(
          q => q && typeof q.question === 'string' && docTypeRegex.test(q.question)
        );

        const questionsForFrontend =
          hasDocTypeQuestion && allQuestions.length > 1
            ? [allQuestions.find(q => q && typeof q.question === 'string' && docTypeRegex.test(q.question))]
            : allQuestions;

        safeSocketEmit(socket, 'doc-questions-ready', { questions: questionsForFrontend });
        // Also let the client know we're waiting for documentation answers
        safeSocketEmit(socket, 'progress', { type: 'info', message: 'Awaiting documentation answers before final completion...' });
      }

      const pendingQs = pendingQuestions.get(sessionId);
      if (pendingQs && Array.isArray(pendingQs.questions) && pendingQs.questions.length > 0) {
        console.log(`❓ Delivering pending clarifying questions to session ${sessionId}`);
        safeSocketEmit(socket, 'questions-ready', { questions: pendingQs.questions });
      }

      const pendingAppr = pendingApproaches.get(sessionId);
      if (pendingAppr && Array.isArray(pendingAppr.approaches) && pendingAppr.approaches.length > 0 && !deliveredApproaches.has(sessionId)) {
        console.log(`📋 Delivering pending approaches to session ${sessionId}`);
        safeSocketEmit(socket, 'approaches-ready', { approaches: pendingAppr.approaches });
        deliveredApproaches.add(sessionId);
      }

      // Flush buffered documentation-ready payload (missed while socket was absent)
      // const pendingDoc = pendingDocumentationReady.get(sessionId);
      if (pendingDoc) {
        console.log(`📄 Delivering buffered documentation-ready to session ${sessionId}`);
        safeSocketEmit(socket, 'documentation-ready', pendingDoc);
        pendingDocumentationReady.delete(sessionId);
      }
    } catch (e) {
      console.warn(`⚠️ Failed delivering pending items for session ${sessionId}:`, e?.message || e);
    }
  });

  // Handle individual API RAML generation requests
  socket.on("generate-api-raml", async (data) => {
    if (!checkSocketGenerationLimit()) return;
    const authorizedSessionId = requireSocketSessionAccess(socket, data);
    if (!authorizedSessionId) return;
    const { sessionId, apiId, apiName, includeFields, fieldDefinitions } = data;
    console.log(`🔄 Generating RAML for individual API: ${apiName} (${apiId}) in session ${sessionId}`);
    const releaseJob = beginSessionJob(sessionId, `RAML ${apiId}`, { socket });
    if (!releaseJob) return;
    
    try {
      // Get existing session outputs for context
      const outputs = sessionOutputs.get(sessionId) || {};
      
      if (!outputs.architecture) {
        socket.emit("error", { message: "Architecture not found. Please generate architecture first." });
        return;
      }

      // Create a new AgentManager instance for this specific API generation
      const config = createSequenceConfig();
      const manager = new AgentManager(config, null, socket);
      
      // Create context for this specific API
      const apiContext = {
        sessionId,
        architecture: outputs.architecture,
        diagram: outputs.diagram,
        estimation: outputs.estimation,
        selectedApi: { id: apiId, name: apiName },
        includeFields,
        fieldDefinitions: fieldDefinitions || []
      };

      // Generate RAML specifically for this API
      const ramlAgent = manager.orchestrator.ramlAgent;
      const ramlContent = await ramlAgent._generateRAMLInternal(
        outputs.architecture,
        apiName,
        { selectedApi: { id: apiId, name: apiName }, includeFields, fieldDefinitions },
        apiContext
      );
      const guardedRaml = guardOutput(ramlContent, `raml content ${apiId}`);
      const validation = validateRamlArtifact(guardedRaml.value, `RAML for ${apiId}`);
      if (guardedRaml.blocked || !validation.valid) {
        socket.emit("error", {
          message: guardedRaml.reason || artifactValidationMessage(validation, 'Generated RAML failed validation.'),
          apiId,
          blockedBy: 'artifact-validation'
        });
        return;
      }

      // Store the RAML content for this specific API
      let apiRamlMap = sessionRamlByApi.get(sessionId) || {};
      apiRamlMap[apiId] = validation.value;
      sessionRamlByApi.set(sessionId, apiRamlMap);
      let ramlTasks = sessionRamlTasks.get(sessionId) || [];
      const apiKey = String(apiId);
      let tasksChanged = false;
      if (!ramlTasks.some(t => String(t.id) === apiKey)) {
        ramlTasks = [...ramlTasks, { id: apiKey, name: apiName || apiKey, description: '' }];
        sessionRamlTasks.set(sessionId, ramlTasks);
        tasksChanged = true;
      } else {
        const updatedTasks = ramlTasks.map(t => {
          if (String(t.id) !== apiKey) return t;
          const existingName = t.name && String(t.name).trim();
          if (existingName) return t;
          tasksChanged = true;
          return { ...t, name: apiName || apiKey };
        });
        if (tasksChanged) {
          sessionRamlTasks.set(sessionId, updatedTasks);
        }
      }
      try {
        const meta = sessionMeta.get(sessionId);
        if (meta) { meta.updatedAt = new Date().toISOString(); sessionMeta.set(sessionId, meta); }
        saveStore();
      } catch (e) {
        console.warn('⚠️ Failed to persist session store after per-API RAML save:', e?.message || e);
      }

      console.log(`✅ Generated RAML for API ${apiName} (${apiId}) - ${validation.value.length} characters`);

      // Emit the result back to the client
      safeSocketEmit(socket, "api-raml-generated", {
        apiId,
        apiName,
        ramlContent: validation.value,
        sessionId
      });

    } catch (error) {
      console.error(`❌ Error generating RAML for API ${apiName}:`, error);
      socket.emit("error", { 
        message: `Failed to generate RAML for ${apiName}: ${error.message}`,
        apiId 
      });
    } finally {
      releaseJob();
    }
  });

  // Handle Mule code generation requests
  socket.on("generate-mule-code", async (data) => {
    if (!checkSocketGenerationLimit()) return;
    const authorizedSessionId = requireSocketSessionAccess(socket, data);
    if (!authorizedSessionId) return;
    const { sessionId, apiId, apiName } = data;
    console.log(`🔄 Generating Mule code for API: ${apiName} (${apiId}) in session ${sessionId}`);
    const releaseJob = beginSessionJob(sessionId, `Mule Code ${apiId}`, { socket });
    if (!releaseJob) return;
    
    try {
      // Get existing session outputs for context
      const outputs = sessionOutputs.get(sessionId) || {};
      
      if (!outputs.architecture) {
        socket.emit("error", { message: "Architecture not found. Please generate architecture first." });
        return;
      }

      // Get RAML content for this API
      const apiRamlMap = sessionRamlByApi.get(sessionId) || {};
      const ramlContent = apiRamlMap[apiId];

      if (!ramlContent || typeof ramlContent !== 'string' || !ramlContent.trim()) {
        socket.emit("error", { message: "RAML not found for this API. Please generate RAML first." });
        return;
      }

      const ramlValidation = validateRamlArtifact(ramlContent, `RAML for ${apiId}`);
      if (!ramlValidation.valid) {
        socket.emit("error", {
          message: artifactValidationMessage(ramlValidation, 'RAML content failed validation.'),
          apiId,
          blockedBy: 'artifact-validation'
        });
        return;
      }

      // Create a new AgentManager instance for this specific Mule code generation
      const config = createSequenceConfig();
      const manager = new AgentManager(config, null, socket);
      
      // Create context for this specific API
      const apiContext = {
        sessionId,
        architecture: outputs.architecture,
        diagram: outputs.diagram,
        estimation: outputs.estimation,
        raml: ramlValidation.value,
        selectedApi: { id: apiId, name: apiName }
      };

      // Generate Mule code specifically for this API
      const muleCodeAgent = manager.orchestrator.muleCodeAgent;
      const muleProject = await muleCodeAgent.generateMuleCode(
        ramlValidation.value,
        apiName,
        { selectedApi: { id: apiId, name: apiName } },
        apiContext
      );
      const guardedMuleProject = guardOutput(muleProject, `mule project ${apiId}`);
      const muleValidation = validateMuleProjectArtifact(guardedMuleProject.value, `Mule project for ${apiId}`);
      if (guardedMuleProject.blocked || !muleValidation.valid) {
        socket.emit("error", {
          message: guardedMuleProject.reason || artifactValidationMessage(muleValidation, 'Generated Mule project failed validation.'),
          apiId,
          blockedBy: 'artifact-validation'
        });
        return;
      }

      // Store the Mule code for this specific API
      let apiMuleCodeMap = sessionMuleCodeByApi.get(sessionId) || {};
      apiMuleCodeMap[apiId] = muleValidation.value;
      sessionMuleCodeByApi.set(sessionId, apiMuleCodeMap);

      console.log(`✅ Generated Mule code for API ${apiName} (${apiId}) - ${muleValidation.value.files?.length || 0} files`);

      // Emit the result back to the client
      safeSocketEmit(socket, "mule-code-generated", {
        apiId,
        apiName,
        muleProject: muleValidation.value,
        sessionId
      });

    } catch (error) {
      console.error(`❌ Error generating Mule code for API ${apiName}:`, error);
      socket.emit("error", { 
        message: `Failed to generate Mule code for ${apiName}: ${error.message}`,
        apiId 
      });
    } finally {
      releaseJob();
    }
  });

  // Handle journey points submission
  // TWO entry paths reach this handler:
  //   Path A — Normal automated flow: diagram was generated, server threw WAIT_FOR_JOURNEY_POINTS,
  //            pendingJourneyPoints is populated. Use stored context + manager.
  //   Path B — Manual button click from diagram panel AFTER the normal flow already completed
  //            (or if user skipped the automated pause). pendingJourneyPoints is empty.
  //            Reconstruct context from sessionOutputs and create a fresh manager.
  socket.on("journey-points-submitted", async (data) => {
    if (!checkSocketGenerationLimit()) return;
    const authorizedSessionId = requireSocketSessionAccess(socket, data);
    if (!authorizedSessionId) return;
    const { sessionId, journeyPoints } = data;
    console.log(`📋 Journey points received for session ${sessionId}: ${journeyPoints?.length ?? 0} points`);
    const releaseJob = beginSessionJob(sessionId, 'Estimation', { socket });
    if (!releaseJob) return;
    let onProgress = null;

    try {
      // ── Path A: normal flow — pending state exists ────────────────────────────
      if (pendingJourneyPoints.has(sessionId)) {
        const pending = pendingJourneyPoints.get(sessionId);
        pendingJourneyPoints.delete(sessionId);
        const latestOutputs = sessionOutputs.get(sessionId) || {};
        const latestContext = {
          ...pending.context,
          architecture: latestOutputs.architecture || pending.context.architecture,
          diagram: latestOutputs.diagram || pending.context.diagram,
          diagramData: latestOutputs.diagramData || pending.context.diagramData || null,
          useCases: Array.isArray(latestOutputs.useCases) ? latestOutputs.useCases : (pending.context.useCases || []),
          requirements: latestOutputs.requirements || pending.context.requirements
        };
        await continueEstimationWithJourneyPoints(
          sessionId,
          latestContext,
          journeyPoints,
          pending.options,
          pending.onProgress,
          pending.manager,
          socket
        );
        return;
      }

      // ── Path B: manual button click — reconstruct context from session outputs ─
      console.log(`ℹ️ No pending journey points state for session ${sessionId} — manual trigger, reconstructing context`);

      const outputs = sessionOutputs.get(sessionId);
      if (!outputs?.architecture) {
        socket.emit("error", { message: "No architecture found for this session. Please generate architecture first." });
        return;
      }

    // Build a fresh onProgress that resolves the current socket
    onProgress = (event) => {
      const activeSocket = activeConnections.get(sessionId);
      if (activeSocket?.connected) {
        activeSocket.emit("progress", event);
        return;
      }
      const existing = pendingProgressEvents.get(sessionId) || [];
      existing.push({ channel: 'progress', payload: event });
      pendingProgressEvents.set(sessionId, existing);
    };

    // Announce estimation starting so the frontend updates the agent panel
    onProgress({
      type: "step",
      step: 3,
      agent: "Estimation",
      status: "working",
      message: "Generating estimation with journey points..."
    });

    const context = {
      sessionId,
      architecture: outputs.architecture,
      diagram: outputs.diagram || null,
      diagramData: outputs.diagramData || null,
      useCases: Array.isArray(outputs.useCases) ? outputs.useCases : [],
      requirements: outputs.requirements || "",
      estimation: null
    };

    // Create a fresh manager using the same config factory used everywhere else
    const config = createSequenceConfig(undefined, 'auto');
    const manager = new AgentManager(config, null, socket);
    const options = {};

      await continueEstimationWithJourneyPoints(
        sessionId,
        context,
        journeyPoints,
        options,
        onProgress,
        manager,
        socket
      );
    } catch (error) {
      console.error(`❌ Error continuing estimation with journey points (Path B):`, error);
      socket.emit("error", { message: `Failed to continue estimation: ${error.message}` });
      if (onProgress) onProgress({
        type: "step",
        agent: "Estimation",
        status: "error",
        message: `Estimation failed: ${error.message}`
      });
    } finally {
      releaseJob();
    }
  });

  socket.on("disconnect", () => {
    // Remove from active connections
    for (const [sessionId, s] of activeConnections.entries()) {
      if (s === socket) {
        activeConnections.delete(sessionId);
        console.log(`Client ${socket.id} left session ${sessionId}`);
        break;
      }
    }
  });
});

if (fs.existsSync(clientBuildPath)) {
  app.use(express.static(clientBuildPath));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/socket.io/") || req.path.startsWith("/download-word/")) {
      return next();
    }
    return res.sendFile(path.join(clientBuildPath, "index.html"));
  });
} else {
  console.warn(`⚠️ React build not found at ${clientBuildPath}. Run "cd client && npm run build" before production start.`);
}

const PORT = process.env.BACKEND_PORT || 5001;
const HOST = process.env.BACKEND_HOST || "localhost";
httpServer.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on http://${HOST}:${PORT}`);
  console.log(`📡 WebSocket server ready for connections`);
  if (fs.existsSync(clientBuildPath)) {
    console.log(`🖥️ Serving React app from ${clientBuildPath}`);
  }
});
