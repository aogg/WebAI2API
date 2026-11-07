/**
 * @fileoverview 请求级追踪模块（操作日志 + 操作截图 + 定时快照）
 * @description 按请求 ID 收集每次页面操作的文字日志与截图、周期性全屏快照，
 *              供「请求记录 → 查看详情」展示，便于人工与 AI-Agent 排查历史问题。
 *
 * 生命周期：
 * - queue.js 处理任务开始时调用 beginTrace(requestId)
 * - Worker._executeAdapter 执行适配器前调用 attachTrace(page, tags)（携带 worker/adapter/model）
 * - 各公共操作工具（safeClick / waitForInput / gotoWithCheck / waitApiResponse）与
 *   installPageTrace 安装的页面方法包装器调用 traceOp / traceError 记录操作
 * - queue.js 任务结束时调用 endTrace(requestId) 拿到 {ops, snaps} 并写入历史记录
 *
 * 截图开关：仅当浏览器处于可见模式（非 headless，含 Xvfb 虚拟显示器）时截图，
 * 可通过 config.browser.traceScreenshots === false 强制关闭。
 */

import fs from 'fs/promises';
import path from 'path';
import { logger } from '../../utils/logger.js';

const MEDIA_DIR = path.join(process.cwd(), 'data', 'history', 'media');
const TRACE_DIR = path.join(MEDIA_DIR, 'trace');

/** 请求快照截图间隔（毫秒） */
const SNAP_INTERVAL_MS = 2000;
/** 单请求最大快照数（防失控） */
const MAX_SNAPS = 600;
/** 单请求最大操作截图数 */
const MAX_OP_SHOTS = 300;
/** 截图 JPEG 质量 */
const JPEG_QUALITY = 50;
/** endTrace 等待挂起截图写入的最长时间（毫秒） */
const FLUSH_TIMEOUT_MS = 6000;
/** trace 泄漏保护：超过该时长自动回收（毫秒） */
const TRACE_TTL_MS = 30 * 60 * 1000;

/** @type {Map<string, object>} requestId -> trace 上下文 */
const traces = new Map();

/**
 * 浏览器是否处于可见模式（非隐藏），可见模式才截屏
 * 与 launcher.js 的判定保持一致：headless 配置 && 非 Xvfb 模式才真正隐藏
 * @param {object} [config] - 全局配置
 * @returns {boolean}
 */
export function isBrowserVisible(config) {
    if (config?.browser?.traceScreenshots === false) return false;
    const isXvfb = process.env.XVFB_RUNNING === 'true';
    return !(config?.browser?.headless === true && !isXvfb);
}

/**
 * 请求 ID 转安全目录名
 * @param {string} requestId
 * @returns {string}
 */
