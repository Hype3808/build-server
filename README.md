# Build2API - Google AI Studio Proxy Server

A proxy server that allows switching between multiple Google AI Studio accounts with automatic failover and OpenAI-compatible API endpoints.

## Quick Start

### Running the Server

```bash
# Install dependencies
npm install

# Start the server
npm start
# or
node main.js
```

The server will start on port 7860 by default.

### Docker

This repository now ships with a production-ready container setup (`Dockerfile`, `docker-compose.yml`, and a GHCR publish workflow).

Build locally:

```bash
docker compose build
docker compose up -d
```

The image embeds Camoufox automatically. Set `CAMOUFOX_URL` to pick the correct architecture:

```bash
# x86_64 (default)
docker compose build

# ARM64
CAMOUFOX_URL=https://github.com/daijro/camoufox/releases/download/v135.0.1-beta.24/camoufox-135.0.1-beta.24-lin.arm64.zip docker compose build
```

At runtime, mount your `auth/`, `runtime/`, and optional `config.json` directories as defined in `docker-compose.yml`, then expose ports `7860` and `9998`.

## Project Structure

```
ais2api/
├── main.js                          # Entry point
├── package.json                     # Dependencies and scripts
├── config.json                      # Optional configuration file
├── models.json                      # Supported AI models list
├── black-browser.js                 # Browser-side proxy client script
├── auth/                            # Authentication files directory
│   └── auth-1.json                  # Storage state for account #1
├── camoufox-windows/                # Windows browser executable
├── camoufox-linux/                  # Linux browser executable (if exists)
├── camoufox-macos/                  # macOS browser executable (if exists)
└── src/                             # Source code modules
    ├── auth/
    │   └── AuthSource.js            # Authentication source management
    ├── browser/
    │   └── BrowserManager.js        # Playwright browser automation
    ├── config/
    │   └── ConfigLoader.js          # Configuration loading and parsing
    ├── http/
    │   ├── ProxyServerSystem.js     # Main server system
    │   └── RequestHandler.js        # Request processing and routing
    ├── routes/
    │   └── index.js                 # Express routes and endpoints
    ├── utils/
    │   ├── Logger.js                # Logging service
    │   └── MessageQueue.js          # Async message queue
    └── websocket/
        └── ConnectionRegistry.js    # WebSocket connection management
```

## Configuration

### Environment Variables

- `PORT` - HTTP server port (default: 7860)
- `HOST` - Server host (default: 0.0.0.0)
- `STREAMING_MODE` - `real` or `fake` (default: real)
- `FAILURE_THRESHOLD` - Failed requests before account switch (default: 3)
- `SWITCH_ON_USES` - Switch account after N successful requests (default: 40)
- `MAX_RETRIES` - Max retry attempts per request (default: 1)
- `RETRY_DELAY` - Delay between retries in ms (default: 2000)
- `API_KEYS` - Comma-separated list of API keys
- `INITIAL_AUTH_INDEX` - Starting account index (default: 1)
- `CAMOUFOX_EXECUTABLE_PATH` - Custom browser executable path
- `IMMEDIATE_SWITCH_STATUS_CODES` - Status codes triggering immediate switch (default: 429,503)
- `AUTH_JSON_1`, `AUTH_JSON_2`, etc. - JSON auth data for environment-based auth

### config.json (Optional)

```json
{
  "httpPort": 7860,
  "host": "0.0.0.0",
  "streamingMode": "real",
  "failureThreshold": 3,
  "switchOnUses": 40,
  "maxRetries": 1,
  "retryDelay": 2000,
  "apiKeys": ["your-secret-key"],
  "immediateSwitchStatusCodes": [429, 503],
  "browserExecutablePath": null
}
```

## Platform Support

### Windows
Place browser executable at: `camoufox-windows/camoufox.exe`

### Linux
Place browser executable at: `camoufox-linux/camoufox` (the Dockerfile automatically downloads the zipped release, unpacks it, and renames the binary for you).

### macOS
Place browser executable at: `camoufox-macos/camoufox`

Or set `CAMOUFOX_EXECUTABLE_PATH` environment variable to a custom location.

## Authentication

### File-based (Default)
Place authentication JSON files in the `auth/` directory:
- `auth/auth-1.json`
- `auth/auth-2.json`
- etc.

### Environment-based
Set environment variables:
- `AUTH_JSON_1='{"cookies":[...]}'`
- `AUTH_JSON_2='{"cookies":[...]}'`
- etc.

## API Endpoints

### OpenAI-Compatible
- `POST /v1/chat/completions` - OpenAI chat completions API
- `GET /v1/models` - List available models

### Google Gemini Native
- `POST /v1beta/models/{model}:generateContent` - Non-streaming generation
- `POST /v1beta/models/{model}:streamGenerateContent` - Streaming generation

### Management UI
- `GET /` - Web-based status dashboard (requires login)
- `GET /api/status` - JSON status endpoint
- `POST /api/switch-account` - Switch to specific account
- `POST /api/set-mode` - Change streaming mode

## Authentication

Default API key is `123456`. Configure custom keys via `API_KEYS` environment variable or `config.json`.

Access the web UI at http://localhost:7860 and login with your API key.

## Features

- ✅ **Multi-Account Support** - Switch between multiple Google accounts
- ✅ **Automatic Failover** - Auto-switch on errors or quota limits  
- ✅ **OpenAI Compatibility** - Drop-in replacement for OpenAI API
- ✅ **Streaming Support** - Real and pseudo-streaming modes
- ✅ **Account Rotation** - Rotate accounts based on usage count
- ✅ **Web Dashboard** - Real-time monitoring and control
- ✅ **Cross-Platform** - Windows, Linux, macOS support
- ✅ **Modular Architecture** - Clean separation of concerns

## Module Overview

### Core Modules

**main.js** - Application entry point
- Initializes the ProxyServerSystem
- Handles startup errors
- Exports for programmatic use

**ProxyServerSystem.js** - Main server orchestrator
- Manages HTTP and WebSocket servers
- Coordinates all subsystems
- Handles graceful startup/shutdown

**RequestHandler.js** - Request processing engine
- Processes Google and OpenAI format requests
- Handles streaming and non-streaming responses
- Implements retry logic and error handling
- Manages account switching triggers

**BrowserManager.js** - Browser automation
- Manages Playwright browser instances
- Handles authentication contexts
- Automates Google AI Studio UI interactions

**AuthSource.js** - Authentication management
- Loads auth from files or environment
- Validates and filters auth sources
- Provides account metadata

**ConnectionRegistry.js** - WebSocket management
- Manages browser↔server WebSocket connections
- Routes messages to appropriate queues
- Handles reconnection logic

**ConfigLoader.js** - Configuration management
- Loads from file and environment
- Validates and normalizes settings
- Provides sensible defaults

### Utility Modules

**Logger.js** - Logging service with in-memory buffer
**MessageQueue.js** - Async message passing between components
**routes/index.js** - Express route definitions and middleware

## License

See LICENSE file for details.

