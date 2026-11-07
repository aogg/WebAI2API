/**
 * @fileoverview PoolManager 类
 * @description 管理 Worker 池，负责初始化、任务分发和故障转移
 */

import { logger } from '../../utils/logger.js';
import { registry } from '../registry.js';
import { createStrategySelector } from '../strategies/index.js';
import { executeWithFailover } from '../strategies/failover.js';
import { normalizeError } from '../utils/error.js';
import { Worker } from './Worker.js';

/**
 * PoolManager 类 - 管理 Worker 池
 */
export class PoolManager {
    /**
     * @param {object} config - 全局配置
     */
    constructor(config) {
        this.config = config;
        this.workers = [];
        this.strategy = config.backend.pool.strategy || 'least_busy';
        this.strategySelector = createStrategySelector(this.strategy);
        this.initialized = false;
        this.roundRobinIndex = 0;
    }

    /**
     * 初始化所有 Worker
     */
    async initAll() {
        if (this.initialized) return;

        // 先加载所有适配器
        await registry.loadAll();

        // 注入适配器配置（用于模型过滤）
        const adapterConfig = this.config.backend?.adapter || {};
        registry.setAdapterConfig(adapterConfig);

        // 解析登录模式参数
        let loginWorkerName = null;
        const loginArg = process.argv.find(arg => arg.startsWith('-login'));
        const isLoginMode = !!loginArg;
        if (loginArg && loginArg.includes('=')) {
            loginWorkerName = loginArg.split('=')[1];
            logger.info('工作池', `登录模式: 仅初始化 Worker "${loginWorkerName}"`);
        } else if (isLoginMode) {
            loginWorkerName = this.config.backend.pool.workers[0]?.name || null;
            logger.info('工作池', `登录模式: 仅初始化第一个 Worker "${loginWorkerName}"`);
        }

        const workerConfigs = this.config.backend.pool.workers;

        if (isLoginMode) {
            logger.info('工作池', `登录模式: 从 ${workerConfigs.length} 个 Worker 中筛选...`);
        } else {
            logger.info('工作池', `正在初始化 ${workerConfigs.length} 个 Worker...`);
        }

        // 过滤并创建 Worker 实例
        const validWorkers = [];
        for (const workerConfig of workerConfigs) {
            if (isLoginMode && workerConfig.name !== loginWorkerName) {
                logger.debug('工作池', `[${workerConfig.name}] 跳过 (不匹配登录目标)`);
                continue;
            }

            if (workerConfig.type !== 'merge' && !registry.hasAdapter(workerConfig.type)) {
                logger.error('工作池', `Worker [${workerConfig.name}] 的类型 "${workerConfig.type}" 无对应适配器，跳过`);
                continue;
            }

            if (workerConfig.type === 'merge') {
                const invalidTypes = (workerConfig.mergeTypes || []).filter(t => !registry.hasAdapter(t));
                if (invalidTypes.length > 0) {
                    logger.error('工作池', `Worker [${workerConfig.name}] 的 mergeTypes 包含无效类型: ${invalidTypes.join(', ')}`);
                    continue;
                }
            }

            validWorkers.push(new Worker(this.config, workerConfig));
        }

        if (isLoginMode && validWorkers.length === 0) {
            const availableNames = workerConfigs.map(w => w.name).join(', ');
            throw new Error(`登录模式未找到 Worker "${loginWorkerName}"。可用的 Worker: ${availableNames}`);
        }

        // 按 userDataDir 分组
        const browserMap = new Map();

        for (const worker of validWorkers) {
            try {
                const existing = browserMap.get(worker.userDataDir);

                if (existing) {
                    const workerProxy = JSON.stringify(worker.proxyConfig || null);
                    const existingProxy = JSON.stringify(existing.proxyConfig || null);
                    if (workerProxy !== existingProxy) {
                        logger.warn('工作池', `[${worker.name}] 代理配置与 [${existing.firstWorkerName}] 不一致，将使用后者的配置`);
                    }

                    logger.debug('工作池', `[${worker.name}] 将与其他 Worker 共享浏览器 (${worker.userDataDir})`);
                    await worker.init(existing.browser);

                    // 建立共享关系：设置所有者引用，并添加到所有者的共享列表
                    worker._browserOwner = existing.ownerWorker;
                    existing.ownerWorker._sharedWorkers.push(worker);
                } else {
                    await worker.init();
                    browserMap.set(worker.userDataDir, {
                        browser: worker.browser,
                        proxyConfig: worker.proxyConfig,
                        firstWorkerName: worker.name,
                        ownerWorker: worker  // 保存所有者 Worker 引用
                    });
                }

                this.workers.push(worker);
            } catch (e) {
                logger.error('工作池', `[${worker.name}] 初始化失败，跳过该 Worker`, { error: e.message });
            }
        }

        if (this.workers.length === 0) {
            throw new Error('所有 Worker 初始化都失败了，无法启动服务');
        }

        this.initialized = true;
        logger.info('工作池', `工作池初始化完成，共 ${this.workers.length} 个 Worker 就绪 (${browserMap.size} 个浏览器实例)`);
    }