function safeDirName(requestId) {
    return String(requestId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * 获取 trace 目录
 * @param {string} requestId
 * @returns {string}
 */
export function getTraceDir(requestId) {
    return path.join(TRACE_DIR, safeDirName(requestId));
}

/**
 * 开始追踪一个请求
 * @param {string} requestId - 请求 ID
 * @param {object} [options]
 * @param {object} [options.config] - 全局配置（判定是否截图）
 * @param {boolean} [options.capture] - 是否截图（默认按可见模式判定）
 * @returns {object|null} trace 上下文（未启用时返回 null）
 */
export function beginTrace(requestId, options = {}) {
    if (!requestId) return null;

    // 泄漏保护：清理过期 trace
    sweepStaleTraces();

    if (traces.has(requestId)) return traces.get(requestId);

    const capture = options.capture !== undefined
        ? options.capture
        : isBrowserVisible(options.config);

    const ctx = {
        requestId,
        startedAt: Date.now(),
        capture,
        ops: [],
        snaps: [],
        opSeq: 0,
        snapSeq: 0,
        opShots: 0,
        pendingWrites: [],
        snapTimer: null,
        snapping: false,
        pages: new Set(),
        currentPage: null,
        ended: false
    };

    traces.set(requestId, ctx);

    // 预创建截图目录（截图写入前等待就绪，避免 ENOENT）
    ctx.dirReady = fs.mkdir(getTraceDir(requestId), { recursive: true }).catch((e) => {
        logger.warn('追踪', `创建截图目录失败: ${e.message}`);
    });

    // 周期快照定时器
    if (capture) {
        ctx.snapTimer = setInterval(() => captureSnapshot(ctx), SNAP_INTERVAL_MS);
        if (ctx.snapTimer.unref) ctx.snapTimer.unref();
    }

    return ctx;
}

/**
 * 回收超时未结束的 trace（防内存泄漏）
 */
function sweepStaleTraces() {
    const now = Date.now();
    for (const [id, ctx] of traces) {
        if (now - ctx.startedAt > TRACE_TTL_MS) {
            logger.warn('追踪', `请求 ${id} 的 trace 超时未结束，强制回收`);
            stopTraceTimer(ctx);
            traces.delete(id);
        }
    }
}

/**
 * 将页面挂到当前请求的 trace 上（携带 worker/adapter/model 标签）
 * @param {object} page - Playwright Page
 * @param {object} tags - {requestId, worker, adapter, model}
 * @returns {object|null} trace 上下文
 */
export function attachTrace(page, tags = {}) {
    const ctx = traces.get(tags.requestId);
    if (!ctx || !page) return null;

    page._traceCtx = { ...tags, trace: ctx };
    ctx.pages.add(page);
    // 快照使用最新挂载的页面
    ctx.currentPage = page;
    return ctx;
}

/**
 * 从页面解除 trace 挂载（请求可能跨多个 Worker 顺序执行）
 * @param {object} page - Playwright Page
 */
export function detachTrace(page) {
    if (page?._traceCtx) {
        const ctx = page._traceCtx.trace;
        ctx.pages.delete(page);
        if (ctx.currentPage === page) ctx.currentPage = null;
        page._traceCtx = null;
    }
}

/**
 * 获取页面上挂载的 trace 上下文
 * @param {object|null} page
 * @returns {object|null}
 */
function ctxOf(page) {
    return page?._traceCtx?.trace || null;
}

/**
 * 记录一次操作（文字日志 + 可选操作截图）
 * @param {object|null} page - Playwright Page（可 null，仅记日志）
 * @param {string} action - 操作类型，如 点击/输入/导航/等待API响应/提交
 * @param {string} [detail=''] - 人类可读说明
 * @param {object} [options]
 * @param {string} [options.level='info'] - info | warn | error
 * @param {string} [options.selector] - 相关选择器
 * @param {string} [options.url] - 相关 URL
 * @param {string} [options.error] - 错误消息
 * @param {number} [options.durationMs] - 操作耗时
 * @param {boolean} [options.screenshot=true] - 是否截图
 * @param {object} [options.extra] - 额外字段（如 httpStatus、responseSnippet）
 * @returns {object|null} 操作条目
 */
export function traceOp(page, action, detail = '', options = {}) {
    const ctx = ctxOf(page);
    if (!ctx || ctx.ended) return null;

    ctx.opSeq++;
    const tags = page?._traceCtx || {};
    const entry = {
        seq: ctx.opSeq,
        at: Date.now(),
        offsetMs: Date.now() - ctx.startedAt,
        worker: tags.worker || null,
        adapter: tags.adapter || null,
        model: tags.model || null,
        action,
        detail: String(detail || '').slice(0, 500),
        level: options.level || (options.error ? 'error' : 'info'),
        selector: options.selector ? String(options.selector).slice(0, 200) : null,
        url: options.url ? String(options.url).slice(0, 500) : null,
        error: options.error ? String(options.error).slice(0, 1000) : null,
        durationMs: options.durationMs ?? null,
        ...(options.extra || {}),
        screenshot: null
    };

    // 页面 URL 自动补充
    if (!entry.url && page && !page.isClosed?.()) {
        try { entry.url = String(page.url()).slice(0, 500); } catch { /* ignore */ }
    }

    ctx.ops.push(entry);

    // 异步截图（不阻塞主流程）
    if (ctx.capture && page && options.screenshot !== false && ctx.opShots < MAX_OP_SHOTS && !page.isClosed?.()) {
        ctx.opShots++;
        const filename = `op_${String(entry.seq).padStart(3, '0')}.jpg`;
        const p = (async () => {
            const buf = await page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY, timeout: 4000 });
            await ctx.dirReady;
            await fs.writeFile(path.join(getTraceDir(ctx.requestId), filename), buf);
            entry.screenshot = filename;
        })()
            .catch((e) => {
                logger.debug('追踪', `操作截图失败: ${e.message}`);
            });
        ctx.pendingWrites.push(p);
    }

    return entry;
}

