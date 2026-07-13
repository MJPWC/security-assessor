# MuleGenie Quality Test Plan

## Purpose

This document defines the quality tests for MuleGenie before dev deployment and later production readiness. It focuses on functional correctness, AI workflow reliability, UI behavior, session/state handling, observability, provider fallback, and regression coverage.

## Test Result Legend

| Status | Meaning |
| --- | --- |
| Not Started | Test has not been executed yet. |
| Passed | Actual result matched expected result. |
| Failed | Actual result did not match expected result. |
| Blocked | Test cannot be completed due to missing setup, environment issue, or dependency. |
| Manual Review | Requires human judgment or deployed-environment evidence. |

## 1. Functional Workflow Tests

| Test Case | Steps | Expected Result | Actual Result | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| General Q&A | Ask: `What is MuleSoft?` | App returns a direct general answer and does not start architecture workflow. | Worked as expected. | Passed | Confirms general routing. |
| Architecture workflow | Ask: `Design an API-led MuleSoft architecture for syncing customer data from Salesforce to SAP.` | App asks useful clarifying questions or provides architecture approaches. | App asked architecture clarifying questions. | Passed | Core workflow. |
| Clarifying question validation | Submit irrelevant/vague answers to required architecture questions. | App keeps the question modal open and asks user to answer again with friendly message. | App showed "Some answers are not relevant", identified the weak question/answer, and returned user to the question panel to rewrite answers. | Passed | Previously fixed area. |
| Approach selection | Select one generated approach. | App accepts selected approach and moves to next workflow step. | Approach selection completed and workflow moved forward without reported error. | Passed | Validates architecture handoff. |
| Diagram/use-case flow | Generate diagram/use cases from completed architecture. | Use cases/diagram flow completes without corrupting architecture output. | Diagram tab extracted all use-case scenarios, allowed editing and re-extraction, generated a good diagram, preserved the Architecture tab response, and did not stay stuck loading. | Passed | If diagram feature is enabled. |
| Estimation workflow | Generate estimation after architecture/use cases are available. | Estimation is generated with readable effort/breakdown. | Auto-populated user stories looked correct. Estimation used current architecture/use cases, streamed like architecture output, produced task-based breakdown with sub-tasks such as 1.1/1.2/1.3, and completed without popup, lag, or stuck loading. | Passed | Checks dependency on previous outputs. |
| RAML generation | Generate RAML from a valid API requirement. | RAML output is generated and contains no hardcoded credentials. | Initial test found RAML tab could show continuous running after estimation without RAML topics. Fix applied to emit/persist extracted RAML API topics and clear blank in-progress state. Retest required. | Failed - Retest Required | Core artifact workflow. |
| Documentation generation | Generate documentation from available architecture/RAML. | Documentation output is readable and consistent with inputs. | TBD | Not Started | Final deliverable workflow. |
| Download/export actions | Use available copy/download/export buttons. | Files download or content copies successfully. | TBD | Not Started | Validates user handoff. |

## 2. AI Workflow Quality Tests

| Test Case | Steps | Expected Result | Actual Result | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| Structured output validation | Generate architecture, RAML, estimation, and documentation. | Output follows expected structure for each artifact type. | TBD | Not Started | Validate headings, sections, RAML syntax, required fields. |
| Regression evaluation set | Run a fixed set of representative prompts and compare behavior assertions. | Outputs meet expected behavioral assertions without regressions. | TBD | Not Started | Should become repeatable test data. |
| Context window management | Use a long but valid requirement with multiple systems, APIs, constraints, and nonfunctional requirements. | App handles/truncates context predictably without losing critical requirements. | TBD | Not Started | Check no silent loss of important details. |
| Truncation strategy | Submit oversized but safe content near configured limits. | App either processes safely or gives clear size/scope guidance. | TBD | Not Started | Related to quality and request budget. |
| Multi-agent handoff correctness | Complete architecture to RAML/documentation workflow. | Downstream agents use correct selected architecture and do not mix stale/previous outputs. | TBD | Not Started | Agent handoff quality. |
| Loop and iteration guards | Give vague answers or prompts that could trigger repeated clarification loops. | App stops at a reasonable point and asks actionable questions without infinite loops. | TBD | Not Started | Protects UX and cost. |
| Provider fallback behavior | Simulate/observe provider failure and fallback. | Fallback response completes or app shows friendly error; no partial/stale output remains. | TBD | Not Started | Security tests cover data safety; quality checks UX. |
| Token/cost observability | Run one workflow and inspect token/cost dashboard or usage output. | Token usage is visible per request/session/provider where supported. | TBD | Not Started | Helps operational monitoring. |
| Response caching/state correctness | Refresh/reopen session after successful and failed prompts. | App restores or clears state according to expected session rules; no stale answer shown for new prompt. | TBD | Not Started | If no true cache exists, treat as persistence correctness. |

