/**
 * @fileoverview ChatGPT 文本生成适配器
 */

import {
    sleep,
    humanType,
    safeClick,
    uploadFilesViaChooser
} from '../engine/utils.js';
import {
    normalizePageError,
    waitForInput,
    gotoWithCheck
} from '../utils/index.js';
import fs from 'fs';
import { logger } from '../../utils/logger.js';
import { TIMEOUTS } from '../../utils/constants.js';

// --- 配置常量 ---
const TARGET_URL = 'https://chatgpt.com/'; // 基础URL
const INPUT_SELECTOR = '.ProseMirror';
// 新版 ChatGPT 页面用 CSS Modules 类名渲染 markdown 内容，用属性片段匹配更稳妥
const ASSISTANT_SELECTOR = '[class*="MarkdownRoot"], [data-message-author-role="assistant"], article';

/**
 * 通过 UI 选择模型
 * @param {import('playwright-core').Page} page - 页面对象
 * @param {string} codeName - 模型 codeName
 * @param {object} meta - 日志元数据
 * @returns {Promise<boolean>} 是否成功选择了模型
 */
async function selectModel(page, codeName, meta = {}) {
    try {
        // 1. 点击模型选择按钮。ChatGPT 网页经常改 aria-label，优先用 data-testid，再回退到可见文本。
        const candidates = [
            page.locator('[data-testid="model-switcher-dropdown-button"]'),
            page.getByRole('button', { name: /Model selector|models?|ChatGPT|GPT|Instant|Thinking|Pro/i }),
            page.locator('button').filter({ hasText: /ChatGPT|GPT|Instant|Thinking|Pro/i })
        ];
        let modelSelectorBtn = null;
        for (const candidate of candidates) {
            if (await candidate.count().catch(() => 0)) {
                modelSelectorBtn = candidate.first();
                break;
            }
        }
        if (!modelSelectorBtn) {
            logger.warn('适配器', '未找到模型选择器按钮，跳过选择模型', meta);
            return false;
        }

        await modelSelectorBtn.waitFor({ timeout: 5000 });
        await safeClick(page, modelSelectorBtn, { bias: 'button' });
        await sleep(500, 800);

        // 2. 检查是否有 Legacy models 选项
        const legacyMenuItem = page.getByRole('menuitem', { name: /^Legacy models/ });
        const legacyExists = await legacyMenuItem.count();
        if (legacyExists > 0) {
            logger.debug('适配器', '发现 Legacy models 选项，正在点击...', meta);
            await safeClick(page, legacyMenuItem, { bias: 'button' });
            await sleep(300, 500);
        }

        // 3. 查找匹配 codeName 开头的 menuitem 或 menuitemradio
        let targetMenuItem = page.getByRole('menuitemradio', { name: new RegExp(`^${codeName}`, 'i') });
        let targetExists = await targetMenuItem.count();
        if (targetExists === 0) {
            targetMenuItem = page.getByRole('menuitem', { name: new RegExp(`^${codeName}`, 'i') });
            targetExists = await targetMenuItem.count();
        }

        if (targetExists > 0) {
            logger.info('适配器', `正在选择模型: ${codeName}`, meta);
            await safeClick(page, targetMenuItem.first(), { bias: 'button' });
            return true;
        } else {
            logger.debug('适配器', `未找到模型 ${codeName}，使用默认模型`, meta);
            // 点击空白区域关闭菜单
            await page.keyboard.press('Escape');
            return false;
        }
    } catch (e) {
        logger.warn('适配器', `选择模型失败: ${e.message}`, meta);
        // 尝试关闭菜单
        await page.keyboard.press('Escape').catch(() => { });
        return false;
    }
}

/**
 * 准备一个可用的新对话页面
 * 整页 goto 在慢代理下容易超时或被隧道中断，这里优先复用已经打开的应用，
 * 只有页面不可用时才真正导航（导航带重试）。
 * @param {import('playwright-core').Page} page - 页面对象
 * @param {string} targetUrl - 目标 URL
 * @param {{meta?: object, forceGoto?: boolean}} [options]
 * @returns {Promise<void>}
 */