/**
 * 记录一次错误操作
 * @param {object|null} page - Playwright Page
 * @param {string} action - 操作类型
 * @param {Error|string} err - 错误
 * @param {object} [options] - 同 traceOp
 * @returns {object|null}
 */
export function traceError(page, action, err, options = {}) {
    const message = err?.message || String(err || '未知错误');
    return traceOp(page, action, options.detail || message, {
        ...options,
        level: 'error',
        error: message
    });
}

/**
 * 周期快照（每 2 秒）
 * @param {object} ctx - trace 上下文
 */
async function captureSnapshot(ctx) {
    if (!ctx || ctx.ended || ctx.snapping || ctx.snaps.length >= MAX_SNAPS) return;
    const page = ctx.currentPage;
    if (!page || page.isClosed?.()) return;

    ctx.snapping = true;
    ctx.snapSeq++;
    const filename = `snap_${String(ctx.snapSeq).padStart(3, '0')}.jpg`;
    const p = (async () => {
        const buf = await page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY, timeout: 4000 });
        await ctx.dirReady;
            await fs.writeFile(path.join(getTraceDir(ctx.requestId), filename), buf);
        ctx.snaps.push({
            seq: ctx.snapSeq,
            at: Date.now(),
            offsetMs: Date.now() - ctx.startedAt,
            file: filename
        });
    })()
        .catch((e) => {
            logger.debug('追踪', `快照失败: ${e.message}`);
        });
    ctx.pendingWrites.push(p);
    await p.finally(() => { ctx.snapping = false; });
}

/**
 * 停止定时器
 * @param {object} ctx
 */
function stopTraceTimer(ctx) {
    if (ctx.snapTimer) {
        clearInterval(ctx.snapTimer);
        ctx.snapTimer = null;
    }
}

/**
 * 结束追踪并返回收集结果（ops / snaps）
 * @param {string} requestId - 请求 ID
 * @param {object} [options]
 * @param {number} [options.timeoutMs=FLUSH_TIMEOUT_MS] - 等待挂起截图写入的最长时间
 * @returns {Promise<{ops: object[], snaps: object[], startedAt: number, capture: boolean}|null>}
 */
export async function endTrace(requestId, options = {}) {
    const ctx = traces.get(requestId);
    if (!ctx) return null;

    stopTraceTimer(ctx);
    ctx.ended = true;
    traces.delete(requestId);

    // 等待挂起的截图写入（限时）
    if (ctx.pendingWrites.length > 0) {
        await Promise.race([
            Promise.allSettled(ctx.pendingWrites),
            new Promise(r => setTimeout(r, options.timeoutMs ?? FLUSH_TIMEOUT_MS))
        ]);
        ctx.pendingWrites = [];
    }

    // 对所有挂载过的页面解除挂载
    for (const page of ctx.pages) {
        if (page._traceCtx?.trace === ctx) page._traceCtx = null;
    }
    ctx.pages.clear();

    return {
        ops: ctx.ops,
        snaps: ctx.snaps,
        startedAt: ctx.startedAt,
        capture: ctx.capture
    };
}

/**
 * 生成操作日志文本（人类与 AI-Agent 可读）
 * @param {object[]} ops - traceOp 条目数组
 * @param {object} [record] - 历史记录（补充上下文）
 * @returns {string}
 */
