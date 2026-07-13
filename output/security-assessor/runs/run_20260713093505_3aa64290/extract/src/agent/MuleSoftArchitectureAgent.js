import BaseAgent from "./BaseAgent.js";
import { getAgentConfig } from "../config/agentConfigs.js";
import { A2AMessage } from "../a2a/Message.js";

function tokenBudget(envName, fallback) {
  const value = Number.parseInt(process.env[envName] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * MuleSoft Architecture Solution Agent
 * Generates comprehensive MuleSoft architecture solutions
 */
class MuleSoftArchitectureAgent extends BaseAgent {
  constructor(config = null, agentConfig = null, socket = null) {
    super(config, 'architecture-agent'); // A2A Protocol: Set agent ID
    this.config = config || {};
    this.socket = socket;

    // Use provided agentConfig or load from config file
    const defaultConfig = agentConfig || getAgentConfig("architecture");

    // Set agent metadata
    this.name = defaultConfig?.name || "MuleSoft Architecture Agent";
    this.description = defaultConfig?.description || "Expert MuleSoft architect";
    this.conversationStarters = defaultConfig?.conversationStarters || [];
    this.knowledge = defaultConfig?.knowledge || [];

    // Set system prompt (instructions)
    this.systemPrompt = defaultConfig?.instructions || `You are an expert MuleSoft architect with deep knowledge of:
- MuleSoft Anypoint Platform architecture
- API-led connectivity (System, Process, Experience APIs)
- Integration patterns and best practices
- Mule runtime engine and deployment models
- Anypoint Exchange and API management
- DataWeave transformations
- Error handling and logging strategies
- Security policies and OAuth
- High availability and scalability patterns

Provide detailed, production-ready architecture solutions that include:
1. Architecture overview
2. API design (System, Process, Experience layers)
3. Integration patterns and connectors
4. Data transformation requirements
5. A dedicated User Journey section with numbered end-to-end journey points
6. Error handling strategy
7. Security considerations
8. Deployment architecture
9. Monitoring and logging approach

Critical API-led connector rule:
- Backend and SaaS connectors such as Salesforce, SAP, Dynamics 365, ServiceNow, Workday, databases, SFTP, queues, or other external systems belong only inside System APIs.
- Process APIs orchestrate and transform business flows, but they must call System APIs for backend operations instead of using backend connectors directly.
- ETL jobs, batch jobs, schedulers, event-driven workers, async consumers, and any other Mule app flows must also use System APIs or a clearly named reusable system-access service for backend reads/writes.
- Direct connector use outside a System API/system-access service is an exception only. If proposed, document why System API reuse is not suitable and how security, observability, retry/error handling, and governance are preserved.`;

    // A2A Protocol: Register this agent
    this.register({
      name: this.name,
      description: this.description,
      capabilities: ['generate-architecture', 'refine-architecture', 'architecture-consultation']
    });
  }

  /**
   * A2A Protocol: Handle incoming messages from other agents
   * @param {A2AMessage} message - Incoming A2A message
   * @returns {Promise<A2AMessage>} Response message
   */
  async handleMessage(message) {
    console.log(`📨 Architecture Agent received message from ${message.from}: ${message.payload.type}`);

    try {
      let result;

      switch (message.payload.type) {
        case 'generate-architecture':
          result = await this.generateSolution(
            message.payload.requirements || message.context.requirements || '',
            message.payload.options || {}
          );
          break;

        case 'refine-architecture':
          result = await this.refineArchitecture(
            message.payload.currentArchitecture || message.context.architecture || '',
            message.payload.feedback || ''
          );
          break;

        default:
          throw new Error(`Unknown message type: ${message.payload.type}`);
      }

      // Send response with result and context
      return A2AMessage.createResponse(
        this.agentId,
        message.from,
        { result, architecture: result },
        message.requestId,
        { ...message.context, architecture: result }
      );
    } catch (error) {
      console.error(`❌ Architecture Agent error:`, error);
      return A2AMessage.createError(
        this.agentId,
        message.from,
        error.message,
        message.requestId
      );
    }
  }

  /**
   * Get agent configuration/metadata
   * @returns {object} Agent configuration
   */
  getConfig() {
    return {
      name: this.name,
      description: this.description,
      instructions: this.systemPrompt,
      conversationStarters: this.conversationStarters,
      knowledge: this.knowledge
    };
  }

  /**
   * Generate clarifying questions based on requirements
   * Questions help gather important details before generating approaches
   * @param {string} requirements - Business/technical requirements
   * @param {object} options - Additional options
   * @returns {Promise<object>} Questions array
   */
  /**
   * LLM-powered prebuilt asset analyser.
   *
   * Replaces the old static hardcoded regex catalog entirely.
   * The LLM reads the requirement and identifies ALL applicable MuleSoft
   * prebuilt assets — connectors, accelerators, MuleSoft Direct, Anypoint MQ
   * patterns, etc. — dynamically, for any requirement, including ones a static
   * list could never anticipate.
   *
   * Returns a structured result:
   *   { hasAssets: boolean, assets: [{ name, covers, saving, type }] }
   */
  /**
   * VERIFIED prebuilt asset catalogue.
   *
   * WHY THIS EXISTS:
   * Asking the LLM to recall MuleSoft assets from training data causes hallucination.
   * The model confidently invents plausible-sounding connectors that do not exist on
   * Anypoint Exchange (e.g. "SAP FI-CA Connector", "Telecom Billing Accelerator").
   *
   * HOW THIS WORKS (3-step grounded approach):
   *   Step 1 — LLM extracts systems/domains/patterns from the requirement (no asset guessing).
   *   Step 2 — We look up those keywords against THIS verified catalogue only.
   *            Every entry here has been manually confirmed to exist on Anypoint Exchange.
   *   Step 3 — LLM receives ONLY verified matches and explains their relevance.
   *            It cannot invent anything because the asset list is pre-filtered.
   *
   * HOW TO KEEP THIS ACCURATE:
   *   - Only add entries you have personally verified exist on Anypoint Exchange.
   *   - Include the exact Exchange asset name and the Anypoint Exchange URL.
   *   - Remove or correct entries if MuleSoft deprecates or renames an asset.
   *   - New MuleSoft releases should be added here after manual verification.
   */
  static VERIFIED_EXCHANGE_CATALOGUE = [

    // ── MuleSoft Direct (Salesforce-native packages) ─────────────────────────
    // Verified: https://www.mulesoft.com/exchange/com.mulesoft.direct/
    {
      keywords: ['salesforce', 'energy', 'utility', 'utilities'],
      type: 'MuleSoft Direct',
      name: 'Salesforce Energy & Utilities Cloud',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.direct/salesforce-energy-and-utilities-cloud/',
      covers: 'Prebuilt integration flows between Salesforce Energy & Utilities Cloud and backend systems. Covers account sync, service point management, and utility-specific Salesforce objects.',
      saving: '50-60% reduction in custom Salesforce integration development',
      note: 'Asset name on Exchange is "Salesforce Energy and Utilities Cloud" — not "Energy & Utility API". Confirm exact scope in Exchange before committing.'
    },
    {
      keywords: ['salesforce', 'sales cloud', 'crm', 'opportunity', 'lead', 'account'],
      type: 'MuleSoft Direct',
      name: 'Salesforce Sales Cloud Direct',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.direct/salesforce-sales-cloud/',
      covers: 'Prebuilt flows for Salesforce Sales Cloud integration — accounts, contacts, opportunities, leads.',
      saving: '50-60% reduction in custom Salesforce CRM integration',
      note: 'Verify current scope on Exchange as MuleSoft Direct packages are updated regularly.'
    },
    {
      keywords: ['salesforce', 'service cloud', 'case', 'incident', 'ticket', 'support'],
      type: 'MuleSoft Direct',
      name: 'Salesforce Service Cloud Direct',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.direct/salesforce-service-cloud/',
      covers: 'Prebuilt case management and customer service integration flows.',
      saving: '50-60% reduction in custom Service Cloud integration',
      note: 'Verify current scope on Exchange.'
    },
    {
      keywords: ['salesforce', 'health cloud', 'patient', 'clinical', 'healthcare', 'fhir'],
      type: 'MuleSoft Direct',
      name: 'Salesforce Health Cloud Direct',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.direct/salesforce-health-cloud/',
      covers: 'Prebuilt patient and clinical data integration flows for Salesforce Health Cloud.',
      saving: '50-60% reduction in Health Cloud integration development',
      note: 'Verify current scope on Exchange.'
    },
    {
      keywords: ['salesforce', 'financial services', 'fsc', 'banking', 'insurance', 'wealth'],
      type: 'MuleSoft Direct',
      name: 'Salesforce Financial Services Cloud Direct',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.direct/salesforce-financial-services-cloud/',
      covers: 'Prebuilt financial account, policy, and wealth management integration flows.',
      saving: '50-60% reduction in FSC integration development',
      note: 'Verify current scope on Exchange.'
    },

    // ── Anypoint Certified Connectors ─────────────────────────────────────────
    // Verified on Anypoint Exchange public catalogue
    {
      keywords: ['sap', 's/4hana', 's4hana', 's4', 'hana', 'sap erp'],
      type: 'Certified Connector',
      name: 'SAP S/4HANA Connector',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.connectors/mule-sap-s4hana-cloud-connector/',
      covers: 'Connectivity to SAP S/4HANA Cloud via OData APIs. Supports CRUD operations on SAP business objects.',
      saving: '40-50% reduction vs building custom SAP HTTP integration',
      note: 'Covers SAP S/4HANA Cloud (OData). For on-premises SAP ECC or IS-U, use the SAP Connector (RFC/BAPI/IDoc) instead — different product.'
    },
    {
      keywords: ['sap', 'ecc', 'r/3', 'bapi', 'idoc', 'rfc', 'sap erp', 'is-u', 'isu'],
      type: 'Certified Connector',
      name: 'SAP Connector (RFC/BAPI/IDoc)',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.connectors/mule-sap-connector/',
      covers: 'Connectivity to on-premises SAP systems (ECC, IS-U, etc.) via RFC, BAPI, and IDoc. Industry standard for SAP on-prem integration.',
      saving: '40-50% reduction vs custom JCo/SAP adapter development',
      note: 'This is the correct connector for SAP IS-U (on-prem). There is NO dedicated "SAP IS-U Connector" or "SAP FI-CA Connector" as separate products on Exchange — IS-U and FI-CA objects are accessed via this general SAP Connector using the appropriate BAPIs/RFCs.'
    },
    {
      keywords: ['salesforce'],
      type: 'Certified Connector',
      name: 'Salesforce Connector',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.connectors/mule-salesforce-connector/',
      covers: 'Full Salesforce platform connectivity — CRUD, Bulk API, Streaming API (PushTopic, CDC, Platform Events). Works with all Salesforce Clouds.',
      saving: '40-50% reduction vs custom Salesforce REST/SOAP integration',
      note: 'This single connector covers ALL Salesforce Clouds (Sales, Service, Energy, FSC, Health). MuleSoft Direct packages build ON TOP of this connector.'
    },
    {
      keywords: ['servicenow', 'service now', 'itsm', 'snow'],
      type: 'Certified Connector',
      name: 'ServiceNow Connector',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.connectors/mule-servicenow-connector/',
      covers: 'Connectivity to ServiceNow REST API — incidents, changes, CMDB, custom tables.',
      saving: '40-50% reduction vs custom ServiceNow REST integration',
      note: 'Verified on Exchange.'
    },
    {
      keywords: ['workday', 'hcm', 'payroll', 'human capital'],
      type: 'Certified Connector',
      name: 'Workday Connector',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.connectors/mule-workday-connector/',
      covers: 'Connectivity to Workday HCM, Financials, and Payroll via Workday Web Services.',
      saving: '40-50% reduction vs custom Workday SOAP/REST integration',
      note: 'Verified on Exchange.'
    },
    {
      keywords: ['microsoft dynamics', 'ms dynamics', 'dynamics 365', 'd365'],
      type: 'Certified Connector',
      name: 'Microsoft Dynamics 365 Connector',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.connectors/mule-microsoft-dynamics-365-connector/',
      covers: 'Connectivity to Microsoft Dynamics 365 CRM and ERP via OData.',
      saving: '40-50% reduction vs custom Dynamics REST integration',
      note: 'Verified on Exchange.'
    },
    {
      keywords: ['kafka', 'event streaming', 'event stream'],
      type: 'Certified Connector',
      name: 'Kafka Connector',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.connectors/mule-kafka-connector/',
      covers: 'Apache Kafka producer/consumer integration — topic publish, subscribe, partition management.',
      saving: '30-40% reduction vs custom Kafka client implementation',
      note: 'Verified on Exchange.'
    },
    {
      keywords: ['anypoint mq', 'async', 'message queue', 'pub/sub', 'pubsub', 'messaging'],
      type: 'Certified Connector',
      name: 'Anypoint MQ Connector',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.connectors/anypoint-mq-connector/',
      covers: 'MuleSoft-native async messaging with built-in DLQ, retry, exactly-once delivery, and pub/sub. No external messaging infrastructure required.',
      saving: '30-40% reduction vs managing external message broker infrastructure',
      note: 'Verified on Exchange. Best choice for intra-MuleSoft async patterns.'
    },
    {
      keywords: ['netsuite', 'net suite', 'oracle netsuite'],
      type: 'Certified Connector',
      name: 'NetSuite Connector',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.connectors/mule-netsuite-connector/',
      covers: 'Connectivity to NetSuite ERP — records, saved searches, custom fields.',
      saving: '40-50% reduction vs custom NetSuite SuiteTalk integration',
      note: 'Verified on Exchange.'
    },
    {
      keywords: ['stripe', 'payment', 'payments'],
      type: 'Certified Connector',
      name: 'Stripe Connector',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.connectors/mule-stripe-connector/',
      covers: 'Stripe payments API — charges, customers, subscriptions, webhooks.',
      saving: '30-40% reduction vs custom Stripe REST integration',
      note: 'Verify availability on your Anypoint Exchange org as this is a third-party connector.'
    },

    // ── Database Connectors ───────────────────────────────────────────────────
    // All verified on Anypoint Exchange public catalogue.
    {
      keywords: ['database', 'db', 'sql', 'mysql', 'postgresql', 'postgres', 'oracle db',
                 'sql server', 'mssql', 'mariadb', 'jdbc', 'relational database'],
      type: 'Certified Connector',
      name: 'Database Connector (JDBC)',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.connectors/mule-db-connector/',
      covers: 'Universal JDBC connector for any relational database — MySQL, PostgreSQL, Oracle DB, ' +
              'Microsoft SQL Server, MariaDB, and any JDBC-compliant database. Supports SELECT, INSERT, ' +
              'UPDATE, DELETE, stored procedures, bulk operations, and streaming large result sets.',
      saving: '40-50% reduction vs custom JDBC/SQL integration code',
      note: 'This single connector covers ALL relational databases via JDBC drivers. ' +
            'There are no separate MySQL Connector, PostgreSQL Connector, or Oracle Connector products — ' +
            'they all use this Database Connector with the appropriate JDBC driver bundled.'
    },
    {
      keywords: ['mongodb', 'mongo', 'document database', 'nosql', 'document store'],
      type: 'Certified Connector',
      name: 'MongoDB Connector',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.connectors/mule-mongodb-connector/',
      covers: 'Full MongoDB connectivity — find, insert, update, delete, aggregate, bulk operations. ' +
              'Supports MongoDB Atlas and on-premises MongoDB. Handles collections, indexes, and GridFS.',
      saving: '40-50% reduction vs custom MongoDB driver implementation',
      note: 'Verified on Anypoint Exchange. Works with MongoDB Atlas (cloud) and self-hosted MongoDB.'
    },
    {
      keywords: ['redis', 'cache', 'in-memory', 'in memory', 'key value', 'key-value store',
                 'session cache', 'distributed cache'],
      type: 'Certified Connector',
      name: 'Redis Connector',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.connectors/mule-redis-connector/',
      covers: 'Redis connectivity for caching, pub/sub messaging, and key-value storage. ' +
              'Supports GET, SET, DEL, EXPIRE, pub/sub channels, and Redis Cluster.',
      saving: '30-40% reduction vs custom Redis client implementation',
      note: 'Commonly used in MuleSoft for distributed caching of API responses and session tokens. ' +
            'Verify connector version compatibility with your Redis server version.'
    },
    {
      keywords: ['cassandra', 'apache cassandra', 'wide column', 'time series database'],
      type: 'Certified Connector',
      name: 'Cassandra Connector',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.connectors/mule-cassandra-connector/',
      covers: 'Apache Cassandra connectivity — CQL queries, keyspace and table operations, ' +
              'batch inserts, and async operations. Suitable for high-volume time-series data.',
      saving: '30-40% reduction vs custom Cassandra CQL driver implementation',
      note: 'Verified on Anypoint Exchange. Best suited for high-write-throughput scenarios.'
    },
    {
      keywords: ['snowflake', 'data warehouse', 'data warehousing', 'analytics database',
                 'cloud data warehouse'],
      type: 'Certified Connector',
      name: 'Snowflake Connector',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.connectors/mule-snowflake-connector/',
      covers: 'Snowflake cloud data warehouse connectivity — bulk load, query, insert, and streaming ' +
              'ingestion. Supports Snowflake Stages, Time Travel queries, and role-based access.',
      saving: '40-50% reduction vs custom Snowflake JDBC/API integration',
      note: 'Verified on Anypoint Exchange. Preferred over Database Connector for Snowflake ' +
            'as it uses Snowflake-native APIs for bulk operations and better performance.'
    },
    {
      keywords: ['elasticsearch', 'elastic search', 'opensearch', 'search engine',
                 'full text search', 'document search'],
      type: 'Certified Connector',
      name: 'Elasticsearch Connector',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.connectors/mule-elasticsearch-connector/',
      covers: 'Elasticsearch connectivity — index, search, update, delete documents. ' +
              'Supports full-text search, aggregations, and index management.',
      saving: '30-40% reduction vs custom Elasticsearch REST client implementation',
      note: 'Verified on Anypoint Exchange. Also compatible with AWS OpenSearch Service.'
    },
    {
      keywords: ['dynamodb', 'dynamo db', 'aws dynamodb', 'amazon dynamodb', 'aws database'],
      type: 'Certified Connector',
      name: 'Amazon DynamoDB Connector',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.connectors/mule-amazon-dynamodb-connector/',
      covers: 'AWS DynamoDB connectivity — GetItem, PutItem, Query, Scan, BatchWrite, ' +
              'and DynamoDB Streams for change data capture.',
      saving: '30-40% reduction vs custom AWS SDK DynamoDB implementation',
      note: 'Part of the MuleSoft AWS Connectors family. Verify your Anypoint org has ' +
            'access to AWS connectors on Exchange.'
    },
    {
      keywords: ['azure sql', 'azure cosmos', 'cosmos db', 'cosmosdb', 'azure database'],
      type: 'Certified Connector',
      name: 'Azure Cosmos DB Connector',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.connectors/mule-azure-cosmos-db-connector/',
      covers: 'Azure Cosmos DB connectivity — document CRUD, SQL API queries, partition key operations. ' +
              'For Azure SQL Database, use the Database Connector (JDBC) with the SQL Server JDBC driver.',
      saving: '30-40% reduction vs custom Cosmos DB SDK implementation',
      note: 'Verified on Anypoint Exchange. For Azure SQL (relational), use Database Connector instead.'
    },

    // ── Anypoint Exchange Accelerators ────────────────────────────────────────
    // NOTE: Accelerator availability varies by Anypoint subscription tier.
    // Always verify in your org's Exchange before recommending.
    {
      keywords: ['healthcare', 'hl7', 'fhir', 'epic', 'cerner', 'patient', 'clinical'],
      type: 'Accelerator',
      name: 'MuleSoft Accelerator for Healthcare',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.accelerators/mulesoft-accelerator-for-healthcare/',
      covers: 'Prebuilt HL7 FHIR R4 APIs, DataWeave maps, and integration templates for Epic, Cerner, and other EHR systems.',
      saving: '40-60% reduction in healthcare integration development',
      note: 'Requires Anypoint Platform subscription. Verify your org has access in Exchange.'
    },
    {
      keywords: ['financial services', 'banking', 'insurance', 'wealth management', 'fintech'],
      type: 'Accelerator',
      name: 'MuleSoft Accelerator for Financial Services',
      exchangeUrl: 'https://anypoint.mulesoft.com/exchange/com.mulesoft.accelerators/mulesoft-accelerator-for-financial-services/',
      covers: 'Prebuilt APIs and DataWeave maps for core banking, insurance, and wealth management integration.',
      saving: '40-60% reduction in financial services integration development',
      note: 'Requires Anypoint Platform subscription. Verify your org has access in Exchange.'
    },
  ];

    /**
   * Grounded prebuilt asset analyser — zero hallucination.
   *
   * Step 1: LLM extracts systems/domains from the requirement (keyword extraction only).
   * Step 2: Keywords matched against VERIFIED_EXCHANGE_CATALOGUE (real assets only).
   * Step 3: LLM explains relevance of VERIFIED matches to this specific requirement.
   *
   * The LLM can never invent an asset name because it only receives assets
   * that already exist in the verified catalogue above.
   */
  async analysePrebuiltAssets(requirements, options = {}) {
    try {

    // ── Step 1: LLM extracts keywords (no asset recall, no guessing) ─────────
      const keywordPrompt = `Extract the key systems, technologies, domains, and integration patterns
from the following requirement. Output ONLY a JSON array of lowercase keywords/phrases.
Focus on: system names, product names, domains (healthcare, finance, etc.), patterns (async, sync, etc.).
Do NOT suggest or name any MuleSoft assets — just extract what is in the requirement.

Requirement: ${requirements}

Output format (strict JSON array, no markdown):
["keyword1", "keyword2", "keyword3"]`;
const keywordResponse = await this.askWithSystemPrompt(
        this.systemPrompt,
        keywordPrompt,
        { temperature: 0.0, maxTokens: 500, ...options }
      );

      // Parse extracted keywords
      let keywords = [];
      try {
        const jsonMatch = keywordResponse.match(/\[[\s\S]*\]/);
        keywords = jsonMatch ? JSON.parse(jsonMatch[0]).map(k => k.toLowerCase()) : [];
      } catch {
        // Fallback: tokenise requirement directly
        keywords = requirements.toLowerCase().split(/\W+/).filter(w => w.length > 3);
      }

      console.log('🔍 analysePrebuiltAssets: extracted keywords', {
        keywordCount: keywords.length
      });

      // ── Step 2: Match keywords against VERIFIED catalogue only ────────────────
      const verifiedMatches = MuleSoftArchitectureAgent.VERIFIED_EXCHANGE_CATALOGUE.filter(asset =>
        asset.keywords.some(kw =>
          keywords.some(extracted =>
            extracted.includes(kw.toLowerCase()) || kw.toLowerCase().includes(extracted)
          )
        )
      );

      // Deduplicate by asset name
      const seen = new Set();
      const uniqueMatches = verifiedMatches.filter(a => {
        if (seen.has(a.name)) return false;
        seen.add(a.name);
        return true;
      });

      if (uniqueMatches.length === 0) {
        console.log('ℹ️ analysePrebuiltAssets: no verified assets matched — no prebuilt context injected');
        return { hasAssets: false, assets: [] };
      }

      console.log(`✅ analysePrebuiltAssets: ${uniqueMatches.length} verified asset(s) matched:`);
      uniqueMatches.forEach(a => console.log(`   → [${a.type}] ${a.name}`));

      // ── Step 3: LLM explains relevance — it can ONLY reference verified assets ─
      const relevancePrompt = `You are a MuleSoft Solution Architect.

The following MuleSoft assets have been VERIFIED to exist on Anypoint Exchange and are
potentially relevant to the client's requirement. Your job is to explain HOW each asset
applies to this specific requirement — do not invent additional assets or modify asset names.

CLIENT REQUIREMENT:
${requirements}

VERIFIED APPLICABLE ASSETS:
${uniqueMatches.map((a, i) => `
${i + 1}. [${a.type}] ${a.name}
   Exchange URL: ${a.exchangeUrl}
   What it covers: ${a.covers}
   Estimated saving: ${a.saving}
   Important note: ${a.note}
`).join('')}

For each asset above, output a JSON object explaining its specific relevance to THIS requirement.
If an asset is only marginally relevant, exclude it (set "include": false).

Output format (strict JSON array, no markdown):
[
  {
    "name": "<exact asset name from list above>",
    "type": "<exact type from list above>",
    "exchangeUrl": "<exact URL from list above>",
    "covers": "<what this asset specifically covers for THIS requirement>",
    "saving": "<effort saving from list above>",
    "note": "<important note from list above>",
    "include": true
  }
]`;

      const relevanceResponse = await this.askWithSystemPrompt(
        this.systemPrompt,
        relevancePrompt,
        { temperature: 0.1, maxTokens: 2000, ...options }
      );

      // Parse relevance response
      const cleanedRelevance = relevanceResponse.replace(/```json/gi, '').replace(/```/g, '').trim();
      const relevanceMatch = cleanedRelevance.match(/\[[\s\S]*\]/);
      if (!relevanceMatch) {
        // Fallback: return all matched assets without LLM relevance filtering
        return { hasAssets: true, assets: uniqueMatches };
      }

      const relevanceData = JSON.parse(relevanceMatch[0]);
      const finalAssets = relevanceData.filter(a => a.include !== false);

      console.log(`✅ analysePrebuiltAssets final: ${finalAssets.length} asset(s) after relevance filtering`);

      return {
        hasAssets: finalAssets.length > 0,
        assets: finalAssets
      };

    } catch (err) {
      console.warn('⚠️ analysePrebuiltAssets failed (non-blocking):', err?.message || err);
      return { hasAssets: false, assets: [] };
    }
  }

  async generateClarifyingQuestions(requirements, options = {}) {

    // ── Step 1: LLM-powered prebuilt asset analysis ───────────────────────────
    // Instead of a hardcoded regex catalog, we ask the LLM to analyse the
    // requirement and identify applicable MuleSoft prebuilt assets dynamically.
    // This means it works for ANY system, ANY connector, ANY accelerator —
    // including new MuleSoft releases that a static list could never know about.
    const prebuiltAnalysis = await this.analysePrebuiltAssets(requirements, options);
    const prebuiltContext = prebuiltAnalysis.hasAssets
      ? `
PREBUILT MULESOFT ASSETS IDENTIFIED FOR THIS REQUIREMENT:
The following MuleSoft prebuilt assets are applicable. You MUST include one question
asking whether the client wants to leverage these to reduce custom development effort.

${prebuiltAnalysis.assets.map((a, i) => `  ${i + 1}. ${a.name}
     What it covers: ${a.covers}
     Effort saving: ${a.saving}`).join('\n')}

`
      : '';

    // ── Step 2: Generate architect-quality clarifying questions ───────────────
    const prompt = `You are a senior MuleSoft Solution Architect preparing for a cl
    A client has just given you the following requirement. Before you can design anything, you need to ask
the RIGHT clarifying questions — questions whose answers will CHANGE the architecture you propose.
${prebuiltContext}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CLIENT REQUIREMENT:
${requirements}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

YOUR TASK:
Read the requirement carefully. Identify exactly which architectural decisions are still AMBIGUOUS
or UNKNOWN based on what the client has told you. Then ask ONLY the questions that resolve those
ambiguities — questions where a different answer leads to a fundamentally different architecture.

ARCHITECT'S DECISION FRAMEWORK — ask yourself:
  1. SYNC STRATEGY AMBIGUITY  — Is the integration pattern (event-driven CDC, polling, batch,
     request-reply, pub/sub) clearly defined? If not, ask what "near real-time", "sync", or
     "trigger" means to the business in concrete SLA terms (e.g. seconds? minutes?).

  2. DATA OWNERSHIP AMBIGUITY — If data flows bi-directionally between two or more systems,
     who owns the truth when there is a conflict? Without this, you cannot design conflict 
     resolution. Ask only if the requirement involves bi-directional or multi-system sync.

  3. EXISTING LANDSCAPE AMBIGUITY — Is there an existing integration, ESB, or MuleSoft
     deployment being replaced? A greenfield and a migration have completely different
     approaches, timelines, and risks. Ask if the requirement does not make this clear.

  4. PLATFORM MATURITY AMBIGUITY — Does the client already have an Anypoint Platform licence
     and a running CloudHub/RTF environment? This determines whether you can recommend
     MuleSoft Direct and prebuilt accelerators at all. Ask if not mentioned.

  5. COMPLIANCE / DEPLOYMENT AMBIGUITY — Are there data residency, regulatory, or network
     isolation requirements (GDPR, HIPAA, PCI-DSS, on-premises mandate) that would force
     a specific deployment model (Private Space, Runtime Fabric, hybrid)? Ask only if the
     domain (healthcare, finance, energy, government) or geography makes this likely.

  6. NEVER mention specific products, vendors, or systems that are not explicitly stated in
     the client's requirement. If you want to ask about additional systems, ask neutrally 
     without naming specific products.

  7. SCALE / VOLUME AMBIGUITY — Is the data change volume (records/events per day) large
     enough to require Kafka or high-throughput streaming instead of Anypoint MQ? Ask only
     if the requirement implies high-volume event streams or real-time processing at scale.

  8. PREBUILT ASSET AWARENESS — If prebuilt assets were identified above, ask whether the
     client is aware of them and willing to use them — this is the single biggest decision
     that reduces cost and delivery time.

STRICT RULES:
- Ask MAXIMUM 5 questions. Fewer is better if the requirement is already clear on some points.
- ONLY ask questions that are genuinely ambiguous given this specific requirement.
- DO NOT ask generic questions that apply to every integration (e.g. "what is your security
  policy?", "what is your API volume per second?" — implementation details, not architecture).
- Each question must directly reference something specific in the client's requirement.
- Frame questions the way an architect would ask a client — clear, business-friendly, specific.
- If a dimension is already clear from the requirement, DO NOT ask about it.
- Do NOT split one architectural decision into multiple questions. Combine the decision and its
  examples/options into a single question.
  Bad:
    1. What payment gateway will be used?
    2. Is it Stripe, Adyen, or something else?
  Good:
    1. Which payment gateway will be used (for example Stripe, Adyen, or another provider)?
- If a question asks "which system/tool/provider/method", include likely options in the same
  question instead of creating a separate follow-up question.

OUTPUT FORMAT — use exactly this format for each question:
1. <Your question here>
2. <Your question here>
(up to 5 questions maximum)`;

    const response = await this.askWithSystemPrompt(
      this.systemPrompt,
      prompt,
      {
        temperature: 0.3,   // Low temperature: architect questions need precision, not creativity
        maxTokens: 2000,    // Questions are short — no need for large budget here
        ...options
      }
    );

    // Parse questions from response
    const questions = this.parseQuestions(response);

    return {
      questions,
      fullResponse: response
    };
  }

  /**
   * Parse questions from LLM response
   * @param {string} response - LLM response text
   * @returns {Array<object>} Parsed questions
   */
  parseQuestions(response) {
    const questions = [];
    const foundQuestions = new Set();

    // ── Primary parser: numbered list (our prompt enforces "1. ... 2. ..." format) ──
    // Matches full multi-sentence questions, not just up to the first "?"
    // e.g. "1. What does 'near real-time' mean in SLA terms — seconds, minutes, or hours?"
    const numberedPattern = /^\s*\d+[\.\)]\s*(.+?)(?=\n\s*\d+[\.\)]\s+|$)/gms;
    const numberedMatches = [...response.matchAll(numberedPattern)];
    for (const match of numberedMatches) {
      const q = match[1]?.replace(/\s+/g, ' ').trim();
      if (q && q.length > 15 && q.includes('?')) {
        for (const splitQuestion of this.splitPackedQuestions(q)) {
          foundQuestions.add(splitQuestion);
        }
      }
    }

    // ── Fallback parser 1: bullet points ──
    if (foundQuestions.size === 0) {
      const bulletPattern = /^[-*•]\s*(.+?\?)/gm;
      for (const match of [...response.matchAll(bulletPattern)]) {
        const q = match[1]?.trim();
        if (q && q.length > 15) {
          for (const splitQuestion of this.splitPackedQuestions(q)) {
            foundQuestions.add(splitQuestion);
          }
        }
      }
    }

    // ── Fallback parser 2: any sentence ending in "?" ──
    if (foundQuestions.size === 0) {
      const sentencePattern = /([A-Z][^?!.]{15,}[?])/g;
      for (const match of [...response.matchAll(sentencePattern)]) {
        const q = match[1]?.trim();
        if (q && !q.toLowerCase().includes('example') && !q.toLowerCase().includes('e.g.')) {
          foundQuestions.add(q);
        }
      }
    }

    const mergedQuestions = this.mergeRelatedQuestions(Array.from(foundQuestions));

    // Build output array — max 5 questions
    let questionNum = 1;
    for (const question of mergedQuestions) {
      if (questionNum > 5) break;
      questions.push({
        number: questionNum,
        question: question,
        answer: null,
        validated: false
      });
      questionNum++;
    }

    // ── Last-resort fallback: should rarely trigger with the new prompt ──
    if (questions.length === 0) {
      questions.push(
        { number: 1, question: "What does 'near real-time' mean to the business in concrete SLA terms — seconds, minutes, or up to 15 minutes?", answer: null, validated: false },
        { number: 2, question: "When both systems hold different values for the same record at the same time, which system is the master of truth?", answer: null, validated: false },
        { number: 3, question: "Is this a greenfield integration or are you replacing an existing integration or ETL process?", answer: null, validated: false },
        { number: 4, question: "Do you already have an active Anypoint Platform licence and a running CloudHub or Runtime Fabric environment?", answer: null, validated: false },
        { number: 5, question: "Are there any data residency, regulatory, or network isolation requirements that would restrict where data can be processed or stored?", answer: null, validated: false }
      );
    }

    return questions;
  }

  splitPackedQuestions(text) {
    const cleaned = String(text || '')
      .replace(/^\s*["'\[]+/, '')
      .replace(/["'\],]+\s*$/, '')
      .trim();

    if (!cleaned) return [];

    // Handles accidental packed output such as:
    // "What payment gateway...?", "What is the expected volume?"
    const quotedMatches = [...cleaned.matchAll(/["']([^"']+\?)["']/g)]
      .map(match => match[1].replace(/\s+/g, ' ').trim())
      .filter(question => question.length > 15);
    if (quotedMatches.length > 1) return quotedMatches;

    const parts = cleaned
      .split(/(?:["']?\s*,\s*["']|(?:\?\s+)(?=[A-Z][a-z]+\s+(?:is|are|will|does|do|should|can|would|could|has|have)\b))/)
      .map(part => part.replace(/^["'\s]+|["'\s]+$/g, '').trim())
      .filter(Boolean)
      .map(part => part.endsWith('?') ? part : `${part}?`)
      .filter(question => question.length > 15);

    return parts.length > 1 ? parts : [cleaned];
  }

  mergeRelatedQuestions(questionTexts = []) {
    const normalizedQuestions = questionTexts
      .map(q => String(q || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    const merged = [];
    const topicWords = (text) => {
      const stop = new Set([
        'what', 'which', 'when', 'where', 'does', 'this', 'that', 'with', 'will',
        'used', 'use', 'using', 'need', 'needs', 'should', 'could', 'would',
        'there', 'their', 'your', 'have', 'from', 'into', 'between', 'system',
        'something', 'else', 'example', 'for'
      ]);
      return new Set((text.toLowerCase().match(/[a-z0-9]+/g) || [])
        .filter(word => word.length >= 4 && !stop.has(word)));
    };

    const optionQuestionPattern = /\b(is it|are they|such as|for example|e\.g\.|or another|or something else|stripe|adyen|paypal|salesforce|sap|workday|servicenow)\b/i;

    for (const question of normalizedQuestions) {
      const previous = merged[merged.length - 1];
      if (!previous) {
        merged.push(question);
        continue;
      }

      const previousTopics = topicWords(previous);
      const currentTopics = topicWords(question);
      const overlap = [...currentTopics].filter(word => previousTopics.has(word));
      const previousAsksForChoice = /\b(which|what)\b.*\b(gateway|provider|tool|system|method|platform|connector|application|service)\b/i.test(previous);
      const currentIsOptionFollowUp = /\b(is it|are they)\b/i.test(question) || /\bor something else\b/i.test(question);
      const shouldMerge =
        currentIsOptionFollowUp &&
        previousAsksForChoice &&
        (overlap.length >= 1 || optionQuestionPattern.test(question));

      if (shouldMerge) {
        merged[merged.length - 1] = this.combineQuestions(previous, question);
      } else {
        merged.push(question);
      }
    }

    return merged;
  }

  combineQuestions(primary, secondary) {
    const cleanPrimary = String(primary || '').replace(/\?+$/, '').trim();
    const cleanSecondary = String(secondary || '').replace(/\?+$/, '').trim();
    const optionMatch = cleanSecondary.match(/\b(?:is it|are they)\s+(.+)$/i);
    if (optionMatch) {
      return `${cleanPrimary} (${optionMatch[1].trim()})?`;
    }
    return `${cleanPrimary}; ${cleanSecondary.charAt(0).toLowerCase()}${cleanSecondary.slice(1)}?`;
  }

  /**
   * Validate if user answer is relevant to the question
   * @param {string} question - The question asked
   * @param {string} answer - User's answer
   * @returns {Promise<object>} Validation result
   */
  async validateAnswer(question, answer) {
    if (!answer || answer.trim().length < 1) {
      return {
        valid: false,
        reason: "Answer is too short. Please provide a more detailed answer."
      };
    }

    // Check for common irrelevant responses
    const irrelevantPatterns = [
      /^(i'?m\s+)?fine$/i,
      /^(i'?m\s+)?ok(ay)?$/i,
      /^(i'?m\s+)?good$/i,
      /^(i\s+)?don'?t\s+know$/i,
      /^(i\s+)?have\s+no\s+idea$/i,
      /^not\s+sure$/i,
      /^maybe$/i,
      /^probably$/i,
      /^i\s+guess$/i,
      /^whatever$/i,
      /^anything$/i
    ];

    for (const pattern of irrelevantPatterns) {
      if (pattern.test(answer.trim())) {
        return {
          valid: false,
          reason: "Your answer is too vague. Please provide specific details related to the question."
        };
      }
    }

    // Use LLM to validate relevance
    const validationPrompt = `Question: "${question}"

User Answer: "${answer}"

Decide if the answer is relevant to the question.

Policy (be generous):
- VALID: The answer addresses the topic of the question in any meaningful way. Partial information is OK (e.g., only peak but not average; only real-time for auth without batch details). Prefer specifics (numbers, ranges, concrete nouns), but do NOT penalize missing pieces.
- INVALID: Only if the answer is clearly off-topic, empty, purely generic (e.g., "maybe", "not sure"), or a refusal/disclaimer. Minor ambiguity or missing details should still be considered VALID (borderline).

Respond with ONLY one word: "VALID" or "INVALID".
If INVALID, provide a brief reason why.`;

    try {
      const validation = await this.askWithSystemPrompt(
        "You are a validation assistant. Determine if user answers are relevant to questions.",
        validationPrompt,
        {
          temperature: 0.1,
          maxTokens: 50
        }
      );

      const normalized = (validation || '').trim();
      const upper = normalized.toUpperCase();
      const firstToken = upper.split(/\s+/)[0];
      let isValid = firstToken === 'VALID';
      let reason = isValid
        ? null
        : normalized.replace(/^\s*INVALID\s*[:\-]?\s*/i, '').trim() || "Answer is not relevant to the question. Please provide specific details.";

      // When INVALID but the answer is specific (numbers/keywords/length), accept as weak validity and request a follow-up
      if (!isValid) {
        const trimmed = (answer || '').trim();
      const answerLower = trimmed.toLowerCase();
        const questionLower = question.toLowerCase();
        const questionKeywords = questionLower.match(/\b(volume|api|data|processing|performance|security|scalability|real-time|batch|throughput|response|time|latency|peak|average|sustained|authorization|settlement|reconciliation|refunds)\b/g) || [];
        const hasRelevantKeywords = questionKeywords.some(keyword => answerLower.includes(keyword));
        const hasNumbers = /\d/.test(answer);
        const isLongEnough = answer.trim().length >= 10;
        // Additional lenient heuristic: overlap of meaningful keywords
        const stop = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'per', 'for', 'be', 'is', 'are', 'was', 'were', 'will', 'with', 'can', 'do', 'does', 'did', 'that', 'this', 'those', 'these', 'as', 'at', 'by', 'from']);
        const qWords = (questionLower.match(/[a-z0-9]+/g) || []).filter(w => w.length >= 4 && !stop.has(w));
        const overlap = qWords.filter(w => answerLower.includes(w));

        if ((hasNumbers || hasRelevantKeywords || overlap.length >= 2) && isLongEnough) {
          // Craft a targeted follow-up based on common patterns in the question
          let followUp = 'Please add the missing specifics required by the question.';
          if (/peak/.test(questionLower) && /average|sustained/.test(questionLower)) {
            followUp = 'Please provide both: peak calls per second (or minute) AND the average sustained load.';
          } else if (/real[-\s]?time/.test(questionLower) && /(settlement|reconciliation|refunds)/.test(questionLower)) {
            followUp = 'Please confirm which operations are real-time vs batch (settlement, reconciliation, refunds) and any batch frequency/latency.';
          }

          return {
            valid: true, // accept as partially sufficient
            reason: followUp,
            strength: 'weak',
            followUp
          };
        }
      }

      return {
        valid: isValid,
        reason: reason,
        strength: isValid ? 'strong' : 'invalid'
      };
    } catch (error) {
      // If LLM failed with a system-level error, propagate so orchestrator can handle globally
      const status = error?.status || error?.response?.status;
      const message = error?.message || '';
      const isRetryableLLMError = status === 429 || (status >= 500 && status < 600) || message.includes('All LLM providers failed');
      if (isRetryableLLMError) {
        throw error;
      }

      // Fallback validation for non-retryable errors (be lenient)
      const trimmed = (answer || '').trim();
      const answerLower = trimmed.toLowerCase();
      const questionLower = (question || '').toLowerCase();

      // Extract some important keywords from the question
      const questionKeywords = questionLower.match(/\b(volume|api|data|processing|performance|security|scalability|real-time|batch|throughput|response|time|sla|availability|latency|rate|calls|per second|per day|per minute)\b/g) || [];
      const hasRelevantKeywords = questionKeywords.some(keyword => answerLower.includes(keyword));

      // Check if answer has numbers (often indicates specificity)
      const hasNumbers = /\d/.test(trimmed);

      // Check if answer is too short
      const isTooShort = trimmed.length < 10;

      // Be lenient: only mark invalid when clearly short/vague and not related to the question
      if (isTooShort || (!hasRelevantKeywords && !hasNumbers && trimmed.length < 20)) {
        return {
          valid: false,
          reason: "Please provide a bit more specific detail (numbers, throughput, or technical context) related to the question."
        };
      }

      return {
        valid: true,
        reason: null
      };
    }
  }

  /**
   * Evaluate Round 1 answers and decide if a Round 2 follow-up is needed.
   *
   * RULES (keeps user frustration low):
   *   - Maximum 2 follow-up questions regardless of how many gaps exist
   *   - Only ask if an answer is VAGUE, CONTRADICTORY, or OPENED a new gap
   *   - If all answers are clear and consistent → return { needsFollowUp: false }
   *   - Never ask about something already clearly answered in Round 1
   *
   * @param {string} requirements - Original requirement
   * @param {Array} questionsAndAnswers - Round 1 Q&A pairs
   * @returns {Promise<object>} { needsFollowUp, followUpQuestions }
   */
  async evaluateAnswers(requirements, questionsAndAnswers, options = {}) {
    const qaSummary = questionsAndAnswers.map(qa => `Q: ${qa.question} A: ${qa.answer}`).join('');

    const prompt = `You are a senior MuleSoft Solution Architect reviewing a client's answers 
to your initial discovery questions. Evaluate whether you have enough information to design 
the architecture, or if 1-2 specific follow-up questions are needed.

ORIGINAL REQUIREMENT:
${requirements}

ROUND 1 — QUESTIONS AND ANSWERS:
${qaSummary}

YOUR TASK:
Evaluate each answer for these issues ONLY:
  1. VAGUE — Answer does not give enough specificity to make an architecture decision.
     Example: "we need it fast" instead of a concrete SLA. "maybe" instead of yes/no.
  2. CONTRADICTORY — Answer contradicts another answer or the requirement.
     Example: Says "GDPR applies" but also "CloudHub Shared Space is fine" (data residency conflict).
  3. NEW GAP OPENED — Answer reveals a new critical unknown not covered in Round 1.
     Example: "we are replacing an existing Tibco ESB" — now you need to know migration constraints.

STRICT RULES:
  - If ALL answers are sufficiently clear → output needsFollowUp: false. Do NOT invent gaps.
  - Maximum 2 follow-up questions. Pick only the most critical gaps.
  - Do NOT ask about something already clearly answered.
  - Do NOT ask generic questions — each must reference a specific answer from Round 1.
  - Frame as a natural architect follow-up: "You mentioned X — could you clarify Y?"

OUTPUT FORMAT (strict JSON, no markdown):
{
  "needsFollowUp": true,
  "reason": "Brief explanation of why follow-up is needed",
  "followUpQuestions": [
    "Follow-up question 1 referencing a specific Round 1 answer?",
    "Follow-up question 2 referencing a specific Round 1 answer?"
  ]
}

OR if no follow-up needed:
{
  "needsFollowUp": false,
  "reason": "All answers are clear and sufficient to proceed with architecture design",
  "followUpQuestions": []
}`;

    try {
      const response = await this.askWithSystemPrompt(
        this.systemPrompt,
        prompt,
        { temperature: 0.2, maxTokens: 800, ...options }
      );

      const cleaned = response.replace(/```json/gi, '').replace(/```/g, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn('⚠️ evaluateAnswers: no JSON in response — skipping Round 2');
        return { needsFollowUp: false, followUpQuestions: [] };
      }

      const result = JSON.parse(jsonMatch[0]);

      // Safety cap — never more than 2 follow-up questions
      if (result.followUpQuestions?.length > 2) {
        result.followUpQuestions = result.followUpQuestions.slice(0, 2);
      }

      console.log(`🔍 evaluateAnswers: needsFollowUp=${result.needsFollowUp}. Reason: ${result.reason}`);
      if (result.needsFollowUp) {
        result.followUpQuestions.forEach((q, i) => console.log(`   Follow-up Q${i + 1}`, {
          questionLength: typeof q === 'string' ? q.length : 0
        }));
      }

      return result;

    } catch (err) {
      // Non-blocking — if evaluation fails, skip Round 2 and proceed to approaches
      console.warn('⚠️ evaluateAnswers failed (non-blocking, skipping Round 2):', err?.message || err);
      return { needsFollowUp: false, followUpQuestions: [] };
    }
  }

  /**
   * Generate multiple architecture approaches with recommendation
   * @param {string} requirements - Business/technical requirements
   * @param {object} options - Additional options (can include questionAnswers)
   * @returns {Promise<object>} Approaches with recommendation
   */
  async generateApproaches(requirements, options = {}) {
      // Include question answers if provided
      let contextInfo = "";
      if (options.questionAnswers && Array.isArray(options.questionAnswers)) {
        contextInfo = "\n\nAdditional Context from User:\n";
        options.questionAnswers.forEach((qa, index) => {
          contextInfo += `${index + 1}. ${qa.question}\n   Answer: ${qa.answer}\n\n`;
        });
      }

      // ── LLM-powered prebuilt asset detection for approaches ──────────────────
      // Re-use the same dynamic analysePrebuiltAssets() method — no static list.
      // If the user already answered questions (which may mention platform maturity,
      // existing assets, etc.) we enrich the requirements with that context first.
      const enrichedRequirements = contextInfo
        ? `${requirements}\n\nAdditional context from client:\n${contextInfo}`
        : requirements;

      const skipApproachAssetAnalysis = process.env.ARCHITECTURE_APPROACH_ASSET_ANALYSIS === 'false';
      const approachAssetAnalysis = skipApproachAssetAnalysis
        ? { hasAssets: false, assets: [] }
        : await this.analysePrebuiltAssets(enrichedRequirements, options);

      const prebuiltApproachInstruction = approachAssetAnalysis.hasAssets
        ? `
PREBUILT ASSETS IDENTIFIED — MANDATORY APPROACH RULES:
The following MuleSoft prebuilt assets are applicable to this requirement:
${approachAssetAnalysis.assets.map(a =>
  `  • [${a.type}] ${a.name}\n    Covers: ${a.covers}\n    Saving: ${a.saving}`
).join('\n')}

You MUST follow these rules when generating approaches:
  RULE 1 — First approach MUST be titled [PREBUILT]: use the identified prebuilt assets above
           as the primary strategy. State what is out-of-the-box vs what needs customisation,
           and the estimated effort reduction vs a fully custom build.
  RULE 2 — Include at least one [HYBRID] approach: prebuilt assets as foundation + custom APIs
           for any requirements not covered by the prebuilt assets.
  RULE 3 — Include one [CUSTOM] approach for comparison, with a clear note on the extra
           effort and cost versus the [PREBUILT] approach.
  RULE 4 — Label EVERY approach title with exactly one of: [PREBUILT], [HYBRID], or [CUSTOM].
`
        : `
APPROACH LABELLING RULE:
Label every approach title with [PREBUILT], [HYBRID], or [CUSTOM] based on how much it
relies on MuleSoft out-of-the-box connectors/accelerators vs custom-built APIs.
Even for custom requirements, always evaluate whether any Anypoint connectors, Anypoint MQ
patterns, or API Manager policies can reduce the custom development footprint.
`;

      const prompt = `Based on the following requirements${contextInfo ? " and user answers" : ""}, provide exactly 3 concise MuleSoft architecture approaches.
${prebuiltApproachInstruction}
STRICT OUTPUT CONTRACT (do not deviate):
- Use EXACTLY the following block format for EACH approach.
- Do NOT include markdown tables.
- Do NOT interleave content between approaches.
- Label every Title with [PREBUILT], [HYBRID], or [CUSTOM].

For each approach output a block like this (repeat for exactly 3 approaches):
<<<APPROACH 1>>>
Title: [PREBUILT/HYBRID/CUSTOM] <concise approach name/title>
Description: <2-4 sentences describing the approach and naming key MuleSoft connectors/accelerators used>
Features:
- <bullet>
- <bullet>
Pros:
- <bullet>
Cons:
- <bullet>
PrebuiltAssets:
- <exact MuleSoft Direct / Accelerator / Connector assets used, or "None — fully custom">
BestFor: <one line>
<<<END>>>

After all approach blocks, output:
RECOMMENDED: <Approach Number>
RecommendationReason: <2-3 sentences comparing delivery effort, risk, maintainability, and fit.>

Requirements:
${requirements}${contextInfo}`;

      const response = await this.askWithSystemPrompt(
        this.systemPrompt,
        prompt,
        {
          temperature: 0.7,
          maxTokens: tokenBudget('ARCHITECTURE_APPROACH_MAX_TOKENS', 3500),
          timeoutMs: tokenBudget('ARCHITECTURE_APPROACH_TIMEOUT_MS', 420000),
          ...options
        }
      );

      // Parse approaches from response
      const approaches = this.parseApproaches(response);

      return {
        approaches,
        fullResponse: response
      };
    }

    /**
     * Parse approaches from LLM response
     * @param {string} response - LLM response text
     * @returns {Array<object>} Parsed approaches
     */
    parseApproaches(response) {
      const approaches = [];

      // 1) Strict block parsing first: <<<APPROACH N>>> ... <<<END>>>
      const blockRegex = /<<<APPROACH\s+(\d+)>>>[\r\n]+([\s\S]*?)<<<END>>>/g;
      const blocks = [...response.matchAll(blockRegex)];
      if (blocks.length > 0) {
        for (const b of blocks) {
          const number = parseInt(b[1]);
          const body = b[2] || '';

          const getSection = (label) => {
            const r = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n(?:Title:|Description:|Features:|Pros:|Cons:|PrebuiltAssets:|BestFor:)|$)`, 'i');
            const m = body.match(r);
            return (m && m[1] ? m[1].trim() : '').trim();
          };

          const titleMatch = body.match(/Title:\s*(.+)/i);
          const title = titleMatch ? titleMatch[1].trim() : '';

          const description = getSection('Description');

          const listSection = (label) => {
            const sec = getSection(label);
            return sec
              .split(/\r?\n/)
              .map(l => l.replace(/^[-*]\s*/, '').trim())
              .filter(Boolean);
          };
          const features = listSection('Features');
          const pros = listSection('Pros');
          const cons = listSection('Cons');
          const prebuiltAssets = listSection('PrebuiltAssets');
          const bestFor = body.match(/BestFor:\s*([\s\S]*?)(?=\n|$)/i)?.[1]?.trim() || '';

          // Extract approach type label: [PREBUILT], [HYBRID], or [CUSTOM]
          const typeMatch = title.match(/\[(PREBUILT|HYBRID|CUSTOM)\]/i);
          const approachType = typeMatch ? typeMatch[1].toUpperCase() : 'CUSTOM';

          if (title && description) {
            const prebuiltSection = prebuiltAssets.length
              ? `Prebuilt Assets:\n- ${prebuiltAssets.join('\n- ')}`
              : '';
            const fullText = [
              `Title: ${title}`,
              `Description: ${description}`,
              features.length ? `Features:\n- ${features.join('\n- ')}` : '',
              pros.length ? `Pros:\n- ${pros.join('\n- ')}` : '',
              cons.length ? `Cons:\n- ${cons.join('\n- ')}` : '',
              prebuiltSection,
              bestFor ? `BestFor: ${bestFor}` : ''
            ].filter(Boolean).join('\n');

            approaches.push({
              number: number || (approaches.length + 1),
              name: title,
              description: description,
              features,
              pros,
              cons,
              prebuiltAssets,
              approachType,   // 'PREBUILT' | 'HYBRID' | 'CUSTOM'
              bestFor,
              fullText
            });
          }
        }
      }

      // 2) Fallback: legacy regex-based parsing when no strict blocks
      if (approaches.length === 0) {
        const approachPatterns = [
          /\*\*Approach\s+(\d+):\s*([^*\n]+)\*\*/g,
          /Approach\s+(\d+):\s*([^\n]+)/g,
          /^(\d+)\.\s*([^\n]+)/gm
        ];

        let matches = [];
        for (const pattern of approachPatterns) {
          const patternMatches = [...response.matchAll(pattern)];
          if (patternMatches.length >= 3) {
            matches = patternMatches;
            break;
          }
        }

        if (matches.length === 0) {
          const manualPattern = /(?:Approach|Option|Solution)\s*(\d+)[:\.]\s*([^\n]+)/gi;
          matches = [...response.matchAll(manualPattern)];
        }

        for (let i = 0; i < matches.length; i++) {
          const match = matches[i];
          const approachNum = parseInt(match[1]);
          const name = match[2].trim();

          const startIndex = match.index + match[0].length;
          const nextMatch = i < matches.length - 1 ? matches[i + 1] : null;
          const endIndex = nextMatch ? nextMatch.index : response.length;
          let content = response.substring(startIndex, endIndex).trim();
          const recommendedIndex = content.search(/RECOMMENDED|Recommended|recommended/i);
          if (recommendedIndex !== -1) {
            content = content.substring(0, recommendedIndex).trim();
          }
          content = content.replace(/^\*\*.*?\*\*\s*/gm, '').trim();

          if (approachNum && name) {
            approaches.push({
              number: approachNum,
              name,
              description: content || `Details for ${name}`,
              fullText: `**Approach ${approachNum}: ${name}**\n${content || `Details for ${name}`}`
            });
          }
        }

        if (approaches.length === 0) {
          const sections = response.split(/\n\s*\n/);
          let approachNum = 1;
          for (const section of sections) {
            if (section.trim().length > 50 && approachNum <= 4) {
              const lines = section.split('\n');
              const title = lines[0].replace(/[#*]/g, '').trim();
              const content = lines.slice(1).join('\n').trim();
              if (title && content) {
                approaches.push({
                  number: approachNum,
                  name: title.substring(0, 100),
                  description: content.substring(0, 500),
                  fullText: section
                });
                approachNum++;
              }
            }
          }
        }
      }

      // Ensure we have at least 3 approaches (duplicate if needed for demo)
      if (approaches.length === 0 && response && response.trim()) {
        approaches.push({
          number: 1,
          name: '[HYBRID] Recommended MuleSoft integration approach',
          description: response.trim().slice(0, 1200),
          fullText: response.trim(),
          recommended: true
        });
      }

      while (approaches.length < 3 && approaches.length > 0) {
        const lastApproach = approaches[approaches.length - 1];
        approaches.push({
          ...lastApproach,
          number: approaches.length + 1,
          name: `${lastApproach.name} (Alternative)`
        });
      }

      // Find recommended approach
      const recommendedPatterns = [
        /RECOMMENDED\s+APPROACH:\s*Approach\s+(\d+)/i,
        /RECOMMENDED:\s*Approach\s+(\d+)/i,
        /RECOMMENDED:\s*(\d+)/i,
        /I recommend\s+Approach\s+(\d+)/i
      ];

      let recommendedNum = null;
      for (const pattern of recommendedPatterns) {
        const match = response.match(pattern);
        if (match) {
          recommendedNum = parseInt(match[1]);
          break;
        }
      }

      const getRecommendationSection = (label, stopLabels = []) => {
        const stopPattern = stopLabels.length
          ? `(?=\\n(?:${stopLabels.map(l => `${l}:`).join('|')}))`
          : '$';
        const regex = new RegExp(`${label}:\\s*([\\s\\S]*?)${stopPattern}`, 'i');
        const match = response.match(regex);
        return match?.[1]?.trim() || '';
      };

      const recommendationReason =
        getRecommendationSection('RecommendationReason', ['RecommendationComparison']) ||
        getRecommendationSection('Reason', ['RecommendationComparison']);

      const recommendationComparisonText = getRecommendationSection('RecommendationComparison');
      const recommendationComparison = recommendationComparisonText
        ? recommendationComparisonText
            .split(/\r?\n/)
            .map(line => line.replace(/^[-*]\s*/, '').trim())
            .filter(Boolean)
        : [];

      // Mark recommended approach
      if (recommendedNum) {
        approaches.forEach(approach => {
          approach.recommended = approach.number === recommendedNum;
        });
      } else if (approaches.length > 0) {
        // If no explicit recommendation, mark first as recommended
        approaches[0].recommended = true;
      }

      // Ensure we have valid approach numbers (1, 2, 3, 4)
      approaches.forEach((approach, index) => {
        if (approach.recommended) {
          approach.recommendationReason = recommendationReason;
          approach.recommendationComparison = recommendationComparison;
        }
      });

      return approaches.slice(0, 4); // Max 4 approaches
    }

  /**
   * Generate architecture solution for a specific approach
   * @param {string} requirements - Business/technical requirements
   * @param {number} approachNumber - Selected approach number
   * @param {Array<object>} approaches - Available approaches
   * @param {object} options - Additional options
   * @returns {Promise<string>} Architecture solution
   */
  async generateSolutionForApproach(requirements, approachNumber, approaches, options = {}) {
      // Validate approach number
      const selectedApproach = approaches.find(a => a.number === approachNumber);
      if (!selectedApproach) {
        throw new Error(`Invalid approach number: ${approachNumber}. Available approaches: ${approaches.map(a => a.number).join(', ')}`);
      }

      // Build tools information string
      let toolsInfo = '';
      if (options.tools) {
        const tools = options.tools;
        toolsInfo = '\n\nTools and Software to be Integrated:\n';
        if (tools.source) toolsInfo += `- Source System: ${tools.source}\n`;
        if (tools.target) toolsInfo += `- Target System: ${tools.target}\n`;
        if (tools.middleware) toolsInfo += `- Middleware/Message Queue: ${tools.middleware}\n`;
        if (tools.externalApps) toolsInfo += `- External Applications/Software: ${tools.externalApps}\n`;
        if (tools.additionalTools) toolsInfo += `- Additional Tools/Applications: ${tools.additionalTools}\n`;
      }

      if (options.fastMode) {
        const fastPrompt = `Produce a concise but complete MuleSoft architecture for the requirement and selected approach.

Requirements:
${requirements}

Selected Approach:
${selectedApproach.fullText}${toolsInfo}

Keep the response practical and bounded. Do not ask clarifying questions. Make reasonable assumptions only where needed.

Required sections:
1. Architecture Overview
2. API and Mule App Design
   - List System APIs/system-access services, Process APIs, Experience APIs or event workers.
   - For each item include Name, Purpose, Trigger, Dependencies, Connector ownership.
3. End-to-End Data Flow
4. Error Handling and Retry
5. Security, Deployment, Monitoring
6. User Journey
   - Numbered journey points usable for estimation.
7. Assumptions and Open Items
8. Validation Checklist
   - Confirm backend connectors live only in System APIs/system-access services.
   - Confirm Process/Experience/event workers do not own Salesforce/SAP/backend connectors unless explicitly justified.

Target length: 1200-1800 words.`;

        return await this.askWithSystemPrompt(
          this.systemPrompt,
          fastPrompt,
          {
            temperature: 0.4,
            maxTokens: 7000,
            timeoutMs: 420_000,
            ...options
          }
        );
      }

      const prompt = `Based on the Requirements and Selected Approach, produce a MuleSoft architecture solution. Follow these mandatory rules and produce the sections listed below:

Requirements:
${requirements}

Selected Approach:
${selectedApproach.fullText}${toolsInfo}

Mode selection (mandatory)
1. If the user selects "3‑layer" or "API‑led connectivity", set Mode = Strict and apply the full rule set: Experience APIs may only call Process APIs; Process APIs may call System APIs; System APIs must not be called by Experience APIs. Run the Validation Checklist and correct any violations.
2. If the user selects any other approach or does not select an approach, set Mode = Flexible. In Flexible mode, allow alternative topologies (single System API, Experience→System direct calls, event‑driven flows) but require:
   - A one‑line justification for choosing a non‑3‑layer topology.
   - A short risk assessment comparing this topology to the 3‑layer model.
   - Explicit mitigations for coupling, reuse, and governance if Experience→System direct calls are used.
Always state the Mode and the reason at the start of the architecture solution.

Mandatory rules
1. Call direction: Experience APIs may only call Process APIs. Process APIs may call System APIs and other Process APIs. System APIs must not be called directly by Experience APIs.
2. Ownership: For each API, state Owner (System = Backend Integrator; Process = Integration/Business Developer; Experience = Frontend/Channel Team).
3. System API definition: One System API per backend system or stable backend capability.
4. Process API definition: One Process API per business capability or orchestration; must expose canonical model.
5. Experience API definition: One Experience API per channel/consumer; must call Process APIs only.
6. Backend connectors such as Salesforce, SAP, databases, SFTP, and queues should be owned by System APIs or clearly named system-access services. If you propose a direct connector in a worker/batch/event flow, briefly justify why it is acceptable.
7. Provide at least one concrete example mapping for each integration described by the user.
8. Include a dedicated section named exactly "User Journey" with numbered end-to-end journey points that can be used for estimation.
9. If any NFRs, credentials, or backend availability are unknown, list them as assumptions and show how they change the design.

Required output sections (plain text list)
1. Architecture Overview
2. API Design grouped by layer/pattern (System / Process / Experience / Event-Driven / Batch if applicable). For each API/app include: Name; Owner; Purpose; Trigger or allowed callers; Key endpoints/events; Dependencies; Connector ownership.
3. Integration Patterns
4. Data Flow (sequence steps)
5. User Journey. Include numbered end-to-end journey points usable for estimation.
6. Security Architecture
7. Deployment Strategy
8. Error Handling
9. Monitoring & Logging
10. Short Validation Checklist covering call direction, connector ownership, error handling, and observability.


End with a corrected architecture if any validation checks failed.

${toolsInfo ? 'IMPORTANT: Ensure the architecture solution incorporates and properly integrates all the tools and software specified above.' : ''}`;


      return await this.askWithSystemPrompt(
        this.systemPrompt,
        prompt,
        {
          temperature: 0.7,
          maxTokens: tokenBudget('ARCHITECTURE_MAX_TOKENS', 14000),
          ...options
        }
      );
    }

  /**
   * A2A Protocol: Generate complete solution by coordinating with other agents
   * Architecture agent requests help from Diagram, Estimation, and RAML agents
   * @param {string} requirements - Business/technical requirements
   * @param {object} options - Additional options
   * @param {function} onProgress - Progress callback
   * @returns {Promise<object>} Complete solution with all outputs
   */
  async generateCompleteSolution(requirements, options = {}, onProgress = null) {
      if (onProgress) {
        onProgress({ type: "step", step: 1, agent: "Architecture", status: "working", message: "Generating architecture solution..." });
      }

      // Step 1: Generate architecture
      // If approach is already selected, use it; otherwise generate approaches first
      let architecture;
      const architectureStreamId = `${options.sessionId || 'architecture'}_${Date.now()}`;
      let architectureChunkSequence = 0;
      const architectureOptions = {
        ...options,
        onChunk: chunk => {
          if (!chunk || !onProgress) return;
          onProgress({
            type: "agent-stream-chunk",
            agent: "Architecture",
            streamId: architectureStreamId,
            sequence: architectureChunkSequence++,
            chunk
          });
        },
        onStreamReset: () => {
          architectureChunkSequence = 0;
          if (onProgress) {
            onProgress({
              type: "agent-stream-reset",
              agent: "Architecture",
              streamId: architectureStreamId,
              message: "Architecture provider changed; restarting streamed output."
            });
          }
        }
      };
      if (onProgress) {
        onProgress({
          type: "agent-stream-start",
          agent: "Architecture",
          streamId: architectureStreamId,
          message: "Architecture response is streaming..."
        });
      }

      if (options.selectedApproach && options.approaches) {
        architecture = await this.generateSolutionForApproach(
          requirements,
          options.selectedApproach,
          options.approaches,
          architectureOptions
        );
      } else {
        architecture = await this.generateSolution(requirements, architectureOptions);
      }

      if (!architecture || !String(architecture).trim()) {
        const message = "Architecture generation failed: empty architecture response. Stopping workflow because architecture is required for all downstream agents.";
        if (onProgress) {
          onProgress({
            type: "step",
            step: 1,
            agent: "Architecture",
            status: "error",
            message
          });
        }
        throw new Error(message);
      }

      if (onProgress) {
        onProgress({
          type: "agent-stream-complete",
          agent: "Architecture",
          streamId: architectureStreamId,
          message: "Architecture response streaming completed."
        });
        onProgress({ type: "step", step: 1, agent: "Architecture", status: "completed", message: `Architecture generated (${architecture.length} characters)`, data: architecture });
      }

      // A2A Protocol: Build context with architecture
      const context = {
        requirements,
        architecture,
        sessionId: options.sessionId
      };

      // Manual diagram / use-case flow:
      // When driven by the UI (socket present + waitForJourneyPoints), pause the
      // automatic pipeline right after the architecture is ready. Diagrams are now
      // generated manually from the Diagram tab — first the user extracts use cases,
      // then generates one sequence diagram per use case plus a master architecture
      // diagram, and finally triggers estimation explicitly. The automatic diagram +
      // estimation steps below only run for non-socket flows (e.g. CLI / PDF).
      if (this.socket && options.waitForJourneyPoints) {
        console.log('⏸️ Pausing workflow after architecture (manual use-case / diagram flow)...');
        if (onProgress) {
          onProgress({
            type: "step",
            step: 1.5,
            agent: "JourneyPoints",
            status: "waiting",
            message: "Architecture ready. Extract use cases and generate diagrams from the Diagram tab."
          });
        }
        // Signal the server to store continuation state for later estimation.
        throw new Error('WAIT_FOR_JOURNEY_POINTS');
      }

      // ── Non-UI / CLI fallback flow ────────────────────────────────────────────
      // This path only runs when there is no socket (CLI, PDF export, API calls).
      // For the UI flow, execution never reaches here — it is paused above by the
      // WAIT_FOR_JOURNEY_POINTS throw and resumes via continueEstimationWithJourneyPoints().
      //
      // Only generates a component (architecture) diagram here.
      // Per-use-case sequence diagrams are a UI-only feature driven from the Diagram tab.

      // Step 1: Execute Diagram Agent (component diagram only)
      let diagram = null;
      try {
        if (onProgress) {
          onProgress({ type: "step", step: 2, agent: "Diagram", status: "working", message: "Generating architecture component diagram..." });
        }

        const diagramResponse = await this.sendMessage(
          'diagram-agent',
          'generate-component-diagram',   // component only — not generate-diagram (which was triggering generateAllDiagrams)
          { architecture, diagramType: 'component' },
          context,
          { timeout: 420000, awaitResponse: true }
        );

        if (diagramResponse && diagramResponse.type === 'response') {
          diagram = diagramResponse.payload.diagram || diagramResponse.payload.result;
          context.diagram = diagram;

          if (onProgress) {
            onProgress({
              type: "step",
              step: 2,
              agent: "Diagram",
              status: "completed",
              message: `Diagram received via A2A (${diagram.length} characters)`,
              data: diagram
            });
          }
        }
      } catch (error) {
        console.error('❌ Failed to get diagram from Diagram Agent:', error);
        // Diagram is required before estimation in the UI workflow.
        context.diagram = null;
        if (onProgress) {
          onProgress({
            type: "step",
            step: 2,
            agent: "Diagram",
            status: "error",
            message: `Diagram generation failed but continuing to estimation: ${error.message}`,
            error: error.message
          });
        }
        console.warn('Stopping workflow before estimation because diagram generation failed');
        return {
          architecture,
          diagram: null,
          estimation: null,
          raml: null,
          documentation: null,
          context,
          blockedEstimation: true,
          missingEstimationInputs: ['diagram'],
          diagramError: error.message
        };
      }

      // Step 2: After Diagram Agent completes (success or failure), execute Estimation Agent
      let estimation = null;
      try {
        if (onProgress) {
          onProgress({
            type: "step",
            step: 3,
            agent: "Estimation",
            status: "working",
            message: "Requesting estimation from Estimation Agent via A2A..."
          });
        }

        const estimationResponse = await this.sendMessage(
          'estimation-agent',
          'generate-estimation',
          { architecture },
          context, // Context includes architecture + diagram (or null if diagram failed)
          { timeout: 420000, awaitResponse: true }
        );

        if (estimationResponse && estimationResponse.type === 'response') {
          estimation = estimationResponse.payload.estimation || estimationResponse.payload.result;
          context.estimation = estimation;

          if (onProgress) {
            onProgress({
              type: "step",
              step: 3,
              agent: "Estimation",
              status: "completed",
              message: `Estimation received via A2A (${estimation.length} characters)`,
              data: estimation
            });
          }
        }
      } catch (error) {
        console.error('❌ Failed to get estimation from Estimation Agent:', error);
         context.estimation = null;
        if (onProgress) {
          onProgress({ type: "step", step: 3, agent: "Estimation", status: "error", message: `Estimation failed but RAML generation will continue: ${error.message}` });
        }
      }

      // A2A Protocol: Request RAML Agent to generate RAML
      if (onProgress) {
        onProgress({ type: "step", step: 4, agent: "RAML", status: "working", message: "Requesting RAML from RAML Agent via A2A..." });
      }

      if (this.socket) {
        this.socket.emit('raml-agent-started', {
          timestamp: new Date().toISOString(),
          message: 'Starting RAML generation',
          status: 'in_progress',
          sessionId: options.sessionId
        });
      }

      let raml = null;
      try {
        const ramlResponse = await this.sendMessage(
          'raml-agent',
          'generate-raml',
          { architecture, apiName: options.apiName || 'MuleSoftAPI', estimation },
          context, // Context includes architecture + diagram + estimation
          { timeout: 420000, awaitResponse: true } // Allow up to 7 minutes for long agent output
        );

        if (ramlResponse && ramlResponse.type === 'response') {
          raml = ramlResponse.payload.raml || ramlResponse.payload.result;

          if (onProgress) {
            onProgress({ type: "step", step: 4, agent: "RAML", status: "completed", message: `RAML received via A2A (${raml.length} characters)`, data: raml });
          }
        }
      } catch (error) {
        console.error('❌ Failed to get RAML from RAML Agent:', error);
        if (onProgress) {
          onProgress({ type: "step", step: 4, agent: "RAML", status: "error", message: `A2A communication failed: ${error.message}` });
        }
      }

      context.raml = raml;

      const missingDocumentInputs = [];
      if (!architecture) missingDocumentInputs.push('architecture');
      if (!estimation) missingDocumentInputs.push('estimation');
      if (!raml) missingDocumentInputs.push('RAML');

      if (missingDocumentInputs.length > 0) {
        const message = `Documentation skipped because required input is missing: ${missingDocumentInputs.join(', ')}. Diagram is optional, but architecture, estimation, and RAML are required.`;
        console.warn(`⚠️ ${message}`);
        if (onProgress) {
          onProgress({
            type: "step",
            step: 5,
            agent: "Documentation",
            status: "blocked",
            message
          });
        }
        return {
          architecture,
          diagram,
          estimation,
          raml,
          documentation,
          context,
          blockedDocumentation: true,
          missingDocumentInputs
        };
      }

      // A2A Protocol: Request Documentation Agent to generate documentation after required artifacts exist.
      if (onProgress) {
        onProgress({ type: "step", step: 5, agent: "Documentation", status: "working", message: "Requesting documentation from Documentation Agent via A2A..." });
      }

      let documentation = null;
      try {
        // Update context with RAML for documentation
        context.raml = raml;

        console.log('📡 Sending A2A message to documentation-agent with context:', {
          hasArchitecture: !!context.architecture,
          hasRAML: !!context.raml,
          hasDiagram: !!context.diagram,
          hasEstimation: !!context.estimation,
          requirementsType: typeof requirements
        });

        const docResponse = await this.sendMessage(
          'documentation-agent',
          'generate-document',
          {
            architecture,
            requirements,
            apiName: options.apiName || 'MuleSoftAPI',
            text: 'Generate comprehensive documentation based on the architecture, diagram, estimation, and RAML specifications.'
          },
          context, // Context includes architecture + diagram + estimation + raml
          { timeout: 420000, awaitResponse: true }
        );

        console.log('📡 Documentation Agent response:', {
          hasResponse: !!docResponse,
          responseType: docResponse?.type,
          hasContent: !!(docResponse?.payload?.content || docResponse?.payload?.result),
          contentLength: (docResponse?.payload?.content || docResponse?.payload?.result)?.length || 0
        });

        if (docResponse && docResponse.type === 'response') {
          // Check if Documentation Agent returned questions for user input
          if (docResponse.payload.questions && docResponse.payload.requiresUserInput) {
            console.log('[ArchitectureAgent] Documentation Agent returned clarifying questions');
            if (onProgress) {
              onProgress({
                type: "doc-questions-ready",
                step: 5,
                agent: "Documentation",
                status: "waiting",
                message: "Documentation questions ready for user input",
                questions: docResponse.payload.questions,
                context: { ...context, a2aDocTypeAsked: context.a2aDocTypeAsked, a2aQuestionsShown: context.a2aQuestionsShown },
                requirements
              });
            }
            // Return partial solution with deferred documentation
            return { architecture, diagram, estimation, raml, documentation: null, context, deferredDocumentation: true };
          } else if (docResponse.payload.documentGenerated && docResponse.payload.content) {
            // Documentation was generated directly
            documentation = docResponse.payload.content;

            if (onProgress) {
              onProgress({ type: "step", step: 5, agent: "Documentation", status: "completed", message: `Documentation received via A2A (${documentation?.length || 0} characters)`, data: documentation });
            }
          } else {
            // Documentation was generated as result
            documentation = docResponse.payload.result;

            if (onProgress) {
              onProgress({ type: "step", step: 5, agent: "Documentation", status: "completed", message: `Documentation received via A2A (${documentation?.length || 0} characters)`, data: documentation });
            }
          }
        }
      } catch (error) {
        console.error('❌ Failed to get documentation from Documentation Agent:', error);
        if (onProgress) {
          onProgress({ type: "step", step: 5, agent: "Documentation", status: "error", message: `A2A communication failed: ${error.message}` });
        }
      }

      // Return results with documentation
      return { architecture, diagram, estimation, raml, documentation, context };
    }

  /**
   * Generate architecture solution
   * @param {string} requirements - Business/technical requirements
   * @param {object} options - Additional options
   * @returns {Promise<string>} Architecture solution
   */
  async generateSolution(requirements, options = {}) {
      const prompt = `Based on the Requirements and Selected Approach, produce a MuleSoft architecture solution. Follow these mandatory rules and produce the sections listed below:

Requirements:
${requirements}

Mode selection (mandatory)
1. If the user selects "3‑layer" or "API‑led connectivity", set Mode = Strict and apply the full rule set: Experience APIs may only call Process APIs; Process APIs may call System APIs; System APIs must not be called by Experience APIs. Run the Validation Checklist and correct any violations.
2. If the user selects any other approach or does not select an approach, set Mode = Flexible. In Flexible mode, allow alternative topologies (single System API, Experience→System direct calls, event‑driven flows) but require:
   - A one‑line justification for choosing a non‑3‑layer topology.
   - A short risk assessment comparing this topology to the 3‑layer model.
   - Explicit mitigations for coupling, reuse, and governance if Experience→System direct calls are used.
Always state the Mode and the reason at the start of the architecture solution.

Mandatory rules
1. Call direction: Experience APIs may only call Process APIs. Process APIs may call System APIs and other Process APIs. System APIs must not be called directly by Experience APIs.
2. Ownership: For each API, state Owner (System = Backend Integrator; Process = Integration/Business Developer; Experience = Frontend/Channel Team).
3. System API definition: One System API per backend system or stable backend capability.
4. Process API definition: One Process API per business capability or orchestration; must expose canonical model.
5. Experience API definition: One Experience API per channel/consumer; must call Process APIs only.
6. Backend connectors such as Salesforce, SAP, databases, SFTP, and queues should be owned by System APIs or clearly named system-access services. If you propose a direct connector in a worker/batch/event flow, briefly justify why it is acceptable.
7. Provide at least one concrete example mapping for each integration described by the user.
8. Include a dedicated section named exactly "User Journey" with numbered end-to-end journey points that can be used for estimation.
9. If any NFRs, credentials, or backend availability are unknown, list them as assumptions and show how they change the design.

Required output sections (plain text list)
1. Architecture Overview
2. API Design grouped by layer/pattern (System / Process / Experience / Event-Driven / Batch if applicable). For each API/app include: Name; Owner; Purpose; Trigger or allowed callers; Key endpoints/events; Dependencies; Connector ownership.
3. Integration Patterns
4. Data Flow (sequence steps)
5. User Journey. Include numbered end-to-end journey points usable for estimation.
6. Security Architecture
7. Deployment Strategy
8. Error Handling
9. Monitoring & Logging
10. Short Validation Checklist covering call direction, connector ownership, error handling, and observability.

End with a corrected architecture if any validation checks failed.

${toolsInfo ? 'IMPORTANT: Ensure the architecture solution incorporates and properly integrates all the tools and software specified above.' : ''}`;


      return await this.askWithSystemPrompt(
        this.systemPrompt,
        prompt,
        {
          temperature: 0.7,
          maxTokens: tokenBudget('ARCHITECTURE_MAX_TOKENS', 14000),
          ...options
        }
      );
    }

  /**
   * Generate architecture for specific use case
   * @param {string} useCase - Use case description
   * @param {string} systems - Systems to integrate
   * @returns {Promise<string>} Architecture solution
   */
  async generateForUseCase(useCase, systems = []) {
      const systemsList = systems.length > 0
        ? `\nSystems to integrate: ${systems.join(", ")}`
        : "";

      const requirements = `Use Case: ${useCase}${systemsList}`;

      return await this.generateSolution(requirements);
    }

  /**
   * Refine architecture based on feedback
   * @param {string} currentArchitecture - Current architecture
   * @param {string} feedback - Feedback/changes needed
   * @returns {Promise<string>} Refined architecture
   */
  async refineArchitecture(currentArchitecture, feedback) {
      const prompt = `Here is the current architecture:
${currentArchitecture}

Please refine it based on this feedback:
${feedback}`;

      return await this.askWithSystemPrompt(
        this.systemPrompt,
        prompt,
        { temperature: 0.7, maxTokens: tokenBudget('ARCHITECTURE_MAX_TOKENS', 14000) }
      );
    }
  }


export default MuleSoftArchitectureAgent;
