/**
 * @fileoverview CDP 远程画面推流模块
 * @description CDP 远程连接模式下，将远程浏览器当前页面截图流通过 WebSocket 推送给 WebUI 虚拟显示器面板
 *
 * 协议：
 * - 二进制帧 = JPEG 截图
 * - 文本帧   = JSON 控制消息 { type: 'wait' | 'error', message }
 *
 * 复用 vncProxy.js 的 WebSocket 帧编解码（不复制第二份实现）。
 */

import { encodeWebSocketFrame, decodeWebSocketFrame } from './vncProxy.js';
import { logger } from '../../../utils/logger.js';

/** 推流帧间隔（毫秒），约 1.4 帧/秒 */
const FRAME_INTERVAL_MS = 700;

/** 截图参数（与 trace.js 操作截图一致的风格） */
const SCREENSHOT_OPTIONS = { type: 'jpeg', quality: 60, timeout: 4000 };

/**
 * 处理 CDP 远程画面 WebSocket 升级请求
 * @param {import('http').IncomingMessage} req - HTTP 请求
 * @param {import('net').Socket} socket - 原始 TCP socket
 * @param {Buffer} head - 升级请求的头部数据
 * @param {string} authToken - 有效的认证令牌
 * @param {object} deps - 依赖注入
 * @param {() => object|null} deps.getPoolManager - 获取 PoolManager 实例（未初始化时返回 null）
 */
export async function handleScreenUpgrade(req, socket, head, authToken, deps) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // 验证 token（与 /admin/vnc 一致：query token）
    const token = url.searchParams.get('token');
    if (token !== authToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }

    const poolManager = typeof deps?.getPoolManager === 'function' ? deps.getPoolManager() : null;
    if (!poolManager || !poolManager.initialized) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return;
    }

    // 手动完成 WebSocket 握手（与 vncProxy 一致）
    const key = req.headers['sec-websocket-key'];
    if (!key) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
    }

    const crypto = await import('crypto');
    const acceptKey = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
        '\r\n'
    );

    // 目标 Worker：query worker=<name> 指定，缺省由 PoolManager 取第一个已初始化的 Worker
    const workerName = url.searchParams.get('worker');

    let stopped = false;  // 客户端断开 / 连接关闭后置 true，推流循环退出
    let sending = false;  // 上一帧截图尚未完成时为 true，跳过本轮防止帧堆积

    /**
     * 发送 JSON 控制消息（文本帧）
     * @param {{type: string, message: string}} payload
     */
    function sendControl(payload) {
        if (stopped || socket.destroyed) return;
        socket.write(encodeWebSocketFrame(Buffer.from(JSON.stringify(payload), 'utf8'), 0x81));
    }

    /**
     * 停止推流并清理连接
     */
    function cleanup() {
        if (stopped) return;
        stopped = true;
        socket.destroy();
    }

    /**
     * 推流主循环
     * 每轮实时从池里重新解析目标 Worker 的当前 page（Worker 重连/标签页重建后
     * page 引用会变化，绝对不能缓存 page 引用），截图后以二进制帧发出。
     */
    async function streamLoop() {
        while (!stopped) {
            await new Promise((resolve) => setTimeout(resolve, FRAME_INTERVAL_MS));
            if (stopped) break;

            // 上一帧还没截完：跳过本轮，防止帧堆积
            if (sending) continue;

            const target = poolManager.getPageForScreen(workerName || null);
            if (!target) {
                sendControl({ type: 'error', message: `Worker 不存在或页面未就绪${workerName ? `: ${workerName}` : ''}` });
                continue;
            }

            if (target.page.isClosed?.()) {
                sendControl({ type: 'wait', message: `Worker ${target.name} 页面已关闭，等待恢复...` });
                continue;
            }

            sending = true;
            try {
                const buf = await target.page.screenshot(SCREENSHOT_OPTIONS);
                if (!stopped && !socket.destroyed) {
                    socket.write(encodeWebSocketFrame(buf));
                }
            } catch (e) {
                // 截图失败（页面跳转中/CDP 抖动等）：通知客户端后自动继续下一帧
                logger.debug('画面推流', `[${target.name}] 截图失败: ${e.message}`);
                sendControl({ type: 'wait', message: `截图失败，正在重试 (${e.message})` });
            } finally {
                sending = false;
            }
        }
    }

    // 客户端 -> 服务端：只处理关闭帧，其余忽略（推流为单向）
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
            const result = decodeWebSocketFrame(buffer);
            if (!result) break;
            buffer = buffer.slice(result.bytesConsumed);
            if (result.opcode === 0x08) {
                // 客户端主动关闭
                cleanup();
                return;
            }
        }
    });

    socket.on('close', cleanup);
    socket.on('error', (err) => {
        logger.debug('画面推流', `客户端连接异常: ${err.message}`);
        cleanup();
    });

    logger.info('画面推流', `客户端已连接，开始推流 (worker: ${workerName || '自动'})`);
    streamLoop();
}
