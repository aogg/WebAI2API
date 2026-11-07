/**
 * @fileoverview 页面交互工具
 * @description 页面认证锁、输入框等待、表单提交等页面级操作
 */

import { sleep, safeClick, isPageValid, createPageCloseWatcher, getRealViewport, clamp, random } from '../engine/utils.js';
import { TIMEOUTS } from '../../utils/constants.js';
import { logger } from '../../utils/logger.js';
import { traceOp, traceError } from './trace.js';

// ==========================================
// 页面认证锁
// ==========================================

/**
 * 等待页面认证完成
 * @param {import('playwright-core').Page} page - 页面对象
 */
export async function waitForPageAuth(page) {
    while (page.authState?.isHandlingAuth) {
        await sleep(500, 1000);
    }
}

/**
 * 设置页面认证锁（加锁）
 * @param {import('playwright-core').Page} page - 页面对象
 */
export function lockPageAuth(page) {
    if (page.authState) page.authState.isHandlingAuth = true;
}

/**
 * 释放页面认证锁（解锁）
 * @param {import('playwright-core').Page} page - 页面对象
 */
export function unlockPageAuth(page) {
    if (page.authState) page.authState.isHandlingAuth = false;
}

/**
 * 检查页面是否正在处理认证
 * @param {import('playwright-core').Page} page - 页面对象
 * @returns {boolean}
 */
export function isPageAuthLocked(page) {
    return page.authState?.isHandlingAuth === true;
}

// ==========================================
// 输入框与表单
// ==========================================

/**
 * 等待输入框出现（自动等待认证完成）
 * @param {import('playwright-core').Page} page - 页面对象
 * @param {string|import('playwright-core').Locator} selectorOrLocator - 输入框选择器或 Locator 对象
 * @param {object} [options={}] - 选项
 * @param {number} [options.timeout=60000] - 超时时间（毫秒）
 * @param {boolean} [options.click=true] - 找到后是否点击输入框
 * @returns {Promise<void>}
 */
export async function waitForInput(page, selectorOrLocator, options = {}) {
    const { timeout = TIMEOUTS.INPUT_WAIT, click = true } = options;

    const isLocator = typeof selectorOrLocator !== 'string';
    const displayName = isLocator ? 'Locator' : selectorOrLocator;
    const startTime = Date.now();

    // 等待认证完成
    while (isPageAuthLocked(page)) {
        if (Date.now() - startTime >= timeout) break;
        await sleep(500, 1000);
    }

    // 计算剩余超时时间
    const elapsed = Date.now() - startTime;
    const remainingTimeout = Math.max(timeout - elapsed, 5000);

    // 等待输入框出现
    if (isLocator) {
        await selectorOrLocator.first().waitFor({ state: 'visible', timeout: remainingTimeout }).catch(() => {
            traceError(page, '定位输入框', new Error(`未找到输入框 (${displayName})`), {
                selector: displayName,
                durationMs: Date.now() - startTime,
                screenshot: false
            });
            throw new Error(`未找到输入框 (${displayName})`);
        });
    } else {
        await page.waitForSelector(selectorOrLocator, { timeout: remainingTimeout }).catch(() => {
            traceError(page, '定位输入框', new Error(`未找到输入框 (${displayName})`), {
                selector: displayName,
                durationMs: Date.now() - startTime,
                screenshot: false
            });
            throw new Error(`未找到输入框 (${displayName})`);
        });
    }

    if (click) {
        await safeClick(page, selectorOrLocator, { bias: 'input' });
        await sleep(500, 1000);
        // 点击时 safeClick 已截图，这里只补一条定位日志
        traceOp(page, '定位输入框', `${displayName}（已点击聚焦）`, {
            selector: displayName,
            durationMs: Date.now() - startTime,
            screenshot: false
        });
    } else {
        traceOp(page, '定位输入框', displayName, {
            selector: displayName,
            durationMs: Date.now() - startTime
        });
    }
}

// ==========================================
// 导航与鼠标
// ==========================================

/**
 * 导航期可重试的网络层错误
 * 代理（gost/clash 中转）在空闲后可能主动断开隧道，浏览器复用旧连接时
 * 会立刻抛 NS_ERROR_NET_INTERRUPT / PR_END_OF_FILE_ERROR，重试即可恢复。
 */
