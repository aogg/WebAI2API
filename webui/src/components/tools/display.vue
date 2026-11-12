<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useSettingsStore } from '@/stores/settings';
import { message, Modal } from 'ant-design-vue';
import {
    DesktopOutlined,
    DisconnectOutlined,
    ExpandOutlined,
    CompressOutlined,
    ReloadOutlined,
    SyncOutlined,
    SnippetsOutlined,
    ClusterOutlined
} from '@ant-design/icons-vue';

const settingsStore = useSettingsStore();

// 状态
const loading = ref(true);
const vncStatus = ref(null);
const connectionState = ref('disconnected'); // disconnected, connecting, connected, error
const errorMessage = ref('');
const isFullscreen = ref(false);

// 重启浏览器状态
const restarting = ref(false);

// 剪贴板自动共享（本机 ⇄ 远程 双向同步）
const clipboardShareEnabled = ref(localStorage.getItem('vncClipboardShare') === '1'); // 开关状态持久化到 localStorage
const clipboardShareSuspended = ref(false); // true = 剪贴板授权被拒后轮询已暂停，等待用户授权后恢复
let clipboardPollTimer = null;   // 共享轮询定时器
let lastPushedText = '';         // 最近一次推送/接收的剪贴板文本，防止双向同步互相回推（防回环）
let clipboardPermWarned = false; // 授权被拒的警告只弹一次

// 剪贴板状态
const pasteModalVisible = ref(false);
const pasteText = ref('');

// DOM 引用
const vncContainer = ref(null);

// noVNC 实例
let rfb = null;
let RFB = null;

// 获取 VNC 状态
async function fetchVncStatus() {
    try {
        const res = await fetch('/admin/vnc/status', {
            headers: settingsStore.getHeaders()
        });
        if (res.ok) {
            vncStatus.value = await res.json();
        }
    } catch (e) {
        console.error('获取 VNC 状态失败', e);
    } finally {
        loading.value = false;
    }
}

