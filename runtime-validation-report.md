# Runtime Validation Report

**Generated**: 2026-10-12  
**Target**: `pulsecast-adaptive`

## Summary

| Step | Status | Exit code | Details |
|---|---|---:|---|
| Backend syntax/import | PASS | 0 | `py_compile` and FastAPI import succeeded |
| Backend regression, priority, targeted delivery, and security tests | PASS | 0 | 22 tests passed, including selected-only delivery, offline target handling, adaptive delivery, priority gating, expiry, and one-time encrypted-share lifecycle |
| Frontend production build | PASS | 0 | `npm run build` completed successfully |
| Backend startup/readiness | PASS | 0 | Uvicorn started from both repository root and `backend/`; `/api/config` reported AI configured without returning a key; multipart priority broadcasts accepted |
| Summarization smoke check | PASS | 0 | Long announcement with location, date, time, destination, numbers, and action returned an editable offline summary with critical-detail validation; live Groq response was not confirmed |
| Secure-share API smoke flow | PASS | 0 | Created, retrieved opaque ciphertext, and consumed a one-time token |
| Browser UI smoke check | PASS | n/a | Vite rendered the composer, language controls, emergency templates, QR generator, targeted receiver panel, and receiver cards |
| Send announcement smoke check | PASS | 0 | Sent to one receiver and three receivers in the browser; dashboard stayed rendered and returned to the normal send state |

**Overall**: PASS for implemented and locally verifiable behavior.

## Environment

- Node.js: available (`v24.13.0`)
- npm: available (`11.6.2`)
- Docker: unavailable; this demo uses in-memory state and needs no external infrastructure
- Playwright CLI: not installed; the integrated browser smoke check was used instead
- Python: project virtual environment at `pulse\Scripts\python.exe`
- Environment loading: `backend/.env` resolved successfully from both repository-root and `backend/` startup contexts

## Coverage and known gaps

- Groq translation/summarization success requires a valid, non-rejected `GROQ_API_KEY`; the configured environment returned the safe offline path during this run, so live provider success remains unverified.
- Browser E2E was not rerun for the targeted-delivery UI in this pass; production compilation and backend delivery tests passed.
- The Groq failure path uses reviewed templates/manual text; no key is exposed to the frontend.
- The dashboard no longer renders the Secure QR Sharing interface; the ordinary QR generator remains local-only and does not encode secrets securely.
- Physical-phone QR scanning and download verification were not performed in this pass.
- The send-flow crash caused by a missing `formatKbps` import was reproduced and fixed; malformed receiver frames and invalid delivery responses now fail safely without replacing the dashboard.
