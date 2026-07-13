import React, { useState, useEffect, useRef, useCallback } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import './App.css';
import OutputViewer from './components/OutputViewer';
import DependencyChain from './components/DependencyChain';
import ApproachSelector from './components/ApproachSelector';
import QuestionModal from './components/QuestionModal';
import JourneyPointsModal from './components/JourneyPointsModal';
import ToolsConfirmationModal from './components/ToolsConfirmationModal';
import TokenUtilizationDashboard from './components/TokenUtilizationDashboard';
import API_BASE_URL from './config';
// import RamlAgentModal from './components/RamlAgentModal'; // Commented out to disable popup

const ACTIVE_SESSION_STORAGE_KEY = 'mulegenie_active_session_id';
const SESSION_TOKENS_STORAGE_KEY = 'mulegenie_session_tokens';
const RUNTIME_INSTANCE_STORAGE_KEY = 'mulegenie_runtime_instance_id';

function readStoredSessionTokens() {
  try {
    const raw = window.localStorage.getItem(SESSION_TOKENS_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    return new Map(Object.entries(parsed || {}).filter(([, token]) => typeof token === 'string' && token));
  } catch (_) {
    return new Map();
  }
}

function writeStoredSessionTokens(tokens) {
  try {
    window.localStorage.setItem(
      SESSION_TOKENS_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(tokens.entries()))
    );
  } catch (_) {
    // Ignore storage failures; in-memory tokens still work for this page.
  }
}

function readActiveSessionId() {
  try {
    return window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY) || '';
  } catch (_) {
    return '';
  }
}

function writeActiveSessionId(sessionId) {
  try {
    if (sessionId) {
      window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
    } else {
      window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    }
  } catch (_) {
    // Ignore storage failures.
  }
}

function readRuntimeInstanceId() {
  try {
    return window.localStorage.getItem(RUNTIME_INSTANCE_STORAGE_KEY) || '';
  } catch (_) {
    return '';
  }
}

function writeRuntimeInstanceId(runtimeInstanceId) {
  try {
    if (runtimeInstanceId) {
      window.localStorage.setItem(RUNTIME_INSTANCE_STORAGE_KEY, runtimeInstanceId);
    } else {
      window.localStorage.removeItem(RUNTIME_INSTANCE_STORAGE_KEY);
    }
  } catch (_) {
    // Ignore storage failures.
  }
}

