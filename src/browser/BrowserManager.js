const fs = require("fs");
const path = require("path");
const { firefox } = require("playwright");
const os = require("os");

class NonceUnavailableError extends Error {
  constructor(message = "Page did not expose CSP nonce") {
    super(message);
    this.name = "NonceUnavailableError";
  }
}

class BrowserManager {
  constructor(logger, config, authSource) {
    this.logger = logger;
    this.config = config;
    this.authSource = authSource;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.currentAuthIndex = 0;
    this.scriptFileName = "black-browser.js";
    this.runtimeDir = path.join(process.cwd(), "runtime");
    this.warmStorageDir = path.join(this.runtimeDir, "warm-storage");
    fs.mkdirSync(this.warmStorageDir, { recursive: true });
    // [优化] 为低内存的Docker/云环境设置优化的启动参数
    this.launchArgs = [
      "--disable-dev-shm-usage", // 关键！防止 /dev/shm 空间不足导致浏览器崩溃
      "--disable-gpu",
      "--no-sandbox", // 在受限的容器环境中通常需要
      "--disable-setuid-sandbox",
      "--disable-infobars",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--mute-audio",
      "--safebrowsing-disable-auto-update",
    ];

    if (this.config.browserExecutablePath) {
      this.browserExecutablePath = this.config.browserExecutablePath;
    } else {
      const platform = os.platform();
      if (platform === "linux") {
        this.browserExecutablePath = path.join(
          process.cwd(),
          "camoufox-linux",
          "camoufox"
        );
      } else if (platform === "win32") {
        this.browserExecutablePath = path.join(
          process.cwd(),
          "camoufox-windows",
          "camoufox.exe"
        );
      } else if (platform === "darwin") {
        this.browserExecutablePath = path.join(
          process.cwd(),
          "camoufox-macos",
          "camoufox"
        );
      } else {
        throw new Error(`Unsupported operating system: ${platform}`);
      }
    }
  }

  async launchOrSwitchContext(authIndex) {
    if (!this.browser) {
      this.logger.info("🚀 [Browser] 浏览器实例未运行，正在进行首次启动...");
      if (!fs.existsSync(this.browserExecutablePath)) {
        throw new Error(
          `Browser executable not found at path: ${this.browserExecutablePath}`
        );
      }
      this.browser = await firefox.launch({
        headless: true,
        executablePath: this.browserExecutablePath,
        args: this.launchArgs,
      });
      this.browser.on("disconnected", () => {
        this.logger.error("❌ [Browser] 浏览器意外断开连接！(可能是资源不足)");
        this.browser = null;
        this.context = null;
        this.page = null;
      });
      this.logger.info("✅ [Browser] 浏览器实例已成功启动。");
    }
    if (this.context) {
      this.logger.info("[Browser] 正在关闭旧的浏览器上下文...");
      await this.context.close();
      this.context = null;
      this.page = null;
      this.logger.info("[Browser] 旧上下文已关闭。");
    }

    const sourceDescription =
      this.authSource.authMode === "env"
        ? `环境变量 AUTH_JSON_${authIndex}`
        : `文件 auth-${authIndex}.json`;
    this.logger.info("==================================================");
    this.logger.info(
      `🔄 [Browser] 正在为账号 #${authIndex} 创建新的浏览器上下文`
    );
    this.logger.info(`   • 认证源: ${sourceDescription}`);
    this.logger.info("==================================================");

    const warmStatePath = this._getWarmStatePath(authIndex);
    const hasWarmState = fs.existsSync(warmStatePath);
    const storageStateObject = this.authSource.getAuth(authIndex);
    if (!storageStateObject && !hasWarmState) {
      throw new Error(
        `Failed to get or parse auth source for index ${authIndex}.`
      );
    }
    const storageStateSource = hasWarmState ? warmStatePath : storageStateObject;
    const buildScriptContent = fs.readFileSync(
      path.join(process.cwd(), this.scriptFileName),
      "utf-8"
    );

    try {
      this.context = await this.browser.newContext({
        storageState: storageStateSource,
        viewport: {
          width: this.config.browserViewportWidth,
          height: this.config.browserViewportHeight,
        },
      });
      await this._applyResourceControls();
      this.page = await this.context.newPage();
      this.page.on("console", (msg) => {
        const msgText = msg.text();
        if (msgText.includes("[ProxyClient]")) {
          this.logger.info(
            `[Browser] ${msgText.replace("[ProxyClient] ", "")}`
          );
        } else if (msg.type() === "error") {
          this.logger.error(`[Browser Page Error] ${msgText}`);
        }
      });

      this.logger.info(`[Browser] 正在导航至目标网页...`);
      const targetUrl =
        "https://aistudio.google.com/u/0/apps/bundled/blank?showAssistant=true&showPreview=true";
      await this.page.goto(targetUrl, {
        timeout: 30000,
        waitUntil: "commit",
      });
      this.logger.info("[Browser] 页面加载完成。");

      if (!hasWarmState) {
        await this._performInitialUiCleanup();
      } else {
        this.logger.info(
          "[Browser] 检测到热启动缓存，已跳过弹窗检测与编辑器操作。"
        );
      }

      let scriptInjected = false;
      try {
        await this._injectProxyClientScript(buildScriptContent);
        scriptInjected = true;
      } catch (error) {
        if (error instanceof NonceUnavailableError) {
          this.logger.info(
            "[Browser] 页面未提供 nonce，直接使用备用UI流程注入脚本。"
          );
        } else {
          this.logger.warn(
            `[Browser] 直接脚本注入失败 (${error.message})，正在回退到手动UI流程...`
          );
        }
        await this._bootstrapScriptViaUi(buildScriptContent);
        scriptInjected = true;
      }

      if (!scriptInjected) {
        throw new Error("脚本注入步骤未成功，停止初始化。");
      }
      if (!hasWarmState) {
        this._persistWarmState(authIndex, warmStatePath).catch(() => {});
      }
      this.currentAuthIndex = authIndex;
      this.logger.info("==================================================");
      this.logger.info(`✅ [Browser] 账号 ${authIndex} 的上下文初始化成功！`);
      this.logger.info("✅ [Browser] 浏览器客户端已准备就绪。");
      this.logger.info("==================================================");
    } catch (error) {
      this.logger.error(
        `❌ [Browser] 账户 ${authIndex} 的上下文初始化失败: ${error.message}`
      );
      // Close context but keep browser running for retry
      if (this.context) {
        await this.context.close().catch(() => {});
        this.context = null;
        this.page = null;
      }
      this.logger.info("[Browser] 浏览器实例保持运行以便重试");
      throw error;
    }
  }

