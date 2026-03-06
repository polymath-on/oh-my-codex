---
name: analyze
description: Investigation router for root-cause, architecture, and dependency analysis
---

<Purpose>
Analyze is a routing shortcut for investigation work. It defaults to the `debugger` lane for root-cause analysis and regressions, and escalates to `architect` when the job is primarily about system boundaries, structural tradeoffs, or dependency impact.
</Purpose>

<Use_When>
- User says "analyze", "investigate", "debug", "why does", or "what's causing"
- User needs root-cause analysis for a failure, regression, or confusing runtime behavior
- User needs to understand architecture, dependency impact, or system boundaries before making changes
- A complex question requires reading multiple files and returning evidence-backed findings
</Use_When>

<Do_Not_Use_When>
- User wants code changes made -- use executor agents or `ralph` instead
- User wants a full plan with acceptance criteria -- use `plan` skill instead
- User wants a general code-quality review -- use `code-review` instead
- User wants a dedicated trust-boundary / OWASP audit -- use `security-review` instead
- User wants a quick file lookup or symbol search -- use `explore` instead
</Do_Not_Use_When>

<Why_This_Exists>
Investigation work is broader than a single role name. Some requests are bug/root-cause questions that belong with `debugger`; others are structural or dependency questions that belong with `architect`. Analyze keeps one user-facing shortcut while routing to the sharper canonical owner.
</Why_This_Exists>

<Routing_Defaults>
- **Default owner: `debugger`** for failures, regressions, "why is this broken", stack traces, reproduction, and causal diagnosis.
- **Route to `architect`** for architecture review, interface boundaries, dependency impact, system behavior across modules, and structural diagnosis.
- **Use `explore` first** when the request is broad and you need a fast file/symbol map before deeper reasoning.
- **Tie-breaker:** if a request mixes failure diagnosis and architecture concerns, lead with `debugger` unless the dominant need is clearly structural/design-oriented.
</Routing_Defaults>

<Routing_Signals>

| Signal in request | Route | Why |
|---|---|---|
| regression, broken, failing, stack trace, crash, flaky, root cause, why is this broken | `debugger` | Causal diagnosis and reproduction come first |
| boundaries, interface, dependency impact, architecture, module interaction, tradeoff, system design | `architect` | Structural/system reasoning comes first |
| broad surface area with unclear files/symbols | `explore` first, then `architect`/`debugger` | Map the code before deep reasoning |

</Routing_Signals>

<Execution_Policy>
- Treat Analyze as a router, not a standalone public specialist
- Gather concrete context before delegating or reasoning deeply
- Return structured findings with evidence, file references, and clear next actions
- Distinguish confirmed facts from hypotheses
</Execution_Policy>

<Steps>
1. **Classify the investigation**: root-cause/debugging vs architecture/dependency/structural analysis
2. **Gather context**: read the key files or use `explore` to map relevant code paths
3. **Route to the canonical owner**:
   - `debugger` for failures, regressions, causality, and reproduction work
   - `architect` for boundaries, tradeoffs, and structural/system analysis
   - if both appear, prefer `debugger` first unless the user is clearly asking for architectural judgment
4. **Synthesize findings**: summarize the diagnosis, evidence, remaining uncertainty, and recommended next step
</Steps>

<Tool_Usage>
- Prefer direct repo inspection or MCP code-intel tools for grounded analysis
- Use `lsp_diagnostics`, `lsp_find_references`, and `ast_grep_search` when they sharpen the investigation
- For broad requests, map the surface area first, then hand off to the appropriate canonical role
</Tool_Usage>

<Examples>
<Good>
User: "analyze why the WebSocket connections drop after 30 seconds"
Action: Route to `debugger`, reproduce or inspect the failure path, and return a root-cause analysis with concrete evidence.
Why good: This is a causal diagnosis request.
</Good>

<Good>
User: "investigate the dependency impact of moving team state into a shared module"
Action: Route to `architect`, inspect module boundaries and imports, and return tradeoffs plus impacted files.
Why good: This is a structural/dependency analysis request.
</Good>

<Bad>
User: "review this refactor for maintainability"
Action: Running Analyze.
Why bad: This is code-quality review work; use `code-review`.
</Bad>

<Bad>
User: "security review the auth changes"
Action: Running Analyze.
Why bad: Trust-boundary and OWASP review should go to `security-review`.
</Bad>
</Examples>

<Escalation_And_Stop_Conditions>
- If analysis shows the real next step is implementation, report findings and recommend executor / `ralph`
- If the request mixes debugging and architecture, lead with the dominant owner, use `debugger` as the default tie-breaker, and call out the secondary handoff explicitly
- If the scope is too broad ("analyze everything"), narrow it before proceeding
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] Investigation is routed to the right canonical owner (`debugger` by default, `architect` when structural)
- [ ] Findings cite the relevant files and evidence where applicable
- [ ] Root causes are separated from symptoms for bug investigations
- [ ] Recommended next actions are explicit
- [ ] Facts and hypotheses are clearly distinguished
</Final_Checklist>

Task: {{ARGUMENTS}}
