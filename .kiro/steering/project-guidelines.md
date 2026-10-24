---
inclusion: always
---

# Hackachussetts project guidelines

## Frontend/backend boundary

- Do not modify files under `frontend/` when implementing backend work unless the user explicitly requests frontend changes.
- The FastAPI application in `backend/main.py` must serve `frontend/public` and preserve the frontend's same-origin API contract.
- Keep the report intake contract compatible with the browser: `multipart/form-data`, `photo`, optional `audio`, location fields, description, contact, client id, and offline retry fields.

## Data and privacy

- Store report metadata in Supabase Postgres and media in the private `civic-reports` Storage bucket.
- Never expose reporter contact information, device identifiers, user agents, or voice notes through public issue-board responses.
- Keep Supabase secret keys and OpenRouter keys in `.env`, never in source files or Kiro artifacts.

## AI and problem merging

- AI output must be validated before it is stored.
- Severity scores are integers from 0 through 100.
- A report may join an existing problem only when its category and department match and its location is within the configured merge radius.
- Invalid or unanalyzed reports must not create or increase a merged problem.

## Verification

Before considering backend work complete:

1. Parse/compile all changed Python files.
2. Verify the FastAPI app imports.
3. Exercise report submission, duplicate retry behavior, public issues, contact lookup, government login, government report listing, and media routes.
4. Confirm no frontend files were modified for backend-only work.