  async closeBrowser() {
    if (this.browser) {
      this.logger.info("[Browser] 正在关闭整个浏览器实例...");
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      this.logger.info("[Browser] 浏览器实例已关闭。");
    }
  }

  async switchAccount(newAuthIndex) {
    this.logger.info(
      `🔄 [Browser] 开始账号切换: 从 ${this.currentAuthIndex} 到 ${newAuthIndex}`
    );
    await this.launchOrSwitchContext(newAuthIndex);
    this.logger.info(
      `✅ [Browser] 账号切换完成，当前账号: ${this.currentAuthIndex}`
    );
  }

  _getWarmStatePath(authIndex) {
    return path.join(this.warmStorageDir, `auth-${authIndex}.json`);
  }

  async _performInitialUiCleanup() {
    this.logger.info(`[Browser] 并行检查所有弹窗...`);
    
    const popupChecks = [
      this.page.locator('button:text("Agree")').click({ timeout: 2000, force: true }).catch(() => {}),
      this.page.locator('div.dialog button:text("Got it")').click({ timeout: 2000, force: true }).catch(() => {}),
      this.page.locator('button[aria-label="Close"]').click({ timeout: 2000, force: true }).catch(() => {}),
    ];
    
    await Promise.all(popupChecks);
    this.logger.info(`[Browser] 弹窗检查完成。`);

    await this.page.evaluate(() => {
      document
        .querySelectorAll("div.cdk-overlay-backdrop")
        .forEach((el) => el.remove());
    });
  }

  async _injectProxyClientScript(scriptContent) {
    const nonceValue = await this._extractPageScriptNonce();
    if (!nonceValue) {
      throw new NonceUnavailableError();
    }
    try {
      await this.page.addScriptTag({ content: scriptContent, nonce: nonceValue });
      this.logger.info(
        `[Browser] ✅ 通过 nonce=${nonceValue} 成功注入脚本。`
      );
    } catch (error) {
      throw new Error(`脚本注入失败: ${error.message}`);
    }
  }

  async _extractPageScriptNonce() {
    try {
      const nonce = await this.page.evaluate(() => {
        const scriptWithNonce = document.querySelector("script[nonce]");
        return scriptWithNonce ? scriptWithNonce.getAttribute("nonce") : null;
      });
      if (nonce) {
        this.logger.info(`[Browser] 检测到页面 CSP nonce: ${nonce}`);
      } else {
        this.logger.info("[Browser] 页面未暴露 nonce 属性，尝试无nonce注入。");
      }
      return nonce;
    } catch (error) {
      this.logger.warn(
        `[Browser] 获取页面 nonce 失败，将退回无nonce注入: ${error.message}`
      );
      return null;
    }
  }

