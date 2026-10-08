# Digital Me backend (MVP)

Node + Express + PostgreSQL/pgvector. Claude for answers, Voyage for embeddings.

## Quick start (Docker)
`cp .env.example .env`, add `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY`, then `docker compose up --build` and open http://localhost:4000 (the app and pgvector database start together; tables are created automatically).

## Run without Docker
1. `cp .env.example .env` and fill in keys; create a Postgres DB with the `vector` extension available.
2. `npm install && npm run db && npm start`

## API (all but auth need `Authorization: Bearer <token>`)
- POST /auth/register, /auth/login
- POST /knowledge (multipart `file` or JSON `text`, plus `title`, `category`): pdf/docx/pptx/txt/md
- GET /knowledge, DELETE /knowledge/:id, DELETE /me/data
- POST /presentation/qa `{question}` -> `{answer, confidence, sources}`
- POST /chat `{message, history?}` -> `{answer, sources}`
- GET/POST/PATCH/DELETE /tasks

## Safety behaviour
Presentation answers are generated only when retrieval score >= 0.35, else the fixed "not available" message is returned without calling the LLM. Companion chat labels general knowledge separately from stored facts.

## v2 endpoints
/profile, /presentation/notes, /presentation/end, /analytics, /learn/{plan,quiz,cards,result,progress}, /interview/{question,evaluate}, /projects (+ /:id/ask). Re-run `npm run db` to create the new tables.

## Not yet included
Image OCR, OAuth, voice (use browser Web Speech API on the frontend), avatar, analytics, rate limiting, tests.
Point the prototype's `answer()` / `ask()` functions at these endpoints to connect the UI.

## v3
Serves the web app from `public/`, auto-migrates the schema on start, `/health`, `/config`, Google sign-in (`GOOGLE_CLIENT_ID`), persisted chat history, image OCR (tesseract.js), `/export`, helmet and rate limiting. Run `npm install` again for the new packages.

## v4
Public Digital Me link (`/p/<slug>`, answers only from items marked Shared), `/generate` (resume, pitch, bio, cover letter), `/plan/today`, `/presentation/prep` (rehearsal gap finder), task due reminders. The schema auto-migrates on restart.
