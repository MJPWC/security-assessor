import BaseAgent from './BaseAgent.js';
import { A2AMessage } from '../a2a/Message.js';
import { detectDocumentType as detectDocType, generateDocumentClarifyingQuestions, generateDocument, extractSystemDetails, buildContextSummary } from '../documentation/documentation.js';
import { convertMarkdownToWord } from '../documentation/doc_service.js';

class DocumentationAgent extends BaseAgent {
  constructor(config = null) {
    super(config, 'documentation-agent');
    this.name = 'Documentation Agent';
    this.description = 'Generates BRD, WBS, Test Plan, HLD and related documents';
    this.register({
      name: this.name,
      description: this.description,
      capabilities: ['generate-document', 'clarify-document', 'convert-to-word']
    });
  }

  getTokenCategory() {
    return 'Documentation';
  }

  async #handleClarifyQuestions(message) {
    const payload = message.payload || {};
    const text = String(payload.message || payload.text || '').trim();
    const ctx = message.context || {};
    ctx.documentMode = true;
    
    // Detect document type from text or use existing currentDocType
    let detectedDocType = detectDocType(text);
    if (!detectedDocType && text) {
      // Try direct matching for button clicks
      const upperText = text.toUpperCase();
      if (upperText === 'HLD') detectedDocType = 'HLD';
      else if (upperText === 'TDD') detectedDocType = 'TDD';
      else if (upperText === 'BRD') detectedDocType = 'BRD';
      else if (upperText === 'WBS') detectedDocType = 'WBS';
      else if (upperText === 'TEST PLAN' || upperText === 'TEST_PLAN') detectedDocType = 'TEST_PLAN';
    }
    
    ctx.currentDocType = ctx.currentDocType || detectedDocType || null;
    const history = Array.isArray(message.context?.history) ? message.context.history : [];

    console.log('[DocumentationAgent] #handleClarifyQuestions - Debug:', {
      text,
      detectedDocType,
      currentDocType: ctx.currentDocType,
      hasArchitecture: !!ctx.architecture,
      hasRaml: !!ctx.raml
    });

    // If we have A2A context (architecture + raml) and a valid document type, generate directly
    const hasA2AContext = ctx.architecture && ctx.raml;
    const validTypes = ['BRD', 'HLD', 'WBS', 'TDD', 'TEST_PLAN'];
    
    // For clarify-document, only ask for document type in pure chat flows where
    // there is no currentDocType and no explicit text indicating a type.
    if (!ctx.currentDocType && !text) {
      return A2AMessage.createResponse(this.agentId, message.from, {
        text: 'Documentation context is available. Please specify a document type (e.g., HLD, BRD, WBS, Test Plan, TDD) or use the UI buttons.',
        requiresUserInput: false
      }, message.requestId, ctx);
    }
    if (hasA2AContext && ctx.currentDocType && validTypes.includes(ctx.currentDocType)) {
      console.log('[DocumentationAgent] A2A context detected for document type:', ctx.currentDocType);

      // First, see if any clarifying questions are actually needed for this document type.
      let followUpQuestions = [];
      try {
        followUpQuestions = await generateDocumentClarifyingQuestions(
          { ...ctx, askedQuestions: new Set() },
          ctx.currentDocType,
          history,
          this.config
        );
        console.log(`[DocumentationAgent] Clarifying questions for ${ctx.currentDocType} in clarify flow:`, followUpQuestions.length);
      } catch (clarErr) {
        console.warn('[DocumentationAgent] Clarifying question generation failed, falling back to direct generation:', clarErr?.message || clarErr);
      }

      if (Array.isArray(followUpQuestions) && followUpQuestions.length > 0) {
        const numberedFollowUps = followUpQuestions.slice(0, 5).map((q, i) => ({
          number: i + 1,
          question: q,
          answer: null,
          validated: false
        }));
        ctx.a2aQuestionsShown = true;
        return A2AMessage.createResponse(this.agentId, message.from, { questions: numberedFollowUps, requiresUserInput: true }, message.requestId, ctx);
      }

      console.log('[DocumentationAgent] Direct generation for button click (no additional questions needed):', ctx.currentDocType);

      // Generate documentation immediately without questions
      const contextSummary = this.#buildA2AContextSummary(ctx);
      const inputs = {
        goal: `Generate comprehensive ${ctx.currentDocType} documentation`,
        systems: 'MuleSoft Integration Platform',
        apis: payload.apiName || 'MuleSoftAPI',
        deployment: 'CloudHub/Runtime Fabric',
        constraints: Array.from(ctx.requirements || []).join(', '),
        extraNotes: `Architecture: ${ctx.architecture?.substring(0, 500)}...\nRAML: ${ctx.raml?.substring(0, 500)}...`
      };
      
      let muleResp;
      try {
        const selectedModel = message.payload?.selectedModel;
        console.log('[DocumentationAgent] Calling generateDocument with:', {
          docType: ctx.currentDocType,
          inputs: Object.keys(inputs),
          contextSummary: contextSummary ? 'present' : 'missing'
        });
        
        muleResp = await generateDocument(
          ctx.currentDocType,
          inputs,
          contextSummary,
          '',
          { context: { sessionId: ctx.sessionId }, selectedModel }
        );
        
        console.log('[DocumentationAgent] generateDocument response:', {
          type: typeof muleResp,
          hasContent: !!(muleResp?.content),
          contentLength: muleResp?.content?.length || (typeof muleResp === 'string' ? muleResp.length : 0)
        });
      } catch (genErr) {
        console.error('[DocumentationAgent] Document generation failed:', genErr?.message || genErr);
        return A2AMessage.createResponse(this.agentId, message.from, {
          text: `❌ ${ctx.currentDocType} document generation failed: ${genErr?.message || genErr}. Please try again.`,
          documentGenerated: false
        }, message.requestId, ctx);
      }
      
      const content = muleResp?.content || (typeof muleResp === 'string' ? muleResp : '');
      ctx.generatedDocumentContent = content;
      
      console.log('[DocumentationAgent] Returning response with:', {
        docType: ctx.currentDocType,
        contentLength: content.length,
        documentGenerated: true
      });
      
      return A2AMessage.createResponse(this.agentId, message.from, {
        content,
        docType: ctx.currentDocType,
        text: `✅ ${ctx.currentDocType} document generated successfully!`,
        documentGenerated: true
      }, message.requestId, ctx);
    }

