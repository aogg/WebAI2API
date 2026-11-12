/**
 * @fileoverview Admin API 路由模块
 * @description 提供管理接口，包括系统状态、配置管理、适配器元数据等
 */

import { sendJson, sendApiError } from '../../respond.js';
import { ERROR_CODES } from '../../errors.js';
import { logger } from '../../../utils/logger.js';
import {
    getSystemStatus,
    getDataFolders,
    deleteDataFolders,
    clearTempFiles
} from '../../../utils/systemInfo.js';
import {
    getServerConfig,
    saveServerConfig,
    getBrowserConfig,
    saveBrowserConfig,
    getQueueConfig,
    saveQueueConfig,
    getInstancesConfig,
    saveInstancesConfig,
    getAdaptersConfig,
    saveAdaptersConfig,
    getPoolConfig,
    savePoolConfig
} from '../../../config/manager.js';
import {
    validateServerConfig,
    validateBrowserConfig,
    validateInstancesConfig,
    validatePoolConfig,
    validateAdaptersConfig
} from '../../../config/validator.js';
import { registry } from '../../../backend/registry.js';
import { sendRestartSignal, sendStopSignal, isUnderSupervisor, getVncInfo } from '../../../utils/ipc.js';
import { getTodayStats, getStatsRange, clearStatsRange } from '../../../utils/stats.js';
import {
    getList as getHistoryList,
    getDetail as getHistoryDetail,
    deleteRecords as deleteHistoryRecords,
    deleteByDateRange as deleteHistoryByDateRange,
    retryMediaDownload,
    getStats as getHistoryStats,
    getModelList as getHistoryModelList,
    getMediaDir
} from '../../../utils/history.js';
import path from 'path';
import fs from 'fs/promises';
import { useContextDownload } from '../../../backend/utils/download.js';

/**
 * 读取请求体
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<object>}
 */
async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString();
    return body ? JSON.parse(body) : {};
}

/**
 * 掩码 CDP 端点：只保留协议与 host:port，隐藏路径与凭据
 * @param {string} endpoint - 原始端点（http://IP:9222 或 ws://IP:9222/devtools/browser/<id>）
 * @returns {string} 形如 ws://IP:9222 的安全展示串，无法解析时返回占位符
 */
function maskCdpEndpoint(endpoint) {
    try {
        const url = new URL(endpoint);
        const protocol = url.protocol.replace(/:$/, '');
        const port = url.port || (url.protocol === 'wss:' || url.protocol === 'https:' ? '443' : '80');
        return `${protocol}://${url.hostname}:${port}`;
    } catch (e) {
        // 端点不是标准 URL（无法解析）时不展示任何内容，避免泄露路径或凭据
        logger.warn('管理器', `CDP 端点无法解析，状态接口将以隐藏形式展示: ${e.message}`);
        return '(已隐藏)';
    }
}

/**
 * 已授权剪贴板权限的浏览器上下文集合（按 context 记忆，避免每次请求重复授权）
 * @type {WeakSet<object>}
 */
const clipboardPermContexts = new WeakSet();

/**
 * 确保 page 所在上下文具有剪贴板读写权限（CDP 远程上下文需要显式授权）
 * @param {object} page - Playwright Page 对象
 */
async function ensureClipboardPermission(page) {
    const context = page.context();
    if (clipboardPermContexts.has(context)) return;
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    clipboardPermContexts.add(context);
}

/**
 * 创建 Admin 路由处理器
 * @param {object} context - 路由上下文
 * @param {object} context.config - 完整配置对象
 * @param {object} context.queueManager - 队列管理器
 * @param {string} context.tempDir - 临时目录
 * @returns {Function} Admin 路由处理函数
 */
