const crypto = require("crypto");

function createRoutes(app, serverSystem) {
  const { config, requestHandler, authSource, browserManager, logger } =
    serverSystem;

  // Health check endpoint - MUST be first, no middleware, always responds
  // This ensures the endpoint works even during browser/WebSocket recreation
  app.get("/health", (req, res) => {
    res.status(200).json({ 
      status: "ok",
      timestamp: new Date().toISOString()
    });
  });

  // Authentication middleware
  const isAuthenticated = (req, res, next) => {
    if (req.session.isAuthenticated) {
      return next();
    }
    res.redirect("/login");
  };

  const _createAuthMiddleware = () => {
    const basicAuth = require("basic-auth");

    return (req, res, next) => {
      const serverApiKeys = config.apiKeys;
      if (!serverApiKeys || serverApiKeys.length === 0) {
        return next();
      }

      let clientKey = null;
      if (req.headers["x-goog-api-key"]) {
        clientKey = req.headers["x-goog-api-key"];
      } else if (
        req.headers.authorization &&
        req.headers.authorization.startsWith("Bearer ")
      ) {
        clientKey = req.headers.authorization.substring(7);
      } else if (req.headers["x-api-key"]) {
        clientKey = req.headers["x-api-key"];
      } else if (req.query.key) {
        clientKey = req.query.key;
      }

      if (clientKey && serverApiKeys.includes(clientKey)) {
        logger.info(
          `[Auth] API Key验证通过 (来自: ${
            req.headers["x-forwarded-for"] || req.ip
          })`
        );
        if (req.query.key) {
          delete req.query.key;
        }
        return next();
      }

      if (req.path !== "/favicon.ico") {
        const clientIp = req.headers["x-forwarded-for"] || req.ip;
        logger.warn(
          `[Auth] 访问密码错误或缺失，已拒绝请求。IP: ${clientIp}, Path: ${req.path}`
        );
      }

      return res.status(401).json({
        error: {
          message:
            "Access denied. A valid API key was not found or is incorrect.",
        },
      });
    };
  };

  // Middleware to block API routes during system busy state
  const _blockDuringSystemBusy = () => {
    return (req, res, next) => {
      if (requestHandler.isSystemBusy) {
        logger.warn(
          `[API] 请求被拒绝: 系统正在进行账号切换 - ${req.method} ${req.path}`
        );
        return res.status(503).json({
          error: {
            message: "正在更换账号中，请稍后再试",
            code: 503,
            type: "service_unavailable"
          }
        });
      }
      next();
    };
  };

  // Login routes
  app.get("/login", (req, res) => {
    if (req.session.isAuthenticated) {
      return res.redirect("/");
    }
    const loginHtml = `
      <!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>登录</title>
      <style>body{display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#f0f2f5}form{background:white;padding:40px;border-radius:10px;box-shadow:0 4px 8px rgba(0,0,0,0.1);text-align:center}input{width:250px;padding:10px;margin-top:10px;border:1px solid #ccc;border-radius:5px}button{width:100%;padding:10px;background-color:#007bff;color:white;border:none;border-radius:5px;margin-top:20px;cursor:pointer}.error{color:red;margin-top:10px}</style>
      </head><body><form action="/login" method="post"><h2>请输入 API Key</h2>
      <input type="password" name="apiKey" placeholder="API Key" required autofocus><button type="submit">登录</button>
      ${req.query.error ? '<p class="error">API Key 错误!</p>' : ""}</form></body></html>`;
    res.send(loginHtml);
  });

  app.post("/login", (req, res) => {
    const { apiKey } = req.body;
    if (apiKey && config.apiKeys.includes(apiKey)) {
      req.session.isAuthenticated = true;
      res.redirect("/");
    } else {
      res.redirect("/login?error=1");
    }
  });

  // Status page
  app.get("/", isAuthenticated, (req, res) => {
    const initialIndices = authSource.initialIndices || [];
    const availableIndices = authSource.availableIndices || [];
    const invalidIndices = initialIndices.filter(
      (i) => !availableIndices.includes(i)
    );
    const logs = logger.logBuffer || [];

    const accountNameMap = authSource.accountNameMap;
    const accountDetailsHtml = initialIndices
      .map((index) => {
        const isInvalid = invalidIndices.includes(index);
        const name = isInvalid
          ? "N/A (JSON格式错误)"
          : accountNameMap.get(index) || "N/A (未命名)";
        return `<span class="label" style="padding-left: 20px;">账号${index}</span>: ${name}`;
      })
      .join("\n");

    const accountOptionsHtml = availableIndices
      .map((index) => `<option value="${index}">账号 #${index}</option>`)
      .join("");

    const statusHtml = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>代理服务状态</title>
    <style>
    body { font-family: 'SF Mono', 'Consolas', 'Menlo', monospace; background-color: #f0f2f5; color: #333; padding: 2em; }
    .container { max-width: 800px; margin: 0 auto; background: #fff; padding: 1em 2em 2em 2em; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
    h1, h2 { color: #333; border-bottom: 2px solid #eee; padding-bottom: 0.5em;}
    pre { background: #2d2d2d; color: #f0f0f0; font-size: 1.1em; padding: 1.5em; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; line-height: 1.6; }
    #log-container { font-size: 0.9em; max-height: 400px; overflow-y: auto; }
    .status-ok { color: #2ecc71; font-weight: bold; }
    .status-error { color: #e74c3c; font-weight: bold; }
    .label { display: inline-block; width: 220px; box-sizing: border-box; }
    .dot { height: 10px; width: 10px; background-color: #bbb; border-radius: 50%; display: inline-block; margin-left: 10px; animation: blink 1s infinite alternate; }
    @keyframes blink { from { opacity: 0.3; } to { opacity: 1; } }
    .action-group { display: flex; flex-wrap: wrap; gap: 15px; align-items: center; }
    .action-group button, .action-group select { font-size: 1em; border: 1px solid #ccc; padding: 10px 15px; border-radius: 8px; cursor: pointer; transition: background-color 0.3s ease; }
    .action-group button:hover { opacity: 0.85; }
    .action-group button { background-color: #007bff; color: white; border-color: #007bff; }
    .action-group select { background-color: #ffffff; color: #000000; -webkit-appearance: none; appearance: none; }
    @media (max-width: 600px) {
        body { padding: 0.5em; }
        .container { padding: 1em; margin: 0; }
        pre { padding: 1em; font-size: 0.9em; }
        .label { width: auto; display: inline; }
        .action-group { flex-direction: column; align-items: stretch; }
        .action-group select, .action-group button { width: 100%; box-sizing: border-box; }
    }
    </style>
</head>
<body>
    <div class="container">
    <h1>代理服务状态 <span class="dot" title="数据动态刷新中..."></span></h1>
    <div id="status-section">
        <pre>
<span class="label">服务状态</span>: <span class="status-ok">Running</span>
<span class="label">浏览器连接</span>: <span class="${
      browserManager.browser ? "status-ok" : "status-error"
    }">${!!browserManager.browser}</span>
--- 服务配置 ---
<span class="label">流模式</span>: ${config.streamingMode} (仅启用流式传输时生效)
<span class="label">立即切换 (状态码)</span>: ${
      config.immediateSwitchStatusCodes.length > 0
        ? `[${config.immediateSwitchStatusCodes.join(", ")}]`
        : "已禁用"
    }
<span class="label">API 密钥</span>: ${config.apiKeySource}
--- 账号状态 ---
<span class="label">当前使用账号</span>: #${requestHandler.currentAuthIndex}
<span class="label">使用次数计数</span>: ${requestHandler.usageCount} / ${
      config.switchOnUses > 0 ? config.switchOnUses : "N/A"
    }
<span class="label">连续失败计数</span>: ${requestHandler.failureCount} / ${
      config.failureThreshold > 0 ? config.failureThreshold : "N/A"
    }
<span class="label">扫描到的总帐号</span>: [${initialIndices.join(", ")}] (总数: ${
      initialIndices.length
    })
${accountDetailsHtml}
<span class="label">格式错误 (已忽略)</span>: [${invalidIndices.join(", ")}] (总数: ${
      invalidIndices.length
    })
        </pre>
    </div>
    <div id="log-section" style="margin-top: 2em;">
        <h2>实时日志 (最近 ${logs.length} 条)</h2>
        <pre id="log-container">${logs.join("\n")}</pre>
    </div>
    <div id="actions-section" style="margin-top: 2em;">
        <h2>操作面板</h2>
        <div class="action-group">
            <select id="accountIndexSelect">${accountOptionsHtml}</select>
            <button onclick="switchSpecificAccount()">切换账号</button>
            <button onclick="toggleStreamingMode()">切换流模式</button>
        </div>
    </div>
    </div>
    <script>
    function updateContent() {
        fetch('/api/status').then(response => response.json()).then(data => {
            const statusPre = document.querySelector('#status-section pre');
            const accountDetailsHtml = data.status.accountDetails.map(acc => {
              return '<span class="label" style="padding-left: 20px;">账号' + acc.index + '</span>: ' + acc.name;
            }).join('\\n');
            statusPre.innerHTML = 
                '<span class="label">服务状态</span>: <span class="status-ok">Running</span>\\n' +
                '<span class="label">浏览器连接</span>: <span class="' + (data.status.browserConnected ? "status-ok" : "status-error") + '">' + data.status.browserConnected + '</span>\\n' +
                '--- 服务配置 ---\\n' +
                '<span class="label">流模式</span>: ' + data.status.streamingMode + '\\n' +
                '<span class="label">立即切换 (状态码)</span>: ' + data.status.immediateSwitchStatusCodes + '\\n' +
                '<span class="label">API 密钥</span>: ' + data.status.apiKeySource + '\\n' +
                '--- 账号状态 ---\\n' +
                '<span class="label">当前使用账号</span>: #' + data.status.currentAuthIndex + '\\n' +
                '<span class="label">使用次数计数</span>: ' + data.status.usageCount + '\\n' +
                '<span class="label">连续失败计数</span>: ' + data.status.failureCount + '\\n' +
                '<span class="label">扫描到的总账号</span>: ' + data.status.initialIndices + '\\n' +
                accountDetailsHtml + '\\n' +
                '<span class="label">格式错误 (已忽略)</span>: ' + data.status.invalidIndices;
            
            const logContainer = document.getElementById('log-container');
            const logTitle = document.querySelector('#log-section h2');
            logTitle.innerText = \`实时日志 (最近 \${data.logCount} 条)\`;
            logContainer.innerText = data.logs;
              logContainer.scrollTop = logContainer.scrollHeight;
        }).catch(error => console.error('Error fetching new content:', error));
    }

    function switchSpecificAccount() {
        const selectElement = document.getElementById('accountIndexSelect');
        const targetIndex = selectElement.value;
        if (!confirm(\`确定要切换到账号 #\${targetIndex} 吗？这会重置浏览器会话。\`)) {
            return;
        }
        fetch('/api/switch-account', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetIndex: parseInt(targetIndex, 10) })
        })
        .then(res => res.text()).then(data => { alert(data); updateContent(); })
        .catch(err => { alert('操作失败: ' + err); updateContent(); });
    }

    function toggleStreamingMode() { 
        const newMode = prompt('请输入新的流模式 (real 或 fake):', '${
          config.streamingMode
        }');
        if (newMode === 'fake' || newMode === 'real') {
            fetch('/api/set-mode', { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ mode: newMode }) 
            })
            .then(res => res.text()).then(data => { alert(data); updateContent(); })
            .catch(err => alert('设置失败: ' + err));
        } else if (newMode !== null) { 
            alert('无效的模式！请只输入 "real" 或 "fake"。'); 
        } 
    }

    document.addEventListener('DOMContentLoaded', () => {
        updateContent(); 
        setInterval(updateContent, 5000);
    });
    </script>
</body>
</html>
`;
    res.status(200).send(statusHtml);
  });

  // API routes
  app.get("/api/status", isAuthenticated, (req, res) => {
    const initialIndices = authSource.initialIndices || [];
    const invalidIndices = initialIndices.filter(
      (i) => !authSource.availableIndices.includes(i)
    );
    const logs = logger.logBuffer || [];
    const accountNameMap = authSource.accountNameMap;
    const accountDetails = initialIndices.map((index) => {
      const isInvalid = invalidIndices.includes(index);
      const name = isInvalid
        ? "N/A (JSON格式错误)"
        : accountNameMap.get(index) || "N/A (未命名)";
      return { index, name };
    });

    const data = {
      status: {
        streamingMode: `${serverSystem.streamingMode} (仅启用流式传输时生效)`,
        browserConnected: !!browserManager.browser,
        immediateSwitchStatusCodes:
          config.immediateSwitchStatusCodes.length > 0
            ? `[${config.immediateSwitchStatusCodes.join(", ")}]`
            : "已禁用",
        apiKeySource: config.apiKeySource,
        currentAuthIndex: requestHandler.currentAuthIndex,
        usageCount: `${requestHandler.usageCount} / ${
          config.switchOnUses > 0 ? config.switchOnUses : "N/A"
        }`,
        failureCount: `${requestHandler.failureCount} / ${
          config.failureThreshold > 0 ? config.failureThreshold : "N/A"
        }`,
        initialIndices: `[${initialIndices.join(", ")}] (总数: ${
          initialIndices.length
        })`,
        accountDetails: accountDetails,
        invalidIndices: `[${invalidIndices.join(", ")}] (总数: ${
          invalidIndices.length
        })`,
      },
      logs: logs.join("\n"),
      logCount: logs.length,
    };
    res.json(data);
  });

  app.post("/api/switch-account", isAuthenticated, async (req, res) => {
    try {
      const { targetIndex } = req.body;
      if (targetIndex !== undefined && targetIndex !== null) {
        logger.info(
          `[WebUI] 收到切换到指定账号 #${targetIndex} 的请求...`
        );
        const result = await requestHandler._switchToSpecificAuth(targetIndex);
        if (result.success) {
          res.status(200).send(`切换成功！已激活账号 #${result.newIndex}。`);
        } else {
          res.status(400).send(result.reason);
        }
      } else {
        logger.info("[WebUI] 收到手动切换下一个账号的请求...");
        if (authSource.availableIndices.length <= 1) {
          return res
            .status(400)
            .send("切换操作已取消：只有一个可用账号，无法切换。");
        }
        const result = await requestHandler._switchToNextAuth();
        if (result.success) {
          res.status(200).send(`切换成功！已切换到账号 #${result.newIndex}。`);
        } else if (result.fallback) {
          res
            .status(200)
            .send(`切换失败，但已成功回退到账号 #${result.newIndex}。`);
        } else {
          res.status(409).send(`操作未执行: ${result.reason}`);
        }
      }
    } catch (error) {
      res
        .status(500)
        .send(`致命错误：操作失败！请检查日志。错误: ${error.message}`);
    }
  });

  app.post("/api/set-mode", isAuthenticated, (req, res) => {
    const newMode = req.body.mode;
    if (newMode === "fake" || newMode === "real") {
      serverSystem.streamingMode = newMode;
      logger.info(
        `[WebUI] 流式模式已由认证用户切换为: ${serverSystem.streamingMode}`
      );
      res.status(200).send(`流式模式已切换为: ${serverSystem.streamingMode}`);
    } else {
      res.status(400).send('无效模式. 请用 "fake" 或 "real".');
    }
  });

  // Apply auth middleware
  app.use(_createAuthMiddleware());

  // Block v1/v1beta API routes during system busy (startup/account switching)
  app.use(/^\/v1(beta)?\//i, (req, res, next) => {
    if (requestHandler.isSystemBusy) {
      logger.warn(
        `[API] 请求被拒绝: 系统正在进行账号切换 - ${req.method} ${req.path}`
      );
      return res.status(503).json({
        error: {
          message: "正在更换账号中，请稍后再试",
          code: 503,
          type: "service_unavailable"
        }
      });
    }
    next();
  });

  // Model list endpoint
  app.get("/v1/models", async (req, res) => {
    const buildModelPayload = (model) => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (typeof model === "string") {
        return {
          id: model,
          object: "model",
          created: nowSeconds,
          owned_by: "google",
          name: model,
          display_name: model,
          supported_generation_methods: [],
        };
      }

      const rawName = model?.name || model?.id || model?.displayName || "unknown-model";
      const normalizedId = rawName.includes("/")
        ? rawName.split("/").pop()
        : rawName;
      let created = nowSeconds;
      if (model?.createTime) {
        const parsed = Date.parse(model.createTime);
        if (!Number.isNaN(parsed)) {
          created = Math.floor(parsed / 1000);
        }
      }

      return {
        id: normalizedId,
        object: "model",
        created,
        owned_by: "google",
        name: model?.name || normalizedId,
        display_name: model?.displayName || normalizedId,
        supported_generation_methods: model?.supportedGenerationMethods || [],
      };
    };

    try {
      const upstreamModels = await requestHandler.fetchAvailableModels();
      if (upstreamModels.length === 0) {
        throw new Error("上游未返回任何模型。");
      }
      const payload = upstreamModels.map(buildModelPayload);
      return res.status(200).json({ object: "list", data: payload });
    } catch (error) {
      logger.warn(
        `[Models] 实时获取模型列表失败: ${error.message}，将回退到本地配置。`
      );
      const fallbackIds = config.modelList || ["gemini-2.5-pro"];
      const fallbackPayload = fallbackIds.map(buildModelPayload);
      return res.status(200).json({ object: "list", data: fallbackPayload });
    }
  });

  // OpenAI chat completions endpoint
  app.post("/v1/chat/completions", (req, res) => {
    requestHandler.processOpenAIRequest(req, res);
  });

  // Catch-all proxy route
  app.all(/(.*)/, (req, res) => {
    requestHandler.processRequest(req, res);
  });
}

module.exports = createRoutes;
