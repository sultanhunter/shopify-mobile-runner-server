# Shopify Mobile Runner Server

Standalone runner backend for the Shopify Mobile AI MVP.

## Included APIs

- `POST /api/shopify-mobile/scaffold-expo` - Generate Expo scaffold (`create-expo-app`)
- `POST /api/shopify-mobile/generate-preview` - Vertex/Gemini preview update generation
- `POST /api/shopify-mobile/dev-session/start` - Clone repo, install, start Expo
- `GET /api/shopify-mobile/dev-session/:sessionId/status` - Session status/logs
- `POST /api/shopify-mobile/dev-session/:sessionId/stop` - Stop session
- `POST /api/shopify-mobile/dev-session/:sessionId/apply-and-push` - Apply files and push commit

## Quick Start

1. Copy `.env.example` to `.env`
2. Install dependencies: `npm install`
3. Build: `npm run build`
4. Run dev: `npm run dev`