export function createAdminRouter(context) {
    const { config, queueManager, tempDir, getSafeMode } = context;

    /**
     * Admin 路由处理函数
     * @param {import('http').IncomingMessage} req
     * @param {import('http').ServerResponse} res
     * @param {string} pathname - 去除 /admin 前缀后的路径
     */
    return async function handleAdminRequest(req, res, pathname) {
        const method = req.method;

        try {
            // ==================== 系统管理 ====================

            // GET /admin/status - 系统状态
            if (method === 'GET' && pathname === '/status') {
                const status = getSystemStatus();
                const safeMode = getSafeMode?.() || { enabled: false, reason: null };
                sendJson(res, 200, { ...status, safeMode });
                return;
            }

            // POST /admin/restart - 重启服务
            if (method === 'POST' && pathname === '/restart') {
                // 解析请求体获取重启参数
                let loginMode = null;
                let workerName = null;
                try {
                    const body = await readBody(req);
                    loginMode = body.loginMode || null;
                    workerName = body.workerName || null;
                } catch { /* 无请求体时使用默认值 */ }

                const modeDesc = loginMode
                    ? (workerName ? `登录模式 (${workerName})` : '登录模式')
                    : '普通模式';
                sendJson(res, 200, { success: true, message: `服务正在以${modeDesc}重启...` });
                logger.info('管理器', `收到重启请求: ${modeDesc}`);

                setTimeout(async () => {
                    // 构建启动参数（仅登录模式相关）
                    const extraArgs = [];
                    if (loginMode) {
                        extraArgs.push(workerName ? `-login=${workerName}` : '-login');
                    }

                    if (isUnderSupervisor()) {
                        // Supervisor 模式：通过 IPC 发送带参数的重启信号
                        const sent = await sendRestartSignal(extraArgs);
                        if (!sent) {
                            logger.warn('管理器', 'IPC 重启信号发送失败，尝试自重启');
                            // 降级到自重启
                            const { spawn } = await import('child_process');
                            const newArgs = process.argv.slice(1).filter(arg => !arg.startsWith('-login'));
                            newArgs.push(...extraArgs);
                            const child = spawn(process.execPath, newArgs, {
                                cwd: process.cwd(),
                                detached: true,
                                stdio: 'ignore',
                                env: process.env
                            });
                            child.unref();
                            setTimeout(() => process.exit(0), 500);
                        }
                    } else {
                        // 独立模式：使用子进程自重启
                        const { spawn } = await import('child_process');
                        const newArgs = process.argv.slice(1).filter(arg => !arg.startsWith('-login'));
                        newArgs.push(...extraArgs);
                        const child = spawn(process.execPath, newArgs, {
                            cwd: process.cwd(),
                            detached: true,
                            stdio: 'ignore',
                            env: process.env
                        });
                        child.unref();
                        setTimeout(() => process.exit(0), 500);
                    }
                }, 500);
                return;
            }

            // POST /admin/stop - 停止服务
            if (method === 'POST' && pathname === '/stop') {
                sendJson(res, 200, { success: true, message: '服务正在停止...' });
                logger.info('管理器', '收到停止请求，将在 1 秒后退出');

                setTimeout(() => process.exit(0), 1000);
                return;
            }

            // GET /admin/vnc/status - VNC 状态
            if (method === 'GET' && pathname === '/vnc/status') {
                const vncInfo = await getVncInfo();
                if (vncInfo) {
                    sendJson(res, 200, vncInfo);
                } else {
                    // 非 Supervisor 模式或无法获取信息
                    sendJson(res, 200, {
                        enabled: false,
                        port: 0,
                        display: '',
                        xvfbMode: false
                    });
                }
                return;
            }

            // ==================== CDP 远程画面 ====================

            // GET /admin/screen/status - CDP 远程画面状态
            if (method === 'GET' && pathname === '/screen/status') {
                const browserInfo = getBrowserConfig();
                const cdpEndpoint = (browserInfo.cdpEndpoint || '').trim();

                // 非 CDP 模式：本地启动浏览器，虚拟显示器走 VNC 流程
                if (!cdpEndpoint) {
                    sendJson(res, 200, { mode: 'local', enabled: false });
                    return;
                }

                const poolContext = queueManager?.getPoolContext?.();
                const poolManager = poolContext?.poolManager;

                sendJson(res, 200, {
                    mode: 'cdp',
                    enabled: !!(poolManager && poolManager.initialized),
                    endpoint: maskCdpEndpoint(cdpEndpoint),
                    workers: poolManager?.initialized ? poolManager.getScreenWorkersStatus() : []
                });
                return;
            }

            // POST /admin/screen/clipboard - 写远程剪贴板（仅 CDP 模式可用）
            if (method === 'POST' && pathname === '/screen/clipboard') {
                const browserInfo = getBrowserConfig();
                if (!(browserInfo.cdpEndpoint || '').trim()) {
                    sendApiError(res, {
                        code: ERROR_CODES.INTERNAL_ERROR,
                        message: '远程剪贴板仅在 CDP 远程连接模式（browser.cdpEndpoint 非空）下可用',
                        status: 400
                    });
                    return;
                }

                const poolContext = queueManager?.getPoolContext?.();
                const poolManager = poolContext?.poolManager;
                if (!poolManager || !poolManager.initialized) {
                    sendApiError(res, {
                        code: ERROR_CODES.INTERNAL_ERROR,
                        message: '工作池尚未初始化（可能处于安全模式），无法操作远程剪贴板',
                        status: 503
                    });
                    return;
                }

                const body = await readBody(req);
                const text = typeof body.text === 'string' ? body.text : '';
                const target = poolManager.getPageForScreen(body.worker || null);
                if (!target) {
                    sendApiError(res, {
                        code: ERROR_CODES.INTERNAL_ERROR,
                        message: `Worker 不存在或页面未就绪${body.worker ? `: ${body.worker}` : ''}`,
                        status: 404
                    });
                    return;
                }

                try {
                    await ensureClipboardPermission(target.page);
                    await target.page.evaluate(t => navigator.clipboard.writeText(t), text);
                    logger.info('管理器', `[${target.name}] 已写入远程剪贴板 (${text.length} 字符)`);
                    sendJson(res, 200, { success: true, ok: true, fallback: false });
                } catch (e) {
                    // 剪贴板 API 不可用（远端 Chromium 不支持授权等）：降级为直接插入文本到焦点元素
                    logger.warn('管理器', `[${target.name}] 远程剪贴板写入失败，降级为插入文本: ${e.message}`);
                    try {
                        await target.page.keyboard.insertText(text);
                        sendJson(res, 200, {
                            success: true,
                            ok: true,
                            fallback: true,
                            message: '远程剪贴板不可用，已直接插入文本到焦点元素（非剪贴板）'
                        });
                    } catch (e2) {
                        sendApiError(res, {
                            code: ERROR_CODES.INTERNAL_ERROR,
                            message: `写入远程剪贴板失败: ${e.message}；降级插入文本也失败: ${e2.message}`
                        });
                    }
                }
                return;
            }

            // GET /admin/screen/clipboard?worker= - 读远程剪贴板（仅 CDP 模式可用）
            if (method === 'GET' && pathname === '/screen/clipboard') {
                const requestUrl = new URL(req.url, `http://${req.headers.host}`);
                const workerParam = requestUrl.searchParams.get('worker');

                const browserInfo = getBrowserConfig();
                if (!(browserInfo.cdpEndpoint || '').trim()) {
                    sendApiError(res, {
                        code: ERROR_CODES.INTERNAL_ERROR,
                        message: '远程剪贴板仅在 CDP 远程连接模式（browser.cdpEndpoint 非空）下可用',
                        status: 400
                    });
                    return;
                }

                const poolContext = queueManager?.getPoolContext?.();
                const poolManager = poolContext?.poolManager;
                if (!poolManager || !poolManager.initialized) {
                    sendApiError(res, {
                        code: ERROR_CODES.INTERNAL_ERROR,
                        message: '工作池尚未初始化（可能处于安全模式），无法读取远程剪贴板',
                        status: 503
                    });
                    return;
                }

                const target = poolManager.getPageForScreen(workerParam || null);
                if (!target) {
                    sendApiError(res, {
                        code: ERROR_CODES.INTERNAL_ERROR,
                        message: `Worker 不存在或页面未就绪${workerParam ? `: ${workerParam}` : ''}`,
                        status: 404
                    });
                    return;
                }

                try {
                    await ensureClipboardPermission(target.page);
                    const text = await target.page.evaluate(() => navigator.clipboard.readText());
                    sendJson(res, 200, { success: true, ok: true, text: typeof text === 'string' ? text : '' });
                } catch (e) {
                    // 读取失败时返回 ok:false，由前端自行降级（不作为服务端错误处理）
                    logger.warn('管理器', `[${target.name}] 读取远程剪贴板失败: ${e.message}`);
                    sendJson(res, 200, { success: false, ok: false, message: e.message });
                }
                return;
            }

            // ==================== 浏览器池管理 ====================

            // POST /admin/pool/restart - 重启浏览器（全部或指定 Worker 的浏览器实例）
            if (method === 'POST' && pathname === '/pool/restart') {
                let workerName = null;
                try {
                    const body = await readBody(req);
                    workerName = body.workerName || null;
                } catch { /* 无请求体时重启全部 */ }

                const poolContext = queueManager?.getPoolContext?.();
                const poolManager = poolContext?.poolManager;

                if (!poolManager || !poolManager.initialized) {
                    sendApiError(res, {
                        code: ERROR_CODES.INTERNAL_ERROR,
                        message: '工作池尚未初始化（可能处于安全模式），无法重启浏览器',
                        status: 503
                    });
                    return;
                }

                logger.info('管理器', `收到浏览器重启请求: ${workerName || '全部浏览器实例'}`);

                try {
                    const result = await poolManager.restartBrowser(workerName);
                    if (result.success) {
                        sendJson(res, 200, {
                            success: true,
                            message: `浏览器重启完成 (${result.results.length} 个实例)`,
                            results: result.results
                        });
                    } else {
                        sendJson(res, 207, {
                            success: false,
                            message: '部分浏览器重启失败',
                            results: result.results
                        });
                    }
                } catch (e) {
                    sendApiError(res, {
                        code: ERROR_CODES.INTERNAL_ERROR,
                        message: `浏览器重启失败: ${e.message}`
                    });
                }
                return;
            }

            // GET /admin/pool/workers - Worker 运行状态列表
            if (method === 'GET' && pathname === '/pool/workers') {
                const poolContext = queueManager?.getPoolContext?.();
                const poolManager = poolContext?.poolManager;

                if (!poolManager || !poolManager.initialized) {
                    sendJson(res, 200, { initialized: false, workers: [] });
                    return;
                }

                sendJson(res, 200, {
                    initialized: true,
                    workers: poolManager.getWorkersStatus()
                });
                return;
            }

            // ==================== 缓存与数据管理 ====================

            // POST /admin/cache/clear - 清理缓存
            if (method === 'POST' && pathname === '/cache/clear') {
                const result = clearTempFiles(tempDir);
                sendJson(res, 200, { success: true, cleaned: result.cleaned });
                return;
            }

            // GET /admin/logs - 读取系统日志
            if (method === 'GET' && pathname === '/logs') {
                const url = new URL(req.url, `http://${req.headers.host}`);
                const lines = parseInt(url.searchParams.get('lines') || '200', 10);
                const result = logger.readLogs(lines);
                sendJson(res, 200, result);
                return;
            }

            // DELETE /admin/logs - 清除系统日志
            if (method === 'DELETE' && pathname === '/logs') {
                const success = logger.clearLogs();
                if (success) {
                    logger.info('管理器', '系统日志已清除');
                    sendJson(res, 200, { success: true, message: '日志已清除' });
                } else {
                    sendJson(res, 500, { success: false, message: '日志清除失败' });
                }
                return;
            }

            // GET /admin/data-folders - 列出数据文件夹
            if (method === 'GET' && pathname === '/data-folders') {
                const workers = config.backend?.pool?.workers || [];
                const folders = getDataFolders(workers);
                sendJson(res, 200, folders);
                return;
            }

            // POST /admin/data-folders/delete - 删除数据文件夹
            if (method === 'POST' && pathname === '/data-folders/delete') {
                const body = await readBody(req);
                if (!body.folders || !Array.isArray(body.folders)) {
                    sendApiError(res, { code: ERROR_CODES.INVALID_REQUEST_BODY, message: '缺少 folders 数组' });
                    return;
                }
                const workers = config.backend?.pool?.workers || [];
                const result = deleteDataFolders(body.folders, workers);

                if (result.errors.length > 0) {
                    sendJson(res, 207, result); // 207 Multi-Status
                } else {
                    sendJson(res, 200, result);
                }
                return;
            }

            // ==================== 配置管理 ====================

            // GET/POST /admin/config/server
            if (pathname === '/config/server') {
                if (method === 'GET') {
                    const serverConfig = getServerConfig();
                    const queueConfig = getQueueConfig();
                    sendJson(res, 200, {
                        ...serverConfig,
                        queueBuffer: queueConfig.queueBuffer,
                        imageLimit: queueConfig.imageLimit
                    });
                } else if (method === 'POST') {
                    const body = await readBody(req);

                    // 校验配置
                    const validation = validateServerConfig(body);
                    if (!validation.valid) {
                        sendApiError(res, {
                            code: ERROR_CODES.INVALID_REQUEST_BODY,
                            message: `配置校验失败: ${validation.errors.join('; ')}`
                        });
                        return;
                    }

                    // 分别保存 server 和 queue 配置
                    saveServerConfig(body);
                    if (body.queueBuffer !== undefined || body.imageLimit !== undefined) {
                        saveQueueConfig(body);
                    }
                    sendJson(res, 200, { success: true, message: '配置已保存，请重启服务生效' });
                } else {
                    res.writeHead(405);
                    res.end();
                }
                return;
            }

            // GET/POST /admin/config/browser
            if (pathname === '/config/browser') {
                if (method === 'GET') {
                    sendJson(res, 200, getBrowserConfig());
                } else if (method === 'POST') {
                    const body = await readBody(req);

                    // 校验配置
                    const validation = validateBrowserConfig(body);
                    if (!validation.valid) {
                        sendApiError(res, {
                            code: ERROR_CODES.INVALID_REQUEST_BODY,
                            message: `配置校验失败: ${validation.errors.join('; ')}`
                        });
                        return;
                    }

                    saveBrowserConfig(body);
                    sendJson(res, 200, { success: true, message: '配置已保存，请重启服务生效' });
                } else {
                    res.writeHead(405);
                    res.end();
                }
                return;
            }

            // GET/POST /admin/config/instances (对应原设计的 workers)
            if (pathname === '/config/instances' || pathname === '/config/workers') {
                if (method === 'GET') {
                    sendJson(res, 200, getInstancesConfig());
                } else if (method === 'POST') {
                    const body = await readBody(req);

                    // 校验配置（包括 Instance/Worker 名称唯一性）
                    const validation = validateInstancesConfig(body);
                    if (!validation.valid) {
                        sendApiError(res, {
                            code: ERROR_CODES.INVALID_REQUEST_BODY,
                            message: `配置校验失败: ${validation.errors.join('; ')}`
                        });
                        return;
                    }

                    saveInstancesConfig(body);
                    sendJson(res, 200, { success: true, message: '配置已保存，请重启服务生效' });
                } else {
                    res.writeHead(405);
                    res.end();
                }
                return;
            }

            // GET/POST /admin/config/adapters
            if (pathname === '/config/adapters') {
                if (method === 'GET') {
                    sendJson(res, 200, getAdaptersConfig());
                } else if (method === 'POST') {
                    const body = await readBody(req);

                    // 校验配置
                    const validation = validateAdaptersConfig(body);
                    if (!validation.valid) {
                        sendApiError(res, {
                            code: ERROR_CODES.INVALID_REQUEST_BODY,
                            message: `配置校验失败: ${validation.errors.join('; ')}`
                        });
                        return;
                    }

                    saveAdaptersConfig(body);
                    sendJson(res, 200, { success: true, message: '配置已保存，请重启服务生效' });
                } else {
                    res.writeHead(405);
                    res.end();
                }
                return;
            }

            // GET/POST /admin/config/pool - 负载均衡和故障转移配置
            if (pathname === '/config/pool') {
                if (method === 'GET') {
                    sendJson(res, 200, getPoolConfig());
                } else if (method === 'POST') {
                    const body = await readBody(req);

                    // 校验配置
                    const validation = validatePoolConfig(body);
                    if (!validation.valid) {
                        sendApiError(res, {
                            code: ERROR_CODES.INVALID_REQUEST_BODY,
                            message: `配置校验失败: ${validation.errors.join('; ')}`
                        });
                        return;
                    }

                    savePoolConfig(body);
                    sendJson(res, 200, { success: true, message: '配置已保存，请重启服务生效' });
                } else {
                    res.writeHead(405);
                    res.end();
                }
                return;
            }

            // ==================== 元数据 ====================

            // GET /admin/adapters - 获取适配器列表（含 configSchema）
            if (method === 'GET' && pathname === '/adapters') {
                const adapters = [];
                const adapterIds = registry.getAdapterIds();
                const adapterConfig = getAdaptersConfig();

                for (const id of adapterIds) {
                    const adapter = registry.getAdapter(id);
                    if (adapter) {
                        const config = adapterConfig[id] || {};
                        adapters.push({
                            id: adapter.id,
                            displayName: adapter.displayName || adapter.id,
                            description: adapter.description || '',
                            modelCount: adapter.models?.length || 0,
                            models: (adapter.models || []).map(m => m.id),
                            modelFilter: config.modelFilter || { mode: 'blacklist', list: [] },
                            configSchema: adapter.configSchema || []
                        });
                    }
                }

                sendJson(res, 200, adapters);
                return;
            }

            // ==================== 统计与监控 ====================

            // GET /admin/stats - 基本统计（包含今日成功/失败）
            if (method === 'GET' && pathname === '/stats') {
                const instances = config.backend?.pool?.instances || [];
                const workers = config.backend?.pool?.workers || [];
                const todayStats = getTodayStats();

                sendJson(res, 200, {
                    instances: instances.length,
                    workers: workers.length,
                    success: todayStats.success,
                    failed: todayStats.failed
                });
                return;
            }

            // GET /admin/stats/range - 查询日期范围统计
            if (method === 'GET' && pathname === '/stats/range') {
                const url = new URL(req.url, `http://${req.headers.host}`);
                const start = url.searchParams.get('start');
                const end = url.searchParams.get('end');

                if (!start || !end) {
                    sendApiError(res, { code: ERROR_CODES.INVALID_REQUEST_BODY, message: '缺少 start 或 end 参数' });
                    return;
                }

                const result = await getStatsRange(start, end);
                sendJson(res, 200, result);
                return;
            }

            // DELETE /admin/stats/range - 删除日期范围统计
            if (method === 'DELETE' && pathname === '/stats/range') {
                const url = new URL(req.url, `http://${req.headers.host}`);
                const start = url.searchParams.get('start');
                const end = url.searchParams.get('end');

                if (!start || !end) {
                    sendApiError(res, { code: ERROR_CODES.INVALID_REQUEST_BODY, message: '缺少 start 或 end 参数' });
                    return;
                }

                const result = await clearStatsRange(start, end);
                sendJson(res, 200, { success: true, deleted: result.deleted });
                return;
            }

            // GET /admin/queue - 任务队列状态
            if (method === 'GET' && pathname === '/queue') {
                const queueStatus = queueManager.getStatus();
                const detailedStatus = queueManager.getDetailedStatus();

                sendJson(res, 200, {
                    processing: queueStatus.processing,
                    waiting: queueStatus.queueLength,
                    total: queueStatus.total,
                    processingTasks: detailedStatus.processing,
                    waitingTasks: detailedStatus.waiting
                });
                return;
            }

            // ==================== 请求历史 ====================

            // GET /admin/history - 历史记录列表
            if (method === 'GET' && pathname === '/history') {
                const url = new URL(req.url, `http://${req.headers.host}`);
                const page = parseInt(url.searchParams.get('page') || '1', 10);
                const pageSize = parseInt(url.searchParams.get('pageSize') || '20', 10);
                const filters = {
                    status: url.searchParams.get('status') || null,
                    modelId: url.searchParams.get('model') || null,
                    search: url.searchParams.get('search') || null,
                    startDate: url.searchParams.get('startDate') || null,
                    endDate: url.searchParams.get('endDate') || null
                };

                const result = getHistoryList(filters, page, pageSize);
                sendJson(res, 200, result);
                return;
            }

            // GET /admin/history/stats - 历史统计摘要
            if (method === 'GET' && pathname === '/history/stats') {
                const url = new URL(req.url, `http://${req.headers.host}`);
                const filters = {
                    startDate: url.searchParams.get('startDate') || null,
                    endDate: url.searchParams.get('endDate') || null
                };

                const stats = getHistoryStats(filters);
                sendJson(res, 200, stats);
                return;
            }

            // GET /admin/history/models - 获取历史中使用过的模型列表
            if (method === 'GET' && pathname === '/history/models') {
                const models = getHistoryModelList();
                sendJson(res, 200, models);
                return;
            }

            // GET /admin/history/media/:filepath - 静态媒体文件服务（含 trace 截图子目录）
            if (method === 'GET' && pathname.startsWith('/history/media/')) {
                const filepath = decodeURIComponent(pathname.replace('/history/media/', ''));
                if (!filepath || filepath.includes('..')) {
                    sendApiError(res, { code: ERROR_CODES.INVALID_REQUEST_BODY, message: '无效的文件名' });
                    return;
                }

                try {
                    const fullPath = path.join(getMediaDir(), filepath);
                    const data = await fs.readFile(fullPath);
                    const ext = path.extname(filepath).toLowerCase();
                    const mimeTypes = {
                        '.png': 'image/png',
                        '.jpg': 'image/jpeg',
                        '.jpeg': 'image/jpeg',
                        '.gif': 'image/gif',
                        '.webp': 'image/webp',
                        '.mp4': 'video/mp4',
                        '.webm': 'video/webm'
                    };
                    res.writeHead(200, {
                        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
                        'Content-Length': data.length,
                        'Cache-Control': 'public, max-age=31536000'
                    });
                    res.end(data);
                } catch (e) {
                    sendApiError(res, { code: ERROR_CODES.NOT_FOUND, message: '文件不存在', status: 404 });
                }
                return;
            }

            // GET /admin/history/:id - 单条记录详情
            const historyDetailMatch = pathname.match(/^\/history\/([^/]+)$/);
            if (method === 'GET' && historyDetailMatch && !pathname.includes('/retry-media')) {
                const id = historyDetailMatch[1];
                const record = getHistoryDetail(id);
                if (record) {
                    sendJson(res, 200, record);
                } else {
                    sendApiError(res, { code: ERROR_CODES.NOT_FOUND, message: '记录不存在', status: 404 });
                }
                return;
            }

            // POST /admin/history/:id/retry-media - 重试下载媒体
            const retryMediaMatch = pathname.match(/^\/history\/([^/]+)\/retry-media$/);
            if (method === 'POST' && retryMediaMatch) {
                const id = retryMediaMatch[1];
                const body = await readBody(req);
                const mediaIndex = body.mediaIndex ?? 0;

                // 使用 Pool 的浏览器下载（如果可用）
                let downloadFn = null;
                try {
                    const poolContext = queueManager?.getPoolContext?.();
                    const page = poolContext?.poolManager?.getFirstPage?.();
                    if (page) {
                        const imgDlCfg = config?.backend?.pool?.failover || {};
                        downloadFn = (url) => useContextDownload(url, page, {
                            retries: imgDlCfg.imgDlRetry ? (imgDlCfg.imgDlRetryMaxRetries || 3) : 1
                        });
                    }
                } catch { /* Pool 未初始化，使用后备方案 */ }

                const result = await retryMediaDownload(id, mediaIndex, downloadFn);
                if (result.success) {
                    sendJson(res, 200, result);
                } else {
                    sendApiError(res, { code: ERROR_CODES.INTERNAL_ERROR, message: result.message });
                }
                return;
            }

            // DELETE /admin/history - 批量删除记录
            if (method === 'DELETE' && pathname === '/history') {
                const url = new URL(req.url, `http://${req.headers.host}`);
                const startDate = url.searchParams.get('startDate');
                const endDate = url.searchParams.get('endDate');

                // 支持按日期范围删除
                if (startDate && endDate) {
                    const deleted = await deleteHistoryByDateRange(startDate, endDate);
                    sendJson(res, 200, { success: true, deleted });
                    return;
                }

                // 支持按 ID 列表删除
                const body = await readBody(req);
                if (body.ids && Array.isArray(body.ids)) {
                    const deleted = await deleteHistoryRecords(body.ids);
                    sendJson(res, 200, { success: true, deleted });
                    return;
                }

                sendApiError(res, { code: ERROR_CODES.INVALID_REQUEST_BODY, message: '缺少 ids 数组或日期范围参数' });
                return;
            }

            // 404
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not Found' }));

        } catch (err) {
            logger.error('管理器', `请求处理失败: ${err.message}`);
            sendApiError(res, {
                code: ERROR_CODES.INTERNAL_ERROR,
                message: err.message
            });
        }
    };
}
