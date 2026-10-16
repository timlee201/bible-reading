# Transcribe

A personal web app. Sign in with Google and browse My Drive or Shared with me. Pick an audio or video file, and the server sends it to AssemblyAI. When the transcript is ready, the app saves an HTML file beside the audio (`Interview.mp3` becomes `Interview.html`) and opens it in the page.

The signed-in page has a sidebar (My Drive, Shared with me, and Transcripts), breadcrumbs for the open folder, and a list of folders followed by recordings. Right-click a folder or recording for Transcribe, Rename, Delete, and Open in Drive. Delete moves that Drive item to trash. A recording is marked transcribed when its job is done or that sibling HTML file is already in the folder. Google Picker is a second way to jump to a file, including files shared with you. Transcripts in the sidebar are the jobs this app created, with the recording name and status (`uploading`, `transcribing`, `saving`, `done`, or `error`).

Paragraph text in the main pane is editable. Speaker names are labels. Save writes the HTML back to Drive and leaves the original AssemblyAI paragraphs embedded, so Revert can restore them. Clean up still rewrites the visible text from those original paragraphs. Print, and the saved HTML, use `@page { size: A4; margin: 18mm 16mm; }` from `src/transcript.html`.

The same HTML is also available at `/t/<transcript id>`. A toolbar (hidden when printing) can:

- **Clean up** — asks this app to clean punctuation, fillers, and obvious stumbles, then swaps the visible paragraphs. Cleaned text is never the automatic default. The model output is inserted with `textContent`, not as HTML.
- **Revert** — puts back the original AssemblyAI paragraphs from JSON embedded in the file. This stays in the browser and does not call the server.
- **Save** — writes the paragraphs you are looking at back over the Drive HTML file. The embedded original JSON is left unchanged.
- **Print** — `window.print()`. Save as PDF from the browser dialog. There is no server-side PDF.

The page is also available while you are signed in at `/t/<transcript id>`, which is the practical way to read it on a phone.

## Local run

From this directory:

```bash
cp .env.example .env
# fill in the values
npm install
npm start
```

`npm start` loads `.env` when that file exists. The app listens on `PORT` (default `8080`).

Do not commit `.env`. It is listed in `.gitignore`.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `ASSEMBLYAI_API_KEY` | yes | AssemblyAI speech-to-text and LLM Gateway. |
| `GOOGLE_CLIENT_ID` | yes | OAuth web client id. |
| `GOOGLE_CLIENT_SECRET` | yes | OAuth client secret. |
| `GOOGLE_API_KEY` | yes | Picker developer key. The signed-in page receives it from `GET /api/session` because Picker runs in the browser. |
| `ALLOWED_EMAIL` | yes | Only this Google account can sign in. Comparison is case-insensitive. Anyone else gets 403 and no session. |
| `APP_ORIGIN` | yes | Public origin with no trailing slash, for example `http://localhost:8080` or `https://transcribe-xxxxx.run.app`. |
| `SESSION_SECRET` | yes | Signs the session cookie. Also the key material for sealing webhook and file tokens: SHA-256(`SESSION_SECRET`), then AES-256-GCM. |
| `WEBHOOK_SECRET` | yes for webhooks | Exact value AssemblyAI must send in the `X-Webhook-Secret` header. Compared in constant time. |
| `WEBHOOK_URL` | no | If set, this exact URL is registered on every transcript instead of a per-job sealed URL. Cold start then needs `GOOGLE_REFRESH_TOKEN`. Leave empty locally. |
| `GOOGLE_REFRESH_TOKEN` | no | Fallback when `WEBHOOK_URL` is set and a fresh instance has no session cookie to read Drive app data. |
| `CLEANUP_MODEL` | no | LLM Gateway model. Defaults to `claude-sonnet-4-6`. |
| `PORT` | no | Defaults to `8080`. |

The session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` when `APP_ORIGIN` is `https`. It holds the email, access token, expiry, and refresh token. The AssemblyAI key and the refresh token are not put in the picker page. The transcript HTML embeds a per-file token so Clean up and Save can authorize without a cookie (including a `file://` page, whose origin is `null`).

## Google Cloud

Keep the OAuth consent screen in **testing** mode and add `ALLOWED_EMAIL` as a test user. The Drive scope is sensitive; testing mode with only your account as a test user avoids Google’s verification review.

Enable **Google Drive API** and **Google Picker API** on the same project.

Create an OAuth client of type **Web application**:

- Authorized redirect URI: `APP_ORIGIN/auth/callback` (no trailing slash on the origin)
- Authorized JavaScript origin: `APP_ORIGIN` (Picker)

Create an API key for Picker. Restrict it to the Picker API and to HTTP referrers for `APP_ORIGIN`.

The sign-in request uses the authorization code flow with `access_type=offline` and `prompt=consent`, so Google issues a refresh token. Scopes:

- `openid`
- `email`
- `profile`
- `https://www.googleapis.com/auth/drive`
- `https://www.googleapis.com/auth/drive.appdata`

`drive.file` is not enough: the app writes the HTML file into the folder that already holds the recording. Job state and the refresh token live in Drive’s hidden app data folder (`transcript-state.json`), so the service can scale to zero without Firestore.

## AssemblyAI webhook

When `APP_ORIGIN` is a public URL (not `localhost` or `127.0.0.1`), each transcript is created with:

- `webhook_url` set to `APP_ORIGIN/api/webhooks/assemblyai/<sealed token>`
- `webhook_auth_header_name` = `X-Webhook-Secret`
- `webhook_auth_header_value` = `WEBHOOK_SECRET`

