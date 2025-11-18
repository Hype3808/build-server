const { EventEmitter } = require("events");
const express = require("express");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const http = require("http");
const WebSocket = require("ws");

const LoggingService = require("../utils/Logger");
const ConfigLoader = require("../config/ConfigLoader");
const AuthSource = require("../auth/AuthSource");
const BrowserManager = require("../browser/BrowserManager");
const ConnectionRegistry = require("../websocket/ConnectionRegistry");
const RequestHandler = require("./RequestHandler");
const createRoutes = require("../routes");

class ProxyServerSystem extends EventEmitter {
  constructor() {
    super();
    this.logger = new LoggingService("ProxySystem");
    this.config = ConfigLoader.load(this.logger);
    this.streamingMode = this.config.streamingMode;

    this.authSource = new AuthSource(this.logger);
    this.browserManager = new BrowserManager(
      this.logger,
      this.config,
      this.authSource
    );
    this.connectionRegistry = new ConnectionRegistry(this.logger);
    this.requestHandler = new RequestHandler(
      this,
      this.connectionRegistry,
      this.logger,
      this.browserManager,
      this.config,
      this.authSource
    );

    this.httpServer = null;
    this.wsServer = null;
  }

  async start(initialAuthIndex = null) {
    this.logger.info("[System] 开始弹性启动流程...");
    const allAvailableIndices = this.authSource.availableIndices;

    if (allAvailableIndices.length === 0) {
      throw new Error("没有任何可用的认证源，无法启动。");
    }

    let startupOrder = [...allAvailableIndices];
    if (initialAuthIndex && allAvailableIndices.includes(initialAuthIndex)) {
      this.logger.info(
        `[System] 检测到指定启动索引 #${initialAuthIndex}，将优先尝试。`
      );
      startupOrder = [
        initialAuthIndex,
        ...allAvailableIndices.filter((i) => i !== initialAuthIndex),
      ];
    } else {
      if (initialAuthIndex) {
        this.logger.warn(
          `[System] 指定的启动索引 #${initialAuthIndex} 无效或不可用，将按默认顺序启动。`
        );
      }
      this.logger.info(
        `[System] 未指定有效启动索引，将按默认顺序 [${startupOrder.join(
          ", "
        )}] 尝试。`
      );
    }

    await this._startHttpServer();
    await this._startWebSocketServer();

    let isStarted = false;
    for (const index of startupOrder) {
      try {
        this.logger.info(`[System] 尝试使用账号 #${index} 启动服务...`);
        await this.browserManager.launchOrSwitchContext(index);

        isStarted = true;
        this.logger.info(`[System] ✅ 使用账号 #${index} 成功启动！`);
        break;
      } catch (error) {
        this.logger.error(
          `[System] ❌ 使用账号 #${index} 启动失败。原因: ${error.message}`
        );
      }
    }

    if (!isStarted) {
      await this._shutdownServers();
      throw new Error("所有认证源均尝试失败，服务器无法启动。");
    }
    this.logger.info(`[System] 代理服务器系统启动完成。`);
    this.emit("started");
  }

  async _startHttpServer() {
    if (this.httpServer) {
      return;
    }
    const app = this._createExpressApp();
    this.httpServer = http.createServer(app);

    this.httpServer.keepAliveTimeout = 15000;
    this.httpServer.headersTimeout = 20000;

    return new Promise((resolve) => {
      this.httpServer.listen(this.config.httpPort, this.config.host, () => {
        this.logger.info(
          `[System] HTTP服务器已在 http://${this.config.host}:${this.config.httpPort} 上监听`
        );
        this.logger.info(
          `[System] Keep-Alive 超时已设置为 ${
            this.httpServer.keepAliveTimeout / 1000
          } 秒。`
        );
        resolve();
      });
    });
  }

  _createExpressApp() {
    const app = express();
    app.use((req, res, next) => {
      if (
        req.path !== "/api/status" &&
        req.path !== "/" &&
        req.path !== "/favicon.ico" &&
        req.path !== "/login"
      ) {
        this.logger.info(
          `[Entrypoint] 收到一个请求: ${req.method} ${req.path}`
        );
      }
      next();
    });
    app.use(express.json({ limit: "100mb" }));
    app.use(express.urlencoded({ extended: true }));

    const sessionSecret =
      (this.config.apiKeys && this.config.apiKeys[0]) ||
      crypto.randomBytes(20).toString("hex");
    app.use(cookieParser());
    app.use(
      session({
        secret: sessionSecret,
        resave: false,
        saveUninitialized: true,
        cookie: { secure: false, maxAge: 86400000 },
      })
    );

    // Apply all routes from routes module
    createRoutes(app, this);

    return app;
  }

  async _startWebSocketServer() {
    if (this.wsServer) {
      return;
    }
    this.wsServer = new WebSocket.Server({
      port: this.config.wsPort,
      host: this.config.host,
    });
    this.wsServer.on("connection", (ws, req) => {
      this.connectionRegistry.addConnection(ws, {
        address: req.socket.remoteAddress,
      });
    });
  }

  async _shutdownServers() {
    const tasks = [];
    if (this.wsServer) {
      tasks.push(
        new Promise((resolve) => {
          this.wsServer.close(() => resolve());
        })
      );
      this.wsServer = null;
    }
    if (this.httpServer) {
      tasks.push(
        new Promise((resolve) => {
          this.httpServer.close(() => resolve());
        })
      );
      this.httpServer = null;
    }
    if (tasks.length > 0) {
      await Promise.all(tasks);
      this.logger.info("[System] 已回收 HTTP/WS 服务端口。");
    }
  }
}

module.exports = ProxyServerSystem;