  async _persistWarmState(authIndex, warmStatePath) {
    try {
      const state = await this.context.storageState();
      fs.writeFileSync(warmStatePath, JSON.stringify(state));
      this.logger.info(
        `[Browser] 已缓存账号 #${authIndex} 的热启动状态，加速后续切换。`
      );
    } catch (error) {
      this.logger.warn(
        `[Browser] 无法写入账号 #${authIndex} 的热启动状态: ${error.message}`
      );
    }
  }

  async _bootstrapScriptViaUi(scriptContent) {
    this.logger.info(
      "[Browser] 正在通过备用UI流程注入脚本（绕过CSP限制）..."
    );

    const editorContainerLocator = this.page
      .locator("div.monaco-editor:visible")
      .first();
    let editorReady = false;

    this.logger.info("[Browser] (快速路径) 尝试直接定位编辑器...");
    try {
      await editorContainerLocator.waitFor({ state: "visible", timeout: 10000 });
      editorReady = true;
      this.logger.info("[Browser] 编辑器已自动显示，跳过“Code”按钮步骤。");
    } catch (error) {
      this.logger.info(
        '[Browser] 未能直接定位编辑器，将执行点击 "Code" 按钮的回退流程...'
      );
    }

    if (!editorReady) {
      this.logger.info('[Browser] (步骤1/5) 准备点击 "Code" 按钮...');
      for (let i = 1; i <= 3; i++) {
        try {
          this.logger.info(`  [尝试 ${i}/3] 清理遮罩层并点击...`);
          await this.page.evaluate(() => {
            document
              .querySelectorAll("div.cdk-overlay-backdrop")
              .forEach((el) => el.remove());
          });

          await this.page.locator('button:text("Code")').click({
            timeout: 5000,
          });
          this.logger.info("  ✅ 点击成功！");
          
          // Wait a bit for any page transitions
          await this.page.waitForTimeout(1000);
          
          // Check if we're still on the same page
          const currentUrl = this.page.url();
          this.logger.info(`  当前页面URL: ${currentUrl}`);
          
          editorReady = true;
          break;
        } catch (error) {
          this.logger.warn(
            `  [尝试 ${i}/3] 点击失败: ${error.message.split("\n")[0]}`
          );
          if (i === 3) {
            this.logger.error(
              `[调试] 多次尝试后仍无法点击 "Code" 按钮，初始化失败。已跳过截图以节省内存。`
            );
            throw new Error(`多次尝试后仍无法点击 "Code" 按钮，初始化失败。`);
          }
        }
      }
    }

    this.logger.info(
      '[Browser] (步骤2/5) 等待编辑器变为可见...'
    );
    
    // Check if page is still loaded
    if (this.page.isClosed()) {
      throw new Error("页面已关闭，无法继续初始化");
    }
    
    try {
      await editorContainerLocator.waitFor({ state: "visible", timeout: 30000 });
    } catch (error) {
      this.logger.error(`[Browser] 编辑器未能在30秒内显示: ${error.message}`);
      this.logger.info("[Browser] 尝试检查页面当前状态...");
      const pageUrl = this.page.url();
      const pageTitle = await this.page.title().catch(() => "无法获取");
      this.logger.info(`[Browser] 当前URL: ${pageUrl}`);
      this.logger.info(`[Browser] 页面标题: ${pageTitle}`);
      throw error;
    }

    this.logger.info(
      "[Browser] (清场 #2) 准备点击编辑器，再次强行移除所有可能的遮罩层..."
    );
    await this.page.evaluate(() => {
      document
        .querySelectorAll("div.cdk-overlay-backdrop")
        .forEach((el) => el.remove());
    });

    this.logger.info("[Browser] (步骤3/5) 编辑器已显示，聚焦并粘贴脚本...");
    await editorContainerLocator.click({ timeout: 10000 });

    await this.page.evaluate(
      (text) => navigator.clipboard.writeText(text),
      scriptContent
    );
    const isMac = os.platform() === "darwin";
    const pasteKey = isMac ? "Meta+V" : "Control+V";
    await this.page.keyboard.press(pasteKey);
    this.logger.info("[Browser] (步骤4/5) 脚本已粘贴。");

    await this._ensurePreviewPaneVisible();
    this.logger.info("[Browser] ✅ UI交互完成，脚本已开始运行。");
  }