const RETRYABLE_NAV_ERROR = /NS_ERROR_NET_INTERRUPT|NS_ERROR_NET_RESET|NS_ERROR_NET_TIMEOUT|NS_ERROR_ABORT|PR_END_OF_FILE_ERROR|PR_CONNECT_RESET_ERROR|Secure Connection Failed|connection (?:was )?(?:reset|aborted)|socket hang up|ECONNRESET/i;

/**
 * 导航到指定 URL 并检测 HTTP 错误
 * @param {import('playwright-core').Page} page - 页面对象
 * @param {string} url - 目标 URL
 * @param {object} [options={}] - 选项
 * @param {number} [options.timeout=30000] - 超时时间（毫秒）
 * @throws {Error} 导航失败时抛出错误
 */
export async function gotoWithCheck(page, url, options = {}) {
    const {
        timeout = TIMEOUTS.NAVIGATION,
        waitUntil = 'load',
        attempts = 3,
        retryDelay = [800, 2000],
        meta = {}
    } = options;

    let lastErr = null;
    const navStart = Date.now();

    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (!isPageValid(page)) {
            throw new Error('PAGE_INVALID');
        }
        try {
            const response = await page.goto(url, { waitUntil, timeout });
            if (!response) {
                throw new Error('页面加载失败: 无响应');
            }
            const status = response.status();
            if (status >= 400) {
                throw new Error(`网站无法访问 (HTTP ${status})`);
            }

            // 操作追踪：导航成功
            traceOp(page, '页面导航', url, {
                url,
                durationMs: Date.now() - navStart,
                extra: { httpStatus: status }
            });

            return response;
        } catch (e) {
            lastErr = e;
            const message = String(e?.message || e);
            const isTimeout = /Timeout|timed out/i.test(message);
            const retryable = isTimeout || RETRYABLE_NAV_ERROR.test(message);
            if (!retryable || attempt >= attempts) break;
            logger.warn('页面', `导航失败（第 ${attempt}/${attempts} 次，${isTimeout ? '超时' : '连接中断'}），正在重试: ${message.split('\n')[0]}`, meta);
            const delay = retryDelay[Math.min(attempt - 1, retryDelay.length - 1)];
            await sleep(delay, delay + 600);
        }
    }

    // 操作追踪：导航失败
    traceError(page, '页面导航', lastErr || new Error('未知错误'), {
        detail: url,
        url,
        durationMs: Date.now() - navStart,
        screenshot: false
    });

    const message = String(lastErr?.message || lastErr || '未知错误');
    if (/Timeout|timed out/i.test(message)) {
        throw new Error('页面加载超时');
    }
    if (message.startsWith('页面') || message.startsWith('网站')) {
        throw lastErr;
    }
    throw new Error(`页面加载失败: ${message}`);
}

/**
 * 尝试导航到 URL（不抛异常版本，用于需要收集错误的场景）
 * @param {import('playwright-core').Page} page - Playwright 页面对象
 * @param {string} url - 目标 URL
 * @param {object} [options={}] - 选项
 * @returns {Promise<{success?: boolean, error?: string}>}
 */
export async function tryGotoWithCheck(page, url, options = {}) {
    try {
        await gotoWithCheck(page, url, options);
        return { success: true };
    } catch (e) {
        return { error: e.message };
    }
}

/**
 * 等待元素出现并滚动到可视范围
 * @param {import('playwright-core').Page} page - Playwright 页面对象
 * @param {string|import('playwright-core').Locator} selectorOrLocator - CSS 选择器或 Locator 对象
 * @param {object} [options={}] - 选项
 * @param {number} [options.timeout=30000] - 超时时间（毫秒）
 * @returns {Promise<import('playwright-core').ElementHandle|null>} 元素句柄，失败返回 null
 */