    const questions = [];
    const clar = await generateDocumentClarifyingQuestions({ ...ctx, askedQuestions: new Set() }, ctx.currentDocType || 'GENERAL', history, this.config);
    for (const q of clar) {
      if (!questions.includes(q)) questions.push(q);
    }

    // If no clarifying questions are needed based on context/history, generate the document directly
    if (questions.length === 0 && ctx.currentDocType) {
      console.log('[DocumentationAgent] No clarifying questions needed in clarify flow, generating directly for', ctx.currentDocType);

      const contextSummary = this.#buildA2AContextSummary(ctx);
      const inputs = {
        goal: `Generate comprehensive ${ctx.currentDocType} documentation`,
        systems: 'MuleSoft Integration Platform',
        apis: payload.apiName || 'MuleSoftAPI',
        deployment: 'CloudHub/Runtime Fabric',
        constraints: Array.from(ctx.requirements || []).join(', '),
        extraNotes: `Architecture: ${ctx.architecture?.substring(0, 500)}...\nRAML: ${ctx.raml?.substring(0, 500)}...`
      };

      let muleResp;
      try {
        const selectedModel = message.payload?.selectedModel;
        muleResp = await generateDocument(
          ctx.currentDocType,
          inputs,
          contextSummary,
          '',
          { context: { sessionId: ctx.sessionId }, selectedModel }
        );
      } catch (genErr) {
        console.error('[DocumentationAgent] Document generation failed in clarify flow:', genErr?.message || genErr);
        return A2AMessage.createResponse(this.agentId, message.from, {
          text: `❌ ${ctx.currentDocType} document generation failed: ${genErr?.message || genErr}. Please try again.`,
          documentGenerated: false
        }, message.requestId, ctx);
      }

      const content = muleResp?.content || (typeof muleResp === 'string' ? muleResp : '');
      ctx.generatedDocumentContent = content;

      return A2AMessage.createResponse(this.agentId, message.from, {
        content,
        docType: ctx.currentDocType,
        text: `✅ ${ctx.currentDocType} document generated successfully!`,
        documentGenerated: true
      }, message.requestId, ctx);
    }

