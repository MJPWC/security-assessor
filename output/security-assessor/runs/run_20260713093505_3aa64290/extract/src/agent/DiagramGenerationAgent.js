import BaseAgent from "./BaseAgent.js";
import { getAgentConfig } from "../config/agentConfigs.js";
import { A2AMessage } from "../a2a/Message.js";
import LLMManager from "../llm/LLMManager.js";
import GeminiClient from "../llm/GeminiClient.js";
import OpenAIClient from "../llm/OpenAIClient.js";
import AnthropicClient from "../llm/AnthropicClient.js";
import OpenRouterClient from "../llm/OpenRouterClient.js";
import GroqClient from "../llm/GroqClient.js";
import Config from "../config/config.js";
import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";

class DiagramGenerationAgent extends BaseAgent {
  constructor(config = null, agentConfig = null) {
    const agentConfigInstance = config || new Config();

    const clientConfigs = [
      {
        key: 'anthropic',
        class: AnthropicClient,
        config: { apiKey: agentConfigInstance.anthropicApiKey, model: agentConfigInstance.anthropicModel },
        priority: 1
      },
      {
        key: 'groq',
        class: GroqClient,
        config: { apiKey: agentConfigInstance.groqApiKey, model: agentConfigInstance.groqModel },
        priority: 2
      },
      {
        key: 'openai',
        class: OpenAIClient,
        config: { apiKey: agentConfigInstance.openaiApiKey, model: agentConfigInstance.openaiModel },
        priority: 3
      },
      {
        key: 'gemini',
        class: GeminiClient,
        config: {
          apiKey: agentConfigInstance.geminiApiKey || (agentConfigInstance.geminiApiKeys && agentConfigInstance.geminiApiKeys[0]),
          apiKeys: agentConfigInstance.geminiApiKeys,
          model: agentConfigInstance.geminiModel
        },
        priority: 4
      },
      {
        key: 'openrouter',
        class: OpenRouterClient,
        config: {
          apiKey: agentConfigInstance.openrouterApiKey,
          model: agentConfigInstance.openrouterModel,
          baseUrl: agentConfigInstance.openrouterBaseUrl,
          site: agentConfigInstance.openrouterSite,
          appName: agentConfigInstance.openrouterAppName
        },
        priority: 5
      }
    ];

    const preferredIndex = clientConfigs.findIndex(({ key }) => key === agentConfigInstance.provider);
    if (preferredIndex > 0) {
      const [preferredConfig] = clientConfigs.splice(preferredIndex, 1);
      clientConfigs.unshift(preferredConfig);
    }

    const llmManager = new LLMManager(clientConfigs);
    super(agentConfigInstance, 'diagram-agent', llmManager);

    const defaultConfig = agentConfig || getAgentConfig("diagram");
    this.name = defaultConfig?.name || "Diagram Generation Agent";
    this.description = defaultConfig?.description || "Expert at creating technical diagrams";
    this.conversationStarters = defaultConfig?.conversationStarters || [];
    this.knowledge = defaultConfig?.knowledge || [];

    this.systemPrompt = defaultConfig?.instructions || `You are an expert MuleSoft architecture diagram generator. You output draw.io XML only.`;

    // Hardened draw.io system prompt with strict XML-only output rules
    this.drawioSystemPrompt = `You are an expert MuleSoft architecture diagram generator. You output draw.io XML only.

ABSOLUTE RULES — violating any of these makes your output unusable:
1. Your ENTIRE response must be a single XML block starting with <mxGraphModel and ending with </mxGraphModel>
2. Do NOT output anything before <mxGraphModel — no explanation, no "Here is", no markdown
3. Do NOT output anything after </mxGraphModel>
4. Do NOT use markdown code fences (no \`\`\`xml or \`\`\`)
5. Every mxCell MUST have a unique numeric id starting from 0
6. mxCell id="0" and id="1" (parent="0") are required boilerplate — always include them
7. All vertex cells need <mxGeometry .../> as child element with as="geometry"
8. All edge cells need source and target attributes matching existing vertex ids
9. Attribute values must use double quotes, never single quotes
10. No unclosed tags, no malformed XML

REQUIRED XML SKELETON:
<mxGraphModel dx="1422" dy="762" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1654" pageHeight="1169" math="0" shadow="0">
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    <!-- your diagram cells here, starting at id="2" -->
  </root>
</mxGraphModel>

ARCHITECTURE DIAGRAM STYLES:
- Experience API box: style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontStyle=1;fontSize=11;"
- Process API box:    style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontStyle=1;fontSize=11;"
- System API box:     style="rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontStyle=1;fontSize=11;"
- Database:           style="shape=cylinder3;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;fontColor=#333333;"
- External system:    style="rounded=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;"
- Flow arrow:         style="rounded=0;orthogonalLoop=1;jettySize=auto;exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;endArrow=block;endFill=1;"

SEQUENCE DIAGRAM — EXACT CONSTRUCTION RULES:
Sequence diagrams use the classic UML style: participant boxes across the top, vertical dashed lifelines, numbered horizontal arrows.
Do NOT use swimlane cells. Build every element manually as individual mxCell entries.

PARTICIPANT BOX style:   style="shape=mxgraph.uml.actor;whiteSpace=wrap;html=1;" for actors  OR
                         style="rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#000000;fontStyle=1;fontSize=11;" for system boxes
LIFELINE style:          style="endArrow=none;dashed=1;strokeColor=#000000;strokeWidth=1;" — vertical line from bottom-center of box downward
REQUEST ARROW style:     style="endArrow=block;endFill=1;strokeColor=#000000;strokeWidth=1;dashed=0;" — solid horizontal arrow left→right
RESPONSE ARROW style:    style="endArrow=open;endFill=0;strokeColor=#000000;strokeWidth=1;dashed=1;" — dashed horizontal arrow right→left
ACTIVATION BAR style:    style="rounded=0;whiteSpace=wrap;html=1;fillColor=#d4d4d4;strokeColor=#666666;" — tall narrow rectangle on lifeline

SEQUENCE LAYOUT COORDINATES (strictly follow these):
- Participants are placed LEFT TO RIGHT across the top, starting at y=40, height=50
- Space each participant 220px apart horizontally: x = 80 + (participantIndex * 220)
- Participant box width = 160px
- Lifeline centerX = participantBox.x + 80  (center of the 160px box)
- Lifelines start at y=100 (bottom of participant box + 10px gap) and extend to y = 100 + (numberOfMessages * 60) + 60
- Each message arrow is at a different y position: y = 130 + (messageIndex * 60)
- Arrow goes from lifeline center of source participant to lifeline center of target participant (horizontal, same y)
- Label each arrow with the step number and message name, e.g. "1: loginRequest(credentials)"
- For left-to-right arrows: exitX=0.5;exitY=0.5 on source lifeline, entryX=0.5;entryY=0.5 on target lifeline — but use absolute x positions instead of source/target when the edge connects points on lifelines

SEQUENCE GEOMETRY PATTERN — use this exact approach:
- Each lifeline is a vertical line cell (edge with no arrow): from (centerX, 100) to (centerX, bottomY)
- Each message arrow is an edge cell with: source=sourceLifelineId, target=targetLifelineId, value="N: messageName"
  BUT since lifelines are vertical lines, use mxPoint overrides in the geometry to pin the y coordinate:
  <mxGeometry relative="1"><Array as="points"/></mxGeometry>
  Instead, draw arrows as VERTEX cells (horizontal rectangles with arrowhead style) positioned at the correct y:
  Actually use edge cells with exitX/exitY/entryX/entryY set to place the arrow at the right vertical position on the lifeline.

SIMPLIFIED APPROACH — most reliable for LLMs:
Instead of connecting to lifeline cells, draw each message arrow as a standalone edge between two invisible point vertices on each lifeline, OR use this proven pattern:
- Create a thin vertical rectangle for each lifeline (vertex, not edge)
- Draw each arrow as an edge with source=leftLifelineRect, target=rightLifelineRect
- Use exitX=0.5;exitY=<fractional position>;entryX=0.5;entryY=<same fraction> to position arrows vertically
- exitY and entryY are fractions of the lifeline height: messageY_fraction = messageIndex / totalMessages

ARCHITECTURE DIAGRAM LAYOUT:
- Layer API tiers left-to-right with 200px+ spacing
- Component box size: 160px wide × 60px tall
- Leave at least 80px between adjacent boxes`;

    // Separate focused system prompt for sequence diagrams
    this.sequenceSystemPrompt = `You are an expert UML sequence diagram generator for draw.io XML. You output draw.io XML only.

ABSOLUTE OUTPUT RULES:
1. Start immediately with <mxGraphModel — zero text before it
2. End with </mxGraphModel> — zero text after it  
3. No markdown, no code fences, no explanations
4. All attribute values in double quotes
5. Every mxCell has a unique integer id (0, 1, 2, 3 ...)
6. No unclosed XML tags

YOU MUST FOLLOW THIS EXACT TEMPLATE for sequence diagrams — adapt the participants and messages but keep the structural pattern identical:

EXAMPLE (4 participants, 5 messages) — study this carefully and replicate the pattern:

<mxGraphModel dx="1422" dy="762" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1654" pageHeight="827" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="2" value="Client" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#000000;fontStyle=1;fontSize=12;" vertex="1" parent="1"><mxGeometry x="60" y="40" width="140" height="50" as="geometry"/></mxCell>
<mxCell id="3" value="API Gateway" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontStyle=1;fontSize=12;" vertex="1" parent="1"><mxGeometry x="280" y="40" width="140" height="50" as="geometry"/></mxCell>
<mxCell id="4" value="Process API" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontStyle=1;fontSize=12;" vertex="1" parent="1"><mxGeometry x="500" y="40" width="140" height="50" as="geometry"/></mxCell>
<mxCell id="5" value="Database" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontStyle=1;fontSize=12;" vertex="1" parent="1"><mxGeometry x="720" y="40" width="140" height="50" as="geometry"/></mxCell>
<mxCell id="6" value="" style="endArrow=none;dashed=1;strokeColor=#000000;strokeWidth=1;exitX=0.5;exitY=1;exitDx=0;exitDy=0;" edge="1" parent="1" source="2"><mxGeometry x="130" y="90" width="1" height="500" relative="0" as="geometry"><mxPoint x="130" y="90" as="sourcePoint"/><mxPoint x="130" y="590" as="targetPoint"/></mxGeometry></mxCell>
<mxCell id="7" value="" style="endArrow=none;dashed=1;strokeColor=#000000;strokeWidth=1;exitX=0.5;exitY=1;exitDx=0;exitDy=0;" edge="1" parent="1" source="3"><mxGeometry relative="0" as="geometry"><mxPoint x="350" y="90" as="sourcePoint"/><mxPoint x="350" y="590" as="targetPoint"/></mxGeometry></mxCell>
<mxCell id="8" value="" style="endArrow=none;dashed=1;strokeColor=#000000;strokeWidth=1;" edge="1" parent="1"><mxGeometry relative="0" as="geometry"><mxPoint x="570" y="90" as="sourcePoint"/><mxPoint x="570" y="590" as="targetPoint"/></mxGeometry></mxCell>
<mxCell id="9" value="" style="endArrow=none;dashed=1;strokeColor=#000000;strokeWidth=1;" edge="1" parent="1"><mxGeometry relative="0" as="geometry"><mxPoint x="790" y="90" as="sourcePoint"/><mxPoint x="790" y="590" as="targetPoint"/></mxGeometry></mxCell>
<mxCell id="10" value="1: request(data)" style="endArrow=block;endFill=1;strokeColor=#000000;strokeWidth=1.5;fontSize=11;align=center;verticalAlign=bottom;" edge="1" parent="1"><mxGeometry relative="0" as="geometry"><mxPoint x="130" y="140" as="sourcePoint"/><mxPoint x="350" y="140" as="targetPoint"/></mxGeometry></mxCell>
<mxCell id="11" value="2: process(data)" style="endArrow=block;endFill=1;strokeColor=#000000;strokeWidth=1.5;fontSize=11;align=center;verticalAlign=bottom;" edge="1" parent="1"><mxGeometry relative="0" as="geometry"><mxPoint x="350" y="200" as="sourcePoint"/><mxPoint x="570" y="200" as="targetPoint"/></mxGeometry></mxCell>
<mxCell id="12" value="3: query(params)" style="endArrow=block;endFill=1;strokeColor=#000000;strokeWidth=1.5;fontSize=11;align=center;verticalAlign=bottom;" edge="1" parent="1"><mxGeometry relative="0" as="geometry"><mxPoint x="570" y="260" as="sourcePoint"/><mxPoint x="790" y="260" as="targetPoint"/></mxGeometry></mxCell>
<mxCell id="13" value="4: results" style="endArrow=open;endFill=0;strokeColor=#666666;strokeWidth=1.5;dashed=1;fontSize=11;align=center;verticalAlign=bottom;" edge="1" parent="1"><mxGeometry relative="0" as="geometry"><mxPoint x="790" y="320" as="sourcePoint"/><mxPoint x="570" y="320" as="targetPoint"/></mxGeometry></mxCell>
<mxCell id="14" value="5: response(data)" style="endArrow=open;endFill=0;strokeColor=#666666;strokeWidth=1.5;dashed=1;fontSize=11;align=center;verticalAlign=bottom;" edge="1" parent="1"><mxGeometry relative="0" as="geometry"><mxPoint x="350" y="380" as="sourcePoint"/><mxPoint x="130" y="380" as="targetPoint"/></mxGeometry></mxCell>
</root></mxGraphModel>

KEY RULES derived from the example above:
- Participant boxes: y=40, height=50, width=140, spaced 220px apart. First at x=60, next x=280, next x=500, etc.
- Lifeline centerX = participantBox.x + 70  (center of 140px box)
- Lifelines: dashed vertical edges using mxPoint sourcePoint/targetPoint (NOT source/target vertex refs for lifelines)
  sourcePoint y = 90 (bottom of participant box), targetPoint y = last message y + 80
- Each message arrow: horizontal edge using mxPoint sourcePoint/targetPoint with EXPLICIT x,y coordinates
  sourcePoint x = source participant centerX, targetPoint x = target participant centerX
  y increases by 60 for each successive message: first at y=140, then 200, 260, 320, 380 ...
- Request arrows (left→right): endArrow=block;endFill=1;strokeColor=#000000;strokeWidth=1.5
- Response arrows (right→left): endArrow=open;endFill=0;strokeColor=#666666;strokeWidth=1.5;dashed=1
- Arrow label: value="N: methodName(params)" where N is the step number
- fontSize=11 or 12 on all cells, align=center on arrow labels`;

    this.topologySystemPrompt = `You are an expert MuleSoft network topology diagram generator. You output draw.io XML only.

ABSOLUTE OUTPUT RULES:
1. Start immediately with <mxGraphModel and end with </mxGraphModel>
2. Output no markdown, explanation, preamble, or trailing text
3. Use double quotes for all XML attributes and close every XML tag
4. Every mxCell must have a unique numeric id
5. Include mxCell id="0" and mxCell id="1" parent="0"
6. Every vertex and edge must contain valid mxGeometry
7. Every edge source and target must reference existing vertex ids

TOPOLOGY CONTENT RULES:
- Create one topology view, not a component inventory or sequence diagram
- Organize the diagram into clearly labeled zone containers:
  External, Security / Boundary, Internal Mule Runtime, and Backend / Enterprise
- Place components inside the correct zone and show public-to-private trust boundaries
- Separate externally exposed Experience APIs from internal Process and System APIs
- Show only infrastructure and connectivity relevant to the supplied architecture
- Label connections with known protocols or transports; do not invent unspecified protocols
- Use solid arrows for synchronous traffic and dashed arrows for asynchronous or batch traffic
- Show high availability or redundant runtime nodes only when the supplied context supports it
- Do not include message numbers, sequence steps, data mappings, API resources, or implementation classes

SECURITY ABSTRACTION RULES:
- Represent API policies with exactly one generic box labeled "Policy Enforcement Layer"
- Never display individual policy names
- Do not create separate policy boxes for OAuth, mTLS, rate limiting, client enforcement, CORS, or threat protection
- WAF, firewall, gateway, ingress, and load balancer may remain separate infrastructure controls when relevant

LAYOUT RULES:
- Arrange zones left-to-right: External -> Security / Boundary -> Internal Mule Runtime -> Backend / Enterprise
- Use large, lightly filled rectangular containers for zones
- Keep child components fully inside their zone containers
- Keep a clear horizontal flow and connect from the right side of a source box to the left side of a target box
- Use orthogonal connectors with explicit exitX=1;exitY=0.5 and entryX=0;entryY=0.5
- Route connectors around boxes and zone headings; no connector may pass through a component
- Avoid crossing or overlapping connectors. Reposition components or add mxPoint waypoints when needed
- Do not draw separate overlapping request and response arrows between the same two components; use one directional connection labeled with the transport
- Keep parallel connectors at least 20px apart and do not place connector labels on top of boxes or other labels
- Use filled block arrowheads with strokeWidth=2 so traffic direction is immediately visible
- Keep labels short and readable; protocol labels belong on connectors
- Give connector labels an opaque white background using labelBackgroundColor=#ffffff
- Every symbol must have a visible text label; do not use unlabeled or decorative icons
- Use consistent component sizes and at least 50px spacing between adjacent components

REQUIRED STYLES:
- Zone container: style="swimlane;html=1;rounded=0;startSize=30;horizontal=1;fillColor=#f5f5f5;strokeColor=#78909c;fontStyle=1;fontSize=12;"
- External component: style="rounded=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;fontSize=11;"
- Security control: style="rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;fontSize=11;"
- Policy layer: style="rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontStyle=1;fontSize=11;"
- Mule API/runtime: style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=11;"
- Backend system: style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontSize=11;"
- Database: style="shape=cylinder3;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;fontSize=11;"
- Synchronous connector: style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;exitX=1;exitY=0.5;entryX=0;entryY=0.5;endArrow=block;endFill=1;strokeColor=#455a64;strokeWidth=2;fontSize=10;labelBackgroundColor=#ffffff;"
- Asynchronous connector: style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;exitX=1;exitY=0.5;entryX=0;entryY=0.5;endArrow=block;endFill=1;dashed=1;strokeColor=#455a64;strokeWidth=2;fontSize=10;labelBackgroundColor=#ffffff;"`;

    this.register({
      name: this.name,
      description: this.description,
      capabilities: ['generate-component-diagram', 'generate-sequence-diagram', 'generate-topology-diagram', 'generate-all-diagrams']
    });
  }

