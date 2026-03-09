# Shopify Mobile Runner Server

Standalone runner backend for the Shopify Mobile AI MVP.

## Included APIs

- `POST /api/shopify-mobile/scaffold-expo` - Generate Expo scaffold (`create-expo-app`)
- `GET /api/shopify-mobile/scaffold-expo/versions` - List supported Expo SDK matrix
- `POST /api/shopify-mobile/generate-preview` - Vertex/Gemini preview update generation
- `POST /api/shopify-mobile/opencode/prompt` - Run OpenCode Shopify agent in persistent repo workspace
- `POST /api/shopify-mobile/opencode/prompt/stream` - Stream OpenCode events + final result
- `POST /api/shopify-mobile/dev-session/start` - Clone repo, install, start Expo
- `GET /api/shopify-mobile/dev-session/:sessionId/status` - Session status/logs
- `POST /api/shopify-mobile/dev-session/:sessionId/stop` - Stop session
- `POST /api/shopify-mobile/dev-session/:sessionId/apply-and-push` - Apply files and push commit

## Quick Start

1. Copy `.env.example` to `.env`
2. Install dependencies: `npm install`
3. Install OpenCode CLI: `npm install -g opencode-ai`
4. Build: `npm run build`
5. Run dev: `npm run dev`

## Deployment Script

- Use `npm run deploy` to run: git fetch/pull, npm install, build, and PM2 restart.
- Defaults:
  - branch: `main`
  - PM2 process: `shopify-mobile-runner-server`
- Override PM2 process name:
  - `PM2_PROCESS=runner npm run deploy`
- Deploy a different branch:
  - `bash scripts/deploy-runner.sh staging`

## OpenCode Agent Notes

- Runner creates/updates `.opencode/agents/shopify-app-builder.md` inside each project repo.
- First prompt creates an OpenCode session in the persistent repo workspace.
- Consecutive prompts reuse the same OpenCode session ID for that project.

## Expo SDK Support Matrix

- Expo scaffold generation is pinned by SDK support data in `src/services/expoSupportMatrix.ts`.
- Default SDK is currently `sdk-55`.
- `POST /api/shopify-mobile/scaffold-expo` accepts optional body field `sdk` (example: `"55"` or `"sdk-55"`).
- Update support matrix entries when adding/removing SDK support, including associated package compatibility.
