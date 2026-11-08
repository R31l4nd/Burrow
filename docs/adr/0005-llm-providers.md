# 5. LLM providers: local first, Claude optional

Date: 2026-09-26 - Status: accepted

## Context

AI features (text to command now, log analysis and reports later) must work
for people who do not want to send anything off their network, and should be
able to use a stronger hosted model when wanted.

## Decision

- One provider interface returning schema-validated output.
- Ollama (local) is the recommended choice; no provider is set until the
  admin picks one. Claude uses the official Anthropic TypeScript SDK with
  structured output (`messages.parse` + zod) and low effort for short
  tasks; default model `claude-sonnet-5`.
  Any OpenAI-compatible server works for everything else. Gemini (added
  2.14.0) is its own choice on that client, at Google's OpenAI-compatible
  endpoint: a key and a model, always external like Claude.
- Burrow sends only what the task needs; for text to command that is the
  question and host context without identity. Masking of logs is mandatory
  before they go to a hosted model (0.10.0).
- Model output is advisory: commands are never executed by Burrow, and
  deterministic risk rules can only raise a risk label.

## Consequences

The Claude API is billed per use and separately from Claude Pro/Max
subscriptions; the UI says so. Structured output needs a model that supports
it; small local models are given the JSON schema through Ollama's `format`.