## 3. Streaming Response Handling Tests

| Test Case | Steps | Expected Result | Actual Result | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| Architecture streaming starts | Trigger architecture generation. | Architecture tab shows generating only while stream is active. | TBD | Not Started | UI indicator correctness. |
| Streaming chunks render | Observe long architecture/estimation response while generating. | Chunks appear in correct order without duplicate text. | TBD | Not Started | Requires live browser observation. |
| Stream completion | Wait until stream finishes. | Generating indicator stops and final output remains visible. | TBD | Not Started | Previously saw stuck state. |
| Stream failure | Trigger provider/guardrail failure during workflow. | Error is friendly, tab stops running, and partial output does not corrupt state. | TBD | Not Started | Negative streaming path. |
| Refresh during stream | Refresh browser while response is streaming. | App reconnects cleanly or starts a safe fresh state without duplicate submission. | TBD | Not Started | Important runtime quality. |

## 4. UI/UX And Error Handling Tests

| Test Case | Steps | Expected Result | Actual Result | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| No browser alert popups | Trigger validation/provider/guardrail errors. | Errors appear in app overlay/modal, not browser alert. | TBD | Not Started | Security UX fix. |
| Friendly guardrail error | Submit blocked prompt. | User sees generic readable message without technical stack/guardrail details. | TBD | Not Started | Manual browser test. |
| Provider failure message | Use invalid/missing provider key or simulate provider failure. | App shows friendly provider/account/key/quota message. | TBD | Not Started | Negative workflow. |
| Loading indicators | Trigger success and failure workflows. | Loading indicators start and stop correctly on every tab. | TBD | Not Started | Includes architecture/RAML/document tabs. |
| Long response rendering | Generate long architecture or documentation response. | Content is readable and not clipped/overlapping. | TBD | Not Started | UI quality. |
| Copy/download controls | Click copy/download buttons for generated outputs. | Controls work and show correct state. | TBD | Not Started | Basic usability. |
| Browser compatibility | Test in Chrome/Edge/Safari if required. | App works consistently in supported browsers. | TBD | Manual Review | Dev environment dependent. |

## 5. Session And Shared State Tests

| Test Case | Steps | Expected Result | Actual Result | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| New prompt clears previous output | Submit successful prompt, then submit a new prompt. | Previous output clears or is separated according to intended session behavior. | TBD | Not Started | Important for user trust. |
| Blocked prompt cleanup | Submit successful prompt, then blocked prompt, then refresh. | Old output is not shown as current result for blocked prompt. | TBD | Not Started | Previously fixed. |
| App restart cleanup | Stop app, relaunch, open browser. | Old output gone; fresh session starts. | TBD | Not Started | Current startup behavior. |
| WebSocket reconnect | Refresh browser or temporarily disconnect/reconnect. | Session reconnects without duplicate events or lost valid state. | TBD | Not Started | Runtime quality. |
| Multi-session isolation | Use two sessions/users where available. | Outputs, tokens, prompts, and downloads do not mix. | TBD | Not Started | Dev/prod important. |
| Concurrency/shared state safety | Run two users/sessions at the same time. | No cross-session leakage, duplicate state, or mixed outputs. | TBD | Not Started | Stronger test after dev deployment. |

## 6. Multi-Agent And Tool Handoff Tests

| Test Case | Steps | Expected Result | Actual Result | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| Manager classification | Submit general Q&A and architecture prompts. | Manager routes to correct workflow each time. | TBD | Not Started | Prevents wrong agent start. |
| Architecture to diagram handoff | Generate architecture then diagram/use cases. | Diagram/use cases match generated architecture. | TBD | Not Started | No stale architecture. |
| Architecture to RAML handoff | Generate RAML from selected architecture/API requirement. | RAML reflects selected requirement and API names. | TBD | Not Started | Core agent chain. |
| Architecture/RAML to documentation handoff | Generate docs after RAML/architecture. | Documentation matches current artifacts. | TBD | Not Started | Downstream consistency. |
| Tool call argument quality | Trigger supported tool-like workflow, such as RAML publish/generation if available. | Tool arguments are valid, expected, and tied to current session. | TBD | Not Started | Quality side of tool policy. |

