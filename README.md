# Gurukul Olympics 2026 — local photo library

A fast, local-first photo library built for large collections (15,000+ photos). Originals stay on your computer; Gurukul Olympics 2026 generates WebP thumbnails and previews for browsing.

## Quick start

Requires **Node.js 22.13+** (tested on Node 24).

```powershell
npm install
npm start
```

Gurukul Olympics 2026 opens `http://127.0.0.1:3000` automatically. Use `NO_OPEN=1` to start without opening a browser.

```powershell
# PowerShell
$env:NO_OPEN = '1'; npm start
```

Run the tests with:

```powershell
npm test
```

## What it does

- Uploads by file picker, folder picker, or drag & drop (including folders)
- Streams uploads with SHA-256 hash-based exact-duplicate detection
- Generates WebP thumbnails and previews with `sharp`
- Infinite-scroll gallery with search, sorting, albums, favorites and Trash
- Selection mode with bulk favorite, album, trash, restore and permanent delete
- Lightbox viewer with caption, tags, album and favorite editing
- CSV metadata export
- Optional Google Drive folder watching (see below)

## Configuration

All settings are environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Server port |
| `HOST` | `127.0.0.1` | Bind address |
| `DATA_DIR` | `./data` | SQLite database and Drive settings |
| `STORAGE_DIR` | `./storage` | Originals, thumbnails, previews, incoming files |
| `MAX_UPLOAD_MB` | `200` | Per-file upload limit |
| `UPLOAD_BATCH_SIZE` | `8` | Server-side file limit per upload request |
| `PROCESS_CONCURRENCY` | CPU-based | Concurrent thumbnail jobs |
| `THUMB_SIZE` / `PREVIEW_SIZE` | `600` / `1600` | Generated image sizes |
| `NO_OPEN` | unset | Set to `1` to skip opening the browser |
| `JIO_EMAIL` | `sgis` | Owner sign-in email |
| `JIO_PASSWORD` | `sgis` | Owner sign-in password |
| `AUTH_ENABLED` | `1` | Set to `0` to disable the sign-in gate (trusted local use only) |
| `AUTH_SECRET` | random per start | Cookie signing secret |
| `GOOGLE_CLIENT_ID` | — | Google OAuth Web application client ID |
| `GOOGLE_CLIENT_SECRET` | — | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | derived from request | Fixed OAuth callback URL |
| `GOOGLE_DRIVE_POLL_SECONDS` | `5` | Default Drive watch interval |
| `GOOGLE_DRIVE_POLL_MINUTES` | `15` | Legacy interval fallback |

## Sign-in and participant mode

Gurukul Olympics 2026 opens with a sign-in screen:

- **Sign in as owner** uses the credentials configured on the server. Defaults are email `sgis` and password `sgis`.
- **Get in as Participants** opens a view-only gallery. Participants can browse, search, sort and open photos, but cannot upload, edit, delete, favorite, export, or manage Google Drive.

Access is enforced server-side with an HttpOnly session cookie, so hiding UI buttons is not the only protection.

Change the owner credentials before starting the server:

```powershell
$env:JIO_EMAIL = 'you@example.com'
$env:JIO_PASSWORD = 'a-strong-password'
npm start
```

Set `AUTH_ENABLED=0` only for trusted local development/test environments to disable the gate. Sessions are signed with a random secret at startup; restarting Gurukul Olympics 2026 signs everyone out.

## Google Drive folder watching

Gurukul Olympics 2026 can watch a Drive folder and import new images automatically.

By default it targets the folder **`GO#2026`** in the authorised Google account, assigns photos to the album **`GO#2026`**, includes subfolders, imports existing photos on first sync, and checks every **5 seconds**. After the first Google sign-in, the folder is selected automatically; a one-time interactive sign-in is still required because Google tokens cannot be created from code alone.

### 1. Google Cloud setup

1. Create a Google Cloud project and enable the **Google Drive API**.
2. Configure the OAuth consent screen.
3. Create an OAuth client ID with application type **Web application**.
4. Add the exact redirect URI:
   - `http://127.0.0.1:3000/api/drive/oauth/callback`
   - If you use `localhost`, also add `http://localhost:3000/api/drive/oauth/callback`
5. Leave authorized JavaScript origins empty; Gurukul Olympics 2026 uses a server-side authorization-code flow.

### 2. Configure Gurukul Olympics 2026

Set the credentials before starting the server:

```powershell
$env:GOOGLE_CLIENT_ID = 'your-client-id'
$env:GOOGLE_CLIENT_SECRET = 'your-client-secret'
npm start
```

Then in Gurukul Olympics 2026:

1. Open **Connect Drive** in the sidebar and approve access.
2. Choose the folder to watch, an optional album name, whether to include subfolders, the poll interval, and whether to import existing photos on the first sync.
3. Gurukul Olympics 2026 checks the folder in the background. You can also press **Sync now**.

Imported files go through the same pipeline as local uploads: SHA-256 dedupe, EXIF date detection, thumbnails/previews, and the chosen album. The Drive file path is preserved in the photo details.

OAuth tokens and watcher settings are stored in `data/drive.json` with restrictive permissions. Do not share that file.

### Notes

- Only image files are imported; Google Docs, videos and SVGs are skipped.
- Files larger than `MAX_UPLOAD_MB` are skipped.
- The watcher uses a 5-minute overlap on its timestamp cursor so late-appearing files are still picked up. Seen file IDs prevent repeated downloads.
- Poll intervals from 5 seconds upward can be selected in the folder dialog. Short intervals with many subfolders use more Drive API quota; 30–60 seconds is a good balance for large folders.
- Subfolder traversal is limited to 4 levels and 150 folders per sync.

## Storage layout

```text
data/
  photos.db          SQLite metadata database
  drive.json         Google OAuth tokens and watcher settings (if used)
storage/
  originals/YYYY/MM/<sha256><ext>
  thumbs/<hash-prefix>/<sha256>.webp
  previews/<hash-prefix>/<sha256>.webp
  incoming/          Temporary upload/download files
```

Deleting from the library first moves photos to Trash. Permanent deletion removes the database row and its files.

## Deployment note

This version is designed for localhost/self-hosting with a persistent local filesystem. Serverless platforms such as Vercel do not persist local files, so hosting there would require moving the SQLite database to a hosted database and media storage to object storage, or running Gurukul Olympics 2026 as a container with a persistent volume.