export async function scrollToElement(page, selectorOrLocator, options = {}) {
    const { timeout = TIMEOUTS.ELEMENT_SCROLL } = options;
    try {
        const isLocator = typeof selectorOrLocator !== 'string';
        let element;

        if (isLocator) {
            // Locator 对象 (getByRole, getByText 等)
            await selectorOrLocator.first().waitFor({ timeout, state: 'attached' });
            element = await selectorOrLocator.first().elementHandle();
        } else {
            // CSS 选择器字符串
            element = await page.waitForSelector(selectorOrLocator, { timeout, state: 'attached' });
        }

        if (element) {
            await element.scrollIntoViewIfNeeded();
            return element;
        }
    } catch {
        // 元素未找到或超时
    }
    return null;
}


/**
 * 等待 API 响应 (带页面关闭监听和错误关键词检测)
 * 匹配到响应后会等待请求完成（requestfinished），使用 60 秒空闲超时保护
 * @param {import('playwright-core').Page} page - Playwright 页面对象
 * @param {object} options - 等待选项
 * @param {string} options.urlMatch - URL 匹配字符串
 * @param {string|string[]} [options.urlContains] - URL 必须额外包含的字符串（可选，可以是数组）
 * @param {string} [options.method='POST'] - HTTP 方法
 * @param {number} [options.timeout=120000] - 等待响应出现的超时时间（毫秒）
 * @param {string|string[]} [options.errorText] - 错误关键词，页面 UI 或 API 响应体中出现时立即停止并返回错误
 * @param {object} [options.meta={}] - 日志元数据
 * @returns {Promise<import('playwright-core').Response>} 响应对象
 */