async function waitComposer(page, timeout = 20000) {
    try {
        await page.waitForSelector(INPUT_SELECTOR, { timeout, state: 'visible' });
        return true;
    } catch {
        return false;
    }
}

async function ensureNewChatSurface(page, targetUrl, options = {}) {
    const { meta = {}, forceGoto = false } = options;
    const onChatGpt = () => /^https?:\/\/chatgpt\.com(\/|$|\?)/i.test(page.url() || '');

    const reload = async (reason) => {
        logger.info('适配器', `重新加载 ChatGPT 页面（${reason}）`, meta);
        await gotoWithCheck(page, targetUrl, {
            timeout: TIMEOUTS.NAVIGATION_EXTENDED,
            waitUntil: 'domcontentloaded',
            attempts: 3,
            meta
        });
        return waitComposer(page, 30000);
    };

    let ready = false;
    if (onChatGpt() && !forceGoto) {
        ready = await waitComposer(page, 15000);
    }

    if (!ready) {
        ready = await reload('输入框不可用');
    }

    if (forceGoto) return;

    if (!ready) {
        logger.warn('适配器', '页面输入框仍不可用，继续尝试发送', meta);
        return;
    }

    // 开启新会话：优先点侧边栏 New chat（避免整页重载），失败再重载页面兜底
    const newChatBtn = page.getByRole('link', { name: /New chat|新聊天|新建聊天/i })
        .or(page.getByRole('button', { name: /New chat|新聊天|新建聊天/i }));
    if (await newChatBtn.count().catch(() => 0)) {
        logger.info('适配器', '点击“New chat”开启新会话', meta);
        await safeClick(page, newChatBtn.first(), { bias: 'button' }).catch(() => { });
        await sleep(700, 1200);
        const ok = await waitComposer(page, 15000);
        if (!ok) {
            logger.warn('适配器', '点击 New chat 后输入框不可用，重新加载页面', meta);
            await reload('New chat 后输入框不可用');
        }
    }
}

/**
 * 执行文本生成任务
 * @param {object} context - 浏览器上下文 { page, config }
 * @param {string} prompt - 提示词
 * @param {string[]} imgPaths - 图片路径数组
 * @param {string} [modelId] - 模型 ID
 * @param {object} [meta={}] - 日志元数据
 * @returns {Promise<{text?: string, error?: string}>}
 */
