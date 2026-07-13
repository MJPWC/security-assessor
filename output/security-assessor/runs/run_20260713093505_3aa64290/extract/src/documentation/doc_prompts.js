export function detectDocumentType(text) {
  const lower = (text || '').toLowerCase();
  if (/\bbrd\b|business\s+requirements?\s+document/i.test(lower)) return 'BRD';
  if (/\bwbs\b|work\s+breakdown\s+structure/i.test(lower)) return 'WBS';
  // Prioritize HLD detection
  if (/\bhld\b|high[-\s]*level\s+integration\s+design|high[-\s]*level\s+design/i.test(lower)) return 'HLD';
  if (/\btdd\b|technical\s+design\s+document|tech\s+design/i.test(lower)) return 'TDD';
  if (/test\s*(plan|strategy)|\bqa\b|testing\s+plan/i.test(lower)) return 'TEST_PLAN';
  
  // Detect general document generation requests
  if (/generat.*document|creat.*document|help.*document|document.*project|project.*document/i.test(lower)) {
    return 'DOCUMENT_REQUEST';
  }
  return null;
}

export function getDocRuleset(docType) {
  switch (docType) {
    case 'BRD':
      return {
        title: 'Business Requirements Document',
        sections: [
          'Executive Summary',
          'Business Objectives',
          'Scope (In/Out)',
          'Current State and Pain Points',
          'Proposed Solution Overview (high-level system interactions; avoid API-layer details)',
          'High-Level Requirements (Functional/Non-Functional)',
          'Data and Integration Requirements',
          'Assumptions and Constraints',
          'Dependencies',
          'Acceptance Criteria',
          'Risks and Mitigations'
        ],
        style: { voice: 'concise, business-friendly', format: 'markdown', bullets: true }
      };
    case 'HLD':
      return {
        title: 'High-Level Integration Design (HLD) – Name of Integration',
        sections: [
          'Change History',
          'Contributors/Reviewers',
          'Key References',
          'Business Context & Objective',
          'System/Component Diagram',
          'End-to-End Sequence Diagrams',
          'Constituent APIs & Integration Low-Level Designs (ILD) Links',
          'Dependencies & External Systems',
          'Monitoring & Observability',
          'Other References & Links',
          'RAIDD',
          '  - Risks',
          '  - Issues',
          '  - Assumptions (and Notes)',
          '  - Dependencies/Decisions',
          'Source to Target Mapping (STTM)',
          'STTM Approval Log'
        ],
        style: { voice: 'architectural-high-level', format: 'markdown', bullets: true }
      };
    case 'WBS':
      return {
        title: 'Work Breakdown Structure',
        sections: [
          'Initiation',
          'Discovery and Analysis',
          'Architecture & Design',
          'Development (APIs, Orchestrations, Mappings)',
          'Testing (Unit, MUnit, Integration, Performance, Security)',
          'Deployment & Cutover',
          'Hypercare & Handover'
        ],
        style: { voice: 'project-structured', format: 'markdown', bullets: true }
      };
    case 'TEST_PLAN':
      return {
        title: 'Test Plan',
        sections: [
          'Objectives and Scope',
          'Test Strategy (Unit, MUnit, Integration, Performance, Security)',
          'Test Environment & Data',
          'Test Cases and Coverage Matrix',
          'Entry/Exit Criteria',
          'Defect Management',
          'Roles & Responsibilities',
          'Schedule and Risks'
        ],
        style: { voice: 'engineering-quality', format: 'markdown', bullets: true }
      };
    case 'TDD':
      return {
        title: 'Technical Design Document',
        sections: [
          'System Overview and Architecture',
          'API Specifications (Endpoints, Methods, Request/Response Models)',
          'Data Models and Schemas',
          'Integration Patterns and Flows',
          'Error Handling and Exception Management',
          'Security Implementation (Authentication, Authorization, Encryption)',
          'Performance and Scalability Considerations',
          'Deployment Architecture and Configuration',
          'Monitoring and Observability',
          'Testing Strategy and Test Cases',
          'Dependencies and External Services',
          'Implementation Timeline and Milestones'
        ],
        style: { voice: 'technical-detailed', format: 'markdown', bullets: true }
      };
    case 'DOCUMENT_REQUEST':
      return {
        title: 'Project Documentation',
        sections: [
          'Project Overview',
          'Business Requirements',
          'Technical Architecture',
          'Integration Requirements',
          'Deployment Strategy',
          'Testing Approach',
          'Risk Assessment',
          'Timeline and Milestones'
        ],
        style: { voice: 'comprehensive-project', format: 'markdown', bullets: true }
      };
    default:
      return { title: 'Document', sections: [], style: { format: 'markdown' } };
  }
}