  getTokenCategory() { return 'Diagram'; }

  /**
   * A2A Protocol: Handle incoming messages from other agents.
   * Returns a structured result object so the tool field survives.
   */
  async handleMessage(message) {
    console.log(`📨 Diagram Agent received message from ${message.from}: ${message.payload.type}`);

    try {
      const messageType = message.payload.type;
      console.log('🔧 Diagram Agent using draw.io');

      const architecture = message.payload.architecture || message.context?.architecture;
      if (!architecture) {
        throw new Error("Architecture solution is required. Please provide architecture in message payload or context.");
      }

      // ── New flow: only generate the component (master architecture) diagram via A2A.
      // Sequence diagrams are now generated per-use-case from the Diagram tab UI
      // via generateUseCaseSequenceDiagram(). generateAllDiagrams() is removed.
      let diagramResult;

      switch (messageType) {
        case 'generate-diagram':
        case 'generate-all-diagrams':
        case 'generate-component-diagram': {
          // Always generate the component/architecture diagram only
          const r = await this.generateDrawioDiagram(architecture, 'component');
          diagramResult = { component: r.diagramUrl, sequence: null, tool: 'drawio' };
          break;
        }
        case 'generate-sequence-diagram': {
          // Legacy single-sequence fallback — kept for CLI / non-UI flows only
          const r = await this.generateDrawioDiagram(architecture, 'sequence');
          diagramResult = { component: null, sequence: r.diagramUrl, tool: 'drawio' };
          break;
        }
        default:
          throw new Error(`Unknown message type: ${messageType}`);
      }

      const resultText = `=== COMPONENT DIAGRAM ===\n${diagramResult.component || 'N/A'}\n\n=== SEQUENCE DIAGRAM ===\n${diagramResult.sequence || 'N/A'}`;

      return A2AMessage.createResponse(
        this.agentId,
        message.from,
        {
          result: resultText,
          diagram: resultText,
          // Structured data for frontend — kept alongside the text result
          diagramData: {
            component: diagramResult.component,
            sequence: diagramResult.sequence,
            tool: diagramResult.tool
          }
        },
        message.requestId,
        {
          ...message.context,
          diagram: resultText,
          diagramData: {
            component: diagramResult.component,
            sequence: diagramResult.sequence,
            tool: diagramResult.tool
          }
        }
      );
    } catch (error) {
      console.error(`❌ Diagram Agent error:`, error);
      return A2AMessage.createError(this.agentId, message.from, error.message, message.requestId);
    }
  }