Point AssemblyAI at the public Cloud Run URL. The handler checks the header, then on `completed` fetches paragraphs and uploads the HTML. On `error` it stores the failure. A valid secret always gets HTTP 200 so AssemblyAI does not keep retrying a rejected call. A bad secret gets 401.

If `APP_ORIGIN` is `http://localhost` (or `127.0.0.1`), the server does **not** register a webhook. AssemblyAI cannot reach your laptop. Leave the tab open: it polls `GET /api/jobs/:id` about every 4 seconds, and that poll writes the HTML file when the transcript completes.

If you set `WEBHOOK_URL`, that exact URL is sent instead of the sealed one (the header is still required). A cold instance cannot read the refresh token out of app data until it already has one, so set `GOOGLE_REFRESH_TOKEN` as the fallback for that mode. Prefer leaving `WEBHOOK_URL` empty and using the per-job sealed URL whenever `APP_ORIGIN` is public.

### Why the webhook path contains a sealed token

The refresh token is stored in Drive app data. A webhook that hits a brand-new instance cannot read app data until it has that token, and the token is inside the file it cannot read yet. The path segment is the refresh token sealed with AES-256-GCM (random IV each time, key derived by SHA-256 of `SESSION_SECRET`). The handler unseals it, exchanges it for an access token, and reads or writes Drive. Do not share those URLs. They are credentials.

The HTML file’s token is the same kind of sealed capability, so Clean up and Save work after a cold start when the page is opened from disk. Do not share the HTML file publicly.

## Secret Manager

Put these in Secret Manager and mount them on the Cloud Run service. Do not bake them into the image:

- `ASSEMBLYAI_API_KEY`
- `GOOGLE_CLIENT_SECRET`
- `SESSION_SECRET`
- `WEBHOOK_SECRET`

`GOOGLE_CLIENT_ID` and `GOOGLE_API_KEY` are visible to the browser (Picker needs the key). They can still live in Secret Manager if you prefer.

```bash
printf '%s' 'VALUE' | gcloud secrets create assemblyai-api-key --data-file=-
printf '%s' 'VALUE' | gcloud secrets create google-client-secret --data-file=-
printf '%s' 'VALUE' | gcloud secrets create session-secret --data-file=-
printf '%s' 'VALUE' | gcloud secrets create webhook-secret --data-file=-
```

Use `gcloud secrets versions add` to rotate a secret that already exists.

## Vercel

Host this app as its own Vercel project. The project’s root directory is `transcribe/`, not the repository root, so the reading schedule at the root of the repo stays where it is.

1. In Vercel, create a new project from this GitHub repo.
2. Set **Root Directory** to `transcribe`.
3. Add the environment variables from `.env.example`, using the same names. Leave `WEBHOOK_URL` empty so each transcript uses the sealed webhook URL (`APP_ORIGIN/api/webhooks/assemblyai/<sealed token>`). `PORT` is unused on Vercel.
4. Deploy. `vercel.json` sends every request to `api/index.js`, which exports the Express app from `createApp()`. `npm start` is unchanged and still listens locally. The function `maxDuration` is 300 seconds because `POST /api/jobs` downloads the Drive file and uploads it to AssemblyAI before it responds. A plan that allows a 300 second function is required.
5. Set `APP_ORIGIN` to the deployment origin with no trailing slash, for example `https://your-project.vercel.app`, and redeploy so the cookie, OAuth redirect, and webhook use that origin.
6. On the existing Google OAuth web client, add that origin as an authorized JavaScript origin and add `APP_ORIGIN/auth/callback` as an authorized redirect URI.
7. Add the same origin to the Picker API key’s website restrictions.

## Cloud Run

The Dockerfile in this directory uses Node.js 22. Build context is `transcribe/` (this folder), not the repository root. The container listens on 8080.

Allow unauthenticated invocations at the Cloud Run IAM layer. The service has to be reachable for the Google sign-in redirect and for AssemblyAI’s webhook. Google login is the real gate: every data route checks the session, and any other email is rejected.

```bash
gcloud run deploy transcribe \
  --source . \
  --region REGION \
  --port 8080 \
  --timeout 1800 \
  --memory 1Gi \
  --allow-unauthenticated \
  --set-env-vars APP_ORIGIN=https://SERVICE_URL,ALLOWED_EMAIL=you@example.com,GOOGLE_CLIENT_ID=YOUR_CLIENT_ID,GOOGLE_API_KEY=YOUR_PICKER_KEY \
  --set-secrets ASSEMBLYAI_API_KEY=assemblyai-api-key:latest,GOOGLE_CLIENT_SECRET=google-client-secret:latest,SESSION_SECRET=session-secret:latest,WEBHOOK_SECRET=webhook-secret:latest
```

Run that from this directory so `--source .` finds the Dockerfile. Uploading a long recording can take several minutes; the request timeout and the Cloud Run timeout are both 30 minutes. After the first deploy, set `APP_ORIGIN` to the service URL Cloud Run prints, and add that same origin as the OAuth redirect URI and the Picker key referrer.

A Docker build from the repository root:

```bash
docker build -t transcribe -f transcribe/Dockerfile transcribe
```

## Drive preview does not run the page

Drive’s own preview sandboxes HTML and does not execute the page’s scripts. Clean up, Revert, Save, and Print do nothing in that preview. Download the HTML file and open it in a browser, or open `/t/<transcript id>` while you are signed in.

## Print

Print uses the browser dialog (`window.print()`), including Save as PDF. The stylesheet sets:

```css
@page { size: A4; margin: 18mm 16mm; }
```

If the browser ignores `@page`, set the paper size to A4 in the print dialog. The toolbar has the class `no-print` and is omitted from the printed page. Speaker labels are printed only when the speaker changes. Word timings and confidence are not shown.