export function buildDocumentPrompt(docType, inputs = {}, contextSummary = '', conversationSummary = '') {
  const rules = getDocRuleset(docType);
  const extra = inputs?.extraNotes || '';
  const pool = `${inputs?.systems || ''}\n${inputs?.goal || ''}\n${inputs?.constraints || ''}\n${inputs?.apis || ''}\n${contextSummary || ''}\n${conversationSummary || ''}`;

  // 1) Prefer domain-specific phrases (healthcare, finance, retail, etc.) over low-level tech
  const preferredEntities = [
    { re: /(electronic\s+medical\s+records?|\bEMR\b)/i, label: 'EMR' },
    { re: /(electronic\s+health\s+records?|\bEHR\b)/i, label: 'EHR' },
    { re: /online\s+booking\s+system/i, label: 'Online Booking System' },
    { re: /appointment(s)?/i, label: 'Appointment' },
    { re: /patient\s+appointment(s)?/i, label: 'Patient Appointment' },
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
    const match = pool.match(ent.re);
    if (match) foundPreferred.push(ent.label);
  }

  // 2) Detect platform/system endpoints (still used if no domain phrases)
  const sysRegex = /(salesforce|sap|oracle|workday|netsuite|servicenow|dynamics|shopify|magento|kafka|rabbitmq|db|database|mysql|postgres|mongodb|s3|ftp|sftp|http|soap|rest|emr|ehr)/ig;
  const prettyMap = {
    salesforce: 'Salesforce',
    sap: 'SAP',
    oracle: 'Oracle',
    workday: 'Workday',
    netsuite: 'NetSuite',
    servicenow: 'ServiceNow',
    dynamics: 'Dynamics',
    shopify: 'Shopify',
    magento: 'Magento',
    kafka: 'Kafka',
    rabbitmq: 'RabbitMQ',
    db: 'Database',
    database: 'Database',
    mysql: 'MySQL',
    postgres: 'Postgres',
    mongodb: 'MongoDB',
    s3: 'S3',
    ftp: 'FTP',
    sftp: 'SFTP',
    http: 'HTTP',
    soap: 'SOAP',
    rest: 'REST',
    emr: 'EMR',
    ehr: 'EHR'
  };
  const systemsOrdered = [];
  let m;
  while ((m = sysRegex.exec(pool)) !== null) {
    const key = String(m[1] || '').toLowerCase();
    const label = prettyMap[key] || (key.charAt(0).toUpperCase() + key.slice(1));
    // De-duplicate while preserving order
    if (!systemsOrdered.includes(label)) systemsOrdered.push(label);
  }
  // Remove low-value transport-only labels unless nothing else present
  const lowValue = new Set(['HTTP', 'REST', 'SOAP']);
  const systemsFiltered = systemsOrdered.filter(l => !lowValue.has(l) || systemsOrdered.length <= 1);

  // 3) Build a human-readable scenario title
  let scenarioTitle = '';
  // Identify a subject if present (e.g., Patient Appointment, Payment, Order)
  const subjectsPriority = [
    // Healthcare
    'Patient Appointment','Appointment','Patient','Doctor',
    // Insurance
    'Claim Status','Claim','Policy',
    // HR
    'Employee Onboarding',
    // Logistics
    'Shipment Tracking',
    // Telecom
    'Plan Upgrade',
    // Manufacturing
    'Inventory Sync','Inventory',
    // Education
    'Student Enrollment',
    // Travel
    'Booking Confirmation',
    // Retail
    'Loyalty Points',
    // Real Estate
    'Lead Management'
  ];
  const subject = subjectsPriority.find(s => foundPreferred.includes(s));

  // Identify endpoints (prefer domain endpoints like Online Booking System, EMR/EHR over platforms)
  const endpointCandidates = [];
  if (foundPreferred.includes('Online Booking System')) endpointCandidates.push('Online Booking System');
  if (foundPreferred.includes('EMR')) endpointCandidates.push('EMR');
  if (foundPreferred.includes('EHR')) endpointCandidates.push('EHR');
  if (foundPreferred.includes('Active Directory')) endpointCandidates.push('Active Directory');
  if (foundPreferred.includes('Customer Portal')) endpointCandidates.push('Customer Portal');
  if (foundPreferred.includes('Backend Processing')) endpointCandidates.push('Backend Processing');
  if (foundPreferred.includes('Billing System')) endpointCandidates.push('Billing System');
  if (foundPreferred.includes('Warehouse System')) endpointCandidates.push('Warehouse System');
  if (foundPreferred.includes('Admissions Portal')) endpointCandidates.push('Admissions Portal');
  if (foundPreferred.includes('SIS')) endpointCandidates.push('SIS');
  if (foundPreferred.includes('Website')) endpointCandidates.push('Website');
  if (foundPreferred.includes('CRM')) endpointCandidates.push('CRM');
  if (foundPreferred.includes('POS')) endpointCandidates.push('POS');
  if (foundPreferred.includes('Rewards Platform')) endpointCandidates.push('Rewards Platform');
  // If still need endpoints, use systemsFiltered
  for (const s of systemsFiltered) {
    if (!endpointCandidates.includes(s)) endpointCandidates.push(s);
  }

  if (subject && endpointCandidates.length >= 2) {
    scenarioTitle = `${subject} – ${endpointCandidates[0]} to ${endpointCandidates[1]}`;
  } else if (subject && endpointCandidates.length === 1) {
    scenarioTitle = `${subject} – ${endpointCandidates[0]}`;
  } else if (endpointCandidates.length >= 2) {
    scenarioTitle = `${endpointCandidates[0]} to ${endpointCandidates[1]} Integration`;
  } else if (endpointCandidates.length === 1) {
    scenarioTitle = `${endpointCandidates[0]} Integration`;
  }
  // Prefer an explicit scenarioTitle provided by caller (e.g., AI-generated)
  if (inputs && typeof inputs.scenarioTitle === 'string' && inputs.scenarioTitle.trim()) {
    scenarioTitle = inputs.scenarioTitle.trim();
  }
  const titleSuffix = scenarioTitle ? ` for ${scenarioTitle}` : '';
  return `You are a MuleSoft Solution Documentation Agent.

Produce a ${rules.title}${titleSuffix} for the described MuleSoft initiative. Follow these strict rules:
- Output format: ${rules.style.format} with clear headings matching the sections below.
- Use proper markdown syntax: # for document title, ## for main sections, ### for subsections.
- Start with document title as: # ${rules.title}${titleSuffix}
- Each main section should be ## Section Name
- Use proper paragraph spacing with double line breaks between sections.
- Use bullet points with proper indentation: - for main bullets, - - for sub-bullets.
- Include tables where appropriate using markdown table syntax.
- Ensure proper text alignment and structure for Word conversion.
- Add horizontal rules (---) between major sections for better visual separation.
- Tone: ${rules.style.voice}.
- Use bullet lists where suitable.
- Use only facts from the conversation and context; state assumptions clearly.
${docType === 'BRD' ? '\n- Proposed Solution Overview must be high-level system interactions (touchpoints, data exchanges, channels, environments). Avoid API-layer breakdowns, endpoints/methods, configuration, or code-level details.' : ''}
${docType === 'TDD' ? '\n- TDD must be highly technical and implementation-focused. Include specific API endpoints, data models, algorithms, configuration details, error codes, security mechanisms, and low-level technical specifications. Target developers, architects, and QA engineers.' : ''}
${docType === 'HLD' ? '\n- For the sections "System/Component Diagram" and "End-to-End Sequence Diagrams", include ONLY the heading followed by blank space for manual entry. Do NOT add any descriptive text, lists, or diagrams under these two sections. Leave at least 10 blank lines under each heading.' : ''}

CONTEXT SUMMARY:
${contextSummary || 'N/A'}

CONVERSATION SUMMARY (entire session):
${conversationSummary || 'N/A'}

PROJECT INPUTS:
- Goal: ${inputs.goal || 'N/A'}
- Systems: ${inputs.systems || 'N/A'}
- APIs: ${inputs.apis || 'N/A'}
- Deployment: ${inputs.deployment || 'N/A'}
- Constraints: ${inputs.constraints || 'N/A'}
- Notes: ${extra || 'N/A'}

MANDATORY SECTIONS:
${rules.sections.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Validation:
- Ensure sections are present, concise, and tailored to MuleSoft context.
- Include non-functional needs (security, observability, performance) where relevant.
`;
}