export function buildTraceLogText(ops, record = null) {
    if (!ops || ops.length === 0) return '';

    const lines = [];
    if (record) {
        lines.push(`# 请求 ${record.id || ''} 操作日志`);
        lines.push(`# 模型: ${record.model_name || record.model_id || '-'} | 状态: ${record.status} | 耗时: ${record.duration_ms ?? '-'}ms`);
    }

    for (const op of ops) {
        const t = new Date(op.at).toLocaleTimeString('zh-CN', { hour12: false })
            + '.' + String(op.at % 1000).padStart(3, '0');
        const offset = `+${(op.offsetMs / 1000).toFixed(1)}s`;
        const scope = [op.worker, op.adapter].filter(Boolean).join('/') || '-';
        let line = `[${t} ${offset}] [${scope}] ${op.action}${op.detail ? `: ${op.detail}` : ''}`;
        if (op.durationMs != null) line += ` (耗时 ${op.durationMs}ms)`;
        if (op.selector) line += ` | 选择器: ${op.selector}`;
        if (op.url) line += ` | URL: ${op.url}`;
        if (op.httpStatus != null) line += ` | HTTP ${op.httpStatus}`;
        if (op.error) line += ` | 错误: ${op.error}`;
        if (op.screenshot) line += ` | 截图: ${op.screenshot}`;
        lines.push(line);
    }

    return lines.join('\n');
}

/**
 * 删除请求的 trace 截图目录
 * @param {string|string[]} requestIds
 */
export async function deleteTraceFiles(requestIds) {
    const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
    for (const id of ids) {
        if (!id) continue;
        try {
            await fs.rm(getTraceDir(id), { recursive: true, force: true });
        } catch (e) {
            logger.debug('追踪', `删除 trace 目录失败: ${e.message}`);
        }
    }
}

/**
 * 在页面上安装操作追踪包装器（每个页面实例只安装一次）
 * 拦截 page.click / fill / type / press 与 keyboard.press / type / insertText，
 * 自动记录操作日志（不打截图，避免刷屏；主要操作的截图由公共工具函数负责）
 * @param {object} page - Playwright Page
 */
export function installPageTrace(page) {
    if (!page || page._traceInstalled) return;
    page._traceInstalled = true;

    // 页面级方法包装：[方法名, 参数→描述函数]
    const pageMethods = [
        ['click', (sel) => ({ action: '点击(page.click)', selector: sel, detail: String(sel) })],
        ['fill', (sel, text) => ({ action: '填充输入框(page.fill)', selector: sel, detail: `${String(text ?? '').length} 字符` })],
        ['type', (sel, text) => ({ action: '键入(page.type)', selector: sel, detail: `${String(text ?? '').length} 字符` })],
        ['press', (sel, key) => ({ action: '按键(page.press)', selector: sel, detail: String(key) })],
        ['hover', (sel) => ({ action: '悬停(page.hover)', selector: sel, detail: String(sel) })],
        ['setViewportSize', (size) => ({ action: '调整视口', detail: `${size?.width}x${size?.height}`, screenshot: false })]
    ];

    for (const [name, describe] of pageMethods) {
        const original = page[name];
        if (typeof original !== 'function') continue;
        page[name] = async function (...args) {
            const meta = describe(...args);
            const t0 = Date.now();
            try {
                const result = await original.apply(this, args);
                traceOp(page, meta.action, meta.detail ?? '', {
                    selector: meta.selector,
                    durationMs: Date.now() - t0,
                    screenshot: meta.screenshot === false ? false : undefined
                });
                return result;
            } catch (e) {
                traceError(page, meta.action, e, {
                    selector: meta.selector,
                    durationMs: Date.now() - t0,
                    screenshot: false
                });
                throw e;
            }
        };
    }

    // 键盘级方法包装
    const kb = page.keyboard;
    if (kb) {
        const kbMethods = [
            ['press', (key) => ({ action: '按键(keyboard.press)', detail: String(key) })],
            ['type', (text) => ({ action: '键入(keyboard.type)', detail: `${String(text ?? '').length} 字符` })],
            ['insertText', (text) => ({ action: '插入文本(keyboard.insertText)', detail: `${String(text ?? '').length} 字符` })]
        ];

        for (const [name, describe] of kbMethods) {
            const original = kb[name];
            if (typeof original !== 'function') continue;
            kb[name] = async function (...args) {
                const meta = describe(...args);
                const t0 = Date.now();
                try {
                    const result = await original.apply(this, args);
                    traceOp(page, meta.action, meta.detail ?? '', {
                        durationMs: Date.now() - t0,
                        screenshot: false
                    });
                    return result;
                } catch (e) {
                    traceError(page, meta.action, e, {
                        durationMs: Date.now() - t0,
                        screenshot: false
                    });
                    throw e;
                }
            };
        }
    }
}