    const numbered = questions.slice(0, 5).map((q, i) => ({ number: i + 1, question: q, answer: null, validated: false }));
    return A2AMessage.createResponse(this.agentId, message.from, { questions: numbered, requiresUserInput: true }, message.requestId, ctx);
  }

  async handleMessage(message) {
    try {
      const payload = message.payload || {};
      console.log('[DocumentationAgent] handleMessage received:', {
        type: payload.type,
        hasText: !!(payload.message || payload.text),
        sessionId: message.context?.sessionId || payload.sessionId || 'n/a'
      });
      switch (payload.type) {
        case 'documentation':
        case 'document:handle':
        case 'generate-document':
          return await this.#handleDocumentationFlow(message);
        case 'clarify-document':
          return await this.#handleClarifyQuestions(message);
        case 'convert-word':
          return await this.#handleConvertToWord(message);
        default:
          throw new Error(`Unknown message type: ${payload.type}`);
      }
    } catch (error) {
      return A2AMessage.createError(this.agentId, message.from, error.message, message.requestId);
    }
  }

  async #handleDocumentationFlow(message) {
    const payload = message.payload || {};
    const text = String(payload.message || payload.text || '').trim();
    const sessionId = payload.sessionId || message.context?.sessionId || 'default-session';

    const ctx = message.context || {};
    ctx.documentMode = true;
    ctx.currentDocType = ctx.currentDocType || null;
    ctx.clarifyingStep = ctx.clarifyingStep || 0;
    ctx.requirements = ctx.requirements || new Set();
    ctx.integrations = ctx.integrations || new Set();
    ctx.deploymentModels = ctx.deploymentModels || new Set();
    ctx.systems = ctx.systems || new Set();
    ctx.apis = ctx.apis || new Set();

    // A2A Protocol: If we have full context (architecture, raml, etc.) and no document type specified, ask for it
    const hasA2AContext = ctx.architecture && ctx.raml;
    
    console.log('[DocumentationAgent] A2A Context check:', {
      hasA2AContext,
      currentDocType: ctx.currentDocType,
      a2aQuestionsShown: ctx.a2aQuestionsShown,
      a2aDocTypeAsked: ctx.a2aDocTypeAsked,
      text: text ? text.substring(0, 100) + '...' : 'none'
    });
    
    // If a document type is already present in context (e.g., from button click), proceed directly
    if (hasA2AContext && ctx.currentDocType && !ctx.a2aQuestionsShown) {
      console.log('[DocumentationAgent] Context already has document type:', ctx.currentDocType);
      const history = Array.isArray(message.context?.history) ? message.context.history : [];
      
      // Extract system details from existing context to improve filtering
      if (ctx.architecture) {
        extractSystemDetails(ctx.architecture, ctx);
      }
      if (ctx.raml) {
        extractSystemDetails(ctx.raml, ctx);
      }
      
      const followUpQuestions = await generateDocumentClarifyingQuestions(ctx, ctx.currentDocType, history, this.config);
      console.log(`[DocumentationAgent] Generated ${followUpQuestions.length} follow-up questions for ${ctx.currentDocType} after context filtering`);
      
      if (followUpQuestions.length > 0) {
        const numberedQuestions = followUpQuestions.slice(0, 5).map((q, i) => ({
          number: i + 1,
          question: q,
          answer: null,
          validated: false
        }));
        ctx.a2aQuestionsShown = true;
        return A2AMessage.createResponse(this.agentId, message.from, {
          questions: numberedQuestions,
          text: `Great! I'll generate a ${ctx.currentDocType} document. Please answer these questions to make it comprehensive:`,
          requiresUserInput: true
        }, message.requestId, ctx);
      } else {
        // No questions needed; generate directly
        console.log('[DocumentationAgent] No questions needed for', ctx.currentDocType, '— generating now');
        const contextSummary = this.#buildA2AContextSummary(ctx);
        const inputs = {
          goal: `Generate comprehensive ${ctx.currentDocType} documentation`,
          systems: 'MuleSoft Integration Platform',
          apis: payload.apiName || 'MuleSoftAPI',
          deployment: 'CloudHub/Runtime Fabric',
          constraints: Array.from(ctx.requirements || []).join(', '),
          extraNotes: `Architecture: ${ctx.architecture?.substring(0, 500)}...\nRAML: ${ctx.raml?.substring(0, 500)}...`
        };
        let muleResp;
        try {
          const selectedModel = message.payload?.selectedModel;
          muleResp = await generateDocument(
            ctx.currentDocType,
            inputs,
            contextSummary,
            '',
            { context: { sessionId }, selectedModel }
          );
        } catch (genErr) {
          console.error('[DocumentationAgent] Document generation failed:', genErr?.message || genErr);
          return A2AMessage.createResponse(this.agentId, message.from, {
            text: `❌ ${ctx.currentDocType} document generation failed: ${genErr?.message || genErr}. Please try again.`,
            documentGenerated: false
          }, message.requestId, ctx);
        }
        const content = muleResp?.content || (typeof muleResp === 'string' ? muleResp : '');
        ctx.generatedDocumentContent = content;
        return A2AMessage.createResponse(this.agentId, message.from, {
          content,
          docType: ctx.currentDocType,
          text: `✅ ${ctx.currentDocType} document generated successfully!`,
          documentGenerated: true
        }, message.requestId, ctx);
      }
    }
    // A2A Protocol: If we have context but no document type and no explicit
    // request text, do not force a question; this case is expected to be
    // handled by explicit UI document-type selection.
    if (hasA2AContext && !ctx.currentDocType && !text) {
      console.log('[DocumentationAgent] A2A context with no document type and no text; awaiting explicit UI selection');
      return A2AMessage.createResponse(this.agentId, message.from, {
        text: 'Architecture and RAML are ready. Use the UI to select the document type you want to generate.',
        requiresUserInput: false
      }, message.requestId, ctx);
    }

    // Handle direct document type requests (from buttons)
    if (hasA2AContext && text && !ctx.currentDocType) {
      console.log('[DocumentationAgent] Processing direct document type request:', text);
      
      // Detect document type from the text (button click sends document type directly)
      let docType = detectDocType(text) || text.toUpperCase();
      
      // Validate and normalize document type
      const validTypes = ['BRD', 'HLD', 'WBS', 'TDD', 'TEST_PLAN'];
      if (validTypes.includes(docType)) {
        ctx.currentDocType = docType;
        ctx.a2aDocTypeAsked = true;
        ctx.a2aQuestionsShown = true;
        
        console.log('[DocumentationAgent] Document type set to:', docType);
        
        // Extract system details from existing context to improve filtering
        if (ctx.architecture) {
          extractSystemDetails(ctx.architecture, ctx);
        }
        if (ctx.raml) {
          extractSystemDetails(ctx.raml, ctx);
        }
        
        // Generate clarifying questions for this document type
        const history = Array.isArray(message.context?.history) ? message.context.history : [];
        const followUpQuestions = await generateDocumentClarifyingQuestions(ctx, docType, history, this.config);
        console.log(`[DocumentationAgent] Generated ${followUpQuestions.length} follow-up questions for ${docType} after context filtering`);
        
        if (followUpQuestions.length > 0) {
          const numberedQuestions = followUpQuestions.slice(0, 5).map((q, i) => ({ 
            number: i + 1, 
            question: q, 
            answer: null, 
            validated: false 
          }));
          
          console.log('[DocumentationAgent] Follow-up questions for', docType, ':', numberedQuestions);
          return A2AMessage.createResponse(this.agentId, message.from, { 
            questions: numberedQuestions,
            text: `Great! I'll generate a ${docType} document. Please answer these questions to make it comprehensive:`,
            requiresUserInput: true
          }, message.requestId, ctx);
        } else {
          // No additional questions needed, proceed to generation
          console.log('[DocumentationAgent] No additional questions needed for', docType, ', proceeding to generation');
          ctx.a2aReadyForGeneration = true;
          
          // Generate documentation immediately
          const contextSummary = this.#buildA2AContextSummary(ctx);
          const inputs = {
            goal: `Generate comprehensive ${docType} documentation`,
            systems: 'MuleSoft Integration Platform',
            apis: payload.apiName || 'MuleSoftAPI',
            deployment: 'CloudHub/Runtime Fabric',
            constraints: Array.from(ctx.requirements || []).join(', '),
            extraNotes: `Architecture: ${ctx.architecture?.substring(0, 500)}...\nRAML: ${ctx.raml?.substring(0, 500)}...`
          };
          
          console.log('[DocumentationAgent] Generating documentation for type:', docType);
          let muleResp;
          try {
            const selectedModel = message.payload?.selectedModel;
            muleResp = await generateDocument(
              docType,
              inputs,
              contextSummary,
              '',
              { context: { sessionId }, selectedModel }
            );
          } catch (genErr) {
            console.error('[DocumentationAgent] Document generation failed:', genErr?.message || genErr);
            return A2AMessage.createResponse(this.agentId, message.from, { 
              text: `❌ ${docType} document generation failed: ${genErr?.message || genErr}. Please try again.`,
              documentGenerated: false
            }, message.requestId, ctx);
          }
          
          const content = muleResp?.content || (typeof muleResp === 'string' ? muleResp : '');
          console.log('[DocumentationAgent] Document generated. Length:', content?.length || 0);
          
          // Store content and return success
          ctx.generatedDocumentContent = content;
          
          return A2AMessage.createResponse(this.agentId, message.from, { 
            content,
            docType: docType,
            text: `✅ ${docType} document generated successfully!`,
            documentGenerated: true
          }, message.requestId, ctx);
        }
      }
    }

    // A2A Protocol: Process document type answer and show follow-up questions
    if (hasA2AContext && ctx.a2aDocTypeAsked && !ctx.currentDocType && text && text.trim()) {
      console.log('[DocumentationAgent] Processing document type answer', {
        textLength: text.length
      });
      
      // First check if document type is already provided in context
      let docType = ctx.currentDocType || detectDocType(text);
      if (!docType) {
        // Try to match single word answers
        const lower = text.toLowerCase().trim();
        if (lower === 'hld' || lower.includes('high level')) docType = 'HLD';
        else if (lower === 'brd' || lower.includes('business req')) docType = 'BRD';
        else if (lower === 'wbs' || lower.includes('work breakdown')) docType = 'WBS';
        else if (lower === 'tdd' || lower.includes('technical design')) docType = 'TDD';
        else if (lower === 'test plan' || lower.includes('test')) docType = 'TEST_PLAN';
      }
      
      if (docType) {
        ctx.currentDocType = docType;
        ctx.a2aQuestionsShown = true;
        
        // Extract system details from context
        extractSystemDetails(text, ctx);
        if (ctx.architecture) {
          extractSystemDetails(ctx.architecture, ctx);
        }
        if (ctx.raml) {
          extractSystemDetails(ctx.raml, ctx);
        }
        
        // Use the existing generateDocumentClarifyingQuestions function
        const history = Array.isArray(message.context?.history) ? message.context.history : [];
        const followUpQuestions = await generateDocumentClarifyingQuestions(ctx, ctx.currentDocType, history, this.config);
        console.log(`[DocumentationAgent] Generated ${followUpQuestions.length} follow-up questions for ${ctx.currentDocType} after context filtering`);
        
        if (followUpQuestions.length > 0) {
          const numberedQuestions = followUpQuestions.slice(0, 5).map((q, i) => ({ 
            number: i + 1, 
            question: q, 
            answer: null, 
            validated: false 
          }));
          
          console.log('[DocumentationAgent] Follow-up questions for', ctx.currentDocType, ':', numberedQuestions);
          return A2AMessage.createResponse(this.agentId, message.from, { 
            questions: numberedQuestions,
            text: `Great! I'll generate a ${ctx.currentDocType} document. Please answer these additional questions to make it comprehensive:`,
            requiresUserInput: true
          }, message.requestId, ctx);
        } else {
          // No additional questions needed, proceed to generation immediately
          console.log('[DocumentationAgent] No additional questions needed, proceeding to generation');
          ctx.a2aReadyForGeneration = true;
          
          // Generate documentation immediately
          const contextSummary = this.#buildA2AContextSummary(ctx);
          const inputs = {
            goal: `Generate comprehensive technical documentation (${ctx.currentDocType})`,
            systems: 'MuleSoft Integration Platform',
            apis: payload.apiName || 'MuleSoftAPI',
            deployment: 'CloudHub/Runtime Fabric',
            constraints: Array.from(ctx.requirements || []).join(', '),
            extraNotes: `User Input: ${text}\n\nArchitecture: ${ctx.architecture?.substring(0, 500)}...\nRAML: ${ctx.raml?.substring(0, 500)}...`
          };
          
          console.log('[DocumentationAgent] Generating A2A documentation for type:', ctx.currentDocType);
          let muleResp;
          try {
            const selectedModel = message.payload?.selectedModel;
            muleResp = await generateDocument(
              ctx.currentDocType,
              inputs,
              contextSummary,
              '',
              { context: { sessionId }, selectedModel }
            );
          } catch (genErr) {
            console.error('[DocumentationAgent] A2A Document generation failed:', genErr?.message || genErr);
            return A2AMessage.createResponse(this.agentId, message.from, { 
              text: `❌ Document generation failed: ${genErr?.message || genErr}. Please try again or verify your configured LLM keys in .env.`,
              documentGenerated: false
            }, message.requestId, ctx);
          }
          
          const content = muleResp?.content || (typeof muleResp === 'string' ? muleResp : '');
          console.log('[DocumentationAgent] A2A Document generated. Length:', content?.length || 0);
          
          // Store content and set up for download option
          ctx.generatedDocumentContent = content;
          ctx.awaitingDocumentSatisfaction = true;
          
          return A2AMessage.createResponse(this.agentId, message.from, { 
            text: `📝 Generated ${ctx.currentDocType}: \n${content} \n\nAre you satisfied with this document? Would you like a downloadable Word file? (yes/no)`,
            content,
            documentGenerated: true,
            docType: ctx.currentDocType
          }, message.requestId, ctx);
        }
      } else {
        // Invalid document type, ask again
        const questions = [
          { number: 1, question: 'Please specify a valid document type: HLD, BRD, WBS, Test Plan, or TDD', answer: null, validated: false }
        ];
        return A2AMessage.createResponse(this.agentId, message.from, { 
          questions,
          text: 'I didn\'t recognize that document type. Please choose from: HLD, BRD, WBS, Test Plan, or TDD',
          requiresUserInput: true
        }, message.requestId, ctx);
      }
    }

    // A2A Protocol: Generate documentation with answers if we have them or if ready for generation
    if (hasA2AContext && ctx.currentDocType && (ctx.a2aQuestionsShown || ctx.a2aReadyForGeneration) && text && text.trim()) {
      console.log('[DocumentationAgent] A2A Protocol - generating documentation with user answers');
      
      // Extract information from context for documentation
      if (ctx.requirements) {
        if (typeof ctx.requirements === 'string') {
          ctx.requirements = new Set([ctx.requirements]);
        }
      }
      
      // Add user input to requirements
      if (text && text.trim()) {
        ctx.requirements = ctx.requirements || new Set();
        ctx.requirements.add(text.trim());
      }
      
      const contextSummary = this.#buildA2AContextSummary(ctx);
      const inputs = {
        goal: `Generate comprehensive technical documentation (${ctx.currentDocType})`,
        systems: 'MuleSoft Integration Platform',
        apis: payload.apiName || 'MuleSoftAPI',
        deployment: 'CloudHub/Runtime Fabric',
        constraints: Array.from(ctx.requirements || []).join(', '),
        extraNotes: `User Input: ${text}\n\nArchitecture: ${ctx.architecture?.substring(0, 500)}...\nRAML: ${ctx.raml?.substring(0, 500)}...`
      };
      
      console.log('[DocumentationAgent] Generating A2A documentation for type:', ctx.currentDocType);
      let muleResp;
      try {
        const selectedModel = message.payload?.selectedModel;
        muleResp = await generateDocument(
          ctx.currentDocType,
          inputs,
          contextSummary,
          '',
          { context: { sessionId }, selectedModel }
        );
      } catch (genErr) {
        console.error('[DocumentationAgent] A2A Document generation failed:', genErr?.message || genErr);
        return A2AMessage.createResponse(this.agentId, message.from, { 
          text: `❌ Document generation failed: ${genErr?.message || genErr}. Please try again or verify your configured LLM keys in .env.`,
          documentGenerated: false
        }, message.requestId, ctx);
      }
      
      const content = muleResp?.content || (typeof muleResp === 'string' ? muleResp : '');
      console.log('[DocumentationAgent] A2A Document generated. Length:', content?.length || 0);
      
      // Store content and set up for download option
      ctx.generatedDocumentContent = content;
      ctx.awaitingDocumentSatisfaction = true;
      
      return A2AMessage.createResponse(this.agentId, message.from, { 
        text: `📝 Generated ${ctx.currentDocType}: \n${content} \n\nAre you satisfied with this document? Would you like a downloadable Word file? (yes/no)`,
        content,
        documentGenerated: true,
        docType: ctx.currentDocType
      }, message.requestId, ctx);
    }

    if (ctx.awaitingDocumentSatisfaction) {
      const wantsWordDownload = /^(yes|y|ok|okay|sure|download|word|docx)\b/i.test(text);
      const isNegative = /^(no|n|nope|not|skip|cancel)\b/i.test(text);
      if (wantsWordDownload) {
        if (!ctx.generatedDocumentContent) {
          return A2AMessage.createResponse(this.agentId, message.from, { text: 'No document content available for conversion. Please generate a document first.' }, message.requestId, ctx);
        }
        ctx.awaitingDocumentSatisfaction = false;
        ctx.awaitingWordDownload = true;
        console.log('[DocumentationAgent] Converting to Word for session', sessionId);
        const wordResult = await convertMarkdownToWord(ctx.generatedDocumentContent);
        if (wordResult.success) {
          const finalFilename = this.#buildDocumentFilename(ctx);
          const wordFileStore = global.wordFileStore || (global.wordFileStore = new Map());
          wordFileStore.set(sessionId, {
            data: wordResult.data,
            filename: finalFilename,
            contentType: wordResult.contentType
          });
          ctx.documentationComplete = true;
          const allCoreDone = !!(ctx.architectureComplete && ctx.ramlComplete && ctx.estimationComplete && ctx.documentationComplete);
          const nextText = allCoreDone
            ? '\n\n✅ Core activities are completed. What would you like to do next?\n\n- Generate another document (e.g., HLD, BRD, WBS, Test Plan)\n- Generate Mule code for additional APIs or flows\n- End the session when you are done'
            : '\n\nWhat would you like to do next? You can generate another document or proceed with RAML, estimation, or Mule code.';
          const result = {
            text: 'Here is your document: ' + nextText,
            content: ctx.generatedDocumentContent,
            wordDownload: {
              filename: finalFilename,
              contentType: wordResult.contentType,
              downloadUrl: `/download-word/${sessionId}`,
              success: true
            }
          };
          console.log('[DocumentationAgent] Word conversion success. Filename:', finalFilename);
          return A2AMessage.createResponse(this.agentId, message.from, result, message.requestId, ctx);
        } else {
          console.error('[DocumentationAgent] Word conversion failed:', wordResult.error);
          return A2AMessage.createResponse(this.agentId, message.from, { text: `❌ Failed to convert to Word: ${wordResult.error}` }, message.requestId, ctx);
        }
      } else if (isNegative) {
        ctx.awaitingDocumentSatisfaction = false;
        ctx.generatedDocumentContent = null;
        ctx.documentationComplete = true;
        const allCoreDone = !!(ctx.architectureComplete && ctx.ramlComplete && ctx.estimationComplete && ctx.documentationComplete);
        const nextText = allCoreDone
          ? '✅ Core activities are completed. What would you like to do next?\n\n- Generate another document (e.g., HLD, BRD, WBS, Test Plan)\n- Generate Mule code for additional APIs or flows\n- End the session when you are done'
          : 'What would you like to do next? You can generate another document or proceed with RAML, estimation, or Mule code.';
        return A2AMessage.createResponse(this.agentId, message.from, { text: 'No problem! The document is ready for your use. ' + nextText }, message.requestId, ctx);
      } else {
        return A2AMessage.createResponse(this.agentId, message.from, { text: 'Please respond with "yes" if you want a Word download, or "no" to skip.' }, message.requestId, ctx);
      }
    }

    // Only auto-detect document type when it is not already present in context
    let docType = ctx.currentDocType || detectDocType(text);
    if (!ctx.currentDocType && docType && docType !== 'DOCUMENT_REQUEST') {
      ctx.currentDocType = docType;
      ctx.clarifyingStep = 0;
    } else if (!ctx.currentDocType && docType === 'DOCUMENT_REQUEST') {
      return A2AMessage.createResponse(this.agentId, message.from, { text: 'I can generate documentation for your project. What kind of document would you like to create?' }, message.requestId, ctx);
    }

    if (ctx.currentDocType) {
      extractSystemDetails(text, ctx);

      if (ctx.lastAskedDocQuestion) {
        const ans = String(text || '').trim();
        const q = String(ctx.lastAskedDocQuestion).toLowerCase();
        ctx.requirements = ctx.requirements || new Set();
        ctx.integrations = ctx.integrations || new Set();
        ctx.deploymentModels = ctx.deploymentModels || new Set();
        ctx.systems = ctx.systems || new Set();
        if (q.includes('business objectives') || q.includes('success criteria')) {
          ctx.requirements.add(ans);
        } else if (q.includes('key stakeholders') || q.includes('target audience')) {
          ctx.stakeholders = true;
          ctx.stakeholdersText = ans;
        } else if (q.includes('timeline') || q.includes('milestones') || q.includes('deliverables')) {
          ctx.timeline = true;
          ctx.timelineText = ans;
        } else if (q.includes('non-functional requirements')) {
          ctx.requirements.add(ans);
        } else if (q.includes('integrations and data flows')) {
          const lower = ans.toLowerCase();
          if (/(rest|http)/.test(lower)) ctx.integrations.add('REST');
          if (/soap/.test(lower)) ctx.integrations.add('SOAP');
          if (/(db|database|sql|mysql|postgres|oracle)/.test(lower)) ctx.integrations.add('Database');
          if (/(file|ftp|sftp)/.test(lower)) ctx.integrations.add('File');
          if (/(mq|kafka|amqp|pub\/?sub|queue|topic|messag)/.test(lower)) ctx.integrations.add('Messaging');
        } else if (q.includes('deployment environment') || q.includes('infrastructure')) {
          const lower = ans.toLowerCase();
          if (/cloudhub/.test(lower)) ctx.deploymentModels.add('CloudHub');
          if (/runtime\s*fabric|rtf/.test(lower)) ctx.deploymentModels.add('Runtime Fabric');
          if (/on[-\s]?prem|onprem/.test(lower)) ctx.deploymentModels.add('On-Premise');
          if (/hybrid/.test(lower)) ctx.deploymentModels.add('Hybrid');
          if (/multi[-\s]?cloud/.test(lower)) ctx.deploymentModels.add('Multi-Cloud');
        }
        ctx.lastAskedDocQuestion = null;
      }

      const history = Array.isArray(message.context?.history) ? message.context.history : [];
      const questions = generateDocumentClarifyingQuestions(ctx, ctx.currentDocType, history);

      if (questions.length > 0 && ctx.clarifyingStep < questions.length) {
        const question = questions[ctx.clarifyingStep];
        ctx.clarifyingStep++;
        if (!ctx.askedQuestions) ctx.askedQuestions = new Set();
        ctx.askedQuestions.add(String(question).toLowerCase());
        ctx.lastAskedDocQuestion = question;
        console.log('[DocumentationAgent] Clarifying question:', question);
        return A2AMessage.createResponse(this.agentId, message.from, { text: question }, message.requestId, ctx);
      } else {
        const contextSummary = buildContextSummary(ctx);
        const conversationSummary = (history || []).map(msg => `${msg.role}: ${String(msg.content).substring(0, 500)}...`).join('\n');
        const inputs = {
          goal: `Generate ${ctx.currentDocType}`,
          systems: Array.from(ctx.systems).join(', '),
          apis: Array.from(ctx.apis).join(', '),
          deployment: Array.from(ctx.deploymentModels).join(', '),
          constraints: Array.from(ctx.requirements).join(', '),
          extraNotes: text
        };
        console.log('[DocumentationAgent] Generating document for type:', ctx.currentDocType);
        let muleResp;
        try {
          const selectedModel = message.payload?.selectedModel;
          muleResp = await generateDocument(
            ctx.currentDocType,
            inputs,
            contextSummary,
            conversationSummary,
            { context: { sessionId }, selectedModel }
          );
        } catch (genErr) {
          console.error('[DocumentationAgent] Document generation failed:', genErr?.message || genErr);
          return A2AMessage.createResponse(this.agentId, message.from, { 
            text: `❌ Document generation failed: ${genErr?.message || genErr}. Please try again or verify your configured LLM keys in .env.`,
            documentGenerated: false
          }, message.requestId, ctx);
        }
        const content = muleResp?.content || (typeof muleResp === 'string' ? muleResp : '');
        ctx.generatedDocumentContent = content;
        ctx.awaitingDocumentSatisfaction = true;
        const result = {
          text: `📝 Generated ${ctx.currentDocType}: \n${content} \n\nAre you satisfied with this document? Would you like a downloadable Word file? (yes/no)`,
          content,
          documentGenerated: true,
          docType: ctx.currentDocType
        };
        console.log('[DocumentationAgent] Document generated. Length:', content?.length || 0);
        return A2AMessage.createResponse(this.agentId, message.from, result, message.requestId, ctx);
      }
    }

    console.log('[DocumentationAgent] Reached fallback response. Context state:', {
      hasA2AContext,
      currentDocType: ctx.currentDocType,
      a2aDocTypeAsked: ctx.a2aDocTypeAsked,
      textLength: text?.length || 0
    });
    
    // Fallback: If we have A2A context but no document type, do not prompt;
    // this is expected to be driven by UI (document buttons).
    if (hasA2AContext && !ctx.currentDocType) {
      console.log('[DocumentationAgent] A2A context without document type; waiting for UI-driven document selection');
      return A2AMessage.createResponse(this.agentId, message.from, {
        text: 'Architecture and RAML are ready. Please choose a document type from the UI to proceed.',
        requiresUserInput: false
      }, message.requestId, ctx);
    }

    return A2AMessage.createResponse(this.agentId, message.from, { text: 'I can generate documentation for your project. What kind of document would you like to create?' }, message.requestId, ctx);
  }

  /**
   * Build context summary for A2A Protocol documentation generation
   * @private
   */
  #buildA2AContextSummary(ctx) {
    const summary = [];
    
    if (ctx.architecture) {
      summary.push(`Architecture: ${ctx.architecture.substring(0, 1000)}`);
    }
    
    if (ctx.diagram) {
      summary.push(`Diagram: ${ctx.diagram.substring(0, 500)}`);
    }
    
    if (ctx.estimation) {
      summary.push(`Estimation: ${ctx.estimation.substring(0, 500)}`);
    }
    
    if (ctx.raml) {
      summary.push(`RAML Specification: ${ctx.raml.substring(0, 1000)}`);
    }
    
    if (ctx.requirements) {
      const reqs = Array.isArray(ctx.requirements) ? ctx.requirements : Array.from(ctx.requirements || []);
      if (reqs.length > 0) {
        summary.push(`Requirements: ${reqs.join(', ')}`);
      }
    }
    
    return summary.join('\n\n');
  }

  /**
   * Build a final Word filename based on document type and inferred scenario
   * e.g., BRD-shopify-sap-integration.docx or test-shopify-sap-integration.docx
   * @private
   */
  #buildDocumentFilename(ctx = {}) {
    try {
      // Prefer a human-readable filename based on scenario title or document heading
      const displayMap = {
        BRD: 'Business Requirements Document',
        HLD: 'High-Level Integration Design (HLD)',
        WBS: 'Work Breakdown Structure',
        TDD: 'Technical Design Document',
        TEST_PLAN: 'Test Plan'
      };

      const rawType = (ctx.currentDocType || 'Document').toString().toUpperCase();
      const display = displayMap[rawType] || (rawType === 'TEST_PLAN' ? 'Test Plan' : (ctx.currentDocType || 'Document'));

      // 1) If scenarioTitle is present (from generator), use "{Display} for {ScenarioTitle}.docx"
      if (ctx.scenarioTitle && typeof ctx.scenarioTitle === 'string') {
        const pretty = `${display} for ${ctx.scenarioTitle}`;
        return `${pretty}.docx`;
      }

      // 2) If generated content has a markdown H1, use that as filename
      if (ctx.generatedDocumentContent && typeof ctx.generatedDocumentContent === 'string') {
        const firstLine = ctx.generatedDocumentContent.split(/\r?\n/).find(l => /^\s*#\s+/.test(l));
        if (firstLine) {
          const title = firstLine.replace(/^\s*#\s+/, '').trim();
          if (title) return `${title}.docx`;
        }
      }

      // 3) Fallback: Ensure systems are extracted and use primary system for a readable name
      try {
        if ((!ctx.systems || ctx.systems.size === 0) && ctx.architecture) {
          extractSystemDetails(ctx.architecture, ctx);
        }
        if ((!ctx.systems || ctx.systems.size === 0) && ctx.raml) {
          extractSystemDetails(ctx.raml, ctx);
        }
      } catch {}

      const systems = Array.from(ctx.systems || []);
      const primary = systems.length > 0 ? systems[0] : 'Integration';
      const pretty = `${display} for ${String(primary).charAt(0).toUpperCase()}${String(primary).slice(1).toLowerCase()}`;
      return `${pretty}.docx`;
    } catch {
      const fallback = (ctx.currentDocType || 'Document').toString();
      return `${fallback}.docx`;
    }
  }

  async #handleConvertToWord(message) {
    const ctx = message.context || {};
    if (!ctx.generatedDocumentContent) {
      return A2AMessage.createResponse(this.agentId, message.from, { text: 'No document content available for conversion. Please generate a document first.' }, message.requestId, ctx);
    }
    const sessionId = message.payload?.sessionId || message.context?.sessionId || 'default-session';
    const wordResult = await convertMarkdownToWord(ctx.generatedDocumentContent);
    if (wordResult.success) {
      const finalFilename = this.#buildDocumentFilename(ctx);
      const wordFileStore = global.wordFileStore || (global.wordFileStore = new Map());
      wordFileStore.set(sessionId, {
        data: wordResult.data,
        filename: finalFilename,
        contentType: wordResult.contentType
      });
      return A2AMessage.createResponse(this.agentId, message.from, {
        wordDownload: {
          filename: finalFilename,
          contentType: wordResult.contentType,
          downloadUrl: `/download-word/${sessionId}`,
          success: true
        }
      }, message.requestId, ctx);
    } else {
      return A2AMessage.createResponse(this.agentId, message.from, { text: `❌ Failed to convert to Word: ${wordResult.error}` }, message.requestId, ctx);
    }
  }
}

export default DocumentationAgent;