async function generate(context, prompt, imgPaths, modelId, meta = {}) {
    const { page, config } = context;

    const waitTimeout = config?.backend?.pool?.waitTimeout ?? 120000;

    try {
        const useTemp = config?.backend?.adapter?.chatgpt_text?.temporaryChat || false;
        const targetUrl = useTemp ? 'https://chatgpt.com/?temporary-chat=true' : 'https://chatgpt.com/'; // 感谢 @zhongjianhua163 提供临时对话方案
        await ensureNewChatSurface(page, targetUrl, { meta, forceGoto: useTemp });

        // 1. 等待输入框加载
        await waitForInput(page, INPUT_SELECTOR, { click: false });

        // 2. 选择模型
        if (modelId) {
            const modelConfig = manifest.models.find(m => m.id === modelId);
            if (modelConfig && modelConfig.codeName) {
                await selectModel(page, modelConfig.codeName, meta);
            } else {
                logger.info('适配器', `未指定模型或未知模型 (${modelId})，跳过模型选择`, meta);
            }
        }

        // 3. 上传图片 (双击 Add files and more 按钮)
        if (imgPaths && imgPaths.length > 0) {
            logger.info('适配器', `开始上传 ${imgPaths.length} 张图片...`, meta);
            const expectedUploads = imgPaths.length;
            let uploadedCount = 0;
            let processedCount = 0;

            logger.debug('适配器', '双击添加文件按钮...', meta);
            const addFilesBtn = page.getByRole('button', { name: 'Add files and more' });

            await uploadFilesViaChooser(page, addFilesBtn, imgPaths, {
                clickAction: 'dblclick',  // 使用双击
                uploadValidator: (response) => {
                    const url = response.url();
                    if (response.status() === 200) {
                        // 上传请求
                        if (url.includes('backend-api/files') && !url.includes('process_upload_stream')) {
                            uploadedCount++;
                            logger.debug('适配器', `图片上传进度: ${uploadedCount}/${expectedUploads}`, meta);
                            return false;
                        }
                        // 处理完成请求
                        if (url.includes('backend-api/files/process_upload_stream')) {
                            processedCount++;
                            logger.info('适配器', `图片处理进度: ${processedCount}/${expectedUploads}`, meta);

                            if (processedCount >= expectedUploads) {
                                return true;
                            }
                        }
                    }
                    return false;
                }
            }, meta);
        }

        // 4. 输入提示词
        logger.info('适配器', '输入提示词...', meta);
        await safeClick(page, INPUT_SELECTOR, { bias: 'input' });
        await humanType(page, INPUT_SELECTOR, prompt);

        // 5. 记录已有回复数量（确保只取本次新产生的回复）
        const assistantCountBefore = await page
            .evaluate(() => Array.from(document.querySelectorAll(ASSISTANT_SELECTOR))
                .filter((el) => (el.innerText || '').trim().length > 0).length)
            .catch(() => 0);

        // 6. 发送提示词
        logger.debug('适配器', '发送提示词...', meta);
        await page.keyboard.press('Enter');
        logger.info('适配器', '等待生成结果...', meta);

        // 7. 以页面 DOM 为准提取回复
        // 说明：网页私有的 SSE 增量协议（channel/append path 等）会随版本变更，解析极易失效；
        // 页面渲染出来的内容才是最终结果，这里改为等待 DOM 稳定后整段读取。
        const textContent = await waitAssistantReply(page, {
            assistantCountBefore,
            timeout: Math.min(waitTimeout, 180000),
            meta
        });

        if (!textContent || textContent.trim() === '') {
            logger.warn('适配器', '回复内容为空', meta);
            return { error: '回复内容为空' };
        }

        logger.info('适配器', `已获取文本内容 (${textContent.length} 字符)`, meta);
        logger.info('适配器', '文本生成完成，任务完成', meta);
        return { text: textContent.trim() };

    } catch (err) {
        // 顶层错误处理
        const pageError = normalizePageError(err, meta);
        if (pageError) return pageError;

        logger.error('适配器', '生成任务失败', { ...meta, error: err.message });
        return { error: `生成任务失败: ${err.message}` };
    } finally { }
}

/**
 * 等待并提取本次新产生的 assistant 回复（以页面渲染结果为准）
 * @param {import('playwright-core').Page} page - 页面对象
 * @param {{assistantCountBefore?: number, timeout?: number, meta?: object}} [options]
 * @returns {Promise<string>} 回复文本（超时则返回已捕获的最长内容）
 */
