# INDIALEGAL.AI

Voice-first legal document assistant. Upload a PDF, ask questions in any Indian language, hear grounded answers cited to the source page.

## Stack

- Node.js + Express
- Postgres (Render Singapore)
- Datalab Marker API for OCR → structured JSON
- OpenAI Realtime 2 (`gpt-realtime-2`) over WebRTC for voice
- Gemini File Search as RAG fallback for grounded text answers

## Endpoints

- `POST /api/cases` — upload a PDF, returns `{ id, status }`
- `GET /api/cases` — list cases
- `GET /api/cases/:id` — case detail
- `POST /api/cases/:id/voice-token` — ephemeral OpenAI Realtime token with the case prompt baked in
- `POST /api/cases/:id/ask` — text-only Gemini-grounded answer

## Local

```
npm install
cp .env.example .env  # fill in keys
node migrate.js
node server.js
```

## Deploy

Render auto-deploys from this repo via `render.yaml`. Secrets `OPENAI_API_KEY`, `DATALAB_API_KEY`, `GEMINI_API_KEY` set in the dashboard.
