const fs = require("fs");
const path = require("path");

class ConfigLoader {
  static load(logger) {
    let config = {
      httpPort: 7860,
      host: "0.0.0.0",
      wsPort: 9998,
      streamingMode: "real",
      failureThreshold: 3,
      switchOnUses: 40,
      maxRetries: 1,
      retryDelay: 2000,
      browserExecutablePath: null,
      browserViewportWidth: 1280,
      browserViewportHeight: 720,
      blockResourceTypes: [],
      resourceBlockExceptions: [
        "fonts.googleapis.com",
        "fonts.gstatic.com",
        "www.gstatic.com/monaco_editor",
        "aistudio.google.com",
      ],
      apiKeys: [],
      immediateSwitchStatusCodes: [429, 503],
      // [新增] 用于追踪API密钥来源
      apiKeySource: "未设置",
    };

    const configPath = path.join(process.cwd(), "config.json");
    try {
      if (fs.existsSync(configPath)) {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        config = { ...config, ...fileConfig };
        logger.info("[System] 已从 config.json 加载配置。");
      }
    } catch (error) {
      logger.warn(`[System] 无法读取或解析 config.json: ${error.message}`);
    }

    if (process.env.PORT)
      config.httpPort = parseInt(process.env.PORT, 10) || config.httpPort;
    if (process.env.HOST) config.host = process.env.HOST;
    if (process.env.STREAMING_MODE)
      config.streamingMode = process.env.STREAMING_MODE;
    if (process.env.FAILURE_THRESHOLD)
      config.failureThreshold =
        parseInt(process.env.FAILURE_THRESHOLD, 10) || config.failureThreshold;
    if (process.env.SWITCH_ON_USES)
      config.switchOnUses =
        parseInt(process.env.SWITCH_ON_USES, 10) || config.switchOnUses;
    if (process.env.MAX_RETRIES)
      config.maxRetries =
        parseInt(process.env.MAX_RETRIES, 10) || config.maxRetries;
    if (process.env.RETRY_DELAY)
      config.retryDelay =
        parseInt(process.env.RETRY_DELAY, 10) || config.retryDelay;
    if (process.env.BROWSER_VIEWPORT_WIDTH)
      config.browserViewportWidth =
        parseInt(process.env.BROWSER_VIEWPORT_WIDTH, 10) ||
        config.browserViewportWidth;
    if (process.env.BROWSER_VIEWPORT_HEIGHT)
      config.browserViewportHeight =
        parseInt(process.env.BROWSER_VIEWPORT_HEIGHT, 10) ||
        config.browserViewportHeight;
    if (process.env.CAMOUFOX_EXECUTABLE_PATH)
      config.browserExecutablePath = process.env.CAMOUFOX_EXECUTABLE_PATH;
    if (process.env.API_KEYS) {
      config.apiKeys = process.env.API_KEYS.split(",");
    }
    if (process.env.BLOCK_RESOURCE_TYPES) {
      config.blockResourceTypes = process.env.BLOCK_RESOURCE_TYPES.split(",")
        .map((type) => type.trim().toLowerCase())
        .filter((type) => type);
    }
    if (process.env.RESOURCE_BLOCK_EXCEPTIONS) {
      config.resourceBlockExceptions = process.env.RESOURCE_BLOCK_EXCEPTIONS.split(",")
        .map((value) => value.trim())
        .filter((value) => value);
    }

    let rawCodes = process.env.IMMEDIATE_SWITCH_STATUS_CODES;
    let codesSource = "环境变量";

    if (
      !rawCodes &&
      config.immediateSwitchStatusCodes &&
      Array.isArray(config.immediateSwitchStatusCodes)
    ) {
      rawCodes = config.immediateSwitchStatusCodes.join(",");
      codesSource = "config.json 文件或默认值";
    }

    if (rawCodes && typeof rawCodes === "string") {
      config.immediateSwitchStatusCodes = rawCodes
        .split(",")
        .map((code) => parseInt(String(code).trim(), 10))
        .filter((code) => !isNaN(code) && code >= 400 && code <= 599);
      if (config.immediateSwitchStatusCodes.length > 0) {
        logger.info(`[System] 已从 ${codesSource} 加载"立即切换报错码"。`);
      }
    } else {
      config.immediateSwitchStatusCodes = [];
    }

    if (Array.isArray(config.apiKeys)) {
      config.apiKeys = config.apiKeys
        .map((k) => String(k).trim())
        .filter((k) => k);
    } else {
      config.apiKeys = [];
    }

    if (Array.isArray(config.blockResourceTypes)) {
      config.blockResourceTypes = config.blockResourceTypes
        .map((type) => String(type).trim().toLowerCase())
        .filter((type) => type);
    } else {
      config.blockResourceTypes = [];
    }

    if (Array.isArray(config.resourceBlockExceptions)) {
      config.resourceBlockExceptions = config.resourceBlockExceptions
        .map((value) => String(value).trim())
        .filter((value) => value);
    } else {
      config.resourceBlockExceptions = [];
    }

    // [修改] 更新API密钥来源的判断逻辑
    if (config.apiKeys.length > 0) {
      config.apiKeySource = "自定义";
    } else {
      config.apiKeys = ["123456"];
      config.apiKeySource = "默认";
      logger.info("[System] 未设置任何API Key，已启用默认密码: 123456");
    }

    const modelsPath = path.join(process.cwd(), "models.json");
    try {
      if (fs.existsSync(modelsPath)) {
        const modelsFileContent = fs.readFileSync(modelsPath, "utf-8");
        config.modelList = JSON.parse(modelsFileContent); // 将读取到的模型列表存入config对象
        logger.info(
          `[System] 已从 models.json 成功加载 ${config.modelList.length} 个模型。`
        );
      } else {
        logger.warn(
          `[System] 未找到 models.json 文件，将使用默认模型列表。`
        );
        config.modelList = ["gemini-1.5-pro-latest"]; // 提供一个备用模型，防止服务启动失败
      }
    } catch (error) {
      logger.error(
        `[System] 读取或解析 models.json 失败: ${error.message}，将使用默认模型列表。`
      );
      config.modelList = ["gemini-1.5-pro-latest"]; // 出错时也使用备用模型
    }

    if (typeof config.streamingMode === "string") {
      config.streamingMode = config.streamingMode.trim().toLowerCase();
    } else {
      config.streamingMode = "real";
    }

    const validStreamingModes = ["real", "fake", "mix"];
    if (!validStreamingModes.includes(config.streamingMode)) {
      logger.warn(
        `[System] 检测到未知流模式 "${config.streamingMode}"，已回退为 real。`
      );
      config.streamingMode = "real";
    }

    logger.info("================ [ 生效配置 ] ================");
    logger.info(`  HTTP 服务端口: ${config.httpPort}`);
    logger.info(`  监听地址: ${config.host}`);
    logger.info(`  流式模式: ${config.streamingMode}`);
    logger.info(
      `  轮换计数切换阈值: ${
        config.switchOnUses > 0
          ? `每 ${config.switchOnUses} 次请求后切换`
          : "已禁用"
      }`
    );
    logger.info(
      `  失败计数切换: ${
        config.failureThreshold > 0
          ? `失败${config.failureThreshold} 次后切换`
          : "已禁用"
      }`
    );
    logger.info(
      `  立即切换报错码: ${
        config.immediateSwitchStatusCodes.length > 0
          ? config.immediateSwitchStatusCodes.join(", ")
          : "已禁用"
      }`
    );
    logger.info(`  单次请求最大重试: ${config.maxRetries}次`);
    logger.info(`  重试间隔: ${config.retryDelay}ms`);
    logger.info(
      `  浏览器视口: ${config.browserViewportWidth}x${config.browserViewportHeight}`
    );
    logger.info(
      `  资源屏蔽: ${
        config.blockResourceTypes.length > 0
          ? config.blockResourceTypes.join(", ")
          : "未启用"
      }`
    );
    if (config.blockResourceTypes.length > 0) {
      logger.info(
        `  资源屏蔽例外: ${
          config.resourceBlockExceptions.length > 0
            ? config.resourceBlockExceptions.join(", ")
            : "未设置"
        }`
      );
    }
    logger.info(`  API 密钥来源: ${config.apiKeySource}`);
    logger.info(
      "============================================================="
    );

    return config;
  }
}

module.exports = ConfigLoader;