async function waitAssistantReply(page, options = {}) {
    const { assistantCountBefore = 0, timeout = 180000, meta = {} } = options;
    const startedAt = Date.now();
    let lastText = '';
    let stableCount = 0;
    let longest = '';
    let pollCount = 0;

    while (Date.now() - startedAt < timeout) {
        pollCount++;
        const snapshot = await page.evaluate(([before, selector]) => {
            const nodes = Array.from(document.querySelectorAll(selector))
                .filter((el) => (el.innerText || '').trim().length > 0);
            if (nodes.length <= before) {
                return { text: '', generating: true, hasActions: false };
            }
            const node = nodes[nodes.length - 1];
            const text = (node.innerText || node.textContent || '').trim();

            const buttons = Array.from(document.querySelectorAll('button'));
            const generating = buttons.some((button) => {
                const label = `${button.getAttribute('aria-label') || ''} ${button.innerText || button.textContent || ''}`;
                return /stop generating|stop streaming|停止生成|停止回答/i.test(label);
            });
            const messageRoot = node.closest('[class*="turn"], [class*="message"], div') || node;
            const hasActions = !!messageRoot.querySelector('button[aria-label*="Copy" i], button[aria-label*="复制"], [data-testid="copy-turn-action-button"]');
            return { text, generating, hasActions };
        }, [assistantCountBefore, ASSISTANT_SELECTOR]).catch(() => ({ text: '', generating: true, hasActions: false }));

        const text = (snapshot.text || '')
            .replace(/^ChatGPT said:\s*/i, '')
            .replace(/\u00a0/g, ' ')
            .trim();

        if (text.length > longest.length) {
            longest = text;
        }

        if (text) {
            if (text === lastText) {
                stableCount++;
            } else {
                stableCount = 0;
                lastText = text;
            }

            if (stableCount >= 2 && (!snapshot.generating || snapshot.hasActions)) {
                logger.debug('适配器', `回复已稳定（轮询 ${pollCount} 次）`, meta);
                return text;
            }
            if (stableCount >= 3 && !snapshot.generating) {
                return text;
            }
        }

        await sleep(900, 1300);
    }

    if (longest) {
        logger.warn('适配器', `等待回复超时，改用已捕获的部分内容 (${longest.length} 字符)`, meta);
        return longest;
    }

    // 调试：定位不到回复时落盘页面结构，便于适配新版页面
    try {
        const dump = await page.evaluate(() => {
            const main = document.querySelector('main') || document.body;
            const chains = [];
            const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                const text = (node.textContent || '').trim();
                if (!text || text.length < 1) continue;
                let el = node.parentElement;
                const chain = [];
                for (let i = 0; i < 7 && el; i++, el = el.parentElement) {
                    chain.push([
                        el.tagName.toLowerCase(),
                        el.getAttribute('data-testid') || '',
                        el.getAttribute('data-message-author-role') || '',
                        el.getAttribute('data-talvt-turn-state') || '',
                        String(el.className || '').slice(0, 70)
                    ].join('|'));
                }
                chains.push({ text: text.slice(0, 60), chain });
                if (chains.length > 60) break;
            }
            return {
                url: location.href,
                text: (main.innerText || '').slice(0, 4000),
                chains,
                html: main.innerHTML.slice(0, 4000)
            };
        });
        if (fs.existsSync('/app/data/temp')) {
            fs.writeFileSync('/app/data/temp/chatgpt_dom_debug.txt',
                `URL:\n${dump.url}\n\nTEXT:\n${dump.text}\n\nCHAINS:\n${JSON.stringify(dump.chains, null, 2)}\n\nHTML-HEAD:\n${dump.html}`);
        }
    } catch { /* ignore */ }

    return '';
}

/**
 * 适配器 manifest
 */
export const manifest = {
    id: 'chatgpt_text',
    displayName: 'ChatGPT (文本生成)',
    description: '使用 ChatGPT 官网生成文本，支持多模型切换和图片上传。需要已登录的 ChatGPT 账户，若需要选择模型，请使用会员账号 (包含 K12 教室认证账号)。',

    // 配置项模式
    configSchema: [
        {
            key: 'temporaryChat',
            label: '临时对话',
            type: 'boolean',
            default: false,
            note: '开启后将使用临时对话模式 (?temporary-chat=true)'
        }
    ],

    // 入口 URL
    getTargetUrl(config, workerConfig) {
        const useTemp = config?.backend?.adapter?.chatgpt_text?.temporaryChat || false;
        return useTemp ? 'https://chatgpt.com/?temporary-chat=true' : 'https://chatgpt.com/';
    },

    // 模型列表
    models: [
        { id: 'gpt-instant', codeName: 'Instant', imagePolicy: 'optional', type: 'text' },
        { id: 'gpt-thinking', codeName: 'Thinking', imagePolicy: 'optional', type: 'text' },
        { id: 'gpt-pro', codeName: 'Pro', imagePolicy: 'optional', type: 'text' }
    ],

    // 无需导航处理器
    navigationHandlers: [],

    // 核心文本生成方法
    generate
};