// 连接 VNC
async function connectVnc() {
    if (!vncStatus.value?.enabled) return;

    connectionState.value = 'connecting';
    errorMessage.value = '';

    try {
        // 动态导入 noVNC
        if (!RFB) {
            const module = await import('@novnc/novnc/core/rfb.js');
            RFB = module.default;
        }

        // 构建 WebSocket URL
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/admin/vnc?token=${settingsStore.token}`;

        // 创建 RFB 实例
        rfb = new RFB(vncContainer.value, wsUrl, {
            wsProtocols: ['binary']
        });

        // 配置
        rfb.scaleViewport = true;   // 缩放远程画面以适应容器
        rfb.clipViewport = false;   // 不裁剪视口
        rfb.resizeSession = false;   // 允许调整远程会话分辨率

        // 事件监听
        rfb.addEventListener('connect', () => {
            connectionState.value = 'connected';
            message.success('VNC 已连接，可直接 Ctrl+V 粘贴或使用"粘贴"按钮');
            // 剪贴板共享开关开启时：连接成功立即尝试一次读取并启动轮询
            //（此刻处于"连接"按钮的用户手势链路上，便于触发浏览器剪贴板授权）
            if (clipboardShareEnabled.value) {
                startClipboardPolling();
            }
        });

        rfb.addEventListener('disconnect', (e) => {
            connectionState.value = 'disconnected';
            if (e.detail.clean === false) {
                errorMessage.value = '连接意外断开';
            }
            stopClipboardPolling();
            rfb = null;
        });

        rfb.addEventListener('credentialsrequired', () => {
            rfb.sendCredentials({ password: '' });
        });

        // 远程剪贴板 → 本地剪贴板（HTTPS 下自动同步）
        rfb.addEventListener('clipboard', async (e) => {
            const text = e.detail?.text;
            if (!text) return;
            try {
                await navigator.clipboard.writeText(text);
                // 防回环：远程推来的文本记为 lastPushedText，避免轮询又把同一文本推回远程
                lastPushedText = text;
            } catch (err) {
                console.debug('远程剪贴板写入本地失败（需 HTTPS）', err);
            }
        });

    } catch (e) {
        connectionState.value = 'error';
        errorMessage.value = e.message || '连接失败';
    }
}

// 断开连接
function disconnectVnc() {
    stopClipboardPolling();
    if (rfb) {
        rfb.disconnect();
        rfb = null;
    }
    connectionState.value = 'disconnected';
}

// 切换全屏
function toggleFullscreen() {
    if (!vncContainer.value) return;

    if (!document.fullscreenElement) {
        vncContainer.value.requestFullscreen();
        isFullscreen.value = true;
    } else {
        document.exitFullscreen();
        isFullscreen.value = false;
    }
}

// 监听全屏变化
function handleFullscreenChange() {
    isFullscreen.value = !!document.fullscreenElement;
}

// ============ 剪贴板：本地 → 远程 ============

/**
 * 把文本发送到远程剪贴板（VNC ClientCutText）
 */
function sendToRemoteClipboard(text) {
    if (!rfb || connectionState.value !== 'connected') {
        message.warning('请先连接虚拟显示器');
        return false;
    }
    if (!text) {
        message.warning('剪贴板内容为空');
        return false;
    }
    rfb.clipboardPaste(text);
    return true;
}

/**
 * 粘贴按钮：读取本地剪贴板并注入远程
 */
async function pasteToRemote() {
    if (connectionState.value !== 'connected') {
        message.warning('请先连接虚拟显示器');
        return;
    }
    try {
        const text = await navigator.clipboard.readText();
        if (!text) {
            message.info('本地剪贴板为空，可手动粘贴到弹窗中发送');
            openPasteModal();
            return;
        }
        if (sendToRemoteClipboard(text)) {
            lastPushedText = text; // 防回环：刚推送的内容不再被轮询重复推送
            // 这次点击是用户手势，readText 成功说明剪贴板授权已通过，
            // 若共享轮询因授权失败被暂停，此时自动恢复
            if (clipboardShareEnabled.value && connectionState.value === 'connected' && !clipboardPollTimer) {
                startClipboardPolling();
            }
            message.success(`已发送 ${text.length} 个字符到远程剪贴板，在远程系统里 Ctrl+V 即可粘贴`);
        }
    } catch (e) {
        // 剪贴板 API 被拒绝（权限/非安全上下文），回退到手动弹窗
        console.warn('读取本地剪贴板失败，回退到手动粘贴', e);
        openPasteModal();
    }
}

/**
 * 打开手动粘贴弹窗
 */
function openPasteModal() {
    pasteText.value = '';
    pasteModalVisible.value = true;
}

/**
 * 手动粘贴弹窗：发送
 */
function sendPasteModal() {
    if (!pasteText.value) {
        message.warning('请先粘贴内容');
        return;
    }
    if (sendToRemoteClipboard(pasteText.value)) {
        pasteModalVisible.value = false;
        message.success(`已发送 ${pasteText.value.length} 个字符到远程剪贴板`);
    }
}

// ============ 剪贴板自动共享：本机 ⇄ 远程 定时双向同步 ============

/**
 * 轮询一次本机剪贴板，内容有变化就推送到远程
 */
async function pollLocalClipboard() {
    if (!clipboardShareEnabled.value || connectionState.value !== 'connected') return;
    if (!document.hasFocus()) return; // 仅窗口聚焦时读取，避免后台标签页反复抢占读取
    let text;
    try {
        text = await navigator.clipboard.readText();
    } catch (err) {
        // 权限被拒（NotAllowedError 等）：不能中断页面功能，降级处理——
        // 自动停止轮询并提示一次；用户点一次"粘贴"按钮（用户手势可完成授权）后会自动恢复共享
        stopClipboardPolling();
        clipboardShareSuspended.value = true;
        if (!clipboardPermWarned) {
            clipboardPermWarned = true;
            message.warning('剪贴板读取被浏览器拒绝：点一次"粘贴"按钮完成授权后会自动恢复共享');
        }
        console.warn('剪贴板共享：读取本机剪贴板被拒绝，已暂停轮询', err);
        return;
    }
    if (text && text !== lastPushedText && rfb && connectionState.value === 'connected') {
        rfb.clipboardPaste(text);
        lastPushedText = text;
    }
}

/**
 * 启动剪贴板共享轮询（1.5s 一次，启动时立即先尝试一次）
 */
function startClipboardPolling() {
    if (clipboardPollTimer) return;
    clipboardShareSuspended.value = false;
    clipboardPermWarned = false;
    pollLocalClipboard();
    clipboardPollTimer = setInterval(pollLocalClipboard, 1500);
}

/**
 * 停止剪贴板共享轮询（开关关闭 / 断开连接 / 组件卸载时清理）
 */
function stopClipboardPolling() {
    if (clipboardPollTimer) {
        clearInterval(clipboardPollTimer);
        clipboardPollTimer = null;
    }
}

// 开关切换：持久化到 localStorage，并按需启停轮询
watch(clipboardShareEnabled, (enabled) => {
    localStorage.setItem('vncClipboardShare', enabled ? '1' : '0');
    if (enabled && connectionState.value === 'connected') {
        startClipboardPolling();
    } else {
        stopClipboardPolling();
    }
});

// Ctrl+V 直接粘贴：在捕获阶段拦截，避免按键被转发到远程系统
function handleKeyDown(e) {
    if (connectionState.value !== 'connected') return;
    const isPasteKey = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
        && (e.key === 'v' || e.key === 'V');
    if (isPasteKey) {
        // 只拦截转发，不阻止默认行为（默认行为会触发 paste 事件）
        e.stopPropagation();
    }
}

// paste 事件：从事件对象直接拿剪贴板文本（无需 read 权限）
function handlePaste(e) {
    if (connectionState.value !== 'connected') return;
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    if (sendToRemoteClipboard(text)) {
        lastPushedText = text; // 防回环：刚推送的内容不再被轮询重复推送
        message.success(`已粘贴 ${text.length} 个字符到远程剪贴板`);
    }
}

// ============ 重启浏览器 ============

function confirmRestartBrowser() {
    Modal.confirm({
        title: '重启浏览器实例',
        content: '将关闭并重新启动所有浏览器（含共享标签页），正在执行中的请求会失败。确定继续？',
        okText: '重启浏览器',
        okType: 'danger',
        cancelText: '取消',
        async onOk() {
            restarting.value = true;
            try {
                const res = await fetch('/admin/pool/restart', {
                    method: 'POST',
                    headers: {
                        ...settingsStore.getHeaders(),
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({})
                });
                const data = await res.json().catch(() => ({}));
                if (res.ok && data.success) {
                    message.success(data.message || '浏览器重启完成');
                } else if (res.status === 207) {
                    message.warning(data.message || '部分浏览器重启失败，详情见日志');
                } else {
                    message.error(data.message || '浏览器重启失败');
                }
            } catch (e) {
                message.error('请求失败: ' + e.message);
            } finally {
                restarting.value = false;
            }
        }
    });
}

// ============ Worker 状态提示 ============

async function fetchWorkersHint() {
    try {
        const res = await fetch('/admin/pool/workers', { headers: settingsStore.getHeaders() });
        if (res.ok) {
            const data = await res.json();
            if (data?.workers?.length) {
                vncStatus.value = {
                    ...(vncStatus.value || {}),
                    workerCount: data.workers.length
                };
            }
        }
    } catch { /* 静默 */ }
}

onMounted(async () => {
    await fetchVncStatus();
    fetchWorkersHint();
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('paste', handlePaste, true);
});

onUnmounted(() => {
    stopClipboardPolling();
    disconnectVnc();
    document.removeEventListener('fullscreenchange', handleFullscreenChange);
    document.removeEventListener('keydown', handleKeyDown, true);
    document.removeEventListener('paste', handlePaste, true);
});
</script>

<template>
    <a-layout style="background: transparent;">
        <a-card title="虚拟显示器" :bordered="false" style="height: 100%">
            <!-- 加载中 -->
            <div v-if="loading" style="text-align: center; padding: 48px;">
                <a-spin size="large" />
                <div style="margin-top: 16px; color: #8c8c8c;">正在检查 VNC 状态...</div>
            </div>

            <!-- 非 xvfbMode -->
            <div v-else-if="!vncStatus?.xvfbMode" style="text-align: center; padding: 48px;">
                <DisconnectOutlined style="font-size: 64px; color: #bfbfbf;" />
                <div style="margin-top: 16px; font-size: 16px; color: #595959;">程序未使用虚拟显示器运行</div>
                <div style="margin-top: 8px; color: #8c8c8c;">
                    VNC 远程显示功能仅在 Linux 环境下使用 <code>-xvfb -vnc</code> 参数启动时可用
                </div>
            </div>

            <!-- xvfbMode 但 VNC 未启用 -->
            <div v-else-if="!vncStatus?.enabled" style="text-align: center; padding: 48px;">
                <DesktopOutlined style="font-size: 64px; color: #bfbfbf;" />
                <div style="margin-top: 16px; font-size: 16px; color: #595959;">VNC 服务未启动</div>
                <div style="margin-top: 8px; color: #8c8c8c;">
                    请确保启动时包含 <code>-vnc</code> 参数，并已安装 x11vnc
                </div>
            </div>

            <!-- VNC 可用 -->
            <div v-else>
                <!-- 控制栏 -->
                <div style="margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <a-tag v-if="connectionState === 'connected'" color="success">已连接</a-tag>
                        <a-tag v-else-if="connectionState === 'connecting'" color="processing">连接中...</a-tag>
                        <a-tag v-else-if="connectionState === 'error'" color="error">连接错误</a-tag>
                        <a-tag v-else color="default">未连接</a-tag>
                        <span v-if="errorMessage" style="margin-left: 8px; color: #ff4d4f; font-size: 12px;">
                            {{ errorMessage }}
                        </span>
                    </div>
                    <a-space>
                        <a-button v-if="connectionState !== 'connected'" type="primary" @click="connectVnc"
                            :loading="connectionState === 'connecting'">
                            <template #icon>
                                <DesktopOutlined />
                            </template>
                            连接
                        </a-button>
                        <a-button v-else danger @click="disconnectVnc">
                            <template #icon>
                                <DisconnectOutlined />
                            </template>
                            断开
                        </a-button>
                        <a-tooltip title="粘贴本地剪贴板到远程系统（连接后也可直接 Ctrl+V）">
                            <a-button @click="pasteToRemote" :disabled="connectionState !== 'connected'">
                                <template #icon>
                                    <SnippetsOutlined />
                                </template>
                            </a-button>
                        </a-tooltip>
                        <a-tooltip title="开启后本机剪贴板与远程系统剪贴板自动互相同步（需浏览器授权，Chrome/Edge 支持最好）">
                            <span style="display: inline-flex; align-items: center; gap: 4px; font-size: 13px; cursor: default;">
                                剪贴板共享
                                <a-switch v-model:checked="clipboardShareEnabled" size="small" />
                            </span>
                        </a-tooltip>
                        <a-button @click="toggleFullscreen" :disabled="connectionState !== 'connected'">
                            <template #icon>
                                <CompressOutlined v-if="isFullscreen" />
                                <ExpandOutlined v-else />
                            </template>
                        </a-button>
                        <a-tooltip title="刷新状态">
                            <a-button @click="fetchVncStatus">
                                <template #icon>
                                    <ReloadOutlined />
                                </template>
                            </a-button>
                        </a-tooltip>
                        <a-tooltip title="重启浏览器实例（关闭并重新启动所有浏览器）">
                            <a-button danger @click="confirmRestartBrowser" :loading="restarting">
                                <template #icon>
                                    <SyncOutlined v-if="!restarting" />
                                    <ClusterOutlined v-else />
                                </template>
                                重启浏览器
                            </a-button>
                        </a-tooltip>
                    </a-space>
                </div>

                <!-- VNC 显示区域 -->
                <div ref="vncContainer"
                    style="width: 100%; aspect-ratio: 16/9; min-height: 400px; max-height: 70vh; background: #000; border-radius: 8px; overflow: hidden;">
                    <div v-if="connectionState === 'disconnected'"
                        style="height: 100%; display: flex; align-items: center; justify-content: center; color: #595959;">
                        <div style="text-align: center;">
                            <DesktopOutlined style="font-size: 48px; color: #434343;" />
                            <div style="margin-top: 16px;">点击"连接"按钮查看远程显示器</div>
                        </div>
                    </div>
                </div>

                <!-- 信息 -->
                <div style="margin-top: 12px; font-size: 12px; color: #8c8c8c;">
                    显示器: {{ vncStatus.display }} | VNC 端口: {{ vncStatus.port }}
                    <span v-if="vncStatus.workerCount"> | 浏览器实例: {{ vncStatus.workerCount }}</span>
                    <span v-if="connectionState === 'connected'"> | 已连接：Ctrl+V 或"粘贴"按钮可发送本地剪贴板，远程复制会自动同步到本地</span>
                    <span v-if="connectionState === 'connected' && clipboardShareEnabled"> | 剪贴板共享: {{ clipboardShareSuspended ? '开（已暂停：点"粘贴"按钮授权后自动恢复）' : '开（自动双向同步）' }}</span>
                </div>
            </div>
        </a-card>

        <!-- 手动粘贴弹窗（剪贴板 API 不可用时的兜底） -->
        <a-modal v-model:open="pasteModalVisible" title="手动粘贴到远程剪贴板" ok-text="发送到远程" cancel-text="取消"
            @ok="sendPasteModal">
            <div style="margin-bottom: 8px; color: #8c8c8c; font-size: 12px;">
                浏览器未授权读取本地剪贴板（或非 HTTPS 环境），请在下方输入框中手动 Ctrl+V 粘贴内容后发送。
                发送后在远程系统里按 Ctrl+V 即可粘贴。
            </div>
            <a-textarea v-model:value="pasteText" placeholder="在此粘贴内容..." :rows="8" />
        </a-modal>
    </a-layout>
</template>