## 7. Observability And Traceability Tests

| Test Case | Steps | Expected Result | Actual Result | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| End-to-end correlation ID | Run one full workflow and inspect server logs. | Related LLM/agent/tool steps share a trace/correlation ID. | TBD | Not Started | Helps debugging. |
| LLM/provider attempt visibility | Trigger normal and fallback paths. | Logs show provider attempts, fallback usage, and failures without secrets. | TBD | Not Started | No raw prompts/secrets. |
| Token usage recording | Run workflow and inspect token dashboard/CSV. | Token usage is recorded per request/session/provider where available. | TBD | Not Started | Cost observability. |
| Error trace usefulness | Trigger a friendly UI error and inspect backend logs. | Logs are useful for debugging but do not expose sensitive user data. | TBD | Not Started | Balance privacy/debugging. |

## 8. Performance And Load Tests

| Test Case | Steps | Expected Result | Actual Result | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| Normal prompt latency | Submit a simple general prompt. | Response returns in acceptable time for selected provider. | TBD | Not Started | Baseline. |
| Complex workflow latency | Run architecture/RAML/documentation flow. | Each stage completes within acceptable dev-environment time. | TBD | Not Started | Provider dependent. |
| Multiple concurrent sessions | Run two or more sessions in parallel. | App remains responsive and state remains isolated. | TBD | Not Started | Dev env smoke test. |
| Large valid input | Submit large but valid requirement below budget. | App handles it or gives clear guidance without crash. | TBD | Not Started | Quality + robustness. |
| Resource usage | Observe CPU/memory during long generation. | No runaway memory/CPU for normal dev usage. | TBD | Manual Review | Environment dependent. |

## 9. Regression Test Set

These tests should be repeated after changes to prompts, agents, frontend state, security checks, provider handling, or session logic.

| Regression Item | Expected Behavior | Status |
| --- | --- | --- |
| Phishing prompt is blocked. | Generic unsafe-request error. | Not Started |
| Real credential prompt is blocked. | Generic credential error. | Not Started |
| Safe secure placeholders are allowed. | No false secret block. | Not Started |
| Request-budget prompt is blocked. | Generic request-too-large error. | Not Started |
| Architecture tab does not stay stuck after failure. | Loading indicator stops. | Not Started |
| Refresh after blocked prompt does not show stale success answer. | Clean/current state. | Not Started |
| Restart starts fresh session. | Old outputs gone. | Not Started |
| Invalid clarifying answer reopens question modal. | Same question flow continues. | Not Started |
| RAML generated output has no hardcoded credentials. | Valid/safe RAML. | Not Started |

## 10. Post-Deployment Quality Checks

These should be performed after deploying to a shared dev/staging environment.

| Check | Why It Matters | Suggested Evidence | Status |
| --- | --- | --- | --- |
| Dev environment smoke test | Confirms app works outside local machine. | Screenshots or test notes from deployed URL. | Manual Review |
| HTTPS/proxy behavior | Confirms auth/session/WebSocket behavior behind gateway. | Browser/network test evidence. | Manual Review |
| Two-user isolation test | Confirms deployed cookies/session/token behavior is safe. | Two-user test notes. | Manual Review |
| Production-like logging review | Confirms cloud logs do not leak raw prompts/completions/secrets. | Sample logs. | Manual Review |
| Provider quota/cost alert check | Confirms operational cost controls are active. | Provider dashboard screenshot or config note. | Manual Review |
| CI quality/security run | Confirms automated checks pass in CI, not only locally. | CI run URL or exported result. | Manual Review |

## Recommended First Execution Order

1. Functional Workflow Tests
2. UI/UX And Error Handling Tests
3. Session And Shared State Tests
4. AI Workflow Quality Tests
5. Streaming Response Handling Tests
6. Multi-Agent And Tool Handoff Tests
7. Observability And Traceability Tests
8. Performance And Load Tests
9. Regression Test Set
10. Post-Deployment Quality Checks