export function waitApiResponse(page, options = {}) {
    const promise = (async () => {
    const {
        urlMatch,
        urlContains,
        method = 'POST',
        timeout = TIMEOUTS.API_RESPONSE,
        errorText,
        meta = {}
    } = options;

    if (!isPageValid(page)) {
        throw new Error('PAGE_INVALID');
    }

    const pageWatcher = createPageCloseWatcher(page);
    const patterns = errorText ? (Array.isArray(errorText) ? errorText : [errorText]) : [];
    const waitStart = Date.now();

    // 页面 UI 错误关键词检测
    let uiErrorPromise = null;
    if (patterns.length > 0) {
        let combinedLocator = null;
        for (const pattern of patterns) {
            const loc = page.getByText(pattern);
            combinedLocator = combinedLocator ? combinedLocator.or(loc) : loc;
        }
        if (combinedLocator) {
            uiErrorPromise = combinedLocator.first().waitFor({ timeout, state: 'attached' })
                .then(async () => {
                    const matchedText = await combinedLocator.first().textContent().catch(() => '未知错误');
                    // 操作追踪：页面 UI 检测到错误关键词
                    traceError(page, '页面UI检测到错误', new Error(matchedText), {
                        detail: `关键词命中: ${matchedText}`,
                        screenshot: true
                    });
                    throw new Error(`PAGE_ERROR_DETECTED: ${matchedText}`);
                });
        }
    }

    // 超时控制
    let timerId = null;
    let responseHandler = null;

    const cleanup = () => {
        if (timerId) clearTimeout(timerId);
        if (responseHandler) page.off('response', responseHandler);
        pageWatcher.cleanup();
    };

    try {
        const responsePromise = new Promise((resolve, reject) => {
            // 超时计时器（流式响应收到数据时会重置）
            const resetTimer = () => {
                if (timerId) clearTimeout(timerId);
                timerId = setTimeout(() => {
                    reject(new Error(`API_TIMEOUT: 等待响应超时 (${Math.round(timeout / 1000)}秒)`));
                }, timeout);
            };

            // 启动初始超时
            resetTimer();

            // 监听响应
            responseHandler = async (res) => {
                const url = res.url();

                // 基础匹配
                if (!url.includes(urlMatch)) return;

                // 额外的 URL 包含检查
                if (urlContains) {
                    const containsArray = Array.isArray(urlContains) ? urlContains : [urlContains];
                    if (!containsArray.every(str => url.includes(str))) return;
                }

                // 方法和状态检查
                const reqMethod = res.request().method();
                const status = res.status();
                if (reqMethod !== method || (status !== 200 && status < 400)) return;

                // 匹配成功，移除监听器（只处理第一个匹配的响应）
                page.off('response', responseHandler);
                responseHandler = null;

                // 操作追踪：捕获到匹配的 API 响应
                traceOp(page, '捕获API响应', url, {
                    url,
                    durationMs: Date.now() - waitStart,
                    extra: { httpStatus: status },
                    screenshot: false
                });

                // 统一等待请求完成（无论流式还是非流式）
                // 使用 timeout 作为空闲超时，防止连接卡住无限等待
                let idleTimerId = null;

                // 取消初始超时，启动空闲超时
                if (timerId) {
                    clearTimeout(timerId);
                    timerId = null;
                }

                idleTimerId = setTimeout(() => {
                    page.off('requestfinished', finishedHandler);
                    page.off('requestfailed', failedHandler);
                    reject(new Error(`API_TIMEOUT: 响应传输超时 (${Math.round(timeout / 1000)}秒未完成)`));
                }, timeout);

                const request = res.request();

                const finishedHandler = (req) => {
                    if (req === request) {
                        if (idleTimerId) clearTimeout(idleTimerId);
                        page.off('requestfinished', finishedHandler);
                        page.off('requestfailed', failedHandler);
                        resolve(res);
                    }
                };

                const failedHandler = (req) => {
                    if (req === request) {
                        if (idleTimerId) clearTimeout(idleTimerId);
                        page.off('requestfinished', finishedHandler);
                        page.off('requestfailed', failedHandler);
                        reject(new Error('NETWORK_FAILED: 请求失败'));
                    }
                };

                page.on('requestfinished', finishedHandler);
                page.on('requestfailed', failedHandler);
            };

            page.on('response', responseHandler);
        });

        const promises = [responsePromise, pageWatcher.promise];
        if (uiErrorPromise) promises.push(uiErrorPromise);

        const response = await Promise.race(promises);

        // API 响应体错误关键词检测 (在返回前同步检查)
        if (patterns.length > 0) {
            try {
                const bodyBuffer = await response.body();
                const body = bodyBuffer.toString('utf-8');
                for (const pattern of patterns) {
                    const keyword = typeof pattern === 'string' ? pattern : pattern.source;
                    if (body.includes(keyword)) {
                        // 操作追踪：API 响应体命中错误关键词（截取片段辅助排查）
                        traceError(page, 'API响应包含错误', new Error(`API_ERROR_DETECTED: ${keyword}`), {
                            detail: `关键词命中: ${keyword}`,
                            extra: {
                                responseSnippet: body.slice(0, 500)
                            },
                            screenshot: false
                        });
                        throw new Error(`API_ERROR_DETECTED: ${keyword}`);
                    }
                }
                // 返回代理对象，缓存 body 以支持调用方重复读取
                const cachedResponse = Object.create(response);
                cachedResponse.text = async () => body;
                cachedResponse.json = async () => JSON.parse(body);
                cachedResponse.body = async () => bodyBuffer;
                return cachedResponse;
            } catch (e) {
                if (e.message.startsWith('API_ERROR_DETECTED')) throw e;
            }
        }

        return response;
    } catch (e) {
        // 检测超时错误，转换为标准错误类型
        if (e.name === 'TimeoutError' || e.message?.includes('TIMEOUT')) {
            // 操作追踪：等待 API 响应超时
            traceError(page, '等待API响应超时', e, {
                detail: `匹配: ${urlMatch}`,
                durationMs: Date.now() - waitStart,
                screenshot: true
            });
            throw new Error(`API_TIMEOUT: ${e.message}`);
        }
        if (e.message?.startsWith('NETWORK_FAILED')) {
            // 操作追踪：网络请求失败
            traceError(page, 'API网络请求失败', e, {
                detail: `匹配: ${urlMatch}`,
                durationMs: Date.now() - waitStart,
                screenshot: false
            });
        }
        throw e;
    } finally {
        cleanup();
    }
    })();

    // 关键修复：挂载一个空的 catch 处理器
    // 因为适配器通常是先调用 waitApiResponse 拿到 Promise，然后执行 safeClick，最后再 await
    // 如果在 safeClick 期间页面关闭/崩溃，此 Promise 会被 reject，触发 Node.js 未捕获异常崩溃
    promise.catch(() => {});

    return promise;
}