function previewText(value, limit = 80) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}...` : clean;
}

function summarizeSocketPayload(data = {}) {
  if (!data || typeof data !== 'object') return data;
  return {
    keys: Object.keys(data),
    type: data.type,
    agent: data.agent,
    status: data.status,
    message: previewText(data.message),
    questions: Array.isArray(data.questions) ? data.questions.length : undefined,
    approaches: Array.isArray(data.approaches) ? data.approaches.length : undefined,
    tasks: Array.isArray(data.tasks) ? data.tasks.length : undefined,
    docType: data.docType,
    contentLength: typeof data.content === 'string' ? data.content.length : undefined,
    dataLength: typeof data.data === 'string' ? data.data.length : undefined
  };
}

function summarizeAnswers(answers = []) {
  return (Array.isArray(answers) ? answers : []).map(answer => ({
    question: previewText(answer?.question, 60),
    answerLength: typeof answer?.answer === 'string' ? answer.answer.length : 0,
    answerPreview: previewText(answer?.answer, 80)
  }));
}

function normalizeErrorMessage(error, fallback = 'Something went wrong while processing your request.') {
  const blockedBy = error?.blockedBy || error?.response?.data?.blockedBy;
  if (blockedBy === 'input-guardrail') {
    return 'This request cannot be processed because it appears to involve unsafe or unsupported activity. Please revise the requirement and try again.';
  }
  if (blockedBy === 'request-budget') {
    return 'This request is too large to process safely in one run. Please reduce the scope or split it into smaller requests.';
  }

  const raw =
    typeof error === 'string'
      ? error
      : error?.message || error?.error || error?.response?.data?.error || error?.response?.data?.message || fallback;
  const message = String(raw || fallback).replace(/\s+/g, ' ').trim();
  const lower = message.toLowerCase();

  if (
    lower.includes('outbound llm request contains sensitive tenant data') ||
    lower.includes('sensitive tenant data') ||
    lower.includes('sensitive client_secret assignment') ||
    lower.includes('hardcoded credential')
  ) {
    return 'This request or generated content appears to include sensitive credential information. Please replace secrets with secure placeholders and try again.';
  }

  if (lower.includes('insufficient') || lower.includes('balance') || lower.includes('credit') || lower.includes('quota')) {
    return 'The selected LLM provider could not continue because the account balance, quota, or credits appear to be too low. Please add credits or switch provider, then try again.';
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    return 'The selected LLM provider is rate-limiting requests right now. Please wait a moment or switch provider, then try again.';
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return 'The request timed out before the LLM completed. Please try again with a smaller request or switch to a faster provider.';
  }
  if (lower.includes('api key') || lower.includes('401') || lower.includes('unauthorized')) {
    return 'The selected LLM provider rejected the API key. Please check the key or switch provider.';
  }
  if (lower.includes('all providers failed')) {
    return 'All configured LLM providers failed for this request. Please check provider keys, balance/quota, and network connectivity.';
  }

  return message;
}

function isSensitiveGuardrailDetail(value) {
  return /outbound llm request contains sensitive tenant data|sensitive tenant data|hardcoded credential|sensitive client_secret assignment/i.test(String(value || ''));
}

function getUserFacingErrorTitle(blockedBy, fallbackTitle) {
  if (blockedBy === 'input-guardrail') return 'Request cannot be processed';
  if (blockedBy === 'request-budget') return 'Request is too large';
  return fallbackTitle;
}

function getUserFacingErrorDetails(responseData = {}) {
  if (responseData.blockedBy === 'input-guardrail' || responseData.blockedBy === 'request-budget') return '';
  const rawDetail = String(responseData.error || responseData.message || responseData.details || '');
  if (isSensitiveGuardrailDetail(rawDetail)) {
    return '';
  }
  return responseData.blockedBy
    ? `Blocked by: ${responseData.blockedBy}`
    : responseData.details;
}

function App() {
  const [authReady, setAuthReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [authUser, setAuthUser] = useState(null);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [input, setInput] = useState('');
  const [apiName] = useState('MuleSoftAPI');
  const [isProcessing, setIsProcessing] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const sessionIdRef = useRef(null);
  const sessionTokensRef = useRef(readStoredSessionTokens());
  const [classification, setClassification] = useState(null);
  const [showApproachSelector, setShowApproachSelector] = useState(false);
  const [approaches, setApproaches] = useState(null);
  const [showToolsConfirmation, setShowToolsConfirmation] = useState(false);
  const [selectedApproachNumber, setSelectedApproachNumber] = useState(null);
  const [selectedApproachObj, setSelectedApproachObj] = useState(null);
  const [showQuestionModal, setShowQuestionModal] = useState(false);
  const [isFollowUpRound, setIsFollowUpRound] = useState(false); // true = Round 2 follow-up
  const [questions, setQuestions] = useState(null);
  const [isProcessingQuestions, setIsProcessingQuestions] = useState(false);
  const questionSessionIdRef = useRef(null);
  const [showDocQuestionModal, setShowDocQuestionModal] = useState(false);
  const [docQuestions, setDocQuestions] = useState(null);
  const [isProcessingDocQuestions, setIsProcessingDocQuestions] = useState(false);
  const showDocQuestionModalRef = useRef(false);
  const [showJourneyPointsModal, setShowJourneyPointsModal] = useState(false);
  const [isProcessingJourneyPoints, setIsProcessingJourneyPoints] = useState(false);
  const journeyPointsSessionIdRef = useRef(null);
  const listenersAttachedRef = useRef(false);
  const listenerSocketRef = useRef(null);
  const architectureStreamRef = useRef({ streamId: null, lastSequence: -1 });
  const estimationStreamRef = useRef({ streamId: null, lastSequence: -1 });
  // const [showRamlAgentModal, setShowRamlAgentModal] = useState(false); // Commented out to disable popup
  const [ramlApiTasks, setRamlApiTasks] = useState([]);
  const [ramlSelectedApiId, setRamlSelectedApiId] = useState(null);
  const [isRamlSelectionPending, setIsRamlSelectionPending] = useState(false);
  const ramlSelectedApiIdRef = useRef(null);
  const [agents, setAgents] = useState({
    Manager: { status: 'idle', message: '', data: null },
    Architecture: { status: 'idle', message: '', data: null },
    Diagram: { status: 'idle', message: '', data: null },
    Estimation: { status: 'idle', message: '', data: null },
    RAML: { status: 'idle', message: '', data: null },
    Documentation: { status: 'idle', message: '', data: null },
    General: { status: 'idle', message: '', data: null }
  });

  // Session Manager state
  const [sessions, setSessions] = useState([]); // [{id,name}]
  const [activeSessionName, setActiveSessionName] = useState('');
  const [outputs, setOutputs] = useState({
    architecture: null,
    diagram: null,
    diagramData: null,
    useCases: null,
    estimation: null,
    raml: null,
    document: null,
    general: null
  });
  const [documentsByType, setDocumentsByType] = useState({});
  const [docPendingByType, setDocPendingByType] = useState({});
  const [ramlByApi, setRamlByApi] = useState({}); // Store RAML per API ID
  const [loadingApiIds, setLoadingApiIds] = useState(new Set()); // Track which APIs are currently loading
  const [muleCodeGenerated, setMuleCodeGenerated] = useState(new Set()); // Track which APIs have Mule code generated
  const [, setLogs] = useState([]);
  const [provider, setProvider] = useState('auto');
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [appError, setAppError] = useState(null);
  const socketRef = useRef(null);
  const [activeDocType, setActiveDocType] = useState(null);
  const activeDocTypeRef = useRef(null);
  const [generatingDocType, setGeneratingDocType] = useState(null);
  const [, setAvailableModels] = useState({
    gemini: false,
    groq: false,
    anthropic: false,
    openai: false,
    openrouter: false
  });
  const [activeView, setActiveView] = useState('main'); // 'main' or 'dashboard'
  const isInitializedRef = useRef(false); // ADDED: New ref to track initialization

  const getSessionToken = useCallback((sid = sessionIdRef.current) => {
    if (!sid) return '';
    return sessionTokensRef.current.get(sid) || '';
  }, []);

  const rememberSessionToken = useCallback((sid, token) => {
    if (sid && token) {
      sessionTokensRef.current.set(sid, token);
      writeStoredSessionTokens(sessionTokensRef.current);
    }
  }, []);

  const buildJoinSessionPayload = useCallback((sid) => ({
    sessionId: sid,
    sessionToken: getSessionToken(sid)
  }), [getSessionToken]);

  useEffect(() => {
    const interceptorId = axios.interceptors.request.use(config => {
      config.withCredentials = true;
      let data = config.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (_) { data = null; }
      }

      const url = config.url || '';
      const sessionPathMatch =
        url.match(/\/api\/sessions\/([^/?]+)/) ||
        url.match(/\/download-word\/([^/?]+)/);
      const sid =
        data?.sessionId ||
        (sessionPathMatch ? decodeURIComponent(sessionPathMatch[1]) : null);
      const token = getSessionToken(sid);

      if (sid && token) {
        config.headers = config.headers || {};
        config.headers['x-session-token'] = token;
      }

      return config;
    });

    return () => axios.interceptors.request.eject(interceptorId);
  }, [getSessionToken]);

  useEffect(() => {
    let active = true;
    axios.get(`${API_BASE_URL}/api/auth/status`, { withCredentials: true })
      .then(response => {
        if (!active) return;
        const runtimeInstanceId = response.data?.runtimeInstanceId || '';
        const storedRuntimeInstanceId = readRuntimeInstanceId();
        if (runtimeInstanceId && storedRuntimeInstanceId !== runtimeInstanceId) {
          writeActiveSessionId('');
          sessionTokensRef.current.clear();
          writeStoredSessionTokens(sessionTokensRef.current);
          setSessions([]);
          setSessionId(null);
          sessionIdRef.current = null;
          setOutputs({
            architecture: null,
            diagram: null,
            diagramData: null,
            useCases: null,
            estimation: null,
            raml: null,
            document: null,
            general: null
          });
          isInitializedRef.current = false;
        }
        if (runtimeInstanceId) {
          writeRuntimeInstanceId(runtimeInstanceId);
        }
        setAuthenticated(!!response.data?.authenticated);
        setAuthUser(response.data?.user || null);
      })
      .catch(() => {
        if (!active) return;
        setAuthenticated(false);
        setAuthUser(null);
      })
      .finally(() => {
        if (active) setAuthReady(true);
      });
    return () => { active = false; };
  }, []);

  const handleLogin = useCallback(async (event) => {
    event.preventDefault();
    setLoginError('');
    setIsSigningIn(true);
    try {
      const response = await axios.post(
        `${API_BASE_URL}/api/auth/login`,
        { username: loginUsername, password: loginPassword },
        { withCredentials: true }
      );
      setAuthenticated(true);
      setAuthUser(response.data?.user || { id: loginUsername });
      setLoginPassword('');
      isInitializedRef.current = false;
    } catch (error) {
      setLoginError(error.response?.data?.error || 'Unable to sign in');
    } finally {
      setIsSigningIn(false);
    }
  }, [loginUsername, loginPassword]);

  const handleLogout = useCallback(async () => {
    try {
      await axios.post(`${API_BASE_URL}/api/auth/logout`, {}, { withCredentials: true });
    } finally {
      socketRef.current?.disconnect();
      socketRef.current = null;
      sessionTokensRef.current.clear();
      setAuthenticated(false);
      setAuthUser(null);
      setSessions([]);
      setSessionId(null);
      sessionIdRef.current = null;
      isInitializedRef.current = false;
    }
  }, []);

  const showAppError = useCallback((error, context = {}) => {
    const message = normalizeErrorMessage(error);
    const detailSource =
      typeof error === 'object'
        ? error?.errorDetails || error?.details || error?.response?.data?.error || error?.message
        : error;
    const detail = detailSource && String(detailSource) !== message && !isSensitiveGuardrailDetail(detailSource)
      ? previewText(detailSource, 500)
      : '';

    setIsProcessing(false);
    setIsProcessingQuestions(false);
    setIsProcessingDocQuestions(false);
    setIsProcessingJourneyPoints(false);
    setIsRamlSelectionPending(false);
    setShowApproachSelector(false);
    if (!context.preserveQuestionModal) {
      setShowQuestionModal(false);
    }
    if (!context.preserveDocQuestionModal) {
      setShowDocQuestionModal(false);
    }
    setDocPendingByType({});
    setGeneratingDocType(null);
    setActiveDocType(null);
    setLoadingApiIds(new Set());

    const agentName = context.agent || error?.agent || 'Manager';
    setAgents(prev => {
      const next = {};
      for (const [name, agent] of Object.entries(prev)) {
        next[name] = agent?.status === 'working'
          ? { ...agent, status: 'idle', message: '', data: null }
          : agent;
      }
      next[agentName] = {
        ...(next[agentName] || {}),
        status: 'error',
        message,
        data: null
      };
      return next;
    });

    setLogs(prev => [...prev, { type: 'error', message, timestamp: new Date() }]);
    setAppError({
      title: context.title || 'Generation failed',
      message,
      detail,
      provider: error?.provider || context.provider || null,
      timestamp: new Date()
    });
  }, []);

  // Setup socket listeners (extracted to reusable function).
  // Keep listener attachment idempotent; reconnects reuse the same socket object.
  const setupSocketListeners = useCallback((socket) => {
    if (!socket) return;
    if (listenersAttachedRef.current && listenerSocketRef.current === socket) {
      return;
    }

    socket.on('session-joined', (data) => {
      console.log('✅ Session joined:', summarizeSocketPayload(data));
      setLogs(prev => [...prev, { type: 'info', message: 'Connected to processing session', timestamp: new Date() }]);
    });

    socket.on('doc-questions-ready', (data) => {
      console.log('📄 Documentation questions ready:', summarizeSocketPayload(data));
      // Show the modal regardless of whether the user has pre-selected a doc type.
      // The server only emits this when it genuinely needs answers; dropping it
      // silently would leave the workflow permanently stuck.
      setDocQuestions(data.questions);
      setShowDocQuestionModal(true);
      showDocQuestionModalRef.current = true;
      setIsProcessing(false);
      setIsProcessingDocQuestions(false);
      setAgents(prev => ({
        ...prev,
        Documentation: { status: 'working', message: `Answer ${data.questions.length} documentation questions to continue`, data: data.questions }
      }));
    });

    socket.on('progress', (event) => {
      console.log('📡 Progress received:', summarizeSocketPayload(event));
      handleProgress(event);
    });

    socket.on('questions-ready', (data) => {
      console.log('❓ Questions ready:', summarizeSocketPayload(data));
      setQuestions(data.questions);
      setShowQuestionModal(true);
      // Bind these questions to the current active session
      questionSessionIdRef.current = sessionIdRef.current;
      setIsProcessing(false);
      setAgents(prev => ({
        ...prev,
        Architecture: { status: 'completed', message: `Generated ${data.questions.length} questions`, data: data.questions }
      }));
    });

    socket.on('questions-validation-failed', (data) => {
      console.log('❌ Questions validation failed:', summarizeSocketPayload(data));
      setQuestions(data.questions);
      setShowQuestionModal(true);
      questionSessionIdRef.current = sessionIdRef.current;
      setIsProcessingQuestions(false);
      setIsProcessing(false);
      showAppError(
        { message: 'Some answers are not relevant. Please provide specific answers related to each question.' },
        { agent: 'Architecture', title: 'Answers need more detail', preserveQuestionModal: true }
      );
      setAgents(prev => ({
        ...prev,
        Architecture: {
          status: 'needs-input',
          message: 'Please update the highlighted answers and submit again',
          data: data.questions
        }
      }));
    });

    socket.on('questions-validated', (data) => {
      console.log('✅ Questions validated:', summarizeSocketPayload(data));
      setIsProcessingQuestions(true);
      setIsProcessing(true);
      setAgents(prev => ({
        ...prev,
        Architecture: { status: 'working', message: 'Validating answers and generating approaches...', data: null }
      }));
    });

     // ── Round 2: follow-up questions ─────────────────────────────────────────
    // Triggered when Round 1 answers had a vague/contradictory/gap-opening answer.
    // Reuses the same question modal with a "quick follow-up" header instead.
    // Maximum 2 questions — user won't see this at all if Round 1 was clear.
    socket.on('followup-questions', (data) => {
      console.log('🔄 Follow-up questions (Round 2):', summarizeSocketPayload(data));
      setQuestions(data.questions);
      setIsFollowUpRound(true);   // tells modal to show "Just a quick follow-up..." header
      setShowQuestionModal(true);
      setIsProcessingQuestions(false);
      setIsProcessing(false);
      questionSessionIdRef.current = sessionIdRef.current;
      setAgents(prev => ({
        ...prev,
        Architecture: {
          status: 'needs-input',
          message: `One quick follow-up before generating approaches`,
          data: data.questions
        }
      }));
    });

    socket.on('approaches-ready', (data) => {
      console.log('📋 Approaches ready:', summarizeSocketPayload(data));
      setApproaches(data.approaches);
      setShowQuestionModal(false);
      setIsFollowUpRound(false);
      setIsProcessingQuestions(false);
      setShowApproachSelector(true);
      setIsProcessing(false);
      setAgents(prev => ({
        ...prev,
        Architecture: { status: 'completed', message: `Generated ${data.approaches.length} approaches`, data: data.approaches }
      }));
    });

    socket.on('raml-agent-started', async (data) => {
      console.log('🔄 RAML Agent started processing', summarizeSocketPayload(data));
      console.log('🔍 RAML Agent Started Debug:', {
        hasTasks: Array.isArray(data.tasks),
        tasksCount: data.tasks?.length || 0,
        taskIds: data.tasks?.map(t => t.id) || []
      });
      const rawTasks = Array.isArray(data.tasks) ? data.tasks : [];
      if (rawTasks.length === 0) {
        setIsRamlSelectionPending(false);
        setRamlSelectedApiId(null);
        setLoadingApiIds(new Set());
        setAgents(prev => ({
          ...prev,
          RAML: {
            status: 'idle',
            message: data.message || 'No RAML API topics identified yet.',
            data: null
          }
        }));
        return;
      }
      // Persist RAML tasks to backend so they survive tab changes/reloads
      try {
        const sid = data.sessionId || sessionIdRef.current;
        if (sid) {
          const tasks = rawTasks.map(t => ({ id: t.id, name: t.name, description: t.description || '' }));
          // Save tasks and placeholders immediately so UI has stable names on first render
          if (tasks.length) {
            await Promise.all([
              axios.post(`${API_BASE_URL}/api/sessions/${sid}/raml/tasks`, { tasks }).catch(() => {}),
              axios.post(`${API_BASE_URL}/api/sessions/${sid}/raml/placeholders`, { items: tasks }).catch(() => {}),
              axios.post(`${API_BASE_URL}/api/sessions/${sid}/raml/tasks/ensure`, { tasks }).catch(() => {})]);
          }

          // Always try to refresh from server so names match what is persisted in store.json
          try {
            const outputsRes = await axios.get(`${API_BASE_URL}/api/sessions/${sid}/outputs`);
            const serverRamlTasks = outputsRes.data?.ramlTasks;
            if (Array.isArray(serverRamlTasks) && serverRamlTasks.length > 0) {
              setRamlApiTasks(serverRamlTasks);
            } else {
              setRamlApiTasks(tasks.length ? tasks : rawTasks);
            }
          } catch (err) {
            console.warn('Failed to refresh RAML tasks from server outputs:', err?.message || err);
            setRamlApiTasks(tasks.length ? tasks : rawTasks);
          }
        } else {
          console.warn('⚠️ Could not resolve sessionId for RAML tasks', { count: rawTasks.length });
          setRamlApiTasks(rawTasks);
        }
      } catch (e) {
        console.warn('⚠️ Error while persisting/refreshing RAML tasks:', e?.message || e);
        setRamlApiTasks(rawTasks);
      }
      setIsRamlSelectionPending(false);
      setRamlSelectedApiId(null);
      // setShowRamlAgentModal(true); // Commented out to disable popup - RAML process continues automatically
      
      // Auto-select first API to continue process without popup
      if (false && Array.isArray(data.tasks) && data.tasks.length > 0) {
        const firstApi = data.tasks[0];
        console.log('🤖 Auto-selecting first API for RAML generation:', firstApi.name);
        
        // Simulate user selection automatically
        setTimeout(() => {
          socketRef.current.emit('raml-agent-continue', {
            sessionId: data.sessionId,
            timestamp: new Date().toISOString(),
            selectedApiId: firstApi.id,
            selectedApi: firstApi,
            includeFields: false, // Generate without fields by default
            fieldDefinitions: []
          });
          
          setRamlSelectedApiId(firstApi.id);
          setIsRamlSelectionPending(false);
          
          setLogs(prev => [...prev, {
            type: 'info',
            message: `Auto-selected API "${firstApi.name}" for RAML generation`,
            timestamp: new Date()
          }]);
        }, 1000); // Small delay to ensure state is set
      }
      
      setLogs(prev => [...prev, {
        type: 'info',
        message: `RAML Agent identified ${rawTasks.length} API topic(s)`,
        timestamp: new Date()
      }]);
    });

    socket.on('error', (error) => {
      console.error('❌ Socket error:', error);
      showAppError(error, { agent: error?.agent || 'Manager' });
    });

    socket.on('documentation-error', (error) => {
      console.error('❌ Documentation error:', error);
      showAppError(error, { agent: 'Documentation', title: 'Documentation failed' });
    });

    socket.on('documentation-ready', (data) => {
      console.log('📄 Documentation ready:', summarizeSocketPayload(data));
      console.log(`🔍 Clearing generatingDocType (was generating: ${data.docType})`);
      setShowDocQuestionModal(false);
      showDocQuestionModalRef.current = false;
      setIsProcessingDocQuestions(false);
      setIsProcessing(false);
      const docType = data.docType || 'DOCUMENT';
      setDocumentsByType(prev => ({
        ...prev,
        [docType]: data.content
      }));
      setDocPendingByType(prev => {
        const next = { ...prev };
        next[docType] = false;
        return next;
      });
      setActiveDocType(null);
      setGeneratingDocType(null);
      setAgents(prev => ({
        ...prev,
        Documentation: { status: 'completed', message: 'Documentation generated successfully!', data: data.content }
      }));
      setOutputs(prev => ({ ...prev, document: data.content }));
    });

    socket.on('connect_error', (error) => {
      console.error('❌ WebSocket connection error:', error);
      setConnectionStatus(socket.active ? 'reconnecting' : 'error');
    });

    socket.on('disconnect', (reason) => {
      console.log('⚠️ WebSocket disconnected:', reason);
      setConnectionStatus(socket.active ? 'reconnecting' : 'disconnected');
    });

    socket.on('connect', () => {
      console.log('✅ WebSocket connected');
      setConnectionStatus('connected');
      const currentSessionId = sessionIdRef.current;
      if (currentSessionId) {
        socket.emit('join-session', buildJoinSessionPayload(currentSessionId));
      }
    });

    socket.on('api-raml-generated', (data) => {
      console.log('🔍 Individual API RAML generated:', {
        apiId: data.apiId,
        apiName: data.apiName,
        ramlContentLength: data.ramlContent?.length || 0
      });
      
      // Store the RAML content for this specific API
      setRamlByApi(prev => {
        const updated = { ...prev, [data.apiId]: data.ramlContent };
        console.log('🔍 Updated ramlByApi with individual API:', Object.keys(updated));
        return updated;
      });
      
      // Remove from loading state
      setLoadingApiIds(prev => {
        const updated = new Set(prev);
        updated.delete(data.apiId);
        return updated;
      });
      
      // Clear processing states
      setIsProcessing(false);
      setIsRamlSelectionPending(false);
      
      // Update agent status
      setAgents(prev => ({
        ...prev,
        RAML: { 
          status: 'completed', 
          message: `Generated RAML for ${data.apiName}`, 
          data: data.ramlContent 
        }
      }));
      
      setLogs(prev => [...prev, {
        type: 'success',
        message: `RAML generated for ${data.apiName}`,
        timestamp: new Date()
      }]);
    });

    listenersAttachedRef.current = true;
    listenerSocketRef.current = socket;
  }, [showAppError, buildJoinSessionPayload]);

  const getSocket = useCallback(() => {
    let socket = socketRef.current;
    if (socket) {
      setupSocketListeners(socket);
      if (socket.disconnected) {
        socket.connect();
      }
      return socket;
    }

    socket = io(`${API_BASE_URL}`, {
      withCredentials: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 30000
    });
    socketRef.current = socket;
    listenersAttachedRef.current = false;
    listenerSocketRef.current = null;
    setupSocketListeners(socket);
    return socket;
  }, [setupSocketListeners]);

  const emitWhenConnected = useCallback((eventName, payload) => {
    const socket = getSocket();
    if (socket.connected) {
      socket.emit(eventName, payload);
      return true;
    }

    setConnectionStatus('reconnecting');
    socket.connect();
    socket.once('connect', () => {
      socket.emit(eventName, payload);
    });
    return true;
  }, [getSocket]);

  // Save user input to backend
  const saveUserInput = useCallback(async (inputText, sessionIdToSave) => {
    const sid = sessionIdToSave || sessionId;
    if (!sid) return;
    try {
      await axios.post(`${API_BASE_URL}/api/sessions/${sid}/input`, { input: inputText });
    } catch (e) {
      console.warn('Failed to save user input:', e?.message || e);
    }
  }, [sessionId]);

  // Define selectSession BEFORE other callbacks that depend on it
  const selectSession = useCallback(async (id, name, opts = {}) => {
    try {
      // If there are open modals, close them before switching tabs
      if (showQuestionModal) {
        setShowQuestionModal(false);
        setQuestions(null);
        setIsProcessingQuestions(false);
      }
      if (showDocQuestionModal) {
        setShowDocQuestionModal(false);
        showDocQuestionModalRef.current = false;
        setDocQuestions(null);
        setIsProcessingDocQuestions(false);
        setActiveDocType(null);
        setGeneratingDocType(null);
      }
      if (showJourneyPointsModal) {
        setShowJourneyPointsModal(false);
        setIsProcessingJourneyPoints(false);
        journeyPointsSessionIdRef.current = null;
      }
      if (showApproachSelector) {
        setShowApproachSelector(false);
        setApproaches(null);
      }
      
      // Reset processing states when switching tabs
      setIsProcessing(false);

      // Save current input before switching sessions
      if (sessionId && input.trim()) {
        await saveUserInput(input, sessionId);
      }
      sessionIdRef.current = id;
      setSessionId(id);
      writeActiveSessionId(id);
      setActiveSessionName(name || '');
      // Join socket room
      const socket = getSocket();
      socket.emit('join-session', buildJoinSessionPayload(id));

      // Fetch outputs for that session
      const res = await axios.get(`${API_BASE_URL}/api/sessions/${id}/outputs`);
      const { outputs: out = {}, documentsByType: docs = {}, ramlByApi: ramlMap = {}, ramlTasks: serverRamlTasks = [] } = res.data || {};
      setOutputs({
        architecture: out.architecture || null,
        diagram: out.diagram || null,
        diagramData: out.diagramData || null,
        useCases: Array.isArray(out.useCases) ? out.useCases : null,
        estimation: out.estimation || null,
        raml: out.raml || null,
        document: null,
        general: out.general || null
      });
      setDocumentsByType(docs || {});
      setRamlByApi(ramlMap || {});
      setDocPendingByType({});
      // Prefer server-provided RAML tasks; else derive minimal placeholders from ramlByApi keys
      let rebuiltTasks = Array.isArray(serverRamlTasks) ? serverRamlTasks : [];
      try {
        if ((!rebuiltTasks || rebuiltTasks.length === 0) && ramlMap && typeof ramlMap === 'object') {
          const keys = Object.keys(ramlMap);
          if (keys.length) {
            rebuiltTasks = keys.map((k, i) => ({ id: k, name: serverRamlTasks?.find(t=>t.id===k)?.name || `API ${i+1}`, description: '' }));
          }
        }
      } catch (e) {
        console.warn('Failed to rebuild RAML tasks from raml map:', e?.message || e);
      }
      setRamlApiTasks(rebuiltTasks);
      // Do not auto-persist rebuilt tasks from estimation; rely on tasks generated/saved by RAML agent
      setRamlSelectedApiId(null);
      setIsRamlSelectionPending(false);
      // Reset agent statuses to reflect this session only
      setAgents({
        Manager: { status: 'idle', message: '', data: null },
        Architecture: { status: out.architecture ? 'completed' : 'idle', message: '', data: null },
        Diagram: { status: out.diagram ? 'completed' : 'idle', message: '', data: null },
        Estimation: { status: out.estimation ? 'completed' : 'idle', message: '', data: null },
        RAML: { status: (out.raml || (ramlMap && Object.keys(ramlMap).length > 0)) ? 'completed' : 'idle', message: '', data: null },
        Documentation: { status: (docs && Object.keys(docs).length > 0) ? 'completed' : 'idle', message: '', data: null },
        General: { status: out.general ? 'completed' : 'idle', message: '', data: null }
      });
      // Load user input from backend and clear classification
      try {
        const inputRes = await axios.get(`${API_BASE_URL}/api/sessions/${id}/input`);
        setInput(inputRes.data?.input || '');
      } catch (e) {
        console.warn('Failed to load user input for session:', e?.message || e);
        setInput('');
      }
      setClassification(null);
    } catch (e) {
      console.error('Failed to select session', e);
    }
  }, [getSocket, saveUserInput, input, sessionId, buildJoinSessionPayload]);

  // Create session (must be defined before deleteSession and fetchSessions)
  const createNewSession = useCallback(async (name) => {
    console.log('🔄 createNewSession called');
    try {
      const res = await axios.post(`${API_BASE_URL}/api/sessions`, { name });
      const meta = res.data;
      console.log('✅ New session created by backend:', meta);
      rememberSessionToken(meta.id, meta.sessionToken);
      setSessions(prev => [...prev, meta]); // Revert: Add new session to existing ones
      await selectSession(meta.id, meta.name, { clearInputs: true });
      console.log('✅ New session selected:', meta.id);
    } catch (e) {
      console.error('❌ Failed to create session', e);
      showAppError(e, { agent: 'Manager', title: 'Failed to create session' });
    }
  }, [selectSession, rememberSessionToken, showAppError]);

  const deleteSession = useCallback(async (id) => {
    try {
      await axios.delete(`${API_BASE_URL}/api/sessions/${id}`);
      sessionTokensRef.current.delete(id);
      writeStoredSessionTokens(sessionTokensRef.current);
      setSessions(prev => prev.filter(s => s.id !== id));
      if (sessionId === id) {
        writeActiveSessionId('');
        const remaining = sessions.filter(s => s.id !== id);
        if (remaining.length > 0) {
          const latest = [...remaining].sort((a,b)=> new Date(b.updatedAt||b.createdAt) - new Date(a.updatedAt||a.createdAt))[0];
          await selectSession(latest.id, latest.name, { clearInputs: true });
        } else {
          await createNewSession();
        }
      }
    } catch (e) {
      console.error('Failed to delete session', e);
      showAppError(e, { agent: 'Manager', title: 'Failed to delete session' });
    }
  }, [sessionId, sessions, selectSession, createNewSession, showAppError]);

  // Session Manager: API helpers
  const fetchSessions = useCallback(async () => {
    console.log('🔄 fetchSessions called. Current sessionId:', sessionId);
    try {
      // Fetch all existing sessions from the backend.
      const res = await axios.get(`${API_BASE_URL}/api/sessions`);
      const list = res.data?.sessions || [];
      console.log('➡️ Backend returned sessions:', list.map(s => s.id));

      if (!sessionId) {
        const storedSessionId = readActiveSessionId();
        const sessionToRestore = storedSessionId
          ? list.find(s => s.id === storedSessionId)
          : null;
        setSessions(list);
        if (sessionToRestore && getSessionToken(sessionToRestore.id)) {
          console.log('✅ Restoring stored active session:', sessionToRestore.id);
          await selectSession(sessionToRestore.id, sessionToRestore.name);
        } else if (list.length > 0) {
          const latest = [...list].sort((a,b)=> new Date(b.updatedAt||b.createdAt) - new Date(a.updatedAt||a.createdAt))[0];
          if (latest && getSessionToken(latest.id)) {
            console.log('✅ Restoring latest known session:', latest.id);
            await selectSession(latest.id, latest.name);
          } else {
            console.log('ℹ️ No restorable session token found, creating new session.');
            await createNewSession();
          }
        } else {
          console.log('ℹ️ No sessions found, creating new session.');
          await createNewSession();
        }
      } else {
        console.log('ℹ️ Active sessionId found, attempting to restore or reset.');
        const sessionToRestore = list.find(s => s.id === sessionId);
        if (sessionToRestore) {
          console.log('✅ Session to restore found:', sessionToRestore.id);
          setSessions(list); // Update the client-side list of sessions with what the server returned
          await selectSession(sessionToRestore.id, sessionToRestore.name);
        } else {
          console.log('⚠️ Active sessionId not found in backend list or invalid, resetting client state.');
          // If the current sessionId is invalid or not found, reset client state.
          // The initial useEffect (if sessionId becomes null) or user action will create a new session.
          setSessions([]); // Clear client-side state
          setSessionId(null); // Explicitly clear sessionId to allow re-initialization if needed
        }
      }
    } catch (e) {
      console.error('❌ Failed to fetch sessions, resetting client state as fallback:', e);
      setSessions([]);
      setSessionId(null);
    }
  }, [sessionId, selectSession, createNewSession, getSessionToken]);

  

  const renameSession = useCallback(async (id, newName) => {
    try {
      const res = await axios.patch(`${API_BASE_URL}/api/sessions/${id}`, { name: newName });
      const updated = res.data;
      setSessions(prev => prev.map(s => s.id === id ? updated : s));
      if (sessionId === id) setActiveSessionName(updated.name);
    } catch (e) {
      console.error('Failed to rename session', e);
      showAppError(e, { agent: 'Manager', title: 'Failed to rename session' });
    }
  }, [sessionId, showAppError]);

  

  // Initial load of sessions
  useEffect(() => {
    if (!authReady || !authenticated) return;
    console.log('🚀 App component mounted. Initializing sessions.');
    const initializeSessions = async () => {
      // Check if already initialized to prevent double execution in React Strict Mode
      if (isInitializedRef.current) {
        console.log('⚠️ Session initialization already performed, skipping duplicate run.');
        return;
      }
      isInitializedRef.current = true; // Mark as initialized

      console.log('✨ initializeSessions function invoked.');
      try {
        await fetchSessions();
        console.log('✅ Session initialization completed.');
      } catch (e) {
        console.error('❌ Failed to create initial session on launch:', e?.message || e);
        
        // Check if it's a network error (server not running)
        if (e?.code === 'ERR_NETWORK' || e?.message?.includes('Network Error')) {
          console.warn('⚠️ Backend server is not running. Please start the server with: npm run server');
          showAppError(
            { message: 'Backend server is not running. Please start the server with npm run server, then refresh this page.' },
            { agent: 'Manager', title: 'Backend unavailable' }
          );
          setSessions([]);
          setConnectionStatus('error');
          return;
        }
        
        // For other errors, try again
        setSessions([]);
        try {
          await createNewSession();
        } catch (retryError) {
          console.error('❌ Retry also failed:', retryError?.message || retryError);
          setConnectionStatus('error');
        }
      }
    };

    initializeSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, authenticated, fetchSessions]);

  const handleDocQuestionSubmit = async (answers) => {
    if (!sessionId) {
      showAppError(
        { message: 'Session ID not found. Please try again.' },
        { agent: 'Documentation', title: 'Session missing' }
      );
      return;
    }
    console.log('📄 Documentation question answers submitted:', summarizeAnswers(answers));
    console.log('🔍 Maintaining generatingDocType during answer submission:', activeDocTypeRef.current);
    setIsProcessingDocQuestions(true);
    setIsProcessing(true);
    setShowDocQuestionModal(false);
    showDocQuestionModalRef.current = false;
    
    // Ensure generatingDocType stays set during answer processing
    if (activeDocTypeRef.current && !generatingDocType) {
      setGeneratingDocType(activeDocTypeRef.current);
    }
    if (activeDocTypeRef.current) {
      const type = activeDocTypeRef.current;
      setDocPendingByType(prev => ({
        ...prev,
        [type]: true
      }));
    }
    
    try {
      getSocket();
      const selectedProvider = selectBestAvailableProvider(provider);
      await axios.post(`${API_BASE_URL}/api/process`, {
        input: '',
        apiName: apiName || 'MuleSoftAPI',
        saveFiles: true,
        sessionId: sessionId,
        provider: selectedProvider,
        docQuestionAnswers: answers,
        documentType: activeDocTypeRef.current || undefined
      });

      // Close the modal after successful submission but keep generating state
      setShowDocQuestionModal(false);
      showDocQuestionModalRef.current = false;
      setDocQuestions(null);
    } catch (error) {
      console.error('❌ Error submitting documentation answers:', error);
      showAppError(error, { agent: 'Documentation', title: 'Failed to submit documentation answers' });
      setIsProcessingDocQuestions(false);
      setIsProcessing(false);
      setGeneratingDocType(null); // Clear generating state on error
      setDocPendingByType(prev => {
        if (!activeDocTypeRef.current) return prev;
        const next = { ...prev };
        next[activeDocTypeRef.current] = false;
        return next;
      });
    }
  };

  const handleGenerateRamlForApi = async (apiTask, options) => {
    console.log('🔍 handleGenerateRamlForApi called:', {
      apiTaskId: apiTask?.id,
      apiTaskName: apiTask?.name,
      includeFields: options?.includeFields,
      fieldDefinitionsCount: options?.fieldDefinitions?.length || 0
    });
    
    if (!sessionId) {
      showAppError(
        { message: 'Session ID not found. Please start a session by processing input first.' },
        { agent: 'RAML', title: 'Session missing' }
      );
      return;
    }

    const includeFields = options?.includeFields || false;
    const fieldDefinitions = includeFields ? (options.fieldDefinitions || []) : [];

    setIsProcessing(true);
    setIsRamlSelectionPending(true);
    setRamlSelectedApiId(apiTask?.id || null);
    
    // Add this API to loading state
    setLoadingApiIds(prev => new Set([...prev, apiTask?.id]));
    
    console.log('🔍 Emitting generate-api-raml for individual API:', {
      apiId: apiTask?.id,
      apiName: apiTask?.name,
      includeFields,
      fieldDefinitionsCount: fieldDefinitions.length
    });

    // Use new socket event for individual API RAML generation
    emitWhenConnected('generate-api-raml', {
      sessionId,
      apiId: apiTask?.id,
      apiName: apiTask?.name,
      includeFields,
      fieldDefinitions
    });
  };

  const handleJourneyPointsSubmit = async (points) => {
    const targetSessionId = journeyPointsSessionIdRef.current || sessionId;
    if (!targetSessionId) {
      showAppError(
        { message: 'Session ID not found. Please try again.' },
        { agent: 'Estimation', title: 'Session missing' }
      );
      return;
    }
    console.log('📋 Journey points submitted:', points);
    setIsProcessingJourneyPoints(true);
    setIsProcessing(true);
    setShowJourneyPointsModal(false);
    
    try {
      // Emit journey points to server
      emitWhenConnected('journey-points-submitted', {
        sessionId: targetSessionId,
        journeyPoints: points
      });
      
      // Clear the binding once submitted
      journeyPointsSessionIdRef.current = null;
    } catch (error) {
      console.error('❌ Error submitting journey points:', error);
      showAppError(error, { agent: 'Estimation', title: 'Failed to submit journey points' });
      setIsProcessingJourneyPoints(false);
      setIsProcessing(false);
    }
  };

  const handleJourneyPointsClose = () => {
    if (!isProcessingJourneyPoints) {
      setShowJourneyPointsModal(false);
      setIsProcessing(false);
      journeyPointsSessionIdRef.current = null;
    }
  };

  const handleDocQuestionClose = () => {
    if (!isProcessingDocQuestions) {
      setShowDocQuestionModal(false);
      showDocQuestionModalRef.current = false;
      setIsProcessing(false);
      setDocQuestions(null);
      setDocPendingByType(prev => {
        if (!activeDocType) return prev;
        const next = { ...prev };
        next[activeDocType] = false;
        return next;
      });
      setActiveDocType(null);
      setGeneratingDocType(null);
    }
  };

  const handleDownloadDocument = async (content, docType) => {
    try {
      console.log('📥 Starting document download...');

      // Create a blob URL approach for download
      const response = await axios.post(`${API_BASE_URL}/api/convert-to-word`, {
        content: content,
        sessionId: sessionId || 'download-session',
        docType: docType || activeDocTypeRef.current || null,
        architecture: outputs?.architecture || null,
        raml: outputs?.raml || null
      }, {
        responseType: 'blob' // Important for binary data
      });

      // Create blob and download
      const blob = new Blob([response.data], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      });

      // Create download link
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;

      // Extract filename from response headers or use default
      const contentDisposition = response.headers['content-disposition'];
      let filename = 'document.docx';
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="(.+)"/);
        if (filenameMatch) filename = filenameMatch[1];
      }

      link.download = filename;
      document.body.appendChild(link);
      link.click();

      // Cleanup
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      console.log(`✅ Document downloaded successfully: ${filename}`);
    } catch (error) {
      console.error('❌ Download failed:', error);
      throw new Error(error.response?.data?.error || error.message || 'Download failed');
    }
  };

  const handleDownloadRaml = async (apiTask, ramlContent) => {
    if (!sessionId) {
      showAppError(
        { message: 'Session ID not found. Please start a session by processing input first.' },
        { agent: 'RAML', title: 'Session missing' }
      );
      return;
    }

    if (!apiTask || !apiTask.id) {
      showAppError(
        { message: 'API information is missing for RAML download.' },
        { agent: 'RAML', title: 'RAML download unavailable' }
      );
      return;
    }

    try {
      const response = await axios.post(
        `${API_BASE_URL}/api/raml/download`,
        {
          sessionId,
          apiId: apiTask.id,
          apiName: apiTask.name || 'API'
        },
        {
          responseType: 'blob'
        }
      );

      const blob = new Blob([response.data], { type: 'application/zip' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;

      const contentDisposition = response.headers['content-disposition'];
      let filename = 'raml-project.zip';
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="(.+)"/);
        if (match && match[1]) {
          filename = match[1];
        }
      } else if (apiTask.name) {
        filename = `RAML-${apiTask.name.replace(/\s+/g, '_')}.zip`;
      }

      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('❌ RAML download failed:', error);
      throw new Error(error.response?.data?.error || error.message || 'RAML download failed');
    }
  };

  const handlePublishRaml = async (apiTask, ramlContent) => {
    if (!sessionId) {
      showAppError(
        { message: 'Session ID not found. Please start a session by processing input first.' },
        { agent: 'RAML', title: 'Session missing' }
      );
      return;
    }

    if (!apiTask || !apiTask.id) {
      showAppError(
        { message: 'API information is missing for RAML publish.' },
        { agent: 'RAML', title: 'RAML publish unavailable' }
      );
      return;
    }

    try {
      const response = await axios.post(`${API_BASE_URL}/api/raml/publish`, {
        sessionId,
        apiId: apiTask.id,
        apiName: apiTask.name || 'API'
      });

      const rawText = response.data?.text || response.data?.message || '';
      const backendSuccess = typeof response.data?.success === 'boolean'
        ? response.data.success
        : undefined;
      // Treat responses that explicitly say "Publishing Failed" as failures even if HTTP 200
      const isExplicitFailure = typeof rawText === 'string' && /Publishing Failed/i.test(rawText);
      const success =
        typeof backendSuccess === 'boolean'
          ? backendSuccess
          : !isExplicitFailure;
      const message = response.data?.message || rawText || (success
        ? 'RAML published successfully.'
        : 'Failed to publish RAML.');

      if (!success) {
        showAppError({ message }, { agent: 'RAML', title: 'RAML publish failed' });
      }
      return { success, message };
    } catch (error) {
      console.error('❌ RAML publish failed:', error);
      const message = error.response?.data?.error || error.message || 'Failed to publish RAML.';
      showAppError({ message }, { agent: 'RAML', title: 'Failed to publish RAML' });
      return { success: false, message: 'Failed to publish RAML: ' + message };
    }
  };

  const handleGenerateMuleCode = async (apiTask, ramlContent) => {
    if (!sessionId) {
      showAppError(
        { message: 'Session ID not found. Please start a session by processing input first.' },
        { agent: 'Mule', title: 'Session missing' }
      );
      return;
    }

    if (!apiTask || !apiTask.id) {
      showAppError(
        { message: 'API information is missing for Mule code generation.' },
        { agent: 'Mule', title: 'Mule code generation unavailable' }
      );
      return;
    }

    try {
      const response = await axios.post(
         `${API_BASE_URL}/api/mule-code/generate`,
        {
          sessionId,
          apiId: apiTask.id,
          apiName: apiTask.name || 'API'
        },
        {
          responseType: 'blob'
        }
      );

      const blob = new Blob([response.data], { type: 'application/zip' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;

      const contentDisposition = response.headers['content-disposition'];
      let filename = 'mule-project.zip';
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="(.+)"/);
        if (match && match[1]) {
          filename = match[1];
        }
      } else if (apiTask.name) {
        filename = `Mule-${apiTask.name.replace(/\s+/g, '_')}.zip`;
      }

      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      
      // Update state to mark this API as having Mule code generated
      setMuleCodeGenerated(prev => {
        const newSet = new Set(prev);
        newSet.add(apiTask.id);
        return newSet;
      });
    } catch (error) {
      console.error('❌ Mule code generation failed:', error);
      throw new Error(error.response?.data?.error || error.message || 'Mule code generation failed');
    }
  };

  // Keep a ref in sync with the latest selected RAML API ID so
  // progress callbacks can safely read it without stale closures.
  useEffect(() => {
    ramlSelectedApiIdRef.current = ramlSelectedApiId;
  }, [ramlSelectedApiId]);

  useEffect(() => {
    activeDocTypeRef.current = activeDocType;
  }, [activeDocType]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    // This is a placeholder - you'll need to implement actual availability checks
    // based on your application's requirements
    const detectAvailableModels = async () => {
      // Example: Check for API keys or other indicators of model availability
      const models = {
        gemini: !!process.env.GEMINI_API_KEY,
        groq: !!process.env.GROQ_API_KEY,
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        openai: !!process.env.OPENAI_API_KEY,
        openrouter: !!process.env.OPENROUTER_API_KEY
      };
      setAvailableModels(models);
      console.log('Available models:', models);
    };

    detectAvailableModels();
  }, []);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    const handleRamlAgentContinue = (data) => {
      console.log('🔄 RAML Agent continuing process', summarizeSocketPayload(data));
      console.log('🔍 RAML Agent Continue Debug:', {
        hasData: !!data,
        selectedApiId: data?.selectedApiId,
        hasSelectedApi: !!data?.selectedApi,
        selectedApiName: data?.selectedApi?.name
      });
      setIsRamlSelectionPending(false);
      if (data && data.selectedApiId) {
        setRamlSelectedApiId(data.selectedApiId);
        console.log('🔍 Set ramlSelectedApiId to:', data.selectedApiId);
      } else {
        console.warn('⚠️ No selectedApiId in raml-agent-continue data');
      }
    };

    socket.on('raml-agent-continue', handleRamlAgentContinue);

    return () => {
      socket.off('raml-agent-continue', handleRamlAgentContinue);
    };
  }, [socketRef]);


  const selectBestAvailableProvider = (preferredProvider = 'auto') => {
    if (preferredProvider !== 'auto') {
      return preferredProvider;
    }

    return 'auto';
  };

  // Update your API calls to use the selected provider
  const handleProcess = async () => {
    const selectedProvider = selectBestAvailableProvider();
    console.log('Selected provider:', selectedProvider);

    if (!input.trim()) {
      showAppError(
        { message: 'Please enter your question or requirements.' },
        { agent: 'Manager', title: 'Input required' }
      );
      return;
    }

    // Ensure we have an active session to avoid the backend creating a new one
    try {
      if (!sessionIdRef.current) {
        // Create and select a new session synchronously before proceeding
        await createNewSession();
      }
    } catch (e) {
      console.error('Failed to ensure session before processing:', e);
      showAppError(e, { agent: 'Manager', title: 'Failed to start session' });
      return;
    }

    setIsProcessing(true);

     // Clear all existing outputs to provide a fresh start for the new process
     setOutputs({
      architecture: null,
      diagram: null,
      estimation: null,
      raml: null,
      document: null,
      general: null
    });

    // Clear RAML-specific states for a complete reset of the RAML tab
    setRamlApiTasks([]);          // Clear the list of RAML API tasks
    setRamlByApi({});             // Clear the generated RAML content per API
    setRamlSelectedApiId(null);   // Clear any selected API ID for RAML
    setLoadingApiIds(new Set());  // Clear any APIs currently in loading state
    setMuleCodeGenerated(new Set()); // Clear Mule code generation tracking

    // Clear Documentation-specific states for a complete reset of the Document tab
    setDocumentsByType({});       // Clear the map of generated documents by type
    setDocPendingByType({});      // Clear the map of pending documentation types
    setActiveDocType(null);       // Clear the currently active document type
    setGeneratingDocType(null);   // Clear any document type currently being generated

    // Clear modal states and related data
    setShowQuestionModal(false);
    setShowApproachSelector(false);
    setShowDocQuestionModal(false);
    showDocQuestionModalRef.current = false;
    setShowJourneyPointsModal(false);
    setQuestions(null);
    setApproaches(null);
    setDocQuestions(null);
    questionSessionIdRef.current = null;
    journeyPointsSessionIdRef.current = null;

    // Clear classification to start fresh
    setClassification(null);

    // Reset agent statuses but keep data for conversation context
    setAgents(prev => ({
      Manager: { status: 'idle', message: '', data: prev.Manager?.data },
      Architecture: { status: 'idle', message: '', data: null },
      Diagram: { status: 'idle', message: '', data: null },
      Estimation: { status: 'idle', message: '', data: null },
      RAML: { status: 'idle', message: '', data: null },
      Documentation: { status: 'idle', message: '', data: null },
      General: { status: 'idle', message: '', data: prev.General?.data }
    }));

    // Don't clear general output - maintain conversation
    setLogs(prev => [...prev, { type: 'info', message: `User: ${input.trim()}`, timestamp: new Date() }]);

    try {
      console.log('📤 Sending input to backend:', {
        inputLength: input.length,
        apiName,
        saveFiles: true,
        sessionId: sessionIdRef.current || 'new session'
      });

      // Use existing socket; if not connected yet, the initial effect will handle reconnection
      const socket = getSocket();

      if (socket.connected) {
        sendRequest();
      } else {
        socket.once('connect', () => {
          console.log('✅ WebSocket connected');
          setConnectionStatus('connected');
          sendRequest();
        });
      }

      function sendRequest() {
        const activeSessionId = sessionIdRef.current || sessionId;
        const activeSessionToken = getSessionToken(activeSessionId);
        // Send input to AgentManager (routes automatically)
        // Include sessionId to maintain conversation context
        axios.post(`${API_BASE_URL}/api/process`, {
          input: input.trim(),
          apiName: apiName || 'MuleSoftAPI',
          saveFiles: true,
          sessionId: activeSessionId, // Reuse existing sessionId for conversation continuity
          sessionToken: activeSessionToken,
          provider: provider || undefined
        })
          .then(response => {
            const newSessionId = response.data.sessionId;
            rememberSessionToken(newSessionId, response.data.sessionToken);
            // Only update sessionId if it's a new one
            if (!activeSessionId || activeSessionId !== newSessionId) {
              setSessionId(newSessionId);
              console.log('📋 New Session ID received:', newSessionId);
            } else {
              console.log('📋 Reusing Session ID:', newSessionId);
            }
            console.log('📤 Input sent to AgentManager:', {
              inputLength: input.trim().length,
              inputPreview: previewText(input),
              apiName: apiName || 'MuleSoftAPI'
            });

            // Join the session (if not already joined)
            socket.emit('join-session', buildJoinSessionPayload(newSessionId));
          })
          .catch(error => {
            console.error('❌ Error processing input:', error);
            const responseData = error.response?.data || {};
            const rawErrorText = `${responseData.error || ''} ${responseData.message || ''} ${error.message || ''}`;
            if (responseData.blockedBy || isSensitiveGuardrailDetail(rawErrorText)) {
              setInput('');
              if (activeSessionId) {
                saveUserInput('', activeSessionId);
              }
            }
            showAppError(
              {
                message: responseData.error || error.message,
                errorDetails: getUserFacingErrorDetails(responseData),
                blockedBy: responseData.blockedBy
              },
              {
                agent: 'Manager',
                title: getUserFacingErrorTitle(responseData.blockedBy, 'Failed to process input')
              }
            );
            setConnectionStatus('error');
          });
      }

    } catch (error) {
      console.error('❌ Error:', error);
      showAppError(error, { agent: 'Manager', title: 'Failed to process input' });
    }
  };

  const handleApproachSelect = async (approach) => {
    // approach is the full object from ApproachSelector (may be edited or custom)
    const num = typeof approach === 'object' ? approach.number : approach;
    console.log('📋 Approach selected:', {
      number: num,
      name: previewText(approach?.name),
      descriptionLength: typeof approach?.description === 'string' ? approach.description.length : undefined
    });
    setSelectedApproachNumber(num);
    setSelectedApproachObj(typeof approach === 'object' ? approach : null);
    setShowApproachSelector(false);
    setShowToolsConfirmation(true);
  };

  const handleToolsConfirmation = async (tools) => {
    if (!sessionId) {
      showAppError(
        { message: 'Session ID not found. Please try again.' },
        { agent: 'Manager', title: 'Session missing' }
      );
      return;
    }

    console.log('🔧 Tools confirmed:', tools);
    console.log('📋 Selected approach:', selectedApproachNumber);
    setShowToolsConfirmation(false);
    setIsProcessing(true);

    // Ensure socket is connected and joined before sending request
    const socket = getSocket();
    socket.emit('join-session', buildJoinSessionPayload(sessionId));

    // Reset agent statuses for new workflow
    setAgents(prev => ({
      Manager: { status: 'idle', message: '', data: prev.Manager?.data },
      Architecture: { status: 'working', message: 'Generating architecture for selected approach...', data: null },
      Diagram: { status: 'idle', message: '', data: null },
      Estimation: { status: 'idle', message: '', data: null },
      RAML: { status: 'idle', message: '', data: null },
      Documentation: { status: 'idle', message: '', data: null },
      General: { status: 'idle', message: '', data: prev.General?.data }
    }));

    // Clear previous architecture outputs
    setOutputs(prev => ({ ...prev, architecture: null, diagram: null, estimation: null, raml: null, document: null }));

    try {
      // Keep the websocket alive for progress events while the HTTP request runs.
      getSocket();

      axios.post(`${API_BASE_URL}/api/process`, {
        input: '', // Empty input since we're continuing with selected approach
        apiName: apiName || 'MuleSoftAPI',
        saveFiles: true,
        sessionId: sessionId,
        provider: provider || undefined,
        selectedApproach: selectedApproachNumber,
        ...(selectedApproachObj?.isCustom || selectedApproachObj?.isEdited
          ? { approachName: selectedApproachObj.name, approachDescription: selectedApproachObj.description }
          : {}),
        tools: tools
      })
        .then(response => {
          console.log('✅ Approach selection with tools sent:', selectedApproachNumber, tools);
        })
        .catch(error => {
          console.error('❌ Error selecting approach:', error);
          showAppError(error, { agent: 'Architecture', title: 'Failed to select approach' });
          setIsProcessing(false);
        });
    } catch (error) {
      console.error('❌ Error:', error);
      showAppError(error, { agent: 'Architecture', title: 'Failed to select approach' });
      setIsProcessing(false);
    }
  };

  const handleToolsConfirmationClose = () => {
    if (!isProcessing) {
      setShowToolsConfirmation(false);
      setSelectedApproachNumber(null);
      setSelectedApproachObj(null);
    }
  };

  const handleApproachClose = () => {
    setShowApproachSelector(false);
    setIsProcessing(false);
    setApproaches(null);
  };

  const handleQuestionSubmit = async (questionAnswers) => {
    const targetSessionId = questionSessionIdRef.current || sessionId;
    if (!targetSessionId) {
      showAppError(
        { message: 'Session ID not found. Please try again.' },
        { agent: 'Architecture', title: 'Session missing' }
      );
      return;
    }

    console.log('❓ Question answers submitted:', summarizeAnswers(questionAnswers));
    setIsProcessingQuestions(true);
    setIsProcessing(true);
    // Keep the question modal open so it can show the processing state
    // The modal will be closed when approaches are ready or validation fails

    try {
      getSocket();

      // Select the best available provider (for logging only)
      const selectedProvider = selectBestAvailableProvider(provider);
      console.log('Using provider for question submission:', selectedProvider);


      // Send question answers to server
      axios.post(`${API_BASE_URL}/api/process`, {
        input: '', // Empty input since we're continuing with answers
        apiName: apiName || 'MuleSoftAPI',
        saveFiles: true,
        sessionId: targetSessionId,
        provider: provider || undefined,
        questionAnswers: questionAnswers
      })
        .then(response => {
          console.log('✅ Question answers sent');
          // Clear the binding once submitted
          questionSessionIdRef.current = null;
        })
        .catch(error => {
          console.error('❌ Error submitting answers:', error);
          showAppError(error, { agent: 'Architecture', title: 'Failed to submit answers' });
          setIsProcessingQuestions(false);
          setIsProcessing(false);
        });
    } catch (error) {
      console.error('❌ Error:', error);
      showAppError(error, { agent: 'Architecture', title: 'Failed to submit answers' });
      setIsProcessingQuestions(false);
      setIsProcessing(false);
    }
  };

  const handleQuestionClose = () => {
    if (!isProcessingQuestions) {
      setShowQuestionModal(false);
      setIsProcessing(false);
      setQuestions(null);
      // Clear any bound session id on close
      questionSessionIdRef.current = null;
    }
  };

  const handleRegenerateDiagram = async (diagramType) => {
    // diagramType: 'component' | 'sequence' | 'both'
    const sid = sessionIdRef.current || sessionId;
    if (!sid) return;
    try {
      const response = await axios.post(
        `${API_BASE_URL}/api/sessions/${sid}/regenerate-diagram`,
        { diagramType }
      );
      if (response.data?.diagramData) {
        setOutputs(prev => ({
          ...prev,
          diagramData: response.data.diagramData,
          diagram: `=== COMPONENT DIAGRAM ===\n${response.data.diagramData.component || 'N/A'}\n\n=== SEQUENCE DIAGRAM ===\n${response.data.diagramData.sequence || 'N/A'}`
        }));
      }
    } catch (err) {
      console.error('❌ Failed to regenerate diagram:', err);
      throw err; // let OutputViewer catch and show error
    }
  };

  const handleStartDocumentation = async (docType) => {
    console.log(`📄 Starting documentation generation for type: ${docType}`);
    console.log(`🔍 Setting generatingDocType to: ${docType}`);
    if (!sessionId) {
      showAppError(
        { message: 'Session ID not found. Please start a session by processing input first.' },
        { agent: 'Documentation', title: 'Session missing' }
      );
      return;
    }
    const hasRamlTopics =
      !!outputs.raml ||
      (ramlByApi && typeof ramlByApi === 'object' && Object.keys(ramlByApi).length > 0) ||
      (Array.isArray(ramlApiTasks) && ramlApiTasks.length > 0);
    const missing = [
      !outputs.architecture ? 'architecture' : null,
      !outputs.estimation ? 'estimation' : null,
      !hasRamlTopics ? 'RAML topics' : null
    ].filter(Boolean);
    if (missing.length > 0) {
      setAgents(prev => ({
        ...prev,
        Documentation: {
          status: 'blocked',
          message: `Cannot generate ${docType} yet. Required input missing: ${missing.join(', ')}.`,
          data: null
        }
      }));
      return;
    }
    try {
      setDocPendingByType(prev => ({
        ...prev,
        [docType]: true
      }));
      setActiveDocType(docType);
      setGeneratingDocType(docType);
      setShowDocQuestionModal(false);
      showDocQuestionModalRef.current = false;
      setDocQuestions(null);
      setIsProcessing(true);
      setAgents(prev => ({
        ...prev,
        Documentation: { status: 'working', message: `Generating ${docType} documentation...`, data: null }
      }));

      getSocket();
      const selectedProvider = selectBestAvailableProvider(provider);

      // Persist planned documentation task to backend so it shows next time
      try {
        await axios.post(`${API_BASE_URL}/api/sessions/${sessionId}/docs/tasks`, { types: [docType] });
      } catch {}

      console.log(`📄 Sending documentation request:`, {
        docType,
        sessionId,
        provider: selectedProvider
      });

      // Send specific documentation request with document type
      const response = await axios.post(`${API_BASE_URL}/api/process`, {
        input: `Generate ${docType}`,
        apiName: apiName || 'MuleSoftAPI',
        saveFiles: true,
        sessionId: sessionId,
        provider: selectedProvider,
        documentType: docType,  // Add explicit document type
        ramlTasks: Array.isArray(ramlApiTasks)
          ? ramlApiTasks.map(task => ({
              id: task.id,
              name: task.name,
              description: task.description || ''
            }))
          : []
      });

      console.log(`📄 Documentation request sent successfully for ${docType}`);
      const newSessionId = response.data.sessionId;
      rememberSessionToken(newSessionId, response.data.sessionToken);
      getSocket().emit('join-session', buildJoinSessionPayload(newSessionId));
    } catch (error) {
      console.error('❌ Error starting documentation:', error);
      showAppError(error, { agent: 'Documentation', title: 'Failed to start documentation' });
      setIsProcessing(false);
      setAgents(prev => ({
        ...prev,
        Documentation: { status: 'error', message: `Failed to generate ${docType}: ${error.message}`, data: null }
      }));
    }
  };


  const handleProgress = (event) => {
    if (event.message) {
      setLogs(prev => [...prev, { type: 'info', message: event.message, timestamp: new Date() }]);
    }

    if (event.type === 'error' || event.status === 'error') {
      showAppError(
        {
          message: event.message || event.error || 'An agent failed while processing your request.',
          agent: event.agent
        },
        {
          agent: event.agent || 'Manager',
          title: `${event.agent || 'Generation'} failed`
        }
      );
      return;
    }

    if (event.agent === 'Architecture' && event.type === 'agent-stream-start') {
      architectureStreamRef.current = { streamId: event.streamId, lastSequence: -1 };
      setOutputs(prev => ({ ...prev, architecture: '' }));
      setAgents(prev => ({
        ...prev,
        Architecture: {
          status: 'working',
          message: event.message || 'Architecture response is streaming...',
          data: null
        }
      }));
      return;
    }

    if (event.agent === 'Architecture' && event.type === 'agent-stream-reset') {
      architectureStreamRef.current = { streamId: event.streamId, lastSequence: -1 };
      setOutputs(prev => ({ ...prev, architecture: '' }));
      setAgents(prev => ({
        ...prev,
        Architecture: {
          status: 'working',
          message: event.message || 'Restarting architecture generation...',
          data: null
        }
      }));
      return;
    }

    if (event.agent === 'Architecture' && event.type === 'agent-stream-chunk') {
      const currentStream = architectureStreamRef.current;
      if (currentStream.streamId !== event.streamId) {
        architectureStreamRef.current = { streamId: event.streamId, lastSequence: -1 };
        setOutputs(prev => ({ ...prev, architecture: '' }));
      }
      if (Number.isInteger(event.sequence) && event.sequence <= architectureStreamRef.current.lastSequence) {
        return;
      }
      architectureStreamRef.current.lastSequence = Number.isInteger(event.sequence)
        ? event.sequence
        : architectureStreamRef.current.lastSequence + 1;
      setOutputs(prev => ({
        ...prev,
        architecture: `${prev.architecture || ''}${event.chunk || ''}`
      }));
      return;
    }

    if (event.agent === 'Architecture' && event.type === 'agent-stream-complete') {
      setAgents(prev => ({
        ...prev,
        Architecture: {
          ...prev.Architecture,
          status: 'working',
          message: event.message || 'Finalizing architecture response...'
        }
      }));
      return;
    }

    if (event.agent === 'Estimation' && event.type === 'agent-stream-start') {
      estimationStreamRef.current = { streamId: event.streamId, lastSequence: -1 };
      setOutputs(prev => ({ ...prev, estimation: '' }));
      setAgents(prev => ({
        ...prev,
        Estimation: {
          status: 'working',
          message: event.message || 'Estimation response is streaming...',
          data: null
        }
      }));
      return;
    }

    if (event.agent === 'Estimation' && event.type === 'agent-stream-reset') {
      estimationStreamRef.current = { streamId: event.streamId, lastSequence: -1 };
      setOutputs(prev => ({ ...prev, estimation: '' }));
      setAgents(prev => ({
        ...prev,
        Estimation: {
          status: 'working',
          message: event.message || 'Restarting estimation generation...',
          data: null
        }
      }));
      return;
    }

    if (event.agent === 'Estimation' && event.type === 'agent-stream-chunk') {
      const currentStream = estimationStreamRef.current;
      if (currentStream.streamId !== event.streamId) {
        estimationStreamRef.current = { streamId: event.streamId, lastSequence: -1 };
        setOutputs(prev => ({ ...prev, estimation: '' }));
      }
      if (Number.isInteger(event.sequence) && event.sequence <= estimationStreamRef.current.lastSequence) {
        return;
      }
      estimationStreamRef.current.lastSequence = Number.isInteger(event.sequence)
        ? event.sequence
        : estimationStreamRef.current.lastSequence + 1;
      setOutputs(prev => ({
        ...prev,
        estimation: `${prev.estimation || ''}${event.chunk || ''}`
      }));
      return;
    }

    if (event.agent === 'Estimation' && event.type === 'agent-stream-complete') {
      setAgents(prev => ({
        ...prev,
        Estimation: {
          ...prev.Estimation,
          status: 'working',
          message: event.message || 'Finalizing estimation response...'
        }
      }));
      return;
    }

    // ── Round 2: follow-up questions wrapped inside a progress event ────────
    // Mirrors the dedicated socket.on('followup-questions') handler — keep in sync.
    if (event.type === 'followup-questions' && event.data?.questions) {
      setQuestions(event.data.questions);
      setIsFollowUpRound(true);
      setShowQuestionModal(true);
      setIsProcessingQuestions(false);
      setIsProcessing(false);
      // Bind to the current session so answers are submitted to the right session
      questionSessionIdRef.current = sessionId;
      setAgents(prev => ({
        ...prev,
        Architecture: {
          status: 'needs-input',
          message: 'One quick follow-up before generating approaches',
          data: event.data.questions
        }
      }));
    }

    // Round 1 answers were sufficient — no follow-up needed
    if (event.type === 'answers-sufficient') {
      setAgents(prev => ({
        ...prev,
        Architecture: { status: 'working', message: 'Generating architecture approaches...', data: null }
      }));
    }
    
    // Handle classification
    if (event.type === 'classified') {
      setClassification(event.classification);
      setAgents(prev => ({
        ...prev,
        Manager: {
          status: 'completed',
          message: event.message,
          data: event.classification
        }
      }));

      // If switching to architecture workflow, clear general output
      if (event.classification === 'ARCHITECTURE_REQUIREMENT') {
        setOutputs(prev => ({ ...prev, general: null }));
      }
    }

      // Handle agent steps
    if (event.type === 'step') {
      console.log('🔄 Step event received:', { agent: event.agent, status: event.status, type: event.type });
      
      // Pipeline paused after architecture for the manual use-case / diagram flow.
      // Release the global processing lock so the user can drive the Diagram tab.
      if (event.agent === 'JourneyPoints' && event.status === 'waiting') {
        setIsProcessing(false);
      }

      setAgents(prev => ({
        ...prev,
        [event.agent]: {
          status: event.status,
          message: event.message,
          data: event.data || prev[event.agent]?.data
        }
      }));

      if (event.status === 'completed' && event.data) {
        const agentKey = event.agent.toLowerCase();
        if (agentKey === 'architecture') {
          setOutputs(prev => ({ ...prev, architecture: event.data }));
        } else if (agentKey === 'diagram') {
          setOutputs(prev => ({
            ...prev,
            diagram: event.data,
            diagramData: event.diagramData || null
          }));
          // NOTE: estimation is no longer auto-triggered here. The user drives
          // use-case extraction, diagram generation, and estimation manually from
          // the Diagram tab (see handleGenerateEstimation).
        } else if (agentKey === 'estimation') {
          setOutputs(prev => ({ ...prev, estimation: event.data }));
        } else if (agentKey === 'raml') {
          const selectedApiIdForRaml = ramlSelectedApiIdRef.current;
          console.log('🔍 RAML Generation Complete:', {
            ramlSelectedApiId: selectedApiIdForRaml,
            hasEventData: !!event.data,
            eventDataLength: event.data?.length || 0,
            eventMessage: event.message
          });
          setOutputs(prev => ({ ...prev, raml: event.data }));
          // Store RAML per API ID using the latest selected API ID from the ref
          if (selectedApiIdForRaml) {
            setRamlByApi(prev => {
              const updated = { ...prev, [selectedApiIdForRaml]: event.data };
              console.log('🔍 Updated ramlByApi:', Object.keys(updated));
              return updated;
            });
          } else {
            console.warn('⚠️ RAML generated but no ramlSelectedApiId set in ref!');
          }
          setIsRamlSelectionPending(false);
        } else if (agentKey === 'documentation') {
          // Only set document output when not in Q&A modal phase and when message indicates final doc generated
          const isFinalDoc = typeof event.message === 'string' && /Documentation generated/i.test(event.message);
          if (!showDocQuestionModalRef.current && isFinalDoc) {
            setOutputs(prev => ({ ...prev, document: event.data }));
          }
        } else if (agentKey === 'General' || agentKey === 'general') {
          console.log('📝 Received general response for agent:', agentKey, 'sessionId:', sessionId, 'data length:', event.data?.length);
          setOutputs(prev => ({ ...prev, general: event.data }));
          // Also persist to backend for tab switching
          if (sessionId && event.data) {
            console.log('💾 Persisting general output to backend for session:', sessionId);
            axios.patch(`${API_BASE_URL}/api/sessions/${sessionId}/outputs`, { general: event.data })
              .then(() => console.log('✅ General output persisted successfully'))
              .catch(e => console.warn('❌ Failed to persist general output:', e));
          } else {
            console.warn('⚠️ Cannot persist general output - sessionId:', sessionId, 'event.data exists:', !!event.data);
          }
        }
      }
    }

    // Handle start event
    if (event.type === 'start') {
      if (event.agent === 'Manager') {
        setAgents(prev => ({
          ...prev,
          Manager: { status: 'working', message: event.message, data: null }
        }));
      }
    }

    // Handle completion
    if (event.type === 'complete') {
      setIsProcessing(false);
      setIsProcessingJourneyPoints(false); // reset journey points lock on completion
      if (event.data) {
        setOutputs(prev => ({ ...prev, ...event.data }));
      }
    }
  };


  // Step 1: Extract individual use cases from the architecture
  const handleExtractUseCases = async () => {
    const sid = sessionIdRef.current || sessionId;
    if (!sid) return;
    setAgents(prev => ({
      ...prev,
       Diagram: { status: 'working', message: 'Extracting use cases from architecture...', data: null }
    }));
    try {
      const response = await axios.post(`${API_BASE_URL}/api/sessions/${sid}/extract-usecases`);
      const useCases = response.data?.useCases || [];
      setOutputs(prev => ({ ...prev, useCases }));
      setAgents(prev => ({
        ...prev,
        Diagram: { status: 'completed', message: `Extracted ${useCases.length} use case(s)`, data: null }
      }));
    } catch (err) {
      console.error('❌ Failed to extract use cases:', err);
      setAgents(prev => ({
        ...prev,
        Diagram: { status: 'error', message: 'Failed to extract use cases', data: null }
      }));
      showAppError(err, { agent: 'Diagram', title: 'Failed to extract use cases' });
    }
  };

  // Persist edited / added / deleted use cases
  const handleSaveUseCases = async (useCases) => {
    const sid = sessionIdRef.current || sessionId;
    if (!sid) return;
    try {
      const response = await axios.put(`${API_BASE_URL}/api/sessions/${sid}/usecases`, { useCases });
      const saved = response.data?.useCases || useCases;
      setOutputs(prev => ({ ...prev, useCases: saved }));
      return saved;
    } catch (err) {
      console.error('❌ Failed to save use cases:', err);
      showAppError(err, { agent: 'Diagram', title: 'Failed to save use cases' });
      throw err;
    }
  };

  // Generate / regenerate the sequence diagram for a single use case
  const handleGenerateUseCaseSequence = async (ucId) => {
    const sid = sessionIdRef.current || sessionId;
    if (!sid) return;
    try {
      const response = await axios.post(`${API_BASE_URL}/api/sessions/${sid}/usecases/${ucId}/sequence-diagram`);
      const updated = response.data?.useCase;
      if (updated) {
        setOutputs(prev => ({
          ...prev,
          useCases: (prev.useCases || []).map(u => (u.id === ucId ? updated : u))
        }));
      }
    } catch (err) {
      console.error('❌ Failed to generate use-case sequence diagram:', err);
      throw err;
    }
  };

  // Step 2: Generate / regenerate the master high-level architecture diagram
  const handleGenerateMasterArchitecture = async () => {
    const sid = sessionIdRef.current || sessionId;
    if (!sid) return;
    try {
      const response = await axios.post(`${API_BASE_URL}/api/sessions/${sid}/master-architecture-diagram`);
      if (response.data?.diagramData) {
        setOutputs(prev => ({
          ...prev,
          diagramData: response.data.diagramData,
          diagram: `=== COMPONENT DIAGRAM ===\n${response.data.diagramData.component || 'N/A'}\n\n=== SEQUENCE DIAGRAM ===\n${response.data.diagramData.sequence || 'N/A'}`
        }));
        setAgents(prev => ({
          ...prev,
          Diagram: { status: 'completed', message: 'Master architecture diagram generated!', data: null }
        }));
      }
    } catch (err) {
      console.error('❌ Failed to generate master architecture diagram:', err);
      throw err;
    }
  };

  const handleGenerateNetworkTopology = async () => {
    const sid = sessionIdRef.current || sessionId;
    if (!sid) return;
    try {
      const response = await axios.post(`${API_BASE_URL}/api/sessions/${sid}/network-topology-diagram`);
      if (response.data?.diagramData) {
        setOutputs(prev => ({
          ...prev,
          diagramData: response.data.diagramData
        }));
        setAgents(prev => ({
          ...prev,
          Diagram: { status: 'completed', message: 'Network topology diagram generated!', data: null }
        }));
      }
    } catch (err) {
      console.error('❌ Failed to generate network topology diagram:', err);
      throw err;
    }
  };

  const handleGenerateEstimation = () => {
    const sid = sessionIdRef.current || sessionId;
    if (!sid) return;
    setShowJourneyPointsModal(true);
    journeyPointsSessionIdRef.current = sid;
  };


  const handleInputKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!isProcessing && input.trim()) {
        handleProcess();
      }
    }
  };

  if (!authReady) {
    return (
      <div className="auth-screen">
        <div className="auth-panel" aria-live="polite">Checking authentication...</div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="auth-screen">
        <form className="auth-panel" onSubmit={handleLogin}>
          <div className="auth-brand">MuleSoft <span>Multi-Agent</span></div>
          <h1>Sign in</h1>
          <p>Use the application credentials configured by your deployment owner.</p>
          <label htmlFor="login-username">Username</label>
          <input
            id="login-username"
            autoComplete="username"
            value={loginUsername}
            onChange={event => setLoginUsername(event.target.value)}
            required
            autoFocus
          />
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={loginPassword}
            onChange={event => setLoginPassword(event.target.value)}
            required
          />
          {loginError && <div className="auth-error" role="alert">{loginError}</div>}
          <button type="submit" disabled={isSigningIn}>
            {isSigningIn ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    );
  }


  return (
    <div className="App">
      {appError && (
        <div className="app-error-overlay" role="alertdialog" aria-modal="true" aria-labelledby="app-error-title">
          <div className="app-error-dialog">
            <div className="app-error-header">
              <div>
                <h3 id="app-error-title">{appError.title}</h3>
                {appError.provider && <span className="app-error-provider">Provider: {appError.provider}</span>}
              </div>
              <button
                type="button"
                className="app-error-close"
                onClick={() => setAppError(null)}
                aria-label="Close error"
              >
                ×
              </button>
            </div>
            <p className="app-error-message">{appError.message}</p>
            {appError.detail && <pre className="app-error-detail">{appError.detail}</pre>}
            <div className="app-error-actions">
              <button type="button" onClick={() => setAppError(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {showQuestionModal && questions && (
        <QuestionModal
          questions={questions}
          onSubmit={handleQuestionSubmit}
          onClose={handleQuestionClose}
          onError={(error, title) => showAppError(error, { agent: 'Architecture', title })}
          isProcessing={isProcessingQuestions}
          isFollowUpRound={isFollowUpRound}
          contextType="architecture"
        />
      )}
      {showDocQuestionModal && docQuestions && (
        <QuestionModal
          questions={docQuestions}
          onSubmit={handleDocQuestionSubmit}
          onClose={handleDocQuestionClose}
          onError={(error, title) => showAppError(error, { agent: 'Documentation', title })}
          isProcessing={isProcessingDocQuestions}
          contextType="documentation"
        />
      )}
      {showJourneyPointsModal && (
        <JourneyPointsModal
          onSubmit={handleJourneyPointsSubmit}
          onClose={handleJourneyPointsClose}
          onError={(error, title) => showAppError(error, { agent: 'Estimation', title })}
          isProcessing={isProcessingJourneyPoints}
          architecture={outputs.architecture || null}
          useCases={outputs.useCases || null}
        />
      )}
      {/* showRamlAgentModal && ( // Commented out to disable popup
        <RamlAgentModal
          onClose={() => setShowRamlAgentModal(false)}
          socket={socketRef.current}
          sessionId={sessionId}
          isOpen={showRamlAgentModal}
          onApiSelected={setRamlSelectedApiId}
        />
      ) */}
      {showApproachSelector && approaches && (
        <ApproachSelector
          approaches={approaches}
          onSelect={handleApproachSelect}
          onClose={handleApproachClose}
        />
      )}
      {showToolsConfirmation && approaches && selectedApproachNumber && (
        <ToolsConfirmationModal
          selectedApproach={selectedApproachNumber}
          approaches={approaches}
          onSubmit={handleToolsConfirmation}
          onClose={handleToolsConfirmationClose}
          isProcessing={isProcessing}
        />
      )}
      <div className="container">
        <header className="header">
          <div className="header-auth">
            <span title={authUser?.id}>{authUser?.id}</span>
            <button type="button" onClick={handleLogout}>Sign out</button>
          </div>
          <div className="header-connection-status">
            <div className="connection-status">
              {connectionStatus === 'connected' && '🟢 Connected'}
              {connectionStatus === 'reconnecting' && '🟡 Reconnecting'}
              {connectionStatus === 'error' && '🔴 Connection Error'}
              {connectionStatus === 'disconnected' && '⚪ Disconnected'}
            </div>
          </div>
          <h1>MuleSoft <span className="brand-orange">Multi-Agent</span> System</h1>
          <p>AI-Powered Architecture, Diagram, Estimation &amp; RAML Generation</p>
        </header>

        <div className="view-navigation">
          <button
            onClick={() => setActiveView('main')}
            className={`view-tab ${activeView === 'main' ? 'active' : ''}`}
          >
            Home
          </button>
          <button
            onClick={() => setActiveView('dashboard')}
            className={`view-tab ${activeView === 'dashboard' ? 'active' : ''}`}
            >
            Token Dashboard
          </button>
        </div>

        {/* Global Tabs Row (spans both columns) - COMMENTED OUT TO DISABLE TABS */}
        {/* <div style={{ display:'flex', alignItems:'center', marginBottom: '10px', gap: '8px', flexWrap:'nowrap' }}>
          <div style={{ fontWeight: 600, whiteSpace:'nowrap' }}>Tabs:</div>
          <div style={{ display:'flex', gap:'6px', alignItems:'center', overflow:'hidden', whiteSpace:'nowrap' }}>
            {(() => {
              // Show up to MAX_INLINE_TABS sessions inline; put the rest in the overflow dropdown
              const MAX_INLINE_TABS = 7;
              const inlineTabs = sessions.slice(0, MAX_INLINE_TABS);
              const overflowTabs = sessions.slice(MAX_INLINE_TABS);
              return (
                <>
                  {inlineTabs.map((s, idx) => {
                    const rawName = s.name?.trim() || '';
                    const isDefaultPattern = /^Tab\s+\d+$/i.test(rawName);
                    const displayName = isDefaultPattern ? `Tab ${idx + 1}` : (rawName || `Tab ${idx + 1}`);
                    return (
                    <div key={s.id} style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'6px 10px', borderRadius:16, border: s.id===sessionId? '2px solid #4caf50':'1px solid #ccc', background: s.id===sessionId? 'rgba(76,175,80,0.1)':'#fff', cursor:'pointer' }} onClick={()=> selectSession(s.id, s.name)}>
                      <span title={s.id}>{displayName}</span>
                      <button title="Rename" style={{ border:'none', background:'transparent', cursor:'pointer' }} onClick={(e)=>{ e.stopPropagation(); const nn = window.prompt('Rename tab', s.name?.trim() ? s.name : `Tab ${idx+1}`); if (nn && nn.trim()) renameSession(s.id, nn.trim()); }}>
                        ✎
                      </button>
                      <button title="Close" style={{ border:'none', background:'transparent', cursor:'pointer', color:'#e53935' }} onClick={(e)=>{ e.stopPropagation(); if (window.confirm('Close this tab?')) deleteSession(s.id); }}>
                        ✕
                      </button>
                    </div>
                    );
                  })}
                  <button onClick={()=>{ const name = window.prompt('New tab name', `Tab ${sessions.length+1}`); createNewSession(name||undefined); }} style={{ padding:'6px 10px', borderRadius:16, border:'1px dashed #aaa', background:'#fafafa', cursor:'pointer' }}>+
                  </button>
                  {overflowTabs.length > 0 && (
                    <select
                      aria-label="More tabs"
                      style={{ padding:'6px 8px', borderRadius:12, border:'1px solid #ccc', background:'#fff', cursor:'pointer' }}
                      onChange={(e)=>{
                        const id = e.target.value;
                        const found = sessions.find(x=>x.id===id);
                        if (found) selectSession(found.id, found.name);
                        e.target.selectedIndex = 0;
                      }}
                    >
                      <option value="">More ▾</option>
                      {overflowTabs.map((s, idx) => {
                        const rawName = s.name?.trim() || '';
                        const isDefaultPattern = /^Tab\s+\d+$/i.test(rawName);
                        const displayName = isDefaultPattern
                          ? `Tab ${MAX_INLINE_TABS + idx + 1}`
                          : (rawName || `Tab ${MAX_INLINE_TABS + idx + 1}`);
                        return (
                          <option key={s.id} value={s.id}>{displayName}</option>
                        );
                      })}
                    </select>
                  )}
                </>
              );
            })()}
          </div>
        </div> */}

        {activeView === 'main' ? (
        <div className="main-content">
          <div className="left-panel">
            <div className="input-section">
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <h2>💬 Ask or Request</h2>
              </div>
              <p style={{ fontSize: '0.9rem', color: '#666', marginBottom: '10px' }}>
                Ask general questions or provide requirements for architecture generation
              </p>
              <textarea
                value={input}
                onChange={(e) => {
                  const newValue = e.target.value;
                  setInput(newValue);
                  if (sessionId) {
                    saveUserInput(newValue, sessionId);
                  }
                }}
                onKeyDown={handleInputKeyDown}
                placeholder="Examples:&#10;• 'What is MuleSoft?' (General Question)&#10;• 'Create integration between Salesforce and SAP' (Architecture Requirement)"
                rows="8"
                disabled={isProcessing}
              />

              {classification && (
                <div style={{
                  marginTop: '10px',
                  padding: '10px',
                  borderRadius: '8px',
                  backgroundColor: classification === 'GENERAL_QUESTION' ? '#e3f2fd' : '#fff3e0',
                  border: `2px solid ${classification === 'GENERAL_QUESTION' ? '#2196f3' : '#ff9800'}`,
                  fontSize: '0.9rem'
                }}>
                  <strong>📊 Classification:</strong> {classification === 'GENERAL_QUESTION' ? '💬 General Question → Q&A Agent' : '🏗️ Architecture Requirement → Full Workflow'}
                </div>
              )}


              <div className="input-group">
                <label>LLM Provider:</label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  disabled={isProcessing}
                  style={{
                    padding: '8px',
                    borderRadius: '4px',
                    border: '1px solid #ccc',
                    width: '100%',
                    backgroundColor: isProcessing ? '#f5f5f5' : 'white',
                    cursor: isProcessing ? 'not-allowed' : 'pointer'
                  }}
                >
                  <option value="auto">Auto (Recommended)</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="groq">Groq</option>
                  <option value="openai">OpenAI</option>
                  <option value="gemini">Gemini</option>
                  <option value="openrouter">OpenRouter</option>

                </select>
              </div>

              <button
                onClick={handleProcess}
                disabled={isProcessing || !input.trim()}
                className="generate-btn"
              >
                {isProcessing ? '🔄 Processing...' : '🚀 Process Input'}
              </button>
            </div>

            <DependencyChain agents={agents} />
          </div>

          <div className="right-panel">
            <OutputViewer
              outputs={outputs}
              agents={agents}
              sessionId={sessionId}
              onRegenerateDiagram={handleRegenerateDiagram}
              useCases={outputs.useCases || null}
              onExtractUseCases={handleExtractUseCases}
              onSaveUseCases={handleSaveUseCases}
              onGenerateUseCaseSequence={handleGenerateUseCaseSequence}
              onGenerateMasterArchitecture={handleGenerateMasterArchitecture}
              onGenerateNetworkTopology={handleGenerateNetworkTopology}
              onGenerateEstimation={!isProcessing && !outputs.estimation && agents.Estimation?.status !== 'working' ? handleGenerateEstimation : null}
              onDownloadDocument={handleDownloadDocument}
              onStartDocumentation={handleStartDocumentation}
              onDownloadRaml={handleDownloadRaml}
              onPublishRaml={handlePublishRaml}
              onGenerateMuleCode={handleGenerateMuleCode}
              documentsByType={documentsByType}
              generatingDocType={generatingDocType}
              docPendingByType={docPendingByType}
              ramlApiTasks={ramlApiTasks}
              ramlSelectedApiId={ramlSelectedApiId}
              isRamlSelectionPending={isRamlSelectionPending}
              onGenerateRamlForApi={handleGenerateRamlForApi}
              ramlByApi={ramlByApi}
              loadingApiIds={loadingApiIds}
              muleCodeGenerated={muleCodeGenerated}
              onError={(error, title) => showAppError(error, { agent: 'Manager', title })}
            />
          </div>
        </div>
        ) : (
        <TokenUtilizationDashboard />
        )}
      </div>
    </div>
  );
}

export default App;