    /**
     * 根据模型选择 Worker
     */
    selectWorker(modelId) {
        const candidates = this.workers.filter(w => w.supports(modelId));

        if (candidates.length === 0) {
            throw new Error(`没有 Worker 支持模型: ${modelId}`);
        }

        if (candidates.length === 1) {
            return candidates[0];
        }

        switch (this.strategy) {
            case 'round_robin': {
                const idx = this.roundRobinIndex % candidates.length;
                this.roundRobinIndex++;
                return candidates[idx];
            }
            case 'random': {
                const idx = Math.floor(Math.random() * candidates.length);
                return candidates[idx];
            }
            case 'least_busy':
            default: {
                return candidates.reduce((min, w) => w.busyCount < min.busyCount ? w : min, candidates[0]);
            }
        }
    }

    /**
     * 分发生图任务（支持故障转移）
     */
    async generate(ctx, prompt, paths, modelId, meta) {
        const failoverConfig = this.config.backend?.pool?.failover || {};
        const failoverEnabled = failoverConfig.enabled !== false;
        const maxRetries = failoverConfig.maxRetries || 2;

        let candidates = this.workers.filter(w => w.supports(modelId));

        if (candidates.length === 0) {
            return { error: `没有 Worker 支持模型: ${modelId}`, code: 'NO_WORKER', retryable: false };
        }

        // 如果请求包含图片，优先选择 imagePolicy 为 optional 的 Worker
        const hasImages = paths && paths.length > 0;
        if (hasImages && candidates.length > 1) {
            const optionalCandidates = candidates.filter(w => {
                const policy = w.getImagePolicy(modelId);
                return policy === 'optional' || policy === 'required';
            });

            if (optionalCandidates.length > 0) {
                logger.debug('工作池', `请求包含图片，优先选择支持图片的 Worker (${optionalCandidates.length}/${candidates.length} 个)`);
                candidates = optionalCandidates;
            } else {
                logger.warn('工作池', `请求包含图片，但没有 Worker 的 imagePolicy 为 optional`);
            }
        }

        const sortedCandidates = this.strategySelector.sort(candidates);

        if (!failoverEnabled) {
            const worker = sortedCandidates[0];
            logger.debug('工作池', `任务分发至: ${worker.name} (busy: ${worker.busyCount})`);
            return await this._safeExecuteWorker(worker, ctx, prompt, paths, modelId, meta);
        }

        return await executeWithFailover(
            sortedCandidates,
            async (worker) => {
                logger.debug('工作池', `任务分发至: ${worker.name} (busy: ${worker.busyCount})`);
                return await this._safeExecuteWorker(worker, ctx, prompt, paths, modelId, meta);
            },
            {
                maxRetries,
                meta,
                onRetry: (worker, error) => {
                    logger.warn('工作池', `[${worker.name}] 失败，尝试下一个 Worker...`, { error, ...meta });
                }
            }
        );
    }

    /**
     * 安全执行 Worker（带错误边界）
     * @private
     */
    async _safeExecuteWorker(worker, ctx, prompt, paths, modelId, meta) {
        try {
            return await worker.generate(ctx, prompt, paths, modelId, meta);
        } catch (err) {
            logger.error('工作池', `[${worker.name}] 执行异常`, { error: err.message, ...meta });
            const normalized = normalizeError(err.message || '执行异常');
            normalized.worker = worker.name;
            normalized.stack = err.stack || null;
            return normalized;
        }
    }

