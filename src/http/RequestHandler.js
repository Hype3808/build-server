class RequestHandler {
  constructor(
    serverSystem,
    connectionRegistry,
    logger,
    browserManager,
    config,
    authSource
  ) {
    this.serverSystem = serverSystem;
    this.connectionRegistry = connectionRegistry;
    this.logger = logger;
    this.browserManager = browserManager;
    this.config = config;
    this.authSource = authSource;
    this.maxRetries = this.config.maxRetries;
    this.retryDelay = this.config.retryDelay;
    this.failureCount = 0;
    this.usageCount = 0;
    this.isAuthSwitching = false;
    this.needsSwitchingAfterRequest = false;
    this.isSystemBusy = false;
    this.fakeStreamPrefix = "假流式/";
  }

  get currentAuthIndex() {
    return this.browserManager.currentAuthIndex;
  }

  _getMaxAuthIndex() {
    return this.authSource.getMaxIndex();
  }

  _getNextAuthIndex() {
    const available = this.authSource.availableIndices; // 使用新的 availableIndices
    if (available.length === 0) return null;

    const currentIndexInArray = available.indexOf(this.currentAuthIndex);

    if (currentIndexInArray === -1) {
      this.logger.warn(
        `[Auth] 当前索引 ${this.currentAuthIndex} 不在可用列表中，将切换到第一个可用索引。`
      );
      return available[0];
    }

    const nextIndexInArray = (currentIndexInArray + 1) % available.length;
    return available[nextIndexInArray];
  }

  async _switchToNextAuth() {
    if (this.authSource.availableIndices.length <= 1) {
      this.logger.warn("[Auth] 😕 检测到只有一个可用账号，拒绝切换操作。");
      throw new Error("Only one account is available, cannot switch.");
    }
    if (this.isAuthSwitching) {
      this.logger.info("🔄 [Auth] 正在切换账号，跳过重复操作");
      return { success: false, reason: "Switch already in progress." };
    }

    // --- 加锁！ ---
    this.isAuthSwitching = true;
    this.isSystemBusy = true;

    try {
      const previousAuthIndex = this.currentAuthIndex;
      const nextAuthIndex = this._getNextAuthIndex();

      this.logger.info("==================================================");
      this.logger.info(`🔄 [Auth] 开始账号切换流程`);
      this.logger.info(`   • 当前账号: #${previousAuthIndex}`);
      this.logger.info(`   • 目标账号: #${nextAuthIndex}`);
      this.logger.info("==================================================");

      try {
        await this.browserManager.switchAccount(nextAuthIndex);
        this.failureCount = 0;
        this.usageCount = 0;
        this.logger.info(
          `✅ [Auth] 成功切换到账号 #${this.currentAuthIndex}，计数已重置。`
        );
        return { success: true, newIndex: this.currentAuthIndex };
      } catch (error) {
        this.logger.error(
          `❌ [Auth] 切换到账号 #${nextAuthIndex} 失败: ${error.message}`
        );
        this.logger.warn(
          `🚨 [Auth] 切换失败，正在尝试回退到上一个可用账号 #${previousAuthIndex}...`
        );
        try {
          await this.browserManager.launchOrSwitchContext(previousAuthIndex);
          this.logger.info(`✅ [Auth] 成功回退到账号 #${previousAuthIndex}！`);
          this.failureCount = 0;
          this.usageCount = 0;
          this.logger.info("[Auth] 失败和使用计数已在回退成功后重置为0。");
          return {
            success: false,
            fallback: true,
            newIndex: this.currentAuthIndex,
          };
        } catch (fallbackError) {
          this.logger.error(
            `FATAL: ❌❌❌ [Auth] 紧急回退到账号 #${previousAuthIndex} 也失败了！服务可能中断。`
          );
          throw fallbackError;
        }
      }
    } finally {
      // --- 解锁！---
      this.isAuthSwitching = false;
      this.isSystemBusy = false;
    }
  }

  async _switchToSpecificAuth(targetIndex) {
    if (this.isAuthSwitching) {
      this.logger.info("🔄 [Auth] 正在切换账号，跳过重复操作");
      return { success: false, reason: "Switch already in progress." };
    }
    if (!this.authSource.availableIndices.includes(targetIndex)) {
      return {
        success: false,
        reason: `切换失败：账号 #${targetIndex} 无效或不存在。`,
      };
    }

    this.isSystemBusy = true;
    this.isAuthSwitching = true;
    try {
      this.logger.info(`🔄 [Auth] 开始切换到指定账号 #${targetIndex}...`);
      await this.browserManager.switchAccount(targetIndex);
      this.failureCount = 0;
      this.usageCount = 0;
      this.logger.info(
        `✅ [Auth] 成功切换到账号 #${this.currentAuthIndex}，计数已重置。`
      );
      return { success: true, newIndex: this.currentAuthIndex };
    } catch (error) {
      this.logger.error(
        `❌ [Auth] 切换到指定账号 #${targetIndex} 失败: ${error.message}`
      );
      // 对于指定切换，失败了就直接报错，不进行回退，让用户知道这个账号有问题
      throw error;
    } finally {
      this.isAuthSwitching = false;
      this.isSystemBusy = false;
    }
  }

  async _handleRequestFailureAndSwitch(errorDetails, res) {
    // 失败计数逻辑
    if (this.config.failureThreshold > 0) {
      this.failureCount++;
      this.logger.warn(
        `⚠️ [Auth] 请求失败 - 失败计数: ${this.failureCount}/${this.config.failureThreshold} (当前账号索引: ${this.currentAuthIndex})`
      );
    }

    const isImmediateSwitch = this.config.immediateSwitchStatusCodes.includes(
      errorDetails.status
    );
    const isThresholdReached =
      this.config.failureThreshold > 0 &&
      this.failureCount >= this.config.failureThreshold;

    // 只要满足任一切换条件
    if (isImmediateSwitch || isThresholdReached) {
      if (isImmediateSwitch) {
        this.logger.warn(
          `🔴 [Auth] 收到状态码 ${errorDetails.status}，触发立即切换账号...`
        );
      } else {
        this.logger.warn(
          `🔴 [Auth] 达到失败阈值 (${this.failureCount}/${this.config.failureThreshold})！准备切换账号...`
        );
      }

      // [核心修改] 等待切换操作完成，并根据其结果发送不同消息
      try {
        await this._switchToNextAuth();
        // 如果上面这行代码没有抛出错误，说明切换/回退成功了
        const successMessage = `🔄 目标账户无效，已自动回退至账号 #${this.currentAuthIndex}。`;
        this.logger.info(`[Auth] ${successMessage}`);
        if (res) this._sendErrorChunkToClient(res, successMessage);
      } catch (error) {
        let userMessage = `❌ 致命错误：发生未知切换错误: ${error.message}`;

        if (error.message.includes("Only one account is available")) {
          // 场景：单账号无法切换
          userMessage = "❌ 切换失败：只有一个可用账号。";
          this.logger.info("[Auth] 只有一个可用账号，失败计数已重置。");
          this.failureCount = 0;
        } else if (error.message.includes("回退失败原因")) {
          // 场景：切换到坏账号后，连回退都失败了
          userMessage = `❌ 致命错误：自动切换和紧急回退均失败，服务可能已中断，请检查日志！`;
        } else if (error.message.includes("切换到账号")) {
          // 场景：切换到坏账号后，成功回退（这是一个伪"成功"，本质是上一个操作失败了）
          userMessage = `⚠️ 自动切换失败：已自动回退到账号 #${this.currentAuthIndex}，请检查目标账号是否存在问题。`;
        }

        this.logger.error(`[Auth] 后台账号切换任务最终失败: ${error.message}`);
        if (res) this._sendErrorChunkToClient(res, userMessage);
      }

      return;
    }
  }

  async processRequest(req, res) {
    const requestId = this._generateRequestId();
    res.on("close", () => {
      if (!res.writableEnded) {
        this.logger.warn(
          `[Request] 客户端已提前关闭请求 #${requestId} 的连接。`
        );
        this._cancelBrowserRequest(requestId);
      }
    });

    if (!this.connectionRegistry.hasActiveConnections()) {
      if (this.isSystemBusy) {
        this.logger.warn(
          "[System] 检测到连接断开，但系统正在进行切换/恢复，拒绝新请求。"
        );
        return this._sendErrorResponse(
          res,
          503,
          "服务器正在进行内部维护（账号切换/恢复），请稍后重试。"
        );
      }

      this.logger.error(
        "❌ [System] 检测到浏览器WebSocket连接已断开！可能是进程崩溃。正在尝试恢复..."
      );
      // --- 开始恢复前，加锁！ ---
      this.isSystemBusy = true;
      try {
        await this.browserManager.launchOrSwitchContext(this.currentAuthIndex);
        this.logger.info(`✅ [System] 浏览器已成功恢复！`);
      } catch (error) {
        this.logger.error(`❌ [System] 浏览器自动恢复失败: ${error.message}`);
        return this._sendErrorResponse(
          res,
          503,
          "服务暂时不可用：后端浏览器实例崩溃且无法自动恢复，请联系管理员。"
        );
      } finally {
        // --- 恢复结束后，解锁！ ---
        this.isSystemBusy = false;
      }
    }

    if (this.isSystemBusy) {
      this.logger.warn(
        "[System] 收到新请求，但系统正在进行切换/恢复，拒绝新请求。"
      );
      return this._sendErrorResponse(
        res,
        503,
        "正在更换账号中，请稍后再试"
      );
    }

    // Check if browser is ready
    if (!this.browserManager.browser || !this.browserManager.page) {
      this.logger.warn(
        "[System] 收到新请求，但浏览器尚未完全初始化。"
      );
      return this._sendErrorResponse(
        res,
        503,
        "系统正在启动中，请稍后再试"
      );
    }

    const isGenerativeRequest =
      req.method === "POST" &&
      (req.path.includes("generateContent") ||
        req.path.includes("streamGenerateContent"));

    const proxyRequest = this._buildProxyRequest(req, requestId);
    const mixModelContext = this._normalizeModelIdentifierInPath(proxyRequest);
    proxyRequest.is_generative = isGenerativeRequest;
    // 根据判断结果，为浏览器脚本准备标志位
    const messageQueue = this.connectionRegistry.createMessageQueue(requestId);
    const wantsStreamByHeader =
      req.headers.accept && req.headers.accept.includes("text/event-stream");
    const wantsStreamByPath = req.path.includes(":streamGenerateContent");
    const wantsStream = wantsStreamByHeader || wantsStreamByPath;

    try {
      if (wantsStream) {
        const resolvedStreamMode = this._resolveStreamingModeForRequest(
          mixModelContext
        );
        proxyRequest.streaming_mode = resolvedStreamMode;
        this.logger.info(
          `[Request] 客户端启用流式传输 (模式: ${resolvedStreamMode})，进入流式处理模式...`
        );
        if (resolvedStreamMode === "fake") {
          await this._handlePseudoStreamResponse(
            proxyRequest,
            messageQueue,
            req,
            res
          );
        } else {
          await this._handleRealStreamResponse(proxyRequest, messageQueue, res);
        }
      } else {
        // --- 客户端想要非流式响应 ---
        // 明确告知浏览器脚本本次应按"一次性JSON"（即fake模式）来处理
        proxyRequest.streaming_mode = "fake";
        await this._handleNonStreamResponse(proxyRequest, messageQueue, res);
      }
    } catch (error) {
      this._handleRequestError(error, res);
    } finally {
      this.connectionRegistry.removeMessageQueue(requestId);
      if (this.needsSwitchingAfterRequest) {
        this.logger.info(
          `[Auth] 轮换计数已达到切换阈值 (${this.usageCount}/${this.config.switchOnUses})，将在后台自动切换账号...`
        );
        this._switchToNextAuth().catch((err) => {
          this.logger.error(`[Auth] 后台账号切换任务失败: ${err.message}`);
        });
        this.needsSwitchingAfterRequest = false;
      }
    }
  }

  async processOpenAIRequest(req, res) {
    const requestId = this._generateRequestId();
    const isOpenAIStream = req.body.stream === true;
    const model = req.body.model || "gemini-1.5-pro-latest";
    const openAIModelContext = this._normalizeMixModeModelId(model);
    const googleModel = openAIModelContext.normalizedModel || model;

    if (this.isSystemBusy) {
      this.logger.warn("[Request] 正在切换账号，拒绝新请求");
      return this._sendErrorResponse(
        res,
        503,
        "正在更换账号中，请稍后再试"
      );
    }

    // Check if browser is ready
    if (!this.browserManager.browser || !this.browserManager.page) {
      this.logger.warn(
        "[Request] 收到OpenAI请求，但浏览器尚未完全初始化。"
      );
      return this._sendErrorResponse(
        res,
        503,
        "系统正在启动中，请稍后再试"
      );
    }

    // 1. 翻译请求体
    let googleBody;
    try {
      googleBody = this._translateOpenAIToGoogle(req.body, model);
    } catch (error) {
      this.logger.error(`[Adapter] OpenAI请求翻译失败: ${error.message}`);
      return this._sendErrorResponse(
        res,
        400,
        "Invalid OpenAI request format."
      );
    }

    // 2. 构建代理请求
    const googleEndpoint = isOpenAIStream
      ? "streamGenerateContent"
      : "generateContent";
    const proxyRequest = {
      path: `/v1beta/models/${googleModel}:${googleEndpoint}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      query_params: isOpenAIStream ? { alt: "sse" } : {},
      body: JSON.stringify(googleBody),
      request_id: requestId,
      is_generative: true,
      streaming_mode: this.serverSystem.streamingMode,
      client_wants_stream: true,
    };

    const messageQueue = this.connectionRegistry.createMessageQueue(requestId);

    try {
      // 根据流式模式选择不同的处理方式
      if (isOpenAIStream) {
        const resolvedStreamMode = this._resolveStreamingModeForRequest(
          openAIModelContext
        );
        proxyRequest.streaming_mode = resolvedStreamMode;
        if (resolvedStreamMode === "fake") {
          // 使用伪流式模式处理
          await this._handleOpenAIPseudoStreamResponse(
            proxyRequest,
            messageQueue,
            model,
            res
          );
        } else {
          // 使用真实流式模式处理
          await this._handleOpenAIRealStreamResponse(
            proxyRequest,
            messageQueue,
            model,
            res
          );
        }
      } else {
        // 非流式请求
        proxyRequest.streaming_mode = "fake";
        await this._handleOpenAINonStreamResponse(proxyRequest, messageQueue, model, res);
      }
    } catch (error) {
      this._handleRequestError(error, res);
    } finally {
      this.connectionRegistry.removeMessageQueue(requestId);
      if (!res.writableEnded) {
        res.end();
      }
      if (this.needsSwitchingAfterRequest) {
        this.logger.info(
          `[Auth] 轮换计数已达到切换阈值 (${this.usageCount}/${this.config.switchOnUses})，将在后台自动切换账号...`
        );
        this._switchToNextAuth().catch((err) => {
          this.logger.error(`[Auth] 后台账号切换任务失败: ${err.message}`);
        });
        this.needsSwitchingAfterRequest = false;
      }
    }
  }

  async _handleOpenAIPseudoStreamResponse(proxyRequest, messageQueue, model, res) {
    this.logger.info(
      "[Request] OpenAI客户端启用流式传输 (fake)，进入伪流式处理模式..."
    );
    res.locals = res.locals || {};
    res.locals.__proxyPseudoStream = true;
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    } else {
      this._flushResponse(res);
    }
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    } else {
      this._flushResponse(res);
    }
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    } else {
      this._flushResponse(res);
    }
    // Send heartbeat every 3 seconds to prevent gateway timeout
    const connectionMaintainer = setInterval(() => {
      if (!res.writableEnded) {
        const heartbeat = {
          id: `chatcmpl-${proxyRequest.request_id}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null
          }]
        };
        this._writeSseChunk(res, `data: ${JSON.stringify(heartbeat)}\n\n`);
      } else {
        clearInterval(connectionMaintainer);
      }
    }, 3000);

    try {
      let lastMessage, requestFailed = false;

      // 重试循环
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        if (attempt > 1) {
          this.logger.info(
            `[Request] 请求尝试 #${attempt}/${this.maxRetries}...`
          );
        }
        this._forwardRequest(proxyRequest);
        try {
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Response from browser timed out after 300 seconds")),
              300000
            )
          );
          lastMessage = await Promise.race([
            messageQueue.dequeue(),
            timeoutPromise,
          ]);
        } catch (timeoutError) {
          this.logger.error(`[Request] 致命错误: ${timeoutError.message}`);
          lastMessage = {
            event_type: "error",
            status: 504,
            message: timeoutError.message,
          };
        }

        if (lastMessage.event_type === "error") {
          if (
            !(
              lastMessage.message &&
              lastMessage.message.includes("The user aborted a request")
            )
          ) {
            this.logger.warn(
              `[Request] 尝试 #${attempt} 失败: 收到 ${
                lastMessage.status || "未知"
              } 错误。 - ${lastMessage.message}`
            );
          }

          if (attempt < this.maxRetries) {
            await new Promise((resolve) =>
              setTimeout(resolve, this.retryDelay)
            );
            continue;
          }
          requestFailed = true;
        }
        break;
      }

      // 处理失败
      if (requestFailed) {
        if (
          lastMessage.message &&
          lastMessage.message.includes("The user aborted a request")
        ) {
          this.logger.info(
            `[Request] 请求 #${proxyRequest.request_id} 已由用户妥善取消，不计入失败统计。`
          );
        } else {
          this.logger.error(
            `[Request] 所有 ${this.maxRetries} 次重试均失败，将计入失败统计。`
          );
          await this._handleRequestFailureAndSwitch(lastMessage, res);
          // 发送OpenAI格式的错误
          const errorChunk = `data: ${JSON.stringify({
            id: `chatcmpl-${proxyRequest.request_id}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: { content: `[代理系统提示] 请求最终失败: ${lastMessage.message}` },
              finish_reason: "stop"
            }]
          })}\n\n`;
          this._writeSseChunk(res, errorChunk);
        }
        this._writeSseChunk(res, "data: [DONE]\n\n");
        return;
      }

      // 处理成功 - 重置失败计数
      if (this.failureCount > 0) {
        this.logger.info(
          `✅ [Auth] OpenAI生成请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`
        );
        this.failureCount = 0;
      }
      
      // Increment usage count on successful request
      if (this.config.switchOnUses > 0) {
        this.usageCount++;
        this.logger.info(
          `[Request] OpenAI生成请求成功 - 账号轮换计数: ${this.usageCount}/${this.config.switchOnUses} (当前账号: ${this.currentAuthIndex})`
        );
        if (this.usageCount >= this.config.switchOnUses) {
          this.needsSwitchingAfterRequest = true;
        }
      }

      // 获取完整响应数据
      const dataMessage = await messageQueue.dequeue();
      const endMessage = await messageQueue.dequeue();
      
      if (dataMessage.data) {
        // In fake mode, dataMessage.data contains the full JSON response (not SSE formatted)
        // Parse it and convert to OpenAI streaming format
        try {
          const googleResponse = JSON.parse(dataMessage.data);
          const candidate = googleResponse.candidates?.[0];
          
          let content = "";
          if (candidate && candidate.content && Array.isArray(candidate.content.parts)) {
            const imagePart = candidate.content.parts.find((p) => p.inlineData);
            if (imagePart) {
              const image = imagePart.inlineData;
              content = `![Generated Image](data:${image.mimeType};base64,${image.data})`;
              this.logger.info("[Adapter] 从 parts.inlineData 中成功解析到图片。");
            } else {
              content = candidate.content.parts.map((p) => p.text).join("") || "";
            }
          }
          
          const finishReason = candidate?.finishReason || "stop";
          
          // Send the content chunk
          const contentChunk = {
            id: `chatcmpl-${proxyRequest.request_id}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: { content: content },
              finish_reason: null
            }]
          };
          this._writeSseChunk(res, `data: ${JSON.stringify(contentChunk)}\n\n`);
          
          // Send the final chunk with finish_reason
          const finalChunk = {
            id: `chatcmpl-${proxyRequest.request_id}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: finishReason
            }]
          };
          this._writeSseChunk(res, `data: ${JSON.stringify(finalChunk)}\n\n`);
          
          this.logger.info(
            `✅ [Request] OpenAI伪流式响应结束，原因: ${finishReason}，请求ID: ${proxyRequest.request_id}`
          );
        } catch (e) {
          this.logger.error(`[Adapter] 解析响应失败: ${e.message}`);
        }
      }
      
      if (endMessage.type !== "STREAM_END") {
        this.logger.warn("[Request] 未收到预期的流结束信号。");
      }
      
      this._writeSseChunk(res, "data: [DONE]\n\n");
    } catch (error) {
      this._handleRequestError(error, res);
    } finally {
      clearInterval(connectionMaintainer);
      if (!res.writableEnded) {
        res.end();
      }
      this.logger.info(
        `[Request] OpenAI响应处理结束，请求ID: ${proxyRequest.request_id}`
      );
    }
  }

  async _handleOpenAIRealStreamResponse(proxyRequest, messageQueue, model, res) {
    this.logger.info(`[Request] OpenAI请求已派发给浏览器端处理 (real模式)...`);
    this._forwardRequest(proxyRequest);
    const initialMessage = await messageQueue.dequeue();

    if (initialMessage.event_type === "error") {
      this.logger.error(
        `[Adapter] 收到来自浏览器的错误，将触发切换逻辑。状态码: ${initialMessage.status}, 消息: ${initialMessage.message}`
      );

      await this._handleRequestFailureAndSwitch(initialMessage, res);

      if (!res.writableEnded) {
        this._writeSseChunk(res, "data: [DONE]\n\n");
        res.end();
      }
      return;
    }

    if (this.failureCount > 0) {
      this.logger.info(
        `✅ [Auth] OpenAI接口请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`
      );
      this.failureCount = 0;
    }
    
    // Increment usage count on successful request
    if (this.config.switchOnUses > 0) {
      this.usageCount++;
      this.logger.info(
        `[Request] OpenAI生成请求成功 - 账号轮换计数: ${this.usageCount}/${this.config.switchOnUses} (当前账号: ${this.currentAuthIndex})`
      );
      if (this.usageCount >= this.config.switchOnUses) {
        this.needsSwitchingAfterRequest = true;
      }
    }

    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let lastGoogleChunk = "";
    let sseBuffer = "";

    const processSseEvent = (rawEvent) => {
      const lines = rawEvent.split("\n");
      const dataLines = [];
      for (const line of lines) {
        if (!line) continue;
        if (line.startsWith(":")) {
          continue;
        }
        if (line.startsWith("data:")) {
          const value = line.slice(5).trimStart();
          dataLines.push(value);
        }
      }

      if (dataLines.length === 0) {
        return;
      }

      const payload = dataLines.join("\n").trim();
      if (!payload || payload === "[DONE]") {
        return;
      }

      const translatedChunk = this._translateGoogleToOpenAIStream(
        payload,
        model
      );
              if (translatedChunk) {
                this._writeSseChunk(res, translatedChunk);
              }
      lastGoogleChunk = payload;
    };

    const processSseBuffer = () => {
      let delimiterIndex;
      while ((delimiterIndex = sseBuffer.indexOf("\n\n")) !== -1) {
        const rawEvent = sseBuffer.slice(0, delimiterIndex);
        sseBuffer = sseBuffer.slice(delimiterIndex + 2);
        if (rawEvent.trim()) {
          processSseEvent(rawEvent);
        }
      }
    };

    while (true) {
      const message = await messageQueue.dequeue(300000);
      if (message.type === "STREAM_END") {
        if (sseBuffer.trim()) {
          sseBuffer += "\n\n";
          processSseBuffer();
        }
        this._writeSseChunk(res, "data: [DONE]\n\n");
        break;
      }
      if (message.event_type === "error") {
        this.logger.error(
          `[Adapter] 浏览器流式处理中断。状态码: ${
            message.status || "未知"
          }, 信息: ${message.message || "未知"}`
        );
        await this._handleRequestFailureAndSwitch(message, res);
        const errorChunk = {
          id: `chatcmpl-${proxyRequest.request_id}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [
            {
              index: 0,
              delta: {
                content: `[代理系统提示] 上游流式传输失败: ${
                  message.message || "未知错误"
                }`,
              },
              finish_reason: "error",
            },
          ],
        };
        this._writeSseChunk(res, `data: ${JSON.stringify(errorChunk)}\n\n`);
        this._writeSseChunk(res, "data: [DONE]\n\n");
        return;
      }

      if (typeof message.data === "string" && message.data.length > 0) {
        const normalizedChunk = message.data
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n");
        sseBuffer += normalizedChunk;
        processSseBuffer();
      }
    }

    try {
      if (lastGoogleChunk) {
        const lastResponse = JSON.parse(lastGoogleChunk);
        const finishReason =
          lastResponse.candidates?.[0]?.finishReason || "UNKNOWN";
        this.logger.info(
          `✅ [Request] OpenAI流式响应结束，原因: ${finishReason}，请求ID: ${proxyRequest.request_id}`
        );
      }
    } catch (e) {
      this.logger.warn(`[Request] 无法解析最后一个响应块: ${e.message}`);
    }
  }

  async _handleOpenAINonStreamResponse(proxyRequest, messageQueue, model, res) {
    this.logger.info(`[Request] OpenAI进入非流式处理模式...`);
    
    this._forwardRequest(proxyRequest);
    const initialMessage = await messageQueue.dequeue();

    if (initialMessage.event_type === "error") {
      this.logger.error(
        `[Adapter] 收到来自浏览器的错误，将触发切换逻辑。状态码: ${initialMessage.status}, 消息: ${initialMessage.message}`
      );
      await this._handleRequestFailureAndSwitch(initialMessage, null);
      return this._sendErrorResponse(
        res,
        initialMessage.status || 500,
        initialMessage.message
      );
    }

    if (this.failureCount > 0) {
      this.logger.info(
        `✅ [Auth] OpenAI接口请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`
      );
      this.failureCount = 0;
    }
    
    // Increment usage count on successful request
    if (this.config.switchOnUses > 0) {
      this.usageCount++;
      this.logger.info(
        `[Request] OpenAI生成请求成功 - 账号轮换计数: ${this.usageCount}/${this.config.switchOnUses} (当前账号: ${this.currentAuthIndex})`
      );
      if (this.usageCount >= this.config.switchOnUses) {
        this.needsSwitchingAfterRequest = true;
      }
    }

    let fullBody = "";
    while (true) {
      const message = await messageQueue.dequeue(300000);
      if (message.type === "STREAM_END") {
        break;
      }
      if (message.event_type === "chunk" && message.data) {
        fullBody += message.data;
      }
    }

    const googleResponse = JSON.parse(fullBody);
    const candidate = googleResponse.candidates?.[0];

    let responseContent = "";
    if (
      candidate &&
      candidate.content &&
      Array.isArray(candidate.content.parts)
    ) {
      const imagePart = candidate.content.parts.find((p) => p.inlineData);
      if (imagePart) {
        const image = imagePart.inlineData;
        responseContent = `![Generated Image](data:${image.mimeType};base64,${image.data})`;
        this.logger.info(
          "[Adapter] 从 parts.inlineData 中成功解析到图片。"
        );
      } else {
        responseContent =
          candidate.content.parts.map((p) => p.text).join("\n") || "";
      }
    }

    const openaiResponse = {
      id: `chatcmpl-${proxyRequest.request_id}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: responseContent },
          finish_reason: candidate?.finishReason || "UNKNOWN",
        },
      ],
    };

    const finishReason = candidate?.finishReason || "UNKNOWN";
    this.logger.info(
      `✅ [Request] OpenAI非流式响应结束，原因: ${finishReason}，请求ID: ${proxyRequest.request_id}`
    );

    res.status(200).json(openaiResponse);
  }

  _cancelBrowserRequest(requestId) {
    const connection = this.connectionRegistry.getFirstConnection();
    if (connection) {
      this.logger.info(
        `[Request] 正在向浏览器发送取消请求 #${requestId} 的指令...`
      );
      connection.send(
        JSON.stringify({
          event_type: "cancel_request",
          request_id: requestId,
        })
      );
    } else {
      this.logger.warn(
        `[Request] 无法发送取消指令：没有可用的浏览器WebSocket连接。`
      );
    }
  }

  _generateRequestId() {
    return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  _buildProxyRequest(req, requestId) {
    let requestBody = "";
    if (req.body) {
      requestBody = JSON.stringify(req.body);
    }
    return {
      path: req.path,
      method: req.method,
      headers: req.headers,
      query_params: req.query,
      body: requestBody,
      request_id: requestId,
      streaming_mode: this.serverSystem.streamingMode,
    };
  }

  async fetchAvailableModels() {
    if (!this.connectionRegistry.hasActiveConnections()) {
      throw new Error("没有可用的浏览器WebSocket连接，无法查询模型列表。");
    }

    const requestId = this._generateRequestId();
    const messageQueue = this.connectionRegistry.createMessageQueue(requestId);
    const proxyRequest = {
      path: "/v1beta/models",
      method: "GET",
      headers: { Accept: "application/json" },
      query_params: {},
      body: "",
      request_id: requestId,
      streaming_mode: "fake",
    };

    this.logger.info("[Models] 正在通过浏览器端查询实时模型列表...");

    try {
      this._forwardRequest(proxyRequest);

      const headerMessage = await messageQueue.dequeue(30000);
      if (headerMessage.event_type === "error") {
        throw new Error(
          headerMessage.message || "上游返回未知错误，无法获取模型列表。"
        );
      }

      let fullBody = "";
      while (true) {
        const message = await messageQueue.dequeue(30000);
        if (message.type === "STREAM_END") break;
        if (message.event_type === "chunk" && message.data) {
          fullBody += message.data;
        }
      }

      if (!fullBody) {
        this.logger.warn("[Models] 上游响应为空，返回空列表。");
        return [];
      }

      try {
        const parsed = JSON.parse(fullBody);
        if (Array.isArray(parsed.models)) {
          return parsed.models;
        }
        if (Array.isArray(parsed.data)) {
          return parsed.data;
        }
        this.logger.warn("[Models] 上游响应未包含 models 数组，返回空列表。");
        return [];
      } catch (error) {
        throw new Error(`解析模型列表失败: ${error.message}`);
      }
    } finally {
      this.connectionRegistry.removeMessageQueue(requestId);
    }
  }

  appendMixModeModelVariants(models, { force = false } = {}) {
    return this._appendMixModeVariants(models, force);
  }

  _forwardRequest(proxyRequest) {
    const connection = this.connectionRegistry.getFirstConnection();
    if (connection) {
      connection.send(JSON.stringify(proxyRequest));
    } else {
      throw new Error("无法转发请求：没有可用的WebSocket连接。");
    }
  }

  _sendErrorChunkToClient(res, errorMessage) {
    const errorPayload = {
      error: {
        message: `[代理系统提示] ${errorMessage}`,
        type: "proxy_error",
        code: "proxy_error",
      },
    };
    const chunk = `data: ${JSON.stringify(errorPayload)}\n\n`;
    if (res && !res.writableEnded) {
      this._writeSseChunk(res, chunk);
      this.logger.info(`[Request] 已向客户端发送标准错误信号: ${errorMessage}`);
    }
  }

  _writeSseChunk(res, chunk) {
    if (!res || res.writableEnded) return;
    res.write(chunk);
    this._flushResponse(res);
  }

  _flushResponse(res) {
    if (!res) return;
    try {
      if (typeof res.flush === "function") {
        res.flush();
      } else if (res.socket && typeof res.socket.flush === "function") {
        res.socket.flush();
      }
    } catch (flushError) {
      this.logger.debug?.(`[Request] SSE flush skipped: ${flushError.message}`);
    }
  }

  async _handlePseudoStreamResponse(proxyRequest, messageQueue, req, res) {
    this.logger.info(
      "[Request] 客户端启用流式传输 (fake)，进入伪流式处理模式..."
    );
    res.locals = res.locals || {};
    res.locals.__proxyPseudoStream = true;
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    } else {
      this._flushResponse(res);
    }
    // Send heartbeat every 3 seconds to prevent gateway timeout
    const connectionMaintainer = setInterval(() => {
      if (!res.writableEnded) {
        const heartbeatChunk = {
          id: `chatcmpl-${proxyRequest.request_id}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: proxyRequest.path || "proxy-pseudo-stream",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "" },
              finish_reason: null,
            },
          ],
        };
        this._writeSseChunk(res, `data: ${JSON.stringify(heartbeatChunk)}\n\n`);
      } else {
        clearInterval(connectionMaintainer);
      }
    }, 3000);

    try {
      let lastMessage,
        requestFailed = false;

      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        if (attempt > 1) {
          this.logger.info(
            `[Request] 请求尝试 #${attempt}/${this.maxRetries}...`
          );
        }
        this._forwardRequest(proxyRequest);
        try {
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error("Response from browser timed out after 300 seconds")
                ),
              300000
            )
          );
          lastMessage = await Promise.race([
            messageQueue.dequeue(),
            timeoutPromise,
          ]);
        } catch (timeoutError) {
          this.logger.error(`[Request] 致命错误: ${timeoutError.message}`);
          lastMessage = {
            event_type: "error",
            status: 504,
            message: timeoutError.message,
          };
        }

        if (lastMessage.event_type === "error") {
          if (
            !(
              lastMessage.message &&
              lastMessage.message.includes("The user aborted a request")
            )
          ) {
            this.logger.warn(
              `[Request] 尝试 #${attempt} 失败: 收到 ${
                lastMessage.status || "未知"
              } 错误。 - ${lastMessage.message}`
            );
          }

          if (attempt < this.maxRetries) {
            await new Promise((resolve) =>
              setTimeout(resolve, this.retryDelay)
            );
            continue;
          }
          requestFailed = true;
        }
        break;
      }

      if (requestFailed) {
        if (
          lastMessage.message &&
          lastMessage.message.includes("The user aborted a request")
        ) {
          this.logger.info(
            `[Request] 请求 #${proxyRequest.request_id} 已由用户妥善取消，不计入失败统计。`
          );
        } else {
          this.logger.error(
            `[Request] 所有 ${this.maxRetries} 次重试均失败，将计入失败统计。`
          );
          await this._handleRequestFailureAndSwitch(lastMessage, res);
          this._sendErrorChunkToClient(
            res,
            `请求最终失败: ${lastMessage.message}`
          );
        }
        return;
      }

      if (proxyRequest.is_generative && this.failureCount > 0) {
        this.logger.info(
          `✅ [Auth] 生成请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`
        );
        this.failureCount = 0;
      }
      
      // Increment usage count on successful request
      if (this.config.switchOnUses > 0 && proxyRequest.is_generative) {
        this.usageCount++;
        this.logger.info(
          `[Request] 生成请求成功 - 账号轮换计数: ${this.usageCount}/${this.config.switchOnUses} (当前账号: ${this.currentAuthIndex})`
        );
        if (this.usageCount >= this.config.switchOnUses) {
          this.needsSwitchingAfterRequest = true;
        }
      }
      
      const dataMessage = await messageQueue.dequeue();
      const endMessage = await messageQueue.dequeue();
      if (dataMessage.data) {
        this._writeSseChunk(res, `data: ${dataMessage.data}\n\n`);
      }
      if (endMessage.type !== "STREAM_END") {
        this.logger.warn("[Request] 未收到预期的流结束信号。");
      }
      try {
        const fullResponse = JSON.parse(dataMessage.data);
        const finishReason =
          fullResponse.candidates?.[0]?.finishReason || "UNKNOWN";
        this.logger.info(
          `✅ [Request] 响应结束，原因: ${finishReason}，请求ID: ${proxyRequest.request_id}`
        );
      } catch (e) {}
      this._writeSseChunk(res, "data: [DONE]\n\n");
    } catch (error) {
      this._handleRequestError(error, res);
    } finally {
      clearInterval(connectionMaintainer);
      if (!res.writableEnded) {
        res.end();
      }
      this.logger.info(
        `[Request] 响应处理结束，请求ID: ${proxyRequest.request_id}`
      );
    }
  }

  async _handleRealStreamResponse(proxyRequest, messageQueue, res) {
    this.logger.info(`[Request] 请求已派发给浏览器端处理...`);
    this._forwardRequest(proxyRequest);
    const headerMessage = await messageQueue.dequeue();

    if (headerMessage.event_type === "error") {
      if (
        headerMessage.message &&
        headerMessage.message.includes("The user aborted a request")
      ) {
        this.logger.info(
          `[Request] 请求 #${proxyRequest.request_id} 已被用户妥善取消，不计入失败统计。`
        );
      } else {
        this.logger.error(`[Request] 请求失败，将计入失败统计。`);
        await this._handleRequestFailureAndSwitch(headerMessage, null);
        return this._sendErrorResponse(
          res,
          headerMessage.status,
          headerMessage.message
        );
      }
      if (!res.writableEnded) res.end();
      return;
    }

    if (proxyRequest.is_generative && this.failureCount > 0) {
      this.logger.info(
        `✅ [Auth] 生成请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`
      );
      this.failureCount = 0;
    }
    
    // Increment usage count on successful request
    if (this.config.switchOnUses > 0 && proxyRequest.is_generative) {
      this.usageCount++;
      this.logger.info(
        `[Request] 生成请求成功 - 账号轮换计数: ${this.usageCount}/${this.config.switchOnUses} (当前账号: ${this.currentAuthIndex})`
      );
      if (this.usageCount >= this.config.switchOnUses) {
        this.needsSwitchingAfterRequest = true;
      }
    }

    this._setResponseHeaders(res, headerMessage);
    this.logger.info("[Request] 开始流式传输...");
    try {
      let lastChunk = "";
      while (true) {
        const dataMessage = await messageQueue.dequeue(30000);
        if (dataMessage.type === "STREAM_END") {
          this.logger.info("[Request] 收到流结束信号。");
          break;
        }
        if (dataMessage.data) {
          this._writeSseChunk(res, dataMessage.data);
          lastChunk = dataMessage.data;
        }
      }
      try {
        if (lastChunk.startsWith("data: ")) {
          const jsonString = lastChunk.substring(6).trim();
          if (jsonString) {
            const lastResponse = JSON.parse(jsonString);
            const finishReason =
              lastResponse.candidates?.[0]?.finishReason || "UNKNOWN";
            this.logger.info(
              `✅ [Request] 响应结束，原因: ${finishReason}，请求ID: ${proxyRequest.request_id}`
            );
          }
        }
      } catch (e) {}
    } catch (error) {
      if (error.message !== "Queue timeout") throw error;
      this.logger.warn("[Request] 真流式响应超时，可能流已正常结束。");
    } finally {
      if (!res.writableEnded) res.end();
      this.logger.info(
        `[Request] 真流式响应连接已关闭，请求ID: ${proxyRequest.request_id}`
      );
    }
  }

  async _handleNonStreamResponse(proxyRequest, messageQueue, res) {
    this.logger.info(`[Request] 进入非流式处理模式...`);

    this._forwardRequest(proxyRequest);

    try {
      const headerMessage = await messageQueue.dequeue();
      if (headerMessage.event_type === "error") {
        if (headerMessage.message?.includes("The user aborted a request")) {
          this.logger.info(
            `[Request] 请求 #${proxyRequest.request_id} 已被用户妥善取消。`
          );
        } else {
          this.logger.error(
            `[Request] 浏览器端返回错误: ${headerMessage.message}`
          );
          await this._handleRequestFailureAndSwitch(headerMessage, null);
        }
        return this._sendErrorResponse(
          res,
          headerMessage.status || 500,
          headerMessage.message
        );
      }

      let fullBody = "";
      while (true) {
        const message = await messageQueue.dequeue(300000);
        if (message.type === "STREAM_END") {
          this.logger.info("[Request] 收到结束信号，数据接收完毕。");
          break;
        }
        if (message.event_type === "chunk" && message.data) {
          fullBody += message.data;
        }
      }

      if (proxyRequest.is_generative && this.failureCount > 0) {
        this.logger.info(
          `✅ [Auth] 非流式生成请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`
        );
        this.failureCount = 0;
      }
      
      // Increment usage count on successful request
      if (this.config.switchOnUses > 0 && proxyRequest.is_generative) {
        this.usageCount++;
        this.logger.info(
          `[Request] 生成请求成功 - 账号轮换计数: ${this.usageCount}/${this.config.switchOnUses} (当前账号: ${this.currentAuthIndex})`
        );
        if (this.usageCount >= this.config.switchOnUses) {
          this.needsSwitchingAfterRequest = true;
        }
      }

      try {
        let parsedBody = JSON.parse(fullBody);
        let needsReserialization = false;

        const candidate = parsedBody.candidates?.[0];
        if (candidate?.content?.parts) {
          const imagePartIndex = candidate.content.parts.findIndex(
            (p) => p.inlineData
          );

          if (imagePartIndex > -1) {
            this.logger.info(
              "[Proxy] 检测到Google格式响应中的图片数据，正在转换为Markdown..."
            );
            const imagePart = candidate.content.parts[imagePartIndex];
            const image = imagePart.inlineData;

            const markdownTextPart = {
              text: `![Generated Image](data:${image.mimeType};base64,${image.data})`,
            };

            candidate.content.parts[imagePartIndex] = markdownTextPart;
            needsReserialization = true;
          }
        }

        const mixAugmentation = this._augmentModelPayloadForMixMode(
          proxyRequest.path,
          parsedBody
        );
        if (mixAugmentation.changed) {
          parsedBody = mixAugmentation.payload;
          needsReserialization = true;
        }

        if (needsReserialization) {
          fullBody = JSON.stringify(parsedBody);
        }
      } catch (e) {
        this.logger.warn(
          `[Proxy] 响应体不是有效的JSON，或在处理图片时出错: ${e.message}`
        );
      }

      try {
        const fullResponse = JSON.parse(fullBody);
        const finishReason =
          fullResponse.candidates?.[0]?.finishReason || "UNKNOWN";
        this.logger.info(
          `✅ [Request] 响应结束，原因: ${finishReason}，请求ID: ${proxyRequest.request_id}`
        );
      } catch (e) {}

      res
        .status(headerMessage.status || 200)
        .type("application/json")
        .send(fullBody || "{}");

      this.logger.info(`[Request] 已向客户端发送完整的非流式响应。`);
    } catch (error) {
      this._handleRequestError(error, res);
    }
  }

  _setResponseHeaders(res, headerMessage) {
    res.status(headerMessage.status || 200);
    const headers = headerMessage.headers || {};
    Object.entries(headers).forEach(([name, value]) => {
      if (name.toLowerCase() !== "content-length") res.set(name, value);
    });
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    } else {
      this._flushResponse(res);
    }
  }

  _handleRequestError(error, res) {
    if (res.headersSent) {
      this.logger.error(`[Request] 请求处理错误 (头已发送): ${error.message}`);
      const expectsPseudoChunks = Boolean(
        res?.locals?.__proxyPseudoStream ||
          this.serverSystem.streamingMode === "fake"
      );
      if (expectsPseudoChunks)
        this._sendErrorChunkToClient(res, `处理失败: ${error.message}`);
      if (!res.writableEnded) res.end();
    } else {
      this.logger.error(`[Request] 请求处理错误: ${error.message}`);
      const status = error.message.includes("超时") ? 504 : 500;
      this._sendErrorResponse(res, status, `代理错误: ${error.message}`);
    }
  }

  _sendErrorResponse(res, status, message) {
    if (!res.headersSent) {
      const errorPayload = {
        error: {
          code: status || 500,
          message: message,
          status: "SERVICE_UNAVAILABLE",
        },
      };
      res
        .status(status || 500)
        .type("application/json")
        .send(JSON.stringify(errorPayload));
    }
  }

  _translateOpenAIToGoogle(openaiBody, modelName = "") {
    this.logger.info("[Adapter] 开始将OpenAI请求格式翻译为Google格式...");

    let systemInstruction = null;
    const googleContents = [];

    const systemMessages = openaiBody.messages.filter(
      (msg) => msg.role === "system"
    );
    if (systemMessages.length > 0) {
      const systemContent = systemMessages.map((msg) => msg.content).join("\n");
      systemInstruction = {
        role: "system",
        parts: [{ text: systemContent }],
      };
    }

    const conversationMessages = openaiBody.messages.filter(
      (msg) => msg.role !== "system"
    );
    for (const message of conversationMessages) {
      const googleParts = [];

      if (typeof message.content === "string") {
        googleParts.push({ text: message.content });
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "text") {
            googleParts.push({ text: part.text });
          } else if (part.type === "image_url" && part.image_url) {
            const dataUrl = part.image_url.url;
            const match = dataUrl.match(/^data:(image\/.*?);base64,(.*)$/);
            if (match) {
              googleParts.push({
                inlineData: {
                  mimeType: match[1],
                  data: match[2],
                },
              });
            }
          }
        }
      }

      googleContents.push({
        role: message.role === "assistant" ? "model" : "user",
        parts: googleParts,
      });
    }

    const googleRequest = {
      contents: googleContents,
      ...(systemInstruction && {
        systemInstruction: { parts: systemInstruction.parts },
      }),
    };

    const generationConfig = {
      temperature: openaiBody.temperature,
      topP: openaiBody.top_p,
      topK: openaiBody.top_k,
      maxOutputTokens: openaiBody.max_tokens,
      stopSequences: openaiBody.stop,
    };
    googleRequest.generationConfig = generationConfig;

    googleRequest.safetySettings = [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ];

    this.logger.info("[Adapter] 翻译完成。");
    return googleRequest;
  }

  _translateGoogleToOpenAIStream(googleChunk, modelName = "gemini-pro") {
    // googleChunk should be the JSON string (without "data: " prefix)
    if (!googleChunk || googleChunk.trim() === "") {
      return null;
    }

    let googleResponse;
    try {
      googleResponse = JSON.parse(googleChunk);
    } catch (e) {
      this.logger.warn(`[Adapter] 无法解析Google返回的JSON块: ${googleChunk}`);
      return null;
    }

    const candidate = googleResponse.candidates?.[0];
    if (!candidate) {
      if (googleResponse.promptFeedback) {
        this.logger.warn(
          `[Adapter] Google返回了promptFeedback，可能已被拦截: ${JSON.stringify(
            googleResponse.promptFeedback
          )}`
        );
        const errorText = `[ProxySystem Error] Request blocked due to safety settings. Finish Reason: ${googleResponse.promptFeedback.blockReason}`;
        return `data: ${JSON.stringify({
          id: `chatcmpl-${this._generateRequestId()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [
            { index: 0, delta: { content: errorText }, finish_reason: "stop" },
          ],
        })}\n\n`;
      }
      return null;
    }

    let content = "";
    if (candidate.content && Array.isArray(candidate.content.parts)) {
      const imagePart = candidate.content.parts.find((p) => p.inlineData);
      if (imagePart) {
        const image = imagePart.inlineData;
        content = `![Generated Image](data:${image.mimeType};base64,${image.data})`;
        this.logger.info("[Adapter] 从流式响应块中成功解析到图片。");
      } else {
        content = candidate.content.parts.map((p) => p.text).join("") || "";
      }
    }

    const finishReason = candidate.finishReason;

    const openaiResponse = {
      id: `chatcmpl-${this._generateRequestId()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [
        {
          index: 0,
          delta: { content: content },
          finish_reason: finishReason || null,
        },
      ],
    };

    return `data: ${JSON.stringify(openaiResponse)}\n\n`;
  }

  _normalizeModelIdentifierInPath(proxyRequest) {
    if (!this._isMixStreamingEnabled()) {
      return null;
    }
    const info = this._extractModelPathInfo(proxyRequest.path);
    if (!info) {
      return null;
    }
    const context = {
      requestedModel: info.decodedModelId,
      normalizedModel: info.decodedModelId,
      isFake: this._isFakeStreamModelId(info.decodedModelId),
    };

    if (context.isFake) {
      const stripped = this._stripFakeStreamPrefix(info.decodedModelId);
      if (stripped) {
        const encodedNormalized = encodeURIComponent(stripped);
        proxyRequest.path = `${info.basePath}${encodedNormalized}${info.suffix}`;
        context.normalizedModel = stripped;
      }
    }

    proxyRequest.requestedModel = context.requestedModel;
    proxyRequest.normalizedModel = context.normalizedModel;
    proxyRequest.isFakeStreamModel = context.isFake;
    return context;
  }

  _normalizeMixModeModelId(modelId) {
    const normalizedModelId = typeof modelId === "string" ? modelId : "";
    const isFake =
      this._isMixStreamingEnabled() &&
      this._isFakeStreamModelId(normalizedModelId);
    const stripped = isFake
      ? this._stripFakeStreamPrefix(normalizedModelId)
      : normalizedModelId;
    return {
      requestedModel: normalizedModelId,
      normalizedModel: stripped || normalizedModelId,
      isFake,
    };
  }

  _resolveStreamingModeForRequest(modelContext) {
    if (this.serverSystem.streamingMode !== "mix") {
      return this.serverSystem.streamingMode;
    }
    return modelContext?.isFake ? "fake" : "real";
  }

  _appendMixModeVariants(models, force = false) {
    if (
      (!force && !this._isMixStreamingEnabled()) ||
      !Array.isArray(models) ||
      models.length === 0
    ) {
      return models;
    }

    const existingIds = new Set();
    for (const model of models) {
      const identifier = this._getModelIdentifier(model);
      if (identifier) {
        existingIds.add(identifier);
      }
    }

    const additions = [];
    for (const model of models) {
      const identifier = this._getModelIdentifier(model);
      if (!identifier) continue;
      if (this._isFakeStreamModelId(identifier)) continue;
      if (!this._isTextModelDescriptor(model, identifier)) continue;

      const fakeId = `${this.fakeStreamPrefix}${identifier}`;
      if (existingIds.has(fakeId)) continue;

      const variant = this._cloneModelDescriptorWithFakePrefix(
        model,
        identifier
      );
      if (variant) {
        additions.push(variant);
        existingIds.add(fakeId);
      }
    }

    if (additions.length === 0) {
      return models;
    }

    return [...models, ...additions];
  }

  _augmentModelPayloadForMixMode(path, payload) {
    if (!this._isMixStreamingEnabled() || !this._isModelListingPath(path)) {
      return { payload, changed: false };
    }
    if (!payload) {
      return { payload, changed: false };
    }

    if (Array.isArray(payload)) {
      const augmented = this._appendMixModeVariants(payload);
      return { payload: augmented, changed: augmented !== payload };
    }

    let changed = false;
    let nextPayload = payload;

    if (Array.isArray(payload.models)) {
      const augmentedModels = this._appendMixModeVariants(payload.models);
      if (augmentedModels !== payload.models) {
        nextPayload = { ...nextPayload, models: augmentedModels };
        changed = true;
      }
    }

    if (Array.isArray(payload.data)) {
      const augmentedData = this._appendMixModeVariants(payload.data);
      if (augmentedData !== payload.data) {
        if (nextPayload === payload) {
          nextPayload = { ...nextPayload };
        }
        nextPayload.data = augmentedData;
        changed = true;
      }
    }

    return { payload: nextPayload, changed };
  }

  _getModelIdentifier(model) {
    if (!model) return null;
    if (typeof model === "string") {
      return model;
    }
    if (typeof model.id === "string" && model.id.length > 0) {
      return model.id.includes("/") ? model.id.split("/").pop() : model.id;
    }
    if (typeof model.name === "string" && model.name.length > 0) {
      return model.name.includes("/")
        ? model.name.split("/").pop()
        : model.name;
    }
    if (typeof model.displayName === "string") {
      return model.displayName;
    }
    return null;
  }

  _isTextModelDescriptor(model, identifier) {
    const modelId = (identifier || this._getModelIdentifier(model) || "")
      .toLowerCase()
      .trim();
    if (!modelId) return false;

    const blockedKeywords = [
      "embed",
      "embedding",
      "search",
      "moderation",
      "speech",
      "audio",
      "vision",
      "image",
      "video",
    ];
    if (blockedKeywords.some((keyword) => modelId.includes(keyword))) {
      return false;
    }

    const supportedMethods = this._getSupportedMethods(model);
    if (supportedMethods.length === 0) {
      return true;
    }

    const normalizedMethods = supportedMethods.map((method) =>
      String(method || "").toLowerCase()
    );
    const textMethods = [
      "generatecontent",
      "streamgeneratecontent",
      "createcontent",
      "generateanswer",
      "generatechatcompletions",
      "respond",
    ];

    const hasTextMethod = normalizedMethods.some((method) =>
      textMethods.some((textMethod) => method.includes(textMethod))
    );
    if (hasTextMethod) {
      return true;
    }

    const isEmbedOnly = normalizedMethods.every((method) =>
      method.includes("embed")
    );
    return !isEmbedOnly;
  }

  _getSupportedMethods(model) {
    if (!model || typeof model !== "object") {
      return [];
    }
    if (Array.isArray(model.supportedGenerationMethods)) {
      return model.supportedGenerationMethods;
    }
    if (Array.isArray(model.supported_generation_methods)) {
      return model.supported_generation_methods;
    }
    if (Array.isArray(model.supportedMethods)) {
      return model.supportedMethods;
    }
    return [];
  }

  _cloneModelDescriptorWithFakePrefix(model, identifier) {
    const fakeId = `${this.fakeStreamPrefix}${identifier}`;
    if (typeof model === "string") {
      return fakeId;
    }

    const clone = { ...model };
    clone.id = fakeId;

    if (typeof clone.name === "string" && clone.name.length > 0) {
      clone.name = this._prefixModelName(clone.name, identifier);
    } else {
      clone.name = `models/${fakeId}`;
    }

    if (typeof clone.displayName === "string" && clone.displayName.length > 0) {
      const cleanName = clone.displayName.startsWith(this.fakeStreamPrefix)
        ? clone.displayName.slice(this.fakeStreamPrefix.length)
        : clone.displayName;
      clone.displayName = `${this.fakeStreamPrefix}${cleanName}`;
    } else {
      clone.displayName = `${this.fakeStreamPrefix}${identifier}`;
    }

    return clone;
  }

  _prefixModelName(originalName, identifier) {
    const baseId = `${this.fakeStreamPrefix}${identifier}`;
    if (typeof originalName !== "string" || originalName.length === 0) {
      return `models/${baseId}`;
    }
    const lastSlashIndex = originalName.lastIndexOf("/");
    if (lastSlashIndex === -1) {
      return baseId;
    }
    const basePath = originalName.slice(0, lastSlashIndex + 1);
    return `${basePath}${baseId}`;
  }

  _extractModelPathInfo(path) {
    if (typeof path !== "string") {
      return null;
    }
    const prefixes = ["/v1beta/models/", "/v1/models/"];
    let basePath = null;
    for (const prefix of prefixes) {
      if (path.startsWith(prefix)) {
        basePath = prefix;
        break;
      }
    }
    if (!basePath) {
      return null;
    }

    const remainder = path.slice(basePath.length);
    if (!remainder) {
      return null;
    }

    let splitIndex = remainder.length;
    const colonIndex = remainder.indexOf(":");
    if (colonIndex !== -1) {
      splitIndex = colonIndex;
    } else {
      const startsWithFakePrefix =
        this._isMixStreamingEnabled() &&
        remainder.startsWith(this.fakeStreamPrefix);
      if (!startsWithFakePrefix) {
        const slashIndex = remainder.indexOf("/");
        if (slashIndex !== -1) {
          splitIndex = slashIndex;
        }
      }
    }

    const encodedSegment = remainder.slice(0, splitIndex);
    const suffix = remainder.slice(splitIndex);
    if (!encodedSegment) {
      return null;
    }

    let decodedSegment = encodedSegment;
    try {
      decodedSegment = decodeURIComponent(encodedSegment);
    } catch (err) {
      this.logger.debug?.(
        `[Request] 无法解码模型标识 ${encodedSegment}: ${err.message}`
      );
    }

    return {
      basePath,
      encodedModelSegment: encodedSegment,
      suffix,
      decodedModelId: decodedSegment,
    };
  }

  _isMixStreamingEnabled() {
    return this.serverSystem.streamingMode === "mix";
  }

  _isFakeStreamModelId(modelId) {
    return (
      typeof modelId === "string" && modelId.startsWith(this.fakeStreamPrefix)
    );
  }

  _stripFakeStreamPrefix(modelId) {
    if (!this._isFakeStreamModelId(modelId)) {
      return modelId;
    }
    return modelId.slice(this.fakeStreamPrefix.length);
  }

  _isModelListingPath(path) {
    if (typeof path !== "string") {
      return false;
    }
    const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
    return trimmed === "/v1/models" || trimmed === "/v1beta/models";
  }
}

module.exports = RequestHandler;