  getConfig() {
    return {
      name: this.name,
      description: this.description,
      instructions: this.systemPrompt,
      conversationStarters: this.conversationStarters,
      knowledge: this.knowledge
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // draw.io generation with retry on malformed XML
  // ────────────────────────────────────────────────────────────────────────────

  createDiagramContext(architectureSolution, useCases = []) {
    const architecture = String(architectureSolution || '').replace(/\r/g, '').trim();
    const lines = architecture
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    const pickLines = (patterns, limit = 18) => {
      const seen = new Set();
      const picked = [];
      for (const line of lines) {
        if (line.length > 260) continue;
        if (!patterns.some(pattern => pattern.test(line))) continue;
        const normalized = line.toLowerCase();
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        picked.push(line.replace(/^[-*•\d.)\s]+/, '').trim());
        if (picked.length >= limit) break;
      }
      return picked;
    };

    const apiLines = pickLines([
      /\bexperience\s+api\b/i,
      /\bprocess\s+api\b/i,
      /\bsystem\s+api\b/i,
      /\bapi\b/i
    ], 20);
    const systemLines = pickLines([
      /\bsalesforce\b/i,
      /\bsap\b/i,
      /\bdatabase\b/i,
      /\bdb\b/i,
      /\bmainframe\b/i,
      /\bsftp\b/i,
      /\bpartner\b/i,
      /\bexternal system\b/i,
      /\bbackend\b/i
    ], 16);
    const protocolLines = pickLines([
      /\bhttps?\b/i,
      /\brest\b/i,
      /\bsoap\b/i,
      /\bmq\b/i,
      /\bkafka\b/i,
      /\bsftp\b/i,
      /\bjdbc\b/i,
      /\bsap\s*(rfc|idoc)\b/i,
      /\boData\b/i,
      /\bprotocol\b/i
    ], 14);
    const networkLines = pickLines([
      /\bvpc\b/i,
      /\bvnet\b/i,
      /\bsubnet\b/i,
      /\bfirewall\b/i,
      /\bwaf\b/i,
      /\bvpn\b/i,
      /\bprivate(link| endpoint| space)?\b/i,
      /\bcloudhub\b/i,
      /\bruntime fabric\b/i,
      /\brtf\b/i,
      /\bdmz\b/i,
      /\bload balancer\b/i,
      /\bgateway\b/i,
      /\bmtls\b/i,
      /\boauth\b/i
    ], 14);

    const useCaseLines = (Array.isArray(useCases) ? useCases : [])
      .slice(0, 10)
      .map((u, i) => `${i + 1}. ${u.name || `Use Case ${i + 1}`}${u.description ? ` - ${u.description}` : ''}`);

    const fallback = lines.slice(0, 18).map(line => line.slice(0, 240));
    const sections = [
      `Use Cases:\n${useCaseLines.length ? useCaseLines.join('\n') : 'Derive from architecture.'}`,
      `API / Component Context:\n${apiLines.length ? apiLines.join('\n') : fallback.join('\n')}`,
      `Systems / Backends:\n${systemLines.length ? systemLines.join('\n') : 'Derive from architecture.'}`,
      `Protocols / Transports:\n${protocolLines.length ? protocolLines.join('\n') : 'Derive from architecture.'}`,
      `Network / Security Context:\n${networkLines.length ? networkLines.join('\n') : 'Derive from architecture.'}`
    ];

    return sections.join('\n\n').slice(0, 7000);
  }

  _parseStyle(style = '') {
    const entries = String(style)
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const separator = part.indexOf('=');
        return separator === -1
          ? [part, '1']
          : [part.slice(0, separator), part.slice(separator + 1)];
      });
    return new Map(entries);
  }

  _serializeStyle(styleMap) {
    return `${Array.from(styleMap.entries()).map(([key, value]) => `${key}=${value}`).join(';')};`;
  }

  _normalizeAndValidateTopologyXml(xml) {
    const validation = XMLValidator.validate(xml);
    if (validation !== true) {
      return {
        xml,
        valid: false,
        issues: [`XML validation failed: ${validation?.err?.msg || 'invalid XML'}`],
        metrics: {}
      };
    }

    const parser = new XMLParser({
      ignoreAttributes: false,
      preserveOrder: true,
      attributeNamePrefix: '@_',
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: false
    });
    const builder = new XMLBuilder({
      ignoreAttributes: false,
      preserveOrder: true,
      attributeNamePrefix: '@_',
      format: false,
      suppressEmptyNode: true
    });

    let tree;
    try {
      tree = parser.parse(xml);
    } catch (error) {
      return { xml, valid: false, issues: [`XML parse failed: ${error.message}`], metrics: {} };
    }

    const cellNodes = [];
    const visit = value => {
      if (!Array.isArray(value)) return;
      for (const node of value) {
        if (!node || typeof node !== 'object') continue;
        if (Object.prototype.hasOwnProperty.call(node, 'mxCell')) cellNodes.push(node);
        for (const [key, child] of Object.entries(node)) {
          if (key !== ':@' && Array.isArray(child)) visit(child);
        }
      }
    };
    visit(tree);

    const cells = new Map();
    for (const node of cellNodes) {
      const attrs = node[':@'] || {};
      const id = attrs['@_id'];
      if (id != null) cells.set(String(id), { node, attrs });
    }

    const vertices = [];
    const edges = [];
    for (const cell of cells.values()) {
      if (cell.attrs['@_vertex'] === '1') vertices.push(cell);
      if (cell.attrs['@_edge'] === '1') edges.push(cell);
    }

    const geometryFor = cell => {
      const geometryNode = (cell.node.mxCell || []).find(
        child => child && Object.prototype.hasOwnProperty.call(child, 'mxGeometry')
      );
      return geometryNode?.[':@'] || {};
    };

    const positionCache = new Map();
    const getPosition = (id, seen = new Set()) => {
      const key = String(id || '');
      if (positionCache.has(key)) return positionCache.get(key);
      if (!key || seen.has(key)) return { x: 0, y: 0 };
      seen.add(key);

      const cell = cells.get(key);
      if (!cell) return { x: 0, y: 0 };
      const geometry = geometryFor(cell);
      const parentPosition = getPosition(cell.attrs['@_parent'], seen);
      const position = {
        x: parentPosition.x + (Number.parseFloat(geometry['@_x']) || 0),
        y: parentPosition.y + (Number.parseFloat(geometry['@_y']) || 0)
      };
      positionCache.set(key, position);
      return position;
    };

    const outgoing = new Map();
    const incoming = new Map();
    const addConnection = (map, id, edge) => {
      if (!id) return;
      const list = map.get(id) || [];
      list.push(edge);
      map.set(id, list);
    };
    for (const edge of edges) {
      addConnection(outgoing, edge.attrs['@_source'], edge);
      addConnection(incoming, edge.attrs['@_target'], edge);
    }
    const sortEdges = list => list.sort((a, b) =>
      String(a.attrs['@_id'] || '').localeCompare(String(b.attrs['@_id'] || ''), undefined, { numeric: true })
    );
    for (const list of outgoing.values()) sortEdges(list);
    for (const list of incoming.values()) sortEdges(list);

    const portPosition = (list, edge) => {
      if (!list?.length) return '0.5';
      const index = Math.max(0, list.indexOf(edge));
      const fraction = (index + 1) / (list.length + 1);
      return String(Math.max(0.2, Math.min(0.8, fraction)).toFixed(2));
    };

    for (const edge of edges) {
      const sourceId = edge.attrs['@_source'];
      const targetId = edge.attrs['@_target'];
      const sourcePosition = getPosition(sourceId);
      const targetPosition = getPosition(targetId);
      const flowsRight = targetPosition.x >= sourcePosition.x;
      const style = this._parseStyle(edge.attrs['@_style']);
      const isAsync = style.get('dashed') === '1';

      style.set('edgeStyle', 'orthogonalEdgeStyle');
      style.set('rounded', '0');
      style.set('orthogonalLoop', '1');
      style.set('jettySize', 'auto');
      style.set('exitX', flowsRight ? '1' : '0');
      style.set('entryX', flowsRight ? '0' : '1');
      style.set('exitY', portPosition(outgoing.get(sourceId), edge));
      style.set('entryY', portPosition(incoming.get(targetId), edge));
      style.set('exitDx', '0');
      style.set('exitDy', '0');
      style.set('entryDx', '0');
      style.set('entryDy', '0');
      style.set('startArrow', 'none');
      style.set('startFill', '0');
      style.set('endArrow', 'block');
      style.set('endFill', '1');
      style.set('strokeColor', '#263238');
      style.set('strokeWidth', '2.5');
      style.set('fontColor', '#263238');
      style.set('fontSize', '11');
      style.set('fontStyle', '1');
      style.set('labelBackgroundColor', '#ffffff');
      style.set('labelBorderColor', '#ffffff');
      style.set('align', 'center');
      style.set('verticalAlign', 'middle');
      style.set('html', '1');
      style.set('dashed', isAsync ? '1' : '0');
      edge.attrs['@_style'] = this._serializeStyle(style);

      let geometryNode = (edge.node.mxCell || []).find(
        child => child && Object.prototype.hasOwnProperty.call(child, 'mxGeometry')
      );
      if (!geometryNode) {
        geometryNode = {
          mxGeometry: [],
          ':@': { '@_relative': '1', '@_as': 'geometry' }
        };
        edge.node.mxCell = [...(edge.node.mxCell || []), geometryNode];
      } else {
        geometryNode[':@'] = {
          ...(geometryNode[':@'] || {}),
          '@_relative': '1',
          '@_as': 'geometry'
        };
      }
    }

    const issues = [];
    if (vertices.length < 4) issues.push(`Expected at least 4 topology vertices; found ${vertices.length}`);
    if (edges.length < 3) issues.push(`Expected at least 3 topology connections; found ${edges.length}`);

    const ids = new Set(cells.keys());
    const connectionPairs = new Map();
    for (const edge of edges) {
      const id = String(edge.attrs['@_id'] || '?');
      const source = String(edge.attrs['@_source'] || '');
      const target = String(edge.attrs['@_target'] || '');
      const label = String(edge.attrs['@_value'] || '').replace(/<[^>]+>/g, '').trim();

      if (!source || !target) issues.push(`Edge ${id} is missing a source or target`);
      if (source && !ids.has(source)) issues.push(`Edge ${id} references unknown source ${source}`);
      if (target && !ids.has(target)) issues.push(`Edge ${id} references unknown target ${target}`);
      if (source && source === target) issues.push(`Edge ${id} connects a component to itself`);
      if (!label) issues.push(`Edge ${id} has no protocol or transport label`);

      if (source && target) {
        const pair = [source, target].sort().join('::');
        connectionPairs.set(pair, (connectionPairs.get(pair) || 0) + 1);
      }
    }

    const crowdedPairs = Array.from(connectionPairs.values()).filter(count => count > 2).length;
    if (crowdedPairs > 0) {
      issues.push(`${crowdedPairs} component pair(s) have more than two overlapping connections`);
    }

    const normalizedXml = builder.build(tree);
    return {
      xml: normalizedXml,
      valid: issues.length === 0,
      issues,
      metrics: {
        vertices: vertices.length,
        edges: edges.length,
        crowdedPairs
      }
    };
  }

  async generateDrawioDiagram(architectureSolution, diagramType = 'component', retryCount = 0) {
    if (!architectureSolution) throw new Error("Architecture solution is required.");

    const isTopology = diagramType === 'topology';
    const isSequence = diagramType === 'sequence';
    const maxRetries = 2;

    const systemPrompt = isTopology
      ? this.topologySystemPrompt
      : (isSequence ? this.sequenceSystemPrompt : this.drawioSystemPrompt);

    const prompt = isTopology
      ? `Generate a NETWORK TOPOLOGY diagram in draw.io XML from this focused solution context:

${architectureSolution}

Apply the topology rules exactly. Show zones, trust boundaries, infrastructure, runtimes, enterprise systems, traffic direction, and protocol labels supported by the context.
Represent all API policies only as one "Policy Enforcement Layer".

Output the complete draw.io XML now (start immediately with <mxGraphModel):
`
      : !isSequence
        ? `Generate an ARCHITECTURE / COMPONENT diagram in draw.io XML for this MuleSoft solution:

${architectureSolution}

Show: Experience API layer → Process API layer → System API layer → Databases/External Systems.
Use styled boxes for each API/service (use the colour styles from the instructions), arrows for data flow, cylinder shapes for databases.
Every component must be labelled clearly. Include at least 8–12 cells.
Arrange components left-to-right showing the API-led connectivity layers.

Output the complete draw.io XML now (start immediately with <mxGraphModel):
`
        : `Generate a UML SEQUENCE diagram in draw.io XML for this MuleSoft solution:

${architectureSolution}

STEP 1 — Identify the participants from left to right:
Extract the key actors/systems involved (e.g. Client, Experience API, Process API, System API, Database/Backend).
List them in order they appear in the flow.

STEP 2 — Identify the message sequence:
Extract the numbered request/response messages between participants.
Requests go left→right (solid arrow). Responses go right→left (dashed arrow).

STEP 3 — Generate the draw.io XML using EXACTLY this coordinate system:
- Participant boxes: y=40, height=50, width=140
- Space participants 220px apart: participant[0].x=60, participant[1].x=280, participant[2].x=500, participant[3].x=720, participant[4].x=940
- Each participant's lifeline centerX = participant.x + 70
- Lifeline starts at y=90, ends at y = 90 + (numberOfMessages * 60) + 60
- Message arrows start at y=140, then y=200, y=260, y=320 ... (increment by 60 per message)
- Use EXPLICIT mxPoint sourcePoint/targetPoint coordinates for ALL lifelines and arrows
- DO NOT use source= or target= attributes on lifeline or arrow edges — use only mxPoint elements
- Request arrows: endArrow=block;endFill=1;strokeColor=#000000;strokeWidth=1.5
- Response arrows: endArrow=open;endFill=0;strokeColor=#555555;strokeWidth=1.5;dashed=1
- Label each arrow: value="N: methodName(params)"

Follow the example in your instructions exactly — same XML structure, same use of mxPoint.
Include ALL participants and ALL messages from the architecture. Minimum 6 messages.

Output the complete draw.io XML now (start immediately with <mxGraphModel):
`;

    let xmlRaw = await this.askWithSystemPrompt(
      systemPrompt,
      prompt,
      { temperature: 0.1, maxTokens: 6000 }
    );

    // ── Clean up the LLM response ───────────────────────────────────
    // Strip any markdown fences
    let xml = xmlRaw
      .replace(/^```(?:xml|drawio|html)?\s*/im, '')
      .replace(/```\s*$/im, '')
      .trim();

    // Strip any preamble text before <mxGraphModel
    const startIdx = xml.indexOf('<mxGraphModel');
    if (startIdx > 0) {
      xml = xml.substring(startIdx);
    }

    // Strip anything after </mxGraphModel>
    const endIdx = xml.lastIndexOf('</mxGraphModel>');
    if (endIdx !== -1) {
      xml = xml.substring(0, endIdx + '</mxGraphModel>'.length);
    }

    // ── Validate the XML is usable ─────────────────────────────────
    let isValid = xml.startsWith('<mxGraphModel') && xml.endsWith('</mxGraphModel>');

    if (isValid && isTopology) {
      const topologyResult = this._normalizeAndValidateTopologyXml(xml);
      xml = topologyResult.xml;
      isValid = topologyResult.valid;
      if (!isValid) {
        console.warn(
          `⚠️ Topology validation failed: ${topologyResult.issues.join('; ')}`
        );
      } else {
        console.log(
          `✅ Topology normalized (${topologyResult.metrics.vertices} vertices, ` +
          `${topologyResult.metrics.edges} connections)`
        );
      }
    }

    if (!isValid) {
      if (retryCount < maxRetries) {
        console.warn(`⚠️ draw.io XML invalid for ${diagramType} diagram, retry ${retryCount + 1}/${maxRetries}`);
        return this.generateDrawioDiagram(architectureSolution, diagramType, retryCount + 1);
      }
      console.error(`❌ draw.io XML still invalid after ${maxRetries} retries — using fallback`);
      xml = this._fallbackXml(diagramType, architectureSolution);
    }

    const diagramLabel = isTopology
      ? 'Network Topology Diagram'
      : (isSequence ? 'Sequence Diagram' : 'Architecture Diagram');
    const diagramUrl = await this._buildDrawioUrl(xml, diagramLabel);
    console.log(`✅ draw.io ${diagramType} diagram ready (${xml.length} chars)`);
    return { xml, diagramUrl, diagramType, tool: 'drawio' };
  }

  /**
   * Valid fallback draw.io XML when LLM keeps producing malformed output.
   * Architecture: 3-layer MuleSoft stack. Sequence: 4-participant UML sequence.
   */
  _fallbackXml(diagramType, architectureSolution) {
    if (diagramType === 'sequence') {
      return `<mxGraphModel dx="1422" dy="762" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1654" pageHeight="827" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Client" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#000000;fontStyle=1;fontSize=12;" vertex="1" parent="1"><mxGeometry x="60" y="40" width="140" height="50" as="geometry"/></mxCell><mxCell id="3" value="Experience API" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontStyle=1;fontSize=12;" vertex="1" parent="1"><mxGeometry x="280" y="40" width="140" height="50" as="geometry"/></mxCell><mxCell id="4" value="Process API" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontStyle=1;fontSize=12;" vertex="1" parent="1"><mxGeometry x="500" y="40" width="140" height="50" as="geometry"/></mxCell><mxCell id="5" value="Database" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontStyle=1;fontSize=12;" vertex="1" parent="1"><mxGeometry x="720" y="40" width="140" height="50" as="geometry"/></mxCell><mxCell id="6" value="" style="endArrow=none;dashed=1;strokeColor=#000000;strokeWidth=1;" edge="1" parent="1"><mxGeometry relative="0" as="geometry"><mxPoint x="130" y="90" as="sourcePoint"/><mxPoint x="130" y="550" as="targetPoint"/></mxGeometry></mxCell><mxCell id="7" value="" style="endArrow=none;dashed=1;strokeColor=#000000;strokeWidth=1;" edge="1" parent="1"><mxGeometry relative="0" as="geometry"><mxPoint x="350" y="90" as="sourcePoint"/><mxPoint x="350" y="550" as="targetPoint"/></mxGeometry></mxCell><mxCell id="8" value="" style="endArrow=none;dashed=1;strokeColor=#000000;strokeWidth=1;" edge="1" parent="1"><mxGeometry relative="0" as="geometry"><mxPoint x="570" y="90" as="sourcePoint"/><mxPoint x="570" y="550" as="targetPoint"/></mxGeometry></mxCell><mxCell id="9" value="" style="endArrow=none;dashed=1;strokeColor=#000000;strokeWidth=1;" edge="1" parent="1"><mxGeometry relative="0" as="geometry"><mxPoint x="790" y="90" as="sourcePoint"/><mxPoint x="790" y="550" as="targetPoint"/></mxGeometry></mxCell><mxCell id="10" value="1: apiRequest(data)" style="endArrow=block;endFill=1;strokeColor=#000000;strokeWidth=1.5;fontSize=11;align=center;verticalAlign=bottom;" edge="1" parent="1"><mxGeometry relative="0" as="geometry"><mxPoint x="130" y="140" as="sourcePoint"/><mxPoint x="350" y="140" as="targetPoint"/></mxGeometry></mxCell><mxCell id="11" value="2: processRequest(data)" style="endArrow=block;endFill=1;strokeColor=#000000;strokeWidth=1.5;fontSize=11;align=center;verticalAlign=bottom;" edge="1" parent="1"><mxGeometry relative="0" as="geometry"><mxPoint x="350" y="200" as="sourcePoint"/><mxPoint x="570" y="200" as="targetPoint"/></mxGeometry></mxCell><mxCell id="12" value="3: queryData(params)" style="endArrow=block;endFill=1;strokeColor=#000000;strokeWidth=1.5;fontSize=11;align=center;verticalAlign=bottom;" edge="1" parent="1"><mxGeometry relative="0" as="geometry"><mxPoint x="570" y="260" as="sourcePoint"/><mxPoint x="790" y="260" as="targetPoint"/></mxGeometry></mxCell><mxCell id="13" value="4: queryResults" style="endArrow=open;endFill=0;strokeColor=#555555;strokeWidth=1.5;dashed=1;fontSize=11;align=center;verticalAlign=bottom;" edge="1" parent="1"><mxGeometry relative="0" as="geometry"><mxPoint x="790" y="320" as="sourcePoint"/><mxPoint x="570" y="320" as="targetPoint"/></mxGeometry></mxCell><mxCell id="14" value="5: processedResponse" style="endArrow=open;endFill=0;strokeColor=#555555;strokeWidth=1.5;dashed=1;fontSize=11;align=center;verticalAlign=bottom;" edge="1" parent="1"><mxGeometry relative="0" as="geometry"><mxPoint x="570" y="380" as="sourcePoint"/><mxPoint x="350" y="380" as="targetPoint"/></mxGeometry></mxCell><mxCell id="15" value="6: apiResponse(result)" style="endArrow=open;endFill=0;strokeColor=#555555;strokeWidth=1.5;dashed=1;fontSize=11;align=center;verticalAlign=bottom;" edge="1" parent="1"><mxGeometry relative="0" as="geometry"><mxPoint x="350" y="440" as="sourcePoint"/><mxPoint x="130" y="440" as="targetPoint"/></mxGeometry></mxCell></root></mxGraphModel>`;
    }
    if (diagramType === 'topology') {
      return `<mxGraphModel dx="1422" dy="762" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1654" pageHeight="827" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="External" style="swimlane;html=1;rounded=0;startSize=30;horizontal=1;fillColor=#f5f5f5;strokeColor=#78909c;fontStyle=1;fontSize=12;" vertex="1" parent="1"><mxGeometry x="40" y="60" width="260" height="560" as="geometry"/></mxCell><mxCell id="3" value="Security / Boundary" style="swimlane;html=1;rounded=0;startSize=30;horizontal=1;fillColor=#fff8e1;strokeColor=#d79b00;fontStyle=1;fontSize=12;" vertex="1" parent="1"><mxGeometry x="340" y="60" width="280" height="560" as="geometry"/></mxCell><mxCell id="4" value="Internal Mule Runtime" style="swimlane;html=1;rounded=0;startSize=30;horizontal=1;fillColor=#e3f2fd;strokeColor=#6c8ebf;fontStyle=1;fontSize=12;" vertex="1" parent="1"><mxGeometry x="660" y="60" width="360" height="560" as="geometry"/></mxCell><mxCell id="5" value="Backend / Enterprise" style="swimlane;html=1;rounded=0;startSize=30;horizontal=1;fillColor=#e8f5e9;strokeColor=#82b366;fontStyle=1;fontSize=12;" vertex="1" parent="1"><mxGeometry x="1060" y="60" width="300" height="560" as="geometry"/></mxCell><mxCell id="6" value="External Client / Partner" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;fontSize=11;" vertex="1" parent="1"><mxGeometry x="90" y="280" width="160" height="60" as="geometry"/></mxCell><mxCell id="7" value="API Gateway / Ingress" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;fontSize=11;" vertex="1" parent="1"><mxGeometry x="400" y="210" width="160" height="60" as="geometry"/></mxCell><mxCell id="8" value="Policy Enforcement Layer" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontStyle=1;fontSize=11;" vertex="1" parent="1"><mxGeometry x="400" y="350" width="160" height="60" as="geometry"/></mxCell><mxCell id="9" value="Experience API" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=11;" vertex="1" parent="1"><mxGeometry x="710" y="170" width="160" height="60" as="geometry"/></mxCell><mxCell id="10" value="Process API" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontSize=11;" vertex="1" parent="1"><mxGeometry x="710" y="300" width="160" height="60" as="geometry"/></mxCell><mxCell id="11" value="System API" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=11;" vertex="1" parent="1"><mxGeometry x="710" y="430" width="160" height="60" as="geometry"/></mxCell><mxCell id="12" value="Enterprise System" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontSize=11;" vertex="1" parent="1"><mxGeometry x="1130" y="280" width="170" height="60" as="geometry"/></mxCell><mxCell id="13" value="HTTPS" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;exitX=1;exitY=0.5;entryX=0;entryY=0.5;endArrow=block;endFill=1;strokeColor=#263238;strokeWidth=2.5;fontSize=11;fontStyle=1;labelBackgroundColor=#ffffff;" edge="1" source="6" target="7" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell><mxCell id="14" value="HTTPS" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;exitX=1;exitY=0.5;entryX=0;entryY=0.5;endArrow=block;endFill=1;strokeColor=#263238;strokeWidth=2.5;fontSize=11;fontStyle=1;labelBackgroundColor=#ffffff;" edge="1" source="7" target="8" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell><mxCell id="15" value="HTTPS" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;exitX=1;exitY=0.5;entryX=0;entryY=0.5;endArrow=block;endFill=1;strokeColor=#263238;strokeWidth=2.5;fontSize=11;fontStyle=1;labelBackgroundColor=#ffffff;" edge="1" source="8" target="9" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell><mxCell id="16" value="Internal HTTPS" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;exitX=1;exitY=0.5;entryX=0;entryY=0.5;endArrow=block;endFill=1;strokeColor=#263238;strokeWidth=2.5;fontSize=11;fontStyle=1;labelBackgroundColor=#ffffff;" edge="1" source="9" target="10" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell><mxCell id="17" value="Internal HTTPS" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;exitX=1;exitY=0.5;entryX=0;entryY=0.5;endArrow=block;endFill=1;strokeColor=#263238;strokeWidth=2.5;fontSize=11;fontStyle=1;labelBackgroundColor=#ffffff;" edge="1" source="10" target="11" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell><mxCell id="18" value="Backend Protocol" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;exitX=1;exitY=0.5;entryX=0;entryY=0.5;endArrow=block;endFill=1;strokeColor=#263238;strokeWidth=2.5;fontSize=11;fontStyle=1;labelBackgroundColor=#ffffff;" edge="1" source="11" target="12" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel>`;
    }
    // Architecture fallback
    return `<mxGraphModel dx="1422" dy="762" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="MuleSoft Architecture" style="text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;whiteSpace=wrap;rounded=0;fontSize=16;fontStyle=1;" vertex="1" parent="1"><mxGeometry x="400" y="40" width="360" height="40" as="geometry"/></mxCell><mxCell id="3" value="Experience API Layer" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontStyle=1;fontSize=11;" vertex="1" parent="1"><mxGeometry x="180" y="120" width="160" height="60" as="geometry"/></mxCell><mxCell id="4" value="Process API Layer" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;fontStyle=1;fontSize=11;" vertex="1" parent="1"><mxGeometry x="180" y="240" width="160" height="60" as="geometry"/></mxCell><mxCell id="5" value="System API Layer" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontStyle=1;fontSize=11;" vertex="1" parent="1"><mxGeometry x="180" y="360" width="160" height="60" as="geometry"/></mxCell><mxCell id="6" value="Backend / Database" style="shape=cylinder3;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;" vertex="1" parent="1"><mxGeometry x="180" y="480" width="160" height="70" as="geometry"/></mxCell><mxCell id="7" style="rounded=0;orthogonalLoop=1;jettySize=auto;exitX=0.5;exitY=1;entryX=0.5;entryY=0;endArrow=block;endFill=1;" edge="1" source="3" target="4" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell><mxCell id="8" style="rounded=0;orthogonalLoop=1;jettySize=auto;exitX=0.5;exitY=1;entryX=0.5;entryY=0;endArrow=block;endFill=1;" edge="1" source="4" target="5" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell><mxCell id="9" style="rounded=0;orthogonalLoop=1;jettySize=auto;exitX=0.5;exitY=1;entryX=0.5;entryY=0;endArrow=block;endFill=1;" edge="1" source="5" target="6" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel>`;
  }

  /**
   * Encode draw.io XML into the canonical diagrams.net URL format:
   *   https://app.diagrams.net/#R<percent-encoded deflate+base64 of mxfile XML>
   *
   * The mxfile wrapper is required — diagrams.net rejects bare mxGraphModel fragments.
   * We use pako (deflate) to compress, then base64, then percent-encode the result.
   *
   * If pako is unavailable we fall back to a plain ?xml= URL which is still functional.
   */
  async _buildDrawioUrl(xml, diagramName = 'Architecture') {
    try {
      // Wrap the mxGraphModel in an mxfile envelope
      const safeName = diagramName.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Diagram';
      const mxfile = `<mxfile host="app.diagrams.net"><diagram name="${safeName}" id="diag1">${xml}</diagram></mxfile>`;

      let encoded;
      try {
        // Try pako (deflate) compression — produces the compact #R format
        const pako = (await import('pako')).default;
        const deflated = pako.deflateRaw(
          new TextEncoder().encode(mxfile),
          { level: 9 }
        );
        // base64 encode the binary data
        const b64 = Buffer.from(deflated).toString('base64');
        encoded = encodeURIComponent(b64);
        return `https://app.diagrams.net/#R${encoded}`;
      } catch (pakoErr) {
        // pako not available — fall back to percent-encoding the full mxfile XML
        console.warn('pako not available, using plain XML encoding:', pakoErr.message);
        encoded = encodeURIComponent(mxfile);
        return `https://app.diagrams.net/#R${encoded}`;
      }
    } catch (e) {
      console.error('Error building draw.io URL:', e);
      return 'https://app.diagrams.net/';
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Orchestration
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * @deprecated — replaced by the new use-case flow.
   *
   * The new flow is:
   *   1. generateMasterArchitectureDiagram(architecture, useCases) → one component diagram
   *   2. generateUseCaseSequenceDiagram(architecture, useCase)     → one sequence per use case
   *
   * This method is kept only to avoid breaking any remaining CLI / non-UI callers.
   * For the UI flow it is never called — the A2A handler now only generates the
   * component diagram, and sequence diagrams are generated per use case from the Diagram tab.
   */
  async generateAllDiagrams(architectureSolution) {
    console.warn('⚠️ generateAllDiagrams() is deprecated. Use generateMasterArchitectureDiagram() + generateUseCaseSequenceDiagram() instead.');
    // Delegate to component-only generation — never generate a generic sequence anymore
    const r = await this.generateDrawioDiagram(architectureSolution, 'component');
    return { component: r.diagramUrl, sequence: null, tool: 'drawio' };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Use-case extraction + per-use-case / master diagram generation
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Break an architecture solution into discrete, individual use cases.
   * Returns an array of { id, name, description }. Robust to non-JSON LLM output.
   */
  async extractUseCases(architectureSolution) {
    if (!architectureSolution) throw new Error("Architecture solution is required.");

    const systemPrompt = `You are a senior MuleSoft business analyst. Your job is to identify the TOP-LEVEL BUSINESS USE CASES in an integration architecture.

CRITICAL RULES:
- A use case is a complete, end-to-end BUSINESS SCENARIO (e.g. "Customer Registration", "Order Management", "Payment Processing").
- A use case is NOT a technical step, sub-step, API endpoint, or implementation detail.
- NEVER split one business scenario into multiple use cases. Example: "Validate user", "Create user record", "Send welcome email" are NOT three use cases — they are all steps inside ONE use case called "Customer Registration".
- Think: "What business goal does the user or system want to achieve?" — that is ONE use case.
- Aim for 3–6 use cases total for a typical integration. Only go above 6 if the architecture truly covers more than 6 completely separate business domains.Output STRICT JSON only — no markdown, no prose, no code fences.`;

    const prompt = `From the MuleSoft architecture below, identify the distinct TOP-LEVEL BUSINESS USE CASES.

ARCHITECTURE:
${architectureSolution}

EXAMPLES OF CORRECT GROUPING:
- "Customer Registration" covers: form submission, validation, Salesforce upsert, welcome email — all ONE use case.
- "Order Processing" covers: order creation, inventory check, payment, fulfilment notification — all ONE use case.
- "Product Sync" covers: pull from ERP, transform, push to eCommerce — all ONE use case.

Rules:
- Output between 3 and 6 use cases (never more unless the architecture truly covers that many separate businesses).
- Each use case must be a separate top-level BUSINESS CAPABILITY, not a step or technical detail.
- "name" = short business title (2–5 words). "description" = ONE sentence covering the end-to-end flow and key systems.

Output ONLY this JSON shape — nothing else:
{"useCases":[{"name":"...","description":"..."}]}`;

    const raw = await this.askWithSystemPrompt(systemPrompt, prompt, { temperature: 0.2, maxTokens: 1500 });
    const useCases = this._parseUseCases(raw);
    console.log(`✅ Extracted ${useCases.length} use case(s) from architecture`);
    return useCases;
  }

  /** Parse use cases out of an LLM response, tolerating fences / preamble. */
  _parseUseCases(raw) {
    if (!raw || typeof raw !== 'string') return [];
    let text = raw.replace(/```(?:json)?/gi, '').trim();

    let arr = [];
    try {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start !== -1 && end !== -1) {
        const parsed = JSON.parse(text.substring(start, end + 1));
        arr = parsed.useCases || parsed.use_cases || parsed.usecases || [];
      }
    } catch (_) {
      arr = [];
    }

    // Fallback: parse bullet/numbered lines "Name - description"
    if (!Array.isArray(arr) || arr.length === 0) {
      const lines = text.split('\n')
        .map(l => l.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').trim())
        .filter(l => l.length > 8);
      arr = lines.slice(0, 8).map(l => {
        const [name, ...rest] = l.split(/[-–:]/);
        return { name: (name || l).trim(), description: rest.join('-').trim() || l };
      });
    }

    return (Array.isArray(arr) ? arr : [])
      .map((u, i) => ({
        id: `uc_${Date.now()}_${i}`,
        name: (typeof u === 'string' ? u : (u.name || u.title || `Use Case ${i + 1}`)).toString().trim(),
        description: (typeof u === 'string' ? '' : (u.description || u.desc || '')).toString().trim()
      }))
      .filter(u => u.name);
  }

  /**
   * Generate a SEQUENCE diagram scoped to a single use case.
   * Reuses the hardened generateDrawioDiagram generator with a focused context.
   */
  async generateUseCaseSequenceDiagram(architectureSolution, useCase, diagramContext = null) {
    if (!useCase || !useCase.name) throw new Error("A use case with a name is required.");
    const compactContext = diagramContext || this.createDiagramContext(architectureSolution, [useCase]);

    const scoped = `FOCUS USE CASE: ${useCase.name}
${useCase.description ? `Use case description: ${useCase.description}\n` : ''}
Generate the sequence diagram ONLY for the "${useCase.name}" use case described above.
Show just the participants and message flow that this specific use case touches — not the entire platform.

COMPACT ARCHITECTURE CONTEXT (for systems, APIs, participants, and protocols):
${compactContext}`;

    const r = await this.generateDrawioDiagram(scoped, 'sequence');
    return { diagramUrl: r.diagramUrl, tool: 'drawio' };
  }

  /**
   * Generate ONE master/component ARCHITECTURE diagram covering ALL use cases
   * at a high level (no internal detail). Reuses generateDrawioDiagram('component').
   */
  async generateMasterArchitectureDiagram(architectureSolution, useCases = [], diagramContext = null) {
    const list = (Array.isArray(useCases) ? useCases : [])
      .map((u, i) => `${i + 1}. ${u.name}${u.description ? ` — ${u.description}` : ''}`)
      .join('\n');
    const compactContext = diagramContext || this.createDiagramContext(architectureSolution, useCases);

    const scoped = `MASTER / HIGH-LEVEL ARCHITECTURE DIAGRAM covering ALL of the following use cases together:
${list || '(no explicit use cases provided — derive from the architecture)'}

Show every use case at a HIGH LEVEL in a single combined architecture diagram (API-led layers + systems/databases).
Each use case must be represented. Do NOT show internal step-by-step detail — keep it to the components and their connections.

COMPACT ARCHITECTURE CONTEXT:
${compactContext}`;

    const r = await this.generateDrawioDiagram(scoped, 'component');
    return { diagramUrl: r.diagramUrl, tool: 'drawio' };
  }

  async generateNetworkTopologyDiagram(architectureSolution, useCases = [], diagramContext = null) {
    const list = (Array.isArray(useCases) ? useCases : [])
      .map((u, i) => `${i + 1}. ${u.name}${u.description ? ` — ${u.description}` : ''}`)
      .join('\n');
    const compactContext = diagramContext || this.createDiagramContext(architectureSolution, useCases);

    const scoped = `NETWORK TOPOLOGY DIAGRAM for this MuleSoft solution.

Use cases to cover:
${list || '(no explicit use cases provided — derive from the architecture)'}

Create ONE combined network topology diagram. Internally split it into clearly labeled zones:
1. External Zone: external users, partner apps, public internet, public ingress, external-facing Experience APIs.
2. Security / Boundary Zone: WAF/firewall, API gateway, load balancer/ingress, and one generic box labeled "Policy Enforcement Layer".
3. Internal Zone: private Mule runtime network, Process APIs, System APIs, queues, object stores, caches, internal services.
4. Backend / Enterprise Zone: SAP, Salesforce, databases, mainframe, SFTP servers, or other backend systems from the architecture.

Show where protocol changes happen. Label every connection with the protocol or transport, such as HTTPS/REST, MQ, Kafka, SFTP, JDBC, SAP RFC, IDoc, OData, SOAP, PrivateLink, VPN, or internal HTTPS.
Make external APIs visually separate from internal APIs. Show public-to-private boundaries and security controls.
Do NOT display individual API policy names or create separate boxes for policies such as OAuth, mTLS, rate limiting, client enforcement, threat protection, or CORS. Represent all API policies only through the single "Policy Enforcement Layer" box.
Do not show detailed sequence steps; this is topology and connectivity, not flow timing.

COMPACT ARCHITECTURE CONTEXT:
${compactContext}`;

    const r = await this.generateDrawioDiagram(scoped, 'topology');
    return { diagramUrl: r.diagramUrl, tool: 'drawio' };
  }

  async saveDiagram(diagramContent, filePath) {
    const fsExtra = (await import("fs-extra")).default;
    await fsExtra.writeFile(filePath, diagramContent, "utf-8");
  }

  delay(ms) { return new Promise(r => setTimeout(r, ms)); }
}

export default DiagramGenerationAgent;