  async _applyResourceControls() {
    const blockList = Array.isArray(this.config.blockResourceTypes)
      ? this.config.blockResourceTypes
      : [];
    const exceptions = Array.isArray(this.config.resourceBlockExceptions)
      ? this.config.resourceBlockExceptions
      : [];

    if (!this.context || blockList.length === 0) {
      this.logger.info("[Browser] 资源优化未启用（无屏蔽类型）。");
      return;
    }

    await this.context.route("**/*", (route) => {
      const request = route.request();
      const resourceType = request.resourceType();
      const requestUrl = request.url();

      if (!blockList.includes(resourceType)) {
        return route.continue();
      }

      const isException = exceptions.some((pattern) =>
        requestUrl.includes(pattern)
      );
      if (isException) {
        return route.continue();
      }

      this.logger.debug(
        `[Browser] ♻️ 已阻止 ${resourceType} 资源: ${requestUrl}`
      );
      return route.abort();
    });

    this.logger.info(
      `[Browser] 资源优化已启用，屏蔽类型: ${blockList.join(", ")}`
    );
    if (exceptions.length > 0) {
      this.logger.info(
        `[Browser] 资源屏蔽例外: ${exceptions.join(", ")}`
      );
    }
  }

  async _ensurePreviewPaneVisible() {
    this.logger.info(
      '[Browser] (步骤5/5) 确保 "Preview" 预览面板处于开启状态...'
    );

    const previewLocator = await this._resolvePreviewToggleLocator();
    if (!previewLocator) {
      this.logger.warn(
        "[Browser] 未能定位到预览切换按钮，推测 UI 发生变更，暂时跳过该步骤。"
      );
      return;
    }

    try {
      await previewLocator.waitFor({ state: "visible", timeout: 15000 });
      await previewLocator.scrollIntoViewIfNeeded();
      await previewLocator.focus();

      if (await this._isPreviewToggleActive(previewLocator)) {
        this.logger.info("[Browser] 预览面板已经开启，跳过点击。");
        return;
      }

      await previewLocator.click({ timeout: 15000 });
      await this.page.waitForTimeout(400);

      if (await this._isPreviewToggleActive(previewLocator)) {
        this.logger.info("[Browser] 成功唤起预览面板，继续执行。");
        await this.page.waitForTimeout(500);
        return;
      }

      this.logger.warn(
        "[Browser] 预览按钮点击后状态未改变，尝试直接在 DOM 中触发..."
      );
      const triggered = await this.page.evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll(
            'button[data-test-id="preview-toggle"], button[aria-controls*="preview"]'
          )
        );
        for (const button of candidates) {
          const dataTestId = button.getAttribute("data-test-id") || "";
          const isToggle =
            dataTestId.includes("preview-toggle") ||
            button.hasAttribute("aria-selected") ||
            button.hasAttribute("aria-pressed");
          if (!isToggle) continue;

          const isActive =
            button.getAttribute("aria-selected") === "true" ||
            button.getAttribute("aria-pressed") === "true";
          if (isActive) {
            return true;
          }
          button.click();
          return true;
        }
        return false;
      });

      if (!triggered) {
        this.logger.warn(
          "[Browser] DOM 触发未成功，后续步骤将继续但可能需要人工确认预览状态。"
        );
      } else {
        await this.page.waitForTimeout(400);
      }
    } catch (error) {
      this.logger.warn(
        `[Browser] 预览按钮流程失败 (${error.message})，为了避免误触运行，将跳过该步骤。`
      );
    }
  }

  async _resolvePreviewToggleLocator() {
    const selectorCandidates = [
      'button[data-test-id="preview-toggle"]',
      '[data-test-id="preview-toggle"] button',
      'button[aria-controls*="preview"][role="tab"]',
      'button[aria-label*="Preview"][aria-selected]',
      'button[aria-label*="Preview"][aria-pressed]',
      'button:has-text("Preview")',
    ];

    for (const selector of selectorCandidates) {
      const locator = this.page.locator(selector).first();
      if ((await locator.count()) === 0) {
        continue;
      }

      const [dataTestId, ariaSelected, ariaPressed] = await Promise.all([
        locator.getAttribute("data-test-id"),
        locator.getAttribute("aria-selected"),
        locator.getAttribute("aria-pressed"),
      ]);

      const identifier = dataTestId || "";
      const isToggleCandidate =
        identifier.includes("preview-toggle") ||
        ariaSelected !== null ||
        ariaPressed !== null;

      if (!isToggleCandidate) {
        continue;
      }

      return locator;
    }

    return null;
  }

  async _isPreviewToggleActive(locator) {
    try {
      const [ariaSelected, ariaPressed] = await Promise.all([
        locator.getAttribute("aria-selected"),
        locator.getAttribute("aria-pressed"),
      ]);
      return ariaSelected === "true" || ariaPressed === "true";
    } catch {
      return false;
    }
  }
}

module.exports = BrowserManager;