    /**
     * 重启浏览器（WebUI「重启浏览器」按钮）
     * @param {string|null} [workerName] - 指定 Worker 名称；共享浏览器会随所有者一起重启。
     *   null 时重启所有浏览器实例
     * @returns {Promise<{success: boolean, results: object[]}>}
     */
    async restartBrowser(workerName = null) {
        if (!this.initialized) {
            throw new Error('工作池尚未初始化');
        }

        // 确定要重启的浏览器所有者集合
        let owners;
        if (workerName) {
            const target = this.workers.find(w => w.name === workerName);
            if (!target) {
                throw new Error(`Worker 不存在: ${workerName}（可用: ${this.workers.map(w => w.name).join(', ')}）`);
            }
            // 共享者 → 重启其所有者（同一浏览器）
            owners = [target._browserOwner || target];
        } else {
            owners = this.workers.filter(w => w._isBrowserOwner);
            // 兜底：没有明确所有者时按 Worker 逐个重启
            if (owners.length === 0) {
                owners = this.workers;
            }
        }

        const results = [];
        for (const owner of owners) {
            const entry = {
                worker: owner.name,
                shared: owner._sharedWorkers.map(w => w.name),
                success: true,
                error: null
            };
            try {
                await owner.restartBrowser();
                logger.info('工作池', `[${owner.name}] 浏览器重启成功`);
            } catch (e) {
                entry.success = false;
                entry.error = e.message;
                logger.error('工作池', `[${owner.name}] 浏览器重启失败: ${e.message}`);
            }
            results.push(entry);
        }

        return {
            success: results.every(r => r.success),
            results
        };
    }

    /**
     * 获取所有 Worker 运行状态（供 Admin API 展示）
     * @returns {object[]}
     */
    getWorkersStatus() {
        return this.workers.map(w => ({
            name: w.name,
            type: w.type,
            instanceName: w.instanceName,
            initialized: w.initialized,
            busy: w.busyCount,
            isBrowserOwner: !!w._isBrowserOwner,
            sharedWith: w._sharedWorkers.map(s => s.name),
            proxy: w.proxyConfig ? `${w.proxyConfig.type}://${w.proxyConfig.host}:${w.proxyConfig.port}` : null
        }));
    }

    /**
     * 获取所有模型列表
     */
    getModels() {
        const allModels = [];
        const seenIds = new Set();

        for (const worker of this.workers) {
            const models = worker.getModels();
            for (const m of models) {
                if (!seenIds.has(m.id)) {
                    seenIds.add(m.id);
                    allModels.push(m);
                }
            }
        }

        return { object: 'list', data: allModels };
    }

    /**
     * 获取图片策略（宽松策略：只要有一个 Worker 支持 optional 就返回 optional）
     */
    getImagePolicy(modelKey) {
        const policies = new Set();

        for (const worker of this.workers) {
            if (worker.supports(modelKey)) {
                policies.add(worker.getImagePolicy(modelKey));
            }
        }

        // 宽松策略：只要有一个 optional 就返回 optional
        if (policies.has('optional')) return 'optional';
        if (policies.has('required')) return 'required';
        if (policies.has('forbidden')) return 'forbidden';
        return 'optional';
    }

    /**
     * 获取模型类型
     */
    getModelType(modelKey) {
        for (const worker of this.workers) {
            if (worker.supports(modelKey)) {
                return worker.getModelType(modelKey);
            }
        }
        return 'image';
    }

    /**
     * 获取指定实例的 Cookies
     */
    async getCookies(instanceName, domain) {
        let worker;
        if (instanceName) {
            worker = this.workers.find(w => w.instanceName === instanceName);
            if (!worker) {
                throw new Error(`浏览器实例不存在: ${instanceName}`);
            }
        } else {
            worker = this.workers[0];
            if (!worker) {
                throw new Error('工作池中没有可用的 Worker');
            }
        }

        const cookies = await worker.getCookies(domain);
        return { instance: worker.instanceName, cookies };
    }

    /**
     * 触发所有 merge Worker 的监控导航
     */
    async navigateToMonitor() {
        for (const worker of this.workers) {
            if (worker.type === 'merge' && worker.busyCount === 0) {
                await worker.navigateToMonitor();
            }
        }
    }

    /**
     * 获取第一个 Worker 的 page
     */
    getFirstPage() {
        return this.workers[0]?.page || null;
    }
}
